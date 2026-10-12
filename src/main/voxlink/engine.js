// SPDX-License-Identifier: LGPL-3.0-only
//
// 逐语句移植自 AUGUHDAR/VoxLink（修订 924845e，LGPL-3.0）的 `network/ConnectionManager.java`
// 里"打洞编排"那一部分。改写参考了 KAMUCL 的 JS 实现（`src/main/core/voxlink/engine.ts`，作者 KAMUCL contributors）。
// 见 THIRD_PARTY_NOTICES.md —— 本文件**不适用**仓库根的 MIT，按 LGPL-3.0-only 提供。
//
// 干什么：把"打洞"这件事**串起来**。前面几个文件各管一段：
//   session.js       喊话（我在这儿，你在哪儿）
//   stun.js          问出我的公网地址
//   punchProfiles/punchPolicy/punchRounds  怎么打、用什么参数、打几轮
//   punch.js         真发 UDP 包去敲
//   rudp.js          打出来的那条洞上跑可靠传输
// 本文件就是**总指挥**：谁该在什么时候做上面哪件事，以及"通了"之后把 rudp 挂上去。
//
// 这一版的**边界**（**故意的**，不是漏了）：
//   ① TCP 那条路（同时打开直连、游戏数据搬运 `bridge.ts`）—— **V4 的活**，这里只做到
//      "UDP 洞打通了、rudp 挂上了、两边互相看得见"。
//   ② TURN 中继、玩家中继 —— **V3 的活**。所以下面凡是出现 `this._turn` / `this._tcp` 的地方，
//      都是**照抄上游的守卫形状**，但那个子系统此刻是空的（`ABSENT_TURN`）——
//      **守卫一个没删**，等 V3 接进来把桩换成真的就行。
//   ③ 因此本文件里 `mode` 永远是 'p2p'、`turnChoices` 永远是空集。
//
// §0 纪律：调用顺序、守卫、常量全部照抄 engine.ts，别自己编排。

const net = require('node:net')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')

const { STUN_SERVERS, stunSampleSeries, samplePortsSequential, stunDeltaFromSamples } = require('./stun')
const { Puncher, PunchFailure, punchListen } = require('./punch')
const { fromProfile, predict, deltaPredict, selectStrategy, symmetric } = require('./punchPolicy')
const { PunchRounds } = require('./punchRounds')
const { RudpConn } = require('./rudp')
const { derivePunchKey } = require('./punchAuth')
const { NAT_RAW_LABELS, natLabel } = require('./room')

/** 上游第 44 行：从信令的 data 里抠出一个 ip:port，抠不出就是 null */
const endpoint = (data, prefix) => {
  const ip = String(data[`${prefix}Ip`] ?? '')
  const port = Number(data[`${prefix}Port`])
  return net.isIP(ip) && Number.isInteger(port) && port > 0 && port <= 65535 ? { ip, port } : null
}

/**
 * V3 之前 TURN 中继还不存在，但上游的守卫里到处都要问它一句。
 * 这里放一个**什么都不会做**的替身：只回答"没有"，其余全是空动作。
 * **别删这些守卫** —— 删了就把上游的编排改了；到 V3 直接把这个常量换成真的 TurnRelay。
 */
const ABSENT_TURN = {
  hasPeer: () => false,
  peerLeft: () => {},
  stop: () => {},
  peerAuth: () => false,
  onSignal: async () => {},
}

class ConnEngine extends EventEmitter {
  constructor(deps) {
    super()
    this.deps = deps
    this.code = ''
    this.token = ''
    this.isHost = false
    this.hostPort = 0
    this.hostIp = ''
    this.clientID = ''
    this.session = null
    this.room = null
    this.joinedAt = 0
    this.lastConnection = null
    this.stages = {}
    this.generation = 0
    this.links = new Map()
    this.creating = new Set()
    this.timers = new Set()
    this.rounds = new Map()
    this.tcp = new Map()
    this.relayAssignments = new Map()
    this.relayPending = false
    this.reconnectPending = false
    this.mode = 'p2p'
    this.winner = new Map()
    this.turnChoices = new Set()
    this.iceRestarts = new Map()
    this.knownPeers = new Set()
    this.lastMappings = new Map()
    this.natNotes = new Set()
    this._turn = ABSENT_TURN
  }

  // ---------------------------------------------------------------- 记账 / 上报

  reportNat(local, remote, peer) {
    const raw = String(this.room?.natType ?? 'unknown').trim().toLowerCase()
    if (!Object.hasOwn(NAT_RAW_LABELS, raw) && !this.natNotes.has(raw)) {
      this.natNotes.add(raw)
      this.deps.netLog('warn', '未收录的 NAT 类型，显示为未知：' + raw.slice(0, 80))
    }
    this.deps.emit('nat:state', {
      local: natLabel(local, undefined),
      remote: natLabel(remote, raw),
      localClass: local,
      remoteClass: remote,
      profile: this._policy(peer).profile.name,
    })
    const expected = raw.includes('cone') ? 'CONE' : raw.startsWith('symmetric_easy') ? 'EASY_SYM' : raw === 'symmetric' ? 'HARD_SYM' : undefined
    const key = raw + ':' + remote
    if (expected && remote !== 'UNKNOWN' && expected !== remote && !this.natNotes.has(key)) {
      this.natNotes.add(key)
      this.deps.netLog('info', `NAT 文案与协商分类不同 (${raw} / ${remote})，打洞使用协商分类`)
    }
  }

  /** 每个对端各有一本"打到第几轮"的账（上游 ConnectionManager 是按对端分开算的） */
  _policy(peer) {
    let p = this.rounds.get(peer)
    if (!p) {
      p = new PunchRounds((message) => this.deps.netLog('info', message))
      this.rounds.set(peer, p)
    }
    return p
  }

  /** 别再用这些 socket / 连接打这个对端了 */
  stopPeerPunching(peer, keep) {
    for (const key of this.tcp.keys()) if (key === peer || key.startsWith(peer + ':direct:')) this._cancelTcp(key)
    for (const [id, link] of this.links) if (link.peer === peer && link !== keep) this.drop(id)
  }

  _cancelTcp(id) {
    const old = this.tcp.get(id)
    this.tcp.delete(id)
    old?.controller.abort()
    old?.stop?.()
  }

  later(callback, ms) {
    const epoch = this.generation
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (epoch === this.generation && this.session) callback()
    }, ms)
    this.timers.add(timer)
  }

  /** 给界面看的"当前总状态" */
  state(phase, status, address, detail) {
    if (!this.session) return
    if (this.lastConnection?.phase !== phase || (status === 'trying' && this.lastConnection.status !== 'trying')) this.stages = {}
    this.lastConnection = { phase, status, address: status === 'success' ? address : '', detail }
    this.deps.emit('conn:state', this.lastConnection)
  }

  /** 给界面看的"细分步骤"（探网络 / 打洞 / 就绪） */
  stage(key, status, detail) {
    if (!this.session) return
    const item = { key, status, detail, ts: Date.now() }
    this.stages[key] = item
    this.deps.emit('stage', item)
  }

  async sendSignal(type, data, to) {
    if (!this.session || this.session.isDone()) throw new Error('房间已退出')
    await this.session.request('/signal/send', { type, data, ...(to ? { to } : {}) })
  }

  setState(code, token, isHost, room, session) {
    this.code = code
    this.token = token
    this.isHost = isHost
    this.room = room
    this.session = session
    this.hostPort = room?.hostPort ?? 0
    this.hostIp = room?.hostIp ?? ''
  }

  // ---------------------------------------------------------------- 连接对象的生与死

  drop(id) {
    const link = this.links.get(id)
    if (!link) return
    this.links.delete(id)
    link.controller.abort()
    clearTimeout(link.timer)
    link.punch.stop()
    for (const punch of link.punchers) punch.stop()
    link.rudp?.close()
    for (const socket of link.sockets) try { socket.close() } catch {}
  }

  alive(id, link) {
    return (
      this.links.get(id) === link &&
      !link.controller.signal.aborted &&
      !!this.session &&
      !this.winner.has(link.peer) &&
      !this.turnChoices.has(link.peer) &&
      !this._turn.hasPeer(link.peer) &&
      (this.isHost || this.mode === 'p2p' || link.peer === 'relay')
    )
  }

  /**
   * 建一条"待打洞的连接"：开 UDP 口 + 探自己的公网地址 + 判网络类型。
   * `probe=false` 表示只要个 socket 不探地址（上游 joiner_extra 那条路）。
   */
  async prepare(id, auth, peer = id, reverse = false, probe = true) {
    const epoch = this.generation
    const socket = await punchListen(this.isHost && !reverse ? this.hostPort : 0)
    if (epoch !== this.generation || !this.session) {
      socket.close()
      throw new Error('房间已退出')
    }
    const punch = new Puncher({ conn: socket, authKey: auth })
    const link = {
      socket, punch, mapped: { ip: '', port: 0 }, delta: 0, auth,
      sockets: [socket], punchers: [], samples: [], nat: 'UNKNOWN',
      peer, reverse, ports: [], controller: new AbortController(),
    }
    this.drop(id)
    this.links.set(id, link)
    if (!probe) return link // ConnectionManager.java: joiner_extra 只开 socket，不探 STUN
    try {
      // ConnectionManager.java: 双 STUN，PROBE_SOCKET_TIMEOUT_MS
      const samples = await stunSampleSeries(socket, STUN_SERVERS, 2, 1, 1000, link.controller.signal)
      if (!this.alive(id, link)) throw new Error('连接已取消')
      if (!samples.length) throw new Error('暂未探测到公网映射，将继续尝试；也可手动使用中继')
      link.samples = samples
      link.mapped = samples[samples.length - 1]
      link.delta = stunDeltaFromSamples(samples)
      // ConnectionManager.java: hostEasySym 阈值 100
      link.nat = samples.length < 2 ? 'UNKNOWN' : link.delta === 0 ? 'CONE' : Math.abs(link.delta) <= 100 ? 'EASY_SYM' : 'HARD_SYM'
      if (symmetric(link.nat)) {
        // ConnectionManager.java: handleJoinRequest 里 P-PRE 采样 10 次 ×100ms
        const extra = await samplePortsSequential(socket, STUN_SERVERS, 10, 100, link.controller.signal)
        if (extra.length >= 5) {
          // ConnectionManager.java: P-PRE / calculatePortDelta（去掉头的 EMA，最小 1）；不挪 STUN 端点
          link.delta = Math.max(1, deltaPredict(extra.map((a) => a.port)) - extra[extra.length - 1].port)
          link.samples = extra
        }
      }
      if (!this.alive(id, link)) throw new Error('连接已取消')
      return link
    } catch (error) {
      if (this.links.get(id) === link) this.drop(id)
      throw error
    }
  }

  /** 多开几个 socket（对称 NAT 要一堆口一起敲），可选地也各自探一下 STUN */
  async addSockets(id, link, count, stun) {
    const profile = this._policy(link.peer).profile
    const queries = []
    for (let i = link.sockets.length; i < count && this.alive(id, link); i++) {
      try {
        const socket = await punchListen(0)
        if (!this.alive(id, link)) { socket.close(); break }
        link.sockets.push(socket)
        if (stun) {
          queries.push(stunSampleSeries(socket, STUN_SERVERS, profile.socketStunCount, 1, 1000, link.controller.signal).then((samples) => {
            const delta = stunDeltaFromSamples(samples)
            // ConnectionManager.java: 多 socket 双 STUN 升级，阈值 100
            if (samples.length >= 2 && delta !== 0) {
              link.nat = Math.abs(delta) <= 100 ? 'EASY_SYM' : 'HARD_SYM'
              link.delta = delta
            }
            return samples[0] ?? null
          }))
        }
      } catch { /* ConnectionManager.java: 个别 socket 开不出来就算了 */ }
      if (stun && profile.socketCreateIntervalMs) await delay(profile.socketCreateIntervalMs, undefined, { signal: link.controller.signal })
    }
    return [link.mapped, ...(await Promise.all(queries)).filter((a) => !!a)]
  }

  // ---------------------------------------------------------------- 核心：打洞

  async connect(id, link, remote, data = {}, relay = false) {
    if (!this.alive(id, link)) return
    link.remote = remote
    for (const punch of link.punchers) punch.setTarget({ address: remote.ip, port: remote.port })
    this.lastMappings.set(link.peer, { local: { address: link.mapped.ip, port: link.mapped.port }, remote: { address: remote.ip, port: remote.port } })
    if (link.started) return
    link.started = true
    clearTimeout(link.timer)
    const policy = this._policy(link.peer)
    const prefix = this.isHost ? 'joiner' : 'host'
    const remoteNat = data[`${prefix}Symmetric`] === true ? (data[`${prefix}EasySym`] === true ? 'EASY_SYM' : 'HARD_SYM') : 'CONE'
    policy.classify(link.nat, remoteNat, link.samples.length)
    this.reportNat(link.nat, remoteNat, link.peer)
    let profile = policy.profile
    let params = { ...(policy.params ?? fromProfile(profile)) }
    const epoch = this.generation
    let both = symmetric(link.nat) && symmetric(remoteNat)
    let count = 1
    let range = profile.defaultPortRange
    let mode = 'prediction'
    let fixedRange = false
    let ports = []
    if (data.mappedExtra === true) {
      range = profile.joinerMultiPortRange
    } else if (link.reverse) {
      fixedRange = true
      if (!this.isHost && symmetric(link.nat)) {
        // ConnectionManager.java: startReversePunch -> startBirthdayPunch
        count = link.nat === 'EASY_SYM' ? profile.birthdaySocketCount : profile.hardSymSocketCount
        range = link.nat === 'EASY_SYM' ? profile.easySymPortRange : symmetric(remoteNat) ? profile.defaultPortRange : profile.minPortRange
      } else if (this.isHost) {
        const advertised = Array.isArray(data.joinerMappedPorts)
          ? data.joinerMappedPorts.map(Number).filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
          : []
        range = both ? 0 : symmetric(remoteNat) ? profile.widePortRange : profile.defaultPortRange
        // ConnectionManager.java: 房主反向漂移窗口
        if (symmetric(link.nat) && Math.abs(link.delta) > range) range = Math.min(Math.abs(link.delta) * 2, profile.maxPortRange)
        params.timeoutMs = Math.max(params.timeoutMs, 12000) // ConnectionManager.java: hostRevParams
        if (advertised.length > 1) {
          const expanded = new Set()
          for (const p of advertised) for (let n = -profile.defaultPortRange; n <= profile.defaultPortRange; n++) if (p + n > 0 && p + n <= 65535) expanded.add(p + n)
          ports = [...expanded]
          mode = 'ports'
        }
      } else {
        range = profile.portPredictionMaxRange
        params.timeoutMs = Math.max(params.timeoutMs, 15000) // ConnectionManager.java: simpleRevParams
      }
    } else if (this.isHost) {
      count = symmetric(link.nat) ? profile.hardSymSocketCount : profile.hostMultiSocketCount
      range = symmetric(remoteNat) ? profile.joinerMultiPortRange : 0
      params.timeoutMs = Math.min(params.timeoutMs, profile.hostRoundTimeoutMs)
      // ConnectionManager.java: host roundParams
      if (range > 0) { params.sendMinRounds = 1; params.sendMinPass = 1 }
    } else if (link.nat === 'EASY_SYM' && remoteNat === 'EASY_SYM') {
      count = policy.round > 0 ? profile.easySymMutualRetrySocketCount : profile.easySymMutualSocketCount
      mode = 'group'
      params.easySymBomb = true
    } else {
      if (symmetric(link.nat)) {
        count = symmetric(remoteNat) ? profile.hardSymSocketCount : profile.joinerSymSocketCount
        mode = 'group'
      }
      range = symmetric(link.nat) && remoteNat === 'CONE' ? 0
        : symmetric(remoteNat) ? Math.max(Number(data.hostMappedPortRange) || profile.widePortRange, profile.maxPortRange)
        : policy.cycle === 0 ? profile.defaultPortRange : policy.cycle === 1 ? profile.widePortRange : profile.maxPortRange
    }
    this.stage(this.isHost ? 'host_punch' : relay ? 'relay' : 'punch', 'active', `正在建立${link.reverse ? '反向' : '直连'}通路 · 第 ${policy.round + 1} 轮`)
    try {
      const mappings = await this.addSockets(id, link, count, this.isHost || link.reverse)
      if (this.isHost && !link.reverse && symmetric(link.nat)) {
        // ConnectionManager.java: 双 STUN 升级之后，房主那组扩到 HARDSYM.hardSymSocketCount
        await this.addSockets(id, link, profile.hardSymSocketCount, false)
        policy.classify(link.nat, remoteNat, link.samples.length)
        profile = policy.profile
        params = fromProfile(profile)
        params.timeoutMs = Math.min(params.timeoutMs, profile.hostRoundTimeoutMs)
        if (range > 0) { params.sendMinRounds = 1; params.sendMinPass = 1 }
        both = symmetric(remoteNat)
      }
      if (!this.alive(id, link)) return
      if (link.reverse && !this.isHost) {
        await this.sendSignal('reverse_holepunch_offer', { ...this.mapping(link, 'joiner'), joinerMappedPorts: mappings.map((a) => a.port) }, 'host')
      }
      if (this.isHost) {
        await this.sendSignal(link.reverse ? 'reverse_punch_info' : 'holepunch_mapped', { ...this.mapping(link, 'host'), hostMappedPorts: mappings.map((a) => a.port) }, link.peer)
      }
      if (!this.alive(id, link)) return
      // 房主每个 socket 各打各的；客人的对称 NAT 走"一组共用一份发包额度"
      const groups = mode === 'group' ? [link.sockets] : link.sockets.map((socket) => [socket])
      link.punchers = groups.map((sockets) => {
        const punch = new Puncher({
          conn: sockets[0], sockets, authKey: link.auth, profile, params, mode, range, fixedRange,
          skipFirewall: both || symmetric(link.nat) || symmetric(remoteNat),
          sweepSpread: both ? profile.joinerMultiPortRange : 0,
        })
        punch.setTarget({ address: remote.ip, port: remote.port })
        if (ports.length) punch.setPredictedPorts(ports)
        punch.setOnPeer((addr) => {
          policy.receivedEver = true
          void this.sendSignal('peer_port', { peer_ip: addr.address, peer_port: addr.port }, link.peer).catch(() => {})
        })
        punch.start()
        return punch
      })
      const hostDeadline = Date.now() + 120000 // ConnectionManager.java: punchGroupDeadline，是**每组**的死线不是整场的
      let won
      while (true) {
        try {
          won = await Promise.any(link.punchers.map(async (punch) => ({ punch, target: await punch.wait() })))
          break
        } catch (error) {
          if (!this.isHost || link.reverse || !this.alive(id, link) || Date.now() >= hostDeadline) throw error
          for (const failure of error instanceof AggregateError ? error.errors : [error]) {
            if (failure instanceof PunchFailure) policy.record(failure.result)
          }
          if (policy.terminal) throw error
          await delay(300, undefined, { signal: link.controller.signal }) // ConnectionManager.java: 房主每轮之间歇 300ms
          if (symmetric(link.nat)) {
            void this.sendSignal('holepunch_mapped', { ...this.mapping(link, 'host'), hostMappedPorts: mappings.map((a) => a.port) }, link.peer).catch(() => {})
          }
          link.punchers = groups.map((sockets) => {
            const punch = new Puncher({
              conn: sockets[0], sockets, authKey: link.auth, profile, params, mode, range, fixedRange,
              skipFirewall: both || symmetric(link.nat) || symmetric(remoteNat),
            })
            const current = link.remote ?? remote
            punch.setTarget({ address: current.ip, port: current.port })
            punch.setOnPeer(() => { policy.receivedEver = true })
            punch.start()
            return punch
          })
        }
      }
      if (epoch !== this.generation || !this.alive(id, link)) return
      this.winner.set(link.peer, id)
      this.stopPeerPunching(link.peer, link)
      for (const punch of link.punchers) punch.stop()
      link.punch = won.punch
      link.socket = won.punch.conn
      for (const socket of link.sockets) if (socket !== link.socket) try { socket.close() } catch {}
      link.sockets = [link.socket]
      const rc = link.rudp = new RudpConn(link.socket, won.target, { authKey: link.auth })
      rc.start()
      if (this.isHost) {
        rc.setOnClosed(() => { if (this.links.get(id) === link) { this.winner.delete(link.peer); this.drop(id) } })
        // V4 才会在这里把游戏端口接上去（上游是 startHostLazyBridge）
        this.stage('host_punch', 'ok', '玩家通路已建立，等待游戏连接')
      } else {
        // V4 才会在这里起 TcpBridge.startGuest 搬游戏数据；这一步只宣布"路通了"
        this._turn.stop()
        this.relayPending = false
        this.state(relay ? 'prelay' : 'p2p', 'success', `${link.mapped.ip}:${link.mapped.port}`, relay ? '玩家中继已连接' : '连接成功')
        this.stage(relay ? 'relay' : 'punch', 'ok', '通路已就绪')
        void this.sendSignal('connected', {}, 'host').catch((error) => this.deps.netLog('warn', error.message))
      }
    } catch (error) {
      if (epoch !== this.generation || this.links.get(id) !== link) return
      const failures = error instanceof AggregateError ? error.errors : [error]
      for (const failure of failures) if (failure instanceof PunchFailure) policy.record(failure.result)
      this.winner.delete(link.peer)
      this.drop(id)
      this.stage(this.isHost ? 'host_punch' : relay ? 'relay' : 'punch', 'retry', policy.terminal ? '未收到对方回应，可手动选择中继' : '本轮未连通，继续尝试')
      if (!this.isHost && !relay) {
        // ConnectionManager.java: 第二轮才轮到 TCP（Wave 2）—— **V4 的活**，这里只把重连排上
        if (epoch === this.generation) this.reconnect(failures.some((e) => e instanceof PunchFailure && e.result.firewallDetected))
      }
    }
  }

  mapping(link, prefix) {
    // ConnectionManager.java: handleJoinRequest 的 symOrUnknown。
    // 只探到一次 STUN 的时候**不许**对外自称"确认的锥型"。
    return {
      [`${prefix}MappedIp`]: link.mapped.ip,
      [`${prefix}MappedPort`]: link.mapped.port,
      [`${prefix}MappedPortDelta`]: link.delta,
      [`${prefix}MappedPortRange`]: predict(link.samples.map((a) => a.port)).range,
      [`${prefix}Symmetric`]: symmetric(link.nat) || (prefix === 'host' && link.nat === 'UNKNOWN'),
      [`${prefix}EasySym`]: link.nat === 'EASY_SYM',
    }
  }

  // ---------------------------------------------------------------- 重连编排

  reconnect(firewall = false) {
    if (this.isHost || !this.session || this.reconnectPending || this.mode !== 'p2p' || this.winner.has('host')) return
    if ([...this.links.values()].some((l) => l.peer === 'host' && l.started)) return
    if ([...this.tcp.entries()].some(([key, value]) => (key === 'host' || key.startsWith('host:direct:')) && !value.stop)) return
    const policy = this._policy('host')
    const wait = policy.advance(firewall)
    if (policy.terminal) {
      this.state('p2p', 'failed', '', '未收到对方的网络回应。可手动使用 TURN 中继，或退出后重新加入')
      void this.sendSignal('cancel_connection', {}, 'host').catch(() => {})
      return
    }
    this.reconnectPending = true
    this.state('p2p', 'trying', '', `正在重新协商连接 · 第 ${policy.round + 1} 轮`)
    this.later(() => {
      this.reconnectPending = false
      if (this.mode !== 'p2p' || this.winner.has('host')) return
      // launcher-integration.md §7.5：服务器在 /room/join 成功时**注入** join_request。
      // **绝不许**客户端自造一个 1.5 秒的直发定时器。重新进房顺带把凭证也刷新了。
      void this.deps.rejoin?.().catch((error) => {
        this.deps.netLog('warn', error.message)
        this.reconnect()
      })
    }, wait)
  }

  // ---------------------------------------------------------------- 两侧的入口

  /** 房主：有人敲门（join_request）→ 探自己的网络 → 报给客人 */
  async hostOffer(from, data = {}) {
    if (this.creating.has(from) || this.links.get(from)?.started || this.winner.has(from) || this.turnChoices.has(from) || this._turn.hasPeer(from)) return
    this.creating.add(from)
    try {
      this.stage('host_stun', 'active', '正在探测网络')
      const caps = Array.isArray(data.clientCapabilities) ? data.clientCapabilities : Array.isArray(data.capabilities) ? data.capabilities : []
      const link = await this.prepare(from, caps.includes('punchAuthV1') || data.punchAuthV1 === true ? derivePunchKey(this.code, from) : null)
      if (!this.alive(from, link)) return
      const addresses = Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal)
      // ConnectionManager.java: offer 的 RTT 同步窗口 3000ms
      await this.sendSignal('holepunch_offer', {
        hostIp: this.hostIp,
        hostPort: this.hostPort,
        hostLocalIp: addresses.find((a) => a?.family === 'IPv4')?.address,
        hostIpv6: addresses.find((a) => a?.family === 'IPv6' && !a.address.startsWith('fe80:'))?.address,
        ...this.mapping(link, 'host'),
        punchAuthV1: !!link.auth,
        punchSyncTimeMs: Date.now() + 3000,
        punchSyncSentAtMs: Date.now(),
      }, from)
      this.stage('host_stun', 'ok', '网络探测完成，等待玩家回应')
    } finally {
      this.creating.delete(from)
    }
  }

  /** 客人：收到房主的 holepunch_offer → 探自己的网络 → 决定用什么打法 */
  async guestOffer(data) {
    if (this.creating.has('host') || this.links.get('host')?.started || this.winner.has('host') || this.mode !== 'p2p') return
    this.creating.add('host')
    this.stage('stun', 'active', '正在探测网络')
    try {
      const auth = this.room?.hostCapabilities?.includes('punchAuthV1') ? derivePunchKey(this.code, this.clientID) : null
      const link = await this.prepare('host', auth)
      const policy = this._policy('host')
      const remoteNat = data.hostSymmetric === true ? (data.hostEasySym === true ? 'EASY_SYM' : 'HARD_SYM') : 'CONE'
      policy.classify(link.nat, remoteNat, link.samples.length)
      this.stage('stun', 'ok', '网络探测完成')
      const strategy = selectStrategy(link.nat, remoteNat, policy.cycle, false)
      const target = endpoint(data, 'hostMapped')
      if (!target) throw new Error('房主网络地址尚未就绪')
      // ConnectionManager.java: 第一波（Wave 1）里 TCP / IPv6 和 UDP 一起抢 —— **V4 的活**（runDirect 没搬）
      // ConnectionManager.java: Wave 1 按策略分派，反向那条路另开 socket
      const reverse = policy.params?.skipDirectPunch || strategy === 'REVERSE_ONLY' || strategy === 'REVERSE_THEN_FORWARD' ||
        strategy === 'PARALLEL_FROM_START' || (strategy === 'REVERSE_FIRST' && policy.cycle === 0) ||
        (strategy === 'DIRECT_ONLY' && policy.cycle === 0) || (strategy === 'DIRECT_WITH_REVERSE_PARALLEL' && policy.cycle >= 1) ||
        (strategy === 'RELAY_FALLBACK_FAST' && policy.cycle >= 1)
      if (reverse) {
        void (async () => {
          const r = await this.prepare('host:reverse', auth, 'host', true)
          await this.connect('host:reverse', r, target, data)
        })().catch((e) => {
          if (this.mode === 'p2p') {
            this.deps.netLog('warn', e.message)
            this.reconnect()
          }
        })
      }
      if (strategy !== 'REVERSE_ONLY' && !policy.params?.skipDirectPunch) {
        await this.sendSignal('punch_info', { ...this.mapping(link, 'joiner'), joinerOfferRecvMs: Date.now() }, 'host')
        void this.connect('host', link, target, data)
      } else {
        this.drop('host')
      }
      // 上游这里还有 cycle>=1 时发 tcp_punch_info —— **V4 的活**（TCP 通路没搬）
    } catch (error) {
      this.deps.netLog('warn', error.message)
      this.reconnect()
    } finally {
      this.creating.delete('host')
    }
  }

  // ---------------------------------------------------------------- 收到信号

  onSignal(type, from, data) {
    if (!this.session || this.session.isDone()) return
    if (!this.acceptSignal(type, from)) return
    const run = async () => {
      if (type === 'cancel_connection' || type === 'disconnect') {
        this.winner.delete(from)
        this.turnChoices.delete(from)
        this.stopPeerPunching(from)
        this._turn.peerLeft(from)
        if (!this.isHost && from === 'host') {
          this.mode = 'direct'
          this.state('p2p', 'failed', '', '对方已结束连接，请退出后重新加入')
        }
        return
      }
      if (type.startsWith('turn_')) {
        // TURN 是 V3，这就是那个空替身（守卫形状照抄上游）
        if (type === 'turn_alloc' && this.isHost && !this.winner.has(from)) {
          this.turnChoices.add(from)
          this.stopPeerPunching(from)
        }
        if (this.isHost || this.mode === 'turn') await this._turn.onSignal(type, from, data)
        return
      }
      if (!this.isHost && this.mode === 'turn' && type === 'relay_notify') { await this._turn.onSignal(type, from, data); return }
      if (this.isHost && type === 'relay_accept' && typeof data.forClientId === 'string') {
        const assignment = this.relayAssignments.get(data.forClientId)
        if (!assignment || assignment.candidate !== from || Date.now() - assignment.at > 20000) return
        const relay = endpoint(data, 'relay')
        if (!relay && data.connected === false) return
        await this.sendSignal('relay_notify', relay ? { relayIp: relay.ip, relayPort: relay.port, connected: data.connected === true } : { connected: true }, data.forClientId)
        return
      }
      if (!this.isHost && this.mode !== 'p2p' && !['relay_notify', 'relay_declined', 'relay_setup'].includes(type)) return
      if (this.isHost && this.turnChoices.has(from) && type !== 'relay_request') return
      if (this.winner.has(from) && type !== 'relay_setup' && type !== 'relay_request') return
      if (type === 'ice_restart') {
        if (!this.isHost && from !== 'host') return
        const previous = this.iceRestarts.get(from) || { count: 0, at: 0 }
        if (previous.count >= 3 || Date.now() - previous.at < 5000) return
        this.iceRestarts.set(from, { count: previous.count + 1, at: Date.now() })
        this._cancelTcp(from)
        this.drop(from)
        this._turn.peerLeft(from)
        if (this.isHost) await this.hostOffer(from)
        else {
          this.state('p2p', 'trying', '', '对端请求重新建立连接')
          this.reconnect()
        }
        return
      }
      if (type === 'peer_port') return // 观测到的对端地址只是诊断用，**永远不是**我们的目标
      if (this.isHost) {
        if (type === 'tcp_punch_info') return // TCP 同时打开 —— V4 的活
        if (type === 'join_request') await this.hostOffer(from, data)
        if (type === 'punch_info' || type === 'reverse_holepunch_offer') {
          const reverse = type === 'reverse_holepunch_offer'
          const id = reverse ? from + ':reverse' : from
          const remote = endpoint(data, 'joinerMapped')
          if (remote && !this._turn.hasPeer(from) && !this.winner.has(from)) {
            let link = this.links.get(id)
            if (!link && reverse) link = await this.prepare(id, this.links.get(from)?.auth ?? null, from, true)
            if (link) void this.connect(id, link, remote, data)
          }
        }
        if (type === 'relay_request') return // 玩家中继 —— V3 的活
      } else if (from === 'host') {
        if (type === 'tcp_punch_go') return // TCP 同时打开 —— V4 的活
        if (type === 'holepunch_offer') await this.guestOffer(data)
        if (type === 'holepunch_mapped' || type === 'reverse_punch_info') {
          const id = type === 'reverse_punch_info' ? 'host:reverse' : 'host'
          const link = this.links.get(id)
          const remote = endpoint(data, 'hostMapped')
          if (link && remote) {
            void this.connect(id, link, remote, data)
            if (type === 'holepunch_mapped' && Array.isArray(data.hostMappedPorts)) {
              const ports = data.hostMappedPorts.map(Number).filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
              if (JSON.stringify(link.ports) !== JSON.stringify(ports)) {
                link.ports = ports
                for (const key of [...this.links.keys()]) if (key.startsWith('host:extra:')) this.drop(key)
                // ConnectionManager.java: handleHolepunchMapped 的 maxExtraCap，同一个 CGNAT 下 12，否则 6
                const cap = link.mapped.ip === remote.ip ? 12 : 6
                for (let i = 1; i < Math.min(ports.length, cap); i++) {
                  void (async () => {
                    const key = `host:extra:${i}`
                    const extra = await this.prepare(key, link.auth, 'host', false, false)
                    extra.nat = link.nat
                    extra.samples = link.samples
                    if (this.alive(key, extra)) await this.connect(key, extra, { ip: remote.ip, port: ports[i] }, { ...data, mappedExtra: true })
                  })().catch(() => {})
                }
              }
            }
          }
        }
        if (type === 'relay_declined') { this.relayPending = false; this.state('prelay', 'failed', '', '当前没有可用的玩家中继') }
        if (type === 'relay_notify' && !data.connected && this.mode === 'prelay') {
          const remote = endpoint(data, 'relay')
          if (remote) { const link = await this.prepare('relay', null); void this.connect('relay', link, remote, {}, true) }
        }
        if (type === 'relay_setup') return // 玩家中继 —— V3 的活
      }
    }
    void run().catch((error) => { if (this.session) this.deps.netLog('warn', error.message) })
  }

  /** 上游是"这条信号我认不认"的守卫，V2c 里先照抄成"都认"（V4 接游戏时才有得挑） */
  acceptSignal(_type, _from) { return true }

  // ---------------------------------------------------------------- 收摊

  teardown(retry = false) {
    this.generation++
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (!retry) {
      this.rounds.clear()
      this.knownPeers.clear()
      this.natNotes.clear()
    }
    this.lastMappings.clear()
    this.iceRestarts.clear()
    this.winner.clear()
    this.turnChoices.clear()
    this.reconnectPending = false
    for (const id of [...this.tcp.keys()]) this._cancelTcp(id)
    this._turn.stop()
    for (const id of [...this.links.keys()]) this.drop(id)
    this.creating.clear()
    this.relayPending = false
    if (!retry) this.joinedAt = 0
    this.mode = 'p2p'
    this.lastConnection = null
    this.stages = {}
  }
}

module.exports = { ConnEngine, endpoint }

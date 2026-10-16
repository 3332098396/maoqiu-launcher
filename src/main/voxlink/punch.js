// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (c) 2026 毛球 (Maoqiu) · https://github.com/3332098396/maoqiu-launcher —— 移植/改编自 VoxLink，本文件按 LGPL-3.0 提供（见 THIRD_PARTY_NOTICES.md）
//
// 逐语句移植自 AUGUHDAR/VoxLink 的 `network/UdpHolePuncher.java`（修订 924845e，LGPL-3.0）。
// 改写参考了 KAMUCL 的 JS 实现（`src/main/core/voxlink/punch.ts`，作者 KAMUCL contributors）——
// 唯一的结构性改动是 **Node 的 UDP 事件回调代替 Java 的 NIO selector**（语言翻译，非机制改动）。
// 见 THIRD_PARTY_NOTICES.md —— 本文件**不适用**仓库根的 MIT，按 LGPL-3.0-only 提供。
//
// 干什么：两边各自躲在路由器后面，都想先给对面发个包。
// 路由器会把"我们刚发过包的那个对面地址"临时放行 —— 所以只要**同时**发，两边的门就互相打开了。
// 难点在于"对面到底会在哪个端口露头"：锥型 NAT 基本不变，对称 NAT 每发一次就换一个。
// 于是这里轮着用三种打法：
//   ① prediction —— 按端口预测算出一圈端口，上下交替扫（见 punchPolicy.js）
//   ② ports      —— 只敲给定的一串端口
//   ③ group      —— 多开几个 socket 一起敲（对称 NAT 用），带"喷"和"炸"两种激进模式
//
// 包格式：`V L 类型 0 0 | nonce(2 字节)`（5 字节头 + 2 字节随机数），有密钥时尾巴挂 4 字节 HMAC 章。
// 类型 1 = PUNCH（我敲你），类型 2 = ACK（我收到了）。收到任何一个都算打通，回一个 ACK 就结束。
//
// §0 纪律：这里每一个数值、每一处取整、每一条守卫都与源码逐值一致，不许"看着差不多"改。
// 特别是：`timeoutMs` 是**每次尝试的超时**，不是整场会话的死线。

const dgram = require('node:dgram')
const net = require('node:net')
const { randomBytes } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { signPunchFrame, verifyPunchFrame } = require('./punchAuth')
const { DEFAULT } = require('./punchProfiles')
const { fromProfile } = require('./punchPolicy')

/** 组一个控制包。类型 1 = PUNCH、2 = ACK；前两字节是 "VL"（86 76）魔术字 */
function punchBuildControl(type, nonce) {
  const b = Buffer.from([86, 76, type, 0, 0]) // UdpHolePuncher.java: MAGIC, CONTROL_PLAIN_LEN
  b.writeUInt16BE(nonce & 65535, 3); return b
}
/** 认这是不是我们的控制包（只认 PUNCH/ACK 两种类型），不是就返回 null */
function punchParseControl(b) {
  return b.length >= 5 && b[0] === 86 && b[1] === 76 && (b[2] === 1 || b[2] === 2) ? { type: b[2], nonce: b.readUInt16BE(3) } : null
}
const punchRandomNonce = () => randomBytes(2).readUInt16BE() // UdpHolePuncher.java: sessionNonce

/**
 * 这个包该不该收：地址完全一致 → 收。
 * 不一致时，**只有没挂密钥的控制包**才允许"前两段相同的运营商大内网漂移"（CGNAT /16）——
 * 挂了密钥的包必须逐字节对得上地址，否则回包地址一变就等于把门打开了。
 */
function punchAcceptSource(expected, actual, authenticated = false) {
  if (!expected || !actual) return false
  if (expected.address === actual.address) return true
  // UdpHolePuncher.java: acceptAddress /16 CGNAT drift only for unauthenticated control.
  return !authenticated && net.isIPv4(expected.address) && net.isIPv4(actual.address) && expected.address.split('.').slice(0, 2).join('.') === actual.address.split('.').slice(0, 2).join('.')
}

async function udpSendTo(socket, data, remote) {
  if (socket && remote) await new Promise((resolve, reject) => { try { socket.send(data, remote.port, remote.address, error => error ? reject(error) : resolve()) } catch (error) { reject(error) } })
}
async function sendPkt(socket, packet, remote) {
  for (let attempt = 0; attempt < 3; attempt++) { // UdpHolePuncher.java: sendPkt ICMP/WSAECONNRESET retries
    try { await udpSendTo(socket, packet, remote); return } catch { /* retry clears Windows ICMP latch */ }
  }
}

/**
 * 限速器：**累计预算**式，不是"每秒清零"。
 * 每发一个包就记一笔，按"从开始到现在一共允许发多少"算有没有超；超了就返回该等多少毫秒。
 * （它算的是**从启动到现在**的累计账，不是"每秒清零"——"每秒"那种写法在突发时挡不住。）
 */
class PpsLimiter {
  constructor(maxPps, now = () => performance.now()) { this.maxPps = maxPps; this.now = now; this.start = now(); this.sent = 0 }
  beforeSendDelay() {
    // UdpHolePuncher.java: PpsLimiter.beforeSend cumulative monotonic budget.
    this.sent++
    const allowed = Math.floor((this.now() - this.start) * Math.max(1, this.maxPps) / 1000)
    return this.sent > allowed ? (this.sent - allowed) * 1000 / Math.max(1, this.maxPps) : 0
  }
}

const shuffle = (values, random) => {
  for (let i = values.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [values[i], values[j]] = [values[j], values[i]] } return values
}

/**
 * 围绕对方端口要敲哪些端口。
 * 范围小（≤20）就老老实实左右交替扫；范围大就**随机挑** window 个（固定的那 800 个窗口大小）。
 * 源码在随机分支里会把中心端口重复放一次，这里照旧保留（不是笔误）。
 */
function controlPorts(center, range, window, random = Math.random) {
  // UdpHolePuncher.java: sendControlMultiPort. Retain the source's duplicate center
  // in the random branch; sample the full range (fixes the old upstream endless loop).
  const ports = [center]
  if (range > 20) { // UdpHolePuncher.java: useRandomScan threshold
    const lo = Math.max(1, center - range), hi = Math.min(65535, center + range), max = Math.min(window, hi - lo), chosen = new Set([center])
    while (chosen.size < max + 1) chosen.add(lo + Math.floor(random() * (hi - lo + 1)))
    ports.push(...shuffle([...chosen], random))
  } else for (let offset = 1; offset <= range; offset++) { if (center - offset > 0) ports.push(center - offset); if (center + offset <= 65535) ports.push(center + offset) }
  return ports
}

/** 一轮没打通时抛这个，身上带着"这轮干了什么"的数据（给调参用） */
class PunchFailure extends Error { constructor(result) { super(result.firewallDetected ? '本轮未收到 UDP 回包' : '本轮打洞未命中'); this.name = 'PunchFailure'; this.result = result } }

class Puncher {
  constructor(options) {
    this.options = options
    this.conn = options.conn
    this.nonce = punchRandomNonce()
    this.profile = options.profile ?? DEFAULT
    this.params = { ...(options.params ?? fromProfile(this.profile)) }
    this.timeoutMs = options.timeoutMs ?? this.params.timeoutMs
    this.remote = null; this.ports = []; this.timeout = undefined
    this.controller = new AbortController(); this.active = false; this.settled = false; this.startedAt = 0
    this.receivers = new Map(); this.sprayCursor = 0
    // UdpHolePuncher.java: prediction path and punchEasySymDual wrapper mark failed
    // results; generic punchMultiSocket and punchMultiPort do not mark prediction.
    this.stats = { socketsTried: options.sockets?.length || 1, socketsReceivedPunch: 0, socketsReceivedAck: 0, predictionDelta: 0, elapsedMs: 0, firewallDetected: false, portPredictionActive: options.mode === 'group' ? this.params.easySymBomb : options.mode !== 'ports' && (options.range ?? 0) > 0, success: false }
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject }); void this.result.catch(() => {})
  }
  get sockets() { return this.options.sockets?.length ? this.options.sockets : [this.options.conn] }
  setOnPeer(callback) { this.notify = callback }
  setTarget(address) { this.remote = address }
  setPredictedPorts(ports) { this.ports = [...new Set(ports)].filter(p => Number.isInteger(p) && p > 0 && p <= 65535) }

  /** 收到包：验章 → 认类型 → 回 ACK → 这轮算成功 */
  message(socket, packet, from) {
    if (!this.active || this.settled) return
    const verified = verifyPunchFrame(packet, this.options.authKey), frame = verified && punchParseControl(verified)
    if (!frame || !punchAcceptSource(this.remote, from, !!this.options.authKey)) return
    if (frame.type === 1) this.stats.socketsReceivedPunch++; else this.stats.socketsReceivedAck++
    const actual = { address: from.address, port: from.port }; this.remote = actual
    // UdpHolePuncher.java: sendControlTo(TYPE_ACK) uses OUR nonce for PUNCH and ACK.
    void sendPkt(socket, signPunchFrame(punchBuildControl(2, this.nonce), this.options.authKey), actual)
    this.stats.success = true; this.stats.elapsedMs = performance.now() - this.startedAt
    this.conn = socket; this.settled = true; this.cleanup(); this.notify?.(actual); this.resolve(actual)
  }
  async sleep(ms) { await delay(ms, undefined, { signal: this.controller.signal }) }
  async send(socket, port, limiter) {
    if (!this.active || !this.remote || port < 1 || port > 65535) return
    if (limiter) { const ms = limiter.beforeSendDelay(); if (ms > 0) await this.sleep(ms) }
    if (!this.active || !this.remote) return
    await sendPkt(socket, signPunchFrame(punchBuildControl(1, this.nonce), this.options.authKey), { address: this.remote.address, port })
  }
  fail(firewall = false) {
    if (this.settled) return
    this.stats.elapsedMs = performance.now() - this.startedAt; this.stats.firewallDetected = firewall
    this.settled = true; this.cleanup(); this.reject(new PunchFailure({ ...this.stats }))
  }
  /** 对称 NAT 的"喷"：一轮里换着端口猛敲，轮次越靠后敲得越少（衰减），但有下限 */
  async spray(round, limiter) {
    const p = this.params, random = this.options.random ?? Math.random
    // UdpHolePuncher.java: sprayRound Fisher-Yates over all ports, persistent cursor.
    this.sprayTable ??= shuffle(Array.from({ length: 65535 }, (_, i) => i + 1), random)
    for (let r = 0; r < p.sprayPacketsPerPort && this.active; r++) await this.send(this.options.conn, this.remote.port, limiter)
    const base = p.sprayPortCountMin + Math.floor(random() * Math.max(1, p.sprayPortCountMax - p.sprayPortCountMin + 1))
    const count = round > 2 ? Math.max(Math.trunc(base * p.sprayDecayNumerator / round), p.sprayDecayFloor) : base // UdpHolePuncher.java: sprayRound decay starts after round 2
    for (let i = 0; i < count && this.active; i++) {
      const port = this.sprayTable[this.sprayCursor++ % this.sprayTable.length], socket = this.sockets[i % this.sockets.length]
      for (let r = 0; r < p.sprayPacketsPerPort && this.active; r++) await this.send(socket, port, limiter)
      await this.sleep(Math.max(0, p.sprayPortIntervalMs))
    }
  }

  /** 主循环：按打法一轮一轮发包，直到收到回应（message() 负责收尾）或超时 */
  async sendLoop() {
    const p = this.params, s = this.profile.send, group = this.options.mode === 'group'
    const interval = group && p.easySymBomb ? Math.min(p.sendInterval, Math.max(1, p.bombRoundIntervalMs)) : p.sendInterval
    const maxCycles = Math.trunc(this.timeoutMs / interval), limiter = new PpsLimiter(this.profile.sym.maxPps)
    for (let cycle = 0; cycle < maxCycles && this.active; cycle++) {
      if (!this.remote) { await this.sleep(interval); continue }
      if (group) {
        // 多 socket 一起敲了好几轮却一个回包都没有 → 判定"被防火墙吞了"，早死早超生
        if (this.sockets.length > 1 && !this.options.skipFirewall && cycle >= this.profile.firewallDetectCycles && !this.stats.socketsReceivedPunch) { this.fail(true); return }
        if (p.hardSymSpray) { await this.spray(cycle + 1, limiter); continue }
        if (p.easySymBomb) {
          for (const socket of this.sockets) for (let off = -p.bombWindow; off <= p.bombWindow && this.active; off++) await this.send(socket, Math.max(1, Math.min(65535, this.remote.port + off)), limiter)
        } else {
          const spread = this.options.sweepSpread ?? 0
          for (let i = 0; i < this.sockets.length && this.active; i++) {
            const port = this.remote.port + (spread > 0 ? i % (spread * 2 + 1) - spread : 0)
            for (let r = 0; r < 3 && this.active; r++) await this.send(this.sockets[i], port) // UdpHolePuncher.java: classic group 3 packets/socket
          }
        }
        await this.sleep(p.easySymBomb && performance.now() - this.startedAt < p.bombDurationMs ? p.bombRoundIntervalMs : p.sendInterval)
      } else if (this.options.mode === 'ports') {
        for (const port of this.ports) { if (!this.active) break; await this.send(this.conn, port) } await this.sleep(p.sendInterval)
      } else {
        const range = this.options.range ?? 0
        if (range > 0) {
          const progressive = this.profile.progressiveRanges[Math.min(Math.trunc(cycle / this.profile.cyclesPerRange), this.profile.progressiveRanges.length - 1)]
          const currentRange = this.options.fixedRange ? range : Math.min(range || p.portRange, progressive)
          const ports = controlPorts(this.remote.port, currentRange, s.sweepWindowSize, this.options.random)
          for (let pass = 0; pass < (p.sendMinRounds || s.minRounds) && this.active; pass++) {
            for (let i = 0; i < ports.length && this.active; i++) {
              for (let r = 0; r < (p.sendMinPass || s.minPass) && this.active; r++) await this.send(this.conn, ports[i])
              if (i < ports.length - 1) await this.sleep(s.sleepShortMs)
            }
            if (pass < 2) await this.sleep(s.sleepLongMs) // UdpHolePuncher.java: roundPass < 2
          }
        } else await this.send(this.conn, this.remote.port)
        await this.sleep(p.sendInterval)
      }
    }
    this.fail()
  }

  start() {
    if (this.active || this.settled) return
    this.active = true; this.startedAt = performance.now()
    for (const socket of this.sockets) { const receiver = (b, from) => this.message(socket, b, from); this.receivers.set(socket, receiver); socket.on('message', receiver) }
    // UdpHolePuncher.java: per-attempt guard, NOT a session deadline.
    this.timeout = setTimeout(() => this.fail(), this.timeoutMs + (this.options.mode === 'ports' ? this.profile.send.extraWaitLongMs : this.profile.send.extraWaitMs))
    void this.sendLoop().catch(error => { if (!this.controller.signal.aborted) { this.settled = true; this.cleanup(); this.reject(error) } })
  }
  wait() { return this.result }
  cleanup() { this.active = false; clearTimeout(this.timeout); this.controller.abort(); for (const [socket, receiver] of this.receivers) socket.off('message', receiver); this.receivers.clear() }
  stop() { this.cleanup(); if (!this.settled) { this.settled = true; this.reject(new Error('打洞已取消')) } }
}

/** 开一个收发包用的 UDP socket：能绑到想绑的端口就绑，绑不上（被占）就随便挑一个 */
async function punchListen(preferredPort) {
  async function bind(port) {
    const socket = dgram.createSocket('udp4')
    try { await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(port, () => { socket.off('error', reject); resolve() }) }); socket.on('error', () => { }); return socket }
    catch (e) { try { socket.close() } catch { } throw e }
  }
  if (Number.isInteger(preferredPort) && preferredPort > 0 && preferredPort <= 65535) try { return await bind(preferredPort) } catch { }
  return bind(0)
}

module.exports = {
  punchBuildControl, punchParseControl, punchRandomNonce, punchAcceptSource,
  udpSendTo, PpsLimiter, controlPorts, PunchFailure, Puncher, punchListen,
}

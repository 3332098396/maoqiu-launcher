// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — VoxLink 联机 · 第 2 层：房间里"喊话"的那条通道
//
// 【为什么需要这个文件】
// "建房"只是一次性的动作：跟服务器说一声，拿到一个 6 位房间码就完事了。
// 但联机玩的整个过程里，房间里的人要**不停地互相说话**：
//
//     "我的公网地址是 1.2.3.4:5678，你朝这儿打"
//     "我这儿也是，我来打你"
//     "你还在吗？"
//
// 这些话（上游叫 signal，信号）**不是我们直接发给对方的** —— 我们和对方之间
// 根本还没有路（路正是要谈出来的东西）。所以全部先发给**服务器**，
// 服务器替我们转给房间里对应的人。这个文件就是管这条"转话"通道的：
//
//   · 说一句   → request('/signal/send', { type, data, to })
//   · 听一句   → 每 1 秒问一次 '/signal/poll'（"上次之后有新话吗？"）
//   · 报个到   → 每 5 秒 '/room/heartbeat'（"我还活着"，顺便问房间有没有变化）
//
// 【为什么轮询，而不是让服务器推给我们】
// 上游（VoxLink）有两条路：WebSocket（服务器主动推，信号几乎立刻到）和 HTTP 轮询。
// 上游**自己**在 WebSocket 连不上/断线时就退化成轮询 —— 这是它源码里的既有分支，
// 不是我们发明的。毛球只走轮询这一条，原因很实在：
// **毛球的硬规矩是"运行时不引入任何第三方依赖"**，而 Node 自带的那套 WebSocket
// 不认上游用到的 ping 帧和"35 秒没动静就重连"的看门狗。
// 代价说得明明白白：**信号最慢晚 1 秒送到**。打洞本来就要打好几十轮、每轮好几秒，
// 晚这一秒不影响能不能打通。
//
// 【"重"和"去重"】
// 轮询这玩意儿天生会重复：网络抖一下重问一次，同一句话可能又问回来两遍。
// 所以每句话都带一个编号（`id`），见过的编号记在一个小本子上，重复的直接丢掉。
// 本子最多记 2048 条，满了就从头开始扔最旧的 —— 只是去重，不存档。
//
// 【什么时候这条通道算"废了"】
// 服务器回 `ROOM_NOT_FOUND` / `ROOM_EXPIRED` / `ROOM_CLOSED` / `ROOM_EVICTED` /
// `INVALID_TOKEN`（或者 HTTP 410）—— 意思是"这个房间没了/你被踢了"，
// 这不是网抖，是**散伙**：直接收摊，并且通知界面上说清楚。
// 反过来，只是网抖（超时、连不上）就换个节奏继续试：心跳连着失败 8 次，
// 把频率降到 30 秒一次，并且告诉界面"信令暂时不可用"——但**不退出房间**。
//
// SPDX-License-Identifier: LGPL-3.0-only
//
// 逐语句移植自 AUGUHDAR/VoxLink 的 `SignalingWsTransport.java` / `RoomManager.java`
// （基线修订 924845e，协议契约 c475faa9，LGPL-3.0）。
// 原作者：AUGUHDAR / VoxLink contributors。
// 改写参考了 KAMUCL 的 JS 实现（`src/main/core/voxlink/session.ts`，作者 KAMUCL contributors）。
// 见 THIRD_PARTY_NOTICES.md —— 本文件**不适用**仓库根的 MIT，按 LGPL-3.0-only 提供。
//
// §0 纪律：端点、字段、节奏、守卫一个都不许改。

const { EventEmitter } = require('node:events')
const { APIError } = require('./api')

/** 这些错误码不是网抖，是"房间没了/你被踢了"——收到就收摊，别傻等。 */
const FATAL_CODES = ['ROOM_NOT_FOUND', 'ROOM_EXPIRED', 'ROOM_CLOSED', 'ROOM_EVICTED', 'INVALID_TOKEN']

/** 心跳的默认间隔，以及上下限（服务器可以让我们改成别的）。 */
const HEARTBEAT_MS = 5000
const HEARTBEAT_MIN_MS = 1000
const HEARTBEAT_MAX_MS = 30000

/** 心跳连着失败这么多次，就降频到 30 秒 —— 但房间不退出，路还留着。 */
const HEARTBEAT_FAILURES_BEFORE_DEGRADE = 8
const DEGRADED_HEARTBEAT_MS = 30000

/** 没话的时候，隔多久问一次"有新话吗"。 */
const POLL_MS = 1000

/** 去重本子最多记多少条。满了扔最旧的（只是去重，不存档）。 */
const SEEN_LIMIT = 2048

/**
 * 房间里的一条常驻连接。
 *
 * 它只干三件事：发话、收话、报到。**不碰打洞，也不碰游戏** ——
 * 那些是上层的事，它们都通过这里说话。
 *
 * 用法：`new VoxLinkSession(app, {code, token, isHost})`，然后 `run()`（一直跑到 `stop()`）。
 * 收到的话从 `'engineSignal'` 事件出来。
 */
class VoxLinkSession extends EventEmitter {
  constructor(app, options) {
    super()
    this.app = {
      api: app.api,
      baseURL: app.baseURL,
      emit: app.emit ?? (() => {}),
      netLog: app.netLog ?? (() => {})
    }
    this.code = options.code
    this.token = options.token
    this.isHost = options.isHost

    /** 收摊了没有。收摊之后一切请求直接拒绝。 */
    this.finished = false
    this.running = false
    /** 心跳降频了没有（降了会在恢复时通知界面）。 */
    this.degraded = false
    this.done = new Promise((resolve) => { this.finish = resolve })

    /** "上次之后"的分界线，由服务器回的时间戳推着往前走。 */
    this.since = Date.now()
    /** 见过的话（去重用）。 */
    this.seen = new Set()
    this.controller = new AbortController()
  }

  isDone() {
    return this.finished
  }

  getDone() {
    return this.done
  }

  /** 收摊：不再发请求、不再轮询，正在飞的请求也别等了。 */
  stop() {
    if (this.finished) return
    this.finished = true
    this.controller.abort()
    this.finish()
  }

  /**
   * "这房间没了"—— 收摊 + 告诉界面。
   * 跟 `stop()` 的区别只在**要不要通知用户**：主动退房不用通知，
   * 房间没了/被踢了必须说清楚，不然界面上会一直显示"在房间里"。
   */
  fatal(message) {
    if (this.finished) return
    this.stop()
    this.app.emit('session:state', { state: 'closed', message })
    this.emit('closed', message)
  }

  /** 每个请求都要带的身份：房间码 + 通行证 + 我是房主还是客人。 */
  payload(extra) {
    return { code: this.code, token: this.token, isHost: this.isHost, ...extra }
  }

  /**
   * 把服务器给的一批话抖出来。
   * 每句话过三关：形状对不对（有 type、data 是对象）、见过没有、记下了没有。
   */
  signals(value) {
    if (this.finished || !value || typeof value !== 'object') return
    for (const signal of Array.isArray(value.s) ? value.s : []) {
      if (typeof signal?.type !== 'string' || !signal.data || typeof signal.data !== 'object') continue
      // 有编号就按编号去重；没有编号（服务器没给）就按内容拼一个 —— 同样的话不算两次。
      const key = signal.id != null
        ? String(signal.id)
        : `${signal.from}|${signal.type}|${signal.timestamp}|${JSON.stringify(signal.data)}`
      if (this.seen.has(key)) continue
      this.seen.add(key)
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value)
      this.emit('engineSignal', signal)
    }
    // 服务器回的 ts 是"这批话到哪儿了"，下次就问"这之后有没有新的"。
    if (Number.isFinite(value.ts)) this.since = Math.max(this.since, value.ts)
  }

  /**
   * 说一句 / 问一句。**所有**和房间有关的动作都走这儿。
   *
   * 上游在这里会先用 WebSocket；毛球没有 WebSocket（见文件头），所以永远是这条路：
   * 往服务器发一个 POST，服务器把答案装在那个四格信封里回给我们。
   */
  async request(route, extra) {
    if (this.finished) throw new Error('会话已取消')
    return this.app.api.do(this.app.baseURL(), 'POST', route, {}, this.payload(extra), this.controller.signal)
  }

  /** 睡一会儿，但"收摊"能立刻把它叫醒（不用等满）。 */
  wait(ms) {
    let timer
    return Promise.race([
      this.done,
      new Promise((resolve) => { timer = setTimeout(resolve, ms) })
    ]).then(() => { clearTimeout(timer) })
  }

  /**
   * 一条车道，一直开到收摊为止。
   *
   * `heartbeat=true` 是"报到"车道（默认 5 秒一次，服务器可调速）；
   * `heartbeat=false` 是"听话"车道（1 秒一次）。两条并行跑。
   */
  async loop(heartbeat) {
    let failures = 0
    let sequence = 0
    let delay = heartbeat ? HEARTBEAT_MS : POLL_MS
    while (!this.finished) {
      // 心跳降频期间，听话车道也歇着 —— 上游就是这么写的，别自作聪明改成继续轮询。
      if (!heartbeat && this.degraded) {
        await this.wait(POLL_MS)
        continue
      }
      try {
        const result = await this.request(
          heartbeat ? '/room/heartbeat' : '/signal/poll',
          heartbeat
            ? { seq: ++sequence, currentInterval: delay / 1000, natType: 'unknown', load: 0, peerLatency: {} }
            : { since: this.since }
        )
        if (this.finished) return
        failures = 0
        if (heartbeat) {
          if (this.degraded) {
            this.degraded = false
            this.app.emit('signaling:recovered', {})
          }
          // 服务器说"每多久报一次到"，就按它说的来（钳在 1~30 秒之间）。
          const seconds = Number(result?.heartbeatInterval)
          delay = seconds ? Math.min(HEARTBEAT_MAX_MS, Math.max(HEARTBEAT_MIN_MS, seconds * 1000)) : HEARTBEAT_MS
          this.emit('roomInfo', result)
        } else {
          this.signals(result)
        }
      } catch (error) {
        if (this.finished) return
        const code = error instanceof APIError ? error.code : ''
        this.app.netLog('warn', error?.message ?? String(error))
        // 房间没了 / 被踢了：散伙。
        if (FATAL_CODES.includes(code) || error?.status === 410) {
          this.fatal(error.message)
          return
        }
        // 只是网抖：心跳连着失败够多次就降频，并且告诉界面一句人话。
        if (heartbeat && ++failures >= HEARTBEAT_FAILURES_BEFORE_DEGRADE) {
          delay = DEGRADED_HEARTBEAT_MS
          if (!this.degraded) {
            this.degraded = true
            this.app.emit('signaling:degraded', { message: '信令暂时不可用，已降低心跳频率；游戏通路保持运行' })
          }
        }
      }
      await this.wait(delay)
    }
  }

  /** 开两条车道，跑到收摊为止。 */
  async run() {
    if (this.running) return this.done
    this.running = true
    await Promise.all([this.loop(true), this.loop(false)])
  }
}

module.exports = {
  VoxLinkSession,
  FATAL_CODES,
  HEARTBEAT_MS,
  HEARTBEAT_MIN_MS,
  HEARTBEAT_MAX_MS,
  HEARTBEAT_FAILURES_BEFORE_DEGRADE,
  DEGRADED_HEARTBEAT_MS,
  POLL_MS,
  SEEN_LIMIT
}

// 毛球 — VoxLink 联机 · 第 1 层：和服务器说话
//
// 【这一层是干什么的】
// VoxLink 的联机不是"启动器自己变个魔术"，而是**一台公共服务器在中间牵线**。
// 我们跟这台服务器之间只有一种对话方式：往它上面发一个 HTTP 请求，
// 地址长这样 ——
//
//     https://p2p.wuhui.icu/?route=/room/create
//                            └──────┬───────┘
//                               "我要干什么"写在地址栏里
//
// 注意那个 `route=`：**它把"要办哪件事"当成网址的一个参数**，而不是像常见的
// 那种 /room/create 直接当路径。这是 VoxLink 服务端的规矩，必须照它来。
//
// 【它回什么】永远是同一个信封，四个格子：
//
//     { success: true/false, data: 真正的内容, error: 错误代号, message: 给人看的话 }
//
// `success` 不是 true 就一律当失败处理。这个文件就是把"发请求 + 拆信封"
// 包成几个顺手的小函数，上面几层（房间、打洞、中继）都靠它。
//
// 【为什么单独一个文件】因为它是唯一"所有功能都要用"的东西。改这里要格外小心。
//
// SPDX-License-Identifier: LGPL-3.0-only
// 本文件按 VoxLink（LGPL-3.0）的协议契约改写，来源与许可见 THIRD_PARTY_NOTICES.md

const path = require('node:path')

/** 服务器地址。VoxLink 官方那台，写死当默认值；用户可以在设置里改。 */
const DEFAULT_SERVER_URL = 'https://p2p.wuhui.icu'

/** 一次请求最多等多久（毫秒）。超过就当连不上——不能让界面一直转圈。 */
const HTTP_TIMEOUT_MS = 10000

/** 服务器回的东西最大允许多大（4 MB）。再大就不对劲了，直接掐掉，免得把内存撑爆。 */
const MAX_RESPONSE_LEN = 4 << 20

/**
 * 我们自报家门的名字。
 * 服务器和大厅靠这个区分"这是哪个启动器来的"，跟功能没关系。
 */
const CLIENT_TAG = 'maoqiu'

/** 我们是第 7 版协议。写死，不许乱改——服务器按这个选行为。 */
const CLIENT_PROTOCOL_VERSION = 7

/**
 * 建房/进房时我们"会哪些本事"。
 * 服务器会把这张单子转告对面，对面据此决定"要不要给你同步模组""能不能走 TURN 中继"。
 *
 * ⚠️ 这张单子**必须跟实现同步**：写了却做不到，对面会按你说的做，然后超时失败。
 * 现在毛球只做到第 1 层，所以先把**已经真的会**的写上，做到哪一步再补哪一项。
 */
const CAPABILITIES = ['relay', 'ice_restart', 'continuous_retry', 'punchAuthV1']

/** 毛球自己的版本号。读 package.json，别写死（写死了改版本它不动）。 */
const APP_VERSION = require(path.join(__dirname, '..', '..', '..', 'package.json')).version

/** 房间码：6 位，只含大写字母和数字，且**故意剔掉了** I/O/0/1 这些念不清的字。 */
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/

/** 拆信封时用的错误对象。`code` 是给程序看的，`message` 是给人看的。 */
class APIError extends Error {
  constructor(code, message, status = 0) {
    super(`${code}: ${message}`)
    this.name = 'APIError'
    this.code = code
    this.status = status
  }
}

/**
 * 检查用户填的服务器地址靠不靠谱。
 * 必须是 http/https，必须有主机名，且**不许带用户名密码**（`https://a:b@x` 那种）。
 */
function validateServerURL(value) {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password
  } catch {
    return false
  }
}

/** 房间码合不合法（6 位，且不含 I/O/0/1）。 */
const validateRoomCode = (value) => ROOM_CODE_RE.test(value)

class ApiClient {
  constructor(options = {}) {
    this.userAgent = options.userAgent ?? `Maoqiu-App/${APP_VERSION}`
    this.timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS
    /** 被服务器限速时，记下"什么时候才能再发"，免得页面在那儿空转重试。 */
    this.deadlines = new Map()
  }

  /**
   * 真正发请求的地方。上面所有接口都走这一个口子。
   *
   * @param {string} base     服务器地址，如 https://p2p.wuhui.icu
   * @param {'GET'|'POST'} method
   * @param {string} route    要办的事，如 '/room/create'
   * @param {object} query    额外参数（拼到网址上）
   * @param {object|null} body POST 的正文
   * @param {AbortSignal} [signal] 用户点了"取消"时用它掐断
   */
  async do(base, method, route, query, body, signal) {
    if (!validateServerURL(base)) throw new APIError('NETWORK', '服务器地址无效')

    // 改房间信息这个动作被限速过：还没到点就直接拒绝，别去撞墙。
    const key = route === '/room/update' ? `${base}|${String(body?.code ?? '')}` : ''
    if (key && (this.deadlines.get(key) ?? 0) > Date.now()) {
      throw new APIError('RATE_LIMITED', '请稍后再修改房间', 429)
    }

    const url = new URL(base)
    url.searchParams.set('route', route)
    for (const [name, values] of Object.entries(query || {})) {
      for (const value of Array.isArray(values) ? values : [values]) {
        if (value !== null && value !== undefined) url.searchParams.append(name, String(value))
      }
    }

    try {
      const timeout = AbortSignal.timeout(this.timeoutMs)
      const response = await fetch(url, {
        method,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          'User-Agent': this.userAgent,
          'X-VoxLink-Version': APP_VERSION,
          'Content-Type': 'application/json'
        },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {})
      })

      // 一边收一边量，超过上限就掐断——防的是"服务器抽风吐了个几百兆"。
      const reader = response.body?.getReader()
      const chunks = []
      let size = 0
      try {
        if (reader) {
          for (;;) {
            const part = await reader.read()
            if (part.done) break
            size += part.value.byteLength
            if (size > MAX_RESPONSE_LEN) {
              throw new APIError('RESPONSE_LIMIT', '服务器响应过大', response.status)
            }
            chunks.push(part.value)
          }
        }
      } finally {
        await reader?.cancel().catch(() => {})
      }

      let envelope
      try {
        envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        throw new APIError(`HTTP_${response.status}`, '服务器未返回有效 JSON', response.status)
      }

      // 被限速了：服务器会告诉我们"过多久再来"（可能写在 retry-after 头里，
      // 也可能写在正文里）。记下来，这段时间内别再发。
      if (response.status === 429 && key) {
        const retry = response.headers.get('retry-after')
        const seconds = Number(retry)
        const delay = retry && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry ?? '') - Date.now()
        this.deadlines.set(key, Date.now() + Math.max(1000, Number.isFinite(delay) ? delay : 30000))
      }

      if (!response.ok || envelope.success !== true) {
        throw new APIError(
          envelope.error ?? (response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}`),
          envelope.message ?? '请求失败',
          response.status
        )
      }
      return envelope.data ?? null
    } catch (error) {
      if (error instanceof APIError) throw error
      // 超时、断网、证书错误……统统归到 NETWORK，界面上只说人话。
      throw new APIError('NETWORK', error?.message || String(error))
    }
  }

  async post(base, route, body, signal) {
    return this.do(base, 'POST', route, {}, body, signal)
  }

  async get(base, route, query, signal) {
    return this.do(base, 'GET', route, query, null, signal)
  }
}

module.exports = {
  DEFAULT_SERVER_URL,
  HTTP_TIMEOUT_MS,
  MAX_RESPONSE_LEN,
  CLIENT_TAG,
  CLIENT_PROTOCOL_VERSION,
  CAPABILITIES,
  APP_VERSION,
  APIError,
  ApiClient,
  validateServerURL,
  validateRoomCode
}

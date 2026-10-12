// 毛球 — VoxLink 联机 · 房间这一层
//
// 【这一层管什么】
// 只管"房间"这个概念，不管数据怎么走：
//   · 建房   →  服务器给你一个**6 位房间码**，你把它发给好友
//   · 进房   →  好友把码填进来，就能进你的房间
//   · 查房   →  这个码是真的吗？房间里几个人？
//   · 退房   →  告诉服务器"我走了"
//
// 【为什么先做这一层】
// 它是后面所有东西的地基：打洞、中继、模组同步，全都得先"有一个房间号"才能谈。
// 而且它是**能当场验证**的——码真的从服务器出来了，就说明路通了。
//
// 【现在还没做的（后面几步补）】
//   ⚠️ 建完房之后，"房间里的人怎么互相看见"这件事**还没接**。
//      所以现在建的房间，只能证明"码是真的、服务器认得"，**还不能联机玩**。
//      第 2 步（打洞 + 可靠传输）会把这块补上。
//   ⚠️ 我们的"能力自报"（CAPABILITIES）也只写了做得到的那几项，做到哪补到哪。
//      这不是偷懒：报了自己做不到的本事，对方会照着你说的来，然后卡住。
//
// 【"操作被取消"是什么意思】
// 用户点了建房又马上点别的——前一个请求还在飞。用一个**代次编号**（epoch）解决：
// 每次开始新动作就把编号 +1；请求回来时发现编号已经变了，就说明"这活过期了"，
// 直接丢弃、并且顺手把已经在服务器上建出来的房间退掉，免得留下一堆幽灵房间。
//
// SPDX-License-Identifier: LGPL-3.0-only
// 本文件按 VoxLink（LGPL-3.0）的流程改写，来源与许可见 THIRD_PARTY_NOTICES.md

const { randomUUID } = require('node:crypto')
const { ApiClient, APIError, DEFAULT_SERVER_URL, CLIENT_TAG, CLIENT_PROTOCOL_VERSION, CAPABILITIES, validateRoomCode } = require('./api')
const { DEFAULT_ROOM_NAME, normalizeRoomName, natLabel } = require('./room')
const { probeHostPort } = require('./ports')
const settingsStore = require('./settings')

/** 房间最多几个人（服务端定的，照抄）。 */
const MAX_PLAYERS = 20

/** 加入房间失败时的重试节奏（毫秒）。两次重试 = 一共试 3 回。 */
const JOIN_RETRY_BACKOFF_MS = [1500, 3000]

/** 这些错误码值得重试——网络抖一下、被限速，多半等一下就好了。 */
const RETRYABLE_CODES = ['NETWORK', 'NETWORK_ERROR', 'CDN_ERROR', 'RATE_LIMITED']

/** 睡一会儿，但用户一取消就立刻醒。 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('操作已取消'))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

class VoxLink {
  constructor(options = {}) {
    this.api = options.api ?? new ApiClient()
    this.settings = options.settings ?? settingsStore.load()

    /** 代次编号：每开始一个新动作就 +1，用来丢弃过期请求。 */
    this.operation = 0
    this.operationController = new AbortController()
    /** 有没有一个动作正在飞（防止连点两次"建房"）。 */
    this.pending = false

    /** 'idle' 没进房间 / 'hosting' 我是房主 / 'in_room' 我在别人房里 */
    this.state = 'idle'
    this.code = ''
    this.token = ''
    this.isHost = false
    this.room = null
  }

  /** 当前用的是哪台服务器。 */
  baseURL() {
    return this.settings.serverUrl || DEFAULT_SERVER_URL
  }

  /** 现在是什么情况——给界面看的。 */
  getState() {
    return {
      state: this.state,
      code: this.code,
      isHost: this.isHost,
      room: this.room,
      serverUrl: this.baseURL(),
      allowRelay: this.settings.allowRelay !== false
    }
  }

  /** 改设置（服务器地址、允不允许走中继），改完立刻存盘。 */
  updateSettings(patch) {
    if (typeof patch.serverUrl === 'string' && patch.serverUrl) this.settings.serverUrl = patch.serverUrl
    if (typeof patch.allowRelay === 'boolean') this.settings.allowRelay = patch.allowRelay
    settingsStore.save(this.settings)
    return this.getState()
  }

  /**
   * 开一个新动作。
   * 已经在房间里、或者上一个动作还没飞完，就直接拒绝——把这句人话顶到界面上。
   */
  begin() {
    if (this.pending || this.state !== 'idle') throw new APIError('SESSION_ACTIVE', '请先退出当前房间')
    this.operationController.abort()
    this.operationController = new AbortController()
    this.pending = true
    return ++this.operation
  }

  /** 动作收尾：如果这一轮还没被顶掉，就把"忙"的状态放掉。 */
  end(epoch) {
    if (epoch === this.operation) this.pending = false
  }

  /** 这一轮还算不算数？不算的话，把已经在服务器上建出来的房间退掉再抛错。 */
  async accept(epoch, code, token, isHost, room) {
    if (epoch !== this.operation) {
      void this.api.post(this.baseURL(), '/room/leave', { code, token, isHost }).catch(() => {})
      throw new Error('操作已取消')
    }
    this.code = code
    this.token = token
    this.isHost = isHost
    this.room = room
    this.state = isHost ? 'hosting' : 'in_room'
    this.operationController = new AbortController()
  }

  /**
   * 建房。
   *
   * 必须先**真的去连一下游戏端口**（probeHostPort）——因为房间建出来就是要把好友
   * 引到那个端口上。端口没人听，房间就等于是个空壳。
   *
   * @param {object} req
   * @param {string} req.name        房间名
   * @param {number} req.hostPort    游戏「对局域网开放」的端口
   * @param {string} [req.password]  房间密码（可选）
   * @param {string} [req.category]  分类（可选）
   * @param {boolean} [req.visible]  要不要公开在大厅里（默认公开）
   * @param {string} [req.loader]    加载器（fabric/forge/neoforge）
   * @param {string} [req.gameVersion] 游戏版本
   */
  async createRoom(req) {
    const epoch = this.begin()
    try {
      const name = normalizeRoomName(req.name ?? DEFAULT_ROOM_NAME)

      await probeHostPort(Number(req.hostPort))
      if (epoch !== this.operation) throw new Error('操作已取消')

      const result = await this.api.post(
        this.baseURL(),
        '/room/create',
        {
          name,
          visible: req.visible !== false,
          hostPort: Number(req.hostPort),
          ...(req.password ? { password: req.password } : {}),
          ...(req.category ? { category: req.category } : {}),
          ...(req.loader ? { loader: req.loader } : {}),
          ...(req.gameVersion ? { gameVersion: req.gameVersion } : {}),
          maxPlayers: MAX_PLAYERS,
          natType: 'unknown',
          clientType: 'app',
          clientTag: CLIENT_TAG,
          client_tag: CLIENT_TAG,
          clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
          clientCapabilities: CAPABILITIES,
          idempotencyKey: randomUUID()
        },
        this.operationController.signal
      )

      const room = {
        ...result,
        maxPlayers: MAX_PLAYERS,
        currentPlayers: 1,
        hasPassword: !!req.password,
        category: req.category ?? '',
        gameVersion: req.gameVersion ?? '',
        loader: req.loader ?? '',
        clientType: 'app',
        clientTag: CLIENT_TAG,
        isHost: true
      }
      await this.accept(epoch, result.code, result.hostToken, true, room)
      return result
    } finally {
      this.end(epoch)
    }
  }

  /**
   * 进别人的房间。
   * 网络抖一下就重试（1.5 秒、3 秒，一共三回），一直失败才报错——
   * 这种"差一点点就连上"的情况在真实网络里太常见了。
   */
  async requestJoin(code, password, signal, onStage) {
    const body = {
      code,
      password,
      ...(this._joinEnv ?? {}),
      clientType: 'app',
      clientTag: CLIENT_TAG,
      clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
      clientCapabilities: CAPABILITIES,
      idempotencyKey: randomUUID()
    }
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new Error('操作已取消')
      try {
        return await this.api.post(this.baseURL(), '/room/join', body, signal)
      } catch (error) {
        if (signal?.aborted) throw new Error('操作已取消')
        const retryable = error instanceof APIError && RETRYABLE_CODES.includes(error.code)
        if (!retryable || attempt >= JOIN_RETRY_BACKOFF_MS.length) throw error
        onStage?.(`加入暂时失败（${error.code}），正在重试 ${attempt + 2}/3 …`)
        await delay(JOIN_RETRY_BACKOFF_MS[attempt], signal)
      }
    }
  }

  async joinRoom(req) {
    const epoch = this.begin()
    this._joinEnv = { loader: req.loader, gameVersion: req.gameVersion }
    try {
      const code = String(req.code ?? '').trim().toUpperCase()
      if (!validateRoomCode(code)) throw new APIError('INVALID_PARAMS', '请输入有效的六位房间码')

      const result = await this.requestJoin(code, req.password, this.operationController.signal, req.onStage)
      result.room = { ...result.room, code, isHost: false }
      await this.accept(epoch, code, result.clientToken, false, result.room)
      return result
    } finally {
      this.end(epoch)
    }
  }

  /** 退房。跟服务器打个招呼就走；打不通也无所谓，本地照样清干净。 */
  async leaveRoom(reason = '用户退出房间') {
    this.operation++
    this.operationController.abort()
    this.pending = false

    const credentials = { code: this.code, token: this.token, isHost: this.isHost }
    const wasInRoom = this.state !== 'idle'

    this.code = ''
    this.token = ''
    this.isHost = false
    this.room = null
    this.state = 'idle'
    this.operationController = new AbortController()

    if (wasInRoom) {
      void this.api.post(this.baseURL(), '/room/leave', credentials).catch(() => {})
    }
    return { left: wasInRoom, reason }
  }

  /** 查这个房间码是不是真的、里面几个人、房主的网络好不好打洞。 */
  async roomInfo(code) {
    return this.api.get(this.baseURL(), '/room/info', { code })
  }

  /** 大厅：看看都有谁在开房。 */
  async listRooms(query = {}) {
    const page = Math.max(1, query.page ?? 1)
    const size = Math.min(100, Math.max(1, query.size ?? 20))
    return this.api.get(this.baseURL(), '/room/list', { ...query, page, size })
  }

  /** 房间分类（服务器给的中文表）。 */
  async categories() {
    return this.api.get(this.baseURL(), '/categories', {})
  }

  /** 服务器活不活着——界面打开时探一下。 */
  async serverStatus() {
    try {
      await this.api.get(this.baseURL(), '/categories', {})
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error.message, code: error.code }
    }
  }
}

module.exports = { VoxLink, MAX_PLAYERS, JOIN_RETRY_BACKOFF_MS, natLabel }

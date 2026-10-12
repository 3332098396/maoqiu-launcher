// SPDX-License-Identifier: LGPL-3.0-only
//
// 逐语句移植自 AUGUHDAR/VoxLink 的 `network/ReliableUdpTransport.java`（修订 6b11d93，LGPL-3.0）；
// 四包 XOR 校验、RTT 估计与重传退避取自 c475faa9。
// 改写参考了 KAMUCL 的 Node 实现（`src/main/core/voxlink/rudp.ts`，作者 KAMUCL contributors）——
// 其中的"Node 接收/缓存生命周期有界"和"显式 ACK 防洪"同样是它加的。
// 见 THIRD_PARTY_NOTICES.md —— 本文件**不适用**仓库根的 MIT，按 LGPL-3.0-only 提供。
//
// 干什么：UDP 本身**不保证送到、不保证顺序、不保证只送一次**。
// 这一层在 UDP 上搭一条"像 TCP 那样可靠有序"的管道，给打洞之后的游戏数据用。
// 额外做了四包一组 XOR 校验：丢一个包时不用等重传，直接算回来（打洞链路丢包多，这一手省时间）。
//
// §0 纪律：帧格式、窗口大小、超时预算、重传节奏 —— 一个数值都不许改。

const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')
const { signPunchFrame, verifyPunchFrame } = require('./punchAuth')

// 包类型。数字是协议的一部分（跟对端逐字节对得上才行），**不许重排**。
const RUDP_TYPE_PUNCH = 1
const RUDP_TYPE_PUNCH_ACK = 2
const RUDP_TYPE_DATA = 3
const RUDP_TYPE_ACK = 4
const RUDP_TYPE_DISCONNECT = 7
const RUDP_TYPE_KEEPALIVE = 8
const RUDP_TYPE_FEC_XOR = 9
const RUDP_TYPE_RESTART = 10
const RUDP_TYPE_VOICE = 11

/** 序列号是 32 位无符号、会回绕的，所以比较要用"环形距离"，不能直接比大小 */
const seqDiff = (a, b) => (a - b) >>> 0
/** a 是否在 b 之后（环形，且小于半圈，用来分辨"真的更晚"还是"回绕了"） */
const seqAfter = (a, b) => seqDiff(a, b) > 0 && seqDiff(a, b) < 0x80000000

/** 打包一帧 */
function rudpEncode(f) {
  const count = f.type === 9 ? f.fecLengths.length : 0
  const offset = f.type === 9 ? 14 + count * 2 : f.type === 3 ? 13 : 11
  const packet = Buffer.alloc(offset + f.payload.length)
  packet[0] = 86 // 'V'
  packet[1] = 76 // 'L'
  packet[2] = f.type
  packet.writeUInt32BE(f.seq >>> 0, 3)
  packet.writeUInt32BE(f.ack >>> 0, 7)
  if (f.type === 3 || f.type === 9) packet.writeUInt16BE(f.payload.length, 11)
  if (f.type === 9) {
    packet[13] = count
    f.fecLengths.forEach((size, i) => packet.writeUInt16BE(size, 14 + 2 * i))
  }
  f.payload.copy(packet, offset)
  return packet
}

/**
 * 解一帧。**任何一项不合法就返回 null**（调用方丢包）——
 * 这些检查是防"外面乱扔的包/坏掉的包"把连接搞乱的，别嫌啰嗦。
 */
function rudpDecode(packet) {
  if (packet.length < 11 || packet[0] !== 86 || packet[1] !== 76) return null
  const type = packet[2]
  let offset = 11
  let length = packet.length - 11
  let count = 0
  const lengths = []
  if (type === 3 || type === 9) {
    if (packet.length < 13) return null
    length = packet.readUInt16BE(11)
    offset = 13
  }
  if (type === 9) {
    if (packet.length < 14) return null
    count = packet[13]
    if (count < 1 || count > 20) return null
    offset = 14 + count * 2
    if (packet.length < offset) return null
    for (let i = 0; i < count; i++) lengths.push(packet.readUInt16BE(14 + 2 * i))
  }
  if (length > 1400 || packet.length !== offset + length) return null
  return {
    type,
    seq: packet.readUInt32BE(3),
    ack: packet.readUInt32BE(7),
    payload: packet.subarray(offset),
    fecCount: count,
    fecLengths: lengths
  }
}

class RudpConn extends EventEmitter {
  constructor(socket, remote, options = {}) {
    super()
    this.socket = socket
    this.remote = remote
    this.options = options

    this.running = false
    this.ended = false
    this.closing = false
    this.lastRx = Date.now()
    this.lastPing = 0

    this.nextSend = 0
    this.nextRead = 0
    this.pending = new Map()

    this.fecSend = []
    this.fecReceive = new Map()

    this.srtt = -1
    this.rttvar = 0
    this.rto = 200
    this.lastAck = -1
    this.duplicateAcks = 0

    this.reordered = new Map()
    this.incoming = []
    this.queuedBytes = 0

    this.timer = undefined
    // 读写各自串成一条链：同一个连接上并发写不会把包序搞乱
    this.writers = Promise.resolve()
    this.readers = Promise.resolve()
    this.onClosed = undefined
    this.changed = new Set()

    this.primary = undefined
    this.secondary = undefined
    this.graceUntil = 0
    this.authDrops = 0

    if (remote) this.primary = this.path(socket, remote, options.codec, options.ownsSocket !== false)
  }

  isConnected() {
    return this.running && !this.ended
  }

  getRemote() {
    return this.primary ? this.primary.remote : null
  }

  /** 造一条"线路"。一个连接可以同时有两块 socket（双线路打洞） */
  path(socket, remote, codec, owns) {
    const path = {
      socket,
      remote: { ...remote },
      codec,
      owns,
      lastRx: 0,
      rx: 0,
      lastCurrent: 0,
      pendingPort: -1,
      pendingAt: 0
    }
    path.receive = (b, from) => this.receive(b, from, path)
    path.closed = () => {
      if (this.primary === path) this.closeWith('传输连接已关闭')
      else if (this.secondary === path) this.dropSecondaryPath()
    }
    path.error = (e) => {
      if (this.primary === path) this.closeWith(e.message)
      else if (this.secondary === path) this.dropSecondaryPath()
    }
    return path
  }

  attach(path) {
    // 64 个 DATA 包加上校验包，一burst就超过 Windows 默认的 64 KiB UDP 队列了。
    // 调大到 256 KiB，让 Node 处理回调期间还留得下一整批。
    try {
      if (path.socket.getRecvBufferSize() < 256 * 1024) path.socket.setRecvBufferSize(256 * 1024)
    } catch {
      // 系统不允许调大也不能让这条本来能用的线路挂掉
    }
    path.socket.on('message', path.receive)
    path.socket.on('close', path.closed)
    path.socket.on('error', path.error)
  }

  detach(path) {
    path.socket.off('message', path.receive)
    path.socket.off('close', path.closed)
    path.socket.off('error', path.error)
  }

  addSecondaryPath(socket, remote, codec) {
    if (this.ended || this.secondary) {
      try { socket.close() } catch {}
      return false
    }
    this.secondary = this.path(socket, remote, codec, true)
    this.attach(this.secondary)
    return true
  }

  secondaryHealth() {
    return this.secondary ? { rx: this.secondary.rx, lastRx: this.secondary.lastRx } : null
  }

  /** 把备用线路提成主线路（原主线路降为备用，10 秒内两边都发，避免正切换时丢包） */
  promoteSecondaryPath() {
    if (!this.secondary || !this.primary) return false
    const prior = this.primary
    this.primary = this.secondary
    this.secondary = prior
    this.graceUntil = Date.now() + 10000
    return true
  }

  dropSecondaryPath() {
    const path = this.secondary
    this.secondary = undefined
    this.graceUntil = 0
    if (path) {
      this.detach(path)
      if (path.owns) try { path.socket.close() } catch {}
    }
  }

  sendPath(path, frame) {
    const packet = path.codec ? path.codec.encode(frame) : frame
    try {
      path.socket.send(packet, path.remote.port, path.remote.address, (error) => {
        if (error && this.primary === path) this.closeWith(error.message)
      })
    } catch {
      if (this.primary === path) this.closeWith('传输连接已关闭')
    }
  }

  setOnClosed(fn) {
    this.onClosed = fn
  }

  wake() {
    for (const fn of this.changed) fn()
    this.changed.clear()
  }

  wait() {
    return new Promise((resolve) => this.changed.add(resolve))
  }

  send(type, payload = Buffer.alloc(0), seq = 0, lengths = []) {
    if (this.ended || !this.primary) return
    // 上游的 FEC 头里有个组号，且 ACK 字段必须填 0（保留位）
    const packet = signPunchFrame(
      rudpEncode({
        type,
        seq,
        ack: type === RUDP_TYPE_FEC_XOR ? 0 : this.nextRead,
        payload,
        fecCount: lengths.length,
        fecLengths: lengths
      }),
      this.options.authKey
    )
    this.sendPath(this.primary, packet)
    // 备用线路上也发一份：切换宽限期内、以及心跳，两条路一起走
    if (this.secondary && (Date.now() < this.graceUntil || type === RUDP_TYPE_KEEPALIVE)) {
      this.sendPath(this.secondary, packet)
    }
  }

  processAck(ack, type, now) {
    // 对端 ACK 了一个我还没发过的号 → 假的，别理
    if (seqAfter(ack, this.nextSend)) return
    for (const [seq, entry] of this.pending) {
      if (seqAfter(ack, seq)) {
        // Karn 规则：重传过的包**不能**用来算 RTT（分不清测的是哪一次的往返）
        if (entry.retries === 0) {
          const sample = Math.max(1, now - entry.sent)
          if (this.srtt < 0) {
            this.srtt = sample
            this.rttvar = sample / 2
          } else {
            this.rttvar = (3 * this.rttvar + Math.abs(this.srtt - sample)) / 4
            this.srtt = (7 * this.srtt + sample) / 8
          }
          this.rto = Math.max(100, Math.min(800, this.srtt + Math.max(10, 4 * this.rttvar)))
        }
        this.pending.delete(seq)
      }
    }
    // 只有**显式 ACK**才算快速重传的依据。心跳/语音/FEC 包不能当成
    // "对端没收到 DATA"的证据 —— 否则两边会互相放大，打成广播风暴。
    if (type === RUDP_TYPE_ACK && ack === this.lastAck && this.pending.has(ack)) {
      if (++this.duplicateAcks >= 3) {
        const entry = this.pending.get(ack)
        if (now - entry.sent >= 50) {
          entry.sent = now
          entry.retries++
          this.send(RUDP_TYPE_DATA, entry.data, ack)
        }
        this.duplicateAcks = 0
      }
    } else if (type === RUDP_TYPE_ACK) {
      this.lastAck = ack
      this.duplicateAcks = 0
    }
  }

  /** 把乱序缓存里"正好接得上"的包连续吐进接收队列 */
  drainReceived() {
    while (this.reordered.has(this.nextRead) && this.incoming.length < 512) {
      const data = this.reordered.get(this.nextRead)
      this.reordered.delete(this.nextRead)
      this.nextRead = (this.nextRead + 1) >>> 0
      this.incoming.push(data)
      this.queuedBytes += data.length
    }
  }

  storeReceived(seq, data) {
    // 太远（超前 512）的不要；已经有过的不要；把接收队列撑到 8 MB 以上的不要
    if (seqDiff(seq, this.nextRead) >= 512 || this.reordered.has(seq) || this.queuedBytes + data.length >= 8 * 1024 * 1024) return false
    this.reordered.set(seq, Buffer.from(data))
    this.drainReceived()
    return true
  }

  fecGroup(id, now) {
    let group = this.fecReceive.get(id)
    if (!group) {
      group = { data: new Map(), updated: now }
      this.fecReceive.set(id, group)
    }
    group.updated = now
    // 已经交付的包要留到校验包到达为止，但**绝不能把整条流都留着**。
    // 时间和条数两个上限顺带能挡住畸形对端。
    for (const [key, value] of this.fecReceive) {
      if (now - value.updated > 24000) this.fecReceive.delete(key)
    }
    while (this.fecReceive.size > 128) this.fecReceive.delete(this.fecReceive.keys().next().value)
    return group
  }

  /** 四包里已经收到三个 + 校验包 → 把丢的那个算回来 */
  recoverFec(id, group) {
    if (!group.parity || !group.lengths || group.data.size !== 3) return
    let missing = -1
    for (let i = 0; i < 4; i++) if (!group.data.has((id * 4 + i) >>> 0)) missing = i
    if (missing < 0) return
    const seq = (id * 4 + missing) >>> 0
    if (seqDiff(seq, this.nextRead) >= 512) return
    const recovered = Buffer.from(group.parity)
    for (const [seq2, data] of group.data) {
      // 长度对不上就不敢按位异或（会算出垃圾），直接放弃
      if (data.length !== group.lengths[seq2 % 4]) return
      for (let i = 0; i < data.length; i++) recovered[i] ^= data[i]
    }
    if (this.storeReceived(seq, recovered.subarray(0, group.lengths[missing]))) {
      this.fecReceive.delete(id)
      this.send(RUDP_TYPE_ACK)
    }
  }

  /** 每攒够四个包，发一个 XOR 校验包 */
  sendFec(seq, data) {
    this.fecSend.push(data)
    if (this.fecSend.length !== 4) return
    const lengths = this.fecSend.map((part) => part.length)
    const parity = Buffer.alloc(Math.max(...lengths))
    for (const part of this.fecSend) for (let i = 0; i < part.length; i++) parity[i] ^= part[i]
    this.fecSend = []
    this.send(RUDP_TYPE_FEC_XOR, parity, Math.floor(seq / 4), lengths)
  }

  receive(packet, from, path) {
    // 只认这条线路该来的地址。有编码器（走 TURN）时端口也必须是它
    if (this.ended || from.address !== path.remote.address || (path.codec && from.port !== path.remote.port)) return
    const decoded = path.codec ? path.codec.decode(packet) : packet
    if (!decoded) return
    const raw = verifyPunchFrame(decoded, this.options.authKey)
    if (!raw) {
      // 走 TURN 时可能对端降级成"不签名"。连续 3 次验章失败就跟着降级。
      if (path.codec && this.options.allowTurnAuthDowngrade && ++this.authDrops >= 3) {
        this.options.authKey = null
        this.lastRx = Date.now()
        this.emit('authDowngrade')
      }
      return
    }
    this.authDrops = 0
    if (raw.length < 3 || raw[0] !== 86 || raw[1] !== 76) return

    // 同 IP 换端口：要**连续两次**看到同一个新端口、且当前端口已经**安静下来**才认。
    // 它故意排在 DATA/FEC 长度校验前面（上游 c475faa9 §2B）。
    const now = Date.now()
    if (!path.codec) {
      if (from.port === path.remote.port) {
        path.lastCurrent = now
        path.pendingPort = -1
      } else if (!(path.lastCurrent > 0 && now - path.lastCurrent < 6000)) {
        if (path.pendingPort === from.port && now - path.pendingAt < 5000) {
          path.remote.port = from.port
          path.lastCurrent = now
          path.pendingPort = -1
        } else {
          path.pendingPort = from.port
          path.pendingAt = now
        }
      }
    }
    if (from.port !== path.remote.port) return

    // 打洞探针包：收到 PUNCH 就回一个 PUNCH_ACK（这种包不走 rudpEncode，是 5 字节裸帧）
    if (raw[2] === 1 || raw[2] === 2) {
      this.lastRx = now
      path.lastRx = now
      path.rx++
      if (raw[2] === 1) this.sendPath(path, signPunchFrame(Buffer.from([86, 76, 2, 0, 0]), this.options.authKey))
      return
    }

    const f = rudpDecode(raw)
    if (!f) return
    this.lastRx = now
    path.lastRx = now
    path.rx++

    // ACK 的号比实际发出去的还大 → 假的
    if (f.type === RUDP_TYPE_DATA || f.type === RUDP_TYPE_ACK || f.type === RUDP_TYPE_KEEPALIVE) {
      this.processAck(f.ack, f.type, now)
    }
    if (f.type === RUDP_TYPE_DISCONNECT) { this.closeWith('对端断开'); return }
    if (f.type === RUDP_TYPE_RESTART) { this.emit('restart'); return }
    if (f.type === RUDP_TYPE_VOICE) { this.emit('voice', f.payload); return }

    if (f.type === RUDP_TYPE_DATA) {
      const ahead = seqDiff(f.seq, this.nextRead)
      // 近期的重复包对 XOR 恢复有用；太老的和太未来的都没用
      if (ahead < 512 || seqDiff(this.nextRead, f.seq) <= 512) {
        const id = Math.floor(f.seq / 4)
        const group = this.fecGroup(id, now)
        group.data.set(f.seq, Buffer.from(f.payload))
        this.storeReceived(f.seq, f.payload)
        this.recoverFec(id, group)
      }
      this.send(RUDP_TYPE_ACK)
    }

    if (
      f.type === RUDP_TYPE_FEC_XOR &&
      f.fecCount === 4 &&
      f.fecLengths.every((size) => size > 0 && size <= f.payload.length) &&
      Math.max(...f.fecLengths) === f.payload.length
    ) {
      const first = (f.seq * 4) >>> 0
      if (seqDiff(first, this.nextRead) < 512 || seqDiff(this.nextRead, first) <= 512) {
        const group = this.fecGroup(f.seq, now)
        group.parity = Buffer.from(f.payload)
        group.lengths = f.fecLengths
        this.recoverFec(f.seq, group)
      }
    }

    // ACK / 心跳**不回**，否则两边会互相 Echo 形成流量放大
    this.wake()
  }

  start() {
    if (this.running || this.ended) return
    this.running = true
    this.lastRx = Date.now()
    if (this.primary) this.attach(this.primary)
    this.timer = setInterval(() => {
      const now = Date.now()
      // 60 秒一个包都没收到 → 对端没了
      if (now - this.lastRx > 60000) { this.closeWith('对端连接超时'); return }
      for (const [seq, entry] of this.pending) {
        // 一个包挂了 24 秒还没被确认 → 这条链路救不回来了
        if (now - entry.created > 24000) { this.closeWith('可靠传输重试超时'); return }
        // 退避：基础 RTO + 每重传一次多等 250ms（最多算 3 次）
        if (now - entry.sent >= this.rto + Math.min(entry.retries, 3) * 250) {
          entry.sent = now
          entry.retries++
          this.send(RUDP_TYPE_DATA, entry.data, seq)
        }
      }
      if (now - this.lastPing >= 1000) {
        this.lastPing = now
        this.send(RUDP_TYPE_KEEPALIVE)
      }
    }, 50)
    this.send(RUDP_TYPE_KEEPALIVE)
  }

  async writeChunk(data) {
    await this.write(data)
  }

  write(data) {
    const copy = Buffer.from(data)
    const job = this.writers.then(async () => {
      for (let offset = 0; offset < copy.length;) {
        // 在途窗口 64 个包。满了就等 ACK 腾地方（**不能**无限堆，否则内存爆）
        while (this.pending.size >= 64 && !this.ended) await this.wait()
        if (this.ended) throw new Error('连接已关闭')
        const seq = this.nextSend
        this.nextSend = (seq + 1) >>> 0
        // 走 TURN 时要留出编码开销，所以分块小一点
        const size = this.primary && this.primary.codec ? 1374 : 1400
        const part = copy.subarray(offset, offset + size)
        const now = Date.now()
        offset += part.length
        this.pending.set(seq, { data: part, sent: now, created: now, retries: 0 })
        this.send(RUDP_TYPE_DATA, part, seq)
        this.sendFec(seq, part)
      }
      return copy.length
    })
    this.writers = job.catch(() => {})
    return job
  }

  read(target) {
    const job = this.readers.then(async () => {
      while (!this.incoming.length && !this.ended) await this.wait()
      if (!this.incoming.length) return 0
      const head = this.incoming[0]
      const size = Math.min(target.length, head.length)
      target.set(head.subarray(0, size))
      this.queuedBytes -= size
      if (size === head.length) this.incoming.shift()
      else this.incoming[0] = head.subarray(size)
      this.drainReceived()
      this.send(RUDP_TYPE_ACK)
      return size
    })
    this.readers = job.catch(() => {})
    return job
  }

  closeWith(reason) {
    if (this.ended || this.closing) return
    this.closing = true
    this.send(RUDP_TYPE_DISCONNECT)
    this.ended = true
    this.running = false
    clearInterval(this.timer)
    for (const path of [this.primary, this.secondary]) {
      if (path) {
        this.detach(path)
        if (path.owns) try { path.socket.close() } catch {}
      }
    }
    this.primary = undefined
    this.secondary = undefined
    this.pending.clear()
    this.reordered.clear()
    this.fecReceive.clear()
    this.fecSend = []
    this.incoming = []
    this.queuedBytes = 0
    this.wake()
    this.emit('closed', reason)
    if (this.onClosed) this.onClosed(reason)
  }

  close() {
    this.closeWith('连接已关闭')
  }
}

module.exports = {
  RUDP_TYPE_PUNCH,
  RUDP_TYPE_PUNCH_ACK,
  RUDP_TYPE_DATA,
  RUDP_TYPE_ACK,
  RUDP_TYPE_DISCONNECT,
  RUDP_TYPE_KEEPALIVE,
  RUDP_TYPE_FEC_XOR,
  RUDP_TYPE_RESTART,
  RUDP_TYPE_VOICE,
  seqDiff,
  seqAfter,
  rudpEncode,
  rudpDecode,
  RudpConn
}

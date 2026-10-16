// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (c) 2026 毛球 (Maoqiu) · https://github.com/3332098396/maoqiu-launcher —— 移植/改编自 VoxLink，本文件按 LGPL-3.0 提供（见 THIRD_PARTY_NOTICES.md）
//
// 逐语句移植自 AUGUHDAR/VoxLink 的 `network/StunProbe.java`（修订 924845e，LGPL-3.0）
// 中的"顺序采样 / 重发"策略，外加 RFC 5389 那一层。
// 改写参考了 KAMUCL 的 JS 实现（`src/main/core/voxlink/stun.ts`，作者 KAMUCL contributors）。
// 见 THIRD_PARTY_NOTICES.md —— 本文件**不适用**仓库根的 MIT，按 LGPL-3.0-only 提供。
//
// 干什么：问一台公共 STUN 服务器"**你看到的我，是从哪个地址来的？**"
// 家里上网都是经过路由器的（NAT），本机看到的自己是 192.168.x.x，**那不是别人看到你的地址**。
// 打洞必须知道对外的那个地址，所以这一步先问出来。
// 顺便还能判断网络类型：换个端口再问一次，看公网地址变不变 ——
// 变了说明是"对称型 NAT"（最难打），没变说明是"锥型"（好打）。
//
// §0 纪律：重发节奏、采样次数、超时数值一个都不许改。

const dgram = require('node:dgram')
const { randomBytes } = require('node:crypto')
const { lookup } = require('node:dns/promises')
const { setTimeout: delay } = require('node:timers/promises')

const STUN_MAGIC_COOKIE = 0x2112a442
const STUN_REQ_TYPE = 1
const STUN_RESP_TYPE = 0x101
const STUN_HEADER_LEN = 20

// 公共 STUN 服务器。国内那两台放前面 —— 从国内问它们最快（上游也是这个顺序）
const STUN_SERVERS = [
  'stun.qq.com:3478',
  'stun.miwifi.com:3478',
  'stun.cloudflare.com:3478',
  'stun.l.google.com:19302'
]

/** 地址得像个地址：有 IP、端口在 1~65535 */
const validMappedAddr = (value) =>
  !!value && !!value.ip && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535

/** 拼一个 STUN 请求：20 字节头 + 12 字节随机数（事务 ID，用来认领回包） */
function stunBuildRequest() {
  const request = Buffer.alloc(20)
  request.writeUInt16BE(STUN_REQ_TYPE)
  request.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  randomBytes(12).copy(request, 8)
  return request
}

// 哪几台服务器答过话。答得上的排前面，省得每次都在死服务器上白等
const preferred = new Set()

/**
 * 问一台服务器要"我的公网地址"。
 * 收不到就重发（最多 `resends` 次，间隔按 `stunResendDelay` 递增），问 `attempts` 轮。
 */
async function stunQuery(socket, server, attempts, timeoutMs, signal, resends = 0) {
  let remote
  try {
    const uri = new URL(`udp://${server}`)
    remote = {
      address: (await lookup(uri.hostname, { family: 4 })).address,
      port: Number(uri.port || 3478)
    }
  } catch {
    return null
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) return null
    const request = stunBuildRequest()
    const answer = await new Promise((resolve) => {
      let resendTimer
      let finished = false
      // 无论成功失败，收尾都要把监听、定时器、abort 监听全部摘干净（不然会越积越多）
      const finish = (value) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        clearTimeout(resendTimer)
        signal?.removeEventListener('abort', failed)
        socket.off('message', message)
        socket.off('error', failed)
        socket.off('close', failed)
        resolve(value)
      }
      const failed = () => finish(null)
      const message = (packet, from) => {
        // 只认这台服务器的回包，而且事务 ID 必须是我刚才发的那一串
        if (
          from.address !== remote.address ||
          from.port !== remote.port ||
          packet.length < 20 ||
          packet.readUInt16BE() !== STUN_RESP_TYPE ||
          !packet.subarray(4, 20).equals(request.subarray(4))
        ) return
        const end = 20 + packet.readUInt16BE(2)
        if (end > packet.length) return
        // 一条一条属性往下找"映射地址"
        for (let cursor = 20; cursor + 4 <= end;) {
          const type = packet.readUInt16BE(cursor)
          const size = packet.readUInt16BE(cursor + 2)
          const start = cursor + 4
          if (start + size > end) return
          // 0x20 = XOR-MAPPED-ADDRESS（现在都用它）；1 = 老的 MAPPED-ADDRESS；0x8020 = 更老的一版
          if ((type === 1 || type === 0x20 || type === 0x8020) && size >= 8 && packet[start + 1] === 1) {
            // XOR 那两版的地址是按 magic cookie 异或过的（防中间设备乱改），要异或回来
            const mask = type === 1 ? 0 : STUN_MAGIC_COOKIE
            const ip = (packet.readUInt32BE(start + 4) ^ mask) >>> 0
            const value = {
              ip: [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'),
              port: packet.readUInt16BE(start + 2) ^ (mask >>> 16)
            }
            if (validMappedAddr(value)) finish(value)
            return
          }
          cursor = start + ((size + 3) & ~3) // 属性按 4 字节对齐
        }
      }
      const timer = setTimeout(failed, timeoutMs)
      socket.on('message', message)
      socket.once('error', failed)
      socket.once('close', failed)
      signal?.addEventListener('abort', failed, { once: true })
      try {
        socket.send(request, remote.port, remote.address, (error) => { if (error) failed() })
      } catch {
        failed()
      }
      const resend = (n) => {
        if (finished || n > resends) return
        resendTimer = setTimeout(() => {
          if (finished) return
          try { socket.send(request, remote.port, remote.address, () => {}) } catch {}
          resend(n + 1)
        }, stunResendDelay(n))
      }
      resend(1)
    })
    if (answer) return answer
  }
  return null
}

/** 挨个服务器问，凑够 `count` 个样本就停（答过话的排前面） */
async function stunSampleSeries(socket, servers, count, tries, timeoutMs, signal) {
  const samples = []
  const ordered = [...servers].sort((a, b) => Number(preferred.has(b)) - Number(preferred.has(a)))
  for (const server of ordered) {
    if (samples.length >= count || signal?.aborted) break
    const result = await stunQuery(socket, server, tries, timeoutMs, signal)
    if (result) {
      preferred.add(server)
      samples.push(result)
    } else {
      preferred.delete(server)
    }
  }
  return samples
}

/** 两次采样之间公网端口差多少 —— 不为 0 就是"对称型 NAT"的征兆 */
const stunDeltaFromSamples = (samples) =>
  samples.length > 1 ? samples[samples.length - 1].port - samples[0].port : 0

/**
 * 重发间隔：200、400、800 毫秒封顶，再给 ±20% 的抖动。
 * 抖动是为了别和别人的重发撞在同一时刻（上游 StunProbe.java 就是 200/800/0.2 这三个数）。
 */
function stunResendDelay(retransmissions, random = Math.random) {
  const rto = Math.min(200 << retransmissions, 800)
  const jitter = Math.trunc(rto * 0.2)
  return rto - jitter + Math.floor(random() * (2 * jitter + 1))
}

/**
 * 顺序采样：先让几台服务器抢答，**选定一台之后就一直用它**，
 * 隔 `intervalMs` 问一次、连问 `count` 次。
 * 必须固定同一台 —— 换服务器比端口就没意义了（不同服务器看到的可能是不同的出口）。
 */
async function samplePortsSequential(socket, servers, count, intervalMs, signal) {
  if (!servers.length || count <= 0) return []
  const race = new AbortController()
  const abort = () => race.abort()
  signal.addEventListener('abort', abort, { once: true })
  let selected
  try {
    selected = await Promise.any(servers.map(async (server) => {
      const result = await stunQuery(socket, server, 1, 800, race.signal, 1)
      if (!result) throw new Error('STUN timeout')
      return { server, result }
    }))
  } catch {
    return []
  } finally {
    race.abort()
    signal.removeEventListener('abort', abort)
  }
  const samples = [selected.result]
  for (let i = 1; i < count; i++) {
    signal.throwIfAborted()
    const result = await stunQuery(socket, selected.server, 1, 800, signal, 2)
    if (result) samples.push(result)
    if (i < count - 1) await delay(intervalMs, undefined, { signal })
  }
  return samples
}

/**
 * 快速判断网络类型。只是"看一眼"用的（建房时上报给服务器）：
 * 两次采样的公网端口不一样 → symmetric（对称型，最难打）；一样 → cone（锥型，好打）。
 */
async function quickNatType() {
  const socket = dgram.createSocket('udp4')
  try {
    const samples = await stunSampleSeries(socket, STUN_SERVERS, 2, 1, 1200)
    if (samples.length < 2) return 'unknown'
    return stunDeltaFromSamples(samples) ? 'symmetric' : 'cone'
  } finally {
    try { socket.close() } catch {}
  }
}

module.exports = {
  STUN_MAGIC_COOKIE,
  STUN_REQ_TYPE,
  STUN_RESP_TYPE,
  STUN_HEADER_LEN,
  STUN_SERVERS,
  validMappedAddr,
  stunBuildRequest,
  stunQuery,
  stunSampleSeries,
  stunDeltaFromSamples,
  stunResendDelay,
  samplePortsSequential,
  quickNatType
}

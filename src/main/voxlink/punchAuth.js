// SPDX-License-Identifier: LGPL-3.0-only
//
// 逐语句移植自 AUGUHDAR/VoxLink 的 `network/PunchAuth.java`（修订 6b11d93，LGPL-3.0）。
// 原作者：AUGUHDAR / VoxLink contributors。
// 改写参考了 KAMUCL 的 JS 实现（`src/main/core/voxlink/punchAuth.ts`，作者 KAMUCL contributors）。
// 见 THIRD_PARTY_NOTICES.md —— 本文件**不适用**仓库根的 MIT，按 LGPL-3.0-only 提供。
//
// 干什么：给打洞用的 UDP 包盖个"防伪章"。
// 不盖章的话，任何人往这个端口扔一个包就能把连接搅黄（或者冒充成对端）。
//
// §0 纪律：数值、字段、顺序一个都不许改。

const crypto = require('node:crypto')

/**
 * 从房间码 + 客户端 ID 推出这对连接的密钥。
 * 前缀字符串是协议的一部分，**不是随便起的名字**，改一个字双方就对不上了。
 */
function derivePunchKey(code, clientId) {
  return code && clientId
    ? crypto.createHash('sha256')
        .update('VOXLINK-PUNCH-AUTH-V1')
        .update(code)
        .update(Buffer.from([0]))
        .update(clientId)
        .digest()
    : null
}

/**
 * 盖章：在包尾巴上加 4 个字节的 HMAC。
 * **注意签的是 `frame.subarray(2)`** —— 跳过最前面那两个字节（`VL` 魔数），
 * 这是上游的算法，不是遗漏。
 */
function signPunchFrame(frame, key) {
  return key
    ? Buffer.concat([
        frame,
        crypto.createHmac('sha256', key).update(frame.subarray(2)).digest().subarray(0, 4)
      ])
    : frame
}

/**
 * 验章：对不上就返回 null（调用方据此丢包）。
 * 用 `timingSafeEqual` 而不是 `===` —— 逐字节比会泄漏"猜对了几位"，虽然这里危害不大，
 * 但上游这么写就照办。
 */
function verifyPunchFrame(frame, key) {
  if (!key) return frame
  if (frame.length < 9) return null
  const body = frame.subarray(0, -4)
  const tag = crypto.createHmac('sha256', key).update(body.subarray(2)).digest().subarray(0, 4)
  return crypto.timingSafeEqual(tag, frame.subarray(-4)) ? body : null
}

module.exports = { derivePunchKey, signPunchFrame, verifyPunchFrame }

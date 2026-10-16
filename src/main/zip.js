// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 读 ZIP 压缩包
//
// 【为什么需要它】
// 两件事要用：① 老版本 Minecraft 的 natives 文件是压缩包，得解开铺到硬盘上
//             ② 拖放安装整合包要读压缩包里的清单和文件
//
// 【为什么不用现成的库】
// 还是那条原则：运行时不引入第三方依赖。ZIP 格式本身的读取并不复杂，
// 而且我们只需要"列出文件"和"取出文件"两件事，压缩方式只遇到两种
// （不压缩 / deflate），自己写一百多行就够，出问题也看得懂。
//
// 当前进度：M11.2（带密码的压缩包也能读了）
//
// 【加密这块的两种做法，都要认】
//   · 老式 ZipCrypto（"Zip 2.0"加密）：WinRAR 做 zip 用的就是它，
//     中文论坛上的整合包大多是这种。弱，但读起来只有几十行。
//   · AES（WinZip 2003 那套，AE-1/AE-2）：7-Zip、新一点的工具默认用它。
//     要 PBKDF2 + AES-CTR + HMAC，比上面那种长一些，但 Node 的 crypto 全都有。
// 密码错了必须说"密码不对"，不能让用户看一堆看不懂的报错（docs/01 里定过的）。
//
// 【怎么保证写对了】拿**另外两个独立实现**造的真样本回来解（见开发日志）：
// 自己加密、自己解密，两边的 bug 会互相抵消，测了等于没测。

const zlib = require('node:zlib')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/**
 * 压缩包里的文件名怎么解。
 *
 * 【为什么要分两种】ZIP 规范里，文件名只有在"标了 UTF-8 标志位"时才是 UTF-8；
 * 没标的时候按老规矩是 CP437（一个很老的字符集）。
 * 但 Windows 自带的"压缩成 zip"**用的是系统本地编码**——中文系统上就是 GBK，
 * 而且**不标那个标志位**。照着规范按 CP437 解，中文名就全成了乱码（实测踩过）。
 * 所以：没标 UTF-8 的一律按 GBK 试，解不出来再退回按原样。
 */
function decodeEntryName(buffer) {
  const utf8 = new TextDecoder('utf-8')
  const text = utf8.decode(buffer)
  if (!text.includes('�')) return text // 是合法的 UTF-8，直接用

  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return text
  }
}

/** 几个固定标记，ZIP 文件靠它们分隔各个区块 */
const SIG_LOCAL = 0x04034b50 // 每个文件的开头
const SIG_CENTRAL = 0x02014b50 // 目录里的一条记录
const SIG_EOCD = 0x06054b50 // 目录的结尾

// ——————————————————————————————————————————————
// 加密（M11.2）
// ——————————————————————————————————————————————

/** 目录记录里那个"通用标志位"：第 0 位 = 这个文件加密了 */
const FLAG_ENCRYPTED = 0x0001
/** 第 3 位 = 真正的大小和 CRC 写在数据后面（本地头里是 0） */
const FLAG_DESCRIPTOR = 0x0008
/** AES 加密在扩展区里留的记号 */
const EXTRA_AES = 0x9901

/** 密码不对时抛这个（带上 code，调用方好认） */
function wrongPassword() {
  const error = new Error('密码不对')
  error.code = 'WRONG_PASSWORD'
  return error
}

/** 文件加密了但没给密码 */
function needPassword() {
  const error = new Error('这个压缩包带密码，要先输密码')
  error.code = 'NEED_PASSWORD'
  return error
}

// ——— 老式 ZipCrypto ———

/** 标准 CRC-32 查表（ZipCrypto 的密钥更新就靠它） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i
    for (let j = 0; j < 8; j++) r = r & 1 ? (r >>> 1) ^ 0xedb88320 : r >>> 1
    table[i] = r
  }
  return table
})()

function crc32Update(crc, byte) {
  return ((crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]) >>> 0
}

/** 算一整段数据的 CRC-32（校验"解出来的对不对"用） */
function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = crc32Update(value, byte)
  return (value ^ 0xffffffff) >>> 0
}

/** 用密码初始化三个密钥 */
function zipCryptoKeys(password) {
  const keys = [0x12345678, 0x23456789, 0x34567890]
  const bytes = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf8')

  for (const byte of bytes) {
    keys[0] = crc32Update(keys[0], byte)
    keys[1] = (Math.imul((keys[1] + (keys[0] & 0xff)) >>> 0, 134775813) + 1) >>> 0
    keys[2] = crc32Update(keys[2], (keys[1] >>> 24) & 0xff)
  }
  return keys
}

/** 按 ZipCrypto 逐字节解密（密钥会跟着明文一路滚，所以只能一个个来） */
function zipCryptoDecrypt(data, keys) {
  const out = Buffer.alloc(data.length)

  for (let i = 0; i < data.length; i++) {
    const temp = (keys[2] | 2) & 0xffff
    const stream = (Math.imul(temp, temp ^ 1) >>> 8) & 0xff
    const plain = data[i] ^ stream
    out[i] = plain

    keys[0] = crc32Update(keys[0], plain)
    keys[1] = (Math.imul((keys[1] + (keys[0] & 0xff)) >>> 0, 134775813) + 1) >>> 0
    keys[2] = crc32Update(keys[2], (keys[1] >>> 24) & 0xff)
  }

  return out
}

/**
 * 解开 ZipCrypto 加密的数据。
 *
 * 前面 12 个字节是"加密头"（随机凑的，就是为了让同样的内容每次加密出来不一样），
 * 其中**最后一个字节**是个校验值：没开"数据描述符"时是 CRC 的高字节，
 * 开了的话是修改时间的高字节。对不上 = 密码不对。
 */
function decryptZipCrypto(raw, password, entry) {
  const keys = zipCryptoKeys(password)

  const header = zipCryptoDecrypt(raw.subarray(0, 12), keys)
  const expected =
    entry.flags & FLAG_DESCRIPTOR ? (entry.dosTime >> 8) & 0xff : (entry.crc >>> 24) & 0xff

  if (header[11] !== expected) throw wrongPassword()

  return zipCryptoDecrypt(raw.subarray(12), keys)
}

// ——— AES（WinZip AE-1 / AE-2）———

/** AES 用的 AES-CTR：计数器是一个 16 字节的小端整数，从 1 开始 */
function aesCtrDecrypt(key, data) {
  const out = Buffer.alloc(data.length)
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null)
  cipher.setAutoPadding(false)

  const counter = Buffer.alloc(16)

  for (let offset = 0, block = 1; offset < data.length; offset += 16, block++) {
    counter.writeUInt32LE(block >>> 0, 0)
    counter.writeUInt32LE(Math.floor(block / 4294967296), 4)
    const stream = cipher.update(counter)

    const take = Math.min(16, data.length - offset)
    for (let i = 0; i < take; i++) out[offset + i] = data[offset + i] ^ stream[i]
  }

  cipher.final()
  return out
}

/**
 * 解开 AES 加密的数据。
 *
 * 数据是这么摆的：盐(8/12/16) + 密码校验值(2) + 密文 + 校验码(10)。
 * 密钥用 PBKDF2-HMAC-SHA1 从"密码 + 盐"推出来，迭代 1000 次——
 * 盐是每个文件随机生成的，所以同一个密码在不同文件里算出的密钥也不一样。
 */
function decryptAes(raw, aes, password, entry) {
  const keyLength = aes.strength === 1 ? 16 : aes.strength === 2 ? 24 : 32
  const saltLength = keyLength / 2 // 128 位配 8 字节盐，256 位配 16 字节

  if (raw.length < saltLength + 2 + 10) throw wrongPassword()

  const salt = raw.subarray(0, saltLength)
  const verify = raw.subarray(saltLength, saltLength + 2)
  const body = raw.subarray(saltLength + 2, raw.length - 10)
  const authCode = raw.subarray(raw.length - 10)

  const passwordBytes = Buffer.isBuffer(password)
    ? password
    : Buffer.from(String(password), 'utf8')
  const derived = crypto.pbkdf2Sync(passwordBytes, salt, 1000, keyLength * 2 + 2, 'sha1')

  const aesKey = derived.subarray(0, keyLength)
  const hmacKey = derived.subarray(keyLength, keyLength * 2)

  // 先看那 2 个字节的"密码校验值"——不快，但能在解密之前就断定密码对不对
  if (!derived.subarray(keyLength * 2).equals(verify)) throw wrongPassword()

  // AE-2 才带校验码（AE-1 没有）；带的话必须对得上，否则说明数据被改过或坏了
  if (aes.version === 2) {
    const hmac = crypto.createHmac('sha1', hmacKey).update(body).digest().subarray(0, 10)
    if (!hmac.equals(authCode)) throw wrongPassword()
  }

  return aesCtrDecrypt(aesKey, body)
}

/** 这个压缩包里有没有加密的文件 */
function isEncrypted(entries) {
  return entries.some((entry) => entry.encrypted)
}

/**
 * 列出压缩包里都有什么（不解压，只读目录）。
 *
 * 【为什么要从后往前找】
 * ZIP 的"总目录"贴在文件最末尾。但末尾还可能有注释（长度不固定），
 * 所以只能从最后往前扫，找到那个标记为止。
 */
function listEntries(buffer) {
  // 找 EOCD，最多往前找 64KB（注释最长就这么长）
  let eocdAt = -1
  const from = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= from; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocdAt = i
      break
    }
  }
  if (eocdAt === -1) throw new Error('这不是一个合法的压缩包')

  const count = buffer.readUInt16LE(eocdAt + 10)
  let at = buffer.readUInt32LE(eocdAt + 16) // 目录区的起始位置

  const entries = []
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== SIG_CENTRAL) break

    const flags = buffer.readUInt16LE(at + 8)
    let method = buffer.readUInt16LE(at + 10)
    const dosTime = buffer.readUInt16LE(at + 12)
    const crc = buffer.readUInt32LE(at + 16)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const size = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localAt = buffer.readUInt32LE(at + 42)
    // 文件名按上面那个函数解（GBK 的包不能按 UTF-8 硬解，会乱码）
    // 另外：Windows 自带压缩写的路径是反斜杠（`我的世界\level.dat`），
    // 不符合 ZIP 规范但确实存在——统一换成正斜杠，后面处理省心
    const name = decodeEntryName(buffer.subarray(at + 46, at + 46 + nameLength)).replace(
      /\\/g,
      '/'
    )

    // 加密的文件"压缩方式"会写成一个特殊编号（AES 是 99），
    // 真正用的方式藏在扩展区的 0x9901 里——得把它挖出来，
    // 不然会当成"不认识的压缩方式"直接报错
    let aes = null
    const extraAt = at + 46 + nameLength
    const extraEnd = extraAt + extraLength

    for (let p = extraAt; p + 4 <= extraEnd; ) {
      const id = buffer.readUInt16LE(p)
      const len = buffer.readUInt16LE(p + 2)
      if (id === EXTRA_AES && len >= 7) {
        aes = {
          version: buffer.readUInt16LE(p + 4), // 1 = AE-1，2 = AE-2
          strength: buffer.readUInt8(p + 8), // 1 = 128 位，2 = 192 位，3 = 256 位
          method: buffer.readUInt16LE(p + 9) // 真正用的压缩方式
        }
        method = aes.method
      }
      p += 4 + len
    }

    entries.push({
      name,
      method,
      compressedSize,
      size,
      localAt,
      flags,
      dosTime,
      crc,
      encrypted: Boolean(flags & FLAG_ENCRYPTED),
      aes
    })
    at += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/**
 * 取出压缩包里的一个文件，返回它的内容。
 *
 * @param {Buffer} buffer 整个压缩包
 * @param {object} entry listEntries 里的一项
 * @param {string} [password] 加密包要给的密码。没给而文件又是加密的，
 *   会抛一个 code = 'NEED_PASSWORD' 的错；密码不对抛 code = 'WRONG_PASSWORD'
 */
function readEntry(buffer, entry, password) {
  // 本地头里的"文件名长度/扩展区长度"和目录里可能不一样，得以本地头为准
  const nameLength = buffer.readUInt16LE(entry.localAt + 26)
  const extraLength = buffer.readUInt16LE(entry.localAt + 28)
  const dataAt = entry.localAt + 30 + nameLength + extraLength

  const raw = buffer.subarray(dataAt, dataAt + entry.compressedSize)

  // ——— 先解密（如果有密码的话）———
  let payload = raw
  if (entry.aes) {
    if (!password) throw needPassword()
    payload = decryptAes(raw, entry.aes, password, entry)
  } else if (entry.encrypted) {
    if (!password) throw needPassword()
    payload = decryptZipCrypto(raw, password, entry)
  }

  if (entry.method === 0) return Buffer.from(payload) // 没压缩，原样返回

  if (entry.method === 8) {
    let out
    try {
      out = zlib.inflateRawSync(payload)
    } catch {
      // 解不开：多半是密码错了（ZipCrypto 的 1 字节校验偶尔会放错人进来）
      if (entry.encrypted) throw wrongPassword()
      throw new Error('这个文件解不开，压缩包可能坏了')
    }

    // 再拿 CRC 核一遍——解出来的东西对不上，那就是密码不对
    if (entry.encrypted && entry.crc && crc32(out) !== entry.crc) throw wrongPassword()

    return out
  }

  throw new Error(`压缩包里用了不支持的压缩方式（编号 ${entry.method}）`)
}

/**
 * 把压缩包解到某个目录里。
 *
 * @param {Buffer} buffer 压缩包的完整内容
 * @param {string} destDir 解到哪
 * @param {{filter?: (name: string) => boolean}} options
 *        filter 返回 false 的条目不处理（比如只解压某一类文件）
 * @returns {number} 解出来几个文件
 */
function extractTo(buffer, destDir, options = {}) {
  const { filter, password } = options
  const entries = listEntries(buffer)
  let written = 0

  for (const entry of entries) {
    // 目录条目（名字以 / 结尾）不用管——我们按文件路径自动建目录
    if (entry.name.endsWith('/')) continue
    if (filter && !filter(entry.name)) continue

    // 【安全】压缩包里的路径可能是 ../ 这种，会解到目标目录外面去。
    // 必须挡住——否则一个恶意压缩包能往你系统任意位置写文件。
    const target = path.resolve(destDir, entry.name)
    const base = path.resolve(destDir)
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error(`压缩包里有不安全的路径，已拒绝：${entry.name}`)
    }

    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, readEntry(buffer, entry, password))
    written++
  }

  return written
}

module.exports = { listEntries, readEntry, extractTo, isEncrypted, crc32 }

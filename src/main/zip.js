// MC启动器 — 读 ZIP 压缩包
//
// 【为什么需要它】
// 两件事要用：① 老版本 Minecraft 的 natives 文件是压缩包，得解开铺到硬盘上
//             ② 以后"拖放安装整合包"要读压缩包里的清单
//
// 【为什么不用现成的库】
// 还是那条原则：运行时不引入第三方依赖。ZIP 格式本身的读取并不复杂，
// 而且我们只需要"列出文件"和"取出文件"两件事，压缩方式只遇到两种
// （不压缩 / deflate），自己写一百多行就够，出问题也看得懂。
//
// 当前进度：M4（只支持不加密的压缩包；带密码的等做"拖放安装"时再加）。

const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

/** 几个固定标记，ZIP 文件靠它们分隔各个区块 */
const SIG_LOCAL = 0x04034b50 // 每个文件的开头
const SIG_CENTRAL = 0x02014b50 // 目录里的一条记录
const SIG_EOCD = 0x06054b50 // 目录的结尾

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

    const method = buffer.readUInt16LE(at + 10)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const size = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localAt = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)

    entries.push({ name, method, compressedSize, size, localAt })
    at += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/** 取出压缩包里的一个文件，返回它的内容 */
function readEntry(buffer, entry) {
  // 本地头里的"文件名长度/扩展区长度"和目录里可能不一样，得以本地头为准
  const nameLength = buffer.readUInt16LE(entry.localAt + 26)
  const extraLength = buffer.readUInt16LE(entry.localAt + 28)
  const dataAt = entry.localAt + 30 + nameLength + extraLength

  const raw = buffer.subarray(dataAt, dataAt + entry.compressedSize)

  if (entry.method === 0) return Buffer.from(raw) // 没压缩，原样返回
  if (entry.method === 8) return zlib.inflateRawSync(raw) // deflate

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
  const { filter } = options
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
    fs.writeFileSync(target, readEntry(buffer, entry))
    written++
  }

  return written
}

module.exports = { listEntries, readEntry, extractTo }

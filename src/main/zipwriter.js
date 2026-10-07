// 毛球 — 写 ZIP 压缩包（备份用）
//
// 读 ZIP 的在 zip.js；这个文件负责"写"。
//
// 【为什么自己写】还是那条老规矩：运行时不引入第三方依赖。
// ZIP 的"写"比"读"多一件事：CRC 校验值和压缩后的大小要等数据写完才知道，
// 所以先把这三个数在文件头里留空，数据写完再回头填上（硬盘支持随机写，很快）。
//
// 【为什么压缩包必须"验回来"】备份坏了比没备份更糟——用户以为有备份，
// 真出事的时候打不开。所以这里除了写，还带一个 verifyZip：
// 写完立刻从文件里把目录读出来核对，再抽查几个文件解开来对 CRC。
//
// 【大文件不压缩】超过阈值的文件直接用"原样存"（ZIP 支持不压缩的条目）。
// 两个原因：① 那些多是 jar/zip，压缩了也小不了多少
//          ② 不用把整个文件读进内存
//
// 【超过 3.5 GB 或 6 万个文件就拒绝】那需要 ZIP64 格式，这里不做——
// 宁可明确说"太大了，请选文件夹形式"，也不要生成一个别人打不开的包。

const fs = require('node:fs')
const zlib = require('node:zlib')

/** 超过这个大小的文件原样存（不压缩），免得整个读进内存 */
const STORE_THRESHOLD = 32 * 1024 * 1024

/** 超过这些就超出普通 ZIP 的能力了（需要 ZIP64），直接拒绝 */
const MAX_TOTAL_BYTES = 3.5 * 1024 * 1024 * 1024
const MAX_FILES = 60000

/** CRC32 查表，启动时算一次 */
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

/** 算一段数据的 CRC32。可以接着上一次的结果算（seed 传上次的返回值） */
function crc32(buffer, seed = 0) {
  let crc = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < buffer.length; i++) {
    crc = (CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** JS 的时间 → ZIP 用的 DOS 时间格式（1980 年起，秒只有 2 秒精度） */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time: time & 0xffff, date: day & 0xffff }
}

/** 每条文件的本地头（CRC 和大小先填 0，写完回填） */
function localHeader(nameBuffer, method, { time, date }) {
  const header = Buffer.alloc(30 + nameBuffer.length)
  header.writeUInt32LE(0x04034b50, 0) // 标记
  header.writeUInt16LE(20, 4) // 需要的版本
  header.writeUInt16LE(0x0800, 6) // 标志位：文件名是 UTF-8（中文名必须）
  header.writeUInt16LE(method, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(date, 12)
  // 14..25 依次是 CRC、压缩后大小、原大小——留 0，后面回填
  header.writeUInt16LE(nameBuffer.length, 26)
  header.writeUInt16LE(0, 28) // 扩展区长度
  nameBuffer.copy(header, 30)
  return header
}

/** 中央目录里的一条记录 */
function centralHeader(entry) {
  const header = Buffer.alloc(46 + entry.nameBuffer.length)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4) // 制作版本
  header.writeUInt16LE(20, 6) // 需要的版本
  header.writeUInt16LE(0x0800, 8)
  header.writeUInt16LE(entry.method, 10)
  header.writeUInt16LE(entry.time, 12)
  header.writeUInt16LE(entry.date, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(entry.compSize, 20)
  header.writeUInt32LE(entry.rawSize, 24)
  header.writeUInt16LE(entry.nameBuffer.length, 28)
  header.writeUInt16LE(0, 30) // 扩展区
  header.writeUInt16LE(0, 32) // 备注
  header.writeUInt16LE(0, 34) // 起始磁盘号
  header.writeUInt16LE(0, 36) // 内部属性
  header.writeUInt32LE(0, 38) // 外部属性
  header.writeUInt32LE(entry.offset, 42)
  entry.nameBuffer.copy(header, 46)
  return header
}

/** 结尾记录 */
function endRecord(count, centralSize, centralOffset) {
  const record = Buffer.alloc(22)
  record.writeUInt32LE(0x06054b50, 0)
  record.writeUInt16LE(0, 4)
  record.writeUInt16LE(0, 6)
  record.writeUInt16LE(count, 8)
  record.writeUInt16LE(count, 10)
  record.writeUInt32LE(centralSize, 12)
  record.writeUInt32LE(centralOffset, 16)
  record.writeUInt16LE(0, 20)
  return record
}

/**
 * 把一堆文件打包成一个 zip。
 *
 * @param {string} outPath 生成到哪
 * @param {Array<{source: string, name: string}>} files 要打包的文件（name 是包里的路径，用 / 分隔）
 * @param {{onProgress?: (done: number, total: number, bytes: number) => void|Promise<void>}} options
 *        onProgress 如果返回 Promise，会被 await——调用方拿它来"喘口气"，
 *        免得打包几个 GB 的时候整个界面卡住不动
 * @returns {Promise<{ok: boolean, bytes?: number, count?: number, error?: string}>}
 */
async function writeZip(outPath, files, options = {}) {
  const { onProgress } = options

  // 先算一遍总量，太大的直接拒绝（ZIP64 不做）
  let totalBytes = 0
  for (const file of files) {
    totalBytes += fs.statSync(file.source).size
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, error: '要备份的东西超过了 3.5 GB，压缩包放不下，请改选「文件夹」形式' }
    }
  }
  if (files.length > MAX_FILES) {
    return { ok: false, error: `文件太多（${files.length} 个），请改选「文件夹」形式` }
  }

  const fd = fs.openSync(outPath, 'w')
  const entries = []
  let offset = 0

  const writeAt = (buffer) => {
    fs.writeSync(fd, buffer, 0, buffer.length, offset)
    offset += buffer.length
  }

  try {
    for (const file of files) {
      const stat = fs.statSync(file.source)
      const nameBuffer = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8')
      const { time, date } = dosDateTime(stat.mtime || new Date())
      const method = stat.size >= STORE_THRESHOLD ? 0 : 8

      const headerOffset = offset
      writeAt(localHeader(nameBuffer, method, { time, date }))

      let crc = 0
      let rawSize = 0
      let compSize = 0

      if (method === 0) {
        // 原样搬：分块读、分块写，内存里始终只有 1 MB
        const inFd = fs.openSync(file.source, 'r')
        const chunk = Buffer.alloc(1024 * 1024)
        let position = 0
        let read = 0
        while ((read = fs.readSync(inFd, chunk, 0, chunk.length, position)) > 0) {
          const slice = Buffer.from(chunk.subarray(0, read))
          crc = crc32(slice, crc)
          writeAt(slice)
          position += read
          rawSize += read
        }
        fs.closeSync(inFd)
        compSize = rawSize
      } else {
        const raw = fs.readFileSync(file.source)
        const packed = zlib.deflateRawSync(raw, { level: 6 })
        crc = crc32(raw)
        rawSize = raw.length
        compSize = packed.length
        writeAt(packed)
      }

      // 回填头部里留空的三个数：CRC、压缩后大小、原大小
      const patch = Buffer.alloc(12)
      patch.writeUInt32LE(crc, 0)
      patch.writeUInt32LE(compSize, 4)
      patch.writeUInt32LE(rawSize, 8)
      fs.writeSync(fd, patch, 0, 12, headerOffset + 14)

      entries.push({
        nameBuffer,
        method,
        time,
        date,
        crc,
        compSize,
        rawSize,
        offset: headerOffset
      })

      if (onProgress) await onProgress(entries.length, files.length, offset)
    }

    // 中央目录 + 结尾
    const centralOffset = offset
    for (const entry of entries) writeAt(centralHeader(entry))
    const centralSize = offset - centralOffset
    writeAt(endRecord(entries.length, centralSize, centralOffset))
  } catch (error) {
    fs.closeSync(fd)
    try {
      fs.unlinkSync(outPath)
    } catch {
      // 删不掉半成品就算了
    }
    return { ok: false, error: `打包失败：${error.message}` }
  }

  fs.closeSync(fd)
  return { ok: true, bytes: offset, count: entries.length }
}

/**
 * 把刚写好的包"验回来"：
 *   ① 从文件尾部读目录，核对条目数对不对
 *   ② 抽查最多 3 个最小的文件，解开来重算 CRC，和目录里记的比对
 *
 * 只读文件的局部（不整个读进内存），几十 GB 的包也能验。
 *
 * @returns {{ok: boolean, checked?: number, error?: string}}
 */
function verifyZip(file, expectedCount) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    if (size < 22) return { ok: false, error: '包太小了，不像是正常的压缩包' }

    // —— ① 找到结尾记录（从末尾往前扫，最多扫 64 KB）——
    const tailSize = Math.min(size, 65557)
    const tail = Buffer.alloc(tailSize)
    fs.readSync(fd, tail, 0, tailSize, size - tailSize)

    let eocdAt = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocdAt = i
        break
      }
    }
    if (eocdAt === -1) return { ok: false, error: '找不到压缩包的目录（结尾记录）' }

    const count = tail.readUInt16LE(eocdAt + 10)
    const centralSize = tail.readUInt32LE(eocdAt + 12)
    const centralOffset = tail.readUInt32LE(eocdAt + 16)

    if (count !== expectedCount) {
      return { ok: false, error: `目录里写着 ${count} 个文件，实际应该 ${expectedCount} 个` }
    }
    if (centralOffset + centralSize > size) {
      return { ok: false, error: '目录的位置超出了文件范围' }
    }

    // —— 读中央目录，收集每条记录 ——
    if (centralSize > 64 * 1024 * 1024) {
      // 目录本身大于 64 MB（几万个文件）就不细查了，前面已经核对过数量
      return { ok: true, checked: 0 }
    }
    const central = Buffer.alloc(centralSize)
    fs.readSync(fd, central, 0, centralSize, centralOffset)

    const records = []
    let at = 0
    for (let i = 0; i < count; i++) {
      if (central.readUInt32LE(at) !== 0x02014b50) {
        return { ok: false, error: `第 ${i + 1} 条目录记录坏掉了` }
      }
      const method = central.readUInt16LE(at + 10)
      const crc = central.readUInt32LE(at + 16)
      const compSize = central.readUInt32LE(at + 20)
      const rawSize = central.readUInt32LE(at + 24)
      const nameLength = central.readUInt16LE(at + 28)
      const extraLength = central.readUInt16LE(at + 30)
      const commentLength = central.readUInt16LE(at + 32)
      const localOffset = central.readUInt32LE(at + 42)
      const name = central.toString('utf8', at + 46, at + 46 + nameLength)
      records.push({ name, method, crc, compSize, rawSize, localOffset })
      at += 46 + nameLength + extraLength + commentLength
    }

    // —— ② 抽查最小的 3 个（含 0 字节的），解开来对 CRC ——
    const samples = records
      .filter((r) => r.rawSize <= 8 * 1024 * 1024)
      .sort((a, b) => a.rawSize - b.rawSize)
      .slice(0, 3)

    for (const record of samples) {
      const head = Buffer.alloc(30)
      fs.readSync(fd, head, 0, 30, record.localOffset)
      if (head.readUInt32LE(0) !== 0x04034b50) {
        return { ok: false, error: `文件「${record.name}」的头部标记不对` }
      }
      const nameLength = head.readUInt16LE(26)
      const extraLength = head.readUInt16LE(28)
      const dataAt = record.localOffset + 30 + nameLength + extraLength

      const packed = Buffer.alloc(record.compSize)
      fs.readSync(fd, packed, 0, record.compSize, dataAt)

      let raw
      if (record.method === 0) raw = packed
      else if (record.method === 8) raw = zlib.inflateRawSync(packed)
      else return { ok: false, error: `文件「${record.name}」用了不认识的压缩方式` }

      if (raw.length !== record.rawSize || crc32(raw) !== record.crc) {
        return { ok: false, error: `文件「${record.name}」的内容对不上（校验失败）` }
      }
    }

    return { ok: true, checked: samples.length }
  } catch (error) {
    return { ok: false, error: `校验时出错：${error.message}` }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // 已经关了就算了
      }
    }
  }
}

module.exports = { writeZip, verifyZip, crc32, STORE_THRESHOLD }

// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 下载引擎
//
// 这是整个启动器最核心的一块。装一个游戏要下几千个文件
// （客户端 jar + 一百多个库文件 + 几千个音效贴图 + Java 运行时），
// 全都靠这个模块可靠地拉下来。
//
// 【设计要点，每条都是踩过坑才会想到的】
//
// 1. **先下到 .part 临时文件，校验通过才改名成正式文件**
//    否则网络断了会留下一个"看着像下好了、其实是半截"的 jar，
//    下次启动直接报一个莫名其妙的类找不到——极难排查。
//
// 2. **下完必须核对哈希**
//    官方清单里每个文件都带 SHA1。不对就重下——
//    这样"下坏了""被中间人改了""杀毒软件动了手脚"都能发现。
//
// 3. **已经下好且校验通过的文件直接跳过**
//    libraries 和 assets 是所有版本共享的。装第二个版本时大部分文件已经在了，
//    校验一下跳过即可，能省几百 MB 的下载。
//
// 4. **失败自动重试**，间隔逐次拉长。网络抖动是常态。
//
// 5. **官方源和镜像之间自动切换 —— 但必须"两个方向都能切"**
//    这一条吃了大亏，详细说明见下面「源切换」那一段。
//
// 当前进度：M3。

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { openStream } = require('./http')
const settings = require('./settings')
const mirror = require('./mirror')

/** 同时下几个文件。8 是个平衡点：再多对方服务器可能限速，再少下得慢 */
const DEFAULT_CONCURRENCY = 16

/**
 * 超过这么久没动过的半截文件（`.part`）就不再续了，直接扔掉（M23）。
 * 7 天：用户断网重来一般就是当天或者第二天的事，隔了一周的多半早忘了。
 */
const STALE_PART_MS = 7 * 24 * 60 * 60 * 1000

/** 一个文件最多试几次 */
const MAX_ATTEMPTS = 3

/** 每次重试前等多久（毫秒），逐次拉长 */
const RETRY_DELAYS = [600, 1800, 4000]

/** 单次请求的超时（毫秒） */
const REQUEST_TIMEOUT = 60000

// ——————————————————————————————————————————————
// 源切换：这一段是用一个下午的排查换来的
// ——————————————————————————————————————————————
//
// 【踩过的坑】
// 第一版按"下载速度"决定要不要换源，规则是"连续 3 个文件都慢于 150KB/秒就换"。
// 结果：小文件（9KB）光建立连接就要 350ms，算出来只有 26KB/秒——
// **被误判成"源太慢"**。于是所有任务都切到了镜像。
// 而那次镜像恰好是坏的（有些请求直接卡到 60 秒超时），
// 更糟的是**切过去就再也回不来**，整批任务全卡死在上面。
//
// 一次下载 1MB 花了 109 秒，而同样的文件官方的实际耗时是 1.2 秒。
//
// 【所以现在这么做】
// · 只有**够大的文件**才用来判断速度。小文件的速度数字没有意义。
// · 换源之后**还能再换回来**——两边都不行就一直来回换，
//   绝不会永久卡在某一边。
// · 失败（连不上 / 超时 / 校验不过）比"慢"更值得换源，权重更高。

/** 小于这个大小的文件不参与"速度判断"——它们的速度数字没有参考价值 */
const MIN_SIZE_FOR_SPEED_JUDGING = 512 * 1024

/** 大文件慢于这个速度，算一次"这个源不行" */
const BAD_SPEED = 200 * 1024

/** 连续几次"这个源不行"就换到另一边 */
const BAD_STREAK_TO_SWITCH = 3

// ——————————————————————————————————————————————
// 小工具
// ——————————————————————————————————————————————

/** 算一个文件的 SHA1（十六进制小写，和官方清单里的格式一致） */
function sha1OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 检查硬盘上已有的文件是不是我们要的那一个。
 * 文件在、大小对、哈希对，才算数。
 */
async function existingFileIsGood(file) {
  try {
    const stat = fs.statSync(file.saveTo)
    if (!stat.isFile()) return false
    // 大小先比一下：不对就不用算哈希了，省时间
    if (file.size && stat.size !== file.size) return false
    // 没有提供哈希的话，文件在且大小对就认了
    if (!file.sha1) return true
    return (await sha1OfFile(file.saveTo)) === file.sha1
  } catch {
    return false
  }
}

/** 把一段时间的下载量换算成速度 */
function createSpeedMeter() {
  const samples = []
  const WINDOW = 5000
  let lastSampleAt = 0

  return {
    add(bytes) {
      const now = Date.now()
      // 采样太密没意义，还会让数组膨胀
      if (now - lastSampleAt < 200) {
        if (samples.length > 0) samples[samples.length - 1].bytes += bytes
        return
      }
      lastSampleAt = now
      samples.push({ t: now, bytes })
    },
    speed() {
      const now = Date.now()
      while (samples.length > 0 && now - samples[0].t > WINDOW) samples.shift()
      if (samples.length === 0) return 0
      const bytes = samples.reduce((sum, s) => sum + s.bytes, 0)
      const span = Math.max((now - samples[0].t) / 1000, 0.5)
      return bytes / span
    }
  }
}

// ——————————————————————————————————————————————
// 下一个文件
// ——————————————————————————————————————————————

/**
 * 限速器（M13 加的"最大速度"）。
 *
 * 【怎么限的】把流**暂停**一下，而不是丢包或者硬等——暂停是 TCP 自己的流控，
 * 服务器那边会跟着慢下来，比"读进来扔掉"省流量。
 * 算法很简单：从开始到现在，如果下载量超过了"限速 × 已经过去的时间"，
 * 就按超出的那部分睡一会儿。
 *
 * limitKB 为 0 = 不限速（默认），这时候连对象都不建，一点开销都没有。
 */
function createThrottle(limitKB) {
  if (!limitKB || limitKB <= 0) return null

  const bytesPerMs = (limitKB * 1024) / 1000
  // 【为什么 startedAt 是 0、等第一批数据才真正开始计时】
  // 请求发出去到第一个字节回来可能要等一秒多（DNS、服务器思考人生），
  // 这段时间要是也算进"额度"，就等于白白多给了一两 MB 的额度——
  // 实测限到 2 MB/s 结果跑出了 6.5 MB/s，就是这么来的。
  let startedAt = 0
  let sent = 0
  let asleep = false

  return {
    /** 报告下了一批字节；该歇就歇一会儿 */
    async account(chunkLength) {
      if (!startedAt) {
        startedAt = Date.now()
        sent = 0
      }

      sent += chunkLength

      const shouldHaveTook = sent / bytesPerMs
      const took = Date.now() - startedAt
      const behind = shouldHaveTook - took

      if (behind > 50 && !asleep) {
        asleep = true
        await new Promise((resolve) => setTimeout(resolve, behind))
        asleep = false
      }

      // 落后太多（比如中途卡了一下）就重新对表，免得越欠越多、一下睡很久
      if (behind > 5000) {
        startedAt = Date.now()
        sent = 0
      }
    }
  }
}

/**
 * 把 url 的内容流式写进 dest，边写边报告进度。
 *
 * 【限速时为什么不能再用 pipe】踩过的坑：一开始在 'data' 里 `pause()`，
 * 想停一会儿再 `resume()`——可 `pipe()` 自己会在底层按需 resume，
 * 把我们的暂停顶掉，结果限速形同虚设（实测限 2 MB/s 跑出 13 MB/s）。
 * 所以限速时**自己接管**：不 pipe，手动 write，写不动就等 'drain'，
 * 该歇就歇。不限速时照旧用 pipe（那条路最快、也最不容易出岔子）。
 */
function streamToFile(url, dest, { signal, onBytes, throttle, offset = 0 }) {
  // 断点续传（M23）：已经有半截文件的话，带一个 Range 头过去，从断的地方接着下。
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {}

  return openStream(url, { signal, timeout: REQUEST_TIMEOUT, headers }).then(
    ({ stream, statusCode }) =>
      new Promise((resolve, reject) => {
        // 【必须核对服务器的回应】不是所有服务器都认 Range。
        // 它要是**不认**（回 200 而不是 206），那就是把整份内容从头发过来了——
        // 这时候还往半截文件后面追加，就会得到"前半截 + 完整一份"的垃圾文件
        // （校验能挡住，但白白下几百 MB）。所以：不认 Range 就清空重下。
        const resumed = offset > 0 && statusCode === 206
        const startAt = resumed ? offset : 0

        if (offset > 0 && !resumed) {
          try {
            fs.unlinkSync(dest)
          } catch {
            // 本来就不在
          }
        }

        const out = fs.createWriteStream(dest, { flags: resumed ? 'a' : 'w' })
        let settled = false

        // 把已经下好的那部分也算进"这个文件收了多少"，
        // 不然续传时进度条会从一半的地方往回跳
        if (resumed && onBytes) onBytes(offset, true)

        const fail = (error) => {
          if (settled) return
          settled = true
          out.destroy()
          stream.destroy()
          reject(error)
        }

        stream.on('error', fail)
        out.on('error', fail)
        out.on('finish', () => {
          if (settled) return
          settled = true
          resolve()
        })

        // ——— 不限速：老路子，交给 pipe ———
        if (!throttle) {
          stream.on('data', (chunk) => onBytes(chunk.length))
          stream.pipe(out)
          return
        }

        // ——— 限速：自己接管数据流 ———
        stream.on('data', (chunk) => {
          onBytes(chunk.length)
          stream.pause()

          // 先让磁盘跟上（写不动就等 drain），再按限速歇一会儿
          const flushed = out.write(chunk)
          const waitFlush = flushed
            ? Promise.resolve()
            : new Promise((done) => out.once('drain', done))

          waitFlush
            .then(() => throttle.account(chunk.length))
            .then(() => {
              if (!settled) stream.resume()
            })
        })

        stream.on('end', () => out.end())
      })
  )
}

// ——————————————————————————————————————————————
// 单个大文件：分段多连接（M30）
// ——————————————————————————————————————————————
//
// 【为什么要这个】整合包、资源文件里常有几百 MB 的单个文件。
// 一个连接拉一个大文件，速度往往被**单连接的窗口/丢包**卡住——
// 换成几个连接各拉一段（HTTP Range），总速度能明显上去。
// 同类启动器（PCL）的多线程下载引擎就是干这个的。
//
// 【和"同时下几个文件"不是一回事】那个是**多文件**并发（这里是 16 个文件一起下），
// 多个小文件本来就能把带宽吃满；**瓶颈只在大文件**上，所以这里只管大文件。
//
// 【三条规矩，都是"别把原来的可靠性搞坏"】
//   1. **小文件不分段**——几百 KB 的文件建连接的时间比下载还长，分了反而更慢。
//   2. **服务器不认 Range 就整条退回老路**——不是所有源都支持；发现是 200（而不是 206）
//      立刻放弃分段、按原来的单连接重来（见 segmentedToFile 里的 noRanges）。
//   3. **限速时不分段**——限速那套是"一个流自己掐节奏"（见 streamToFile 的注释），
//      几个流各掐各的会算不准。
//   4. **没有 sha1 的文件不分段**——整套"半截文件"的安全前提就是"下完要校验哈希才认"
//      （见文件开头的设计要点 1）。没哈希的文件，万一拼错了没人拦得住：
//      方块工程 2026-10-17 复核时真复现出一条通路 —— 侧车谎称某段下完、`.part` 其实只有一半，
//      那段被跳过、后面那段把文件撑到正好 size ⇒ **大小检查也拦不住**，安静地交付一个坏文件。
//      有 sha1 时这类问题都会被校验挡下（失败→删两份→重下），没 sha1 就连挡的人都没有。
//      所以：**宁可慢一点走单连接，也不给"没法验"的文件分段**。

/** 小于这个大小就不值得分段（建连接的开销 > 省下的时间） */
const MIN_SIZE_FOR_SEGMENTED = 8 * 1024 * 1024

/** 一个文件最多分几段（再多对方服务器容易掐，收益也递减） */
const MAX_SEGMENTS = 8

/** 每 32 MB 加一个连接；不足 32 MB 也要 2 个 */
const SEGMENT_STEP = 32 * 1024 * 1024

/** 全局同时只允许几个"分段中的文件"——16 个文件 × 8 段 = 128 条连接，会被掐 */
const MAX_SEGMENTED_AT_ONCE = 4

/** 现在有几个文件在分段 */
let segmentingNow = 0
/** 排队等分段名额的 */
const segmentWaiters = []

/**
 * "本该分段、结果没分"的次数，分类记着。
 *
 * 【为什么要留这个痕】这些情况都是**悄悄地变回单连接、悄悄变慢**：不报错、界面上也看不出来。
 * 以后有人问"某某包怎么下得这么慢"，有这个计数就能一眼看出来是"没哈希所以没分段"，
 * 不用从头查一遍。（方块工程 2026-10-17 复核时提的，本鱼认。）
 */
const segmentationSkips = { noHash: 0, throttled: 0 }

/** 给探针/排查用：看看有哪些大文件没走分段、为什么 */
function segmentSkipStats() {
  return { ...segmentationSkips, segmentingNow, waiting: segmentWaiters.length }
}

/** 抢一个"分段名额"（满了就排队），跑完自动让给下一个 */
function withSegmentSlot(run) {
  return new Promise((resolve, reject) => {
    const go = () => {
      segmentingNow++
      Promise.resolve()
        .then(run)
        .then(resolve, reject)
        .finally(() => {
          segmentingNow--
          const next = segmentWaiters.shift()
          if (next) next()
        })
    }
    if (segmentingNow < MAX_SEGMENTED_AT_ONCE) go()
    else segmentWaiters.push(go)
  })
}

/** 这个文件该分几段（1 = 不分段） */
function segmentCountFor(size) {
  if (!size || size < MIN_SIZE_FOR_SEGMENTED) return 1
  return Math.min(MAX_SEGMENTS, Math.max(2, Math.ceil(size / SEGMENT_STEP)))
}

/** 侧车文件名：记每一段下到哪儿了（`.part` 本身是稀疏文件，光看大小看不出进度） */
function segmentSidecar(partPath) {
  return `${partPath}.seg`
}

/** 写侧车文件——先写临时文件再改名（断电不会写出个半截 JSON 让下次读崩） */
function writeSegmentSidecar(sidecar, data) {
  try {
    const tmp = `${sidecar}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
    fs.renameSync(tmp, sidecar)
  } catch {
    // 写不进去就算了：下次续传时读不到侧车，会从头来一遍（不会出错，只是白下）
  }
}

/** 把 content-range: bytes 100-199/1234 解出来 */
function parseContentRange(header) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(header || '').trim())
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? 0 : Number(m[3]) }
}

/**
 * 分段把一个文件写进 partPath（就是那个 `.part`）。
 *
 * @param {string} url
 * @param {string} partPath
 * @param {{signal: AbortSignal, onBytes: Function, size: number, segments: number, throttle?: object}} options
 * @returns {Promise<{bytes: number}>}
 *   失败时抛的错里可能带 `noRanges = true`（服务器不支持 Range → 调用方该退回单连接）
 */
async function segmentedToFile(url, partPath, { signal, onBytes, size, segments }) {
  const sidecar = segmentSidecar(partPath)

  // ——— 算出每一段的区间 ———
  const bounds = []
  const per = Math.ceil(size / segments)
  for (let i = 0; i < segments; i++) {
    const from = i * per
    if (from >= size) break
    bounds.push({ from, to: Math.min(size, from + per) - 1, done: 0 })
  }

  // ——— 有侧车就接着上次的进度；对不上就整份重来 ———
  let have = null
  if (fs.existsSync(sidecar)) {
    try {
      const saved = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
      if (saved && saved.size === size && Array.isArray(saved.bounds) && saved.bounds.length === bounds.length) {
        have = saved.bounds
      }
    } catch {
      // 读不出来当没有
    }
  }
  // 【侧车在、`.part` 却不在 → 侧车是孤儿】按它接着下会拼出一个中间全是洞的文件
  // （大小检查能拦下，但白折腾一轮）。两份同生共死（见 downloadOneFile 里那段），
  // 真碰上就当没这回事，从头来。
  const resuming = !!have && fs.existsSync(partPath)
  if (have && !resuming) have = null
  if (have) {
    // 【还要按 `.part` 的真实长度再钳一次】侧车只证明"打算下到哪"，**不证明文件里真有那么多字节**。
    // 断电丢写、侧车比数据先落盘都会留下"侧车比文件长"的现场；不钳的话那一段会被整段跳过、
    // 中间留一个永远不写的洞，而后一段又会把文件撑到正好 size —— **大小检查拦不住**
    // （方块工程 2026-10-17 复核时复现的就是这条）。
    let partSize = 0
    try {
      partSize = fs.statSync(partPath).size
    } catch {
      partSize = 0
    }
    for (let i = 0; i < bounds.length; i++) {
      const done = Number(have[i] && have[i].done) || 0
      bounds[i].done = Math.max(
        0,
        Math.min(done, bounds[i].to - bounds[i].from + 1, Math.max(0, partSize - bounds[i].from))
      )
    }
  } else {
    try {
      fs.unlinkSync(partPath)
    } catch {
      /* 本来就不在 */
    }
    writeSegmentSidecar(sidecar, { size, bounds: bounds.map((b) => ({ from: b.from, to: b.to, done: 0 })) })
  }

  // 接着下的那部分也算"这个文件收了多少"，续传时进度条才不会往回跳
  const already = bounds.reduce((sum, b) => sum + b.done, 0)
  if (already > 0 && onBytes) onBytes(already, true)

  // 【别用 'a'（追加）打开】**追加模式下按偏移写是无效的**——Node 明确说过
  // "Linux 上以追加模式打开时定位写不生效"，Windows 上一样会把每一段都写到文件末尾，
  // 结果几段互相盖、拼出一个大小对不上、内容全错的文件。
  // （第一版就是这么写的，探针当场抓出来：哈希对不上。）
  // 续传用 'r+'（不能截断已有的进度），从头下用 'w+'（建新文件）。
  const fd = fs.openSync(partPath, resuming ? 'r+' : 'w+')
  let bytes = already
  let lastSaved = 0
  let sinceSave = 0

  // 进度多久记一次：**1.5 秒或者又下了 4 MB**，哪个先到算哪个。
  // 【为什么要有个"字节数"条件】只看时间的话，网快的时候 1.5 秒能下好几 MB——
  // 一断网那几 MB 就白下了（侧车没有记到）。加上 4 MB 这条，白下的量有个上界。
  // 【注意"白下"是唯一的代价】前提是**只给有 sha1 的文件分段**（见文件上方第 4 条）：
  // 这样最坏也只是重下一段，绝不会交付一个没验过的文件。
  //
  // 【写侧车之前先把数据刷到盘（fsync）】**顺序反了就会出事**：侧车比数据先落盘，
  // 断电后就成了"侧车说下完了、文件里其实没有"——那正是上面按 partSize 再钳一次要防的现场。
  // （方块工程复核时的建议；一次 fsync 的代价换来"侧车永远不会比数据新"。）
  const saveProgress = (force) => {
    const now = Date.now()
    if (!force && now - lastSaved < 1500 && sinceSave < 4 * 1024 * 1024) return
    lastSaved = now
    sinceSave = 0
    try {
      fs.fsyncSync(fd)
    } catch {
      // 刷不动就算了：下面按 partSize 钳一次还能兜住
    }
    writeSegmentSidecar(sidecar, { size, bounds: bounds.map((b) => ({ from: b.from, to: b.to, done: b.done })) })
  }

  // 正在跑的几条流：**一条段挂了就把别的全掐了**——
  // 不然"服务器不认 Range"的时候，其它几条还在闷头下整份内容，
  // 白耗带宽不说，退回单连接那一步还得跟它们抢带宽。
  const inflight = new Set()
  const stopAll = () => {
    for (const s of inflight) {
      try {
        s.destroy()
      } catch {
        /* 已经死了就算了 */
      }
    }
    inflight.clear()
  }

  /** 拉一段（含重试）。抛出的错里带 noRanges 就说明这个源不吃 Range */
  const pull = async (bound) => {
    let attempt = 0
    for (;;) {
      if (signal.aborted) throw new Error('已取消')
      const from = bound.from + bound.done
      if (from > bound.to) return

      let opened
      try {
        opened = await openStream(url, {
          signal,
          timeout: REQUEST_TIMEOUT,
          headers: { Range: `bytes=${from}-${bound.to}` }
        })
      } catch (error) {
        if (signal.aborted) throw error
        if (attempt++ >= MAX_ATTEMPTS) throw error
        await delay(RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)])
        continue
      }

      // 服务器把整份发过来了（200）→ 它不认 Range。别硬拼，退回单连接。
      if (opened.statusCode !== 206) {
        opened.stream.destroy()
        const noRange = new Error('这个源不支持分段下载（回了整份内容）')
        noRange.noRanges = true
        throw noRange
      }
      const range = parseContentRange(opened.headers && opened.headers['content-range'])
      if (!range || range.start !== from || (range.total && range.total !== size)) {
        opened.stream.destroy()
        const odd = new Error('这个源给的 Range 回应对不上，别拿它拼文件')
        odd.noRanges = true
        throw odd
      }

      try {
        inflight.add(opened.stream)
        await new Promise((resolve, reject) => {
          let settled = false
          const fail = (error) => {
            if (settled) return
            settled = true
            inflight.delete(opened.stream)
            opened.stream.destroy()
            reject(error)
          }
          opened.stream.on('error', fail)
          opened.stream.on('data', (chunk) => {
            if (settled) return
            let wrote = 0
            try {
              // 【必须看返回值】**POSIX 允许短写**（磁盘满、被信号打断）。
              // 不看返回值、直接按整块算 `done`，就会记多 —— 又是"侧车比数据多"那个形状。
              while (wrote < chunk.length) {
                const n = fs.writeSync(fd, chunk, wrote, chunk.length - wrote, bound.done + bound.from + wrote)
                if (!(n > 0)) throw new Error('写入短了且没有进展')
                wrote += n
              }
            } catch (error) {
              fail(error)
              return
            }
            bound.done += chunk.length
            bytes += chunk.length
            sinceSave += chunk.length
            if (onBytes) onBytes(chunk.length)
            saveProgress(false)
          })
          opened.stream.on('end', () => {
            if (settled) return
            settled = true
            inflight.delete(opened.stream)
            resolve()
          })
          opened.stream.on('aborted', () => fail(new Error('连接被掐断了')))
        })
      } catch (error) {
        if (signal.aborted) throw error
        if (attempt++ >= MAX_ATTEMPTS) throw error
        await delay(RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)])
        continue
      }

      // 这一段够了就收工；不够（连接提前断）就接着拉剩下那截
      if (bound.done > bound.to - bound.from) return
    }
  }

  try {
    await Promise.all(bounds.map((b) => pull(b)))
    // 每段都写满了才算数（末尾那段正好写到最后一个字节，文件大小就是 size）
    if (fs.fstatSync(fd).size !== size) {
      throw new Error(`分段下完了但文件大小不对（${fs.fstatSync(fd).size} 应该是 ${size}）`)
    }
    saveProgress(true)
  } catch (error) {
    stopAll()
    throw error
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* 关不上就算了 */
    }
  }

  return { bytes }
}

/**
 * 下载一个文件，把内容写进 saveTo。
 *
 * 会按 candidates 里的顺序逐个尝试（当前偏向的源排第一个），
 * 每个源都试 MAX_ATTEMPTS 次。
 *
 * @returns {Promise<{bytes: number, usedMirror: boolean}>}
 */
async function downloadOneFile(file, { signal, preferMirror, onBytes, sourcePreference = 'auto', throttle }) {
  const mirrorUrl = mirror.toMirror(file.url)
  const partPath = `${file.saveTo}.part`

  fs.mkdirSync(path.dirname(file.saveTo), { recursive: true })

  // 当前偏向的源排第一，另一个排第二。
  // 这样"偏向的那个不行"时能立刻换另一个，不用等重试。
  //
  // "官方那条路"可能有两个域名（见 mirror.js 的 officialFastPair）：
  // Modrinth 的 cdn-raw 国内实测比 cdn 快 300 倍。快的排前面、慢的垫后面当退路，
  // **两个都是官方的**，所以跟"只用官方"的设置不冲突。
  const official = mirror.officialFastPair(file.url)
  const candidates = []
  if (preferMirror && mirrorUrl) candidates.push({ url: mirrorUrl, isMirror: true })
  candidates.push({ url: official ? official.fast : file.url, isMirror: false })
  if (official && official.slow && official.slow !== official.fast) {
    candidates.push({ url: official.slow, isMirror: false })
  }
  // 用户选了"只用官方"就绝不碰镜像（设置里写的明白，不能偷着用）
  if (!preferMirror && mirrorUrl && sourcePreference !== 'official') {
    candidates.push({ url: mirrorUrl, isMirror: true })
  }

  let lastError = null

  for (const candidate of candidates) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) throw new Error('已取消')

      try {
        // ——— 断点续传（M23）：看看上次是不是留了半截在这 ———
        //
        // 【为什么要这么做】几百 MB 的整合包，网一抖就得从头下——
        // 这是用户最容易骂人的地方（"下了三回了"）。
        // 只要服务器支持 Range（Mojang 和 Modrinth 的 CDN 都支持），
        // 就能从断的地方接着下。
        //
        // 【为什么半截文件是安全的】我们**只认 `.part` 这个名字**，
        // 下完还要校验 sha1 才改名成正式文件。所以半截文件永远不会被
        // 当成"已经下好了"（判断那个走的是 file.saveTo，不是这里）。
        // ——— 这次分段还是单连接（M30）———
        // （没 sha1 的不分段：理由见文件上方第 4 条规矩）
        const wantSegments = throttle || !file.sha1 ? 1 : segmentCountFor(file.size)
        // 本该分段却没分 → 留个痕（不然"怎么变慢了"要重查一遍）
        if (wantSegments === 1 && segmentCountFor(file.size) > 1) {
          if (!file.sha1) {
            segmentationSkips.noHash++
            console.log(
              `[下载] ${file.name || path.basename(file.saveTo)}（${(file.size / 1048576).toFixed(1)} MB）` +
              '清单里没给哈希，为安全走单连接，会慢一些'
            )
          } else if (throttle) {
            segmentationSkips.throttled++
          }
        }
        const sidecarPath = segmentSidecar(partPath)

        // 【分段留下的半截，这次不分段了就整份清掉】分段是把各段按偏移写进**同一个**
        // `.part`（稀疏文件），光看它的大小会以为"下了很多"，其实中间全是洞。
        // 拿那个大小去单连接续传（`Range: bytes=<洞的位置>`）只会拼出一个坏文件。
        // 侧车（`.seg`）就是用来分辨这种情况的：**有侧车但这次不分段 → 两份一起删**。
        if (wantSegments === 1 && fs.existsSync(sidecarPath)) {
          try {
            fs.unlinkSync(partPath)
          } catch {
            /* 本来就不在 */
          }
          try {
            fs.unlinkSync(sidecarPath)
          } catch {
            /* 本来就不在 */
          }
        }

        let offset = 0
        // 【分段时不看 `.part` 的大小】**分段自己**按侧车记的进度续传（见 segmentedToFile）；
        // 它写的是稀疏文件，那个大小不能当成"下到哪儿了"。
        if (wantSegments === 1) {
          try {
            const partInfo = fs.statSync(partPath)

            // 已经不比目标小了 → 这份半截没用（可能服务器换过文件），重来
            if (partInfo.size > 0 && (!file.size || partInfo.size < file.size)) {
              // 太老的半截别要了：用户可能早就换了版本、或者干脆不下了。
              // 【为什么要有这条】半截文件是**跨会话**留着的，没人管就会一直堆着——
              // 断过几次网之后，游戏目录里躺着好几个 GB 的 .part，
              // 而且用户完全不知道它们是什么。超过 7 天的一律扔掉。
              if (Date.now() - partInfo.mtimeMs > STALE_PART_MS) {
                fs.unlinkSync(partPath)
              } else {
                offset = partInfo.size
              }
            } else if (partInfo.size > 0) {
              fs.unlinkSync(partPath)
            }
          } catch {
            // 没有半截文件，从头下
          }
        }

        let bytes = 0
        const report = (n, isResume) => {
          bytes += n
          onBytes(n, isResume)
        }

        if (wantSegments > 1) {
          try {
            const done = await withSegmentSlot(() =>
              segmentedToFile(candidate.url, partPath, {
                signal,
                onBytes: report,
                size: file.size,
                segments: wantSegments
              })
            )
            bytes = done.bytes
          } catch (error) {
            // 这个源不吃 Range（回了整份内容）→ **不消耗重试**，就地退回单连接重来一遍
            if (error && error.noRanges && !signal.aborted) {
              try {
                fs.unlinkSync(partPath)
              } catch {
                /* 本来就不在 */
              }
              try {
                fs.unlinkSync(sidecarPath)
              } catch {
                /* 本来就不在 */
              }
              bytes = 0
              await streamToFile(candidate.url, partPath, { signal, throttle, offset: 0, onBytes: report })
            } else {
              throw error
            }
          }
        } else {
          await streamToFile(candidate.url, partPath, { signal, throttle, offset, onBytes: report })
        }

        // —— 校验 ——
        if (file.sha1) {
          const actual = await sha1OfFile(partPath)
          if (actual !== file.sha1) {
            // 标一下：**内容本身不对**，那份半截没有续传价值，必须删掉重来
            const bad = new Error('内容校验不通过（可能没下完，或者被拦截替换了）')
            bad.checksumFailed = true
            throw bad
          }
        }

        // 到这一步才改名成正式文件——见文件开头的设计要点 1
        fs.renameSync(partPath, file.saveTo)
        // 侧车（分段用的进度小文件）跟着一起清掉，别在游戏目录里留垃圾
        try {
          fs.unlinkSync(sidecarPath)
        } catch {
          /* 没分段的话本来就没有 */
        }
        return { bytes, usedMirror: candidate.isMirror }
      } catch (error) {
        lastError = error

        // ——— 半截文件留还是删（M23）———
        //
        // · 校验不过：这份内容是坏的，留着只会一直坏 → 删
        // · 用户主动取消：他不要了 → 删
        // · 网络断了/超时：**留着**，下次（哪怕重启了启动器）能接着下
        //
        // 【为什么以前一律删】那时候没有续传，留着半截等于占着几百 MB 没用，
        // 而且"下次下的时候又从头写一遍"。现在留着才有价值。
        const keepPart = !signal.aborted && !error.checksumFailed
        if (!keepPart) {
          try {
            fs.unlinkSync(partPath)
          } catch {
            /* 本来就不在就算了 */
          }
          // 【侧车必须跟着半截一起走】侧车还在、`.part` 没了的话，下次分段续传
          // 会以为"那几段都下好了"，拼出一个中间全是洞的文件（大小检查会拦下，
          // 但白折腾一轮）。所以两份永远同生共死。
          try {
            fs.unlinkSync(segmentSidecar(partPath))
          } catch {
            /* 没分段的话本来就没有 */
          }
        }

        if (signal.aborted) throw error

        await delay(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)])
      }
    }
  }

  throw lastError ?? new Error('下载失败')
}

// ——————————————————————————————————————————————
// 任务
// ——————————————————————————————————————————————

/**
 * 建一个下载任务。
 *
 * @param {Array<{url: string, saveTo: string, sha1?: string, size?: number, name?: string}>} files
 * @param {{concurrency?: number, onProgress?: Function}} options
 * @returns 控制器：{ start, pause, cancel, getStats }
 */
function createTask(files, options = {}) {
  // 并发数：调用方说了算；没说就按设置里的（默认 16），最后兜底成 16。
  // 【注意别写成 Number.isFinite(concurrency)——那是在声明之前引用自己，
  //   会抛 TDZ 错误，而且一抛就是"所有下载全挂"。实测踩过。】
  const asked = Number.isFinite(options.concurrency)
    ? options.concurrency
    : settings.downloadConcurrency()
  const concurrency = Math.min(32, Math.max(1, asked || DEFAULT_CONCURRENCY))

  // 限速（0 = 不限）
  const throttle = createThrottle(settings.downloadSpeedLimitKB())

  const { onProgress } = options

  const list = files.slice()
  const totalBytes = list.reduce((sum, f) => sum + (f.size || 0), 0)

  const controller = new AbortController()

  let paused = false
  let finished = false
  let cancelled = false

  let doneCount = 0
  let skippedCount = 0
  let failedCount = 0
  let doneBytes = 0
  let currentBytes = 0

  const failures = []
  const speed = createSpeedMeter()

  /**
   * 用户选的下载源偏好（设置里能改）：
   *   auto      优先官方，太慢自动换镜像（默认）
   *   mirror    直接优先镜像，镜像不行再回官方
   *   official  只用官方，绝不碰镜像
   */
  const sourcePreference = settings.downloadSource()
  /**
   * 这次任务真下下来（不是跳过）的文件。
   * "取消安装 + 全部删掉"要用它——但删之前必须核对别的版本还在不在用它，
   * 所以这里只记录"下过"，删不删由调用方判断。
   */
  const downloaded = []

  /** 当前偏向哪个源。会在两个源之间来回切换，不会卡死在某一边 */
  let preferMirror = sourcePreference === 'mirror'
  /** 连续几次"当前偏向的源不行" */
  let badStreak = 0

  let lastReportAt = 0

  /**
   * 此刻"正在下"的那几个文件（M23：进度条上要写"正在下载 xxx.jar"）。
   * 用 saveTo 当 key——同一个文件不会被两个工人同时下，但同名不同目录的会有，
   * 所以不能拿文件名当 key。
   */
  const activeFiles = new Map()

  /** 从路径里取出文件名（进度条上只显示文件名，整条路径太长） */
  function baseNameOf(filePath) {
    return String(filePath || '').split(/[\\/]/).pop() || ''
  }

  function stats() {
    const received = Math.min(doneBytes + currentBytes, totalBytes || Number.MAX_SAFE_INTEGER)
    const perSecond = speed.speed()

    return {
      total: list.length,
      done: doneCount,
      skipped: skippedCount,
      failed: failedCount,
      remaining: list.length - doneCount - failedCount,
      // 【只有一个文件时按字节算】下 Mod / 整合包就是"一个文件"，
      // 按"下完了几个文件"算的话，一个 96 MB 的整合包全程显示 0%，
      // 最后突然跳到 100%——看着就像卡死了（实测：6 秒下完，进度条纹丝不动）
      percent:
        list.length > 1
          ? Math.round((doneCount / list.length) * 100)
          : totalBytes > 0
            ? Math.min(100, Math.round((received / totalBytes) * 100))
            : doneCount > 0
              ? 100
              : 0,
      totalBytes,
      receivedBytes: received,
      speed: perSecond,
      // 剩余时间（毫秒）。速度太低时算不出来，返回 0 让界面显示"—"
      etaMs: perSecond > 1024 ? Math.max(0, ((totalBytes - received) / perSecond) * 1000) : 0,
      usingMirror: preferMirror,
      // 正在下的文件名（按开始先后）。并发高时可能有好几个，界面只显示头一两个
      currentFiles: [...activeFiles.values()],
      failures: failures.slice()
    }
  }

  function report(force = false) {
    const now = Date.now()
    if (!force && now - lastReportAt < 250) return
    lastReportAt = now
    if (onProgress) onProgress(stats())
  }

  /**
   * 一个文件下完之后，更新"哪个源更好"的判断。
   *
   * 两个信号会让 badStreak 加一：
   *   · 用了备用源才下成（说明偏向的那个不行）—— 权重更高，直接算一次
   *   · 大文件但速度太慢（小文件不参与判断，见上面那段说明）
   * 连续 BAD_STREAK_TO_SWITCH 次就换边。换边是双向的，
   * 所以不存在"永久卡在某个坏源上"。
   */
  function updateSourcePreference({ usedFallback, size, bytes, elapsedMs }) {
    // 用户选了"只用官方"，就不做任何换源——设置里怎么写的就怎么做
    if (sourcePreference === 'official') return

    let bad = false

    if (usedFallback) {
      bad = true
    } else if (size && size >= MIN_SIZE_FOR_SPEED_JUDGING && elapsedMs > 0) {
      if (bytes / (elapsedMs / 1000) < BAD_SPEED) bad = true
    }

    if (bad) {
      badStreak++
      if (badStreak >= BAD_STREAK_TO_SWITCH) {
        preferMirror = !preferMirror
        badStreak = 0
      }
    } else {
      badStreak = 0
    }
  }

  /** 一个工人：不停地从队列里拿文件下，直到队列空了或者被叫停 */
  async function worker(queue) {
    while (true) {
      if (cancelled || paused) return

      const file = queue.shift()
      if (!file) return

      try {
        // —— 已经下好且校验通过的，直接跳过 ——
        if (await existingFileIsGood(file)) {
          doneCount++
          skippedCount++
          doneBytes += file.size || 0
          report()
          continue
        }

        const startedAt = Date.now()
        const wanted = preferMirror
        activeFiles.set(file.saveTo, baseNameOf(file.saveTo))
        report(true)

        let result
        try {
          result = await downloadOneFile(file, {
            signal: controller.signal,
            preferMirror,
            sourcePreference,
            throttle,
            // isResume=true 的是"上次已经下好的那部分"，只算进进度、
            // **不算进速度**——不然续传一开始会显示一个离谱的速度
            onBytes: (n, isResume) => {
              currentBytes += n
              if (!isResume) speed.add(n)
              report()
            }
          })
        } finally {
          // 不管下成没下成，都从"正在下"里划掉
          activeFiles.delete(file.saveTo)
        }

        // 这个文件已经下完，把它计入总量，并从"正在下"里扣掉。
        //
        // 注意这里加的是"清单里声明的大小"而不是"实际下了多少字节"：
        // 进度条的分母 `totalBytes` 也是按声明大小累加的，
        // 两边必须用同一个口径，否则下完最后一个文件时进度会停在
        // "619/686MB" 这种看着像没下完的数字上（实际是账算岔了）。
        currentBytes = Math.max(0, currentBytes - result.bytes)
        doneBytes += file.size || result.bytes
        doneCount++
        downloaded.push({ path: file.saveTo, size: file.size || result.bytes })

        updateSourcePreference({
          usedFallback: result.usedMirror !== wanted,
          size: file.size || result.bytes,
          bytes: result.bytes,
          elapsedMs: Date.now() - startedAt
        })

        report(true)
      } catch (error) {
        if (cancelled) return
        failedCount++
        failures.push({ file, error: String(error?.message ?? error) })
        report(true)
      }
    }
  }

  return {
    /** 开始下载。重复调用无效 */
    async start() {
      if (finished) return stats()
      paused = false

      const queue = list.slice()
      const workers = []
      for (let i = 0; i < Math.max(1, concurrency); i++) {
        workers.push(worker(queue))
      }
      await Promise.all(workers)

      finished = true
      report(true)
      return stats()
    },

    /** 暂停：已经在下头的几个会下完，但不再开始新的 */
    pause() {
      paused = true
    },

    resume() {
      paused = false
    },

    /** 取消：正在下的立刻掐断 */
    cancel() {
      cancelled = true
      paused = true
      controller.abort()
    },

    getStats: stats,

    /** 这次真下下来的文件（跳过的不算）。取消安装时要按它来清理 */
    getDownloaded: () => downloaded.slice()
  }
}

module.exports = {
  createTask,
  segmentSkipStats,
  sha1OfFile,
  existingFileIsGood,
  DEFAULT_CONCURRENCY,
  MIN_SIZE_FOR_SPEED_JUDGING,
  BAD_SPEED,
  BAD_STREAK_TO_SWITCH
}

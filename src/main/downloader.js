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

/** 同时下几个文件。8 是个平衡点：再多人家的服务器可能限速，再少下得慢 */
const DEFAULT_CONCURRENCY = 8

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
function streamToFile(url, dest, { signal, onBytes, throttle }) {
  return openStream(url, { signal, timeout: REQUEST_TIMEOUT }).then(
    ({ stream }) =>
      new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest)
        let settled = false

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
  if (official && official.slow !== official.fast) {
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
        let bytes = 0
        await streamToFile(candidate.url, partPath, {
          signal,
          throttle,
          onBytes: (n) => {
            bytes += n
            onBytes(n)
          }
        })

        // —— 校验 ——
        if (file.sha1) {
          const actual = await sha1OfFile(partPath)
          if (actual !== file.sha1) {
            throw new Error('内容校验不通过（可能没下完，或者被拦截替换了）')
          }
        }

        // 到这一步才改名成正式文件——见文件开头的设计要点 1
        fs.renameSync(partPath, file.saveTo)
        return { bytes, usedMirror: candidate.isMirror }
      } catch (error) {
        lastError = error

        // 临时的半截文件必须删掉，否则下次会被误判成"已下好"
        try {
          fs.unlinkSync(partPath)
        } catch {
          /* 本来就不在就算了 */
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
  // 并发数：调用方说了算；没说就按设置里的（默认 8），最后兜底成 8。
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
        const result = await downloadOneFile(file, {
          signal: controller.signal,
          preferMirror,
          sourcePreference,
          throttle,
          onBytes: (n) => {
            currentBytes += n
            speed.add(n)
            report()
          }
        })

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
  sha1OfFile,
  existingFileIsGood,
  DEFAULT_CONCURRENCY,
  MIN_SIZE_FOR_SPEED_JUDGING,
  BAD_SPEED,
  BAD_STREAK_TO_SWITCH
}

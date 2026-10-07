// MC启动器 — 启动游戏
//
// 这是整个启动器"最后的临门一脚"：把前面几个里程碑装好的东西
// （客户端 jar、库文件、资源文件、Java 运行时）拼成一条命令，把游戏跑起来。
//
// 干四件事：
//   ① 拼启动参数：版本 JSON 里有 arguments.jvm / arguments.game 两份清单，
//      里面写着 ${auth_player_name} 这类占位符，逐个替换成本机的真值
//   ② 起 Java 进程，把游戏输出抓回来
//   ③ 出错时把一堆英文翻译成"人话"（R3.4）
//   ④ 管生命周期：同一时间只允许跑一个游戏，退出了要告诉界面
//
// 【一条铁律：启动参数是"数据"，不是"代码"】
// 不同版本、不同 Mod 加载器的参数差别很大，所以全部照版本 JSON 里写的来。
// 我们只负责替换占位符、套上本机路径，**不自己发明参数**——
// 自作聪明加参数是启动器最常见的翻车方式。
//
// 当前进度：M5。

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { TextDecoder } = require('node:util')

const paths = require('./paths')
const settings = require('./settings')
const accounts = require('./accounts')
const javaUtil = require('./java')
const install = require('./install')
const downloader = require('./downloader')

const LAUNCHER_NAME = 'MC启动器'
const LAUNCHER_VERSION = '0.1.0'

/** 日志最多留多少行给界面显示（再多界面也看不过来） */
const MAX_LOG_LINES = 600

/** 当前正在跑的游戏。null = 没有 */
let current = null

/** 有没有游戏在跑 */
function isRunning() {
  return current !== null
}

// ——————————————————————————————————————————————
// 拼启动参数
// ——————————————————————————————————————————————

/**
 * 把 arguments 清单里符合当前系统的项摊平成字符串数组。
 * 每一项要么直接是一个字符串，要么是 { rules: [...], value: ... }——
 * 后者要先过规则判断（比如 osx 专用的参数在 Windows 上就不加）。
 */
function flattenArguments(entries, ctx) {
  const out = []
  for (const entry of entries || []) {
    if (typeof entry === 'string') {
      out.push(entry)
      continue
    }
    if (!entry || !install.rulesAllow(entry.rules, ctx)) continue
    if (Array.isArray(entry.value)) out.push(...entry.value)
    else if (typeof entry.value === 'string') out.push(entry.value)
  }
  return out
}

/** 做替换用的函数：把 ${xxx} 换成真值。遇到不认识的占位符记下来（写进日志备查） */
function makeSubstituter(values, unknown) {
  return (text) =>
    String(text).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) => {
      if (Object.prototype.hasOwnProperty.call(values, key)) return values[key]
      unknown.add(key)
      return ''
    })
}

/**
 * 算出完整的启动命令。
 *
 * @returns {{jvmArgs: string[], gameArgs: string[], classpath: string,
 *            nativesDir: string, assetsIndex: string,
 *            missing: string[], unknown: string[]}}
 */
function buildCommand(versionId, versionJson, { account, memoryMB, logConfigPath }) {
  const ctx = install.buildContext()
  const nativesDir = paths.versionNativesDir(versionId)
  const missing = []
  const unknown = new Set()

  // ——— classpath：所有符合当前系统的库文件 + 客户端 jar（放最后） ———
  const cpFiles = []
  for (const lib of versionJson.libraries || []) {
    if (!install.rulesAllow(lib.rules, ctx)) continue
    const artifact = lib.downloads && lib.downloads.artifact
    if (!artifact || !artifact.path) continue

    const file = path.join(paths.librariesDir(), artifact.path)
    cpFiles.push(file)
    if (!fs.existsSync(file)) missing.push(artifact.path)
  }

  const clientJar = paths.versionJarFile(versionId)
  cpFiles.push(clientJar)
  if (!fs.existsSync(clientJar)) missing.push(`${versionId}.jar`)

  const classpath = cpFiles.join(path.delimiter)
  const assetsIndex =
    (versionJson.assetIndex && versionJson.assetIndex.id) || versionJson.assets || ''

  // ——— 占位符对照表 ———
  // 离线模式的取值见 docs/02 的"决策 5"：UUID 用离线算法算，
  // accessToken 随便给一个——单机游戏根本不校验它。
  const values = {
    auth_player_name: account.name,
    auth_uuid: account.uuid,
    auth_access_token: '0',
    clientid: '',
    auth_xuid: '',
    user_type: 'legacy',

    version_name: versionId,
    version_type: versionJson.type || 'release',

    game_directory: paths.gameDir(),
    assets_root: paths.assetsDir(),
    assets_index_name: String(assetsIndex),
    // 远古版本（1.7 以前）的资源目录，现在用不到，留着以防万一
    game_assets: path.join(paths.assetsDir(), 'virtual', String(assetsIndex)),

    natives_directory: nativesDir,
    library_directory: paths.librariesDir(),
    classpath,
    classpath_separator: path.delimiter,

    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,

    // 下面这些只有开了对应的"特性开关"才会用到，我们不开，
    // 但占位符先备着，免得被替换成空白
    resolution_width: '854',
    resolution_height: '480',
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: '',
    quickPlayRealms: ''
  }
  const substitute = makeSubstituter(values, unknown)

  const jvmArgs = []
  const gameArgs = []

  if (versionJson.arguments) {
    jvmArgs.push(...flattenArguments(versionJson.arguments.jvm, ctx))
    gameArgs.push(...flattenArguments(versionJson.arguments.game, ctx))
  } else if (versionJson.minecraftArguments) {
    // 远古版本（1.6 以前）只有一个平铺的参数串，jvm 那半边要自己补
    gameArgs.push(...versionJson.minecraftArguments.split(/\s+/).filter(Boolean))
    jvmArgs.push(`-Djava.library.path=${nativesDir}`, '-cp', classpath)
  }

  // ——— 日志配置 ———
  // 版本 JSON 里给了一条 -Dlog4j.configurationFile=…，把配置文件路径填进去。
  // 文件没下到就不加这条参数——游戏会用默认日志设置，不影响能不能玩。
  const logging = versionJson.logging && versionJson.logging.client
  if (logging && logging.argument && logConfigPath) {
    jvmArgs.push(logging.argument.replace(/\$\{path\}/g, logConfigPath))
  }

  // ——— 内存 ———
  // 版本 JSON 里不写内存，是启动器自己加的（官方启动器也这么干）
  const finalJvm = [`-Xmx${memoryMB}M`, ...jvmArgs].map(substitute)
  const finalGame = gameArgs.map(substitute)

  return {
    jvmArgs: finalJvm,
    gameArgs: finalGame,
    classpath,
    nativesDir,
    assetsIndex: String(assetsIndex),
    missing,
    unknown: [...unknown]
  }
}

// ——————————————————————————————————————————————
// natives（游戏的动态库）
// ——————————————————————————————————————————————

/**
 * 把 natives 目录准备好。
 *
 * 分两种情况：
 *   · 新版本（1.19+）：动态库压缩包直接进了 classpath，由游戏自己在运行时
 *     解压到 natives 下的 java / jna / lwjgl / netty 四个子目录里
 *     （参数里写死的）。我们只要把这几个目录先建好就行。
 *   · 老版本：动态库是单独的压缩包（classifiers），得提前解压到 natives 根目录。
 */
function prepareNatives(versionId, versionJson) {
  const dir = paths.versionNativesDir(versionId)
  paths.ensureDir(dir)

  for (const sub of ['java', 'jna', 'lwjgl', 'netty']) {
    paths.ensureDir(path.join(dir, sub))
  }

  const natives = install.collectClassifierNatives(versionJson, install.buildContext())
  if (natives.length === 0) return

  // 已经解过就不用再解（判断标准：目录里已经有动态库文件）
  let extracted = false
  try {
    extracted = fs.readdirSync(dir).some((name) => /\.(dll|so|dylib)$/i.test(name))
  } catch {
    extracted = false
  }
  if (!extracted) install.extractNatives(versionId, natives)
}

/**
 * 把 log4j 的日志配置文件补下来（M4 安装清单里漏了它）。
 * 很小，一千多字节。下不到不算致命，返回 null 让调用方跳过这条参数。
 */
async function ensureLogConfig(versionJson) {
  const entry = versionJson.logging && versionJson.logging.client
  if (!entry || !entry.file || !entry.file.url) return null

  const dest = paths.logConfigFile(entry.file.id)
  if (fs.existsSync(dest)) return dest

  try {
    const task = downloader.createTask([
      {
        name: entry.file.id,
        url: entry.file.url,
        saveTo: dest,
        sha1: entry.file.sha1,
        size: entry.file.size
      }
    ])
    const stats = await task.start()
    if (stats.failed > 0) return null
    return dest
  } catch {
    return null
  }
}

// ——————————————————————————————————————————————
// 游戏语言：第一次启动时帮设成中文（R3.5）
// ——————————————————————————————————————————————

/**
 * 第一次启动时，把游戏语言设成简体中文。
 *
 * 【为什么要做】游戏装好默认是英文（options.txt 里写的 lang:en_us），
 * 对国内用户来说第一步就是一道坎。实测时用户当场就问了"英文的？"
 *
 * 【为什么只做一次】语言是用户的个人偏好，他完全可能特意改成英文。
 * 所以只在"他还没表过态"的时候设一次，设完在配置里记一笔，
 * **以后再也不碰 options.txt**——绝不和用户对着干。
 *
 * 【改的是哪个文件】游戏目录下的 options.txt（游戏自己的设置文件），
 * 只动 lang: 那一行，其他设置原样保留；先写临时文件再改名，中途断电不会写坏。
 */
function ensureGameLanguage(log) {
  const config = settings.readConfig()
  if (config.launch.languageApplied) return

  const file = paths.gameOptionsFile()

  try {
    const exists = fs.existsSync(file)
    const text = exists ? fs.readFileSync(file, 'utf8') : ''

    // 已经是中文了：不用改，只记一笔"这件事做过了"
    if (/^lang:zh_cn\s*$/m.test(text)) {
      settings.writeConfig({ launch: { languageApplied: true } })
      return
    }

    let next
    if (/^lang:/m.test(text)) {
      next = text.replace(/^lang:.*$/m, 'lang:zh_cn')
    } else {
      // 文件不存在（游戏还没启动过），或者里面压根没有语言行 → 补一行
      next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}lang:zh_cn\n`
    }

    const temp = `${file}.tmp`
    paths.ensureDir(paths.gameDir())
    fs.writeFileSync(temp, next, 'utf8')
    fs.renameSync(temp, file)

    settings.writeConfig({ launch: { languageApplied: true } })
    if (log) log.line('[启动器] 第一次启动，已把游戏语言设成简体中文（你以后自己改了，就不会再动它）')
  } catch (error) {
    // 设不上不该拦着玩游戏，记一笔就算了
    if (log) log.line(`[启动器] 想把游戏语言设成中文，但没成功：${error.message}`)
  }
}

// ——————————————————————————————————————————————
// 抓日志
// ——————————————————————————————————————————————

// 游戏输出的编码：新版本（Java 18+）是 UTF-8；很老的版本可能是系统默认的 GBK。
// 先按 UTF-8 解，解出一堆"�"（看不懂的替换符）就换 GBK 再解一遍。
const utf8Decoder = new TextDecoder('utf-8')
let gbkDecoder = null
try {
  gbkDecoder = new TextDecoder('gbk')
} catch {
  // 万一环境不支持 GBK，就只能用 UTF-8 了
}

function decodeLine(buffer) {
  const text = utf8Decoder.decode(buffer)
  if (text.includes('�') && gbkDecoder) {
    try {
      return gbkDecoder.decode(buffer)
    } catch {
      return text
    }
  }
  return text
}

/**
 * 日志收集器：
 *   · 留最近 MAX_LOG_LINES 行在内存里（退出时分析用）
 *   · 攒一批发给界面（一条一条发的话消息太多了）
 *   · 同时把完整日志写进启动器目录的 logs\ 里，留作排查
 */
function createLogCollector({ onLog, logFile }) {
  const lines = []
  let pending = []
  let flushTimer = null
  const out = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null
  if (out) out.on('error', () => {})

  function flush() {
    if (pending.length === 0) return
    const batch = pending
    pending = []
    if (onLog) {
      try {
        onLog(batch)
      } catch {
        // 界面那边出了问题不该影响游戏
      }
    }
  }

  function line(text) {
    lines.push(text)
    if (lines.length > MAX_LOG_LINES) lines.shift()

    pending.push(text)
    if (out) out.write(`${text}\n`)

    if (pending.length >= 50) flush()
    else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        flush()
      }, 250)
    }
  }

  return {
    line,
    finish() {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      flush()
      if (out) out.end()
    },
    recent: (n) => lines.slice(-n)
  }
}

/** 把游戏进程的一条输出流接到日志收集器上（按行拆） */
function attachStream(stream, log) {
  let pending = Buffer.alloc(0)

  stream.on('data', (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk

    let at
    while ((at = pending.indexOf(0x0a)) >= 0) {
      let raw = pending.subarray(0, at)
      pending = pending.subarray(at + 1)
      if (raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1)
      log.line(decodeLine(raw))
    }

    // 万一一整行特别长又不换行，不能让它把内存撑爆
    if (pending.length > 64 * 1024) {
      log.line(decodeLine(pending))
      pending = Buffer.alloc(0)
    }
  })

  stream.on('end', () => {
    if (pending.length > 0) {
      log.line(decodeLine(pending))
      pending = Buffer.alloc(0)
    }
  })
  stream.on('error', () => {})
}

// ——————————————————————————————————————————————
// 报错翻译（R3.4：把一堆英文翻译成人话）
// ——————————————————————————————————————————————

/**
 * 日志里出现这些词，说明是什么问题。
 *
 * strong = true 的规则"正常退出（退出码 0）"时也查——这类词出现就是真出事了。
 * 没标的只在异常退出时才查：像 OpenGL 这种词，游戏正常运行时日志里到处都是，
 * 拿它判断"显卡坏了"会天天误报。
 */
const LOG_PATTERNS = [
  {
    strong: true,
    test: /OutOfMemoryError|Java heap space/i,
    title: '游戏内存不够，退出了',
    hint: '给游戏分配的内存太少了。等 M6 的设置页做好就能直接调，现在先把这个情况告诉开发者。'
  },
  {
    strong: true,
    test: /UnsupportedClassVersionError|class file version/i,
    title: 'Java 版本不对',
    hint: '这个版本需要的 Java 和实际用的对不上。到「下载」页对着这个版本点「重装」可以补下正确的 Java。'
  },
  {
    strong: true,
    test: /Could not find or load main class|NoClassDefFoundError|ClassNotFoundException/i,
    title: '游戏文件缺失或者坏掉了',
    hint: '到「下载」页对着这个版本点「重装」，缺的文件会自动补上（已经下好的不会重下）。'
  },
  {
    strong: true,
    test: /The game crashed whilst/i,
    title: '游戏自己崩了',
    hint: '游戏在 游戏目录\\crash-reports\\ 里写了崩溃报告，里面有详细原因。'
  },
  {
    test: /Pixel format not accelerated|Failed to create window|WGL/i,
    title: '显卡这边出了问题',
    hint: '先更新一下显卡驱动再试。如果是很老的电脑，可能跑不动新版本的游戏。'
  },
  {
    test: /Address already in use|Failed to bind to port/i,
    title: '端口被占用了',
    hint: '可能是上一个游戏没退干净，等几秒钟再点一次「开始游戏」。'
  },
  {
    test: /Exception in thread "main"/i,
    title: '游戏自己崩了',
    hint: '游戏在 游戏目录\\crash-reports\\ 里写了崩溃报告，里面有详细原因。'
  }
]

/** Windows 上进程被系统"打死"时的退出码（写成十进制是因为 Node 报的就是十进制） */
const EXIT_CODES = {
  3221225477: { title: '程序崩了（内存出错了）', hint: '常见原因是显卡驱动老旧，或者内存条有问题。先更新显卡驱动试试。' },
  3221225725: { title: '程序崩了（栈溢出）', hint: '通常是某个 Mod 或组件的问题。' },
  3221226505: { title: '程序崩了（被系统强制结束）', hint: '常见于杀毒软件误拦，或者文件损坏。' }
}

/**
 * 游戏退出后，说清楚"为什么退的"。
 * @returns {{ok: boolean, title: string, hint: string}}
 */
function explainExit(code, recentLines) {
  const tail = recentLines.join('\n')
  const crashed = code !== 0

  for (const pattern of LOG_PATTERNS) {
    // 正常退出时只查"出现即出事"的那几条，见上面 LOG_PATTERNS 的说明
    if (!crashed && !pattern.strong) continue
    if (pattern.test.test(tail)) {
      return { ok: false, title: pattern.title, hint: pattern.hint }
    }
  }

  if (!crashed) {
    return { ok: true, title: '游戏正常退出了', hint: '' }
  }

  const known = EXIT_CODES[code]
  if (known) return { ok: false, ...known }

  return {
    ok: false,
    title: `游戏异常退出（退出码 ${code}）`,
    hint: '日志的最后几行就在下面，游戏目录里的 logs\\latest.log 有完整记录。'
  }
}

// ——————————————————————————————————————————————
// 入口
// ——————————————————————————————————————————————

/**
 * 启动游戏。
 *
 * @param {string} versionId 版本号
 * @param {{onLog?: (lines: string[]) => void, onState?: (payload: object) => void}} options
 * @returns {Promise<{ok: boolean, error?: string, versionId?: string,
 *                    pid?: number, java?: object, memoryMB?: number, logFile?: string}>}
 */
async function launch(versionId, options = {}) {
  const { onLog, onState } = options
  const state = (payload) => {
    try {
      if (onState) onState(payload)
    } catch {
      // 界面那边出问题不该影响游戏
    }
  }

  if (current) return { ok: false, error: '游戏已经在运行了' }

  // ——— ① 账号 ———
  const account = accounts.getAccount()
  if (!account) return { ok: false, error: '先在左边填一个游戏名字，再点「开始游戏」' }

  // ——— ② 版本文件 ———
  const jsonFile = paths.versionJsonFile(versionId)
  if (!fs.existsSync(jsonFile)) {
    return { ok: false, error: `找不到 ${versionId} 的版本文件。到「下载」页重新安装一次这个版本。` }
  }

  let versionJson
  try {
    versionJson = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
  } catch {
    return { ok: false, error: `${versionId} 的版本文件读不出来（可能坏了）。到「下载」页重新安装一次。` }
  }

  if (versionJson.inheritsFrom) {
    return { ok: false, error: '这个版本装了 Mod 加载器，暂时还启动不了，先玩纯原版' }
  }

  // ——— ③ 内存 ———
  const memoryMB = settings.currentMemoryMB()
  const memoryCheck = settings.validateMemoryMB(memoryMB)
  if (!memoryCheck.ok) return { ok: false, error: memoryCheck.error }

  // ——— ④ Java ———
  const javaExe = javaUtil.findJava(versionJson)
  if (!javaExe) {
    return {
      ok: false,
      error: '找不到这个版本需要的 Java。到「下载」页对着这个版本点「重装」，会自动把 Java 也下好。'
    }
  }

  const probe = javaUtil.probeJava(javaExe.path)
  if (!probe.ok) {
    return { ok: false, error: `找到了 Java，但它跑不起来（${javaExe.path}）：${probe.error}` }
  }

  // 版本要求的大版本对不上时只提醒、不拦——有些版本差一点也能跑
  const wantedMajor = versionJson.javaVersion && versionJson.javaVersion.majorVersion
  const javaWarning =
    wantedMajor && probe.major && probe.major !== wantedMajor
      ? `注意：这个版本建议用 Java ${wantedMajor}，现在找到的是 Java ${probe.version}，可能会起不来。`
      : ''

  // ——— ⑤ 日志配置（很小，没有就补下；下不到不致命） ———
  const logConfigPath = await ensureLogConfig(versionJson)

  // ——— ⑥ 拼参数，并检查文件齐不齐 ———
  const command = buildCommand(versionId, versionJson, { account, memoryMB, logConfigPath })

  if (command.missing.length > 0) {
    const sample = command.missing.slice(0, 3).join('、')
    return {
      ok: false,
      error: `有 ${command.missing.length} 个游戏文件不在了（比如 ${sample}）。到「下载」页对着这个版本点「重装」，缺的会自动补上。`
    }
  }

  if (command.assetsIndex) {
    const indexFile = path.join(paths.assetsDir(), 'indexes', `${command.assetsIndex}.json`)
    if (!fs.existsSync(indexFile)) {
      return {
        ok: false,
        error: '游戏资源文件的索引不在了。到「下载」页对着这个版本点「重装」补齐。'
      }
    }
  }

  // ——— ⑦ natives 目录 ———
  prepareNatives(versionId, versionJson)

  // ——— ⑧ 起进程 ———
  const args = [...command.jvmArgs, versionJson.mainClass, ...command.gameArgs]

  paths.ensureDir(paths.logsDir())
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const logFile = path.join(paths.logsDir(), `launch-${stamp}.log`)

  const log = createLogCollector({ onLog, logFile })
  log.line(`[启动器] 版本 ${versionId} · Java ${probe.version}（${javaExe.source}）· 内存 ${memoryMB} MB`)
  log.line(`[启动器] 游戏目录：${paths.gameDir()}`)
  log.line(`[启动器] 完整日志会存到：${logFile}`)
  if (javaWarning) log.line(`[启动器] ${javaWarning}`)
  if (command.unknown.length > 0) {
    log.line(`[启动器] 这些启动参数不认识，已按空值处理：${command.unknown.join('、')}`)
  }

  // 第一次启动的话，把游戏语言设成中文（只做一次，见函数说明）
  ensureGameLanguage(log)

  let child
  try {
    child = spawn(javaExe.path, args, {
      cwd: paths.gameDir(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    log.line(`[启动器] 启动失败：${error.message}`)
    log.finish()
    return { ok: false, error: `游戏没能启动：${error.message}` }
  }

  current = { child, versionId, startedAt: Date.now(), logFile }

  // 把完整的命令行也写进日志——排查启动问题时，这条最有价值
  log.line(`[启动器] 命令：${javaExe.path} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`)

  attachStream(child.stdout, log)
  attachStream(child.stderr, log)

  let settled = false

  child.on('error', (error) => {
    if (settled) return
    settled = true
    current = null
    log.line(`[启动器] 进程起不来：${error.message}`)
    log.finish()
    state({ state: 'error', error: `游戏进程起不来：${error.message}`, logFile })
  })

  child.on('exit', (code, signal) => {
    if (settled) return
    settled = true
    current = null

    log.line(`[启动器] 游戏进程结束（退出码 ${code}${signal ? `，信号 ${signal}` : ''}）`)

    const explain = explainExit(code, log.recent(120))
    log.line(`[启动器] ${explain.title}${explain.hint ? `：${explain.hint}` : ''}`)
    log.finish()

    state({
      state: 'exited',
      code,
      signal: signal || '',
      ok: explain.ok,
      title: explain.title,
      hint: explain.hint,
      logFile
    })
  })

  state({
    state: 'running',
    versionId,
    pid: child.pid,
    java: { path: javaExe.path, version: probe.version, source: javaExe.source },
    memoryMB,
    logFile
  })

  return {
    ok: true,
    versionId,
    pid: child.pid,
    java: { path: javaExe.path, version: probe.version, source: javaExe.source },
    memoryMB,
    logFile
  }
}

module.exports = { launch, isRunning, buildCommand, explainExit, ensureGameLanguage }

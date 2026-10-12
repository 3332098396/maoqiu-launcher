// 毛球 — 启动游戏
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
const inherit = require('./inherit')
const authlibUtil = require('./authlib')
const microsoft = require('./microsoft')

const LAUNCHER_NAME = '毛球'
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

/**
 * 把游戏参数里"管窗口大小的那几条"就地删掉（M23）。
 *
 * 要删的三种写法：
 *   `--width 1280` / `--width=1280`
 *   `--height 720` / `--height=720`
 *   `--fullscreen`
 *
 * 【为什么要连值一起删】`--width` 和它的数字是**两个**数组项，
 * 只删掉 `--width` 会剩下一个孤零零的 `1280`——游戏会把它当成
 * "要打开的世界名"之类的东西，行为很怪（而且完全不报错）。
 * 所以看到 `--width` 必须顺手把后面那个数字也吞掉。
 */
function stripWindowArgs(gameArgs) {
  const drop = new Set(['--width', '--height'])
  for (let i = 0; i < gameArgs.length; i++) {
    const arg = String(gameArgs[i] || '')

    if (arg === '--fullscreen') {
      gameArgs.splice(i, 1)
      i--
      continue
    }

    // `--width=1280` 这种连在一起的写法
    if (/^--(width|height)=/.test(arg)) {
      gameArgs.splice(i, 1)
      i--
      continue
    }

    // `--width` `1280` 这种分成两项的写法
    if (drop.has(arg)) {
      gameArgs.splice(i, 1)
      // 后面紧跟的那个数字也一起删
      const next = String(gameArgs[i] ?? '')
      if (/^-?\d+$/.test(next)) gameArgs.splice(i, 1)
      i--
    }
  }
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
 * 这个版本这次启动时，"游戏目录"在哪。
 *
 * 开了版本隔离 → 每个版本用自己的目录（versions\<版本号>\），
 * 存档、Mod、设置都放在里面，各版本互不干扰；
 * 关着 → 大家都用游戏目录本身，共用一套。
 *
 * 注意：这个目录会作为 --gameDir 传给游戏，游戏在哪儿建 saves、logs、
 * options.txt 全看它，所以下面所有跟"游戏目录"有关的地方都得用它，
 * 不能直接用 paths.gameDir()
 *
 * 【M11.4：一定要带上 dir】这个版本的库文件、资源文件、Java 都在**它自己那个**
 * 游戏目录里（D 盘的包装在 D 盘）。拿默认目录去启动一个 D 盘的版本，
 * 结果就是"有 1 个游戏文件不在了"。
 */
function effectiveGameDir(versionId, dir) {
  const isolated = settings.effectiveLaunchSettings(settings.versionKey(dir, versionId)).isolation
  return isolated ? paths.versionDir(versionId, dir) : paths.gameDir(dir)
}

/**
 * 算出完整的启动命令。
 *
 * @returns {{jvmArgs: string[], gameArgs: string[], classpath: string,
 *            nativesDir: string, assetsIndex: string,
 *            missing: string[], unknown: string[]}}
 */
function buildCommand(versionId, versionJson, { account, memoryMB, logConfigPath, gameDir, window, rootId, dir, authlib, quickPlay }) {
  const ctx = install.buildContext()
  // 告诉规则判断："我们支持自定义分辨率"——版本 JSON 里那两条
  // --width/--height 参数就是靠这个开关才生效的
  ctx.features = { has_custom_resolution: true }

  // ——— quickPlay（M23）：一键进服务器 ———
  //
  // 版本 JSON 里 `--quickPlayMultiplayer` 那两条参数是**带条件**的：
  // 只有游戏知道"这次要直接进多人游戏"才会加上去。
  // 所以要进服就得把对应的特性开关打开，只填占位符是不够的——
  // 那样参数根本不会被拼进命令行（第一版就卡在这儿）。
  const quickPlayAddress = quickPlay && quickPlay.address ? String(quickPlay.address) : ''
  if (quickPlayAddress) {
    ctx.features.is_quick_play_multiplayer = true
  }

  const runDir = gameDir || paths.gameDir(dir)
  const nativesDir = paths.versionNativesDir(versionId, dir)
  const missing = []
  const unknown = new Set()

  // ——— classpath：所有符合当前系统的库文件 + 客户端 jar（放最后） ———
  const cpFiles = []
  for (const lib of versionJson.libraries || []) {
    if (!install.rulesAllow(lib.rules, ctx)) continue
    const artifact = lib.downloads && lib.downloads.artifact
    if (!artifact || !artifact.path) continue

    const file = path.join(paths.librariesDir(dir), artifact.path)
    cpFiles.push(file)
    if (!fs.existsSync(file)) missing.push(artifact.path)
  }

  // 客户端 jar：装了 Mod 加载器的版本自己没有，用最底下那个父版本的
  const jarOwner = rootId || versionId
  const clientJar = paths.versionJarFile(jarOwner, dir)
  cpFiles.push(clientJar)
  if (!fs.existsSync(clientJar)) missing.push(`${jarOwner}.jar`)

  const classpath = cpFiles.join(path.delimiter)
  const assetsIndex =
    (versionJson.assetIndex && versionJson.assetIndex.id) || versionJson.assets || ''

  // ——— 占位符对照表 ———
  //
  // 离线模式：取值见 docs/02 的"决策 5"——UUID 用离线算法算，
  // accessToken 随便给一个，单机游戏根本不校验它。
  //
  // 外置登录：**全都要换成真的**，而且规矩不一样（见 authlib-injector 官方的
  // 《启动器技术规范》）：令牌用真的、user_type 写 mojang、
  // **UUID 要去掉横杠**（游戏拿它去皮肤站认人，带横杠的写法规范里不要）。
  // 光传令牌还不够——还得靠下面的 -javaagent 把游戏里的验证地址指到皮肤站去，
  // 不然游戏会拿着这个令牌去问 Mojang，那当然不认。
  const isYggdrasil = account.type === 'yggdrasil'
  const isMicrosoft = account.type === 'microsoft'
  // 这两种都是"真账号"：有令牌、由服务器发的 UUID。取值规矩也一样
  // （令牌用真的、UUID 去掉横杠），只有"是哪一种账号"要分开写。
  const realAccount = isYggdrasil || isMicrosoft

  const values = {
    auth_player_name: account.name,
    auth_uuid: realAccount ? String(account.uuid || '').replace(/-/g, '') : account.uuid,
    auth_access_token: isYggdrasil
      ? String(account.accessToken || '')
      : isMicrosoft
        ? String(account.mcAccessToken || '')
        : '0',
    clientid: '',
    // Xbox 用户编号：只有正版账号有，别的填不填都行（缺了不影响进服务器）
    auth_xuid: isMicrosoft ? String(account.xuid || '') : '',
    user_type: isYggdrasil ? 'mojang' : isMicrosoft ? 'msa' : 'legacy',

    version_name: versionId,
    version_type: versionJson.type || 'release',

    game_directory: runDir,
    assets_root: paths.assetsDir(dir),
    assets_index_name: String(assetsIndex),
    // 远古版本（1.7 以前）的资源目录，现在用不到，留着以防万一
    game_assets: path.join(paths.assetsDir(dir), 'virtual', String(assetsIndex)),

    natives_directory: nativesDir,
    library_directory: paths.librariesDir(dir),
    classpath,
    classpath_separator: path.delimiter,

    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,

    // 窗口大小：上面开了 has_custom_resolution，这两个值会真的传给游戏
    resolution_width: String(window?.width || 854),
    resolution_height: String(window?.height || 480),

    // quickPlay（M23）：1.20 起游戏支持"点一下直接进某个世界/服务器"。
    // 服务器列表页那个「进服」用的就是这个。不传就是空串，
    // 对应的特性开关也不开，游戏正常显示主菜单。
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: quickPlay && quickPlay.address ? String(quickPlay.address) : '',
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

  // ——— 窗口大小：先把 JSON 自带的摘掉，再按设置重新加一遍（M23，照 KAMUCL）———
  //
  // 【为什么非摘不可】版本 JSON 里本来就带着 `--width`/`--height`/`--fullscreen`。
  // 大多数版本它们是"跟着 has_custom_resolution 开关走"的模板，替换占位符就行；
  // 但**整合包改过的 JSON、以及一些老版本**里这两个数是写死的，
  // 于是设置里调的窗口大小根本没生效——游戏照样按 JSON 里那个数开
  // （用户会觉得"我改了啊，怎么没用"）。
  // 摘掉再重加，而且放在**最后**——命令行里后出现的参数覆盖前面的。
  stripWindowArgs(gameArgs)
  if (window && window.fullscreen) {
    gameArgs.push('--fullscreen')
  } else if (window && window.width > 0 && window.height > 0) {
    gameArgs.push('--width', String(Math.round(window.width)), '--height', String(Math.round(window.height)))
  }

  // ——— 日志配置 ———
  // 版本 JSON 里给了一条 -Dlog4j.configurationFile=…，把配置文件路径填进去。
  // 文件没下到就不加这条参数——游戏会用默认日志设置，不影响能不能玩。
  const logging = versionJson.logging && versionJson.logging.client
  if (logging && logging.argument && logConfigPath) {
    jvmArgs.push(logging.argument.replace(/\$\{path\}/g, logConfigPath))
  }

  // ——— 外置登录：挂上 authlib-injector ———
  //
  // 【这两条参数为什么必须在最前面】官方规范要求它们加在主类参数之前。
  // 第一条是那个 Java 小代理本身（"把这个 jar 挂上去，验证地址换成这一家"），
  // 第二条是我们提前取好的服务器信息——带上它游戏就不用自己去问，
  // 启动更快，而且不会因为那一瞬间网络不通而崩。
  const agentArgs = []
  if (authlib && authlib.jar) {
    agentArgs.push(`-javaagent:${authlib.jar}=${authlib.apiRoot}`)
    if (authlib.prefetched) {
      agentArgs.push(`-Dauthlibinjector.yggdrasil.prefetched=${authlib.prefetched}`)
    }
    // 【为什么关掉它自己的日志文件】实测：这个代理默认会往"当前目录"写一个
    // authlib-injector.log，而启动游戏时当前目录就是**用户的游戏目录**——
    // 白白往人家 .minecraft 里丢一个文件。关掉它之后输出照样进控制台，
    // 而控制台的内容我们是全程记进启动器日志的（「日志」页能看）
    agentArgs.push('-Dauthlibinjector.noLogFile')
  }

  // ——— 内存和 JVM 调参 ———
  //
  // 这几条版本 JSON 里都不写，是启动器自己加的（官方启动器也这么干）。
  //
  // · `-Xmx`：最多能用多少内存
  // · `-Xms`：**一开始就申请多少**。不写的话 Java 从很小一块开始、
  //   边玩边一点点要，玩到一半突然卡一下就是在申请内存。
  //   取 min(内存, 1024)：给多了启动慢（要先把那么多内存占住），
  //   给少了起不到作用——1024 是上游试出来的那个数。
  // · G1 + 200ms：G1 是现在游戏默认该用的垃圾回收器，
  //   MaxGCPauseMillis=200 让它"宁可多跑几趟、每次别停太久"——
  //   直接的效果是玩着不那么顿。这两条官方启动器也在用。
  // · `-Dfile.encoding=UTF-8`：让游戏的输出固定成 UTF-8。
  //   不写的话老版本在中文 Windows 上按 GBK 吐字，我们虽然能兜底解出来（见下面
  //   解日志那段），但定死成 UTF-8 更省事、也少一层猜。
  const initialHeapMB = Math.min(memoryMB, 1024)

  const finalJvm = [
    `-Xmx${memoryMB}M`,
    `-Xms${initialHeapMB}M`,
    '-XX:+UseG1GC',
    '-XX:MaxGCPauseMillis=200',
    '-Dfile.encoding=UTF-8',
    ...agentArgs,
    ...jvmArgs
  ].map(substitute)
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
function prepareNatives(versionId, versionJson, gameDir) {
  const dir = paths.versionNativesDir(versionId, gameDir)
  paths.ensureDir(dir)

  for (const sub of ['java', 'jna', 'lwjgl', 'netty']) {
    paths.ensureDir(path.join(dir, sub))
  }

  const natives = install.collectClassifierNatives(versionJson, install.buildContext(), gameDir)
  if (natives.length === 0) return

  // 已经解过就不用再解（判断标准：目录里已经有动态库文件）
  let extracted = false
  try {
    extracted = fs.readdirSync(dir).some((name) => /\.(dll|so|dylib)$/i.test(name))
  } catch {
    extracted = false
  }
  if (!extracted) install.extractNatives(versionId, natives, gameDir)
}

/**
 * 把 log4j 的日志配置文件补下来（M4 安装清单里漏了它）。
 * 很小，一千多字节。下不到不算致命，返回 null 让调用方跳过这条参数。
 */
async function ensureLogConfig(versionJson, gameDir) {
  const entry = versionJson.logging && versionJson.logging.client
  if (!entry || !entry.file || !entry.file.url) return null

  const dest = paths.logConfigFile(entry.file.id, gameDir)
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
 * 第一次用这个游戏目录时，把游戏语言设成简体中文。
 *
 * 【为什么要做】游戏装好默认是英文（options.txt 里写的 lang:en_us），
 * 对国内用户来说第一步就是一道坎。实测时用户当场就问了"英文的？"
 *
 * 【为什么"每个目录只做一次"】2026-10-08 用户先后提了两句：
 *   先是"就算用新版本进游戏也要是中文"，我照着改成"每次启动都强制改回中文"；
 *   他马上纠正："**永远是中文不要，用户自己改成英文就保留**"。
 * 所以最终规矩：**每个游戏目录只设一次**，设完在配置里记一笔（languageAppliedDir），
 * 之后无论他把语言改成什么，都**再也不碰**——绝不和用户对着干。
 * 换新版本 = 换新目录 = 会被设一次，所以"新版本进去也是中文"这条照样成立。
 *
 * 【改的是哪个文件】游戏目录下的 options.txt（游戏自己的设置文件），
 * 只动 lang: 那一行，其他设置原样保留；先写临时文件再改名，中途断电不会写坏。
 */
function ensureGameLanguage(gameDir, log) {
  const config = settings.readConfig()

  // 【为什么记的是一串目录、不是单个】原来只记"最后设过的那个目录"，
  // 换着版本玩会互相覆盖：设过 A、又设过 B 之后，配置里只剩 B——
  // 再回来玩 A 就以为"没设过"，又给改一遍，**用户自己改的英文就这么被冲掉了**
  // （2026-10-08 实测踩到：新版本一多，这条就必然出问题）。
  // 老配置里那个单个的 languageAppliedDir 也认，当成列表里的第一项。
  const done = Array.isArray(config.launch.languageAppliedDirs)
    ? config.launch.languageAppliedDirs
    : config.launch.languageAppliedDir
      ? [config.launch.languageAppliedDir]
      : []

  const file = paths.gameOptionsFile(gameDir)

  try {
    const exists = fs.existsSync(file)
    const text = exists ? fs.readFileSync(file, 'utf8') : ''

    // 【选项文件都不在了，就当没设过】用户"把版本删了重新下"的时候，
    // 目录还是那个目录（`versions/26.3`），配置里也还记着"设过了"，
    // 但 options.txt 早跟着版本一起被删了——这时候必须重新设一次，
    // 不然新下下来的版本进去就是英文（用户 2026-10-08 实测碰到）。
    // 所以"记过没"这个判断要**和文件在不在一起看**，光看记录不行。
    if (exists && done.includes(gameDir)) return

    // 已经是中文了：不用改，只记一笔"这个目录做过了"
    // （用 [ \t] 而不是 \s：\s 会把行尾换行也吃掉，语义不干净）
    if (/^lang:zh_cn[ \t]*$/m.test(text)) {
      // 用 Set 去个重：同一个目录被设两次的话，列表里会攒重复项，越攒越长
      settings.writeConfig({ launch: { languageAppliedDirs: [...new Set([...done, gameDir])] } })
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
    paths.ensureDir(gameDir)
    fs.writeFileSync(temp, next, 'utf8')
    fs.renameSync(temp, file)

    // 用 Set 去个重（同一个目录可能被走到两次，不然列表会攒重复项）
    settings.writeConfig({ launch: { languageAppliedDirs: [...new Set([...done, gameDir])] } })
    if (log) log.line('[启动器] 第一次用这个目录，已把游戏语言设成简体中文（你以后自己改了，就不会再动它）')
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
function createLogCollector({ onLog, logFile, onLine }) {
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

    // 每一行都过一下这个小钩子——联机那边靠它抓"对局域网开放"的端口号
    if (onLine) {
      try {
        onLine(text)
      } catch {
        // 钩子里出问题不该影响游戏
      }
    }

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
/**
 * 找这次启动产生的崩溃报告（M23）。
 *
 * 【为什么按时间找而不是按名字】`crash-reports\crash-2026-10-12_18.30.12-client.txt`
 * 这名字里是**游戏那边的时间**，而且格式各版本不一样。
 * 只看"比这次启动还新的"，比猜文件名靠谱得多。
 *
 * @param {string} runDir 游戏目录
 * @param {number} since 这次启动的时间戳
 */
function findCrashReport(runDir, since) {
  const folder = path.join(runDir, 'crash-reports')
  let names = []
  try {
    names = fs.readdirSync(folder)
  } catch {
    return ''
  }

  let newest = ''
  let newestAt = 0
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.txt')) continue
    const full = path.join(folder, name)
    try {
      const info = fs.statSync(full)
      // 留 2 秒余量：文件的时间戳和进程启动可能差一点点
      if (info.mtimeMs >= since - 2000 && info.mtimeMs >= newestAt) {
        newest = full
        newestAt = info.mtimeMs
      }
    } catch {
      // 读不到就不算
    }
  }
  return newest
}

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
  const { onLog, onState, dir, quickPlay } = options
  const state = (payload) => {
    try {
      if (onState) onState(payload)
    } catch {
      // 界面那边出问题不该影响游戏
    }
  }

  // 往界面日志里说一句话。⑨ 那步之前还没有正式的日志收集器，
  // 但补下 Java 的过程也得让用户看得见，所以先备一个临时的
  const say = (text) => {
    try {
      if (onLog) onLog([text])
    } catch {
      // 界面那边出问题不该影响游戏
    }
  }

  if (current) return { ok: false, error: '游戏已经在运行了' }

  // ——— ① 账号 ———
  let account = accounts.getAccount()
  if (!account) return { ok: false, error: '先在左边填一个游戏名字，再点「开始游戏」' }

  // ——— ①.5 正版账号：令牌过期就顺手续一下（M13.2）———
  //
  // 【为什么要续】游戏令牌只有一天有效期，但登录时存下来的 refresh_token 能长期用。
  // 不续的话，用户第二天点「开始游戏」就会莫名其妙进不去正版服务器——
  // 而且报错来自游戏内部，看不懂。
  // 【为什么"续不上就别启动"】令牌已经过期又续不上，游戏拿着它去认人一定失败。
  // 与其让用户进游戏看到一句莫名其妙的英文，不如在这儿说清楚。
  if (account.type === 'microsoft') {
    if (!account.mcAccessToken) {
      return { ok: false, error: '这个正版账号缺登录信息，到「启动」页左边重新登录一次' }
    }

    // 提前一分钟续，免得"刚好在启动那一瞬间过期"
    if ((account.mcExpiresAt || 0) < Date.now() + 60 * 1000) {
      say('[启动器] 正版登录状态快过期了，正在续期…')
      const renewed = await microsoft.refresh(account)

      if (renewed.ok) {
        account = renewed.account
        accounts.saveAccount(account) // 存下来，下次不用再续
        say('[启动器] 续期好了')
      } else if (renewed.needLogin) {
        return { ok: false, error: '正版登录状态过期了，到「启动」页左边重新登录一次' }
      } else {
        return { ok: false, error: `正版登录续期失败：${renewed.error}` }
      }
    }
  }

  // ——— ② 版本文件 ———
  const jsonFile = paths.versionJsonFile(versionId, dir)
  if (!fs.existsSync(jsonFile)) {
    return { ok: false, error: `找不到 ${versionId} 的版本文件。到「下载」页重新安装一次这个版本。` }
  }

  let versionJson
  try {
    versionJson = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
  } catch {
    return { ok: false, error: `${versionId} 的版本文件读不出来（可能坏了）。到「下载」页重新安装一次。` }
  }

  // 装了 Mod 加载器的版本写着一句 inheritsFrom（继承自某个原版）：
  // 库文件、启动参数、主类都要连父版本一起算，客户端 jar 用父版本那份
  const resolved = inherit.resolveVersion(versionId, versionJson, dir)
  if (resolved.missingParent) {
    return {
      ok: false,
      error: `这个版本是装在 ${resolved.missingParent} 上面的，得先把它装好（到「下载」页重装一下）`
    }
  }
  const fullJson = resolved.json
  const rootId = resolved.rootId

  // ——— ③ 内存和窗口大小 ———
  // 这个版本自己单独设过就用自己的，没设过跟随全局（见 settings.effectiveLaunchSettings）
  const effective = settings.effectiveLaunchSettings(settings.versionKey(dir, versionId))
  const memoryMB = effective.memoryMB
  const memoryCheck = settings.validateMemoryMB(memoryMB)
  if (!memoryCheck.ok) return { ok: false, error: memoryCheck.error }

  const windowSize = { width: effective.windowWidth, height: effective.windowHeight }

  // ——— ④ Java ———
  //
  // 先看这个版本点名的运行时在不在，不在就补下。
  // 【为什么启动前要管这个】"装整合包"（拖个 zip 进来那种）走的是另一条路，
  // 只把包里的文件铺开、不碰 Java。实测踩到过（2026-10-07）：一个 1.20.1 Forge 的包
  // 文件装得齐齐的，可本机没有它要的 Java 17，启动时拿现成的 Java 16 顶上，
  // 游戏当场崩。所以缺了就补——和上面"日志配置缺了补下"是同一个套路。
  // 【M20 加的开关】设置里那个「自动检测并下载所需 Java」关掉之后，
  // 这里就**一个字节都不下**——只在本机已有的 Java 里找。
  // 有的用户网按流量算，或者就是不想让启动器往硬盘里塞 200 MB。
  const autoJava = settings.readConfig().launch.autoJava !== false
  const wantedComponent = fullJson.javaVersion && fullJson.javaVersion.component
  if (wantedComponent && autoJava) {
    const wantedExe = path.join(paths.runtimeDir(), wantedComponent, 'bin', 'java.exe')

    if (!fs.existsSync(wantedExe)) {
      say(`[启动器] 这个版本要的 Java 运行时（${wantedComponent}）本机还没有，正在补下…`)
      try {
        await install.ensureJavaComponent(wantedComponent, { onStage: (text) => say(`[启动器] ${text}`) })
        say('[启动器] Java 运行时下好了')
      } catch (error) {
        // 下不到不能拦住启动：本机要是有版本对得上的 Java，照样能跑；
        // 真跑不起来，下面 findJava 的结果和退出时的提示会告诉用户为什么
        say(`[启动器] Java 运行时没下成（${error.message}），先试试本机已有的 Java`)
      }
    }
  } else if (wantedComponent && !autoJava) {
    say('[启动器] 你关掉了"自动下载 Java"，只在本机已有的里面找')
  }

  const key = settings.versionKey(dir, versionId)
  const javaExe = javaUtil.findJava(fullJson, { key })
  if (!javaExe) {
    // 用户指定的那个不见了，得单独说——不然他会以为自己选的没生效
    const preference = javaUtil.javaPreference(key)
    if (preference.chosen) {
      return {
        ok: false,
        error: `你指定的那个 Java 不在了：${preference.chosen}\n到「设置 → Java 运行时」重新选一个，或者把「自动检测并下载所需 Java」打开。`
      }
    }
    return {
      ok: false,
      error: autoJava
        ? '找不到这个版本需要的 Java。到「下载」页对着这个版本点「重装」，会自动把 Java 也下好。'
        : '这个版本要的 Java 本机没有，而你把「自动检测并下载所需 Java」关掉了。到「设置 → Java 运行时」打开它，或者自己指定一个 Java。'
    }
  }

  const probe = javaUtil.probeJava(javaExe.path)
  if (!probe.ok) {
    return { ok: false, error: `找到了 Java，但它跑不起来（${javaExe.path}）：${probe.error}` }
  }

  // 版本要求的大版本对不上时只提醒、不拦——有些版本差一点也能跑
  const wantedMajor = fullJson.javaVersion && fullJson.javaVersion.majorVersion
  const javaWarning =
    wantedMajor && probe.major && probe.major !== wantedMajor
      ? `注意：这个版本建议用 Java ${wantedMajor}，现在找到的是 Java ${probe.version}，可能会起不来。`
      : ''

  // ——— ⑤ 这次启动用哪个"游戏目录"（版本隔离决定，在这个版本自己的游戏目录里算） ———
  const runDir = effectiveGameDir(versionId, dir)
  // 这次启动是什么时候开始的。判"崩溃报告是不是这次的"要用它（见 findCrashReport）
  const startedAt = Date.now()
  paths.ensureDir(runDir)

  // ——— ⑥ 日志配置（很小，没有就补下；下不到不致命） ———
  const logConfigPath = await ensureLogConfig(fullJson, dir)

  // ——— ⑥.5 外置登录：把 authlib-injector 准备好 ———
  //
  // 【配不上就别启动】挂不上这个代理，游戏会拿着皮肤站的令牌去问 Mojang，
  // 结果只会是一头雾水。与其让用户进游戏看到莫名其妙的报错，
  // 不如在这儿说清楚"组件没下下来"，并给出下一步。
  let authlib = null
  if (account.type === 'yggdrasil') {
    if (!account.apiRoot || !account.accessToken) {
      return {
        ok: false,
        error: '这个外置账号缺登录信息，到「启动」页左边重新登录一次试试'
      }
    }

    try {
      say(`[启动器] 正在准备外置登录组件…`)
      const wrapped = await authlibUtil.ensure({ onStage: (text) => say(`[启动器] ${text}`) })
      const prefetched = await authlibUtil.prefetchMetadata(account.apiRoot)
      authlib = { jar: wrapped.path, apiRoot: account.apiRoot, prefetched }
      say('[启动器] 外置登录组件就绪')
    } catch (error) {
      return {
        ok: false,
        error: `外置登录要用的组件没下下来（${error.message}）。检查一下网络再试；着急玩的话可以先换成离线账号。`
      }
    }
  }

  // ——— ⑦ 拼参数，并检查文件齐不齐 ———
  const command = buildCommand(versionId, fullJson, {
    account,
    memoryMB,
    logConfigPath,
    gameDir: runDir,
    window: windowSize,
    rootId,
    dir,
    authlib,
    quickPlay
  })

  if (command.missing.length > 0) {
    const sample = command.missing.slice(0, 3).join('、')
    return {
      ok: false,
      error: `有 ${command.missing.length} 个游戏文件不在了（比如 ${sample}）。到「下载」页对着这个版本点「重装」，缺的会自动补上。`
    }
  }

  if (command.assetsIndex) {
    const indexFile = path.join(paths.assetsDir(dir), 'indexes', `${command.assetsIndex}.json`)
    if (!fs.existsSync(indexFile)) {
      return {
        ok: false,
        error: '游戏资源文件的索引不在了。到「下载」页对着这个版本点「重装」补齐。'
      }
    }
  }

  // ——— ⑧ natives 目录 ———
  prepareNatives(versionId, fullJson, dir)

  // ——— ⑨ 起进程 ———
  const args = [...command.jvmArgs, fullJson.mainClass, ...command.gameArgs]

  paths.ensureDir(paths.logsDir())
  // 【不能用 toISOString()】那是**世界时**，比北京时间早 8 小时：上午 9 点起的日志
  // 会被写成 launch-...011314.log，界面上就会显示成"夜里 1 点那次启动"（2026-10-09 实测抓到）。
  // 自己按本机时间拼，文件名和用户看到的钟点才对得上。
  const now = new Date()
  const two = (n) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  const logFile = path.join(paths.logsDir(), `launch-${stamp}.log`)

  // 游戏里点「对局域网开放」时会往日志里打一行，带着端口号。
  // 抓到这个端口号，联机那边就能算出"把这个地址发给好友：10.126.126.1:54321"——
  // 省得用户自己去日志里翻。
  //
  // 【这些文案是哪来的】没靠记忆，一条条摸出来的：
  //   `Started serving on {}`          1.20.1 —— 解开游戏 jar、在类文件里搜字符串搜到的
  //   `Local game hosted on port {}`    另一个版本用的
  //   `Published LAN server on port {}` **26.3** —— 2026-10-08 用户实测：
  //       他明明开了局域网，毛球就是不认。翻他的游戏日志才看到文案换了
  //       （`[Render thread/INFO]: Published LAN server on port 57003`）。
  // 【为什么要写后面那条兜底】这文案每个大版本都可能换一次，一条条加迟早又漏。
  // 兜底那条只要同一行里同时出现"LAN"和"port"、后头跟个 2~5 位数字就认——
  // 限制够严，不至于误伤别的日志行。
  // 【只能有一个捕获组】下面直接取 match[1]，写成好几个分支（每个带一个组）的话
  // 没命中的那些组是 undefined，取出来就是 NaN
  const lanPattern =
    /(?:(?:Started serving on|Local game hosted on|Published LAN server on)\s+(?:port\s*)?|LAN[^\d\n]{0,40}port[^\d\n]{0,20})(\d{2,5})/i

  const log = createLogCollector({
    onLog,
    logFile,
    onLine: (text) => {
      const match = text.match(lanPattern)
      if (match) {
        state({ state: 'lan', port: Number(match[1]), versionId })
        return
      }

      // 退出存档（回到主菜单）时也会打一行，这时候**端口就作废了**——
      // 得赶紧告诉界面，不然它还写着"把这个地址发给好友：xxx:57400"，
      // 可那个世界早关了，好友连过来根本连不上（2026-10-08 用户实测）。
      // 【文案哪来的】翻用户那次游戏日志看到的：
      //   `[Server thread/INFO]: Stopping server`
      //   `[Server thread/INFO]: Stopping singleplayer server as player logged out`
      // 认"Stopping server"这一句就够；它是集成服务端停下来的标志。
      // 【注意】这里**只是把端口作废，不退出房间**——用户换个世界重开、
      // 再按一次「对局域网开放」就会报一个新的端口上来，房间不用重建。
      if (/Stopping server|Stopping singleplayer server/i.test(text)) {
        state({ state: 'lan-closed', versionId })
      }
    }
  })
  log.line(`[启动器] 版本 ${versionId} · Java ${probe.version}（${javaExe.source}）· 内存 ${memoryMB} MB`)
  log.line(`[启动器] 游戏窗口：${windowSize.width} × ${windowSize.height}`)
  log.line(`[启动器] 游戏目录：${runDir}${effective.isolation ? '（开着版本隔离）' : ''}`)
  if (effective.overridden.memoryMB || effective.overridden.window || effective.overridden.isolation) {
    log.line('[启动器] 这个版本有自己的单独设置（内存/窗口/隔离里的某几项）')
  }
  log.line(`[启动器] 完整日志会存到：${logFile}`)
  if (javaWarning) log.line(`[启动器] ${javaWarning}`)
  if (command.unknown.length > 0) {
    log.line(`[启动器] 这些启动参数不认识，已按空值处理：${command.unknown.join('、')}`)
  }

  // 第一次用这个游戏目录的话，把游戏语言设成中文（只做一次，见函数说明）
  ensureGameLanguage(runDir, log)

  let child
  try {
    child = spawn(javaExe.path, args, {
      cwd: runDir,
      windowsHide: true,
      // 【为什么必须 detached】Electron 把它的子进程都放在一个"进程组"里，
      // 主进程一退出，组里的全部被杀。实测过：不加这行，用户关掉启动器，
      // **正在玩的游戏会跟着一起没**。detached 让游戏自己独立成组，
      // 启动器关了它照样跑（和 PCL 的行为一致）。
      detached: true,
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
      logFile,
      // 这次启动有没有写崩溃报告（通知里要提一句，用户点开就知道去哪看）
      crashReport: explain.ok ? '' : findCrashReport(runDir, startedAt)
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

/**
 * 把"这个目录设过中文"的记录里、**目录已经不在了**的那些剔掉。
 *
 * 【为什么要做】那份记录是按目录存的。用户"删掉版本重新下"之后，目录还是同一个名字
 * （`versions/26.3`），记录却还留着——于是新下下来的版本被当成"设过了"，进去是英文
 * （用户 2026-10-08 实测碰到）。删版本时顺手清一遍，或者毛球启动时清一遍。
 */
function forgetLanguageForMissingDirs() {
  const config = settings.readConfig()
  const done = Array.isArray(config.launch.languageAppliedDirs)
    ? config.launch.languageAppliedDirs
    : []
  if (!done.length) return false

  const alive = done.filter((one) => {
    try {
      return fs.existsSync(one)
    } catch {
      return false
    }
  })
  if (alive.length === done.length) return false

  settings.writeConfig({ launch: { languageAppliedDirs: alive } })
  return true
}

module.exports = { launch, isRunning, buildCommand, explainExit, ensureGameLanguage, forgetLanguageForMissingDirs }

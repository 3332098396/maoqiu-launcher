// 毛球 — 配置读写
//
// 配置就一个 JSON 文件：%APPDATA%\毛球\config.json
// 里面放账号、启动设置这些"关掉软件也要记住"的东西。
//
// 【为什么必须先写临时文件再改名】
// 直接往 config.json 上写，写到一半断电或者崩溃，文件就成了半截——
// 下次打开软件读不出来，账号和设置就全丢了。
// 先写 config.json.tmp、写完整了再改名替换：改名是一瞬间的事，
// 硬盘上要么是旧的完整文件，要么是新的完整文件，不存在半截状态。
//
// 当前进度：M5（内存分配、手动指定 Java 的读写先做好，
// 改这些值的界面在 M6 的设置页）。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const paths = require('./paths')

/** 默认配置。读不到文件、文件坏了，都用这份 */
const DEFAULTS = {
  /**
   * 下载源偏好（用户可以在设置里改）：
   *   'auto'     优先官方，太慢自动换国内镜像（默认）
   *   'mirror'   优先国内镜像
   *   'official' 只用官方，不经过任何第三方镜像
   */
  download: {
    source: 'auto'
  },
  /** 账号。第一期只有离线：{ type: 'offline', name: '玩家名', uuid: '...' } */
  account: null,
  /**
   * 游戏目录：除了默认那个（%APPDATA%\.minecraft），用户还选了哪些。
   *
   * 用途：拖整合包的时候可以选"装到哪儿"（比如装到 D 盘去）。选过的目录记在这儿，
   * 以后那个目录里的版本也会一起出现在启动页的列表里（各自标着自己在哪个目录）。
   *
   * 【为什么 known 里不装默认目录】默认目录是"永远可用"的锚点
   * （见 paths.defaultGameDir 的说明），不用登记；混在一起每次读都得先去一遍重。
   */
  gameDirs: {
    /** 用户额外选过的游戏目录（不含默认目录） */
    known: [],
    /** 上次拖包装到哪儿了——下次打开那个对话框时默认选它 */
    lastPackDir: ''
  },
  /**
   * 每个版本的自定义信息（显示名、备注），按版本号存：
   * { "26.3": { name: "我的生存", note: "装了 XX" } }
   * 只存用户真填过的，留空的版本不会出现在这里。
   */
  versions: {},
  launch: {
    /** 给游戏多少内存（MB）。0 = 自动（本机内存的 1/4，上限 8 GB） */
    memoryMB: 0,
    /** 手动指定的 Java 路径。空 = 自动找 */
    javaPath: '',
    /** 上次启动的版本，下次打开软件默认选它 */
    lastVersion: '',
    /**
     * 帮哪个游戏目录设过中文（存的是目录路径）。
     * 只设一次——之后用户自己在游戏里改了就永远不再干预（见 launch.js）。
     * 【为什么记的是路径而不是"是/否"】开了版本隔离后，游戏目录会变成
     * versions\<版本号>\，"设过了"这件事要按目录各算各的，
     * 否则隔离后的新目录会被漏掉，游戏又变回英文
     */
    languageAppliedDir: '',
    /** 游戏窗口多大（像素）。默认就是游戏自己的标准尺寸 */
    windowWidth: 854,
    windowHeight: 480,
    /** 版本隔离：每个版本的存档/Mod 各放各的（默认开，见 docs/01 默认值表） */
    isolation: true
  },
  /**
   * 单个版本自己的启动设置（上面那份是全局的）。
   * 只存"用户单独改过"的项，没写的就跟随全局：
   * { "26.3": { memoryMB: 4096, isolation: false } }
   *
   * 【为什么要有这一层】有的版本吃内存多、有的版本想单独开隔离，
   * 一个全局值伺候不了所有版本（PCL 也是这么分的）。
   */
  versionSettings: {}
}

/** 读配置。没有文件或者内容坏了，都返回默认值，不抛异常 */
function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'))
    const dirs = raw.gameDirs || {}
    return {
      ...DEFAULTS,
      ...raw,
      launch: { ...DEFAULTS.launch, ...(raw.launch || {}) },
      download: { ...DEFAULTS.download, ...(raw.download || {}) },
      gameDirs: {
        // 老配置文件里根本没有 gameDirs 这一项，读出来就是空的
        known: Array.isArray(dirs.known) ? dirs.known.filter((d) => typeof d === 'string' && d) : [],
        lastPackDir: typeof dirs.lastPackDir === 'string' ? dirs.lastPackDir : ''
      }
    }
  } catch {
    return {
      ...DEFAULTS,
      launch: { ...DEFAULTS.launch },
      download: { ...DEFAULTS.download },
      gameDirs: { known: [], lastPackDir: '' }
    }
  }
}

/** 下载源偏好：'auto' | 'mirror' | 'official' */
function downloadSource() {
  const value = readConfig().download?.source
  return value === 'mirror' || value === 'official' ? value : 'auto'
}

// ——————————————————————————————————————————————
// 游戏目录（M11.4：整合包可以装到别的目录去）
// ——————————————————————————————————————————————

/**
 * 认得的游戏目录清单：默认目录打头，后面是用户选过的那些（去掉重复的）。
 * "去哪儿找版本"这件事都拿它当依据。
 */
function knownGameDirs() {
  const raw = readConfig().gameDirs.known
  const out = [paths.defaultGameDir()]

  for (const one of raw) {
    const dir = String(one || '').trim()
    if (!dir) continue
    if (out.some((known) => paths.sameDir(known, dir))) continue
    out.push(dir)
  }

  return out
}

/** 记住一个游戏目录（已经认得就只更新"上次用的"）。返回最新清单 */
function rememberGameDir(dir) {
  const target = path.resolve(String(dir || '').trim())
  const known = readConfig().gameDirs.known

  // 默认目录不用记（它天然永远可用）
  if (paths.sameDir(target, paths.defaultGameDir())) {
    writeConfig({ gameDirs: { lastPackDir: '' } })
    return knownGameDirs()
  }

  const next = known.filter((one) => !paths.sameDir(one, target))
  next.push(target)

  writeConfig({ gameDirs: { known: next, lastPackDir: target } })
  return knownGameDirs()
}

/**
 * 这个目录能不能当游戏目录用。
 *
 * 【为什么中文路径要硬拦】这是项目的老规矩（docs/01 第 208 行）：
 * 老版本的 Java 和部分 Mod 对中文路径处理不好，会报一些谁也看不懂的错。
 * 与其让用户装完几百 MB 再撞上去，不如选的时候就说明白。
 *
 * @returns {{ok: boolean, error?: string}}
 */
function validateGameDir(dir) {
  const text = String(dir || '').trim()

  if (!text) return { ok: false, error: '没选目录' }
  if (!path.isAbsolute(text)) {
    return { ok: false, error: '要选一个完整的路径，比如 D:\\minecraft' }
  }

  const resolved = path.resolve(text)

  // 先查"是不是毛球自己的配置目录"——这条要排在"查中文"前面：
  // 配置目录本身带了中文（毛球），排在后面的话会给出一句驴唇不对马嘴的理由
  if (paths.sameDir(resolved, paths.configDir())) {
    return { ok: false, error: '这是毛球自己存配置的地方，不能拿来当游戏目录' }
  }
  if (path.parse(resolved).root === resolved) {
    return { ok: false, error: '不能直接选整个盘（比如 D:\\），得选盘里的一个文件夹' }
  }
  // 只允许英文、数字、常见符号（ASCII）
  if (/[^\x20-\x7E]/.test(resolved)) {
    return {
      ok: false,
      error: '路径里别带中文——老版本的 Java 遇到中文路径会犯迷糊。换一个英文路径，比如 D:\\minecraft'
    }
  }

  // 和已知目录互相套娃会让"这个版本在哪个目录"变得说不清
  for (const known of knownGameDirs()) {
    const a = resolved.toLowerCase()
    const b = path.resolve(known).toLowerCase()
    if (a === b) return { ok: false, error: `这个目录已经在列表里了：${known}` }
    if (a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) {
      return { ok: false, error: `和另一个游戏目录套在一起了（${known}），换一个互不包含的文件夹` }
    }
  }

  return { ok: true }
}

/**
 * 用户挑的那个文件夹，最终当哪个目录用。
 *
 * 规矩：选中的文件夹如果**本身就像个游戏目录**（叫 .minecraft，或者里面已经有
 * versions / libraries），就直接用它；否则在它下面再建一层 `.minecraft`——
 * 免得用户随手选个 D:\我的世界，游戏文件就散落在它根上。
 * 界面上会把最终结果写出来，不让用户猜。
 */
function resolveChosenDir(chosen) {
  const target = path.resolve(String(chosen || '').trim())

  if (path.basename(target).toLowerCase() === '.minecraft') return target
  for (const mark of ['versions', 'libraries', 'assets']) {
    if (fs.existsSync(path.join(target, mark))) return target
  }

  return path.join(target, '.minecraft')
}

/**
 * 版本在配置里的键。
 *
 * 【为什么要这么绕】配置里那些跟版本走的数据（显示名、备注、单独的内存/隔离设置）
 * 原来是**只按版本号**存的。现在有了第二个游戏目录，两个目录里可能各有一个
 * 叫 "26.3" 的版本——不区分就会串台（改 D 盘那个的名字，C 盘那个跟着变）。
 *
 * 规矩：**默认目录里的版本仍然只用版本号**（老配置一个字都不用改，零迁移），
 * 别的目录用 `<目录>|<版本号>`。分隔符用竖线：Windows 路径里不可能出现它，
 * 版本名里的竖线也已经被 pack.checkVersionName 拦掉了。
 *
 * 这一切成立的前提是 paths.defaultGameDir() **永不漂移**。
 */
function versionKey(dir, id) {
  const versionId = String(id || '')
  if (!dir || paths.sameDir(dir, paths.defaultGameDir())) return versionId
  return `${path.resolve(dir)}|${versionId}`
}

/** 把 versionKey 拆回去。老式的裸版本号 → 算默认目录里的 */
function parseVersionKey(key) {
  const text = String(key || '')
  // 按**第一个**竖线拆：目录里不可能有竖线（Windows 不允许），版本号里却可能有，
  // 所以竖线后头那一整段都算版本号。反过来拆（找最后一个）会把带竖线的版本号切坏。
  const at = text.indexOf('|')

  if (at < 0) return { dir: paths.defaultGameDir(), id: text, isDefault: true }
  return { dir: text.slice(0, at), id: text.slice(at + 1), isDefault: false }
}

/**
 * 改一部分配置并保存。
 * 只传要改的部分即可，比如 writeConfig({ launch: { lastVersion: '26.3' } })
 * @returns 保存后的完整配置
 */
function writeConfig(patch) {
  const config = readConfig()
  const next = {
    ...config,
    ...patch,
    launch: { ...config.launch, ...(patch.launch || {}) },
    gameDirs: { ...config.gameDirs, ...(patch.gameDirs || {}) }
  }

  paths.ensureDir(paths.configDir())
  const file = paths.settingsFile()
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(temp, file)

  return next
}

// ——————————————————————————————————————————————
// 内存分配
// ——————————————————————————————————————————————

/** 本机一共多少内存（MB） */
function totalMemoryMB() {
  return Math.round(os.totalmem() / 1024 / 1024)
}

/**
 * 自动值：本机内存的 1/4，往下取到 512 的整数倍，
 * 最少 1024 MB（再少游戏跑不动），最多 8192 MB（给太多会把电脑拖卡）。
 */
function defaultMemoryMB() {
  const quarter = Math.floor(totalMemoryMB() / 4)
  const rounded = Math.floor(quarter / 512) * 512
  return Math.min(Math.max(rounded, 1024), 8192)
}

/** 当前生效的内存分配（用户没设过就是自动值） */
function currentMemoryMB() {
  const value = Number(readConfig().launch.memoryMB)
  return value > 0 ? Math.round(value) : defaultMemoryMB()
}

/**
 * 检查内存数值合不合理。
 * 启动前会调它——宁可提前说清楚，也不要让游戏默默卡死。
 */
function validateMemoryMB(mb) {
  if (!Number.isFinite(mb) || mb < 512) {
    return {
      ok: false,
      error: `给游戏分配的内存只有 ${mb} MB，太少了，游戏至少要 512 MB 才能启动。`
    }
  }
  if (mb > totalMemoryMB()) {
    return {
      ok: false,
      error: `给游戏分配的内存（${mb} MB）超过了本机总内存（${totalMemoryMB()} MB），游戏会起不来。`
    }
  }
  return { ok: true }
}

/** 窗口大小的合理范围。不是技术限制，是防手滑（比如输成 99999） */
const WINDOW_LIMITS = { minWidth: 320, maxWidth: 3840, minHeight: 240, maxHeight: 2160 }

/**
 * 检查窗口大小合不合理。
 * @returns {{ok: boolean, error?: string, warning?: string}}
 */
function validateWindow(width, height) {
  const w = Number(width)
  const h = Number(height)

  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, error: '窗口大小要填数字' }
  }
  if (w < WINDOW_LIMITS.minWidth || h < WINDOW_LIMITS.minHeight) {
    return {
      ok: false,
      error: `窗口太小了，最小 ${WINDOW_LIMITS.minWidth} × ${WINDOW_LIMITS.minHeight}`
    }
  }
  if (w > WINDOW_LIMITS.maxWidth || h > WINDOW_LIMITS.maxHeight) {
    return {
      ok: false,
      error: `窗口太大了，最大 ${WINDOW_LIMITS.maxWidth} × ${WINDOW_LIMITS.maxHeight}`
    }
  }
  return { ok: true }
}

/** 全局的启动设置（把"自动内存"解析成具体数字，界面直接能用） */
function globalLaunchSettings() {
  const launch = readConfig().launch
  return {
    memoryMB: Number(launch.memoryMB) > 0 ? Math.round(launch.memoryMB) : defaultMemoryMB(),
    memoryAuto: !(Number(launch.memoryMB) > 0),
    windowWidth: Number(launch.windowWidth) > 0 ? Math.round(launch.windowWidth) : 854,
    windowHeight: Number(launch.windowHeight) > 0 ? Math.round(launch.windowHeight) : 480,
    isolation: Boolean(launch.isolation)
  }
}

/**
 * 算出某个版本这次启动真正用的设置：
 * 它自己单独设过的用自己的，没设的跟随全局。
 *
 * @returns {{memoryMB: number, windowWidth: number, windowHeight: number,
 *            isolation: boolean, overridden: {memoryMB: boolean, window: boolean, isolation: boolean}}}
 */
function effectiveLaunchSettings(versionId) {
  const override = (readConfig().versionSettings || {})[versionId] || {}
  const global = globalLaunchSettings()

  const hasMemory = Number(override.memoryMB) > 0
  const hasWindow = Number(override.windowWidth) > 0 && Number(override.windowHeight) > 0
  const hasIsolation = typeof override.isolation === 'boolean'

  return {
    memoryMB: hasMemory ? Math.round(override.memoryMB) : global.memoryMB,
    windowWidth: hasWindow ? Math.round(override.windowWidth) : global.windowWidth,
    windowHeight: hasWindow ? Math.round(override.windowHeight) : global.windowHeight,
    isolation: hasIsolation ? override.isolation : global.isolation,
    overridden: { memoryMB: hasMemory, window: hasWindow, isolation: hasIsolation }
  }
}

module.exports = {
  readConfig,
  writeConfig,
  totalMemoryMB,
  defaultMemoryMB,
  currentMemoryMB,
  validateMemoryMB,
  validateWindow,
  WINDOW_LIMITS,
  globalLaunchSettings,
  effectiveLaunchSettings,
  downloadSource,
  knownGameDirs,
  rememberGameDir,
  validateGameDir,
  resolveChosenDir,
  versionKey,
  parseVersionKey
}

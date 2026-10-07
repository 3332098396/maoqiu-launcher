// MC启动器 — 配置读写
//
// 配置就一个 JSON 文件：%APPDATA%\MC启动器\config.json
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
const paths = require('./paths')

/** 默认配置。读不到文件、文件坏了，都用这份 */
const DEFAULTS = {
  /** 账号。第一期只有离线：{ type: 'offline', name: '玩家名', uuid: '...' } */
  account: null,
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
     * 有没有帮用户把游戏语言设成过中文。
     * 只做一次——之后用户自己在游戏里改了就永远不再干预（见 launch.js）
     */
    languageApplied: false
  }
}

/** 读配置。没有文件或者内容坏了，都返回默认值，不抛异常 */
function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'))
    return {
      ...DEFAULTS,
      ...raw,
      launch: { ...DEFAULTS.launch, ...(raw.launch || {}) }
    }
  } catch {
    return { ...DEFAULTS, launch: { ...DEFAULTS.launch } }
  }
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
    launch: { ...config.launch, ...(patch.launch || {}) }
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

module.exports = {
  readConfig,
  writeConfig,
  totalMemoryMB,
  defaultMemoryMB,
  currentMemoryMB,
  validateMemoryMB
}

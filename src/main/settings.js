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
    source: 'auto',
    /** 同时下几个文件（M23 起默认 16，见 downloadConcurrency 的说明） */
    concurrency: 16,
    /** 限速 KB/s（M13，0 = 不限） */
    speedLimitKB: 0
  },
  /** 账号。第一期只有离线：{ type: 'offline', name: '玩家名', uuid: '...' } */
  account: null,
  /**
   * 正版登录（M13）用的东西。
   *
   * 【clientId 为什么空着、要用户自己填】微软的应用条款要求每个启动器
   * 用**自己注册的** ID，不许借别人的。而且借来的 ID 一旦被停，
   * 用户会毫无预兆地登不上、还查不出原因。注册步骤见 docs/09。
   *
   * 【这里绝不存微软账号密码】密码只在微软自己的页面上输入，
   * 毛球只接住跳回来时那串临时码。存进账号里的是**登录令牌**。
   */
  microsoft: {
    clientId: ''
  },
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
   * 界面个性化（M13）：藏哪些页面、背景图、背景音乐、顶栏样式。
   * 全是看着玩的东西，坏了不影响游戏——所以读取时一律兜底成空值。
   */
  look: {
    /** 要藏起来的页面（'online' / 'download' / 'help'） */
    hiddenPages: [],
    /**
     * 用账号上的皮肤（M17.5，默认用）。
     * 关掉之后就用 skin 里那个本地文件——以前是登了账号就自动盖掉，
     * 用户自己挑的那张被换了还不知道为什么。
     */
    useAccountSkin: true,
    /**
     * 没登录时随机穿一张皮肤（M21，默认开）。
     * 每次打开软件换一张——不然永远是同一个小人站在那儿。
     * 【不联网】随机池全是本机现成的：官方 Steve、毛球自带的几套配色、你自己传的。
     */
    randomSkin: true,
    /**
     * 离线账号进游戏时，也把现在这张皮肤穿上（M25，默认开）。
     * 关掉的话游戏里就是默认的 Steve/Alex（以前一直是这样）。
     */
    offlineSkinInGame: true,
    /**
     * 自己挑的那张皮肤是"粗胳膊"还是"细胳膊"（M25）。
     * 【为什么得让用户说】皮肤图上**看不出来**——Steve 型和 Alex 型都是 64×64，
     * 差别只在游戏怎么解释它。官方那两张我们不用问（steve=粗、alex=细）。
     * 'classic' = 粗（Steve）/ 'slim' = 细（Alex）
     */
    skinVariant: 'classic',
    /** 示例皮肤已经存进皮肤库了没有（存过一次就不再自动补，免得用户删了又冒出来） */
    builtinsSeeded: false,
    /** 背景图的完整路径（空 = 不设） */
    background: '',
    /** 背景音乐的完整路径（空 = 不设），还有音量 0-100 */
    bgm: '',
    bgmVolume: 40,
    /** 界面主题名（对应 style.css 里的 body[data-theme=...]，默认霓虹紫青）*/
    theme: 'neon',
    /**
     * 减少动态效果（M23，照 KAMUCL 的"减少动效/跟随系统"）。
     *   'system' 跟随系统（默认）—— Windows「辅助功能 → 显示 → 显示动画」关掉就跟着关
     *   'on'     一直减少 —— 界面里的淡入、滑动、小人转动全部停掉
     *   'off'    不减少   —— 系统设了减少也不理它
     * 【为什么要给三档而不是一个开关】"跟随系统"是给晕动症用户的默认值；
     * 但有人纯粹是系统被优化软件关过动画、自己却想看着舒服，所以得能手动打开。
     */
    reduceMotion: 'system',
    /**
     * 启动卡上轮播用的图（M23，照 KAMUCL 的 launchImages）。
     * 空 = 就用内置那张风景图（等于不轮播）。
     * 【为什么不内置几张】图片要么自己拍、要么买授权，不能随手从网上抓；
     * 所以这条路交给用户：把自己的截图/壁纸挑进来，首页那张大卡就会轮着换。
     */
    heroImages: [],
    /** 启动卡轮播开关（默认开；只有一张图时开着也不换） */
    heroCarousel: true,
    /** 轮播顺序：'order' 按顺序 / 'random' 随机 */
    heroOrder: 'order'
  },
  /**
   * 联机。现在只剩樱花内网穿透那套（M15）：访问密钥、隧道 ID、frpc 路径、本地端口。
   * （以前的"房间码联机"走 EasyTier，2026-10-13 整套删掉了。）
   */
  online: {
    /** 樱花内网穿透那套（M15）：访问密钥、隧道 ID、frpc 路径、本地端口 */
    frp: { accessKey: '', tunnelId: '', exePath: '', localPort: 25565 }
  },
  /**
   * AI 助手（M22）。用户自己填自己的 Key，毛球只管存和发。
   * 【key 存的是**加密后**的串】用 Windows 自带的 safeStorage 加密（见 ai.js），
   * 明文绝不落盘——配置文件是纯文本，谁打开都看得见。
   */
  ai: {
    /** 接口地址（OpenAI 兼容的那套；默认智谱的，因为那个模型**免费**） */
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    /**
     * 用哪个模型（默认智谱 GLM-4-Flash-250414：**免费**、128K、中文好、一直很稳）。
     * 【2026-10-09 实测】免费模型的情况（拿用户自己的 Key 打真接口试出来的）：
     *   glm-4.7-flash      免费，但**经常挤不上**：平台回 429「该模型当前访问量过大」
     *   glm-4-flash-250414 免费，0.6 秒就回 ← 用这个当默认
     *   glm-4.5-flash      免费，但是"思考模型"（先输出一大段思考），而且官方说了要下线
     *   更老的 glm-4-flash 已经不在免费列表里了
     * **Key 不绑模型**：用户能随时在设置里换名字，不用重新申请。
     * 平台改名/模型拥挤是常态，**这个默认值要定期拿真 Key 试一下**。
     */
    model: 'glm-4-flash-250414',
    /** 加密后的 Key（空 = 还没填，那就只用本地规则库） */
    keyEncrypted: '',
    /** 界面用哪种：local = 本地规则库；api = 用用户自己的 AI */
    mode: 'local'
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
    /**
     * 游戏启动好之后，自动把毛球关掉（M23，照 KAMUCL 的 closeAfterLaunch）。
     * 默认关——留着窗口才能看日志和四格状态，需要的用户自己勾。
     * 游戏是 detached 起的，关掉启动器不影响它。
     */
    closeAfterLaunch: false,
    /** 手动指定的 Java 路径。空 = 自动找（按版本要求挑） */
    javaPath: '',
    /**
     * 自动检测并下载所需 Java（默认开）。
     * 关掉之后**绝不下那个 200 MB 的运行时**，只在本机已有的里面找——
     * 有的用户的网按流量算、或者就是不想让启动器往硬盘里塞东西。
     */
    autoJava: true,
    /**
     * 用户自己"添加"进来的 Java。
     * 【注意】"移除"只是把它从这份名单里划掉，**绝不动硬盘上的文件**——
     * 那是人家自己装的 Java，可能别的程序还在用。
     */
    extraJavaPaths: [],
    /** 上次启动的版本，下次打开软件默认选它 */
    lastVersion: '',
    /**
     * 帮哪个游戏目录设过中文（存的是目录路径）。
     * 只设一次——之后用户自己在游戏里改了就永远不再干预（见 launch.js）。
     * 【为什么记的是路径而不是"是/否"】开了版本隔离后，游戏目录会变成
     * versions\<版本号>\，"设过了"这件事要按目录各算各的，
     * 否则隔离后的新目录会被漏掉，游戏又变回英文
     */
    languageAppliedDirs: [],
    /** 老配置里那个单值字段，读的时候还认，不再写 */
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
      launch: {
        ...DEFAULTS.launch,
        ...(raw.launch || {}),
        // 数组这一项单独过一遍：配置文件是个文本文件，用户（或者别的什么程序）
        // 可能把它改成别的类型，直接透传下去会让下面的 for...of 炸掉
        extraJavaPaths: Array.isArray((raw.launch || {}).extraJavaPaths)
          ? (raw.launch || {}).extraJavaPaths.filter((one) => typeof one === 'string' && one)
          : []
      },
      download: { ...DEFAULTS.download, ...(raw.download || {}) },
      gameDirs: {
        // 老配置文件里根本没有 gameDirs 这一项，读出来就是空的
        known: Array.isArray(dirs.known) ? dirs.known.filter((d) => typeof d === 'string' && d) : [],
        lastPackDir: typeof dirs.lastPackDir === 'string' ? dirs.lastPackDir : ''
      },
      online: {
        // 只合 frp 一层。老配置里那些 EasyTier 的 code/role/version 直接丢掉
        // （那套联机 2026-10-13 删了）。
        frp: { ...DEFAULTS.online.frp, ...(((raw.online) || {}).frp || {}) }
      },
      look: { ...DEFAULTS.look, ...((raw.look) || {}) },
      ai: { ...DEFAULTS.ai, ...((raw.ai) || {}) }
    }
  } catch {
    return {
      ...DEFAULTS,
      launch: { ...DEFAULTS.launch },
      download: { ...DEFAULTS.download },
      gameDirs: { known: [], lastPackDir: '' },
      online: { ...DEFAULTS.online },
      look: { ...DEFAULTS.look },
      ai: { ...DEFAULTS.ai }
    }
  }
}

/** 同时下几个文件（1-32，默认 16）。网络不好时调小能稳一点 */
function downloadConcurrency() {
  const value = Number(readConfig().download?.concurrency)
  // 默认 16（M23，对齐 KAMUCL 的 downloadLimits）。
  // 【为什么从 8 提到 16】Mojang 和 Modrinth 的 CDN 是**按连接**限速的，
  // 不是按总带宽——多开几个连接总速度能翻一倍上下。
  // 但也不能无限加：连接太多小文件会互相抢，而且容易被当成异常流量。
  if (!Number.isFinite(value) || value <= 0) return 16
  return Math.min(32, Math.max(1, Math.round(value)))
}

/** 下载限速（KB/s，0 = 不限）。单位是 KB，不是 KB/s 之外的什么奇怪东西 */
function downloadSpeedLimitKB() {
  const value = Number(readConfig().download?.speedLimitKB)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(1024 * 100, Math.round(value))
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
// ——————————————————————————————————————————————
// Java 名单（M20）
// ——————————————————————————————————————————————

/** 两个"java.exe 的路径"是不是同一个（大小写、斜杠方向都不计较） */
function sameJavaPath(a, b) {
  if (!a || !b) return false
  try {
    return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase()
  } catch {
    return String(a).toLowerCase() === String(b).toLowerCase()
  }
}

/**
 * 把用户挑的 Java 记进名单（已经在名单里就不重复加）。
 * @returns {string[]} 加完之后的整份名单
 */
function addExtraJava(exePath) {
  const list = [...(readConfig().launch.extraJavaPaths || [])]
  if (list.some((one) => sameJavaPath(one, exePath))) return list
  list.push(String(exePath))
  writeConfig({ launch: { extraJavaPaths: list } })
  return list
}

/**
 * 从名单里划掉一个。
 *
 * 【只是"划掉名字"，绝不动硬盘上的文件】那是用户自己装的 Java，
 * 别的程序（甚至别的启动器）可能还在用它。顺手删掉就是闯祸。
 *
 * @returns {string[]} 划完之后的整份名单
 */
function removeExtraJava(exePath) {
  const list = (readConfig().launch.extraJavaPaths || []).filter(
    (one) => !sameJavaPath(one, exePath)
  )
  writeConfig({ launch: { extraJavaPaths: list } })
  return list
}

function writeConfig(patch) {
  const config = readConfig()
  const next = {
    ...config,
    ...patch,
    launch: { ...config.launch, ...(patch.launch || {}) },
    gameDirs: { ...config.gameDirs, ...(patch.gameDirs || {}) },
    online: { ...config.online, ...(patch.online || {}) },
    microsoft: { ...config.microsoft, ...(patch.microsoft || {}) },
    look: { ...config.look, ...(patch.look || {}) }
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
 * @param {string} key **版本在配置里的键**（`versionKey(dir, id)` 算出来的那个），
 *   不是裸版本号。默认目录里的版本，键恰好就是版本号；别的目录里的是
 *   `<目录>|<版本号>`。传错不会报错、只会读到"没有这个版本的单独设置"，
 *   所以调用点请一律用 `settings.versionKey(dir, id)` 现算，别自己拼。
 * @returns {{memoryMB: number, windowWidth: number, windowHeight: number,
 *            isolation: boolean, overridden: {memoryMB: boolean, window: boolean, isolation: boolean}}}
 */
function effectiveLaunchSettings(key) {
  const override = (readConfig().versionSettings || {})[key] || {}
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
  downloadConcurrency,
  downloadSpeedLimitKB,
  knownGameDirs,
  rememberGameDir,
  validateGameDir,
  resolveChosenDir,
  versionKey,
  parseVersionKey,
  addExtraJava,
  removeExtraJava,
  sameJavaPath
}

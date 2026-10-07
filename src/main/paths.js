// 毛球 — 所有目录路径，集中在这一个文件里
//
// 【为什么要把路径集中管理】
// 这个软件要碰的目录很多：配置、缓存、游戏目录、版本、存档、Mod……
// 如果每处代码自己拼一遍路径，改起来就会漏掉一两处，
// 而且将来加"多游戏目录"之类的功能时会很难改。
// 所以统一在这里定义，别处一律调这里的方法。

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

// ——————————————————————————————————————————————
// 启动器自己的目录
// ——————————————————————————————————————————————

/** 配置目录：%APPDATA%\毛球\ */
function configDir() {
  return app.getPath('userData')
}

/** 缓存目录。放版本清单这类"随时可以重新下"的东西 */
function cacheDir() {
  return path.join(configDir(), 'cache')
}

/** 版本清单的缓存文件 */
function manifestCacheFile() {
  return path.join(cacheDir(), 'version_manifest_v2.json')
}

/** 配置文件（账号、启动设置都在这） */
function settingsFile() {
  return path.join(configDir(), 'config.json')
}

/** 启动器自己的日志目录。每次启动游戏的完整输出存一份，方便排查 */
function logsDir() {
  return path.join(configDir(), 'logs')
}

/** 备份放在这儿（一键备份生成的压缩包/文件夹都在里面） */
function backupsDir() {
  return path.join(configDir(), 'backups')
}

/**
 * 联机组件（EasyTier）放在这儿：%APPDATA%\毛球\easytier\
 *
 * 【为什么放启动器自己的目录，不放进游戏目录】它跟游戏装在哪没关系，
 * 是"启动器级"的工具（和 Java 运行时不一样——那个是每个游戏目录各一份也行）。
 * 放这儿的好处：卸载重装游戏目录不会把它弄丢；换电脑时备份也只会带一份。
 */
function easytierRoot() {
  return path.join(configDir(), 'easytier')
}

/** 某一个版本的 EasyTier 解在这儿 */
function easytierDir(version) {
  return path.join(easytierRoot(), version)
}

/**
 * authlib-injector 存哪儿（M16.2 外置登录用）。
 * 它是个 java 小代理，不跟某一个游戏版本绑定，所以不同版本放在一个目录里。
 */
function authlibRoot() {
  return path.join(configDir(), 'authlib-injector')
}

/** 某个版本的 authlib-injector.jar 在哪儿 */
function authlibJarPath(version) {
  return path.join(authlibRoot(), `authlib-injector-${String(version).replace(/^v/, '')}.jar`)
}

// ——————————————————————————————————————————————
// 游戏目录
// ——————————————————————————————————————————————

/**
 * 默认游戏目录：%APPDATA%\.minecraft——Minecraft 的标准位置，官方启动器也用这儿。
 *
 * 【为什么单独有这么个"常量"】它是**永不漂移的锚点**：
 * 配置里那些老数据（版本显示名、备注、单独设置）都是按"默认目录里的版本"记的
 * （见 settings.versionKey 的说明）。要是这个锚点会变，老数据就会被错认成
 * 别的目录里的同名版本。
 *
 * 另外它不能从配置里读——paths.js 去 require settings.js 会成环
 * （settings.js 已经 require 了 paths.js）。好在它本来就该是固定的。
 */
function defaultGameDir() {
  return path.join(app.getPath('appData'), '.minecraft')
}

/**
 * 游戏装在哪。
 *
 * **必须用英文路径**：老版本的 Java 和部分 Mod 对中文路径处理不好，
 * 会报一些莫名其妙的错。
 *
 * @param {string} [dir] 指定一个别的游戏目录（M11.4 起支持"整合包装到 D 盘"这种事）。
 *   **不传 = 默认目录**。
 *
 * 【为什么"不传就用默认目录"，而不是"不传就用上次选的目录"】
 * 忘传参数时，两种做法后果差很远：
 *   · 用默认目录 → 最坏是"这个版本不在"、删除被拒——**错得看得见**（fail-closed）
 *   · 用"当前目录" → 悄悄跑到另一个目录上干活，装了半天发现装歪了，甚至写坏数据
 * 而且安装/下载是异步长跑，中途要是那个"当前目录"被改了，写到一半就换地方了。
 * 所以：**每个调用点自己负责把 dir 传对**，不搞全局可变状态。
 */
function gameDir(dir) {
  return dir || defaultGameDir()
}

/** 两个路径是不是同一个目录（大小写、多余的斜杠、.. 都算过） */
function sameDir(a, b) {
  if (!a || !b) return false
  return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase()
}

function versionsDir(dir) {
  return path.join(gameDir(dir), 'versions')
}

function librariesDir(dir) {
  return path.join(gameDir(dir), 'libraries')
}

function assetsDir(dir) {
  return path.join(gameDir(dir), 'assets')
}

/**
 * Java 运行时。
 *
 * 【注意：这个不跟游戏目录走，永远在默认目录里】Java 是"启动器级"的东西，
 * 跟游戏装在哪没关系。要是每个游戏目录都备一份，用户每换个目录就白下 180 MB。
 * 所以 dir 参数照样收（保持调用姿势一致），但内部固定用默认目录。
 */
function runtimeDir() {
  return path.join(defaultGameDir(), 'runtime')
}

/**
 * 游戏的设置文件（语言、音量、视距这些都在这）。
 * 位置由游戏自己定，我们只在"首次启动帮设中文"时动一行，别的不碰。
 *
 * 注意：开了版本隔离后，"游戏目录"会变成 versions\<版本号>\，
 * 这个文件也跟着跑那儿去了——所以调用方要把当时的游戏目录传进来。
 */
function gameOptionsFile(forGameDir) {
  return path.join(forGameDir || gameDir(), 'options.txt')
}

// ——— 玩家自己的东西（没开版本隔离时，所有版本共用这几个目录）———

function savesDir(dir) {
  return path.join(gameDir(dir), 'saves')
}

function modsDir(dir) {
  return path.join(gameDir(dir), 'mods')
}

function screenshotsDir(dir) {
  return path.join(gameDir(dir), 'screenshots')
}

function resourcepacksDir(dir) {
  return path.join(gameDir(dir), 'resourcepacks')
}

function shaderpacksDir(dir) {
  return path.join(gameDir(dir), 'shaderpacks')
}

// ——— 单个版本 ———

function versionDir(id, dir) {
  return path.join(versionsDir(dir), id)
}

function versionJsonFile(id, dir) {
  return path.join(versionDir(id, dir), `${id}.json`)
}

function versionJarFile(id, dir) {
  return path.join(versionDir(id, dir), `${id}.jar`)
}

/** 老版本要把 natives 压缩包解到这儿 */
function versionNativesDir(id, dir) {
  return path.join(versionDir(id, dir), 'natives')
}

/**
 * "装到一半"的标记文件。
 *
 * 【为什么要它】安装中途被取消（或者断电、失败）时，版本目录里可能已经有
 * 版本 JSON 和客户端 jar 了——光看这两个文件会以为"装好了"，其实资源文件
 * 还差一大截，启动起来会缺音效缺贴图。有标记文件的版本一律**不算装好**，
 * 界面上显示成"安装"而不是"已安装"，重新装一次会把剩下的补齐。
 */
function versionIncompleteMarker(id, dir) {
  return path.join(versionDir(id, dir), '.incomplete')
}

/**
 * log4j 的日志配置文件。
 * 位置是游戏规定的（assets\log_configs\），版本 JSON 里的
 * logging.client 指向它，游戏启动时要求这个文件在。
 */
function logConfigFile(id, dir) {
  return path.join(assetsDir(dir), 'log_configs', id)
}

// ——————————————————————————————————————————————
// 工具
// ——————————————————————————————————————————————

/** 确保目录存在。已经存在也不会报错 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * 某个版本装好了吗。
 *
 * 【注意"继承版"】装了 Mod 加载器的版本（Fabric / Forge）**自己没有客户端 jar**，
 * 它继承原版的。所以判断规则是：
 *   · 有"装到一半"标记 → 没装好
 *   · 有版本 JSON + 自己的 jar → 装好了（普通版本）
 *   · 没有自己的 jar，但写着继承谁 → 顺着往上找，找到那一层有 jar 就算装好
 * （M10 实测发现：一开始只认"有自己的 jar"，结果 Fabric 版本装完了
 *   却不出现在版本列表里——因为它本来就不该有自己的 jar）
 */
function isVersionInstalled(id, dir) {
  let current = String(id)

  for (let depth = 0; depth < 5; depth++) {
    if (fs.existsSync(versionIncompleteMarker(current, dir))) return false

    const jsonFile = versionJsonFile(current, dir)
    if (!fs.existsSync(jsonFile)) return false

    // 自己有 jar → 这层就是本体，装好了
    if (fs.existsSync(versionJarFile(current, dir))) return true

    let json
    try {
      json = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
    } catch {
      return false
    }

    // 没有 jar 也没继承谁 → 文件不全
    if (!json.inheritsFrom) return false

    current = String(json.inheritsFrom)
  }

  return false
}

/**
 * 列出**某一个**游戏目录里已装的所有版本（按目录名）。
 * @param {string} [dir] 不传 = 默认目录
 */
function listInstalledVersions(dir) {
  try {
    return fs
      .readdirSync(versionsDir(dir), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => isVersionInstalled(id, dir))
  } catch {
    return []
  }
}

/**
 * 列出**所有**已知游戏目录里的版本，每项带上它在哪个目录。
 *
 * 启动页那个版本列表用它——几个目录的版本混在一起显示，各标各的目录。
 *
 * @param {string[]} dirs 目录清单（默认目录放第一个）；空/不传 = 只算默认目录
 * @returns {Array<{id: string, dir: string, isDefault: boolean}>}
 */
function listAllInstalledVersions(dirs) {
  const list = Array.isArray(dirs) && dirs.length > 0 ? dirs : [defaultGameDir()]
  const out = []
  const seen = []

  for (const raw of list) {
    const dir = gameDir(raw)
    // 同一个目录写了两遍（大小写不同之类）只算一次
    if (seen.some((one) => sameDir(one, dir))) continue
    seen.push(dir)

    for (const id of listInstalledVersions(dir)) {
      out.push({ id, dir, isDefault: sameDir(dir, defaultGameDir()) })
    }
  }

  return out
}

module.exports = {
  configDir,
  cacheDir,
  manifestCacheFile,
  settingsFile,
  logsDir,
  backupsDir,
  easytierRoot,
  easytierDir,
  authlibRoot,
  authlibJarPath,
  defaultGameDir,
  sameDir,
  listAllInstalledVersions,
  gameDir,
  versionsDir,
  librariesDir,
  assetsDir,
  runtimeDir,
  versionDir,
  versionJsonFile,
  versionJarFile,
  versionNativesDir,
  versionIncompleteMarker,
  logConfigFile,
  gameOptionsFile,
  savesDir,
  modsDir,
  screenshotsDir,
  resourcepacksDir,
  shaderpacksDir,
  ensureDir,
  isVersionInstalled,
  listInstalledVersions
}

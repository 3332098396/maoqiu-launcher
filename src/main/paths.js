// MC启动器 — 所有目录路径，集中在这一个文件里
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

/** 配置目录：%APPDATA%\MC启动器\ */
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

// ——————————————————————————————————————————————
// 游戏目录
// ——————————————————————————————————————————————

/**
 * 游戏装在哪。
 *
 * 默认是 %APPDATA%\.minecraft——这是 Minecraft 的标准位置，官方启动器也用这儿。
 *
 * **必须用英文路径**：老版本的 Java 和部分 Mod 对中文路径处理不好，
 * 会报一些莫名其妙的错。所以就算软件自己装在中文目录下，
 * 游戏文件也放这儿。
 *
 * （M6 会做成可以在设置里改。）
 */
function gameDir() {
  return path.join(app.getPath('appData'), '.minecraft')
}

function versionsDir() {
  return path.join(gameDir(), 'versions')
}

function librariesDir() {
  return path.join(gameDir(), 'libraries')
}

function assetsDir() {
  return path.join(gameDir(), 'assets')
}

/** Java 运行时。放在这儿可以和使用同一个游戏目录的其他启动器共用 */
function runtimeDir() {
  return path.join(gameDir(), 'runtime')
}

// ——— 单个版本 ———

function versionDir(id) {
  return path.join(versionsDir(), id)
}

function versionJsonFile(id) {
  return path.join(versionDir(id), `${id}.json`)
}

function versionJarFile(id) {
  return path.join(versionDir(id), `${id}.jar`)
}

/** 老版本要把 natives 压缩包解到这儿 */
function versionNativesDir(id) {
  return path.join(versionDir(id), 'natives')
}

// ——————————————————————————————————————————————
// 工具
// ——————————————————————————————————————————————

/** 确保目录存在。已经存在也不会报错 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** 某个版本装好了吗（有版本 JSON 和客户端 jar 就算装好了） */
function isVersionInstalled(id) {
  return fs.existsSync(versionJsonFile(id)) && fs.existsSync(versionJarFile(id))
}

/** 列出本机已装的所有版本（按目录名） */
function listInstalledVersions() {
  try {
    return fs
      .readdirSync(versionsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => isVersionInstalled(id))
  } catch {
    return []
  }
}

module.exports = {
  configDir,
  cacheDir,
  manifestCacheFile,
  gameDir,
  versionsDir,
  librariesDir,
  assetsDir,
  runtimeDir,
  versionDir,
  versionJsonFile,
  versionJarFile,
  versionNativesDir,
  ensureDir,
  isVersionInstalled,
  listInstalledVersions
}

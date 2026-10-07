// 毛球 — 版本管理（M6.1）
//
// 干四件事：列出已装版本（带自定义名字）、改名/写备注、打开四个文件夹、删版本。
//
// 【改名字为什么不改文件夹名】
// 版本文件夹的名字就是版本号（比如 26.3），游戏自己的版本 JSON 里也写着它。
// 改了文件夹名，游戏就找不到自己了。所以"改名"只是启动器这边显示的名字——
// 就像给联系人存个备注名，电话号码本身不动。
//
// 【删除是这个软件里唯一会"删东西"的操作】
// 所以这里挡了三道，见 deleteVersion 的注释。宁可多做几道检查。

const fs = require('node:fs')
const path = require('node:path')
const { shell } = require('electron')
const paths = require('./paths')
const settings = require('./settings')

/** 名字和备注最多存多长——不是技术限制，是防止界面被撑爆 */
const MAX_NAME = 40
const MAX_NOTE = 200

/** 已装版本 + 用户起的显示名/备注 */
function listVersions() {
  const custom = settings.readConfig().versions || {}
  return paths.listInstalledVersions().map((id) => ({
    id,
    name: custom[id]?.name || '',
    note: custom[id]?.note || ''
  }))
}

/** id → { name, note } 的表，界面用起来方便 */
function versionInfoMap() {
  const custom = settings.readConfig().versions || {}
  const map = {}
  for (const id of paths.listInstalledVersions()) {
    map[id] = { name: custom[id]?.name || '', note: custom[id]?.note || '' }
  }
  return map
}

/**
 * 改显示名 / 备注。两个都留空就等于恢复成默认（显示版本号）。
 * @returns {{ok: boolean, version?: object, error?: string}}
 */
function updateVersion(id, { name, note } = {}) {
  if (!paths.isVersionInstalled(id)) {
    return { ok: false, error: '这个版本已经不在了' }
  }

  const trimmedName = String(name ?? '').trim().slice(0, MAX_NAME)
  const trimmedNote = String(note ?? '').trim().slice(0, MAX_NOTE)

  const config = settings.readConfig()
  const versions = { ...(config.versions || {}) }

  if (!trimmedName && !trimmedNote) {
    delete versions[id]
  } else {
    versions[id] = { name: trimmedName, note: trimmedNote }
  }

  try {
    settings.writeConfig({ versions })
  } catch (error) {
    return { ok: false, error: `存不下来：${error.message}` }
  }

  return { ok: true, version: { id, name: trimmedName, note: trimmedNote } }
}

/** 这个版本自己的文件夹有多大（只看这一个文件夹，很快） */
function versionSize(id) {
  let total = 0

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch {
          // 读不到某个文件的大小就跳过，不影响总数
        }
      }
    }
  }

  try {
    walk(paths.versionDir(id))
  } catch {
    // 目录不在就是 0
  }
  return total
}

/** 这个版本有没有开隔离（它自己设过就用它自己的，没设过跟随全局） */
function isIsolated(id) {
  return settings.effectiveLaunchSettings(id).isolation
}

/** 某个版本单独设过的启动设置（空对象 = 全都跟随全局） */
function getVersionSettings(id) {
  const all = settings.readConfig().versionSettings || {}
  return all[id] || {}
}

/**
 * 改某个版本的单独设置。没传的项不动，传 null 表示"这一项改回跟随全局"。
 *
 * @param {{memoryMB?: number|null, window?: {width: number, height: number}|null,
 *          isolation?: boolean|null}} patch
 * @returns {{ok: boolean, settings?: object, error?: string}}
 */
function setVersionSettings(id, patch = {}) {
  if (!paths.isVersionInstalled(id)) return { ok: false, error: '这个版本已经不在了' }

  const config = settings.readConfig()
  const all = { ...(config.versionSettings || {}) }
  const current = { ...(all[id] || {}) }

  if (patch.memoryMB !== undefined) {
    if (patch.memoryMB === null) {
      delete current.memoryMB
    } else {
      const check = settings.validateMemoryMB(Number(patch.memoryMB))
      if (!check.ok) return check
      current.memoryMB = Math.round(Number(patch.memoryMB))
    }
  }

  if (patch.window !== undefined) {
    if (patch.window === null) {
      delete current.windowWidth
      delete current.windowHeight
    } else {
      const check = settings.validateWindow(Number(patch.window.width), Number(patch.window.height))
      if (!check.ok) return check
      current.windowWidth = Math.round(Number(patch.window.width))
      current.windowHeight = Math.round(Number(patch.window.height))
    }
  }

  if (patch.isolation !== undefined) {
    if (patch.isolation === null) delete current.isolation
    else current.isolation = Boolean(patch.isolation)
  }

  // 一项都不剩就整条删掉，别在配置里留空壳
  if (Object.keys(current).length === 0) delete all[id]
  else all[id] = current

  try {
    settings.writeConfig({ versionSettings: all })
  } catch (error) {
    return { ok: false, error: `存不下来：${error.message}` }
  }

  return { ok: true, settings: current }
}

/**
 * 某个版本的四个文件夹在哪。
 *
 * 【存档/Mod/截图的区别】开启版本隔离后，它们在版本目录里面（各版本互不干扰）；
 * 关着的时候在游戏目录里（所有版本共用）。
 * 隔离开没开，**按这个版本自己的设置算**（它没单独设过才看全局）。
 */
function folderFor(id, which) {
  const isolated = isIsolated(id)
  const versionDir = paths.versionDir(id)

  switch (which) {
    case 'version':
      return versionDir
    case 'saves':
      return isolated ? path.join(versionDir, 'saves') : paths.savesDir()
    case 'mods':
      return isolated ? path.join(versionDir, 'mods') : paths.modsDir()
    case 'screenshots':
      return isolated ? path.join(versionDir, 'screenshots') : paths.screenshotsDir()
    default:
      return null
  }
}

/**
 * 在文件资源管理器里打开某个文件夹。
 * 文件夹不存在就先建出来——点了没反应会被当成软件坏了。
 */
async function openFolder(id, which) {
  if (!paths.isVersionInstalled(id)) return { ok: false, error: '这个版本已经不在了' }

  const dir = folderFor(id, which)
  if (!dir) return { ok: false, error: '不认识的文件夹' }

  try {
    paths.ensureDir(dir)
    const message = await shell.openPath(dir)
    return message ? { ok: false, error: message } : { ok: true, dir }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * 删除一个版本。
 *
 * 【这是唯一会删东西的操作，挡三道】
 *   ① 路径必须真的在 游戏目录\versions\ 里面
 *      （防住 ../ 之类的花招——压缩包那一课的教训）
 *   ② 目标必须"看起来像个版本目录"（里面有版本 JSON 或客户端 jar），
 *      免得手滑指到一个别的文件夹
 *   ③ 界面上必须已经二次确认过（界面负责，这里再核一遍目标还在不在）
 *
 * 删掉的只是这个版本自己的文件夹：版本 JSON、客户端 jar、natives。
 * 共享的库文件、资源文件，以及其他版本，都不在这个文件夹里，不会被动到。
 *
 * @returns {{ok: boolean, sizeBytes?: number, error?: string}}
 */
function deleteVersion(id) {
  const root = path.resolve(paths.versionsDir())
  const target = path.resolve(paths.versionDir(id))

  if (target === root) return { ok: false, error: '路径不对，拒绝删除' }
  if (!target.startsWith(root + path.sep)) {
    return { ok: false, error: '这个路径不在版本目录里，拒绝删除' }
  }
  if (!fs.existsSync(target)) return { ok: false, error: '这个版本已经不在了' }

  const looksLikeVersion =
    fs.existsSync(paths.versionJsonFile(id)) || fs.existsSync(paths.versionJarFile(id))
  if (!looksLikeVersion) {
    return { ok: false, error: '这个文件夹看起来不是版本目录，拒绝删除' }
  }

  const sizeBytes = versionSize(id)

  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch (error) {
    return { ok: false, error: `删不掉：${error.message}` }
  }

  // 顺手把它的显示名/备注也清掉，别在配置里留垃圾
  try {
    const config = settings.readConfig()
    const versions = { ...(config.versions || {}) }
    if (versions[id]) {
      delete versions[id]
      settings.writeConfig({ versions })
    }
  } catch {
    // 清不掉不影响删除本身
  }

  return { ok: true, sizeBytes }
}

module.exports = {
  listVersions,
  versionInfoMap,
  updateVersion,
  versionSize,
  openFolder,
  deleteVersion,
  folderFor,
  isIsolated,
  getVersionSettings,
  setVersionSettings
}

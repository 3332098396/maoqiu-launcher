// 毛球 — 版本管理（M6.1，M11.4 起支持多个游戏目录）
//
// 干四件事：列出已装版本（带自定义名字）、改名/写备注、打开四个文件夹、删版本。
//
// 【改名字为什么不改文件夹名】
// 版本文件夹的名字就是版本号（比如 26.3），游戏自己的版本 JSON 里也写着它。
// 改了文件夹名，游戏就找不到自己了。所以"改名"只是启动器这边显示的名字——
// 就像给联系人存个备注名，电话号码本身不动。
//
// 【M11.4 加了"目录"这一维之后，处处要问两件事】
//   "哪个版本" （id）  +  "它在哪个游戏目录" （dir）
// 函数一律把 dir 放在参数表最后，不传 = 默认目录（%APPDATA%\.minecraft）。
// 跟版本走的数据（名字、备注、单独设置）都存在 settings.versionKey(dir, id) 那个键上，
// 两个目录里的同名版本才不会串台。
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

/**
 * 已装版本 + 用户起的显示名/备注。
 *
 * 跨**所有认得的游戏目录**列，每项带着"它在哪个目录"——启动页那个列表就是它渲染的。
 *
 * @param {string[]} [dirs] 要列哪些目录；不传 = 默认目录
 * @returns {Array<{id, dir, key, isDefault, name, note, loader, base}>}
 */
function listAllVersions(dirs) {
  const custom = settings.readConfig().versions || {}

  return paths.listAllInstalledVersions(dirs).map(({ id, dir, isDefault }) => {
    const key = settings.versionKey(dir, id)
    return {
      id,
      dir,
      key,
      isDefault,
      name: custom[key]?.name || '',
      note: custom[key]?.note || '',
      icon: custom[key]?.icon || '',
      category: custom[key]?.category || '',
      favorite: Boolean(custom[key]?.favorite),
      lastPlayed: Number(custom[key]?.lastPlayed) || 0,
      loader: loaderName(id, dir),
      type: versionType(id, dir),
      base: baseGameVersion(id, dir)
    }
  })
}

/**
 * 这个版本是哪种版本：正式版 / 快照 / 远古版。
 *
 * 版本 JSON 里那个 `type` 字段就是它（官方给的），原样读出来。
 * 界面上翻成中文显示——用户看到 "26.4-snapshot-3" 这种名字，
 * 光看数字分不出是正式版还是快照。
 */
function versionType(id, dir) {
  try {
    const json = JSON.parse(fs.readFileSync(paths.versionJsonFile(id, dir), 'utf8'))
    const type = String(json.type || '').trim()
    if (type === 'release' || type === 'snapshot' || type === 'old_beta' || type === 'old_alpha') {
      return type
    }
  } catch {
    // 读不出来就当不知道
  }
  return ''
}

/** 这个版本装了什么 Mod 加载器（翻它的版本 JSON 里的库文件） */
function loaderName(id, dir) {
  try {
    const json = JSON.parse(fs.readFileSync(paths.versionJsonFile(id, dir), 'utf8'))
    const names = (json.libraries || []).map((lib) => String(lib.name || '').toLowerCase())

    if (names.some((n) => n.includes('fabric-loader'))) return 'Fabric'
    if (names.some((n) => n.includes('neoforge'))) return 'NeoForge'
    if (names.some((n) => n.includes('forge'))) return 'Forge'
    if (names.some((n) => n.includes('optifine'))) return 'OptiFine'
  } catch {
    // 读不出来就当没装加载器
  }
  return ''
}

/** 顺着继承往上找，这个版本底下的"游戏版本"是哪个（社区网站只认它） */
function baseGameVersion(id, dir) {
  let current = String(id)

  for (let depth = 0; depth < 5; depth++) {
    try {
      const json = JSON.parse(fs.readFileSync(paths.versionJsonFile(current, dir), 'utf8'))
      if (!json.inheritsFrom) return current
      current = String(json.inheritsFrom)
    } catch {
      return current
    }
  }
  return current
}

/**
 * id → 信息的表，界面用起来方便。
 *
 * 【键是 versionKey 而不是版本号】两个目录里都有 "26.3" 时，光用版本号当键会打架。
 * 默认目录里的版本键就是版本号本身，所以老的界面代码看着"差不多还是那样"。
 */
function versionInfoMap(dirs) {
  const custom = settings.readConfig().versions || {}
  const map = {}

  for (const one of listAllVersions(dirs)) {
    map[one.key] = {
      id: one.id,
      dir: one.dir,
      key: one.key,
      isDefault: one.isDefault,
      name: one.name,
      note: one.note,
      icon: one.icon,
      category: one.category,
      favorite: one.favorite,
      loader: one.loader,
      type: one.type,
      base: one.base
    }
  }

  return map
}

/**
 * 改显示名 / 备注。两个都留空就等于恢复成默认（显示版本号）。
 * @returns {{ok: boolean, version?: object, error?: string}}
 */
function updateVersion(id, { name, note, icon, category, favorite } = {}, dir) {
  if (!paths.isVersionInstalled(id, dir)) {
    return { ok: false, error: '这个版本已经不在了' }
  }

  const trimmedName = String(name ?? '').trim().slice(0, MAX_NAME)
  const trimmedNote = String(note ?? '').trim().slice(0, MAX_NOTE)
  // 图标就一个字符（emoji 或字母），多了会撑破列表
  const trimmedIcon = [...String(icon ?? '').trim()].slice(0, 2).join('')
  const trimmedCategory = String(category ?? '').trim().slice(0, 12)
  const star = Boolean(favorite)
  const key = settings.versionKey(dir, id)

  const config = settings.readConfig()
  const versions = { ...(config.versions || {}) }

  // 一样都没填就整条删掉，别在配置里留空壳
  const empty = !trimmedName && !trimmedNote && !trimmedIcon && !trimmedCategory && !star
  if (empty) {
    delete versions[key]
  } else {
    versions[key] = {
      name: trimmedName,
      note: trimmedNote,
      icon: trimmedIcon,
      category: trimmedCategory,
      favorite: star
    }
  }

  try {
    settings.writeConfig({ versions })
  } catch (error) {
    return { ok: false, error: `存不下来：${error.message}` }
  }

  return {
    ok: true,
    version: {
      id,
      dir,
      key,
      name: trimmedName,
      note: trimmedNote,
      icon: trimmedIcon,
      category: trimmedCategory,
      favorite: star
    }
  }
}

/**
 * 记一下这个版本什么时候玩的（M14.3：版本页要显示最近游玩）。
 *
 * 【为什么单独有这么个函数】改名/备注那条路（updateVersion）要求传名字和备注，
 * 这里只想戳一个时间戳，走那条路会把名字冲掉。
 */
function markPlayed(id, dir) {
  const key = settings.versionKey(dir, id)
  const config = settings.readConfig()
  const versions = { ...(config.versions || {}) }

  versions[key] = { ...(versions[key] || {}), lastPlayed: Date.now() }
  settings.writeConfig({ versions })
}

/** 这个版本自己的文件夹有多大（只看这一个文件夹，很快） */
function versionSize(id, dir) {
  let total = 0

  const walk = (target) => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const full = path.join(target, entry.name)
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
    walk(paths.versionDir(id, dir))
  } catch {
    // 目录不在就是 0
  }
  return total
}

/** 这个版本有没有开隔离（它自己设过就用它自己的，没设过跟随全局） */
function isIsolated(id, dir) {
  return settings.effectiveLaunchSettings(settings.versionKey(dir, id)).isolation
}

/** 某个版本单独设过的启动设置（空对象 = 全都跟随全局） */
function getVersionSettings(id, dir) {
  const all = settings.readConfig().versionSettings || {}
  return all[settings.versionKey(dir, id)] || {}
}

/**
 * 改某个版本的单独设置。没传的项不动，传 null 表示"这一项改回跟随全局"。
 *
 * @param {{memoryMB?: number|null, window?: {width: number, height: number}|null,
 *          isolation?: boolean|null}} patch
 * @returns {{ok: boolean, settings?: object, error?: string}}
 */
function setVersionSettings(id, patch = {}, dir) {
  if (!paths.isVersionInstalled(id, dir)) return { ok: false, error: '这个版本已经不在了' }

  const key = settings.versionKey(dir, id)
  const config = settings.readConfig()
  const all = { ...(config.versionSettings || {}) }
  const current = { ...(all[key] || {}) }

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

  // 这个版本单独用哪个 Java（M20）：
  //   null  = 改回"跟随全局"
  //   ''    = 自动选择（按这个版本的要求在本机挑，必要时自动下载）
  //   路径  = 就用这个
  if (patch.javaPath !== undefined) {
    if (patch.javaPath === null) {
      delete current.javaPath
    } else {
      const value = String(patch.javaPath || '')
      if (value && !fs.existsSync(value)) return { ok: false, error: `这个文件不在了：${value}` }
      current.javaPath = value
    }
  }

  // 一项都不剩就整条删掉，别在配置里留空壳
  if (Object.keys(current).length === 0) delete all[key]
  else all[key] = current

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
 * 关着的时候在**那个游戏目录**里（同一个目录里的版本共用）。
 * 隔离开没开，**按这个版本自己的设置算**（它没单独设过才看全局）。
 */
function folderFor(id, which, dir) {
  const isolated = isIsolated(id, dir)
  const versionDir = paths.versionDir(id, dir)

  switch (which) {
    case 'version':
      return versionDir
    // 这个版本所在的**游戏目录**本身（不是版本文件夹）。
    // 启动页那张"目录"卡片上写的就是它——没开隔离时游戏读的正是这个目录，
    // 开了隔离才会缩到 versions\<版本号>\ 里去（见下面 saves 那几行）
    case 'gamedir':
      return paths.gameDir(dir)
    case 'saves':
      return isolated ? path.join(versionDir, 'saves') : paths.savesDir(dir)
    case 'mods':
      return isolated ? path.join(versionDir, 'mods') : paths.modsDir(dir)
    case 'screenshots':
      return isolated ? path.join(versionDir, 'screenshots') : paths.screenshotsDir(dir)
    // 下面两类是 M9 加的：社区资源下好之后就放这儿
    case 'resourcepacks':
      return isolated ? path.join(versionDir, 'resourcepacks') : paths.resourcepacksDir(dir)
    case 'shaderpacks':
      return isolated ? path.join(versionDir, 'shaderpacks') : paths.shaderpacksDir(dir)
    default:
      return null
  }
}

/**
 * 在文件资源管理器里打开某个文件夹。
 * 文件夹不存在就先建出来——点了没反应会被当成软件坏了。
 */
async function openFolder(id, which, dir) {
  if (!paths.isVersionInstalled(id, dir)) return { ok: false, error: '这个版本已经不在了' }

  const target = folderFor(id, which, dir)
  if (!target) return { ok: false, error: '不认识的文件夹' }

  try {
    paths.ensureDir(target)
    const message = await shell.openPath(target)
    return message ? { ok: false, error: message } : { ok: true, dir: target }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * 删除一个版本。
 *
 * 【这是唯一会删东西的操作，挡三道】
 *   ① 路径必须真的在那个游戏目录的 versions\ 里面
 *      （防住 ../ 之类的花招——压缩包那一课的教训）
 *   ② 目标必须"看起来像个版本目录"（里面有版本 JSON 或客户端 jar），
 *      免得手滑指到一个别的文件夹
 *   ③ 界面上必须已经二次确认过（界面负责，这里再核一遍目标还在不在）
 *
 * **多目录之后第 ① 道特别要紧**：防线必须按"这个版本自己那个目录"来算，
 * 不能拿默认目录去卡——否则要么删不掉 D 盘的版本，要么路径校验形同虚设。
 *
 * 删掉的只是这个版本自己的文件夹：版本 JSON、客户端 jar、natives。
 * 共享的库文件、资源文件，以及其他版本，都不在这个文件夹里，不会被动到。
 *
 * @returns {{ok: boolean, sizeBytes?: number, error?: string}}
 */
function deleteVersion(id, dir) {
  const root = path.resolve(paths.versionsDir(dir))
  const target = path.resolve(paths.versionDir(id, dir))

  if (target === root) return { ok: false, error: '路径不对，拒绝删除' }
  if (!target.startsWith(root + path.sep)) {
    return { ok: false, error: '这个路径不在版本目录里，拒绝删除' }
  }
  if (!fs.existsSync(target)) return { ok: false, error: '这个版本已经不在了' }

  const looksLikeVersion =
    fs.existsSync(paths.versionJsonFile(id, dir)) || fs.existsSync(paths.versionJarFile(id, dir))
  if (!looksLikeVersion) {
    return { ok: false, error: '这个文件夹看起来不是版本目录，拒绝删除' }
  }

  const sizeBytes = versionSize(id, dir)

  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch (error) {
    return { ok: false, error: `删不掉：${error.message}` }
  }

  // 顺手把它的显示名/备注也清掉，别在配置里留垃圾
  try {
    const key = settings.versionKey(dir, id)
    const config = settings.readConfig()
    const versions = { ...(config.versions || {}) }
    if (versions[key]) {
      delete versions[key]
      settings.writeConfig({ versions })
    }
  } catch {
    // 清不掉不影响删除本身
  }

  return { ok: true, sizeBytes }
}

module.exports = {
  listAllVersions,
  versionInfoMap,
  loaderName,
  versionType,
  markPlayed,
  baseGameVersion,
  updateVersion,
  versionSize,
  openFolder,
  deleteVersion,
  folderFor,
  isIsolated,
  getVersionSettings,
  setVersionSettings
}

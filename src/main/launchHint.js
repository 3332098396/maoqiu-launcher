// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
//
// 毛球 — 启动前看一眼：「这个版本没装 Mod 加载器，Mods 里的 Mod 不会生效」（M28）
//
// 【为什么要管这件事】2026-10-16 用户撞的真事：他把一个 NeoForge 模组装进了
// `versions\1.21\mods\`，点「开始游戏」开的却是**原版 1.21** —— 原版压根不读 mods 文件夹，
// 游戏里当然什么都没有。游戏日志里只有一句 `Reloading ResourceManager: vanilla`，
// 普通用户不会去看，观感就是"装好了却没用"。
//
// 【这里只"查"，不"弹"】判断和弹窗分成两半：本模块只回答"要不要提示、提示什么"，
// 弹窗在主进程（`main.js` 的 `launch:precheck`，用系统的 showMessageBox）。
// 分开的好处是**探针能直接测这里的判断**，不用去点对话框。
//
// 【不许乱弹】只在三个条件同时成立时才提示：
//   ① 这个版本**没装任何加载器**（装了就不提示，Mod 反正能跑）
//   ② 它的 mods 文件夹里**确实有启用的 .jar**（空文件夹不提示）
//   ③ 用户没对这个版本说过"以后不再提示"

const fs = require('node:fs')
const path = require('node:path')

const versions = require('./versions')
const localfiles = require('./localfiles')
const settings = require('./settings')

/** 加载器代号（本地读元数据时用的写法）→ 给人看的中文名 */
const LOADER_NAMES = { neoforge: 'NeoForge', forge: 'Forge', fabric: 'Fabric', quilt: 'Quilt' }

/**
 * 最多读几个 jar 的元数据。
 * Mods 里可能有几百个 jar（整合包），每个都要解压读一遍 —— 全读会把"点开始游戏"
 * 拖慢好几秒。看**主流是哪个加载器**只要十来个样本就够，所以设个上限。
 */
const MAX_READ = 15

/** mods 文件夹里现在有几个启用的 .jar（`.jar.disabled` 不算，它不会被加载） */
function listEnabledMods(folder) {
  try {
    return fs
      .readdirSync(folder)
      .filter((name) => name.toLowerCase().endsWith('.jar'))
      .map((name) => path.join(folder, name))
  } catch {
    return []
  }
}

/** 用户对这个版本说过"以后不再提示"吗 */
function skipped(versionKey) {
  try {
    const list = settings.readConfig().launch?.loaderHintSkip
    return Array.isArray(list) && list.includes(versionKey)
  } catch {
    return false
  }
}

/**
 * 查一遍这个版本要不要提示。
 *
 * @param {string} versionId 版本号（如 `1.21`）
 * @param {string} dir 游戏目录（空字符串 = 默认目录；调用方先用 known() 规范化过）
 * @returns {{
 *   need: boolean,                    要不要弹
 *   loader: string,                   这个版本自己装的加载器（空 = 没装）
 *   gameVersion: string,              它底下的原版版本号（如 `1.21`）
 *   modCount: number,                 启用的 Mod 个数
 *   byLoader: Record<string, number>, 每个加载器各要几个
 *   wantedLoader: string,             大多数 Mod 要的那个加载器（中文名；认不出来是空）
 *   suggestion: { id: string, dir: string, key: string, loader: string } | null,
 *                                     同 MC 版本、加载器正好对得上的那个实例（没有就是 null）
 *   skip: boolean                     用户说过不再提示吗
 * }}
 */
function inspect(versionId, dir) {
  const out = {
    need: false,
    loader: '',
    gameVersion: '',
    modCount: 0,
    byLoader: {},
    wantedLoader: '',
    wantedLoaderKey: '',
    suggestion: null,
    skip: false
  }

  if (!versionId) return out

  // ① 装了加载器的版本不用管 —— Mod 能跑
  out.loader = versions.loaderName(versionId, dir)
  if (out.loader) return out

  // 【为什么用 folderFor 而不是 content.targetDir】它返回的就是"**游戏真正会读的那个**
  // mods 文件夹"：开了版本隔离是 `versions\<版本>\mods`，没开是公共的 `.minecraft\mods`。
  // （content.targetDir 的键是单数 `mod`，而且那句话术是给"装东西"用的，不是给"查"用的。）
  const folder = versions.folderFor(versionId, 'mods', dir)
  const jars = folder ? listEnabledMods(folder) : []
  if (!jars.length) return out

  // ② 有 Mod。看看它们要哪个加载器（只读前 MAX_READ 个）
  const counted = {}
  for (const jar of jars.slice(0, MAX_READ)) {
    try {
      const meta = localfiles.readModMeta(jar)
      if (meta?.loader) counted[meta.loader] = (counted[meta.loader] || 0) + 1
    } catch {
      // 读不懂的 jar 就当它是普通 jar，不参与"要哪个加载器"的统计
    }
  }

  out.need = true
  out.skip = skipped(settings.versionKey(dir, versionId))
  out.modCount = jars.length
  out.byLoader = counted
  out.gameVersion = versions.baseGameVersion(versionId, dir)

  // 大多数 Mod 要的那个（并列时按 NeoForge → Forge → Fabric → Quilt 的顺序挑，够用了）
  let best = ''
  let bestCount = 0
  for (const loader of ['neoforge', 'forge', 'fabric', 'quilt']) {
    if ((counted[loader] || 0) > bestCount) {
      best = loader
      bestCount = counted[loader]
    }
  }
  out.wantedLoader = LOADER_NAMES[best] || ''
  out.wantedLoaderKey = best

  // ③ 找一个"同 MC 版本、加载器正好对得上"的实例 —— 提示里直接报它的名字，用户一步就能换
  try {
    for (const one of versions.listAllVersions(settings.knownGameDirs())) {
      if (one.id === versionId && one.dir === dir) continue
      if (!one.loader) continue
      if ((one.base || versions.baseGameVersion(one.id, one.dir)) !== out.gameVersion) continue
      if (best && !String(one.loader).toLowerCase().includes(best)) continue
      out.suggestion = { id: one.id, dir: one.dir, key: one.key, loader: one.loader }
      break
    }
  } catch {
    // 找不着就算了，提示里不提"换哪个版本"
  }

  return out
}

/** 记下"这个版本以后不再提示" */
function skip(versionKey) {
  try {
    const config = settings.readConfig()
    const list = Array.isArray(config.launch?.loaderHintSkip) ? config.launch.loaderHintSkip : []
    if (list.includes(versionKey)) return { ok: true }
    settings.writeConfig({ launch: { loaderHintSkip: [...list, versionKey] } })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

module.exports = { inspect, skip }

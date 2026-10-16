// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 把下载的社区内容放到该放的地方（M9）
//
// 【为什么单独成模块】"下好的文件该放哪"是 Mod、资源包、光影、数据包、
// 整合包共用的地基，而且和"从哪下"（Modrinth）是两件事，分开更好改。
//
// 放哪（**跟着这个版本的隔离设置走**，和游戏自己找的位置一致）：
//   Mod     → mods\
//   资源包  → resourcepacks\
//   光影包  → shaderpacks\
//
// 数据包比较特殊：它得放进**某一个存档**的 datapacks\ 文件夹里才生效，
// 所以要先知道"放哪个存档"——M9 先不做（等做存档管理时一起）。
// 整合包是一整套东西（含版本、配置），M11 单独做。
//
// 当前进度：M9。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')
const versions = require('./versions')
const downloader = require('./downloader')

/** 内容类型 → 游戏里对应的文件夹名 */
const CONTENT_FOLDER = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks'
}

/** 这类内容能不能自动放好 */
function canInstall(type) {
  return Boolean(CONTENT_FOLDER[type])
}

/**
 * 某个版本的这类内容应该放在哪个文件夹。
 * 没开隔离 → **它那个游戏目录**下的公共文件夹；开了 → 这个版本自己的文件夹。
 *
 * 【dir 别漏】漏了就会"在 A 目录的版本上点了下载，文件落进 B 目录"，
 * 而界面上一路都是成功的——最难查的那种错。
 *
 * @param {string} [saveFolder] 数据包专用：存档文件夹的完整路径（见下面 listSaves 的说明）
 */
function targetDir(versionId, type, dir, saveName, saveFolder) {
  // 数据包比别的多一层：它得放进**某一个存档**里才生效（`saves\<存档名>\datapacks\`），
  // 不像 Mod 那样扔进公共文件夹就行。
  if (type === 'datapack') {
    // 界面挑存档的时候会把它所在的文件夹一起带回来——因为存档可能在
    // "版本自己的 saves"里，也可能在公共的 `.minecraft\saves` 里（见 listSaves）。
    // 但**仍然卡一道**：必须在这个游戏目录里面，别让它指到别处去。
    if (saveFolder) {
      const target = path.resolve(String(saveFolder))
      const root = path.resolve(paths.gameDir(dir))
      if (target === root || !target.startsWith(root + path.sep)) {
        return null
      }
      return path.join(target, saveName, 'datapacks')
    }
    if (!saveName) return null
    return path.join(versions.folderFor(versionId, 'saves', dir), saveName, 'datapacks')
  }

  // 整合包装完的结果是**一个完整的版本**（不像别的是"扔进某个文件夹"），
  // 所以它的"文件夹"就是那个版本自己的目录
  if (type === 'modpack') {
    if (!versionId) return null
    return versions.folderFor(versionId, 'version', dir)
  }

  const folder = CONTENT_FOLDER[type]
  if (!folder) return null
  return versions.folderFor(versionId, folder, dir)
}

/**
 * 列出这个版本能看见的存档（数据包要往里装，得先让用户挑一个）。
 * 【怎么认】存档文件夹里有个 `level.dat` —— 游戏就是这么认的。
 *
 * 【为什么两处都找】开了版本隔离（**默认就是开的**）之后，存档在这个版本自己的
 * 文件夹里（`versions\<版本>\saves`）；可用户以前用别的启动器建的、或者关了隔离
 * 的版本用的存档，在公共的 `.minecraft\saves` 里。只找一处的话，用户天天玩的那个
 * 世界根本不出现在列表里，他会以为"毛球把我存档弄丢了"。
 *
 * @returns {Array<{name: string, mtime: number, folder: string, where: string}>}
 *   folder 是存档所在的文件夹（装的时候要原样带回去）
 */
function listSaves(versionId, dir) {
  const roots = []
  const own = versions.folderFor(versionId || '', 'saves', dir)
  if (own) roots.push({ path: own, where: '这个版本' })
  const shared = paths.savesDir(dir)
  if (shared && !roots.some((one) => paths.sameDir(one.path, shared))) {
    roots.push({ path: shared, where: '公共' })
  }

  const out = []
  const seen = new Set()
  for (const root of roots) {
    let names = []
    try {
      names = fs.readdirSync(root.path)
    } catch {
      continue // 这个文件夹还不存在 = 那边一个存档都没有
    }
    for (const name of names) {
      if (seen.has(name)) continue
      const level = path.join(root.path, name, 'level.dat')
      let info
      try {
        info = fs.statSync(level)
      } catch {
        continue // 没有 level.dat 的不算存档（可能是备份、或者建了一半）
      }
      seen.add(name)
      out.push({ name, mtime: info.mtimeMs, folder: root.path, where: root.where })
    }
  }
  // 最近玩过的排前面
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/**
 * 下载一个文件并放到该放的地方。
 *
 * @param {{versionId: string, type: string, saveName?: string,
 *          file: {url: string, filename: string, sha1?: string, size?: number},
 *          onProgress?: Function}} options
 * @returns {Promise<{ok: boolean, path?: string, dir?: string, skipped?: boolean, error?: string}>}
 */
async function installFile(options) {
  const { versionId, type, file, onProgress, dir: gameDir, saveName, saveFolder } = options

  // saveName / saveFolder 只有数据包用得上（要指定装进哪个存档）
  const dir = targetDir(versionId, type, gameDir, saveName, saveFolder)
  if (!dir) {
    return { ok: false, error: `「${type}」这种内容还不能自动放好` }
  }
  if (!file || !file.url || !file.filename) {
    return { ok: false, error: '这个文件的信息不全，下不了' }
  }

  // 文件名里可能有路径分隔符（恶意或意外），只取最后一段，别让它跑到别的目录去
  const safeName = path.basename(file.filename)
  const saveTo = path.join(dir, safeName)

  try {
    paths.ensureDir(dir)
  } catch (error) {
    return { ok: false, error: `建不了文件夹：${error.message}` }
  }

  const task = downloader.createTask(
    [
      {
        name: safeName,
        url: file.url,
        saveTo,
        sha1: file.sha1 || '',
        size: file.size || 0
      }
    ],
    { onProgress }
  )

  const stats = await task.start()

  if (stats.failed > 0) {
    const first = stats.failures[0]
    return { ok: false, error: first ? first.error : '下载失败' }
  }

  return { ok: true, path: saveTo, dir, skipped: stats.skipped > 0 }
}

module.exports = { installFile, targetDir, canInstall, listSaves, CONTENT_FOLDER }

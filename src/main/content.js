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
 * 没开隔离 → 游戏目录下的公共文件夹；开了 → 这个版本自己的文件夹。
 */
function targetDir(versionId, type) {
  const folder = CONTENT_FOLDER[type]
  if (!folder) return null
  return versions.folderFor(versionId, folder)
}

/**
 * 下载一个文件并放到该放的地方。
 *
 * @param {{versionId: string, type: string,
 *          file: {url: string, filename: string, sha1?: string, size?: number},
 *          onProgress?: Function}} options
 * @returns {Promise<{ok: boolean, path?: string, dir?: string, skipped?: boolean, error?: string}>}
 */
async function installFile(options) {
  const { versionId, type, file, onProgress } = options

  const dir = targetDir(versionId, type)
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

module.exports = { installFile, targetDir, canInstall, CONTENT_FOLDER }

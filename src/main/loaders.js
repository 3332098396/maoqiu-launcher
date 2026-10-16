// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 装 Mod 加载器（M10）
//
// 【为什么先做 Fabric】
// 它官方给了一个干净的接口：直接返回一份"版本文件"（版本 JSON），
// 里面写着"我继承自 26.3，只是多几个库、换个启动入口"。
// 我们把它存成新版本、按正常流程把库下下来就行——完全走现成的安装管道。
// （Forge / NeoForge 要跑它们自己的安装器，是另一套做法，放后面做。）
//
// 接口（Fabric 官方，不需要密钥）：
//   GET meta.fabricmc.net/v2/versions/loader/<游戏版本>
//       → 有哪些加载器版本可用
//   GET meta.fabricmc.net/v2/versions/loader/<游戏版本>/<加载器版本>/profile/json
//       → 那份"版本文件"
//
// 【为什么要做一次"格式转换"】
// Fabric 给的库文件是 Maven 仓库的写法（只有名字和仓库地址），
// 而版本 JSON 里其他库文件是"下载地址 + 校验码"的写法。
// 我们把 Fabric 那份转成统一格式，后面的下载、校验、启动就都不用特判了。
//
// 当前进度：M10。

const { fetchJson } = require('./http')
const paths = require('./paths')
const mirror = require('./mirror')
const settings = require('./settings')

/**
 * Fabric 官方接口。
 *
 * 【为什么优先走镜像】实测：官方接口在国内一个小文件要 20 秒，
 * 它的库文件仓库更是 30 秒都下不完；BMCLAPI 的对应镜像分别是 1.2 秒和 0.2 秒。
 * 所以先试镜像，镜像不行再回头试官方——和下载 Mojang 的东西一个策略。
 */
const FABRIC_META_OFFICIAL = 'https://meta.fabricmc.net/v2'
const FABRIC_META_MIRROR = 'https://bmclapi2.bangbang93.com/fabric-meta/v2'

/**
 * 取一份 Fabric 的 JSON。
 *
 * 【顺序按用户的下载源设置来】
 *   · 选了"只用官方" → 只试官方（慢也认）
 *   · 其他情况 → 先镜像（官方实测 20 秒起，等得人心焦；镜像 1.2 秒）
 * 镜像不行会自动回官方，不会因为镜像抽风就装不上。
 */
async function fetchFabricJson(pathAfterVersion) {
  const errors = []
  const source = settings.downloadSource()

  const tries =
    source === 'official'
      ? [{ name: '官方', url: `${FABRIC_META_OFFICIAL}${pathAfterVersion}`, timeout: 90000 }]
      : [
          { name: '国内镜像', url: `${FABRIC_META_MIRROR}${pathAfterVersion}`, timeout: 30000 },
          { name: '官方', url: `${FABRIC_META_OFFICIAL}${pathAfterVersion}`, timeout: 90000 }
        ]

  for (const attempt of tries) {
    try {
      return await fetchJson(attempt.url, { timeout: attempt.timeout })
    } catch (error) {
      errors.push(`${attempt.name}：${error.message}`)
    }
  }

  throw new Error(`Fabric 的接口连不上。\n${errors.join('\n')}`)
}

/**
 * 把 Maven 的库名转成仓库里的路径。
 * 例：org.ow2.asm:asm:9.7.1 → org/ow2/asm/asm/9.7.1/asm-9.7.1.jar
 */
function mavenToPath(name) {
  const parts = String(name).split(':')
  const [group, artifact, version, classifier] = parts
  if (!group || !artifact || !version) return null

  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`
}

/**
 * 把 Fabric 的版本文件转成我们的写法：
 * 给每个库文件补上 downloads.artifact（路径 + 下载地址），别的原样保留。
 */
function normalizeFabricProfile(profile) {
  const libraries = (profile.libraries || []).map((lib) => {
    if (lib.downloads && lib.downloads.artifact) return lib // 已经是标准写法

    const relPath = mavenToPath(lib.name)
    if (!relPath || !lib.url) return lib // 认不出来的原样留着（下载时会跳过并说明）

    const official = `${String(lib.url).replace(/\/$/, '')}/${relPath}`
    // 直接存成镜像地址：官方仓库实测 30 秒都下不完一个文件，
    // 走镜像 0.2 秒（mirror.js 里有映射规则）
    const mirrored = mirror.toMirror(official)

    return {
      ...lib,
      downloads: {
        ...(lib.downloads || {}),
        artifact: {
          path: relPath,
          url: mirrored || official,
          sha1: '',
          size: 0
        }
      }
    }
  })

  return { ...profile, libraries }
}

/**
 * 查某个游戏版本能用哪些 Fabric 加载器版本。
 * @returns {Promise<Array<{version: string, stable: boolean}>>}
 */
async function listFabricLoaders(gameVersion) {
  const list = await fetchFabricJson(`/versions/loader/${encodeURIComponent(gameVersion)}`)
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && item.loader && item.loader.version)
    .map((item) => ({ version: item.loader.version, stable: Boolean(item.loader.stable) }))
}

/**
 * 拿到"装了 Fabric 的那份版本文件"。
 *
 * @param {string} gameVersion 装在哪个游戏版本上（比如 26.3）
 * @param {string} [loaderVersion] 指定加载器版本；不传就挑最新的稳定版
 * @returns {Promise<{versionId: string, json: object, loaderVersion: string}>}
 */
async function buildFabricProfile(gameVersion, loaderVersion) {
  let version = loaderVersion

  if (!version) {
    const list = await listFabricLoaders(gameVersion)
    if (list.length === 0) {
      throw new Error(`Fabric 没有支持 ${gameVersion} 的加载器——到「下载」页换个游戏版本试试`)
    }
    const stable = list.find((item) => item.stable) || list[0]
    version = stable.version
  }

  const profile = await fetchFabricJson(
    `/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(version)}/profile/json`
  )

  if (!profile || !profile.id || !profile.inheritsFrom) {
    throw new Error('Fabric 给的版本文件不完整，装不了')
  }
  if (String(profile.inheritsFrom) !== String(gameVersion)) {
    throw new Error(`Fabric 返回的是继承自 ${profile.inheritsFrom} 的版本，和预期的对不上`)
  }

  return {
    versionId: profile.id,
    json: normalizeFabricProfile(profile),
    loaderVersion: version
  }
}

module.exports = { buildFabricProfile, listFabricLoaders, normalizeFabricProfile, mavenToPath }

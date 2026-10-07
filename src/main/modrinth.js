// 毛球 — 和 Modrinth 打交道（M9）
//
// Modrinth 是一个开放的游戏资源站（Mod、资源包、光影、数据包、整合包都在这）。
// 它的接口**不需要密钥**，文件地址直接给出来，还带校验码——所以能做到
// "搜完直接下、下完校验"。这也是我们选它当社区资源来源的原因
// （CurseForge 要密钥而且不许内嵌进公开软件，做不了）。
//
// 接口文档：https://docs.modrinth.com/api/
//
// 【用到的三个接口】
//   GET /v2/search?query=…&facets=…      搜索，返回一页结果
//   GET /v2/project/{id}/version?…       这个项目有哪些文件能下
//   （文件本身在 cdn.modrinth.com，直接下）
//
// 当前进度：M9。

const { fetchJson } = require('./http')
const modnames = require('./modnames')

const API = 'https://api.modrinth.com/v2'

/** 能搜的内容类型。值是 Modrinth 用的代号，加一是给人看的名字 */
const PROJECT_TYPES = {
  mod: 'Mod',
  resourcepack: '资源包',
  shader: '光影包',
  datapack: '数据包',
  modpack: '整合包'
}

/**
 * 我们下载每种东西时，按哪一类加载器过滤。
 * 现在只会装纯原版（没有加载器），所以 Mod 先不按加载器筛——
 * 装加载器是下一步（M10）的事，到时候把对应的值填进来即可。
 */
const LOADER_FOR_TYPE = {
  mod: null,
  resourcepack: null,
  shader: null,
  datapack: null,
  modpack: null
}

/**
 * 把搜索结果里的一条整理成界面好用的形状。
 * 顺手把"能认出来的"翻成中文名、分类翻成中文（见 modnames.js）。
 */
function tidyHit(hit) {
  const rawCategories = hit.display_categories?.length
    ? hit.display_categories
    : hit.categories || []

  return {
    id: hit.project_id,
    slug: hit.slug,
    // 中文名（认不出来就是空的，界面会显示英文名，不瞎编）
    nameZh: modnames.chineseName(hit.slug),
    title: hit.title,
    description: hit.description || '',
    icon: hit.icon_url || '',
    downloads: hit.downloads || 0,
    updated: hit.date_modified || '',
    categories: modnames.chineseCategories(rawCategories),
    type: hit.project_type
  }
}

/**
 * 搜内容。
 *
 * @param {{type: string, query?: string, gameVersion?: string, limit?: number, offset?: number}} options
 * @returns {Promise<{total: number, hits: Array}>}
 */
async function search({ type, query = '', gameVersion = '', limit = 20, offset = 0 }) {
  // facets 是"必须同时满足"的筛选条件组
  const facets = [[`project_type:${type}`]]
  if (gameVersion) facets.push([`versions:${gameVersion}`])

  const params = new URLSearchParams({
    query,
    limit: String(limit),
    offset: String(offset),
    index: 'relevance',
    facets: JSON.stringify(facets)
  })

  const data = await fetchJson(`${API}/search?${params.toString()}`, { timeout: 20000 })

  return {
    total: data.total_hits || 0,
    hits: (data.hits || []).map(tidyHit)
  }
}

/** 把版本记录整理成界面好用的形状（只留主文件） */
function tidyVersion(version) {
  const files = version.files || []
  const file = files.find((f) => f.primary) || files[0] || null

  return {
    id: version.id,
    name: version.name,
    versionNumber: version.version_number,
    versionType: version.version_type || 'release',
    gameVersions: version.game_versions || [],
    loaders: version.loaders || [],
    downloads: version.downloads || 0,
    published: version.date_published || '',
    file: file
      ? {
          url: file.url,
          filename: file.filename,
          sha1: (file.hashes && file.hashes.sha1) || '',
          size: file.size || 0
        }
      : null
  }
}

/**
 * 某个项目有哪些文件能下（可以按游戏版本 / 加载器筛）。
 * @returns {Promise<Array>}
 */
async function getVersions(projectId, { gameVersion = '', loader = '' } = {}) {
  const params = new URLSearchParams()
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]))
  if (loader) params.set('loaders', JSON.stringify([loader]))

  const query = params.toString()
  const list = await fetchJson(
    `${API}/project/${encodeURIComponent(projectId)}/version${query ? `?${query}` : ''}`,
    { timeout: 20000 }
  )

  return (Array.isArray(list) ? list : []).map(tidyVersion)
}

/**
 * 从一堆版本里挑一个"最合适的"：优先正式版，其余按发布时间从新到旧。
 * 没有带文件的版本返回 null。
 */
function pickBest(versions) {
  const usable = (versions || []).filter((v) => v.file && v.file.url)
  if (usable.length === 0) return null

  const release = usable.filter((v) => v.versionType === 'release')
  const pool = release.length > 0 ? release : usable

  return pool
    .slice()
    .sort((a, b) => String(b.published).localeCompare(String(a.published)))[0]
}

/** 这个类型该按哪个加载器筛（现在都返回空，装加载器之后再说） */
function loaderFor(type) {
  return LOADER_FOR_TYPE[type] || ''
}

module.exports = { search, getVersions, pickBest, loaderFor, PROJECT_TYPES, API }

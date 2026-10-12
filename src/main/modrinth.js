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

const { fetchJson, postJson } = require('./http')
const modnames = require('./modnames')

/**
 * 接口地址，两个口子：
 *   ① 官方 api.modrinth.com —— 权威，但国内时通时不通
 *   ② mod.mcimirror.top（MCIM 镜像）—— 国内直连，快得多
 *
 * 【为什么两个都要】只留官方，国内用户搜个 Mod 要等十几秒甚至直接失败；
 * 只留镜像，镜像哪天关了就整个「下载」页报废。所以**两个都留着，谁先行谁**。
 *
 * 【为什么记住上次成功的那个】官方被墙的时候，每次搜索都先撞一次官方的墙
 * （要等十几秒超时才轮到镜像），体验很差。所以第一次跑通哪个，
 * 这一次会话就先走哪个 —— 相当于"撞一次墙就够了"。
 */
const API_OFFICIAL = 'https://api.modrinth.com/v2'
const API_MIRROR = 'https://mod.mcimirror.top/modrinth/v2'

/** 兼容老引用（别处可能 import 了 API） */
const API = API_OFFICIAL

/** 上次跑到哪个源上了。true = 这次会话先走镜像 */
let preferMirror = false

/**
 * 按路径取一次 Modrinth 接口，**两个源依次试**。
 * @param {string} pathAndQuery 形如 `/search?a=1`（两个源的路径部分是一样的）
 */
async function apiGet(pathAndQuery, options = {}) {
  const sources = preferMirror ? [API_MIRROR, API_OFFICIAL] : [API_OFFICIAL, API_MIRROR]
  let lastError = null

  for (const base of sources) {
    try {
      // 单个源给 15 秒：比官方的 20 秒短，好让"官方卡住"时能及时切镜像
      const data = await fetchJson(`${base}${pathAndQuery}`, { timeout: 15000, ...options })
      preferMirror = base === API_MIRROR
      return data
    } catch (error) {
      lastError = error
    }
  }

  // 两个都不行才报错。说的话要让人知道"是网络，不是你搜的东西不存在"
  throw new Error(
    `连不上 Modrinth（官方和国内镜像都试过了）：${lastError?.message || '未知原因'}`
  )
}

/** 现在走的是镜像吗（界面/日志想显示时用） */
function usingMirror() {
  return preferMirror
}

/**
 * 按路径 **POST** 一次 Modrinth 接口，两个源依次试。
 * 和 apiGet 一个套路，只是换成 POST（有几个接口只收 POST）。
 */
async function apiPost(pathAndQuery, payload, options = {}) {
  const sources = preferMirror ? [API_MIRROR, API_OFFICIAL] : [API_OFFICIAL, API_MIRROR]
  let lastError = null

  for (const base of sources) {
    try {
      const data = await postJson(`${base}${pathAndQuery}`, payload, {
        timeout: 20000,
        ...options
      })
      preferMirror = base === API_MIRROR
      return data
    } catch (error) {
      lastError = error
    }
  }

  throw new Error(`连不上 Modrinth（官方和国内镜像都试过了）：${lastError?.message || '未知原因'}`)
}

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
async function search({ type, query = '', gameVersion = '', loader = '', limit = 20, offset = 0 }) {
  // facets 是"必须同时满足"的筛选条件组
  const facets = [[`project_type:${type}`]]
  if (gameVersion) facets.push([`versions:${gameVersion}`])
  // 加载器（fabric / forge / neoforge）：只找能在这个版本上跑的那种构建。
  // 不筛的话会挑到别的加载器的构建（实测：Fabric 版本下到了 NeoForge 版的 Sodium）
  if (loader && type === 'mod') facets.push([`categories:${loader}`])

  const params = new URLSearchParams({
    query,
    limit: String(limit),
    offset: String(offset),
    index: 'relevance',
    facets: JSON.stringify(facets)
  })

  const data = await apiGet(`/search?${params.toString()}`)

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
    // 前置 / 冲突（M23）：Modrinth 自己标了"这个文件需要谁"。装之前要拿它提醒用户，
    // 不然装完一启动游戏就崩，用户根本猜不到是缺了个前置。
    dependencies: (version.dependencies || []).map((one) => ({
      projectId: one.project_id || '',
      versionId: one.version_id || '',
      filename: one.file_name || '',
      // required = 必须装；optional = 可选；incompatible = 冲突；embedded = 已经打包在里面
      kind: one.dependency_type || 'required'
    })),
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
  const list = await apiGet(
    `/project/${encodeURIComponent(projectId)}/version${query ? `?${query}` : ''}`
  )

  return (Array.isArray(list) ? list : []).map(tidyVersion)
}

/**
 * 每类内容"能用的那个文件"长什么样（看扩展名）。
 *
 * 【为什么非要有这张表】同一个项目在 Modrinth 上可能**同时挂着好几种文件**。
 * 实测 Terralith：它既有数据包（.zip），又有配套的 Fabric Mod（.jar），
 * 两边的版本号还一样。挑错了就是"下载成功、游戏里啥也没变"这种最难查的问题
 * ——数据包装的还是 .jar，游戏根本不认。
 */
const TYPE_EXTENSION = {
  mod: '.jar',
  modpack: '.mrpack',
  datapack: '.zip',
  resourcepack: '.zip',
  shader: '.zip'
}

/**
 * 从一堆版本里挑一个"最合适的"：先挑对类型，再优先正式版，其余按发布时间从新到旧。
 * 没有带文件的版本返回 null。
 *
 * @param {Array} versions
 * @param {string} [type] 内容类型（mod / datapack / …）。不传就退化成"只看正式版"
 */
function pickBest(versions, type = '') {
  const usable = (versions || []).filter((v) => v.file && v.file.url)
  if (usable.length === 0) return null

  // 先按扩展名留下"这一类能用的"
  const ext = TYPE_EXTENSION[type] || ''
  const rightKind = ext
    ? usable.filter((v) => String(v.file.filename || '').toLowerCase().endsWith(ext))
    : usable
  // 一个都没有就退回全部——宁可让用户拿到个可能不对的，也别报"没文件"
  const pool0 = rightKind.length > 0 ? rightKind : usable

  const release = pool0.filter((v) => v.versionType === 'release')
  const pool = release.length > 0 ? release : pool0

  return pool
    .slice()
    .sort((a, b) => String(b.published).localeCompare(String(a.published)))[0]
}

/** 这个类型该按哪个加载器筛（现在都返回空，装加载器之后再说） */
function loaderFor(type) {
  return LOADER_FOR_TYPE[type] || ''
}

/**
 * 批量问"这些文件有没有新版本"（M23）。
 *
 * 接口是 `POST /version_files/update`：把本地文件的 sha1 一批发过去，
 * 它回一张表——**同 sha1 原样回来 = 已经是最新的**，回来的是别的 id = 有新的。
 * 这个接口不需要密钥，也不会上传我们的任何东西（只发哈希）。
 *
 * @param {Array<{sha1: string}>} files 本地文件（必须有 sha1）
 * @param {{loader?: string, gameVersion?: string}} options
 * @returns {Promise<Object>} sha1 → 新版本信息（没更新的那个 sha1 不在表里）
 */
async function checkFileUpdates(files, { loader = '', gameVersion = '' } = {}) {
  const hashes = (files || []).map((one) => one.sha1).filter(Boolean)
  if (hashes.length === 0) return {}

  // 【为什么必须带上加载器和游戏版本】不带给的话，它会拿"整个项目的最新版"来比，
  // 于是 1.20.1 的 Fabric 包会被推荐更新到 1.21 的 Forge 版——装上去直接起不来。
  const payload = {
    hashes,
    algorithm: 'sha1',
    loaders: loader ? [loader] : [],
    game_versions: gameVersion ? [gameVersion] : []
  }

  const data = await apiPost('/version_files/update', payload)
  const out = {}
  for (const [sha1, version] of Object.entries(data || {})) {
    // 回来的还是原来那个文件 → 就是最新的
    const files = (version && version.files) || []
    if (files.some((one) => one.hashes && one.hashes.sha1 === sha1)) continue
    out[sha1] = tidyVersion(version)
  }
  return out
}

/**
 * 按项目 id 批量取项目信息（拿标题、图标用）。
 * 一次最多 100 个 id——查前置的时候要用。
 */
async function getProjects(ids) {
  const list = [...new Set((ids || []).filter(Boolean))].slice(0, 100)
  if (list.length === 0) return {}

  const params = new URLSearchParams({ ids: JSON.stringify(list) })
  const data = await apiGet(`/projects?${params.toString()}`)

  const out = {}
  for (const one of Array.isArray(data) ? data : []) {
    out[one.id] = {
      id: one.id,
      slug: one.slug,
      title: one.title,
      nameZh: modnames.chineseName(one.slug),
      icon: one.icon_url || '',
      description: one.description || ''
    }
  }
  return out
}

module.exports = {
  search,
  getVersions,
  pickBest,
  loaderFor,
  checkFileUpdates,
  getProjects,
  tidyVersion,
  PROJECT_TYPES,
  API,
  usingMirror,
  apiGet,
  apiPost
}

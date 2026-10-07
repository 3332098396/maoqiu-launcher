// 毛球 — 和 Mojang 官方接口打交道
//
// 目前只做一件事：取"版本清单"——那个列出了所有可下载版本的列表。
//
// 【版本清单是什么】
// 一个 JSON 文件，里面有 900 多个版本，每个版本带：版本号、类型
// （正式版 / 快照 / 远古版）、发布时间、以及"这个版本的详细 JSON 在哪"。
// 后面所有下载都要从这里起步：先有清单，才能知道要下什么。
//
// 【为什么要缓存】
// 用户完全可能开着软件的时候断网，或者 Mojang 那边偶尔抽风。
// 缓存一份在本地，下次打开先拿缓存显示（瞬间出来），
// 后台再去更新——这样"打开就有东西看"，不会对着空白等。
//
// 当前进度：M2。

const fs = require('node:fs')
const paths = require('./paths')
const { fetchJson } = require('./http')
const mirror = require('./mirror')

/** 版本清单的官方地址 */
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

/** 版本类型的显示名 */
const TYPE_LABELS = {
  release: '正式版',
  snapshot: '快照',
  old_beta: '远古版 β',
  old_alpha: '远古版 α'
}

/**
 * 把原始清单整理成界面好用的形状。
 * 只保留界面需要的字段——原始 JSON 里有一堆我们用不到的，
 * 原样丢给界面既浪费内存也容易乱。
 */
function tidy(raw) {
  const versions = (raw.versions || []).map((v) => ({
    id: v.id,
    type: v.type,
    typeLabel: TYPE_LABELS[v.type] || v.type,
    released: v.releaseTime,
    url: v.url
  }))

  return {
    latest: {
      release: raw.latest?.release ?? '',
      snapshot: raw.latest?.snapshot ?? ''
    },
    versions
  }
}

/** 读缓存。没有或者坏了就返回 null */
function readCache() {
  try {
    const file = paths.manifestCacheFile()
    if (!fs.existsSync(file)) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      ...tidy(raw.data),
      fromCache: true,
      updatedAt: raw.updatedAt ?? 0
    }
  } catch {
    // 缓存坏了不是什么大事——重新下一份就是了，不要因此报错
    return null
  }
}

/** 把整理好的清单写进缓存 */
function writeCache(tidied) {
  try {
    paths.ensureDir(paths.cacheDir())
    // 先写临时文件再改名：断电时不会留下一个半截的缓存文件
    const file = paths.manifestCacheFile()
    const temp = `${file}.tmp`
    fs.writeFileSync(
      temp,
      JSON.stringify({ updatedAt: Date.now(), data: tidied }, null, 2),
      'utf8'
    )
    fs.renameSync(temp, file)
  } catch {
    // 缓存写不进去也不该影响使用，静默跳过
  }
}

/**
 * 从网上下载一份版本清单。
 * 先试官方源，官方源不行就换国内镜像。
 */
async function downloadManifest() {
  const errors = []

  // 先官方
  try {
    return tidy(await fetchJson(MANIFEST_URL, { timeout: 20000 }))
  } catch (error) {
    errors.push(`官方源：${error.message}`)
  }

  // 再镜像
  const mirrorUrl = mirror.toMirror(MANIFEST_URL)
  if (mirrorUrl) {
    try {
      return tidy(await fetchJson(mirrorUrl, { timeout: 20000 }))
    } catch (error) {
      errors.push(`国内镜像：${error.message}`)
    }
  }

  throw new Error(`两个下载源都没连上。\n${errors.join('\n')}`)
}

/**
 * 取版本清单。
 *
 * 先给缓存（快，断网也能看），后台可以再调 refresh 去更新。
 * @returns {Promise<{versions, latest, fromCache, updatedAt}>}
 */
async function getManifest() {
  const cached = readCache()
  if (cached) return cached

  // 没有缓存就只能现下
  const fresh = await downloadManifest()
  writeCache(fresh)
  return { ...fresh, fromCache: false, updatedAt: Date.now() }
}

/**
 * 强制从网上更新一份，写进缓存后返回。
 * 界面打开后会在后台调它，这样用户看到的是最新列表，但不用等。
 */
async function refreshManifest() {
  const fresh = await downloadManifest()
  writeCache(fresh)
  return { ...fresh, fromCache: false, updatedAt: Date.now() }
}

module.exports = { getManifest, refreshManifest, MANIFEST_URL }

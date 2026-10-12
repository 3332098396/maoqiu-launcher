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
const settings = require('./settings')

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
 * 单个源的超时时间（M23）。
 * 【为什么从 30 秒砍到 8 秒】以前是"官方源先试，30 秒不通再换镜像"——
 * 官方在国内被卡住的时候，用户要对着转圈等满 30 秒才轮到镜像。
 * 8 秒是上游用的数：正常网络下这点时间足够回来，被卡住时也不会让人干等。
 */
const SOURCE_TIMEOUT_MS = 8000

/**
 * 官方的"优先窗口"（M23）。
 * 两个源同时发出去之后，**先给官方 2.5 秒**：它在窗口内回来就用它
 * （官方永远是最新的那份）；没回来就先用手上已有的那个，不等了。
 * 【为什么要留这个窗口】镜像偶尔会比官方慢几个小时才同步。
 * 无脑"谁先到用谁"的话，官方明明通着也会被镜像抢走，列表就可能旧一点。
 */
const OFFICIAL_HEAD_START_MS = 2500

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 缓存多久算"还新鲜"（M23，5 分钟）。
 * 这么新的缓存就不用再联网刷一遍了——版本清单一天也变不了几次。
 * 【以前没有这一条】每次打开软件都会在后台重下一份，多花一次请求；
 * 而真被卡住的时候，等来的还是旧的那份。现在"新的就用、老的才刷"。
 */
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * 从网上下载一份版本清单。
 *
 * 【M23 改成了"两个源同时发"】以前是一个一个试：官方不通要等满超时才轮到镜像。
 * 现在两边一起发，先回来先用 —— 反正两边给的是同一份清单，
 * 没必要为了"必须走官方"让用户干等。
 * 用户设置里选「只用官方」的话就真的只用官方（那是他自己的选择）。
 */
async function downloadManifest() {
  const mirrorUrl = mirror.toMirror(MANIFEST_URL)
  const source = settings.downloadSource()

  const official = { name: '官方源', url: MANIFEST_URL }
  const mirrored = mirrorUrl ? { name: '国内镜像', url: mirrorUrl } : null

  let candidates
  if (source === 'official' || !mirrored) {
    candidates = [official]
  } else if (source === 'mirror') {
    candidates = [mirrored, official]
  } else {
    candidates = [official, mirrored]
  }

  const errors = []
  /** 包一层：成功给数据，失败把原因记下来、返回 null */
  const attempt = (one) =>
    fetchJson(one.url, { timeout: SOURCE_TIMEOUT_MS })
      .then((raw) => ({ name: one.name, raw }))
      .catch((error) => {
        errors.push(`${one.name}：${error.message}`)
        return null
      })

  const pending = candidates.map(attempt)
  const first = pending[0]

  // 只有官方一个源（或者用户指定只用官方）——那就老实等它
  if (pending.length === 1) {
    const only = await pending[0]
    if (!only) throw new Error(`下载源没连上。\n${errors.join('\n')}`)
    return tidy(only.raw)
  }

  // 给排第一的那个（auto 模式就是官方）一个优先窗口
  const headStart = await Promise.race([first, sleep(OFFICIAL_HEAD_START_MS).then(() => null)])
  if (headStart) return tidy(headStart.raw)

  // 窗口内没等到——谁先成谁赢（first 还在跑，赢了也照收）
  const winner = await new Promise((resolve) => {
    let pendingCount = pending.length
    let settled = false
    for (const one of pending) {
      one.then((result) => {
        if (settled) return
        if (result) {
          settled = true
          resolve(result)
          return
        }
        pendingCount--
        if (pendingCount === 0) {
          settled = true
          resolve(null)
        }
      })
    }
  })

  if (!winner) throw new Error(`下载源都没连上。\n${errors.join('\n')}`)
  return tidy(winner.raw)
}

/**
 * 取版本清单。
 *
 * 先给缓存（快，断网也能看），后台可以再调 refresh 去更新。
 * @returns {Promise<{versions, latest, fromCache, updatedAt}>}
 */
async function getManifest() {
  const cached = readCache()
  if (cached) {
    // 顺手告诉界面"这份缓存还算新吗"（M23）：
    // 刚下过的就别再跑一趟网了，省一次请求也省用户一次等待。
    return { ...cached, fresh: Date.now() - (cached.updatedAt || 0) < CACHE_TTL_MS }
  }

  // 没有缓存就只能现下
  const fresh = await downloadManifest()
  writeCache(fresh)
  return { ...fresh, fromCache: false, fresh: true, updatedAt: Date.now() }
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

module.exports = { getManifest, refreshManifest, MANIFEST_URL, CACHE_TTL_MS }

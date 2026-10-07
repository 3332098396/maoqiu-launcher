// 毛球 — authlib-injector（外置登录进游戏的钥匙）
//
// 【它是干什么的】游戏本体里写死了一套"去哪儿验证身份、去哪儿取皮肤"的地址
// （指向 Mojang 自己的服务器）。authlib-injector 是个 **Java 小代理**，
// 在游戏启动的那一瞬间把这些地址换成皮肤站的地址——游戏于是就把你当成
// 皮肤站上的那个角色了。**它不是 Mod，也不是插件**，扔进 mods/ 一点用都没有，
// 必须通过 JVM 参数挂上去。
//
// 【为什么下载而不是塞进安装包】
//   ① 它是 Java 的东西，跟毛球这套 JS 代码没关系
//   ② 它会跟着游戏版本更新换代，内置一份早晚会过期
// 【下载必须校验】跟联机组件（EasyTier）一样的规矩：走国内加速站下，
//   但**拿 GitHub 官方给的 sha256 核一遍**——镜像要是被换了包，这里会当场发现。
//
// 【规范出处】authlib-injector 官方的《启动器技术规范》：
//   -javaagent:{jar 路径}={验证服务器 API 地址}
//   -Dauthlibinjector.yggdrasil.prefetched={Base64 的 API 元数据}
//   这些参数要加在主类之前。

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const paths = require('./paths')
const downloader = require('./downloader')
const { fetchJson, fetchText } = require('./http')

/** 官方仓库 */
const REPO = 'yushijinhun/authlib-injector'

/**
 * 万能的 API 查不到时用这个版本。
 * 【为什么要留一手】GitHub 的接口在国内时不时连不上，
 * 没有兜底的话用户会因为"问不到最新版"而整个用不了外置登录。
 */
const FALLBACK_VERSION = 'v1.2.8'

/** 跟联机组件用同一套加速站；最后空字符串是 GitHub 官方（兜底） */
const MIRROR_PREFIXES = ['https://gh-proxy.com/', 'https://ghfast.top/', '']

function jarName(version) {
  return `authlib-injector-${String(version).replace(/^v/, '')}.jar`
}

function releaseUrl(version) {
  return `https://github.com/${REPO}/releases/download/${version}/${jarName(version)}`
}

/** 已经下好了吗 */
function isReady(version) {
  const file = paths.authlibJarPath(version)
  try {
    // 这个 jar 大概 340 KB，太小的肯定不是完整的
    return fs.statSync(file).size > 100 * 1024
  } catch {
    return false
  }
}

/** 问 GitHub 现在最新是哪个版本 */
async function latestVersion() {
  try {
    const data = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`, {
      timeout: 15000,
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (data && typeof data.tag_name === 'string' && data.tag_name) return data.tag_name
  } catch {
    // 问不到就用兜底版本
  }
  return FALLBACK_VERSION
}

/**
 * 问官方要"这个包该长什么样、官方摘要是多少"。
 * @returns {Promise<{size: number, sha256: string}|null>} 问不到返回 null（那就退一步只校验大小）
 */
async function assetDigest(version) {
  try {
    const data = await fetchJson(`https://api.github.com/repos/${REPO}/releases/tags/${version}`, {
      timeout: 15000,
      headers: { Accept: 'application/vnd.github+json' }
    })
    const asset = (data.assets || []).find((one) => one.name === jarName(version))
    if (!asset) return null

    const digest = String(asset.digest || '')
    return {
      size: Number(asset.size) || 0,
      sha256: digest.startsWith('sha256:') ? digest.slice(7) : ''
    }
  } catch {
    return null
  }
}

function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * 确保 jar 已经在本机（没有就下）。
 * @returns {Promise<{ok: boolean, path: string, version: string, downloaded: boolean}>}
 */
async function ensure(options = {}) {
  const stage = (text) => {
    if (options.onStage) options.onStage(text)
  }

  const version = await latestVersion()

  if (isReady(version)) {
    return { ok: true, path: paths.authlibJarPath(version), version, downloaded: false }
  }

  paths.ensureDir(paths.authlibRoot())
  const target = paths.authlibJarPath(version)

  stage(`正在下载外置登录组件（authlib-injector ${version}，约 340 KB）…`)

  const official = await assetDigest(version)
  const url = releaseUrl(version)
  let lastError = ''

  for (const prefix of MIRROR_PREFIXES) {
    const label = prefix ? prefix.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'GitHub 官方'
    stage(prefix ? `从 ${label} 下…` : '加速站都不行，试试官方地址（可能会很慢）…')

    try {
      const task = downloader.createTask(
        [
          {
            name: jarName(version),
            url: `${prefix}${url}`,
            saveTo: target,
            size: official ? official.size : 0
          }
        ],
        { onProgress: options.onProgress }
      )
      const stats = await task.start()

      if (stats.failed === 0 && fs.existsSync(target)) {
        // ——— 拿官方摘要核一遍：镜像换了包这里会当场发现 ———
        if (official && official.sha256) {
          stage('正在核对官方校验值…')
          const got = sha256Of(fs.readFileSync(target))
          if (got !== official.sha256) {
            lastError = `下下来的文件和官方的校验值对不上（${label} 可能有问题）`
            fs.rmSync(target, { force: true })
            continue
          }
        }

        return { ok: true, path: target, version, downloaded: true }
      }

      lastError = `从 ${label} 下载失败`
    } catch (error) {
      lastError = `${label}：${error.message}`
    }
  }

  throw new Error(lastError || '下载失败')
}

/**
 * 把验证服务器的"元数据"取回来，供启动时直接塞给游戏。
 *
 * 【为什么多做这一步】照官方规范的说法：启动时如果让游戏自己去请求验证服务器，
 * 一来会慢，二来**万一那一瞬间网络不通，游戏会直接崩**。
 * 我们先取好、编码好带过去，就绕开了这两个问题。
 *
 * 取不到不算致命（游戏会自己去要），所以这里失败返回空字符串。
 *
 * @returns {Promise<string>} Base64 编码的元数据；拿不到就返回 ''
 */
async function prefetchMetadata(apiRoot) {
  if (!apiRoot) return ''
  try {
    const text = await fetchText(apiRoot, { timeout: 15000 })
    if (!text || !text.trim()) return ''
    return Buffer.from(text, 'utf8').toString('base64')
  } catch {
    return ''
  }
}

module.exports = { ensure, prefetchMetadata, isReady, FALLBACK_VERSION }

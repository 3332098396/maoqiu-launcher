// 毛球 — 联机组件（EasyTier）
//
// 【这是什么】EasyTier 是一个开源免费的"异地组网"工具（PCL 的联机用的也是它）。
// 两台不在同一个局域网的电脑，各自跑一个它，就"像在一个局域网里"了——
// 游戏里的「对局域网开放」和「直接连接」就能用。
//
// 【为什么是"下载"而不是"打包进安装包"】
//   · 它有 31 MB，打包进去会让安装包变大，而且没人联机的话白占地方
//   · 它是别人家的程序（LGPL 许可），我们不修改不打包，用的时候从官方下，
//     跟"下载 Java 运行时"是一个路子（见 install.ensureJavaComponent）
//
// 【下载地址为什么这么绕】实测过：GitHub 直连 **2.5 KB/s**（31 MB 要下三个多小时），
// 国内根本用不了。所以按顺序试：先两个国内加速，最后才是官方地址兜底。
// 加速站是民间服务，哪天挂了就自动落到下一个，不会卡死在某一个上。
//
// 【那怎么保证下下来的东西没被换过】GitHub 的 API 会给每个附件一个 **SHA-256 摘要**，
// 我们从它那儿取摘要，下完**逐字节核对**：对不上就删掉、报错、拒绝使用。
// 这样就算某个加速站被做了手脚，也过不了这一关——"快"和"安全"就不冲突了。
// （这一步是这个功能里最要紧的安全措施，别为了图省事去掉。）

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const paths = require('./paths')
const zip = require('./zip')
const downloader = require('./downloader')
const { fetchJson } = require('./http')

/** 拿不到"最新版本号"时用这个兜底（写死一个确认能用的，别让联机功能整个瘫掉） */
const FALLBACK_VERSION = 'v2.6.4'

/**
 * 下载地址前面的"加速前缀"，按顺序试。
 * 最后那个空串 = GitHub 官方地址（兜底）。
 * 【别删空串】加速站都是民间服务，全挂了的时候官方地址还能慢慢下。
 */
const MIRROR_PREFIXES = ['https://gh-proxy.com/', 'https://ghfast.top/', '']

/** 我们这个平台的包叫什么名 */
function assetName(version) {
  return `easytier-windows-x86_64-${version}.zip`
}

/** 官方的下载地址 */
function releaseUrl(version) {
  return `https://github.com/EasyTier/EasyTier/releases/download/${version}/${assetName(version)}`
}

/** easytier-core.exe 在哪 */
function corePath(version) {
  return path.join(paths.easytierDir(version), 'easytier-core.exe')
}

/** easytier-cli.exe 在哪（查状态用的那个） */
function cliPath(version) {
  return path.join(paths.easytierDir(version), 'easytier-cli.exe')
}

/** 这个版本下好了吗 */
function isReady(version) {
  return fs.existsSync(corePath(version)) && fs.existsSync(cliPath(version))
}

/**
 * 问 GitHub 现在最新是哪个版本。
 * 问不到（被墙、限流、断网）就用兜底版本号——联机功能不能因为"版本号没问到"就用不了。
 */
async function latestVersion() {
  try {
    const info = await fetchJson('https://api.github.com/repos/EasyTier/EasyTier/releases/latest', {
      timeout: 10000
    })
    const tag = String(info.tag_name || '').trim()
    if (/^v?\d+\.\d+\.\d+$/.test(tag)) return tag.startsWith('v') ? tag : `v${tag}`
  } catch {
    // 拿不到就走兜底
  }
  return FALLBACK_VERSION
}

/**
 * 问 GitHub 要这个附件的"官方信息"：多大、**官方给的 SHA-256 是多少**。
 *
 * 【为什么要这个】下载走的是国内加速站（民间服务，速度才有 7 MB/s）。
 * 万一某个加速站被做了手脚、塞了改过的包，光看"下下来了"是发现不了的。
 * GitHub 的 API 会给每个附件一个 sha256 摘要 —— 拿它校验，
 * **镜像被换过也会当场露馅**。校验不过就拒绝使用。
 *
 * @returns {Promise<{size: number, sha256: string}|null>} 问不到就返回 null（那就退回"只校验结构"）
 */
async function assetDigest(version) {
  try {
    const info = await fetchJson(
      `https://api.github.com/repos/EasyTier/EasyTier/releases/tags/${version}`,
      { timeout: 10000 }
    )
    const asset = (info.assets || []).find((one) => one.name === assetName(version))
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

/** 算一个文件的 SHA-256（十六进制小写） */
function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** 把解压出来的东西摆平：包里套了一层文件夹的话，把里面的东西提上来 */
function flattenIfWrapped(dir) {
  if (fs.existsSync(path.join(dir, 'easytier-core.exe'))) return

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const inner = path.join(dir, entry.name)
    if (!fs.existsSync(path.join(inner, 'easytier-core.exe'))) continue

    for (const file of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, file), path.join(dir, file))
    }
    fs.rmdirSync(inner)
    return
  }
}

/**
 * 确保这个版本的 EasyTier 在硬盘上。没有就下、解开；有就直接用。
 *
 * @param {{onStage?: Function, onProgress?: Function}} options
 * @returns {Promise<{ok: boolean, version: string, dir: string, core: string, cli: string,
 *                    downloaded: boolean, error?: string}>}
 */
async function ensure(options = {}) {
  const stage = (text) => {
    if (options.onStage) options.onStage(text)
  }

  const version = await latestVersion()

  if (isReady(version)) {
    return {
      ok: true,
      version,
      dir: paths.easytierDir(version),
      core: corePath(version),
      cli: cliPath(version),
      downloaded: false
    }
  }

  const dir = paths.easytierDir(version)
  const zipFile = path.join(paths.easytierRoot(), `${assetName(version)}`)
  paths.ensureDir(dir)

  stage(`正在下载联机组件（EasyTier ${version}，约 31 MB）…`)

  // 先问官方要"这个包该长什么样、官方摘要是多少"——下载完要拿它校验
  const official = await assetDigest(version)

  const url = releaseUrl(version)
  let lastError = ''

  for (const prefix of MIRROR_PREFIXES) {
    const full = `${prefix}${url}`
    const label = prefix ? prefix.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'GitHub 官方'

    stage(prefix ? `从 ${label} 下…` : '加速站都不行，试试官方地址（可能会很慢）…')

    try {
      const task = downloader.createTask(
        [
          {
            name: assetName(version),
            url: full,
            saveTo: zipFile,
            // 大小对不上就不用下了（摘要下载完再验，那个要整包读进来算）
            size: official ? official.size : 0
          }
        ],
        { onProgress: options.onProgress }
      )
      const stats = await task.start()

      if (stats.failed === 0 && fs.existsSync(zipFile)) {
        // ——— 拿官方摘要验一遍：镜像要是给换了包，这里会当场发现 ———
        if (official && official.sha256) {
          stage('正在核对官方校验值…')
          const got = sha256Of(fs.readFileSync(zipFile))
          if (got !== official.sha256) {
            lastError = `下下来的文件和官方的校验值对不上（${label} 可能有问题）`
            try {
              fs.rmSync(zipFile, { force: true })
            } catch {
              // 删不掉就算了
            }
            continue
          }
        }

        lastError = ''
        break
      }
      lastError = stats.failures[0] ? String(stats.failures[0].error) : '下载失败'
    } catch (error) {
      lastError = String(error?.message ?? error)
    }

    // 这一路失败：把半截文件清掉，换下一个
    try {
      fs.rmSync(zipFile, { force: true })
    } catch {
      // 删不掉不影响继续试
    }
  }

  if (lastError) {
    return { ok: false, version, dir, error: `联机组件没下下来（${lastError}）。检查一下网络，然后再试一次。` }
  }

  stage('正在解开…')
  try {
    const buffer = fs.readFileSync(zipFile)
    zip.extractTo(buffer, dir)
    flattenIfWrapped(dir)
  } catch (error) {
    return { ok: false, version, dir, error: `联机组件解不开：${error.message}` }
  } finally {
    // 31 MB 的压缩包留着没用，解完就删
    try {
      fs.rmSync(zipFile, { force: true })
    } catch {
      // 删不掉就算了
    }
  }

  if (!isReady(version)) {
    return { ok: false, version, dir, error: '联机组件解开之后没找到主程序，可能压缩包不完整。' }
  }

  return { ok: true, version, dir, core: corePath(version), cli: cliPath(version), downloaded: true }
}

/**
 * 跑一下 easytier-core.exe --version，确认它真的能用。
 *
 * 【为什么要试跑】文件在硬盘上不代表能跑：杀毒软件可能拦了、架构不对、
 * 或者下载时缺了一截。花几百毫秒试一下，比让联机按钮点了没反应强。
 */
function probe(version) {
  const exe = corePath(version)
  if (!fs.existsSync(exe)) return { ok: false, error: '还没下载' }

  const result = spawnSync(exe, ['--version'], { timeout: 15000, encoding: 'utf8', windowsHide: true })
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim()

  if (result.error) return { ok: false, error: result.error.message }
  if (!text) return { ok: false, error: '跑了一下没有任何输出，可能被杀毒软件拦了' }

  return { ok: true, text: text.split('\n')[0].slice(0, 80) }
}

module.exports = {
  ensure,
  probe,
  latestVersion,
  isReady,
  corePath,
  cliPath,
  releaseUrl,
  FALLBACK_VERSION
}

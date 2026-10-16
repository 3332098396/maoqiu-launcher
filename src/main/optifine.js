// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 装 OptiFine
//
// 【OptiFine 是什么结构】它给的是一个"安装器 jar"，但和 Forge 那种不一样：
// 真正改过游戏的一堆类就在这个 jar 里；jar 里还塞着两样配套的东西——
//   · launchwrapper-of-<N>.jar   OptiFine 自己 fork 的启动组件（老游戏入口是它）
//   · launchwrapper-of.txt       写着该用哪个版本（比如 "2.3"）
// 官方安装器会把这两样分别放进 libraries，再写一份"继承原版"的版本文件：
//   libraries/optifine/OptiFine/<版本>/OptiFine-<版本>.jar
//   libraries/optifine/launchwrapper-of/<N>/launchwrapper-of-<N>.jar
// 启动入口换成 net.minecraft.launchwrapper.Launch，游戏参数里加
// --tweakClass optifine.OptiFineTweaker。我们照这个样子来（和别家启动器一致，
// 用户拿同一个游戏目录在别家那边也认得出这个版本）。
//
// 【下载源】optifine.net 国内连不上（跟 Forge 官方仓库一个情况），
// 走 BMCLAPI 的镜像；镜像不提供哈希，这条和 forge.js 里安装器的情况相同——
// HTTPS 从镜像下，装完的文件由它自己带校验（这里没有）。
//
// 当前进度：跟着 M10 的加载器一起做。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')
const { fetchJson } = require('./http')
const zip = require('./zip')
const downloader = require('./downloader')

const BMCLAPI = 'https://bmclapi2.bangbang93.com'

/**
 * 版本号比较：新的在前。
 * 【为什么不能用字符串比】"47.1.10" 按字符串排会跑到 "47.1.9" 前面去（10 比 9"小"）。
 */
function compareNewerFirst(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number)
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return y - x
  }
  return 0
}

/**
 * 某个游戏版本有哪些 OptiFine（新的在前，正式版排在预览版前面）。
 *
 * 接口返回的每一条长这样：
 *   {mcversion:"1.20.1", type:"HD_U",     patch:"I6",  filename:"OptiFine_1.20.1_HD_U_I6.jar"}
 *   {mcversion:"1.20.1", type:"HD_U_I5",  patch:"pre4", filename:"preview_OptiFine_…jar"}
 * 下载地址按 <游戏版本>/<type>/<patch> 拼，BMCLAPI 会跳转到文件。
 *
 * @returns {Promise<Array<{version: string, label: string, preview: boolean, type: string, patch: string, filename: string}>>}
 */
async function listVersions(gameVersion) {
  const list = await fetchJson(`${BMCLAPI}/optifine/${encodeURIComponent(gameVersion)}`, {
    timeout: 30000
  })
  if (!Array.isArray(list)) return []

  const seen = new Set()
  const items = []
  for (const one of list) {
    if (!one || !one.filename || !one.patch || !one.type) continue
    // version 是去掉文件名前后缀的部分："1.20.1_HD_U_I6"
    const version = String(one.filename).replace(/^preview_/, '').replace(/^OptiFine_/, '').replace(/\.jar$/, '')
    if (!version || seen.has(version)) continue
    seen.add(version)

    const preview = String(one.filename).startsWith('preview_') || String(one.patch).startsWith('pre')
    items.push({
      version,
      // 官网的写法："HD_U"+"I6" → "HD U I6"；预览版 type 里已经带着上一段（HD_U_I5 + pre4）
      label: `${String(one.type).replace(/_/g, ' ')} ${one.patch}`,
      preview,
      type: String(one.type),
      patch: String(one.patch),
      filename: String(one.filename)
    })
  }

  items.sort((a, b) => {
    if (a.preview !== b.preview) return a.preview ? 1 : -1
    return compareNewerFirst(a.patch, b.patch)
  })
  return items
}

/**
 * 下载 OptiFine 的安装器 jar 到缓存目录。
 * （和 Forge 的安装器一样存 cache/installers，重装时不用再下一遍）
 */
async function downloadJar(gameVersion, entry, { onProgress, onTask } = {}) {
  const dir = path.join(paths.cacheDir(), 'installers')
  paths.ensureDir(dir)
  const saveTo = path.join(dir, entry.filename)

  const task = downloader.createTask(
    [
      {
        name: entry.filename,
        url: `${BMCLAPI}/optifine/${encodeURIComponent(gameVersion)}/${entry.type}/${entry.patch}`,
        saveTo,
        sha1: '',
        size: 0
      }
    ],
    { onProgress }
  )
  if (onTask) onTask(task)

  const stats = await task.start()
  if (stats.failed > 0) {
    throw new Error(`OptiFine 没下下来：${stats.failures[0] ? stats.failures[0].error : '未知原因'}`)
  }
  return saveTo
}

/**
 * 装一个 OptiFine。
 *
 * 做三件事：
 *   ① 下载安装器 jar（下到缓存）
 *   ② 把 jar 本体复制进 libraries/optifine/OptiFine/<版本>/，
 *      再把里面塞着的 launchwrapper-of 解出来放进 libraries（官方安装器的做法）
 *   ③ 拼一份"继承原版"的版本文件交出去，后面的下载、启动都走正常流程
 *
 * @returns {Promise<{versionId: string, json: object, loaderVersion: string}>}
 */
async function install(gameVersion, entry, { dir, onStage, onProgress, onTask } = {}) {
  const stage = (text) => {
    if (onStage) onStage(text)
  }

  stage(`正在下载 OptiFine ${entry.label}…`)
  const jarPath = await downloadJar(gameVersion, entry, { onProgress, onTask })

  stage('正在读取 OptiFine 的安装文件…')
  const buffer = fs.readFileSync(jarPath)
  const entries = zip.listEntries(buffer)

  const wrapperEntry = entries.find((one) => /^launchwrapper-of-.*\.jar$/.test(one.name))
  if (!wrapperEntry) {
    throw new Error(
      `这个 OptiFine（${entry.label}）太老了，里面没有毛球要用的启动组件——` +
        '挑一个 1.13 以后的版本试试'
    )
  }

  // 版本号优先读里面的小文本（官方安装器也是这么认的），读不到就从文件名里抠
  const txtEntry = entries.find((one) => one.name === 'launchwrapper-of.txt')
  let wrapperVersion = txtEntry ? zip.readEntry(buffer, txtEntry).toString('utf8').trim() : ''
  if (!wrapperVersion) {
    wrapperVersion = wrapperEntry.name.replace(/^launchwrapper-of-/, '').replace(/\.jar$/, '')
  }

  const optifineRel = `optifine/OptiFine/${entry.version}/OptiFine-${entry.version}.jar`
  const wrapperRel = `optifine/launchwrapper-of/${wrapperVersion}/launchwrapper-of-${wrapperVersion}.jar`

  stage('正在放 OptiFine 的文件…')
  const libraries = paths.librariesDir(dir)
  for (const [rel, data] of [
    [optifineRel, buffer],
    [wrapperRel, zip.readEntry(buffer, wrapperEntry)]
  ]) {
    const target = path.join(libraries, rel)
    // 安全：路径必须落在 libraries 里（版本号来自网络，防 ../ 跑出去）
    if (!path.resolve(target).startsWith(path.resolve(libraries))) {
      throw new Error('OptiFine 的文件路径不对劲，停手了')
    }
    paths.ensureDir(path.dirname(target))
    fs.writeFileSync(target, data)
  }

  const versionId = `OptiFine_${entry.version}`

  return {
    versionId,
    loaderVersion: entry.label,
    json: {
      id: versionId,
      inheritsFrom: gameVersion,
      type: 'release',
      time: new Date().toISOString(),
      releaseTime: new Date().toISOString(),
      mainClass: 'net.minecraft.launchwrapper.Launch',
      arguments: { game: ['--tweakClass', 'optifine.OptiFineTweaker'] },
      libraries: [
        {
          // 真身：文件上面已经放好了，这里带上地址——万一被删了，重装能自己补
          name: `optifine:OptiFine:${entry.version}`,
          downloads: {
            artifact: {
              path: optifineRel,
              url: `${BMCLAPI}/optifine/${encodeURIComponent(gameVersion)}/${entry.type}/${entry.patch}`,
              sha1: '',
              size: 0
            }
          }
        },
        {
          // 启动组件：BMCLAPI 上没有单独的坐标，只能从安装器 jar 里解（上面已经解好）
          name: `optifine:launchwrapper-of:${wrapperVersion}`,
          downloads: { artifact: { path: wrapperRel } }
        }
      ]
    }
  }
}

module.exports = { listVersions, install }

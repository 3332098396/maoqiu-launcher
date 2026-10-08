// 毛球 — 把账号上的皮肤取回来（M16.3）
//
// 【干什么用的】启动页右边那个 3D 小人，登了真账号之后就该换成**你自己的皮肤**，
// 而不是一直站那儿当默认样板。
//
// 【两个来源，一条出口】
//   外置登录：验证服务器的 profile 接口给一段签过名的 Base64，解开才有地址
//   正版账号：游戏档案接口直接给一串皮肤地址
// 两者的共同点是"都只给一个图片地址"，所以下载那一段可以共用。
//
// 【只回一张图，不回地址】界面那边不需要知道地址（那是网络细节），
// 我们直接把图编码成 data URL 递过去——64×64 的 PNG 只有几 KB。

const { fetchBuffer, HttpError } = require('./http')
const yggdrasil = require('./yggdrasil')
const microsoft = require('./microsoft')

/** 只有这两种账号有"网上的皮肤"；离线账号没有 */
function hasRemoteSkin(account) {
  return account?.type === 'yggdrasil' || account?.type === 'microsoft'
}

/**
 * 取这个账号的皮肤。
 * @param {object} account
 * @returns {Promise<{ok: boolean, dataUrl?: string, source?: string, error?: string}>}
 */
async function fetchFor(account) {
  if (!hasRemoteSkin(account)) {
    return { ok: false, error: '离线账号没有网上的皮肤' }
  }

  // 缺令牌的话，"查不到皮肤"这个说法是错的——得说清是账号状态不对
  // （实测踩过：令牌空着时提示了"这个账号还没设皮肤"，完全指错方向）
  if (account.type === 'microsoft' && !account.mcAccessToken) {
    return { ok: false, error: '这个正版账号缺登录信息，重新登录一次就好' }
  }
  if (account.type === 'yggdrasil' && !account.accessToken) {
    return { ok: false, error: '这个外置账号缺登录信息，重新登录一次就好' }
  }

  let url = ''
  try {
    url =
      account.type === 'yggdrasil'
        ? await yggdrasil.skinUrl(account)
        : await microsoft.skinUrl(account)
  } catch (error) {
    // 拿地址失败多半是网络问题——**不该影响玩**，所以只说一句，
    // 界面那边保持现状（用默认皮肤）就行。
    // 报错要翻成人话：Node 原话是 `getaddrinfo ENOTFOUND xxx` 这种，用户看不懂
    if (error instanceof HttpError && error.statusCode === 204) {
      return { ok: false, error: '那台验证服务器上找不到这个角色' }
    }
    if (error instanceof HttpError && error.statusCode === 404) {
      return { ok: false, error: '那台验证服务器上没有这个角色' }
    }
    return { ok: false, error: yggdrasil.networkErrorText(error.message) }
  }

  if (!url) return { ok: false, error: '这个账号还没设皮肤' }

  // 【为什么对 http 网开一面】实测（2026-10-08）：**Mojang 自己的皮肤地址就是 http 的**
  // （`textures.minecraft.net`）。一开始我写的是"只认 https"，结果正版账号的皮肤
  // 一个都显示不出来——自己把自己的功能挡死了。
  // 规则改成：https 一律放行；http 只放行 Mojang 自家的皮肤域名，别处的明文地址不要。
  const isHttps = /^https:\/\//i.test(url)
  let isMojangHttp = false
  if (/^http:\/\//i.test(url)) {
    try {
      isMojangHttp = /(^|\.)minecraft\.net$/i.test(new URL(url).hostname)
    } catch {
      isMojangHttp = false
    }
  }

  if (!isHttps && !isMojangHttp) {
    return { ok: false, error: '服务器给的皮肤地址既不是 https、也不是官方域名，不用它' }
  }

  try {
    const buffer = await fetchBuffer(url, { timeout: 15000 })
    if (!buffer || buffer.length < 100) {
      return { ok: false, error: '皮肤文件是空的' }
    }
    return {
      ok: true,
      dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
      source: account.type
    }
  } catch (error) {
    return { ok: false, error: `皮肤没下下来（${error.message}）` }
  }
}

// ——————————————————————————————————————————————
// 本地皮肤库（M17.5）
// ——————————————————————————————————————————————
//
// 【为什么要把用户挑的皮肤**复制**一份进来】
// 以前只记了个路径：用户把那张图删了、挪走了，下次打开就变回默认皮肤，
// 而他完全不知道发生了什么。复制到 `%APPDATA%\毛球\skins\` 之后，
// 这份就是自己的了——也才有"本地保存"这个列表可列。
//
// 【绝不动用户原来的文件】复制，不是移动；「移除」删的也是我们复制进来的那份。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')

/** 皮肤库的文件夹 */
function skinsDir() {
  return path.join(paths.configDir(), 'skins')
}

/**
 * 看一眼这个 PNG 是不是 64×64（或 64×32 的老式皮肤）。
 * 【为什么要看】皮肤必须是这个尺寸，别的图贴上去只会是一团马赛克。
 * 直接读 PNG 文件头里的宽高，不用把整个图解出来——几行就够。
 *
 * @returns {{ok: boolean, width?: number, height?: number, error?: string}}
 */
function readPngSize(buffer) {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buffer || buffer.length < 24) return { ok: false, error: '这个文件太小了，不像是一张图' }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, error: '皮肤得是 PNG 格式的图（jpg 不行）' }
  }
  // PNG 的 IHDR 块固定在第 16 字节开始：宽 4 字节、高 4 字节
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return { ok: true, width, height }
}

/** 把文件名里 Windows 不认的字符换掉（用户挑的文件名什么都可能有） */
function safeFileName(name) {
  const cleaned = String(name || 'skin')
    .replace(/\.png$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 40)
  return cleaned || 'skin'
}

/** 列皮肤库里现有的皮肤（按放进去的时间倒序：最新传的排前面） */
function listLocal() {
  let names = []
  try {
    names = fs.readdirSync(skinsDir())
  } catch {
    return [] // 还没传过任何皮肤
  }

  const out = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.png')) continue
    const full = path.join(skinsDir(), name)
    try {
      const info = fs.statSync(full)
      out.push({ name: name.replace(/\.png$/i, ''), path: full, mtime: info.mtimeMs })
    } catch {
      // 读不到就算了
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/**
 * 把用户挑的皮肤收进皮肤库。
 * @returns {{ok: boolean, path?: string, name?: string, error?: string}}
 */
function importFile(sourcePath) {
  let buffer
  try {
    buffer = fs.readFileSync(sourcePath)
  } catch {
    return { ok: false, error: '这个文件读不出来（可能被删了或者没权限）' }
  }

  const size = readPngSize(buffer)
  if (!size.ok) return size
  // 老式皮肤是 64×32，现在的是 64×64，两种都收
  if (size.width !== 64 || (size.height !== 64 && size.height !== 32)) {
    return {
      ok: false,
      error: `皮肤的尺寸得是 64×64（老式的是 64×32），这张是 ${size.width}×${size.height}`
    }
  }

  const dir = skinsDir()
  paths.ensureDir(dir)

  // 重名就往后加数字：别覆盖用户之前传的那张
  const base = safeFileName(path.basename(sourcePath))
  let target = path.join(dir, `${base}.png`)
  let n = 2
  while (fs.existsSync(target)) {
    target = path.join(dir, `${base}-${n}.png`)
    n++
  }

  try {
    fs.copyFileSync(sourcePath, target)
  } catch (error) {
    return { ok: false, error: `复制不过来：${error.message}` }
  }

  return { ok: true, path: target, name: path.basename(target, '.png') }
}

/**
 * 从皮肤库里删一份。
 *
 * 【只删我们自己复制进来的那份】先卡一道"这个路径必须在皮肤库里"，
 * 免得传进来别的路径把用户的文件删了（界面是我们自己写的，但这条规矩不靠它）。
 */
function removeLocal(target) {
  const dir = path.resolve(skinsDir())
  const full = path.resolve(String(target || ''))
  if (!full.startsWith(dir + path.sep)) {
    return { ok: false, error: '只能删皮肤库里的文件' }
  }
  try {
    fs.rmSync(full, { force: true })
  } catch (error) {
    return { ok: false, error: `删不掉：${error.message}` }
  }
  return { ok: true }
}

module.exports = {
  hasRemoteSkin,
  fetchFor,
  skinsDir,
  listLocal,
  importFile,
  removeLocal,
  readPngSize
}

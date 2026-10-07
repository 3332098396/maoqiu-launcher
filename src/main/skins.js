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

module.exports = { hasRemoteSkin, fetchFor }

// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 下载源镜像切换
//
// 【为什么需要这个】
// Minecraft 的文件都在国外（Mojang 的服务器），国内直连很慢，有时根本连不上。
// 国内有志愿者把文件镜像了一份（BMCLAPI，bangbang93 维护），
// 把地址换一换就能从国内下，快很多。
//
// 【映射规则不是简单换个域名——这是实测出来的】
// 不同资源的路径规则不一样，猜错就会下载失败：
//
//   官方域名                                镜像地址
//   ─────────────────────────────────────  ──────────────────────────────
//   piston-meta.mojang.com/xxx             bmclapi2.bangbang93.com/xxx        （同路径）
//   piston-data.mojang.com/xxx             bmclapi2.bangbang93.com/xxx        （同路径）
//   launchermeta.mojang.com/xxx            bmclapi2.bangbang93.com/xxx        （同路径）
//   libraries.minecraft.net/xxx            bmclapi2.bangbang93.com/maven/xxx  （要加 /maven）
//   resources.download.minecraft.net/xxx   bmclapi2.bangbang93.com/assets/xxx （要加 /assets）
//
// 后两条特别容易搞错：直接换域名会返回 404，必须带上那个前缀。
//
// 【关于 302 跳转】
// 镜像的部分地址会先返回 302，跳到它自己的对象存储（minio.749333.xyz）。
// 这是正常的，下载时跟着跳转走就行，不用特殊处理。

const MIRROR_HOST = 'bmclapi2.bangbang93.com'

/**
 * 把一个官方下载地址换成镜像地址。
 * @param {string} url 官方地址
 * @returns {string|null} 镜像地址；如果这个地址没有对应镜像，返回 null
 */
function toMirror(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const suffix = `${parsed.pathname}${parsed.search}`

  switch (parsed.hostname) {
    // 这三个站是"路径原样搬过去"，直接换域名即可
    case 'piston-meta.mojang.com':
    case 'piston-data.mojang.com':
    case 'launchermeta.mojang.com':
      return `https://${MIRROR_HOST}${suffix}`

    // 库文件：镜像把它们放在 /maven 下面
    case 'libraries.minecraft.net':
      return `https://${MIRROR_HOST}/maven${suffix}`

    // 音效语言贴图这些：镜像放在 /assets 下面
    case 'resources.download.minecraft.net':
      return `https://${MIRROR_HOST}/assets${suffix}`

    // Fabric 的库文件仓库，镜像同样放在 /maven 下面（实测 0.2 秒，官方要 30 秒+）
    case 'maven.fabricmc.net':
      return `https://${MIRROR_HOST}/maven${suffix}`

    // Forge 的仓库。在国内**直接连不上**（实测请求都发不出去），
    // 镜像在 /maven 下面（实测 0.6 秒）
    case 'maven.minecraftforge.net':
      return `https://${MIRROR_HOST}/maven${suffix}`

    // 【NeoForge 要单独一条：官方路径比镜像多一段 releases/】
    //   官方：https://maven.neoforged.net/releases/net/neoforged/xxx.jar
    //   镜像：https://bmclapi2.bangbang93.com/maven/net/neoforged/xxx.jar
    // 照搬会变成 /maven/releases/… → **404**。
    // 2026-10-16 实测：装 NeoForge 21.0.167 时 12 个库全 404（JarJar、modlauncher、
    // fancymodloader 这些），去掉 releases 那一段再试全 200。
    case 'maven.neoforged.net':
      return `https://${MIRROR_HOST}/maven${suffix.replace(/^\/releases\//, '/')}`

    // 不认识的地址不动它——宁可用官方源，也不要伪造一个可能不存在的地址
    default:
      return null
  }
}

/** 这个地址有没有对应的镜像 */
function hasMirror(url) {
  return toMirror(url) !== null
}

/**
 * "同一个官方厂商的另一个域名" —— 这不是第三方镜像，是官方自己还有一条路。
 *
 * 【为什么单列一条，不并进 toMirror】
 * Modrinth 的文件走 `cdn.modrinth.com`，国内实测只有 **4~7 KB/s**——
 * 一个 3 MB 的数据包要下十分钟，几百 MB 的整合包压根下不动。
 * 而 Modrinth 自己的 `cdn-raw.modrinth.com` **同一个文件 1.4 MB/s**，
 * 下下来的 sha1 一模一样（实测三次，稳定复现）。
 * 既然还是官方的服务器，那就跟"用不用国内镜像"是两码事：
 * **用户选了"只用官方"，走 cdn-raw 也还是官方**，不算违背他的选择。
 *
 * @returns {{fast: string, slow: string|null}|null} 快的那个和垫底的退路（没有退路时 slow 为 null）；不是这两家就返回 null
 */
function officialFastPair(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const suffix = `${parsed.pathname}${parsed.search}`

  if (parsed.hostname === 'cdn.modrinth.com') {
    return {
      fast: `https://cdn-raw.modrinth.com${suffix}`,
      slow: `https://cdn.modrinth.com${suffix}`
    }
  }

  // 【NeoForge：官方自家还有一条 CDN，两条路都得给下载器】
  //   官方仓库 maven.neoforged.net 在国内**连请求都发不出去**（实测超时）；
  //   官方自己还有 neoforged.forgecdn.net，**路径规则一模一样**（releases/ 段保留）。
  //
  //   2026-10-17 实测（同一个文件比两家，单位 B/s）：
  //     · 安装器 6.97 MB    ：BMCLAPI **9 KB / 27 B**（在爬）  forgecdn **515 KB ~ 2.0 MB**
  //     · universal.jar 3.5 MB：BMCLAPI 183~345 KB            forgecdn 765 KB ~ 1.3 MB
  //     · neoform 库 zip     ：BMCLAPI **1.9 MB / 1.5 MB**      forgecdn 382~569 KB
  //   ⇒ **哪边快是要看文件的**，不存在"一方永远赢"。所以我们只做一件事：
  //     把"已知连不上"的官方仓库换成它的快 CDN，**同时把镜像留作第二个候选**，
  //     让下载器自己按实测速度换边（downloader.js 的 badStreak 机制，阈值 200 KB/s）。
  //     以前库地址被提前写死成镜像，候选只有一个，那套换源机制压根没有别的可换。
  if (parsed.hostname === 'maven.neoforged.net') {
    return { fast: `https://neoforged.forgecdn.net${suffix}`, slow: null }
  }

  return null
}

/** 这个地址是不是 NeoForge 官方仓库的文件（这类要交给 officialFastPair 处理，别写死成镜像） */
function isNeoForgeUrl(url) {
  try {
    return new URL(url).hostname === 'maven.neoforged.net'
  } catch {
    return false
  }
}

module.exports = { toMirror, hasMirror, officialFastPair, isNeoForgeUrl, MIRROR_HOST }

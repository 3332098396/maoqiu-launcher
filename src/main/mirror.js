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

    // Forge / NeoForge 的仓库。这两个在国内**直接连不上**（实测请求都发不出去），
    // 镜像同样在 /maven 下面（实测 0.6 秒）
    case 'maven.minecraftforge.net':
    case 'maven.neoforged.net':
      return `https://${MIRROR_HOST}/maven${suffix}`

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
 * @returns {{fast: string, slow: string}|null} 快的那个和垫底的退路；不是 Modrinth 就返回 null
 */
function officialFastPair(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== 'cdn.modrinth.com') return null

  const suffix = `${parsed.pathname}${parsed.search}`
  return {
    fast: `https://cdn-raw.modrinth.com${suffix}`,
    slow: `https://cdn.modrinth.com${suffix}`
  }
}

module.exports = { toMirror, hasMirror, officialFastPair, MIRROR_HOST }

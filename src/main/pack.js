// 毛球 — 整合包：识别 + 安装（M11）
//
// 用户把整合包压缩包**拖进窗口**，我们负责认出它是什么、然后照着装。
//
// 【能认的三种】
//  ① Modrinth 整合包（.mrpack）：里面有 modrinth.index.json，
//     列着每个 Mod 的**下载地址和校验码**，还有 overrides/ 文件夹
//     （作者的配置、按键设置这些）。**完全能装**。
//  ② PCL / HMCL 导出的整合包（.zip）：文件直接在里面（mods、config…），
//     解压摆放就行。**完全能装**。
//  ③ CurseForge 整合包（.zip）：里面只写着"第 12345 号 Mod 的第 67890 号文件"，
//     **没有下载地址**——官方给下载加了强制密钥，且不许把密钥放进公开软件。
//     这一种我们**能认出来，但下不了**，要明明白白告诉用户（别让人等一个做不出来的东西）。
//
// 加密压缩包（要输密码的）单独一层处理，见 M11.2。
//
// 当前进度：M11。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')
const zip = require('./zip')
const downloader = require('./downloader')
const install = require('./install')
const loaders = require('./loaders')
const forge = require('./forge')

/** .mrpack 里那个清单文件 */
const MRPACK_INDEX = 'modrinth.index.json'

/** 解压时挡在前面的公共前缀（有些包外面套了一层 .minecraft/） */
const WRAPPER_DIRS = ['.minecraft', 'minecraft']

/** 读一个压缩包（读不了 = 可能是加密的） */
function readArchive(filePath) {
  const buffer = fs.readFileSync(filePath)
  try {
    return { buffer, entries: zip.listEntries(buffer) }
  } catch (error) {
    return { buffer: null, entries: null, error: String(error?.message ?? error) }
  }
}

/** 包里的顶层文件夹都有什么（给用户看的） */
function topLevelNames(entries) {
  const names = new Set()
  for (const entry of entries) {
    const first = entry.name.replace(/^\//, '').split('/')[0]
    if (first && !first.startsWith('.')) names.add(first)
  }
  return [...names]
}

/**
 * 看一眼这个压缩包是什么。
 * @returns {{ok: boolean, kind: string, ...}}
 */
function inspect(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: '找不到这个文件' }
  }

  const archive = readArchive(filePath)

  if (!archive.entries) {
    return {
      ok: true,
      kind: 'encrypted',
      error: archive.error,
      name: path.basename(filePath),
      summary: '这个压缩包打不开——如果它带密码，M11.2 做完就能输了'
    }
  }

  const find = (name) => archive.entries.find((e) => e.name.replace(/^\//, '') === name)

  // ——— ① Modrinth ———
  const index = find(MRPACK_INDEX)
  if (index) {
    try {
      const data = JSON.parse(zip.readEntry(archive.buffer, index).toString('utf8'))
      const deps = data.dependencies || {}
      const loaderName = deps['fabric-loader']
        ? 'Fabric'
        : deps.forge
          ? 'Forge'
          : deps.neoforge
            ? 'NeoForge'
            : ''
      const loaderVersion = deps['fabric-loader'] || deps.forge || deps.neoforge || ''

      return {
        ok: true,
        kind: 'modrinth',
        name: data.name || path.basename(filePath, path.extname(filePath)),
        gameVersion: deps.minecraft || '',
        loader: loaderName,
        loaderVersion,
        fileCount: (data.files || []).length,
        hasOverrides: archive.entries.some((e) => e.name.startsWith('overrides/')),
        summary:
          `Modrinth 整合包：${data.name || '(没有名字)'}\n` +
          `需要 Minecraft ${deps.minecraft || '?'}` +
          (loaderName ? ` + ${loaderName} ${loaderVersion}` : '（不用加载器）') +
          `\n要下载 ${(data.files || []).length} 个文件`
      }
    } catch (error) {
      return { ok: false, error: `整合包里的清单读不出来：${error.message}` }
    }
  }

  // ——— ③ CurseForge ———
  const cfManifest = find('manifest.json')
  if (cfManifest) {
    try {
      const data = JSON.parse(zip.readEntry(archive.buffer, cfManifest).toString('utf8'))
      if (data.minecraft && data.files) {
        return {
          ok: true,
          kind: 'curseforge',
          name: data.name || path.basename(filePath, path.extname(filePath)),
          gameVersion: (data.minecraft && data.minecraft.version) || '',
          fileCount: data.files.length,
          summary:
            `CurseForge 整合包：${data.name || '(没有名字)'}\n` +
            `需要 Minecraft ${(data.minecraft && data.minecraft.version) || '?'}\n` +
            `里面 ${data.files.length} 个 Mod 只写了编号、**没有下载地址**`
        }
      }
    } catch {
      // 不是 CurseForge 的就往下走
    }
  }

  // ——— 不是 Modrinth / CurseForge 的，看看是不是"文件直接在里面"的整合包 ———
  const names = archive.entries.map((e) => e.name.replace(/^\//, ''))
  const tops = topLevelNames(archive.entries)
  const lowerTops = tops.map((name) => name.toLowerCase())

  // 整合包（PCL / HMCL 导出的）：看有没有这些标志性文件夹
  const modpackMarkers = ['mods', 'versions', '.minecraft']
  if (lowerTops.some((name) => modpackMarkers.includes(name))) {
    const gamedirLike = lowerTops.some((name) =>
      ['versions', '.minecraft', 'minecraft'].includes(name)
    )

    return {
      ok: true,
      kind: 'files',
      name: path.basename(filePath, path.extname(filePath)),
      layout: gamedirLike ? 'gamedir' : 'instance',
      topFolders: tops.slice(0, 8),
      fileCount: names.filter((n) => !n.endsWith('/')).length,
      summary:
        `整合包（文件直接在里面）：${path.basename(filePath)}\n` +
        `顶层有：${tops.slice(0, 6).join('、')}${tops.length > 6 ? '…' : ''}\n` +
        (gamedirLike
          ? '里面带着版本文件，会解到游戏目录里'
          : '会解到选中的那个版本自己的文件夹里')
    }
  }

  // ——— 到这里就不是整合包了 ———
  //
  // 【只认整合包】用户明确定过：**拖进来的必须是整合包**，
  // 其他东西（存档、资源包、随便一个压缩包）一律"识别失败"，
  // 并明确告诉用户"这不是有效的整合包"。不要自作主张去装别的东西。
  // 唯一"多做的"是看一眼它像什么，好让提示更懂人话。
  const looksLikeWorld = names.some((n) => n === 'level.dat' || n.endsWith('/level.dat'))
  const looksLikePack = names.includes('pack.mcmeta') || lowerTops.includes('shaders')

  const whatItIs = looksLikeWorld
    ? '看起来像是一个存档（世界）'
    : looksLikePack
      ? '看起来像是一个资源包或光影包'
      : `里面装的是：${tops.slice(0, 5).join('、')}${tops.length > 5 ? '…' : ''}`

  return {
    ok: true,
    kind: 'invalid',
    name: path.basename(filePath, path.extname(filePath)),
    topFolders: tops.slice(0, 8),
    summary:
      `这不是一个有效的整合包。\n${whatItIs}\n\n` +
      '本启动器只支持拖入整合包：Modrinth 的 .mrpack，' +
      '或者 PCL / HMCL 导出的整合包 .zip'
  }
}

/**
 * 装一个 Modrinth 整合包。
 *
 * 步骤：① 把需要的基础版本备齐（原版 + 加载器）
 *      ② 建一个"整合包自己的版本"（继承基础版本）
 *      ③ 按清单把文件下进这个版本的文件夹
 *      ④ 把 overrides/ 解开盖上去
 */
async function installModrinthPack(filePath, data, { onStage, onProgress, onTask } = {}) {
  const stage = (text) => {
    if (onStage) onStage(text)
  }

  const deps = data.dependencies || {}
  const gameVersion = String(deps.minecraft || '')

  if (!gameVersion) throw new Error('整合包没写需要哪个游戏版本，装不了')
  if (!paths.isVersionInstalled(gameVersion)) {
    throw new Error(
      `这个整合包需要 Minecraft ${gameVersion}，本机还没装——先到「下载」页把它装好`
    )
  }

  // ——— ① 基础版本：原版 + 加载器 ———
  let baseId = gameVersion

  const loaderKind = deps['fabric-loader'] ? 'fabric' : deps.forge ? 'forge' : deps.neoforge ? 'neoforge' : ''
  if (loaderKind) {
    const loaderVersion = String(deps['fabric-loader'] || deps.forge || deps.neoforge)
    stage(`正在准备 ${loaderKind} ${loaderVersion}…`)

    if (loaderKind === 'fabric') {
      const built = await loaders.buildFabricProfile(gameVersion, loaderVersion)
      if (!paths.isVersionInstalled(built.versionId)) {
        const r = await install.installVersion(built.versionId, {
          providedJson: built.json,
          onStage,
          onProgress,
          onTask
        })
        if (!r.ok) throw new Error(`装 Fabric 失败：${r.error}`)
      }
      baseId = built.versionId
    } else {
      const built = await forge.prepare(loaderKind, gameVersion, { onStage, onProgress, onTask })
      // 这一步只装"加载器版本"；如果整包指定的版本和最新版不一致，
      // 先用最新版跑通（版本号不合时会有提示）
      if (!paths.isVersionInstalled(built.versionId)) {
        const r = await install.installVersion(built.versionId, {
          providedJson: built.json,
          onStage,
          onProgress,
          onTask
        })
        if (!r.ok) throw new Error(`装 ${loaderKind} 失败：${r.error}`)
        await forge.runPatchers(built.patcher, { onStage, onProgress, onTask })
      }
      baseId = built.versionId
    }
  }

  // ——— ② 整合包自己的版本（继承上面那个） ———
  const packId = safePackName(data.name, data.versionId)
  stage(`正在建「${packId}」这个版本…`)

  const packJson = {
    id: packId,
    inheritsFrom: baseId,
    type: 'release',
    time: new Date().toISOString(),
    releaseTime: new Date().toISOString(),
    // 版本描述写清楚来源，以后在版本列表里一眼知道这是什么
    _packSource: 'Modrinth 整合包'
  }

  paths.ensureDir(paths.versionDir(packId))
  fs.writeFileSync(paths.versionJsonFile(packId), JSON.stringify(packJson, null, 2), 'utf8')

  // ——— ③ 按清单下文件 ———
  const files = []

  for (const item of data.files || []) {
    // env 里写了"不要"的（比如 server 专用的）就跳过
    if (item.env && item.env.client === 'unsupported') continue

    const url = (item.downloads || [])[0]
    if (!url || !item.path) continue

    // 目标路径要挡一下：包里可能写 ../../ 想跑到外面去
    const target = path.resolve(paths.versionDir(packId), item.path)
    if (!target.startsWith(path.resolve(paths.versionDir(packId)))) continue

    files.push({
      name: item.path,
      url,
      saveTo: target,
      sha1: (item.hashes && item.hashes.sha1) || '',
      size: item.fileSize || 0
    })
  }

  if (files.length > 0) {
    stage(`开始下载整合包里的 ${files.length} 个文件…`)
    const task = downloader.createTask(files, { onProgress })
    if (onTask) onTask(task)
    const stats = await task.start()
    if (stats.failed > 0) {
      const first = stats.failures[0]
      throw new Error(
        `有 ${stats.failed} 个文件没下成功（第一个：${first ? first.error : '未知原因'}）。` +
          '网络恢复后可以重新拖一次，已经下好的不会重下。'
      )
    }
  }

  // ——— ④ overrides：作者的配置、按键、资源包这些 ———
  const buffer = fs.readFileSync(filePath)
  const entries = zip.listEntries(buffer)
  const packRoot = path.resolve(paths.versionDir(packId))

  let overrides = 0
  for (const entry of entries) {
    const name = entry.name.replace(/^\//, '')
    const prefix = name.startsWith('client-overrides/')
      ? 'client-overrides/'
      : name.startsWith('overrides/')
        ? 'overrides/'
        : null
    if (!prefix || name.endsWith('/')) continue

    const rel = name.slice(prefix.length)
    const target = path.resolve(packRoot, rel)
    if (!target.startsWith(packRoot)) continue

    paths.ensureDir(path.dirname(target))
    fs.writeFileSync(target, zip.readEntry(buffer, entry))
    overrides++
  }

  stage('整合包安装完成')
  return { ok: true, versionId: packId, files: files.length, overrides }
}

/**
 * 装一个"文件直接在里面"的整合包（PCL / HMCL 导出的）。
 * layout='instance' → 解到选中的那个版本的文件夹
 * layout='gamedir'  → 解到游戏目录（里面带着版本文件的情况）
 */
async function installPlainPack(filePath, layout, targetVersionId, { onStage, onProgress } = {}) {
  const buffer = fs.readFileSync(filePath)
  const entries = zip.listEntries(buffer)

  let dest
  if (layout === 'gamedir') {
    dest = paths.gameDir()
  } else {
    if (!targetVersionId) throw new Error('没选装到哪个版本')
    dest = paths.versionDir(targetVersionId)
  }

  // 有些包外面套了一层 .minecraft/，那层要剥掉
  let wrapper = ''
  const firstDir = entries.length > 0 ? entries[0].name.replace(/^\//, '').split('/')[0] : ''
  if (WRAPPER_DIRS.includes(String(firstDir).toLowerCase())) {
    wrapper = `${firstDir}/`
  }

  if (onStage) onStage(`正在解压（${entries.length} 个文件）…`)

  const root = path.resolve(dest)
  const pending = entries.filter(
    (e) => !e.name.endsWith('/') && (!wrapper || e.name.startsWith(wrapper))
  )

  let written = 0
  for (const entry of pending) {
    const rel = wrapper ? entry.name.slice(wrapper.length) : entry.name.replace(/^\//, '')
    if (!rel) continue
    const target = path.resolve(root, rel)
    if (!target.startsWith(root)) continue

    paths.ensureDir(path.dirname(target))
    fs.writeFileSync(target, zip.readEntry(buffer, entry))
    written++

    if (onProgress && written % 50 === 0) {
      onProgress({ total: pending.length, done: written, percent: Math.round((written / pending.length) * 100) })
    }
  }

  if (onStage) onStage('解压完成')
  return { ok: true, written, dest }
}

/**
 * 整合包名字 → 版本文件夹名。
 *
 * 【为什么要清理】整合包名字会被当作版本文件夹名，而文件夹名会成为
 * 开了版本隔离后的"游戏目录"——游戏目录里出现 `\ / : * ? " < > |`
 * 这些字符在 Windows 上直接是非法路径，游戏必然起不来。
 * 中文本身合法（现代版本没问题），但很老的版本对中文路径不友好，
 * 所以这里只挡非法字符、保留中文（用户看得懂最重要）。
 */
function safePackName(name, versionId) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '') // Windows 非法字符
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 60)

  if (cleaned) return cleaned
  // 名字是空的（或者全是非法字符）→ 用版本号兜底
  const fallback = String(versionId || '').replace(/[\\/:*?"<>|]/g, '').trim()
  return fallback ? `整合包-${fallback}` : `整合包-${Date.now()}`
}

/** 把 .mrpack 里的清单读出来 */
function readModrinthIndex(filePath) {
  const buffer = fs.readFileSync(filePath)
  const entries = zip.listEntries(buffer)
  const index = entries.find((e) => e.name.replace(/^\//, '') === MRPACK_INDEX)
  if (!index) throw new Error('这不是 Modrinth 整合包（里面没有 modrinth.index.json）')
  return JSON.parse(zip.readEntry(buffer, index).toString('utf8'))
}

/**
 * 装一个整合包：自己先认一遍，再按类型装。
 * 界面只需要把"拖进来的文件路径"交给它就行。
 */
async function installPack(filePath, options = {}) {
  const info = inspect(filePath)

  if (!info.ok) return { ok: false, error: info.error }

  if (info.kind === 'encrypted') {
    return {
      ok: false,
      error: '这个压缩包打不开。如果它带密码，要等"加密压缩包"那一步做完才能装。'
    }
  }

  if (info.kind === 'curseforge') {
    return {
      ok: false,
      error:
        '这是 CurseForge 整合包，装不了——它里面只写了 Mod 的编号、没有下载地址，' +
        '而官方要求用密钥才能下载、并且不许把密钥放进公开软件里。\n' +
        '能用的办法：到 CurseForge 官网按这个整合包的清单手动下载 Mod，放进版本的 mods 文件夹。'
    }
  }

  if (info.kind === 'modrinth') {
    const data = readModrinthIndex(filePath)
    return installModrinthPack(filePath, data, options)
  }

  if (info.kind === 'invalid') {
    return { ok: false, error: '这不是一个有效的整合包，装不了。只支持整合包（.mrpack 或 PCL/HMCL 导出的 .zip）。' }
  }

  // 剩下的就是"整合包（文件直接在里面）"
  return installPlainPack(filePath, info.layout, options.targetVersionId, options)
}

module.exports = { inspect, installPack, installModrinthPack, installPlainPack }

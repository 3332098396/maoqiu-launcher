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

/** 读一个压缩包（读不了 = 多半是加密的，或者文件坏了） */
function readArchive(filePath) {
  const buffer = fs.readFileSync(filePath)
  try {
    return { buffer, entries: zip.listEntries(buffer) }
  } catch (error) {
    return { buffer: null, entries: null, error: String(error?.message ?? error) }
  }
}

/**
 * 密码行不行：挑一个**最小的**加密文件试解一下。
 *
 * 【为什么挑最小的】解一个文件就能知道密码对不对（解密算法自带校验），
 * 挑最小的那个最省时间。整合包里动辄几千个文件，不能挨个试。
 *
 * @returns {'ok' | 'wrong' | 'need'}
 */
function tryPassword(buffer, entries, password) {
  const locked = entries.filter((entry) => entry.encrypted && !entry.name.endsWith('/'))
  if (locked.length === 0) return 'ok'

  if (!password) return 'need'

  locked.sort((a, b) => a.compressedSize - b.compressedSize)

  try {
    zip.readEntry(buffer, locked[0], password)
    return 'ok'
  } catch (error) {
    if (error && error.code === 'WRONG_PASSWORD') return 'wrong'
    throw error
  }
}

/**
 * 包里的顶层文件夹都有什么（给用户看的，也用来判断"是不是整合包"）。
 *
 * 【踩过的坑】这里原来有一句"过滤掉点开头的名字"（本想滤掉 .DS_Store 这类），
 * 结果把 **`.minecraft`** 也滤掉了——而很多整合包（尤其 PCL 导出的）
 * 内容就装在 `.minecraft/` 里！判断"是不是整合包"时看不到它，
 * 就会把好好的整合包判成"不是整合包"（用户实测踩到）。
 * 现在只滤真正没用的那几个系统垃圾文件。
 */
const JUNK_NAMES = ['__macosx', '.ds_store', 'thumbs.db', 'desktop.ini']

/**
 * 解压时**根本不写进硬盘**的条目（M23，对齐 KAMUCL 那份跳过清单）。
 *
 * 【为什么要专门挡这几类】整合包是**别人做的**，里面什么都有可能。
 * 下面这几类要么对用户毫无用处、要么会让写入直接失败：
 *   · `__MACOSX/`、`.DS_Store`、`Thumbs.db`、`desktop.ini` —— 苹果/Windows 产生的垃圾
 *   · 顶层的 `logs/` `crash-reports/` —— 打包者的日志和崩溃报告，几百 MB 白占地方
 *   · Windows 保留名（con / nul / com1…）—— 写下去轻则失败，重则生成一个
 *     你在资源管理器里看不见也删不掉的文件
 *   · 单文件超过 512 MB —— 正常的游戏文件不会有这么大，多半是包里混进了别的东西
 *
 * 【注意】判断的是**相对路径的每一段**，不是只看顶层——`mods/__MACOSX/` 这种
 * 夹在中间的也得挡掉（打包工具会把资源目录整个带上）。
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** 单个文件超过这个大小就不解压 */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024

function unsafeEntry(name, size) {
  const clean = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean) return true

  const segments = clean.split('/')

  // ① 苹果塞进来的元数据目录
  if (segments.some((one) => one.toLowerCase() === '__macosx')) return true

  // ② 系统垃圾文件
  if (JUNK_NAMES.includes(segments[segments.length - 1].toLowerCase())) return true

  // ③ 打包者的日志 / 崩溃报告
  const first = segments[0].toLowerCase()
  if (first === 'logs' || first === 'crash-reports') return true

  // ④ Windows 保留名
  if (segments.some((one) => WINDOWS_RESERVED.test(one))) return true

  // ⑤ 巨无霸单文件
  if (Number(size) > MAX_ENTRY_BYTES) return true

  return false
}

function topLevelNames(entries) {
  const names = new Set()
  for (const entry of entries) {
    const first = entry.name.replace(/^\//, '').split('/')[0]
    if (!first) continue
    if (JUNK_NAMES.includes(first.toLowerCase())) continue
    names.add(first)
  }
  return [...names]
}

/**
 * 看一眼这个压缩包是什么。
 * @returns {{ok: boolean, kind: string, ...}}
 */
function inspect(filePath, password) {
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
      summary:
        '这个压缩包连目录都读不出来，可能是坏了、也可能是一种我们还不认识的加密方式。'
    }
  }

  // ——— 带密码的：先问密码，密码对了再往下认 ———
  if (zip.isEncrypted(archive.entries)) {
    const state = tryPassword(archive.buffer, archive.entries, password)

    if (state === 'need') {
      return {
        ok: true,
        kind: 'encrypted',
        needPassword: true,
        name: path.basename(filePath),
        summary:
          '这个压缩包带密码。密码一般在下载它的那个帖子 / 群里写着——输进去就能装。'
      }
    }

    if (state === 'wrong') {
      return {
        ok: true,
        kind: 'encrypted',
        needPassword: true,
        badPassword: true,
        name: path.basename(filePath),
        summary: '密码不对，再想想？'
      }
    }

    // 密码对了，接着往下认（下面的读取都要带上密码）
  }

  const find = (name) => archive.entries.find((e) => e.name.replace(/^\//, '') === name)

  // ——— ① Modrinth ———
  const index = find(MRPACK_INDEX)
  if (index) {
    try {
      const data = JSON.parse(zip.readEntry(archive.buffer, index, password).toString('utf8'))
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
        // 界面上"这个版本叫什么"那个框预填它（用户想改就改）
        suggestedName: safePackName(data.name, data.versionId),
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
      const data = JSON.parse(zip.readEntry(archive.buffer, cfManifest, password).toString('utf8'))
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
      // 带着版本文件夹的那种包，才能给它起名字（另一种是解到已有版本里，没名字可起）
      suggestedName: gamedirLike ? packVersionOf(archive.entries, detectWrapper(archive.entries)) : '',
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
 * 版本名（我们建的那个版本文件夹叫什么）能不能用。
 *
 * 【为什么得挑一遍】这个名字直接就是 `versions\<名字>\` 这个文件夹名，
 * 所以 Windows 不认的符号、系统保留名都不能进——不然安装会以一句
 * 用户看不懂的系统错误收场。
 *
 * 另外还会查一句"是不是已经有同名版本了"：**那不算错**（重装同一个包很常见），
 * 但要提前告诉用户会发生什么。
 *
 * 【和界面的关系】界面那边每敲一个字就问一次这个函数（走 pack:check-name），
 * 这样"名字行不行"的规矩只有这一份，不会两边写得不一样。
 *
 * @returns {{ok: boolean, name?: string, error?: string, warning?: string}}
 */
function checkVersionName(rawName, dir) {
  const name = String(rawName || '').trim()

  if (!name) return { ok: false, error: '给它起个名字' }
  if (name.length > 64) return { ok: false, error: '名字太长了（64 个字以内）' }
  if (name === '.' || name === '..') return { ok: false, error: '这个名字不能用' }
  if (/[\\/:*?"<>|]/.test(name)) {
    return { ok: false, error: '名字里不能有 \\ / : * ? " < > | 这些符号' }
  }
  if (/[. ]$/.test(name)) {
    return { ok: false, error: '名字最后别用空格或点号（Windows 存不下这样的文件夹）' }
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    return { ok: false, error: `「${name}」是 Windows 自己留着的名字，换一个` }
  }

  // 已经有同名的了：不是错，但要说清楚
  if (fs.existsSync(paths.versionDir(name, dir))) {
    return {
      ok: true,
      name,
      warning:
        `本机已经有个版本叫「${name}」——装进去会把包里带的文件覆盖上去。` +
        '你自己的存档、后加的 Mod 不会被删。'
    }
  }

  return { ok: true, name }
}

/**
 * 定这个整合包的版本叫什么：用户起了名就用用户的，没起就用包里自带的。
 * 名字不合法就抛错（界面也会拦，但这里必须再拦一道——不能只信界面）。
 */
function resolvePackVersionName(suggested, userWanted, dir) {
  if (!userWanted) return suggested

  const checked = checkVersionName(userWanted, dir)
  if (!checked.ok) throw new Error(checked.error)
  return checked.name
}

/**
 * 包里带着哪个版本？（找 `versions/<名字>/<某文件>.json`）
 * 有的包会同时带着原版和加载器版，那就挑带加载器名的那个——那才是要玩的。
 */
function packVersionOf(entries, wrapper) {
  const pattern = new RegExp(`^${escapeRegExp(wrapper)}versions/([^/]+)/[^/]+\\.json$`)
  const ids = new Set()

  for (const entry of entries) {
    const match = entry.name.match(pattern)
    if (match) ids.add(match[1])
  }

  const preferred = [...ids].find((id) => /forge|fabric|neoforge/i.test(id))
  return preferred || [...ids][0] || ''
}

/**
 * 装一个 Modrinth 整合包。
 *
 * 步骤：① 把需要的基础版本备齐（原版 + 加载器）
 *      ② 建一个"整合包自己的版本"（继承基础版本）
 *      ③ 按清单把文件下进这个版本的文件夹
 *      ④ 把 overrides/ 解开盖上去
 */
async function installModrinthPack(filePath, data, { onStage, onProgress, onTask, versionName, dir } = {}) {
  const stage = (text) => {
    if (onStage) onStage(text)
  }

  const deps = data.dependencies || {}
  const gameVersion = String(deps.minecraft || '')

  if (!gameVersion) throw new Error('整合包没写需要哪个游戏版本，装不了')

  // 需要的基础版本没装过就**顺手一起装上**。
  //
  // 【为什么不报错让用户自己去装】从「下载」页点整合包的「下载」，用户的意思就是
  // "把这个包装上"；中间把他轰去别的页面手动装一遍原版，多半就卡在这儿不装了
  // （实测：点下载直接弹"本机还没装——先到「下载」页把它装好"，等于这功能用不了）。
  // 拖进来的整合包也一样受益：这东西本来就该是一键装完的。
  if (!paths.isVersionInstalled(gameVersion, dir)) {
    stage(`这个整合包需要 Minecraft ${gameVersion}，正在顺手把它装上…`)
    const r = await install.installVersion(gameVersion, { dir, onStage, onProgress, onTask })
    if (!r.ok) throw new Error(`装 Minecraft ${gameVersion} 失败：${r.error}`)
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
          dir,
          onStage,
          onProgress,
          onTask
        })
        if (!r.ok) throw new Error(`装 Fabric 失败：${r.error}`)
      }
      baseId = built.versionId
    } else {
      const built = await forge.prepare(loaderKind, gameVersion, { onStage, onProgress, onTask, dir })
      // 这一步只装"加载器版本"；如果整包指定的版本和最新版不一致，
      // 先用最新版跑通（版本号不合时会有提示）
      if (!paths.isVersionInstalled(built.versionId)) {
        const r = await install.installVersion(built.versionId, {
          providedJson: built.json,
          dir,
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
  const packId = resolvePackVersionName(safePackName(data.name, data.versionId), versionName, dir)
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

  paths.ensureDir(paths.versionDir(packId, dir))
  fs.writeFileSync(paths.versionJsonFile(packId, dir), JSON.stringify(packJson, null, 2), 'utf8')

  // ——— ③ 按清单下文件 ———
  const files = []

  for (const item of data.files || []) {
    // env 里写了"不要"的（比如 server 专用的）就跳过
    if (item.env && item.env.client === 'unsupported') continue

    const url = (item.downloads || [])[0]
    if (!url || !item.path) continue

    // 目标路径要挡一下：包里可能写 ../../ 想跑到外面去
    const target = path.resolve(paths.versionDir(packId, dir), item.path)
    if (!target.startsWith(path.resolve(paths.versionDir(packId, dir)))) continue

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
  const packRoot = path.resolve(paths.versionDir(packId, dir))

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
    if (unsafeEntry(rel, entry.size)) continue

    const target = path.resolve(packRoot, rel)
    if (!target.startsWith(packRoot)) continue

    paths.ensureDir(path.dirname(target))
    // Modrinth 的 .mrpack 从不加密，这儿没有密码可传（以前误用了外层的 password 变量，
    // 从「下载」页下整合包时直接报 "password is not defined"——拖放那条路没走到这儿，
    // 所以一直没露出来）
    fs.writeFileSync(target, zip.readEntry(buffer, entry, ''))
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
async function installPlainPack(filePath, layout, targetVersionId, { onStage, onProgress, versionName, dir, password } = {}) {
  const buffer = fs.readFileSync(filePath)
  const entries = zip.listEntries(buffer)

  // ——— "整个游戏目录快照"的包（PCL 导出的通常是这种）———
  //
  // 【它的结构长这样】（实测一个 1 GB 的真包）：
  //   .minecraft/versions/<版本名>/   ← 版本文件夹：jar、版本 JSON、mods、config…
  //   .minecraft/assets/  libraries/  ← 共享文件
  //   PCL.ini / launcher_profiles.json / PCL/ / PCL.exe  ← 附带的启动器，没用
  //
  // 巧的是 **PCL 的"版本隔离"布局和我们的一模一样**（版本文件夹里装游戏文件），
  // 所以照搬就行：versions / assets / libraries 原样放，
  // 其余的游戏文件归到版本文件夹里，PCL 自己的东西丢掉。
  if (layout === 'gamedir') {
    return installGameDirPack(buffer, entries, { onStage, onProgress, versionName, dir, password })
  }

  let dest = null
  if (targetVersionId) dest = paths.versionDir(targetVersionId, dir)
  if (!dest) throw new Error('没选装到哪个版本')

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
  let refused = 0
  for (const entry of pending) {
    const rel = wrapper ? entry.name.slice(wrapper.length) : entry.name.replace(/^\//, '')
    if (!rel) continue
    if (unsafeEntry(rel, entry.size)) {
      refused++
      continue
    }
    const target = path.resolve(root, rel)
    if (!target.startsWith(root)) continue

    paths.ensureDir(path.dirname(target))
    fs.writeFileSync(target, zip.readEntry(buffer, entry, password))
    written++

    if (onProgress && written % 50 === 0) {
      onProgress({ total: pending.length, done: written, percent: Math.round((written / pending.length) * 100) })
    }
  }

  if (onStage) onStage('解压完成')
  return { ok: true, written, refused, dest }
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
function readModrinthIndex(filePath, password) {
  const buffer = fs.readFileSync(filePath)
  const entries = zip.listEntries(buffer)
  const index = entries.find((e) => e.name.replace(/^\//, '') === MRPACK_INDEX)
  if (!index) throw new Error('这不是 Modrinth 整合包（里面没有 modrinth.index.json）')
  return JSON.parse(zip.readEntry(buffer, index, password).toString('utf8'))
}

/**
 * 装一个整合包：自己先认一遍，再按类型装。
 * 界面只需要把"拖进来的文件路径"交给它就行。
 */
async function installPack(filePath, options = {}) {
  // 认包的时候就把密码带上——加密包里连清单都读不出来，不给密码认不出是什么包
  const info = inspect(filePath, options.password)

  if (!info.ok) return { ok: false, error: info.error }

  if (info.kind === 'encrypted') {
    return {
      ok: false,
      error: info.needPassword
        ? info.badPassword
          ? '密码不对，装不了。回对话框里重新输一次吧。'
          : '这个压缩包要密码才能装。回对话框里把密码输进去。'
        : '这个压缩包打不开，可能是坏了。'
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
    const data = readModrinthIndex(filePath, options.password)
    return installModrinthPack(filePath, data, options)
  }

  if (info.kind === 'invalid') {
    return { ok: false, error: '这不是一个有效的整合包，装不了。只支持整合包（.mrpack 或 PCL/HMCL 导出的 .zip）。' }
  }

  // 剩下的就是"整合包（文件直接在里面）"
  return installPlainPack(filePath, info.layout, options.targetVersionId, options)
}

/**
 * 装一个"整个游戏目录快照"的整合包（里面是 .minecraft/ 那种）。
 * 见 installPlainPack 里那段说明：我们的布局和 PCL 的一样，照搬即可。
 */
async function installGameDirPack(buffer, entries, { onStage, onProgress, versionName, dir, password } = {}) {
  const stage = (text) => {
    if (onStage) onStage(text)
  }

  // 剥掉外面套的那层（.minecraft/ 或者别的单个文件夹）
  const wrapper = detectWrapper(entries)

  // 包里带着哪个版本？
  const packVersion = packVersionOf(entries, wrapper)

  // 用户给这个包起了名字，就用他的（起名字 = 这个版本的文件夹叫什么）
  const targetVersion = resolvePackVersionName(packVersion, versionName, dir)
  const renaming = Boolean(packVersion && targetVersion && targetVersion !== packVersion)

  const SHARED = ['versions/', 'assets/', 'libraries/', 'runtime/']

  const pending = entries.filter(
    (entry) => !entry.name.endsWith('/') && entry.name.startsWith(wrapper) && entry.name !== wrapper
  )

  const gameRoot = path.resolve(paths.gameDir(dir))
  const versionRoot = targetVersion ? path.resolve(paths.versionDir(targetVersion, dir)) : gameRoot

  let written = 0
  let skipped = 0
  let refused = 0

  for (const entry of pending) {
    let rel = entry.name.slice(wrapper.length)

    // PCL 自己的东西（启动器本体、它的配置）——对我们没用
    if (rel === 'PCL.ini' || rel === 'launcher_profiles.json') continue
    if (/^pcl\//i.test(rel) || /plain craft launcher/i.test(rel)) continue

    // 系统垃圾 / 打包者日志 / Windows 保留名 / 超大文件（见 unsafeEntry 的说明）
    if (unsafeEntry(rel, entry.size)) {
      refused++
      continue
    }

    // ——— 改名字：versions\<包里的名字>\… → versions\<用户起的名字>\… ———
    //
    // 【为什么连文件名都要改】游戏是按 **版本名** 找东西的：
    // 版本文件必须叫 `versions\<名字>\<名字>.json`，客户端 jar 也得叫 `<名字>.jar`
    // （启动参数里的 `-DignoreList=…,${version_name}.jar` 就指着它）。
    // 只改文件夹名不改文件名，游戏会找不到版本。
    const oldPrefix = `versions/${packVersion}/`
    let newName = ''
    if (renaming && rel.startsWith(oldPrefix)) {
      const rest = rel.slice(oldPrefix.length)
      // 版本文件夹"门口"那几个文件（json、jar）的文件名要跟着改；里面的一层层目录不动
      newName = rest.includes('/') ? rest : rest.replace(packVersion, targetVersion)
      // 注意是 versions/<新名字>/…，不是把新名字接到旧文件夹后面（这里第一版写错过）
      rel = `versions/${targetVersion}/${newName}`
    }

    const shared = SHARED.some((prefix) => rel.startsWith(prefix))
    const root = shared ? gameRoot : versionRoot
    const dest = path.resolve(root, rel)

    // 安全：别让压缩包里的 ../ 跑到外面去
    if (dest !== root && !dest.startsWith(root + path.sep)) continue

    paths.ensureDir(path.dirname(dest))

    // 文件已经在了、大小也一样 → 跳过（省的重复写几百 MB，实测能省一大半时间）
    try {
      const stat = fs.statSync(dest)
      if (stat.isFile() && stat.size === entry.size) {
        skipped++
        continue
      }
    } catch {
      // 不存在就往下走
    }

    let data = zip.readEntry(buffer, entry, password)

    // 版本 JSON 里写着 `"id": "老名字"`，也得改成新名字——游戏认的是这个
    if (renaming && newName === `${targetVersion}.json`) {
      try {
        const parsed = JSON.parse(data.toString('utf8'))
        parsed.id = targetVersion
        data = Buffer.from(JSON.stringify(parsed, null, 2), 'utf8')
      } catch {
        // 不是 JSON 就原样写下去
      }
    }

    fs.writeFileSync(dest, data)
    written++

    if (onProgress && written % 100 === 0) {
      onProgress({
        total: pending.length,
        done: written + skipped,
        percent: Math.round(((written + skipped) / pending.length) * 100)
      })
    }
  }

  stage('整合包安装完成')
  return { ok: true, written, skipped, refused, versionId: targetVersion, dest: paths.gameDir(dir), dir: paths.gameDir(dir) }
}

/** 找出"外面套的那层"目录（.minecraft/ 或者单个文件夹）；没有就返回空 */
function detectWrapper(entries) {
  const tops = topLevelNames(entries)

  // 最常见的：套了一层 .minecraft/
  const dotMinecraft = tops.find((name) => name.toLowerCase() === '.minecraft')
  if (dotMinecraft) return `${dotMinecraft}/`

  // 整个包只有唯一一个顶层目录 → 那它就是外壳
  if (tops.length === 1 && entries.some((e) => e.name.startsWith(`${tops[0]}/`))) {
    return `${tops[0]}/`
  }

  return ''
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = {
  inspect,
  checkVersionName,
  installPack,
  installModrinthPack,
  installPlainPack,
  installGameDirPack
}

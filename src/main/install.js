// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 安装一个版本
//
// 干的事：拿版本 JSON，算出"要下哪些文件、放到哪"，然后交给下载引擎去下。
//
// 装一个版本要下四样东西：
//   ① 客户端 jar          ~20 MB，一个文件
//   ② libraries 库文件    ~150 MB，一百多个 jar（所有版本共享）
//   ③ assets 资源文件     ~300-800 MB，几千个小文件（所有版本共享，最耗时）
//   ④ Java 运行时         ~100 MB（按版本要求下对应的那一个）
//
// ②③ 是共享的：装第二个版本时大部分文件已经在了，校验一下跳过即可，
// 所以会快非常多。
//
// 当前进度：M4。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fetchJson } = require('./http')
const paths = require('./paths')
const mojang = require('./mojang')
const downloader = require('./downloader')
const zip = require('./zip')
const inherit = require('./inherit')

/**
 * Java 运行时清单的地址。
 *
 * 中间那串是 Mojang 给启动器版本编的号，**写死在地址里**。
 * 万一哪天 Mojang 换了编号，这里会 404——所以整段逻辑外面包了 try/catch，
 * 拿不到清单就自动降级成"让用户手动指定 Java"。
 */
const JAVA_RUNTIME_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'

// ——————————————————————————————————————————————
// 环境判断
// ——————————————————————————————————————————————

/** 当前系统在 Mojang 的清单里叫什么名字 */
function currentOsName() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'osx'
  return 'linux'
}

/** 当前架构在清单里叫什么（Node 说 'ia32'，Mojang 说 'x86'） */
function currentArch() {
  if (os.arch() === 'x64') return 'x64'
  if (os.arch() === 'ia32') return 'x86'
  if (os.arch() === 'arm64') return 'arm64'
  return os.arch()
}

/** 当前系统版本号，用来匹配形如 ^10\. 的规则 */
function currentOsVersion() {
  return os.release()
}

/** 当前环境（给规则判断用）。装版本和启动游戏都要，做成一个函数避免两处不一致 */
function buildContext() {
  return {
    osName: currentOsName(),
    arch: currentArch(),
    osVersion: currentOsVersion(),
    features: {}
  }
}

// ——————————————————————————————————————————————
// 版本 JSON 里的 rules 怎么读
// ——————————————————————————————————————————————

/**
 * 一条规则适不适用当前环境。
 * 规则大概长这样：
 *   { action: 'allow', os: { name: 'windows', version: '^10\\.' } }
 *   { action: 'disallow', os: { name: 'osx' } }
 */
function ruleMatches(rule, ctx) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== ctx.osName) return false
    if (rule.os.arch && rule.os.arch !== ctx.arch) return false
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(ctx.osVersion)) return false
      } catch {
        // 正则写坏了就当它不匹配，不要让整个安装因此中断
        return false
      }
    }
  }

  // features 是官方启动器的一些开关（比如"是不是演示模式"）。
  // 我们不是官方启动器，一律当作"没有这个特性"。
  if (rule.features) {
    for (const [name, wanted] of Object.entries(rule.features)) {
      if (wanted && !ctx.features[name]) return false
    }
  }

  return true
}

/**
 * 一组规则最后是允许还是禁止。没有规则就是允许。
 * 规则按顺序应用，后面的覆盖前面的。
 */
function rulesAllow(rules, ctx) {
  if (!Array.isArray(rules) || rules.length === 0) return true

  let allowed = false
  for (const rule of rules) {
    if (ruleMatches(rule, ctx)) allowed = rule.action === 'allow'
  }
  return allowed
}

// ——————————————————————————————————————————————
// 算出要下哪些文件
// ——————————————————————————————————————————————

/**
 * @param {{onStage?: Function, rootId?: string}} options
 *   rootId 是"继承链最底下那个带客户端 jar 的版本"；
 *   不传就当这个版本自己就是（普通原版就是这样）
 * @returns {Promise<{files: Array, natives: Array, javaComponent: string|null, needsNatives: string[]}>}
 */
async function buildFileList(versionId, versionJson, { onStage, rootId, dir } = {}) {
  const ctx = buildContext()

  const files = []
  const natives = []

  // ——— ① 客户端 jar ———
  // 装了 Mod 加载器的版本自己没有客户端 jar（它继承原版的），
  // 这时候要确认原版那份在硬盘上
  if (rootId && rootId !== versionId) {
    if (!fs.existsSync(paths.versionJarFile(rootId, dir))) {
      throw new Error(`缺了 ${rootId} 的客户端文件——先到「下载」页把它装好`)
    }
  } else {
    const client = versionJson.downloads && versionJson.downloads.client
    if (client) {
      files.push({
        name: `${versionId}.jar`,
        url: client.url,
        saveTo: paths.versionJarFile(versionId, dir),
        sha1: client.sha1,
        size: client.size
      })
    }
  }

  // ——— ② libraries ———
  for (const lib of versionJson.libraries || []) {
    if (!rulesAllow(lib.rules, ctx)) continue

    // 普通库文件
    const artifact = lib.downloads && lib.downloads.artifact
    if (artifact && artifact.url) {
      files.push({
        name: artifact.path || path.basename(artifact.url),
        url: artifact.url,
        saveTo: path.join(paths.librariesDir(dir), artifact.path),
        sha1: artifact.sha1,
        size: artifact.size
      })
    }

    // 老版本才有：natives 是压缩包，要单独解压
    natives.push(...nativesFromLibrary(lib, ctx, dir))
  }

  // ——— ③ assets ———
  const assetIndex = versionJson.assetIndex
  if (assetIndex && assetIndex.url) {
    // 索引本身
    files.push({
      name: `${assetIndex.id}.json`,
      url: assetIndex.url,
      saveTo: path.join(paths.assetsDir(dir), 'indexes', `${assetIndex.id}.json`),
      sha1: assetIndex.sha1,
      size: assetIndex.size
    })

    // 索引里列出的每一个资源文件
    if (onStage) onStage('读取资源文件清单…（有几千个，稍等）')
    const index = await fetchJson(assetIndex.url)
    for (const [name, obj] of Object.entries(index.objects || {})) {
      const prefix = obj.hash.slice(0, 2)
      files.push({
        name,
        // 资源文件的地址是固定拼出来的，版本 JSON 里没写
        url: `https://resources.download.minecraft.net/${prefix}/${obj.hash}`,
        saveTo: path.join(paths.assetsDir(dir), 'objects', prefix, obj.hash),
        sha1: obj.hash,
        size: obj.size
      })
    }
  }

  // ——— ④ Java 运行时 ———
  let javaComponent = null
  const wanted = versionJson.javaVersion && versionJson.javaVersion.component
  if (wanted) {
    javaComponent = wanted
    const javaRoot = path.join(paths.runtimeDir(), wanted)

    // 已经有就不用下了——和别的启动器共用同一个游戏目录时能省 100 MB
    if (fs.existsSync(path.join(javaRoot, 'bin', 'java.exe'))) {
      if (onStage) onStage('Java 运行时已经有了，跳过')
    } else {
      if (onStage) onStage('准备 Java 运行时…')
      try {
        const javaFiles = await buildJavaFileList(wanted, javaRoot)
        files.push(...javaFiles)
      } catch (error) {
        // 【重要】Java 拿不到不能拦住整个安装——版本文件先装好，
        // 启动的时候再让用户手动指定 Java 路径（M5 会处理）
        if (onStage) onStage(`Java 运行时暂时拿不到（${error.message}），先装游戏文件`)
      }
    }
  }

  return { files, natives, javaComponent }
}

/**
 * 老版本（1.19 以前）的动态库：挂在库文件的 classifiers 里，是单独的压缩包，
 * 下载完还要解压到版本目录。不同系统、不同架构的包名不一样，按当前环境挑一个。
 *
 * 新版本不用这套——动态库直接作为普通库文件进了 classpath，
 * 游戏自己在运行时把它们解压到 natives 目录（见 launch.js）。
 */
function nativesFromLibrary(lib, ctx, dir) {
  const classifiers = lib.downloads && lib.downloads.classifiers
  if (!classifiers) return []

  const wanted = [`natives-${ctx.osName}`, `natives-${ctx.osName}-${ctx.arch}`]
  for (const key of wanted) {
    const entry = classifiers[key]
    if (!entry) continue
    return [
      {
        name: `${lib.name}-${key}.jar`,
        url: entry.url,
        saveTo: path.join(paths.librariesDir(dir), entry.path),
        sha1: entry.sha1,
        size: entry.size
      }
    ]
  }
  return []
}

/**
 * 把版本 JSON 里所有老式 natives 压缩包挑出来（启动时补解压要用）。
 *
 * 【dir 必须传对】这个清单里的 saveTo 是"库文件在哪个游戏目录"的完整路径，
 * 启动时 prepareNatives 拿它去判断"这个包下过没有、要不要解压"。
 * 传错目录不会报错，只会**静默地不解压 natives**——老版本启动时缺 DLL 崩掉，
 * 而且日志里看不出所以然。所以别漏。
 */
function collectClassifierNatives(versionJson, ctx, dir) {
  const list = []
  for (const lib of versionJson.libraries || []) {
    if (!rulesAllow(lib.rules, ctx)) continue
    list.push(...nativesFromLibrary(lib, ctx, dir))
  }
  return list
}

/** Java 运行时要下的文件 */
async function buildJavaFileList(component, javaRoot) {
  const all = await fetchJson(JAVA_RUNTIME_URL)
  const platform = `${currentOsName()}-${currentArch()}`

  const candidates = (all[platform] && all[platform][component]) || []
  if (candidates.length === 0) {
    throw new Error(`清单里没有 ${platform} 平台的 ${component}`)
  }

  const manifestUrl = candidates[0].manifest.url
  const manifest = await fetchJson(manifestUrl)

  const files = []
  for (const [relative, entry] of Object.entries(manifest.files || {})) {
    if (entry.type !== 'file') continue
    const raw = entry.downloads && entry.downloads.raw
    if (!raw || !raw.url) continue

    files.push({
      name: `运行时/${relative}`,
      url: raw.url,
      saveTo: path.join(javaRoot, relative),
      sha1: raw.sha1,
      size: raw.size
    })
  }

  if (files.length === 0) throw new Error('Java 运行时的文件清单是空的')
  return files
}

/**
 * 确保某一个 Java 运行时在本机有了，缺了就下。已经有就直接返回，不重复下。
 *
 * 【为什么单独有这么一步】装"整合包"（拖个 zip 进来那种）走的是另一条路：
 * 它只是把包里的文件铺开，**不会碰 Java**。实测踩到过（2026-10-07）：
 * 一个 1.20.1 Forge 的整合包文件全装好了，启动时本机没有它要的 Java 17，
 * 于是拿了台机器上现成的 Java 16 顶上 → 游戏当场崩。所以启动前要检查一次。
 *
 * @param {string} component 运行时名字，比如 java-runtime-gamma
 * @returns {Promise<{ok: boolean, already: boolean, path: string}>}
 */
async function ensureJavaComponent(component, { onStage, onProgress } = {}) {
  const stage = (text) => {
    if (onStage) onStage(text)
  }

  const javaRoot = path.join(paths.runtimeDir(), component)
  const exe = path.join(javaRoot, 'bin', 'java.exe')

  // 已经有了就别再下 100 MB
  if (fs.existsSync(exe)) return { ok: true, already: true, path: exe }

  stage('正在准备 Java 运行时的下载清单…')
  const files = await buildJavaFileList(component, javaRoot)

  stage(`开始下载 Java 运行时，共 ${files.length} 个文件…`)
  const task = downloader.createTask(files, { onProgress })
  const stats = await task.start()

  if (stats.done + stats.failed < stats.total) {
    throw new Error('Java 运行时下到一半停了')
  }
  if (stats.failed > 0) {
    const first = stats.failures[0]
    throw new Error(`Java 运行时没下全：${first?.error ?? '未知原因'}`)
  }
  // 下完了却还是没有 java.exe，说明清单给的东西不对，得当失败处理
  if (!fs.existsSync(exe)) throw new Error('下完了却没找到 java.exe，Mojang 的清单可能变了')

  return { ok: true, already: false, path: exe }
}

// ——————————————————————————————————————————————
// 解压 natives
// ——————————————————————————————————————————————

/** 把老版本的 natives 压缩包解开铺到版本目录 */
function extractNatives(versionId, natives, dir) {
  if (natives.length === 0) return 0

  const dest = paths.versionNativesDir(versionId, dir)
  paths.ensureDir(dest)
  let count = 0

  for (const item of natives) {
    if (!fs.existsSync(item.saveTo)) continue
    try {
      const buffer = fs.readFileSync(item.saveTo)
      // natives 包里除了 .dll 还有一堆别的（META-INF 之类），
      // 只解动态库和可执行文件，别的没用
      count += zip.extractTo(buffer, dest, {
        filter: (name) => /\.(dll|so|dylib|exe)$/i.test(name)
      })
    } catch (error) {
      // 某个 natives 包解不开不该让整个安装失败——大不了这个版本启动时缺个库
      console.warn(`natives 解压失败（${item.name}）：`, error.message)
    }
  }

  return count
}

// ——————————————————————————————————————————————
// 入口
// ——————————————————————————————————————————————

/**
 * 装一个版本。
 *
 * @param {string} versionId 版本号，比如 '1.21.4'
 * @param {{onStage?: Function, onProgress?: Function}} options
 * @returns {Promise<{ok: boolean, stats?: object, error?: string}>}
 */
async function installVersion(versionId, options = {}) {
  const { onStage, onProgress, onTask, dir } = options
  const stage = (text) => {
    if (onStage) onStage(text)
  }

  // 记一下"这次装之前它是不是已经装好了"——取消后要不要删版本文件夹靠它判断：
  // 本来就装好的版本（比如点"重装"中途取消），绝不能把已经装好的那一份删了
  const wasInstalled = paths.isVersionInstalled(versionId, dir)

  try {
    // ——— 1. 拿到这个版本的 JSON ———
    // providedJson 是"装 Mod 加载器"时用的：那份 JSON 是我们自己拼/下好的，
    // 不在官方版本清单里，所以直接传进来
    stage('正在读取版本信息…')
    let versionJson = options.providedJson || null

    if (!versionJson) {
      const manifest = await mojang.getManifest()
      const found = manifest.versions.find((v) => v.id === versionId)
      if (!found) throw new Error('版本清单里没有这个版本，先点一下「刷新」试试')
      versionJson = await fetchJson(found.url)
    }

    // ——— 1.5 有继承关系就先合并 ———
    // 装了 Mod 加载器的版本写着一句 inheritsFrom（继承自某个原版），
    // 库文件、资源、Java 要求这些都要连父版本一起算
    const resolved = inherit.resolveVersion(versionId, versionJson, dir)
    if (resolved.missingParent) {
      throw new Error(`这个版本是装在 ${resolved.missingParent} 上面的，得先把它装好`)
    }
    const fullJson = resolved.json
    const rootId = resolved.rootId

    // ——— 2. 算出要下哪些文件 ———
    stage('正在准备下载清单…')
    const { files, natives } = await buildFileList(versionId, fullJson, { onStage: stage, rootId, dir })

    // ——— 3. 版本 JSON 本身也存一份 ———
    // 【自成一体的存法（2026-10-17 用户拍板，照 PCL 的样子）】
    // 带 inheritsFrom 的版本（Fabric / Forge / NeoForge / OptiFine）以前存"自己那份"，
    // 用的时候现合并。现在存**合并后的完整版**：去掉 inheritsFrom、写上 `clientVersion`
    // （就是它底下那个原版）。好处：
    //   · 底座版本哪天被删/被换掉，这个实例照样能启动（不再依赖别人）
    //   · 列表里不会出现"底座 + 加载器"两个（底座靠 clientVersion 认出来）
    // 底座文件夹**不删**——那可能是用户还要单独玩的原版；只是被标成"底座"。
    const selfContained = Boolean(versionJson.inheritsFrom) && String(rootId) !== String(versionId)
    let storedJson = versionJson
    if (selfContained) {
      storedJson = { ...fullJson, clientVersion: String(rootId) }
      delete storedJson.inheritsFrom
    }
    paths.ensureDir(paths.versionDir(versionId, dir))
    fs.writeFileSync(
      paths.versionJsonFile(versionId, dir),
      JSON.stringify(storedJson, null, 2),
      'utf8'
    )

    // 从这里开始算"装到一半"：先插个标记，全部装完再拔掉。
    // 这样中途取消/失败留下的半成品，界面上不会显示成"已安装"
    fs.writeFileSync(
      paths.versionIncompleteMarker(versionId, dir),
      '装到一半（被取消或失败了）。重新安装会接着下，已经下好的不会重下。',
      'utf8'
    )

    // ——— 4. 下载 ———
    stage(`开始下载，共 ${files.length} 个文件…`)
    const task = downloader.createTask(files, {
      onProgress: (stats) => {
        if (onProgress) onProgress(stats)
      }
    })

    // 把控制器交给调用方（界面要拿它做"取消安装"）
    if (onTask) onTask(task)

    const stats = await task.start()

    // 没下完又没报失败 = 被取消了。不这么判断的话，取消会被当成"安装成功"——
    // 那就成了"看着装完了、其实少了一半文件"
    if (stats.done + stats.failed < stats.total) {
      return { ok: false, cancelled: true, wasInstalled, error: '安装已取消' }
    }

    if (stats.failed > 0) {
      const first = stats.failures[0]
      throw new Error(
        `有 ${stats.failed} 个文件没下成功。第一个是：${first?.error ?? '未知原因'}`
      )
    }

    // ——— 5. 解压 natives（老版本才有） ———
    if (natives.length > 0) {
      stage('正在解压运行库…')
      extractNatives(versionId, natives, dir)
    }

    // ——— 5.5 自成一体的版本要自带一份客户端 jar ———
    // 合并后的实例不再继承谁，主程序必须在自己文件夹里（名字得跟实例一样）。
    // Forge / NeoForge 打补丁时已经放了一份；Fabric / OptiFine 靠这里补。
    // 底座那份原样留着不动。
    if (selfContained) {
      const src = paths.versionJarFile(rootId, dir)
      const dest = paths.versionJarFile(versionId, dir)
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        paths.ensureDir(path.dirname(dest))
        fs.copyFileSync(src, dest)
      }
    }

    // 装全了，把"装到一半"的标记拔掉
    try {
      fs.unlinkSync(paths.versionIncompleteMarker(versionId, dir))
    } catch {
      // 标记本来就不在就算了
    }

    stage('安装完成')
    return { ok: true, stats }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * 把"**某个游戏目录里**装好的版本"还需要用到的文件列成一张表（库文件 + 资源文件）。
 * 用来回答："这个文件还有别人要吗？"
 *
 * 【为什么只算一个目录】库文件和资源文件是**每个游戏目录各一份**的：
 * 默认目录里的版本不会去用 D 盘那份库。清理时按目录各算各的，
 * 才不会把另一个目录里还要用的文件删掉。
 */
function collectReferencedFiles(dir) {
  const needed = new Set()

  for (const id of paths.listInstalledVersions(dir)) {
    let json
    try {
      json = JSON.parse(fs.readFileSync(paths.versionJsonFile(id, dir), 'utf8'))
    } catch {
      continue
    }

    const ctx = buildContext()

    for (const lib of json.libraries || []) {
      if (!rulesAllow(lib.rules, ctx)) continue

      const artifact = lib.downloads && lib.downloads.artifact
      if (artifact && artifact.path) {
        needed.add(path.resolve(path.join(paths.librariesDir(dir), artifact.path)))
      }

      const classifiers = lib.downloads && lib.downloads.classifiers
      if (classifiers) {
        for (const entry of Object.values(classifiers)) {
          if (entry && entry.path) {
            needed.add(path.resolve(path.join(paths.librariesDir(dir), entry.path)))
          }
        }
      }
    }

    const indexId = (json.assetIndex && json.assetIndex.id) || json.assets
    if (indexId) {
      try {
        const index = JSON.parse(
          fs.readFileSync(path.join(paths.assetsDir(dir), 'indexes', `${indexId}.json`), 'utf8')
        )
        for (const obj of Object.values(index.objects || {})) {
          needed.add(
            path.resolve(path.join(paths.assetsDir(dir), 'objects', obj.hash.slice(0, 2), obj.hash))
          )
        }
      } catch {
        // 索引读不到就跳过；缺的东西那个版本自己会重下
      }
    }
  }

  return needed
}

/**
 * 取消安装后选了"全部删掉"：把这次下的东西清理干净。
 *
 * 【为什么不能闭着眼睛删】下载的文件里有一大堆是**公共的**（库文件、音效贴图），
 * 别的版本可能正在用——删了就把人家弄坏了。所以每个公共文件都要先问一句
 * "还有哪个装好的版本要它？"，没人要才删。宁可多绕一步，不能碰坏别的版本。
 *
 * @param {string} versionId
 * @param {{removeVersionDir: boolean, downloaded: Array<{path: string, size: number}>}} options
 * @returns {{removedVersionDir: boolean, removedFiles: number, removedBytes: number, keptShared: number, error?: string}}
 */
function dropPartialInstall(versionId, { removeVersionDir, downloaded = [], dir } = {}) {
  const result = { removedVersionDir: false, removedFiles: 0, removedBytes: 0, keptShared: 0 }

  // ① 这个版本自己的文件夹（本来就没装好过才删——"重装到一半取消"不能删人家装好的版本）
  if (removeVersionDir) {
    try {
      const target = paths.versionDir(versionId, dir)
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true })
        result.removedVersionDir = true
      }
    } catch (error) {
      result.error = `版本自己的文件夹没删掉：${error.message}`
    }
  }

  // ② 这次新下的公共文件：别的版本还要的留着（只在这个游戏目录里问"还有谁要"）
  const needed = collectReferencedFiles(dir)
  const librariesRoot = `${path.resolve(paths.librariesDir(dir))}${path.sep}`
  const objectsRoot = `${path.resolve(path.join(paths.assetsDir(dir), 'objects'))}${path.sep}`

  for (const item of downloaded) {
    const full = path.resolve(item.path)
    const isShared = full.startsWith(librariesRoot) || full.startsWith(objectsRoot)
    if (!isShared) continue // 版本自己文件夹里的，第 ① 步已经处理了

    if (needed.has(full)) {
      result.keptShared++
      continue
    }

    try {
      if (fs.existsSync(full)) {
        fs.unlinkSync(full)
        result.removedFiles++
        result.removedBytes += item.size || 0
      }
    } catch {
      // 删不掉某一个不影响整体
    }
  }

  return result
}

module.exports = {
  installVersion,
  ensureJavaComponent,
  buildFileList,
  rulesAllow,
  buildContext,
  collectClassifierNatives,
  extractNatives,
  dropPartialInstall
}

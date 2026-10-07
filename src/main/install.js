// MC启动器 — 安装一个版本
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
 * @returns {Promise<{files: Array, natives: Array, javaComponent: string|null, needsNatives: string[]}>}
 */
async function buildFileList(versionId, versionJson, { onStage }) {
  const ctx = buildContext()

  const files = []
  const natives = []

  // ——— ① 客户端 jar ———
  const client = versionJson.downloads && versionJson.downloads.client
  if (client) {
    files.push({
      name: `${versionId}.jar`,
      url: client.url,
      saveTo: paths.versionJarFile(versionId),
      sha1: client.sha1,
      size: client.size
    })
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
        saveTo: path.join(paths.librariesDir(), artifact.path),
        sha1: artifact.sha1,
        size: artifact.size
      })
    }

    // 老版本才有：natives 是压缩包，要单独解压
    natives.push(...nativesFromLibrary(lib, ctx))
  }

  // ——— ③ assets ———
  const assetIndex = versionJson.assetIndex
  if (assetIndex && assetIndex.url) {
    // 索引本身
    files.push({
      name: `${assetIndex.id}.json`,
      url: assetIndex.url,
      saveTo: path.join(paths.assetsDir(), 'indexes', `${assetIndex.id}.json`),
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
        saveTo: path.join(paths.assetsDir(), 'objects', prefix, obj.hash),
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
function nativesFromLibrary(lib, ctx) {
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
        saveTo: path.join(paths.librariesDir(), entry.path),
        sha1: entry.sha1,
        size: entry.size
      }
    ]
  }
  return []
}

/** 把版本 JSON 里所有老式 natives 压缩包挑出来（启动时补解压要用） */
function collectClassifierNatives(versionJson, ctx) {
  const list = []
  for (const lib of versionJson.libraries || []) {
    if (!rulesAllow(lib.rules, ctx)) continue
    list.push(...nativesFromLibrary(lib, ctx))
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

// ——————————————————————————————————————————————
// 解压 natives
// ——————————————————————————————————————————————

/** 把老版本的 natives 压缩包解开铺到版本目录 */
function extractNatives(versionId, natives) {
  if (natives.length === 0) return 0

  const dest = paths.versionNativesDir(versionId)
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
  const { onStage, onProgress } = options
  const stage = (text) => {
    if (onStage) onStage(text)
  }

  try {
    // ——— 1. 找到并下载这个版本的 JSON ———
    stage('正在读取版本信息…')
    const manifest = await mojang.getManifest()
    const found = manifest.versions.find((v) => v.id === versionId)
    if (!found) throw new Error('版本清单里没有这个版本，先点一下「刷新」试试')

    const versionJson = await fetchJson(found.url)

    // 带了 inheritsFrom 的是"改装版"（比如装了 Mod 加载器的版本），
    // 要把它继承的那个父版本一起算进来。M4 先只处理纯原版。
    if (versionJson.inheritsFrom) {
      throw new Error('这个版本装了 Mod 加载器，暂时还不支持，先装纯原版')
    }

    // ——— 2. 算出要下哪些文件 ———
    stage('正在准备下载清单…')
    const { files, natives } = await buildFileList(versionId, versionJson, { onStage: stage })

    // ——— 3. 版本 JSON 本身也存一份 ———
    paths.ensureDir(paths.versionDir(versionId))
    fs.writeFileSync(
      paths.versionJsonFile(versionId),
      JSON.stringify(versionJson, null, 2),
      'utf8'
    )

    // ——— 4. 下载 ———
    stage(`开始下载，共 ${files.length} 个文件…`)
    const task = downloader.createTask(files, {
      onProgress: (stats) => {
        if (onProgress) onProgress(stats)
      }
    })
    const stats = await task.start()

    if (stats.failed > 0) {
      const first = stats.failures[0]
      throw new Error(
        `有 ${stats.failed} 个文件没下成功。第一个是：${first?.error ?? '未知原因'}`
      )
    }

    // ——— 5. 解压 natives（老版本才有） ———
    if (natives.length > 0) {
      stage('正在解压运行库…')
      extractNatives(versionId, natives)
    }

    stage('安装完成')
    return { ok: true, stats }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

module.exports = {
  installVersion,
  buildFileList,
  rulesAllow,
  buildContext,
  collectClassifierNatives,
  extractNatives
}

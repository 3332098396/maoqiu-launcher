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
async function buildFileList(versionId, versionJson, { onStage, rootId } = {}) {
  const ctx = buildContext()

  const files = []
  const natives = []

  // ——— ① 客户端 jar ———
  // 装了 Mod 加载器的版本自己没有客户端 jar（它继承原版的），
  // 这时候要确认原版那份在硬盘上
  if (rootId && rootId !== versionId) {
    if (!fs.existsSync(paths.versionJarFile(rootId))) {
      throw new Error(`缺了 ${rootId} 的客户端文件——先到「下载」页把它装好`)
    }
  } else {
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
  const { onStage, onProgress, onTask } = options
  const stage = (text) => {
    if (onStage) onStage(text)
  }

  // 记一下"这次装之前它是不是已经装好了"——取消后要不要删版本文件夹靠它判断：
  // 本来就装好的版本（比如点"重装"中途取消），绝不能把人家的版本给删了
  const wasInstalled = paths.isVersionInstalled(versionId)

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
    const resolved = inherit.resolveVersion(versionId, versionJson)
    if (resolved.missingParent) {
      throw new Error(`这个版本是装在 ${resolved.missingParent} 上面的，得先把它装好`)
    }
    const fullJson = resolved.json
    const rootId = resolved.rootId

    // ——— 2. 算出要下哪些文件 ———
    stage('正在准备下载清单…')
    const { files, natives } = await buildFileList(versionId, fullJson, { onStage: stage, rootId })

    // ——— 3. 版本 JSON 本身也存一份 ———
    // 存"它自己那份"（带 inheritsFrom 的原样），不是合并后的——
    // 合并是每次用的时候现算的，存合并版会把继承关系弄丢
    paths.ensureDir(paths.versionDir(versionId))
    fs.writeFileSync(
      paths.versionJsonFile(versionId),
      JSON.stringify(versionJson, null, 2),
      'utf8'
    )

    // 从这里开始算"装到一半"：先插个标记，全部装完再拔掉。
    // 这样中途取消/失败留下的半成品，界面上不会显示成"已安装"
    fs.writeFileSync(
      paths.versionIncompleteMarker(versionId),
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
      extractNatives(versionId, natives)
    }

    // 装全了，把"装到一半"的标记拔掉
    try {
      fs.unlinkSync(paths.versionIncompleteMarker(versionId))
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
 * 把"所有装好的版本"还需要用到的文件列成一张表（库文件 + 资源文件）。
 * 用来回答："这个文件还有别人要吗？"
 */
function collectReferencedFiles() {
  const needed = new Set()

  for (const id of paths.listInstalledVersions()) {
    let json
    try {
      json = JSON.parse(fs.readFileSync(paths.versionJsonFile(id), 'utf8'))
    } catch {
      continue
    }

    const ctx = buildContext()

    for (const lib of json.libraries || []) {
      if (!rulesAllow(lib.rules, ctx)) continue

      const artifact = lib.downloads && lib.downloads.artifact
      if (artifact && artifact.path) {
        needed.add(path.resolve(path.join(paths.librariesDir(), artifact.path)))
      }

      const classifiers = lib.downloads && lib.downloads.classifiers
      if (classifiers) {
        for (const entry of Object.values(classifiers)) {
          if (entry && entry.path) {
            needed.add(path.resolve(path.join(paths.librariesDir(), entry.path)))
          }
        }
      }
    }

    const indexId = (json.assetIndex && json.assetIndex.id) || json.assets
    if (indexId) {
      try {
        const index = JSON.parse(
          fs.readFileSync(path.join(paths.assetsDir(), 'indexes', `${indexId}.json`), 'utf8')
        )
        for (const obj of Object.values(index.objects || {})) {
          needed.add(
            path.resolve(path.join(paths.assetsDir(), 'objects', obj.hash.slice(0, 2), obj.hash))
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
function dropPartialInstall(versionId, { removeVersionDir, downloaded = [] }) {
  const result = { removedVersionDir: false, removedFiles: 0, removedBytes: 0, keptShared: 0 }

  // ① 这个版本自己的文件夹（本来就没装好过才删——"重装到一半取消"不能删人家装好的版本）
  if (removeVersionDir) {
    try {
      const dir = paths.versionDir(versionId)
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
        result.removedVersionDir = true
      }
    } catch (error) {
      result.error = `版本自己的文件夹没删掉：${error.message}`
    }
  }

  // ② 这次新下的公共文件：别的版本还要的留着
  const needed = collectReferencedFiles()
  const librariesRoot = `${path.resolve(paths.librariesDir())}${path.sep}`
  const objectsRoot = `${path.resolve(path.join(paths.assetsDir(), 'objects'))}${path.sep}`

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
  buildFileList,
  rulesAllow,
  buildContext,
  collectClassifierNatives,
  extractNatives,
  dropPartialInstall
}

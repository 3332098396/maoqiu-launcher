// 毛球 — 装 Forge / NeoForge（M10.2）
//
// 【和 Fabric 不一样在哪】
// Fabric 官方直接给一份"版本文件"，拿来就能用。
// Forge / NeoForge 给的是一整个**安装器**（一个 Java 程序）。
//
// 【为什么不能直接跑官方安装器】实测：安装器要去自己的仓库
// （maven.minecraftforge.net、maven.neoforged.net）下东西，
// 而这两个站在国内**根本连不上**（请求都发不出去），跑起来只会卡死。
//
// 好在安装器本身就是个压缩包，里面装着：
//   · install_profile.json  安装说明（版本号、要跑哪些处理步骤）
//   · version.json          完整的版本文件（继承自原版，拿来就能用）
//   · maven/…               它自己带的库文件（解到游戏目录即可）
//
// 所以我们的做法是：**下载安装器 → 拆开 → 照着里面的版本文件装**，
// 库文件全部走国内镜像。这也是 PCL / HMCL 的做法。
//
// 【关于"打补丁"】
// 安装说明里还有一个给客户端 jar 打补丁的步骤（生成一个 patched jar）。
// 先不做，直接试启动——失败了再补（别为了可能用不上的东西先写一堆代码）。
//
// 当前进度：M10.2。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')
const { fetchJson, fetchBuffer } = require('./http')
const zip = require('./zip')
const mirror = require('./mirror')
const downloader = require('./downloader')

/** BMCLAPI 上的加载器清单（官方站在国内连不上，只能用镜像） */
const BMCLAPI = 'https://bmclapi2.bangbang93.com'

/**
 * 某种加载器支持哪些版本。
 * @returns {Promise<Array<{version: string, installerUrl: string, sha1: string}>>}
 */
async function listBuilds(loader, gameVersion) {
  if (loader === 'forge') {
    const list = await fetchJson(
      `${BMCLAPI}/forge/minecraft/${encodeURIComponent(gameVersion)}`,
      { timeout: 30000 }
    )
    return (Array.isArray(list) ? list : [])
      .filter((build) => build && build.version)
      .map((build) => {
        const file = `forge-${gameVersion}-${build.version}-installer.jar`
        return {
          version: build.version,
          installerUrl: `${BMCLAPI}/maven/net/minecraftforge/forge/${gameVersion}-${build.version}/${file}`,
          // 【别用列表里的 hash 校验】实测那个值和安装器文件对不上
          // （SHA1、MD5 都不是），八成是它自己元数据里的另一个东西。
          // 所以这里不校验——文件走 HTTPS 从镜像下，装完的库文件都带官方哈希，照样验。
          sha1: ''
        }
      })
  }

  if (loader === 'neoforge') {
    const list = await fetchJson(
      `${BMCLAPI}/neoforge/list/${encodeURIComponent(gameVersion)}`,
      { timeout: 30000 }
    )
    return (Array.isArray(list) ? list : [])
      // beta 排在后面：优先挑正式版，实在没有再用 beta
      .filter((item) => item && item.version && item.installerPath)
      .sort((a, b) => {
        const aBeta = a.version.includes('beta') ? 1 : 0
        const bBeta = b.version.includes('beta') ? 1 : 0
        if (aBeta !== bBeta) return aBeta - bBeta
        return String(b.version).localeCompare(String(a.version))
      })
      .map((item) => ({
        version: item.version,
        installerUrl: `${BMCLAPI}${item.installerPath}`,
        sha1: ''
      }))
  }

  throw new Error(`不认识的加载器：${loader}`)
}

/** 挑一个要装的：最新的（NeoForge 已经把 beta 排后面了） */
function pickBuild(builds) {
  return builds.length > 0 ? builds[0] : null
}

/** 下载安装器到缓存目录（走镜像） */
async function downloadInstaller(build, { onProgress, onTask }) {
  const dir = path.join(paths.cacheDir(), 'installers')
  paths.ensureDir(dir)

  const saveTo = path.join(dir, `${path.basename(new URL(build.installerUrl).pathname)}`)

  const task = downloader.createTask(
    [{ name: path.basename(saveTo), url: build.installerUrl, saveTo, sha1: build.sha1, size: 0 }],
    { onProgress }
  )
  if (onTask) onTask(task)

  const stats = await task.start()
  if (stats.failed > 0) {
    throw new Error(`安装器没下下来：${stats.failures[0] ? stats.failures[0].error : '未知原因'}`)
  }
  return saveTo
}

/** 从安装器（一个压缩包）里把说明和版本文件读出来 */
function readInstaller(jarPath) {
  const buffer = fs.readFileSync(jarPath)
  const entries = zip.listEntries(buffer)

  const readJson = (rawName) => {
    const want = String(rawName).replace(/^\//, '')
    const entry = entries.find((e) => e.name === want)
    if (!entry) return null
    try {
      return JSON.parse(zip.readEntry(buffer, entry).toString('utf8'))
    } catch {
      return null
    }
  }

  const profile = readJson('install_profile.json')
  if (!profile) throw new Error('安装器里没有 install_profile.json，这个包不对')

  const version = readJson(profile.json || 'version.json')
  if (!version || !version.id) throw new Error('安装器里没有版本文件，装不了')

  return { buffer, entries, profile, version }
}

/**
 * 把安装器里自带的库解到游戏目录的 libraries 里。
 * （Forge 的 universal / shim 这类文件是直接塞在安装器里的，官方仓库下不到）
 */
function extractBundledLibraries(jar) {
  const dest = paths.librariesDir()
  let count = 0

  for (const entry of jar.entries) {
    if (!entry.name.startsWith('maven/')) continue
    if (entry.name.endsWith('/')) continue

    const rel = entry.name.slice('maven/'.length)
    const target = path.join(dest, rel)

    // 安全：别让压缩包里的 ../ 跑到外面去（zip.js 也挡了一道，这里再确认）
    if (!path.resolve(target).startsWith(path.resolve(dest))) continue

    try {
      paths.ensureDir(path.dirname(target))
      fs.writeFileSync(target, zip.readEntry(jar.buffer, entry))
      count++
    } catch {
      // 单个文件失败不影响整体
    }
  }

  return count
}

/**
 * 把版本文件里的库地址换成国内镜像。
 *
 * 【为什么必须换】这些库的官方地址（maven.minecraftforge.net / maven.neoforged.net）
 * 在国内连请求都发不出去，走"先官方后镜像"要白白等好几个 60 秒超时。
 * 直接存镜像地址（和 Fabric 那边一个道理）。
 */
function pointLibrariesToMirror(version) {
  const fixed = { ...version }

  fixed.libraries = (version.libraries || []).map((lib) => {
    const artifact = lib.downloads && lib.downloads.artifact
    if (!artifact || !artifact.url) return lib

    const mirrored = mirror.toMirror(artifact.url)
    if (!mirrored) return lib

    return { ...lib, downloads: { ...lib.downloads, artifact: { ...artifact, url: mirrored } } }
  })

  return fixed
}

/**
 * 准备好一个 Forge / NeoForge 版本：
 * 下安装器 → 拆开 → 自带的库解出来 → 返回版本文件（剩下的交给正常安装流程）。
 *
 * @returns {Promise<{versionId: string, json: object, loaderVersion: string}>}
 */
async function prepare(loader, gameVersion, { onStage, onProgress, onTask } = {}) {
  const stage = (text) => {
    if (onStage) onStage(text)
  }

  stage(`正在查 ${loader === 'forge' ? 'Forge' : 'NeoForge'} 有哪些版本…`)
  const builds = await listBuilds(loader, gameVersion)
  const build = pickBuild(builds)
  if (!build) {
    throw new Error(`${loader === 'forge' ? 'Forge' : 'NeoForge'} 没有支持 ${gameVersion} 的版本`)
  }

  stage(`正在下载 ${loader === 'forge' ? 'Forge' : 'NeoForge'} ${build.version} 的安装器…`)
  const jarPath = await downloadInstaller(build, { onProgress, onTask })

  stage('正在拆开安装器…')
  const jar = readInstaller(jarPath)

  stage('正在放它自带的库文件…')
  const extracted = extractBundledLibraries(jar)

  const versionJson = pointLibrariesToMirror(jar.version)

  return {
    versionId: String(jar.version.id),
    json: versionJson,
    loaderVersion: build.version,
    bundled: extracted,
    // 打补丁要用的东西（等库都下好了再跑，见 main.js 里的顺序说明）
    patcher: { profile: jar.profile, jar, gameVersion }
  }
}

// ——————————————————————————————————————————————
// 处理器：给客户端 jar 打补丁（M10.2 实测证明这步必须做）
// ——————————————————————————————————————————————
//
// 【为什么必须要】Forge / NeoForge 的版本文件里，classpath 上有一个
// "打过补丁的客户端 jar"（比如 forge-26.3-66.0.2-client.jar）。
// 那个文件**不在任何地方可以下载**——它是安装器用"处理器"现场做出来的：
// 拿原版 jar 当输入，套上一条二进制补丁，输出到 libraries 里。
// 实测：不做这步，启动器会报"有 1 个游戏文件不在了（比如 …-client.jar）"。
//
// 处理器的写法是安装器自己给的（install_profile.json 的 processors）：
// 一段 Java 程序 + 一串参数，参数里有 {MINECRAFT_JAR} 这种变量要替换。

/** 把 "[net.minecraftforge:forge:1.2.3:client]" 这种坐标转成库文件路径 */
function coordToPath(coord) {
  const inner = String(coord).replace(/^\[/, '').replace(/\]$/, '')
  const parts = inner.split(':')
  const [group, artifact, version, classifier] = parts
  if (!group || !artifact || !version) return null
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`
}

/** 参数里的 {变量} 替换 */
function substituteVars(text, vars) {
  return String(text).replace(/\{([A-Z_]+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole
  )
}

/** 处理器的参数可能混着字符串和 {"--key": "值"} 这种对象，都摊平 */
function resolveArgs(args, vars) {
  const out = []

  for (const arg of args || []) {
    if (typeof arg === 'string') {
      out.push(substituteVars(arg, vars))
      continue
    }
    if (arg && typeof arg === 'object') {
      for (const [key, value] of Object.entries(arg)) {
        out.push(substituteVars(key, vars))
        if (value !== undefined && value !== null && value !== '') {
          out.push(substituteVars(String(value), vars))
        }
      }
    }
  }

  return out
}

/** 把安装器里 data 段声明的某个文件（比如 /data/client.lzma）解到缓存目录 */
function extractDataFile(jar, dataPath) {
  const want = String(dataPath).replace(/^\//, '')
  const entry = jar.entries.find((e) => e.name === want)
  if (!entry) throw new Error(`安装器里没有 ${dataPath} 这个文件`)

  const dir = path.join(paths.cacheDir(), 'installers')
  paths.ensureDir(dir)
  const target = path.join(dir, path.basename(want))
  fs.writeFileSync(target, zip.readEntry(jar.buffer, entry))
  return target
}

/** 这一侧的处理器（Forge 会给 server / client 两套，我们只要 client 这边的） */
function clientProcessors(profile) {
  return (profile.processors || []).filter((p) => {
    if (!p || !p.args) return false
    const sides = p.sides
    if (!sides) return true // 没写就是两边都要
    return sides.includes('client')
  })
}

/**
 * 跑一遍打补丁的处理器。
 *
 * @param {{profile: object, jar: object, gameVersion: string}} options
 * @param {{onStage?: Function, onProgress?: Function, onTask?: Function}} hooks
 */
async function runPatchers({ profile, jar, gameVersion }, { onStage, onProgress, onTask } = {}) {
  const processors = clientProcessors(profile)
  if (processors.length === 0) return { ran: 0 }

  const stage = (text) => {
    if (onStage) onStage(text)
  }

  // ——— 1. 处理器自己要用的库，先下齐（装到 libraries 里，和别的库一样） ———
  const profileLibs = (profile.libraries || [])
    .filter((lib) => lib && lib.name)
    .map((lib) => {
      const relPath = coordToPath(lib.name)
      if (!relPath) return null
      const official = `https://maven.minecraftforge.net/${relPath}`
      const neoOfficial = `https://maven.neoforged.net/releases/${relPath}`
      const mirrored = mirror.toMirror(official) || (`https://bmclapi2.bangbang93.com/maven/${relPath}`)
      return {
        name: relPath,
        url: mirrored,
        saveTo: path.join(paths.librariesDir(), relPath),
        sha1: (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.sha1) || '',
        size: 0,
        _neo: neoOfficial
      }
    })
    .filter(Boolean)

  if (profileLibs.length > 0) {
    stage(`正在准备打补丁要用的 ${profileLibs.length} 个库…`)
    const task = downloader.createTask(profileLibs, { onProgress })
    if (onTask) onTask(task)
    const stats = await task.start()
    if (stats.failed > 0) {
      throw new Error(`打补丁要用的库没下齐（${stats.failures[0] ? stats.failures[0].file.name : ''}）`)
    }
  }

  // ——— 2. 变量替换表 ———
  const mcJar = paths.versionJarFile(gameVersion)
  if (!fs.existsSync(mcJar)) throw new Error(`找不到原版 ${gameVersion} 的客户端文件，先把它装好`)

  const javaExe = findJava(gameVersion)
  if (!javaExe) throw new Error('找不到 Java，没法打补丁')

  let ran = 0

  for (const processor of processors) {
    const jarPath = path.join(paths.librariesDir(), coordToPath(processor.jar) || '')
    if (!fs.existsSync(jarPath)) {
      throw new Error(`处理器 ${processor.jar} 没下到，装不了`)
    }

    // 这一侧要用到的变量（data 段里 client 那份）
    const vars = { MINECRAFT_JAR: mcJar, ROOT: paths.gameDir() }
    for (const [key, value] of Object.entries(profile.data || {})) {
      const raw =
        value && typeof value === 'object' ? value.client ?? value.server ?? '' : value
      if (!raw) continue

      // 形如 [group:artifact:version:classifier] 的是"产物路径"
      if (/^\[.*\]$/.test(String(raw))) {
        vars[key] = path.join(paths.librariesDir(), coordToPath(raw) || '')
      } else if (/^['"].*['"]$/.test(String(raw))) {
        vars[key] = String(raw).slice(1, -1) // 带引号的常量
      } else {
        // 形如 /data/client.lzma 的：从安装器里解出来
        try {
          vars[key] = extractDataFile(jar, raw)
        } catch {
          vars[key] = String(raw)
        }
      }
    }

    // ——— 3. 跑：java -cp <处理器+它的依赖> <主类> <参数…> ———
    const classpath = [jarPath]
    for (const dep of processor.classpath || []) {
      const rel = coordToPath(dep)
      if (rel) classpath.push(path.join(paths.librariesDir(), rel))
    }

    const mainClass = readMainClass(jarPath)
    if (!mainClass) throw new Error(`处理器 ${processor.jar} 里没有主类，装不了`)

    const args = resolveArgs(processor.args, vars)
    stage('正在给游戏文件打补丁（这步要几秒到一分钟）…')

    const { spawn } = require('node:child_process')
    await new Promise((resolve, reject) => {
      const child = spawn(javaExe, ['-cp', classpath.join(path.delimiter), mainClass, ...args], {
        cwd: paths.gameDir(),
        windowsHide: true
      })

      let output = ''
      const collect = (chunk) => {
        output += chunk.toString('utf8')
        if (output.length > 4000) output = output.slice(-4000)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)

      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`打补丁的步骤失败了（退出码 ${code}）：${output.trim().slice(-300)}`))
      })
    })

    ran++
  }

  return { ran }
}

// ——————————————————————————————————————————————
// 小工具
// ——————————————————————————————————————————————

/** 从 jar 的 MANIFEST.MF 里读主类（处理器就是这么启动的） */
function readMainClass(jarPath) {
  try {
    const buffer = fs.readFileSync(jarPath)
    const entries = zip.listEntries(buffer)
    const manifest = entries.find((e) => e.name === 'META-INF/MANIFEST.MF')
    if (!manifest) return ''
    const text = zip.readEntry(buffer, manifest).toString('utf8')
    // MANIFEST 每行最多 72 字节，长的会折行（下一行以空格开头）
    const joined = text.replace(/\r?\n /g, '')
    const match = joined.match(/^Main-Class:\s*(.+)$/m)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

/** 找 Java（处理器要用；和启动游戏用的是同一套逻辑） */
function findJava(versionId) {
  try {
    const javaUtil = require('./java')
    const json = JSON.parse(fs.readFileSync(paths.versionJsonFile(versionId), 'utf8'))
    const found = javaUtil.findJava(json)
    return found ? found.path : ''
  } catch {
    return ''
  }
}

module.exports = {
  prepare,
  listBuilds,
  readInstaller,
  extractBundledLibraries,
  pointLibrariesToMirror,
  runPatchers,
  coordToPath
}

// 毛球 — 找 Java
//
// 每个 Minecraft 版本都要求特定大版本的 Java（26.3 要 Java 25）。
// M4 已经按版本 JSON 的声明，把对应的 Java 运行时下到了
// 游戏目录\runtime\<组件名>\ 里，这一步就是把那个 java.exe 找出来。
//
// 找的顺序：
//   ① 用户手动指定的（设置里的 javaPath，界面在 M6 做）
//   ② 版本要求的那个运行时（M4 下好的）
//   ③ 本机游戏目录里已有的别的运行时（比如其他启动器下过的）
//
// ③ 挑的时候要**看大版本号对不对得上**：拿 Java 16 去跑要 Java 17 的版本，
// 游戏会当场崩。这一条是实测踩出来的（见 findJava 里的注释）。
//
// 都找不到就返回 null，由调用方给出中文提示——不在这里报错，
// 因为"找不到 Java"该怎么说给用户听，是界面那边的事。
//
// 当前进度：M5。

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const paths = require('./paths')
const settings = require('./settings')

/**
 * 这个版本最后该按哪个"用户的意思"去找 Java（M20）。
 *
 * 优先顺序：
 *   ① 这个版本自己选过（版本设置里那个「选择 Java」）→ 听它的
 *      选的是具体某个路径 = 就用那个；选的是"自动选择" = 按版本要求挑，不看全局
 *   ② 没选过 → 跟随全局（设置页「Java 运行时」里那个选择）
 *
 * @returns {{chosen: string, own: boolean}} chosen 是具体路径；空 = 自动选择
 */
function javaPreference(key) {
  const config = settings.readConfig()
  const override = (config.versionSettings || {})[key] || {}

  // 【为什么用 typeof 判断而不是直接取】"跟随全局"和"自动选择"要用不同的值表示：
  //   没这个字段  → 跟随全局
  //   ''（空串）  → 自动选择（不看全局）
  //   一个路径    → 就用它
  if (typeof override.javaPath === 'string') {
    return { chosen: override.javaPath, own: true }
  }
  return { chosen: String(config.launch.javaPath || ''), own: false }
}

/**
 * 找这个版本能用的 java.exe。
 * @param {object} versionJson
 * @param {{key?: string}} [options] key = settings.versionKey(dir, id)，用来查"这个版本自己选过没"
 * @returns {{path: string, source: string}|null}
 */
function findJava(versionJson, options = {}) {
  const javaVersion = (versionJson && versionJson.javaVersion) || {}
  const component = javaVersion.component
  const wantedMajor = Number(javaVersion.majorVersion) || 0

  // ——— ① 用户手动指定的 ② 版本要求的 ———
  // 这两个是"明说的"（一个是用户自己选的，一个是版本 JSON 自己写的），直接信，不用试跑
  const specified = []

  const preference = javaPreference(options.key)
  if (preference.chosen) {
    specified.push({
      path: preference.chosen,
      source: preference.own ? '这个版本指定的' : '你指定的'
    })
  }

  if (component) {
    specified.push({
      path: path.join(paths.runtimeDir(), component, 'bin', 'java.exe'),
      source: `这个版本要求的（${component}）`
    })
  }

  for (const candidate of specified) {
    if (fs.existsSync(candidate.path)) return candidate
  }

  // ——— ③ 本机已有的其他运行时 ———
  // 别的启动器下过的也能用，省得重复下 100 MB
  const others = []
  try {
    for (const name of fs.readdirSync(paths.runtimeDir())) {
      if (name === component) continue
      others.push({
        path: path.join(paths.runtimeDir(), name, 'bin', 'java.exe'),
        source: `本机已有的（${name}）`
      })
    }
  } catch {
    // 运行时目录还不存在，说明什么都没下过，跳过
  }

  const existing = others.filter((candidate) => fs.existsSync(candidate.path))
  if (existing.length === 0) return null

  // 【这里必须看一眼版本号对不对得上】踩过的坑（2026-10-07）：
  // 一个 1.20.1 的整合包要 Java 17，本机只有个 java-runtime-alpha（Java 16），
  // 原来"名字排前面就用哪个"，于是拿 Java 16 去跑 → 游戏当场崩，报的是
  // UnsupportedClassVersionError（一句用户根本看不懂的英文）。
  // 所以先挑版本号对得上的那个。
  if (wantedMajor) {
    for (const candidate of existing) {
      const probe = probeJava(candidate.path)
      if (probe.ok && probe.major === wantedMajor) return candidate
    }
  }

  // 实在没有对得上的，还是给一个——有些版本差一点也能跑。
  // 版本号不对时由 launch.js 把这个情况写进日志提醒用户，这里不拦。
  return existing[0]
}

/** 从 `openjdk version "25.0.1"` 这类文字里算出大版本号（25） */
/**
 * 64 位还是 32 位。
 * java -version 的输出里写着 "64-Bit Server VM"，界面上那句
 * 「Java 25.0.1 · x64」的后半截就从这儿来。
 */
function parseBits(text) {
  if (/64-Bit/i.test(text)) return 64
  if (/32-Bit/i.test(text)) return 32
  return 0
}

function parseMajor(version) {
  const parts = String(version).split(/[._-]/)
  // 老 Java 写的是 1.8.0_292，大版本是 8
  if (parts[0] === '1' && parts.length > 1) return Number(parts[1]) || 0
  return Number(parts[0]) || 0
}

/**
 * 试着跑一下 java -version，确认它真的能用，顺便拿到版本号。
 *
 * 【为什么要先试跑】文件在硬盘上不代表能用——可能被杀毒软件清空了、
 * 或者是给别的系统用的。花 0.2 秒试一下，比让游戏崩在用户面前强。
 *
 * @returns {{ok: boolean, version?: string, major?: number, error?: string}}
 */
function probeJava(exePath) {
  let result
  try {
    result = spawnSync(exePath, ['-version'], {
      timeout: 15000,
      encoding: 'utf8',
      windowsHide: true
    })
  } catch (error) {
    return { ok: false, error: error.message }
  }

  // java -version 的输出在 stderr 里，别只看 stdout
  const text = `${result.stdout || ''}${result.stderr || ''}`
  const match = text.match(/version "([^"]+)"/)

  if (!match) {
    return { ok: false, error: '跑了一下没认出版本号，文件可能坏了或被拦截了' }
  }

  return { ok: true, version: match[1], major: parseMajor(match[1]), bits: parseBits(text) }
}

/**
 * 试着跑一下 java -version（异步版）。
 *
 * 【为什么要两个版本】`probeJava` 是同步的（启动游戏时用，那会儿等得起），
 * 但"列本机所有 Java"要一次试跑好几个，同步的话主进程会被卡住，
 * 界面上的鼠标都会转圈。这里用异步的，几个一起跑。
 *
 * @returns {Promise<{ok: boolean, version?: string, major?: number, error?: string}>}
 */
function probeJavaAsync(exePath) {
  return new Promise((resolve) => {
    let child
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    try {
      child = spawn(exePath, ['-version'], { windowsHide: true })
    } catch (error) {
      resolve({ ok: false, error: error.message })
      return
    }

    let text = ''
    // 有的 java.exe 会挂住不退出（比如被杀毒软件拦着），15 秒就放弃
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已经退了
      }
      done({ ok: false, error: '试着跑了一下，15 秒没反应' })
    }, 15000)

    child.stdout.on('data', (chunk) => {
      text += chunk
    })
    child.stderr.on('data', (chunk) => {
      text += chunk
    })
    child.on('error', (error) => done({ ok: false, error: error.message }))
    child.on('close', () => {
      const match = text.match(/version "([^"]+)"/)
      if (!match) {
        done({ ok: false, error: '跑起来了，但没认出版本号（文件可能不完整）' })
        return
      }
      done({ ok: true, version: match[1], major: parseMajor(match[1]), bits: parseBits(text) })
    })
  })
}

/**
 * 列出"本机能用哪些 Java"（设置页那个「Java 运行时」列表用它）。
 *
 * 【都从哪找】
 *   ① 游戏目录\runtime\ 下面每个运行时（毛球自己下的、别的启动器下的都在这儿）
 *   ② 用户自己"添加"进来的（存配置里，可能在任何地方）
 * 不去满硬盘乱翻——那是杀毒软件干的活，而且翻出来的多半是游戏用不上的。
 *
 * @returns {Promise<Array<{path, name, source, added, ok, version?, major?, error?}>>}
 */
async function listJavas() {
  const found = []
  const seen = new Set()
  const push = (exePath, source, added) => {
    const key = path.resolve(String(exePath)).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push({ path: String(exePath), source, added })
  }

  try {
    for (const name of fs.readdirSync(paths.runtimeDir())) {
      push(path.join(paths.runtimeDir(), name, 'bin', 'java.exe'), name, false)
    }
  } catch {
    // runtime 目录还不存在 = 一个运行时都没下过
  }

  for (const one of settings.readConfig().launch.extraJavaPaths || []) {
    push(one, '手动添加', true)
  }

  const out = await Promise.all(
    found.map(async (one) => {
      if (!fs.existsSync(one.path)) {
        return { ...one, ok: false, error: '文件不在了（可能被删了或者被移走了）' }
      }
      const probe = await probeJavaAsync(one.path)
      return { ...one, ...probe }
    })
  )

  // 能用的排前面；都是能用的按版本号从大到小
  out.sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0) || (b.major || 0) - (a.major || 0))
  return out
}

module.exports = { findJava, probeJava, probeJavaAsync, parseMajor, parseBits, listJavas, javaPreference }

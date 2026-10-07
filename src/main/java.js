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
const { spawnSync } = require('node:child_process')
const paths = require('./paths')
const settings = require('./settings')

/**
 * 找这个版本能用的 java.exe。
 * @returns {{path: string, source: string}|null}
 */
function findJava(versionJson) {
  const javaVersion = (versionJson && versionJson.javaVersion) || {}
  const component = javaVersion.component
  const wantedMajor = Number(javaVersion.majorVersion) || 0

  // ——— ① 用户手动指定的 ② 版本要求的 ———
  // 这两个是"明说的"（一个是用户自己选的，一个是版本 JSON 自己写的），直接信，不用试跑
  const specified = []

  const manual = settings.readConfig().launch.javaPath
  if (manual) specified.push({ path: manual, source: '手动指定的' })

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

  return { ok: true, version: match[1], major: parseMajor(match[1]) }
}

module.exports = { findJava, probeJava, parseMajor }

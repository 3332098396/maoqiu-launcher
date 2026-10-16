// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 清理游戏垃圾（对照同类软件的候选清单里的 ⭐⭐ 项）
//
// 【清什么】游戏自己产生的、删了完全不影响玩的东西：
//   · 游戏日志 logs\*.log（游戏自己会重新写）
//   · 崩溃报告 crash-reports\（出问题时生成的那一堆）
//   · JVM 崩溃转储 hs_err_pid*.log / replay_pid*.log（在游戏目录根上）
//   · Mixin 的调试输出 .mixin.out\（装 Mod 的版本跑完会留下一堆）
//
// 【不清什么 —— 这条比清什么更重要】
// 存档、Mod、配置、资源包、光影、截图，一律不碰。它们是用户的东西，
// 而且"清理"这个词最容易让人误以为可以随手删。
// 所以这里的规则是**白名单**：只认上面那几类名字，别的一律不看。
//
// 【为什么只在这些地方删】删除前会核对"这个文件确实在我算出来的游戏目录里"，
// 和删版本那套一样挡一道——宁可多写几行，不能删错地方。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')
const settings = require('./settings')
const versions = require('./versions')

/** 每一类垃圾叫什么、为什么要清 */
const KINDS = [
  {
    key: 'logs',
    label: '游戏日志',
    hint: '游戏每次运行都会写，越攒越多。删了不影响玩（下次运行会重新写）'
  },
  {
    key: 'crashes',
    label: '崩溃报告',
    hint: '游戏出错时生成的。如果最近老崩，先留着发给别人看；平时可以清掉'
  },
  {
    key: 'jvm',
    label: 'Java 崩溃转储',
    hint: '极端崩溃（整个 Java 挂掉）时留下的，通常几十 MB 一个'
  },
  {
    key: 'mixin',
    label: 'Mod 调试输出（.mixin.out）',
    hint: '装 Mod 的版本跑完会留下的一堆小文件，没用'
  }
]

/** 一个文件算不算"游戏日志" */
function isLogFile(name) {
  return /\.log(\.\d+)?$/i.test(name) || /^latest\.log$/i.test(name) || /\.log\.gz$/i.test(name)
}

/**
 * 把一个文件夹里的文件捞出来（**会往里走子文件夹**）。
 *
 * 【为什么必须递归】`.mixin.out` 里的东西就放在子文件夹下
 * （比如 `.mixin.out\class\…`），只看第一层会一个都扫不到——
 * 实测造样本时就是这么发现的。
 *
 * @param {string} dir 要捞的文件夹
 * @param {(full: string, name: string) => boolean} keep 留下哪些（返回 false 就跳过）
 * @param {(full: string) => void} push 捞到之后干什么
 */
function walk(dir, keep, push) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 没这个文件夹就跳过
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, keep, push)
    } else if (entry.isFile() && keep(full, entry.name)) {
      push(full)
    }
  }
}

/** 收集某个游戏目录里的垃圾 */
function collectFrom(gameDir, where, out) {
  const push = (key, full, size) => {
    const group = out.find((one) => one.key === key)
    if (group) {
      group.files.push(full)
      group.bytes += size
    }
  }

  const sizeOf = (full) => {
    try {
      return fs.statSync(full).size
    } catch {
      return 0
    }
  }

  // ① 游戏日志：<游戏目录>\logs\ 里所有 .log / .log.gz
  walk(
    path.join(gameDir, 'logs'),
    (full, name) => isLogFile(name),
    (full) => push('logs', full, sizeOf(full))
  )

  // ② 崩溃报告：<游戏目录>\crash-reports\ 里什么都算垃圾
  walk(
    path.join(gameDir, 'crash-reports'),
    () => true,
    (full) => push('crashes', full, sizeOf(full))
  )

  // ③ JVM 转储：游戏目录**根上**的 hs_err_pid*.log / replay_pid*.log
  // 【这里只能看第一层，不能往里递归】游戏目录里有 assets、libraries 那种
  // 几万个文件的大文件夹，递归一遍要好几秒，界面会卡住（实测踩过）。
  try {
    for (const entry of fs.readdirSync(gameDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!/^(hs_err_pid|replay_pid)/i.test(entry.name)) continue
      push('jvm', path.join(gameDir, entry.name), sizeOf(path.join(gameDir, entry.name)))
    }
  } catch {
    // 读不了就跳过
  }

  // ④ Mixin 调试输出：<游戏目录>\.mixin.out\（里面有子文件夹，必须往里走）
  walk(
    path.join(gameDir, '.mixin.out'),
    () => true,
    (full) => push('mixin', full, sizeOf(full))
  )
}

/**
 * 扫一遍，看看有多少垃圾可以清。
 *
 * 扫的范围：所有认得的游戏目录 + 每个已装版本自己的文件夹
 * （开了版本隔离的版本，日志和崩溃报告在它自己文件夹里）。
 *
 * @returns {{groups: Array<{key, label, hint, files: string[], bytes: number}>, totalBytes: number, totalFiles: number}}
 */
function scan(roots) {
  const out = KINDS.map((one) => ({ ...one, files: [], bytes: 0 }))

  // roots 不传 = 所有认得的游戏目录。传了就用传进来的那几个
  // （测试时可以只扫一个临时目录，不去碰用户真实的游戏目录）
  const dirs = Array.isArray(roots) && roots.length > 0 ? roots : settings.knownGameDirs()

  for (const dir of dirs) {
    collectFrom(paths.gameDir(dir), dir, out)

    for (const one of versions.listAllVersions([dir])) {
      // 开了隔离的版本，游戏目录就是它自己的文件夹
      if (versions.isIsolated(one.id, one.dir)) {
        collectFrom(paths.versionDir(one.id, one.dir), one.dir, out)
      }
    }
  }

  const totalBytes = out.reduce((sum, one) => sum + one.bytes, 0)
  const totalFiles = out.reduce((sum, one) => sum + one.files.length, 0)

  return {
    groups: out.filter((one) => one.files.length > 0),
    totalBytes,
    totalFiles
  }
}

/**
 * 真删。
 *
 * @param {string[]} keys 要清哪几类（'logs' / 'crashes' / 'jvm' / 'mixin'）
 * @returns {{ok: boolean, deleted: number, bytes: number, errors: string[]}}
 */
function clean(keys, roots) {
  const wanted = new Set(keys || [])
  const result = { ok: true, deleted: 0, bytes: 0, errors: [] }

  // 每次删之前**重新扫一遍**，不信任界面传回来的路径——
  // 中间用户可能又玩了一局，文件列表已经变了
  const fresh = scan(roots)

  for (const group of fresh.groups) {
    if (!wanted.has(group.key)) continue

    for (const file of group.files) {
      // 安全：只删我们算出来的目录里的东西
      // 安全网：只删这次扫的那些目录里的东西（roots 不传就是所有认得的目录）
      const allowedRoots =
        Array.isArray(roots) && roots.length > 0 ? roots : settings.knownGameDirs()
      const allowed = allowedRoots.some((dir) =>
        path.resolve(file).toLowerCase().startsWith(path.resolve(dir).toLowerCase())
      )
      if (!allowed) {
        result.errors.push(`跳过了一个不该删的路径：${file}`)
        continue
      }

      try {
        const size = fs.statSync(file).size
        fs.rmSync(file, { force: true })
        result.deleted++
        result.bytes += size
      } catch (error) {
        result.errors.push(`${path.basename(file)} 删不掉：${error.message}`)
      }
    }
  }

  if (result.errors.length > 0) result.ok = false
  return result
}

module.exports = { scan, clean, KINDS }

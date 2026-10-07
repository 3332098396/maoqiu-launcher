// 毛球 — 一键备份（M6.3 / 需求 R9.1）
//
// 把重要的东西打包存一份，防手滑、防意外。
//
// 【备份什么】由用户勾：存档 / Mod / 启动器设置 / 游戏本体与资源
// 【存成什么】由用户选：压缩包（自己写的 zipwriter）/ 文件夹（直接复制）
//
// 【三条原则】
//  ① 备份是"只读"操作——只往备份目录里写，绝不碰任何原文件
//  ② 包里放一份「备份说明.txt」（人话，三个月后打开也知道这是什么）
//     和一份 manifest.json（机器读的清单，以后做"还原"要用）
//  ③ 压缩包写完**必须自验一遍**（zipwriter.verifyZip）；验不过就删掉重报错，
//     绝不把一个坏包留在那儿让用户以为有备份
//
// 当前进度：M6.3。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')
const zipwriter = require('./zipwriter')

/** 能备份的四类东西。key 是代号，值是给人看的名字 */
const CATEGORIES = {
  saves: '存档',
  mods: 'Mod',
  settings: '启动器设置',
  game: '游戏本体与资源'
}

/** 一句话解释每一类是什么（界面直接用这个） */
const CATEGORY_HELP = {
  saves: '你的世界（所有版本里的都算上）。最怕丢的就是它',
  mods: '下载的 Mod 文件',
  settings: '账号、内存这些启动器设置（很小）',
  game: '游戏本体：版本文件、库文件、资源文件（好几个 GB，最慢）'
}

// ——————————————————————————————————————————————
// 收集要备份的东西
// ——————————————————————————————————————————————

/**
 * 按勾选的类别，列出要备份的"根"（可能是文件，也可能是文件夹）。
 * name 是放进备份里的路径——按照游戏目录的结构摆，以后还原最省事。
 */
function collectRoots(categories = {}) {
  const roots = []

  const add = (source, name) => {
    try {
      if (fs.existsSync(source)) roots.push({ source, name })
    } catch {
      // 读不到就算了，不能让一个读不了的东西拦住整个备份
    }
  }

  const versions = paths.listInstalledVersions()

  if (categories.saves) {
    add(paths.savesDir(), 'saves')
    for (const id of versions) {
      add(path.join(paths.versionDir(id), 'saves'), `versions/${id}/saves`)
    }
  }

  if (categories.mods) {
    add(paths.modsDir(), 'mods')
    for (const id of versions) {
      add(path.join(paths.versionDir(id), 'mods'), `versions/${id}/mods`)
    }
  }

  if (categories.settings) {
    add(paths.settingsFile(), '启动器设置/config.json')
  }

  if (categories.game) {
    for (const id of versions) {
      add(paths.versionDir(id), `versions/${id}`)
    }
    add(paths.librariesDir(), 'libraries')
    add(paths.assetsDir(), 'assets')
    add(paths.runtimeDir(), 'runtime')
  }

  return roots
}

/** 把一个根展开成一个个文件（文件夹就一层层走进去） */
function expandFiles(source, name, out) {
  let stat
  try {
    stat = fs.statSync(source)
  } catch {
    return
  }

  if (stat.isFile()) {
    out.push({ source, name })
    return
  }
  if (!stat.isDirectory()) return

  let children
  try {
    children = fs.readdirSync(source, { withFileTypes: true })
  } catch {
    return // 没权限读的目录跳过，不中断整个备份
  }

  for (const child of children) {
    // 符号链接不跟——防止顺着链接跑到游戏目录外面去
    if (child.isSymbolicLink()) continue
    const full = path.join(source, child.name)
    if (child.isDirectory()) expandFiles(full, `${name}/${child.name}`, out)
    else if (child.isFile()) out.push({ source: full, name: `${name}/${child.name}` })
  }
}

/** 一个文件或文件夹总共多大（估算用） */
function treeSize(target) {
  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    return 0
  }
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0

  let total = 0
  let children = []
  try {
    children = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const child of children) {
    if (child.isSymbolicLink()) continue
    total += treeSize(path.join(target, child.name))
  }
  return total
}

/** 每一类大概多大（界面显示"约 XX MB"用） */
function estimateSizes() {
  const sizes = {}
  for (const key of Object.keys(CATEGORIES)) {
    let total = 0
    for (const root of collectRoots({ [key]: true })) total += treeSize(root.source)
    sizes[key] = total
  }
  return sizes
}

// ——————————————————————————————————————————————
// 人话说明 + 机器清单
// ——————————————————————————————————————————————

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 备份文件夹/文件的名字：备份-2026-10-07-213015 */
function backupName(date = new Date()) {
  return (
    `备份-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 写给人看的说明。三个月后打开这个备份，靠它就能明白是什么 */
function buildReadme(categories, fileCount, format) {
  const picked = Object.keys(CATEGORIES)
    .filter((key) => categories[key])
    .map((key) => CATEGORIES[key])
  const now = new Date()

  const lines = [
    '毛球 · 一键备份',
    '',
    `备份时间：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    `备份内容：${picked.join('、')}`,
    `备份形式：${format === 'zip' ? '压缩包' : '文件夹（双击就能看里面的东西）'}`,
    // 说明文件自己也在这个备份里，写清楚免得对不上（界面上报的是含它俩的总数）
    `文件数量：${fileCount} 个（另外还有本说明和 manifest.json）`,
    '',
    '里面都有什么：',
    '· saves\\            —— 存档（你的世界）',
    '· versions\\<版本号>\\saves\\ —— 某个版本自己的存档（开了版本隔离时用这个）',
    '· mods\\             —— Mod 文件',
    '· 启动器设置\\config.json —— 账号、内存这些设置',
    '· versions\\、libraries\\、assets\\、runtime\\ —— 游戏本体和资源（如果勾了）',
    '',
    '怎么用它：',
    '1. 先别动原文件，把这份备份留着',
    '2. 想恢复存档：把 saves 里的世界文件夹，复制回 游戏目录\\saves\\',
    '   （开了版本隔离的版本，就复制到 versions\\<版本号>\\saves\\）',
    '3. 想恢复设置：把 config.json 复制回 %APPDATA%\\毛球\\',
    '4. 拿不准就找懂电脑的人帮忙，别急着覆盖原文件',
    '',
    '提醒：备份是"当时那一刻"的快照。备份之后玩出来的新进度不在里面。'
  ]
  return lines.join('\r\n')
}

// ——————————————————————————————————————————————
// 干活
// ——————————————————————————————————————————————

/**
 * 做一次备份。
 *
 * @param {{categories: object, format: 'zip'|'folder'}} options
 * @param {{onProgress?: (payload: object) => void|Promise<void>}} hooks
 * @returns {Promise<{ok: boolean, path?: string, bytes?: number, count?: number, error?: string}>}
 */
async function createBackup(options, hooks = {}) {
  const { onProgress } = hooks
  const format = options.format === 'folder' ? 'folder' : 'zip'
  const categories = options.categories || {}

  if (!Object.keys(CATEGORIES).some((key) => categories[key])) {
    return { ok: false, error: '一样都没勾——先勾上要备份的东西' }
  }

  // 展开成文件清单
  const files = []
  for (const root of collectRoots(categories)) expandFiles(root.source, root.name, files)

  if (files.length === 0) {
    return { ok: false, error: '勾的东西都是空的，没什么可备份的' }
  }

  const totalBytes = files.reduce((sum, file) => {
    try {
      return sum + fs.statSync(file.source).size
    } catch {
      return sum
    }
  }, 0)

  // 返回回调的结果（可能是 Promise）——调用方 await 它来"喘口气"，
  // 免得备份几个 GB 的时候整个界面卡住不动
  const report = (payload) => {
    if (!onProgress) return undefined
    try {
      return onProgress(payload)
    } catch {
      return undefined
    }
  }

  try {
    paths.ensureDir(paths.backupsDir())
  } catch (error) {
    return { ok: false, error: `建不了备份文件夹：${error.message}` }
  }

  const name = backupName()
  const target = path.join(paths.backupsDir(), format === 'zip' ? `${name}.zip` : name)
  const readme = buildReadme(categories, files.length, format)
  const manifest = JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      categories,
      format,
      fileCount: files.length,
      totalBytes,
      files: files.map((file) => ({ name: file.name, source: file.source }))
    },
    null,
    2
  )

  // ——— 文件夹形式：直接往里复制 ———
  if (format === 'folder') {
    try {
      paths.ensureDir(target)
      let done = 0
      let copied = 0
      for (const file of files) {
        const dest = path.join(target, file.name)
        paths.ensureDir(path.dirname(dest))
        fs.copyFileSync(file.source, dest)
        done++
        try {
          copied += fs.statSync(file.source).size
        } catch {
          // 算不到大小不影响复制
        }
        if (done % 20 === 0 || done === files.length) {
          await report({ done, total: files.length, bytes: copied, totalBytes, path: target })
        }
      }

      fs.writeFileSync(path.join(target, '备份说明.txt'), readme, 'utf8')
      fs.writeFileSync(path.join(target, 'manifest.json'), manifest, 'utf8')

      return { ok: true, path: target, bytes: copied, count: files.length }
    } catch (error) {
      return { ok: false, error: `复制失败：${error.message}` }
    }
  }

  // ——— 压缩包形式 ———
  // 说明文件也要放进包里：先写成临时文件，进包，完事再删
  const tempFiles = []
  try {
    for (const [fileName, content] of [
      ['备份说明.txt', readme],
      ['manifest.json', manifest]
    ]) {
      const temp = path.join(paths.backupsDir(), `.tmp-${Date.now()}-${fileName}`)
      fs.writeFileSync(temp, content, 'utf8')
      tempFiles.push(temp)
      files.push({ source: temp, name: fileName })
    }

    const result = await zipwriter.writeZip(target, files, {
      onProgress: (done, total, bytes) =>
        report({ done, total, bytes, totalBytes, path: target })
    })

    if (!result.ok) {
      try {
        fs.unlinkSync(target)
      } catch {
        // 没生成就不用删
      }
      return { ok: false, error: result.error }
    }

    // 写完立刻验一遍：坏包绝不留下
    const check = zipwriter.verifyZip(target, files.length)
    if (!check.ok) {
      try {
        fs.unlinkSync(target)
      } catch {
        // 删不掉就算了，但下面会报错
      }
      return { ok: false, error: `压缩包写完自己验不过（${check.error}），已经删掉了，请重试` }
    }

    return { ok: true, path: target, bytes: result.bytes, count: result.count }
  } catch (error) {
    return { ok: false, error: `打包失败：${error.message}` }
  } finally {
    for (const temp of tempFiles) {
      try {
        fs.unlinkSync(temp)
      } catch {
        // 临时文件删不掉不致命
      }
    }
  }
}

/** 打开备份文件夹（没有就先建出来） */
async function openBackupFolder(shell) {
  try {
    paths.ensureDir(paths.backupsDir())
    const message = await shell.openPath(paths.backupsDir())
    return message ? { ok: false, error: message } : { ok: true, path: paths.backupsDir() }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

module.exports = {
  CATEGORIES,
  CATEGORY_HELP,
  collectRoots,
  estimateSizes,
  createBackup,
  openBackupFolder,
  backupName
}

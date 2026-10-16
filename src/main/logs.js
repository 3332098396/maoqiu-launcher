// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 日志归档轮转 + 脱敏诊断包（M23）
//
// 【两件事，为什么要放一起】
//   ① 轮转：启动器每开一次游戏就写一份 launch-*.log，只增不减，
//      半年下来几百份，翻起来找不到哪份是哪份。
//   ② 导出：用户出问题了要把日志发给别人看。但日志里有**账号令牌**、
//      **Windows 用户名**这些东西——直接发出去等于把自家钥匙拍给人家看。
//      所以导出的那份必须自动抹掉。
//
// 【脱敏只做"导出"那一份】硬盘上的原始日志一个字不动——
// 那是排查问题的第一手材料，抹了就没法查了。只在你**发给别人**的时候抹。
//
// 当前进度：M23。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')
const zipwriter = require('./zipwriter')

/** 启动器日志最多留几份（够翻最近几次，又不会堆成山） */
const KEEP_LOGS = 20

/** 单份日志写进诊断包时最多截多长（超过就只留尾巴，尾巴才是有用的那截） */
const MAX_LOG_BYTES = 4 * 1024 * 1024

/**
 * 轮转：把启动器日志留最近 KEEP_LOGS 份，多出来的删掉。
 *
 * 【只删我们自己的】只认 `launch-数字.log` 这种名字，
 * 而且只在 `%APPDATA%\毛球\logs\` 里面找——别的一律不碰。
 * 用户自己往那个文件夹里放的东西，名字对不上就不会被删。
 */
function rotateLauncherLogs(keep = KEEP_LOGS) {
  const dir = paths.logsDir()
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { removed: 0 }
  }

  const logs = []
  for (const name of names) {
    if (!/^launch-\d{14}\.log$/.test(name)) continue
    const full = path.join(dir, name)
    try {
      logs.push({ name, full, at: fs.statSync(full).mtimeMs })
    } catch {
      // 读不到就算了
    }
  }

  if (logs.length <= keep) return { removed: 0 }

  logs.sort((a, b) => b.at - a.at) // 新的在前
  let removed = 0
  for (const one of logs.slice(keep)) {
    try {
      fs.unlinkSync(one.full)
      removed++
    } catch {
      // 删不掉（被占用之类）就留着，不值得因此报错
    }
  }

  return { removed }
}

// ——————————————————————————————————————————————
// 脱敏
// ——————————————————————————————————————————————

/** 会被抹掉的东西和换成什么 */
const REDACTIONS = [
  // ① JSON 里的令牌字段（Mojang 的、外置登录的都在这一类）
  [/((?:"|')?(?:accessToken|access_token|mcAccessToken|refreshToken|clientSecret|client_secret|xuid)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1"<已抹掉>"'],
  // ② Authorization 头
  [/(Authorization\s*:\s*(?:Bearer|Basic)\s+)\S+/gi, '$1<已抹掉>'],
  // ③ 长得像 JWT 的一长串（三段点分 base64）——登录令牌基本都是这个形状
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<已抹掉的令牌>'],
  // ④ Windows 用户名（路径里的 C:\Users\xxx\）
  [/([A-Za-z]:\\Users\\)([^\\\r\n]+)/g, '$1<用户名>'],
  // ⑤ 我们自己的配置目录也带上用户名，单独再抹一遍（macOS / Linux 那种写法）
  [/(\/(?:home|Users)\/)([^/\r\n]+)/g, '$1<用户名>'],
  // ⑥ 明写着"用户名：某某"的地方
  [/(用户名\s*[:：]\s*)\S+/g, '$1<已抹掉>']
]

/**
 * 把一段文本里可能暴露身份/权限的东西换成占位符。
 * @returns {{text: string, hits: number}} hits 是抹了几处（界面上要如实告诉用户）
 */
function redact(text) {
  let out = String(text || '')
  let hits = 0

  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, (...args) => {
      hits++
      // $1 这种占位要手动展开：replace 传进来的参数里，最后两个是 offset 和原文
      const groups = args.slice(0, -2)
      return String(replacement).replace(/\$(\d)/g, (_, index) => groups[Number(index)] ?? '')
    })
  }

  return { text: out, hits }
}

// ——————————————————————————————————————————————
// 导出诊断包
// ——————————————————————————————————————————————

/** 读一个文件，太长就只留尾巴（问题一般都写在最后） */
function tailOf(file, maxBytes = MAX_LOG_BYTES) {
  const info = fs.statSync(file)
  if (info.size <= maxBytes) return fs.readFileSync(file, 'utf8')

  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    fs.readSync(fd, buffer, 0, maxBytes, info.size - maxBytes)
    return `（文件有 ${(info.size / 1024 / 1024).toFixed(1)} MB，这里只留了最后一段）\n\n${buffer.toString('utf8')}`
  } finally {
    fs.closeSync(fd)
  }
}

/** 按修改时间从新到旧排，取前几个 */
function newestFiles(dir, filter, count) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }

  const out = []
  for (const name of names) {
    if (filter && !filter(name)) continue
    const full = path.join(dir, name)
    try {
      const info = fs.statSync(full)
      if (info.isFile()) out.push({ path: full, name, at: info.mtimeMs, size: info.size })
    } catch {
      // 跳过
    }
  }

  return out.sort((a, b) => b.at - a.at).slice(0, count)
}

/**
 * 打一个诊断包给用户发给别人。
 *
 * 里面装：启动器日志（最近 5 份）+ 游戏日志 + 崩溃报告 + 一份说明。
 * **所有文本都过一遍脱敏**。
 *
 * @param {{outPath: string, dir?: string, versionId?: string}} options
 */
async function exportDiagnostics({ outPath, dir, versionId } = {}) {
  const gameDir = paths.gameDir(dir)
  const tempDir = path.join(paths.cacheDir(), `diag-${Date.now()}`)

  const collected = []
  let redactHits = 0

  /** 装一份文本进去（日志走这个，会过脱敏） */
  const addText = (inZipName, text) => {
    const { text: clean, hits } = redact(text)
    redactHits += hits
    writeInto(inZipName, clean)
  }

  /**
   * 装一份文本进去，**不脱敏**。
   *
   * 【为什么要有这个】说明书是我们自己写的（说明包里有什么、抹了哪些东西），
   * 里面**拿路径举了例子**。要是也过一遍脱敏，那句"`C:\Users\某某` 会变成
   * `C:\Users\<用户名>`"会被当成真路径吃掉一半，说明书写得驴唇不对马嘴
   * （第一版就是这样，导出后自己读了一遍才发现）。
   * 我们自己的固定文本里本来就没有秘密，不需要抹。
   */
  const addRawText = (inZipName, text) => {
    writeInto(inZipName, String(text))
  }

  const writeInto = (inZipName, text) => {
    const target = path.join(tempDir, inZipName)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text, 'utf8')
    collected.push({ source: target, name: inZipName, size: fs.statSync(target).size })
  }

  const addFile = (inZipName, filePath) => {
    try {
      addText(inZipName, tailOf(filePath))
    } catch {
      // 读不到就跳过这一份
    }
  }

  try {
    fs.mkdirSync(tempDir, { recursive: true })

    // ——— ① 启动器自己的日志（最近 5 份）———
    for (const one of newestFiles(paths.logsDir(), (name) => /^launch-\d{14}\.log$/.test(name), 5)) {
      addFile(`启动器日志/${one.name}`, one.path)
    }

    // ——— ② 游戏日志 ———
    const gameLogs = [
      path.join(gameDir, 'logs', 'latest.log'),
      path.join(gameDir, 'logs', 'debug.log')
    ]
    if (versionId) {
      gameLogs.push(path.join(paths.versionDir(versionId, dir), 'logs', 'latest.log'))
    }
    gameLogs.forEach((one, index) => {
      if (fs.existsSync(one)) addFile(`游戏日志/${index}.${path.basename(one)}`, one)
    })

    // ——— ③ 崩溃报告（最近 5 份）———
    for (const one of newestFiles(path.join(gameDir, 'crash-reports'), (n) => n.endsWith('.txt'), 5)) {
      addFile(`崩溃报告/${one.name}`, one.path)
    }

    // ——— ④ 说明（用户看一眼就知道包里是什么、哪些被抹了）———
    addRawText(
      '说明.txt',
      [
        '这是毛球导出的诊断包，给帮你排查问题的人看的。',
        '',
        '里面有什么：',
        '  · 启动器日志（最近几次启动的完整记录）',
        '  · 游戏自己的日志（latest.log）',
        '  · 游戏的崩溃报告（如果有）',
        '',
        '已经抹掉的东西：',
        '  · 登录令牌、刷新令牌、client secret',
        '  · Windows 用户名（路径里的 C:\\Users\\某某 会变成 C:\\Users\\<用户名>）',
        '',
        '没有动的东西：',
        '  · 你的存档、截图、Mod 文件——诊断包里**不含**这些',
        '',
        `导出时间：${new Date().toLocaleString('zh-CN')}`
      ].join('\n')
    )

    if (collected.length === 0) {
      return { ok: false, error: '什么日志都没找到，先启动一次游戏再来导出' }
    }

    const zip = await zipwriter.writeZip(outPath, collected)
    if (!zip.ok) return { ok: false, error: zip.error }

    return { ok: true, path: outPath, count: collected.length, bytes: zip.bytes, redactHits }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    // 临时目录用完就扔（那是我们自己造的，删它不用问用户）
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // 删不掉就算了，下次开机清理时还有机会
    }
  }
}

module.exports = { rotateLauncherLogs, redact, exportDiagnostics, KEEP_LOGS }

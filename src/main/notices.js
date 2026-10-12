// 毛球 — 通知中心（M23）
//
// 【这一块是干什么的】
// 以前顶栏那个铃铛点开就是日志窗口——它只是"日志的另一个入口"，
// 用户玩完游戏回来，看不出"刚才到底出没出过事"。
// 现在铃铛是**通知**：游戏异常退出、崩溃报告、安装失败这类事儿都会留在里面，
// 没看过的会亮一个小红点。点一条能直接跳到对应的日志。
//
// 【为什么存在启动器的配置目录里】就 30 条纯文本，几十 KB，
// 放 `%APPDATA%\毛球\notices.json`，跟别的配置一个地方，清理/备份都方便。
//
// 当前进度：M23。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')

/** 最多留几条。再多用户也不会往上翻，白占地方 */
const MAX_NOTICES = 30

function noticesFile() {
  return path.join(paths.configDir(), 'notices.json')
}

/** 读。读不到/坏了就当空的（**不是错误**，别为它弹报错） */
function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(noticesFile(), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((one) => one && typeof one === 'object')
  } catch {
    return []
  }
}

/** 原子写（先写临时文件再改名，断电不会留半个坏文件） */
function write(list) {
  const file = noticesFile()
  const temp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, JSON.stringify(list, null, 2), 'utf8')
    fs.renameSync(temp, file)
  } catch {
    // 记不住通知不影响玩游戏
  }
}

/** 全部通知（新的在前） */
function list() {
  return read()
}

/** 没看过几条（铃铛上那个小红点用） */
function unreadCount() {
  return read().filter((one) => !one.read).length
}

/**
 * 记一条通知。
 * @param {{kind?: string, title: string, text?: string, logFile?: string}} notice
 *   kind 只是给界面挑图标/颜色用的：'crash' 崩溃 / 'error' 出错 / 'info' 一般消息
 */
function add(notice) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    kind: String(notice?.kind || 'info'),
    title: String(notice?.title || '有件事'),
    text: String(notice?.text || ''),
    logFile: String(notice?.logFile || ''),
    read: false
  }

  const list = read()
  list.unshift(entry)
  write(list.slice(0, MAX_NOTICES))
  return entry
}

/** 全都标记成看过了（打开通知面板就调它） */
function markAllRead() {
  const list = read()
  let changed = false
  for (const one of list) {
    if (!one.read) {
      one.read = true
      changed = true
    }
  }
  if (changed) write(list)
  return list
}

/** 清空 */
function clear() {
  write([])
  return []
}

module.exports = { list, add, unreadCount, markAllRead, clear, MAX_NOTICES, noticesFile }

// 毛球 — 樱花内网穿透（M15）
//
// 【这是干什么的】和房间码（EasyTier）并列的另一种联机方式。
// 适合"愿意自己配隧道"的玩家：到樱花穿透（natfrp.com）注册、建一条 TCP 隧道
// 指向本机的游戏端口，然后把**访问密钥 + 隧道 ID** 填进毛球，毛球帮你把 frpc 跑起来。
//
// 【为什么不用它的开放接口】樱花有 API，但要密钥、要账号等级，还得跟着它改；
// 而 frpc 自己就带"拉配置"功能（`frpc -f 密钥:隧道ID`，官方手册里就是这么写的）——
// 把这件事交给 frpc 最省事，我们只管起进程、看日志、报告状态。
//
// 【frpc 从哪来】它的下载要登录樱花面板（没有公开地址），所以**由用户自己下**，
// 我们只记住他选的那个 exe 路径。好处：不用我们下载一个来路不明的可执行文件。
//
// 【和 EasyTier 的区别】frpc **不需要管理员权限**（没有虚拟网卡），
// 所以这条路子比联机房间"门槛低"——代价是好友得手动连过来，而且要先有樱花账号。

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const paths = require('./paths')
const settings = require('./settings')

/** 正在跑的 frpc 进程（null = 没跑） */
let child = null
/** 最近的日志行（给界面看状态用） */
let logLines = []
/** 起没起来、连没连上。
 *  【为什么叫 connected 不叫 ok】"接口调用成功"也叫 ok，两个 ok 撞在一起，
 *  界面就会把"隧道还没连上"当成"状态读不出来"（实测踩过）。 */
let state = { running: false, connected: false, message: '' }

/** 访问密钥只在内存里转一圈？不——它得存下来，不然每次都要重新填。
 *  存在哪：配置里的 online.frp（%APPDATA%\毛球\config.json），只在本机。
 *  界面上会写明"只存在本机"。 */
function readFrpConfig() {
  const config = settings.readConfig()
  const frp = (config.online && config.online.frp) || {}
  return {
    accessKey: String(frp.accessKey || ''),
    tunnelId: String(frp.tunnelId || ''),
    exePath: String(frp.exePath || ''),
    localPort: Number(frp.localPort) || 25565
  }
}

/** 存一部分设置 */
function saveFrpConfig(patch) {
  settings.writeConfig({ online: { frp: { ...readFrpConfig(), ...patch } } })
  return readFrpConfig()
}

/** 状态：给界面看的 */
function status() {
  return {
    running: Boolean(child),
    ...state,
    log: logLines.slice(-12),
    config: readFrpConfig()
  }
}

/** 一行日志进来：记下来，顺便从里面认状态 */
function noteLine(text) {
  logLines.push(text)
  if (logLines.length > 200) logLines.shift()

  // frpc 的输出里认这几句（不同版本措辞略有差别，所以用宽松的关键词）
  if (/启动成功|start tunnel success|start proxy success/i.test(text)) {
    state = { running: true, connected: true, message: '隧道已启动' }
  } else if (/认证失败|auth failed|token/i.test(text) && /fail|错误|失败/i.test(text)) {
    state = { running: true, connected: false, message: '访问密钥不对，或者这条隧道不属于这个账号' }
  } else if (/隧道不存在|tunnel not found|no such tunnel/i.test(text)) {
    state = { running: true, connected: false, message: '找不到这个隧道 ID——到樱花面板上核对一下' }
  } else if (/连接失败|connect failed|connection refused|timeout|超时/i.test(text)) {
    state = { running: true, connected: false, message: '连不上樱花节点，检查一下网络' }
  }
}

/**
 * 起隧道。
 *
 * @param {{accessKey: string, tunnelId: string, localPort: number, exePath: string}} options
 * @returns {{ok: boolean, error?: string}}
 */
function start(options = {}) {
  // 【为什么错误也要写进 state】界面点完"开始"会顺手刷新一次状态，
  // 而刷新是拿 state.message 覆盖提示行的——只 return 不写 state 的话，
  // 用户刚看到的"还没选 frpc.exe"会在 0.8 秒后被冲成空白（2026-10-09 全量体检抓到的）。
  const fail = (text) => {
    state = { running: false, connected: false, message: text }
    return { ok: false, error: text }
  }

  if (child) return fail('已经有一条隧道在跑了，先停掉它')

  const key = String(options.accessKey || '').trim()
  const tunnelId = String(options.tunnelId || '').trim()
  const exe = String(options.exePath || readFrpConfig().exePath || '').trim()

  if (!exe || !fs.existsSync(exe)) {
    return fail('还没选 frpc.exe——点「选 frpc 文件…」，到你下载樱花的那个文件夹里挑')
  }
  if (!key) return fail('先把访问密钥填上（樱花面板 → 用户信息 → 访问密钥）')
  if (!/^\d+$/.test(tunnelId)) return fail('隧道 ID 是一串数字，在樱花面板的隧道列表里')

  const localPort = Number(options.localPort) || 25565
  saveFrpConfig({ accessKey: key, tunnelId, exePath: exe, localPort })

  logLines = []
  state = { running: true, connected: false, message: '正在启动…' }

  try {
    child = spawn(exe, ['-f', `${key}:${tunnelId}`, '--disable_log_color'], {
      cwd: path.dirname(exe),
      windowsHide: true,
      // 【为什么 detached】和启动游戏那个坑一样：Electron 退出时会把子进程一起带走。
      // 这样用户关掉毛球，隧道也干净结束（这正是我们想要的——不留下一个偷偷跑着的隧道）
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    child = null
    state = { running: false, connected: false, message: `frpc 起不来：${error.message}` }
    return { ok: false, error: state.message }
  }

  const eat = (chunk) => {
    // frpc 的输出是纯文本（不像游戏那样带 XML），按行切开就行
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.trim()
      if (text) noteLine(text)
    }
  }
  child.stdout.on('data', eat)
  child.stderr.on('data', eat)

  child.on('exit', (code) => {
    child = null
    if (state.ok) {
      state = { running: false, connected: true, message: '隧道已停止' }
      return
    }

    // 没成功就退出了：把原因说清楚。
    // 【注意】这里不能直接用 state.message——它可能还停在"正在启动…"，
    // 那等于什么都没说。只有认出了具体原因（密钥错/隧道不存在/连不上）才用它。
    const known = state.message && state.message !== '正在启动…'
    state = {
      running: false,
      ok: false,
      message: known ? state.message : `frpc 退出了（退出码 ${code}）——看看下面的日志，常见原因是密钥或隧道 ID 不对`
    }
  })

  return { ok: true }
}

/** 停隧道 */
function stop() {
  if (!child) return { ok: true }
  try {
    child.kill()
  } catch {
    // 杀不掉就算了，exit 事件会兜底
  }
  child = null
  state = { running: false, connected: true, message: '隧道已停止' }
  return { ok: true }
}

module.exports = { start, stop, status, readFrpConfig, saveFrpConfig }

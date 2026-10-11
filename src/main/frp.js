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
/** "没人应声"的看门狗定时器（见 start() 里的说明） */
let watchdog = null

function clearWatchdog() {
  if (watchdog) clearTimeout(watchdog)
  watchdog = null
}
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

/** 状态：给界面看的。
 *  【为什么要把 state 里的 ok 剃掉】这个对象会被包成 `{ ok: true, ...这个 }` 发给界面，
 *  而界面（app.js 的 refreshFrp）第一句就是 `if (!status.ok) return`。
 *  只要 state 里混进一个 ok:false，上头的 ok:true 就被顶掉，界面从此不再刷新
 *  ——"卡在正在启动…"就是这么来的（2026-10-11，见 docs/10）。
 *  内部字段一律不许叫 ok。 */
function status() {
  const { ok: _drop, ...inner } = state
  return {
    running: Boolean(child),
    ...inner,
    log: logLines.slice(-12),
    config: readFrpConfig()
  }
}

/** 一行日志进来：记下来，顺便从里面认状态 */
function noteLine(text) {
  logLines.push(text)
  if (logLines.length > 200) logLines.shift()

  // frpc 的输出里认这几句（不同版本措辞略有差别，所以用宽松的关键词）
  // 【排在最前】新版的 frpc 被樱花锁了：别的程序一调用，它只打这句就退出
  // （2026-10-11 实测本机的 sakura-14 就是这样，见 docs/10）。
  if (/not intended to be run directly|part of SakuraFrp Launcher/i.test(text)) {
    state = {
      running: true,
      connected: false,
      message: '这个 frpc 是樱花启动器专用的，它拒绝被别的程序调用。请到樱花面板「软件下载」里下那个单独的 frpc.exe'
    }
  } else if (/启动成功|start tunnel success|start proxy success/i.test(text)) {
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
  // 【为什么先按名字拦一道】樱花启动器的安装目录里躺着好几个 exe：
  // SakuraLauncher.exe（图形界面）、SakuraFrpService.exe（后台服务）、frpc.exe（真正干活的）。
  // 用户很容易挑中前两个，而它们压根不读我们的参数——界面就永远停在"正在启动…"
  // （2026-10-11 用户就是这么踩的，见 docs/10）。
  const exeName = path.basename(exe).toLowerCase()
  if (/^sakuralauncher|^sakurafrp|^natfrp-service/.test(exeName)) {
    return fail('这个不是 frpc，是樱花自己的启动器/服务程序——它不听别的程序指挥。请到樱花面板「软件下载」里下那个单独的 frpc.exe，再选它')
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

  // 【"没人应声"的看门狗】挑错了文件时那个程序有两种表现：
  //   ① 图形程序（SakuraLauncher.exe）——不读参数、不打印、也永远不退出；
  //   ② 被锁的 frpc —— 打一行"不给别的程序调用"就退出（那句 noteLine 认得，走 exit 那条路）。
  // ①就靠这个兜底：真 frpc 一上来就会打版本号，所以"N 秒一句话都没有"基本就是挑错了。
  // 【为什么限定"一句话都没有"】能打印的 frpc 可能只是连得慢，那属于正常，别去打扰它。
  clearWatchdog()
  watchdog = setTimeout(() => {
    watchdog = null
    if (!child || state.connected) return
    if (logLines.length > 0) return
    state = {
      running: true,
      connected: false,
      message: '这个文件一直没吭声，多半是挑错了——要选的是 frpc.exe（樱花面板「软件下载」里那个），不是 SakuraLauncher / SakuraFrpService 这类程序'
    }
  }, 12000)

  child.on('exit', (code) => {
    clearWatchdog()
    child = null

    // 没成功就退出了：把原因说清楚。
    // 【注意】这里不能直接用 state.message——它可能还停在"正在启动…"，
    // 那等于什么都没说。只有认出了具体原因（密钥错/隧道不存在/连不上）才用它。
    //
    // 【为什么这里不许再写 ok 这个字段】它会被 status() 一并发给界面，
    // 而界面第一句是 `if (!status.ok) return`——于是"退出了"这条提示
    // 永远画不出来，界面就死死卡在"正在启动…"（2026-10-11 实测踩到，见 docs/10）。
    // 内部状态字段别跟 IPC 那个 ok 撞名字。
    const known = state.message && state.message !== '正在启动…'
    state = {
      running: false,
      connected: false,
      message: known ? state.message : `frpc 退出了（退出码 ${code}）——看看下面的日志，常见原因是密钥或隧道 ID 不对`
    }
  })

  return { ok: true }
}

/** 停隧道 */
function stop() {
  clearWatchdog()
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

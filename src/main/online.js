// 毛球 — 联机（房间码）
//
// 【两个人不在一块儿，怎么"像在一个局域网里"】
// 用 EasyTier 建一块**虚拟局域网**：双方各自跑一个 EasyTier，用同一个
// "网络名 + 密码"进去，就互相看得见了。之后游戏里那套「对局域网开放」
// 和「直接连接」照常能用——跟坐在同一个 WiFi 下没区别。
//
// 【房间码是什么】就是"网络名 + 密码"这两样东西的化身：
//   房间码  →  网络名 maoqiu-xxxx  +  密码（由码算出来的一串）
// 谁拿到码，谁就能推出一模一样的网络名和密码，于是进了同一个虚拟网络。
// 码本身**就是密码**，所以发给好友的那一刻等于把钥匙给了他——这是设计如此。
//
// 【房主固定 IP 10.126.126.1】访客永远连这个地址就行，不用每次问"你 IP 多少"。
// 访客自己用 DHCP 自动分配（-d），互不冲突。
//
// 【要管理员权限这件事】在 Windows 上建虚拟网卡必须提权。Electron 没有内建的提权 API，
// 所以走"写一个小小的 PowerShell 包装脚本 → 用 Start-Process -Verb RunAs 起它"这条路：
// 它只负责 ① 以管理员身份起 easytier-core ② 盯着两个信号决定什么时候收工
// （用户点了"离开房间" = 出现停止标记文件；毛球自己关掉了 = 我们的进程号没了）。
// **一次联机只弹一次 UAC**，收尾不需要再弹。

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const paths = require('./paths')
const settings = require('./settings')
const easytier = require('./easytier')

/** 房间码用的字符：把 O/0、I/1/L 这些看着像的剔掉了，念给朋友听也不容易错 */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

/** 房主的虚拟 IPv4。定死它，好友就永远连这一个地址 */
const HOST_IP = '10.126.126.1'

/**
 * 公共共享节点（志愿者捐的服务器，PCL 用的也是这个）。
 * 写两个：一个连不上就试下一个。它们只负责"牵线"，之后数据是两边直连的。
 */
const PUBLIC_NODES = ['tcp://public.easytier.top:11010', 'tcp://public.easytier.cn:11010']

/** 查状态用的 RPC 端口（EasyTier 自己的默认值，只监听本机） */
const RPC_PORTAL = '127.0.0.1:15888'

// ——————————————————————————————————————————————
// 房间码
// ——————————————————————————————————————————————

/** 生成一个新的房间码 */
function newRoomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[bytes[i] % CODE_CHARS.length]
  return code
}

/**
 * 把用户输进来的码整理一下：去掉空格和横杠、转大写。
 * 如果里面有"这个码根本不会出现的字符"（比如 0、O、1、I），说清楚哪里不对——
 * 多半是看错了，直接说比"房间不存在"有用。
 */
function normalizeCode(raw) {
  const text = String(raw || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')

  if (!text) return { ok: false, error: '房间码是空的' }

  const bad = [...new Set(text.split('').filter((ch) => !CODE_CHARS.includes(ch)))]
  if (bad.length > 0) {
    return {
      ok: false,
      error: `房间码里不会有这些字符：${bad.join(' ')}。可能是看错了（比如 0 和 O、1 和 I 长得像）`
    }
  }
  if (text.length !== CODE_LENGTH) {
    return { ok: false, error: `房间码是 ${CODE_LENGTH} 位，你输的是 ${text.length} 位` }
  }

  return { ok: true, code: text }
}

/** 房间码 → 网络名 + 网络密码（两边算出来必须一模一样） */
function networkFor(code) {
  return {
    name: `maoqiu-${code.toLowerCase()}`,
    secret: crypto.createHash('sha256').update(`maoqiu-room-v1-${code}`).digest('hex').slice(0, 24)
  }
}

// ——————————————————————————————————————————————
// 提权那套壳
// ——————————————————————————————————————————————

function wrapperScriptPath() {
  return path.join(paths.easytierRoot(), 'run-room.ps1')
}

function argsFilePath() {
  return path.join(paths.easytierRoot(), 'run-room.args')
}

function stopFlagPath() {
  return path.join(paths.easytierRoot(), 'stop.flag')
}

function roomLogDir() {
  return path.join(paths.easytierRoot(), 'logs')
}

/**
 * 写那个"以管理员身份运作"的包装脚本。
 *
 * 【为什么用文件传参数，不用命令行传】路径里有中文（毛球）、参数里有冒号和斜杠，
 * 一层层转义过去容易出错。写成"一行一个参数"的文件最省心，也不会被转义坑到。
 *
 * 脚本本身**刻意全是 ASCII**：cmd / powershell 读文件时的编码问题踩过坑，
 * 而且这个文件要放在中文目录里，里面再写中文就更乱了。
 */
function writeWrapper(ready) {
  // 【为什么要把所有参数直接写进脚本里】
  // 踩过的坑：一开始是把 core 路径、参数文件、进程号这些**当参数传进 PowerShell**
  // （`-Command "Start-Process ... -ArgumentList '-NoProfile','-File',...'`），
  // 参数一多、路径里又带中文（毛球），解析就崩了——而且报错还被吞掉，
  // 表现是"点了没反应"。现在改成：脚本每次现生成、路径写死在里面，
  // 起它的时候**只传一个脚本路径**（这是实测唯一稳的形式）。
  //
  // 【为什么写 BOM】PowerShell 5.1 读 .ps1 时，没有 BOM 会按系统编码(GBK)解，
  // 脚本里的中文路径就全乱了。带 UTF-8 BOM 才会正确按 UTF-8 读。
  const core = ready.core
  const argFile = argsFilePath()
  const flag = stopFlagPath()
  const trace = tracePath()
  const parentPid = process.pid

  const script = `# 毛球 — 以管理员身份跑 EasyTier，并在该收工时收工（这个文件是毛球自动生成的）
#   1. 起 easytier-core（参数从下面那个文件一行一行读）
#   2. 每一步都写进日记文件——联机出问题时，这个文件能说清"卡在哪一步"
#   3. 等着：用户点"离开房间"（出现停止标记）或者毛球本身退出了（进程号没了）
#   4. 把 core 收掉，自己退出

$ErrorActionPreference = 'SilentlyContinue'

$Core = '${core.replace(/'/g, "''")}'
$ArgFile = '${argFile.replace(/'/g, "''")}'
$Flag = '${flag.replace(/'/g, "''")}'
$Trace = '${trace.replace(/'/g, "''")}'
$ParentPid = ${parentPid}

function Note([string]$text) {
  $stamp = Get-Date -Format 'HH:mm:ss'
  Add-Content -LiteralPath $Trace -Value "$stamp $text" -Encoding UTF8
}

Note 'wrapper started'

# 【起新的之前，先把老的清干净】2026-10-08 实测踩到的大坑：
# 毛球被强杀（装安装包、任务管理器结束进程）之后，上一次那个 core 会留下来。
# 它是**管理员权限**起的，普通权限的 taskkill 杀不动，而那个包装脚本只管自己起的那一个
# ——于是谁都管不了它。后果很阴：新 core 因为端口被老占着，起来就秒退；
# 毛球连的其实还是那个老 core，界面上看着一切正常，**房间却是上一次的**。
# 这个脚本本身是管理员，所以在这儿清最合适：一次 UAC 之内顺手做完。
$old = @(Get-Process -Name 'easytier-core' -ErrorAction SilentlyContinue)
if ($old.Count -gt 0) {
  Note ("cleaning " + $old.Count + " stale core(s)")
  Stop-Process -Name 'easytier-core' -Force
  Start-Sleep -Seconds 1
}

$argsList = @()
if (Test-Path -LiteralPath $ArgFile) {
  foreach ($one in Get-Content -LiteralPath $ArgFile -Encoding UTF8) {
    if ($one -ne '') { $argsList += $one }
  }
}
Note ("args read: " + $argsList.Count)

$core = Start-Process -FilePath $Core -ArgumentList $argsList -PassThru -WindowStyle Hidden
if ($core -eq $null) { Note 'FAILED to start core'; exit 1 }
Note ("core started, pid=" + $core.Id)

while ($true) {
  Start-Sleep -Seconds 2
  if (Test-Path -LiteralPath $Flag) { Note 'stop flag seen'; break }
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { Note 'parent gone'; break }
  # 【为什么要看 core 还在不在】万一 core 自己退了（崩了、被别的软件杀了），
  # 这个脚本会一直傻等下去——变成一个永远不退的"管理员进程"（实测见过一次：
  # 早上发现一个昨夜的 core 没人管）。core 没了就跟着退。
  if (-not (Get-Process -Id $core.Id -ErrorAction SilentlyContinue)) { Note 'core already gone'; exit 0 }
}

# 按**名字**杀，不只杀自己起的那个：万一刚才那一步清完、又冒出来一个
# （或者 core 自己拉起了子进程），一起收拾掉。这个脚本是管理员，杀得动。
Stop-Process -Name 'easytier-core' -Force
Remove-Item -LiteralPath $Flag -Force
Note 'core stopped, wrapper done'
`

  const file = wrapperScriptPath()
  paths.ensureDir(path.dirname(file))
  // 带 UTF-8 BOM 写（见上面的说明，BOM 不能省）
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script, 'utf8')]))
  return file
}

/** 包装脚本的日记（它每一步都会往里写一行） */
function tracePath() {
  return path.join(paths.easytierRoot(), 'wrapper.log')
}

// ——————————————————————————————————————————————
// 起停
// ——————————————————————————————————————————————

/** 现在有没有房间在跑（问一下 RPC 端口通不通） */
function isRunning() {
  const version = currentVersion()
  if (!version) return false

  const cli = easytier.cliPath(version)
  if (!fs.existsSync(cli)) return false

  const result = spawnSync(cli, ['-p', RPC_PORTAL, '-o', 'json', 'node'], {
    timeout: 8000,
    encoding: 'utf8',
    windowsHide: true
  })

  return result.status === 0 && Boolean(`${result.stdout || ''}`.trim())
}

/** 这次用的是哪个版本（ensure 成功后就记在这儿，见 startRoom） */
let activeVersion = ''

/**
 * 当前用的 EasyTier 在哪个版本目录里。
 *
 * 【这里踩过一个坑】原来只从配置里读版本号，而版本号是**启动成功之后**才写进配置的——
 * 于是"起来了吗"这个判断在第一次启动时永远为假：房间明明已经跑起来了
 * （RPC 端口在听、虚拟 IP 都分配好了），代码却一直在等，等到超时判成失败。
 * 现在按"手上有的 → 配置里记的 → 目录里下过的"三层去找，不会再转不过弯。
 */
function currentVersion() {
  if (activeVersion && easytier.isReady(activeVersion)) return activeVersion

  const remembered = settings.readConfig().online.version
  if (remembered && easytier.isReady(remembered)) return remembered

  try {
    for (const name of fs.readdirSync(paths.easytierRoot())) {
      if (easytier.isReady(name)) return name
    }
  } catch {
    // 目录还不存在就是没下过
  }

  return ''
}

/**
 * 起一个房间。
 *
 * @param {{role: 'host'|'guest', code: string, onStage?: Function}} options
 * @returns {Promise<{ok: boolean, code?: string, role?: string, ip?: string, error?: string}>}
 */
async function startRoom(options) {
  const stage = (text) => {
    if (options.onStage) options.onStage(text)
  }

  if (isRunning()) leave()

  stage('正在准备联机组件…')
  const ready = await easytier.ensure({ onStage: stage })
  if (!ready.ok) return { ok: false, error: ready.error }

  // 先把这次用的版本记下来——下面判断"起来了吗"要用它（见 currentVersion 的说明）
  activeVersion = ready.version

  const net = networkFor(options.code)

  // 参数一行一个，写进文件给包装脚本读（见 writeWrapper 的说明）
  const args = [
    '--network-name',
    net.name,
    '--network-secret',
    net.secret,
    ...PUBLIC_NODES.flatMap((node) => ['-p', node]),
    '-r',
    RPC_PORTAL,
    '--file-log-dir',
    roomLogDir(),
    '--file-log-level',
    'warn',
    // 延迟优先：有几条路可走时挑最快的（R7.4 的"先试直连"）
    '--latency-first',
    'true'
  ]

  if (options.role === 'host') {
    args.push('-i', `${HOST_IP}/24`)
    // 把"对局域网开放"的广播包也送过去，好友的多人游戏列表里能**自动**看到这个房间
    // （这条只有 Windows 有，也正因为如此才需要管理员权限）
    args.push('--enable-udp-broadcast-relay', 'true')
  } else {
    // 访客自动分配一个虚拟 IP
    args.push('-d')
  }

  paths.ensureDir(roomLogDir())
  fs.writeFileSync(argsFilePath(), args.join('\n'), 'utf8')

  // ——— 先给"可能还在的旧包装脚本"一个收尾的机会 ———
  //
  // 【为什么要这么绕】毛球只有普通权限，杀不掉以管理员身份跑的 easytier-core；
  // 唯一能收掉它的是那个包装脚本（它有管理员权限）。正常情况下包装脚本会
  // 自己发现"毛球没了"然后收工，但**万一它先死了**（被强杀、被杀软干掉），
  // core 就没人管了——实测真碰上一次，早上发现一个昨夜残留的 core 还在跑。
  // 所以：起新房间之前先放个停止标记、等两秒，让可能存在的旧包装脚本看见它并收工，
  // 再把标记清掉、起自己的。
  try {
    fs.writeFileSync(stopFlagPath(), 'stop', 'utf8')
  } catch {
    // 写不进去就算了
  }
  await sleep(2000)
  try {
    fs.rmSync(stopFlagPath(), { force: true })
  } catch {
    // 本来就没有最好
  }

  const script = writeWrapper(ready)

  // 每次重来都把日记清空，免得看到上一回的
  try {
    fs.rmSync(tracePath(), { force: true })
  } catch {
    // 本来就没有最好
  }

  stage('正在创建虚拟网卡（会弹一次"是否允许"，点是就行）…')

  // 【这里踩过一个大坑，别改回去】一开始用的是
  //     spawn(..., { detached: true, stdio: 'ignore' })
  // 结果**提权静默失败**：没有任何报错、没有任何窗口、日志一片空白，
  // 表现就是"点了没反应"。对照实验才定位到是 `detached: true`——
  // 它让子进程脱离控制台，而提权（Start-Process -Verb RunAs）恰恰要靠控制台。
  // 现在用 spawnSync：外面这层 PowerShell 把提权请求发出去就立刻退出了，
  // 不需要一直挂着，也就用不着 detached。
  const elevated = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      // 只传一个脚本路径——这是实测唯一稳的形式（见 writeWrapper 里的说明）
      `Start-Process -FilePath 'powershell.exe' -Verb RunAs ` +
        `-ArgumentList '-NoProfile','-File',${quote(script)}`
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 20000 }
  )

  if (elevated.error) {
    return { ok: false, error: `没能启动联机组件：${elevated.error.message}` }
  }

  // 等它真的起来（RPC 端口通了才算）
  stage('正在进房间…')
  const started = Date.now()
  while (Date.now() - started < 30000) {
    await sleep(1500)
    if (isRunning()) {
      settings.writeConfig({ online: { code: options.code, role: options.role, version: ready.version } })
      return {
        ok: true,
        code: options.code,
        role: options.role,
        ip: options.role === 'host' ? HOST_IP : '',
        version: ready.version
      }
    }
  }

  // 起不来的话，把包装脚本的日记带上——用户描述不清时，这是唯一的线索
  let trace = ''
  try {
    const lines = fs.readFileSync(tracePath(), 'utf8').trim().split(/\r?\n/)
    trace = lines.slice(-3).join(' / ')
  } catch {
    trace = ''
  }

  return {
    ok: false,
    error:
      '联机组件没能起来。常见原因：刚才那个"是否允许"的窗口点了"否"、或者没注意到，' +
      '也可能被安全软件拦了。再点一次试试。' +
      (trace ? `（组件那边的记录：${trace}）` : '（组件那边一点动静都没有——多半是没点到"是"）')
  }
}

/** PowerShell 单引号字符串里的转义：把一个 ' 写成两个 */
function quote(text) {
  return `'${String(text).replace(/'/g, "''")}'`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 离开房间。
 *
 * 做法是"轻轻放一个标记文件"，那个以管理员身份跑着的包装脚本看到它就会
 * 自己收工——这样不用再弹一次 UAC 去杀进程（普通权限杀不掉管理员进程）。
 */
function leave() {
  try {
    paths.ensureDir(paths.easytierRoot())
    fs.writeFileSync(stopFlagPath(), 'stop', 'utf8')
  } catch {
    // 写不进去也得往下走：下面还会尽力杀一把
  }

  const version = currentVersion()
  if (version) {
    // 兜底：万一包装脚本没了（比如毛球被强杀过），直接杀进程
    spawnSync('taskkill', ['/IM', 'easytier-core.exe', '/F'], { windowsHide: true, timeout: 8000 })
  }

  settings.writeConfig({ online: { code: '', role: '' } })
  return { ok: true }
}

// ——————————————————————————————————————————————
// 看状态
// ——————————————————————————————————————————————

/** 把 easyetier-cli 给的一行数据翻译成我们界面上要说的话 */
function describePeer(raw) {
  const cost = String(raw.cost ?? raw.path_cost ?? '')
  const relayed = /relay/i.test(cost)

  const lat = Number(raw.lat_ms ?? raw.latency_ms ?? raw.latency ?? 0)
  const hostname = String(raw.hostname ?? raw.host ?? '')
  const ipv4 = String(raw.ipv4 ?? raw.ip ?? '')

  // 主机名我们没设，会显示成机器名；界面上显示成"某某的设备"更好认
  return {
    ip: ipv4,
    name: hostname || ipv4,
    latencyMs: Number.isFinite(lat) ? Math.round(lat) : null,
    route: relayed ? 'relay' : 'direct',
    routeText: relayed ? '走中转（慢一点）' : '直连',
    lossRate: Number(raw.loss_rate ?? raw.loss ?? 0) || 0
  }
}

/**
 * 收拾"上一个毛球留下来的联机进程"。
 *
 * 【为什么需要】EasyTier 是 detached 起来的（为了让关掉毛球后联机还能用一会儿）。
 * 正常情况下毛球一退、那个以管理员跑的包装脚本会自己收工；
 * 但**毛球被强杀**（装安装包、任务管理器结束进程）时，core 会一直挂着。
 * 于是新开的毛球一问"有进程在跑"就说"你在房间里"——可房间码和身份早已经清空了，
 * 界面上就会显示成"你在好友的房间里"、房间码一个横杠（2026-10-08 用户就是这么撞上的：
 * "为什么安装程序安装完就显示已经创建房间，我并没有创建"）。
 *
 * 【判据】**配置里没有房间记录**（code 为空）却检测到在跑 → 一定是残留，收掉。
 * 有记录的一律留着——那种是"毛球崩了又重开"，房间本来就该继续。
 *
 * @returns {boolean} 有没有真收拾掉一个
 */
function cleanupStray() {
  const config = settings.readConfig().online
  if (config.code) return false // 有记录：正常的房间，别动
  if (!currentVersion()) return false // 这台机器还没装过联机组件
  if (!isRunning()) return false // 没在跑，无事可做

  leave()
  startupNote = '顺手收掉了一个上次没退干净的联机进程。'
  return true
}

/**
 * 启动时清理残留的提示，**读一次就清掉**（免得界面上反复弹）。
 * 【为什么要给界面看】用户要求"每次打开毛球让他自己检测有没有没退干净的残留"——
 * 光在控制台打一行他看不见，得让他知道"检查过了、还清理了"。
 */
let startupNote = ''

function takeStartupNote() {
  const note = startupNote
  startupNote = ''
  return note
}

/** 启动时收掉"游戏早就退了的空房间"，顺带记一句给界面 */
function noteStrayRoom() {
  startupNote = '收掉了一个上次留下的空房间（游戏已经退出了）。'
}

/**
 * 房间现在什么情况：通不通、都有谁、延迟多少、直连还是中转。
 * @returns {{running: boolean, peers: Array, error?: string}}
 */
function status() {
  const version = currentVersion()
  if (!version || !isRunning()) return { running: false, peers: [], myIp: '' }

  const cli = easytier.cliPath(version)
  const run = (args) =>
    spawnSync(cli, ['-p', RPC_PORTAL, '-o', 'json', ...args], {
      timeout: 10000,
      encoding: 'utf8',
      windowsHide: true
    })

  // 先问"我自己是谁"——peer 列表里**包含自己那条**，不排掉的话界面上
  // 会显示成一个"好友"，用户会以为已经有人进来了
  let myIp = ''
  try {
    const me = JSON.parse(`${run(['node']).stdout || ''}`.trim() || '{}')
    myIp = String(me.ipv4_addr || '').split('/')[0]
  } catch {
    myIp = ''
  }

  const result = run(['peer', 'list'])

  if (result.status !== 0) {
    return { running: true, peers: [], myIp, error: '状态暂时读不出来' }
  }

  try {
    const text = `${result.stdout || ''}`.trim()
    const data = text ? JSON.parse(text) : []
    const list = Array.isArray(data) ? data : data.peers || data.items || []

    const peers = list
      .map(describePeer)
      .filter((one) => one.ip && !one.ip.startsWith('127.'))
      .filter((one) => !myIp || one.ip !== myIp)

    return { running: true, peers, myIp }
  } catch (error) {
    return { running: true, peers: [], myIp, error: `状态读出来看不懂：${error.message}` }
  }
}

module.exports = {
  newRoomCode,
  normalizeCode,
  networkFor,
  startRoom,
  leave,
  cleanupStray,
  takeStartupNote,
  noteStrayRoom,
  isRunning,
  status,
  HOST_IP,
  CODE_LENGTH
}

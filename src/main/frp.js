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
// 【frpc 从哪来】毛球**自己下**（见下面「frpc 从哪来」那一节），也允许用户自己指一个。
// 【和 EasyTier 的区别】frpc **不需要管理员权限**（没有虚拟网卡），
// 所以这条路子比联机房间"门槛低"——代价是好友得手动连过来，而且要先有樱花账号。

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const paths = require('./paths')
const settings = require('./settings')
const downloader = require('./downloader')

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

// ══════════════════════════════════════════════════════
// frpc 从哪来：毛球自己下（2026-10-11 补）
// ══════════════════════════════════════════════════════
//
// 【为什么非自己下不可】樱花启动器（就是樱花的图形界面）自带一个 frpc.exe，但它**被锁了**：
// 别的程序一调用，它只打一句 "not intended to be run directly or launched by any program
// other than SakuraFrp Service" 就自己退出。实测过（2026-10-11，见 docs/10）。
// 能用的是樱花**面板「软件下载」里的那个独立版**，而它在一个公开的下载站上：
//
//     https://nya.globalslb.net/natfrp/client/frpc/<版本>/frpc_windows_amd64.exe
//
// 那个站不用登录、不用账号（翻过它的目录）。所以让用户自己去面板里点来点去太绕了，
// 毛球直接下——**但不能白下**：下完必须验，见下面两道关。
//
// 【为什么不打包进安装包】14 MB，而且它是别人家的程序：用的时候下最新版更合理，
// 也不用替它的更新操心（和联机组件 EasyTier 一个路子）。
//
// 【怎么保证下下来的没被换过 —— 两道关】
//   ① 哈希：那个站**不提供官方校验值**（翻过目录列表，没有 .sig 也没有清单文件），
//      所以只能"毛球自己认过的清单"：版本号 + 大小 + SHA-256 写死在下面这张表里。
//      下完逐字节核对，对不上就删掉、报错、绝不用。
//      （代价：樱花出新版时毛球不会自动跟，得我们往表里加一行——这是拿"能校验"换的，值。）
//   ② 再扫一眼文件里有没有那句"不给别的程序调用"的守卫字符串。被锁的那个版本和独立版
//      **文件名一模一样，只有内容不同**，哈希管住了"是不是我们认的那个字节"，
//      这一道管住"下到的到底是不是能干活的"——万一我们抄错哈希，它能兜住。

/**
 * 毛球认过的 frpc（新的排前面，优先用新的）。
 *
 * 【怎么加一行 / 换新的】
 *   1. 到上面那个地址把 exe 下下来（把 <版本> 换成新的）
 *   2. `sha256sum frpc.exe` 和 `ls -l` 拿到哈希和大小，填进来
 *   3. 顺手验一下它是独立版：`grep -c "not intended to be run directly" frpc.exe` 应当是 **0**
 *      （是 1 就说明你下到了被锁的那个，别加进来）
 *
 * 【为什么写死版本号，而不是每次去问"最新是哪个"】那个下载站没有版本清单接口，
 * 目录列表是个网页（得解析 HTML，还会变）。写死 = 每次下的都是同一串字节，哈希才验得起来。
 * 旧版本哪天被它删了，会自动往下一个试，不会卡死。
 */
const FRPC_VERSIONS = [
  { version: '0.51.0-sakura-15', size: 14209024, sha256: '7387a348ac631a736d15c796e89a972186b48ae3db9210bb60a451e50a17ea69' },
  { version: '0.51.0-sakura-14', size: 14133248, sha256: 'b705262edad9f0de04b38f342e811e9d97d0beada75edab3f790e105dcfb5234' }
]

/** 我们这个平台上，那个文件叫什么名 */
const FRPC_FILENAME = 'frpc_windows_amd64.exe'

/** "只有樱花自己的服务能调用我"的守卫字符串（被锁的版本里有，独立版里没有） */
const FRPC_LOCKED_MARK = 'not intended to be run directly'

/** 某个版本的下载地址 */
function frpcUrl(version) {
  return `https://nya.globalslb.net/natfrp/client/frpc/${version}/${FRPC_FILENAME}`
}

/** 下好之后落在哪儿 */
function frpcPath() {
  return path.join(paths.frpcDir(), 'frpc.exe')
}

/** 算一段内容的 SHA-256（十六进制小写） */
function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * 硬盘上现在这个 frpc 能用吗。
 * @returns {{ok: boolean, path?: string, version?: string, reason?: string}}
 *          reason: missing 没有 / unreadable 读不动 / unknown 有但对不上我们认的清单
 */
function frpcState() {
  const file = frpcPath()
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' }

  let got = ''
  try {
    got = sha256Of(fs.readFileSync(file))
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  const hit = FRPC_VERSIONS.find((entry) => entry.sha256 === got)
  if (!hit) return { ok: false, reason: 'unknown' }
  return { ok: true, path: file, version: hit.version }
}

/**
 * 确保硬盘上有一个"能用的"frpc.exe。已经有就直接用；没有就下一个，下完验。
 *
 * @param {{onStage?: Function, onProgress?: Function}} options
 * @returns {Promise<{ok: boolean, path?: string, version?: string, downloaded?: boolean, error?: string}>}
 */
async function ensureFrpc(options = {}) {
  const stage = (text) => {
    if (options.onStage) options.onStage(text)
  }

  const ready = frpcState()
  if (ready.ok) return { ok: true, path: ready.path, version: ready.version, downloaded: false }

  paths.ensureDir(paths.frpcDir())

  const dest = frpcPath()
  // 【为什么先下到 .part 再改名】下到一半断电/断网，硬盘上留的是 .part，
  // 不会被当成本体拿去跑（和"配置先写临时文件再改名"是一个道理）。
  const tmp = `${dest}.part`
  let lastError = ''

  for (const entry of FRPC_VERSIONS) {
    stage(`正在下载 frpc（${entry.version}，约 ${Math.round(entry.size / 1048576)} MB）…`)

    try {
      const task = downloader.createTask(
        [{ name: FRPC_FILENAME, url: frpcUrl(entry.version), saveTo: tmp, size: entry.size }],
        { onProgress: options.onProgress }
      )
      const stats = await task.start()

      if (stats.failed !== 0 || !fs.existsSync(tmp)) {
        lastError = stats.failures[0] ? String(stats.failures[0].error) : '下载失败'
        continue
      }

      // ——— 第一道关：哈希 ———
      stage('正在核对校验值…')
      const buffer = fs.readFileSync(tmp)
      const got = sha256Of(buffer)
      if (got !== entry.sha256) {
        lastError = `${entry.version} 下下来对不上校验值（下载站可能有问题）`
        continue
      }

      // ——— 第二道关：确认它不是"被锁"的那个版本 ———
      if (buffer.includes(FRPC_LOCKED_MARK)) {
        lastError = '下到的 frpc 是"只认樱花启动器"的那个版本，毛球指挥不动它'
        continue
      }

      // 换上新文件。目标位置可能躺着一个旧的/坏的同名文件（Windows 的 rename 不许覆盖，
      // 所以先删；删了才有那一下"短暂没有 frpc"的窗口，但那时用户也不会正好去点启动）
      try {
        fs.rmSync(dest, { force: true })
      } catch {
        // 删不掉的话下面 rename 会报错，会被 catch 住
      }
      fs.renameSync(tmp, dest)

      return { ok: true, path: dest, version: entry.version, downloaded: true }
    } catch (error) {
      lastError = String(error?.message ?? error)
    } finally {
      // 这一路成没成都把半截文件清掉（成功时已经改名走了，这儿删的是不存在的东西，无所谓）
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // 删不掉不影响什么，下次会覆盖
      }
    }
  }

  return {
    ok: false,
    error: `frpc 没下下来（${lastError}）。检查一下网络再试一次；也可以自己到樱花面板「软件下载」里下一个，用旁边的「我自己有，选文件…」指给毛球。`
  }
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

  const next = readFrpcLine(text, state.connected)
  if (next) state = { running: true, connected: next.connected, message: next.message }
}

/**
 * 认一行 frpc 的输出，说出"现在算是什么状态"。
 *
 * 【为什么单独拆出来】它得能**拿字符串单独喂**着验（喂真机日志里的原话），
 * 不用起界面、不用真去连隧道。所以做成纯函数：只看传进来的两个参数，不碰外面的东西。
 *
 * 【底下这些措辞是从独立版 frpc 的二进制里挖出来的原话】——不是猜的：
 *   成功：  "%s 隧道启动成功" / "隧道已启动" / "连接节点成功, 运行 …"
 *   密钥：  "访问密钥错误" / "访问密钥无效, 请检查您的输入" / "访问密钥输入有误" /
 *           "访问密钥长度错误" / "配置中的访问密钥为空"
 *   已在线："当前隧道已在线, 请勿重复开启"
 *   连不上："登录节点失败, 请检查网络连接" / "正在重试连接节点…"
 * 【为什么非挖不可】最早那版代码认的是"启动成功"/"认证失败"这种想当然的词，
 * 跟真机对不上——表现就是隧道其实通了，界面却永远停在"正在启动…"。
 *
 * @param {string} text 一行输出
 * @param {boolean} wasConnected 认这行之前是不是已经连上了
 * @returns {{connected: boolean, message: string}|null} 认不出来就 null（状态不动）
 */
function readFrpcLine(text, wasConnected) {
  // 【排在最前】被锁的 frpc：别的程序一调用，它只打这句就退出
  // （2026-10-11 实测本机的 sakura-14 就是这样，见 docs/10）。
  if (/not intended to be run directly|part of SakuraFrp Launcher/i.test(text)) {
    return {
      connected: false,
      message: '这个 frpc 是樱花启动器专用的，它拒绝被别的程序调用。点上面的「让毛球自己下 frpc」换一个'
    }
  }

  // 【"先别慌"这一类，必须挡在底下那条 timeout 规则前面】
  // 隧道起来之后，frpc 会时不时重试某一条"数据通道"，日志里长这样：
  //   [W] 新数据连接建立失败: dial tcp 122.192.154.125:8088: i/o timeout
  // 这是**正常抖动**，不是"连不上樱花节点"。不单独拦下来的话，底下那条规则一看
  // 到 timeout 就当故障，把已经显示出来的「隧道已启动」翻成「连不上樱花节点」——
  // 用户看到的就是状态自己乱跳（2026-10-11 用户实测抓到的正是这个）。
  if (/新数据连接|重试连接节点|正在重试|reconnect/i.test(text)) {
    // 已经连上的：一个字都不改，保持"隧道已启动"
    if (wasConnected) return null
    // 还没连上的：给一句话说明它在忙什么，但别喊"故障"
    return { connected: false, message: 'frpc 正在重试跟节点的数据连接——日志里有详情，先等一会儿' }
  }

  if (/隧道启动成功|隧道已启动|启动成功|连接节点成功|start tunnel success|start proxy success/i.test(text)) {
    return { connected: true, message: '隧道已启动' }
  }

  if (/隧道已在线|请勿重复开启/i.test(text)) {
    return {
      connected: false,
      message: '这条隧道已经在别处开着了（樱花一条隧道同时只能开一处）——先把那边关掉，或者换一条隧道'
    }
  }

  // 【为什么"访问密钥"和"错误"要分两段判】frpc 有好几种说法（错误 / 无效 / 为空 / 有误 /
  // 长度错误），而"访问密钥"这四个字本身也出现在正常提示里，所以必须两个都中才算。
  if (/访问密钥/.test(text) && /错误|无效|为空|有误|长度/.test(text)) {
    return {
      connected: false,
      message: '访问密钥不对——到樱花面板「用户信息」里重新复制一遍（注意别漏字符、别带空格）'
    }
  }

  if (/认证失败|auth failed/i.test(text) || (/token/i.test(text) && /fail|错误|失败/i.test(text))) {
    return {
      connected: false,
      message: '认证没过——多半是访问密钥不对；反复失败的话再看看电脑时间准不准'
    }
  }

  if (/隧道不存在|tunnel not found|no such tunnel/i.test(text)) {
    return { connected: false, message: '找不到这个隧道 ID——到樱花面板上核对一下' }
  }

  if (/隧道.*失败/.test(text)) {
    return {
      connected: false,
      message: '这条隧道没起来——到樱花面板上看看它的状态（欠费、被停用、端口被占都会这样）'
    }
  }

  if (/登录节点失败|连接节点失败|连接失败|connect failed|connection refused|timeout|超时/i.test(text)) {
    return { connected: false, message: '连不上樱花节点，检查一下网络' }
  }

  return null
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
    return fail('还没有 frpc——点「让毛球自己下 frpc」就行（想用自己手上的那个，就点「我自己有，选文件…」）')
  }
  // 【为什么先按名字拦一道】樱花启动器的安装目录里躺着好几个 exe：
  // SakuraLauncher.exe（图形界面）、SakuraFrpService.exe（后台服务）、frpc.exe（真正干活的）。
  // 用户很容易挑中前两个，而它们压根不读我们的参数——界面就永远停在"正在启动…"
  // （2026-10-11 用户就是这么踩的，见 docs/10）。
  const exeName = path.basename(exe).toLowerCase()
  if (/^sakuralauncher|^sakurafrp|^natfrp-service/.test(exeName)) {
    return fail('这个不是 frpc，是樱花自己的启动器/服务程序——它不听别的程序指挥。点上面的「让毛球自己下 frpc」换一个')
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

module.exports = { start, stop, status, readFrpConfig, saveFrpConfig, ensureFrpc, readFrpcLine }

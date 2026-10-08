// 毛球 — 主进程入口
//
// 主进程负责所有"重活"：窗口、下载、装游戏、启动游戏、读写配置。
// 界面（renderer）只负责显示和上报点击，不直接碰系统能力，
// 两者通过 preload 里的安全桥通信。
//
// 当前进度：M5（启动游戏）。
//
// 已经接好的模块：
//   M2 版本清单    → src/main/mojang.js
//   M3 下载引擎    → src/main/downloader.js
//   M4 安装版本    → src/main/install.js + zip.js
//   M5 启动游戏    → src/main/launch.js + accounts.js + java.js + settings.js
//   M6 版本管理    → settings.js 的界面部分

const { app, BrowserWindow, ipcMain, shell, screen, dialog } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const mojang = require('./mojang')
const install = require('./install')
const paths = require('./paths')
const settings = require('./settings')
const accounts = require('./accounts')
const yggdrasil = require('./yggdrasil')
const microsoft = require('./microsoft')
const skins = require('./skins')
const javaUtil = require('./java')
const launch = require('./launch')
const versions = require('./versions')
const inherit = require('./inherit')
const cleanup = require('./cleanup')
const backup = require('./backup')
const modrinth = require('./modrinth')
const content = require('./content')
const downloader = require('./downloader')
const pack = require('./pack')
const online = require('./online')
const frp = require('./frp')
const loaders = require('./loaders')
const forge = require('./forge')

// 软件名。它会决定数据存放目录：%APPDATA%\毛球\
app.setName('毛球')

// 开发模式换一个"网页缓存"目录（配置、账号那些还是共用的）。
//
// 【为什么】开发版和你桌面上装好的那份**用的是同一个** %APPDATA%\毛球\，
// 里面那个 Cache 文件夹同一时间只允许一个程序用。两个一起开的时候，
// 后启动的那个会刷一屏 "Unable to create cache 拒绝访问"，
// 而且**图片会加载不出来**（实测：首页大启动卡那张风景图直接消失，只剩渐变底色，
// 看起来就像"功能没做"）。开发模式的缓存丢了无所谓，换一个目录最省事。
if (!app.isPackaged) {
  app.commandLine.appendSwitch('disk-cache-dir', path.join(app.getPath('temp'), '毛球-dev-cache'))
}

/**
 * 从旧名字的目录搬一次家。
 *
 * 【为什么必须做】软件原来叫「MC启动器」，配置存在 %APPDATA%\MC启动器\
 * （账号、设置、备份、日志都在里面）。改名后程序会去找 %APPDATA%\毛球\——
 * 不搬的话，用户打开软件会发现**账号和备份凭空消失了**。
 *
 * 只在新目录还不存在、旧目录存在时搬一次；是"移动"不是"复制"。
 * 搬不动就退一步复制；再不行就算了（程序照常能用，只是回到默认设置）。
 */
function migrateDataDirFromOldName() {
  try {
    const appData = app.getPath('appData')
    const oldDir = path.join(appData, 'MC启动器')
    const newDir = path.join(appData, '毛球')

    if (fs.existsSync(newDir) || !fs.existsSync(oldDir)) return

    try {
      fs.renameSync(oldDir, newDir)
    } catch {
      fs.cpSync(oldDir, newDir, { recursive: true })
    }
    console.log(`已把数据目录搬到新名字下：${oldDir} → ${newDir}`)
  } catch (error) {
    console.warn('数据目录没搬成（不影响使用，只是设置会回到默认）：', error.message)
  }
}

migrateDataDirFromOldName()

/** 主窗口 */
let mainWindow = null

// ——————————————————————————————————————————————
// 开场动画（M17.4）
// ——————————————————————————————————————————————

/** 那个小窗口 */
let splashWindow = null
/** 它是什么时候出现的（用来算"至少显示多久"） */
let splashShownAt = 0

/**
 * 开场动画**最少**显示多久。
 * 【为什么要设个下限】机器快的话主窗口几百毫秒就画好了，
 * 动画"啪"地闪一下反而像出了故障。宁可让它稳稳当当待够，再切过去。
 */
const SPLASH_MIN_MS = 1400

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 360,
    height: 240,
    frame: false,
    transparent: true, // 圆角和阴影要靠它；不透明就是个方角黑框
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true, // 别在任务栏里多出一个窗口
    center: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })

  splashShownAt = Date.now()
  splashWindow.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'))
  splashWindow.once('ready-to-show', () => {
    splashShownAt = Date.now() // 从"真的显示出来"开始算，别把加载时间算进去
    try {
      splashWindow.show()
    } catch {
      // 窗口已经没了就算了
    }
  })
  splashWindow.on('closed', () => {
    splashWindow = null
  })
}

/** 收掉开场动画（主窗口要出来的时候调） */
function closeSplash() {
  if (!splashWindow) return
  try {
    splashWindow.close()
  } catch {
    // 已经没了
  }
  splashWindow = null
}

function createWindow() {
  mainWindow = new BrowserWindow({
    // 左边现在有个导航栏（M14.2），窗口宽一点内容才不挤
    width: 1180,
    // M17.5：设计稿是大版式（一屏放下大启动卡 + 四格 + 两栏），
    // 740 太挤会把皮肤预览挤到屏幕外，所以默认高一点
    height: 824,
    minWidth: 900,
    minHeight: 600,
    title: '毛球',
    icon: path.join(__dirname, '..', '..', 'assets', 'app-256.png'),
    backgroundColor: '#F2F8FF',
    // M17.4：标题栏自己画（设计稿右上角画了最小化/最大化），所以不要系统那一条。
    // 【别忘了】去掉系统边框后，能拖窗口的只剩界面里标了 -webkit-app-region: drag 的那块，
    // 三个按钮在顶栏右边（见 index.html / style.css）。
    frame: false,
    show: false, // 先不显示，等页面画好再显示，避免白屏闪烁
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, // 界面代码与主进程代码隔离，安全底线
      nodeIntegration: false // 界面里不许直接调用 Node，安全底线
    }
  })

  // 去掉 Electron 自带的英文菜单栏（File / Edit / View…），它对这个软件没用
  mainWindow.removeMenu()

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  // 最大化/还原的时候告诉界面一声（双击标题栏、Win+↑ 也能最大化，
  // 界面不通知就不知道，那个按钮的图标会一直停在错的样式上）
  const tellMax = (isMax) => () => {
    if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('win:maximized', isMax)
    }
  }
  mainWindow.on('maximize', tellMax(true))
  mainWindow.on('unmaximize', tellMax(false))

  // 窗口关掉时把"盯着光标"那个计时器也停了。
  // 【为什么要专门停】窗口没了以后计时器还往界面发消息，Electron 会在控制台
  // 刷一堆 "Render frame was disposed" 的红色报错——看着像软件坏了，其实不是。
  mainWindow.on('closed', () => {
    if (cursorWatcher) {
      clearInterval(cursorWatcher)
      cursorWatcher = null
    }
  })

  mainWindow.once('ready-to-show', () => {
    // 开场动画至少待够 SPLASH_MIN_MS 再切——太快了像闪了一下故障
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt))
    setTimeout(() => {
      closeSplash()
      mainWindow.show()
    }, wait)
  })

  return mainWindow
}

// ——————————————————————————————————————————————
// 界面能调用的接口（与 preload 里列出的方法一一对应）
// ——————————————————————————————————————————————

// ——— 窗口按钮（M17.4：标题栏是自己画的，这三个动作也得自己接）———
//
// 【为什么不用 event.sender 里那个窗口】界面送来的东西不能全信；
// 这里只拿"发消息的那个界面所属的窗口"，不认界面报上来的任何 id。

ipcMain.handle('win:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize()
})

ipcMain.handle('win:toggleMaximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})

ipcMain.handle('win:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})

ipcMain.handle('win:isMaximized', (event) =>
  Boolean(BrowserWindow.fromWebContents(event.sender)?.isMaximized())
)

/** 当前正在跑的安装任务（同时只允许一个） */
let currentInstall = null
/** 正在跑的下载任务控制器（界面点"取消安装"时用它） */
let currentInstallTask = null
/** 取消安装时用户选了什么：'keep' 保留已下的 / 'drop' 这次下的全删掉 */
let installCancelMode = 'keep'

/** 有没有备份正在跑（同时只允许一个） */
let backupRunning = false

/**
 * 把界面报上来的"在哪个游戏目录"归一化成**清单里的那个规范写法**。
 *
 * 【为什么每道口子都要过一遍】界面送来的东西不能全信：大小写可能不一样、
 * 可能多一条尾斜杠、可能带 `..`，也可能是个根本没登记过的路径。
 * 认不出来的一律落回**默认目录**——这是个 fail-closed 的选择：
 * 结果最多是"那个目录里找不到这个版本"（看得见的错），
 * 而不是在某个没登记的地方建文件、写数据。
 *
 * @returns {string} 规范路径；空字符串 = 默认目录（paths 那边就是这么认的）
 */
function known(dir) {
  if (!dir) return ''

  for (const one of settings.knownGameDirs()) {
    if (paths.sameDir(one, dir)) return one
  }

  return ''
}

/** 盯着屏幕光标位置的那个计时器（M14.4，3D 皮肤小人用） */
let cursorWatcher = null

/** 有没有整合包在装（同时只允许一个） */
let packRunning = false

/** 有没有"下载社区资源"在跑（同时只允许一个） */
let contentRunning = false

function registerIpcHandlers() {
  /** 本机已装了哪些版本（跨所有认得的游戏目录，每项带着它在哪儿） */
  ipcMain.handle('versions:installed', () => paths.listAllInstalledVersions(settings.knownGameDirs()))

  /** 装一个版本。进度通过 install:progress 主动推给界面 */
  ipcMain.handle('install:start', async (event, versionId) => {
    if (currentInstall) {
      return { ok: false, error: '已经有一个安装任务在跑了，等它完成或取消它' }
    }

    const send = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
    }

    currentInstall = true
    installCancelMode = 'keep'
    let task = null

    try {
      const result = await install.installVersion(versionId, {
        onStage: (text) => send('install:stage', text),
        onProgress: (stats) => send('install:progress', stats),
        onTask: (t) => {
          task = t
          currentInstallTask = t
        }
      })

      // 取消时选了"全部删掉"：把这次下的清干净（公共文件不伤别的版本，见实现说明）
      if (result.cancelled && installCancelMode === 'drop' && task) {
        const cleanup = install.dropPartialInstall(versionId, {
          removeVersionDir: !result.wasInstalled,
          downloaded: task.getDownloaded()
        })
        return {
          ok: false,
          cancelled: true,
          dropped: true,
          cleanup,
          error:
            `安装已取消，这次下的已经删掉了` +
            `（清掉 ${cleanup.removedFiles} 个文件` +
            (cleanup.removedBytes ? `、约 ${Math.round(cleanup.removedBytes / 1024 / 1024)} MB` : '') +
            `）`
        }
      }

      return result
    } finally {
      currentInstall = null
      currentInstallTask = null
      installCancelMode = 'keep'
    }
  })

  /**
   * 取消正在跑的安装。mode: 'keep'（保留已下好的）/ 'drop'（这次下的全删掉）
   */
  ipcMain.handle('install:cancel', (_event, mode) => {
    if (!currentInstallTask) return { ok: false, error: '安装已经结束了' }
    installCancelMode = mode === 'drop' ? 'drop' : 'keep'
    currentInstallTask.cancel()
    return { ok: true }
  })

  /** 装完了、或者界面重新打开时，取一下已装列表和游戏目录 */
  ipcMain.handle('game:info', () => ({
    gameDir: paths.gameDir(),
    gameDirs: settings.knownGameDirs(),
    installed: paths.listAllInstalledVersions(settings.knownGameDirs())
  }))

  // ——— 版本清单（M2）———

  /**
   * 取版本清单。先给缓存（快、断网也能看），没有缓存才联网。
   * 出错时不是抛异常，而是返回 { ok: false, error }——
   * 界面要的是"能显示一句人话"，不是一个崩掉的 Promise。
   */
  ipcMain.handle('manifest:get', async () => {
    try {
      return { ok: true, ...(await mojang.getManifest()) }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /** 强制从网上更新一份版本清单 */
  ipcMain.handle('manifest:refresh', async () => {
    try {
      return { ok: true, ...(await mojang.refreshManifest()) }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  // ——— 账号与启动（M5）———

  /**
   * 启动页要的全部信息：已装版本、账号、内存、游戏目录、Java 情况。
   * Java 要实际跑一下才知道版本号，所以这里稍微花点时间（约 0.2 秒）。
   */
  ipcMain.handle('launch:info', async () => {
    const dirs = settings.knownGameDirs()
    const list = paths.listAllInstalledVersions(dirs)
    const config = settings.readConfig()

    let javaInfo = { found: false, path: '', version: '', source: '', error: '' }
    if (list.length > 0) {
      try {
        // 用上次启动的版本（或第一个已装版本）去看 Java 在不在
        const last = settings.parseVersionKey(config.launch.lastVersion || '')
        const pick =
          list.find((one) => one.id === last.id && paths.sameDir(one.dir, last.dir)) || list[0]
        const versionJson = JSON.parse(fs.readFileSync(paths.versionJsonFile(pick.id, pick.dir), 'utf8'))
        const candidate = javaUtil.findJava(versionJson, { key: settings.versionKey(pick.dir, pick.id) })
        if (candidate) {
          const probe = javaUtil.probeJava(candidate.path)
          javaInfo = {
            found: probe.ok,
            path: candidate.path,
            version: probe.ok ? probe.version : '',
            source: candidate.source,
            error: probe.ok ? '' : probe.error
          }
        }
      } catch {
        // 读不出来就当没找到，界面会显示提示
      }
    }

    return {
      // 版本列表：跨所有目录，每项带着 id + dir + key
      versions: versions.listAllVersions(dirs),
      versionInfo: versions.versionInfoMap(dirs),
      versionSettings: config.versionSettings || {},
      gameDirs: dirs,
      // 上次拖包装到哪儿了——整合包对话框打开时默认选它
      lastPackDir: config.gameDirs.lastPackDir || '',
      account: accounts.getAccount(),
      // 账号在列表里的标识。界面"退出登录"要拿它删账号——
      // 格式（类型+UUID）只在 accounts.js 里定义一次，界面别自己拼
      accountKey: accounts.accountKey(accounts.getAccount()),
      // 正版登录配了没有（界面要拿它决定"能不能点登录"）
      microsoftClientId: config.microsoft?.clientId || '',
      lastVersion: config.launch.lastVersion || '',
      memoryMB: settings.currentMemoryMB(),
      memoryAuto: !(Number(config.launch.memoryMB) > 0),
      totalMemoryMB: settings.totalMemoryMB(),
      isolation: Boolean(config.launch.isolation),
      gameDir: paths.gameDir(),
      java: javaInfo
    }
  })

  /** 保存离线账号（名字 + 算出来的 UUID） */
  ipcMain.handle('account:set', (_event, name) => accounts.setAccount(name))

  // ——— 外置登录（M16）———
  //
  // 【为什么登录要放在主进程】密码是从界面传进来的，但**只在这一趟里活着**：
  // 主进程拿它去换令牌，换完立刻丢掉，界面上那份也不再留着。
  // 存盘的只有令牌（见 accounts.js）。

  /** 界面打开时要知道默认填哪个服务器 */
  ipcMain.handle('account:yggdrasilDefault', () => yggdrasil.DEFAULT_SERVER)

  ipcMain.handle('account:login', async (_event, input) => {
    const result = await yggdrasil.authenticate(input)
    if (!result.ok) return result

    const saved = accounts.saveAccount(result.account)
    if (!saved.ok) return saved

    return { ok: true, account: saved.account, note: result.note || '' }
  })

  // ——— 正版登录（微软，M13）———

  /**
   * 弹微软登录窗口，走完四道关卡。
   * 【为什么把窗口交给主进程开】密码必须输在**微软自己的页面**上，
   * 毛球一行密码都不碰；界面那边只负责点一下、然后等结果。
   */
  ipcMain.handle('account:loginMicrosoft', async () => {
    const config = settings.readConfig()
    const result = await microsoft.login({
      clientId: config.microsoft?.clientId || '',
      parentWindow: mainWindow
    })
    if (!result.ok) return result

    const saved = accounts.saveAccount(result.account)
    if (!saved.ok) return saved

    return { ok: true, account: saved.account }
  })

  /** 存客户端 ID。顺手检查一下格式——抄错一位的话报错很难看懂 */
  ipcMain.handle('microsoft:setClientId', (_event, value) => {
    const clientId = String(value ?? '').trim()

    if (clientId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      return {
        ok: false,
        error: '这串 ID 的样子不对。它应该是 8-4-4-4-12 的格式，像 12345678-1234-1234-1234-123456789abc'
      }
    }

    try {
      settings.writeConfig({ microsoft: { clientId } })
    } catch (error) {
      return { ok: false, error: `存不下来：${error.message}` }
    }
    return { ok: true, clientId }
  })

  ipcMain.handle('account:list', () => ({
    accounts: accounts.listAccounts(),
    currentKey: accounts.accountKey(accounts.getAccount())
  }))

  ipcMain.handle('account:switch', (_event, key) => accounts.setCurrent(key))

  ipcMain.handle('account:remove', (_event, key) => accounts.remove(key))

  // ——— 账号的皮肤（M16.3）：取回来贴到启动页那个 3D 小人身上 ———
  //
  // 【为什么不让界面自己去下】界面不许碰网络（安全红线），而且下载文件要校验、
  // 要超时、要镜像——这些都归主进程管。
  ipcMain.handle('skin:account', () => skins.fetchFor(accounts.getAccount()))

  /**
   * 启动游戏。
   * 检查不通过会马上返回 { ok:false, error }（中文）；
   * 起来了就返回 { ok:true }，之后日志和退出消息通过 launch:log / launch:state 推给界面。
   */
  ipcMain.handle('launch:start', async (event, versionId, dir) => {
    if (launch.isRunning()) return { ok: false, error: '游戏已经在运行了' }

    const where = known(dir)
    const send = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
    }

    const result = await launch.launch(versionId, {
      dir: where,
      onLog: (lines) => send('launch:log', lines),
      onState: (payload) => send('launch:state', payload)
    })

    // 启动成功就记住这个版本，下次打开软件默认选它；顺便记一下"什么时候玩的"
    if (result.ok) {
      try {
        settings.writeConfig({ launch: { lastVersion: settings.versionKey(where, versionId) } })
      } catch {
        // 记不住不影响玩
      }
      try {
        versions.markPlayed(versionId, where)
      } catch {
        // 记不住不影响玩
      }
    }

    return result
  })

  // ——— 日志（M5 追加：界面上的「日志」按钮）———

  /**
   * 取最近一次启动的日志内容。
   * 日志可能很大，只返回最后 300 KB——看日志是看"最后出什么事了"，
   * 前面的启动过程没什么用。被截断时会告诉界面。
   */
  ipcMain.handle('log:latest', () => {
    try {
      const dir = paths.logsDir()
      if (!fs.existsSync(dir)) {
        return { ok: false, error: '还没有日志。启动过一次游戏之后，这里就有东西看了。' }
      }

      const files = fs.readdirSync(dir).filter((name) => name.endsWith('.log')).sort()
      if (files.length === 0) {
        return { ok: false, error: '还没有日志。启动过一次游戏之后，这里就有东西看了。' }
      }

      const name = files[files.length - 1]
      const file = path.join(dir, name)
      const size = fs.statSync(file).size
      const LIMIT = 300 * 1024

      if (size <= LIMIT) {
        return { ok: true, name, text: fs.readFileSync(file, 'utf8'), truncated: false }
      }

      // 从中间截断会把一个多字节的字劈成两半，所以掐掉开头那半行
      const fd = fs.openSync(file, 'r')
      const buffer = Buffer.alloc(LIMIT)
      fs.readSync(fd, buffer, 0, LIMIT, size - LIMIT)
      fs.closeSync(fd)

      let text = buffer.toString('utf8')
      const firstBreak = text.indexOf('\n')
      if (firstBreak >= 0) text = text.slice(firstBreak + 1)

      return { ok: true, name, text, truncated: true }
    } catch (error) {
      return { ok: false, error: `日志读不出来：${error.message}` }
    }
  })

  /** 在文件资源管理器里打开日志文件夹（日志要发给别人时用） */
  ipcMain.handle('log:openFolder', async () => {
    try {
      paths.ensureDir(paths.logsDir())
      const message = await shell.openPath(paths.logsDir())
      return message ? { ok: false, error: message } : { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  // ——— 版本管理（M6.1，M11.4 起带"哪个游戏目录"）———

  /** 改某个版本的显示名/备注 */
  ipcMain.handle('versions:update', (_event, id, info, dir) =>
    versions.updateVersion(id, info, known(dir))
  )

  /** 在资源管理器里打开某个版本的某一类文件夹（version / saves / mods / screenshots） */
  ipcMain.handle('versions:openFolder', (_event, id, which, dir) =>
    versions.openFolder(id, which, known(dir))
  )

  /** 某个版本文件夹有多大、有没有开隔离（删除确认时给用户看的） */
  ipcMain.handle('versions:size', (_event, id, dir) => {
    const where = known(dir)
    return {
      bytes: versions.versionSize(id, where),
      isolated: versions.isIsolated(id, where)
    }
  })

  /** 删一个版本。游戏在跑的时候不许删——文件正被用着呢 */
  ipcMain.handle('versions:delete', (_event, id, dir) => {
    if (launch.isRunning()) {
      return { ok: false, error: '游戏正在运行，先关掉游戏再删' }
    }
    const result = versions.deleteVersion(id, known(dir))
    // 删完顺手清掉"这些目录设过中文"的记录（M17.x）。
    // 【为什么】用户"删掉版本重新下"之后，目录还是同一个名字，记录却还留着——
    // 新版本会被当成"设过了"，进去是英文（用户 2026-10-08 实测碰到）。
    if (result && result.ok) launch.forgetLanguageForMissingDirs()
    return result
  })

  /**
   * 这个版本"将会使用哪个 Java"。
   *
   * 【为什么要专门给界面看一眼】用户报问题时，第一句通常得说清楚"用的哪个 Java"；
   * 而且换电脑、装新版本之后 Java 可能悄悄换了一个——写出来才看得见。
   * PCL 的版本设置页里也有这么一行（对照清单里的 ⭐⭐⭐ 项）。
   */
  ipcMain.handle('versions:java', (_event, id, dir) => {
    const where = known(dir)
    try {
      const json = JSON.parse(fs.readFileSync(paths.versionJsonFile(id, where), 'utf8'))
      const resolved = inherit.resolveVersion(id, json, where)
      if (resolved.missingParent) {
        return { ok: false, error: `它装在 ${resolved.missingParent} 上面，那个还没装` }
      }

      const candidate = javaUtil.findJava(resolved.json, { key: settings.versionKey(where, id) })
      if (!candidate) return { ok: false, error: '还没找到能用的 Java（启动时会自动补下）' }

      const probe = javaUtil.probeJava(candidate.path)
      const wanted = resolved.json.javaVersion && resolved.json.javaVersion.majorVersion

      return {
        ok: true,
        path: candidate.path,
        source: candidate.source,
        version: probe.ok ? probe.version : '',
        major: probe.ok ? probe.major : 0,
        wanted: wanted || 0,
        mismatch: Boolean(wanted && probe.ok && probe.major !== wanted)
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /** 某个版本的单独设置：它自己设过什么、以及算下来真正生效的值 */
  ipcMain.handle('versions:getSettings', (_event, id, dir) => {
    const where = known(dir)
    return {
      override: versions.getVersionSettings(id, where),
      effective: settings.effectiveLaunchSettings(settings.versionKey(where, id)),
      global: settings.globalLaunchSettings(),
      totalMemoryMB: settings.totalMemoryMB(),
      suggestedMemoryMB: settings.defaultMemoryMB()
    }
  })

  /** 改某个版本的单独设置（传 null = 这一项改回跟随全局） */
  ipcMain.handle('versions:setSettings', (_event, id, patch, dir) =>
    versions.setVersionSettings(id, patch, known(dir))
  )

  // ——— 一键备份（M6.3）———

  /** 每一类大概多大（界面显示"约 XX MB"用） */
  ipcMain.handle('backup:estimate', () => ({
    sizes: backup.estimateSizes(),
    help: backup.CATEGORY_HELP,
    names: backup.CATEGORIES,
    dir: paths.backupsDir()
  }))

  /** 开始备份。进度通过 backup:progress 推给界面 */
  ipcMain.handle('backup:start', async (event, options) => {
    if (backupRunning) return { ok: false, error: '已经有一个备份在跑了，等它完成' }

    backupRunning = true
    try {
      return await backup.createBackup(options, {
        // 每次报进度都让出一下主线程，界面才不会卡死
        onProgress: async (payload) => {
          if (!event.sender.isDestroyed()) event.sender.send('backup:progress', payload)
          await new Promise((resolve) => setImmediate(resolve))
        }
      })
    } finally {
      backupRunning = false
    }
  })

  /** 打开备份文件夹 */
  ipcMain.handle('backup:openFolder', () => backup.openBackupFolder(shell))

  // ——— 启动设置（M6.2）———

  /** 设置页要的东西：当前的启动设置 + 本机的情况（内存、屏幕） */
  ipcMain.handle('settings:get', () => {
    const config = settings.readConfig()
    const display = screen.getPrimaryDisplay().workAreaSize

    return {
      memoryMB: settings.currentMemoryMB(),
      memoryAuto: !(Number(config.launch.memoryMB) > 0),
      totalMemoryMB: settings.totalMemoryMB(),
      suggestedMemoryMB: settings.defaultMemoryMB(),
      windowWidth: Number(config.launch.windowWidth) || 854,
      windowHeight: Number(config.launch.windowHeight) || 480,
      isolation: Boolean(config.launch.isolation),
      // Java 那两样（M20）：自动检测并下载 / 全局用哪个
      autoJava: config.launch.autoJava !== false,
      javaPath: String(config.launch.javaPath || ''),
      downloadSource: settings.downloadSource(),
      screenWidth: display.width,
      screenHeight: display.height,
      // 设置页这张卡说的都是"默认那个游戏目录"的情况：备份、存档数、
      // 新装版本往哪儿装，都以它为准（别的目录是拖包时按需加的，见 docs/01 R6.8）
      gameDir: paths.gameDir(),
      gameDirs: settings.knownGameDirs(),
      sharedWorlds: countSharedWorlds(),
      // 个性化那栏要的东西（M13）
      look: config.look
    }
  })

  /**
   * 改启动设置。只传要改的那几项。
   * 数值合不合理在这里挡一道——界面上的提示可以绕过，这里不能。
   */
  ipcMain.handle('settings:set', (_event, patch) => {
    const current = settings.readConfig().launch
    const launchPatch = {}

    if (patch.memoryMB !== undefined) {
      const value = Number(patch.memoryMB)
      if (value !== 0) {
        const check = settings.validateMemoryMB(value)
        if (!check.ok) return { ok: false, error: check.error }
      }
      launchPatch.memoryMB = value > 0 ? Math.round(value) : 0
    }

    if (patch.windowWidth !== undefined || patch.windowHeight !== undefined) {
      const width = patch.windowWidth !== undefined ? Number(patch.windowWidth) : current.windowWidth
      const height =
        patch.windowHeight !== undefined ? Number(patch.windowHeight) : current.windowHeight
      const check = settings.validateWindow(width, height)
      if (!check.ok) return { ok: false, error: check.error }
      launchPatch.windowWidth = Math.round(width)
      launchPatch.windowHeight = Math.round(height)
    }

    if (patch.isolation !== undefined) {
      launchPatch.isolation = Boolean(patch.isolation)
    }

    // ——— Java（M20）———
    if (patch.autoJava !== undefined) {
      launchPatch.autoJava = Boolean(patch.autoJava)
    }

    if (patch.javaPath !== undefined) {
      // 空字符串 = 自动选择；给路径的话要确认那个文件真的在，
      // 不然用户会得到一个"设置看着好好的、启动就报错"的局面
      const value = String(patch.javaPath || '')
      if (value && !fs.existsSync(value)) {
        return { ok: false, error: `这个文件不在了：${value}` }
      }
      launchPatch.javaPath = value
    }

    // 下载源是顶层配置（不是 launch 里的），单独存
    if (patch.downloadSource !== undefined) {
      const value = String(patch.downloadSource)
      if (!['auto', 'mirror', 'official'].includes(value)) {
        return { ok: false, error: '不认识的下载源' }
      }
      try {
        settings.writeConfig({ download: { source: value } })
      } catch (error) {
        return { ok: false, error: `存不下来：${error.message}` }
      }
    }

    // 下载速度（M13）：并发数 + 限速，都存进 download 里
    if (patch.downloadConcurrency !== undefined || patch.downloadSpeedLimitKB !== undefined) {
      const current = settings.readConfig().download || {}
      const concurrency =
        patch.downloadConcurrency !== undefined
          ? Math.min(32, Math.max(1, Math.round(Number(patch.downloadConcurrency) || 8)))
          : Number(current.concurrency) || 8
      const speedLimitKB =
        patch.downloadSpeedLimitKB !== undefined
          ? Math.max(0, Math.round(Number(patch.downloadSpeedLimitKB) || 0))
          : Number(current.speedLimitKB) || 0

      try {
        settings.writeConfig({ download: { concurrency, speedLimitKB } })
      } catch (error) {
        return { ok: false, error: `存不下来：${error.message}` }
      }
    }

    // 个性化（M13）：藏哪些页面、背景图/音乐、顶栏样式
    if (patch.look !== undefined) {
      const look = patch.look || {}
      const lookPatch = {}

      if (Array.isArray(look.hiddenPages)) {
        // 「启动」和「设置」不许藏——藏了就没地方改回来了
        lookPatch.hiddenPages = look.hiddenPages
          .map((one) => String(one))
          .filter((one) => ['online', 'download', 'help'].includes(one))
      }
      if (typeof look.background === 'string') lookPatch.background = look.background
      if (typeof look.bgm === 'string') lookPatch.bgm = look.bgm
      if (typeof look.skin === 'string') lookPatch.skin = look.skin
      // 用账号上的皮肤，还是用本地那份（M17.5）。
      // 【为什么要有这个开关】以前是"登了账号就自动盖掉你选的"——
      // 用户自己挑了一张，登录之后发现被换掉了，还不知道为什么。
      if (typeof look.useAccountSkin === 'boolean') {
        lookPatch.useAccountSkin = look.useAccountSkin
      }
      // 没登录时随机穿一张（M21）：开关 + "示例皮肤已经存过了"的标记
      if (typeof look.randomSkin === 'boolean') {
        lookPatch.randomSkin = look.randomSkin
      }
      if (typeof look.builtinsSeeded === 'boolean') {
        lookPatch.builtinsSeeded = look.builtinsSeeded
      }
      if (look.bgmVolume !== undefined) {
        lookPatch.bgmVolume = Math.min(100, Math.max(0, Math.round(Number(look.bgmVolume) || 0)))
      }
      // 【原来这里是列举式白名单】只认开头那 5 套——后来加的主题（霓虹紫青等）
      // 一律被挡在门外，界面上切了也存不下来，重启就弹回默认（2026-10-08 发现）。
      // 改成只校验"长得像个主题名"：小写字母加连字符。以后加主题不用再来改这里。
      if (typeof look.theme === 'string' && /^[a-z][a-z0-9-]{1,23}$/.test(look.theme)) {
        lookPatch.theme = look.theme
      }

      try {
        settings.writeConfig({ look: lookPatch })
      } catch (error) {
        return { ok: false, error: `存不下来：${error.message}` }
      }
    }

    try {
      settings.writeConfig({ launch: launchPatch })
    } catch (error) {
      return { ok: false, error: `存不下来：${error.message}` }
    }
    return { ok: true }
  })

  /** 挑背景图 / 背景音乐（弹系统的文件选择框） */
  ipcMain.handle('look:pick', async (_event, kind) => {
    const isImage = kind === 'background'
    const result = await dialog.showOpenDialog({
      title: isImage ? '挑一张背景图' : '挑一首背景音乐',
      properties: ['openFile'],
      filters: isImage
        ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
        : [{ name: '音频', extensions: ['mp3', 'ogg', 'wav', 'm4a', 'flac'] }]
    })

    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return { ok: true, path: result.filePaths[0] }
  })

  // ——— 整合包（M11）———

  /** 看一眼拖进来的压缩包是什么（不装，只认） */
  ipcMain.handle('pack:inspect', (_event, filePath, password) => pack.inspect(filePath, password))

  /**
   * 让用户自己挑一个整合包文件（不方便拖拽的时候用）。
   * @returns {Promise<{ok: boolean, filePath?: string}>} 用户点了取消就是 ok:false
   */
  ipcMain.handle('pack:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '选一个整合包',
      properties: ['openFile'],
      filters: [
        { name: '整合包', extensions: ['zip', 'mrpack'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return { ok: false }
    return { ok: true, filePath: result.filePaths[0] }
  })

  /** 用户给版本起的名字行不行（界面上一边打字一边问，规矩只留在主进程这一份） */
  ipcMain.handle('pack:check-name', (_event, name, dir) =>
    pack.checkVersionName(name, known(dir))
  )

  /**
   * 让用户挑一个"装到哪儿"的游戏目录。
   *
   * 挑完要过三道：① 校验（英文路径、不是盘根、没跟别的目录套娃）
   * ② 归一化成真正的游戏目录（选的是普通文件夹就往下建一层 .minecraft）
   * ③ 记进"认得的目录"里，以后它里面的版本也会出现在启动页列表里。
   */
  ipcMain.handle('pack:pick-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: '挑一个装整合包的地方',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '就装这儿'
    })

    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }

    const chosen = result.filePaths[0]
    const check = settings.validateGameDir(chosen)
    if (!check.ok) return { ok: false, error: check.error }

    const finalDir = settings.resolveChosenDir(chosen)
    // 建一层 .minecraft 之后可能又和已知目录撞上了（比如选的就是别的目录本身），再验一次
    const again = settings.validateGameDir(finalDir)
    if (!again.ok && !settings.knownGameDirs().some((one) => paths.sameDir(one, finalDir))) {
      return { ok: false, error: again.error }
    }

    settings.rememberGameDir(finalDir)
    return {
      ok: true,
      dir: finalDir,
      // 这个目录里还没装过游戏 → 界面要提前说清楚"要重新下一份库文件/资源"
      empty: paths.listInstalledVersions(finalDir).length === 0
    }
  })

  /** 装这个整合包 */
  ipcMain.handle('pack:install', async (event, options) => {
    if (packRunning) return { ok: false, error: '已经有一个整合包在装了，等它完成' }

    packRunning = true
    try {
      const send = (channel, payload) => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
      }

      return await pack.installPack(options.filePath, {
        targetVersionId: options.targetVersionId,
        versionName: options.versionName,
        dir: known(options.dir),
        password: options.password,
        onStage: (text) => send('pack:stage', text),
        onProgress: (stats) => send('pack:progress', stats),
        onTask: (task) => {
          currentInstallTask = task
        }
      })
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    } finally {
      packRunning = false
    }
  })

  // ——— 樱花内网穿透（M15）———

  /** 让用户挑 frpc.exe（要他自己去樱花面板下，我们不代下） */
  ipcMain.handle('frp:pick-exe', async () => {
    const result = await dialog.showOpenDialog({
      title: '找到你下载的 frpc.exe',
      properties: ['openFile'],
      filters: [{ name: 'frpc', extensions: ['exe'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }

    const saved = frp.saveFrpConfig({ exePath: result.filePaths[0] })
    return { ok: true, config: saved }
  })

  /** 起隧道 / 停隧道 / 看状态 */
  ipcMain.handle('frp:start', (_event, options) => {
    try {
      return frp.start(options)
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  ipcMain.handle('frp:stop', () => frp.stop())

  ipcMain.handle('frp:status', () => {
    try {
      return { ok: true, ...frp.status() }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /** 打开樱花穿透官网（用户要去那儿注册、建隧道、复制访问密钥） */
  ipcMain.handle('frp:open-site', async () => {
    await shell.openExternal('https://www.natfrp.com/')
    return { ok: true }
  })

  /**
   * 盯着鼠标在**屏幕**上的位置（M14.4 的 3D 皮肤小人用）。
   *
   * 【为什么要主进程来干】界面里的 pointermove 只有鼠标在本窗口上才触发——
   * 用户要的是鼠标出了窗口也继续跟着转。所以由主进程每隔 60 毫秒问一次系统
   * 光标现在在屏幕哪儿（screen.getCursorScreenPoint），再推给界面。
   * 传 true 开始盯、false 停下（界面不显示那个小人时就该停，别白耗电）。
   */
  ipcMain.handle('cursor:watch', (event, on) => {
    if (cursorWatcher) {
      clearInterval(cursorWatcher)
      cursorWatcher = null
    }
    if (!on) return { ok: true }

    cursorWatcher = setInterval(() => {
      // 【光看 isDestroyed() 不够】窗口正在关的那一瞬间，webContents 还在、
      // 但里面的"渲染帧"已经释放了，这时候 send 会让 Electron 往控制台喷红字。
      // 所以要顺着 mainFrame.detached 一起看，而且读它本身也可能抛。
      let alive = false
      try {
        alive = !event.sender.isDestroyed() && !event.sender.mainFrame.detached
      } catch {
        alive = false
      }
      if (!alive) {
        clearInterval(cursorWatcher)
        cursorWatcher = null
        return
      }
      try {
        event.sender.send('cursor:move', screen.getCursorScreenPoint())
      } catch {
        // 界面没了就算了，下一轮会自己收
      }
    }, 60)

    return { ok: true }
  })

  /** 挑一个皮肤文件（M14.4：3D 预览用）。只返回路径，不复制文件 */
  ipcMain.handle('skin:pick', async () => {
    // 【从皮肤文件夹开始】（用户 2026-10-09 反馈：点"打开皮肤文件"跳到了下载文件夹）
    // 这个按钮叫"打开皮肤文件"，那打开的时候就该站在皮肤文件堆里——
    // 随包发的那几张、用户自己传的，都在这个文件夹。
    // （皮肤页那个「上传皮肤…」不设起始目录，那是"从别处导入"，让 Windows 记住上次的位置更顺手）
    const start = skins.skinsDir()
    try {
      paths.ensureDir(start)
    } catch {
      // 建不出来就让系统自己决定开在哪
    }

    const result = await dialog.showOpenDialog({
      title: '挑一张 Minecraft 皮肤（64×64 的 PNG）',
      defaultPath: fs.existsSync(start) ? start : undefined,
      properties: ['openFile'],
      filters: [{ name: '皮肤', extensions: ['png'] }]
    })

    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return { ok: true, path: result.filePaths[0] }
  })

  // ——— 本地皮肤库（M17.5）———
  //
  // 挑一张皮肤之后**复制一份到 `%APPDATA%\毛球\skins\`**：
  // 用户把原来那张删了、挪走了，毛球这边照样有——也才有"我上传过的"这个列表可列。

  /** 皮肤库里有哪些（最新传的排前面） */
  ipcMain.handle('skin:list', () => {
    try {
      return { ok: true, list: skins.listLocal() }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /** 挑一张皮肤，检查尺寸，收进皮肤库 */
  ipcMain.handle('skin:import', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: '挑一张 Minecraft 皮肤（64×64 的 PNG）',
      properties: ['openFile'],
      filters: [{ name: '皮肤', extensions: ['png'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }

    return skins.importFile(result.filePaths[0])
  })

  /** 从皮肤库里删一份（**只动我们自己复制进来的那份**，见 skins.removeLocal） */
  ipcMain.handle('skin:remove', (_event, target) => {
    try {
      return skins.removeLocal(target)
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /**
   * 官方的默认皮肤（Steve）。
   * 【从哪来】从**玩家自己的游戏文件**里读（客户端 jar 里就有），
   * 不是把 Mojang 的图打进我们的安装包——见 skins.js 上面的说明。
   */
  ipcMain.handle('skin:official', (_event, kind) => {
    try {
      return skins.officialDefault('', kind === 'alex' ? 'alex' : 'steve')
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /** 把随软件打包的那几张皮肤复制进皮肤库（M21，已经有的不覆盖） */
  ipcMain.handle('skin:seedBundled', () => {
    try {
      return skins.seedBundled()
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /** 把界面画好的示例皮肤存进皮肤库（M21，同名不覆盖） */
  ipcMain.handle('skin:saveBuiltin', (_event, name, dataUrl) => {
    try {
      return skins.saveBuiltin(name, dataUrl)
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /**
   * 打开皮肤站（用户可以去那儿找喜欢的皮肤，下下来再用「上传皮肤…」装进来）。
   * 【地址写死在主进程】界面只能"请求打开皮肤站"，不能自己指定网址——
   * 它要是被塞了个乱七八糟的地址进来，用户点一下就在浏览器里打开了。
   */
  ipcMain.handle('skin:openSite', async () => {
    try {
      await shell.openExternal('https://littleskin.cn/skinlib')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /** 在文件管理器里打开皮肤库（用户想自己往里丢图也行） */
  ipcMain.handle('skin:openFolder', async () => {
    try {
      const dir = skins.skinsDir()
      paths.ensureDir(dir)
      const failed = await shell.openPath(dir)
      return failed ? { ok: false, error: failed } : { ok: true, dir }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /** 帮助页那三个"一键打开"：游戏目录 / 配置目录（日志那个早就有了） */
  ipcMain.handle('app:openFolder', async (_event, which) => {
    try {
      const target =
        which === 'config' ? paths.configDir() : which === 'game' ? paths.gameDir() : ''
      if (!target) return { ok: false, error: '不认识的文件夹' }

      paths.ensureDir(target)
      const message = await shell.openPath(target)
      return message ? { ok: false, error: message } : { ok: true, dir: target }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  // ——— Java 运行时管理（M20）———
  //
  // 【为什么要有这一块】以前 Java 是"用户看不见的黑盒"：哪来的、能不能用、
  // 怎么换一个，界面上一个字都不说。碰到"Java 版本不对"只能靠启动时自动补下。
  // 现在把本机的 Java 全列出来，让用户看得见、能自己挑、也能添自己装的。

  /** 本机能用哪些 Java（设置页那个列表用） */
  ipcMain.handle('java:list', async () => {
    try {
      return { ok: true, list: await javaUtil.listJavas() }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /**
   * 让用户挑一个 java.exe，并且**真的跑一下**确认能用。
   * 只是探测，不保存——保存是下面 java:add 的事。
   */
  ipcMain.handle('java:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: '挑一个 java.exe',
      properties: ['openFile'],
      filters: [
        { name: 'Java 程序', extensions: ['exe'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }

    const picked = result.filePaths[0]
    // 挑错了（比如挑成 javac.exe、或者挑成压缩包）当场说清楚，
    // 别等用户"保存成功"了、启动时才发现用不了
    if (path.basename(picked).toLowerCase() !== 'java.exe') {
      return { ok: false, error: '这个不是 java.exe。去 Java 安装目录里的 bin 文件夹挑' }
    }

    const probe = await javaUtil.probeJavaAsync(picked)
    if (!probe.ok) return { ok: false, error: `这个 java.exe 跑不起来：${probe.error}` }
    return { ok: true, path: picked, version: probe.version, major: probe.major }
  })

  /** 把挑好的 Java 记进名单（**只是记个路径，不复制、不移动文件**） */
  ipcMain.handle('java:add', (_event, exePath) => {
    try {
      const value = String(exePath || '')
      if (!value || !fs.existsSync(value)) return { ok: false, error: '这个文件不在了' }
      return { ok: true, list: settings.addExtraJava(value) }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /** 从名单里划掉（**不动硬盘上的文件**） */
  ipcMain.handle('java:remove', (_event, exePath) => {
    try {
      const list = settings.removeExtraJava(String(exePath || ''))
      const config = settings.readConfig()
      // 划掉的正好是"当前用的那个"的话，把选择清回"自动"——
      // 不然设置里指着一个已经不在名单里的 Java，看着莫名其妙
      if (settings.sameJavaPath(config.launch.javaPath, exePath)) {
        settings.writeConfig({ launch: { javaPath: '' } })
      }
      return { ok: true, list }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  // ——— 清理游戏垃圾（M13）———

  /** 扫一遍能清多少（不动任何文件） */
  ipcMain.handle('cleanup:scan', () => {
    try {
      return { ok: true, ...cleanup.scan() }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /** 真删（界面上必须已经二次确认过） */
  ipcMain.handle('cleanup:run', (_event, keys) => {
    try {
      return { ok: true, ...cleanup.clean(keys) }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  // ——— 联机（M12）———

  /** 现在联机是什么情况（还没进房间就返回 running:false） */
  ipcMain.handle('online:status', () => {
    try {
      const config = settings.readConfig().online
      return {
        ok: true,
        ...online.status(),
        // 启动时清理残留的那句提示（读一次就清掉，免得反复弹）
        startupNote: online.takeStartupNote(),
        code: config.code || '',
        role: config.role || ''
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), running: false, peers: [] }
    }
  })

  /**
   * 建房间 / 进房间。这一步会弹一次系统权限确认（要建虚拟网卡），
   * 进度通过 online:stage 推给界面。
   */
  ipcMain.handle('online:start', async (event, options) => {
    const send = (text) => {
      if (!event.sender.isDestroyed()) event.sender.send('online:stage', text)
    }

    const role = options && options.role === 'guest' ? 'guest' : 'host'
    let code = String((options && options.code) || '')

    if (role === 'host') {
      code = online.newRoomCode()
    } else {
      const checked = online.normalizeCode(code)
      if (!checked.ok) return { ok: false, error: checked.error }
      code = checked.code
    }

    try {
      const result = await online.startRoom({ role, code, onStage: send })
      return { ...result, role, code }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /** 离开房间（虚拟网卡也会一起收掉） */
  ipcMain.handle('online:leave', () => {
    try {
      return online.leave()
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  // ——— 社区资源（M9，来自 Modrinth）———

  /** 搜索 Mod / 资源包 / 光影包 */
  ipcMain.handle('modrinth:search', async (_event, options) => {
    try {
      const result = await modrinth.search({
        type: options.type,
        query: options.query || '',
        gameVersion: resolveGameVersion(options.gameVersion || ''),
        loader: loaderSlugFor(options.gameVersion || ''),
        limit: options.limit || 20
      })
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  /**
   * 给某个版本装 Mod 加载器（M10，先支持 Fabric）。
   * 装完会多出一个新版本（比如 fabric-loader-0.16.5-26.3），原来的版本不动。
   * 进度复用 install:stage / install:progress 两条通道。
   */
  ipcMain.handle('loader:install', async (event, options) => {
    if (currentInstall) return { ok: false, error: '已经有一个安装任务在跑了，等它完成' }

    const send = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
    }

    currentInstall = true
    try {
      const { gameVersion, loader } = options
      const wanted = loader || 'fabric'
      if (!['fabric', 'forge', 'neoforge'].includes(wanted)) {
        return { ok: false, error: `不认识的加载器：${wanted}` }
      }
      const where = known(options.dir)
      if (!paths.isVersionInstalled(gameVersion, where)) {
        return { ok: false, error: `先把 ${gameVersion} 装好，才能在它上面装加载器` }
      }

      // Fabric 官方给现成的版本文件；Forge / NeoForge 得自己拆安装器
      const built =
        wanted === 'fabric'
          ? await loaders.buildFabricProfile(gameVersion)
          : await forge.prepare(wanted, gameVersion, {
              dir: where,
              onStage: (text) => send('install:stage', text),
              onProgress: (stats) => send('install:progress', stats),
              onTask: (task) => {
                currentInstallTask = task
              }
            })

      if (paths.isVersionInstalled(built.versionId, where)) {
        return { ok: true, already: true, versionId: built.versionId }
      }

      const loaderLabel = wanted === 'fabric' ? 'Fabric' : wanted === 'forge' ? 'Forge' : 'NeoForge'
      send('install:stage', `正在装 ${loaderLabel} ${built.loaderVersion}…`)
      const result = await install.installVersion(built.versionId, {
        providedJson: built.json,
        dir: where,
        onStage: (text) => send('install:stage', text),
        onProgress: (stats) => send('install:progress', stats),
        onTask: (task) => {
          currentInstallTask = task
        }
      })

      if (!result.ok) return result

      // Forge / NeoForge 还要多一步：给客户端 jar 打补丁
      // （放在库都下好之后跑——打补丁的工具自己也要用库）
      if (built.patcher) {
        try {
          await forge.runPatchers(built.patcher, {
            onStage: (text) => send('install:stage', text),
            onProgress: (stats) => send('install:progress', stats),
            onTask: (task) => {
              currentInstallTask = task
            }
          })
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        }
      }

      return { ok: true, versionId: built.versionId, loaderVersion: built.loaderVersion }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    } finally {
      currentInstall = null
      currentInstallTask = null
    }
  })

  /**
   * 下载一个项目，放到该放的地方。
   * 自动挑一个合适的文件：优先正式版、优先支持这个游戏版本的。
   */
  /**
   * 这个版本能看见的存档（装数据包时要挑一个）。
   * 【为什么让主进程列】存档目录在游戏目录里，界面那边碰不到文件系统。
   */
  ipcMain.handle('saves:list', (_event, versionId, dir) => {
    try {
      return { ok: true, saves: content.listSaves(versionId || '', known(dir)) }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  /**
   * 打开"刚下好的东西"所在的那个文件夹（「下载」页那个按钮）。
   * 【为什么不复用 versions:openFolder】数据包藏在某个世界的里面，
   * 而且那个世界可能在公共 saves 里、也可能在版本自己的 saves 里——
   * 这里直接拿**当初算出来的那条路径**（同一段代码），保证跟装进去的位置一致。
   */
  ipcMain.handle('content:openFolder', async (_event, options) => {
    try {
      const { versionId, type, saveName, saveFolder } = options || {}
      const dir = content.targetDir(versionId || '', type, known(options?.dir), saveName, saveFolder)
      if (!dir) return { ok: false, error: '不知道这个文件夹在哪儿' }
      paths.ensureDir(dir)
      const failed = await shell.openPath(dir)
      return failed ? { ok: false, error: failed } : { ok: true, dir }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  })

  ipcMain.handle('modrinth:install', async (event, options) => {
    if (contentRunning) return { ok: false, error: '已经有一个下载在跑了，等它完成' }

    contentRunning = true
    try {
      const { projectId, type, versionId } = options
      const where = known(options.dir)

      // 筛选用"游戏版本"（装了 Fabric 的版本要顺着继承找到 26.3），
      // 但**放文件还是放进选中的那个版本**（Mod 就要放进 Fabric 版本的 mods 里），
      // 而且是**它那个游戏目录**里的那个版本
      //
      // 【只有 Mod 能按加载器筛】资源包在 Modrinth 那边挂的 loaders 是 `minecraft`、
      // 光影包是 `iris`/`optifine`、数据包是 `datapack`——**都不是** fabric/forge。
      // 拿 "fabric" 去筛它们会一个文件都匹配不到，界面上看着就是"这个项目没有文件"
      // （以前只测过纯原版版本，那会儿 loader 是空的，所以没露出来）。
      // 整合包也是：它自带加载器（fabric/forge 由包决定），不能拿当前版本的加载器去筛。
      //
      // 游戏版本按**界面上那个筛选**来（"只搜当前版本" / "所有版本"）——
      // 界面上写着"所有版本"却挑了个只给 26.3 的构建，用户看到的就是
      // "我明明选的所有版本，怎么给我装了个老版本"。界面没传就按选中的版本算。
      const gameVersion =
        options.gameVersion !== undefined
          ? resolveGameVersion(options.gameVersion || '')
          : resolveGameVersion(versionId || '', where)
      const list = await modrinth.getVersions(projectId, {
        gameVersion,
        loader: type === 'mod' ? loaderSlugFor(versionId || '', where) : ''
      })
      const best = modrinth.pickBest(list, type)

      if (!best) {
        return {
          ok: false,
          error: versionId
            ? `这个项目没有支持 ${versionId} 的文件——把筛选换成「所有版本」再看看`
            : '这个项目没有可下载的文件'
        }
      }

      // ——— 整合包：走"整套安装"，不是"放进某个文件夹" ———
      // 整合包是一整套东西（游戏版本 + 配置 + 一堆 Mod），所以交给 M11.1 那条
      // "本地包"安装流程去办：先下到一个临时文件，再让 pack.installPack 解压安装。
      // 装完把临时文件删掉——它可能几百 MB，留着白占地方。
      if (type === 'modpack') {
        // 整合包会连带装一整个游戏版本，可能跑好几分钟。
        // 跟"拖进来的整合包"共用一把锁——两边同时装会互相踩（都在写 versions\ 和库文件）
        if (packRunning) return { ok: false, error: '已经有一个整合包在装了，等它完成' }
        packRunning = true

        const temp = path.join(os.tmpdir(), `maoqiu-modpack-${Date.now()}.mrpack`)
        const send = (channel, payload) => {
          if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
        }
        try {
          // 用和别的内容同一套下载器：它自带"换源、重试、校验哈希、下完才改名"，
          // 而且进度字段跟界面那边对得上（自己手搓一个的话，进度条和失败处理都得重写一遍）
          const task = downloader.createTask(
            [
              {
                name: best.file.filename || 'pack.mrpack',
                url: best.file.url,
                saveTo: temp,
                sha1: best.file.sha1 || '',
                size: Number(best.file.size) || 0
              }
            ],
            { onProgress: (stats) => send('content:progress', stats) }
          )
          const stats = await task.start()
          if (stats.failed > 0) {
            const first = stats.failures && stats.failures[0]
            return { ok: false, error: first ? first.error : '整合包下载失败' }
          }

          const installed = await pack.installPack(temp, {
            dir: where,
            onStage: (text) => send('pack:stage', text),
            onProgress: (stats) => send('pack:progress', stats),
            onTask: (task) => {
              currentInstallTask = task
            }
          })
          return { ...installed, versionName: best.name, dir: where, filename: best.file.filename || '' }
        } finally {
          packRunning = false
          try {
            fs.rmSync(temp, { force: true })
          } catch {
            // 删不掉就算了（临时目录系统自己会清）
          }
        }
      }

      const result = await content.installFile({
        versionId,
        type,
        dir: where,
        // saveName / saveFolder 只有数据包用得上（要指定装进哪个存档）
        saveName: options.saveName,
        saveFolder: options.saveFolder,
        file: best.file,
        onProgress: (stats) => {
          if (!event.sender.isDestroyed()) event.sender.send('content:progress', stats)
        }
      })

      if (!result.ok) return result

      return {
        ok: true,
        path: result.path,
        dir: result.dir,
        skipped: result.skipped,
        versionName: best.name,
        filename: path.basename(result.path)
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    } finally {
      contentRunning = false
    }
  })
}

/** 我们认的加载器名 → Modrinth 用的代号 */
const LOADER_SLUGS = { Fabric: 'fabric', Forge: 'forge', NeoForge: 'neoforge' }

/** 这个版本用的是哪种加载器（Modrinth 的写法）；没有就返回空 */
function loaderSlugFor(versionId, dir) {
  if (!versionId) return ''
  return LOADER_SLUGS[versions.loaderName(versionId, dir)] || ''
}

/**
 * 把一个版本号还原成"游戏版本号"。
 *
 * 【为什么需要】装了 Mod 加载器的版本（fabric-loader-0.19.5-26.3）在社区网站上
 * 是查不到的——网站只认"26.3"这个游戏版本。所以搜资源之前要先顺着
 * inheritsFrom 往上找，找到最底下那个原版版本号。
 */
function resolveGameVersion(versionId, dir) {
  let current = String(versionId || '')

  for (let depth = 0; depth < 5 && current; depth++) {
    try {
      const json = JSON.parse(fs.readFileSync(paths.versionJsonFile(current, dir), 'utf8'))
      if (!json.inheritsFrom) return current
      current = String(json.inheritsFrom)
    } catch {
      return current
    }
  }
  return current
}

/**
 * 共享存档目录里有几个世界（开版本隔离时提示用）。
 * 看的是**默认目录**的 saves——设置页那张卡说的就是默认目录的情况。
 */
function countSharedWorlds() {
  try {
    return fs
      .readdirSync(paths.savesDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length
  } catch {
    return 0
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()

  // 收拾"上一个毛球留下的联机进程"（M17.x）。
  // 毛球被强杀（装安装包、任务管理器结束进程）时 EasyTier 会残留，
  // 新开的毛球一问"有进程在跑"就说"你在房间里"——可房间码早清空了，
  // 界面上显示成"你在好友的房间里"配一个空的房间码（用户实测撞到过）。
  // 这里只收"没有房间记录"的那种，正常开着的房间不动。
  try {
    if (online.cleanupStray()) {
      console.log('[启动器] 收掉了一个上次没退干净的联机进程')
    }
  } catch (error) {
    console.warn('[启动器] 清理残留联机进程时出错：', error.message)
  }

  // 房间还在、但**游戏早就退了** → 这是个空房间，收掉（M17.x）。
  // 【为什么能这么判断】规矩是"必须先开局域网才让建房"，所以建房那一刻游戏一定在跑；
  // 反过来"游戏没在跑、却还留着房间"就只能是上次没收干净的。
  // 用户实测碰到过：一打开毛球就显示"你是房主"，房间码还是上次那个。
  try {
    const onlineCfg = settings.readConfig().online
    if (onlineCfg.code && online.isRunning() && !launch.isRunning()) {
      online.leave()
      online.noteStrayRoom()
      console.log('[启动器] 收掉了一个游戏已经退出的空房间')
    }
  } catch (error) {
    console.warn('[启动器] 收空房间时出错：', error.message)
  }

  // 顺手清掉"设过中文"记录里那些**目录已经不在了**的（M17.x）。
  // 用户手动删过 versions 目录时也能清到——不然新下的同名版本会被当成"设过了"，进游戏是英文。
  try {
    launch.forgetLanguageForMissingDirs()
  } catch {
    // 清不掉不影响用，下次启动还会再试
  }

  createSplash() // 开场动画（M17.4）——先盖着，主窗口画好了再收
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

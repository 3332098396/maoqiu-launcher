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
const path = require('node:path')
const mojang = require('./mojang')
const install = require('./install')
const paths = require('./paths')
const settings = require('./settings')
const accounts = require('./accounts')
const javaUtil = require('./java')
const launch = require('./launch')
const versions = require('./versions')
const inherit = require('./inherit')
const cleanup = require('./cleanup')
const backup = require('./backup')
const modrinth = require('./modrinth')
const content = require('./content')
const pack = require('./pack')
const online = require('./online')
const loaders = require('./loaders')
const forge = require('./forge')

// 软件名。它会决定数据存放目录：%APPDATA%\毛球\
app.setName('毛球')

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 660,
    minWidth: 860,
    minHeight: 560,
    title: '毛球',
    icon: path.join(__dirname, '..', '..', 'assets', 'app-256.png'),
    backgroundColor: '#F2F8FF',
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

  mainWindow.once('ready-to-show', () => mainWindow.show())

  return mainWindow
}

// ——————————————————————————————————————————————
// 界面能调用的接口（与 preload 里列出的方法一一对应）
// ——————————————————————————————————————————————

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
        const candidate = javaUtil.findJava(versionJson)
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

    // 启动成功就记住这个版本，下次打开软件默认选它
    if (result.ok) {
      try {
        settings.writeConfig({ launch: { lastVersion: settings.versionKey(where, versionId) } })
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
    return versions.deleteVersion(id, known(dir))
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

      const candidate = javaUtil.findJava(resolved.json)
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
      if (look.bgmVolume !== undefined) {
        lookPatch.bgmVolume = Math.min(100, Math.max(0, Math.round(Number(look.bgmVolume) || 0)))
      }
      if (typeof look.theme === 'string' && ['blue', 'dark', 'matcha', 'sunset', 'sakura'].includes(look.theme)) {
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
  ipcMain.handle('modrinth:install', async (event, options) => {
    if (contentRunning) return { ok: false, error: '已经有一个下载在跑了，等它完成' }

    contentRunning = true
    try {
      const { projectId, type, versionId } = options
      const where = known(options.dir)

      // 筛选用"游戏版本"（装了 Fabric 的版本要顺着继承找到 26.3），
      // 但**放文件还是放进选中的那个版本**（Mod 就要放进 Fabric 版本的 mods 里），
      // 而且是**它那个游戏目录**里的那个版本
      const list = await modrinth.getVersions(projectId, {
        gameVersion: resolveGameVersion(versionId || '', where),
        loader: loaderSlugFor(versionId || '', where)
      })
      const best = modrinth.pickBest(list)

      if (!best) {
        return {
          ok: false,
          error: versionId
            ? `这个项目没有支持 ${versionId} 的文件——把筛选换成「所有版本」再看看`
            : '这个项目没有可下载的文件'
        }
      }

      const result = await content.installFile({
        versionId,
        type,
        dir: where,
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
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

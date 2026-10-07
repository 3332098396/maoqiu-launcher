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

const { app, BrowserWindow, ipcMain, shell, screen } = require('electron')
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
const backup = require('./backup')
const modrinth = require('./modrinth')
const content = require('./content')
const loaders = require('./loaders')

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

/** 有没有"下载社区资源"在跑（同时只允许一个） */
let contentRunning = false

function registerIpcHandlers() {
  /** 本机已装了哪些版本 */
  ipcMain.handle('versions:installed', () => paths.listInstalledVersions())

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
    installed: paths.listInstalledVersions()
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
    const installed = paths.listInstalledVersions()
    const config = settings.readConfig()

    let javaInfo = { found: false, path: '', version: '', source: '', error: '' }
    if (installed.length > 0) {
      try {
        // 用上次启动的版本（或第一个已装版本）去看 Java 在不在
        const pick =
          config.launch.lastVersion && installed.includes(config.launch.lastVersion)
            ? config.launch.lastVersion
            : installed[0]
        const versionJson = JSON.parse(fs.readFileSync(paths.versionJsonFile(pick), 'utf8'))
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
      installed,
      versionInfo: versions.versionInfoMap(),
      versionSettings: config.versionSettings || {},
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
  ipcMain.handle('launch:start', async (event, versionId) => {
    if (launch.isRunning()) return { ok: false, error: '游戏已经在运行了' }

    const send = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
    }

    const result = await launch.launch(versionId, {
      onLog: (lines) => send('launch:log', lines),
      onState: (payload) => send('launch:state', payload)
    })

    // 启动成功就记住这个版本，下次打开软件默认选它
    if (result.ok) {
      try {
        settings.writeConfig({ launch: { lastVersion: versionId } })
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

  // ——— 版本管理（M6.1）———

  /** 改某个版本的显示名/备注 */
  ipcMain.handle('versions:update', (_event, id, info) => versions.updateVersion(id, info))

  /** 在资源管理器里打开某个版本的某一类文件夹（version / saves / mods / screenshots） */
  ipcMain.handle('versions:openFolder', (_event, id, which) => versions.openFolder(id, which))

  /** 某个版本文件夹有多大、有没有开隔离（删除确认时给用户看的） */
  ipcMain.handle('versions:size', (_event, id) => ({
    bytes: versions.versionSize(id),
    isolated: versions.isIsolated()
  }))

  /** 删一个版本。游戏在跑的时候不许删——文件正被用着呢 */
  ipcMain.handle('versions:delete', (_event, id) => {
    if (launch.isRunning()) {
      return { ok: false, error: '游戏正在运行，先关掉游戏再删' }
    }
    return versions.deleteVersion(id)
  })

  /** 某个版本的单独设置：它自己设过什么、以及算下来真正生效的值 */
  ipcMain.handle('versions:getSettings', (_event, id) => ({
    override: versions.getVersionSettings(id),
    effective: settings.effectiveLaunchSettings(id),
    global: settings.globalLaunchSettings(),
    totalMemoryMB: settings.totalMemoryMB(),
    suggestedMemoryMB: settings.defaultMemoryMB()
  }))

  /** 改某个版本的单独设置（传 null = 这一项改回跟随全局） */
  ipcMain.handle('versions:setSettings', (_event, id, patch) =>
    versions.setVersionSettings(id, patch)
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
      gameDir: paths.gameDir(),
      sharedWorlds: countSharedWorlds()
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

    try {
      settings.writeConfig({ launch: launchPatch })
    } catch (error) {
      return { ok: false, error: `存不下来：${error.message}` }
    }
    return { ok: true }
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
      if (loader && loader !== 'fabric') {
        return { ok: false, error: '现在只支持装 Fabric，Forge / NeoForge 后面再做' }
      }
      if (!paths.isVersionInstalled(gameVersion)) {
        return { ok: false, error: `先把 ${gameVersion} 装好，才能在它上面装加载器` }
      }

      send('install:stage', '正在问 Fabric 有哪些加载器版本…')
      const built = await loaders.buildFabricProfile(gameVersion)

      if (paths.isVersionInstalled(built.versionId)) {
        return { ok: true, already: true, versionId: built.versionId }
      }

      send('install:stage', `正在装 Fabric ${built.loaderVersion}…`)
      const result = await install.installVersion(built.versionId, {
        providedJson: built.json,
        onStage: (text) => send('install:stage', text),
        onProgress: (stats) => send('install:progress', stats),
        onTask: (task) => {
          currentInstallTask = task
        }
      })

      if (!result.ok) return result
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

      // 筛选用"游戏版本"（装了 Fabric 的版本要顺着继承找到 26.3），
      // 但**放文件还是放进选中的那个版本**（Mod 就要放进 Fabric 版本的 mods 里）
      const list = await modrinth.getVersions(projectId, {
        gameVersion: resolveGameVersion(versionId || ''),
        loader: loaderSlugFor(versionId || '')
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
function loaderSlugFor(versionId) {
  if (!versionId) return ''
  return LOADER_SLUGS[versions.loaderName(versionId)] || ''
}

/**
 * 把一个版本号还原成"游戏版本号"。
 *
 * 【为什么需要】装了 Mod 加载器的版本（fabric-loader-0.19.5-26.3）在社区网站上
 * 是查不到的——网站只认"26.3"这个游戏版本。所以搜资源之前要先顺着
 * inheritsFrom 往上找，找到最底下那个原版版本号。
 */
function resolveGameVersion(versionId) {
  let current = String(versionId || '')

  for (let depth = 0; depth < 5 && current; depth++) {
    try {
      const json = JSON.parse(fs.readFileSync(paths.versionJsonFile(current), 'utf8'))
      if (!json.inheritsFrom) return current
      current = String(json.inheritsFrom)
    } catch {
      return current
    }
  }
  return current
}

/** 共享存档目录里有几个世界（开版本隔离时提示用） */
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

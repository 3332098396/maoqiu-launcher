// MC启动器 — 主进程入口
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

// 软件名。它会决定数据存放目录：%APPDATA%\MC启动器\
app.setName('MC启动器')

/** 主窗口 */
let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 660,
    minWidth: 860,
    minHeight: 560,
    title: 'MC启动器',
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
    try {
      const result = await install.installVersion(versionId, {
        onStage: (text) => send('install:stage', text),
        onProgress: (stats) => send('install:progress', stats)
      })
      return result
    } finally {
      currentInstall = null
    }
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
      account: accounts.getAccount(),
      lastVersion: config.launch.lastVersion || '',
      memoryMB: settings.currentMemoryMB(),
      memoryAuto: !(Number(config.launch.memoryMB) > 0),
      totalMemoryMB: settings.totalMemoryMB(),
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

    try {
      settings.writeConfig({ launch: launchPatch })
    } catch (error) {
      return { ok: false, error: `存不下来：${error.message}` }
    }
    return { ok: true }
  })
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

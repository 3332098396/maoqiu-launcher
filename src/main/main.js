// MC启动器 — 主进程入口
//
// 主进程负责所有"重活"：窗口、下载、装游戏、启动游戏、读写配置。
// 界面（renderer）只负责显示和上报点击，不直接碰系统能力，
// 两者通过 preload 里的安全桥通信。
//
// 当前进度：M0（骨架）。本文件目前只做一件事——把窗口开出来。
//
// 后续里程碑会往这里加：
//   M2 版本清单    → src/main/mojang.js
//   M3 下载引擎    → src/main/downloader.js
//   M4 安装版本    → src/main/install.js + java.js
//   M5 启动游戏    → src/main/launch.js + accounts.js
//   M6 版本管理    → src/main/paths.js + settings.js

const { app, BrowserWindow } = require('electron')
const path = require('node:path')

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

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

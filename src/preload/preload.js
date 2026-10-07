// MC启动器 — 安全桥（preload）
//
// 界面（网页）默认无权访问系统。这里用 contextBridge 把主进程的能力
// "挑着"暴露给界面，界面只能调用这里列出来的方法，不能乱来。
//
// 【加新功能的规矩】
// 界面每需要一个新能力，就在这里加一条，并在主进程里写对应的 ipcMain.handle。
// 绝不能让界面直接去碰 require / fs / child_process。
//
// 当前进度：M0（骨架）。还没到需要暴露功能的阶段，先留一个占位。

const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('api', {
  /** 界面可以读取自己的版本号，用来显示在页脚 */
  appVersion: '0.1.0'
})

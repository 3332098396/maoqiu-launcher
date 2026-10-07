// MC启动器 — 安全桥（preload）
//
// 界面（网页）默认无权访问系统。这里用 contextBridge 把主进程的能力
// "挑着"暴露给界面，界面只能调用这里列出来的方法，不能乱来。
//
// 【加新功能的规矩】
// 界面每需要一个新能力，就在这里加一条，并在主进程里写对应的 ipcMain.handle。
// 绝不能让界面直接去碰 require / fs / https。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  /** 界面可以读取自己的版本号，用来显示在页脚 */
  appVersion: '0.1.0',

  // ——— 版本清单（M2）———

  /**
   * 取版本清单。先给本地缓存（快，断网也能看），没有缓存才联网。
   * @returns {Promise<{ok: boolean, versions?, latest?, fromCache?, updatedAt?, error?}>}
   */
  getManifest: () => ipcRenderer.invoke('manifest:get'),

  /**
   * 强制从网上更新一份版本清单，成功后写进缓存。
   * @returns {Promise<{ok: boolean, versions?, latest?, error?}>}
   */
  refreshManifest: () => ipcRenderer.invoke('manifest:refresh')
})

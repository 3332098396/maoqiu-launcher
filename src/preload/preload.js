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
  refreshManifest: () => ipcRenderer.invoke('manifest:refresh'),

  // ——— 安装版本（M4）———

  /** 取游戏目录和本机已装版本列表：{ gameDir, installed: string[] } */
  getGameInfo: () => ipcRenderer.invoke('game:info'),

  /**
   * 装一个版本，装完才 resolve。
   * 过程中会通过 onInstallStage / onInstallProgress 主动推消息给界面。
   * @returns {Promise<{ok: boolean, stats?, error?}>}
   */
  startInstall: (versionId) => ipcRenderer.invoke('install:start', versionId),

  /**
   * 取消正在跑的安装。
   * @param {'keep'|'drop'} mode 'keep' = 已经下好的留着（下次接着下）；
   *                              'drop' = 这次下的全部删掉（公共文件里别的版本在用的会保留）
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  cancelInstall: (mode) => ipcRenderer.invoke('install:cancel', mode),

  /** 安装到哪一步了（"正在读取版本信息…"这类文字） */
  onInstallStage: (callback) => {
    ipcRenderer.on('install:stage', (_event, text) => callback(text))
  },

  /** 下载进度（百分比、速度、剩余时间、失败数） */
  onInstallProgress: (callback) => {
    ipcRenderer.on('install:progress', (_event, stats) => callback(stats))
  },

  // ——— 账号与启动（M5）———

  /**
   * 启动页要的全部信息。
   * @returns {Promise<{installed: string[], account: object|null, lastVersion: string,
   *                    memoryMB: number, memoryAuto: boolean, totalMemoryMB: number,
   *                    gameDir: string, java: object}>}
   */
  getLaunchInfo: () => ipcRenderer.invoke('launch:info'),

  /**
   * 保存离线账号（名字 + 算出来的 UUID）。
   * @returns {Promise<{ok: boolean, account?: object, error?: string}>}
   */
  setAccount: (name) => ipcRenderer.invoke('account:set', name),

  /**
   * 启动游戏。检查不通过马上返回 { ok:false, error }；
   * 起来了返回 { ok:true, java, memoryMB }，之后靠下面两个事件推消息。
   * @returns {Promise<{ok: boolean, error?: string, java?: object, memoryMB?: number}>}
   */
  startLaunch: (versionId) => ipcRenderer.invoke('launch:start', versionId),

  /** 游戏输出的日志（一批几行地推过来） */
  onLaunchLog: (callback) => {
    ipcRenderer.on('launch:log', (_event, lines) => callback(lines))
  },

  /**
   * 启动状态变化。state 有三种：
   *   'running' 游戏进程起来了
   *   'exited'  游戏退出了，带 ok / title / hint（中文说明）
   *   'error'   进程压根没起来
   */
  onLaunchState: (callback) => {
    ipcRenderer.on('launch:state', (_event, payload) => callback(payload))
  },

  // ——— 日志（M5 追加：「日志」按钮）———

  /**
   * 最近一次启动的日志内容（只给最后一段，太长会截断）。
   * @returns {Promise<{ok: boolean, name?: string, text?: string, truncated?: boolean, error?: string}>}
   */
  getLatestLog: () => ipcRenderer.invoke('log:latest'),

  /** 在文件资源管理器里打开日志文件夹 */
  openLogFolder: () => ipcRenderer.invoke('log:openFolder'),

  // ——— 版本管理（M6.1）———

  /**
   * 改某个版本的显示名/备注。两个都留空 = 恢复成默认（显示版本号）。
   * @returns {Promise<{ok: boolean, version?: object, error?: string}>}
   */
  updateVersion: (id, info) => ipcRenderer.invoke('versions:update', id, info),

  /**
   * 打开某个版本的文件夹。which 取 'version' | 'saves' | 'mods' | 'screenshots'
   * @returns {Promise<{ok: boolean, dir?: string, error?: string}>}
   */
  openVersionFolder: (id, which) => ipcRenderer.invoke('versions:openFolder', id, which),

  /**
   * 这个版本文件夹占多大、有没有开版本隔离（删除确认时给用户看）。
   * @returns {Promise<{bytes: number, isolated: boolean}>}
   */
  getVersionSize: (id) => ipcRenderer.invoke('versions:size', id),

  /**
   * 删除一个版本（界面必须先二次确认；主进程还会再挡一道路径检查）。
   * @returns {Promise<{ok: boolean, sizeBytes?: number, error?: string}>}
   */
  deleteVersion: (id) => ipcRenderer.invoke('versions:delete', id),

  // ——— 启动设置（M6.2）———

  /**
   * 设置页要的东西：当前设置 + 本机内存/屏幕大小 + 共享存档目录里有几个世界。
   * @returns {Promise<object>}
   */
  getSettings: () => ipcRenderer.invoke('settings:get'),

  /**
   * 改启动设置，只传要改的那几项（memoryMB / windowWidth / windowHeight / isolation）。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // ——— 单个版本自己的启动设置（M6.2 追加）———

  /**
   * 某个版本单独设过什么、以及算下来真正生效的值。
   * @returns {Promise<{override: object, effective: object, global: object,
   *                    totalMemoryMB: number, suggestedMemoryMB: number}>}
   */
  getVersionSettings: (id) => ipcRenderer.invoke('versions:getSettings', id),

  /**
   * 改某个版本的单独设置（传 null 的那一项 = 改回跟随全局）。
   * patch: { memoryMB?, window?: {width,height}|null, isolation? }
   * @returns {Promise<{ok: boolean, settings?: object, error?: string}>}
   */
  setVersionSettings: (id, patch) => ipcRenderer.invoke('versions:setSettings', id, patch),

  // ——— 一键备份（M6.3）———

  /**
   * 每一类要备份的东西大概多大 + 它们的说明。
   * @returns {Promise<{sizes: object, help: object, names: object, dir: string}>}
   */
  getBackupEstimate: () => ipcRenderer.invoke('backup:estimate'),

  /**
   * 开始备份。过程中通过 onBackupProgress 推进度。
   * options: { categories: {saves, mods, settings, game}, format: 'zip' | 'folder' }
   * @returns {Promise<{ok: boolean, path?: string, bytes?: number, count?: number, error?: string}>}
   */
  startBackup: (options) => ipcRenderer.invoke('backup:start', options),

  /** 打开备份文件夹 */
  openBackupFolder: () => ipcRenderer.invoke('backup:openFolder'),

  /** 备份进度：{ done, total, bytes, totalBytes } */
  onBackupProgress: (callback) => {
    ipcRenderer.on('backup:progress', (_event, payload) => callback(payload))
  }
})

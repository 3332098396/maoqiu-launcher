// 毛球 — 安全桥（preload）
//
// 界面（网页）默认无权访问系统。这里用 contextBridge 把主进程的能力
// "挑着"暴露给界面，界面只能调用这里列出来的方法，不能乱来。
//
// 【加新功能的规矩】
// 界面每需要一个新能力，就在这里加一条，并在主进程里写对应的 ipcMain.handle。
// 绝不能让界面直接去碰 require / fs / https。

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  /** 问一句"我是哪个版本的"——答案由主进程从 package.json 读出（别在界面上写死） */
  getAppVersion: () => ipcRenderer.invoke('app:version'),

  // ——— 窗口按钮（M17.4：标题栏是自己画的，最小化/最大化/关闭也得自己来）———

  minimizeWindow: () => ipcRenderer.invoke('win:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('win:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('win:close'),

  /** 现在是不是最大化的状态（界面上那个按钮要换图标）*/
  isWindowMaximized: () => ipcRenderer.invoke('win:isMaximized'),

  /**
   * 窗口最大化/还原时通知界面一声。
   * 【为什么要通知】双击标题栏、或者按系统的快捷键（Win+↑）也能最大化，
   * 那时候界面不知道，按钮图标就会停在错的样式上。
   * @returns {() => void} 取消订阅
   */
  onMaximizeChange: (callback) => {
    const listener = (_event, isMax) => callback(isMax)
    ipcRenderer.on('win:maximized', listener)
    return () => ipcRenderer.removeListener('win:maximized', listener)
  },

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

  // ——— 外置登录（M16）———

  /** 界面上"服务器地址"框的默认值（比如 littleskin.cn） */
  yggdrasilDefaultServer: () => ipcRenderer.invoke('account:yggdrasilDefault'),

  /**
   * 用外置登录服务器登录。
   * 【密码只在这儿路过一趟】主进程拿它换令牌，换完就丢，不写盘。
   * @returns {Promise<{ok: boolean, account?: object, error?: string, note?: string}>}
   */
  loginYggdrasil: (input) => ipcRenderer.invoke('account:login', input),

  /** 存着哪些账号、当前是哪个 */
  listAccounts: () => ipcRenderer.invoke('account:list'),

  /** 切换当前账号 */
  switchAccount: (key) => ipcRenderer.invoke('account:switch', key),

  /** 删掉一个账号（外置账号会顺手把令牌作废） */
  removeAccount: (key) => ipcRenderer.invoke('account:remove', key),

  // ——— 正版登录（微软，M13）———

  /**
   * 弹微软登录窗口，走完整条链路。
   * 【密码不经过这里】密码是输在微软自己页面上的，毛球只接跳回来的临时码。
   * @returns {Promise<{ok: boolean, account?: object, error?: string, cancelled?: boolean}>}
   */
  loginMicrosoft: () => ipcRenderer.invoke('account:loginMicrosoft'),

  /** 存客户端 ID（用户自己注册的那个，步骤见 docs/09） */
  setMicrosoftClientId: (value) => ipcRenderer.invoke('microsoft:setClientId', value),

  /**
   * 取当前账号在你那个皮肤站/正版账号上的皮肤（M16.3）。
   * 回来的是一张现成的图（data URL），界面直接贴到 3D 小人身上就行。
   * @returns {Promise<{ok: boolean, dataUrl?: string, source?: string, error?: string}>}
   */
  fetchAccountSkin: () => ipcRenderer.invoke('skin:account'),

  /**
   * 启动游戏。检查不通过马上返回 { ok:false, error }；
   * 起来了返回 { ok:true, java, memoryMB }，之后靠下面两个事件推消息。
   * @returns {Promise<{ok: boolean, error?: string, java?: object, memoryMB?: number}>}
   */
  /** 启动游戏。options.quickPlay = { address } 时，游戏起来直接进那台服务器（M23） */
  startLaunch: (versionId, dir, options) => ipcRenderer.invoke('launch:start', versionId, dir, options),

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

  /** 诊断最近一次启动的日志（带退出码）：认出是什么毛病、为什么、怎么办 */
  diagnoseLast: (exitCode) => ipcRenderer.invoke('diagnose:last', exitCode),

  // ——— AI 助手（M22）———
  //
  // 【谁付钱】用户自己填自己的 Key。不填就只用本地规则库（不联网、不花钱）。

  /** 现在的 AI 配置（**不含 Key 本身**，只说填没填过） */
  getAiConfig: () => ipcRenderer.invoke('ai:getConfig'),

  /** 改 AI 配置：{ endpoint, model, mode, apiKey } */
  setAiConfig: (patch) => ipcRenderer.invoke('ai:setConfig', patch),

  /** 打开智谱开放平台（拿免费 Key 的地方） */
  openAiSite: () => ipcRenderer.invoke('ai:openSite'),

  /** 测一下通不通 */
  testAi: () => ipcRenderer.invoke('ai:test'),

  /** 准备要发的日志（挑最近一次报错的 + 去隐私），给用户过目用 */
  prepareAiLog: () => ipcRenderer.invoke('ai:prepareLog'),

  /** 问 AI。options: { question, logText, history } */
  askAi: (options) => ipcRenderer.invoke('ai:ask', options),

  /** 在文件资源管理器里打开日志文件夹 */
  openLogFolder: () => ipcRenderer.invoke('log:openFolder'),

  // ——— 版本管理（M6.1）———

  /**
   * 改某个版本的显示名/备注。两个都留空 = 恢复成默认（显示版本号）。
   * @returns {Promise<{ok: boolean, version?: object, error?: string}>}
   */
  updateVersion: (id, info, dir) => ipcRenderer.invoke('versions:update', id, info, dir),

  /**
   * 打开某个版本的文件夹。which 取 'version' | 'saves' | 'mods' | 'screenshots'
   * @returns {Promise<{ok: boolean, dir?: string, error?: string}>}
   */
  openVersionFolder: (id, which, dir) => ipcRenderer.invoke('versions:openFolder', id, which, dir),

  /**
   * 这个版本文件夹占多大、有没有开版本隔离（删除确认时给用户看）。
   * @returns {Promise<{bytes: number, isolated: boolean}>}
   */
  getVersionSize: (id, dir) => ipcRenderer.invoke('versions:size', id, dir),

  /**
   * 删除一个版本（界面必须先二次确认；主进程还会再挡一道路径检查）。
   * @returns {Promise<{ok: boolean, sizeBytes?: number, error?: string}>}
   */
  deleteVersion: (id, dir) => ipcRenderer.invoke('versions:delete', id, dir),

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
  /** 这个版本将会使用哪个 Java（版本设置里显示那一行用） */
  getVersionJava: (id, dir) => ipcRenderer.invoke('versions:java', id, dir),

  getVersionSettings: (id, dir) => ipcRenderer.invoke('versions:getSettings', id, dir),

  /**
   * 改某个版本的单独设置（传 null 的那一项 = 改回跟随全局）。
   * patch: { memoryMB?, window?: {width,height}|null, isolation? }
   * @returns {Promise<{ok: boolean, settings?: object, error?: string}>}
   */
  setVersionSettings: (id, patch, dir) => ipcRenderer.invoke('versions:setSettings', id, patch, dir),

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
  },

  // ——— 社区资源（M9，来自 Modrinth）———

  /**
   * 搜索 Mod / 资源包 / 光影包。
   * @param {{type: string, query?: string, gameVersion?: string, limit?: number}} options
   * @returns {Promise<{ok: boolean, total?: number, hits?: Array, error?: string}>}
   */
  searchModrinth: (options) => ipcRenderer.invoke('modrinth:search', options),

  /**
   * 下载一个项目并放到该放的地方（自动挑合适的文件版本）。
   * @param {{projectId: string, type: string, versionId: string}} options
   * @returns {Promise<{ok: boolean, path?: string, dir?: string, versionName?: string,
   *                    filename?: string, skipped?: boolean, error?: string}>}
   */
  installModrinth: (options) => ipcRenderer.invoke('modrinth:install', options),

  /** 列出这个版本的存档（装数据包时挑一个）*/
  listSaves: (versionId, dir) => ipcRenderer.invoke('saves:list', versionId, dir),

  /** 打开"刚下好的那个东西"所在的文件夹（数据包这种藏在世界里的也能打开）*/
  openContentFolder: (options) => ipcRenderer.invoke('content:openFolder', options),

  /** 下载进度（和安装版本共用一套字段） */
  onContentProgress: (callback) => {
    ipcRenderer.on('content:progress', (_event, stats) => callback(stats))
  },

  // ——— 本地内容管理（M23）：已经装了的 Mod / 资源包 / 光影 / 存档 ———

  /** 列出这个版本已经装了的某类内容 */
  listLocal: (options) => ipcRenderer.invoke('local:list', options),

  /** 把 Mod jar 里的图标抠出来（返回 data URL，可能没有） */
  localIcon: (options) => ipcRenderer.invoke('local:icon', options),

  /** 开关一个 Mod（改 .disabled 后缀，不删文件） */
  toggleLocal: (options) => ipcRenderer.invoke('local:toggle', options),

  /** 删掉一个文件或者一个存档 —— 走系统回收站，捡得回来 */
  trashLocal: (options) => ipcRenderer.invoke('local:trash', options),

  /** 从外面挑文件复制进来 */
  importLocal: (options) => ipcRenderer.invoke('local:import', options),

  /** 打开某类内容的文件夹 */
  openLocalFolder: (options) => ipcRenderer.invoke('local:openFolder', options),

  /** 存档（世界）列表，带大小 */
  listWorlds: (options) => ipcRenderer.invoke('worlds:list', options),

  /** 导入一个存档文件夹 */
  importWorld: (options) => ipcRenderer.invoke('worlds:import', options),

  /** 打开存档文件夹 */
  openWorldFolder: (options) => ipcRenderer.invoke('worlds:openFolder', options),

  /** 版本隔离：先算一遍"能搬几个世界" */
  planIsolationMove: (options) => ipcRenderer.invoke('isolation:plan', options),

  /** 版本隔离：真搬（调用前必须先确认过） */
  moveIsolationSaves: (options) => ipcRenderer.invoke('isolation:move', options),

  /** 搬存档的进度提示 */
  onIsolationStage: (callback) => {
    ipcRenderer.on('isolation:stage', (_event, text) => callback(text))
  },

  /** 检查已装的 Mod 有没有新版本（只发哈希，不发文件） */
  checkModUpdates: (options) => ipcRenderer.invoke('local:checkUpdates', options),

  /** 装之前看看缺不缺前置 */
  checkDeps: (options) => ipcRenderer.invoke('content:checkDeps', options),

  /** 把一个 Mod 更新到新版本（先下新的，再把旧的放进回收站） */
  updateLocalMod: (options) => ipcRenderer.invoke('local:updateMod', options),

  // ——— 服务器列表（M23）：写的其实是游戏目录下的 servers.dat ———

  /** 读服务器列表 */
  listServers: (options) => ipcRenderer.invoke('servers:list', options),

  /** 加一台 */
  addServer: (options) => ipcRenderer.invoke('servers:add', options),

  /** 改一条 */
  updateServer: (options) => ipcRenderer.invoke('servers:update', options),

  /** 删一条（删的是列表记录） */
  removeServer: (options) => ipcRenderer.invoke('servers:remove', options),

  /** 问一台服务器在不在线、几个人、延迟多少 */
  pingServer: (options) => ipcRenderer.invoke('servers:ping', options),

  // ——— 通知中心（M23）———

  /** 读通知列表和未读数 */
  listNotices: () => ipcRenderer.invoke('notices:list'),

  /** 记一条通知（界面这边发生的事） */
  addNotice: (notice) => ipcRenderer.invoke('notices:add', notice),

  /** 全部标记已读 */
  readNotices: () => ipcRenderer.invoke('notices:read'),

  /** 清空通知 */
  clearNotices: () => ipcRenderer.invoke('notices:clear'),

  // ——— 诊断包（M23）：带脱敏的 zip ———

  /** 导出诊断包（会弹保存框） */
  exportDiagnostics: (options) => ipcRenderer.invoke('diag:export', options),

  // ——— Java 运行时管理（M20）———

  /** 本机能用哪些 Java（设置页那个列表用） */
  listJavas: () => ipcRenderer.invoke('java:list'),

  /** 弹系统文件框挑一个 java.exe，并且真的跑一下确认能用（只探测，不保存） */
  pickJava: () => ipcRenderer.invoke('java:pick'),

  /** 把挑好的 Java 记进名单（只记路径，不动文件） */
  addJava: (exePath) => ipcRenderer.invoke('java:add', exePath),

  /** 从名单里划掉（不动硬盘上的文件） */
  removeJava: (exePath) => ipcRenderer.invoke('java:remove', exePath),

  // ——— Mod 加载器（M10）———

  /**
   * 给某个游戏版本装 Mod 加载器（先支持 Fabric）。
   * 进度通过 onInstallStage / onInstallProgress 推过来。
   * @param {{gameVersion: string, loader?: 'fabric'}} options
   * @returns {Promise<{ok: boolean, versionId?: string, loaderVersion?: string,
   *                    already?: boolean, error?: string}>}
   */
  installLoader: (options) => ipcRenderer.invoke('loader:install', options),

  // ——— 整合包：拖放安装（M11）———

  /**
   * 拿到拖进来的文件的真实路径。
   * 【为什么必须走这里】新版 Electron 里网页拿不到文件的真实路径了
   * （安全考虑），要在这一层用 webUtils 换。
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  /** 让用户自己挑一个整合包文件 */
  pickPackFile: () => ipcRenderer.invoke('pack:pick'),

  /** 看一眼这个压缩包是什么（不装） */
  inspectPack: (filePath, password) => ipcRenderer.invoke('pack:inspect', filePath, password),

  /**
   * 用户给版本起的那个名字行不行（名字会变成 versions\<名字>\ 这个文件夹）。
   * @param {string} name 名字
   * @param {string} [dir] 要装到哪个游戏目录（重名检查要按这个目录来）
   * @returns {Promise<{ok: boolean, name?: string, error?: string, warning?: string}>}
   */
  checkPackName: (name, dir) => ipcRenderer.invoke('pack:check-name', name, dir),

  /**
   * 让用户挑一个"装到哪儿"的游戏目录（弹系统文件夹选择框）。
   * 挑完主进程会校验、归一化（普通文件夹会自动往下建一层 .minecraft）并记住它。
   * @returns {Promise<{ok: boolean, dir?: string, empty?: boolean, error?: string, canceled?: boolean}>}
   */
  pickPackDir: () => ipcRenderer.invoke('pack:pick-dir'),

  /**
   * 装这个整合包。
   * @param {{filePath: string, targetVersionId?: string, versionName?: string}} options
   */
  installPack: (options) => ipcRenderer.invoke('pack:install', options),

  /**
   * 挑背景图 / 背景音乐（弹系统文件选择框，只返回路径，不复制文件）。
   * @param {'background'|'bgm'} kind
   */
  pickLookFile: (kind) => ipcRenderer.invoke('look:pick', kind),

  // ——— 樱花内网穿透（M15）———

  /** 让毛球自己下 frpc（下之前先问一句、下完之后校验） */
  ensureFrpc: () => ipcRenderer.invoke('frp:ensure-frpc'),

  /** 挑 frpc.exe（自己有现成的——比如从樱花面板下过的那个） */
  pickFrpc: () => ipcRenderer.invoke('frp:pick-exe'),

  /** 下 frpc 过程中的"现在在干嘛" / 进度百分比 */
  onFrpStage: (callback) => {
    ipcRenderer.on('frp:stage', (_event, text) => callback(text))
  },
  onFrpProgress: (callback) => {
    ipcRenderer.on('frp:progress', (_event, stats) => callback(stats))
  },

  /** 起隧道 / 停隧道 / 看状态 */
  frpStart: (options) => ipcRenderer.invoke('frp:start', options),
  frpStop: () => ipcRenderer.invoke('frp:stop'),
  frpStatus: () => ipcRenderer.invoke('frp:status'),

  /** 打开樱花穿透官网 */
  openFrpSite: () => ipcRenderer.invoke('frp:open-site'),

  /** 开始/停止盯着屏幕光标（M14.4 的 3D 小人用，出了窗口也要跟） */
  watchCursor: (on) => ipcRenderer.invoke('cursor:watch', on),

  /** 主进程推来的光标位置（屏幕坐标） */
  onCursorMove: (callback) => {
    ipcRenderer.on('cursor:move', (_event, point) => callback(point))
  },

  /** 挑一个皮肤文件（M14.4），只返回路径 */
  pickSkinFile: () => ipcRenderer.invoke('skin:pick'),

  // ——— 本地皮肤库（M17.5）———

  /** 皮肤库里有哪些（最新传的排前面） */
  listSkins: () => ipcRenderer.invoke('skin:list'),

  /** 挑一张皮肤，检查尺寸，**复制**一份进皮肤库（不动用户原来那张） */
  importSkin: () => ipcRenderer.invoke('skin:import'),

  /** 从皮肤库里删一份（只删我们自己复制进来的那份） */
  removeSkin: (path) => ipcRenderer.invoke('skin:remove', path),

  /** 打开皮肤站（地址写死在主进程，界面只能请求打开它） */
  openSkinSite: () => ipcRenderer.invoke('skin:openSite'),

  /** 在文件管理器里打开皮肤库 */
  openSkinFolder: () => ipcRenderer.invoke('skin:openFolder'),

  /** 把随软件打包的几张皮肤复制进皮肤库（同名不覆盖） */
  seedBundledSkins: () => ipcRenderer.invoke('skin:seedBundled'),

  /** 把界面画好的示例皮肤存进皮肤库（同名不覆盖） */
  saveBuiltinSkin: (name, dataUrl) => ipcRenderer.invoke('skin:saveBuiltin', name, dataUrl),

  /** 官方的默认皮肤 Steve（从玩家自己的游戏文件里读出来的） */
  getOfficialSkin: (kind) => ipcRenderer.invoke('skin:official', kind),

  /** 皮肤编辑器画完存进皮肤库（重名会自动换个编号，不会默默不存） */
  saveEditedSkin: (name, dataUrl) => ipcRenderer.invoke('skin:saveEdited', name, dataUrl),

  // ——— 传到正版账号 / 披风（M23，等 Mojang 审批下来才用得上）———

  /** 把皮肤库里的一张真传到 Mojang 上（游戏里立刻生效） */
  skinToMojang: (options) => ipcRenderer.invoke('skin:toMojang', options),

  /** 这个正版账号有哪些官方披风 */
  listCapes: () => ipcRenderer.invoke('skin:capes'),

  /** 戴 / 摘披风（capeId 传空就是摘下来） */
  setCape: (capeId) => ipcRenderer.invoke('skin:setCape', capeId),

  /** 帮助页的一键打开：'game' 游戏目录 / 'config' 配置目录 */
  openAppFolder: (which) => ipcRenderer.invoke('app:openFolder', which),

  // ——— 清理游戏垃圾（M13）———

  /** 扫一遍能清多少（不动任何文件） */
  scanGarbage: () => ipcRenderer.invoke('cleanup:scan'),

  /** 真删（界面上已经确认过才调） */
  cleanGarbage: (keys) => ipcRenderer.invoke('cleanup:run', keys),

  // ——— 联机（M12）———

  /**
   * 现在联机是什么情况。
   * @returns {Promise<{ok: boolean, running: boolean, code?: string, peers: Array, myIp?: string, error?: string}>}
   */
  onlineStatus: () => ipcRenderer.invoke('online:status'),

  /**
   * 建房间（role: 'host'）或者进别人的房间（role: 'guest' + code）。
   * ⚠️ 会弹一次系统权限确认（要建虚拟网卡），用户同意才能继续。
   */
  onlineStart: (options) => ipcRenderer.invoke('online:start', options),

  /** 离开房间（虚拟网卡会一起收掉） */
  onlineLeave: () => ipcRenderer.invoke('online:leave'),

  /** 联机的阶段提示（"正在下载组件…""正在创建虚拟网卡…"） */
  onOnlineStage: (callback) => {
    ipcRenderer.on('online:stage', (_event, text) => callback(text))
  },

  // ——— 联机：VoxLink ———
  //
  // ⚠️ 这一套现在只做到"房间"：能真的从服务器拿到 6 位房间码，好友的码也认得。
  //    **但还不能联机玩**——数据怎么在两个人之间走，是下一步的事。

  /** VoxLink 现在什么情况：state 是 'idle' / 'hosting' / 'in_room' */
  voxlinkStatus: () => ipcRenderer.invoke('voxlink:status'),

  /** VoxLink 服务器活着吗 → { ok: true } 或 { ok: false, error } */
  voxlinkPing: () => ipcRenderer.invoke('voxlink:ping'),

  /** 找本机游戏的「对局域网开放」端口 → { ok, ports: [{port, pid}] } */
  voxlinkPorts: () => ipcRenderer.invoke('voxlink:ports'),

  /** 建 VoxLink 房间（不传 hostPort 就自动找） */
  voxlinkCreate: (options) => ipcRenderer.invoke('voxlink:create', options),

  /** 进别人的 VoxLink 房间（options.code 是 6 位房间码） */
  voxlinkJoin: (options) => ipcRenderer.invoke('voxlink:join', options),

  /** 退 VoxLink 房间 */
  voxlinkLeave: () => ipcRenderer.invoke('voxlink:leave'),

  /** 查某个房间码 → { ok, info } */
  voxlinkInfo: (code) => ipcRenderer.invoke('voxlink:info', code),

  /** 大厅列表 */
  voxlinkRooms: (query) => ipcRenderer.invoke('voxlink:rooms', query),

  /** 改 VoxLink 设置（serverUrl / allowRelay） */
  voxlinkSettings: (patch) => ipcRenderer.invoke('voxlink:settings', patch),

  /** VoxLink 的阶段提示（"正在找游戏的端口…"） */
  onVoxlinkStage: (callback) => {
    ipcRenderer.on('voxlink:stage', (_event, text) => callback(text))
  },

  /**
   * VoxLink 的连接进展（对象，不是一句话）：
   * event 是 'conn:state'（主状态）/ 'stage'（细分步骤）/ 'nat:state'（两边的网络类型）/
   * 'channel:closed'（房间没了或被踢了）。
   */
  onVoxlinkConn: (callback) => {
    ipcRenderer.on('voxlink:conn', (_event, payload) => callback(payload))
  },

  /** 把这个版本导出成一个整合包 zip（存档/截图/日志不会进去） */
  exportPack: (options) => ipcRenderer.invoke('pack:export', options),

  /** 整合包的进度与阶段提示 */
  onPackStage: (callback) => {
    ipcRenderer.on('pack:stage', (_event, text) => callback(text))
  },
  onPackProgress: (callback) => {
    ipcRenderer.on('pack:progress', (_event, stats) => callback(stats))
  }
})

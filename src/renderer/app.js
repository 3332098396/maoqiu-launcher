// 毛球 — 界面逻辑
//
// 当前进度：M5（启动游戏）。下载页（版本清单、安装）+ 启动页（账号、选版本、启动）。
//
// 【安全底线】所有来自网络的内容（版本号、版本类型、游戏日志）一律用 textContent
// 塞进页面，绝对不用 innerHTML。这些数据来自外部，用 innerHTML 等于给恶意代码开门。

// ═══════════════════════════════════════
// 页面切换
// ═══════════════════════════════════════

const navButtons = document.querySelectorAll('.rail__btn[data-page]')
const pages = document.querySelectorAll('.page')

function showPage(name) {
  for (const button of navButtons) {
    button.classList.toggle('rail__btn--on', button.dataset.page === name)
  }
  for (const page of pages) {
    page.hidden = page.dataset.page !== name
  }

  // 版本清单要联网，没必要一开机就去拿。
  // 等用户真的点开「下载」页再加载，第一次之后就不再重复触发。
  if (name === 'download' && !manifestLoaded) {
    manifestLoaded = true
    loadManifest()
    loadInstalled()
  }

  // 启动页每次进来都重新读一遍：用户可能刚在下载页装完新版本
  if (name === 'launch') {
    loadLaunchPage()
    ensureSkinCard() // 3D 皮肤预览（M14.4）：第一次进来时挂上
    moveSkinViewerTo(skinStageEl, 1) // 从皮肤页回来时把小人搬回来（M17.5）
  }

  // AI 助手页（M22）：进来先读一遍配置（用户可能刚在设置里填了 Key）
  if (name === 'ai') {
    loadAiConfig()
  }

  // 皮肤页（M17.5）：把 3D 小人搬过来 + 重新画列表
  if (name === 'skin') {
    ensureSkinCard()
    if (!bundledSkinNames.length) seedBundledSkins().then(() => renderSkinPage())
    moveSkinViewerTo(skinStageMainEl, 1.15) // 大预览：相机拉远一点，不然脚会被裁掉
    renderSkinPage()
  }

  // 设置页同理：设置可能被别处改过（比如改完内存回到启动页看信息卡）
  if (name === 'settings') loadSettingsPage()

  // 联机页：进来先看一眼"现在房间里是什么情况"（可能上次就没退出去）
  if (name === 'online') {
    refreshOnlinePage()
    loadFrpPanel()
  }
}

for (const button of navButtons) {
  button.addEventListener('click', () => showPage(button.dataset.page))
}

// ═══════════════════════════════════════
// 下载页：版本清单
// ═══════════════════════════════════════

const searchEl = document.getElementById('ver-search')
const filterEl = document.getElementById('ver-filter')
const listEl = document.getElementById('ver-list')
const statusEl = document.getElementById('ver-status')
const refreshBtn = document.getElementById('ver-refresh')

/** 拿到手的版本清单（含 latest / versions / fromCache / updatedAt） */
let manifest = { versions: [], latest: {} }
/** 当前筛选：all | release | snapshot | old */
let verFilter = 'all'
/** 当前搜索词 */
let verKeyword = ''
/** 有没有在后台更新中，避免重复触发 */
let refreshing = false
/** 版本清单是不是已经加载过了（懒加载用） */
let manifestLoaded = false

function pad(n) {
  return String(n).padStart(2, '0')
}

function formatDate(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function badgeClass(type) {
  if (type === 'release') return 'ver__badge ver__badge--release'
  if (type === 'snapshot') return 'ver__badge ver__badge--snapshot'
  return 'ver__badge ver__badge--old'
}

/** 按当前筛选和搜索词，算出该显示哪些版本 */
function visibleVersions() {
  const keyword = verKeyword.trim().toLowerCase()

  return manifest.versions.filter((v) => {
    if (verFilter === 'release' && v.type !== 'release') return false
    if (verFilter === 'snapshot' && v.type !== 'snapshot') return false
    if (verFilter === 'old' && v.type !== 'old_beta' && v.type !== 'old_alpha') return false
    if (keyword && !v.id.toLowerCase().includes(keyword)) return false
    return true
  })
}

function renderVersions() {
  const list = visibleVersions()
  listEl.textContent = ''

  if (list.length === 0) {
    const li = document.createElement('li')
    li.className = 'ver'
    li.style.justifyContent = 'center'
    li.style.color = 'var(--text-muted)'
    li.textContent =
      manifest.versions.length === 0 ? '还没有版本数据' : '没有找到匹配的版本'
    listEl.appendChild(li)
    return
  }

  const frag = document.createDocumentFragment()

  for (const version of list) {
    const li = document.createElement('li')
    li.className = 'ver'

    const id = document.createElement('span')
    id.className = 'ver__id'
    id.textContent = version.id
    li.appendChild(id)

    const badge = document.createElement('span')
    badge.className = badgeClass(version.type)
    badge.textContent = version.typeLabel
    li.appendChild(badge)

    const date = document.createElement('span')
    date.className = 'ver__date'
    date.textContent = formatDate(version.released)
    li.appendChild(date)

    // ——— 右侧：装过了就标一下，没装过给个「安装」按钮 ———
    const action = document.createElement('div')
    action.className = 'ver__action'

    if (installedVersions.has(version.id)) {
      const ok = document.createElement('span')
      ok.className = 'ver__installed'
      ok.textContent = '已安装'
      action.appendChild(ok)

      // 万一文件被删掉或弄坏了，点「重装」能补齐——
      // 已经下好且校验通过的文件会跳过，不会白白重下
      const fix = document.createElement('button')
      fix.className = 'linkbtn'
      fix.type = 'button'
      fix.dataset.install = version.id
      fix.textContent = '重装'
      action.appendChild(fix)
    } else {
      const button = document.createElement('button')
      button.className = 'btn btn--primary btn--sm'
      button.type = 'button'
      button.dataset.install = version.id
      button.textContent = '安装'
      action.appendChild(button)
    }
    li.appendChild(action)

    frag.appendChild(li)
  }

  listEl.appendChild(frag)
}

function setStatus(text, isError = false) {
  statusEl.textContent = text
  statusEl.classList.toggle('verstatus--error', isError)
}

/** 状态栏那句话：显示了多少个、最新版本是哪个、是不是缓存 */
function describeCount() {
  const shown = visibleVersions().length
  const total = manifest.versions.length
  const parts = []

  parts.push(shown === total ? `共 ${total} 个版本` : `显示 ${shown} / ${total} 个版本`)

  if (manifest.latest && manifest.latest.release) {
    parts.push(`最新正式版 ${manifest.latest.release}`)
  }
  if (manifest.fromCache && manifest.updatedAt) {
    parts.push(`用的是 ${formatTime(manifest.updatedAt)} 缓存下来的列表`)
  }

  return parts.join(' · ')
}

/**
 * 打开下载页时调用：先拿缓存（快），有缓存的话再在后台更新。
 *
 * 这样用户打开就能看到东西，不用对着空白等网。
 */
async function loadManifest() {
  setStatus('正在读取版本清单…')

  const result = await window.api.getManifest()

  if (!result.ok) {
    setStatus(`读不到版本清单。\n${result.error}`, true)
    return
  }

  manifest = result
  renderVersions()
  setStatus(describeCount())

  // 有缓存就先显示着，后台悄悄去更新
  if (result.fromCache) await refreshManifest()
}

/** 强制从网上更新一份 */
async function refreshManifest() {
  if (refreshing) return
  refreshing = true

  setStatus('正在从网上更新版本清单…')
  const result = await window.api.refreshManifest()
  refreshing = false

  if (!result.ok) {
    setStatus(
      `更新失败，继续用上次的列表。\n${result.error}`,
      true
    )
    return
  }

  manifest = result
  renderVersions()
  setStatus(describeCount())
}

searchEl.addEventListener('input', () => {
  verKeyword = searchEl.value
  renderVersions()
  setStatus(describeCount())
})

filterEl.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip')
  if (!chip) return

  verFilter = chip.dataset.filter
  for (const item of filterEl.children) {
    item.classList.toggle('chip--on', item === chip)
  }

  renderVersions()
  setStatus(describeCount())
})

refreshBtn.addEventListener('click', refreshManifest)

// ═══════════════════════════════════════
// 安装版本（M4）
// ═══════════════════════════════════════

const installEl = document.getElementById('install')
const installTitleEl = document.getElementById('install-title')
const installStageEl = document.getElementById('install-stage')
const installFillEl = document.getElementById('install-fill')
const installDetailEl = document.getElementById('install-detail')
const installCancelEl = document.getElementById('install-cancel')

/** 本机已经装了哪些版本。用来决定版本行右边显示「安装」还是「已安装」 */
const installedVersions = new Set()
/** 正在装哪个版本；空字符串表示没有任务在跑 */
let installingVersion = ''

function setStage(text) {
  installStageEl.textContent = text
}

function setFill(percent) {
  installFillEl.style.width = `${Math.max(0, Math.min(100, percent))}%`
}

function setDetail(text) {
  installDetailEl.textContent = text
}

function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond < 1) return '—'
  const mb = bytesPerSecond / 1024 / 1024
  if (mb >= 1) return `${mb.toFixed(1)} MB/秒`
  return `${(bytesPerSecond / 1024).toFixed(0)} KB/秒`
}

function formatSize(bytes) {
  const value = Number(bytes) || 0
  // 小东西别看"0 MB"——清理那页全是日志这类小文件，写 0 MB 像出错了
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatEta(ms) {
  if (!ms || ms <= 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

/** 读一下本机装了哪些版本 */
async function loadInstalled() {
  try {
    const info = await window.api.getGameInfo()
    installedVersions.clear()
    for (const id of info.installed) installedVersions.add(id)
    renderVersions()
  } catch {
    // 读不到就当没装过，不影响别的功能
  }
}

async function startInstall(versionId) {
  if (installingVersion) return
  installingVersion = versionId

  installEl.hidden = false
  installTitleEl.textContent = `正在安装 ${versionId}`
  setStage('准备中…')
  setFill(0)
  setDetail('—')
  installCancelEl.hidden = false

  const result = await window.api.startInstall(versionId)
  installingVersion = ''
  // 【装完要收起来，不能只置灰】用户反馈："安装完成之后右下角还是取消安装"——
  // 光禁用的话它还杵在那儿、点又点不动，看着像坏了。
  installCancelEl.hidden = true
  cancelModalEl.hidden = true // 装完了/取消了，取消确认框(如果开着)收掉

  if (!result.ok) {
    setFill(0)
    if (result.cancelled) {
      installTitleEl.textContent = `${versionId} 安装已取消`
      setStage('')
      setDetail(result.dropped ? result.error : '已经下好的文件留着，下次装会接着用')
      return
    }
    setStage('安装失败')
    setDetail(result.error ?? '未知原因')
    return
  }

  setFill(100)
  // 标题也改掉，否则"正在安装 xx"会一直挂在那儿，看着像没结束
  installTitleEl.textContent = `${versionId} 安装完成`
  setStage('')
  setDetail(`共 ${result.stats.done} 个文件，没有失败`)

  // 装完立刻刷新列表，让这一行变成「已安装」
  await loadInstalled()
}

// 主进程推过来的阶段提示和进度
window.api.onInstallStage((text) => {
  setStage(text)
  // 装 Mod 加载器是在「版本设置」弹窗里点的，进度也要写到那儿去
  if (loaderInstalling) verLoaderHintEl.textContent = text
})
window.api.onInstallProgress((stats) => {
  setFill(stats.percent)
  setDetail(
    `${stats.percent}% · ${stats.done}/${stats.total} 个 · ${formatSize(stats.receivedBytes)}/${formatSize(stats.totalBytes)}` +
      ` · ${formatSpeed(stats.speed)} · 剩 ${formatEta(stats.etaMs)}` +
      (stats.failed > 0 ? ` · 失败 ${stats.failed}` : '')
  )
  if (loaderInstalling) {
    verLoaderHintEl.textContent =
      `正在下载加载器… ${stats.percent}% · ` +
      `${formatSize(stats.receivedBytes)}/${formatSize(stats.totalBytes)}`
  }
})

// 列表里点「安装」
listEl.addEventListener('click', (event) => {
  const versionId = event.target.dataset?.install
  if (versionId) startInstall(versionId)
})

// 进度面板可以手动收起，不挡着看列表
document.getElementById('install-hide').addEventListener('click', () => {
  installEl.hidden = true
})

// 取消安装：先问一句"已经下好的要不要留"，别自作主张
const cancelModalEl = document.getElementById('cancel-modal')
const cancelWhatEl = document.getElementById('cancel-what')
const cancelWarnEl = document.getElementById('cancel-warn')

function openCancelDialog() {
  if (!installingVersion) return
  cancelWhatEl.textContent = `正在安装 ${installingVersion}，已经下好了一部分文件。`
  cancelWarnEl.textContent =
    '全部删掉只清这次下的：公共的库文件、音效贴图如果别的版本还在用，会留着。'
  cancelModalEl.hidden = false
}

async function finishCancel(mode) {
  cancelModalEl.hidden = true
  installCancelEl.hidden = true
  setStage(mode === 'drop' ? '正在取消并清理…' : '正在取消…')

  const result = await window.api.cancelInstall(mode)
  if (!result.ok) setStage(result.error)
}

installCancelEl.addEventListener('click', openCancelDialog)
document.getElementById('cancel-back').addEventListener('click', () => {
  cancelModalEl.hidden = true // 继续安装，什么都不用做——下载一直没停
})
document.getElementById('cancel-keep').addEventListener('click', () => finishCancel('keep'))
document.getElementById('cancel-drop').addEventListener('click', () => finishCancel('drop'))
cancelModalEl.addEventListener('click', (event) => {
  if (event.target === cancelModalEl) cancelModalEl.hidden = true
})

// ═══════════════════════════════════════
// 启动页：账号 + 选版本 + 启动游戏（M5）
// ═══════════════════════════════════════

const accInputEl = document.getElementById('acc-input')
const accNameEl = document.getElementById('acc-name')
const accHintEl = document.getElementById('acc-hint')
const accAvatarEl = document.getElementById('acc-avatar')
// 外置登录（M16）
const accTabOfflineEl = document.getElementById('acc-tab-offline')
const accTabYggdrasilEl = document.getElementById('acc-tab-yggdrasil')
const accPaneOfflineEl = document.getElementById('acc-pane-offline')
const accPaneYggdrasilEl = document.getElementById('acc-pane-yggdrasil')
const accServerEl = document.getElementById('acc-server')
const accUserEl = document.getElementById('acc-user')
const accPassEl = document.getElementById('acc-pass')
const accLoginBtnEl = document.getElementById('acc-login-btn')
const accLoginHintEl = document.getElementById('acc-login-hint')
const accWarnEl = document.getElementById('acc-warn')
// 正版登录（微软，M13）
const accTabMicrosoftEl = document.getElementById('acc-tab-microsoft')
const accPaneMicrosoftEl = document.getElementById('acc-pane-microsoft')
const accMsLoginEl = document.getElementById('acc-ms-login')
const accMsGoSetupEl = document.getElementById('acc-ms-gosetup')
const accMsHintEl = document.getElementById('acc-ms-hint')
const accSignoutEl = document.getElementById('acc-signout')
const pickListEl = document.getElementById('pick-list')
const pickEmptyEl = document.getElementById('pick-empty')
const pickToggleEl = document.getElementById('pick-toggle')
const pickToggleIconEl = document.getElementById('pick-toggle-icon')
const launchBtnEl = document.getElementById('launch-btn')
const launchTipEl = document.getElementById('launch-tip')
const launchNoticeEl = document.getElementById('launch-notice')
const currentVersionPanelEl = document.getElementById('current-version-panel')
const curNameEl = document.getElementById('cur-name')
const curNoteEl = document.getElementById('cur-note')
const curHintEl = document.getElementById('cur-hint')
const factVersionEl = document.getElementById('fact-version')
const heroNameEl = document.getElementById('hero-name')
const heroMetaEl = document.getElementById('hero-meta')
const factJavaEl = document.getElementById('fact-java')
const factMemoryEl = document.getElementById('fact-memory')
const factDirEl = document.getElementById('fact-dir')

const HINT_DEFAULT = '3～16 个字符，只能用字母、数字、下划线'
/** 界面里最多留多少行日志——再多也没人翻 */
const MAX_UI_LOG_LINES = 500

/** 启动页拿到的信息（已装版本、账号、内存、Java…） */
let launchInfo = null
/** 当前选中的版本号 */
let selectedVersion = ''
/**
 * 当前选中的版本在**哪个游戏目录**里。
 *
 * 【为什么版本号之外还要记这个】M11.4 起可以有好几个游戏目录，
 * 两个目录里可能各有一个叫 "26.3" 的版本。只说版本号等于没说清是哪个。
 * 空字符串 = 默认目录（%APPDATA%\.minecraft）。
 */
let selectedDir = ''
/** 版本列表展开了没有（版本多了会顶到按钮，默认收起；见 renderPickList） */
let pickerOpen = false
/** 有没有一次启动正在进行（准备中或游戏运行中） */
let launching = false
/** 界面上的日志行 */
let logLines = []

/**
 * 检查名字合不合法。返回空字符串表示没问题，否则是给用户看的原因。
 *
 * 【为什么主进程里也有一份】界面这份是为了让用户边打字边看到提示；
 * 真正说话算数的是主进程里那份（accounts.js）——界面可以被绕过，主进程不会。
 */
function nameProblem(raw) {
  const name = String(raw ?? '').trim()
  if (!name) return '先填一个游戏名字'
  if (name.length < 3 || name.length > 16) return '名字要 3～16 个字符'
  if (!/^[A-Za-z0-9_]+$/.test(name)) return '只能用字母、数字、下划线（中文名游戏不认）'
  return ''
}

/** 页面顶部那条提示。kind: info（蓝）| ok（绿）| error（红） */
function setNotice(text, kind = 'info') {
  launchNoticeEl.textContent = text
  launchNoticeEl.classList.toggle('notice--ok', kind === 'ok')
  launchNoticeEl.classList.toggle('notice--error', kind === 'error')
}

function renderAccountCard() {
  const account = launchInfo?.account
  accNameEl.textContent = account?.name || '还没有账号'
  accAvatarEl.textContent = account?.name ? account.name.slice(0, 1).toUpperCase() : '⛏'

  // 账号变了，把右边那个 3D 小人换成这个账号的皮肤（M16.3）。
  // 内部有"同一个账号不重复取"的判断，所以在这儿调用是安全的
  refreshAccountSkin()

  // 只有"真账号"（外置 / 微软）需要"退出登录"——离线账号就是个名字，改掉就行
  accSignoutEl.hidden = account?.type !== 'yggdrasil' && account?.type !== 'microsoft'

  // 输入框里已经有内容但还不合法时，把原因写在提示上
  const typed = accInputEl.value
  const problem = nameProblem(typed)
  const showProblem = Boolean(typed.trim()) && Boolean(problem)
  accHintEl.textContent = showProblem ? problem : HINT_DEFAULT
  accHintEl.classList.toggle('acc__hint--error', showProblem)
}

// ═══════════════════════════════════════
// 外置登录（M16）
//
// 【它是什么】用皮肤站（比如 LittleSkin）的账号登录。
// 有真令牌、有皮肤，但**不是正版账号**，进不了正版服务器——这句话必须写在界面上，
// 不能只写在文档里（用户不会去翻文档）。
//
// 【密码怎么走】界面 → 主进程 → 服务器，换完令牌**立刻丢掉**，
// 既不写盘也不留在输入框里。界面上唯一留着的是令牌。
// ═══════════════════════════════════════

/** 当前显示的是哪张表单 */
let accTab = 'offline'

/** 开机时"跟着当前账号选一次表单"，只做一次 */
let accTabInitialized = false

/** 默认服务器地址由主进程给——只在一处定义（yggdrasil.js），界面不另写一份 */
let yggdrasilDefaultServer = 'littleskin.cn'

/** 登录中：按钮变灰防连点 */
let loggingIn = false

/**
 * 登录结果那一行。
 * 【没话说就整行收掉】卡片本来就高，留一行空占位会把下面的内容顶出屏幕。
 * @param {'error'|'ok'|''} kind
 */
function setLoginHint(text, kind = '') {
  accLoginHintEl.textContent = text || ''
  accLoginHintEl.hidden = !text
  accLoginHintEl.classList.toggle('acc__hint--error', kind === 'error')
  accLoginHintEl.classList.toggle('acc__hint--ok', kind === 'ok')
}

/**
 * 切换账号卡片里的表单。
 * 【为什么跟着"点哪张"走、而不是跟着"当前账号是什么类型"】用户可能正登着外置账号，
 * 但想换回随便一个离线名字——表单该听他点的那一下。
 */
function setAccTab(tab, options = {}) {
  accTab = ['yggdrasil', 'microsoft'].includes(tab) ? tab : 'offline'

  accPaneOfflineEl.hidden = accTab !== 'offline'
  accPaneYggdrasilEl.hidden = accTab !== 'yggdrasil'
  accPaneMicrosoftEl.hidden = accTab !== 'microsoft'
  accTabOfflineEl.classList.toggle('acc__tab--on', accTab === 'offline')
  accTabYggdrasilEl.classList.toggle('acc__tab--on', accTab === 'yggdrasil')
  accTabMicrosoftEl.classList.toggle('acc__tab--on', accTab === 'microsoft')
  // "不是正版"那句只跟着外置登录走（离线用不着，正版更用不着）
  accWarnEl.hidden = accTab !== 'yggdrasil'

  if (accTab === 'microsoft') renderMicrosoftPane()

  refreshLaunchUi()

  // 开机自动选中那张表的时候别抢焦点——用户可能正在别的地方打字
  if (options.focus === false) return

  // 【为什么必须滚一下】这几张表比离线的长一截，点在标签上之后按钮
  // 很可能落在窗口外面——用户会以为"点了没反应"。
  // block:'nearest' 是"能看见就行"，不会把页面猛拉到顶上。
  accTabYggdrasilEl.closest('.acc')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

  if (accTab === 'yggdrasil') {
    if (!accServerEl.value) accServerEl.value = yggdrasilDefaultServer
    if (launchInfo?.account?.type === 'yggdrasil') accUserEl.value = launchInfo.account.name
    ;(accUserEl.value ? accPassEl : accUserEl).focus()
  } else if (accTab === 'microsoft') {
    accMsLoginEl.focus()
  } else {
    accInputEl.focus()
  }
}

// ——— 正版登录（微软，M13）———

/** 登录中：按钮变灰防连点 */
let msLoggingIn = false

function setMsHint(text, kind = '') {
  accMsHintEl.textContent = text || ''
  accMsHintEl.hidden = !text
  accMsHintEl.classList.toggle('acc__hint--error', kind === 'error')
  accMsHintEl.classList.toggle('acc__hint--ok', kind === 'ok')
}

/** 没填客户端 ID 的时候，直接把"该去哪儿弄"摆出来 */
function renderMicrosoftPane() {
  const hasId = Boolean(launchInfo?.microsoftClientId)
  accMsGoSetupEl.hidden = hasId
  if (!hasId) {
    setMsHint('还没填客户端 ID。照着 docs/09 注册一个（免费，十分钟），填进「设置 → 账号」就能用了。', '')
  } else if (launchInfo?.account?.type !== 'microsoft') {
    setMsHint('点上面那个按钮，会弹出微软自己的登录页。密码是输在那儿的，毛球碰不到。', '')
  }
}

async function doMicrosoftLogin() {
  if (msLoggingIn) return

  if (!launchInfo?.microsoftClientId) {
    setMsHint('还没填客户端 ID。照着 docs/09 注册一个（免费，十分钟），填进「设置 → 账号」就能用了。', 'error')
    accMsGoSetupEl.hidden = false
    return
  }

  msLoggingIn = true
  accMsLoginEl.disabled = true
  accMsLoginEl.textContent = '登录中…'
  setMsHint('正在打开微软的登录页…', '')

  try {
    const result = await window.api.loginMicrosoft()

    if (!result.ok) {
      // 用户自己关掉窗口不算出错，别用红字吓人
      setMsHint(result.error, result.cancelled ? '' : 'error')
      return
    }

    if (launchInfo) {
      launchInfo.account = result.account
      launchInfo.accountKey = `${result.account.type}:${result.account.uuid}`
    }
    renderAccountCard()
    setMsHint(`登录成功，现在是「${result.account.name}」`, 'ok')
    setNotice(`已登录：${result.account.name}`, 'ok')
  } catch (error) {
    setMsHint(`登录时出了点意外：${error.message}`, 'error')
  } finally {
    msLoggingIn = false
    accMsLoginEl.disabled = false
    accMsLoginEl.textContent = '用微软账号登录'
    refreshLaunchUi()
  }
}

accTabMicrosoftEl.addEventListener('click', () => setAccTab('microsoft'))

// ——— 账号弹窗（M17.5）———
//
// 账号卡原来在启动页左边，但设计稿里首页左边只有「版本选择」，
// 账号在侧栏头像那边。所以把它挪进弹窗，点左上角头像打开。
const accModalEl = document.getElementById('acc-modal')

function openAccountModal() {
  accModalEl.hidden = false
  renderAccountCard()
  setAccTab(accTab) // 让那张表按当前状态显示（顺便把焦点放到该放的地方）
}

document.querySelector('.rail__brand')?.addEventListener('click', openAccountModal)
document.getElementById('acc-close').addEventListener('click', () => {
  accModalEl.hidden = true
})

// 点弹窗外面那层黑也能关（跟别的弹窗一个手感）
accModalEl.addEventListener('click', (event) => {
  if (event.target === accModalEl) accModalEl.hidden = true
})
accMsLoginEl.addEventListener('click', doMicrosoftLogin)
accMsGoSetupEl.addEventListener('click', () => {
  // 直接把人送到该填的地方，别让他自己在设置里找
  showPage('settings')
  showSettingsTab('account')
  msClientIdEl.focus()
})

// ——— 设置页 · 账号：客户端 ID（M13）———

const msClientIdEl = document.getElementById('ms-client-id')
const msClientIdSaveEl = document.getElementById('ms-client-id-save')
const msClientIdHintEl = document.getElementById('ms-client-id-hint')

function renderMicrosoftClientId() {
  const id = launchInfo?.microsoftClientId || ''
  // 用户正在改的话别去覆盖他手里的字
  if (document.activeElement !== msClientIdEl) msClientIdEl.value = id

  msClientIdHintEl.textContent = id
    ? '已保存。到「启动」页左边点「正版」，就能用微软账号登录了。'
    : '还没填。注册步骤在项目目录的 docs/09-正版登录申请步骤.md 里'
  msClientIdHintEl.classList.toggle('acc__hint--ok', Boolean(id))
}

msClientIdSaveEl.addEventListener('click', async () => {
  const result = await window.api.setMicrosoftClientId(msClientIdEl.value)

  if (!result.ok) {
    msClientIdHintEl.textContent = result.error
    msClientIdHintEl.classList.remove('acc__hint--ok')
    return
  }

  if (launchInfo) launchInfo.microsoftClientId = result.clientId
  renderMicrosoftClientId()
  if (accTab === 'microsoft') renderMicrosoftPane()
})

async function doYggdrasilLogin() {
  if (loggingIn) return

  const server = accServerEl.value.trim()
  const username = accUserEl.value.trim()
  const password = accPassEl.value

  if (!username) {
    setLoginHint('先填账号（一般是你注册时用的邮箱）', 'error')
    accUserEl.focus()
    return
  }
  if (!password) {
    setLoginHint('先填密码', 'error')
    accPassEl.focus()
    return
  }

  loggingIn = true
  accLoginBtnEl.disabled = true
  accLoginBtnEl.textContent = '登录中…'
  setLoginHint('正在问服务器要令牌…', '')

  try {
    const result = await window.api.loginYggdrasil({ server, username, password })

    if (!result.ok) {
      setLoginHint(result.error, 'error')
      return
    }

    if (launchInfo) launchInfo.account = result.account
    if (launchInfo) launchInfo.accountKey = `${result.account.type}:${result.account.uuid}`
    accPassEl.value = '' // 密码用完就清掉，别留在界面上
    renderAccountCard()
    setLoginHint(result.note || `登录成功，现在是「${result.account.name}」`, 'ok')
    setNotice(`已登录：${result.account.name}`, 'ok')
  } catch (error) {
    setLoginHint(`登录时出了点意外：${error.message}`, 'error')
  } finally {
    loggingIn = false
    accLoginBtnEl.disabled = false
    accLoginBtnEl.textContent = '登录'
    refreshLaunchUi()
  }
}

accTabOfflineEl.addEventListener('click', () => setAccTab('offline'))
accTabYggdrasilEl.addEventListener('click', () => setAccTab('yggdrasil'))
accLoginBtnEl.addEventListener('click', doYggdrasilLogin)

// 三个框里按回车都能登录——省得每次都去点按钮
for (const el of [accServerEl, accUserEl, accPassEl]) {
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') doYggdrasilLogin()
  })
}

accSignoutEl.addEventListener('click', async () => {
  const account = launchInfo?.account
  if (account?.type !== 'yggdrasil' && account?.type !== 'microsoft') return

  const extra =
    account.type === 'yggdrasil'
      ? '那个网站上的角色和皮肤不受影响。'
      : '你的微软账号和已经买的游戏都不受影响。'

  const yes = window.confirm(
    `要在这台电脑上退出「${account.name}」吗？\n\n` +
      '账号和令牌会从本机删掉，下次要用得重新登录一次（密码我们本来就没存）。\n' +
      extra
  )
  if (!yes) return

  const result = await window.api.removeAccount(launchInfo.accountKey || '')
  if (!result.ok) {
    setNotice(result.error, 'error')
    return
  }

  if (launchInfo) {
    launchInfo.account = result.account
    launchInfo.accountKey = result.account ? `${result.account.type}:${result.account.uuid}` : ''
  }
  accPassEl.value = ''
  renderAccountCard()
  setLoginHint('已经退出了。要换账号就重新填一次。', '')
  // 文案跟着账号类型走。这里原来写死了"外置账号"，
  // 结果退正版账号时也说"已退出外置账号"（2026-10-08 用户实际看到并指出）
  setNotice(account.type === 'microsoft' ? '已退出正版账号。' : '已退出外置账号。', 'ok')
  refreshLaunchUi()
})

// 默认服务器地址（拿不到也不影响——输入框里有占位文字顶着）
if (window.api.yggdrasilDefaultServer) {
  window.api
    .yggdrasilDefaultServer()
    .then((value) => {
      if (value) yggdrasilDefaultServer = value
      if (!accServerEl.value) accServerEl.value = yggdrasilDefaultServer
    })
    .catch(() => {})
}

/** 版本列表（跨所有游戏目录，来自主进程） */
function versionList() {
  return launchInfo?.versions || []
}

/** 两个目录路径是不是同一个（界面上只用来配对，粗一点没关系） */
function samePath(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase()
}

/** 按"版本号 + 目录"找一项 */
function findVersion(id, dir) {
  return versionList().find((one) => one.id === id && samePath(one.dir, dir)) || null
}

/** 当前选中项在配置里的键（主进程按它找"这个版本单独设过什么"） */
function selectedKey() {
  return findVersion(selectedVersion, selectedDir)?.key || selectedVersion
}

/** 当前选中项（没有就是 null） */
function selectedItem() {
  return findVersion(selectedVersion, selectedDir)
}

/**
 * 大启动卡上那行小字：正式版 · Forge · 默认目录。
 * 版本是快照、装了加载器、在别的目录——这些一眼能看到，省得点进版本设置去查。
 */
function heroMetaOf(one) {
  const parts = []
  if (one.type) parts.push(VERSION_TYPE_LABELS[one.type] || one.type)
  if (one.loader) parts.push(one.loader)
  if (one.category) parts.push(one.category)
  parts.push(one.isDefault ? '默认目录' : dirTail(one.dir))
  return parts.join(' · ')
}

/**
 * 版本在按钮上显示成什么。
 *
 * 太长的话按钮会被撑变形（整合包的名字动不动就二十几个字），
 * 所以超过 12 个字就截断加省略号——完整名字在左边列表和「当前版本」卡片上还能看到。
 */
function shortVersionLabel(one) {
  const text = one.name || one.id || ''
  return text.length > 12 ? `${text.slice(0, 12)}…` : text
}

/** 目录路径的最后一段，给用户看的（D:\我的世界\.minecraft → .minecraft） */
function dirTail(dir) {
  const parts = String(dir || '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || String(dir || '')
}

/**
 * 渲染左侧那一列版本。
 *
 * 【为什么默认只显示一个】版本一多，这一列会一直往下排，把下面的「版本设置」
 * 顶到屏幕外面（用户实测反馈）。所以收起来时只显示当前选中的那个，
 * 点标题右边的箭头才展开全部——展开后列表自己也带滚动条，最多占 38% 屏高。
 */
function renderPickList() {
  const all = versionList()
  const current = selectedItem()

  // 收藏的排前面（sort 是稳定的，所以收藏之间还是原来的顺序）
  const sorted = [...all].sort((a, b) => Number(b.favorite) - Number(a.favorite))

  pickListEl.textContent = ''
  pickEmptyEl.hidden = all.length > 0

  // 收起时：只显示选中的那个。没选中（比如刚删掉）就显示前一个，免得列表空着
  const shown = pickerOpen || !current ? sorted : [current]

  const frag = document.createDocumentFragment()
  for (const one of shown) {
    const li = document.createElement('li')
    li.className =
      one.id === selectedVersion && samePath(one.dir, selectedDir)
        ? 'pick__item pick__item--on'
        : 'pick__item'
    li.dataset.version = one.id
    li.dataset.dir = one.dir

    // 用户起过名字就显示名字（后面带上版本号，免得对不上）；
    // 没起过就显示版本号本身
    const label = document.createElement('span')
    const icon = one.icon ? `${one.icon} ` : ''
    // 版本名太长（fabric-loader-…）时，后面缀个加载器名，一眼知道这是什么
    label.textContent =
      icon +
      (one.name
        ? `${one.name}（${one.id}）`
        : one.loader
          ? `${one.id}（${one.loader}）`
          : one.id)

    // 有分类的话挂个小标签（浅灰），和"目录标签"区分开
    if (one.category) {
      const cat = document.createElement('em')
      cat.className = 'pick__cat'
      cat.textContent = one.category
      label.appendChild(cat)
    }
    li.appendChild(label)

    // 不是默认目录里的版本，名字后面挂个小标签说明它在哪个目录
    if (!one.isDefault) {
      const tag = document.createElement('em')
      tag.className = 'pick__dir'
      tag.textContent = dirTail(one.dir)
      tag.title = one.dir
      li.appendChild(tag)
    }

    frag.appendChild(li)
  }

  pickListEl.appendChild(frag)

  // 箭头：展开着就是"往上"，收着就是"往下"
  pickToggleIconEl.textContent = pickerOpen ? '▴' : '▾'
  pickToggleEl.setAttribute('aria-expanded', pickerOpen ? 'true' : 'false')
  pickToggleEl.title = pickerOpen ? '收起版本列表' : `展开版本列表（一共 ${all.length} 个）`
}

/**
 * 现在这个账号能不能用来启动？不能就返回"缺什么"（中文），能就返回空字符串。
 *
 * 【两种表单判断标准不一样】离线看的是名字框填没填对，
 * 外置登录看的是"登进去没有"——名字框那边是什么内容跟外置账号没关系。
 */
function accountProblem() {
  if (accTab === 'yggdrasil') {
    if (launchInfo?.account?.type === 'yggdrasil') return ''
    return '点左上角的头像登录一个外置账号，按钮就能点了'
  }
  if (accTab === 'microsoft') {
    if (launchInfo?.account?.type === 'microsoft') return ''
    return '点左上角的头像用微软账号登录，按钮就能点了'
  }

  const typed = accInputEl.value.trim()
  if (!typed) return '点左上角的头像填个游戏名字，按钮就能点了'
  return nameProblem(typed)
}

/** 按当前状态刷新整个启动页（按钮能不能点、版本列表、信息卡） */
function refreshLaunchUi() {
  const problem = accountProblem()
  const picked = selectedItem()

  // 【没装版本时这个按钮换个身份】用户要求：一个版本都没装的时候，
  // 按钮不该是灰着的"开始游戏"，而应该是能点的「下载一个版本」，点一下直接去下载页。
  // 所以这时候既不置灰、也不看账号有没有问题——反正点下去是跳页面，不是启动游戏。
  const noVersions = !selectedVersion

  launchBtnEl.disabled = launching || (!noVersions && Boolean(problem))

  // 按钮上直接写清楚"要启动的是哪个版本"——不用回头看左边列表
  // （对照 PCL 整理的 ⭐⭐⭐ 项：PCL 那个大按钮里就写着版本名）
  launchBtnEl.textContent = launching
    ? '游戏运行中…'
    : noVersions
      ? '下载一个版本'
      : picked
        ? `开始游戏 · ${shortVersionLabel(picked)}`
        : '开始游戏'

  // 没选版本就没得设置
  verSettingsBtnEl.disabled = !selectedVersion

  // 按钮点不了的时候，直接把"缺什么"写在旁边——
  // 光把按钮变灰，用户只能自己猜（实测时用户就问过"为什么点不了"）
  let tip = ''
  if (!launching) {
    if (!selectedVersion) tip = '一个版本都还没装 —— 点上面那个按钮，去下载页挑一个'
    else if (problem) tip = problem
  }
  launchTipEl.textContent = tip
  launchTipEl.hidden = tip === ''

  factVersionEl.textContent = selectedVersion || '—'

  // 四格卡片是能点的（M19）：一个版本都没装的时候没什么可管，就别装成能点的样子
  for (const button of factButtonEls) button.disabled = !selectedVersion

  // ——— 大启动卡上那两行（M14.2）———
  {
    const one = picked
    heroNameEl.textContent = one ? one.name || one.id : '还没有装版本'
    heroMetaEl.textContent = one ? heroMetaOf(one) : '先去「下载」页装一个'
  }

  if (launchInfo) {
    // 内存和游戏目录都要按"这个版本实际用的"显示——
    // 版本可能自己单独设过（见版本设置），不能只显示全局值。
    // 键要用 selectedKey()（目录 + 版本号），光用版本号会在两个目录有同名版本时认错人
    const override = launchInfo.versionSettings?.[selectedKey()] || {}
    const ownMemory = Number(override.memoryMB) > 0
    const memoryMB = ownMemory ? override.memoryMB : launchInfo.memoryMB
    factMemoryEl.textContent =
      `${memoryMB} MB` +
      (ownMemory ? '（这个版本单独设的）' : launchInfo.memoryAuto ? '（自动）' : '')

    const isolated =
      typeof override.isolation === 'boolean' ? override.isolation : launchInfo.isolation
    // 记下来给"点目录卡片"用（要和卡片上显示的那个路径保持一致）
    selectedIsolated = isolated
    // 游戏目录要用**这个版本自己那个**目录，不是默认目录
    const base = selectedDir || launchInfo.gameDir
    factDirEl.textContent = isolated ? `${base}\\versions\\${selectedVersion}` : base

    const java = launchInfo.java
    factJavaEl.textContent = java.found
      ? `${java.version}（${shortJavaSource(java.source)}）`
      : java.error || '还没找到——装好版本后会自动带上'

    // 「当前版本」那张卡（M17.5：首页上不再显示它）
    //
    // 【为什么拿掉了】设计稿的首页是"大启动卡 + 四格 + [版本选择 | 皮肤预览]"，
    // **没有这张卡**——版本的名字、备注这些，设计稿里归「版本设置」那个弹窗管。
    // 而且实测：留着它首页会多出 90px，正好把皮肤预览挤出屏幕（用户看到过半个皮肤）。
    // 内容照样算好（下面的 else 分支），哪天想放回去，把 hidden 那行改回来就行。
    currentVersionPanelEl.hidden = true
    if (selectedVersion) {
      const info = selectedItem() || {}
      // 名字后面缀上"正式版/快照"——光看版本号分不出来（对照 PCL 整理的 ⭐⭐⭐ 项）
      const typeLabel = VERSION_TYPE_LABELS[info.type] || ''
      curNameEl.textContent =
        (info.name ? `${info.name}（${selectedVersion}）` : selectedVersion) +
        (typeLabel ? ` · ${typeLabel}` : '')
      curNoteEl.textContent = info.note || ''
      curNoteEl.hidden = !info.note
      curHintEl.textContent = info.isDefault
        ? '想改名字、写备注、打开存档文件夹或者删掉它：点左下角的「版本设置」'
        : `这个版本在 ${info.dir} 里。想改名字、写备注、打开存档文件夹或者删掉它：点左下角的「版本设置」`
    }
  }

  renderAccountCard()
  renderPickList()
}

/** Java 从哪来的，一句话说清楚（后端给的原文太长，套在一起读着别扭） */
function shortJavaSource(source) {
  const text = String(source || '')
  if (text.includes('手动')) return '手动指定'
  if (text.includes('本机已有')) return '本机已有的'
  return '版本自带'
}

/** 当前选中的版本有没有开版本隔离（四格卡片点"目录"时要按它决定打开哪个文件夹） */
let selectedIsolated = false

// ——— 四格卡片：点一下去做对应的事（M19）———
//
// 【为什么做成能点的】用户 2026-10-09 反馈"这几个卡片点不了，鼠标放上边也没反应"。
// 这四格本来只是"现在的状态"，看着不对劲也没处下手；做成入口之后，
// 内存小了、Java 不对，当场就能点进去改。
const factButtonEls = document.querySelectorAll('.fact[data-fact]')

for (const button of factButtonEls) {
  button.addEventListener('click', () => onFactClick(button.dataset.fact))
}

async function onFactClick(kind) {
  if (!selectedVersion) return

  if (kind === 'version') {
    openVersionSettings()
    return
  }

  // Java：直接开「选择 Java 运行环境」（M20 加的）。
  // 以前是跳到版本设置里高亮那一行——但那行只是个"显示"，改不了，
  // 用户点进去还得自己找下一步；现在一步到位。
  if (kind === 'java') {
    openJavaPicker(selectedVersion, selectedDir)
    return
  }

  if (kind === 'memory') {
    showPage('settings')
    showSettingsTab('launch')
    flashAt(document.getElementById('panel-memory'))
    return
  }

  if (kind === 'dir') {
    // 打开的就是卡片上写着的那一个：
    // 开了隔离 → versions\<版本号>\；没开 → 这个版本所在的游戏目录
    const result = await window.api.openVersionFolder(
      selectedVersion,
      selectedIsolated ? 'version' : 'gamedir',
      selectedDir
    )
    if (!result.ok) setNotice(`打不开文件夹：${result.error}`, 'error')
  }
}

/** 让某一块闪一圈光——点了卡片跳过来之后，告诉用户"看这儿" */
function flashAt(el) {
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.remove('flash-hi')
  void el.offsetWidth // 强制重排一下，连点两次才会重新播动画
  el.classList.add('flash-hi')
  setTimeout(() => el.classList.remove('flash-hi'), 1800)
}

/** 只把启动页的信息重新读一遍并刷新（比如刚在版本设置里改了内存） */
async function refreshLaunchFacts() {
  try {
    launchInfo = await window.api.getLaunchInfo()
  } catch {
    return
  }
  refreshLaunchUi()
}

/** 进启动页（或回到启动页）时读一遍最新状态 */
async function loadLaunchPage() {
  try {
    launchInfo = await window.api.getLaunchInfo()
  } catch (error) {
    setNotice(`启动页的信息读不出来：${error.message}`, 'error')
    return
  }

  // 选中的那个版本还在不在？（要连目录一起对——两个目录可能有同名版本）
  if (!selectedItem()) {
    // 优先回到"上次启动过的那个"（主进程存的是带目录的键），否则用列表第一个
    const last = launchInfo.lastVersion || ''
    const match = versionList().find((one) => one.key === last)
    const pickOne = match || versionList()[0] || null
    selectedVersion = pickOne ? pickOne.id : ''
    selectedDir = pickOne ? pickOne.dir : ''
  }

  // 只在第一次把存下来的**离线**账号填进名字框，别把用户正在敲的字冲掉。
  // 外置账号的名字是服务器给的、不能改，填进去反而会让人以为"改了名字就能换账号"
  const savedType = launchInfo.account?.type
  if (!accInputEl.value && launchInfo.account && (!savedType || savedType === 'offline')) {
    accInputEl.value = launchInfo.account.name
  }

  // 第一次进来时，账号卡片跟着"当前账号是什么"显示对应的表单；
  // 之后就不再动它了（用户点过哪张就停在哪张）
  if (!accTabInitialized) {
    accTabInitialized = true
    const type = launchInfo.account?.type
    setAccTab(type === 'yggdrasil' || type === 'microsoft' ? type : 'offline', { focus: false })
  }

  refreshLaunchNotice()
  refreshLaunchUi()
}

/**
 * 启动页顶上那行提示，按"现在到底有没有版本"来说话。
 *
 * 【为什么要单独抽出来】以前这段只在"进启动页"的时候跑一次。
 * 于是拖个整合包装完，版本都已经选上了，那行字还写着
 * "还没有装过版本"——界面自己打自己的脸（实测反馈过）。
 * 凡是会改变"本机有几个版本"的地方，装完都要再喊一声这个函数。
 */
function refreshLaunchNotice() {
  if (launching) return

  if (versionList().length === 0) {
    setNotice('这里还空着——去「下载」页挑个版本装上，回来就能开玩了。')
  } else {
    setNotice('点左上角的头像填个游戏名字、选一个版本，就可以点「开始游戏」了。')
  }
}

/**
 * 游戏的日志在控制台里是 log4j 的 XML 格式（一段一段的标签），
 * 直接显示像乱码。这里把它翻译成游戏自己 latest.log 里那种
 * 「[时间] [线程/级别]: 消息」的纯文字。
 *
 * 【为什么不干脆改游戏输出】那是 Mojang 官方配置的行为，不该动。
 * 而且我们只是"显示"时翻译，存到硬盘的日志保持原样，排查问题不吃亏。
 */
let currentLogEvent = null

function prettifyLogLine(raw) {
  // 一条日志的开始：<log4j:Event logger="…" timestamp="…" level="…" thread="…">
  const event = raw.match(
    /<log4j:Event\s+logger="([^"]*)"\s+timestamp="(\d+)"\s+level="([^"]*)"\s+thread="([^"]*)"/
  )
  if (event) {
    currentLogEvent = {
      logger: event[1],
      at: Number(event[2]),
      level: event[3],
      thread: event[4]
    }
    return []
  }

  // 日志正文：<log4j:Message><![CDATA[……]]></log4j:Message>
  const message = raw.match(/<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Message>/)
  if (message) {
    const when = currentLogEvent ? clockOf(currentLogEvent.at) : ''
    const thread = currentLogEvent?.thread ?? ''
    const level = currentLogEvent?.level ?? ''
    return [`${when} [${thread}/${level}]: ${message[1]}`]
  }

  // 报错的堆栈：<log4j:Throwable><![CDATA[ 开头，里面的内容照原样显示
  const throwable = raw.match(/<log4j:Throwable><!\[CDATA\[([\s\S]*)$/)
  if (throwable) return throwable[1] ? [throwable[1]] : []

  // 堆栈结束的标记行（]]></log4j:Throwable>），不用显示
  if (/^\s*\]\]><\/log4j:Throwable>\s*$/.test(raw)) return []

  // 其他纯包装行（</log4j:Event> 之类），不显示
  if (/^\s*<\/log4j:/.test(raw)) return []

  // 启动器自己写的行（[启动器] …）和 CDATA 里的堆栈，原样显示
  return [raw]
}

function clockOf(timestamp) {
  const d = new Date(timestamp)
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`
}

function appendLog(lines) {
  for (const raw of lines) logLines.push(...prettifyLogLine(raw))
  if (logLines.length > MAX_UI_LOG_LINES) logLines = logLines.slice(-MAX_UI_LOG_LINES)

  // 日志只存在内存里，由顶栏的「日志」按钮打开看（M7：启动页不再常驻日志面板）
  if (!logModalEl.hidden) {
    if (logModalMode !== 'live') {
      logModalMode = 'live'
      logTitleEl.textContent = '游戏日志（本次的实时记录）'
    }
    renderLogModal()
  }
}

accInputEl.addEventListener('input', refreshLaunchUi)

// 名字填好了、鼠标离开输入框时，顺手把账号存下来
accInputEl.addEventListener('blur', async () => {
  const name = accInputEl.value.trim()
  if (nameProblem(name)) return
  if (launchInfo?.account?.name === name) return

  const result = await window.api.setAccount(name)
  if (result.ok) {
    if (launchInfo) launchInfo.account = result.account
    renderAccountCard()
  }
})

pickListEl.addEventListener('click', (event) => {
  const item = event.target.closest('.pick__item')
  if (!item) return
  selectedVersion = item.dataset.version
  selectedDir = item.dataset.dir || ''
  // 选完就收起来——列表开着的时候它很占地方（版本一多就顶到按钮上）
  pickerOpen = false
  refreshLaunchUi()
})

// 点标题右边那个小箭头：展开 / 收起版本列表
pickToggleEl.addEventListener('click', () => {
  pickerOpen = !pickerOpen
  renderPickList()
})

// 大启动卡上那个「刷新」：重新问一遍主进程（版本列表、Java、内存这些）
// 比如用户在别处装了新版本、或者把 Java 换了，不用重开软件
document.getElementById('hero-refresh').addEventListener('click', async (event) => {
  const button = event.currentTarget
  button.disabled = true
  const original = button.textContent
  button.textContent = '刷新中…'
  try {
    await loadLaunchPage()
    setNotice('刷新好了。', 'ok')
  } finally {
    button.textContent = original
    button.disabled = false
  }
})

async function startGame() {
  if (!selectedVersion) return

  // ——— 账号：三种表单要的东西不一样 ———
  // 外置账号和微软账号都在"登录"那一步就存好了，这儿不用再存一遍
  if (accTab !== 'offline') {
    if (launchInfo?.account?.type !== accTab) {
      const which = accTab === 'yggdrasil' ? '外置账号' : '微软账号'
      setNotice(`先点左上角的头像登录一个${which}，再点「开始游戏」`, 'error')
      if (accTab === 'yggdrasil') accUserEl.focus()
      else accMsLoginEl.focus()
      return
    }
  } else {
    const name = accInputEl.value.trim()

    const problem = nameProblem(name)
    if (problem) {
      setNotice(problem, 'error')
      accInputEl.focus()
      return
    }

    // 先把账号存下来，再启动
    const saved = await window.api.setAccount(name)
    if (!saved.ok) {
      setNotice(saved.error, 'error')
      return
    }
    if (launchInfo) {
      launchInfo.account = saved.account
      launchInfo.accountKey = `${saved.account.type}:${saved.account.uuid}`
    }
    renderAccountCard()
  }

  launching = true
  refreshLaunchUi()
  setNotice(`正在启动 ${selectedVersion}…第一次启动会慢一点，稍等。`)

  const result = await window.api.startLaunch(selectedVersion, selectedDir)

  if (!result.ok) {
    launching = false
    refreshLaunchUi()
    setNotice(result.error, 'error')
    appendLog([`[启动器] 启动失败：${result.error}`])
  }
}

// 一个版本都没装的时候，这个按钮是"去下载"，不是"开始游戏"（用户点名要的）
launchBtnEl.addEventListener('click', () => {
  if (!selectedVersion) {
    showPage('download')
    return
  }
  startGame()
})

// 主进程推过来的游戏日志和状态
window.api.onLaunchLog((lines) => appendLog(lines))

window.api.onLaunchState((payload) => {
  if (payload.state === 'running') {
    launching = true
    refreshLaunchUi()
    setNotice('游戏已经启动了。这个窗口可以最小化，不影响游戏。', 'ok')
  } else if (payload.state === 'exited') {
    launching = false
    // 游戏一退，"世界对局域网开放"这件事就没了——端口清零。
    // 【为什么必须清】"有没有开局域网"就是靠 lanPort 判断的（用户定的规矩：
    // 没开局域网不许建房）。不清的话，上次玩剩的端口号会让判断一直为真，
    // 用户明明没开也能建房，那个提醒就形同虚设。
    lanPort = 0
    refreshLaunchUi()

    // 游戏一退，"世界"就没了——房间也就没用了，顺手收掉（M17.x，用户提的：
    // "我退出游戏了，但是毛球还在创建过的房间里"）。
    // 【为什么该收】好友这会儿连不上（服务端跟着世界一起没了）；而且下次开游戏
    // 端口多半会变，之前发给好友的地址也就失效了，留着只会误导人。
    if (onlineInfo.running && onlineInfo.code) {
      leaveRoomNow('游戏退出了，房间也顺手收了 —— 下次要联机，进游戏开局域网后重新建一个。')
    }
    if (payload.ok) {
      setNotice('游戏正常退出了。可以再点「开始游戏」重新玩。', 'ok')
    } else {
      const logHint = payload.logFile ? `\n完整日志：${payload.logFile}` : ''
      setNotice(`${payload.title}。${payload.hint}${logHint}`, 'error')
    }
  } else if (payload.state === 'error') {
    launching = false
    refreshLaunchUi()
    setNotice(payload.error, 'error')
  } else if (payload.state === 'lan-closed') {
    // 退出存档了（回到主菜单）——端口作废。
    // 【为什么不顺手退房】用户换个世界重开、再按一次「对局域网开放」就会报个新端口上来，
    // 房间还能接着用，退了反而要他重建。这里只把"发给好友的地址"收掉。
    lanPort = 0
    if (onlineInfo.running) renderOnline()
    appendLog(['[启动器] 世界关掉了（退出存档），之前那个发给好友的地址作废了'])
  } else if (payload.state === 'lan') {
    // 游戏里点了「对局域网开放」——拿到端口号，把它变成"发给好友的地址"
    lanPort = payload.port
    // 樱花那块也顺手填上（大部分人的隧道就是指向这个端口）
    if (frpPortEl && !frpRunning) frpPortEl.value = String(payload.port)
    appendLog([`[启动器] 你的世界已经对局域网开放（端口 ${payload.port}）`])
    if (onlineInfo.running) {
      // 在房间里：直接把"发给好友的地址"显示出来
      renderOnline()
      setNotice(`世界开好了！把地址 ${HOST_VIRTUAL_IP}:${payload.port} 发给好友。`, 'ok')
    }
  }
})

// ═══════════════════════════════════════
// 下载页：社区资源（M9，来自 Modrinth）
// ═══════════════════════════════════════

const dlMenuEl = document.getElementById('dl-menu')
const dlTabs = document.querySelectorAll('.dl-tab')
const mrSearchEl = document.getElementById('mr-search')
const mrVersionEl = document.getElementById('mr-version')
const mrListEl = document.getElementById('mr-list')
const mrStatusEl = document.getElementById('mr-status')
const mrDoneEl = document.getElementById('mr-done')
const mrDoneTextEl = document.getElementById('mr-done-text')

/** 当前在看哪个社区分类：mod / resourcepack / shader */
let mrType = 'mod'
/** 版本筛选：auto = 只搜当前选中的游戏版本；all = 所有版本 */
let mrVersionMode = 'auto'
/** 有没有在搜/在下 */
let mrBusy = false
/** 上一次下载的结果（「打开文件夹」要用） */
let mrLastResult = null

const MR_TYPE_NAMES = {
  mod: 'Mod',
  modpack: '整合包',
  datapack: '数据包',
  resourcepack: '资源包',
  shader: '光影包'
}
/**
 * 内容类型 → 游戏里的文件夹（打开文件夹时用）。
 * 【整合包 / 数据包不在表里】它们的落点算起来不这么直白（整合包是一个版本目录、
 * 数据包藏在某个世界里面），统一交给主进程按"当初装进去的那段逻辑"重算一遍，
 * 见下面 openContentFolder 那一段。
 */
const MR_FOLDER_KEY = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks'
}

/** 搜索框里的提示语跟着分类变——不然用户在整合包分类里看到"比如 sodium"会懵 */
const MR_PLACEHOLDERS = {
  mod: '搜索，比如 sodium、光影名…',
  modpack: '搜索整合包，比如 匠魂、RLCraft…',
  datapack: '搜索数据包，比如 更好的刷怪…',
  resourcepack: '搜索资源包，比如 舒服细致…',
  shader: '搜索光影，比如 光子、BSL…'
}

/** 切"只搜当前版本 / 所有版本"那两个小按钮（含高亮） */
function setMrVersionMode(mode) {
  mrVersionMode = mode
  for (const chip of mrVersionEl.children) {
    chip.classList.toggle('chip--on', chip.dataset.mrVersion === mode)
  }
}

/** "装到哪个世界"那个弹窗里的几个零件 */
const saveModalEl = document.getElementById('save-modal')
const saveListEl = document.getElementById('save-list')
const saveHintEl = document.getElementById('save-hint')

/** 该把东西放到哪个版本里：启动页选中的那个（没选就退而用列表第一个） */
function mrTarget() {
  const one = selectedItem() || versionList()[0] || null
  return { id: one ? one.id : '', dir: one ? one.dir : '' }
}

function mrTargetVersion() {
  return mrTarget().id
}

/** 搜索时用哪个游戏版本筛 */
function mrGameVersion() {
  return mrVersionMode === 'auto' ? mrTargetVersion() : ''
}

function showDownloadTab(name) {
  for (const item of dlMenuEl.querySelectorAll('.menu__item')) {
    if (!item.dataset.dlTab && !item.dataset.dlCat) continue
    const on =
      (item.dataset.dlTab && item.dataset.dlTab === name) ||
      (name === 'community' && item.dataset.dlCat === mrType)
    item.classList.toggle('menu__item--on', Boolean(on))
  }
  for (const tab of dlTabs) tab.hidden = tab.dataset.dlTab !== name
}

dlMenuEl.addEventListener('click', (event) => {
  const item = event.target.closest('.menu__item')
  if (!item) return

  if (item.dataset.dlCat) {
    mrType = item.dataset.dlCat
    // 整合包**自带游戏版本和加载器**，拿"你现在选的那个版本"去筛它没道理
    // （筛完基本是空的，用户会以为"整合包搜不到东西"），进这个分类自动切到"所有版本"
    if (mrType === 'modpack' && mrVersionMode === 'auto') setMrVersionMode('all')
    mrSearchEl.placeholder = MR_PLACEHOLDERS[mrType] || MR_PLACEHOLDERS.mod
    showDownloadTab('community')
    runMrSearch()
  } else if (item.dataset.dlTab === 'vanilla') {
    showDownloadTab('vanilla')
  } else if (item.dataset.dlTab === 'installed') {
    showDownloadTab('installed')
    renderInstalled()
  }
})

/** 下载量：太长的数字换成人话（2.38 亿） */
function formatCount(n) {
  if (n >= 100000000) return `${(n / 100000000).toFixed(2)} 亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`
  return String(n)
}

function formatUpdated(iso) {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return '今天更新'
  if (days < 30) return `${days} 天前更新`
  if (days < 365) return `${Math.floor(days / 30)} 个月前更新`
  return `${Math.floor(days / 365)} 年前更新`
}

function renderMrList(hits) {
  mrListEl.textContent = ''

  if (hits.length === 0) {
    const li = document.createElement('li')
    li.className = 'ver'
    li.style.justifyContent = 'center'
    li.style.color = 'var(--text-muted)'
    li.textContent = '没搜到东西，换个词、或者把筛选换成「所有版本」'
    mrListEl.appendChild(li)
    return
  }

  const frag = document.createDocumentFragment()

  for (const hit of hits) {
    const li = document.createElement('li')
    li.className = 'ver mr'

    // 图标（Modrinth 的 cdn 上）。加载不出来也不影响用，空着就行
    const icon = document.createElement('img')
    icon.className = 'mr__icon'
    icon.alt = ''
    icon.loading = 'lazy'
    if (hit.icon) icon.src = hit.icon
    li.appendChild(icon)

    const main = document.createElement('div')
    main.className = 'mr__main'

    const title = document.createElement('div')
    title.className = 'mr__title'
    // 认得出来的显示成「钠（Sodium）」——中文名在前、英文原名保留，
    // 认不出来的就照原样显示英文名，不瞎编翻译；
    // 中文名和英文名一样（Fabric API 这种）就只显示一遍
    title.textContent =
      hit.nameZh && hit.nameZh !== hit.title ? `${hit.nameZh}（${hit.title}）` : hit.title
    main.appendChild(title)

    const desc = document.createElement('div')
    desc.className = 'mr__desc'
    desc.textContent = hit.description
    main.appendChild(desc)

    const meta = document.createElement('div')
    meta.className = 'mr__meta'
    const parts = [`${formatCount(hit.downloads)}次下载`]
    if (hit.categories.length > 0) parts.push(hit.categories.slice(0, 4).join(' / '))
    const updated = formatUpdated(hit.updated)
    if (updated) parts.push(updated)
    meta.textContent = parts.join(' · ')
    main.appendChild(meta)

    li.appendChild(main)

    const button = document.createElement('button')
    button.className = 'btn btn--primary btn--sm'
    button.type = 'button'
    button.dataset.mrInstall = hit.id
    button.dataset.mrTitle = hit.title
    button.dataset.mrNameZh = hit.nameZh || ''
    button.textContent = '下载'
    li.appendChild(button)

    frag.appendChild(li)
  }

  mrListEl.appendChild(frag)
}

async function runMrSearch() {
  if (mrBusy) return
  mrBusy = true
  mrDoneEl.hidden = true
  mrListEl.textContent = ''

  const gameVersion = mrGameVersion()
  mrStatusEl.textContent = `正在搜索${MR_TYPE_NAMES[mrType] || ''}…`

  let result
  try {
    result = await window.api.searchModrinth({
      type: mrType,
      query: mrSearchEl.value.trim(),
      gameVersion
    })
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) }
  }
  mrBusy = false

  if (!result.ok) {
    mrStatusEl.textContent = `搜索失败：${result.error}`
    return
  }

  renderMrList(result.hits)

  const info = launchInfo?.versionInfo?.[mrTargetVersion()] || {}
  const scope = gameVersion ? `只显示支持 ${info.base || gameVersion} 的` : '所有版本'
  let status = `共 ${result.total} 个结果 · ${scope}`

  if (mrType === 'mod') {
    status += info.loader
      ? ` · 当前版本用的是 ${info.loader}，只显示 ${info.loader} 版的 Mod`
      : ' · 这个版本还没装 Mod 加载器——到「版本设置」里装一个，Mod 才能用'
  } else if (mrType === 'modpack') {
    status += ' · 整合包会装成一个「新版本」，不动你现在装的'
  } else if (mrType === 'datapack') {
    status += ' · 数据包是装进「某一个世界」里的，点下载后会让你挑'
  }
  mrStatusEl.textContent = status
}

/** 装数据包时用户挑的那个世界（挑完再调一次 installMrProject 就带上它）*/
let pendingSaveName = ''
/** 那个世界在哪个 saves 文件夹里（版本自己的、还是公共的——见 showSavePicker） */
let pendingSaveFolder = ''

/** 时间戳 → "8月9日 17:30" 这种短写法 */
function shortWhen(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 弹出"装到哪个世界"的列表（只有数据包会走这儿）。
 * 【为什么让用户挑】数据包放进 `saves\<世界>\datapacks\` 才生效，
 * 装到别的世界就跟没装一样——不问清楚，用户会以为"下载成功了怎么没用"。
 */
async function showSavePicker(button) {
  const target = mrTarget()
  let res
  try {
    res = await window.api.listSaves(target.id, target.dir)
  } catch (error) {
    mrStatusEl.textContent = `读存档列表失败：${error.message}`
    return
  }
  if (!res.ok) {
    mrStatusEl.textContent = `读存档列表失败：${res.error}`
    return
  }
  if (!res.saves.length) {
    mrStatusEl.textContent = '你还没有存档 —— 先在游戏里建一个世界并存过盘，再回来装数据包'
    return
  }

  // 世界的存档可能在两个地方（版本自己的 saves、公共的 .minecraft\saves），
  // 两边都有的时候得标出来——不然"同一个世界怎么出现两次"会让人犯迷糊
  const mixed = new Set(res.saves.map((one) => one.where)).size > 1

  saveListEl.textContent = ''
  for (const one of res.saves) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'save-item'

    const name = document.createElement('span')
    name.className = 'save-item__name'
    name.textContent = one.name

    const when = document.createElement('span')
    when.className = 'save-item__when'
    when.textContent =
      '上次玩 ' + shortWhen(one.mtime) + (mixed ? ` · ${one.where}的存档` : '')

    item.appendChild(name)
    item.appendChild(when)
    item.addEventListener('click', () => {
      pendingSaveName = one.name
      pendingSaveFolder = one.folder
      saveModalEl.hidden = true
      installMrProject(button) // 带上存档名重来一次
    })
    saveListEl.appendChild(item)
  }

  saveHintEl.textContent = '看着列表里的世界不对？多半是这个版本的「存档文件夹」不一样——先去游戏里进一次那个世界，它就会出现在最上面。'
  saveModalEl.hidden = false
}

/** 点某一行的「下载」：自动挑文件 → 下载 → 放到该放的地方 */
async function installMrProject(button) {
  if (mrBusy) return

  const projectId = button.dataset.mrInstall
  const nameZh = button.dataset.mrNameZh
  const title = nameZh ? `${nameZh}（${button.dataset.mrTitle}）` : button.dataset.mrTitle
  const target = mrTarget()
  const versionId = target.id

  // 整合包是"给我装一个**新**版本"，所以不要求已经装过版本；
  // 别的类型（Mod / 资源包 / 数据包）得先有个版本，才知道该放进哪个目录。
  if (!versionId && mrType !== 'modpack') {
    mrStatusEl.textContent = '还没有装过游戏版本——先到「原版游戏」里装一个，才知道该放到哪'
    return
  }

  // 数据包跟**单个世界**走（不像 Mod 扔进公共文件夹就行），所以先让用户挑一个存档。
  // 挑完会把 pendingSaveName 填上、再调回这个函数一次。
  if (mrType === 'datapack' && !pendingSaveName) {
    showSavePicker(button)
    return
  }

  mrBusy = true
  installEl.hidden = false
  installTitleEl.textContent = `正在下载 ${title}`
  setStage('正在挑合适的文件…')
  setFill(0)
  setDetail('—')
  // 社区资源一般都很小，不给取消按钮（避免和"取消装版本"混在一起）
  installCancelEl.hidden = true
  mrDoneEl.hidden = true

  let result
  try {
    result = await window.api.installModrinth({
      projectId,
      type: mrType,
      versionId,
      // 挑哪个文件，按**界面上那个筛选**来（"只搜当前版本" / "所有版本"）——
      // 不然会出现"筛着 26.3 的搜索结果，装下去却是别的版本"
      gameVersion: mrGameVersion(),
      // saveName / saveFolder 只有数据包用得上（装进哪个世界）
      saveName: pendingSaveName || undefined,
      saveFolder: pendingSaveFolder || undefined,
      dir: target.dir
    })
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) }
  }
  mrBusy = false

  if (!result.ok) {
    installTitleEl.textContent = `${title} 下载失败`
    setStage('')
    setFill(0)
    setDetail(result.error)
    pendingSaveName = '' // 白挑的那个世界也忘掉，下次重新挑
    pendingSaveFolder = ''
    return
  }

  setFill(100)
  setStage('')

  // ——— 整合包：装完的结果是"版本列表里多了一个新版本" ———
  // 它跟别的不一样——不是往某个文件夹里放个文件，而是整套装出一个新版本，
  // 所以这儿要把版本列表重新读一遍、顺手把它选上，用户回启动页直接就能玩。
  if (mrType === 'modpack') {
    const fresh = result.versionId || ''
    installTitleEl.textContent = `${title} 安装完成`
    setDetail(fresh ? `版本列表里多了个「${fresh}」` : '装好了')
    mrLastResult = {
      versionId: fresh,
      type: 'modpack',
      dir: result.dir || '',
      saveName: '',
      saveFolder: ''
    }
    pendingSaveName = ''
    pendingSaveFolder = ''

    await refreshLaunchFacts()
    if (fresh) {
      const one = findVersion(fresh, result.dir || '')
      if (one) {
        selectedVersion = one.id
        selectedDir = one.dir
        refreshLaunchUi()
      }
    }

    mrDoneTextEl.textContent = fresh
      ? `${title} 装好了——版本列表里多了个「${fresh}」，回启动页选它就能玩`
      : `${title} 装好了`
    mrDoneEl.hidden = false
    mrStatusEl.textContent = `装好了：${title}`
    return
  }

  installTitleEl.textContent = `${title} 下载完成`
  const folderName = result.dir.split(/[\\/]/).pop()
  setDetail(`已放到 ${folderName} 文件夹：${result.filename}`)

  mrLastResult = {
    versionId,
    type: mrType,
    dir: target.dir,
    saveName: pendingSaveName,
    saveFolder: pendingSaveFolder
  }
  pendingSaveName = '' // 用完了清掉，下一个数据包还得重新挑
  pendingSaveFolder = ''
  mrDoneTextEl.textContent =
    mrLastResult.type === 'datapack'
      ? `${title}（${result.versionName}）已经放进世界「${mrLastResult.saveName}」里了——进游戏就能用`
      : `${title}（${result.versionName}）已经放到 ${folderName} 文件夹`
  mrDoneEl.hidden = false
}

// 列表里点「下载」
mrListEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-mr-install]')
  if (button) installMrProject(button)
})

document.getElementById('mr-do-search').addEventListener('click', runMrSearch)

// 搜索框里回车 = 搜索
mrSearchEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runMrSearch()
})

// 版本筛选
mrVersionEl.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip')
  if (!chip) return
  setMrVersionMode(chip.dataset.mrVersion)
  runMrSearch()
})

// 下载进度（和装版本共用底部那个面板）
window.api.onContentProgress((stats) => {
  setStage('正在下载…')
  setFill(stats.percent)
  setDetail(
    `${stats.percent}% · ${formatSize(stats.receivedBytes)}/${formatSize(stats.totalBytes)}` +
      ` · ${formatSpeed(stats.speed)}`
  )
})

// 打开刚下好的那个文件夹
document.getElementById('mr-open-folder').addEventListener('click', async () => {
  if (!mrLastResult) return

  // 数据包（和"刚装完的整合包"）走这条路：位置由主进程按**当初装进去时那段逻辑**
  // 重新算一遍，保证打开的就是文件真正待着的地方——数据包可能在世界自己的
  // saves 里，也可能在公共 saves 里，界面上拼不出来
  const result = mrLastResult.type === 'datapack' || mrLastResult.type === 'modpack'
    ? await window.api.openContentFolder({
        versionId: mrLastResult.versionId,
        type: mrLastResult.type,
        dir: mrLastResult.dir,
        saveName: mrLastResult.saveName,
        saveFolder: mrLastResult.saveFolder
      })
    : await window.api.openVersionFolder(
        mrLastResult.versionId,
        MR_FOLDER_KEY[mrLastResult.type],
        mrLastResult.dir
      )

  if (!result.ok) mrStatusEl.textContent = `打不开文件夹：${result.error}`
})

// 选世界那个弹窗的取消按钮（还有点灰底也能关）
function closeSavePicker() {
  saveModalEl.hidden = true
  pendingSaveName = ''
  pendingSaveFolder = ''
}

document.getElementById('save-cancel').addEventListener('click', closeSavePicker)
saveModalEl.addEventListener('click', (event) => {
  if (event.target === saveModalEl) closeSavePicker()
})

// ═══════════════════════════════════════
// 整合包：拖放安装（M11）
// ═══════════════════════════════════════

const dropzoneEl = document.getElementById('dropzone')
const packModalEl = document.getElementById('pack-modal')
const packTitleEl = document.getElementById('pack-title')
const packSummaryEl = document.getElementById('pack-summary')
const packWarnEl = document.getElementById('pack-warn')
const packProgressEl = document.getElementById('pack-progress')
const packTargetRowEl = document.getElementById('pack-target-row')
const packTargetEl = document.getElementById('pack-target')
const packInstallEl = document.getElementById('pack-install')
const packCancelEl = document.getElementById('pack-cancel')
const packNameRowEl = document.getElementById('pack-name-row')
const packNameEl = document.getElementById('pack-name')
const packNameHintEl = document.getElementById('pack-name-hint')
const packDirRowEl = document.getElementById('pack-dir-row')
const packDirEl = document.getElementById('pack-dir')
const packDirHintEl = document.getElementById('pack-dir-hint')
const packDirPickEl = document.getElementById('pack-dir-pick')
const packPwdRowEl = document.getElementById('pack-pwd-row')
const packPwdEl = document.getElementById('pack-pwd')
const packPwdHintEl = document.getElementById('pack-pwd-hint')
const packPwdTryEl = document.getElementById('pack-pwd-try')

/** 这次拖进来的是哪个文件 */
let packFilePath = ''
/** 认出来的信息 */
let packInfo = null
/** 有没有在装 */
let packInstalling = false
/**
 * 装完了没有。
 *
 * 【为什么要有这么个标记】装完之后如果按钮还写着「开始安装」，用户只会一头雾水：
 * 到底装没装完？再点一下会不会又装一遍？（用户实测反馈过这个问题。）
 * 装完就把按钮换成「完成」——点它关掉对话框，这就是"这一趟结束了"的明确信号。
 */
let packDone = false
/**
 * 这次要装到哪个游戏目录。空字符串 = 默认目录（%APPDATA%\.minecraft）。
 * 打开对话框时默认用"上次装过的那个"（主进程记着）。
 */
let packDir = ''
/** 选的这个目录里是不是还没装过游戏（用来提前说清"要重新下一份库和资源"） */
let packDirIsEmpty = false
/** 加密压缩包的密码（安装的时候每个文件都要用它解） */
let packPassword = ''

// 文件拖到窗口上时：盖一层提示（不 preventDefault 的话，浏览器会直接打开这个文件）
document.addEventListener('dragover', (event) => {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  dropzoneEl.hidden = false
})

document.addEventListener('dragleave', (event) => {
  // 在窗口内部移动也会触发 dragleave，只有真的离开窗口才收起来
  if (event.relatedTarget === null || event.clientX <= 0 || event.clientY <= 0) {
    dropzoneEl.hidden = true
  }
})

document.addEventListener('drop', async (event) => {
  event.preventDefault()
  dropzoneEl.hidden = true

  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]
  if (!file) return

  // 新版 Electron 要这样拿文件的真实路径（见 preload 里的说明）
  const filePath = window.api.pathForFile(file)
  if (!filePath) {
    setNotice('没认出这个文件是什么，拖放装不了', 'error')
    return
  }

  await openPackDialog(filePath)
})

function closePackDialog() {
  packModalEl.hidden = true
  packFilePath = ''
  packInfo = null
  packDone = false
  // 按钮和标题都恢复成"还没开始装"的样子，下次拖包进来才不会是上回的残留
  packInstallEl.textContent = '开始安装'
  packCancelEl.hidden = false
}

async function openPackDialog(filePath, password) {
  packFilePath = filePath
  packInfo = null
  packInstalling = false
  packDone = false
  // 记住密码，安装那一步还要用（加密包里每个文件都得拿它解）
  packPassword = password || ''
  // 默认装到"上次装过的那个目录"（没装过就是默认目录）
  packDir = launchInfo?.lastPackDir || ''
  packDirIsEmpty = false

  packInstallEl.textContent = '开始安装'
  packCancelEl.hidden = false
  packTitleEl.textContent = '捡到一个整合包'
  packSummaryEl.textContent = '正在翻这个压缩包，看看里面有什么…'
  packWarnEl.textContent = ''
  packProgressEl.textContent = ''
  packNameRowEl.hidden = true
  packNameEl.value = ''
  packNameHintEl.textContent = ''
  packDirRowEl.hidden = true
  packDirEl.value = ''
  packDirHintEl.textContent = ''
  renderPackDir()
  packPwdRowEl.hidden = true
  // 输了密码重试时，别把框里已经打的清掉——多半是打错一个字，改改就行
  if (!password) {
    packPwdEl.value = ''
    packPwdHintEl.textContent = ''
  }
  packTargetRowEl.hidden = true
  packInstallEl.disabled = true
  packModalEl.hidden = false

  const info = await window.api.inspectPack(filePath, password)
  if (packFilePath !== filePath) return // 看的时候又拖了别的，忽略这次

  if (!info.ok) {
    packSummaryEl.textContent = `这个文件认不出来：${info.error}`
    return
  }

  packInfo = info
  packTitleEl.textContent = info.name || '整合包'
  packSummaryEl.textContent = info.summary

  if (info.kind === 'curseforge') {
    packWarnEl.textContent =
      '这个装不了：CurseForge 整合包里的 Mod 只写了编号、没有下载地址。' +
      '（官方要求带密钥下载，而且不许把密钥放进公开软件里——不是我们偷懒。）\n' +
      '能用的办法：到 CurseForge 官网按它的清单手动下载 Mod，放进 mods 文件夹。'
    return
  }

  // ——— 带密码的：先把密码问出来，密码对了才往下认 ———
  if (info.kind === 'encrypted' && info.needPassword) {
    packTitleEl.textContent = '这个包锁着呢'
    packPwdRowEl.hidden = false
    packPwdHintEl.textContent = info.badPassword
      ? '密码不对，再想想？（一般就写在下载它的那个帖子或群公告里）'
      : ''
    packPwdHintEl.className = info.badPassword ? 'delbox delbox--warn' : 'delbox'
    packInstallEl.disabled = true
    packPwdEl.focus()
    return
  }

  // 目录都读不出来的（坏了、或者不认识的加密方式）：说清楚，别让用户干等
  if (info.kind === 'encrypted') {
    packWarnEl.textContent = info.summary || '这个压缩包打不开。'
    return
  }

  packInstallEl.disabled = false

  // 不是整合包的（存档、资源包、随便一个压缩包）：不给装，只说清楚
  if (info.kind === 'invalid') {
    packTitleEl.textContent = '这不是整合包'
    packWarnEl.textContent =
      '只支持拖入整合包：Modrinth 的 .mrpack，或者 PCL / HMCL 导出的整合包 .zip。\n' +
      '（存档、资源包、光影包这些不是整合包，装不了）'
    return
  }

  // "文件直接在里面"的整合包，要问清楚装到哪个版本
  if (info.kind === 'files' && info.layout === 'instance') {
    packTargetRowEl.hidden = false
    packTargetEl.textContent = ''

    // 列出**所有目录**里的版本，每项标着它在哪儿。
    // 选中哪个，就解到"哪个目录里的哪个版本"——所以选项上要带着 dir，
    // 光有版本号的话，两个目录有同名版本时就会装错地方（而且是悄悄装错）。
    const installed = versionList()
    for (const one of installed) {
      const option = document.createElement('option')
      option.value = one.id
      option.dataset.dir = one.dir
      option.textContent = one.isDefault ? one.id : `${one.id}（${dirTail(one.dir)}）`
      packTargetEl.appendChild(option)
    }
    const mine = installed.find((one) => one.id === selectedVersion && samePath(one.dir, selectedDir))
    packTargetEl.value = mine ? mine.id : installed[0] ? installed[0].id : ''
    if (mine) packTargetEl.selectedOptions[0].dataset.dir = mine.dir

    if (installed.length === 0) {
      packWarnEl.textContent = '本机还没装游戏版本——先到「下载」页装一个，再拖这个包'
      packInstallEl.disabled = true
    }
    return
  }

  // ——— 起名字 + 装到哪儿：这个包装完会变成"一个新的版本"，名字和目录都由用户定 ———
  // （包里自带的那个名字写在括号里当默认值，不想改就直接装）
  if (info.suggestedName) {
    packNameRowEl.hidden = false
    packNameEl.value = info.suggestedName
    packDirRowEl.hidden = false
    renderPackDir()
    await checkPackName()
  }
}

/**
 * 把"装到哪儿"那一行画出来。
 *
 * 【为什么要写这么一句提示】装到一个空目录，意味着库文件、资源文件都要**重新下一份**
 * （几百 MB 到 1 GB）。这事必须**在选完目录、点安装之前**就说清楚——
 * 等用户点了安装才发现要下 1 GB，那叫坑人。
 */
function renderPackDir() {
  const isDefault = !packDir
  packDirEl.value = isDefault
    ? `${launchInfo?.gameDir || '（默认游戏目录）'}（默认，一直用的那个）`
    : packDir
  packDirEl.title = packDir || launchInfo?.gameDir || ''

  if (isDefault) {
    packDirHintEl.textContent = ''
    packDirHintEl.className = 'delbox'
    return
  }

  packDirHintEl.textContent = packDirIsEmpty
    ? '这个目录里还没装过游戏——装的时候要把库文件、资源文件重新下一份（几百 MB 起步）。' +
      '装完它里面的版本会和默认目录里的一起出现在启动页列表里。'
    : '装完它里面的版本会和默认目录里的一起出现在启动页列表里（各自标着自己在哪个目录）。'
  packDirHintEl.className = 'delbox'
}

/**
 * 用户敲的版本名行不行。
 *
 * 名字要变成 `versions\<名字>\` 这个文件夹，能不能用（Windows 的符号规矩、
 * 是不是已经有同名版本）由主进程说了算——规矩只有那一份，
 * 这里只负责把结果写在框下面、顺便决定「开始安装」能不能点。
 */
async function checkPackName() {
  if (packNameRowEl.hidden) return true

  const result = await window.api.checkPackName(packNameEl.value, packDir)

  packNameHintEl.textContent = result.ok ? result.warning || '' : result.error
  packNameHintEl.className = result.ok ? 'delbox' : 'delbox delbox--warn'
  packInstallEl.disabled = !result.ok

  return result.ok
}

// 一边打字一边看名字行不行
packNameEl.addEventListener('input', () => {
  checkPackName()
})

// 加密包：输密码 → 点「试试」（或者直接回车）→ 拿这个密码重新认一遍
async function tryPackPassword() {
  const pwd = packPwdEl.value
  if (!pwd) {
    packPwdHintEl.textContent = '先把密码填上'
    packPwdHintEl.className = 'delbox delbox--warn'
    packPwdEl.focus()
    return
  }

  packPwdHintEl.textContent = '正在试…'
  packPwdHintEl.className = 'delbox'
  await openPackDialog(packFilePath, pwd)
}

packPwdTryEl.addEventListener('click', tryPackPassword)
packPwdEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') tryPackPassword()
})

// 换个目录装（弹系统的文件夹选择框）。
// 按钮和那个框都挂上——用户看着那个框像能点的，点它就该有反应
packDirEl.addEventListener('click', () => packDirPickEl.click())

packDirPickEl.addEventListener('click', async () => {
  const picked = await window.api.pickPackDir()
  if (picked.canceled) return

  if (!picked.ok) {
    packDirHintEl.textContent = picked.error
    packDirHintEl.className = 'delbox delbox--warn'
    return
  }

  packDir = picked.dir
  packDirIsEmpty = Boolean(picked.empty)
  renderPackDir()

  // 换了目录，名字重不重名要重新算（同名检查是按目录来的）
  await checkPackName()
})

packInstallEl.addEventListener('click', async () => {
  // 装完了这次按钮是「完成」——再点就是关掉对话框，不是再装一遍
  if (packDone) {
    closePackDialog()
    return
  }

  if (!packInfo || packInstalling) return

  const isInstance = packInfo.kind === 'files' && packInfo.layout === 'instance'
  const targetVersionId = isInstance ? packTargetEl.value : ''
  // "解到已有版本里"的包：目录跟着**下拉里选的那个版本**走，不是跟着"装到哪儿"那行
  const targetDir = isInstance
    ? packTargetEl.selectedOptions[0]?.dataset.dir || ''
    : packDir

  // 名字再验一遍（界面上虽然一边打字一边在验，但"点下去那一刻"才是准的）
  if (!packNameRowEl.hidden && !(await checkPackName())) return
  const versionName = packNameRowEl.hidden ? '' : packNameEl.value.trim()

  packInstalling = true
  packInstallEl.disabled = true
  packWarnEl.textContent = ''
  packProgressEl.textContent = '正在准备…'

  let result
  try {
    result = await window.api.installPack({
      filePath: packFilePath,
      targetVersionId,
      versionName,
      dir: targetDir,
      password: packPassword
    })
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) }
  }

  packInstalling = false
  packInstallEl.disabled = false

  if (!result.ok) {
    packWarnEl.textContent = result.error
    packProgressEl.textContent = ''
    return
  }

  // 装完了：按钮换成「完成」，那一行"装到哪个版本"也收起来（已经装完了，改不了了）
  packDone = true
  packPassword = ''
  packInstallEl.textContent = '完成'
  packCancelEl.hidden = true
  packTargetRowEl.hidden = true
  packNameRowEl.hidden = true
  // 装完了，"装到哪儿"那一行和它下面那句"要重下一份"的提醒也该收起来——
  // 留着的话用户会以为还要再装一次（实测截图里就是这个问题）
  packDirRowEl.hidden = true

  // 装在别处的话，成功提示里要写明"装到哪儿了"——不写的话用户还得回列表里猜
  const where = targetDir && !samePath(targetDir, launchInfo?.gameDir)
    ? `装到了 ${targetDir}。`
    : ''

  packProgressEl.textContent = result.versionId
    ? `装好啦！${where}版本列表里多了个「${result.versionId}」——回启动页选它就能玩。` +
      `这次 ${packFileSummary(result)}` +
      (result.overrides ? `，另有 ${result.overrides} 个作者的配置文件` : '')
    : `装好啦！${result.written} 个文件已经解到 ${result.dest}`

  // 版本列表刷新，并把新版本选上（装在哪个目录就选哪个目录里的那个）
  await refreshLaunchFacts()
  const fresh = findVersion(result.versionId, targetDir)
  if (fresh) {
    selectedVersion = fresh.id
    selectedDir = fresh.dir
    refreshLaunchUi()
  }

  // 装完这会儿"本机有几个版本"变了，启动页那行提示也得跟着改口
  refreshLaunchNotice()
})

/**
 * "这次装了多少文件"的说明。
 *
 * 【为什么不能直接写 result.files】拖进来的整合包有两种路子：
 * 一种是 Modrinth 包（报"下了几个文件"），一种是 PCL 那种整个目录快照
 * （报"新写了几个、跳过几个"）。以前不管哪种都拿 files 硬套，
 * 于是重装一个已经装过的包时，界面上写着"装好了（0 个文件）"——
 * 用户看到"0 个文件"只会以为没装上（实测反馈过）。
 */
function packFileSummary(result) {
  const written = result.written || 0
  const skipped = result.skipped || 0

  if (result.files !== undefined) return `${result.files} 个文件到位`

  const total = written + skipped
  if (skipped > 0) {
    return `${total} 个文件到位（新写 ${written} 个，本机已有的 ${skipped} 个直接跳过）`
  }
  return `${total} 个文件到位`
}

// 「安装本地整合包」按钮：不方便拖拽的时候，点它挑文件
document.getElementById('pack-pick').addEventListener('click', async () => {
  const picked = await window.api.pickPackFile()
  if (picked.ok && picked.filePath) await openPackDialog(picked.filePath)
})

document.getElementById('pack-cancel').addEventListener('click', closePackDialog)
packModalEl.addEventListener('click', (event) => {
  if (event.target === packModalEl) closePackDialog()
})

window.api.onPackStage((text) => {
  if (packInstalling) packProgressEl.textContent = text
  // 从「下载」页下的整合包也走这条通道（装包和解包是同一套）。
  // 不接这一条的话，底部面板会停在"正在下载…"不动好几分钟，看着像卡死了。
  if (mrBusy) setStage(text)
})

window.api.onPackProgress((stats) => {
  if (stats.percent === undefined) return
  const line =
    `正在下载… ${stats.percent}% · ${stats.done}/${stats.total} 个` +
    (stats.failed > 0 ? ` · 失败 ${stats.failed}` : '')
  if (packInstalling) packProgressEl.textContent = line
  if (mrBusy) {
    setStage('正在装整合包…（里面有几千个文件，慢一点是正常的）')
    setFill(stats.percent)
    setDetail(line.replace('正在下载… ', ''))
  }
})

// ═══════════════════════════════════════
// 版本管理（M6.1）：改名、备注、四个文件夹、删版本
// ═══════════════════════════════════════

const verSettingsBtnEl = document.getElementById('ver-settings-btn')
const verModalEl = document.getElementById('ver-modal')
const verTitleEl = document.getElementById('ver-title')
const verTypeEl = document.getElementById('ver-type')
const verIconsEl = document.getElementById('ver-icons')
const verCategoryEl = document.getElementById('ver-category')
const verFavoriteEl = document.getElementById('ver-favorite')
const verJavaEl = document.getElementById('ver-java')
const verNameEl = document.getElementById('ver-name')
const verNoteEl = document.getElementById('ver-note')
const verHintEl = document.getElementById('ver-hint')
const verFolderHintEl = document.getElementById('ver-folder-hint')
const delModalEl = document.getElementById('del-modal')
const delTitleEl = document.getElementById('del-title')
const delWhatEl = document.getElementById('del-what')
const delSafeEl = document.getElementById('del-safe')

// 「这个版本自己的设置」那几个控件
const verMemoryOnEl = document.getElementById('ver-memory-on')
const verMemoryEl = document.getElementById('ver-memory')
const verMemoryNumEl = document.getElementById('ver-memory-num')
const verWindowOnEl = document.getElementById('ver-window-on')
const verWidthEl = document.getElementById('ver-width')
const verHeightEl = document.getElementById('ver-height')
const verIsolationOnEl = document.getElementById('ver-isolation-on')
const verIsolationEl = document.getElementById('ver-isolation')
const verSettingsHintEl = document.getElementById('ver-settings-hint')
const verInstallFabricEl = document.getElementById('ver-install-fabric')
const verInstallForgeEl = document.getElementById('ver-install-forge')
const verInstallNeoForgeEl = document.getElementById('ver-install-neoforge')
const verLoaderHintEl = document.getElementById('ver-loader-hint')

/** 正在装 Mod 加载器吗（进度要写到版本设置弹窗里） */
let loaderInstalling = false

/** 版本设置弹窗里，「这个版本自己的设置」的信息（含全局值作对比） */
let verSettingsInfo = null

/** 版本设置弹窗正在设置哪个版本 */
let editingVersion = ''
/** 正在编辑的这个版本在哪个游戏目录里（M11.4） */
let editingDir = ''
/** 删除确认弹窗正在确认哪个版本 */
let deletingVersion = ''
/** 正在删的那个版本在哪个游戏目录里 */
let deletingDir = ''

function formatBytes(bytes) {
  if (!bytes) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / 1024 / 1024
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(1)} MB`
}

async function openVersionSettings() {
  if (!selectedVersion) return
  editingVersion = selectedVersion
  editingDir = selectedDir
  const id = editingVersion

  const info = launchInfo?.versionInfo?.[id] ?? { name: '', note: '' }
  verTitleEl.textContent = `版本设置 — ${id}`
  verNameEl.value = info.name
  verNoteEl.value = info.note
  verCategoryEl.value = info.category || ''
  verFavoriteEl.checked = Boolean(info.favorite)
  renderIconPicker(info.icon || '')
  verHintEl.textContent = ''
  verHintEl.classList.remove('verform__hint--bad')
  verFolderHintEl.textContent = ''
  verSettingsHintEl.textContent = '正在读设置…'
  verModalEl.hidden = false

  // 「这个版本是什么」：类型先填上（数据已经在手边），Java 那张要现算，异步填
  const picked = findVersion(id, editingDir)
  verTypeEl.textContent = VERSION_TYPE_LABELS[picked?.type] || '不知道（可能不是官方版本）'
  verTypeEl.className = 'vermeta__v'
  renderVersionJava(id)
  verNameEl.focus()

  // 「这个版本自己的设置」要现算（还要拿全局值作对比），异步读一下
  const settings = await window.api.getVersionSettings(id, editingDir)
  if (editingVersion !== id) return // 读的过程中弹窗被关了/换了版本
  verSettingsInfo = settings

  const override = settings.override || {}
  verMemoryOnEl.checked = Number(override.memoryMB) > 0
  verWindowOnEl.checked = Number(override.windowWidth) > 0
  verIsolationOnEl.checked = typeof override.isolation === 'boolean'

  const maxSlider = Math.min(Math.floor(settings.totalMemoryMB / 512) * 512, 16384)
  verMemoryEl.max = String(maxSlider)

  renderVersionSettings()
}

/** 按当前状态刷新「这个版本自己的设置」那几行 */
function renderVersionSettings() {
  if (!verSettingsInfo) return
  const { global, effective } = verSettingsInfo

  const memoryOn = verMemoryOnEl.checked
  verMemoryEl.disabled = !memoryOn
  verMemoryNumEl.disabled = !memoryOn
  verMemoryEl.value = String(memoryOn ? effective.memoryMB : global.memoryMB)
  verMemoryNumEl.value = String(memoryOn ? effective.memoryMB : global.memoryMB)

  const windowOn = verWindowOnEl.checked
  verWidthEl.disabled = !windowOn
  verHeightEl.disabled = !windowOn
  verWidthEl.value = String(windowOn ? effective.windowWidth : global.windowWidth)
  verHeightEl.value = String(windowOn ? effective.windowHeight : global.windowHeight)

  const isolationOn = verIsolationOnEl.checked
  verIsolationEl.disabled = !isolationOn
  verIsolationEl.checked = isolationOn ? effective.isolation : global.isolation

  verSettingsHintEl.textContent =
    `这个版本实际用：内存 ${effective.memoryMB} MB · ` +
    `窗口 ${effective.windowWidth} × ${effective.windowHeight} · ` +
    `隔离${effective.isolation ? '开' : '关'}`
}

/** 改这个版本的一项设置，存完重新算一遍"真正生效的值" */
async function saveVersionSetting(patch) {
  if (!editingVersion) return
  const id = editingVersion

  const result = await window.api.setVersionSettings(id, patch, editingDir)
  if (!result.ok) {
    verHintEl.textContent = result.error
    verHintEl.classList.add('verform__hint--bad')
    return
  }

  verSettingsInfo = await window.api.getVersionSettings(id, editingDir)
  if (editingVersion !== id) return

  verHintEl.classList.remove('verform__hint--bad')
  verHintEl.textContent = '已保存'
  setTimeout(() => {
    if (editingVersion === id && verHintEl.textContent === '已保存') verHintEl.textContent = ''
  }, 2000)

  renderVersionSettings()
}

function closeVersionSettings() {
  verModalEl.hidden = true
  editingVersion = ''
  verSettingsInfo = null
  // 回到启动页时信息卡（内存等）要跟着变
  refreshLaunchFacts()
}

async function saveVersionSettings() {
  if (!editingVersion) return

  const result = await window.api.updateVersion(editingVersion, {
    name: verNameEl.value,
    note: verNoteEl.value,
    icon: pickedIcon,
    category: verCategoryEl.value,
    favorite: verFavoriteEl.checked
  })

  if (!result.ok) {
    verHintEl.textContent = result.error
    verHintEl.classList.add('verform__hint--bad')
    return
  }

  if (launchInfo) launchInfo.versionInfo[editingVersion] = result.version
  verHintEl.classList.remove('verform__hint--bad')
  verHintEl.textContent = '已保存'
  renderPickList()

  const shownFor = editingVersion
  setTimeout(() => {
    if (editingVersion === shownFor && verHintEl.textContent === '已保存') {
      verHintEl.textContent = ''
    }
  }, 2000)
}

// ——— 删除（两步：先弹确认说清楚删什么，再真删）———

async function askDeleteVersion() {
  if (!editingVersion) return
  deletingVersion = editingVersion
  deletingDir = editingDir

  // 不是默认目录里的版本，标题里就把目录写出来——删东西之前必须让人看清楚删的是哪个
  const where = findVersion(deletingVersion, deletingDir)
  delTitleEl.textContent = where && !where.isDefault
    ? `要删除版本「${deletingVersion}」吗？（在 ${deletingDir}）`
    : `要删除版本「${deletingVersion}」吗？`
  delWhatEl.textContent = '正在算这个版本占多大…'
  delSafeEl.textContent = ''
  delModalEl.hidden = false

  const size = await window.api.getVersionSize(deletingVersion, deletingDir)

  // 算大小的这点时间里，用户可能已经把弹窗关了
  if (delModalEl.hidden || !deletingVersion) return

  delWhatEl.textContent =
    `会删掉：versions\\${deletingVersion}\\ 这个文件夹` +
    `（版本文件本体${size.bytes ? `，约 ${formatBytes(size.bytes)}` : ''}）`

  delSafeEl.textContent = size.isolated
    ? '⚠ 这个版本开着版本隔离，它的存档、Mod 就在这个文件夹里，会一起被删掉！'
    : '不会动：共享的库文件、资源文件，其他版本，还有你的存档、Mod、截图' +
      '（它们在游戏目录里，不在这个文件夹里）'
}

async function confirmDeleteVersion() {
  if (!deletingVersion) return
  const id = deletingVersion

  const result = await window.api.deleteVersion(id, deletingDir)

  delModalEl.hidden = true
  deletingVersion = ''

  if (!result.ok) {
    verHintEl.textContent = result.error
    verHintEl.classList.add('verform__hint--bad')
    return
  }

  closeVersionSettings()
  if (selectedVersion === id) selectedVersion = ''

  // 两个列表都要跟着变：启动页的版本列表 + 下载页的「已安装」
  await loadLaunchPage()
  loadInstalled()
  setNotice(`版本 ${id} 已删除。`, 'ok')
}

// ——— 「这个版本自己的设置」那几个控件 ———

verMemoryOnEl.addEventListener('change', () => {
  if (!verSettingsInfo) return
  saveVersionSetting(
    verMemoryOnEl.checked ? { memoryMB: verSettingsInfo.global.memoryMB } : { memoryMB: null }
  )
})
verMemoryEl.addEventListener('input', () => {
  verMemoryNumEl.value = verMemoryEl.value
})
verMemoryEl.addEventListener('change', () =>
  saveVersionSetting({ memoryMB: Number(verMemoryEl.value) })
)
verMemoryNumEl.addEventListener('change', () =>
  saveVersionSetting({ memoryMB: Number(verMemoryNumEl.value) })
)

verWindowOnEl.addEventListener('change', () => {
  if (!verSettingsInfo) return
  saveVersionSetting(
    verWindowOnEl.checked
      ? {
          window: {
            width: verSettingsInfo.global.windowWidth,
            height: verSettingsInfo.global.windowHeight
          }
        }
      : { window: null }
  )
})

const saveVersionWindow = () =>
  saveVersionSetting({
    window: { width: Number(verWidthEl.value), height: Number(verHeightEl.value) }
  })
verWidthEl.addEventListener('change', saveVersionWindow)
verHeightEl.addEventListener('change', saveVersionWindow)

verIsolationOnEl.addEventListener('change', () => {
  if (!verSettingsInfo) return
  saveVersionSetting(
    verIsolationOnEl.checked
      ? { isolation: verSettingsInfo.global.isolation }
      : { isolation: null }
  )
})
verIsolationEl.addEventListener('change', () =>
  saveVersionSetting({ isolation: verIsolationEl.checked })
)

// ——— 装 Mod 加载器（M10 / M10.2：Fabric、Forge、NeoForge）———

const LOADER_LABELS = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }

/** 三个按钮走同一条路，只是加载器不一样 */
async function installLoader(type) {
  if (!editingVersion || loaderInstalling) return
  const base = editingVersion
  const label = LOADER_LABELS[type]

  loaderInstalling = true
  for (const button of [verInstallFabricEl, verInstallForgeEl, verInstallNeoForgeEl]) {
    button.disabled = true
  }
  verLoaderHintEl.textContent = `正在准备装 ${label}…`
  // 提示文字在弹窗底部，可能看不到——滚过去让用户看见进度
  verLoaderHintEl.scrollIntoView({ block: 'nearest' })

  let result
  try {
    result = await window.api.installLoader({
      gameVersion: base,
      loader: type,
      dir: editingDir
    })
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) }
  }

  loaderInstalling = false
  for (const button of [verInstallFabricEl, verInstallForgeEl, verInstallNeoForgeEl]) {
    button.disabled = false
  }

  if (!result.ok) {
    verLoaderHintEl.textContent = `装不上：${result.error}`
    return
  }

  verLoaderHintEl.textContent = result.already
    ? `${result.versionId} 之前就装好啦，不用再来一遍`
    : `装好啦：${result.versionId}——回启动页选它就能用 Mod 了`

  // 版本列表刷新，并把新装好的那个选上（省得用户自己找）
  await refreshLaunchFacts()
  const installedNow = findVersion(result.versionId, editingDir)
  if (installedNow) {
    selectedVersion = installedNow.id
    selectedDir = installedNow.dir
    refreshLaunchUi()
  }
}

verInstallFabricEl.addEventListener('click', () => installLoader('fabric'))
verInstallForgeEl.addEventListener('click', () => installLoader('forge'))
verInstallNeoForgeEl.addEventListener('click', () => installLoader('neoforge'))

verSettingsBtnEl.addEventListener('click', openVersionSettings)
document.getElementById('ver-close').addEventListener('click', closeVersionSettings)
document.getElementById('ver-save').addEventListener('click', saveVersionSettings)
document.getElementById('ver-delete').addEventListener('click', askDeleteVersion)
document.getElementById('del-ok').addEventListener('click', confirmDeleteVersion)
document.getElementById('del-cancel').addEventListener('click', () => {
  delModalEl.hidden = true
  deletingVersion = ''
})

verModalEl.addEventListener('click', async (event) => {
  // 四个文件夹按钮
  const which = event.target.dataset?.folder
  if (which) {
    const result = await window.api.openVersionFolder(editingVersion, which, editingDir)
    verFolderHintEl.textContent = result.ok ? `已打开：${result.dir}` : `打不开：${result.error}`
    return
  }
  // 点灰底关掉
  if (event.target === verModalEl) closeVersionSettings()
})

delModalEl.addEventListener('click', (event) => {
  if (event.target === delModalEl) {
    delModalEl.hidden = true
    deletingVersion = ''
  }
})

// ═══════════════════════════════════════
// 设置页：启动选项（M6.2）
// ═══════════════════════════════════════

const setMemoryEl = document.getElementById('set-memory')
const setMemoryNumEl = document.getElementById('set-memory-num')
const setThreadsEl = document.getElementById('set-threads')
const setSpeedEl = document.getElementById('set-speed')
const setSpeedHintEl = document.getElementById('set-speed-hint')

/** 下载速度那两行下面的提示 */
function renderSpeedHint() {
  const speed = Number(setSpeedEl.value) || 0
  setSpeedHintEl.textContent =
    speed > 0
      ? `限到 ${speed} KB/s（约 ${(speed / 1024).toFixed(1)} MB/s）——下大版本会慢一些，但不会把家里的网占满。`
      : '现在不限速。装一个版本动辄几百 MB，限速了会明显变慢。'
}

// 改完失焦/回车就存（不用点"保存"）
async function saveSpeedSettings() {
  const threads = Math.min(32, Math.max(1, Math.round(Number(setThreadsEl.value) || 8)))
  const speed = Math.max(0, Math.round(Number(setSpeedEl.value) || 0))

  setThreadsEl.value = String(threads)
  setSpeedEl.value = String(speed)
  renderSpeedHint()

  await window.api.setSettings({ downloadConcurrency: threads, downloadSpeedLimitKB: speed })
}

setThreadsEl.addEventListener('change', saveSpeedSettings)
setSpeedEl.addEventListener('change', saveSpeedSettings)
setSpeedEl.addEventListener('input', renderSpeedHint)
const setMemoryHintEl = document.getElementById('set-memory-hint')
const setWidthEl = document.getElementById('set-width')
const setHeightEl = document.getElementById('set-height')
const setWindowHintEl = document.getElementById('set-window-hint')
const setIsolationEl = document.getElementById('set-isolation')
const setIsolationHintEl = document.getElementById('set-isolation-hint')
const settingsNoticeEl = document.getElementById('settings-notice')

/** 设置页拿到的信息：本机内存、屏幕大小、当前设置 */
let settingsInfo = null
/** "已保存"这种提示过一会儿要自己消失 */
let settingsNoticeTimer = null

function saySettings(text, kind = 'info', autoClear = false) {
  settingsNoticeEl.textContent = text
  settingsNoticeEl.classList.toggle('notice--ok', kind === 'ok')
  settingsNoticeEl.classList.toggle('notice--error', kind === 'error')

  if (settingsNoticeTimer) {
    clearTimeout(settingsNoticeTimer)
    settingsNoticeTimer = null
  }
  if (autoClear) {
    settingsNoticeTimer = setTimeout(() => {
      settingsNoticeEl.classList.remove('notice--ok', 'notice--error')
      settingsNoticeEl.textContent = '这里改完马上生效，下次启动游戏就按这里的来。'
    }, 2500)
  }
}

function formatMemory(mb) {
  if (mb >= 1024) {
    const gb = mb / 1024
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
  }
  return `${mb} MB`
}

function renderMemoryHint() {
  if (!settingsInfo) return
  const mb = Number(setMemoryNumEl.value)
  const total = settingsInfo.totalMemoryMB

  const lines = [
    `本机一共 ${formatMemory(total)} 内存，建议分 ${formatMemory(settingsInfo.suggestedMemoryMB)} 给游戏`
  ]
  let bad = false

  if (!Number.isFinite(mb) || mb < 512) {
    lines.push('太少了——游戏至少要 512 MB 才跑得起来')
    bad = true
  } else if (mb > total) {
    lines.push('比本机内存还大，启动会被拦住')
    bad = true
  } else if (mb > total * 0.8) {
    lines.push('给这么多会把电脑拖得很卡，建议给系统留一些')
    bad = true
  }

  if (settingsInfo.memoryAuto) lines.push('现在用的是自动值；动一下滑块就固定成你设的')

  setMemoryHintEl.textContent = lines.join('\n')
  setMemoryHintEl.classList.toggle('panel__desc--bad', bad)
}

function renderWindowHint() {
  if (!settingsInfo) return
  const width = Number(setWidthEl.value)
  const height = Number(setHeightEl.value)

  const lines = [`屏幕是 ${settingsInfo.screenWidth} × ${settingsInfo.screenHeight}`]
  let bad = false

  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 240) {
    lines.push('太小了，最小 320 × 240')
    bad = true
  } else if (width > 3840 || height > 2160) {
    lines.push('太大了，最大 3840 × 2160')
    bad = true
  } else if (width > settingsInfo.screenWidth) {
    lines.push('比屏幕还宽，游戏窗口会伸到屏幕外面去')
    bad = true
  }

  setWindowHintEl.textContent = lines.join('\n')
  setWindowHintEl.classList.toggle('panel__desc--bad', bad)
}

function renderIsolationHint() {
  if (!settingsInfo) return
  const on = setIsolationEl.checked

  if (on) {
    let text = '开着：每个版本的存档、Mod 都在自己的文件夹里（versions\\版本号\\），互不干扰。'
    if (settingsInfo.sharedWorlds > 0) {
      text +=
        `\n注意：共享存档目录里还有 ${settingsInfo.sharedWorlds} 个世界，` +
        '隔离开着在游戏里看不到它们——文件没丢，需要的话可以搬过来。'
    }
    setIsolationHintEl.textContent = text
    setIsolationHintEl.classList.toggle('panel__desc--bad', settingsInfo.sharedWorlds > 0)
  } else {
    setIsolationHintEl.textContent = '关着：所有版本共用游戏目录里的存档和 Mod。'
    setIsolationHintEl.classList.remove('panel__desc--bad')
  }
}

async function loadSettingsPage() {
  try {
    settingsInfo = await window.api.getSettings()
  } catch (error) {
    saySettings(`设置读不出来：${error.message}`, 'error')
    return
  }

  const maxSlider = Math.min(Math.floor(settingsInfo.totalMemoryMB / 512) * 512, 16384)
  setMemoryEl.max = String(maxSlider)
  setMemoryEl.value = String(settingsInfo.memoryMB)
  setMemoryNumEl.value = String(settingsInfo.memoryMB)
  renderMemoryHint()

  // 下载速度那两项（M13）。
  // 【注意变量名是 settingsInfo 不是 config】写错过一次：那行会抛 ReferenceError，
  // 结果是这两个框一直空着（而且页面别的部分看着还正常，不好发现）。
  setThreadsEl.value = String(settingsInfo.downloadConcurrency || 8)
  setSpeedEl.value = String(settingsInfo.downloadSpeedLimitKB || 0)
  renderSpeedHint()

  setWidthEl.value = String(settingsInfo.windowWidth)
  setHeightEl.value = String(settingsInfo.windowHeight)
  renderWindowHint()

  setIsolationEl.checked = settingsInfo.isolation
  renderIsolationHint()

  // ——— 下载源 ———
  const source = settingsInfo.downloadSource || 'auto'
  for (const radio of document.querySelectorAll('input[name="set-source"]')) {
    radio.checked = radio.value === source
  }

  // ——— Java 运行时（M20）———
  setAutoJavaEl.checked = settingsInfo.autoJava !== false
  renderJavaPanel()
}

// ——————————————————————————————————————————————
// Java 运行时（M20）
// ——————————————————————————————————————————————
//
// 【为什么要有这一块】以前 Java 对用户是个黑盒：本机有哪几个、游戏用的是哪个、
// 想换一个怎么办，界面上一个字都不说。现在全列出来：能挑、能加自己装的、
// 也能把"自动下载"关掉（网按流量算的人不需要毛球偷偷下 200 MB）。

const javaListEl = document.getElementById('java-list')
const javaHintEl = document.getElementById('java-hint')
const setAutoJavaEl = document.getElementById('set-auto-java')
const javaModalEl = document.getElementById('java-modal')
const javaPickListEl = document.getElementById('java-pick-list')
const javaPickHintEl = document.getElementById('java-pick-hint')
const javaModalSubEl = document.getElementById('java-modal-sub')
const verPickJavaEl = document.getElementById('ver-pick-java')

/** 本机 Java 名单。两个列表共用一份——每次重读都要挨个试跑 java.exe，挺慢的 */
let javaListCache = null

/** 「选择 Java」弹窗正在给哪个版本挑（谁打开的谁说了算，别猜） */
let javaPickTarget = { id: '', dir: '' }

/** 「选择 Java」弹窗里暂选的那一项（点了「保存选择」才算数） */
let javaPickChoice = ''

/** 空字符串 = 自动选择（跟全局那个用的是同一套约定） */
const JAVA_AUTO = ''
/** 「跟随全局设置」——这个值不可能撞上真实路径，拿它当哨兵 */
const JAVA_FOLLOW = '__follow_global__'

/** 读名单。force = 重新检测（忽略缓存） */
async function loadJavaList(force = false) {
  if (javaListCache && !force) return javaListCache

  let res
  try {
    res = await window.api.listJavas()
  } catch (error) {
    res = { ok: false, error: String(error?.message ?? error) }
  }

  if (!res.ok) {
    saySettings(`读本机 Java 失败：${res.error}`, 'error')
    return javaListCache || []
  }
  javaListCache = res.list
  return javaListCache
}

/** Java 25.0.1 · x64 这行的前半截 */
function javaRowTitle(one) {
  if (!one.ok) return `${one.source}：不能用`
  const bits = one.bits === 64 ? ' · x64' : one.bits === 32 ? ' · x86' : ''
  return `Java ${one.version}${bits}`
}

/**
 * 造一行单选。「自动选择」和每一个本机 Java 都用它，保证长得一样。
 * @param {{name: string, value: string, title: string, help?: string,
 *          checked?: boolean, bad?: boolean, onPick?: Function, onRemove?: Function}} opts
 */
function makeJavaOption(opts) {
  const wrap = document.createElement('div')
  wrap.className = 'java-row' + (opts.bad ? ' java-row--bad' : '')

  const label = document.createElement('label')
  label.className = 'check check--block'

  const input = document.createElement('input')
  input.type = 'radio'
  input.name = opts.name
  input.value = opts.value
  input.checked = Boolean(opts.checked)
  // 不能用的（文件没了/跑不起来）列出来但不给选——选了也是个坑
  if (opts.bad) input.disabled = true
  if (opts.onPick) input.addEventListener('change', () => opts.onPick(opts.value))

  const box = document.createElement('span')
  const title = document.createElement('b')
  title.textContent = opts.title
  box.appendChild(title)
  if (opts.help) {
    const help = document.createElement('em')
    help.className = 'check__help'
    help.textContent = opts.help
    box.appendChild(help)
  }

  label.appendChild(input)
  label.appendChild(box)
  wrap.appendChild(label)

  if (opts.onRemove) {
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'linkbtn'
    del.textContent = '移除'
    del.title = '只是从名单里划掉，不会删掉硬盘上的 Java'
    del.addEventListener('click', () => opts.onRemove())
    wrap.appendChild(del)
  }

  return wrap
}

/** 设置页那块「用哪个 Java」 */
async function renderJavaPanel(force = false) {
  if (!settingsInfo) return
  const list = await loadJavaList(force)
  const chosen = String(settingsInfo.javaPath || '')

  javaListEl.textContent = ''

  // ① 自动选择
  javaListEl.appendChild(
    makeJavaOption({
      name: 'set-java',
      value: JAVA_AUTO,
      title: '自动选择（推荐）',
      help: '按每个版本的要求，在本机已有的里面挑一个最合适的',
      checked: chosen === '',
      onPick: () => saveSetting({ javaPath: '' }, () => { settingsInfo.javaPath = '' })
    })
  )

  // ② 本机找到的
  for (const one of list) {
    javaListEl.appendChild(
      makeJavaOption({
        name: 'set-java',
        value: one.path,
        title: javaRowTitle(one),
        help: one.ok ? one.path : `${one.path} —— ${one.error}`,
        checked: samePath(chosen, one.path),
        bad: !one.ok,
        onPick: () =>
          saveSetting({ javaPath: one.path }, () => { settingsInfo.javaPath = one.path }),
        onRemove: one.added
          ? async () => {
              const res = await window.api.removeJava(one.path)
              if (!res.ok) {
                saySettings(`移除失败：${res.error}`, 'error')
                return
              }
              javaListCache = null
              javaListCache = await loadJavaList(true)
              const fresh = await window.api.getSettings()
              settingsInfo.javaPath = fresh.javaPath
              renderJavaPanel()
              saySettings('已经从名单里划掉了（硬盘上的文件没动）', 'ok', true)
            }
          : undefined
      })
    )
  }

  // ③ 选的那个后来被删了/移走了：也得列出来，不然四个单选框一个都不亮，
  //    用户看着像"我的设置丢了"，其实是那个文件不在了
  if (chosen && !list.some((one) => samePath(one.path, chosen))) {
    javaListEl.appendChild(
      makeJavaOption({
        name: 'set-java',
        value: chosen,
        title: '你选的那个 Java：现在找不到了',
        help: `${chosen} —— 文件被删了或者被移走了，重新挑一个吧`,
        checked: true,
        bad: true
      })
    )
  }

  // ——— 底下那行提示：说清楚"现在这个设置意味着什么" ———
  const parts = []
  if (list.length === 0) {
    parts.push('本机还没找到 Java —— 装好一个游戏版本之后，毛球会连运行环境一起备好。')
  } else {
    parts.push(`本机找到 ${list.length} 个 Java。`)
  }

  const current = launchInfo?.java
  if (current && selectedVersion) {
    parts.push(
      current.found
        ? `当前选中的 ${selectedVersion} 会用它：Java ${current.version}（${shortJavaSource(current.source)}）`
        : `当前选中的 ${selectedVersion} 还没有能用的 Java：${current.error || '还没找到'}`
    )
  }
  javaHintEl.textContent = parts.join('')
}

/** 换哪个 Java 之后，两边（设置页 / 版本设置）都要跟着变 */
function refreshJavaEverywhere() {
  renderJavaPanel()
  if (editingVersion && !verModalEl.hidden) renderVersionJava(editingVersion)
  refreshLaunchFacts()
}

// ——— 上面那个开关：自动检测并下载 ———

if (setAutoJavaEl) {
  setAutoJavaEl.addEventListener('change', () => {
    saveSetting({ autoJava: setAutoJavaEl.checked }, () => {
      if (settingsInfo) settingsInfo.autoJava = setAutoJavaEl.checked
    })
  })
}

// ——— 添加 Java… / 重新检测 ———

document.getElementById('java-add').addEventListener('click', async () => {
  const picked = await window.api.pickJava()
  if (picked.canceled) return
  if (!picked.ok) {
    saySettings(picked.error, 'error')
    return
  }

  const added = await window.api.addJava(picked.path)
  if (!added.ok) {
    saySettings(`加不进去：${added.error}`, 'error')
    return
  }

  javaListCache = null
  const list = await loadJavaList(true)
  const mine = list.find((one) => one.added && samePath(one.path, picked.path))

  // 毛球本来就能自己找到的（游戏目录里那几个），添加了也不会多出一行——
  // 得说清楚，不然用户会以为"点了添加怎么什么都没变"
  if (!mine) {
    await renderJavaPanel()
    saySettings(`这个 Java 毛球本来就能找到，已经在名单里了：Java ${picked.version}`, 'ok')
    return
  }

  // 加完直接把它选上——用户点"添加"的意图就是"我要用它"
  await saveSetting({ javaPath: picked.path }, () => { settingsInfo.javaPath = picked.path })
  await renderJavaPanel(true)
  saySettings(`加好了：Java ${picked.version}`, 'ok', true)
})

document.getElementById('java-refresh').addEventListener('click', async () => {
  javaListCache = null
  await renderJavaPanel(true)
  saySettings('重新检测完了', 'ok', true)
})

// ——— 「选择 Java 运行环境」弹窗（给单个版本挑）———

/**
 * 打开「选择 Java 运行环境」。
 *
 * 【为什么把 id/dir 当参数传进来】这个弹窗有两个入口：版本设置里那个「选择…」，
 * 和启动页那张 Java 卡片。要是靠 editingVersion 这种"当前正在编辑谁"的全局变量，
 * 从启动页点进来时会用到上一次编辑过的版本，改错人——这种错还特别难发现。
 * 谁打开的，谁把目标说清楚。
 */
async function openJavaPicker(id, dir) {
  const target = id || selectedVersion
  if (!target) return
  javaPickTarget = { id: target, dir: dir === undefined ? selectedDir : dir }
  javaPickChoice = JAVA_FOLLOW
  javaModalSubEl.textContent = `${target} · 只对这个版本生效，别的版本不受影响`
  javaModalEl.hidden = false
  await renderJavaPicker()
}

async function renderJavaPicker() {
  const list = await loadJavaList()
  const config = await window.api.getVersionSettings(javaPickTarget.id, javaPickTarget.dir)
  const own = config?.override?.javaPath

  // 这个版本自己挑过没有？挑过就是具体的值（'' = 它自己选了"自动选择"）
  const hasOwn = typeof own === 'string'
  const globalLabel = settingsInfo?.javaPath ? '用你指定的那个' : '自动选择'

  javaPickListEl.textContent = ''

  // ① 跟随全局设置
  javaPickListEl.appendChild(
    makeJavaOption({
      name: 'pick-java',
      value: JAVA_FOLLOW,
      title: '跟随全局设置',
      help: `当前全局：${globalLabel}`,
      checked: !hasOwn,
      onPick: (value) => { javaPickChoice = value }
    })
  )

  // ② 自动选择（不看全局）
  javaPickListEl.appendChild(
    makeJavaOption({
      name: 'pick-java',
      value: JAVA_AUTO,
      title: '自动选择',
      help: '按这个版本的要求在本机挑一个最合适的；设置里允许的话，缺了会自动下',
      checked: hasOwn && own === '',
      onPick: (value) => { javaPickChoice = value }
    })
  )

  // ③ 本机找到的
  for (const one of list) {
    javaPickListEl.appendChild(
      makeJavaOption({
        name: 'pick-java',
        value: one.path,
        title: javaRowTitle(one),
        help: one.ok ? one.path : `${one.path} —— ${one.error}`,
        checked: hasOwn && samePath(own, one.path),
        bad: !one.ok,
        onPick: (value) => { javaPickChoice = value }
      })
    )
  }

  javaPickHintEl.textContent =
    list.length === 0
      ? '本机还没找到 Java。可以点左下角「管理 Java」去添加一个。'
      : '拿不准就用「跟随全局设置」——那是最省心的那个。'
}

document.getElementById('java-pick-cancel').addEventListener('click', () => {
  javaModalEl.hidden = true
})
javaModalEl.addEventListener('click', (event) => {
  if (event.target === javaModalEl) javaModalEl.hidden = true
})

document.getElementById('java-pick-save').addEventListener('click', async () => {
  const id = javaPickTarget.id
  const dir = javaPickTarget.dir
  if (!id) return

  const patch =
    javaPickChoice === JAVA_FOLLOW
      ? { javaPath: null }
      : { javaPath: javaPickChoice === JAVA_AUTO ? '' : javaPickChoice }

  const result = await window.api.setVersionSettings(id, patch, dir)
  if (!result.ok) {
    javaPickHintEl.textContent = result.error
    return
  }

  javaModalEl.hidden = true
  if (!verModalEl.hidden && editingVersion) renderVersionJava(editingVersion)
  refreshLaunchFacts()
  setNotice('Java 选择存好了，下次启动这个版本就按它来', 'ok')
})

// 「管理 Java」：关掉弹窗，跳到设置页那块 Java，并让它闪一下
document.getElementById('java-manage').addEventListener('click', () => {
  javaModalEl.hidden = true
  showPage('settings')
  showSettingsTab('launch')
  showJavaPanel()
})

/** 跳到设置页并高亮"Java 运行时"那块（几个地方都要用，抽出来） */
function showJavaPanel() {
  const panel = document.getElementById('panel-java')
  if (panel) panel.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flashAt(panel)
}

verPickJavaEl.addEventListener('click', () => openJavaPicker(editingVersion, editingDir))

/** 把一项设置存下去，顺手刷新提示 */
async function saveSetting(patch, after) {
  const result = await window.api.setSettings(patch)
  if (!result.ok) {
    saySettings(result.error, 'error')
    return false
  }
  if (after) after()
  saySettings('已保存', 'ok', true)
  return true
}

// ——— 内存：滑块和输入框互相同步，松手（change）才存 ———
setMemoryEl.addEventListener('input', () => {
  setMemoryNumEl.value = setMemoryEl.value
  renderMemoryHint()
})
setMemoryEl.addEventListener('change', () => {
  saveSetting({ memoryMB: Number(setMemoryEl.value) }, () => {
    settingsInfo.memoryAuto = false
    settingsInfo.memoryMB = Number(setMemoryEl.value)
    renderMemoryHint()
  })
})

setMemoryNumEl.addEventListener('input', () => {
  setMemoryEl.value = setMemoryNumEl.value
  renderMemoryHint()
})
setMemoryNumEl.addEventListener('change', () => {
  saveSetting({ memoryMB: Number(setMemoryNumEl.value) }, () => {
    settingsInfo.memoryAuto = false
    settingsInfo.memoryMB = Number(setMemoryNumEl.value)
    renderMemoryHint()
  })
})

document.getElementById('set-memory-auto').addEventListener('click', () => {
  saveSetting({ memoryMB: 0 }, async () => {
    settingsInfo = await window.api.getSettings()
    setMemoryEl.value = String(settingsInfo.memoryMB)
    setMemoryNumEl.value = String(settingsInfo.memoryMB)
    renderMemoryHint()
  })
})

// ——— 窗口大小 ———
async function saveWindow() {
  const width = Number(setWidthEl.value)
  const height = Number(setHeightEl.value)
  return saveSetting({ windowWidth: width, windowHeight: height }, () => {
    settingsInfo.windowWidth = width
    settingsInfo.windowHeight = height
    renderWindowHint()
  })
}

setWidthEl.addEventListener('change', saveWindow)
setHeightEl.addEventListener('change', saveWindow)

document.getElementById('set-window-reset').addEventListener('click', () => {
  setWidthEl.value = '854'
  setHeightEl.value = '480'
  saveWindow()
})

// ——— 版本隔离 ———
setIsolationEl.addEventListener('change', () => {
  saveSetting({ isolation: setIsolationEl.checked }, () => {
    settingsInfo.isolation = setIsolationEl.checked
    renderIsolationHint()
  })
})

// ——— 下载源 ———
for (const radio of document.querySelectorAll('input[name="set-source"]')) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return
    saveSetting({ downloadSource: radio.value }, () => {
      if (settingsInfo) settingsInfo.downloadSource = radio.value
    })
  })
}

// ═══════════════════════════════════════
// 设置页：备份（M6.3）
// ═══════════════════════════════════════

const settingsMenuEl = document.getElementById('settings-menu')
const settingsTabEls = document.querySelectorAll('.settings-tab')
const backupNoticeEl = document.getElementById('backup-notice')
const bkStartEl = document.getElementById('bk-start')
const bkOpenEl = document.getElementById('bk-open')
const bkBarWrapEl = document.getElementById('bk-bar-wrap')
const bkBarEl = document.getElementById('bk-bar')
const bkStatusEl = document.getElementById('bk-status')

/** 每一类多大、说明是什么（第一次打开备份页时算一次） */
let backupInfo = null
/** 有没有备份在跑 */
let backupBusy = false

let currentSettingsTab = 'launch'

function showSettingsTab(name) {
  currentSettingsTab = name
  for (const item of settingsMenuEl.children) {
    if (item.dataset && item.dataset.settingsTab) {
      item.classList.toggle('menu__item--on', item.dataset.settingsTab === name)
    }
  }
  for (const tab of settingsTabEls) {
    tab.hidden = tab.dataset.settingsTab !== name
  }
  if (name === 'backup') loadBackupTab()
  if (name === 'clean') loadCleanTab()
  if (name === 'look') renderLookTab()
  if (name === 'account') renderMicrosoftClientId()
  if (name === 'ai') renderAiSettingsTab()
}

// ——— AI 设置那一栏（M22）———

const aiKeyEl = document.getElementById('ai-key')
const aiEndpointEl = document.getElementById('ai-endpoint')
const aiModelEl = document.getElementById('ai-model')
const aiKeyHintEl = document.getElementById('ai-key-hint')
const aiTestResultEl = document.getElementById('ai-test-result')

/** 把当前配置填进设置页那几个框（**Key 不回填**——服务器都不往回发，界面也不留） */
async function renderAiSettingsTab() {
  await loadAiConfig()
  aiEndpointEl.value = aiConfig.endpoint || ''
  aiModelEl.value = aiConfig.model || ''
  aiKeyEl.value = ''
  aiKeyEl.placeholder = aiConfig.hasKey ? '已经填过了（留空 = 不改；想换就直接粘新的）' : '粘贴你的 API Key'
  aiKeyHintEl.textContent = aiConfig.hasKey
    ? '已经存好一个 Key 了（加密存的）。要换就粘新的进来，要清掉点下面「清掉 Key」。'
    : '还没有 Key。不填也能用——助手页的「本地规则库」不联网就能看报错。'
  aiTestResultEl.textContent = ''
}

document.getElementById('ai-open-site').addEventListener('click', () => {
  window.api.openAiSite()
})

document.getElementById('ai-save').addEventListener('click', async () => {
  const patch = {
    endpoint: aiEndpointEl.value.trim(),
    model: aiModelEl.value.trim()
  }
  // 只有用户真打了字才动 Key（留空 = 不改动已有的）
  if (aiKeyEl.value.trim()) patch.apiKey = aiKeyEl.value.trim()

  const result = await window.api.setAiConfig(patch)
  if (!result.ok) {
    aiTestResultEl.textContent = result.error
    return
  }
  aiKeyEl.value = ''
  await renderAiSettingsTab()
  aiTestResultEl.textContent = '存好了。点「测试连接」看看通不通。'
})

document.getElementById('ai-test').addEventListener('click', async () => {
  aiTestResultEl.textContent = '正在试…'
  const result = await window.api.testAi()
  aiTestResultEl.textContent = result.ok
    ? `通了 ✓ 它回了「${result.answer || '…'}」，可以用了。`
    : `没通：${result.error}`
})

document.getElementById('ai-clear').addEventListener('click', async () => {
  const yes = window.confirm('清掉存着的 API Key？\n\n清掉之后还是能用「本地规则库」，只是不能问 AI 了。')
  if (!yes) return
  await window.api.setAiConfig({ apiKey: '' })
  await renderAiSettingsTab()
  aiTestResultEl.textContent = '已经清掉了。'
})

// ——— 帮助页（M13）———

const helpStatusEl = document.getElementById('help-status')

async function openHelpFolder(which, label) {
  try {
    const result =
      which === 'logs' ? await window.api.openLogFolder() : await window.api.openAppFolder(which)
    helpStatusEl.textContent = result.ok
      ? `已经打开${label}了。（要是没跳出来，可能被别的窗口挡住了）`
      : `打不开：${result.error}`
  } catch (error) {
    helpStatusEl.textContent = `打不开：${error.message}`
  }
}

document
  .getElementById('help-open-logs')
  .addEventListener('click', () => openHelpFolder('logs', '日志文件夹'))
document
  .getElementById('help-open-game')
  .addEventListener('click', () => openHelpFolder('game', '游戏目录'))
document
  .getElementById('help-open-config')
  .addEventListener('click', () => openHelpFolder('config', '配置目录'))

// 帮助页那块「AI 助手怎么用」底下那个按钮：直接带他去 AI 页（M22）
document.getElementById('help-goto-ai').addEventListener('click', () => showPage('ai'))

// ——— 清理游戏垃圾（M13）———

const cleanNoticeEl = document.getElementById('clean-notice')
const cleanSummaryEl = document.getElementById('clean-summary')
const cleanListEl = document.getElementById('clean-list')
const cleanResultEl = document.getElementById('clean-result')
const cleanRunEl = document.getElementById('clean-run')
const cleanRescanEl = document.getElementById('clean-rescan')

/** 上次扫出来的结果 */
let cleanInfo = null

/** 选中的要清的类别 */
function checkedCleanKeys() {
  return [...cleanListEl.querySelectorAll('input[type=checkbox]:checked')].map((one) => one.value)
}

async function loadCleanTab() {
  cleanResultEl.textContent = ''
  cleanSummaryEl.textContent = '正在扫…'
  cleanRunEl.disabled = true
  cleanListEl.textContent = ''

  try {
    cleanInfo = await window.api.scanGarbage()
  } catch (error) {
    cleanSummaryEl.textContent = `扫不了：${error.message}`
    return
  }

  if (!cleanInfo.ok) {
    cleanSummaryEl.textContent = `扫不了：${cleanInfo.error}`
    return
  }

  if (cleanInfo.totalFiles === 0) {
    cleanSummaryEl.textContent = '干干净净，没什么可清的。'
    return
  }

  cleanSummaryEl.textContent =
    `一共 ${cleanInfo.totalFiles} 个文件、约 ${formatSize(cleanInfo.totalBytes)}。` +
    '勾上的才会清。'

  for (const group of cleanInfo.groups) {
    const label = document.createElement('label')
    label.className = 'check check--block'

    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = group.key
    input.checked = true
    input.addEventListener('change', () => {
      cleanRunEl.disabled = checkedCleanKeys().length === 0
    })
    label.appendChild(input)

    const span = document.createElement('span')
    const title = document.createElement('b')
    title.textContent = group.label
    span.appendChild(title)

    const help = document.createElement('em')
    help.className = 'check__help'
    help.textContent = group.hint
    span.appendChild(help)

    const size = document.createElement('i')
    size.className = 'check__size'
    size.textContent = `${group.files.length} 个 · ${formatSize(group.bytes)}`
    span.appendChild(size)

    label.appendChild(span)
    cleanListEl.appendChild(label)
  }

  cleanRunEl.disabled = false
}

cleanRescanEl.addEventListener('click', loadCleanTab)

cleanRunEl.addEventListener('click', async () => {
  const keys = checkedCleanKeys()
  if (keys.length === 0) return

  // 删东西之前问一句——这是这个软件第二次"真删文件"（第一次是删版本）
  const names = cleanInfo.groups
    .filter((one) => keys.includes(one.key))
    .map((one) => `${one.label}（${one.files.length} 个）`)
    .join('、')

  const yes = window.confirm(
    `要清掉这些吗？\n\n${names}\n\n` +
      '清的都是游戏日志、崩溃报告这类东西，删了不影响玩。\n' +
      '存档、Mod、配置、截图不在这次清理范围内。'
  )
  if (!yes) return

  cleanRunEl.disabled = true
  cleanResultEl.textContent = '正在清…'

  try {
    const result = await window.api.cleanGarbage(keys)
    if (!result.ok && result.errors.length > 0) {
      cleanResultEl.textContent = `清掉 ${result.deleted} 个、腾出 ${formatSize(result.bytes)}，但有 ${result.errors.length} 个没清掉：${result.errors[0]}`
    } else {
      cleanResultEl.textContent = `清掉了 ${result.deleted} 个文件，腾出约 ${formatSize(result.bytes)}。`
    }
  } catch (error) {
    cleanResultEl.textContent = `清理出错：${error.message}`
  }

  await loadCleanTab()
})

settingsMenuEl.addEventListener('click', (event) => {
  const item = event.target.closest('.menu__item[data-settings-tab]')
  if (item) showSettingsTab(item.dataset.settingsTab)
})

async function loadBackupTab() {
  if (backupInfo) return
  backupNoticeEl.textContent = '正在算每一类有多大…'

  try {
    backupInfo = await window.api.getBackupEstimate()
  } catch (error) {
    backupNoticeEl.textContent = `读不出来：${error.message}`
    return
  }

  for (const key of ['saves', 'mods', 'settings', 'game']) {
    const help = document.getElementById(`bk-${key}-help`)
    const size = document.getElementById(`bk-${key}-size`)
    if (help) help.textContent = backupInfo.help[key] || ''
    if (size) {
      size.textContent = backupInfo.sizes[key]
        ? `约 ${formatBytes(backupInfo.sizes[key])}`
        : '（现在是空的）'
    }
  }

  backupNoticeEl.textContent =
    `备份会存到：${backupInfo.dir}（只读不写，不会动你的原文件）`
}

function setBackupBar(percent) {
  bkBarEl.style.width = `${Math.max(0, Math.min(100, percent))}%`
}

async function startBackup() {
  if (backupBusy) return

  const categories = {
    saves: document.getElementById('bk-saves').checked,
    mods: document.getElementById('bk-mods').checked,
    settings: document.getElementById('bk-settings').checked,
    game: document.getElementById('bk-game').checked
  }
  const format = document.querySelector('input[name="bk-format"]:checked').value

  backupBusy = true
  bkStartEl.disabled = true
  bkBarWrapEl.hidden = false
  setBackupBar(0)
  bkStatusEl.classList.remove('panel__desc--bad')
  bkStatusEl.textContent = '准备中…'

  let result
  try {
    result = await window.api.startBackup({ categories, format })
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) }
  }

  backupBusy = false
  bkStartEl.disabled = false

  if (!result.ok) {
    setBackupBar(0)
    bkStatusEl.classList.add('panel__desc--bad')
    bkStatusEl.textContent = result.error
    return
  }

  setBackupBar(100)
  bkStatusEl.textContent =
    `备份做完了：${result.path}\n共 ${result.count} 个文件，${formatBytes(result.bytes)}`
}

bkStartEl.addEventListener('click', startBackup)

bkOpenEl.addEventListener('click', async () => {
  const result = await window.api.openBackupFolder()
  if (!result.ok) {
    bkStatusEl.classList.add('panel__desc--bad')
    bkStatusEl.textContent = `打不开备份文件夹：${result.error}`
  }
})

window.api.onBackupProgress((payload) => {
  const percent = payload.total > 0 ? Math.round((payload.done / payload.total) * 100) : 0
  setBackupBar(percent)
  bkStatusEl.textContent =
    `正在备份… ${payload.done}/${payload.total} 个文件 · ` +
    `${formatBytes(payload.bytes)}/${formatBytes(payload.totalBytes)}`
})

// ═══════════════════════════════════════
// 日志弹窗（顶栏「日志」按钮，M5 追加）
// ═══════════════════════════════════════

const logModalEl = document.getElementById('log-modal')
const logModalTextEl = document.getElementById('log-modal-text')
const diagnosisEl = document.getElementById('log-diagnosis')
const logTitleEl = document.getElementById('log-title')

/** 弹窗里现在显示的是哪种日志：'live' = 本次打开软件后的实时记录，'file' = 上次存下来的 */
let logModalMode = ''

function renderLogModal() {
  logModalTextEl.textContent = logLines.join('\n') || '（还没有内容）'
  logModalTextEl.scrollTop = logModalTextEl.scrollHeight
}

/**
 * 把诊断结果画到日志窗口顶上（M22 第 1 步）。
 *
 * 【放在这儿的原因】用户看到一屏英文时的第一个动作就是点「日志」——
 * 那就该在这儿的**最上面**先说人话，下面才是原始日志。
 */
function renderDiagnosis(result) {
  diagnosisEl.textContent = ''
  diagnosisEl.hidden = false

  if (!result || !result.ok) {
    diagnosisEl.hidden = true
    return
  }

  // 一条都没认出来：老实说，并给个下一步
  if (result.unknown) {
    const box = document.createElement('div')
    box.className = 'diag__unknown'
    const t = document.createElement('b')
    t.textContent = '这次的问题毛球没认出来'
    const p = document.createElement('span')
    p.textContent =
      '日志就在下面。可以把它复制给懂行的朋友看，或者等「问问 AI」做好之后交给大模型看。'
    box.appendChild(t)
    box.appendChild(p)
    diagnosisEl.appendChild(box)
    return
  }

  for (const one of result.found) {
    const item = document.createElement('div')
    item.className = 'diag__item'

    const title = document.createElement('b')
    title.className = 'diag__title'
    title.textContent = one.title
    item.appendChild(title)

    if (one.why) {
      const why = document.createElement('span')
      why.className = 'diag__why'
      why.textContent = one.why
      item.appendChild(why)
    }

    if (Array.isArray(one.steps) && one.steps.length) {
      const list = document.createElement('ol')
      list.className = 'diag__steps'
      for (const step of one.steps) {
        const li = document.createElement('li')
        li.textContent = step
        list.appendChild(li)
      }
      item.appendChild(list)
    }

    diagnosisEl.appendChild(item)
  }
}

/** 问主进程要一次诊断（读的是最近那份日志） */
async function runDiagnosis(exitCode) {
  try {
    const result = await window.api.diagnoseLast(exitCode)
    renderDiagnosis(result)
  } catch (error) {
    diagnosisEl.hidden = true
  }
}

async function openLogModal() {
  logModalEl.hidden = false
  // 顺手诊断一下（不等它，日志先显示出来）
  runDiagnosis()

  // 本次打开软件后启动过游戏——直接看实时的那份
  if (logLines.length > 0) {
    logModalMode = 'live'
    logTitleEl.textContent = '游戏日志（本次的实时记录）'
    renderLogModal()
    return
  }

  // 没有实时记录，就去读上次启动存下来的日志文件
  logModalMode = 'file'
  logTitleEl.textContent = '正在读取日志…'
  logModalTextEl.textContent = ''

  const result = await window.api.getLatestLog()

  // 读的过程中弹窗可能被关了（或者已经切到实时模式），那就别管了
  if (logModalEl.hidden || logModalMode !== 'file') return

  if (!result.ok) {
    logTitleEl.textContent = '游戏日志'
    logModalTextEl.textContent = result.error
    return
  }

  const lines = []
  for (const raw of result.text.split('\n')) lines.push(...prettifyLogLine(raw))

  logTitleEl.textContent =
    `上次启动的日志：${result.name}${result.truncated ? '（太长，只显示最后一段）' : ''}`
  logModalTextEl.textContent = lines.slice(-MAX_UI_LOG_LINES).join('\n') || '（日志是空的）'
  logModalTextEl.scrollTop = logModalTextEl.scrollHeight
}

function closeLogModal() {
  logModalEl.hidden = true
}

// 「问问 AI」：关掉日志窗口 → 跳到 AI 助手页 → 勾上"带日志" → 弹"确认要发的内容"
document.getElementById('log-ask-ai').addEventListener('click', async () => {
  closeLogModal()
  showPage('ai')
  await loadAiConfig()
  aiWithLogEl.checked = true
  aiLogHintEl.textContent = '会先弹一层让你过目，确认了才发'
  aiInputEl.focus()
  await prepareAiLogAndPreview('这次游戏出问题了，帮我看看是什么原因、怎么解决。')
})

document.getElementById('log-btn').addEventListener('click', openLogModal)
document.getElementById('log-close').addEventListener('click', closeLogModal)

// ——— 顶栏那两个图标（M17.2 照设计稿加的）———
// 放大镜：直接把你送到下载页的"搜资源"那一栏，光标落进输入框，抬手就能打字
document.getElementById('top-search').addEventListener('click', () => {
  showPage('download')
  showDownloadTab('community')
  document.getElementById('mr-search').focus()
})

// 铃铛：就是"运行记录"的另一个入口（跟左下角那个「日志」是同一件事）
document.getElementById('top-bell').addEventListener('click', () => {
  document.getElementById('log-btn').click()
})

// ——— 窗口那三个键（M17.4：系统标题栏被我们去掉了，这三个只能自己接）———
document.getElementById('win-min').addEventListener('click', () => window.api.minimizeWindow())
document.getElementById('win-max').addEventListener('click', () => window.api.toggleMaximizeWindow())
document.getElementById('win-close').addEventListener('click', () => window.api.closeWindow())

/**
 * 最大化的时候，那个按钮要换成"还原"的样子（两个叠起来的方框）。
 * 【为什么用监听、不只在点击时改】双击顶栏、Win+↑、任务栏右键都能最大化，
 * 那时候界面这边是被动知道的，只能靠主进程推过来。
 */
function paintMaxButton(isMax) {
  document.getElementById('ico-max').classList.toggle('ico-off', Boolean(isMax))
  document.getElementById('ico-restore').classList.toggle('ico-off', !isMax)
  const button = document.getElementById('win-max')
  button.title = isMax ? '还原' : '最大化'
  button.setAttribute('aria-label', button.title)
}

window.api.onMaximizeChange(paintMaxButton)
window.api.isWindowMaximized().then(paintMaxButton).catch(() => {})

// 点弹窗外面（灰底）也能关
logModalEl.addEventListener('click', (event) => {
  if (event.target === logModalEl) closeLogModal()
})

// Esc 关弹窗：从最上面那层开始关（删除确认盖在版本设置上面）
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return

  if (!cancelModalEl.hidden) {
    cancelModalEl.hidden = true
    return
  }
  if (!delModalEl.hidden) {
    delModalEl.hidden = true
    deletingVersion = ''
    return
  }
  if (!verModalEl.hidden) {
    closeVersionSettings()
    return
  }
  if (!logModalEl.hidden) closeLogModal()
})

document.getElementById('log-folder').addEventListener('click', async () => {
  const result = await window.api.openLogFolder()
  if (!result.ok) logTitleEl.textContent = `打不开文件夹：${result.error}`
})

// ═══════════════════════════════════════
// 联机（M12）
// ═══════════════════════════════════════

const onlineNoticeEl = document.getElementById('online-notice')
const onlineStartEl = document.getElementById('online-start')
const onlineRoomEl = document.getElementById('online-room')
const onlineStatusPanelEl = document.getElementById('online-status-panel')

// ——— 联机页那两张入口卡片（M17.x）———
// 用户说原来那页"太臃肿"：房间码 + 连接状态 + 樱花穿透竖着摞一大条，进来不知道看哪儿。
// 现在上面两张正方形卡片当入口，点哪个、下面显示哪个（卡片一直留着，换另一个直接再点一下）。
const onlineModeCards = document.querySelectorAll('[data-online-mode]')
const onlineModePanes = document.querySelectorAll('[data-online-pane]')

function showOnlineMode(name) {
  for (const card of onlineModeCards) {
    card.classList.toggle('mode-card--on', card.dataset.onlineMode === name)
  }
  for (const pane of onlineModePanes) {
    pane.hidden = pane.dataset.onlinePane !== name
  }
}

for (const card of onlineModeCards) {
  card.addEventListener('click', () => showOnlineMode(card.dataset.onlineMode))
}
const onlineRoomTitleEl = document.getElementById('online-room-title')
const onlineCodeEl = document.getElementById('online-code')
const onlineMyIpEl = document.getElementById('online-myip')
const onlineTipEl = document.getElementById('online-tip')
const onlinePeersEl = document.getElementById('online-peers')
const onlinePeersEmptyEl = document.getElementById('online-peers-empty')
const onlineStatusTextEl = document.getElementById('online-status-text')
const onlineCodeInputEl = document.getElementById('online-code-input')
const onlineJoinHintEl = document.getElementById('online-join-hint')
const onlineCreateEl = document.getElementById('online-create')
/** "还没开局域网就想建房"时弹的那个提醒（M17.x）*/
const lanModalEl = document.getElementById('lan-modal')
const onlineJoinEl = document.getElementById('online-join')
const onlineCopyEl = document.getElementById('online-copy')
const onlineLeaveEl = document.getElementById('online-leave')

/** 房主的虚拟地址是固定的（联机模块里定死的），好友永远连这个 */
const HOST_VIRTUAL_IP = '10.126.126.1'

/** 版本可以挑的图标（就这几个够用了，不搞表情包大全） */
const VERSION_ICONS = ['', '⭐', '🔥', '🌿', '⛏', '🏰', '🧪', '🐷', '💎', '🚀', '🎮', '🛠']
/** 当前选中的图标 */
let pickedIcon = ''

function renderIconPicker(current) {
  pickedIcon = current || ''
  verIconsEl.textContent = ''

  for (const icon of VERSION_ICONS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = icon === pickedIcon ? 'icon-picker__item icon-picker__item--on' : 'icon-picker__item'
    // 第一个是"不要图标"，给个看得懂的写法
    button.textContent = icon || '无'
    button.title = icon || '不显示图标'
    button.addEventListener('click', () => {
      pickedIcon = icon
      renderIconPicker(icon)
    })
    verIconsEl.appendChild(button)
  }
}

/** 版本 JSON 里的 type → 跟用户说的话 */
const VERSION_TYPE_LABELS = {
  release: '正式版',
  snapshot: '快照（测试版，可能不稳定）',
  old_beta: '远古版 Beta',
  old_alpha: '远古版 Alpha'
}

/**
 * 把"将会使用哪个 Java"填进版本设置。
 *
 * 单独一个函数是因为它要跑一下 java.exe 才知道版本号，比较慢——
 * 不能卡着弹窗不让开（`versions:java` 那条 IPC 会现算）。
 */
async function renderVersionJava(id) {
  verJavaEl.textContent = '正在看…'
  verJavaEl.className = 'vermeta__v'

  try {
    const result = await window.api.getVersionJava(id, editingDir)
    if (editingVersion !== id) return // 看的过程中弹窗关了/换版本了

    if (!result.ok) {
      verJavaEl.textContent = result.error
      verJavaEl.className = 'vermeta__v'
      return
    }

    const short = String(result.path).replace(/^.*[\\/]runtime[\\/]/, '').replace(/[\\/]bin[\\/]java\.exe$/i, '')
    verJavaEl.textContent =
      `Java ${result.version || '?'}` +
      (short && short !== String(result.path) ? `（${short}）` : result.source ? `（${result.source}）` : '')
    verJavaEl.title = result.path

    if (result.mismatch) {
      verJavaEl.textContent += `　⚠ 这个版本建议 Java ${result.wanted}`
      verJavaEl.className = 'vermeta__v vermeta__v--warn'
    }
  } catch (error) {
    verJavaEl.textContent = `读不出来：${error.message}`
    verJavaEl.className = 'vermeta__v'
  }
}

/** 联机现在的状态（主进程给的原文） */
let onlineInfo = { running: false, peers: [], code: '', myIp: '', role: '' }
/** 游戏里"对局域网开放"用的端口（从游戏日志里抓的，没开就是 0） */
let lanPort = 0
/** 正在建房间 / 进房间（这时候按钮要禁用，免得点两遍） */
let onlineBusy = false
/** 在房间里的时候，定时去问一下状态（谁进来了、延迟多少） */
let onlineTimer = null

function setOnlineNotice(text, kind = 'info') {
  onlineNoticeEl.textContent = text
  onlineNoticeEl.classList.toggle('notice--ok', kind === 'ok')
  onlineNoticeEl.classList.toggle('notice--error', kind === 'error')
}

/** 进联机页时调一次：把现在的状态读回来画上去 */
async function refreshOnlinePage() {
  let status
  try {
    status = await window.api.onlineStatus()
  } catch (error) {
    setOnlineNotice(`联机状态读不出来：${error.message}`, 'error')
    return
  }

  if (!status.ok) {
    setOnlineNotice(status.error, 'error')
    return
  }

  onlineInfo = status
  renderOnline()

  // 启动时毛球自己收拾过残留（上次没退干净的联机进程 / 游戏已退出的空房间）——
  // 说一声，不然用户只知道"打开来没房间"，不知道毛球替他清过。
  // 这句在服务端是"读一次就清掉"的，所以不会反复弹。
  if (status.startupNote) setOnlineNotice(status.startupNote, 'ok')
}

/**
 * 把状态画到界面上。两种样子：
 *   · 还没进房间 → 显示"创建房间 / 加入房间"两块
 *   · 已经在房间里 → 显示房间码、房间里有谁、离开按钮
 */
function renderOnline() {
  // 【为什么还要看 code】光看 running 不够：EasyTier 残留的时候（毛球被强杀过），
  // running 是 true 但房间码是空的——那样界面上会显示成"你在好友的房间里"配一个空房间码，
  // 用户完全看不懂（他实测撞到过："为什么安装程序安装完就显示已经创建房间"）。
  // 主进程启动时已经会清掉这种残留（online.cleanupStray），这里再兜一层。
  const inRoom = onlineInfo.running && Boolean(onlineInfo.code)
  onlineStartEl.hidden = inRoom
  onlineRoomEl.hidden = !inRoom
  // 连接状态那块只在**真的开着房间**时露出来。
  // 以前它一直摆着，没开房间也写"还没连接"——用户点名说那样太占地方。
  onlineStatusPanelEl.hidden = !inRoom

  // 定时问状态的开关：在房间里才需要
  if (inRoom && !onlineTimer) {
    onlineTimer = setInterval(refreshOnlineSilently, 3000)
  } else if (!inRoom && onlineTimer) {
    clearInterval(onlineTimer)
    onlineTimer = null
  }

  if (!inRoom) {
    onlineStatusTextEl.textContent =
      '还没连接。创建或加入房间后，这里会显示：你是房主还是加入的人、连接方式（直连还是走了中转）、延迟多少。'
    return
  }

  const isHost = onlineInfo.role === 'host'
  // 房间里的人（下面写提示和列表都要用，所以先在顶上取出来）
  const peers = onlineInfo.peers || []
  onlineRoomTitleEl.textContent = isHost ? '你是房主' : '你在好友的房间里'
  onlineCodeEl.textContent = onlineInfo.code || '—'
  onlineMyIpEl.textContent = onlineInfo.myIp || (isHost ? '10.126.126.1' : '正在分配…')

  // 房主和访客要做的事不一样，提示也分开写。
  // 房主那边还分两种情况：世界还没对局域网开放 / 已经开了（抓到端口了）
  if (isHost) {
    // 【为什么不再提醒"去开局域网"】用户定的规矩是"世界没对局域网开放就不许建房"
    // （见下面 onlineCreateEl 的点击处理），所以能走到这一步就说明已经开好了——直接给地址。
    // 剩下这条兜底是给"建房以后游戏退了"（lanPort 会被清零）准备的。
    onlineTipEl.textContent = lanPort
      ? `世界已经开放了。把这个地址发给好友，让他在游戏里用「直接连接」填进去：` +
        `${HOST_VIRTUAL_IP}:${lanPort}（他的多人游戏列表里多半也会自动出现）`
      : '世界现在是关着的。要联机的话：进游戏开一个世界，按 Esc 点「对局域网开放」' +
        '——开了之后这里会自动出现发给好友的地址，房间不用重建。'
  } else if (peers.length > 0) {
    // 访客这边：**看到人了**才敢说"房主那边已经开好世界"
    // （用户这轮定的规矩：没开局域网不许建房，所以房主在就说明他开好了）
    onlineTipEl.textContent =
      '房主那边的世界已经开好了。去游戏里点「多人游戏」——列表里应该能看到；' +
      '看不到就让房主把地址发你，用「直接连接」填进去。'
  } else {
    // 房间里一个人都没有 —— 这时候说"房主世界开好了"就是骗人
    // （实测：随手编一个房间码也能"进去"，因为房间码只是给虚拟网络起个名字，
    //   没有一个服务器能回答"这个房间存在吗"。所以这儿只能如实说：没人）
    onlineTipEl.textContent =
      '这个房间里现在只有你一个 —— 房主还没上来，或者房间码打错了。' +
      '等房主那边开了房间，这里会自动看到人。'
  }

  // 房间里的人（peers 在上面已经取过了）
  onlinePeersEl.textContent = ''
  onlinePeersEmptyEl.hidden = peers.length > 0
  // 空着的时候说什么，房主和访客不一样：让访客"把房间码发给好友"是牛头不对马嘴
  onlinePeersEmptyEl.textContent = isHost
    ? '还没有别人进来。把房间码发给好友吧。'
    : '房间里还没看到别人 —— 房主可能还没上来（房间码打错了也会是这样）。'

  for (const one of peers) {
    const li = document.createElement('li')
    li.className = 'peer'

    const name = document.createElement('span')
    name.className = 'peer__name'
    name.textContent = `${one.name}（${one.ip}）`
    li.appendChild(name)

    const tag = document.createElement('span')
    tag.className = `peer__tag peer__tag--${one.route === 'relay' ? 'relay' : 'direct'}`
    tag.textContent =
      (one.route === 'relay' ? '中转' : '直连') + (one.latencyMs !== null ? ` · ${one.latencyMs}ms` : '')
    li.appendChild(tag)

    onlinePeersEl.appendChild(li)
  }

  // 【说人话，别说假话】以前这儿对访客一律写"已连上房主的房间"——
  // 可房间码只是给虚拟网络起个名字，**没有一个服务器能回答"这个房间存在吗"**：
  // 随手编一串码也能"进去"（实测用户编了个 DAADUBRV，界面照样说已连上）。
  // 所以有没有连上，只能看"房间里有没有别人"。
  if (isHost) {
    onlineStatusTextEl.textContent = `房间开着，里面有 ${peers.length} 位好友。`
  } else if (peers.length > 0) {
    onlineStatusTextEl.textContent = `连上房主了，房间里一共 ${peers.length + 1} 个人。`
  } else {
    onlineStatusTextEl.textContent =
      '还没看到房主——房间码已经用上了，但这个房间里现在一个人都没有。'
  }
}

/** 定时刷新（不弹错误、不闪界面，安安静静地更新） */
async function refreshOnlineSilently() {
  if (onlineBusy) return
  try {
    const status = await window.api.onlineStatus()
    if (status.ok) {
      onlineInfo = status
      renderOnline()
    }
  } catch {
    // 问不到就先不动，下一轮再说
  }
}

/** 建房间或者进房间（两个按钮走同一条路，只有 role 不一样） */
async function startOnline(role) {
  if (onlineBusy) return

  if (role === 'guest') {
    const typed = onlineCodeInputEl.value
    if (!typed.trim()) {
      onlineJoinHintEl.textContent = '先把房间码填上'
      onlineJoinHintEl.className = 'delbox delbox--warn'
      return
    }
  }

  onlineBusy = true
  onlineCreateEl.disabled = true
  onlineJoinEl.disabled = true
  onlineJoinHintEl.textContent = ''
  onlineJoinHintEl.className = 'delbox'

  try {
    setOnlineNotice(
      role === 'host'
        ? '正在建房间…（第一次会下载联机组件；中途可能弹一次系统权限确认，点是就行）'
        : '正在进房间…（中途可能弹一次系统权限确认，点是就行）'
    )

    const result = await window.api.onlineStart({
      role,
      code: role === 'guest' ? onlineCodeInputEl.value : ''
    })

    if (!result.ok) {
      setOnlineNotice(result.error, 'error')
      if (role === 'guest') {
        onlineJoinHintEl.textContent = result.error
        onlineJoinHintEl.className = 'delbox delbox--warn'
      }
      return
    }

    onlineInfo = {
      ok: true,
      running: true,
      code: result.code,
      role: result.role,
      myIp: result.ip || '',
      peers: []
    }
    onlineCodeInputEl.value = ''
    setOnlineNotice(
      role === 'host'
        ? '房间建好了！把房间码发给好友。'
        : // 别一上来就说"进房间了"——那会儿还没跟任何人握上手，
          // 说得跟真连上了似的，用户会以为房主已经在等他了
          '房间码填上了。正在找房主……几个人算连上，下面那行"连接状态"会说实话。',
      'ok'
    )
    renderOnline()
  } catch (error) {
    setOnlineNotice(`出错了：${error.message}`, 'error')
  } finally {
    onlineBusy = false
    onlineCreateEl.disabled = false
    onlineJoinEl.disabled = false
  }
}

// 「创建房间」：**世界没对局域网开放就不让建**（用户 2026-10-08 定的规矩）。
// 【怎么判断"开了没"】看 lanPort —— 它是从游戏日志里抓到的端口号
// （游戏里点「对局域网开放」时会打一行 `Started serving on 54321`）。
// 游戏一退出，主进程会推 exited，那边把 lanPort 清零。
onlineCreateEl.addEventListener('click', () => {
  if (!lanPort) {
    lanModalEl.hidden = false
    return
  }
  startOnline('host')
})
document.getElementById('lan-modal-ok').addEventListener('click', () => {
  lanModalEl.hidden = true
})
lanModalEl.addEventListener('click', (event) => {
  // 点弹窗外面（灰底）也能关
  if (event.target === lanModalEl) lanModalEl.hidden = true
})
onlineJoinEl.addEventListener('click', () => startOnline('guest'))
onlineCodeInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') startOnline('guest')
})

onlineCopyEl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(onlineInfo.code || '')
    onlineCopyEl.textContent = '复制好了'
    setTimeout(() => (onlineCopyEl.textContent = '复制房间码'), 1500)
  } catch {
    onlineCopyEl.textContent = '复制不了，手动抄一下吧'
    setTimeout(() => (onlineCopyEl.textContent = '复制房间码'), 1500)
  }
})

/**
 * 退出房间。两条路都走这儿：用户点「离开房间」、以及**游戏退出时自动退**。
 * @param {string} why 退完在联机页上说的那句话
 */
async function leaveRoomNow(why) {
  try {
    await window.api.onlineLeave()
    onlineInfo = { ok: true, running: false, peers: [], code: '', myIp: '', role: '' }
    setOnlineNotice(why, 'ok')
    renderOnline()
  } catch (error) {
    setOnlineNotice(`离开房间时出错：${error.message}`, 'error')
  }
}

onlineLeaveEl.addEventListener('click', async () => {
  onlineLeaveEl.disabled = true
  try {
    await leaveRoomNow('已离开房间，虚拟网卡也收掉了。')
  } finally {
    onlineLeaveEl.disabled = false
  }
})

// 主进程推过来的阶段提示（"正在下载组件…""正在创建虚拟网卡…"）
window.api.onOnlineStage((text) => setOnlineNotice(text))

// ═══════════════════════════════════════
// 联机：VoxLink（现在只做到「房间」这一层）
// ═══════════════════════════════════════
//
// ⚠️ 这一块跟上面的「房间码联机」（EasyTier）是**两码事**，别混：
//    · 上面那套 —— 毛球自己用 EasyTier 搭虚拟局域网（8 位码）
//    · 这一套 —— 借 VoxLink 的公共服务器牵线（6 位码）
// 现在这一套只做到"房间码是真的、服务器认得"，**还连不上游戏**。
// 所以下面所有文案都必须把这句话说清楚，不许含糊成"能联机了"。

const voxlinkNoticeEl = document.getElementById('voxlink-notice')
const voxlinkStartEl = document.getElementById('voxlink-start')
const voxlinkStatusPanelEl = document.getElementById('voxlink-status-panel')
const voxlinkStatusTextEl = document.getElementById('voxlink-status-text')
const voxlinkNameEl = document.getElementById('voxlink-name')
const voxlinkCodeInputEl = document.getElementById('voxlink-code-input')
const voxlinkCreateEl = document.getElementById('voxlink-create')
const voxlinkJoinEl = document.getElementById('voxlink-join')
const voxlinkLeaveEl = document.getElementById('voxlink-leave')
const voxlinkCopyEl = document.getElementById('voxlink-copy')

const VOXLINK_DEFAULT_NOTICE =
  '这是 VoxLink 的房间：房间码是真的，服务器认得。' +
  '但"把游戏连起来"那一步还没做完，所以现在还不能真的联机玩——这一步只是把地基打好。'

let voxlinkState = { ok: true, state: 'idle', code: '', isHost: false, room: null, serverUrl: '' }

function setVoxlinkNotice(text, kind = 'info') {
  if (!voxlinkNoticeEl) return
  voxlinkNoticeEl.textContent = text
  voxlinkNoticeEl.classList.toggle('notice--ok', kind === 'ok')
  voxlinkNoticeEl.classList.toggle('notice--error', kind === 'error')
}

/** 按当前状态把这一块画出来 */
function renderVoxlink() {
  if (!voxlinkStartEl) return
  const inRoom = voxlinkState.state === 'hosting' || voxlinkState.state === 'in_room'

  voxlinkStartEl.hidden = inRoom
  voxlinkStatusPanelEl.hidden = !inRoom
  if (!inRoom) return

  // 注意：房间名是从服务器回来的，属于"外部内容"，只能用 textContent 拼，
  // 不能用 innerHTML —— 这是毛球的死规矩。
  const room = voxlinkState.room || {}
  const lines = []
  lines.push(voxlinkState.isHost ? '你是房主。' : '你在好友的房间里。')
  lines.push(`房间码：${voxlinkState.code}`)
  // 房间名要先过服务器审核。审核没放行时，服务器回的不是名字，而是一个
  // 占位符「name_pending_review」—— 那是给程序看的记号，原样显示给用户就是个谜语。
  const namePending = room.nameApproved === false || room.name === 'name_pending_review'
  if (namePending) {
    lines.push(room.requestedName
      ? `房间名：${room.requestedName}（服务器在审核，先按这个名字排着）`
      : '房间名：服务器正在审核，暂时看不到')
  } else if (room.name) {
    lines.push(`房间名：${room.name}`)
  }
  lines.push(`服务器：${voxlinkState.serverUrl}`)
  if (voxlinkState.state === 'hosting') {
    lines.push('把这个 6 位房间码发给好友。')
  }
  lines.push('（提醒：现在还连不上游戏，这一步只是房间建出来了。）')
  voxlinkStatusTextEl.textContent = lines.join('\n')
}

async function refreshVoxlink() {
  try {
    const status = await window.api.voxlinkStatus()
    voxlinkState = status
    renderVoxlink()
  } catch (error) {
    setVoxlinkNotice(`读不到 VoxLink 状态：${error.message}`, 'error')
  }
}

// 点到这张卡片时刷一次（顺便探一下服务器活着没——省得对着死服务器白点）
document.querySelector('[data-online-mode="voxlink"]')?.addEventListener('click', async () => {
  await refreshVoxlink()
  if (voxlinkState.state === 'idle') {
    const ping = await window.api.voxlinkPing()
    if (!ping.ok) {
      setVoxlinkNotice(`连不上 VoxLink 服务器（${ping.error}）。等会儿再试，或者在设置里换一台。`, 'error')
    }
  }
})

voxlinkCreateEl?.addEventListener('click', async () => {
  voxlinkCreateEl.disabled = true
  try {
    setVoxlinkNotice('正在建房…')
    const result = await window.api.voxlinkCreate({
      name: String(voxlinkNameEl?.value || '').trim() || undefined
    })
    if (!result.ok) {
      setVoxlinkNotice(`建房没成功：${result.error}`, 'error')
      return
    }
    await refreshVoxlink()
    setVoxlinkNotice(`房间建好了，房间码是 ${result.code}。把它发给好友。`, 'ok')
  } finally {
    voxlinkCreateEl.disabled = false
  }
})

voxlinkJoinEl?.addEventListener('click', async () => {
  const code = String(voxlinkCodeInputEl?.value || '').trim().toUpperCase()
  if (code.length !== 6) {
    setVoxlinkNotice('房间码是 6 位（字母和数字，不含 I、O、0、1）。', 'error')
    return
  }
  voxlinkJoinEl.disabled = true
  try {
    setVoxlinkNotice('正在加入…')
    const result = await window.api.voxlinkJoin({ code })
    if (!result.ok) {
      setVoxlinkNotice(`进不去：${result.error}`, 'error')
      return
    }
    await refreshVoxlink()
    setVoxlinkNotice('进去了。', 'ok')
  } finally {
    voxlinkJoinEl.disabled = false
  }
})

voxlinkLeaveEl?.addEventListener('click', async () => {
  voxlinkLeaveEl.disabled = true
  try {
    await window.api.voxlinkLeave()
    await refreshVoxlink()
    setVoxlinkNotice('已经退出来了。', 'ok')
  } finally {
    voxlinkLeaveEl.disabled = false
  }
})

voxlinkCopyEl?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(voxlinkState.code || '')
    voxlinkCopyEl.textContent = '复制好了'
    setTimeout(() => (voxlinkCopyEl.textContent = '复制房间码'), 1500)
  } catch {
    voxlinkCopyEl.textContent = '复制不了，手动抄一下吧'
    setTimeout(() => (voxlinkCopyEl.textContent = '复制房间码'), 1500)
  }
})

// 主进程推过来的阶段提示（"正在找游戏的端口…"）
window.api.onVoxlinkStage((text) => setVoxlinkNotice(text))

refreshVoxlink()

// ═══════════════════════════════════════
// 版本号
// ═══════════════════════════════════════

// 版本号问主进程要（来自 package.json），左下角和导航栏角标都填它。
// 读不到就显示"未知"——总比显示一个错的版本号强
window.api
  .getAppVersion()
  .then((version) => {
    const text = version || '未知'
    document.getElementById('stat-left').textContent = `版本 ${text}`
    document.getElementById('rail-badge').textContent = text
  })
  .catch(() => {})

// 个性化设置要在开机时就套上：藏了哪些页面、背景图、背景音乐、顶栏样式
// （读失败就当没设过——这些是"看着玩"的东西，不该拦住软件启动）
window.api
  .getSettings()
  .then((config) => {
    if (!config) return
    settingsInfo = config
    applyLook(config.look)
  })
  .catch(() => {})


// ═══════════════════════════════════════
// 个性化（M13）：藏页面 / 背景图 / 背景音乐 / 顶栏样式
// ═══════════════════════════════════════

const bgmEl = document.getElementById('bgm')

/**
 * 本机路径 → 界面能用的网址。
 *
 * 【为什么要转】Windows 的路径是 `D:\图片\背景.png` 这种反斜杠，
 * 直接塞进 CSS 的 url() 或 <audio src> 里会被当成转义字符，图/音乐都出不来。
 * 顺手把中文之类的字符编码一下（encodeURI），免得空格和中文把地址截断。
 */
function toFileUrl(localPath) {
  const forward = String(localPath || '').replace(/\\/g, '/')
  return encodeURI(forward.startsWith('/') ? `file://${forward}` : `file:///${forward}`)
}
const lookPagesEl = document.getElementById('look-pages')
const lookBgEl = document.getElementById('look-bg')
const lookBgmEl = document.getElementById('look-bgm')
const lookHintEl = document.getElementById('look-hint')
const lookThemesEl = document.getElementById('look-themes')

/** 可以藏的页面（「启动」「设置」不给藏——藏了就没地方改回来） */
const HIDEABLE_PAGES = [
  { key: 'online', label: '联机', hint: '不玩联机就藏起来' },
  { key: 'download', label: '下载', hint: '版本都装好了、也不装 Mod 的话可以藏' },
  { key: 'help', label: '帮助', hint: '常见问题那一页' }
]

/** 顶栏样式 */
const THEMES = [
  // M17.x：用户把之前那几套主题全删了，只留霓虹紫青 + 新加的 4 套深色。
// 名字后面一律带上"亮色/暗色 · 什么色系"，不然几套深色主题光看色点分不出来。
  { key: 'neon', label: '霓虹紫青（暗色 · 图纸同款）', colors: ['#9a5cf7', '#2fd4e8', '#141a2e'] },
  { key: 'aurora', label: '冷色极光（暗色 · 紫蓝青）', colors: ['#9a5cf7', '#5b7cff', '#2fd4e8'] },
  { key: 'magenta', label: '品红霓虹（暗色 · 紫粉）', colors: ['#ff5eb3', '#b85cf0', '#7a5cff'] },
  { key: 'emerald', label: '翡翠夜（暗色 · 青绿）', colors: ['#2dd4a8', '#22c8d8', '#4a90ff'] },
  { key: 'amber', label: '琥珀夜（暗色 · 橙粉）', colors: ['#ff9a4d', '#f76a8b', '#a85cf0'] },
]

/**
 * 把个性化设置套到界面上。
 *
 * 【为什么每次都整个套一遍】设置可能被别处改过（比如刚在这页点了"藏起来"），
 * 与其记"改了什么"，不如每次照当前配置重画一遍——少一种出错的可能。
 */
function applyLook(look) {
  const settingsLook = look || {}

  // ① 藏页面
  const hidden = settingsLook.hiddenPages || []
  for (const button of navButtons) {
    const page = button.dataset.page
    if (page === 'launch' || page === 'settings') continue
    button.hidden = hidden.includes(page)
  }

  // 藏起来的页面正开着的话，切回启动页（不然用户会看到一片空白）
  const current = [...pages].find((page) => !page.hidden)
  if (current && hidden.includes(current.dataset.page)) showPage('launch')

  // ② 背景图（Windows 的路径是反斜杠，塞进 url() 里必须换成正斜杠）
  //
  // 【只换图，不碰压色】整页背景在 CSS 里是两层：压色（--page-veil）+ 图（--page-image）。
  // 压色按主题定好（浅色主题压一层白、深色主题压一层暗），所以换成什么图，
  // 上面的字都看得清。以前是直接往 body 盖 backgroundImage——顺手把那层压色也顶掉了，
  // 亮图上的字当场看不清（2026-10-08 用户踩过）。没选图就 removeProperty，
  // 自动回落到主题自带的那张风景图。
  if (settingsLook.background) {
    document.body.style.setProperty('--page-image', `url("${toFileUrl(settingsLook.background)}")`)
  } else {
    document.body.style.removeProperty('--page-image')
  }

  // ③ 背景音乐：换一首就重放（同一个文件别打断）
  if (bgmEl.dataset.src !== (settingsLook.bgm || '')) {
    bgmEl.dataset.src = settingsLook.bgm || ''
    if (settingsLook.bgm) {
      bgmEl.src = toFileUrl(settingsLook.bgm)
      bgmEl.volume = Math.min(1, Math.max(0, (Number(settingsLook.bgmVolume) || 40) / 100))
      // 浏览器不许自动播放声音，得等用户先点一下页面——所以这里只准备，不硬播
      bgmEl.play().catch(() => {
        lookHintEl.textContent = '背景音乐准备好了，点一下界面就会开始放。'
      })
    } else {
      bgmEl.pause()
      bgmEl.removeAttribute('src')
    }
  }

  // ④ 主题配色（M14.1：整个界面的配色都由这个属性决定，见 style.css 开头的主题块）
  document.body.dataset.theme = settingsLook.theme || 'neon'
}

/** 用户第一次点页面时，把没放成的背景音乐补上（浏览器的自动播放限制） */
function resumeBgmOnce() {
  if (bgmEl.dataset.src && bgmEl.paused) bgmEl.play().catch(() => {})
  window.removeEventListener('click', resumeBgmOnce)
}
window.addEventListener('click', resumeBgmOnce)

/** 画「个性化」那一栏 */
function renderLookTab() {
  const look = settingsInfo?.look || {}

  // 页面开关
  lookPagesEl.textContent = ''
  for (const one of HIDEABLE_PAGES) {
    const label = document.createElement('label')
    label.className = 'check check--block'

    const input = document.createElement('input')
    input.type = 'checkbox'
    // 勾上 = 显示（对用户来说，"显示联机"比"藏起联机"好理解）
    input.checked = !(look.hiddenPages || []).includes(one.key)
    input.addEventListener('change', async () => {
      const hiddenNow = HIDEABLE_PAGES.filter((page) => {
        if (page.key === one.key) return !input.checked
        const box = lookPagesEl.querySelector(`input[value="${page.key}"]`)
        return box ? !box.checked : (look.hiddenPages || []).includes(page.key)
      }).map((page) => page.key)

      await saveLook({ hiddenPages: hiddenNow })
    })
    input.value = one.key
    label.appendChild(input)

    const span = document.createElement('span')
    const title = document.createElement('b')
    title.textContent = one.label
    span.appendChild(title)
    const help = document.createElement('em')
    help.className = 'check__help'
    help.textContent = one.hint
    span.appendChild(help)
    label.appendChild(span)

    lookPagesEl.appendChild(label)
  }

  lookBgEl.value = look.background || ''
  lookBgmEl.value = look.bgm || ''

  // 主题配色：每个是一条"配色卡片"，左边三个小圆点先让人看出是什么颜色
  lookThemesEl.textContent = ''
  for (const one of THEMES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className =
      (look.theme || 'neon') === one.key ? 'theme-card theme-card--on' : 'theme-card'

    const dots = document.createElement('span')
    dots.className = 'theme-card__dots'
    for (const color of one.colors || []) {
      const dot = document.createElement('i')
      dot.style.background = color
      dots.appendChild(dot)
    }
    button.appendChild(dots)

    const label = document.createElement('span')
    label.textContent = one.label
    button.appendChild(label)

    button.addEventListener('click', () => saveLook({ theme: one.key }))
    lookThemesEl.appendChild(button)
  }
}

/** 存个性化设置，然后立刻套上去 */
async function saveLook(patch) {
  try {
    const result = await window.api.setSettings({ look: patch })
    if (!result.ok) {
      lookHintEl.textContent = result.error
      return
    }
    settingsInfo = { ...settingsInfo, look: { ...(settingsInfo?.look || {}), ...patch } }
    applyLook(settingsInfo.look)
    renderLookTab()
    lookHintEl.textContent = '改好了，立刻生效。'
  } catch (error) {
    lookHintEl.textContent = `存不下来：${error.message}`
  }
}

document.getElementById('look-bg-pick').addEventListener('click', async () => {
  const picked = await window.api.pickLookFile('background')
  if (picked.ok) await saveLook({ background: picked.path })
})

document.getElementById('look-bg-clear').addEventListener('click', () => saveLook({ background: '' }))

document.getElementById('look-bgm-pick').addEventListener('click', async () => {
  const picked = await window.api.pickLookFile('bgm')
  if (picked.ok) await saveLook({ bgm: picked.path })
})

document.getElementById('look-bgm-clear').addEventListener('click', () => saveLook({ bgm: '' }))

// ——— 设置搜索（M14.2）———

const setSearchEl = document.getElementById('set-search')
const setSearchHintEl = document.getElementById('set-search-hint')

/**
 * 按关键字过滤设置。
 *
 * 【怎么过滤的】搜索时把**所有栏**都露出来，只留下"文字里含这个关键字"的块——
 * 这样用户搜"内存"就能直接看到它属于哪一栏、在哪儿，不用自己一栏一栏翻。
 * 清空搜索框就恢复成正常的一栏一栏。
 */
function doSettingsSearch() {
  const keyword = setSearchEl.value.trim().toLowerCase()

  if (!keyword) {
    setSearchHintEl.textContent = ''
    // 恢复：每块都显示，然后回到当前那一栏
    for (const tab of settingsTabEls) {
      for (const block of tab.children) block.hidden = false
    }
    showSettingsTab(currentSettingsTab)
    return
  }

  let hits = 0
  for (const tab of settingsTabEls) {
    tab.hidden = false // 先都露出来
    const tabName =
      (settingsMenuEl.querySelector(`[data-settings-tab="${tab.dataset.settingsTab}"]`) || {})
        .textContent || ''

    for (const block of tab.children) {
      // 搜索框自己不算
      if (block.classList.contains('setsearch')) continue

      const match = block.textContent.toLowerCase().includes(keyword)
      block.hidden = !match
      if (match) hits++
    }

    // 这一栏一条都没命中，就把它整栏收起来（栏里光剩个空壳更难看）
    const anyVisible = [...tab.children].some((one) => !one.hidden && !one.classList.contains('setsearch'))
    if (!anyVisible) tab.hidden = true
    else tab.dataset.foundIn = tabName.trim()
  }

  setSearchHintEl.textContent = hits
    ? `找到 ${hits} 处，都在上面了（清空搜索框就恢复）`
    : `没找到「${setSearchEl.value.trim()}」——换个词试试，比如"内存""Java""下载"`
}

setSearchEl.addEventListener('input', doSettingsSearch)

// ═══════════════════════════════════════
// 已安装的版本（M14.3：从启动页那个小列表里搬出来的完整页面）
// ═══════════════════════════════════════

const insSearchEl = document.getElementById('ins-search')
const insFilterEl = document.getElementById('ins-filter')
const insStatusEl = document.getElementById('ins-status')
const insListEl = document.getElementById('ins-list')

/** 当前筛选用的是哪个：all / fav / loader */
let insFilter = 'all'

/** "最近游玩"显示成人话 */
function lastPlayedText(stamp) {
  if (!stamp) return '还没玩过'
  const days = Math.floor((Date.now() - stamp) / 86400000)
  if (days <= 0) return '今天玩过'
  if (days === 1) return '昨天玩过'
  if (days < 30) return `${days} 天前玩过`
  const date = new Date(stamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 玩过`
}

/** 把版本列表画出来（带搜索和筛选） */
function renderInstalled() {
  const keyword = insSearchEl.value.trim().toLowerCase()

  let list = versionList()

  if (insFilter === 'fav') list = list.filter((one) => one.favorite)
  if (insFilter === 'loader') list = list.filter((one) => one.loader)

  if (keyword) {
    list = list.filter((one) =>
      [one.id, one.name, one.category, one.loader, one.dir]
        .filter(Boolean)
        .some((text) => String(text).toLowerCase().includes(keyword))
    )
  }

  // 收藏排前面；都是收藏（或都不是）就按"最近玩过"排
  list = [...list].sort(
    (a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastPlayed || 0) - (a.lastPlayed || 0)
  )

  insListEl.textContent = ''

  const total = versionList().length
  insStatusEl.textContent = total === 0
    ? '还没装过任何版本。上面「原版游戏」那一栏可以装。'
    : `一共 ${total} 个版本${list.length !== total ? `，筛出来 ${list.length} 个` : ''}`

  for (const one of list) {
    const li = document.createElement('li')
    li.className = 'veritem'

    // 收藏星星（点一下切换）
    const star = document.createElement('button')
    star.type = 'button'
    star.className = one.favorite ? 'star star--on' : 'star'
    star.title = one.favorite ? '取消收藏' : '收藏这个版本'
    star.textContent = one.favorite ? '★' : '☆'
    star.addEventListener('click', async () => {
      await window.api.updateVersion(
        one.id,
        { name: one.name, note: one.note, icon: one.icon, category: one.category, favorite: !one.favorite },
        one.dir
      )
      await refreshLaunchFacts()
      renderInstalled()
    })
    li.appendChild(star)

    const box = document.createElement('div')
    box.className = 'veritem__main'

    const title = document.createElement('div')
    title.className = 'veritem__name'
    title.textContent = (one.icon ? `${one.icon} ` : '') + (one.name ? `${one.name}（${one.id}）` : one.id)
    box.appendChild(title)

    const meta = document.createElement('div')
    meta.className = 'veritem__meta'
    const bits = []
    if (one.type) bits.push(VERSION_TYPE_LABELS[one.type] || one.type)
    if (one.loader) bits.push(one.loader)
    if (one.category) bits.push(one.category)
    bits.push(one.isDefault ? '默认目录' : one.dir)
    bits.push(lastPlayedText(one.lastPlayed))
    meta.textContent = bits.join(' · ')
    box.appendChild(meta)

    li.appendChild(box)

    const actions = document.createElement('div')
    actions.className = 'veritem__actions'

    const manage = document.createElement('button')
    manage.type = 'button'
    manage.className = 'btn btn--ghost btn--sm'
    manage.textContent = '管理'
    manage.addEventListener('click', () => {
      // 先把启动页选成这个版本，再打开版本设置（那套逻辑是按"当前选中"来的）
      selectedVersion = one.id
      selectedDir = one.dir
      refreshLaunchUi()
      openVersionSettings()
    })
    actions.appendChild(manage)

    const play = document.createElement('button')
    play.type = 'button'
    play.className = 'btn btn--ghost btn--sm'
    play.textContent = '▶ 启动'
    play.addEventListener('click', async () => {
      selectedVersion = one.id
      selectedDir = one.dir
      refreshLaunchUi()
      showPage('launch')
      // 账号还没弄好的话先别启动——启动页那边会提示缺什么
      if (!accountProblem()) startGame()
      else setNotice(accountProblem())
    })
    actions.appendChild(play)

    const folder = document.createElement('button')
    folder.type = 'button'
    folder.className = 'btn btn--ghost btn--sm'
    folder.textContent = '文件夹'
    folder.addEventListener('click', async () => {
      const result = await window.api.openVersionFolder(one.id, 'version', one.dir)
      if (!result.ok) insStatusEl.textContent = `打不开文件夹：${result.error}`
    })
    actions.appendChild(folder)

    li.appendChild(actions)
    insListEl.appendChild(li)
  }
}

insSearchEl.addEventListener('input', renderInstalled)

insFilterEl.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip')
  if (!chip) return
  insFilter = chip.dataset.insFilter
  for (const one of insFilterEl.querySelectorAll('.chip')) {
    one.classList.toggle('chip--on', one === chip)
  }
  renderInstalled()
})

// ═══════════════════════════════════════
// 3D 皮肤预览（M14.4）
// 真正的渲染在 skin3d.js 里（它要 import Three.js，得是模块脚本）；
// 这里只管"什么时候挂上去、换皮肤、记住上次选的"。
// ═══════════════════════════════════════

const skinStageEl = document.getElementById('skin-stage')
// 【卡片下面那行提示已经去掉了】（用户 2026-10-09："把皮肤下面的，提示去掉，不需要"）
// 以前那儿写着"鼠标左右移动，小人就跟着转"这类话，现在页面干净了；万一 3D 起不来，
// 走右下角那个全局提示（setNotice）说一声

/** 3D 那块挂上了没有（模块脚本是异步加载的，可能要等一会儿） */
let skinMounted = false

/** 等 skin3d.js 加载好（它挂 window.skinViewer 出来） */
function whenSkinReady(callback) {
  if (window.skinViewer) return callback()
  let tries = 0
  const timer = setInterval(() => {
    tries++
    if (window.skinViewer) {
      clearInterval(timer)
      callback()
    } else if (tries > 40) {
      clearInterval(timer)
      // 3D 起不来（多半是显卡驱动的事）——不挡人，右下角说一句就完
      setNotice('3D 预览起不来（可能是显卡驱动的问题），不影响玩游戏。', 'error')
    }
  }, 100)
}

/** 按存的路径加载皮肤文件 */
// ——— 左上角那个圆头像（M17.x）———
// 设计稿上它就是个**玩家的脑袋**。所以登录账号（或自己选了皮肤文件）之后，
// 这里把皮肤图里的头部裁出来换上；没有皮肤就退回 HTML 里那个手画的小脑袋。
const railAvatarEl = document.getElementById('rail-avatar')

/**
 * 把皮肤图里的"头部"裁出来，当左上角的头像。
 *
 * 【为什么要裁】皮肤是一整张 64×64 的图，脑袋只占左上角一小块 8×8；
 * 整张塞进去只会看到一堆手脚。
 * 【帽子层】脑袋正面在 (8,8)，"帽子层"在 (40,8)——那是一层能盖在头上的透明贴图
 * （有人拿它画帽檐、耳机）。叠上去就对了；没有内容的皮肤这层是透明的，画了也不变。
 */
function paintAvatar(image) {
  try {
    const piece = document.createElement('canvas')
    piece.width = 8
    piece.height = 8
    const brush = piece.getContext('2d')
    brush.imageSmoothingEnabled = false
    brush.drawImage(image, 8, 8, 8, 8, 0, 0, 8, 8)
    brush.drawImage(image, 40, 8, 8, 8, 0, 0, 8, 8)

    for (const old of railAvatarEl.querySelectorAll('canvas')) old.remove()
    railAvatarEl.appendChild(piece)
    railAvatarEl.classList.add('is-skin')
  } catch {
    // 裁不出来就先不换——别把原来那个小脑袋也弄没了
  }
}

/** 退回默认那个手画的头像（退出登录、皮肤读不出来的时候）*/
function clearAvatar() {
  for (const old of railAvatarEl.querySelectorAll('canvas')) old.remove()
  railAvatarEl.classList.remove('is-skin')
}

/**
 * 现在这个小人身上贴的是哪张图（M17.5 加的）。
 * 皮肤页那个头像圈要拿它现裁一个脑袋——
 * 【为什么不能 cloneNode 现成的头像】canvas 被 cloneNode 复制出来是**空白**的
 * （只复制标签属性，不复制画面），实测头像圈一直是个空圈。
 * 所以这里记着原图，用谁就现裁谁。
 */
let currentSkinImage = null

/** 换皮肤时**两个地方一起换**：右边那个 3D 小人 + 左边这个圆头像 */
function applySkin(image) {
  currentSkinImage = image
  window.skinViewer.setSkin(image)
  paintAvatar(image)
}

/** 换回默认皮肤时也一样，两个地方一起退 */
function useDefaultSkinAndAvatar() {
  currentSkinImage = window.skinViewer ? window.skinViewer.makeDefaultSkin() : null
  window.skinViewer.useDefaultSkin()
  clearAvatar()
}

function loadSkinFrom(path) {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      applySkin(image)
      resolve(true)
    }
    image.onerror = () => resolve(false)
    image.src = toFileUrl(path)
  })
}

/** 启动页露出来的时候把 3D 挂上（只挂一次） */
function ensureSkinCard() {
  if (skinMounted) return
  whenSkinReady(async () => {
    window.skinViewer.mount(skinStageEl)
    skinMounted = true
    // 毛球自带的那几张示例皮肤，第一次运行时存成真文件（只做一次）
    await seedBundledSkins()
    await applyCurrentSkin()
  })
}

/**
 * 把 3D 小人搬到这个容器里（M17.5）。
 *
 * 【为什么要搬】启动页和皮肤页都要看小人，但 WebGL 只开一个
 * （开两个白烧一份显存，而且两边的"跟着鼠标转"会打架）。
 * 画布跟着当前显示的页面走，见 skin3d.js 的 mount。
 */
function moveSkinViewerTo(container, zoom) {
  if (!skinMounted || !window.skinViewer || !container) return
  window.skinViewer.mount(container, zoom)
}

document.getElementById('skin-pick').addEventListener('click', async () => {
  const picked = await window.api.pickSkinFile()
  if (!picked.ok) return

  const loaded = await loadSkinFrom(picked.path)
  if (!loaded) {
    return
  }

  await saveLook({ skin: picked.path })
})

document.getElementById('skin-reset').addEventListener('click', async () => {
  useDefaultSkinAndAvatar()
  await saveLook({ skin: '' })
})

// ——————————————————————————————————————————————
// 账号皮肤（M16.3）：登了真账号就把小人换成你自己的皮肤
// ——————————————————————————————————————————————

/** 上一次是按哪个账号取的皮肤——记着它，免得每次刷新界面都重新下一遍 */
let skinAccountKey = ''

/**
 * 账号变了就换皮肤。
 *
 * 【离线账号不管】它没有"网上的皮肤"，保持用户自己选的那张（或默认）。
 * 【取不到不算错】网络抖一下、账号压根没设皮肤——都只提示一句、保持现状，
 * 绝不能因为这个把人挡住不让玩。
 */
async function refreshAccountSkin() {
  const account = launchInfo?.account
  const remote = account && (account.type === 'yggdrasil' || account.type === 'microsoft')
  const useAccount = remote && settingsInfo?.look?.useAccountSkin !== false
  const showAccount = Boolean(useAccount)
  const key = showAccount ? `${account.type}:${account.uuid}` : ''

  const saved = String(settingsInfo?.look?.skin || '')
  const wanted = showAccount ? `account:${key}` : saved ? `file:${saved}` : 'default'
  if (wanted === skinAccountKey) return
  skinAccountKey = wanted

  whenSkinReady(() => applyCurrentSkin())
}

/**
 * 按"用户选的那一项"把皮肤换上去（M17.5）。
 *
 * 三选一，优先级从高到低：
 *   ① 账号上的（设置里"用账号上的皮肤"开着，而且账号确实有）
 *   ② 你自己传的那张（皮肤页里点过「使用」）
 *   ③ 系统默认
 *
 * 【为什么要有这个函数】以前是"登了账号就自动盖掉你自己挑的那张"——
 * 用户完全不知道为什么自己选的皮肤不见了。现在这件事由用户说了算。
 */
async function applyCurrentSkin() {
  const look = settingsInfo?.look || {}
  const account = launchInfo?.account
  const remote = account && (account.type === 'yggdrasil' || account.type === 'microsoft')

  // ① 账号上的
  if (look.useAccountSkin !== false && remote) {
    const result = await window.api.fetchAccountSkin()
    if (result.ok) {
      const image = new Image()
      image.onload = () => {
        applySkin(image)
        const from =
          result.source === 'microsoft' ? '正版账号上的皮肤' : '皮肤站账号上的皮肤'
        skinBigFromEl.textContent = `来自：${from}`
      }
      image.src = result.dataUrl
      return
    }
    // 取不到（没设皮肤 / 网络抖一下）——不吭声，直接退回下面那两种
  }

  // ② 自己定下来的那张（点过"换一张"、或者在皮肤页点过「使用」）
  const saved = String(look.skin || '')

  // 定下来的是官方那两张之一（它们不是硬盘上的文件，所以存的是记号 @steve / @alex）
  if (saved === '@steve' || saved === '@alex') {
    const image = await getOfficialSkin(saved.slice(1))
    if (image) {
      applySkin(image)
      skinBigFromEl.textContent = '来自：官方默认皮肤'
      return
    }
  }

  if (saved && !saved.startsWith('@')) {
    const okLoaded = await loadSkinFrom(saved)
    if (okLoaded) {
      // 说清楚是"毛球自带"还是"我上传的"（见 skinSourceLabel 的注释）
      if (!skinLibCache) skinLibCache = await loadSkinLib()
      skinBigFromEl.textContent = skinSourceLabel(saved)
      return
    }
  }

  // ③ 没登录、也没自己挑过 → 随机穿一张（M21，每次开软件换一次）
  if (randomActive()) {
    const picked = await pickRandomSkin()
    if (picked) {
      applySkin(picked.image)
      skinBigFromEl.textContent = `来自：随机（${picked.from}）`
      return
    }
  }

  // ④ 官方默认皮肤（Steve）——从玩家自己的游戏文件里读出来的那一张
  const official = await getOfficialSkin()
  if (official) {
    applySkin(official)
    skinBigFromEl.textContent = '来自：官方默认皮肤'
    return
  }

  // ⑤ 实在没有（游戏还没装 / jar 读不出来）→ 用毛球自己画的那张顶着
  useDefaultSkinAndAvatar()
  skinBigFromEl.textContent = '来自：毛球自带的默认皮肤'
}

// ——— 随机皮肤（M21）———
//
// 【用户要的】没登录账号的时候，每次打开软件随机穿一张，别老是同一个人站在那儿。
// 【从哪挑】不联网，全用**本机现成的**：
//   ① 官方的 Steve（从玩家自己的游戏文件里读，见 skins.js）
//   ② 毛球自带的几套配色（我们自己配的色）
//   ③ 你自己传进皮肤库的那些
// 【为什么不去皮肤站抓】LittleSkin 的公开 API 手册里只有公告/验证/Yggdrasil 那几个，
// **没有"浏览皮肤库"这种接口**；皮肤库页面是它内部的 JS 应用在用，
// 逆那个接口既容易被人家改版搞坏，也不是给别的程序用的。所以不碰。

/** 这一次开软件随机到的那张（重开软件才会换） */
let randomPick = null

/**
 * 攒一份"可以随机挑"的名单。
 * @returns {Promise<Array<{image, name, from}>>}
 */
async function buildRandomPool() {
  const pool = []

  // 官方原版两张：Steve（经典体型）和 Alex（纤细体型）
  for (const [kind, label] of [['steve', 'Steve'], ['alex', 'Alex']]) {
    const image = await getOfficialSkin(kind)
    if (image) pool.push({ image, name: label, from: '官方默认皮肤', official: kind })
  }

  if (!skinLibCache) skinLibCache = await loadSkinLib()
  for (const one of skinLibCache) {
    const image = await loadImageFile(one.path)
    if (image) {
      pool.push({
        image,
        name: one.name,
        from: builtinSource(one) ? '毛球自带' : '我上传的',
        path: one.path
      })
    }
  }

  return pool.filter((one) => one.image)
}

/**
 * 把**随软件打包的那几张皮肤**复制进皮肤库（M21，只做一次）。
 *
 * 【它们从哪来】`assets/skins/` 里那几张 PNG，跟着安装包一起发出去——
 * 用户提供的，免费公开、不侵权。复制进皮肤库之后它们就跟用户自己传的皮肤一个待遇：
 * 列表里看得见、能挑；不联网也一直在。
 */
async function seedBundledSkins() {
  // 【每次开机都要问一遍名字】"哪几张是随包发的那种"由主进程读文件夹告诉我们；
  // 只把"已经复制过了"这件事记进配置，免得每次开机都写一遍配置
  let names = []
  try {
    const res = await window.api.seedBundledSkins()
    if (res.ok && Array.isArray(res.names)) names = res.names
  } catch {
    // 复制不进去就算了（硬盘满/没权限），下一轮还会再试
  }

  if (names.length) {
    bundledSkinNames = names
    skinLibCache = null // 名单可能变了，下次重读
  }

  if (settingsInfo && !settingsInfo.look?.builtinsSeeded) {
    await saveLook({ builtinsSeeded: true })
    settingsInfo.look = { ...settingsInfo.look, builtinsSeeded: true }
  }
}

/** 随软件打包的那几张叫什么（主进程开机时报过来的） */
let bundledSkinNames = []

/** 这一张是不是随软件打包的那几张 */
function builtinSource(one) {
  return bundledSkinNames.includes(one.name)
}

/**
 * 一句话说清"这张皮肤是哪儿来的"。
 *
 * 【为什么要单独有个函数】以前这话在三个地方各写各的：列表里写"毛球自带 / 我上传的"，
 * 大预览那行却**一律**写"来自：我上传的"——毛球自带的那几张也被叫成"我上传的"，
 * 同一个东西两个说法（2026-10-09 全量体检时抓到的）。
 * 现在都走这里：认得出来是自带的就说自带，认不出来（比如库里的记录被删了、路径是老的）才说"我选的"。
 */
function skinSourceLabel(path) {
  if (!path) return ''
  const one = (skinLibCache || []).find((x) => samePath(x.path, path))
  if (!one) return '来自：我选的'
  return builtinSource(one) ? '来自：毛球自带' : '来自：我上传的'
}

/** 随机挑一张（同一次开软件里，一直用挑中的那张） */
async function pickRandomSkin(force = false) {
  if (randomPick && !force) return randomPick
  const pool = await buildRandomPool()
  if (pool.length === 0) return null
  randomPick = pool[Math.floor(Math.random() * pool.length)]
  return randomPick
}

/** 官方那两张默认皮肤（Steve / Alex）：读一次就记着，别每次换皮肤都去翻一遍 jar */
const officialSkins = {}
const officialTried = {}

async function getOfficialSkin(kind = 'steve') {
  if (officialTried[kind]) return officialSkins[kind]
  officialTried[kind] = true

  try {
    const res = await window.api.getOfficialSkin(kind)
    if (!res.ok) {
      officialSkins[kind] = null
      return null
    }
    officialSkins[kind] = await new Promise((resolve) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => resolve(null)
      image.src = res.dataUrl
    })
  } catch {
    officialSkins[kind] = null
  }
  return officialSkins[kind]
}

// ═══════════════════════════════════════
// 皮肤页（M17.5）
// ═══════════════════════════════════════
//
// 照设计稿的"皮肤与披风页"做的，**披风那块不做**（游戏本体不认本地披风文件，
// 只有 Optifine 或某些 Mod 才显示，做出来是个空功能）。
//
// 和启动页那张卡的关系：**同一个 3D 小人**（切页面时把画布搬过去，见 moveSkinViewerTo），
// 这里多了账号卡、我上传过的皮肤列表、上传和移除。

const skinListEl = document.getElementById('skin-list')
// 大预览下面那行皮肤名已经不要了（用户 2026-10-09 说“皮肤页面不用带名字”），
// index.html 里那个元素也删了——只留下面“来自：xxx”那一行
const skinBigFromEl = document.getElementById('skin-big-from')
const skinStageMainEl = document.getElementById('skin-stage-main')
const skinAccountAvatarEl = document.getElementById('skin-account-avatar')
const skinAccountNameEl = document.getElementById('skin-account-name')
const skinAccountHintEl = document.getElementById('skin-account-hint')
const skinAccountBtnEl = document.getElementById('skin-account-btn')

/** 皮肤库里有哪些（主进程读回来的；上传/删除后要重建） */
let skinLibCache = null

/** 现在是不是"随机穿的那张"在生效（没登录、没自己挑、随机开关开着） */
function randomActive() {
  if (!settingsInfo) return false
  const look = settingsInfo.look || {}
  if (look.randomSkin === false) return false
  const account = launchInfo?.account
  const remote = account && (account.type === 'yggdrasil' || account.type === 'microsoft')
  if (look.useAccountSkin !== false && remote) return false
  return !look.skin
}

/** 现在到底在用哪个：'account' | 'default' | 具体路径 */
function currentSkinChoice() {
  const look = settingsInfo?.look || {}
  const account = launchInfo?.account
  const remote = account && (account.type === 'yggdrasil' || account.type === 'microsoft')
  if (look.useAccountSkin !== false && remote) return 'account'
  return look.skin || 'default'
}

/** 把皮肤图里的脑袋裁出来（列表里的小图、左上角头像都用它） */
function headCanvas(image) {
  const piece = document.createElement('canvas')
  piece.width = 8
  piece.height = 8
  const brush = piece.getContext('2d')
  brush.imageSmoothingEnabled = false
  // 脑袋正面在 (8,8)，"帽子层"在 (40,8)——叠上去就对了（没有内容的皮肤这层是透明的）
  brush.drawImage(image, 8, 8, 8, 8, 0, 0, 8, 8)
  brush.drawImage(image, 40, 8, 8, 8, 0, 0, 8, 8)
  return piece
}

/** 读一张本地皮肤图（读不出来返回 null，不抛） */
function loadImageFile(path) {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = toFileUrl(path)
  })
}

/**
 * 画皮肤页：左边账号卡、右边皮肤列表。
 * 列表里三项都是有出处的：账号上的 / 我传过的每一个 / 系统默认。
 */
async function renderSkinPage() {
  if (!settingsInfo) {
    // 设置还没读回来（比如一开机直接点皮肤页）——先读一遍再说
    try {
      settingsInfo = await window.api.getSettings()
    } catch {
      // 读不到就画个空列表，不影响别处
    }
  }

  const current = currentSkinChoice()
  const account = launchInfo?.account
  const remote = account && (account.type === 'yggdrasil' || account.type === 'microsoft')

  // 【先把"现在身上穿的到底是哪张"定下来】三个来源（账号 / 自己挑的 / 随机），
  // 随机是最后生效的那一步，所以要排在前面判断——
  // 之前就吃过亏：身上穿着随机挑的"毛球·小蓝"，名字那儿还写着 Steve，
  // 列表里还同时标了两行"当前使用"。
  const random = randomActive() ? randomPick : null
  const showing = random
    ? { kind: 'random', name: random.name, from: random.from, path: random.path || '' }
    : current === 'account'
      ? { kind: 'account', name: account?.name || '我的角色', from: '账号' }
      : current === 'default'
        ? { kind: 'default', name: '', from: '' }
        : { kind: 'file', name: '', from: '', path: current }

  /** 这一项是不是"现在身上穿的" */
  const isShowing = (opts) => {
    if (showing.kind === 'default') return Boolean(opts.isDefault)
    if (showing.kind === 'account') return Boolean(opts.isAccount)
    if (showing.kind === 'random') return showing.path ? samePath(showing.path, opts.path) : Boolean(opts.isDefault)
    return samePath(showing.path, opts.path)
  }

  // ——— 左：账号卡（头像用"当前正在用的那张皮肤"的脑袋）———
  // 【为什么不是"账号上的那个脑袋"】离线账号压根没有，卡片上会是个空圈看着像坏了。
  // 这一栏要说的是"你现在长什么样"，那用当前皮肤的脑袋最合适。
  // 【为什么是现裁一个而不是复制现成的】见 currentSkinImage 那段注释：canvas 复制出来是空的
  skinAccountAvatarEl.textContent = ''
  if (currentSkinImage) skinAccountAvatarEl.appendChild(headCanvas(currentSkinImage))
  skinAccountNameEl.textContent = account ? account.name || '已登录' : '未登录'
  if (remote) {
    skinAccountHintEl.textContent =
      account.type === 'microsoft' ? '正版账号，能直接用账号上的皮肤' : '皮肤站账号，能直接用账号上的皮肤'
    skinAccountBtnEl.hidden = true
  } else {
    skinAccountHintEl.textContent = account
      ? '离线账号进游戏只会穿官方默认皮肤'
      : '登录之后能直接用账号上的皮肤'
    skinAccountBtnEl.hidden = false
  }

  // ——— 右：皮肤列表 ———
  if (!skinLibCache) skinLibCache = await loadSkinLib()
  skinListEl.textContent = ''

  const addItem = (opts) => {
    const row = document.createElement('div')
    row.className = 'skin-item' + (opts.on ? ' skin-item--on' : '')

    const thumb = document.createElement('div')
    thumb.className = 'skin-item__thumb'
    if (opts.image) thumb.appendChild(headCanvas(opts.image))
    row.appendChild(thumb)

    // 【不写皮肤名】（用户 2026-10-09："皮肤页面不用带名字"）
    // 一排图摆在那儿，点哪个用哪个，比编一堆名字清楚
    const main = document.createElement('div')
    main.className = 'skin-item__main'
    const from = document.createElement('div')
    from.className = 'skin-item__from'
    from.textContent = opts.from
    main.appendChild(from)
    row.appendChild(main)

    if (opts.on) {
      const tag = document.createElement('span')
      tag.className = 'skin-item__from'
      tag.textContent = '当前使用'
      row.appendChild(tag)
    } else if (opts.canUse) {
      const use = document.createElement('button')
      use.className = 'btn btn--primary btn--sm'
      use.type = 'button'
      use.textContent = '使用'
      use.addEventListener('click', () => opts.canUse())
      row.appendChild(use)
    }

    if (opts.canRemove) {
      const del = document.createElement('button')
      del.className = 'skin-item__remove'
      del.type = 'button'
      del.textContent = '移除'
      del.title = '只从皮肤库里删掉，不动你原来那张图'
      del.addEventListener('click', () => opts.canRemove())
      row.appendChild(del)
    }

    skinListEl.appendChild(row)
  }

  // ① 账号上的（只有账号支持才列）
  if (remote) {
    const on = isShowing({ isAccount: true })
    addItem({
      name: account.name || '账号上的皮肤',
      from: '来自：账号',
      on,
      canUse: on ? null : () => chooseSkin('account')
    })
  }

  // ② 皮肤库里的每一张（毛球自带的那几张也在这儿，只是来源写得不一样）
  for (const one of skinLibCache) {
    const image = await loadImageFile(one.path)
    const on = isShowing({ path: one.path })
    addItem({
      name: one.name,
      from: builtinSource(one) ? '来自：毛球自带' : '来自：我上传的',
      image,
      on,
      canUse: on ? null : () => chooseSkin(one.path),
      // 毛球自带的那几张不给删——它们是"随机"的底子，删了随机就没得挑了
      canRemove: builtinSource(one) ? null : () => removeSkinFromLib(one)
    })
  }

  // ③ 默认那张：优先用官方的 Steve（从游戏文件里读），没有才用毛球自己画的
  const official = await getOfficialSkin()
  const defaultName = official ? 'Steve' : '毛球小人'
  const defaultFrom = official ? '来自：官方默认皮肤' : '来自：毛球自带的默认皮肤'
  const defaultOn = isShowing({ isDefault: true })
  addItem({
    name: defaultName,
    from: defaultFrom,
    image: official || (window.skinViewer ? window.skinViewer.makeDefaultSkin() : null),
    on: defaultOn,
    canUse: defaultOn ? null : () => chooseSkin('default')
  })

  // 那个开关和"换一张"按钮：只有"随机"在生效的时候才有意义
  skinRandomEl.checked = settingsInfo?.look?.randomSkin !== false
  skinShuffleEl.hidden = !randomActive()

  // ——— 中间那行名字/来源：就说身上穿的那张 ———
  if (showing.kind === 'default') {
    skinBigFromEl.textContent = defaultFrom
  } else if (showing.kind === 'account') {
    skinBigFromEl.textContent = '来自：账号'
  } else if (showing.kind === 'random') {
    skinBigFromEl.textContent = `来自：随机（${showing.from}）`
  } else {
    skinBigFromEl.textContent = skinSourceLabel(showing.path)
  }
}

/** 读皮肤库（读不到就当空的，不拦着用户） */
async function loadSkinLib() {
  try {
    const res = await window.api.listSkins()
    return res.ok ? res.list : []
  } catch {
    return []
  }
}

/**
 * 换成这一项。
 * @param {'account'|'default'|string} choice 'account' = 用账号上的；'default' = 系统默认；其余当路径
 */
async function chooseSkin(choice) {
  if (choice === 'account') {
    await saveLook({ useAccountSkin: true })
  } else if (choice === 'default') {
    await saveLook({ skin: '', useAccountSkin: false })
  } else {
    await saveLook({ skin: choice, useAccountSkin: false })
  }

  // look 存完之后 settingsInfo 里还是旧的，得重读一遍，不然界面上"当前使用"标错人
  try {
    settingsInfo = await window.api.getSettings()
  } catch {
    // 读不到就用本地的乐观值（下面 applyCurrentSkin 也按它来）
    if (settingsInfo) {
      settingsInfo.look = { ...settingsInfo.look, useAccountSkin: choice === 'account', skin: choice === 'account' || choice === 'default' ? '' : choice }
    }
  }

  skinAccountKey = '' // 强制重算（不然 refreshAccountSkin 会以为没变）
  await applyCurrentSkin()
  await renderSkinPage()
  refreshLaunchFacts()
}

/** 从皮肤库里删一份（会先问一句） */
async function removeSkinFromLib(one) {
  const ok = window.confirm(`把「${one.name}」从皮肤库里删掉？\n\n只删毛球复制进来的那一份，你自己原来那张图不动。`)
  if (!ok) return

  const res = await window.api.removeSkin(one.path)
  if (!res.ok) {
    setNotice(`删不掉：${res.error}`, 'error')
    return
  }

  // 删掉的正是在用的那张 → 退回默认
  if (samePath(currentSkinChoice(), one.path)) {
    await saveLook({ skin: '', useAccountSkin: false })
    if (settingsInfo) settingsInfo.look = { ...settingsInfo.look, skin: '', useAccountSkin: false }
    skinAccountKey = ''
    await applyCurrentSkin()
  }

  skinLibCache = await loadSkinLib()
  await renderSkinPage()
  setNotice('已经从皮肤库里删掉了', 'ok', true)
}

// ——— 上传 / 打开文件夹 / 登录 ———

document.getElementById('skin-upload').addEventListener('click', async () => {
  const picked = await window.api.importSkin()
  if (picked.canceled) return
  if (!picked.ok) {
    setNotice(`这张皮肤用不了：${picked.error}`, 'error')
    return
  }
  skinLibCache = await loadSkinLib()
  await chooseSkin(picked.path)
  setNotice('皮肤传好了，已经给你换上了', 'ok', true)
})

// 「去皮肤站找皮肤」：开浏览器到皮肤站（用户自己下喜欢的皮肤，再用「上传皮肤…」装进来）
for (const id of ['skin-site', 'skin-site-2']) {
  const el = document.getElementById(id)
  if (!el) continue
  el.addEventListener('click', async (event) => {
    event.preventDefault()
    const res = await window.api.openSkinSite()
    if (!res.ok) setNotice(`打不开皮肤站：${res.error}`, 'error')
  })
}

document.getElementById('skin-open-folder').addEventListener('click', async () => {
  const res = await window.api.openSkinFolder()
  if (!res.ok) setNotice(`打不开文件夹：${res.error}`, 'error')
})

// ——— 随机皮肤（M21）———

const skinRandomEl = document.getElementById('skin-random')
const skinShuffleEl = document.getElementById('skin-shuffle')
const skinShuffleCardEl = document.getElementById('skin-shuffle-card')

/**
 * 换一张随机皮肤，**并且记住它**（M21）。
 *
 * 【用户要的就是这个】"点一下随机换一张，选完的皮肤就是以后默认皮肤，除非登录账号"。
 * 所以不只是"预览一下"——会把选择存进配置（`look.skin`），
 * 以后每次打开都是它，直到用户再点一次、或者登录了账号。
 *
 * 存文件路径；随机到官方那两张时存个记号（@steve / @alex），
 * 因为那不是硬盘上的文件（是从游戏文件里读出来的）。
 */
async function shuffleAndKeep() {
  // 【"除非登录账号"】登着号的时候皮肤以账号上的为准，点了也白点——说清楚，别让用户以为坏了
  const account = launchInfo?.account
  const remote = account && (account.type === 'yggdrasil' || account.type === 'microsoft')
  if (remote && settingsInfo?.look?.useAccountSkin !== false) {
    setNotice('你现在登录着账号，皮肤以账号上的为准 —— 想穿自己挑的，去「皮肤」页选一张。', 'info')
    return
  }

  randomPick = null
  await pickRandomSkin(true)
  if (!randomPick) return

  const mark = randomPick.path || (randomPick.official === 'alex' ? '@alex' : '@steve')
  await saveLook({ skin: mark, randomSkin: false })
  if (settingsInfo) {
    settingsInfo.look = { ...settingsInfo.look, skin: mark, randomSkin: false }
  }

  try {
    settingsInfo = await window.api.getSettings()
  } catch {
    // 读不到就用上面那份乐观值
  }
  skinAccountKey = ''
  await applyCurrentSkin()
  if (!document.querySelector('[data-page="skin"]').hidden) await renderSkinPage()
  refreshLaunchFacts()
}

// 启动页那张卡脚下正中的圆按钮（用户点名要的那个）
skinShuffleCardEl.addEventListener('click', shuffleAndKeep)

// 皮肤页那个「换一张」：做同一件事（换一张并记住）
skinShuffleEl.addEventListener('click', shuffleAndKeep)

skinRandomEl.addEventListener('change', async () => {
  // 【开 = 回到"每次打开随机穿"】把固定的那张清掉（不然定了之后随机就没意义了）
  const patch = { randomSkin: skinRandomEl.checked }
  if (skinRandomEl.checked) patch.skin = ''

  await saveLook(patch)
  if (settingsInfo) {
    settingsInfo.look = {
      ...settingsInfo.look,
      randomSkin: skinRandomEl.checked,
      skin: skinRandomEl.checked ? '' : settingsInfo.look?.skin
    }
  }
  if (skinRandomEl.checked) randomPick = null // 立刻换一张给用户看看
  await applyCurrentSkin()
  await renderSkinPage()
  refreshLaunchFacts()
})

skinAccountBtnEl.addEventListener('click', () => {
  // 复用启动页左上角头像那个弹窗——账号的事只有一处，别做第二套
  openAccountModal()
})

// ——————————————————————————————————————————————
// 最后一步：把启动页显示出来
//
// 【为什么必须放在**整个文件的最后一行**】启动页要用到上面几乎所有变量。
// 这里踩过两次坑：一开始写在中间，后面又追加了新代码段（联机、个性化、3D 皮肤），
// 结果它一跑就碰到还没初始化的变量（Cannot access 'xxx' before initialization）。
// **2026-10-08 又犯了一次**：M15 的樱花穿透整段加在了这行后面。
// 这次没出事（因为启动页不碰穿透那几个变量），但属于"运气好"。
// 所以这行**挪到文件最末尾**了——以后新加的代码都加在它前面，不用再记着这条规矩。
// ——————————————————————————————————————————————

// ═══════════════════════════════════════
// AI 助手（M22）
// ═══════════════════════════════════════
//
// 【设计要点，别改歪】
//   ① **花不花钱的开关在用户手上**：顶上一排切换，随时能从"自己的 AI"切回本地规则库
//   ② 不填 Key 也能用：本地规则库不联网，认日志里的毛病
//   ③ **发出去之前一定让用户看一眼**（那是他的日志，发出去收不回来）
//   ④ 本地规则认不出来的，主动提示"要不要切到 AI 问问"，但不替他切

const aiModeEl = document.getElementById('ai-mode')
const aiNoteEl = document.getElementById('ai-note')
const aiChatEl = document.getElementById('ai-chat')
const aiInputEl = document.getElementById('ai-input')
const aiWithLogEl = document.getElementById('ai-with-log')
const aiLogHintEl = document.getElementById('ai-loghint')
const aiSendEl = document.getElementById('ai-send')
const aiPreviewModalEl = document.getElementById('ai-preview-modal')
const aiPreviewTextEl = document.getElementById('ai-preview-text')
const aiPreviewWhenEl = document.getElementById('ai-preview-when')

/** 现在的 AI 配置（界面那份，不含 Key） */
let aiConfig = { mode: 'local', hasKey: false, model: '', endpoint: '' }
/** 聊天记录（只在内存里，关掉软件就没了——隐私上干净） */
let aiHistory = []
/** 正在等回答（等的时候不让再发） */
let aiBusy = false
/** 这一次发送用的日志（用户可能改过） */
let aiPendingLog = ''

async function loadAiConfig() {
  try {
    const result = await window.api.getAiConfig()
    if (result.ok) aiConfig = result.config
  } catch {
    // 读不到就用默认的（只用本地规则库）
  }
  renderAiHead()
}

function renderAiHead() {
  for (const chip of aiModeEl.querySelectorAll('[data-ai-mode]')) {
    chip.classList.toggle('chip--on', chip.dataset.aiMode === aiConfig.mode)
  }

  if (aiConfig.mode === 'api') {
    aiNoteEl.textContent = aiConfig.hasKey
      ? `现在用的是你自己的 AI（${aiConfig.model}）——会花你自己的额度。想省钱随时点左边那个切回本地。`
      : '还没填 Key。点上面「我的 AI」旁边的提示去设置里填一个（有免费的）。'
  } else {
    aiNoteEl.textContent = aiConfig.hasKey
      ? '现在用的是本地规则库：不联网、不花钱、立刻有答案。认不出来的可以切到「我的 AI」。'
      : '现在用的是本地规则库：不联网、不花钱。它能认常见的报错（Java 版本、内存、Mod 冲突…）。'
  }
}

/** 往聊天区加一条 */
function addAiMessage(kind, text, foot) {
  const box = document.createElement('div')
  box.className = `ai-msg ai-msg--${kind}`
  box.textContent = text
  if (foot) {
    const line = document.createElement('span')
    line.className = 'ai-msg__foot'
    line.textContent = foot
    box.appendChild(line)
  }
  aiChatEl.appendChild(box)
  aiChatEl.scrollTop = aiChatEl.scrollHeight
  return box
}

/** 本地模式：用规则库/小抄回答 */
async function answerLocally(question, logText) {
  // 有日志 → 走规则诊断（这是本地模式最拿手的）
  if (logText) {
    try {
      const result = await window.api.diagnoseLast()
      if (result.ok && !result.unknown && result.found.length) {
        const lines = []
        for (const one of result.found) {
          lines.push(`【${one.title}】`)
          if (one.why) lines.push(one.why)
          if (Array.isArray(one.steps)) one.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
          lines.push('')
        }
        return { ok: true, text: lines.join('\n').trim() }
      }
      return {
        ok: true,
        text:
          '这段日志本地规则库没认出来。\n\n' +
          '可以试试：① 换个更长的日志（把整个文件贴进来）；② 或者切到「我的 AI」让它看看。'
      }
    } catch (error) {
      return { ok: false, text: `本地诊断出错：${error.message}` }
    }
  }

  // 没日志 → 常见问题小抄（关键词匹配，写死的，不联网）
  const hit = matchFaq(question)
  if (hit) return { ok: true, text: hit }
  return {
    ok: true,
    text:
      '本地规则库只能认日志里的报错，回答不了这种开放问题。\n\n' +
      '想聊这种问题，切到「我的 AI」（右上角那个）——用你自己的 Key，可以一直追问。'
  }
}

/**
 * 常见问题小抄（本地、写死的）。
 * 【为什么要有】本地模式如果只会"贴日志"，用户问一句"怎么装 Mod"就被弹回来，
 * 会显得这个页面很没用。把最高频的几个问题写死，关键词一匹配就答。
 */
const AI_FAQ = [
  {
    key: ['内存', '卡', '掉帧', '内存不足', '给多少'],
    answer:
      '内存给多少：\n\n' +
      '1. 到「设置 → 启动选项 → 内存分配」，建议给本机的 1/4 左右（16G 的机器给 4G 上下）\n' +
      '2. 装了整合包的话，可以在「版本设置」里给那一个版本单独多分点\n' +
      '3. 别拉满——给太多会把整台电脑拖慢，游戏反而更卡\n' +
      '4. 还是卡的话：把游戏里「视距」调小、关掉光影，效果比加内存明显'
  },
  {
    key: ['装mod', '装 mod', 'mod怎么', '怎么装mod', '模组'],
    answer:
      '怎么装 Mod：\n\n' +
      '1. 先给这个版本装一个「Mod 加载器」：版本设置 → 装 Fabric（或 Forge）\n' +
      '2. 装完会多出一个新版本（名字带 fabric-loader），**启动要用那个新版本**\n' +
      '3. 到「下载」页搜你要的 Mod，点下载——会自动放进这个版本的 mods 文件夹\n' +
      '4. 注意：Mod 要跟游戏版本和加载器对得上，不然进游戏会崩'
  },
  {
    key: ['联机', '和朋友', '一起玩', '房间码'],
    answer:
      '怎么和朋友联机：\n\n' +
      '1. 房主：进游戏开一个世界 → 按 Esc → 点「对局域网开放」\n' +
      '2. 房主：回毛球「联机」页 → 创建房间 → 得到一串房间码\n' +
      '3. 好友：在毛球「联机」页输入房间码加入\n' +
      '4. 好友：进游戏 → 多人游戏 → 列表里就能看到房主的世界\n\n' +
      '（两边都得用毛球。连不上的话，看联机页底下那行"连接状态"说的是什么）'
  },
  {
    key: ['皮肤', '怎么换皮肤', '外观'],
    answer:
      '怎么换皮肤：\n\n' +
      '毛球里挑的皮肤是**给毛球那个小人看的**，游戏里显示的皮肤是问账号服务器要的——两回事。\n\n' +
      '想让游戏里也是你自己的皮肤：\n' +
      '1. 用一个皮肤站账号（比如 littleskin.cn）：在网站上「角色管理」里传皮肤\n' +
      '2. 回毛球用「外置登录」登进去，进游戏就是你那张\n\n' +
      '离线账号进游戏只会穿官方自带的默认皮肤——这是游戏本身的限制，不是毛球的问题。'
  },
  {
    key: ['闪退', '打不开', '起不来', '崩'],
    answer:
      '游戏闪退/打不开，按这个顺序查：\n\n' +
      '1. **先看日志**：左下角「日志」按钮，最上面那块"诊断"会直接告诉你是什么毛病\n' +
      '2. 常见的是 Java 版本不对——到「设置 → Java 运行时」把「自动检测并下载」打开，再重装一次版本\n' +
      '3. 挂了 Mod 的话：把最近新加的 Mod 删掉试试（版本设置 → Mod 文件夹）\n' +
      '4. 都不行就把日志发给 AI 看看（切到「我的 AI」）'
  },
  {
    key: ['下载慢', '下载失败', '下不动'],
    answer:
      '下载慢：\n\n' +
      '1. 到「设置 → 启动选项 → 下载源」，选「优先国内镜像」\n' +
      '2. 再点一次安装/重装，已经下好的不会重下\n' +
      '3. 还是慢就换个时间段——晚上高峰官方源会很慢'
  }
]

/** 在常见问题小抄里找一条（关键词匹配） */
function matchFaq(question) {
  const text = String(question || '').toLowerCase()
  if (!text) return ''
  for (const item of AI_FAQ) {
    if (item.key.some((k) => text.includes(k.toLowerCase()))) return item.answer
  }
  return ''
}

/** 点「发送」 */
async function sendAiQuestion() {
  if (aiBusy) return
  const question = aiInputEl.value.trim()

  // 要带日志的话，先弹"给你看一眼"
  if (aiWithLogEl.checked) {
    await prepareAiLogAndPreview(question)
    return
  }

  if (!question) return
  aiInputEl.value = ''
  await runAiAnswer(question, '')
}

/** 弹"确认要发的内容"（先去主进程把日志挑好、隐私抹掉） */
async function prepareAiLogAndPreview(question) {
  let result
  try {
    result = await window.api.prepareAiLog()
  } catch (error) {
    addAiMessage('tip', `读日志失败：${error.message}`)
    return
  }

  if (!result.ok) {
    addAiMessage('tip', `没能读到日志：${result.error}`)
    return
  }

  aiPreviewWhenEl.textContent = result.when
    ? `用的是 ${result.when} 那次启动的日志（最近一次出问题的）${result.truncated ? '，太长，只发了最后一段' : ''}`
    : '用的是最近一次启动的日志'
  aiPreviewTextEl.value = question ? `【我的问题】\n${question}\n\n【日志】\n${result.text}` : result.text
  aiPreviewModalEl.hidden = false
}

/** 确认发送 */
async function confirmSendAi() {
  aiPreviewModalEl.hidden = true
  const question = aiInputEl.value.trim()
  aiInputEl.value = ''
  aiWithLogEl.checked = false

  const logText = aiPreviewTextEl.value.replace(/^【我的问题】[\s\S]*?【日志】\n/, '')
  await runAiAnswer(question || '这次游戏出问题了，帮我看看是什么原因、怎么解决。', logText)
}

/** 真正去要答案（本地 or AI） */
async function runAiAnswer(question, logText) {
  aiBusy = true
  aiSendEl.disabled = true
  addAiMessage('me', logText ? `${question}\n（附上了最近一次的报错日志）` : question)

  const waiting = addAiMessage('bot', '正在想…')
  waiting.classList.add('ai-msg--wait') // 灰色等一等的样子（以前写成 addAiMessage('bot wait')，类名对不上，样式一直没生效）
  // 让用户看见它"还活着"：每秒报一下等了几秒。
  // （免费模型赶上人多会慢，光写"正在想…"一动不动，看着像卡死——用户就是这么以为的）
  const startedAt = Date.now()
  const ticker = setInterval(() => {
    waiting.textContent = `正在想…（已经等了 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`
  }, 1000)
  const stopTicker = () => clearInterval(ticker)

  try {
    if (aiConfig.mode === 'local') {
      const local = await answerLocally(question, logText)
      stopTicker()
      waiting.remove()
      if (local.ok) {
        addAiMessage('bot', local.text, '（这是本地规则库的答案，不联网、没花钱）')
        // 本地答不了 → 主动提示可以切到 AI（但**不替他切**）
        if (!logText || local.text.includes('没认出来') || local.text.includes('回答不了')) {
          const tip = addAiMessage('tip', '想让它更聪明一点？点右上角切到「我的 AI」。')
          tip.style.cursor = 'pointer'
          tip.addEventListener('click', () => switchAiMode('api'))
        }
      } else {
        addAiMessage('bot', local.text)
      }
    } else {
      // 用用户自己的 AI
      const result = await window.api.askAi({
        question,
        logText,
        history: aiHistory.slice(-6)
      })
      stopTicker()
      waiting.remove()

      if (!result.ok) {
        addAiMessage('bot', `没问成：${result.error}`)
        // Key 没填 → 直接把他送到设置页
        if (String(result.error).includes('还没填')) {
          const tip = addAiMessage('tip', '点这里去填 Key →')
          tip.style.cursor = 'pointer'
          tip.addEventListener('click', () => {
            showPage('settings')
            showSettingsTab('ai')
          })
        }
      } else {
        const foot = result.trimmed
          ? '（AI 说的不一定对，动手前想清楚。日志太长，只发了最后一段）'
          : '（AI 说的不一定对，动手前想清楚）'
        addAiMessage('bot', result.answer, foot)
        // 记进历史，好让用户能追问
        aiHistory.push({ role: 'user', content: question })
        aiHistory.push({ role: 'assistant', content: result.answer })
        if (aiHistory.length > 12) aiHistory = aiHistory.slice(-12)
      }
    }
  } catch (error) {
    stopTicker()
    waiting.remove()
    addAiMessage('bot', `出错了：${error.message}`)
  }

  aiBusy = false
  aiSendEl.disabled = false
}

/** 切换"用哪个" */
async function switchAiMode(mode) {
  if (mode === 'api' && !aiConfig.hasKey) {
    // 没填过 Key → 直接把他送到设置页（用户定的：没填过就跳过去填）
    showPage('settings')
    showSettingsTab('ai')
    setNotice('先用本地规则库顶着——填好 Key 就能切到「我的 AI」了。', 'ok')
    return
  }

  aiConfig.mode = mode
  renderAiHead()
  try {
    await window.api.setAiConfig({ mode })
  } catch {
    // 存不下也没关系，这次照样按选的来
  }
}

// 顶上的切换
aiModeEl.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-ai-mode]')
  if (chip) switchAiMode(chip.dataset.aiMode)
})

aiSendEl.addEventListener('click', sendAiQuestion)

// 输入框里按回车发送（Shift+回车是换行）
aiInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendAiQuestion()
  }
})

// 勾上"带日志"时，先说清楚会发什么
aiWithLogEl.addEventListener('change', () => {
  aiLogHintEl.textContent = aiWithLogEl.checked
    ? '会先弹一层让你过目，确认了才发'
    : ''
})

document.getElementById('ai-preview-cancel').addEventListener('click', () => {
  aiPreviewModalEl.hidden = true
})
aiPreviewModalEl.addEventListener('click', (event) => {
  if (event.target === aiPreviewModalEl) aiPreviewModalEl.hidden = true
})
document.getElementById('ai-preview-send').addEventListener('click', confirmSendAi)

// ═══════════════════════════════════════
// 樱花内网穿透（M15）
// ═══════════════════════════════════════

const frpKeyEl = document.getElementById('frp-key')
const frpTunnelEl = document.getElementById('frp-tunnel')
const frpPortEl = document.getElementById('frp-port')
const frpExeEl = document.getElementById('frp-exe')
const frpMsgEl = document.getElementById('frp-message')
const frpLogEl = document.getElementById('frp-log')
const frpStartEl = document.getElementById('frp-start')
const frpStopEl = document.getElementById('frp-stop')
const frpDownloadEl = document.getElementById('frp-download')

/** 有没有在跑（按钮状态要跟着变） */
let frpRunning = false
/** 定时刷状态的计时器 */
let frpTimer = null
/** 正在下 frpc（这期间轮询不许动提示行，见 renderFrp） */
let frpBusy = false
/** 到这个时刻之前，轮询也别动提示行（让"下好了"这类话多留几秒） */
let frpQuiet = 0

/** 在提示行上说一句话，并让轮询在 keepMs 内别去冲它 */
function frpSay(text, keepMs = 6000) {
  frpMsgEl.textContent = text
  frpQuiet = Date.now() + keepMs
}

/** 把主进程给的状态画到界面上
 *
 *  【绝对不许在这儿碰输入框】这个函数每 3 秒被轮询调一次，顺手刷一下输入框，
 *  就会把用户正填的东西冲掉——之前"填完访问密钥去填隧道 ID，访问密钥就没了"
 *  就是这儿闹的（光标离开哪个框，哪个框就被旧配置刷掉）。
 *  输入框只在 fillFrpInputs() 里填，那个只在进页面 / 选完 frpc 时调。 */
function renderFrp(status) {
  if (!status) return

  frpRunning = Boolean(status.running)
  frpStartEl.disabled = frpRunning
  frpStopEl.disabled = !frpRunning

  // 【为什么不是直接写了】"正在下 frpc…" 和"刚下好"这类话也画在这一行，
  // 而轮询每 3 秒会拿主进程的 message（闲着的时候是空的）把它冲掉——
  // 于是提示一闪就没。忙的时候、刚说过话之后的几秒，都让轮询让路。
  if (!frpBusy && Date.now() > frpQuiet) frpMsgEl.textContent = status.message || ''

  frpLogEl.textContent = (status.log || []).join('\n')
  frpLogEl.scrollTop = frpLogEl.scrollHeight
}

/** 用户动手填过的东西先存一份在这儿
 *  【为什么要有它】主进程存的只是"上次点启动时用的值"，用户没点过启动就是空的；
 *  填到一半切去别的页面再回来，光靠主进程那份会把用户填的顶掉 */
const frpDraft = { accessKey: null, tunnelId: null, localPort: null, exePath: null }
for (const [元素, 字段] of [[frpKeyEl, 'accessKey'], [frpTunnelEl, 'tunnelId'], [frpPortEl, 'localPort'], [frpExeEl, 'exePath']]) {
  元素.addEventListener('input', () => { frpDraft[字段] = 元素.value })
}

/** 把配置填进输入框（进页面 / 选完 frpc 时调）——用户手填过的优先，没填过的用存下来的 */
function fillFrpInputs(config) {
  const c = config || {}
  frpKeyEl.value = frpDraft.accessKey ?? c.accessKey ?? ''
  frpTunnelEl.value = frpDraft.tunnelId ?? c.tunnelId ?? ''
  frpPortEl.value = frpDraft.localPort ?? String(c.localPort || 25565)
  frpExeEl.value = frpDraft.exePath ?? c.exePath ?? ''
}

async function refreshFrp(要不要填输入框 = false) {
  try {
    const status = await window.api.frpStatus()
    if (!status.ok) return
    renderFrp(status)
    if (要不要填输入框) fillFrpInputs(status.config)
  } catch {
    // 问不到就先不动
  }
}

/** 进联机页时把樱花那块的设置读出来 */
function loadFrpPanel() {
  refreshFrp(true) // 只有这会儿填输入框
  if (!frpTimer) frpTimer = setInterval(refreshFrp, 3000)
}

document.getElementById('frp-open-site').addEventListener('click', () => window.api.openFrpSite())

document.getElementById('frp-pick').addEventListener('click', async () => {
  const picked = await window.api.pickFrpc()
  if (!picked.ok) return
  frpDraft.exePath = null // 用户刚亲手选的，以这个为准，别被之前手打的旧值顶掉
  fillFrpInputs(picked.config)
  frpSay('记住 frpc 了。')
})

/**
 * 让毛球自己下 frpc。
 *
 * 【为什么要这个】樱花启动器自带那个 frpc 被它锁了，别的程序调不动；
 * 能用的那个在樱花的公开下载站上。让用户自己找那个页面太绕，所以毛球代下（下完校验）。
 * @returns {Promise<boolean>} 现在手上有没有一个可用的 frpc
 */
async function 准备frpc() {
  frpBusy = true
  frpDownloadEl.disabled = true
  frpMsgEl.textContent = '正在准备 frpc…'
  try {
    const result = await window.api.ensureFrpc()
    if (!result.ok) {
      frpSay(result.error)
      return false
    }
    frpDraft.exePath = null // 刚下回来的，以这个为准，别被之前留下的旧路径顶掉
    frpExeEl.value = result.path
    frpSay(
      result.downloaded
        ? `frpc 下好了（${result.version}，已核对校验值）`
        : `frpc 已经备好了（${result.version}）`
    )
    return true
  } catch (error) {
    frpSay(`下 frpc 出错：${error.message}`)
    return false
  } finally {
    frpBusy = false
    frpDownloadEl.disabled = false
  }
}

frpDownloadEl.addEventListener('click', () => { 准备frpc() })

// 下 frpc 的时候，主进程会把"现在在干嘛"和进度推过来（借的是安装那套下载器）
window.api.onFrpStage((text) => {
  if (frpBusy) frpMsgEl.textContent = text
})
window.api.onFrpProgress((stats) => {
  if (!frpBusy || !stats || !stats.percent) return
  frpMsgEl.textContent = `正在下载 frpc… ${stats.percent}%（${formatSpeed(stats.speed)}）`
})

frpStartEl.addEventListener('click', async () => {
  // 手上还没有 frpc 就自己下一个——用户不用先跑去樱花面板里翻（下不动才提示他手动选）
  if (!frpExeEl.value.trim()) {
    const ok = await 准备frpc()
    if (!ok) return
  }

  // keepMs 给 0：这句是"过渡话"，马上就该让主进程的真状态接管
  // （不然刚下完 frpc 留下的 6 秒"静默期"会把真状态一起挡住）
  frpSay('正在启动…', 0)
  try {
    const result = await window.api.frpStart({
      accessKey: frpKeyEl.value,
      tunnelId: frpTunnelEl.value,
      localPort: Number(frpPortEl.value),
      exePath: frpExeEl.value
    })
    if (!result.ok) frpMsgEl.textContent = result.error
  } catch (error) {
    frpMsgEl.textContent = `起不来：${error.message}`
  }
  setTimeout(refreshFrp, 800)
})

frpStopEl.addEventListener('click', async () => {
  await window.api.frpStop()
  setTimeout(refreshFrp, 500)
})

// ——————————————————————————————————————————————
// 真正的最后一步：把启动页显示出来
// （上面那条注释说的"踩过的坑"就是它——所以它必须在**最后一行**）
// ——————————————————————————————————————————————
showPage('launch')

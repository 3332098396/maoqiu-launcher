// MC启动器 — 界面逻辑
//
// 当前进度：M5（启动游戏）。下载页（版本清单、安装）+ 启动页（账号、选版本、启动）。
//
// 【安全底线】所有来自网络的内容（版本号、版本类型、游戏日志）一律用 textContent
// 塞进页面，绝对不用 innerHTML。这些数据来自外部，用 innerHTML 等于给恶意代码开门。

// ═══════════════════════════════════════
// 页面切换
// ═══════════════════════════════════════

const navButtons = document.querySelectorAll('.nav__btn')
const pages = document.querySelectorAll('.page')

function showPage(name) {
  for (const button of navButtons) {
    button.classList.toggle('nav__btn--on', button.dataset.page === name)
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
  if (name === 'launch') loadLaunchPage()
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
  if (!bytes) return '0 MB'
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
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

  const result = await window.api.startInstall(versionId)
  installingVersion = ''

  if (!result.ok) {
    setStage('安装失败')
    setFill(0)
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
window.api.onInstallStage((text) => setStage(text))
window.api.onInstallProgress((stats) => {
  setFill(stats.percent)
  setDetail(
    `${stats.percent}% · ${stats.done}/${stats.total} 个 · ${formatSize(stats.receivedBytes)}/${formatSize(stats.totalBytes)}` +
      ` · ${formatSpeed(stats.speed)} · 剩 ${formatEta(stats.etaMs)}` +
      (stats.failed > 0 ? ` · 失败 ${stats.failed}` : '')
  )
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

// ═══════════════════════════════════════
// 启动页：账号 + 选版本 + 启动游戏（M5）
// ═══════════════════════════════════════

const accInputEl = document.getElementById('acc-input')
const accNameEl = document.getElementById('acc-name')
const accHintEl = document.getElementById('acc-hint')
const accAvatarEl = document.getElementById('acc-avatar')
const pickListEl = document.getElementById('pick-list')
const pickEmptyEl = document.getElementById('pick-empty')
const launchBtnEl = document.getElementById('launch-btn')
const launchNoticeEl = document.getElementById('launch-notice')
const launchLogEl = document.getElementById('launch-log')
const logClearEl = document.getElementById('log-clear')
const factVersionEl = document.getElementById('fact-version')
const factJavaEl = document.getElementById('fact-java')
const factMemoryEl = document.getElementById('fact-memory')
const factDirEl = document.getElementById('fact-dir')

const HINT_DEFAULT = '3～16 个字符，只能用字母、数字、下划线'
/** 界面里最多留多少行日志——再多也没人翻 */
const MAX_UI_LOG_LINES = 500

/** 启动页拿到的信息（已装版本、账号、内存、Java…） */
let launchInfo = null
/** 当前选中的版本 */
let selectedVersion = ''
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

  // 输入框里已经有内容但还不合法时，把原因写在提示上
  const typed = accInputEl.value
  const problem = nameProblem(typed)
  const showProblem = Boolean(typed.trim()) && Boolean(problem)
  accHintEl.textContent = showProblem ? problem : HINT_DEFAULT
  accHintEl.classList.toggle('acc__hint--error', showProblem)
}

function renderPickList() {
  const installed = launchInfo?.installed ?? []
  pickListEl.textContent = ''
  pickEmptyEl.hidden = installed.length > 0

  const frag = document.createDocumentFragment()
  for (const id of installed) {
    const li = document.createElement('li')
    li.className = id === selectedVersion ? 'pick__item pick__item--on' : 'pick__item'
    li.dataset.version = id
    li.textContent = id
    frag.appendChild(li)
  }
  pickListEl.appendChild(frag)
}

/** 按当前状态刷新整个启动页（按钮能不能点、版本列表、信息卡） */
function refreshLaunchUi() {
  const problem = nameProblem(accInputEl.value)
  launchBtnEl.disabled = launching || !selectedVersion || Boolean(problem)
  launchBtnEl.textContent = launching ? '游戏运行中…' : '开始游戏'

  factVersionEl.textContent = selectedVersion || '—'

  if (launchInfo) {
    factMemoryEl.textContent = `${launchInfo.memoryMB} MB${launchInfo.memoryAuto ? '（自动）' : ''}`
    factDirEl.textContent = launchInfo.gameDir

    const java = launchInfo.java
    factJavaEl.textContent = java.found
      ? `${java.version}（${java.source}）`
      : java.error || '还没找到——装好版本后会自动带上'
  }

  renderAccountCard()
  renderPickList()
}

/** 进启动页（或回到启动页）时读一遍最新状态 */
async function loadLaunchPage() {
  try {
    launchInfo = await window.api.getLaunchInfo()
  } catch (error) {
    setNotice(`启动页的信息读不出来：${error.message}`, 'error')
    return
  }

  const installed = launchInfo.installed
  if (!installed.includes(selectedVersion)) {
    selectedVersion = installed.includes(launchInfo.lastVersion)
      ? launchInfo.lastVersion
      : installed[0] || ''
  }

  // 只在第一次把存下来的账号填进输入框，别把用户正在敲的字冲掉
  if (!accInputEl.value && launchInfo.account) accInputEl.value = launchInfo.account.name

  if (installed.length === 0) {
    setNotice('还没有装过版本。先到「下载」页挑一个装上，回来就能开始游戏了。')
  } else if (!launching) {
    setNotice('在左边填一个游戏名字、选一个版本，就可以点「开始游戏」了。')
  }

  refreshLaunchUi()
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

  // 用户没在往回翻的时候，跟着滚到底；正在往上翻就别打扰他
  const atBottom =
    launchLogEl.scrollTop + launchLogEl.clientHeight >= launchLogEl.scrollHeight - 30
  launchLogEl.textContent = logLines.join('\n')
  if (atBottom) launchLogEl.scrollTop = launchLogEl.scrollHeight

  // 日志弹窗开着的话，让它跟着实时刷新
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
  refreshLaunchUi()
})

logClearEl.addEventListener('click', () => {
  logLines = []
  launchLogEl.textContent = '（已清空）'
})

async function startGame() {
  const name = accInputEl.value.trim()

  const problem = nameProblem(name)
  if (problem) {
    setNotice(problem, 'error')
    accInputEl.focus()
    return
  }
  if (!selectedVersion) return

  // 先把账号存下来，再启动
  const saved = await window.api.setAccount(name)
  if (!saved.ok) {
    setNotice(saved.error, 'error')
    return
  }
  if (launchInfo) launchInfo.account = saved.account
  renderAccountCard()

  launching = true
  refreshLaunchUi()
  setNotice(`正在启动 ${selectedVersion}…第一次启动会慢一点，稍等。`)

  const result = await window.api.startLaunch(selectedVersion)

  if (!result.ok) {
    launching = false
    refreshLaunchUi()
    setNotice(result.error, 'error')
    appendLog([`[启动器] 启动失败：${result.error}`])
  }
}

launchBtnEl.addEventListener('click', startGame)

// 主进程推过来的游戏日志和状态
window.api.onLaunchLog((lines) => appendLog(lines))

window.api.onLaunchState((payload) => {
  if (payload.state === 'running') {
    launching = true
    refreshLaunchUi()
    setNotice('游戏已经启动了。这个窗口可以最小化，不影响游戏。', 'ok')
  } else if (payload.state === 'exited') {
    launching = false
    refreshLaunchUi()
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
  }
})

// ═══════════════════════════════════════
// 日志弹窗（顶栏「日志」按钮，M5 追加）
// ═══════════════════════════════════════

const logModalEl = document.getElementById('log-modal')
const logModalTextEl = document.getElementById('log-modal-text')
const logTitleEl = document.getElementById('log-title')

/** 弹窗里现在显示的是哪种日志：'live' = 本次打开软件后的实时记录，'file' = 上次存下来的 */
let logModalMode = ''

function renderLogModal() {
  logModalTextEl.textContent = logLines.join('\n') || '（还没有内容）'
  logModalTextEl.scrollTop = logModalTextEl.scrollHeight
}

async function openLogModal() {
  logModalEl.hidden = false

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

document.getElementById('log-btn').addEventListener('click', openLogModal)
document.getElementById('log-close').addEventListener('click', closeLogModal)

// 点弹窗外面（灰底）也能关
logModalEl.addEventListener('click', (event) => {
  if (event.target === logModalEl) closeLogModal()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !logModalEl.hidden) closeLogModal()
})

document.getElementById('log-folder').addEventListener('click', async () => {
  const result = await window.api.openLogFolder()
  if (!result.ok) logTitleEl.textContent = `打不开文件夹：${result.error}`
})

// ═══════════════════════════════════════
// 版本号
// ═══════════════════════════════════════

document.getElementById('stat-left').textContent =
  `版本 ${window.api?.appVersion ?? '未知'}`

// 所有定义都就位了，把启动页显示出来。
// （放在最后调用：启动页要用到上面这些变量，页面还没解析完就调会踩空）
showPage('launch')

// 毛球 — 界面逻辑
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

  // 设置页同理：设置可能被别处改过（比如改完内存回到启动页看信息卡）
  if (name === 'settings') loadSettingsPage()
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
  installCancelEl.disabled = false

  const result = await window.api.startInstall(versionId)
  installingVersion = ''
  installCancelEl.disabled = true
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
  installCancelEl.disabled = true
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
const pickListEl = document.getElementById('pick-list')
const pickEmptyEl = document.getElementById('pick-empty')
const launchBtnEl = document.getElementById('launch-btn')
const launchTipEl = document.getElementById('launch-tip')
const launchNoticeEl = document.getElementById('launch-notice')
const currentVersionPanelEl = document.getElementById('current-version-panel')
const curNameEl = document.getElementById('cur-name')
const curNoteEl = document.getElementById('cur-note')
const curHintEl = document.getElementById('cur-hint')
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

    // 用户起过名字就显示名字（后面带上版本号，免得对不上）；
    // 没起过就显示版本号本身。
    // 外面套一层 span：名字太长时好做省略号，不撑破侧栏
    const label = document.createElement('span')
    const info = launchInfo?.versionInfo?.[id] || {}
    // 版本名太长（fabric-loader-…）时，后面缀个加载器名，一眼知道这是什么
    label.textContent = info.name
      ? `${info.name}（${id}）`
      : info.loader
        ? `${id}（${info.loader}）`
        : id
    li.appendChild(label)

    frag.appendChild(li)
  }
  pickListEl.appendChild(frag)
}

/** 按当前状态刷新整个启动页（按钮能不能点、版本列表、信息卡） */
function refreshLaunchUi() {
  const problem = nameProblem(accInputEl.value)
  launchBtnEl.disabled = launching || !selectedVersion || Boolean(problem)
  launchBtnEl.textContent = launching ? '游戏运行中…' : '开始游戏'

  // 没选版本就没得设置
  verSettingsBtnEl.disabled = !selectedVersion

  // 按钮点不了的时候，直接把"缺什么"写在旁边——
  // 光把按钮变灰，用户只能自己猜（实测时用户就问过"为什么点不了"）
  let tip = ''
  if (!launching) {
    if (!selectedVersion) tip = '先到「下载」页装一个版本，才能开始游戏'
    else if (!accInputEl.value.trim()) tip = '填一个游戏名字（上面那个框），按钮就能点了'
    else if (problem) tip = problem
  }
  launchTipEl.textContent = tip
  launchTipEl.hidden = tip === ''

  factVersionEl.textContent = selectedVersion || '—'

  if (launchInfo) {
    // 内存和游戏目录都要按"这个版本实际用的"显示——
    // 版本可能自己单独设过（见版本设置），不能只显示全局值
    const override = launchInfo.versionSettings?.[selectedVersion] || {}
    const ownMemory = Number(override.memoryMB) > 0
    const memoryMB = ownMemory ? override.memoryMB : launchInfo.memoryMB
    factMemoryEl.textContent =
      `${memoryMB} MB` +
      (ownMemory ? '（这个版本单独设的）' : launchInfo.memoryAuto ? '（自动）' : '')

    const isolated =
      typeof override.isolation === 'boolean' ? override.isolation : launchInfo.isolation
    factDirEl.textContent = isolated
      ? `${launchInfo.gameDir}\\versions\\${selectedVersion}`
      : launchInfo.gameDir

    const java = launchInfo.java
    factJavaEl.textContent = java.found
      ? `${java.version}（${shortJavaSource(java.source)}）`
      : java.error || '还没找到——装好版本后会自动带上'

    // 「当前版本」那张卡：名字、备注，以及"要改去哪改"的提示
    if (selectedVersion) {
      const info = launchInfo.versionInfo?.[selectedVersion] || {}
      currentVersionPanelEl.hidden = false
      curNameEl.textContent = info.name ? `${info.name}（${selectedVersion}）` : selectedVersion
      curNoteEl.textContent = info.note || ''
      curNoteEl.hidden = !info.note
      curHintEl.textContent =
        '想改名字、写备注、打开存档文件夹或者删掉它：点左下角的「版本设置」'
    } else {
      currentVersionPanelEl.hidden = true
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

  const installed = launchInfo.installed
  if (!installed.includes(selectedVersion)) {
    selectedVersion = installed.includes(launchInfo.lastVersion)
      ? launchInfo.lastVersion
      : installed[0] || ''
  }

  // 只在第一次把存下来的账号填进输入框，别把用户正在敲的字冲掉
  if (!accInputEl.value && launchInfo.account) accInputEl.value = launchInfo.account.name

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

  const installed = (launchInfo && launchInfo.installed) || []
  if (installed.length === 0) {
    setNotice('这里还空着——去「下载」页挑个版本装上，回来就能开玩了。')
  } else {
    setNotice('在左边填一个游戏名字、选一个版本，就可以点「开始游戏」了。')
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
  refreshLaunchUi()
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

const MR_TYPE_NAMES = { mod: 'Mod', resourcepack: '资源包', shader: '光影包' }
/** 内容类型 → 游戏里的文件夹（打开文件夹时用） */
const MR_FOLDER_KEY = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' }

/** 该把东西放到哪个版本里：启动页选中的那个 */
function mrTargetVersion() {
  return selectedVersion || launchInfo?.installed?.[0] || ''
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
    showDownloadTab('community')
    runMrSearch()
  } else if (item.dataset.dlTab === 'vanilla') {
    showDownloadTab('vanilla')
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
  }
  mrStatusEl.textContent = status
}

/** 点某一行的「下载」：自动挑文件 → 下载 → 放到该放的地方 */
async function installMrProject(button) {
  if (mrBusy) return

  const projectId = button.dataset.mrInstall
  const nameZh = button.dataset.mrNameZh
  const title = nameZh ? `${nameZh}（${button.dataset.mrTitle}）` : button.dataset.mrTitle
  const versionId = mrTargetVersion()

  if (!versionId) {
    mrStatusEl.textContent = '还没有装过游戏版本——先到「原版游戏」里装一个，才知道该放到哪'
    return
  }

  mrBusy = true
  installEl.hidden = false
  installTitleEl.textContent = `正在下载 ${title}`
  setStage('正在挑合适的文件…')
  setFill(0)
  setDetail('—')
  // 社区资源一般都很小，不给取消按钮（避免和"取消装版本"混在一起）
  installCancelEl.disabled = true
  mrDoneEl.hidden = true

  let result
  try {
    result = await window.api.installModrinth({ projectId, type: mrType, versionId })
  } catch (error) {
    result = { ok: false, error: String(error?.message ?? error) }
  }
  mrBusy = false

  if (!result.ok) {
    installTitleEl.textContent = `${title} 下载失败`
    setStage('')
    setFill(0)
    setDetail(result.error)
    return
  }

  setFill(100)
  installTitleEl.textContent = `${title} 下载完成`
  setStage('')
  const folderName = result.dir.split(/[\\/]/).pop()
  setDetail(`已放到 ${folderName} 文件夹：${result.filename}`)

  mrLastResult = { versionId, type: mrType }
  mrDoneTextEl.textContent = `${title}（${result.versionName}）已经放到 ${folderName} 文件夹`
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
  mrVersionMode = chip.dataset.mrVersion
  for (const item of mrVersionEl.children) item.classList.toggle('chip--on', item === chip)
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
  const result = await window.api.openVersionFolder(
    mrLastResult.versionId,
    MR_FOLDER_KEY[mrLastResult.type]
  )
  if (!result.ok) mrStatusEl.textContent = `打不开文件夹：${result.error}`
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

async function openPackDialog(filePath) {
  packFilePath = filePath
  packInfo = null
  packInstalling = false
  packDone = false

  packInstallEl.textContent = '开始安装'
  packCancelEl.hidden = false
  packTitleEl.textContent = '捡到一个整合包'
  packSummaryEl.textContent = '正在翻这个压缩包，看看里面有什么…'
  packWarnEl.textContent = ''
  packProgressEl.textContent = ''
  packNameRowEl.hidden = true
  packNameEl.value = ''
  packNameHintEl.textContent = ''
  packTargetRowEl.hidden = true
  packInstallEl.disabled = true
  packModalEl.hidden = false

  const info = await window.api.inspectPack(filePath)
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

  if (info.kind === 'encrypted') {
    packWarnEl.textContent = '这个压缩包打不开。带密码的压缩包要等下一步做完才能装。'
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

    const installed = launchInfo?.installed || []
    for (const id of installed) {
      const option = document.createElement('option')
      option.value = id
      option.textContent = id
      packTargetEl.appendChild(option)
    }
    packTargetEl.value = selectedVersion || installed[0] || ''

    if (installed.length === 0) {
      packWarnEl.textContent = '本机还没装游戏版本——先到「下载」页装一个，再拖这个包'
      packInstallEl.disabled = true
    }
    return
  }

  // ——— 起名字：这个包装完会变成"一个新的版本"，那就让用户给它起个名 ———
  // （包里自带的那个名字写在括号里当默认值，不想改就直接装）
  if (info.suggestedName) {
    packNameRowEl.hidden = false
    packNameEl.value = info.suggestedName
    await checkPackName()
  }
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

  const result = await window.api.checkPackName(packNameEl.value)

  packNameHintEl.textContent = result.ok ? result.warning || '' : result.error
  packNameHintEl.className = result.ok ? 'delbox' : 'delbox delbox--warn'
  packInstallEl.disabled = !result.ok

  return result.ok
}

// 一边打字一边看名字行不行
packNameEl.addEventListener('input', () => {
  checkPackName()
})

packInstallEl.addEventListener('click', async () => {
  // 装完了这次按钮是「完成」——再点就是关掉对话框，不是再装一遍
  if (packDone) {
    closePackDialog()
    return
  }

  if (!packInfo || packInstalling) return

  const targetVersionId =
    packInfo.kind === 'files' && packInfo.layout === 'instance' ? packTargetEl.value : ''

  // 名字再验一遍（界面上虽然一边打字一边在验，但"点下去那一刻"才是准的）
  if (!packNameRowEl.hidden && !(await checkPackName())) return
  const versionName = packNameRowEl.hidden ? '' : packNameEl.value.trim()

  packInstalling = true
  packInstallEl.disabled = true
  packWarnEl.textContent = ''
  packProgressEl.textContent = '正在准备…'

  let result
  try {
    result = await window.api.installPack({ filePath: packFilePath, targetVersionId, versionName })
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
  packInstallEl.textContent = '完成'
  packCancelEl.hidden = true
  packTargetRowEl.hidden = true
  packNameRowEl.hidden = true

  packProgressEl.textContent = result.versionId
    ? `装好啦！版本列表里多了个「${result.versionId}」——回启动页选它就能玩。` +
      `这次 ${packFileSummary(result)}` +
      (result.overrides ? `，另有 ${result.overrides} 个作者的配置文件` : '')
    : `装好啦！${result.written} 个文件已经解到 ${result.dest}`

  // 版本列表刷新，并把新版本选上
  await refreshLaunchFacts()
  if (result.versionId && launchInfo?.installed?.includes(result.versionId)) {
    selectedVersion = result.versionId
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
})

window.api.onPackProgress((stats) => {
  if (!packInstalling) return
  if (stats.percent === undefined) return
  packProgressEl.textContent =
    `正在下载… ${stats.percent}% · ${stats.done}/${stats.total} 个` +
    (stats.failed > 0 ? ` · 失败 ${stats.failed}` : '')
})

// ═══════════════════════════════════════
// 版本管理（M6.1）：改名、备注、四个文件夹、删版本
// ═══════════════════════════════════════

const verSettingsBtnEl = document.getElementById('ver-settings-btn')
const verModalEl = document.getElementById('ver-modal')
const verTitleEl = document.getElementById('ver-title')
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
/** 删除确认弹窗正在确认哪个版本 */
let deletingVersion = ''

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
  const id = editingVersion

  const info = launchInfo?.versionInfo?.[id] ?? { name: '', note: '' }
  verTitleEl.textContent = `版本设置 — ${id}`
  verNameEl.value = info.name
  verNoteEl.value = info.note
  verHintEl.textContent = ''
  verHintEl.classList.remove('verform__hint--bad')
  verFolderHintEl.textContent = ''
  verSettingsHintEl.textContent = '正在读设置…'
  verModalEl.hidden = false
  verNameEl.focus()

  // 「这个版本自己的设置」要现算（还要拿全局值作对比），异步读一下
  const settings = await window.api.getVersionSettings(id)
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

  const result = await window.api.setVersionSettings(id, patch)
  if (!result.ok) {
    verHintEl.textContent = result.error
    verHintEl.classList.add('verform__hint--bad')
    return
  }

  verSettingsInfo = await window.api.getVersionSettings(id)
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
    note: verNoteEl.value
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

  delTitleEl.textContent = `要删除版本「${deletingVersion}」吗？`
  delWhatEl.textContent = '正在算这个版本占多大…'
  delSafeEl.textContent = ''
  delModalEl.hidden = false

  const size = await window.api.getVersionSize(deletingVersion)

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

  const result = await window.api.deleteVersion(id)

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
    result = await window.api.installLoader({ gameVersion: base, loader: type })
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
  if (launchInfo?.installed?.includes(result.versionId)) {
    selectedVersion = result.versionId
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
    const result = await window.api.openVersionFolder(editingVersion, which)
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
}

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

function showSettingsTab(name) {
  for (const item of settingsMenuEl.children) {
    if (item.dataset && item.dataset.settingsTab) {
      item.classList.toggle('menu__item--on', item.dataset.settingsTab === name)
    }
  }
  for (const tab of settingsTabEls) {
    tab.hidden = tab.dataset.settingsTab !== name
  }
  if (name === 'backup') loadBackupTab()
}

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
// 版本号
// ═══════════════════════════════════════

document.getElementById('stat-left').textContent =
  `版本 ${window.api?.appVersion ?? '未知'}`

// 所有定义都就位了，把启动页显示出来。
// （放在最后调用：启动页要用到上面这些变量，页面还没解析完就调会踩空）
showPage('launch')

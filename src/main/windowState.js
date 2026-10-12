// 毛球 — 记住窗口的位置和大小
//
// 【为什么要单独一个文件】这件事和"启动器在干什么"没关系，
// 纯粹是窗口自己的事，塞进 main.js 里会把那个文件搞得更长。
//
// 【存在哪】%APPDATA%\毛球\window-state.json —— 和 config.json 分开，
// 因为它是"关窗口的一瞬间"高频写的，和用户配置（改一次存一次）不是一个节奏。
//
// 【踩过的坑（照抄上游经验）】
//   · 显示器拔了/换了，"上次的位置"可能落在不存在的屏幕上（幻影坐标，
//     典型是 -32000 这种）——必须判掉，否则窗口永远显示在看不见的地方。
//   · 高分屏缩放会让存下来的宽高取整后差一两个像素，越长越歪 —— 所以
//     存的时候用"正常尺寸"（最大化时另存一个 maximized 标记）。
//   · 存的尺寸比现在的屏幕还大（换小屏）—— 要按工作区夹一遍。

const fs = require('node:fs')
const path = require('node:path')
const { screen } = require('electron')
const paths = require('./paths')

/** 上次窗口状态存在这儿 */
function stateFile() {
  return path.join(paths.configDir(), 'window-state.json')
}

/** 坐标小于这个数就认为是"幻影坐标"（屏幕早就不在了） */
const GHOST = -30000

/** 设计稿上的"舒适尺寸"（M17.5 定的），屏幕够大就用这个 */
const COMFORT_WIDTH = 1180
const COMFORT_HEIGHT = 824

/** 主窗口允许的最小尺寸（屏幕正常时就是它俩） */
const MIN_WIDTH = 900
const MIN_HEIGHT = 600

/** 窗口和屏幕边缘至少留多少（按工作区比例算），别贴边也别超出 */
const MARGIN_RATIO = 0.04

/** 屏幕太小的话最多缩到这个比例，再缩界面就没法看了 */
const MIN_SCALE = 0.5

/**
 * 算出"这台电脑上合适的默认尺寸"和"最小尺寸"。
 * 屏幕小（1366×768 这种）就按比例缩，别一上来就顶出屏幕外。
 */
function adaptiveSize() {
  const area = screen.getPrimaryDisplay().workArea

  const scale = Math.min(
    1,
    Math.max(
      MIN_SCALE,
      Math.min(
        (area.width * (1 - MARGIN_RATIO * 2)) / COMFORT_WIDTH,
        (area.height * (1 - MARGIN_RATIO * 2)) / COMFORT_HEIGHT
      )
    )
  )

  return {
    width: Math.round(COMFORT_WIDTH * scale),
    height: Math.round(COMFORT_HEIGHT * scale),
    // 最小尺寸只在"屏幕比它还小"的时候才往下降，正常屏幕上不动它
    minWidth: Math.min(MIN_WIDTH, Math.round(area.width * 0.9)),
    minHeight: Math.min(MIN_HEIGHT, Math.round(area.height * 0.9))
  }
}

/** 读上次存的状态。读不到/坏了都当没存过 */
function readSaved() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (!raw || typeof raw !== 'object') return null

    const num = (value) => (Number.isFinite(value) ? Math.round(value) : null)

    return {
      x: num(raw.x),
      y: num(raw.y),
      width: num(raw.width),
      height: num(raw.height),
      maximized: raw.maximized === true
    }
  } catch {
    return null
  }
}

/** 原子写：先写临时文件再改名（断电不会把文件写坏，见 CLAUDE.md 红线） */
function writeSaved(state) {
  const file = stateFile()
  const tmp = `${file}.tmp`

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    // 记不住就记不住，下次用默认的。为这个弹错误框不值当
  }
}

/**
 * 把一组坐标夹回某个显示器的工作区里。
 * 返回 null 表示"这些坐标没法用"（屏幕不在了）。
 */
function clampToDisplay(x, y, width, height) {
  if (x === null || y === null) return null
  if (x < GHOST || y < GHOST) return null

  // 找一个"包含了这个点"的显示器；找不到就用主显示器
  const target =
    screen.getAllDisplays().find((d) => {
      const a = d.workArea
      return x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height
    }) || screen.getPrimaryDisplay()

  const area = target.workArea

  // 尺寸先夹进工作区（换小屏时窗口不能比屏幕还大）
  const w = Math.min(width ?? area.width, area.width)
  const h = Math.min(height ?? area.height, area.height)

  // 再把左上角拉回来，保证整个窗口都在屏幕里，且至少露出标题栏
  const left = Math.min(Math.max(x, area.x), area.x + area.width - w)
  const top = Math.min(Math.max(y, area.y), area.y + area.height - h)

  return { x: Math.round(left), y: Math.round(top), width: Math.round(w), height: Math.round(h) }
}

/**
 * 给 createWindow 用的：算出这次的窗口参数。
 * @returns {{width,height,minWidth,minHeight,x?,y?,maximized}}
 */
function restore() {
  const base = adaptiveSize()
  const saved = readSaved()

  if (!saved || !saved.width || !saved.height) {
    return { ...base, maximized: false }
  }

  // 存的尺寸也别超过这台机器的舒适尺寸太多——换到小屏时不留个"半截窗口在屏幕外"
  const width = Math.min(saved.width, Math.max(base.width, base.minWidth))
  const height = Math.min(saved.height, Math.max(base.height, base.minHeight))

  const placed = clampToDisplay(saved.x, saved.y, width, height)

  return {
    ...base,
    width,
    height,
    x: placed ? placed.x : undefined,
    y: placed ? placed.y : undefined,
    maximized: saved.maximized
  }
}

/**
 * 挂上自动保存。窗口动过/改过大小就记一笔（不会一直写盘）。
 * @param {import('electron').BrowserWindow} win
 */
function track(win) {
  let timer = null

  const save = () => {
    if (win.isDestroyed()) return
    try {
      // 最大化/全屏的时候要存"还原后"的尺寸，否则下次还原会变成整屏
      const maximized = win.isMaximized()
      const fullscreen = win.isFullScreen()
      const bounds = maximized || fullscreen ? win.getNormalBounds() : win.getBounds()
      writeSaved({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized
      })
    } catch {
      // 窗口正好在销毁就算了
    }
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    // 拖窗口时 resize/move 会疯狂触发，攒 500 毫秒再写一次
    timer = setTimeout(save, 500)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)

  // 关窗口那一刻一定要落盘一次——上面那 500 毫秒的攒批很可能还没到点
  win.on('close', () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    save()
  })
}

module.exports = { restore, track, adaptiveSize, stateFile }

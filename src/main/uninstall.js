// 毛球 — 卸载自己（M26）
//
// 【这是个什么东西】设置页那个「卸载毛球」按钮。点了之后不是毛球自己去删文件，
// 而是**把安装时生成的那个卸载程序拉起来**（NSIS 装的，就在毛球自己那个目录里，
// 名字是 `Uninstall 毛球.exe`）。删程序、清注册表、去控制面板里消失，全交给它——
// 那套逻辑是安装器自己写的，我们不该抄一遍。
//
// 【为什么不用用别的方式】「控制面板 → 卸载程序」走的也是同一个 exe；
// 让用户自己去那儿找，不如就在设置里给一个。
//
// 【用户的东西一个都不动】安装包打的时候 `deleteAppDataOnUninstall: false`，
// 所以 `%APPDATA%\毛球\`（设置、皮肤、令牌）**不会被删**；
// 游戏存档在游戏目录里，跟卸载更没关系。

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

/**
 * 卸载程序在哪儿。
 * 就放在**毛球自己那个目录**里（`process.execPath` 旁边）。
 * 名字随产品名走（`Uninstall <产品名>.exe`），所以按前缀找，别写死。
 * @returns {string} 找不到就空字符串（开发模式跑的就是这种）
 */
function findUninstaller() {
  const dir = path.dirname(process.execPath)
  try {
    const hit = fs.readdirSync(dir).find((name) => /^uninstall.*\.exe$/i.test(name))
    return hit ? path.join(dir, hit) : ''
  } catch {
    return ''
  }
}

/** 现在这个毛球能不能卸载（装在系统里的才行，开发模式跑的不算） */
function available() {
  return Boolean(findUninstaller())
}

/**
 * 拉起卸载程序。
 *
 * 【为什么要 detached】卸载程序要活过毛球自己 —— 我们马上就让毛球退出了，
 * 不 detached 的话它会跟着一起被杀掉，用户看到的就是"点了没反应"。
 */
function run() {
  const exe = findUninstaller()
  if (!exe) {
    return {
      ok: false,
      error: '没找到卸载程序。多半是因为现在这个毛球不是"装"出来的（开发模式直接跑的），本来就没有卸载程序。'
    }
  }

  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `卸载程序起不来：${error.message}` }
  }
}

module.exports = { available, run }

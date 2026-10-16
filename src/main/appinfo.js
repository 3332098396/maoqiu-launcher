// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — "我这一份是哪个毛球"（给导出的东西盖章：诊断包、整合包的说明里都要写）
//
// 【为什么要单独一个文件】导出去的包（诊断包、整合包）都得写清"这是哪一版毛球、是不是安装版"——
// 收到包的人第一件要知道的就是这个。以前这段只写在 main.js 里、只给界面用；
// 2026-10-17 用户导出诊断包时踩到：说明里没有版本，只能去翻启动日志里那行
// `-javaagent:…\resources\app.asar.unpacked\…` 才认出是安装版。
// 现在**只有这一处**说"我是什么版本"，多处要用就都来这儿拿。

const path = require('node:path')

// 直接读 package.json。**别用 app.getVersion()**：它认的是"App 目录里的 package.json"，
// 开发模式下认的是 Electron 自己那份——2026-10-17 实测打出来的说明里写着 **44.6.0**
// （Electron 的版本号），而不是毛球的 0.4.2。升版本只改 package.json 一处。
const APP_VERSION = require(path.join(__dirname, '..', '..', 'package.json')).version

/** 这次跑的是"装出来的那份"还是"开发时那份"——两者代码可能差一大截 */
function isPackaged() {
  try {
    const { app } = require('electron')
    return !!app.isPackaged
  } catch {
    // 读不到（没有 electron）就按开发版算：没打包过才会读不到
    return false
  }
}

/** 写给人看的一行：「0.4.2（安装版）」 */
function versionLabel() {
  return `${APP_VERSION}（${isPackaged() ? '安装版' : '开发版'}）`
}

module.exports = { APP_VERSION, isPackaged, versionLabel }

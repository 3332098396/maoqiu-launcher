// 毛球 — VoxLink 联机 · 自己的小设置
//
// 这里存的是**联机专属**的那点偏好，跟毛球主设置分开放：
//   · 服务器地址（默认官方那台，用户可以改成自建）
//   · 允不允许走中继（打洞失败时借别人服务器转发，见第 3 步）
//
// 文件放在 `%APPDATA%\毛球\voxlink.json`。
//
// 【写入方式】跟毛球别处的规矩一样：**先写临时文件，再改名**。
// 直接往正式文件上写，万一写到一半断电，配置就成了半截乱码，下次启动读不出来。
//
// SPDX-License-Identifier: MIT
// 写法参考 KAMUCL 的 voxlink/settings.ts（MIT），行为一致

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const paths = require('../paths')
const { DEFAULT_SERVER_URL } = require('./api')

/** 设置文件的位置。懒算，不在这里就建目录。 */
function settingsFile() {
  return path.join(paths.configDir(), 'voxlink.json')
}

/** 没设置过时的默认值。 */
function defaultSettings() {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    allowRelay: true,
    uploadDiagnostics: false
  }
}

/**
 * 读设置。
 * 文件不存在、读不动、或者里面的内容乱七八糟 —— 一律当"没设置过"，
 * 用默认值继续跑。**绝不因为设置坏了就让联机打不开。**
 */
function load() {
  try {
    const value = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    return {
      serverUrl: typeof value.serverUrl === 'string' && value.serverUrl ? value.serverUrl : DEFAULT_SERVER_URL,
      allowRelay: typeof value.allowRelay === 'boolean' ? value.allowRelay : true,
      uploadDiagnostics: value.uploadDiagnostics === true
    }
  } catch {
    return defaultSettings()
  }
}

/** 存设置：先写临时文件 → 再改名成正式文件（改名是"一瞬间"完成的，不会写坏）。 */
function save(value) {
  const file = settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(
      temporary,
      JSON.stringify({
        serverUrl: value.serverUrl,
        allowRelay: value.allowRelay !== false,
        uploadDiagnostics: value.uploadDiagnostics === true
      })
    )
    fs.renameSync(temporary, file)
  } finally {
    // 不管成没成，临时文件都别留下
    fs.rmSync(temporary, { force: true })
  }
}

module.exports = { settingsFile, defaultSettings, load, save }

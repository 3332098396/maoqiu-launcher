// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — UUID 小工具
//
// 【为什么单独一个文件】"把一串十六进制补成标准 UUID 写法"这件事，
// 微软登录、外置登录、离线账号三处都要用，以前是三个文件各抄一份。
// 抄三份的坏处不是多几行，是**改一份忘了另两份**——那种 bug 很难看出来。

/**
 * 收拾成标准 UUID 写法：8-4-4-4-12，小写，带横杠。
 * 给进来的不是 32 位十六进制（空值、或者服务器给了个怪东西）就返回空串，
 * 让调用方自己去判断"这个账号没拿到 UUID"。
 */
function dashedUuid(raw) {
  const hex = String(raw ?? '').replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return ''
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

module.exports = { dashedUuid }

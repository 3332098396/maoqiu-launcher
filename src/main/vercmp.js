// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 版本号比较
//
// 【为什么单独一个文件】装 Forge 和装 OptiFine 都要把版本号从新到旧排一遍，
// 以前两个文件各抄了一份。抄两份的坏处是**改一份忘了另一份**——排序坏掉
// 不会报错，只会"列表里的新版本跑到下面去了"，很难发现。
//
// 【为什么不能直接比字符串】"47.1.10" 按字符串排会跑到 "47.1.9" 前面
//（因为 '1' < '9'）。所以要把每段数字抠出来当数字比。

/** 版本号从新到旧。给 sort() 用：返回负数表示 a 更新、排在前面。 */
function compareNewerFirst(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number)
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return y - x
  }
  return 0
}

module.exports = { compareNewerFirst }

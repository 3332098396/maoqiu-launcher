// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 把一个版本导出成整合包（M23）
//
// 【这一块是干什么的】
// 用户花一晚上配好一个版本（几十个 Mod、一堆配置、资源包），
// 想发给朋友一起玩——以前只能让他自己一个个装。现在能导成一个 zip。
//
// 【导成什么形状】`.minecraft\versions\<版本名>\...` —— 就是常见启动器导出整合包的那套布局。
// 我们自己拖拽安装能认（走的是"整个游戏目录快照"那条路），别的启动器一般也认。
//
// 【什么东西**绝对不进去**】存档、截图、日志、崩溃报告。
//   · 存档是几百小时的成果，而且可能带聊天记录、带别人的建筑——不能跟着包走
//   · 截图里可能有聊天框、有服务器 IP、有别人
//   · 日志里有账号令牌（虽然我们已经会脱敏，但"不进去"比"进去再抹掉"干净）
// 这一条是红线级别的事：**导出是给别人看的，不能顺手把用户的私人东西带出去**。
//
// 当前进度：M23。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')
const zipwriter = require('./zipwriter')
const appinfo = require('./appinfo')

/**
 * 这些东西一律不进包（**名字完全匹配**，用相对版本文件夹的路径比）。
 * 之所以用"白名单式地排除"而不是"白名单式地包含"：
 * 整合包里的文件种类太多（config / kubejs / scripts / shaderpacks…），
 * 逐个列进来一定会漏；而"私人东西"就那么几样，列出来更可靠。
 */
const NEVER_EXPORT = new Set([
  'saves',
  'logs',
  'crash-reports',
  'screenshots',
  '.mixin.out',
  'localconfig',
  'journeymap',
  'replay_recordings',
  // natives 是启动时**从库里现解出来的**（每台机器一大串 dll），
  // 带上它包会胖几十 MB，而对方启动时会自己再解一遍——纯粹是白占地方
  'natives'
])

/** 单个文件最多多大（超过的多半不是 Mod，是用户自己扔进来的东西） */
const MAX_FILE_BYTES = 300 * 1024 * 1024

/** 收集这个版本要打包的文件 */
function collectVersionFiles(versionId, dir) {
  const root = paths.versionDir(versionId, dir)
  if (!fs.existsSync(root)) {
    return { ok: false, error: `找不到 ${versionId} 这个版本的文件夹` }
  }

  const files = []
  let bytes = 0
  let skipped = 0

  const walk = (now, rel) => {
    let items = []
    try {
      items = fs.readdirSync(now, { withFileTypes: true })
    } catch {
      return
    }

    for (const item of items) {
      const childRel = rel ? `${rel}/${item.name}` : item.name
      const full = path.join(now, item.name)

      // 顶层的那几样私人东西一律跳过（往下的层不按这个名单跳，
      // 因为 `config/某个mod/saves` 这种也可能是那个 mod 要用的）
      if (!rel && NEVER_EXPORT.has(item.name.toLowerCase())) {
        skipped++
        continue
      }
      // 下载到一半的残file
      if (item.name.endsWith('.part') || item.name.endsWith('.tmp')) {
        skipped++
        continue
      }
      // 符号链接不跟（跟进去可能跑到版本文件夹外面）
      if (item.isSymbolicLink()) {
        skipped++
        continue
      }

      if (item.isDirectory()) {
        walk(full, childRel)
        continue
      }
      if (!item.isFile()) continue

      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      if (size > MAX_FILE_BYTES) {
        skipped++
        continue
      }

      files.push({ source: full, name: `.minecraft/versions/${versionId}/${childRel}` })
      bytes += size
    }
  }

  walk(root, '')
  return { ok: true, files, bytes, skipped, root }
}

/**
 * 导出。
 *
 * @param {{versionId: string, outPath: string, dir?: string,
 *          onStage?: Function}} options
 */
async function exportPack({ versionId, outPath, dir, onStage } = {}) {
  if (!versionId) return { ok: false, error: '没说要导出哪个版本' }
  if (!outPath) return { ok: false, error: '没说要存到哪儿' }

  if (onStage) onStage('正在数一数这个版本里有哪些文件…')
  const collected = collectVersionFiles(versionId, dir)
  if (!collected.ok) return collected
  if (collected.files.length === 0) {
    return { ok: false, error: '这个版本的文件夹里什么都没有，导出来是个空包' }
  }

  // ——— 附一份说明。对方解压前应该知道这是什么、里面有没有他要小心的东西 ———
  const readme = [
    `毛球导出的整合包：${versionId}`,
    `（导出它的毛球：${appinfo.versionLabel()}）`,
    '',
    '怎么用：直接把整个压缩包拖进毛球的窗口，它会自己认出这是整合包并装好。',
    '用别的启动器的话，解压到游戏目录（让它覆盖 .minecraft 那一层）一般也能认出。',
    '',
    '这个包里有什么：',
    '  · 这个版本自己的文件夹（versions/' + versionId + '/）：Mod、配置、资源包…',
    '',
    '这个包里**没有**什么（导出时故意不带的）：',
    '  · 存档（世界）—— 那是做包的人的私人进度，也不该跟着包走',
    '  · 截图、日志、崩溃报告',
    '',
    '用之前注意：',
    `  · 如果这个版本是建立在别的版本之上的（比如某个原版或者加载器版本），`,
    `    对方电脑上得先有那个基础版本，不然可能起不来。`,
    `  · 包里的 Mod 都是原作者做的，自己玩没问题；要再分发请看清每个 Mod 的许可。`,
    '',
    `导出时间：${new Date().toLocaleString('zh-CN')}`
  ].join('\n')

  const tempDir = path.join(paths.cacheDir(), `packexport-${Date.now()}`)
  const readmePath = path.join(tempDir, '说明.txt')

  try {
    fs.mkdirSync(tempDir, { recursive: true })
    fs.writeFileSync(readmePath, readme, 'utf8')

    const list = collected.files.concat([{ source: readmePath, name: '说明.txt' }])

    if (onStage) {
      onStage(`正在打包 ${list.length} 个文件（${(collected.bytes / 1024 / 1024).toFixed(0)} MB）…`)
    }

    const zip = await zipwriter.writeZip(outPath, list, {
      onProgress: (done, total) => {
        if (onStage) onStage(`正在打包… ${Math.round((done / total) * 100)}%`)
      }
    })

    if (!zip.ok) return { ok: false, error: zip.error }

    return {
      ok: true,
      path: outPath,
      count: list.length,
      bytes: zip.bytes,
      skipped: collected.skipped
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // 删不掉就算了
    }
  }
}

module.exports = { exportPack, collectVersionFiles, NEVER_EXPORT }

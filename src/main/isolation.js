// 毛球 — 版本隔离：把共享的存档搬进版本自己的文件夹（M23）
//
// 【为什么需要这个】
// 毛球默认开着版本隔离：每个版本的存档放在 `versions\<版本>\saves\`。
// 但用户以前用别的启动器（或者关了隔离的版本）建的世界，在**公共的**
// `.minecraft\saves\` 里——一开隔离，游戏里就看不见它们了。
// 界面上早就提示了这件事（"共享存档目录里还有 N 个世界"），
// 但以前只能干看着——**没有搬过去的办法**。这一段就是那个"搬"。
//
// 【这套规矩】
//   · **永不覆盖**：目标里已经有同名的，跳过并如实报出来
//   · **事务式**：先复制到暂存区，全都复制成功了再一个个改名搬进去；
//     中间出任何错，把这次已经搬进去的**逆序删掉**，恢复成动手之前的样子
//   · 符号链接一律跳过（跟着链接走可能跑到存档外面去）
//
// 当前进度：M23。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')
const versions = require('./versions')

/** 数一个文件夹有多大 */
function dirSize(folder) {
  let total = 0
  const stack = [folder]
  let guard = 0
  while (stack.length > 0 && guard < 200000) {
    guard++
    const now = stack.pop()
    let items = []
    try {
      items = fs.readdirSync(now, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      const full = path.join(now, item.name)
      if (item.isDirectory()) stack.push(full)
      else {
        try {
          total += fs.statSync(full).size
        } catch {
          // 读不到就不算
        }
      }
    }
  }
  return total
}

/** 整个文件夹复制过去（符号链接跳过） */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const item of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, item.name)
    const dest = path.join(to, item.name)
    if (item.isSymbolicLink()) continue
    if (item.isDirectory()) copyDir(src, dest)
    else if (item.isFile()) fs.copyFileSync(src, dest)
  }
}

/** 把"这次要搬的东西"算出来——动手之前先让用户看清楚 */
function planSaveMove(versionId, dir) {
  const source = paths.savesDir(dir)
  const dest = versions.folderFor(versionId || '', 'saves', dir)

  if (!dest) return { ok: false, error: '得先知道是哪个版本（隔离是按版本各算各的）' }
  if (paths.sameDir(source, dest)) {
    return { ok: false, error: '这个版本没有开隔离，存档本来就在公共目录里，不用搬' }
  }

  let names = []
  try {
    names = fs.readdirSync(source, { withFileTypes: true })
  } catch {
    return { ok: true, source, dest, items: [], movable: 0, conflicts: 0, bytes: 0 }
  }

  const items = []
  for (const item of names) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue
    // 只搬"看着像存档"的（里面有 level.dat）——别的文件夹可能是备份或者杂七杂八的东西
    const from = path.join(source, item.name)
    if (!fs.existsSync(path.join(from, 'level.dat'))) continue

    const to = path.join(dest, item.name)
    let bytes = 0
    try {
      bytes = dirSize(from)
    } catch {
      bytes = 0
    }

    items.push({
      name: item.name,
      from,
      to,
      bytes,
      conflict: fs.existsSync(to) // 目标里已经有同名的 → 永不覆盖，跳过
    })
  }

  return {
    ok: true,
    source,
    dest,
    items,
    movable: items.filter((one) => !one.conflict).length,
    conflicts: items.filter((one) => one.conflict).length,
    bytes: items.filter((one) => !one.conflict).reduce((sum, one) => sum + one.bytes, 0)
  }
}

/**
 * 真搬。**调用方必须先让用户确认过**（红线：动用户文件要二次确认）。
 *
 * @param {(text: string) => void} [onStage] 进度说给界面听
 */
function moveSaves(versionId, dir, { onStage } = {}) {
  const plan = planSaveMove(versionId, dir)
  if (!plan.ok) return plan

  const todo = plan.items.filter((one) => !one.conflict)
  if (todo.length === 0) {
    return { ok: true, moved: 0, skipped: plan.conflicts, dest: plan.dest }
  }

  // 暂存区放在目标盘上（同一个盘才能"改名"这种原子操作）
  const stageDir = path.join(plan.dest, '.毛球搬运暂存')
  try {
    fs.rmSync(stageDir, { recursive: true, force: true })
    fs.mkdirSync(stageDir, { recursive: true })
  } catch (error) {
    return { ok: false, error: `建不了暂存目录：${error.message}` }
  }

  const staged = []
  const moved = []

  const cleanupStage = () => {
    try {
      fs.rmSync(stageDir, { recursive: true, force: true })
    } catch {
      // 清不掉就留着，下次搬的时候会先删它
    }
  }

  try {
    // ——— 第一步：全都先复制到暂存区 ———
    for (const one of todo) {
      if (onStage) onStage(`正在复制「${one.name}」…`)
      copyDir(one.from, path.join(stageDir, one.name))
      staged.push(one)
    }

    // ——— 第二步：复制全成功了，再一个个改名搬到位 ———
    // 【为什么分两步】改名是瞬间完成的。万一复制到一半出错，
    // 我们只需要把暂存区删掉，**用户的存档一个字节都没动过**。
    for (const one of staged) {
      if (fs.existsSync(one.to)) {
        // 极端情况：这中间用户自己建了个同名的。跳过，别覆盖
        continue
      }
      fs.renameSync(path.join(stageDir, one.name), one.to)
      moved.push(one)
    }

    cleanupStage()
    return {
      ok: true,
      moved: moved.length,
      skipped: plan.conflicts,
      dest: plan.dest,
      names: moved.map((one) => one.name)
    }
  } catch (error) {
    // ——— 出错了：把这次搬进去的逆序删掉，恢复原样 ———
    for (const one of moved.slice().reverse()) {
      try {
        fs.rmSync(one.to, { recursive: true, force: true })
      } catch {
        // 删不掉的留着——但至少如实告诉用户哪一个没还原
      }
    }
    cleanupStage()

    return {
      ok: false,
      error: `搬的时候出错了（${error.message}），已经搬进去的 ${moved.length} 个都退回去了。` +
        (moved.length > 0 ? `请检查这几个还在不在：${moved.map((one) => one.name).join('、')}` : '')
    }
  }
}

module.exports = { planSaveMove, moveSaves }

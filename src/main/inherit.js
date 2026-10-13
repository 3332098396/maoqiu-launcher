// 毛球 — 版本继承（M10）
//
// 【什么是版本继承】
// 装了 Mod 加载器（Fabric / Forge）的版本，它的版本 JSON 里会写一句
//     "inheritsFrom": "26.3"
// 意思是："游戏主体还是 26.3，我只是在它上面加了些库文件、换了个启动入口。"
// 这样的版本**自己不下载客户端 jar、也不带资源文件**——那些全用父版本的。
//
// 所以启动器要做的事是：把子版本和它继承的所有父版本**合起来看**，
// 算出一份完整的清单再安装 / 启动。
//
// 【合并规则】（和官方启动器、同类软件一致）
//   · 客户端 jar、资源索引、Java 要求：子版本没写就用父版本的
//   · 库文件：父的 + 子的（同名的以子的为准）
//   · 启动参数：父的在前、子的在后
//   · mainClass：子的优先（Fabric 就是靠这个把入口换成自己的）
//
// 当前进度：M10。

const fs = require('node:fs')
const paths = require('./paths')

/** 读一个已经装在硬盘上的版本 JSON */
function readInstalledJson(id, dir) {
  return JSON.parse(fs.readFileSync(paths.versionJsonFile(id, dir), 'utf8'))
}

/** 把子版本盖在父版本上面，合成一份 */
function mergeTwo(parent, child) {
  const merged = { ...parent, ...child }

  // 库文件：父的 + 子的，同名的以子的为准（子的写在后、会覆盖）
  const byName = new Map()
  for (const lib of parent.libraries || []) byName.set(lib.name, lib)
  for (const lib of child.libraries || []) byName.set(lib.name, lib)
  merged.libraries = [...byName.values()]

  // 启动参数：父的在前、子的在后（顺序有讲究，别调换）
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...((child.arguments && child.arguments.jvm) || [])],
      game: [...((parent.arguments && parent.arguments.game) || []), ...((child.arguments && child.arguments.game) || [])]
    }
    delete merged.minecraftArguments
  }

  // downloads 是"每个键各自独立"的：子的可能只写了 server，
  // 不能让它把父的 client 整个盖掉
  merged.downloads = { ...(parent.downloads || {}), ...(child.downloads || {}) }

  // 版本号用子的（界面上显示的就是它）
  merged.id = child.id || parent.id

  return merged
}

/**
 * 把"这个版本 + 它继承的所有父版本"合并成一份完整的版本 JSON。
 *
 * 【父版本必须和子版本在**同一个游戏目录**里找】Fabric / Forge 的版本是
 * "装在某个原版上面"的，父版本当然也在同一个 .minecraft 里。
 * 拿默认目录去找 D 盘那个 Fabric 版的爹，只会得出"父版本没装"。
 *
 * @param {string} versionId
 * @param {object} versionJson 这个版本自己的 JSON
 * @param {string} [dir] 这个版本在哪个游戏目录（不传 = 默认目录）
 * @returns {{json: object, rootId: string, missingParent: string|null}}
 *   rootId 是最底下那个"真正带客户端 jar"的版本（也就是原版）；
 *   missingParent 不为空 = 父版本没装，装不了（要先装它）
 */
function resolveVersion(versionId, versionJson, dir) {
  if (!versionJson.inheritsFrom) {
    return { json: versionJson, rootId: versionId, missingParent: null }
  }

  const chain = [versionJson]
  let current = versionJson
  const seen = new Set([String(versionId)])

  // 一层层往上找。Fabric 一般只套一层，但防着套多层的（也防死循环）
  while (current.inheritsFrom) {
    const parentId = String(current.inheritsFrom)
    if (seen.has(parentId)) break
    seen.add(parentId)

    let parent
    try {
      parent = readInstalledJson(parentId, dir)
    } catch {
      // 父版本没装——这个必须拦下来，不然会算出一份缺东少西的清单
      return { json: versionJson, rootId: versionId, missingParent: parentId }
    }

    chain.push(parent)
    current = parent
  }

  const rootId = String(current.id || chain[chain.length - 1].id)

  // 从最底下的父版本开始，一层层把子版本盖上去
  let merged = chain[chain.length - 1]
  for (let i = chain.length - 2; i >= 0; i--) {
    merged = mergeTwo(merged, chain[i])
  }

  return { json: merged, rootId, missingParent: null }
}

module.exports = { resolveVersion, mergeTwo, readInstalledJson }

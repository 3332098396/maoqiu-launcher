// 毛球 — 本地的 Mod / 资源包 / 光影 / 存档（M23）
//
// 【这个文件是干什么的】
// 以前毛球只会"往里装"（从 Modrinth 下完放好），从来不管"已经装了什么"。
// 用户装了几十个 Mod 之后想知道：装的是哪些？哪个过期了？能不能先关掉一个试试？
// 这一段就是回答这些问题的。
//
// 内容放在哪，**和 content.js 用的是同一套规则**（跟着版本隔离走），
// 所以两边永远不会各说各话。
//
// 【为什么读 jar 里的文件要自己写】Mod 的信息（叫什么、什么版本、要哪些前置）
// 全都写在 jar 里面的几个文本文件里，得先解开压缩包才能看见。
// 我们已经有 zip.js（自己写的，不引第三方），直接用它。
//
// 当前进度：M23。

const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths')
const versions = require('./versions')
const content = require('./content')
const zip = require('./zip')

/** 能被"关掉"（改后缀）的内容类型——只有 Mod 有这个玩法 */
const TOGGLEABLE = new Set(['mod'])

/** 关掉一个 Mod 就是在文件名后面加这个后缀（游戏不认这个后缀，等于没装） */
const DISABLED_SUFFIX = '.disabled'

// ——————————————————————————————————————————————
// 极简 TOML
// ——————————————————————————————————————————————

/**
 * 只认 Forge / NeoForge 那个 `mods.toml` 里用到的写法。
 *
 * 【为什么自己写一个】项目红线是"运行时不引第三方依赖"，而一个完整的 TOML
 * 解析器好几百行。我们真正要读的只有几个字段，所以只做这一小块。
 *
 * 【不认识的写法怎么办】原样跳过，不猜、不报错。mods.toml 里还塞着
 * credits / authors / displayURL 一大堆我们不看的，猜错了比不认得还糟。
 *
 * 认识的东西：
 *   key = "字符串"   key = '字符串'   key = 数字   key = true/false
 *   [section]  [[array.of.tables]]
 *   多行字符串 """…"""
 */
function parseToml(text) {
  const root = {}
  let current = root
  const lines = String(text || '').split(/\r?\n/)

  /**
   * 把行尾的注释切掉——**只切引号外面的 `#`**。
   *
   * 【为什么不能简单地 indexOf('#')】值本身可能带井号，比如
   * `displayURL="https://x.com/#faq"`，一刀切下去值就废了。
   * 实测真的 mods.toml 里到处是 `loaderVersion="[50,)" #mandatory` 这种写法，
   * 不切的话引号对不上，整个值都读不出来（第一版就栽在这儿）。
   */
  const stripComment = (raw) => {
    let inS = null
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      if (inS) {
        if (c === '\\') {
          i++
          continue
        }
        if (c === inS) inS = null
        continue
      }
      if (c === '"' || c === "'") {
        inS = c
        continue
      }
      if (c === '#') return raw.slice(0, i)
    }
    return raw
  }

  const unquote = (raw) => {
    const value = raw.trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      return value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1)
    }
    if (value === 'true') return true
    if (value === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
    return value
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim()
    if (!line || line.startsWith('#')) continue

    // ——— [段] / [[段数组]] ———
    // 【组头后面可以跟注释】真的 mods.toml 里写的是 `[[mods]] #mandatory`、
    // `[[dependencies.xxx]] #optional`。只认"整个行就是组头"的话，
    // **一条依赖都读不出来**（第一版就是这么栽的，而且不报错，只是静悄悄地少东西）。
    const arrayHeader = line.match(/^\[\[(.+?)\]\](?:\s*#.*)?$/)
    const tableHeader = line.match(/^\[(.+?)\](?:\s*#.*)?$/)
    if (arrayHeader || tableHeader) {
      const names = String((arrayHeader || tableHeader)[1])
        .split('.')
        .map((one) => one.trim().replace(/^"|"$/g, ''))
        .filter(Boolean)

      const isArray = Boolean(arrayHeader)
      let node = root
      for (let n = 0; n < names.length; n++) {
        const key = names[n]
        const last = n === names.length - 1

        if (last && isArray) {
          if (!Array.isArray(node[key])) node[key] = []
          const fresh = {}
          node[key].push(fresh)
          node = fresh
        } else {
          // 数组段里要接着往下走，用的是**最后一个元素**
          const existing = node[key]
          if (Array.isArray(existing)) node = existing[existing.length - 1]
          else {
            if (!existing || typeof existing !== 'object') node[key] = {}
            node = node[key]
          }
        }
      }
      current = node
      continue
    }

    // ——— key = value ———
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, '')
    let rawValue = line.slice(eq + 1).trim()
    if (!key) continue

    // 多行字符串：`"""…"""` 和 `'''…'''` 都算，一直读到收尾那个三引号
    const triple = rawValue.startsWith('"""') ? '"""' : rawValue.startsWith("'''") ? "'''" : null
    if (triple) {
      const rest = rawValue.slice(3)
      const endAt = rest.indexOf(triple)
      if (endAt >= 0) {
        rawValue = rest.slice(0, endAt)
      } else {
        const parts = [rest]
        for (i++; i < lines.length; i++) {
          const at = lines[i].indexOf(triple)
          if (at >= 0) {
            parts.push(lines[i].slice(0, at))
            break
          }
          parts.push(lines[i])
        }
        rawValue = parts.join('\n')
      }
      current[key] = rawValue.trim()
      continue
    }

    current[key] = unquote(stripComment(rawValue).trim())
  }

  return root
}

// ——————————————————————————————————————————————
// 读一个 Mod jar 的"身份证"
// ——————————————————————————————————————————————

/** 从 jar 里挑一个文件读出来当文本（找不到返回 null） */
function readEntryText(buffer, entries, names) {
  for (const name of names) {
    const entry = entries.find((one) => one.name === name)
    if (!entry) continue
    try {
      return zip.readEntry(buffer, entry, '').toString('utf8')
    } catch {
      // 这个读不出来就试下一个
    }
  }
  return null
}

/** 把 Fabric 的 depends 表整理成统一形状（不关心 minecraft / java 这些"不是 Mod 的"） */
const NOT_A_MOD = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-api',
  'forge',
  'neoforge',
  'quilt_loader',
  'quiltloader',
  'fabric'
])

function tidyFabricDepends(depends, mandatory) {
  const out = []
  for (const [id, range] of Object.entries(depends || {})) {
    if (NOT_A_MOD.has(String(id).toLowerCase())) continue
    out.push({
      id: String(id),
      versionRange: typeof range === 'string' ? range : '*',
      mandatory
    })
  }
  return out
}

/**
 * 读一个 Mod jar 里写着的信息。
 *
 * 按加载器挨个试：Fabric → NeoForge → Forge → 老 Forge（mcmod.info）。
 * 都认不出来就只给个文件名——**不瞎编**，界面上显示"认不出来"比显示错的强。
 *
 * @returns {{ok: boolean, id: string, name: string, version: string,
 *            description: string, loader: string, icon: string|null,
 *            depends: Array<{id: string, versionRange: string, mandatory: boolean}>}}
 */
function readModMeta(filePath) {
  const base = {
    ok: false,
    id: '',
    name: '',
    version: '',
    description: '',
    loader: '',
    icon: null,
    depends: []
  }

  let buffer
  try {
    buffer = fs.readFileSync(filePath)
  } catch {
    return base
  }

  let entries
  try {
    entries = zip.listEntries(buffer)
  } catch {
    // 不是个能读的 jar（下坏了、或者根本不是 jar）
    return { ...base, broken: true }
  }

  // ——— ① Fabric / Quilt ———
  const fabricText = readEntryText(buffer, entries, ['fabric.mod.json', 'quilt.mod.json'])
  if (fabricText) {
    try {
      const data = JSON.parse(fabricText)
      // quilt 的写法套了一层 quark
      const quilt = data.quilt_loader
      const meta = quilt
        ? { id: quilt.id, name: quilt.metadata?.name, version: quilt.version, description: quilt.metadata?.description, icon: quilt.metadata?.icon, depends: quilt.depends }
        : data

      const depends = Array.isArray(meta.depends)
        ? tidyFabricDepends(Object.fromEntries(meta.depends.map((one) => [one.id, one.version || '*'])), true)
        : tidyFabricDepends(meta.depends, true)

      return {
        ok: true,
        id: String(meta.id || ''),
        name: String(meta.name || meta.id || ''),
        version: String(meta.version || ''),
        description: String(meta.description || ''),
        loader: quilt ? 'quilt' : 'fabric',
        icon: pickIcon(meta.icon, entries),
        depends
      }
    } catch {
      // JSON 坏了就往下试别的
    }
  }

  // ——— ② NeoForge / Forge（mods.toml）———
  const tomlText = readEntryText(buffer, entries, ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml'])
  if (tomlText) {
    const parsed = parseToml(tomlText)
    const first = Array.isArray(parsed.mods) && parsed.mods.length > 0 ? parsed.mods[0] : null
    if (first) {
      const modId = String(first.modId || '')
      // depends 是按"谁的依赖"分组的：[[dependencies.我的id]] 里才是我的前置
      const group = (parsed.dependencies && parsed.dependencies[modId]) || []
      const depends = []
      for (const one of Array.isArray(group) ? group : [group]) {
        if (!one || !one.modId) continue
        if (NOT_A_MOD.has(String(one.modId).toLowerCase())) continue
        // mandatory 是字符串 "true"/"false"（TOML 里也可能写成真布尔）
        const mandatory = one.mandatory !== false && one.mandatory !== 'false'
        depends.push({ id: String(one.modId), versionRange: String(one.versionRange || '*'), mandatory })
      }

      const loader = entries.some((one) => one.name === 'META-INF/neoforge.mods.toml')
        ? 'neoforge'
        : 'forge'

      return {
        ok: true,
        id: modId,
        name: String(first.displayName || modId),
        version: String(first.version || ''),
        description: String(first.description || ''),
        loader,
        icon: pickIcon(first.logoFile, entries),
        depends
      }
    }
  }

  // ——— ③ 老 Forge（mcmod.info，一个 JSON 数组）———
  const oldText = readEntryText(buffer, entries, ['mcmod.info'])
  if (oldText) {
    try {
      const data = JSON.parse(oldText)
      const first = Array.isArray(data) ? data[0] : (data.modList && data.modList[0]) || data
      if (first && (first.modid || first.modId)) {
        const id = String(first.modid || first.modId)
        return {
          ok: true,
          id,
          name: String(first.name || id),
          version: String(first.version || ''),
          description: String(first.description || ''),
          loader: 'forge',
          icon: null,
          depends: []
        }
      }
    } catch {
      // 老格式认不出来就算了
    }
  }

  return base
}

/** icon 字段可能是一张图、也可能是一串图（取第一张），还要确认图真的在包里 */
function pickIcon(icon, entries) {
  const name = Array.isArray(icon) ? icon[0] : icon
  if (!name || typeof name !== 'string') return null
  // 前面不带 / 的是相对路径，得在资源目录里找
  const clean = name.replace(/^\/+/, '')
  const candidates = [clean, `assets/${clean}`]
  for (const one of candidates) {
    if (entries.some((entry) => entry.name === one)) return one
  }
  return null
}

/** 把 jar 里那张图标抠出来（界面要显示的小图） */
function readModIcon(filePath, iconName) {
  if (!iconName) return null
  try {
    const buffer = fs.readFileSync(filePath)
    const entries = zip.listEntries(buffer)
    const entry = entries.find((one) => one.name === iconName)
    if (!entry) return null
    return zip.readEntry(buffer, entry, '')
  } catch {
    return null
  }
}

// ——————————————————————————————————————————————
// 列文件
// ——————————————————————————————————————————————

/** 这类内容认哪些后缀（列表里只显示这些） */
const EXTENSIONS = {
  mod: ['.jar'],
  resourcepack: ['.zip'],
  shader: ['.zip']
}

/**
 * 列出某个版本"这一类内容"已经装了哪些。
 *
 * @returns {Array<{name: string, path: string, size: number, mtime: number,
 *                  disabled: boolean, meta: object|null}>}
 */
function listFiles(versionId, type, dir) {
  const folder = content.targetDir(versionId, type, dir)
  if (!folder) return []

  let names = []
  try {
    names = fs.readdirSync(folder)
  } catch {
    return [] // 文件夹还不存在 = 一个都没装
  }

  const exts = EXTENSIONS[type] || ['.zip']
  const out = []

  for (const name of names) {
    const disabled = TOGGLEABLE.has(type) && name.toLowerCase().endsWith(DISABLED_SUFFIX)
    const realName = disabled ? name.slice(0, -DISABLED_SUFFIX.length) : name
    const lower = realName.toLowerCase()
    if (!exts.some((ext) => lower.endsWith(ext))) continue
    // 数据包也放 .zip，但它们在存档里，不会跑到这儿来

    const full = path.join(folder, name)
    let info
    try {
      info = fs.statSync(full)
    } catch {
      continue
    }
    if (!info.isFile()) continue

    out.push({
      name: realName,
      file: name,
      path: full,
      size: info.size,
      mtime: info.mtimeMs,
      disabled,
      // Mod 才读身份信息（资源包/光影里面没有这套东西）
      meta: type === 'mod' && !disabled ? readModMeta(full) : null
    })
  }

  // 名字乱了不好找，按名字排；同名的大小写不敏感
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return out
}

/** 这一类的文件夹在哪（界面上「打开文件夹」用） */
function folderOf(versionId, type, dir) {
  return content.targetDir(versionId, type, dir)
}

// ——————————————————————————————————————————————
// 启用 / 禁用（只有 Mod 有）
// ——————————————————————————————————————————————

/**
 * 开关一个 Mod —— 就是给文件名加/去掉 `.disabled`。
 *
 * 【为什么要"先复制再删"而不是直接改名】直接 rename 在同一个文件夹里本来是一瞬间的事，
 * 但如果目标文件已经存在（比如手动留下过一个同名的），rename 会**覆盖**掉它。
 * 所以按上游的做法：用 COPYFILE_EXCL 复制（目标已存在就失败），成了再删原来的。
 * 这样最坏的情况是"什么都没发生"，不会是"把一个文件悄悄吃掉了"。
 */
function setModEnabled(filePath, enabled) {
  const current = path.resolve(String(filePath || ''))
  if (!current) return { ok: false, error: '没给文件路径' }

  const isDisabled = current.toLowerCase().endsWith(DISABLED_SUFFIX)
  const wantDisabled = !enabled

  if (isDisabled === wantDisabled) {
    return { ok: true, path: current, disabled: isDisabled, unchanged: true }
  }

  const target = wantDisabled ? `${current}${DISABLED_SUFFIX}` : current.slice(0, -DISABLED_SUFFIX.length)

  try {
    if (!fs.existsSync(current)) return { ok: false, error: '这个文件不在了' }
    if (fs.existsSync(target)) {
      return { ok: false, error: '已经有一个同名的文件了，先处理掉它再试' }
    }
    fs.copyFileSync(current, target, fs.constants.COPYFILE_EXCL)
    fs.unlinkSync(current)
    return { ok: true, path: target, disabled: wantDisabled }
  } catch (error) {
    return { ok: false, error: `改不了：${error.message}` }
  }
}

// ——————————————————————————————————————————————
// 删 / 导入
// ——————————————————————————————————————————————

/**
 * 删掉一个文件——**走系统回收站**，不进垃圾堆。
 *
 * 【为什么非要走回收站】红线里写着"删除任何用户文件前必须二次确认"。
 * 二确认由界面负责，但这里还能再保险一层：万一用户手滑点了"确定"、
 * 或者界面那边将来出了 bug，东西还在回收站里，捡得回来。
 * 一个玩了几百小时的东西，不该因为一次误点就没了。
 *
 * @param {import('electron').Shell} shell Electron 的 shell 模块（从外面传进来，方便测）
 */
async function moveToTrash(shell, targetPath) {
  const resolved = path.resolve(String(targetPath || ''))
  if (!resolved) return { ok: false, error: '没给路径' }
  if (!fs.existsSync(resolved)) return { ok: false, error: '这个东西已经不在了' }

  try {
    await shell.trashItem(resolved)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `删不掉：${error.message}` }
  }
}

/**
 * 把用户挑的文件复制进"该放的地方"。
 * 【只复制、不移动】用户挑的可能是他桌面上的东西，移走了他会找不到。
 */
function importFiles(versionId, type, dir, sourcePaths) {
  const folder = content.targetDir(versionId, type, dir)
  if (!folder) return { ok: false, error: '不知道这一类该放哪儿' }

  const list = (Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths]).filter(Boolean)
  if (list.length === 0) return { ok: false, error: '没挑文件' }

  const exts = EXTENSIONS[type] || ['.zip']
  const added = []
  const skipped = []

  try {
    paths.ensureDir(folder)
  } catch (error) {
    return { ok: false, error: `建不了文件夹：${error.message}` }
  }

  for (const source of list) {
    const from = path.resolve(String(source))
    const base = path.basename(from)

    if (!exts.some((ext) => base.toLowerCase().endsWith(ext))) {
      skipped.push({ name: base, why: `这类内容只认 ${exts.join(' / ')}` })
      continue
    }

    const to = path.join(folder, base)
    try {
      if (fs.existsSync(to)) {
        skipped.push({ name: base, why: '已经有一个同名的了' })
        continue
      }
      // 也走 COPYFILE_EXCL：宁可失败，也不覆盖用户已有的东西
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
      added.push(base)
    } catch (error) {
      skipped.push({ name: base, why: error.message })
    }
  }

  return { ok: true, added, skipped, dir: folder }
}

// ——————————————————————————————————————————————
// 存档（世界）
// ——————————————————————————————————————————————

/** 数一个文件夹有多大（存档大小要显示给用户看） */
function dirSize(folder) {
  let total = 0
  let stack = [folder]
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

/**
 * 列出能看见的存档，带上大小和上次玩的时间。
 * 转调 content.listSaves（那套"版本自己的 + 公共的都要找"的逻辑不能重写一份）。
 */
function listWorlds(versionId, dir) {
  return content.listSaves(versionId || '', dir).map((one) => {
    const full = path.join(one.folder, one.name)
    let size = 0
    let sizeFailed = false
    try {
      size = dirSize(full)
    } catch {
      sizeFailed = true
    }
    return { ...one, path: full, size, sizeFailed }
  })
}

/**
 * 把一个别处的存档文件夹复制进来（"导入别人的存档"）。
 * 【为什么要卡一道"里面有 level.dat 吗"】用户挑错文件夹是常事，
 * 复制进去一个没用的目录等于给他添乱，直接在入口说清楚更好。
 */
function importWorld(versionId, dir, sourceFolder, name) {
  const from = path.resolve(String(sourceFolder || ''))
  if (!fs.existsSync(path.join(from, 'level.dat'))) {
    return { ok: false, error: '这个文件夹里没有 level.dat，看着不像一个存档' }
  }

  const safeName = String(name || path.basename(from)).replace(/[\\/:*?"<>|]/g, '_').trim()
  if (!safeName) return { ok: false, error: '存档得有个名字' }

  const dest = versions.folderFor(versionId || '', 'saves', dir) || paths.savesDir(dir)
  const target = path.join(dest, safeName)
  if (fs.existsSync(target)) {
    return { ok: false, error: `已经有一个叫「${safeName}」的存档了，换个名字或者先处理掉它` }
  }

  try {
    copyDir(from, target)
    return { ok: true, path: target, name: safeName, dir: dest }
  } catch (error) {
    return { ok: false, error: `复制不过去：${error.message}` }
  }
}

/** 整个文件夹复制过去（Node 没有现成的，得自己走一遍） */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const item of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, item.name)
    const dest = path.join(to, item.name)
    if (item.isDirectory()) copyDir(src, dest)
    else if (item.isFile()) fs.copyFileSync(src, dest)
    // 符号链接之类的一律跳过：跟着链接走可能跑到存档外面去
  }
}

module.exports = {
  listFiles,
  folderOf,
  readModMeta,
  readModIcon,
  setModEnabled,
  moveToTrash,
  importFiles,
  listWorlds,
  importWorld,
  parseToml,
  EXTENSIONS,
  DISABLED_SUFFIX
}

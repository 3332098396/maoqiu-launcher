// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 图标生成脚本
//
// 【现在是干什么的】把 `build/icon-source.png`（一张方形的源图）**缩成各个尺寸**，
// 生成 Windows 各处要用的图标文件：
//     assets/app-256.png      窗口图标 / 过场动画 / 左上角头像
//     assets/tray-16.png      托盘（小）
//     assets/tray-32.png      托盘（大）
//     build/icon.ico          打包用的程序图标（里面装 16/32/48/256 四种）
//     build/icon.png          打包用的大图（electron-builder 别的平台要）
//
// 【为什么不再用代码画】2026-10-09 用户给了一张现成的图（紫色草方块 + 发光边框），
// 要求安装程序、桌面、过场动画都用它。原来那套"用代码画草方块"就没用了，
// 改成"从源图生成"——**换图标只要换 icon-source.png，重跑一次就行**。
//
// 【怎么跑】`npm run icons`
//
// 【为什么这个脚本要借 Electron 干活】纯 Node 没有解码 PNG 的能力（只有 zlib，
// 要自己写解码器），而 Electron 自带 nativeImage，读图、缩放、导出都是一句话。
// 所以脚本发现自己在普通 Node 里跑时，会**自动用 Electron 重跑一遍自己**
// （跟 scripts/start.js 处理 ELECTRON_RUN_AS_NODE 是一个套路）。

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const sourceFile = path.join(root, 'build', 'icon-source.png')

// ——————————————————————————————————————————————
// 第一段：如果现在是普通 Node 在跑，就用 Electron 把自己重启一遍
// ——————————————————————————————————————————————
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')

  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fs.existsSync(electron)) {
    console.error('找不到 Electron（node_modules/electron/dist/electron.exe 不在）。先跑一次 npm install。')
    process.exit(1)
  }

  const env = { ...process.env }
  // 这个环境变量会让 Electron 被当成普通 Node 跑（见 CLAUDE.md 的排查小抄）
  delete env.ELECTRON_RUN_AS_NODE

  const result = spawnSync(electron, [__filename], { stdio: 'inherit', env })
  process.exit(result.status ?? 1)
}

// ——————————————————————————————————————————————
// 第二段：以下是真正干活的部分（跑在 Electron 里）
// ——————————————————————————————————————————————
const { app, nativeImage } = require('electron')

/** ICO 就是一个盒子，里面装好几张不同尺寸的 PNG（Vista 起支持直接放 PNG） */
function encodeICO(images) {
  const HEADER = 6
  const ENTRY = 16

  const header = Buffer.alloc(HEADER)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = 图标（2 是光标）
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(ENTRY * images.length)
  let offset = HEADER + directory.length

  images.forEach(({ size, png }, index) => {
    const at = index * ENTRY
    // 宽高各占 1 字节；256 存不下，要写成 0（规矩就是这么定的）
    directory[at] = size >= 256 ? 0 : size
    directory[at + 1] = size >= 256 ? 0 : size
    directory[at + 2] = 0
    directory[at + 3] = 0
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += png.length
  })

  return Buffer.concat([header, directory, ...images.map((image) => image.png)])
}

/**
 * 把源图四周的空白裁掉（裁成正方形、留一点点边）。
 *
 * 【为什么要裁】源图四周留了一圈空白（实测 2048 里有 100px 左右），
 * 不裁的话缩到 16×16 时图案只占中间那一小块——糊成一团看不出是什么。
 * 裁完图案能大一圈。
 *
 * 【怎么找边界】沿着图片正中间那条横线和竖线扫，找"明显变亮"的地方
 * （图案/发光边框总归是亮的，四周是暗底）。扫不到就原样返回——宁可不动，
 * 也不要把图裁坏。
 */
function autoCrop(source) {
  const bmp = source.getBitmap()
  const { width: w, height: h } = source.getSize()
  const brightness = (x, y) => {
    const i = (y * w + x) * 4
    return (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3
  }
  const THRESHOLD = 90 // 暗紫底大约 40~60，发光边和草方块都在 100 以上

  let left = -1
  for (let x = 0; x < w; x++) if (brightness(x, Math.floor(h / 2)) > THRESHOLD) { left = x; break }
  let right = -1
  for (let x = w - 1; x >= 0; x--) if (brightness(x, Math.floor(h / 2)) > THRESHOLD) { right = x; break }
  let top = -1
  for (let y = 0; y < h; y++) if (brightness(Math.floor(w / 2), y) > THRESHOLD) { top = y; break }
  let bottom = -1
  for (let y = h - 1; y >= 0; y--) if (brightness(Math.floor(w / 2), y) > THRESHOLD) { bottom = y; break }

  if (left < 0 || right < 0 || top < 0 || bottom < 0) return source // 认不出来就不裁

  // 裁成正方形（以中心为准，取长的那条边），外面再留 2% 的边
  const halfW = (right - left + 1) / 2
  const halfH = (bottom - top + 1) / 2
  const half = Math.ceil(Math.max(halfW, halfH) * 1.02)
  const cx = Math.floor((left + right) / 2)
  const cy = Math.floor((top + bottom) / 2)

  const x = Math.max(0, cx - half)
  const y = Math.max(0, cy - half)
  const width = Math.min(w - x, half * 2)
  const height = Math.min(h - y, half * 2)
  const cropped = source.crop({ x, y, width, height })
  console.log(`图案在 ${w}×${h} 里占 x${left}..${right} / y${top}..${bottom}，裁成 ${width}×${height} 再缩放`)
  return cropped
}

/** 把源图缩成指定边长的 PNG */
function makeSize(source, size) {
  const image = source.resize({ width: size, height: size, quality: 'best' })
  return image.toPNG()
}

app.whenReady().then(() => {
  if (!fs.existsSync(sourceFile)) {
    console.error(`找不到源图：${sourceFile}\n换图标就把新图存成这个名字（正方形、越大越好）。`)
    app.exit(1)
    return
  }

  const raw = nativeImage.createFromPath(sourceFile)
  const size = raw.getSize()
  if (!size.width || !size.height) {
    console.error('源图读不出来——确认它是正常的 PNG。')
    app.exit(1)
    return
  }
  console.log(`源图：${size.width}×${size.height}（${path.relative(root, sourceFile)}）`)
  const source = autoCrop(raw)

  const assetsDir = path.join(root, 'assets')
  const buildDir = path.join(root, 'build')

  // 各处要用的 PNG
  for (const [file, px] of [
    ['app-256.png', 256],
    ['tray-16.png', 16],
    ['tray-32.png', 32]
  ]) {
    fs.writeFileSync(path.join(assetsDir, file), makeSize(source, px))
    console.log(`已生成 assets/${file}  (${px}×${px})`)
  }

  // 打包用的 .ico：Windows 按地方挑尺寸，缺了会糊或者显示成旧图
  const icoSizes = [16, 32, 48, 256]
  const ico = encodeICO(icoSizes.map((px) => ({ size: px, png: makeSize(source, px) })))
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico)
  console.log(`已生成 build/icon.ico  （含 ${icoSizes.join('/')} 四种尺寸，${ico.length} 字节）`)

  fs.writeFileSync(path.join(buildDir, 'icon.png'), makeSize(source, 256))
  console.log('已生成 build/icon.png  (256×256)')

  console.log('\n图标都生成好了。改完图标记得重新跑 npm run dist 打包 + 重装一遍，桌面那个才会变。')
  app.exit(0)
})

// 毛球 — 图标生成脚本
//
// 【为什么用脚本画图标，而不是找一张现成图片】
// 图标要和软件配套、能随时调。脚本生成意味着改几个数字重新跑一次就行，
// 不用去找设计、不用担心版权。（这套做法在「历史粘贴板」项目里已验证有效。）
//
// 【画的是什么】
// 我的世界最经典的「草方块」：上面一层草绿、下面一层泥土棕。
// 一眼就能认出是 MC，比画个抽象图形强。
//
// 【怎么跑】
//     npm run icons
// 会生成 assets/tray-*.png、assets/app-256.png、build/icon.ico、build/icon.png
//
// 【原理】
// PNG 文件本身就是"把像素数据压缩一下，前面加几个标记块"，用 Node 自带的 zlib
// 就能手动拼出来，不需要任何第三方库。
// 边缘平滑靠"超采样"：先按 4 倍尺寸画，再缩小时把 4×4 个像素平均成一个。

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// ——————————————————————————————————————————————
// 一、配色
// ——————————————————————————————————————————————
const GRASS = '#6FAE4A' // 草：上层的绿（旧配色，留着备用）
const DIRT = '#8B6239' // 泥土：下层的棕（旧配色，留着备用）

/**
 * M17.3：换成品牌渐变（紫→青），跟"霓虹紫青"那套主题一套。
 *
 * 【为什么用渐变而不是纯色】设计稿里那套配色的招牌就是紫→青的渐变
 * （大启动卡、主按钮都是它）。图标只用一个纯紫或纯青，放在任务栏里
 * 跟别的软件没区别；用渐变一眼就能认出是毛球。
 *
 * 【泥层为什么用"同一个渐变压暗"】草方块要有"块"的立体感，
 * 上下两层得是同色系、一亮一暗。用两种不相干的颜色就不像一块了。
 */
const BRAND_FROM = [154, 92, 247] // #9a5cf7（紫）
const BRAND_TO = [47, 212, 232] // #2fd4e8（青）
const mix = (a, b, t) => Math.round(a + (b - a) * t)

/** 按横坐标取品牌渐变的颜色（1.5~30.5 是方块在 32 格设计稿里的范围） */
function brandColor(px) {
  const t = Math.min(1, Math.max(0, (px - 1.5) / 29))
  return [
    mix(BRAND_FROM[0], BRAND_TO[0], t),
    mix(BRAND_FROM[1], BRAND_TO[1], t),
    mix(BRAND_FROM[2], BRAND_TO[2], t)
  ]
}

/** 泥层：同一条渐变，压暗到一半左右 */
function brandColorDark(px) {
  const [r, g, b] = brandColor(px)
  return [Math.round(r * 0.48), Math.round(g * 0.48), Math.round(b * 0.48)]
}

// ——————————————————————————————————————————————
// 二、PNG 编码
// ——————————————————————————————————————————————
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 每个通道 8 位
  ihdr[9] = 6 // 颜色类型 6 = RGBA（带透明度）
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // 每一行前面要加一个字节表示"本行不做过滤"
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ——————————————————————————————————————————————
// 三、绘图工具
// ——————————————————————————————————————————————
const SS = 4 // 超采样倍数

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ]
}

/** 矩形：在就返回 true。方块是方的，不做圆角，这才是 MC 的样子 */
function inRect(px, py, x, y, w, h) {
  return px >= x && px < x + w && py >= y && py < y + h
}

/**
 * 画出图标。所有坐标都按 32×32 的"设计稿"来写，
 * 输出成别的尺寸时自动等比缩放。
 */
function renderIcon(size) {
  const S = size * SS
  const k = S / 32 // 设计稿坐标 → 实际像素 的缩放系数

  const acc = new Float32Array(S * S * 4)

  /**
   * 按形状铺一层颜色。test 返回 true 的地方就被涂上。
   * colorAt 传字符串就是铺纯色；传函数就是"按坐标算颜色"（渐变用它）。
   */
  const paint = (test, colorAt) => {
    const flat = typeof colorAt === 'string' ? hexToRgb(colorAt) : null
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const px = (x + 0.5) / k
        const py = (y + 0.5) / k
        if (!test(px, py)) continue
        const [r, g, b] = flat || colorAt(px, py)
        const i = (y * S + x) * 4
        acc[i] = r
        acc[i + 1] = g
        acc[i + 2] = b
        acc[i + 3] = 1
      }
    }
  }

  // —— 第 1 层：泥土（整个方块） ——
  // 留 1.5 像素的边距，免得贴到图标边缘显得挤
  paint((px, py) => inRect(px, py, 1.5, 1.5, 29, 29), brandColorDark)

  // —— 第 2 层：草（上面约三分之一） ——
  // 真实的草方块，草大概占方块高度的三成左右，多了就不像了
  paint((px, py) => inRect(px, py, 1.5, 1.5, 29, 9.5), brandColor)

  // —— 第 3 层：草往下垂得不齐，像真的草皮 ——
  // 几块高低不一的草挂在下面。**用和草一样的绿**，只是往下参差；
  // 换成深色会看着像另外贴上去的小方块，就不像草了
  const tabs = [
    { x: 2.5, w: 3.5, h: 1.6 },
    { x: 8, w: 4.5, h: 2.4 },
    { x: 14.5, w: 2.5, h: 1.2 },
    { x: 19, w: 5, h: 2.8 },
    { x: 26, w: 3, h: 1.8 }
  ]
  for (const tab of tabs) {
    paint((px, py) => inRect(px, py, tab.x, 11, tab.w, tab.h), brandColor)
  }

  // —— 缩回目标尺寸：把 SS×SS 个像素平均成一个 ——
  const out = Buffer.alloc(size * size * 4)
  const samples = SS * SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4
          // 按"预乘透明度"求平均，否则边缘会出现黑边
          const alpha = acc[i + 3]
          r += acc[i] * alpha
          g += acc[i + 1] * alpha
          b += acc[i + 2] * alpha
          a += alpha
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round((a / samples) * 255)
    }
  }

  return encodePNG(size, size, out)
}

// ——————————————————————————————————————————————
// 四、打包成 .ico（Windows 的程序图标格式）
// ——————————————————————————————————————————————
//
// ICO 就是一个"盒子"，里面可以装好几张不同尺寸的图，Windows 按当前需要
// 挑合适的那张显示。从 Vista 起盒子里可以直接放 PNG，所以只要把画好的
// PNG 塞进去、前面加一小段目录说明就行。
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
    // 宽高各占 1 字节，256 要写成 0（一个字节存不下 256）
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

// ——————————————————————————————————————————————
// 五、生成
// ——————————————————————————————————————————————
const assetsDir = path.join(__dirname, '..', 'assets')
const buildDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(assetsDir, { recursive: true })
fs.mkdirSync(buildDir, { recursive: true })

const targets = [
  { file: 'tray-16.png', size: 16 },
  { file: 'tray-32.png', size: 32 },
  { file: 'app-256.png', size: 256 }
]

for (const { file, size } of targets) {
  const png = renderIcon(size)
  fs.writeFileSync(path.join(assetsDir, file), png)
  console.log(`已生成 assets/${file}  (${size}×${size}, ${png.length} 字节)`)
}

const icoSizes = [16, 32, 48, 256]
const ico = encodeICO(icoSizes.map((size) => ({ size, png: renderIcon(size) })))
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico)
console.log(`已生成 build/icon.ico  （含 ${icoSizes.join('/')} 四种尺寸，${ico.length} 字节）`)

fs.writeFileSync(path.join(buildDir, 'icon.png'), renderIcon(256))
console.log('已生成 build/icon.png  (256×256)')

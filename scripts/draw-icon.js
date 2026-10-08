// 毛球 — 画一张图标源图（紫色草方块，背景透明）
//
// 【为什么不用用户给的那张原图】用户 2026-10-09 给了一张很漂亮的紫色草方块渲染图，
// 要求做成 PCL 那样"只有方块、背景透明"的图标。但那张图**抠不出来**——
// 实测试了五种分法（区域生长 / 按行插值背景色 / 补洞 / 连着边缘的当背景 / 每列留最下面一段）：
// 方块下半部分的暗紫泥土和背景的暗紫太接近，上面那条紫色光带又和方块顶端连着，
// 每一种不是啃掉方块一块、就是留下背景一条。
//
// 所以照它的**样子**画一个：同样是紫色的草方块、等距视角、像素质感，
// 但背景是真的透明，缩到 16×16 也清清楚楚（照片感的图缩那么小反而糊）。
//
// 【怎么跑】`npm run icons` 之前先跑一次 `npm run draw-icon`（或者手动
// `node_modules/electron/dist/electron.exe scripts/draw-icon.js`），
// 它会生成 build/icon-source.png，然后 make-icons.js 再拿去缩成各个尺寸。
//
// 【技术上的取巧】不用 canvas、不用三方库：每个像素点属于哪个面是**算出来的**
// （等距投影的三块平行四边形），像素质感和草土分界用一个"固定的伪随机"生成
// （同样的输入永远画出一样的图，所以图标是可复现的）。最后用 4 倍超采样抹平锯齿。

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// ——————————————————————————————————————————————
// 一、配色（照着用户那张图取的色）
// ——————————————————————————————————————————————
const GRASS_LIGHT = [186, 116, 245] // 草：亮
const GRASS_MID = [160, 84, 232] // 草：中
const GRASS_DARK = [134, 62, 208] // 草：暗
const DIRT_BASE = [58, 36, 64] // 泥土：底
const DIRT_SPECKS = [
  [96, 58, 116],
  [120, 74, 148],
  [74, 46, 88],
  [138, 88, 176],
  [52, 32, 58]
]

// ——————————————————————————————————————————————
// 二、一个"固定的伪随机"：同样的坐标永远得到同样的数（图标要可复现）
// ——————————————————————————————————————————————
function hash2(x, y) {
  let h = x * 374761393 + y * 668265263
  h = (h ^ (h >> 13)) * 1274126177
  return ((h ^ (h >> 16)) >>> 0) / 4294967295
}

// ——————————————————————————————————————————————
// 三、等距（斜 45°）方块：算出每个像素属于哪一面
// ——————————————————————————————————————————————
//
// 设方块边长 1，用这样的投影：
//   顶面：菱形（左顶点、上顶点、右顶点、下顶点）
//   左面 / 右面：下面的两块平行四边形
// 用"逆变换"判断像素落在哪块里——比自己画三角形省事得多。
function faceAt(u, v) {
  // u,v 是归一化到 [-1.5, 1.5] 左右的坐标；返回 'top' / 'left' / 'right' / null
  const halfW = 1 // 菱形半宽
  const halfH = 0.5 // 菱形半高（等距 2:1）
  const height = 1.2 // 侧面往下多高（比半高长，看起来是个立体的方块）

  // 顶面菱形：|u|/halfW + |v|/halfH <= 1
  const d = Math.abs(u) / halfW + Math.abs(v) / halfH
  if (d <= 1) return 'top'

  // 侧面：在菱形下方，往左/往右各一半
  if (v > halfH * (1 - Math.abs(u) / halfW) && v <= halfH * (1 - Math.abs(u) / halfW) + height) {
    return u < 0 ? 'left' : 'right'
  }
  return null
}

/** 草皮往下扎的那圈锯齿：草土分界（越靠外越往下，像草方块那样） */
function grassDepth(u, v, edgeY) {
  // edgeY 是这一面的"草土分界"基准高度
  const t = (v - edgeY) / 0.42 // 0 = 分界处，1 = 锯齿最深处
  if (t <= 0) return true // 还在草里
  if (t >= 1) return false
  // 方块上的"格子"：每格 1/8 宽度，格子里随机决定这格草扎多深
  const cell = Math.floor((u + 2) * 8)
  const row = Math.floor((v + 2) * 8)
  const depth = hash2(cell, row)
  return t < depth
}

// ——————————————————————————————————————————————
// 四、把一张图渲染出来（超采样 4 倍再缩，边缘就平滑了）
// ——————————————————————————————————————————————
function render(size, scale) {
  const S = size * scale
  const px = new Float32Array(S * S * 4) // RGBA，0~255，先累加

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // 归一到 [-1.5, 1.5]：方块占画面中间大部分，四周留一点点边
      const u = ((x + 0.5) / S - 0.5) * 2.4
      const v = (((y + 0.5) / S - 0.5) * 2.4) + 0.6
      const face = faceAt(u, v)
      const o = (y * S + x) * 4
      if (!face) continue // 透明

      let color
      if (face === 'top') {
        // 顶面：一格一格的紫，带一点明暗变化
        const cell = Math.floor((u + 2) * 8)
        const row = Math.floor((v + 2) * 8)
        const r = hash2(cell, row)
        color = r < 0.34 ? GRASS_LIGHT : r < 0.68 ? GRASS_MID : GRASS_DARK
        // 靠左上的稍微亮一点，有点光照感
        const lift = (u + v) * -0.06
        color = color.map((c) => Math.max(0, Math.min(255, Math.round(c + lift * 255))))
      } else {
        // 侧面：上面是草（扎一圈锯齿），下面是泥土（撒一层紫色碎点）
        const dir = face === 'left' ? -1 : 1
        const edgeY = 0.02 + (u * dir) * 0.18
        const inGrass = grassDepth(u, v, edgeY)
        const shade = face === 'left' ? 0.95 : 0.72 // 左面亮一点、右面暗一点
        if (inGrass) {
          const cell = Math.floor((u + 2) * 8)
          const row = Math.floor((v + 2) * 8)
          const r = hash2(cell + 37, row + 11)
          const base = r < 0.5 ? GRASS_MID : GRASS_DARK
          color = base.map((c) => Math.round(c * shade))
        } else {
          const cell = Math.floor((u + 2) * 12)
          const row = Math.floor((v + 2) * 12)
          const r = hash2(cell + 91, row + 57)
          const base = r < 0.45 ? DIRT_BASE : DIRT_SPECKS[Math.floor(hash2(cell, row + 3) * DIRT_SPECKS.length)]
          color = base.map((c) => Math.round(c * shade))
        }
      }

      px[o] = color[0]
      px[o + 1] = color[1]
      px[o + 2] = color[2]
      px[o + 3] = 255
    }
  }

  // 缩小（把 scale×scale 个像素平均成一个）
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = ((y * scale + dy) * S + (x * scale + dx)) * 4
          const alpha = px[o + 3] / 255
          r += px[o] * alpha
          g += px[o + 1] * alpha
          b += px[o + 2] * alpha
          a += alpha
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round((a / (scale * scale)) * 255)
    }
  }
  return out
}

// ——————————————————————————————————————————————
// 五、写 PNG（纯 Node，用自带的 zlib）
// ——————————————————————————————————————————————
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // 每行前面一个"过滤方式"字节
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 每通道 8 位
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ——————————————————————————————————————————————
// 六、生成
// ——————————————————————————————————————————————
const root = path.join(__dirname, '..')
const size = 1024 // 源图不用太大：够缩到 256 就行，而且画得也快
const png = encodePNG(render(size, 4), size)
const file = path.join(root, 'build', 'icon-source.png')
fs.writeFileSync(file, png)
console.log(`已画出 build/icon-source.png（${size}×${size}，${png.length} 字节）`)
console.log('接着跑 npm run icons，就会缩成各个尺寸 + 生成 icon.ico')

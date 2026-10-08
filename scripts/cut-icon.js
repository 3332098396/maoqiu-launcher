// 白底图抠图：白色变透明 → 只留最大的一块（水印、杂点自动掉）→ 裁到内容
const { app, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
app.on('window-all-closed', () => {})

app.whenReady().then(() => {
  const src = nativeImage.createFromPath(process.env.MQ_SRC)
  const { width: W, height: H } = src.getSize()
  const bmp = Buffer.from(src.getBitmap()) // BGRA
  const idx = (x, y) => (y * W + x) * 4
  console.log(`源图 ${W}×${H}`)

  // ① 白变透明（留一点渐变边，免得边缘一圈白渣）
  const HARD = 238 // 比这个亮 = 全是背景
  const SOFT = 205 // 比这个暗 = 全是图形；中间按比例给半透明
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = idx(x, y)
      const lum = Math.min(bmp[o], bmp[o + 1], bmp[o + 2])
      if (lum >= HARD) {
        bmp[o + 3] = 0
      } else if (lum > SOFT) {
        const t = (HARD - lum) / (HARD - SOFT) // 0~1
        const a = Math.max(0.02, t)
        bmp[o + 3] = Math.round(255 * t)
        // 这些像素本来是"方块色 + 白底"混出来的，倒推回纯粹的方块色
        for (let c = 0; c < 3; c++) {
          const pure = (bmp[o + c] - (1 - a) * 255) / a
          bmp[o + c] = Math.max(0, Math.min(255, Math.round(pure)))
        }
      }
    }
  }

  // ② 只留最大的一块（水印、"豆包AI生成"那几个字，都是分开的小块）
  const seen = new Uint8Array(W * H)
  let best = null
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (seen[i] || bmp[i * 4 + 3] < 40) continue
      const stack = [i]
      seen[i] = 1
      const cells = []
      while (stack.length) {
        const cur = stack.pop()
        cells.push(cur)
        const cx = cur % W
        const cy = (cur - cx) / W
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const ni = ny * W + nx
          if (seen[ni] || bmp[ni * 4 + 3] < 40) continue
          seen[ni] = 1
          stack.push(ni)
        }
      }
      if (!best || cells.length > best.length) best = cells
    }
  }
  console.log(`最大的一块 ${best ? best.length : 0} 个像素`)
  if (best) {
    const keep = new Set(best)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (bmp[i * 4 + 3] > 0 && !keep.has(i)) bmp[i * 4 + 3] = 0
      }
    }
  }

  // ③ 裁到内容 + 留一点点边
  let minX = W, minY = H, maxX = -1, maxY = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (bmp[idx(x, y) + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  console.log(`内容占 x${minX}..${maxX} / y${minY}..${maxY}`)
  const half = Math.ceil((Math.max(maxX - minX, maxY - minY) / 2) * 1.05)
  const cx = Math.floor((minX + maxX) / 2)
  const cy = Math.floor((minY + maxY) / 2)
  const out = nativeImage.createFromBitmap(bmp, { width: W, height: H })
  const cut = out.crop({
    x: Math.max(0, cx - half),
    y: Math.max(0, cy - half),
    width: Math.min(W, half * 2),
    height: Math.min(H, half * 2)
  })
  const target = path.join(__dirname, '..', 'build', 'icon-source.png')
  fs.writeFileSync(target, cut.toPNG())
  console.log('存成 build/icon-source.png ' + JSON.stringify(cut.getSize()))
  app.exit(0)
})

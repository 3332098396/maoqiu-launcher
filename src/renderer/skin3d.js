// 毛球 — 3D 皮肤预览（M14.4）
//
// 【这是什么】启动页右边那个能拖着转的小人。学 KAMUCL 的做法，但用的是
// Three.js 而不是它的 skinview3d —— 我们只需要"一个方块人 + 走路动画"，
// 直接管 Three.js 更可控（理由记在 docs/02）。
//
// 【为什么单独一个文件、还要 type="module"】Three.js 是 ESM 模块，
// 而界面主体（app.js）是普通脚本。模块脚本可以 import 它，普通脚本不行。
// 所以这里单独开一个模块，做完把接口挂到 window.skinViewer 上给 app.js 用。
//
// 【MC 皮肤的 UV 映射 —— 这块最容易翻车】
// 皮肤是一张 64×64 的 PNG，每个身体部位（头/身/左右臂/左右腿）在图上占一块，
// 每块里再按"上、下、右、前、左、后"六个面摆成十字形。顺序和偏移错一个像素，
// 脸上就会长出一条腿。所以下面这张表**别凭记忆改**——
// 想知道对不对：换一张"每块颜色都不一样"的测试皮肤看一眼（见 makeDebugSkin）。

import * as THREE from './vendor/three.module.js'

/**
 * 身体各部位：名字、尺寸（宽 高 厚）、在皮肤图上的位置、**转轴**、方块顶在转轴上面多少。
 *
 * 【尺寸和位置是对着 Minecraft 原版模型摆的】
 *   脚底 y=0 → 腿 0~12 → 腰 y=12 → 身体 12~24 → 肩 y=24 → 头 24~32
 *
 * 【pivot 是"转轴"，不是方块顶】手要绕**肩膀**转、腿要绕**胯**转，
 * 所以这两个数得分开写：转轴 + boxTop = 方块顶。
 *   头：转轴在脖子 y=24，方块顶 32 → boxTop 8
 *   身体：转轴在肩线 y=24，方块顶 24 → boxTop 0
 *   手臂：转轴在肩关节 y=22（比肩线低 2 格，跟原版一样），方块顶 24 → boxTop 2
 *   腿：转轴在胯 y=12，方块顶 12 → boxTop 0
 * 【踩过的坑】一开始只有一个"挂点"，而且是"方块顶"，于是走路时手脚绕**自己中心**
 * 转（不是绕肩膀）——画面上手臂会跟身体脱开、腿从胯部拧出来。不报错，只是"看着不对"。
 *
 * 【左右别装反】皮肤图上"右臂"那块在 (40,16)、"左臂"在 (32,48)；原版里
 * **右臂在 -x 这一侧**（站在角色面前时，他的右手在你的左边）。
 * 一开始把 (40,16) 贴到了 +x 那只手上，结果就是**左右镜像**——
 * 对称的皮肤看不出来，但戴手表、有纹身的皮肤一眼就露馅。
 * 所以下面 armR 的 pivot.x 是 -6、armL 是 +6，腿同理。
 */
const PARTS = [
  // 头：8×8×8，在 (0,0)
  { name: 'head', w: 8, h: 8, d: 8, at: [0, 0], overlayAt: [32, 0], pivot: [0, 24, 0], boxTop: 8 },
  // 身体：8×12×4，在 (16,16)
  { name: 'body', w: 8, h: 12, d: 4, at: [16, 16], overlayAt: [16, 32], pivot: [0, 24, 0], boxTop: 0 },
  // 右臂：4×12×4，在 (40,16) —— 在 -x 侧
  { name: 'armR', w: 4, h: 12, d: 4, at: [40, 16], overlayAt: [40, 32], pivot: [-6, 22, 0], boxTop: 2 },
  // 左臂：4×12×4，在 (32,48) —— 在 +x 侧
  { name: 'armL', w: 4, h: 12, d: 4, at: [32, 48], overlayAt: [48, 48], pivot: [6, 22, 0], boxTop: 2 },
  // 右腿：4×12×4，在 (0,16) —— 在 -x 侧
  { name: 'legR', w: 4, h: 12, d: 4, at: [0, 16], overlayAt: [0, 32], pivot: [-2, 12, 0], boxTop: 0 },
  // 左腿：4×12×4，在 (16,48) —— 在 +x 侧
  { name: 'legL', w: 4, h: 12, d: 4, at: [16, 48], overlayAt: [16, 48], pivot: [2, 12, 0], boxTop: 0 }
]

/**
 * 一个部位六个面在皮肤图上的位置（相对这块的左上角）。
 *
 * 顺序和 Three.js 的 BoxGeometry 一致：+x, -x, +y, -y, +z, -z
 * （也就是 左、右、上、下、前、后）。
 * 每一面给的是 [x, y, 宽, 高]，单位是皮肤图上的像素。
 *
 * 【图上的摆法】一个部位在皮肤图里摊开成这样（宽 w 高 h 厚 d）：
 *
 *              [ 上 w×d ][ 下 w×d ]
 *      [ 右 d×h ][ 前 w×h ][ 左 d×h ][ 后 w×h ]
 *
 * 上面一排从 x=d 开始、高 d；下面一排从 y=d 开始。
 *
 * 【两面侧面的坐标千万不要凭感觉写】`d+w+d` 是**宽度**方向的偏移，不是高度方向的。
 * 一开始把侧面的 y 写成了 `d+w+d`，等于往下挪了 w 行——那个矩形就压到别的部位
 * 在图上占的位置去了。默认皮肤"自己画自己采"所以看着还凑合，
 * 但那块被压到的贴图会从**外套层**漏出来，躯干正面就变成两种蓝。
 * 换一张真皮肤更明显：脸上会长出一条腿。
 */
function faceRects(w, h, d) {
  return {
    px: [d + w, d, d, h], // +x：角色的左侧面（图上"左"那一列）
    nx: [0, d, d, h], // -x：角色的右侧面（图上"右"那一列）
    py: [d, 0, w, d], // +y：上（头顶）
    ny: [d + w, 0, w, d], // -y：下（脚底）
    pz: [d, d, w, h], // +z：前（脸）
    nz: [d + w + d, d, w, h] // -z：后（后脑勺）
  }
}

/** 画一张 64×64 的皮肤：默认的"毛球"小人（不依赖任何外部图片） */
function makeDefaultSkin() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')

  // 底色透明（没画到的地方=没东西）
  ctx.clearRect(0, 0, 64, 64)

  const drawPart = (at, w, h, d, colors) => {
    const [bx, by] = at
    const rects = faceRects(w, h, d)
    // 六个面各填一个颜色：上 前 侧 后 下 都有区别，方便看出映射对不对
    const map = {
      py: colors.top,
      ny: colors.bottom,
      pz: colors.front,
      nz: colors.back,
      px: colors.side,
      nx: colors.side
    }
    for (const [key, rect] of Object.entries(rects)) {
      ctx.fillStyle = map[key]
      ctx.fillRect(bx + rect[0], by + rect[1], rect[2], rect[3])
    }
  }

  // 毛球配色：蓝衣服、深蓝裤子、皮肤色的头
  const skin = '#f0c8a0'
  const skinDark = '#d8ae86'
  const shirt = '#4a9bff'
  const shirtDark = '#3d86d8'
  const pants = '#2f4a6b'

  drawPart([0, 0], 8, 8, 8, { top: '#5aa9ff', bottom: skinDark, front: skin, back: skinDark, side: skin })
  drawPart([16, 16], 8, 12, 4, { top: shirtDark, bottom: pants, front: shirt, back: shirtDark, side: shirtDark })
  drawPart([40, 16], 4, 12, 4, { top: shirtDark, bottom: skin, front: shirt, back: shirtDark, side: shirt })
  drawPart([32, 48], 4, 12, 4, { top: shirtDark, bottom: skin, front: shirt, back: shirtDark, side: shirt })
  drawPart([0, 16], 4, 12, 4, { top: pants, bottom: '#2a2a2a', front: pants, back: pants, side: pants })
  drawPart([16, 48], 4, 12, 4, { top: pants, bottom: '#2a2a2a', front: pants, back: pants, side: pants })

  // 脸上画两个眼睛（在"前"那一面的坐标里）
  ctx.fillStyle = '#2b3a4a'
  ctx.fillRect(9, 12, 2, 1)
  ctx.fillRect(13, 12, 2, 1)

  return canvas
}

/** 把 canvas 上的一块切出来当纹理 */
function cropTexture(source, rect, flipY) {
  const canvas = document.createElement('canvas')
  canvas.width = rect[2]
  canvas.height = rect[3]
  const ctx = canvas.getContext('2d')
  ctx.drawImage(source, rect[0], rect[1], rect[2], rect[3], 0, 0, rect[2], rect[3])

  const texture = new THREE.CanvasTexture(canvas)
  // 像素风：放大用最近邻（一格一格清清楚楚），也不生成 mipmap（那玩意会让远处发糊）
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.anisotropy = 1
  texture.flipY = flipY
  texture.needsUpdate = true
  return texture
}

/**
 * 按皮肤图做一个方块人。
 *
 * 每个部位做两个盒子：本体 + 一层"外套"（帽子/袖子/裤腿，皮肤图右半边那圈）。
 * 外套用透明材质，没画到的地方就是透明的——这样披风、帽子这些才有层次。
 *
 * 【每个部位外面套一个空组（Group），组的位置 = 转轴】
 * 盒子放在组里、相对组往下挪 h/2（再按 boxTop 修正）。这样转的是**组**，
 * 手脚就绕肩膀/胯转；直接转盒子的话会绕盒子自己的中心转，走路像螺旋桨。
 */
function buildPlayer(skinCanvas) {
  const group = new THREE.Group()
  // 一张皮肤图只需要一份贴图，所有部位共用（UV 决定各自采哪一块）
  const texture = cropTexture(skinCanvas, [0, 0, 64, 64], true)

  for (const part of PARTS) {
    // 转轴
    const joint = new THREE.Group()
    joint.position.set(part.pivot[0], part.pivot[1], part.pivot[2])
    // 方块中心相对转轴的偏移：方块顶在 boxTop 处，往下半个身高就是中心
    const centerY = part.boxTop - part.h / 2

    const geo = new THREE.BoxGeometry(part.w, part.h, part.d)
    // 【注意】UV 要写在**这个真正拿去渲染的几何体**上。
    // 我第一版把 UV 算在一个临时几何体上，算完就 dispose 了——
    // 白算一场，贴图全是错的（这种错不报错，只是"看着不对"）。
    applyFaceUVs(geo, part, false)
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: texture }))
    mesh.position.set(0, centerY, 0)
    joint.add(mesh)

    // 外套：稍微大一圈，用同一套 UV
    const overGeo = new THREE.BoxGeometry(part.w + 0.5, part.h + 0.5, part.d + 0.5)
    applyFaceUVs(overGeo, part, true)
    const overMesh = new THREE.Mesh(overGeo, new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.1
    }))
    overMesh.position.set(0, centerY, 0)
    joint.add(overMesh)

    group.add(joint)
    part.joint = joint
    part.texture = texture
  }

  return group
}

/**
 * 把六个面各自的 UV 写进几何体。
 *
 * Three.js 的 BoxGeometry 每个面 4 个顶点，顺序是：左上、右上、左下、右下。
 * 我们按"皮肤上那一块"算出 0~1 的坐标填进去，每个面就只采它自己那一块了。
 */
function applyFaceUVs(geometry, part, overlay) {
  const [bx, by] = overlay ? part.overlayAt : part.at
  const rects = faceRects(part.w, part.h, part.d)
  const uv = geometry.attributes.uv
  const order = ['px', 'nx', 'py', 'ny', 'pz', 'nz']

  order.forEach((key, faceIndex) => {
    const rect = rects[key]
    const u0 = (bx + rect[0]) / 64
    const u1 = (bx + rect[0] + rect[2]) / 64
    // 纹理是 flipY 的（贴图上下是反的），所以 v 要从下往上算
    const v0 = 1 - (by + rect[1]) / 64
    const v1 = 1 - (by + rect[1] + rect[3]) / 64

    const base = faceIndex * 4
    uv.setXY(base + 0, u0, v0)
    uv.setXY(base + 1, u1, v0)
    uv.setXY(base + 2, u0, v1)
    uv.setXY(base + 3, u1, v1)
  })
  uv.needsUpdate = true
  return geometry
}

// ——————————————————————————————————————————————
// 对外的接口
// ——————————————————————————————————————————————

let renderer = null
let scene = null
let camera = null
let player = null
let skinCanvas = makeDefaultSkin()
let targetSpin = 0
let spin = 0
/** 3D 挂上了没有 */
let mounted = false
let walkPhase = 0
let raf = null

function resize() {
  if (!renderer) return
  const box = renderer.domElement.parentElement
  const w = box.clientWidth
  const h = box.clientHeight
  if (w === 0 || h === 0) return
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

function rebuild() {
  if (!scene) return
  if (player) {
    scene.remove(player)
    // 换皮肤会重做一遍模型，旧的得收掉，不然显存越用越多
    player.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose()
      if (obj.material) obj.material.dispose()
    })
    const oldTexture = PARTS[0].texture
    if (oldTexture) oldTexture.dispose()
  }
  player = buildPlayer(skinCanvas)
  scene.add(player)
}

function animate() {
  raf = requestAnimationFrame(animate)
  if (!renderer) return

  walkPhase += 0.045
  const swing = Math.sin(walkPhase) * 0.5

  // 走路动画：手脚前后摆（转轴在肩膀/胯，见 buildPlayer），身体轻轻上下
  // 右臂和左腿同相、左臂和右腿同相 —— 这就是人走路的样子
  for (const part of PARTS) {
    if (!part.joint) continue
    const isLimb = part.name.startsWith('arm') || part.name.startsWith('leg')
    const amount = part.name === 'armR' || part.name === 'legL' ? swing : -swing
    part.joint.rotation.x = isLimb ? amount : 0
  }
  if (player) {
    player.position.y = Math.sin(walkPhase * 2) * 0.12
    // 平滑地追向鼠标指的角度（0.12 越小越"慢半拍"，看着越自然）
    spin += (targetSpin - spin) * 0.12
    player.rotation.y = spin
  }

  renderer.render(scene, camera)
}

/** 起一个 3D 预览，塞进指定的容器元素里 */
function mount(container) {
  if (renderer) return
  mounted = true

  scene = new THREE.Scene()
  // 【相机距离是算出来的，别乱改】小人总高 32 个单位，竖直视角 40° 时
  // 距离 52 能看到约 38 个单位（刚好占满还有一点边距）。
  // 踩过两次：太远 → 小人小小的发虚；太近 → 头都出画了。
  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  // 相机在斜前方，稍微高一点——和 KAMUCL 那个视角差不多
  camera.position.set(0, 22, 52)
  camera.lookAt(0, 16, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.cursor = 'grab'
  container.appendChild(renderer.domElement)

  rebuild()
  resize()
  window.addEventListener('resize', resize)

  // 鼠标一动，小人就跟着转（不用按着拖）
  //
  // 【为什么监听整个窗口，而不是只监听卡片】用户要的是"鼠标出了卡片也继续跟着"——
  // 只挂在卡片上的话，鼠标一出去就不转了，手感很别扭。
  // 现在整个窗口都在听，卡片只是当"刻度尺"用：
  //   鼠标在卡片正中 = 朝前；往右挪 = 往右转；挪到卡片外面 = 继续往右转（有上限）。
  //
  // 【为什么用"追"而不是直接设】直接设的话鼠标一动小人"啪"地跳过去，很生硬；
  // 让它每一帧往目标角度靠一点（见 animate 里的 lerp），看着像真的在转。
  renderer.domElement.style.cursor = 'default'

  // 按光标的**屏幕坐标**算该转到哪（窗口内、窗口外一视同仁）
  const aimAtScreenX = (screenX) => {
    if (!renderer) return
    const rect = renderer.domElement.getBoundingClientRect()
    // 卡片在屏幕上的左边缘 = 窗口左上角 + 卡片在窗口里的位置
    const cardScreenLeft = window.screenX + rect.left
    // 不夹在 0~1：允许超出卡片，所以鼠标走到窗口外还能继续转
    // （上限收到 ±0.3 个卡片宽：再往外也不多转，免得转成"侧面对着人"看不出是谁）
    const ratio = Math.min(1.3, Math.max(-0.3, (screenX - cardScreenLeft) / rect.width))
    targetSpin = (ratio - 0.5) * 1.6 // 两侧最多约 ±73 度
  }

  // ① 鼠标在窗口里：直接听（反应最快）
  window.addEventListener('pointermove', (event) => aimAtScreenX(window.screenX + event.clientX))

  // ② 鼠标跑出窗口了：界面就看不见它了，得让主进程去问系统"光标在哪"（见 main.js 的 cursor:watch）
  if (window.api && window.api.watchCursor) {
    window.api.onCursorMove((point) => aimAtScreenX(point.x))
    window.api.watchCursor(true)
  }

  animate()
}

/** 换一张皮肤（传一个能画到 canvas 上的图：Image / Canvas） */
function setSkin(source) {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(source, 0, 0)
  skinCanvas = canvas
  rebuild()
}

/** 用我们自带的默认皮肤 */
function useDefaultSkin() {
  skinCanvas = makeDefaultSkin()
  rebuild()
}

/** 停掉（切页面时省点电） */
function unmount() {
  if (window.api && window.api.watchCursor) window.api.watchCursor(false)
  if (raf) cancelAnimationFrame(raf)
  raf = null
  renderer = null
  scene = null
  camera = null
  player = null
  mounted = false
}


window.skinViewer = { mount, setSkin, useDefaultSkin, unmount, makeDefaultSkin }

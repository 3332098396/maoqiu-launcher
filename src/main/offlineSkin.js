// 毛球 — 离线皮肤「进游戏」（M25）
//
// 【要解决什么】离线账号进游戏，永远是那张 Steve/Alex。哪怕在皮肤页挑了半天、
// 3D 小人也换了，游戏里还是默认小人 —— 因为游戏压根不知道去哪儿取你那张皮肤。
//
// 【怎么做的】照 KAMUCL 那套（`offlineSkinLaunch.ts`，MIT，见 THIRD_PARTY_NOTICES.md）：
//   ① 启动时多挂一个 Java 小代理（`-javaagent:maoqiu-offline-skin.jar=…`），
//      它在**游戏自己的进程里**开一个只监听 127.0.0.1 的小 HTTP 服务；
//   ② 再用 authlib-injector（外置登录那套，毛球本来就有）把游戏里"去哪儿验证身份、
//      去哪儿取皮肤"的地址指到这个本地小服务上。
//   游戏于是把用户当成某个皮肤站上的玩家，皮肤就穿上了。
//
// 【为什么小代理必须跑在游戏进程里，而不是跑在毛球里】
//   毛球关掉了，游戏还在跑。服务跟着毛球一起死的话，进游戏就没皮肤了。
//   KAMUCL 也是这么处理的（它的 README 写明"关掉启动器不会关掉游戏里的皮肤服务"）。
//
// 【几条安全设定，改之前先读】
//   · 只监听 `127.0.0.1`，端口随机、路径里带 64 位随机串（别人猜不到）
//   · 每次启动临时生成一对 RSA 密钥，签名只对这一次启动有效
//   · 那份临时配置（里面有私钥）**先写临时文件再改名**，代理读完自己删掉
//   · 它**不认任何联网服务器的登录**：`join` 一律回 403 —— 离线就是离线，
//     穿上皮肤不代表能进正版服务器
//
// 【和 VoxLink 那条线的规矩一样】这份文件是从 KAMUCL 逐语句译过来的，
// 数值和分支不许自作主张改。

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { nativeImage } = require('electron')

const paths = require('./paths')
const settings = require('./settings')
const skins = require('./skins')
const authlibUtil = require('./authlib')

/** 小代理放在这儿（跟图标一样打进安装包；`.jar` 不能待在 asar 里，java 读不了） */
const AGENT_JAR = ['assets', 'offline-skin', 'maoqiu-offline-skin.jar']

/**
 * 界面报上来的"现在预览里穿的是哪张"。
 *
 * 【为什么要在内存里记这个】配置里只存了"用户自己定下来的那张"（`look.skin`）；
 * 而"没登录时每次开软件随机穿一张"（M21）是**界面那边现挑的**，主进程不知道。
 * 不记的话会出现"预览里是 A、游戏里是 B"。界面每次换完皮肤都会报过来。
 */
let current = null

/** 界面上那张皮肤的绝对路径（随机挑中的也算） */
function report(choice) {
  if (choice && (choice.official === 'steve' || choice.official === 'alex')) {
    current = { official: choice.official }
  } else if (choice && typeof choice.path === 'string' && choice.path) {
    current = { path: choice.path }
  } else {
    current = null
  }
  return { ok: true }
}

/** 小代理 jar 的完整路径（打包后要指向 app.asar.unpacked，见 package.json） */
function agentPath() {
  return path.join(__dirname, '..', '..', ...AGENT_JAR).replace('app.asar', 'app.asar.unpacked')
}

/** 每次启动写一份临时配置的地方（读完就删） */
function sessionDir() {
  return path.join(paths.configDir(), 'offline-skin')
}

/**
 * 把"现在用哪张"翻译成一段 PNG 字节 + 模型。
 *
 * 【为什么模型（粗/细胳膊）要单独说】皮肤图上**看不出来**是 Steve 那种粗胳膊还是
 * Alex 那种细胳膊——两种都是 64×64，差别只在游戏怎么解释它。
 * 官方那两张我们自己知道（steve = 粗、alex = 细）；用户自己传的按设置里选的那个来。
 *
 * @returns {{buffer: Buffer, variant: 'classic'|'slim'}|null}
 */
function resolveSnapshot(dir) {
  if (!current) return null

  if (current.official) {
    const found = skins.officialSkinBuffer(dir, current.official)
    if (!found) return null
    return { buffer: found.buffer, variant: current.official === 'alex' ? 'slim' : 'classic' }
  }

  let buffer
  try {
    buffer = fs.readFileSync(current.path)
  } catch {
    return null // 那张图被删了/挪走了
  }
  const look = settings.readConfig().look || {}
  return { buffer, variant: look.skinVariant === 'slim' ? 'slim' : 'classic' }
}

/** 像一个皮肤 PNG 吗（尺寸另外判） */
function isSkinPng(buffer) {
  return (
    buffer.length >= 24 &&
    buffer.length <= 1024 * 1024 &&
    buffer.readUInt32BE(0) === 0x89504e47 &&
    buffer.readUInt32BE(16) === 64 &&
    (buffer.readUInt32BE(20) === 64 || buffer.readUInt32BE(20) === 32)
  )
}

/**
 * 老式皮肤（64×32）补成 64×64。
 *
 * 【为什么要补】现在游戏用的皮肤是 64×64 的版式；老式的 64×32 只画了上半格。
 * 官方自己的做法就是"原样贴到左上角、其余留透明"——补完看起来**一模一样**，
 * 不是拉伸。（拉伸是错的：那样整张脸都会变形。）
 *
 * 【为什么不用 canvas 画】主进程里没有 canvas。Electron 自带的 nativeImage
 * 能解 PNG、能拿原始像素、也能再编回 PNG，够用了，不用为这个引第三方库。
 *
 * @returns {Buffer|null} 补好的 PNG（不是老式的就返回 null）
 */
function padLegacySkin(buffer) {
  try {
    const image = nativeImage.createFromBuffer(buffer)
    const size = image.getSize()
    if (size.width !== 64 || size.height !== 32) return null

    const source = image.toBitmap() // BGRA，每行 64×4 字节
    const out = Buffer.alloc(64 * 64 * 4)
    for (let y = 0; y < 32; y++) {
      source.copy(out, y * 256, y * 256, (y + 1) * 256)
    }
    return nativeImage.createFromBuffer(out, { width: 64, height: 64 }).toPNG()
  } catch {
    return null
  }
}

/**
 * 准备这次启动要用的"本地皮肤服务"。
 *
 * @param {object} account 账号（只有 type === 'offline' 才做这件事）
 * @param {string} dir 这次启动的游戏目录
 * @param {(text: string) => void} [onStage] 往启动日志里写一行
 * @returns {Promise<{args: string[], releasePort: () => Promise<void>, dispose: () => Promise<void>}|null>}
 */
async function prepare(account, dir, onStage) {
  const say = typeof onStage === 'function' ? onStage : () => {}
  if (!account || account.type !== 'offline') return null

  const look = settings.readConfig().look || {}
  if (look.offlineSkinInGame === false) return null

  const snapshot = resolveSnapshot(dir)
  if (!snapshot) return null

  if (!isSkinPng(snapshot.buffer)) {
    // 不是 64×64 也不是 64×32 的，当它不是皮肤（比如用户把别的图塞进皮肤库了）
    return null
  }

  const agent = agentPath()
  if (!fs.existsSync(agent)) {
    say(`[启动器] 离线皮肤组件不在（${agent}），这次先不穿皮肤`)
    return null
  }

  // 账号身份（代理要拿它去回答游戏"你是谁"）
  const uuid = String(account.uuid || '').replace(/-/g, '').toLowerCase()
  const username = String(account.name || '')
  if (!/^[a-f\d]{32}$/.test(uuid)) return null
  if (!username || username.length > 64 || /[\u0000-\u001f\u007f]/.test(username)) return null

  let buffer = snapshot.buffer
  // 老式的 64×32 先补成 64×64（那个 Java 小代理只收 64×64）
  if (buffer.readUInt32BE(20) === 32) {
    const padded = padLegacySkin(buffer)
    if (!padded) {
      say('[启动器] 这张皮肤是老式的 64×32，补不成 64×64，这次先不穿它')
      return null
    }
    buffer = padded
    say('[启动器] 这张是老式的 64×32 皮肤，已按官方做法补成 64×64')
  }
  const hash = crypto.createHash('sha256').update(buffer).digest('hex')

  say('[启动器] 正在准备离线皮肤组件…')
  let injector
  try {
    const wrapped = await authlibUtil.ensure({ onStage: (text) => say(`[启动器] ${text}`) })
    injector = wrapped.path
  } catch (error) {
    // 【这一步失败不拦着启动】皮肤挂不上顶多是小人还是默认那张，游戏照常能玩。
    say(`[启动器] 离线皮肤组件没准备好（${error.message}），这次先不穿皮肤`)
    return null
  }

  // 【先生成密钥再去占端口】密钥生成失败时不该留下一个"占着不放"的端口
  const keys = await new Promise((resolve, reject) => {
    crypto.generateKeyPair(
      'rsa',
      {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' }
      },
      (error, publicKey, privateKey) => (error ? reject(error) : resolve({ publicKey, privateKey }))
    )
  })

  const nonce = crypto.randomBytes(32).toString('hex')
  const directory = sessionDir()
  const config = path.join(directory, `${crypto.randomUUID()}.properties`)
  const temp = config + '.tmp'

  // 这个 socket **只用来占一个空闲端口**，不接任何连接
  //（接了会让 server.close() 挂住，见 KAMUCL 的注释）
  const reservation = net.createServer((socket) => socket.destroy())

  // 离线服务器认的是"Java 标准的名字 UUID"；毛球算出来的就是它，
  // 但两条路都留一份（见 KAMUCL 源码里的这段说明）
  const serverUuid = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest()
  serverUuid[6] = (serverUuid[6] & 0x0f) | 0x30
  serverUuid[8] = (serverUuid[8] & 0x3f) | 0x80

  let released = false
  const releasePort = async () => {
    if (released) return
    released = true
    if (!reservation.listening) return
    await new Promise((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())))
  }

  const dispose = async () => {
    const failures = []
    try {
      await releasePort()
    } catch (error) {
      failures.push(error)
    }
    for (const file of [config, temp]) {
      try {
        fs.unlinkSync(file)
      } catch (error) {
        if (error && error.code !== 'ENOENT') failures.push(error)
      }
    }
    if (failures.length) throw new Error('离线皮肤临时文件没清干净')
  }

  try {
    await new Promise((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', () => {
        reservation.removeListener('error', reject)
        resolve()
      })
    })
    reservation.unref()

    const port = reservation.address().port
    const root = `http://127.0.0.1:${port}/${nonce}/`
    const metadata = JSON.stringify({
      meta: {
        serverName: '毛球离线外观',
        'feature.no_mojang_namespace': true,
        'feature.username_check': true
      },
      skinDomains: ['127.0.0.1'],
      signaturePublickey: `-----BEGIN PUBLIC KEY-----\n${keys.publicKey.toString('base64')}\n-----END PUBLIC KEY-----`
    })

    const values = {
      port: String(port),
      nonce,
      uuid,
      serverUuid: serverUuid.toString('hex'),
      username64: Buffer.from(username, 'utf8').toString('base64'),
      sha256: hash,
      variant: snapshot.variant,
      png: buffer.toString('base64'),
      privateKey: keys.privateKey.toString('base64'),
      publicKey: keys.publicKey.toString('base64')
    }

    fs.mkdirSync(directory, { recursive: true })
    // 先写临时文件再改名（断电不会留下半份配置），权限只给自己
    fs.writeFileSync(temp, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', {
      mode: 0o600,
      flag: 'wx'
    })
    fs.renameSync(temp, config)

    const configArg = Buffer.from(config, 'utf8').toString('base64url')
    return {
      args: [
        `-javaagent:${agent}=${configArg}`,
        `-javaagent:${injector}=${root}`,
        `-Dauthlibinjector.yggdrasil.prefetched=${Buffer.from(metadata, 'utf8').toString('base64')}`,
        '-Dauthlibinjector.noShowServerName',
        '-Dauthlibinjector.mojangNamespace=disabled',
        // 毛球自己加的：别往用户的游戏目录里丢 authlib-injector.log（跟外置登录那条同一个理由）
        '-Dauthlibinjector.noLogFile'
      ],
      releasePort,
      dispose
    }
  } catch (error) {
    await dispose()
    say(`[启动器] 离线皮肤没准备好（${error.message}），这次先不穿皮肤`)
    return null
  }
}

module.exports = { report, prepare, agentPath }

// 毛球 — 正版登录（微软账号）
//
// 【这条路要经过四道关卡，少一道都进不去】
//   ① 微软账号登录          → 换到"微软令牌"
//   ② 微软令牌 → Xbox Live 令牌
//   ③ Xbox 令牌 → XSTS 令牌（这一步会告诉你能不能玩、账号有没有问题）
//   ④ XSTS 令牌 → 游戏令牌（**Mojang 在这儿检查"你这个应用登记过没有"**）
//
// 【为什么要自己弹一个窗口让用户登录】
// 微软不允许我们碰用户的密码——密码只输在**微软自己的页面上**，
// 我们只接住它跳回来时带的那一串"临时码"。这样即使毛球被拆开看，
// 也拿不到用户的账号密码。
//
// 【客户端 ID 为什么不内置】
//   · 微软的应用条款要求每个启动器用**自己注册的** ID
//   · 更要紧的是对用户不安全：ID 是别人的，人家哪天改了或者停了，
//     用户会毫无预兆地登不上，还查不出原因（因为不归他管）
// 所以 ID 存在设置里、由用户自己填。步骤见 docs/09。
//
// 【为什么最后一步会被挡】
// 就算前面全走通，Mojang 还要**人工审核**这个应用才放行，
// 不批就回 `403 Invalid app registration`。**这不是代码能解决的**，
// 所以那句报错必须翻成人话讲清楚，别让用户以为软件坏了。见 docs/09 第二部分。

const crypto = require('node:crypto')
const { BrowserWindow } = require('electron')
const { post, postJson, postForm, putJson, del, fetchJson, HttpError } = require('./http')

/**
 * 微软登录的"入口"有两个，**必须和应用的配置对上**，对不上会被当场拒。
 * （2026-10-08 用户实际踩到的：应用配成"仅个人账户"，代码用 `/common/`，
 * 微软回一句 `The request is not valid for the application's 'userAudience' configuration`。）
 *
 *   consumers → 应用配成「仅个人 Microsoft 帐户」（我们让用户选的那种）
 *   common    → 应用配成「任何组织目录 + 个人帐户」（也就是 'All'）
 *
 * 所以下面**两个都准备着**，哪个被拒就换另一个重试（见 loginEdge）。
 */
const AUTHORITY = 'https://login.microsoftonline.com'
const TENANTS = { personal: 'consumers', any: 'common' }

/** 这是**注册在 Azure 上的那一串**，必须一字不差地原样发回去，别跟着 tenant 变 */
const REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient'

/** 要的权限：登录 Xbox Live + 允许我们之后不弹窗就续期（offline_access） */
const SCOPE = 'XboxLive.signin offline_access'

const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

const LOGIN_TIMEOUT = 30000

/** 登录窗口最多等多久（用户一直不操作就自己关掉，别挂在那儿） */
const WINDOW_TIMEOUT = 5 * 60 * 1000

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 生成 PKCE 用的两个值。
 *
 * 【为什么要这个】我们这种"公共客户端"没法藏住密钥，
 * 万一有人在半路截走了那串临时码就能冒充你。
 * 做法是：登录时先递一个"谜面"（challenge）过去，换令牌时再递"谜底"（verifier）——
 * 截走码的人不知道谜底，换不出令牌。
 */
function makePkce() {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** 标准 UUID 格式（8-4-4-4-12），游戏档案给的是不带横杠的 */
function dashedUuid(raw) {
  const hex = String(raw ?? '').replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return ''
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

// ——————————————————————————————————————————————
// 报错翻译成人话
// ——————————————————————————————————————————————

/**
 * XSTS 那一步的报错码 → 人话。
 * 【为什么必须查表】微软回的是 `2148916233` 这种数字，直接甩给用户等于没说，
 * 而且每一种的处理办法完全不同（有的要建 Xbox 档案，有的要家长操作）。
 */
const XSTS_ERRORS = {
  2148916227: '这个账号被 Xbox Live 封了',
  2148916233: '这个微软账号还没有 Xbox 档案。先用同一个账号登录 xbox.com 建一个，再回来',
  2148916235: '你所在的地区用不了 Xbox Live（可能是网络或地区限制）',
  2148916236: '这个账号需要先做成年人验证（韩国地区的要求）',
  2148916237: '这个账号需要先做成年人验证（韩国地区的要求）',
  2148916238: '这是未成年账号，需要家长把它加进微软家庭组里才能用'
}

function microsoftErrorText(error) {
  if (!(error instanceof HttpError)) {
    // 网络层面的
    const text = String(error.message || '')
    if (/ENOTFOUND|EAI_AGAIN/.test(text)) return '连不上微软服务器（域名解析不了，检查一下网络）'
    if (/ETIMEDOUT|超时/.test(text)) return '连不上微软服务器（超时了），过一会儿再试'
    if (/CERT|certificate/i.test(text)) return '微软服务器的证书有问题，可能是网络被中间人拦了'
    return `连不上微软服务器：${text}`
  }

  const body = error.body || {}
  const code = body.error || ''

  // —— 换令牌那一步：多半是客户端 ID 或那个勾没弄对 ——
  if (body.error === 'invalid_grant' || body.error === 'unauthorized_client') {
    return '微软不认这个客户端 ID。检查两处：① ID 是不是填错了 ② 注册应用时那个「允许公共客户端流」有没有勾上（见 docs/09）'
  }
  if (body.error === 'invalid_request' && /redirect/i.test(body.error_description || '')) {
    return '重定向地址对不上。注册应用时那串地址要和毛球里用的一字不差（见 docs/09 第 2 步）'
  }
  if (typeof code === 'string' && code.startsWith('AADSTS')) {
    return `微软拒绝了这次登录（${code}）${body.error_description ? `：${body.error_description}` : ''}`
  }

  // —— 换游戏令牌那一步：就是那道审批 ——
  if (error.statusCode === 403) {
    return '微软那边一路都通过了，但 Mojang 说「这个应用没登记过」。这不是坏了，是那份申请表还没批下来（见 docs/09 第二部分）。批准之后同一份代码直接就能用'
  }
  if (error.statusCode === 401) {
    return '登录信息过期或无效，请重新登录一次'
  }
  if (error.statusCode === 404) {
    return '这个微软账号名下没有 Minecraft Java 版（没买过，或者买在别的账号上）'
  }

  const detail = body.errorMessage || body.error_description || body.error || ''
  return `微软那边返回了 ${error.statusCode}${detail ? `：${detail}` : ''}`
}

// ——————————————————————————————————————————————
// 四道关卡
// ——————————————————————————————————————————————

/** ② 微软令牌 → Xbox Live 令牌 */
async function xboxLive(msAccessToken) {
  const data = await postJson(
    XBL_URL,
    {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        // 这个 d= 前缀是协议规定的写法，不是笔误
        RpsTicket: `d=${msAccessToken}`
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    },
    { timeout: LOGIN_TIMEOUT }
  )

  return { token: data.Token, uhs: data.DisplayClaims?.xui?.[0]?.uhs }
}

/** ③ Xbox 令牌 → XSTS 令牌 */
async function xsts(xblToken) {
  const data = await postJson(
    XSTS_URL,
    {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      // 这个 RelyingParty 必须是游戏接口的地址，写错了拿不到能用的令牌
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    },
    { timeout: LOGIN_TIMEOUT }
  )

  return {
    token: data.Token,
    uhs: data.DisplayClaims?.xui?.[0]?.uhs,
    // xuid 是"Xbox 用户编号"，游戏启动参数里有一项要它。
    // 缺了也不影响进服务器，但官方启动器会给，我们也顺手带上
    xuid: data.DisplayClaims?.xui?.[0]?.xid
  }
}

/** ④ XSTS 令牌 → 游戏令牌 */
async function minecraftToken(uhs, xstsToken) {
  const data = await postJson(
    MC_LOGIN_URL,
    { identityToken: `XBL3.0 x=${uhs};${xstsToken}` },
    { timeout: LOGIN_TIMEOUT }
  )

  return {
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in) || 86400
  }
}

/** 问一句"我是谁"——顺便验证这个账号到底有没有 Java 版 */
async function minecraftProfile(mcAccessToken) {
  const data = await fetchJson(MC_PROFILE_URL, {
    timeout: LOGIN_TIMEOUT,
    headers: { Authorization: `Bearer ${mcAccessToken}` }
  })

  if (!data?.name) {
    throw new Error('游戏档案里没有角色名，这个账号可能没有 Java 版')
  }
  return { id: dashedUuid(data.id), name: data.name, skins: data.skins || [] }
}

/**
 * 把"微软令牌"一路换成"能用的账号"。
 * ②③④ 这三步是固定的，登录和续期都要走一遍，所以抽出来。
 */
async function finishChain(msAccessToken, base) {
  const live = await xboxLive(msAccessToken)
  if (!live.token || !live.uhs) throw new Error('Xbox 那一步没换到令牌，稍后再试')

  const xstsResult = await xsts(live.token)
  if (!xstsResult.token) throw new Error('Xbox 那边没给通行证，稍后再试')

  const mc = await minecraftToken(xstsResult.uhs, xstsResult.token)
  const profile = await minecraftProfile(mc.accessToken)

  return {
    type: 'microsoft',
    name: profile.name,
    uuid: profile.id,
    mcAccessToken: mc.accessToken,
    mcExpiresAt: Date.now() + (mc.expiresIn - 300) * 1000,
    xuid: xstsResult.xid || '',
    savedAt: Date.now(),
    ...base
  }
}

// ——————————————————————————————————————————————
// 弹窗登录
// ——————————————————————————————————————————————

/**
 * 弹出微软自己的登录页，等它跳回来，把地址里那串临时码接住。
 *
 * 【为什么要在新窗口里开】密码要在**微软自己的域名**下输入，毛球一行密码都不碰。
 * 【为什么用单独的会话（partition）】这样它不会用到毛球别处存的 cookie，
 * 也不会把微软的登录状态留在毛球的常规会话里；而且每次都是干净的开始。
 */
function askForCode(clientId, tenant, parentWindow) {
  const { verifier, challenge } = makePkce()

  const url = new URL(`${AUTHORITY}/${tenant}/oauth2/v2.0/authorize`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('response_mode', 'query')
  // 每次都让用户挑一次账号——不然想换账号就没法换了
  url.searchParams.set('prompt', 'select_account')
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parentWindow || undefined,
      modal: false,
      autoHideMenuBar: true,
      title: '登录微软账号',
      webPreferences: {
        // 不带 persist: 前缀 = 用完就散的会话，不在本机留登录痕迹
        partition: 'maoqiu-mslogin',
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (!win.isDestroyed()) win.destroy()
      } catch {
        // 窗口已经没了就算了
      }
      resolve({ ...result, verifier })
    }

    // 用户一直不动的话别让窗口挂一晚上
    const timer = setTimeout(() => {
      finish({ ok: false, error: '等太久了，登录窗口自动关掉了。想登再点一次' })
    }, WINDOW_TIMEOUT)

    // 【为什么要两种事件都听】跳回来这一下是"重定向"，
    // 不同版本的 Electron 触发的时机不完全一样，两个都听最保险。
    const inspect = (...args) => {
      // 新版 Electron 把参数包在一个对象里，老版是 (event, url, ...)，两种都认
      const first = args[0]
      const raw = typeof args[1] === 'string' ? args[1] : first?.url
      if (!raw || !raw.startsWith(REDIRECT_URI)) return false

      const back = new URL(raw)
      const code = back.searchParams.get('code')
      const denied = back.searchParams.get('error')
      const description = back.searchParams.get('error_description') || ''

      if (code) {
        finish({ ok: true, code })
      } else if (denied === 'access_denied') {
        finish({ ok: false, error: '你取消了登录', cancelled: true })
      } else if (/userAudience/i.test(description)) {
        // 应用的"账户类型"设置和我们用的入口对不上。这不是用户的错，
        // 上面的 login() 会自动换另一个入口再试一次，所以这儿只标记一下
        finish({ ok: false, audienceMismatch: true, error: description })
      } else {
        finish({ ok: false, error: `微软那边说了句：${description || denied || '没给出原因'}` })
      }
      return true
    }

    win.webContents.on('will-redirect', (event, ...rest) => {
      if (inspect(event, ...rest)) event.preventDefault()
    })
    win.webContents.on('will-navigate', (event, ...rest) => {
      if (inspect(event, ...rest)) event.preventDefault()
    })

    win.on('closed', () => finish({ ok: false, error: '登录窗口被关掉了', cancelled: true }))

    win.loadURL(url.toString()).catch((error) => {
      finish({ ok: false, error: `登录页打不开：${error.message}` })
    })
  })
}

/**
 * 登录。
 * @param {{clientId: string, parentWindow?: object}} options
 * @returns {Promise<{ok: boolean, account?: object, error?: string, cancelled?: boolean}>}
 */
async function login(options = {}) {
  const clientId = String(options.clientId ?? '').trim()
  if (!clientId) {
    return {
      ok: false,
      error: '还没填客户端 ID。到「设置」页找「正版登录」，按 docs/09 的步骤注册一个填进去'
    }
  }

  // 先按"我自己注册时选的是仅个人账户"来试（docs/09 让用户选的就是这个）
  let tenant = TENANTS.personal
  let asked = await askForCode(clientId, tenant, options.parentWindow)

  // 应用的账户类型和我们用的入口对不上 → 换另一个入口再试一次。
  // 【为什么要自动重试】这一步完全不该让用户操心：他选"仅个人账户"还是"所有账户"
  // 都是合理的，错的是我们只认一种。实测踩到过（2026-10-08）
  if (!asked.ok && asked.audienceMismatch) {
    tenant = TENANTS.any
    asked = await askForCode(clientId, tenant, options.parentWindow)
  }
  if (!asked.ok) return asked

  const tokenEndpoint = `${AUTHORITY}/${tenant}/oauth2/v2.0/token`

  let tokens
  try {
    tokens = await postForm(
      tokenEndpoint,
      {
        client_id: clientId,
        grant_type: 'authorization_code',
        code: asked.code,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        code_verifier: asked.verifier
      },
      { timeout: LOGIN_TIMEOUT }
    )
  } catch (error) {
    return { ok: false, error: microsoftErrorText(error) }
  }

  if (!tokens?.access_token) {
    return { ok: false, error: '微软没给令牌，可能是刚才那一下过期了，再点一次登录' }
  }

  try {
    const account = await finishChain(tokens.access_token, {
      msRefreshToken: tokens.refresh_token || '',
      clientId,
      // 记下这次是从哪个入口进的——续期的时候要用同一个，不然又会撞上那个配置不匹配
      tenant
    })
    return { ok: true, account }
  } catch (error) {
    return { ok: false, error: xstsOrMojangText(error) }
  }
}

/** ②③④ 这几步的报错单独翻译（要认 XSTS 的数字码） */
function xstsOrMojangText(error) {
  if (error instanceof HttpError) {
    const xerr = error.body?.XErr
    if (xerr && XSTS_ERRORS[xerr]) return XSTS_ERRORS[xerr]
    if (xerr) return `Xbox 那边出了个问题（代码 ${xerr}），可以截图发给我`
    return microsoftErrorText(error)
  }
  return error.message
}

/**
 * 续期：用存下来的 refresh_token 换新的令牌。
 * 【为什么不让用户天天重新登】游戏令牌只有一天有效期，
 * 但 refresh_token 能长期用——把所有关卡重走一遍就行，不用再弹窗。
 */
async function refresh(account) {
  if (!account?.msRefreshToken || !account?.clientId) {
    return { ok: false, error: '这个账号缺续期用的信息，得重新登录一次' }
  }

  // 用登录时记下的那个入口；老账号没记过就按"仅个人账户"来
  const tokenEndpoint = `${AUTHORITY}/${account.tenant || TENANTS.personal}/oauth2/v2.0/token`

  let tokens
  try {
    tokens = await postForm(
      tokenEndpoint,
      {
        client_id: account.clientId,
        grant_type: 'refresh_token',
        refresh_token: account.msRefreshToken,
        scope: SCOPE
      },
      { timeout: LOGIN_TIMEOUT }
    )
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 400) {
      // refresh_token 失效了（改过密码、被吊销、太久没用）——只能重新登
      return { ok: false, error: '登录状态过期了，需要重新登录一次', needLogin: true }
    }
    return { ok: false, error: microsoftErrorText(error) }
  }

  try {
    const next = await finishChain(tokens.access_token, {
      msRefreshToken: tokens.refresh_token || account.msRefreshToken,
      clientId: account.clientId
    })
    return { ok: true, account: next }
  } catch (error) {
    return { ok: false, error: xstsOrMojangText(error) }
  }
}

/**
 * 这个正版账号现在用的皮肤，地址是多少。
 * 【为什么每次现问】用户可能刚在官网换了皮肤——存下来的旧地址就不对了。
 * 反正只是一次很小的请求。
 *
 * @returns {Promise<string>} 没设皮肤就返回空字符串
 */
async function skinUrl(account) {
  if (!account?.mcAccessToken) return ''

  const data = await fetchJson(MC_PROFILE_URL, {
    timeout: 15000,
    headers: { Authorization: `Bearer ${account.mcAccessToken}` }
  })

  const skins = data.skins || []
  // 皮肤可以有好几张，只有 ACTIVE 那张是"正在用的"
  const active = skins.find((one) => one.state === 'ACTIVE') || skins[0]
  return active?.url || ''
}

// ——————————————————————————————————————————————
// 换皮肤 / 换披风（M23）
// ——————————————————————————————————————————————
//
// 【这一段现在能不能用】**暂时不能，卡在 Mojang 审批上**（见 docs/09）。
// 正版登录本身要 Mojang 人工批准了才拿得到令牌，拿不到令牌就调不了下面这几个接口。
// 代码是按官方接口文档写好的，批下来就能用；在那之前界面上会明说用不了。
//
// 【为什么不内置一个 client ID 把它"跑起来"】那是拿别人的应用身份冒充用户，
// 等于把账号密码印在传单上发——红线，不碰。

/** 换皮肤用的接口 */
const MC_SKIN_URL = 'https://api.minecraftservices.com/minecraft/profile/skins'
/** 换披风用的接口 */
const MC_CAPE_URL = 'https://api.minecraftservices.com/minecraft/profile/capes/active'

/**
 * 拼一个 multipart/form-data 的请求体。
 * 【为什么自己拼】Node 没有现成的 FormData（要 18 以上才有，而且我们还要兼容
 * 打包后的环境），而这个格式本身很简单：一段一段用分隔线隔开就行。
 */
function buildMultipart(parts, boundary) {
  const chunks = []
  for (const part of parts) {
    const head = [`--${boundary}`, `Content-Disposition: form-data; name="${part.name}"`]
    if (part.filename) head[1] += `; filename="${part.filename}"`
    head.push(`Content-Type: ${part.contentType || 'text/plain'}`)
    chunks.push(Buffer.from(`${head.join('\r\n')}\r\n\r\n`, 'utf8'))
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data), 'utf8'))
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return Buffer.concat(chunks)
}

/**
 * 把一张皮肤真的传上 Mojang。
 *
 * @param {object} account 正版账号（要有 mcAccessToken）
 * @param {Buffer} png 64×64 的 PNG
 * @param {'classic'|'slim'} variant 体型：经典 / 纤细
 */
async function uploadSkin(account, png, variant = 'classic') {
  if (!account?.mcAccessToken) {
    return { ok: false, error: '得先用正版账号登录才能换皮肤' }
  }

  const boundary = `----maoqiu${Date.now().toString(16)}`
  const body = buildMultipart(
    [
      { name: 'variant', data: variant === 'slim' ? 'slim' : 'classic' },
      { name: 'file', filename: 'skin.png', contentType: 'image/png', data: png }
    ],
    boundary
  )

  try {
    await post(MC_SKIN_URL, null, {
      body,
      contentType: `multipart/form-data; boundary=${boundary}`,
      headers: { Authorization: `Bearer ${account.mcAccessToken}` },
      timeout: 30000
    })
    return { ok: true, variant: variant === 'slim' ? 'slim' : 'classic' }
  } catch (error) {
    return { ok: false, error: skinUploadErrorText(error) }
  }
}

/** 把换皮肤失败的响应翻成人话 */
function skinUploadErrorText(error) {
  if (error instanceof HttpError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return '登录状态过期了，重新登录一次再试'
    }
    if (error.statusCode === 400) {
      return 'Mojang 说这张图不合规（皮肤要 64×64 的 PNG，而且不能是违规内容）'
    }
    if (error.statusCode === 429) {
      return '换皮肤换得太勤了，等一会儿再试（官方有限制）'
    }
    return `Mojang 那边返回 ${error.statusCode}${error.text ? `：${String(error.text).slice(0, 120)}` : ''}`
  }
  return `传不上去：${error.message}`
}

/** 这个正版账号现在有哪些披风、正在戴哪一条 */
async function listCapes(account) {
  if (!account?.mcAccessToken) return { ok: false, error: '得先用正版账号登录才能看披风' }

  try {
    const data = await fetchJson(MC_PROFILE_URL, {
      timeout: 15000,
      headers: { Authorization: `Bearer ${account.mcAccessToken}` }
    })

    const capes = (data.capes || []).map((one) => ({
      id: one.id,
      // 官方的披风名是英文（Migrator / MineCon 2011…），照原样显示，不硬翻
      name: one.alias || one.id,
      url: one.url || '',
      active: one.state === 'ACTIVE'
    }))

    return { ok: true, capes }
  } catch (error) {
    return { ok: false, error: `披风列表读不出来：${error.message}` }
  }
}

/** 戴上一件披风；capeId 传空就是摘下来 */
async function setCape(account, capeId) {
  if (!account?.mcAccessToken) return { ok: false, error: '得先用正版账号登录才能换披风' }

  try {
    if (capeId) {
      await putJson(MC_CAPE_URL, { capeId }, {
        headers: { Authorization: `Bearer ${account.mcAccessToken}` },
        timeout: 20000
      })
    } else {
      await del(MC_CAPE_URL, {
        headers: { Authorization: `Bearer ${account.mcAccessToken}` },
        timeout: 20000
      })
    }
    return { ok: true }
  } catch (error) {
    if (error instanceof HttpError && (error.statusCode === 401 || error.statusCode === 403)) {
      return { ok: false, error: '登录状态过期了，重新登录一次再试' }
    }
    return { ok: false, error: `换不了披风：${error.message}` }
  }
}

module.exports = {
  REDIRECT_URI,
  login,
  refresh,
  skinUrl,
  dashedUuid,
  uploadSkin,
  listCapes,
  setCape
}

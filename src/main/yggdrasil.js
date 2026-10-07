// 毛球 — 外置登录（Yggdrasil 协议 + authlib-injector）
//
// 【这是什么】Minecraft 登录用的是"Yggdrasil"这套接口：
//   启动器拿**账号密码**去认证服务器换一个**令牌**，再把令牌交给游戏，游戏拿它去认人。
//   原版这套接口是 Mojang 的；"外置登录"就是把它换成一个**别人搭的服务器**
//   （国内最常见的是 LittleSkin）——于是照样能登录、照样有皮肤，
//   只是**这个账号不是 Mojang 的正版账号**（进不了正版服务器，已写进 docs/01 R1.6）。
//
// 【为什么现在做这个】正版登录卡在 Mojang 审批（不归我们控制，见 docs/01）。
//   外置登录**不用任何人审批**，而且和正版登录共用同一套骨架
//   （账号存储、令牌续期、皮肤抓取），将来审批下来只需换一个"通行证"。
//
// 【密码怎么处理——这条是红线】
//   密码只用来换令牌，**换完就扔，绝不写进配置文件**。
//   存盘的是令牌（accessToken / clientToken）：令牌能续期、能被吊销，
//   丢了也不会牵连用户的账号密码。见 docs/06 数据与隐私说明。
//
// 【服务器地址怎么算】用户很可能只填一个 `littleskin.cn`。
//   authlib-injector 定了个规矩叫 **ALI**（API Location Indication）：
//   服务器会在响应头里告诉客户端"我的 API 在哪儿"。我们按这个规矩问一句，
//   问不到再按惯例补 `/api/yggdrasil`。**别把地址写死在代码里**——
//   用户有权用任何一个兼容的服务器。

const crypto = require('node:crypto')
const { openStream, postJson, HttpError } = require('./http')

/** 界面上的预填值。只是"默认"，用户随时能改成别的服务器 */
const DEFAULT_SERVER = 'littleskin.cn'

/** 一个格子的超时。登录不该让人干等 */
const LOGIN_TIMEOUT = 20000

/** 标准 UUID 的格式（8-4-4-4-12） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function trimSlash(url) {
  return url.replace(/\/+$/, '')
}

/** 登录时用的"客户端令牌"——本地随机生成一个，用来之后续期 */
function newClientToken() {
  return crypto.randomUUID()
}

/**
 * 把 Yggdrasil 给的 UUID（一串 32 位十六进制，没有横杠）补成标准格式。
 * 我们的离线账号存的是带横杠的，统一成一样，别的地方就不用分情况处理了。
 */
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

/**
 * 问一句"你的 API 在哪儿"（这套服务发现机制官方叫 ALI）。
 *
 * @returns {Promise<{answered: boolean, location: string}>}
 *   answered=false 表示**压根没问上**（网络不通），跟"问上了但没这个头"
 *   是两回事——规范里这两种情况的处理不一样，不能混。
 */
async function askApiLocation(target) {
  try {
    const { stream } = await openStream(target, { timeout: 10000 })
    const location = stream.headers['x-authlib-injector-api-location']
    stream.resume() // 我们只要响应头，正文扔掉，不然连接不释放

    return {
      answered: true,
      // 服务器可能给相对地址，按当前站点补全
      location: location ? trimSlash(new URL(location, `${target}/`).toString()) : ''
    }
  } catch {
    return { answered: false, location: '' }
  }
}

/**
 * 把用户填的地址变成能用的 API 根地址。
 *
 * 下面三种写法都得认：
 *   littleskin.cn
 *   https://littleskin.cn
 *   https://littleskin.cn/api/yggdrasil
 *
 * 【规矩是按官方《启动器技术规范》来的】
 *   ① 缺协议就补 HTTPS（**不许降级成明文 HTTP**，规范明文禁止）
 *   ② 发个 GET，看响应里有没有 ALI 头；有就用它指的地址
 *   ③ **没有这个头 = 你填的地址本身就是 API 地址**（不是"猜一个"）
 *   ④ 只有"连都没连上"（网络问题）才退回惯例地址，让用户至少能试
 *
 * @returns {Promise<string>} 比如 https://littleskin.cn/api/yggdrasil
 */
async function resolveApiRoot(input) {
  const raw = String(input ?? '').trim() || DEFAULT_SERVER

  let url
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new Error('服务器地址看不明白。填站点域名就行，比如 littleskin.cn')
  }

  const asked = await askApiLocation(url.toString())
  if (asked.location) return asked.location

  if (asked.answered) return trimSlash(url.toString())

  // 连不上：按最常用的惯例猜一个，成不成用户一试就知道
  return `${url.origin}/api/yggdrasil`
}

/**
 * 把"连不上"翻译成人话。
 *
 * 【为什么必须做】Node 报的是 `getaddrinfo ENOTFOUND xn--ihq19l2rdztt` 这种，
 * 用户看到只会以为软件坏了——其实只是地址打错了一个字。
 * （实测：地址填"不是域名"就会回这一串拼音域名，看着完全莫名其妙。）
 */
function networkErrorText(message) {
  const text = String(message || '')

  if (/ENOTFOUND|EAI_AGAIN/.test(text)) {
    return '找不到这个网站。服务器地址可能拼错了——照抄网站首页地址就行，比如 littleskin.cn'
  }
  if (/ECONNREFUSED/.test(text)) {
    return '这个网站拒绝了连接。地址可能不对，也可能它的登录服务临时关了'
  }
  if (/ETIMEDOUT|超时/.test(text)) {
    return '连不上这个网站（超时了）。可能是网络问题，也可能是对方服务器忙'
  }
  if (/CERT|certificate/i.test(text)) {
    return '这个网站的证书有问题，浏览器能打开但软件不敢连。换一个服务器试试'
  }
  return `连不上这个网站：${text}`
}

/**
 * 把登录失败翻译成人话。
 *
 * 【为什么值得单独写】Yggdrasil 的错误名是 `ForbiddenOperationException` 这种，
 * 直接甩给用户等于没说话。而"密码错"和"服务器挂了"是**两种完全不同的处理**：
 * 一个让用户改密码，一个让用户等一会儿。
 */
function loginErrorText(error) {
  if (error instanceof HttpError) {
    const name = error.body?.error || ''
    const message = error.body?.errorMessage || ''

    if (name === 'ForbiddenOperationException') {
      // 九成是账号或密码不对。服务器不区分这两者（故意的，防止探测账号是否存在）
      return '账号或密码不对。注意账号一般填邮箱，不是角色名'
    }
    if (name === 'IllegalArgumentException') {
      return `服务器说请求不对${message ? `：${message}` : ''}`
    }
    if (error.statusCode === 404) {
      return '这个站点没有外置登录接口——地址可能填错了'
    }
    if (error.statusCode === 429) {
      return '登录太频繁了，服务器让你歇一会儿再试'
    }
    if (error.statusCode >= 500) {
      return '对方服务器出问题了（不是你的错），过一会儿再试'
    }
    return `登录失败（服务器返回 ${error.statusCode}）${message ? `：${message}` : ''}`
  }
  return networkErrorText(error.message)
}

/**
 * 登录。密码**只传进来用一次，不保存**。
 *
 * @param {{server?: string, username: string, password: string}} input
 * @returns {Promise<{ok: boolean, account?: object, error?: string, note?: string}>}
 */
async function authenticate(input) {
  const username = String(input?.username ?? '').trim()
  const password = String(input?.password ?? '')

  if (!username) return { ok: false, error: '先填账号（一般是你注册时用的邮箱）' }
  if (!password) return { ok: false, error: '先填密码' }

  let apiRoot
  try {
    apiRoot = await resolveApiRoot(input?.server)
  } catch (error) {
    return { ok: false, error: error.message }
  }

  const clientToken = newClientToken()

  let data
  try {
    data = await postJson(
      `${apiRoot}/authserver/authenticate`,
      {
        // agent 里写 Minecraft 是协议规定的，服务器靠它判断"这是来玩游戏的"
        agent: { name: 'Minecraft', version: 1 },
        username,
        password,
        clientToken,
        requestUser: true
      },
      { timeout: LOGIN_TIMEOUT }
    )
  } catch (error) {
    return { ok: false, error: loginErrorText(error) }
  }

  const profiles = Array.isArray(data.availableProfiles) ? data.availableProfiles : []
  const picked = data.selectedProfile || profiles[0]
  if (!picked || !picked.name) {
    // 账号能登进去，但名下没有游戏角色——这在皮肤站上很常见，
    // 用户得先去网站上"添加角色"。这种话必须说清楚，不然他会以为软件坏了
    return {
      ok: false,
      error: '登进去了，但这个账号名下还没有游戏角色。到那个网站上先添加一个角色，再回来登录'
    }
  }

  const account = {
    type: 'yggdrasil',
    name: picked.name,
    uuid: dashedUuid(picked.id),
    apiRoot,
    accessToken: data.accessToken,
    clientToken: data.clientToken || clientToken,
    savedAt: Date.now()
  }

  // 有多个角色时告诉界面一声（现在先用了被选中的那个，以后可以做角色选择）
  const note = profiles.length > 1 ? `你有 ${profiles.length} 个角色，先用了「${picked.name}」` : ''

  return { ok: true, account, note }
}

/**
 * 续期。令牌会过期，过期前拿它换一个新的——用户就不用天天重新登录。
 * 密码在这儿派不上用场，这也是"存令牌不存密码"的好处。
 */
async function refresh(account) {
  if (!account?.apiRoot || !account?.accessToken) {
    return { ok: false, error: '这个账号缺令牌，得重新登录' }
  }

  try {
    const data = await postJson(
      `${account.apiRoot}/authserver/refresh`,
      {
        accessToken: account.accessToken,
        clientToken: account.clientToken,
        requestUser: true
      },
      { timeout: LOGIN_TIMEOUT }
    )

    return {
      ok: true,
      account: {
        ...account,
        name: data.selectedProfile?.name || account.name,
        uuid: dashedUuid(data.selectedProfile?.id) || account.uuid,
        accessToken: data.accessToken,
        clientToken: data.clientToken || account.clientToken,
        savedAt: Date.now()
      }
    }
  } catch (error) {
    return { ok: false, error: loginErrorText(error) }
  }
}

/** 令牌还有效吗？（204/200 就是有效） */
async function validate(account) {
  if (!account?.apiRoot || !account?.accessToken) return false
  try {
    await postJson(
      `${account.apiRoot}/authserver/validate`,
      { accessToken: account.accessToken, clientToken: account.clientToken },
      { timeout: LOGIN_TIMEOUT }
    )
    return true
  } catch {
    return false
  }
}

/** 退出登录时把这个令牌作废掉（对得起用户，别让令牌在外面飘着） */
async function invalidate(account) {
  if (!account?.apiRoot || !account?.accessToken) return
  try {
    await postJson(
      `${account.apiRoot}/authserver/invalidate`,
      { accessToken: account.accessToken, clientToken: account.clientToken },
      { timeout: 10000 }
    )
  } catch {
    // 作废失败无所谓：本地账号已经删了，令牌到期自然失效
  }
}

module.exports = {
  DEFAULT_SERVER,
  UUID_PATTERN,
  resolveApiRoot,
  authenticate,
  refresh,
  validate,
  invalidate
}

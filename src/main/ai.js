// 毛球 — AI 助手（M22）
//
// 【这个模块干什么】把用户的问题（可能带着一段游戏日志）发给他自己填的那个大模型，
// 把答案拿回来。**用谁的 Key、花谁的钱，由用户自己决定**——毛球不内置任何 Key
// （内置就等于把账号密码印在传单上发，见开发日志里的讨论）。
//
// 【为什么要支持"接口地址 + 模型名"两项】
// 国内能用的 AI 有好几家（智谱、豆包、通义、DeepSeek、Kimi…），
// 它们大多提供"OpenAI 兼容"的接口——**格式一样、地址和模型名不一样**。
// 所以只要把这两项做成能填的，用户填哪家都行，我们不用为每家写一套代码。
// 默认填的是**智谱 GLM-4-Flash**：那个模型免费（2026 年 10 月查的），
// 用户注册个账号、贴个 Key 就能白嫖，不用花钱。
//
// 【Key 怎么存】用 Windows 自带的 safeStorage 加密之后才写进配置文件。
// 配置文件是纯文本，明文存 Key 等于放在桌面上给人看。
//
// 当前进度：M22。

const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')
const { app, safeStorage } = require('electron')
const settings = require('./settings')

/** 请求超时：日志长的时候模型要想一会儿，给宽一点 */
const TIMEOUT_MS = 90000

/** 单次最多发多少字（日志），超了截尾部——**这是替用户省钱**，AI 是按字数收费的 */
const MAX_LOG_CHARS = 8000

// ——————————————————————————————————————————————
// 一、配置的读写（Key 加密）
// ——————————————————————————————————————————————

/** Key 能不能加密存（Windows 上一般都能；Linux 缺 keyring 时会不行） */
function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 把界面填的 Key 存起来（加密）。
 * @returns {{ok: boolean, error?: string}}
 */
function saveKey(plainKey) {
  const text = String(plainKey || '')
  const config = settings.readConfig()

  // 空字符串 = 用户要清掉 Key
  if (!text) {
    settings.writeConfig({ ai: { ...config.ai, keyEncrypted: '' } })
    return { ok: true }
  }

  if (!canEncrypt()) {
    return {
      ok: false,
      error: '这台电脑的系统加密用不了，为了不让 Key 明文躺在硬盘上，毛球不保存它。'
    }
  }

  try {
    const encrypted = safeStorage.encryptString(text).toString('base64')
    settings.writeConfig({ ai: { ...config.ai, keyEncrypted: encrypted } })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `存不下来：${error.message}` }
  }
}

/** 拿回明文 Key（拿不到就返回空串） */
function readKey() {
  const encrypted = settings.readConfig().ai.keyEncrypted
  if (!encrypted) return ''
  if (!canEncrypt()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    // 换了电脑 / 系统重装过 → 解不开了，让用户重填
    return ''
  }
}

/**
 * 给界面看的配置（**不带 Key 本身**，只告诉它"填没填过"）。
 * 【为什么不把 Key 发回界面】界面用不着它，少发一次就少一次泄漏的机会。
 */
function publicConfig() {
  const config = settings.readConfig().ai
  return {
    endpoint: config.endpoint,
    model: config.model,
    mode: config.mode === 'api' ? 'api' : 'local',
    hasKey: Boolean(config.keyEncrypted),
    canEncrypt: canEncrypt()
  }
}

/** 改配置（endpoint / model / mode 是明文存的，Key 走 saveKey） */
function updateConfig(patch = {}) {
  const config = settings.readConfig().ai
  const next = { ...config }

  if (typeof patch.endpoint === 'string') {
    const value = patch.endpoint.trim()
    if (!/^https?:\/\//i.test(value)) return { ok: false, error: '接口地址要以 http:// 或 https:// 开头' }
    next.endpoint = value
  }
  if (typeof patch.model === 'string') {
    const value = patch.model.trim()
    if (!value) return { ok: false, error: '模型名不能空着' }
    next.model = value
  }
  if (patch.mode === 'local' || patch.mode === 'api') next.mode = patch.mode

  settings.writeConfig({ ai: next })

  if (patch.apiKey !== undefined) {
    const saved = saveKey(patch.apiKey)
    if (!saved.ok) return saved
  }
  return { ok: true, config: publicConfig() }
}

// ——————————————————————————————————————————————
// 二、把该去的隐私去掉
// ——————————————————————————————————————————————

/**
 * 发出去之前把隐私抹掉。
 *
 * 【抹什么、留什么】
 *   抹：Windows 用户名（`C:\Users\某某\...` 里的 li）、账号名、联机房间码
 *   留：Mod 名、游戏版本、报错内容——**这些是判断问题的依据，抹了 AI 就没法看了**
 * 【为什么只抹这些】再多抹就把有用的信息也抹没了；用户的 Mod 列表和报错内容
 * 本身不是隐私（都是公开的东西），真正敏感的是"这台电脑是谁的"。
 */
function redact(text, { accountName } = {}) {
  let out = String(text || '')

  // Windows 的用户名：C:\Users\xxx\...
  out = out.replace(/([A-Za-z]:\\Users\\)[^\\/\s]+/gi, '$1<用户名>')
  // 反过来的写法（有的日志会拼成 C:/Users/xxx）
  out = out.replace(/([A-Za-z]:\/Users\/)[^\\/\s]+/gi, '$1<用户名>')

  // 账号名（游戏里那个名字）：只在它真的出现过时才抹
  const name = String(accountName || '').trim()
  if (name && name.length >= 2) {
    out = out.split(name).join('<玩家名>')
  }

  // 联机房间码：8 位的大写字母数字（我们自己的格式，见 online.js）
  out = out.replace(/\b[A-HJ-NP-Z2-9]{8}\b/g, '<房间码>')

  return out
}

/** 日志太长就截尾巴（前面多是启动过程，出错的是后面） */
function trimLog(text) {
  const value = String(text || '')
  if (value.length <= MAX_LOG_CHARS) return { text: value, truncated: false }
  return {
    text: `（前面省略了 ${value.length - MAX_LOG_CHARS} 个字，下面是最后一段）\n` + value.slice(-MAX_LOG_CHARS),
    truncated: true
  }
}

// ——————————————————————————————————————————————
// 三、跟模型说话
// ——————————————————————————————————————————————

/**
 * POST 一个 JSON 出去，拿回 JSON。
 *
 * 【为什么不用 http.js】那个是给"下文件"写的（GET + 跟随跳转）；
 * 这里是 POST + 自定义头 + 要读状态码里的错误信息，单独写反而清楚。
 */
function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error('接口地址不对'))
      return
    }

    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const lib = parsed.protocol === 'http:' ? http : https

    const request = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          ...headers
        },
        timeout: TIMEOUT_MS
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => {
          resolve({ status: response.statusCode || 0, text })
        })
      }
    )

    request.on('timeout', () => {
      request.destroy(new Error('等太久没回应'))
    })
    request.on('error', reject)
    request.write(payload)
    request.end()
  })
}

/** 把各种失败翻译成人话（英文报错直接甩给用户等于没说） */
function friendlyError(error, status, bodyText) {
  const text = String(bodyText || '')

  if (status === 401 || status === 403) {
    return 'Key 不对，或者这个 Key 没有权限。回平台看看是不是复制全了（有的 Key 很长，容易少一位）'
  }
  if (status === 404) {
    return '接口地址不对——检查一下地址末尾（有的平台要把 /v1 或 /v4 带上）'
  }
  if (status === 429) {
    // 429 其实分两种：一种是"你问太快"（额度用完），另一种是"这个模型现在挤不上"
    // （智谱实测回过 code 1305「该模型当前访问量过大」——2026-10-09 在 glm-4.7-flash 上碰到）
    const detail = text.replace(/\s+/g, ' ').trim().slice(0, 160)
    const busy = /访问量|繁忙|排队|overload|busy/i.test(text)
    const head = busy ? '这个免费模型现在用的人太多，暂时挤不上' : '问得太快了，或者今天的免费额度用完了'
    const tail = busy
      ? '（过几分钟再试；急着用就去「设置 → AI 助手」把模型名换成 glm-4-flash-250414——那个也免费、现在很稳）'
      : '（等一会儿再问，或者明天再试）'
    return detail ? `${head}。平台的原话：「${detail}」\n${tail}` : `${head}。${tail}`
  }
  if (status >= 500) {
    return '对面服务器出问题了（不是你的锅），等几分钟再试'
  }
  if (status === 400) {
    // 平台通常会在 body 里说清楚，能读到就带上
    const detail = text.slice(0, 200)
    // 最常见的 400 就是模型名写错了，单独给一句能照着做的（模型名随时能在设置里改）
    if (/model|模型/i.test(text)) {
      return `这个模型名平台不认：${detail}\n（去「设置 → AI 助手」把模型名换一个。免费的可以填 glm-4-flash-250414——一直很稳；glm-4.7-flash 更新，但赶上人多会挤不上）`
    }
    return `这个请求对方不认：${detail}`
  }

  const message = String(error?.message || '')
  if (message.includes('ENOTFOUND') || message.includes('EAI_AGAIN')) {
    return '连不上这个接口地址——检查一下网络，或者地址是不是拼错了'
  }
  if (message.includes('ETIMEDOUT') || message.includes('等太久')) {
    return '等了很久没回应：可能是网慢、或者日志太长。等会儿再试'
  }
  if (message.includes('ECONNREFUSED')) {
    return '这个地址拒绝连接——地址或者端口可能不对'
  }
  return `没能问成：${message || '未知原因'}`
}

/** 接口地址可能给的是"根地址"，也可能给全了——两种都认 */
function completionsUrl(endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(base)) return base
  return `${base}/chat/completions`
}

/** 给模型的"人设"：说人话、只说该说的、别编 */
const SYSTEM_PROMPT = [
  '你是「毛球」——一个 Minecraft Java 版启动器的助手，帮中文用户看游戏报错、解答疑难。',
  '',
  '回答要求：',
  '1. 用中文，说人话。用户多半不是程序员，别堆术语；必须用的术语后面跟一句解释。',
  '2. 先给结论（是什么毛病），再给"为什么"，最后给一条一条能照着做的步骤。',
  '3. 步骤要具体到"点哪个按钮、进哪个文件夹"，别说"检查一下配置"这种空话。',
  '4. **不确定就说不确定**，别编。宁可说"这条日志看不出来，建议把完整日志发出来"。',
  '5. **不要编造文件和路径**：只依据我给的信息，需要引用路径时照着原文写。',
  '6. 简短优先：能三行说清就别写十行。'
].join('\n')

/**
 * 问一次 AI。
 *
 * @param {{question: string, logText?: string, history?: Array<{role, content}>}} options
 * @returns {Promise<{ok: boolean, answer?: string, error?: string, usage?: object}>}
 */
async function ask({ question, logText = '', history = [] } = {}) {
  const config = settings.readConfig().ai
  const key = readKey()

  if (!key) return { ok: false, error: '还没填 AI 的 Key。到「设置 → AI 助手」里填一个（有免费的）。' }
  if (!config.endpoint || !config.model) return { ok: false, error: 'AI 的接口地址或模型名空着，去设置里补上' }

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]

  // 前面几轮对话（最多带 6 条，免得越聊越长越贵）
  for (const one of history.slice(-6)) {
    if (!one || !one.content) continue
    messages.push({ role: one.role === 'assistant' ? 'assistant' : 'user', content: String(one.content) })
  }

  const trimmed = trimLog(logText)
  const userText = trimmed.text
    ? `【游戏日志】\n${trimmed.text}\n\n【我的问题】\n${question || '这次游戏出问题了，帮我看看是什么原因、怎么解决。'}`
    : String(question || '')
  messages.push({ role: 'user', content: userText })

  let response
  try {
    response = await postJson(
      completionsUrl(config.endpoint),
      { authorization: `Bearer ${key}` },
      {
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: 1500
      }
    )
  } catch (error) {
    return { ok: false, error: friendlyError(error, 0, '') }
  }

  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: friendlyError(null, response.status, response.text) }
  }

  let data
  try {
    data = JSON.parse(response.text)
  } catch {
    return { ok: false, error: '对面回的东西看不懂（不是标准的接口格式），检查一下接口地址' }
  }

  const answer = data?.choices?.[0]?.message?.content
  if (!answer) {
    return { ok: false, error: '对面没给答案（可能是模型名不对，或者内容被拦了）' }
  }

  return {
    ok: true,
    answer: String(answer).trim(),
    trimmed: trimmed.truncated,
    usage: data.usage || null
  }
}

/** 测试连接：发一句最小的话，看通不通 */
async function test() {
  const config = settings.readConfig().ai
  const key = readKey()
  if (!key) return { ok: false, error: '还没填 Key' }

  try {
    const response = await postJson(
      completionsUrl(config.endpoint),
      { authorization: `Bearer ${key}` },
      {
        model: config.model,
        messages: [{ role: 'user', content: '只回两个字：收到' }],
        max_tokens: 20
      }
    )

    if (response.status < 200 || response.status >= 300) {
      return { ok: false, error: friendlyError(null, response.status, response.text) }
    }

    const data = JSON.parse(response.text)
    const answer = data?.choices?.[0]?.message?.content || ''
    return { ok: true, answer: String(answer).trim().slice(0, 40) }
  } catch (error) {
    return { ok: false, error: friendlyError(error, 0, '') }
  }
}

module.exports = { ask, test, publicConfig, updateConfig, redact, trimLog, MAX_LOG_CHARS, canEncrypt }

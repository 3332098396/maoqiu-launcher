// 毛球 — 账号令牌的加密存放（M23）
//
// 【为什么要加密】配置文件 `%APPDATA%\毛球\config.json` 以前是**明文**存令牌的。
// 谁要是看到了那个文件（远程协助、共享屏幕、备份传网盘、顺手拷了一份），
// 就拿到了你的登录令牌——能直接用你的身份登进游戏。
// 启动器里躺着别人的会话令牌，不该是这个样子。
//
// 【怎么加密的】用 Electron 自带的 safeStorage：
// Windows 上它走的是 DPAPI，密钥跟**当前 Windows 用户的登录凭据**绑在一起。
// 意思就是：把 config.json 拷到别的电脑、或者换个 Windows 账号登录，
// 那串东西**解不开**。
//
// 【为什么不自己写加密】自己写就得自己管密钥，而密钥只能放在同一个文件夹里——
// 等于把钥匙和锁放一块儿，看着像加密，其实一点用没有。
//
// 【存不进去的时候怎么办】极少数环境（比如没有桌面会话的 Linux）拿不到加密能力。
// 那种情况下**老老实实存明文**，但界面上要说明白——总比把账号弄丢强。
//
// 当前进度：M23。

const { safeStorage } = require('electron')

/** 这些字段是要加密的（其余都是可以见人的信息） */
const SECRET_FIELDS = ['accessToken', 'mcAccessToken', 'refreshToken', 'clientSecret']

/** 加密后的东西存在 `<字段名>Enc` 里，值是 base64 */
function encFieldName(field) {
  return `${field}Enc`
}

/** 这台机器能不能加密 */
function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 把账号里那些"不能见人"的字段加密，**并从对象里去掉明文**。
 * 拿不到加密能力时原样返回（明文留着，至少账号还能用）。
 */
function lockAccount(account) {
  if (!account || typeof account !== 'object') return account

  const out = { ...account }
  if (!isAvailable()) return out

  for (const field of SECRET_FIELDS) {
    const value = out[field]
    if (typeof value !== 'string' || !value) continue

    try {
      out[encFieldName(field)] = safeStorage.encryptString(value).toString('base64')
      // 加成功了才删明文。反过来的话一旦加密抛错，令牌就两头都没有了
      delete out[field]
    } catch {
      // 这一个加不了就留着明文，别把账号搞丢
    }
  }

  return out
}

/**
 * 反过来：把 `<字段名>Enc` 解回明文，填进 `字段名`。
 * 解不开的（换了电脑、换了 Windows 账号）就把那个 Enc 字段去掉、留空——
 * 上层看到"没有令牌"会提示重新登录，比抛异常强。
 */
function unlockAccount(account) {
  if (!account || typeof account !== 'object') return account

  const out = { ...account }

  for (const field of SECRET_FIELDS) {
    const stored = out[encFieldName(field)]
    if (typeof stored !== 'string' || !stored) continue

    if (out[field]) continue // 已经有明文了（老配置），不用管

    try {
      out[field] = safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      // 解不开：把那个字段清掉，让上层当成"没登录"
      out[field] = ''
    }
  }

  return out
}

/**
 * 给界面看的版本：**一个令牌都不带**。
 *
 * 【为什么要单独有这么一步】账号信息是要发给渲染层的（界面要显示头像、名字）。
 * 令牌对界面来说一点用都没有——它又不发请求。
 * 不带出去，就算将来界面上出了什么注入问题，也偷不到令牌。
 */
function publicAccount(account) {
  if (!account || typeof account !== 'object') return account

  const out = { ...account }
  for (const field of SECRET_FIELDS) {
    delete out[field]
    delete out[encFieldName(field)]
  }
  return out
}

module.exports = { lockAccount, unlockAccount, publicAccount, isAvailable, SECRET_FIELDS }

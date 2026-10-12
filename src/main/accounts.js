// 毛球 — 账号
//
// 三种账号，存哪儿都在这一个文件里：
//   offline    离线：随便起个名字就能玩单机（第一期）
//   yggdrasil  外置登录：皮肤站那种账号，有真令牌、有皮肤（M16）
//   正版（微软）排在 M16 后面，卡在 Mojang 审批上，见 docs/01
//
// 【存的是什么】离线账号只有名字和算出来的 UUID；
// 外置登录存**令牌**（accessToken / clientToken），**绝不存密码**。
//
// 【离线 UUID 是怎么算的】
// 游戏里每个玩家有一个 UUID（一串唯一编号），正版是服务器发的。
// 离线模式没有服务器，就用名字"算"出一个固定的编号：
//
//   UUID = MD5("OfflinePlayer:" + 名字)，再把版本号和格式标记按规矩改两下
//
// 【为什么必须用这个算法】
// 联机时对方的服务器也是这么算的——算法不一样，别人就认不出你是谁。
// 这个算法和 Java 的 UUID.nameUUIDFromBytes 完全一致。
//
// 当前进度：M5。

const crypto = require('node:crypto')
const settings = require('./settings')
const secrets = require('./secrets')

/** 名字的规矩：跟游戏本体的限制一致（3~16 位，字母数字下划线） */
const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/

/**
 * 检查名字合不合法。
 * @returns {{ok: boolean, error?: string}} error 是给用户看的中文
 */
function checkName(name) {
  const trimmed = String(name ?? '').trim()

  if (!trimmed) return { ok: false, error: '先填一个游戏名字' }
  if (trimmed.length < 3 || trimmed.length > 16) {
    return { ok: false, error: '名字要 3～16 个字符' }
  }
  if (!NAME_PATTERN.test(trimmed)) {
    return { ok: false, error: '名字只能用英文字母、数字、下划线（中文和空格游戏不认）' }
  }
  return { ok: true }
}

/**
 * 从名字算出离线 UUID（带横杠的标准格式）。
 * 算法和游戏本体、和别的启动器完全一致。
 */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()

  // 按 UUID 的规矩改两个字节：第 7 字节的高 4 位标成版本 3（MD5），
  // 第 9 字节的高 2 位标成标准格式。不改的话不是合法 UUID。
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80

  const hex = hash.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

/**
 * 当前用的账号。没设过返回 null。
 * 【M23】令牌在配置里是加密存的（见 secrets.js），这里**解开来**再给出去——
 * 上层拿到的还是原来那个形状，它不用知道底下存的是密文。
 */
function getAccount() {
  const account = settings.readConfig().account
  if (!account || !account.name) return null
  return secrets.unlockAccount(account)
}

/**
 * 保存离线账号（存进配置文件，下次打开还在）。
 * @returns {{ok: boolean, account?: object, error?: string}}
 */
function setAccount(name) {
  const trimmed = String(name ?? '').trim()

  const check = checkName(trimmed)
  if (!check.ok) return check

  const account = { type: 'offline', name: trimmed, uuid: offlineUuid(trimmed) }

  return save(account, '账号存不下来')
}

// ——————————————————————————————————————————————
// 账号列表（R1.4 记住账号 / R1.5 多账号切换 / M16 外置登录）
// ——————————————————————————————————————————————

/**
 * 一个账号在列表里的唯一标识。
 *
 * 【为什么不按名字】外置登录的账号能改角色名，只按名字的话改一次就变成两个账号。
 * 用"类型 + UUID"：UUID 是服务器发的，不会变。
 */
function accountKey(account) {
  if (!account) return ''
  return `${account.type || 'offline'}:${account.uuid || account.name || ''}`
}

/**
 * 现在存着哪些账号。
 *
 * 【为什么要兼容老配置】M16 之前配置里只有单个 `account`。
 * 老用户升级上来不能"账号凭空消失"，所以列表为空时把那个补进来。
 */
function listAccounts() {
  const config = settings.readConfig()
  const raw = Array.isArray(config.accounts) ? config.accounts.filter((a) => a && a.name) : []
  // 令牌解密之后再给出去（见 getAccount 的说明）
  if (raw.length) return raw.map(secrets.unlockAccount)

  const legacy = config.account
  return legacy && legacy.name ? [secrets.unlockAccount(legacy)] : []
}

/**
 * 把账号写进配置。**这是唯一往配置里写账号的地方**——
 * 所有调用都得走它，才不会漏掉加密那一步。
 *
 * 【为什么要集中】以前 setCurrent 是自己写 writeConfig 的，
 * 要是只在 save 里加密，切一下账号就把明文令牌又写回去了。
 */
function writeAccounts(account, list) {
  settings.writeConfig({
    account: account ? secrets.lockAccount(account) : account,
    accounts: (list || []).map(secrets.lockAccount)
  })
}

/** 把账号存进列表并设为当前账号 */
function save(account, failPrefix = '账号存不下来') {
  try {
    const list = listAccounts()
    const key = accountKey(account)
    const at = list.findIndex((item) => accountKey(item) === key)

    if (at >= 0) list[at] = account
    else list.push(account)

    writeAccounts(account, list)
    return { ok: true, account }
  } catch (error) {
    return { ok: false, error: `${failPrefix}：${error.message}` }
  }
}

/** 存一个登录到手的账号（外置登录 / 正版登录都走这儿；令牌在里面，密码不在） */
function saveAccount(account) {
  return save(account, '账号存不下来')
}

/** 切换当前账号 */
function setCurrent(key) {
  const found = listAccounts().find((item) => accountKey(item) === key)
  if (!found) return { ok: false, error: '找不到这个账号，可能已经删掉了' }

  try {
    writeAccounts(found, listAccounts())
  } catch (error) {
    return { ok: false, error: `切换失败：${error.message}` }
  }
  return { ok: true, account: found }
}

/**
 * 删掉一个账号。
 * 【外置账号顺手把令牌作废】不然那个令牌还能在外面飘到过期为止。
 */
async function remove(key) {
  const list = listAccounts()
  const found = list.find((item) => accountKey(item) === key)
  if (!found) return { ok: false, error: '找不到这个账号' }

  const rest = list.filter((item) => accountKey(item) !== key)
  const current = getAccount()
  const nextCurrent = accountKey(current) === key ? rest[0] || null : current

  try {
    writeAccounts(nextCurrent, rest)
  } catch (error) {
    return { ok: false, error: `删账号失败：${error.message}` }
  }

  if (found.type === 'yggdrasil') {
    // 作废是"顺手做的好事"，失败了也不该让删除报错
    require('./yggdrasil').invalidate(found)
  }

  return { ok: true, account: nextCurrent, accounts: rest }
}

module.exports = {
  checkName,
  offlineUuid,
  accountKey,
  getAccount,
  setAccount,
  saveAccount,
  listAccounts,
  setCurrent,
  remove
}

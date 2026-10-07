// 毛球 — 账号
//
// 第一期只有离线账号：用户随便起个名字就能玩单机。
// 正版登录卡在 Mojang 审批上（见 docs/01），等批了再补。
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

/** 当前用的账号。没设过返回 null */
function getAccount() {
  const account = settings.readConfig().account
  if (!account || !account.name) return null
  return account
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

  try {
    settings.writeConfig({ account })
  } catch (error) {
    return { ok: false, error: `账号存不下来：${error.message}` }
  }

  return { ok: true, account }
}

module.exports = { checkName, offlineUuid, getAccount, setAccount }

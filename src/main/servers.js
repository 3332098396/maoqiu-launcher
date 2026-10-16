// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 多人游戏的服务器列表（M23）
//
// 【这一页是干什么的】
// 游戏里"多人游戏"那张列表，其实是游戏目录下一个 `servers.dat`（NBT 格式）。
// 以前毛球碰不了它，所以收藏的服务器只能在游戏里一个个手输 IP。
// 现在能读能写：在启动器里加服务器、看它在不在线、几个人、延迟多少、一键进服。
//
// 【为什么自己实现"探活"（SLP）】官方的"服务器列表 Ping"是一段很短的
// TCP 对话（连上去、问一句"你是谁"、服务器回一段 JSON）。协议小到不值得为它
// 引一个库，而且自己写还能顺手把 SRV 记录（有的服务器用域名隐藏端口）也处理了。
//
// 协议参考：https://minecraft.wiki/w/Java_Edition_protocol#Status
//
// 当前进度：M23。

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const dns = require('node:dns')
const paths = require('./paths')
const nbt = require('./nbt')

/** 服务器列表文件在游戏目录根部 */
function serversFile(dir) {
  return path.join(paths.gameDir(dir), 'servers.dat')
}

// ——————————————————————————————————————————————
// 读写 servers.dat
// ——————————————————————————————————————————————

/**
 * 读服务器列表。
 * 文件不在就返回空列表（**不算错误**——没加过服务器的人本来就没有这个文件）。
 */
function readServers(dir) {
  const file = serversFile(dir)
  if (!fs.existsSync(file)) return []

  const root = nbt.parse(fs.readFileSync(file))
  const list = Array.isArray(root.servers) ? root.servers : []

  return list.map((one, index) => ({
    index,
    name: String(one.name || ''),
    ip: String(one.ip || ''),
    // 这几个开关在 NBT 里是"字节"，读出来是 0/1
    hideAddress: Boolean(one.hideAddress),
    acceptTextures: Boolean(one.acceptTextures),
    icon: typeof one.icon === 'string' ? one.icon : ''
  }))
}

/**
 * 写回服务器列表。
 *
 * 【为什么字段要"一个不少"地写回去】游戏读这个文件是**按名字找字段**的，
 * 缺了 `hideAddress` 它就用默认值——看起来没事，但用户原来设的就被抹掉了。
 * 所以每个服务器都把该有的字段全写一遍。
 *
 * 【注意】写的时候是"先写临时文件再改名"（CLAUDE.md 红线），
 * 断电也不会留下半个坏掉的 servers.dat（那个文件坏了游戏会直接忽略整个列表）。
 */
function writeServers(dir, servers) {
  const file = serversFile(dir)
  const temp = `${file}.tmp`

  const items = servers.map((one) =>
    nbt.compound({
      name: nbt.str(one.name || ''),
      ip: nbt.str(one.ip || ''),
      hideAddress: nbt.byte(one.hideAddress),
      acceptTextures: nbt.byte(one.acceptTextures),
      // 图标（一段 base64 的 PNG）。没有就别写这个字段——
      // 游戏读到空字符串会当成"有一张空图"，那一行会变成空白而不是地球图标
      ...(one.icon ? { icon: nbt.str(one.icon) } : {})
    })
  )

  const root = nbt.compound({ servers: nbt.list(nbt.TAG.COMPOUND, items) })
  const data = nbt.write(root)

  paths.ensureDir(paths.gameDir(dir))
  fs.writeFileSync(temp, data)
  fs.renameSync(temp, file)

  return { ok: true, file }
}

/** 加一台服务器（同名同地址的会被拒，免得用户点两下多出两条一样的） */
function addServer(dir, { name, ip, hideAddress = false, acceptTextures = false }) {
  const cleanName = String(name || '').trim()
  const cleanIp = String(ip || '').trim()

  if (!cleanName) return { ok: false, error: '服务器得有个名字' }
  if (!cleanIp) return { ok: false, error: '得填服务器的地址' }

  const servers = readServers(dir)
  if (servers.some((one) => one.ip.toLowerCase() === cleanIp.toLowerCase())) {
    return { ok: false, error: '这个地址已经在列表里了' }
  }

  servers.push({ name: cleanName, ip: cleanIp, hideAddress, acceptTextures })
  writeServers(dir, servers)
  return { ok: true, servers: readServers(dir) }
}

/** 改一条（按索引，因为名字可能重复） */
function updateServer(dir, index, patch) {
  const servers = readServers(dir)
  if (!servers[index]) return { ok: false, error: '找不到这一条' }

  servers[index] = { ...servers[index], ...patch }
  writeServers(dir, servers)
  return { ok: true, servers: readServers(dir) }
}

/** 删一条（**删的是记录，不是用户电脑上的东西**，不用二次确认那么重） */
function removeServer(dir, index) {
  const servers = readServers(dir)
  if (!servers[index]) return { ok: false, error: '找不到这一条' }

  servers.splice(index, 1)
  writeServers(dir, servers)
  return { ok: true, servers: readServers(dir) }
}

// ——————————————————————————————————————————————
// 探活（Server List Ping）
// ——————————————————————————————————————————————

/** 把地址拆成 { host, port }。没写端口就按 25565 */
function splitAddress(ip) {
  const text = String(ip || '').trim()
  const at = text.lastIndexOf(':')
  if (at > 0 && !text.slice(at + 1).includes(']')) {
    const port = Number(text.slice(at + 1))
    if (Number.isFinite(port) && port > 0) {
      return { host: text.slice(0, at), port, hadPort: true }
    }
  }
  return { host: text, port: 25565, hadPort: false }
}

/** 写一个 VarInt（协议里"变长整数"的写法，小的数就一个字节） */
function writeVarInt(value) {
  const out = []
  let rest = value >>> 0
  do {
    let byte = rest & 0x7f
    rest >>>= 7
    if (rest !== 0) byte |= 0x80
    out.push(byte)
  } while (rest !== 0)
  return Buffer.from(out)
}

/** 写一个字符串（先写长度再写内容） */
function writeString(text) {
  const body = Buffer.from(String(text), 'utf8')
  return Buffer.concat([writeVarInt(body.length), body])
}

/** 拼一个完整的数据包（长度 + 包号 + 内容） */
function packet(id, ...parts) {
  const body = Buffer.concat([writeVarInt(id), ...parts])
  return Buffer.concat([writeVarInt(body.length), body])
}

/**
 * 从一段缓冲里读 VarInt。
 * @returns {{value: number, size: number}|null} 读不全就返回 null（等下一批数据）
 */
function readVarInt(buffer, at = 0) {
  let value = 0
  let size = 0
  for (;;) {
    if (at + size >= buffer.length) return null
    const byte = buffer[at + size]
    value |= (byte & 0x7f) << (7 * size)
    size++
    if ((byte & 0x80) === 0) break
    if (size > 5) return null // 坏了
  }
  return { value: value >>> 0, size }
}

const PROTOCOL_VERSION = 768 // 随便给一个"现代版本"的号；服务器只看它决定要不要显示红叉

/**
 * 问一台服务器"你还在吗、几个人、什么版本"。
 *
 * 【为什么自己算 RTT 而不用别人报的延迟】拿到的 JSON 里没有延迟这一项，
 * 延迟就是"我发出去到收到回应"的时间——这也是游戏里那个绿格子的算法。
 *
 * @returns {Promise<{ok: boolean, online: boolean, latency: number, online_players: number,
 *                    max_players: number, version: string, motd: string, error?: string}>}
 */
function ping(ip, { timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    const { host, port, hadPort } = splitAddress(ip)
    if (!host) {
      resolve({ ok: false, online: false, error: '地址是空的' })
      return
    }

    const startedAt = Date.now()
    const socket = new net.Socket()
    let chunks = []
    let settled = false

    const done = (result) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // 已经断了
      }
      resolve(result)
    }

    socket.setTimeout(timeout)
    socket.on('timeout', () => done({ ok: false, online: false, error: '等太久了，没回应' }))
    socket.on('error', (error) => done({ ok: false, online: false, error: error.message }))

    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const all = Buffer.concat(chunks)

      // 回应是：长度(VarInt) + 包号(VarInt) + JSON字符串
      const length = readVarInt(all, 0)
      if (!length) return
      const total = length.size + length.value
      if (all.length < total) return // 还没收完

      const idAt = length.size
      const id = readVarInt(all, idAt)
      if (!id) return

      const textAt = idAt + id.size
      const textLength = readVarInt(all, textAt)
      if (!textLength) return

      const jsonStart = textAt + textLength.size
      const jsonText = all.subarray(jsonStart, jsonStart + textLength.value).toString('utf8')

      let data
      try {
        data = JSON.parse(jsonText)
      } catch {
        done({ ok: false, online: false, error: '服务器回的看不懂' })
        return
      }

      done({
        ok: true,
        online: true,
        latency: Date.now() - startedAt,
        online_players: data.players?.online ?? 0,
        max_players: data.players?.max ?? 0,
        version: data.version?.name || '',
        // MOTD 里带颜色代码（§a 这种），显示前要洗掉
        motd: stripColors(flattenChat(data.description)),
        icon: typeof data.favicon === 'string' ? data.favicon : ''
      })
    })

    // ——— 先看有没有 SRV 记录 ———
    //
    // 【为什么要这一步】很多服务器用的是域名，真实端口藏在 `_minecraft._tcp.域名`
    // 这条 SRV 记录里；用户填的就是个普通域名（比如 `hypixel.net`），
    // 直接连 25565 是连不上的，而游戏自己能连上——差别就在这一步。
    // 用户自己写了端口的话就不查了（以他写的为准）。
    const go = (realHost, realPort) => {
      const handshake = packet(
        0,
        writeVarInt(PROTOCOL_VERSION),
        writeString(realHost),
        (() => {
          const b = Buffer.alloc(2)
          b.writeUInt16BE(realPort)
          return b
        })(),
        writeVarInt(1) // 1 = 我要问状态
      )
      const request = packet(0)
      socket.connect(realPort, realHost, () => socket.write(Buffer.concat([handshake, request])))
    }

    if (hadPort || net.isIP(host)) {
      go(host, port)
      return
    }

    dns.resolveSrv(`_minecraft._tcp.${host}`, (error, records) => {
      if (!error && Array.isArray(records) && records.length > 0) {
        // 按优先级排一下，取最前面那个（协议里 priority 小的优先）
        const best = records.slice().sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0]
        go(best.name, best.port)
        return
      }
      go(host, port)
    })
  })
}

/** 把聊天组件（可能是字符串、也可能是一层层嵌套的对象）摊平成纯文本 */
function flattenChat(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flattenChat).join('')
  if (typeof node === 'object') {
    return `${flattenChat(node.text)}${flattenChat(node.extra)}`
  }
  return String(node)
}

/** 去掉 §a 这种颜色/格式代码 */
function stripColors(text) {
  return String(text).replace(/§./g, '')
}

module.exports = { readServers, writeServers, addServer, updateServer, removeServer, ping, serversFile }

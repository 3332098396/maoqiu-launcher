// SPDX-License-Identifier: LGPL-3.0-only
//
// 逐语句移植自 KAMUCL 的 `src/main/core/voxlink/tcpPunch.ts`（它自己标注 LGPL-3.0-only，
// 头部写着 "Adapted from AUGUHDAR/VoxLink TcpHolePuncher / P2PBridge, revision 721c7fae"）。
// 见 THIRD_PARTY_NOTICES.md —— 本文件**不适用**仓库根的 MIT，按 LGPL-3.0-only 提供。
//
// 干什么：UDP 打洞打不通时的**第二条路** —— TCP「同时打开」（simultaneous open）。
//
// 说人话：正常打电话是"你拨给他、他接"。但两家都在路由器后面时，谁先拨都可能被拦。
// 这里的办法是**两边同时拨**：你拨过去的 SYN、他拨过来的 SYN 在半路上撞上，
// 于是两边的路由器都当成"这是我先发出去的连接的回包"，判它合法放行 —— 洞就这么开了。
// 代价是**两边必须用同一个端口号**（`localPort: port`），所以先用 `chooseTcpPunchPort()`
// 跟系统要一个空闲端口。
//
// 这条路打通以后，游戏数据就在这条 TCP 上跑；"把游戏接上去"由 `bridge.js` 负责。
//
// §0 纪律：重试次数、超时、守卫全部与 tcpPunch.ts 一致，别自己改。
// 唯一允许的变换是语言翻译（TS 类型标注去掉、`private` 等修饰符去掉）。

const net = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')

/** 上游第 5-11 行：跟系统要一个空闲端口（开一下就关掉），拿去当"同时打开"用的端口 */
async function chooseTcpPunchPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(() => resolve()))
  return port
}

/**
 * 上游第 12-43 行：**同时打开**。
 *
 * 先自己主动拨（房主最多试 5 次、房客 1 次，总预算 10 秒），
 * 拨不动了就在**同一个端口上**开个监听等着 —— 别人的 SYN 撞上来就算成功。
 *
 * `host` 决定"主动拨几次"：房主多试几次（它那边先开局，早拨早撞上）。
 */
async function tcpSimOpen(ip, port, host, signal) {
  if (!net.isIP(ip) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('TCP 打洞地址无效')
  const deadline = Date.now() + 10000
  for (let attempt = 0; attempt < (host ? 5 : 1) && Date.now() < deadline; attempt++) {
    signal.throwIfAborted()
    const socket = new net.Socket()
    const abort = () => socket.destroy()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('TCP 同时打开超时')) }, Math.min(3000, deadline - Date.now()))
        socket.once('error', reject)
        socket.once('close', () => { clearTimeout(timer); reject(new Error('TCP 同时打开已关闭')) })
        // localPort 必须和对方要连的端口一样 —— 这是"同时打开"能撞上的前提，改了就废
        socket.connect({ host: ip, port, localPort: port }, () => { clearTimeout(timer); resolve() })
      })
      signal.throwIfAborted()
      socket.setNoDelay(true)
      return socket
    } catch {
      socket.destroy()
      signal.throwIfAborted()
    } finally {
      signal.removeEventListener('abort', abort)
    }
    await delay(50 + Math.floor(Math.random() * 200), undefined, { signal })
  }
  signal.throwIfAborted()
  // 主动拨不出去：换个姿势 —— 在同一个端口上守着，等对方的 SYN 撞过来
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      // 只有真·对方的包才收：不是他发来的一律扔掉（防第三者插进来）
      if ((socket.remoteAddress || '').replace(/^::ffff:/, '') !== ip.replace(/^::ffff:/, '')) { socket.destroy(); return }
      finish()
      socket.setNoDelay(true)
      resolve(socket)
    })
    const finish = (error) => { clearTimeout(timer); signal.removeEventListener('abort', abort); server.close(); if (error) reject(error) }
    const abort = () => finish(new Error('TCP 打洞已取消'))
    const timer = setTimeout(() => finish(new Error('TCP 打洞未命中')), 10000)
    signal.addEventListener('abort', abort, { once: true })
    server.once('error', finish)
    server.listen(port, net.isIP(ip) === 6 ? '::' : '0.0.0.0')
  })
}

/**
 * 上游第 44-69 行：TCP 洞打通了以后，**把游戏接上去**。
 *
 * 和 `bridge.js` 里的 `TcpBridge` 是一回事，区别在端口从哪来：
 * - **房主**（`hostPort` 非空）：主动去连本机的游戏端口，连上就把两边对接起来
 * - **房客**（`hostPort` 为 null）：开一个本地临时端口等着游戏来连，
 *   把 `127.0.0.1:<端口>` 交给界面显示给用户
 *
 * 返回的 `stop()` 一调，两边一起收摊。
 */
async function bridgePunchedSocket(peer, hostPort, onDown) {
  let server
  let local
  let stopped = false
  const stop = () => { if (stopped) return; stopped = true; server?.close(); peer.destroy(); local?.destroy(); onDown() }
  peer.on('error', stop)
  peer.once('close', stop)
  peer.setKeepAlive(true, 10000)
  peer.pause()
  const pair = (socket) => {
    if (stopped || local) { socket.destroy(); return }
    local = socket
    socket.setNoDelay(true)
    socket.on('error', stop)
    socket.once('close', stop)
    peer.pipe(socket)
    socket.pipe(peer)
  }
  if (hostPort) {
    const socket = net.createConnection({ host: '127.0.0.1', port: hostPort })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('本地游戏连接超时')) }, 10000)
        socket.once('error', (error) => { clearTimeout(timer); reject(error) })
        socket.once('connect', () => { clearTimeout(timer); resolve() })
      })
      pair(socket)
      return { address: '', stop }
    } catch (error) {
      socket.destroy()
      stop()
      throw error
    }
  }
  server = net.createServer(pair)
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    server.on('error', stop)
    return { address: `127.0.0.1:${server.address().port}`, stop }
  } catch (error) {
    stop()
    throw error
  }
}

module.exports = { chooseTcpPunchPort, tcpSimOpen, bridgePunchedSocket }

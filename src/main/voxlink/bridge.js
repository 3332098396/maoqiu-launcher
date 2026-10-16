// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (c) 2026 毛球 (Maoqiu) · https://github.com/3332098396/maoqiu-launcher —— 移植/改编自 VoxLink，本文件按 LGPL-3.0 提供（见 THIRD_PARTY_NOTICES.md）
//
// 逐语句移植自 KAMUCL 的 `src/main/core/voxlink/bridge.ts`。
// 见 THIRD_PARTY_NOTICES.md —— 本文件**不适用**仓库根的 MIT，按 LGPL-3.0-only 提供。
//
// ⚠️ 许可上有一点要说清：KAMUCL 这个文件头部**自称 MIT**（"KAMUCL stream adapter"），
// 但它干的事对应上游 VoxLink 的 `P2PBridge.java`，而同目录里真正从 VoxLink 翻过来的那些
// 文件（punch/rudp/stun/tcpPunch…）它都老老实实标了 LGPL-3.0-only。
// **本项目按最保守的来**：一律标 LGPL-3.0-only，并把这一点记在 THIRD_PARTY_NOTICES.md 里。
//
// 干什么：**把游戏数据搬过那条"洞"**。
//
// 洞打出来的是一条「可靠 UDP 管道」（`rudp.js`），可游戏说的是 TCP。
// 这个文件就是中间那个搬运工：一头是游戏（本地 TCP），一头是那条管子（rudp），
// 两边来的字节原样倒给对方。
//
// 两种角色（**顺序不一样，别写反**）：
// - **房主** `startHostLazyBridge()`：洞通了之后**先卡住等**，等房客那边**先发过一段游戏数据**来
//   （说明他真的接进来了），**这时候才回头去连本机的游戏端口**。
//   反过来先连游戏会被立刻拒绝 —— 因为游戏那边此时还没人连。
//   连上之后，把先读到的那段数据**一个字节不少地补发**给游戏。
// - **房客** `TcpBridge.startGuest()`：开一个本机临时端口等着，
//   把 `127.0.0.1:<随机端口>` 交给界面，用户把它填进游戏的「加入服务器」。
//
// ⚠️ 上游还定义了 `BRIDGE_IDLE_TIMEOUT_MS`（30 秒没动静）和 `watchdogOnce()`，
// 但**上游整个项目里没有任何地方调用它** —— 是个空摆设，**它不会自动断线**。
// 我们原样保留（供以后接上），但别以为它在干活。
//
// §0 纪律：常量、守卫、顺序全部与 bridge.ts 一致，别自己改。

const net = require('node:net')

const BRIDGE_BUF_SIZE = 32768
const BRIDGE_IDLE_TIMEOUT_MS = 30000
const BRIDGE_DIAL_WINDOW_MS = 10000
const BRIDGE_DIAL_RETRY_MS = 1000
const BRIDGE_DIAL_TIMEOUT_MS = 2000

/** 上游第 8 行：把一段数据写完（写失败就抛），能 await */
async function send(socket, data) {
  await new Promise((resolve, reject) => socket.write(data, (error) => (error ? reject(error) : resolve())))
}

class TcpBridge {
  constructor(rc, down) {
    this.rc = rc
    this.down = down
    this.ln = undefined
    this.socket = undefined
    this.stopped = false
    this.activity = Date.now()
    // 管子那头断了，这边跟着收摊（上游同一行）
    rc.setOnClosed(() => this.stop())
  }

  touch() { this.activity = Date.now() }

  idleMs() { return Date.now() - this.activity }

  isStopped() { return this.stopped }

  stop() {
    if (this.stopped) return
    this.stopped = true
    this.ln?.close()
    this.socket?.destroy()
    this.rc.close()
    this.down?.()
  }

  setConn(socket) { this.socket?.destroy(); this.socket = socket; this.touch() }

  /** 上游第 20-25 行：房客 —— 开个本机临时端口，把地址交出去 */
  static async startGuest(rc, down) {
    const bridge = new TcpBridge(rc, down)
    const server = (bridge.ln = net.createServer((socket) => {
      // 已经有人连着了、或者已经收摊了，后来的一律拒掉（**这个守卫别删**）
      if (bridge.socket || bridge.stopped) { socket.destroy(); return }
      bridge.setConn(socket)
      void bridge.pump(socket)
    }))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', () => bridge.stop())
        resolve()
      })
    })
    return { addr: `127.0.0.1:${server.address().port}`, bridge }
  }

  /** 上游第 26-31 行：两个方向同时搬，**任意一头断了就整体收摊** */
  async pump(socket) {
    socket.setNoDelay(true)
    socket.on('error', () => this.stop())
    socket.once('close', () => this.stop())
    const upload = async () => {
      for await (const chunk of socket) {
        if (this.stopped) break
        this.touch()
        await this.rc.write(Buffer.from(chunk))
      }
    }
    const download = async () => {
      const buffer = Buffer.alloc(BRIDGE_BUF_SIZE)
      while (!this.stopped) {
        const length = await this.rc.read(buffer)
        if (!length) break
        this.touch()
        await send(socket, Buffer.from(buffer.subarray(0, length)))
      }
    }
    try { await Promise.race([upload(), download()]) } catch {} finally { this.stop() }
  }

  async watchdogOnce() { return this.stopped || this.idleMs() > BRIDGE_IDLE_TIMEOUT_MS }
}

/**
 * 上游第 34-45 行：房主这一支。
 *
 * 三步，**顺序不能换**：
 *   ① 先读一段（最多 32 KB）—— 读到了才说明房客接进来了；读不到（0）直接返回
 *   ② 在 10 秒窗口里反复去连本机游戏端口（每次 2 秒超时，失败隔 1 秒再试）
 *   ③ 连上以后，把 ① 读到的那段**原样补发**给游戏，然后开始对搬
 */
async function startHostLazyBridge(rc, port, log) {
  const first = Buffer.alloc(BRIDGE_BUF_SIZE)
  const length = await rc.read(first)
  if (!length) return
  const deadline = Date.now() + BRIDGE_DIAL_WINDOW_MS
  while (rc.isConnected() && Date.now() < deadline) {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { socket.destroy(); reject(new Error('本地游戏连接超时')) }, BRIDGE_DIAL_TIMEOUT_MS)
        socket.once('error', (error) => { clearTimeout(timeout); reject(error) })
        socket.once('connect', () => { clearTimeout(timeout); resolve() })
      })
      const bridge = new TcpBridge(rc, null)
      bridge.setConn(socket)
      await send(socket, first.subarray(0, length))
      await bridge.pump(socket)
      return
    } catch (error) {
      socket.destroy()
      log?.('warn', error.message)
      await new Promise((resolve) => setTimeout(resolve, BRIDGE_DIAL_RETRY_MS))
    }
  }
  rc.close()
}

/**
 * 上游第 46-51 行：**两条管子对倒**（玩家中继那条路用的，V3 才接得上）。
 * V4 用不着它；保留下来是为了以后接 V3 时这个文件是完整的。
 */
function pumpRelay(a, b) {
  let stopped = false
  const stop = () => { if (!stopped) { stopped = true; a.close(); b.close() } }
  const copy = async (source, target) => {
    try {
      const data = Buffer.alloc(BRIDGE_BUF_SIZE)
      while (!stopped) {
        const size = await source.read(data)
        if (!size) break
        await target.write(Buffer.from(data.subarray(0, size)))
      }
    } catch {} finally { stop() }
  }
  void copy(a, b)
  void copy(b, a)
  return stop
}

module.exports = {
  BRIDGE_BUF_SIZE, BRIDGE_IDLE_TIMEOUT_MS, BRIDGE_DIAL_WINDOW_MS, BRIDGE_DIAL_RETRY_MS, BRIDGE_DIAL_TIMEOUT_MS,
  TcpBridge, startHostLazyBridge, pumpRelay,
}

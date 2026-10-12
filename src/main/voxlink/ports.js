// 毛球 — VoxLink 联机 · 找游戏端口
//
// 【为什么需要这个】
// 联机要成立的最后一环是：**好友的游戏最终要连到"你的游戏"身上**。
// 而"你的游戏"在网络里就是一个**端口号**（比如 25565）。所以建房时必须知道
// "我现在这个游戏开在哪个端口"——不知道就没法把好友引过来。
//
// 这个端口哪来的？游戏里点「对局域网开放」之后，聊天栏会打出一行：
//     本地游戏已在端口 54321 上开放
// 那个 54321 就是它。端口每次开放都可能不一样，所以**不能写死，必须现查**。
//
// 【怎么查】两个办法配合：
//   ① 扫一遍本机正在监听的端口，挑出属于 java 进程的那些（"猜测"）
//   ② 拿到候选端口后，真的去连一下 127.0.0.1:那个端口（"确认"）
// 只做 ① 不够——本机上别的程序也可能开着端口。所以真正建房前一定走 ②。
//
// 【隐私】查进程时要读命令行（里面有 --username 之类）。**只看不记**：
// 这个文件不会把命令行写进日志，也不会传出去。
//
// SPDX-License-Identifier: LGPL-3.0-only
// 本文件按 VoxLink（LGPL-3.0）的行为改写，来源与许可见 THIRD_PARTY_NOTICES.md

const net = require('node:net')
const { execFile } = require('node:child_process')

/** 把一条外部命令跑完，拿它的输出。超时 8 秒，输出最多 4 MB。 */
function capture(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (error, out) => {
      if (error) reject(error)
      else resolve(out)
    })
  })
}

/**
 * 扫出"可能是 Minecraft 的监听端口"，按端口号从小到大。
 *
 * 判断依据：进程是 java.exe / javaw.exe，且命令行里带着 minecraft / fabric /
 * forge / quilt / net.minecraft 这些字样——正常启动的游戏都有。
 */
async function detectMcPorts() {
  const found = []

  if (process.platform === 'win32') {
    // 一条 PowerShell 搞定两件事：先挑出"像 Minecraft 的 java 进程"，
    // 再问系统"这些进程都占了哪些监听端口"。
    const query =
      "$p = @(Get-CimInstance Win32_Process -Filter \"Name = 'java.exe' OR Name = 'javaw.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'minecraft|fabric|forge|quilt|net\\.minecraft' } | " +
      "ForEach-Object { $_.ProcessId }); " +
      '@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ' +
      'Where-Object { $p -contains $_.OwningProcess } | Select-Object LocalPort,OwningProcess) | ' +
      'ConvertTo-Json -Compress'
    const raw = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query])
    const values = raw.trim() ? JSON.parse(raw) : []
    for (const row of Array.isArray(values) ? values : [values]) {
      found.push({ port: Number(row.LocalPort), pid: Number(row.OwningProcess) })
    }
  } else {
    const processes = await capture('ps', ['-axo', 'pid=,command='])
    const pids = new Set()
    for (const line of processes.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.*)$/)
      if (match && /java/i.test(match[2]) && /minecraft|fabric|forge|quilt/i.test(match[2])) pids.add(Number(match[1]))
    }
    if (pids.size) {
      const listing = await capture('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])
      let pid = 0
      for (const line of listing.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1))
        if (line.startsWith('n') && pids.has(pid)) {
          const port = Number(line.match(/:(\d+)$/)?.[1])
          found.push({ port, pid })
        }
      }
    }
  }

  // 去重（同一个端口可能被报两遍）+ 把明显不靠谱的丢掉（端口号得是 1~65535）
  return [
    ...new Map(
      found
        .filter((row) => Number.isInteger(row.port) && row.port > 0 && row.port <= 65535 && row.pid > 0)
        .map((row) => [`${row.pid}:${row.port}`, row])
    ).values()
  ].sort((a, b) => a.port - b.port)
}

/**
 * 确认某个端口上**真的有东西在听**。
 *
 * 只是"去连一下"：连上了就说明端口是活的，连不上就说明没开。
 * 这一步不做的话，会出现"房间建出来了，好友进来却连不上"这种最气人的情况——
 * 因为房间指向了一个根本没在听的端口。
 *
 * @param {number} port 要确认的端口
 * @param {number} [timeoutMs] 等多久算没开（默认 1.5 秒——本机连接要不了这么久）
 */
async function probeHostPort(port, timeoutMs = 1500) {
  if (!port) throw new Error('请先启动游戏并对局域网开放世界')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('请填写游戏中显示的有效端口（1–65535）')
  }
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => finish(new Error('请先启动游戏并对局域网开放世界')), timeoutMs)
    const finish = (error) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.once('connect', () => finish())
    socket.once('error', () => finish(new Error('请先启动游戏并对局域网开放世界')))
  })
}

module.exports = { detectMcPorts, probeHostPort }

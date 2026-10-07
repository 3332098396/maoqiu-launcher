// MC启动器 — 简单的 HTTP 请求
//
// 【为什么不用第三方库（axios / node-fetch 之类）】
// 我们只需要"给我一个网址，把内容拿回来"这一件事，外加超时和跳转跟随。
// Node 自带的模块几十行就能写完，没必要为此引入一个依赖——
// 依赖越少，这个非程序员维护的项目坏掉的概率越小。
//
// 【为什么必须自己处理跳转】
// Node 自带的 https.get **不会**自动跟随 302 跳转，它会把跳转响应直接给你。
// 而 Mojang 和国内镜像都会跳转（镜像甚至会跳到它自己的对象存储），
// 不处理的话拿到的是一个空响应，还会以为"下载成功了"。

const https = require('node:https')
const http = require('node:http')

/** 有些服务器会因为缺少 User-Agent 而拒绝请求，统一带一个 */
const USER_AGENT = 'MCLauncher/0.1 (local)'

/**
 * 下载一个地址，返回它的全部内容。
 *
 * @param {string} url
 * @param {{timeout?: number, onProgress?: (received: number, total: number) => void}} options
 * @returns {Promise<Buffer>}
 */
function fetchBuffer(url, options = {}) {
  const { timeout = 30000, onProgress } = options
  return request(url, { timeout, onProgress, redirectsLeft: 5 })
}

function request(url, options) {
  const { timeout, onProgress, redirectsLeft } = options

  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`地址格式不对：${url}`))
      return
    }

    const client = parsed.protocol === 'https:' ? https : http

    const req = client.get(
      parsed,
      { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } },
      (res) => {
        // —— 跳转：跟过去 ——
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume() // 扔掉响应体，否则连接不会释放

          if (redirectsLeft <= 0) {
            reject(new Error('跳转次数太多，可能陷入了循环'))
            return
          }

          // location 可能是相对路径，用 new URL(..., 当前地址) 解析成绝对地址
          const next = new URL(res.headers.location, url).toString()
          resolve(request(next, { ...options, redirectsLeft: redirectsLeft - 1 }))
          return
        }

        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`服务器返回 ${res.statusCode}`))
          return
        }

        const total = Number(res.headers['content-length']) || 0
        const chunks = []
        let received = 0

        res.on('data', (chunk) => {
          chunks.push(chunk)
          received += chunk.length
          if (onProgress) onProgress(received, total)
        })

        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }
    )

    req.on('error', (error) => reject(new Error(`连不上服务器：${error.message}`)))
    req.setTimeout(timeout, () => {
      req.destroy(new Error('等太久了，连接超时'))
    })
  })
}

/** 下载一个地址，当作 UTF-8 文本返回 */
async function fetchText(url, options) {
  const buffer = await fetchBuffer(url, options)
  return buffer.toString('utf8')
}

/** 下载一个地址，当作 JSON 解析后返回 */
async function fetchJson(url, options) {
  const text = await fetchText(url, options)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('服务器返回的不是合法数据（可能被网络拦截了）')
  }
}

module.exports = { fetchBuffer, fetchText, fetchJson }

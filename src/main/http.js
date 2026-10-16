// SPDX-License-Identifier: MIT
// 毛球 (Maoqiu) © 2026 · https://github.com/3332098396/maoqiu-launcher · 转载、改编、打包都请保留本行署名
// 毛球 — 简单的 HTTP 请求
//
// 【为什么不用第三方库（axios / node-fetch 之类）】
// 我们只需要两件事：① 拿回一小段内容（JSON）② 把一个大文件流式写到硬盘。
// Node 自带的模块几十行就能写完，没必要为此引入依赖——
// 依赖越少，这个非程序员维护的项目坏掉的概率越小。
//
// 【为什么必须自己处理跳转】
// Node 自带的 https.get **不会**自动跟随 302 跳转，它会把跳转响应直接给你。
// 而 Mojang 和国内镜像都会跳转（镜像甚至会跳到它自己的对象存储），
// 不处理的话拿到的是一个空响应，还会以为"下载成功了"。

const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')

/**
 * 有些服务器会因为缺少 User-Agent 而拒绝请求，统一带一个。
 * Modrinth 的接口文档明确要求带一个能认出是谁的标识，别用浏览器默认的。
 */
const USER_AGENT = 'MaoqiuLauncher/0.1.0 (local Minecraft launcher)'

/** 跳转最多跟几次，防止陷入循环 */
const MAX_REDIRECTS = 5

/**
 * 打开一个下载流。拿到响应后由调用方决定是"全部读进内存"还是"写进文件"。
 *
 * @param {string} url
 * @param {{timeout?: number, signal?: AbortSignal, redirectsLeft?: number,
 *          headers?: object}} options
 * @returns {Promise<{stream: import('node:stream').Readable, total: number,
 *                    statusCode: number, headers: object}>}
 *          total 是服务器声明的内容长度；服务器没给就是 0。
 *          statusCode 206 表示服务器**只给了我们要的那一段**（断点续传时用）
 */
function openStream(url, options = {}) {
  const { timeout = 30000, signal, redirectsLeft = MAX_REDIRECTS, headers = {} } = options

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
      { headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers }, signal },
      (res) => {
        // —— 跳转：跟过去 ——
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume() // 扔掉响应体，否则连接不会释放

          if (redirectsLeft <= 0) {
            reject(new Error('跳转次数太多，可能陷入了循环'))
            return
          }

          // location 可能是相对路径，用 new URL(..., 当前地址) 解析成绝对地址
          let next
          try {
            next = new URL(res.headers.location, url).toString()
          } catch {
            reject(new Error('服务器给了个看不懂的跳转地址'))
            return
          }

          resolve(openStream(next, { ...options, redirectsLeft: redirectsLeft - 1 }))
          return
        }

        // 200 = 整份内容；206 = "你要的那一段"（我们把 Range 头带上了才可能收到它）
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume()
          reject(new HttpError(res.statusCode))
          return
        }

        resolve({
          stream: res,
          total: Number(res.headers['content-length']) || 0,
          statusCode: res.statusCode,
          headers: res.headers
        })
      }
    )

    req.on('error', (error) => {
      // 主动取消不算"连不上"，要说清楚，否则用户看到的是莫名其妙的报错
      if (error.name === 'AbortError') {
        reject(new Error('已取消'))
        return
      }
      reject(new Error(`连不上服务器：${error.message}`))
    })

    req.setTimeout(timeout, () => {
      req.destroy(new Error('等太久了，连接超时'))
    })
  })
}

/**
 * 带 HTTP 状态码的错误，方便调用方判断"是 404 还是网络问题"。
 * body / text 是服务器回的原文——**出错时说人话全靠它**：
 * 比如外置登录密码错了，服务器会在响应体里写明原因，光看状态码看不错来。
 */
class HttpError extends Error {
  constructor(statusCode, body = null, text = '') {
    super(`服务器返回 ${statusCode}`)
    this.statusCode = statusCode
    this.body = body
    this.text = text
  }
}

/**
 * POST 一段内容，把响应当 JSON 读回来。
 *
 * 【为什么不复用上面的 openStream】那个只走 GET。
 * 【为什么失败也要把响应体读回来】登录接口出错时会在响应体里写清楚原因
 * （账号密码不对、令牌过期、应用没登记……），只看状态码分不出是哪种。
 *
 * @param {object|null} payload JSON 内容（用 body 直接给内容时传 null）
 * @param {{body?: Buffer, contentType?: string}} options
 */
function post(url, payload, options = {}) {
  const {
    timeout = 30000,
    signal,
    headers = {},
    contentType = 'application/json; charset=utf-8',
    body,
    // 【为什么要能换方法】微软那套接口里有 PUT（换披风）和 DELETE（取消披风），
    // 逻辑和 POST 一模一样，只有动词不同——没必要为它们各写一遍
    method = 'POST'
  } = options

  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`地址格式不对：${url}`))
      return
    }

    const client = parsed.protocol === 'https:' ? https : http
    const data = body || Buffer.from(JSON.stringify(payload ?? {}), 'utf8')

    const req = client.request(
      parsed,
      {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          'Content-Type': contentType,
          'Content-Length': data.length,
          ...headers
        },
        signal
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body = null
          try {
            body = JSON.parse(text)
          } catch {
            // 不是 JSON（比如被网络中间人换成了网页）——调用方看 text
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body ?? {})
            return
          }
          reject(new HttpError(res.statusCode, body, text))
        })
      }
    )

    req.on('error', (error) => {
      if (error.name === 'AbortError') {
        reject(new Error('已取消'))
        return
      }
      reject(new Error(`连不上服务器：${error.message}`))
    })

    req.setTimeout(timeout, () => {
      req.destroy(new Error('等太久了，连接超时'))
    })

    req.write(data)
    req.end()
  })
}

/**
 * 下载一个地址，把内容全部读进内存返回。
 * 只适合小文件（JSON、图标之类）——大文件请用 openStream 流式写盘。
 */
async function fetchBuffer(url, options = {}) {
  const { onProgress } = options
  const { stream, total } = await openStream(url, options)

  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0

    stream.on('data', (chunk) => {
      chunks.push(chunk)
      received += chunk.length
      if (onProgress) onProgress(received, total)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/** POST 一个 JSON（登录接口用） */
function postJson(url, payload, options = {}) {
  return post(url, payload, options)
}

/**
 * POST 一个表单。
 * 【为什么要单独一个】微软换令牌那个接口**只收表单格式**，发 JSON 会被拒。
 * 这是 OAuth 的规矩，不是微软的怪癖。
 */
function postForm(url, fields, options = {}) {
  const body = Buffer.from(new URLSearchParams(fields).toString(), 'utf8')
  return post(url, null, {
    ...options,
    body,
    contentType: 'application/x-www-form-urlencoded; charset=utf-8'
  })
}

/** PUT 一个 JSON（微软那套接口里换披风用的是 PUT） */
function putJson(url, payload, options = {}) {
  return post(url, payload, { ...options, method: 'PUT' })
}

/** DELETE（取消披风用的是它）。微软这个接口不要请求体 */
function del(url, options = {}) {
  return post(url, null, { ...options, method: 'DELETE', body: Buffer.alloc(0) })
}

/** 下载一个地址，当作 UTF-8 文本返回 */
async function fetchText(url, options) {
  return (await fetchBuffer(url, options)).toString('utf8')
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

module.exports = { openStream, fetchBuffer, fetchText, fetchJson, post, postJson, postForm, putJson, del, HttpError, USER_AGENT }

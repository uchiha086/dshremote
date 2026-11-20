import crypto from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { svgOf } from './qr.mjs'
import { createWebSocketServer } from './websocket.mjs'

/** 桥插件版本，手机端据此判断兼容性。 */
const BRIDGE_VERSION = '0.1.0'

/** WebSocket 子协议标识，握手时就固定，避免手机连到别的服务上。 */
const WS_PROTOCOL = 'dshremote-bridge-v1'

/** 鉴权超时：连上后必须在这段时间内发 auth 帧，否则断开。 */
const AUTH_TIMEOUT_MS = 10_000

/** 心跳间隔。 */
const HEARTBEAT_MS = 30_000

/** 最近事件最多留多少条，供 /events 调试与手机补拉。 */
const EVENT_BUFFER = 100

const DEFAULT_OPTIONS = {
  enabled: true,
  port: 3088,
  bind: '0.0.0.0',
  token: '',
  proxyEnabled: true,
  proxyPort: 7627,
  upstreamHost: '127.0.0.1',
  upstreamPort: 7626,
  answerHeadChars: 120,
  questionChars: 200,
  logFile: '',
  tokenFile: '',
  hostsFile: '',
  extraHosts: [],
  // 当前对外的公网地址（Cloudflare 隧道域名等）；隧道地址会变，所以既能写配置也能运行时通过 /public 存入文件。
  publicUrl: '',
  publicUrlFile: '',
  // 局域网自动发现：往 3089 端口广播自己，手机 App 监听即可自动列出电脑，不用手填 IP。
  discovery: true,
  discoveryPort: 3089,
}

/** 读已保存的 token；只认长十六进制串，避免把脏内容当口令用。 */
function readToken(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    return /^[a-f0-9]{16,128}$/i.test(text) ? text : ''
  } catch {
    return ''
  }
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir()
}

function expandHome(p) {
  if (!p) return ''
  if (p === '~') return homeDir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir(), p.slice(2))
  return p
}

/** 从 content block 数组里抽纯文本；官方把正文拆成 text / reasoning / tool-call 等块。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

function trimText(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!limit || flat.length <= limit) return flat
  return `${flat.slice(0, limit)}…`
}

/** 本机所有非回环 IPv4 与本机名，用来拼 DSH Host 围栏认的 authority。 */
function localAuthorities(ports) {
  const hosts = new Set(['localhost', '127.0.0.1', os.hostname()])
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list ?? []) {
        if (item && item.family === 'IPv4' && !item.internal) hosts.add(item.address)
      }
    }
  } catch {
    // 拿不到网卡就只留 localhost。
  }
  const out = []
  for (const host of hosts) {
    for (const port of ports) {
      if (Number.isFinite(port) && port > 0) out.push(`${host}:${port}`)
    }
  }
  return out
}

/** turn/end 的 reason.kind 归一成手机端认识的三种状态。 */
function normalizeStatus(reason) {
  const kind = String(reason?.kind ?? '').toLowerCase()
  if (/error|fail|crash/.test(kind)) return 'failed'
  if (/interrupt|cancel|abort|stop|user/.test(kind)) return 'cancelled'
  return 'done'
}

export function apply(ctx, config) {
  const options = { ...DEFAULT_OPTIONS, ...(config ?? {}) }
  if (!options.enabled) return

  const logFile = expandHome(options.logFile) || path.join(homeDir(), '.dsh', 'dshremote-bridge.log')
  // token 要跨重启稳定：优先用配置里的，其次沿用上次落盘的，最后才随机生成。
  const tokenFile = expandHome(options.tokenFile) || path.join(homeDir(), '.dsh', 'dshremote-bridge.token')
  const token = String(options.token ?? '').trim() || readToken(tokenFile) || crypto.randomBytes(16).toString('hex')

  // DSH Web 每次启动端口可能不同（7626、10628…），以宿主 webServer 实际端口为准。
  const webPort = Number(ctx.webServer?.port)
  const upstreamPort = Number.isFinite(webPort) && webPort > 0 ? webPort : options.upstreamPort

  // DSH Web 用「进程启动令牌 + 按 authority 绑定的 cookie」鉴权：打开带 ?token= 的地址会下发 cookie。
  // 这里借宿主的 BrowserAuth 帮手机生成一次这样的地址，手机打开一次之后 cookie 就长期有效。
  const browserAuth = ctx.connection?.browserAuth ?? null

  // DSH 的 Host 围栏只放行回环、监听 bind IP 和 trustedHosts；手机走局域网 authority 会被 403。
  // 把本机各网卡 IPv4（桥端口 + 反代端口）注册进去，避免写死某个 IP。
  const trustedList = ctx.connection?.trustedHosts
  const hostsFile = expandHome(options.hostsFile) || path.join(homeDir(), '.dsh', 'dshremote-bridge.hosts')
  const publicUrlFile = expandHome(options.publicUrlFile) || path.join(homeDir(), '.dsh', 'dshremote-bridge.public')

  /** 读上次落盘的公网地址（隧道域名重启会变，靠它记住最近一次）。 */
  function readPublicUrl() {
    try {
      const text = fs.readFileSync(publicUrlFile, 'utf8').trim()
      return /^https?:\/\/[^\s]+$/i.test(text) ? text : ''
    } catch {
      return ''
    }
  }

  function writePublicUrl(value) {
    try {
      fs.mkdirSync(path.dirname(publicUrlFile), { recursive: true })
      fs.writeFileSync(publicUrlFile, `${value}\n`, 'utf8')
    } catch (error) {
      log(`公网地址落盘失败：${error?.message ?? error}`)
    }
  }

  let publicUrl = String(options.publicUrl ?? '').trim().replace(/\/+$/, '') || readPublicUrl()

  /**
   * 本机联网用的 IPv4（不含回环），按"手机更可能连上"的顺序排。
   * Windows 上常同时有 WLAN、VirtualBox、WSL/VMware 虚拟网卡，虚拟网卡的地址手机根本到不了，
   * 所以先靠一次 UDP connect 问出系统真正走默认路由的网卡地址，再按网卡名给其余地址打分。
   */
  let primaryIp = ''

  function detectPrimaryIp() {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4')
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        try {
          socket.close()
        } catch {
          // 已经关掉了。
        }
        resolve(value)
      }
      socket.on('error', () => done(''))
      socket.connect(53, '223.5.5.5', () => {
        try {
          done(String(socket.address()?.address ?? ''))
        } catch {
          done('')
        }
      })
      setTimeout(() => done(''), 400)
    })
  }

  function lanAddresses() {
    const preferName = [/wlan|wi-?fi|无线/i]
    const avoidName = [/virtualbox|vmware|hyper-v|vethernet|docker|loopback|bluetooth|蓝牙|tap|tun|npcap|tailscale/i]
    const items = []
    try {
      for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const item of list ?? []) {
          if (!item || item.family !== 'IPv4' || item.internal) continue
          let score = 0
          if (item.address === primaryIp) score += 100
          if (preferName.some((re) => re.test(name))) score += 10
          if (avoidName.some((re) => re.test(name))) score -= 10
          if (/^192\.168\./.test(item.address)) score += 3
          if (/^169\.254\./.test(item.address)) score -= 5
          items.push({ address: item.address, score })
        }
      }
    } catch {
      // 拿不到网卡就当没有局域网地址。
    }
    items.sort((a, b) => b.score - a.score)
    return items.map((item) => item.address)
  }

  /** 请求是从公网（隧道域名）进来的吗——只影响二维码里优先给哪个地址。 */
  function looksPublic(host) {
    const name = String(host ?? '').split(':')[0].toLowerCase()
    if (!name) return false
    if (name === 'localhost' || name === '127.0.0.1') return false
    if (/^10\./.test(name) || /^192\.168\./.test(name)) return false
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(name)) return false
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(name)) return false
    return true
  }

  /**
   * 生成配对信息：局域网地址 + 公网地址都给，二维码里编码"当下最该用的那个"。
   * 手机扫到后写入配置，就不用再手抄 IP 和 token。
   */
  function pairing(hostHeader) {
    const ips = lanAddresses()
    const ip = ips[0] ?? '127.0.0.1'
    const lanAll = ips.length > 0
      ? ips.map((address) => ({ base: `http://${address}:${options.port}`, web: `http://${address}:${options.proxyPort}` }))
      : [{ base: `http://${ip}:${options.port}`, web: `http://${ip}:${options.proxyPort}` }]
    const lan = lanAll[0]
    const pub = publicUrl ? { base: publicUrl, web: publicUrl } : null
    const choosePublic = pub && looksPublic(hostHeader)
    const target = choosePublic ? pub : lan
    const payload = `dshremote://pair?v=1&name=${encodeURIComponent(os.hostname())}&base=${encodeURIComponent(target.base)}&web=${encodeURIComponent(target.web)}&token=${token}`
    return { name: os.hostname(), lan, lanAll, public: pub, target, payload }
  }

  /** 手机扫码/自动发现后要能连上，这里统一给一份 JSON。 */
  function pairingJson(hostHeader) {
    const info = pairing(hostHeader)
    return {
      ok: true,
      v: 1,
      name: info.name,
      payload: info.payload,
      base: info.target.base,
      web: info.target.web,
      lan: info.lan,
      lanAll: info.lanAll,
      public: info.public,
      proxyPort: options.proxyPort,
    }
  }

  /** 把一个 authority（host 或 host:port）登记进 DSH 的白名单；重复登记无害。 */
  function trustHost(authority) {
    const value = String(authority ?? '').trim().toLowerCase()
    if (!value || !Array.isArray(trustedList)) return false
    if (!trustedList.includes(value)) trustedList.push(value)
    return true
  }

  /** 把 tunnel / 公网 host 记到文件，Desktop 重启后自动放行（隧道域名每次会变，靠它续命）。 */
  function rememberHost(authority) {
    const value = String(authority ?? '').trim().toLowerCase()
    if (!value) return
    try {
      const existing = fs.existsSync(hostsFile) ? fs.readFileSync(hostsFile, 'utf8') : ''
      const lines = existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      if (lines.includes(value)) return
      fs.mkdirSync(path.dirname(hostsFile), { recursive: true })
      fs.writeFileSync(hostsFile, `${[...lines, value].join('\n')}\n`, 'utf8')
    } catch (error) {
      log(`host 落盘失败：${error?.message ?? error}`)
    }
  }

  function rememberedHosts() {
    const wanted = []
    if (Array.isArray(options.extraHosts)) wanted.push(...options.extraHosts)
    try {
      const text = fs.existsSync(hostsFile) ? fs.readFileSync(hostsFile, 'utf8') : ''
      for (const line of text.split(/\r?\n/)) wanted.push(line)
    } catch {
      // 文件读不了就当没有。
    }
    return wanted
  }

  if (Array.isArray(trustedList)) {
    for (const authority of [...localAuthorities([options.port, options.proxyPort, upstreamPort]), ...rememberedHosts()]) {
      const value = String(authority ?? '').trim().toLowerCase()
      if (value && !trustedList.includes(value)) trustedList.push(value)
    }
  }

  function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`
    console.log(`[dshremote-bridge] ${message}`)
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      fs.appendFileSync(logFile, `${line}\n`, 'utf8')
    } catch {
      // 日志写不进去不该拖垮宿主。
    }
  }

  /** 会话状态：标题、最后一次提问、当前回合的回复文本。 */
  const sessions = new Map()
  const clients = new Set()
  const events = []
  const startedAt = Date.now()

  function pushEvent(frame) {
    events.push(frame)
    if (events.length > EVENT_BUFFER) events.shift()
  }

  function broadcast(frame) {
    if (clients.size === 0) return
    const payload = JSON.stringify(frame)
    for (const client of clients) {
      if (!client.authed) continue
      if (client.ws.closed) continue
      if (!client.ws.send(payload)) {
        log(`发送失败 peer=${client.peer}`)
      }
    }
  }

  function sessionState(id) {
    let state = sessions.get(id)
    if (!state) {
      state = { id, title: '', question: '', answer: '', running: false, turn: 0, updatedAt: Date.now() }
      sessions.set(id, state)
    }
    return state
  }

  function onSessionEvent(session, event) {
    const id = String(session?.id ?? '')
    if (!id || !event) return
    const data = event.data ?? {}
    const state = sessionState(id)
    state.updatedAt = Date.now()

    switch (event.type) {
      case 'session/title': {
        const title = typeof data.title === 'string' ? data.title : ''
        if (title) state.title = title
        break
      }
      case 'user/message': {
        const text = textOf(data.content).trim()
        if (text) state.question = text
        state.answer = ''
        break
      }
      case 'assistant/message': {
        const text = textOf(data.message?.content).trim()
        if (text) state.answer = text
        break
      }
      case 'turn/start': {
        state.running = true
        state.answer = ''
        state.turn = Number(data.turn ?? state.turn) || state.turn
        break
      }
      case 'turn/end': {
        state.running = false
        state.turn = Number(data.turn ?? state.turn) || state.turn
        const frame = {
          type: 'turn_end',
          id: `turn-${id}-${event.seq ?? Date.now()}`,
          ts: Date.now(),
          sessionId: id,
          sessionTitle: state.title || '',
          question: trimText(state.question, options.questionChars),
          answerHead: trimText(state.answer, options.answerHeadChars),
          status: normalizeStatus(data.reason),
          turn: state.turn,
          seq: event.seq ?? null,
        }
        pushEvent(frame)
        broadcast(frame)
        log(`turn_end session=${id} status=${frame.status} answer=${frame.answerHead.length}字`)
        break
      }
      default:
        break
    }
  }

  // 回合状态兜底：拿不到 turn/end 时，至少知道会话是否还在跑。
  function onSessionStatus(sessionId, running) {
    const state = sessionState(String(sessionId))
    state.running = Boolean(running)
    state.updatedAt = Date.now()
  }

  const disposeEvents = ctx.on('session/event', onSessionEvent)
  const disposeStatus = ctx.on('api-session/status', onSessionStatus)

  /** 顺着带 tokened 的地址打一次上游，把 Set-Cookie 取回来（手机端自己设 cookie，绕开 WebView 的 SameSite 策略）。
   *  Host 头必须写成手机将来访问用的 authority（比如 192.168.68.225:7627），
   *  因为 DSH 签的 cookie 里带着 authority，校验时要求与请求的 Host 一致。 */
  function fetchAuthCookie(authedUrl, authority) {
    return new Promise((resolve) => {
      let target
      try {
        target = new URL(authedUrl)
      } catch {
        resolve('')
        return
      }
      const hostHeader = authority && authority.length > 0 ? authority : `${options.upstreamHost}:${upstreamPort}`
      const req = http.request(
        {
          host: options.upstreamHost,
          port: upstreamPort,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { host: hostHeader },
        },
        (res) => {
          const raw = res.headers['set-cookie']
          res.resume()
          const list = Array.isArray(raw) ? raw : raw ? [raw] : []
          const first = list.find((item) => item.startsWith('dsh-auth-'))
          resolve(first ? first.split(';')[0] : '')
        },
      )
      req.setTimeout(5000, () => {
        req.destroy()
        resolve('')
      })
      req.on('error', () => resolve(''))
      req.end()
    })
  }

  /** 把非桥自身路由的请求原样转给 DSH。
   *  Host 头**不改写**：隧道访问时 Host 是公网域名，DSH 的 cookie 与 trustedHosts 都按它来校验。 */
  function proxyRequest(request, response) {
    const headers = { ...request.headers }
    if (!headers.host) headers.host = `${options.upstreamHost}:${upstreamPort}`
    const upstreamRequest = http.request(
      {
        host: options.upstreamHost,
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    upstreamRequest.on('error', (error) => {
      log(`HTTP 反代上游错误 ${error?.message ?? error}`)
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('bridge: upstream unreachable')
      } else {
        response.destroy()
      }
    })
    request.pipe(upstreamRequest)
  }

  /** 非 /ws 的 WebSocket 升级（DSH 自己的长连接）也照原样透传。 */
  function proxyUpgrade(request, socket, head) {
    const upstream = net.connect({ host: options.upstreamHost, port: upstreamPort }, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`]
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head && head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    const close = () => {
      socket.destroy()
      upstream.destroy()
    }
    socket.on('error', close)
    upstream.on('error', (error) => {
      log(`WS 反代上游错误 ${error?.message ?? error}`)
      close()
    })
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (url.pathname === '/health') {
      const body = JSON.stringify({
        ok: true,
        service: 'dshremote-bridge',
        version: BRIDGE_VERSION,
        protocol: 1,
        uptimeMs: Date.now() - startedAt,
        clients: [...clients].filter((client) => client.authed).length,
        sessions: sessions.size,
        proxy: options.proxyEnabled ? options.proxyPort : null,
      })
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(body)
      return
    }

    if (url.pathname === '/auth/url') {
      if (url.searchParams.get('token') !== token) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'bad-token' }))
        return
      }
      if (!browserAuth?.authenticatedUrl) {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'browser-auth-unavailable' }))
        return
      }
      const hostname = String(request.headers.host ?? '127.0.0.1:0').split(':')[0]
      const base = url.searchParams.get('base') || `http://${hostname}:${options.proxyPort}/`
      try {
        const authenticated = browserAuth.authenticatedUrl(base)
        log(`签发 DSH Web 登录地址 authority=${base}`)
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ ok: true, url: authenticated }))
      } catch (error) {
        log(`签发登录地址失败：${error?.message ?? error}`)
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'failed' }))
      }
      return
    }

    if (url.pathname === '/auth/cookie') {
      if (url.searchParams.get('token') !== token) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'bad-token' }))
        return
      }
      if (!browserAuth?.authenticatedUrl) {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'browser-auth-unavailable' }))
        return
      }
      const baseParam = url.searchParams.get('base')
      let authority = String(request.headers.host ?? `127.0.0.1:${options.proxyPort}`)
      let target = `http://${String(authority).split(':')[0]}:${options.proxyPort}/`
      if (baseParam) {
        try {
          const parsedBase = new URL(baseParam)
          if (parsedBase.host) {
            authority = parsedBase.host
            // 隧道是 https 且没有端口，直接用手机给的 base 当目标，别硬拼 7627。
            target = `${parsedBase.origin}/`
          }
        } catch {
          // base 解析不出来就用请求本身的 Host
        }
      }
      const authed = browserAuth.authenticatedUrl(target)
      fetchAuthCookie(authed, authority).then((cookie) => {
        if (!cookie) {
          response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: false, error: 'no-cookie' }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ ok: true, url: target, cookie }))
      })
      return
    }

    if (url.pathname === '/events') {
      if (url.searchParams.get('token') !== token) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'bad-token' }))
        return
      }
      // since=<ts> 只回比它更新的事件，手机轮询时用它去重，避免每轮重发旧通知。
      const since = Number(url.searchParams.get('since') ?? '')
      const list = Number.isFinite(since) && since > 0 ? events.filter((frame) => Number(frame.ts) > since) : events
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, events: list }))
      return
    }

    if (url.pathname === '/trust') {
      if (url.searchParams.get('token') !== token) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'bad-token' }))
        return
      }
      const host = String(url.searchParams.get('host') ?? '').trim()
      if (!host) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'missing-host' }))
        return
      }
      const added = trustHost(host)
      rememberHost(host)
      log(`信任 host ${host}${added ? '' : '（trustedHosts 不可写）'}`)
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, host, trusted: Array.isArray(trustedList) ? trustedList.length : 0 }))
      return
    }

    if (url.pathname === '/pair') {
      // 本地（回环/局域网）扫码本来就该拿到 token；从公网转发进来则要求带上 token，避免把口令送到隧道里。
      const host = String(request.headers.host ?? '')
      if (looksPublic(host) && url.searchParams.get('token') !== token) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'bad-token' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(pairingJson(host)))
      return
    }

    if (url.pathname === '/pair.svg' || url.pathname === '/pair.png') {
      const host = String(request.headers.host ?? '')
      if (looksPublic(host) && url.searchParams.get('token') !== token) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'bad-token' }))
        return
      }
      try {
        const svg = svgOf(pairing(host).payload, { scale: 8, margin: 4 })
        response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
        response.end(svg)
      } catch (error) {
        log(`二维码生成失败：${error?.message ?? error}`)
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'qr-failed' }))
      }
      return
    }

    if (url.pathname === '/pair.html') {
      const host = String(request.headers.host ?? '')
      const info = pairing(host)
      const tokenParam = url.searchParams.get('token')
      const suffix = tokenParam ? `?token=${encodeURIComponent(tokenParam)}` : ''
      const publicNote = info.public ? `公网地址：${info.public.base}` : '公网地址：未设置（只在局域网内可扫）'
      const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DSH Remote 配对</title>
<style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:32px;background:#0f1626;color:#e8eefc;display:flex;flex-direction:column;align-items:center}
h1{font-size:20px;margin:0 0 6px}p{margin:4px 0;font-size:13px;color:#9fb0d0}
.card{background:#fff;padding:16px;border-radius:16px;margin:18px 0}
code{font-size:11px;word-break:break-all;background:#1b2438;padding:10px;border-radius:8px;display:block;max-width:520px}
</style></head><body>
<h1>用手机 App 扫这个码</h1>
<p>App 首页 →「扫一扫」→ 对准屏幕。扫完会自动填好地址与 token。</p>
<div class="card"><img src="/pair.svg${suffix}" width="280" height="280" alt="pairing qr"/></div>
<p>${publicNote}</p>
<code>${info.payload}</code>
</body></html>`
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
      return
    }

    if (url.pathname === '/public') {
      if (url.searchParams.get('token') !== token) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'bad-token' }))
        return
      }
      const value = String(url.searchParams.get('url') ?? '').trim()
      if (value) {
        if (!/^https?:\/\/[^\s/]+/i.test(value)) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: false, error: 'bad-url' }))
          return
        }
        publicUrl = value.replace(/\/+$/, '')
        writePublicUrl(publicUrl)
        log(`公网地址=${publicUrl}`)
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, public: publicUrl || null }))
      return
    }

    // 其余路径原样转给 DSH：这样一条隧道（指向 3088）就能同时当网页入口和控制接口用。
    proxyRequest(request, response)
  })

  const wss = createWebSocketServer(server, { path: '/ws', protocol: WS_PROTOCOL, fallback: proxyUpgrade })

  wss.on('connection', (ws, request) => {
    const client = {
      ws,
      authed: false,
      deviceName: 'unknown',
      peer: request.socket.remoteAddress ?? 'unknown',
      connectedAt: Date.now(),
    }
    clients.add(client)
    log(`WS 连接 ${client.peer}`)

    const authTimer = setTimeout(() => {
      if (!client.authed) {
        log(`鉴权超时，断开 ${client.peer}`)
        ws.close(4001, 'auth-timeout')
      }
    }, AUTH_TIMEOUT_MS)

    ws.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!frame || typeof frame !== 'object') return

      if (frame.type === 'auth') {
        const provided = typeof frame.token === 'string' ? frame.token : ''
        const a = Buffer.from(provided)
        const b = Buffer.from(token)
        const same = a.length === b.length && crypto.timingSafeEqual(a, b)
        if (!same) {
          log(`鉴权失败 ${client.peer}`)
          ws.send(JSON.stringify({ type: 'error', code: 'bad-token' }))
          ws.close(4003, 'bad-token')
          return
        }
        client.authed = true
        client.deviceName = typeof frame.deviceName === 'string' ? frame.deviceName.slice(0, 64) : 'unknown'
        clearTimeout(authTimer)
        ws.send(JSON.stringify({
          type: 'hello',
          protocol: 1,
          bridgeVersion: BRIDGE_VERSION,
          host: os.hostname(),
          now: Date.now(),
          proxyPort: options.proxyEnabled ? options.proxyPort : null,
        }))
        log(`鉴权通过 device=${client.deviceName} peer=${client.peer}`)
        return
      }

      if (!client.authed) {
        ws.send(JSON.stringify({ type: 'error', code: 'not-authenticated' }))
        return
      }

      if (frame.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
      }
      // ack 目前只记日志，留给后续推送可靠性用。
      if (frame.type === 'ack') {
        log(`收到 ack id=${frame.id ?? ''}`)
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
      clients.delete(client)
      log(`WS 断开 ${client.peer} device=${client.deviceName}`)
    })

    ws.on('error', (error) => {
      log(`WS 错误 ${client.peer}: ${error?.message ?? error}`)
    })
  })

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.ws.closed) continue
      client.ws.ping()
    }
  }, HEARTBEAT_MS)

  // DSH Web 只监听回环，手机访问不到；这里做一层裸 TCP 反代。
  let proxy = null
  if (options.proxyEnabled) {
    proxy = net.createServer((socket) => {
      const peer = `${socket.remoteAddress}:${socket.remotePort}`
      log(`反代连接 ${peer}`)
      const upstream = net.connect({ host: options.upstreamHost, port: upstreamPort })
      socket.pipe(upstream).pipe(socket)
      const close = () => {
        socket.destroy()
        upstream.destroy()
      }
      socket.on('error', close)
      upstream.on('error', (error) => {
        log(`反代上游错误 ${error?.message ?? error}`)
        close()
      })
      socket.on('close', () => log(`反代断开 ${peer}`))
    })
  }

  function listen(target, port, host, label) {
    return new Promise((resolve) => {
      const onError = (error) => {
        log(`${label} 监听失败 ${host}:${port} → ${error?.code ?? ''} ${error?.message ?? error}`)
        resolve(false)
      }
      target.once('error', onError)
      target.listen(port, host, () => {
        target.removeListener('error', onError)
        log(`${label} 已监听 http://${host}:${port}`)
        resolve(true)
      })
    })
  }

  // 局域网自动发现：每 2 秒往广播地址喊一声自己是谁。手机 App 监听同端口即可列出电脑，免手填 IP。
  // 广播只在同一个网段内可见，安全性等同"连着同一个 Wi-Fi"，不想暴露就把 discovery 关掉。
  let beaconSocket = null
  let beaconTimer = null
  function startBeacon() {
    if (!options.discovery) return
    const socket = dgram.createSocket({ type: 'udp4' })
    beaconSocket = socket
    socket.on('error', (error) => {
      log(`自动发现广播失败：${error?.message ?? error}`)
      try {
        socket.close()
      } catch {
        // 已经关了就算了。
      }
    })
    socket.bind(() => {
      try {
        socket.setBroadcast(true)
      } catch (error) {
        log(`打开广播权限失败：${error?.message ?? error}`)
      }
      const send = () => {
        const body = Buffer.from(JSON.stringify({
          svc: 'dshremote',
          v: 1,
          name: os.hostname(),
          port: options.port,
          proxy: options.proxyEnabled ? options.proxyPort : null,
          lan: lanAddresses(),
          public: publicUrl || null,
          token,
        }), 'utf8')
        socket.send(body, 0, body.length, options.discoveryPort, '255.255.255.255', () => {
          // 广播发不出去（比如没有网卡）不影响其它功能。
        })
      }
      send()
      beaconTimer = setInterval(send, 2000)
      log(`自动发现已开启 udp://255.255.255.255:${options.discoveryPort}`)
    })
  }

  ctx.effect(() => {
    void (async () => {
      await listen(server, options.port, options.bind, 'bridge')
      if (proxy) await listen(proxy, options.proxyPort, options.bind, '反代')
      primaryIp = await detectPrimaryIp()
      startBeacon()
      try {
        fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
        if (readToken(tokenFile) !== token) {
          fs.writeFileSync(tokenFile, token, { encoding: 'utf8', mode: 0o600 })
          log(`token 已写入 ${tokenFile}`)
        }
      } catch (error) {
        log(`token 落盘失败：${error?.message ?? error}`)
      }
      log(`就绪 token=${token} 上游=127.0.0.1:${upstreamPort} browserAuth=${browserAuth ? 'yes' : 'no'} trusted=${Array.isArray(trustedList) ? trustedList.length : 'no'}`)
    })()

    return () => {
      clearInterval(heartbeat)
      clearInterval(beaconTimer)
      try {
        beaconSocket?.close()
      } catch {
        // 关不掉忽略。
      }
      disposeEvents?.()
      disposeStatus?.()
      for (const client of clients) {
        client.ws.close(1001, 'shutdown')
      }
      clients.clear()
      wss.removeAllListeners()
      server.close()
      proxy?.close()
      log('已停止')
    }
  })
}

export default { name: 'dshremote-bridge', inject: ['connection', 'webServer'], apply }

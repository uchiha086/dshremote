import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
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

    if (url.pathname === '/events') {
      if (url.searchParams.get('token') !== token) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'bad-token' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, events }))
      return
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: false, error: 'not-found' }))
  })

  const wss = createWebSocketServer(server, { path: '/ws', protocol: WS_PROTOCOL })

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

  ctx.effect(() => {
    void (async () => {
      await listen(server, options.port, options.bind, 'bridge')
      if (proxy) await listen(proxy, options.proxyPort, options.bind, '反代')
      try {
        fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
        if (readToken(tokenFile) !== token) {
          fs.writeFileSync(tokenFile, token, { encoding: 'utf8', mode: 0o600 })
          log(`token 已写入 ${tokenFile}`)
        }
      } catch (error) {
        log(`token 落盘失败：${error?.message ?? error}`)
      }
      log(`就绪 token=${token} 上游=127.0.0.1:${upstreamPort} browserAuth=${browserAuth ? 'yes' : 'no'}`)
    })()

    return () => {
      clearInterval(heartbeat)
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

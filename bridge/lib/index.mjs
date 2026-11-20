import crypto from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { svgOf } from './qr.mjs'
import { createWebSocketServer } from './websocket.mjs'

/** 桥插件版本，手机端据此判断兼容性。 */
const BRIDGE_VERSION = '0.2.0'

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
  // 隧道：auto = 由桥自己拉起 cloudflared 快速隧道并守护重启，off = 手动跑 tools/tunnel.ps1。
  tunnel: 'off',
  cloudflaredPath: 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  tunnelProtocol: 'http2',
  tunnelWaitMs: 60_000,
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
  const STORE_DIR = path.dirname(tokenFile)
  const token = String(options.token ?? '').trim() || readToken(tokenFile) || crypto.randomBytes(16).toString('hex')

  // DSH Web 每次启动端口可能不同（7626、10628…），以宿主 webServer 实际端口为准。
  const webPort = Number(ctx.webServer?.port)
  const upstreamPort = Number.isFinite(webPort) && webPort > 0 ? webPort : options.upstreamPort

  // 让 AI 修：借宿主的 typert 网关，以 owner 身份开新会话并把体检结果发过去。
  const typertGateway = ctx.typertGateway
  let sessionPeer = null
  function ownerPeer() {
    if (sessionPeer) return sessionPeer
    try {
      sessionPeer = ctx.connection?.createPeer?.({ principal: { kind: 'owner' }, interactions: 'none' }) ?? null
    } catch {
      sessionPeer = null
    }
    return sessionPeer
  }

  /** 给 AI 的修复简报：把这次体检的每一项都写进去，省得它再猜。 */
  function repairBrief(diag) {
    const lines = [
      '帮我修一下这台电脑上的 DSH Remote 桥（dshremote-bridge）。',
      '',
      `桥服务：http://127.0.0.1:${options.port}（反代 ${options.proxyPort}，上游 127.0.0.1:${upstreamPort}）`,
      `仓库：C:\\Users\\user\\Desktop\\dshremote（bridge/ 是插件，app/ 是鸿蒙手机端）`,
      `cloudflared：${options.cloudflaredPath}（隧道模式 ${options.tunnel}，协议 ${options.tunnelProtocol}）`,
      '',
      '刚才的体检结果：',
    ]
    for (const check of diag?.checks ?? []) {
      lines.push(`- ${check.ok ? 'OK ' : 'FAIL'} ${check.name}：${check.detail}（${check.ms}ms）`)
    }
    if (diag?.tunnel) lines.push(`- 当前隧道地址：${diag.tunnel}`)
    lines.push(
      '',
      '要求：',
      '1. 先跑 `node bridge/test/pair.mjs` 和 `node bridge/test/smoke.mjs` 确认没被我改坏；',
      '2. 定位为什么隧道不可用（本机 DNS 对 argotunnel.com 会抖，quick tunnel 域名会被回收）；',
      '3. 修好后用 `GET http://127.0.0.1:3088/pair/test` 确认五项全绿，并把结果贴给我；',
      '4. 只改 bridge/ 下的文件，别动 app/ 的 ArkTS 代码（那边我这边验证）。',
    )
    return lines.join('\n')
  }

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
    const pub = tunnelFresh() ? { base: publicUrl, web: publicUrl } : null
    const choosePublic = Boolean(pub) && looksPublic(hostHeader)
    const target = choosePublic ? pub : lan
    // 二维码里同时带局域网与公网：手机在同一个 Wi-Fi 就直连，出了门自动改走隧道。
    // 只编码一个地址的话，换个网络就得重新扫码。
    const payload = [
      'dshremote://pair?v=1',
      `&name=${encodeURIComponent(os.hostname())}`,
      `&base=${encodeURIComponent(lan.base)}`,
      `&web=${encodeURIComponent(lan.web)}`,
      pub ? `&tunnel=${encodeURIComponent(pub.base)}` : '',
      `&token=${token}`,
    ].join('')
    return { name: os.hostname(), lan, lanAll, public: pub, target, payload }
  }

  /** 单个 HTTP 探测：2xx/3xx/401 都算"通了"（401 说明 DSH 在跑，只是还没登录）。 */
  function probe(urlString, name) {
    return new Promise((resolve) => {
      const started = Date.now()
      const done = (ok, detail) => resolve({ name, ok, ms: Date.now() - started, detail })
      try {
        const target = new URL(urlString)
        const secure = target.protocol === 'https:'
        const request = (secure ? https : http).request({
          host: target.hostname,
          port: target.port ? Number(target.port) : (secure ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          timeout: 8000,
          headers: { host: target.host, accept: 'application/json,text/html' },
        }, (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => { body += chunk })
          response.on('end', () => {
            const status = response.statusCode ?? 0
            const ok = (status >= 200 && status < 400) || status === 401
            const head = body.replace(/\s+/g, ' ').slice(0, 48)
            done(ok, `HTTP ${status}${head ? ` · ${head}` : ''}`)
          })
        })
        request.on('timeout', () => { request.destroy(); done(false, '超时') })
        request.on('error', (error) => done(false, error?.code ?? String(error?.message ?? error)))
        request.end()
      } catch (error) {
        done(false, String(error?.message ?? error))
      }
    })
  }

  /** 配对前的体检：桥本身、反代、局域网、隧道 → 桥、隧道 → DSH。 */
  async function pairTest() {
    const info = pairing('127.0.0.1')
    const checks = []
    checks.push(await probe(`http://127.0.0.1:${options.port}/health`, '桥服务'))
    checks.push(await probe(`http://127.0.0.1:${options.proxyPort}/`, 'DSH 反代'))
    const lanHost = (() => {
      try { return new URL(info.lan.base).host } catch { return '' }
    })()
    if (lanHost) checks.push(await probe(`http://${lanHost}/health`, '局域网可达'))
    if (publicUrl && tunnelFresh()) {
      checks.push(await probe(`${publicUrl}/health`, '隧道 → 桥'))
      checks.push(await probe(`${publicUrl}/`, '隧道 → DSH'))
    } else {
      checks.push({
        name: '隧道',
        ok: false,
        ms: 0,
        detail: publicUrl
          ? '地址已失效或还没就绪（Cloudflare 回收后会重建，稍等或重启 Desktop）'
          : '未启用（config.tunnel 设为 auto 后重启 Desktop）',
      })
    }
    return {
      ok: checks.every((check) => check.ok),
      checks,
      lan: info.lan.base,
      tunnel: info.public ? info.public.base : '',
      proxyPort: options.proxyPort,
      at: Date.now(),
    }
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
      tunnel: info.public ? info.public.base : '',
      tunnelPending: Boolean(publicUrl) && !tunnelFresh(),
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

  const handleBridgeRequest = (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    // 桌面端页面跑在 dsh-app://app 这类自定义协议下，请求桥属于跨源；
    // 统一的 CORS 预检与响应头放在最前面，省得每个路由各写一遍。
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      })
      response.end()
      return
    }

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
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        // Web UI 走 7627（反代端口）时与桥不同源，配对面板要能跨源取数据。
        'access-control-allow-origin': '*',
      })
      response.end(JSON.stringify(pairingJson(host)))
      return
    }

    if (url.pathname === '/pair/test') {
      // 面板在生成二维码之前先跑一遍体检：局域网 / 反代 / 隧道三段都通了才出码。
      const host = String(request.headers.host ?? '')
      if (looksPublic(host) && url.searchParams.get('token') !== token) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'bad-token' }))
        return
      }
      pairTest().then((result) => {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        })
        response.end(JSON.stringify(result))
      }).catch((error) => {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, checks: [], error: String(error?.message ?? error) }))
      })
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
        response.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        })
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
        // 调用方（tools/tunnel.ps1）发布前已经打通过 /health，这里直接记为已校验。
        tunnelVerifiedAt = Date.now()
        trustHost(tunnelAuthority(publicUrl))
        log(`公网地址=${publicUrl}`)
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, public: publicUrl || null }))
      return
    }

    // 一键修复：把卡住的隧道进程换掉，等到一条真的能被公网访问的地址再返回。
    if (url.pathname === '/repair') {
      const startedRepair = Date.now()
      void (async () => {
        const reply = (status, body) => {
          response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify(body))
        }
        if (String(options.tunnel ?? 'off') !== 'auto') {
          reply(200, { ok: false, error: 'tunnel-disabled', hint: 'config.tunnel 不是 auto，先改 cordis.patch.yml 再重启 Desktop' })
          return
        }
        // 1) 收掉现有进程（可能卡在建隧道阶段），清掉可能已失效的旧地址。
        tunnelVerifiedAt = 0
        publicUrl = ''
        writePublicUrl('')
        if (tunnelChild) {
          try {
            tunnelChild.kill()
          } catch {
            // 退出事件会负责重启
          }
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
        tunnelAttempt = 0
        if (tunnelTimer) {
          clearTimeout(tunnelTimer)
          tunnelTimer = null
        }
        // 2) 重新拉起，最多等 120 秒。
        if (!tunnelChild) startTunnel()
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          if (publicUrl && tunnelFresh()) break
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
        const tunnelUrl = tunnelFresh() ? publicUrl : ''
        log(tunnelUrl ? `一键修复完成 ${tunnelUrl}` : '一键修复失败：120 秒内没拿到可用隧道')
        const result = await pairTest()
        reply(200, {
          ok: Boolean(tunnelUrl) && result.ok,
          tunnel: tunnelUrl || null,
          waitedMs: Date.now() - startedRepair,
          checks: result.checks,
          error: tunnelUrl ? undefined : 'tunnel-unavailable',
        })
      })()
      return
    }

    // 让 AI 修：在当前 DSH 里开一个新会话，把体检结果和修复要点直接发给它。
    if (url.pathname === '/ai-fix') {
      void (async () => {
        const reply = (status, body) => {
          response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify(body))
        }
        const diag = await pairTest()
        const prompt = repairBrief(diag)
        try {
          if (!typertGateway?.invoke) throw new Error('typertGateway 不可用')
          const created = await typertGateway.invoke({
            namespace: 'session',
            method: 'create',
            args: { request: { cwd: STORE_DIR } },
            peer: ownerPeer(),
          })
          const sessionId = created?.sessionId ?? created?.id
          if (!sessionId) throw new Error('session/create 没有返回 sessionId')
          await typertGateway.invoke({
            namespace: 'session',
            method: 'prompt',
            args: {
              request: {
                requestId: crypto.randomUUID(),
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: prompt }],
              },
            },
            peer: ownerPeer(),
          })
          log(`AI 修复会话已创建 ${sessionId}`)
          reply(200, { ok: true, sessionId, prompt })
        } catch (error) {
          const message = error?.message ?? String(error)
          log(`AI 修复没能起会话：${message}`)
          reply(200, { ok: false, error: message, prompt })
        }
      })()
      return
    }

    // 其余路径原样转给 DSH：这样一条隧道（指向 3088）就能同时当网页入口和控制接口用。
    proxyRequest(request, response)
  }

  const server = http.createServer(handleBridgeRequest)

  // 桌面端页面来源是 dsh-app://app，从页面直接 fetch http://127.0.0.1:3088 会被
  // 浏览器的私有网络访问（Private Network Access）策略拦成 "Failed to fetch"。
  // 所以把同一套接口在 DSH 自己的 web 服务上再挂一遍，面板改用同源相对路径。
  const SAME_ORIGIN_PREFIX = '/dshremote'
  const sameOriginRoutes = ['/health', '/pair', '/pair.svg', '/pair.png', '/pair.html', '/pair/test', '/repair', '/ai-fix']
  const sameOriginDisposers = []
  if (typeof ctx.webServer?.register === 'function') {
    for (const suffix of sameOriginRoutes) {
      const path = `${SAME_ORIGIN_PREFIX}${suffix}`
      try {
        const dispose = ctx.webServer.register({
          kind: 'exact',
          path,
          handler: (request, response) => {
            request.url = suffix
            handleBridgeRequest(request, response)
          },
        })
        if (typeof dispose === 'function') sameOriginDisposers.push(dispose)
      } catch (error) {
        log(`同源路由 ${path} 注册失败：${error?.message ?? error}`)
      }
    }
    log(`同源路由已挂载 ${sameOriginDisposers.length} 条（${SAME_ORIGIN_PREFIX}/*）`)
  }

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

  // ---- 隧道守护 ----
  // 以前靠 tools/tunnel.ps1 手动跑 cloudflared，它一被父进程带走、或者 DNS 抖一下退出，
  // 手机在 4G 就连不上了。这里改成由宿主进程负责拉起与重启，掉线会自动恢复。
  let tunnelChild = null
  /** cloudflared 最近的原始输出，进程快速退出时用来解释原因。 */
  let tunnelTail = []
  let tunnelTimer = null
  let tunnelAttempt = 0
  let tunnelStopped = false
  // 只有"最近真的从公网打通 /health"的隧道才会写进二维码；否则宁可不给，免得手机扫到死链。
  let tunnelVerifiedAt = 0
  let tunnelWatch = null
  const TUNNEL_FRESH_MS = 15 * 60 * 1000

  function tunnelAuthority(value) {
    return String(value ?? '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
  }

  function tunnelFresh() {
    return Boolean(publicUrl) && tunnelVerifiedAt > 0 && Date.now() - tunnelVerifiedAt < TUNNEL_FRESH_MS
  }

  function scheduleTunnel(delayMs) {
    if (tunnelStopped || tunnelTimer) return
    tunnelTimer = setTimeout(() => {
      tunnelTimer = null
      startTunnel()
    }, delayMs)
    if (typeof tunnelTimer.unref === 'function') tunnelTimer.unref()
  }

  function adoptTunnelUrl(url) {
    const clean = String(url).replace(/\/+$/, '')
    if (!/^https:\/\//.test(clean) || clean === publicUrl) return
    // cloudflared 的日志里会出现 api.trycloudflare.com 这类服务域名，不能当成隧道地址。
    const authority = tunnelAuthority(clean)
    if (!authority.endsWith('.trycloudflare.com')) return
    if (/^(api|www|dash|dashv2)\.trycloudflare\.com$/.test(authority)) return
    if (authority.split('-').length < 3) return
    verifyTunnelSoon(clean, authority)
  }

  /** 校验几次再决定发布：cloudflared 刚建好时 DNS 还没铺开，一次失败不代表这条隧道是死的。 */
  function verifyTunnelSoon(clean, authority, attempt = 1) {
    verifyTunnel(clean, authority).then((ok) => {
      if (ok) {
        if (clean !== publicUrl) {
          publicUrl = clean
          trustHost(authority)
          writePublicUrl(publicUrl)
          log(`隧道就绪 ${publicUrl}`)
        }
        tunnelVerifiedAt = Date.now()
        tunnelAttempt = 0
        return
      }
      if (attempt >= 3) {
        log(`隧道地址校验失败，先不写进二维码：${clean}`)
        return
      }
      const timer = setTimeout(() => verifyTunnelSoon(clean, authority, attempt + 1), 4000 * attempt)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  /** 每 60 秒复核一次已发布的隧道：域名会被 Cloudflare 回收，回收后要立刻停止再用它。 */
  function watchTunnel() {
    if (tunnelWatch || tunnelStopped) return
    tunnelWatch = setInterval(() => {
      if (!publicUrl) return
      const authority = tunnelAuthority(publicUrl)
      if (!authority) return
      verifyTunnel(publicUrl, authority).then((ok) => {
        if (ok) {
          tunnelVerifiedAt = Date.now()
          return
        }
        if (tunnelVerifiedAt > 0) {
          log(`隧道 ${publicUrl} 已失效，等待新地址`)
        }
        tunnelVerifiedAt = 0
      })
    }, 60_000)
    if (typeof tunnelWatch.unref === 'function') tunnelWatch.unref()
  }

  /** 从本机经隧道打一次 /health，确认这条隧道真的能用。 */
  function verifyTunnel(base, authority) {
    return new Promise((resolve) => {
      let settled = false
      const done = (ok) => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        const request = https.request({
          host: authority,
          port: 443,
          path: '/health',
          method: 'GET',
          timeout: 8000,
          headers: { host: authority },
        }, (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => { body += chunk })
          response.on('end', () => done(response.statusCode === 200 && body.includes('dshremote-bridge')))
        })
        request.on('timeout', () => { request.destroy(); done(false) })
        request.on('error', () => done(false))
        request.end()
      } catch {
        done(false)
      }
    })
  }

  function startTunnel() {
    if (tunnelStopped || tunnelChild) return
    if (String(options.tunnel ?? 'off') !== 'auto') return
    const exe = String(options.cloudflaredPath ?? '')
    if (!exe || !fs.existsSync(exe)) {
      log(`隧道未启动：找不到 cloudflared（${exe}）`)
      return
    }
    const args = [
      'tunnel',
      '--url', `http://127.0.0.1:${options.port}`,
      '--protocol', String(options.tunnelProtocol ?? 'http2'),
      '--no-autoupdate',
      // precheck 要跑 30-60 秒，且本机 DNS 对 argotunnel.com 抖动时会拖更久；直接跳过，靠 verifyTunnel 自证。
      '--no-prechecks',
      '--loglevel', 'info',
    ]
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      log(`隧道启动失败：${error?.message ?? error}`)
      scheduleTunnel(10_000)
      return
    }
    tunnelChild = child
    tunnelTail = []
    log(`隧道启动中 pid=${child.pid}`)

    const onData = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // 留最后几行原始输出：cloudflared 快速退出时，原因只写在 stderr 里。
        tunnelTail.push(trimmed.slice(0, 200))
        if (tunnelTail.length > 6) tunnelTail.shift()
        const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
        if (match) adoptTunnelUrl(match[0])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    // cloudflared 偶尔会卡在建隧道阶段（连上 edge 但迟迟不给 quick tunnel 地址），到点就重来。
    if (tunnelTimer) clearTimeout(tunnelTimer)
    tunnelTimer = setTimeout(() => {
      tunnelTimer = null
      if (tunnelChild !== child) return
      log(`隧道 ${Math.round(Number(options.tunnelWaitMs ?? 90000) / 1000)}s 内没拿到地址，重启 cloudflared`)
      try {
        child.kill()
      } catch {
        // 杀不掉就让退出事件走重启流程。
      }
    }, Number(options.tunnelWaitMs ?? 90000))
    if (typeof tunnelTimer.unref === 'function') tunnelTimer.unref()
    child.on('error', (error) => log(`隧道进程错误：${error?.message ?? error}`))
    child.on('exit', (code) => {
      tunnelChild = null
      if (tunnelStopped) return
      tunnelAttempt += 1
      const delay = Math.min(60_000, 5_000 * tunnelAttempt)
      log(`隧道进程退出 code=${code}，${Math.round(delay / 1000)}s 后重启`)
      if (tunnelTail.length > 0) log(`  cloudflared 最后输出：${tunnelTail.join(' | ')}`)
      scheduleTunnel(delay)
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
      startTunnel()
      watchTunnel()
    })()

    return () => {
      clearInterval(heartbeat)
      clearInterval(beaconTimer)
      for (const dispose of sameOriginDisposers) {
        try {
          dispose()
        } catch {
          // 卸载时路由表可能已经没了。
        }
      }
      if (tunnelWatch) {
        clearInterval(tunnelWatch)
        tunnelWatch = null
      }
      tunnelStopped = true
      if (tunnelTimer) {
        clearTimeout(tunnelTimer)
        tunnelTimer = null
      }
      try {
        tunnelChild?.kill()
      } catch {
        // 杀不掉就交给系统回收。
      }
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

export default { name: 'dshremote-bridge', inject: ['connection', 'webServer', 'typertGateway'], apply }

import crypto from 'node:crypto'
import dgram from 'node:dgram'
import dns from 'node:dns'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { svgOf } from './qr.mjs'

/** 桥插件版本，手机端据此判断兼容性。 */
const BRIDGE_VERSION = '0.2.2'


/** 最近事件最多留多少条，供 /events 调试与手机补拉。 */
const EVENT_BUFFER = 1000

/** 一次性配对码：扫码后用它换 token，二维码里不再塞长期口令。 */
const PAIR_CODE_TTL_MS = 60_000

/** 本机回环地址集合：来自这些地址的请求才算"本机进程"。 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 允许跨源访问桥的页面来源（DSH 桌面端是 dsh-app://app，Web 版是 127.0.0.1:端口）。 */
function isAllowedOrigin(origin) {
  const value = String(origin ?? '').trim()
  if (!value) return true
  if (value === 'dsh-app://app' || value === 'dsh-app://-') return true
  try {
    const parsed = new URL(value)
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') return true
  } catch {
    return false
  }
  return false
}

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
  // 局域网自动发现：默认关闭。早先默认开启且广播里带 token，
  // 等于把口令明文撒到同网段（咖啡厅/酒店/校园网都不安全）。
  // 需要时在配置里打开 discovery: true，beacon 也只会广播身份与地址，不带 token。
  discovery: false,
  discoveryPort: 3089,
  // 隧道：auto = 由桥自己拉起 cloudflared 快速隧道并守护重启，off = 手动跑 tools/tunnel.ps1。
  tunnel: 'off',
  cloudflaredPath: 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  tunnelProtocol: 'http2',
  tunnelWaitMs: 60_000,
}

/** 读已保存的 token；太短或含空白的都不认，避免把脏内容当口令用。 */
function readToken(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    return /^[A-Za-z0-9._~-]{16,128}$/.test(text) ? text : ''
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
      `仓库：<repo>/bridge（bridge/ 是电脑端插件，app/ 是鸿蒙端，android/ 是安卓端）`,
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
      const accept = (value) =>
        /^192\.168\./.test(value) || /^10\./.test(value) || /^172\.(1[6-9]|2\d|3[01])\./.test(value)
      const done = (raw) => {
        const value = accept(String(raw ?? "")) ? String(raw) : ""
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
    // 手机能连的只有"家宽私网"：192.168/16、10/8、172.16/12。
    // Tailscale 的 100.64/10、APIPA 的 169.254/16、回环都不算——把它们编进二维码就是死地址。
    const reachable = (address) =>
      /^192\.168\./.test(address) || /^10\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    const items = []
    try {
      for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const item of list ?? []) {
          if (!item || item.family !== 'IPv4' || item.internal) continue
          if (!reachable(item.address)) continue
          const virtual = avoidName.some((re) => re.test(name))
          let score = 0
          // 默认路由那张网卡优先，但如果它是虚拟网卡（WSL/Hyper-V/VirtualBox）就不加分。
          if (item.address === primaryIp && !virtual) score += 100
          if (preferName.some((re) => re.test(name))) score += 10
          if (virtual) score -= 10
          if (/^192\.168\./.test(item.address)) score += 3
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

  /** 请求是不是本机进程发起的（回环地址）。隧道流量在本地看也是 127.0.0.1，所以还要结合 Host 判断。 */
  function remoteIsLoopback(request) {
    if (!LOOPBACK_ADDRESSES.has(String(request.socket?.remoteAddress ?? ''))) return false
    // Host 头也必须指着回环：否则就是"本机进程伪装成隧道域名"，不能当本地面板用。
    const host = String(request.headers.host ?? '').replace(/^\[/, '').replace(/\](:\d+)?$/, '').replace(/:\d+$/, '').toLowerCase()
    return LOOPBACK_ADDRESSES.has(host) || host === 'localhost'
  }

  /** 取请求里的 token：优先 Authorization: Bearer，其次 X-DSH-Token，最后兼容旧的 ?token=。 */
  function tokenFrom(request, url) {
    const auth = String(request.headers['authorization'] ?? '')
    if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim()
    const header = String(request.headers['x-dsh-token'] ?? '').trim()
    if (header) return header
    return String(url.searchParams.get('token') ?? '').trim()
  }

  function sameToken(value) {
    const given = Buffer.from(String(value ?? ''), 'utf8')
    const expected = Buffer.from(String(token ?? ''), 'utf8')
    if (given.length !== expected.length) return false
    return crypto.timingSafeEqual(given, expected)
  }

  /** 需要鉴权：来自非回环地址，或 Host 是公网域名（隧道场景）。 */
  function needsAuth(request, host) {
    return !remoteIsLoopback(request) || looksPublic(host)
  }

  function deny(response, status = 401, error = 'bad-token') {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ ok: false, error }))
  }

  /** 读接口的鉴权：回环 + 局域网 Host 放行，其余必须带 token。 */
  function allowToken(request, response, url, host) {
    if (!needsAuth(request, host)) return true
    if (sameToken(tokenFrom(request, url))) return true
    deny(response)
    return false
  }

  /** 状态变更接口（/repair、/ai-fix 等）只认请求头里的 token，并校验 Origin，防 CSRF。 */
  function allowHeaderToken(request, response) {
    const auth = String(request.headers['authorization'] ?? '')
    const bearer = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : ''
    const provided = String(request.headers['x-dsh-token'] ?? '').trim() || bearer
    if (!provided) {
      deny(response)
      return false
    }
    if (!sameToken(provided)) {
      deny(response)
      return false
    }
    if (!isAllowedOrigin(request.headers.origin)) {
      deny(response, 403, 'bad-origin')
      return false
    }
    return true
  }

  /** 简单令牌桶：按来源地址限速，避免 /pair/test、/repair 被刷成打手。 */
  const rateBuckets = new Map()
  function rateLimit(request, key, capacity, refillPerSecond) {
    const id = `${key}:${request.socket?.remoteAddress ?? 'unknown'}`
    const now = Date.now()
    const bucket = rateBuckets.get(id) ?? { tokens: capacity, updatedAt: now }
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.updatedAt) / 1000) * refillPerSecond)
    bucket.updatedAt = now
    const allowed = bucket.tokens >= 1
    if (allowed) bucket.tokens -= 1
    rateBuckets.set(id, bucket)
    if (rateBuckets.size > 500) {
      const oldest = rateBuckets.keys().next().value
      rateBuckets.delete(oldest)
    }
    return allowed
  }

  /** 一次性配对码：内存里存 60 秒，单次有效，手机拿它换长期 token。 */
  const pairCodes = new Map()
  function prunePairCodes() {
    const now = Date.now()
    for (const [code, entry] of pairCodes) {
      if (entry.expiresAt <= now) pairCodes.delete(code)
    }
  }
  function issuePairCode() {
    prunePairCodes()
    const code = crypto.randomBytes(9).toString('base64url')
    pairCodes.set(code, { expiresAt: Date.now() + PAIR_CODE_TTL_MS, used: false })
    if (pairCodes.size > 200) {
      const oldest = pairCodes.keys().next().value
      pairCodes.delete(oldest)
    }
    return code
  }
  function claimPairCode(code) {
    prunePairCodes()
    const entry = pairCodes.get(String(code ?? '').trim())
    if (!entry || entry.used || entry.expiresAt <= Date.now()) return null
    entry.used = true
    return entry
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
    // v2 起二维码里不再带长期 token，改带 60 秒一次性 pairCode：
    // 截图/投屏/肩窥泄露的只是一个马上作废的码，换不成登录态。
    const code = issuePairCode()
    const payload = [
      'dshremote://pair?v=2',
      `&name=${encodeURIComponent(os.hostname())}`,
      `&base=${encodeURIComponent(lan.base)}`,
      `&web=${encodeURIComponent(lan.web)}`,
      pub ? `&tunnel=${encodeURIComponent(pub.base)}` : '',
      `&code=${code}`
    ].join('')
    return { name: os.hostname(), lan, lanAll, public: pub, target, payload, code }
  }

  // 本机 DNS 对 Cloudflare 域名会抖（NXDOMAIN / i/o timeout），而 *.trycloudflare.com 的解析结果
  // 永远落在 Cloudflare 的 anycast 边缘上。所以隧道流量配一个专用 lookup：系统 DNS 1.5s 内没答复
  // 就直接用边缘 IP 顶上，SNI/Host 仍然是原主机名，证书校验和回源都不受影响。
  const TUNNEL_EDGE_IPS = ['104.16.230.132', '104.16.231.132']
  let tunnelEdgeCursor = 0

  function nextTunnelEdgeIp() {
    const ip = TUNNEL_EDGE_IPS[tunnelEdgeCursor % TUNNEL_EDGE_IPS.length]
    tunnelEdgeCursor += 1
    return ip
  }

  /** api.trycloudflare.com 是 cloudflared 的建隧道接口，不能拿边缘 IP 去糊它。 */
  function isTunnelHost(hostname) {
    const host = String(hostname ?? '').toLowerCase()
    return host.endsWith('.trycloudflare.com') && host !== 'api.trycloudflare.com'
  }

  /** 隧道专用 lookup：先系统 DNS，失败或超时退回 anycast 边缘 IP；force=true 时直接钉边缘 IP。 */
  function tunnelLookup(hostname, { force = false } = {}) {
    return (host, options, callback) => {
      const opts = typeof options === 'function' ? {} : (options ?? {})
      const cb = typeof options === 'function' ? options : callback
      const answer = (address) => {
        if (opts.all) cb(null, [{ address, family: 4 }])
        else cb(null, address, 4)
      }
      if (force) {
        answer(nextTunnelEdgeIp())
        return
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        answer(nextTunnelEdgeIp())
      }, 1500)
      if (typeof timer.unref === 'function') timer.unref()
      dns.lookup(hostname, { family: 4 }, (error, address) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        answer(error || !address ? nextTunnelEdgeIp() : address)
      })
    }
  }

  // 固定公网域名（Tailscale Funnel、自己的域名）没有 Cloudflare 的边缘 IP 可钉，但本机 DNS
  // 对它们照样会抖：解析要么超时、要么偶发 NXDOMAIN，而域名本身一直是好的。所以给这类域名
  // 留一份"上次解析成功的 IP"：DNS 打不通时直接复用，SNI/Host 仍是原域名，证书校验不受影响。
  const publicIpCache = new Map()
  const PUBLIC_IP_TTL_MS = 10 * 60 * 1000
  // 解析结果落盘：重启 Desktop 后本机 DNS 往往还没回暖，先把上次打通的入口 IP 捞回来用，
  // 免得固定地址被误判成"隧道挂了"。文件名跟 token/hosts 放同一个目录。
  const publicIpFile = path.join(STORE_DIR, 'dshremote-bridge.public-ip.json')

  function loadPublicIps() {
    try {
      if (!fs.existsSync(publicIpFile)) return
      const parsed = JSON.parse(fs.readFileSync(publicIpFile, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return
      for (const [host, entry] of Object.entries(parsed)) {
        const ip = String(entry?.ip ?? '').trim()
        const at = Number(entry?.at ?? 0)
        if (!host || !ip || ip.startsWith('100.')) continue
        if (Date.now() - at > PUBLIC_IP_TTL_MS) continue
        publicIpCache.set(String(host).toLowerCase(), { ip, at })
      }
    } catch {
      // 缓存坏了不影响主流程，下一轮解析成功会重写。
    }
  }

  function savePublicIps() {
    try {
      const out = Object.fromEntries(publicIpCache)
      fs.mkdirSync(path.dirname(publicIpFile), { recursive: true })
      fs.writeFileSync(publicIpFile, JSON.stringify(out), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // 写不进去就算了，只是少了冷启动加速。
    }
  }

  function rememberPublicIp(hostname, address) {
    const host = String(hostname ?? '').toLowerCase()
    const ip = String(address ?? '').trim()
    if (!host || !ip || ip.startsWith('100.')) return
    publicIpCache.set(host, { ip, at: Date.now() })
    savePublicIps()
  }

  function cachedPublicIp(hostname) {
    const host = String(hostname ?? '').toLowerCase()
    const hit = publicIpCache.get(host)
    if (!hit) return ''
    if (Date.now() - hit.at > PUBLIC_IP_TTL_MS) {
      publicIpCache.delete(host)
      savePublicIps()
      return ''
    }
    return hit.ip
  }

  function forgetPublicIp(hostname) {
    if (publicIpCache.delete(String(hostname ?? '').toLowerCase())) savePublicIps()
  }

  loadPublicIps()

  /** 固定公网域名专用 lookup：先系统 DNS，失败/超时退回上次解析成功的 IP；force 时直接用缓存。 */
  function publicHostLookup(hostname, { force = false } = {}) {
    return (host, options, callback) => {
      const opts = typeof options === 'function' ? {} : (options ?? {})
      const cb = typeof options === 'function' ? options : callback
      const answer = (address) => {
        if (opts.all) cb(null, [{ address, family: 4 }])
        else cb(null, address, 4)
      }
      if (force) {
        const pinned = cachedPublicIp(hostname)
        if (pinned) {
          answer(pinned)
          return
        }
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const pinned = cachedPublicIp(hostname)
        if (pinned) answer(pinned)
        else cb(Object.assign(new Error(`dns timeout: ${hostname}`), { code: 'ENOTFOUND' }))
      }, 1500)
      if (typeof timer.unref === 'function') timer.unref()
      dns.lookup(hostname, { family: 4 }, (error, address) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!error && address) {
          rememberPublicIp(hostname, address)
          answer(address)
          return
        }
        const pinned = cachedPublicIp(hostname)
        if (pinned) {
          answer(pinned)
          return
        }
        cb(error || Object.assign(new Error(`dns failed: ${hostname}`), { code: 'ENOTFOUND' }))
      })
    }
  }

  /** 单个 HTTP 探测：2xx/3xx/401 都算"通了"（401 说明 DSH 在跑，只是还没登录）。 */
  function probe(urlString, name) {
    return new Promise((resolve) => {
      const started = Date.now()
      try {
        const target = new URL(urlString)
        const secure = target.protocol === 'https:'
        const tunnelHost = secure && isTunnelHost(target.hostname)
        // 固定公网域名（Tailscale Funnel 等）没有边缘 IP 可钉，改用"上次解析成功的 IP"兜底。
        const fixedPublicHost = secure && !tunnelHost && looksPublic(target.hostname)
        const attempt = (force) => new Promise((settle) => {
          const request = (secure ? https : http).request({
            host: target.hostname,
            port: target.port ? Number(target.port) : (secure ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            timeout: 8000,
            headers: { host: target.host, accept: 'application/json,text/html' },
            ...(tunnelHost ? { lookup: tunnelLookup(target.hostname, { force }) } : {}),
            ...(fixedPublicHost ? { lookup: publicHostLookup(target.hostname, { force }) } : {}),
          }, (response) => {
            if (fixedPublicHost) rememberPublicIp(target.hostname, response.socket?.remoteAddress)
            let body = ''
            response.setEncoding('utf8')
            response.on('data', (chunk) => { body += chunk })
            response.on('end', () => {
              const status = response.statusCode ?? 0
              const ok = (status >= 200 && status < 400) || status === 401
              const head = body.replace(/\s+/g, ' ').slice(0, 48)
              settle({ ok, detail: `HTTP ${status}${head ? ` · ${head}` : ''}` })
            })
          })
          request.on('timeout', () => { request.destroy(); settle({ ok: false, detail: '超时' }) })
          request.on('error', (error) => settle({ ok: false, detail: error?.code ?? String(error?.message ?? error) }))
          request.end()
        })
        // 隧道/固定公网域名：系统 DNS 这轮没打通，就换条路再打一次，别把好地址误判成红。
        const retryable = tunnelHost || fixedPublicHost
        const flow = retryable
          ? attempt(false).then((first) => (first.ok ? first : attempt(true).then((second) => {
            // 连缓存 IP 也打不通，说明入口换了：把缓存丢掉，下一轮重新解析。
            if (!second.ok && fixedPublicHost) forgetPublicIp(target.hostname)
            return second
          })))
          : attempt(false)
        flow.then((result) => resolve({ name, ok: result.ok, ms: Date.now() - started, detail: result.detail }))
      } catch (error) {
        resolve({ name, ok: false, ms: Date.now() - started, detail: String(error?.message ?? error) })
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
      checks.push({ name: '隧道', ok: false, ms: 0, detail: tunnelHint() })
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
  function pairingJson(hostHeader, { includeToken = false } = {}) {
    const info = pairing(hostHeader)
    return {
      ok: true,
      v: 2,
      name: info.name,
      payload: info.payload,
      code: info.code,
      codeTtlMs: PAIR_CODE_TTL_MS,
      base: info.target.base,
      web: info.target.web,
      lan: info.lan,
      lanAll: info.lanAll,
      public: info.public,
      tunnel: info.public ? info.public.base : '',
      tunnelPending: Boolean(publicUrl) && !tunnelFresh(),
      proxyPort: options.proxyPort,
      // 只有本机进程（桌面面板）才拿得到长期 token，用来调 /repair、/ai-fix 这类状态变更接口。
      ...(includeToken ? { token } : {}),
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
  // 单调递增的事件序号：客户端只记 seq，不依赖手机与服务端的时钟一致。
  let eventSeq = 0
  const startedAt = Date.now()

  function pushEvent(frame) {
    eventSeq += 1
    const stamped = { ...frame, seq: eventSeq }
    events.push(stamped)
    if (events.length > EVENT_BUFFER) events.shift()
    return stamped
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
  function proxyRequest(request, response, attempt = 1) {
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
    // DSH 电脑端重启、或者它自己踢 keep-alive 连接时会 ECONNRESET。GET/HEAD 是幂等的，
    // 悄悄再试一次基本就能过去，用户不会看到一个莫名其妙的 502。
    const idempotent = request.method === 'GET' || request.method === 'HEAD'
    const retryable = idempotent && attempt < 3
    upstreamRequest.on('error', (error) => {
      const code = String(error?.code ?? '')
      const why = code || String(error?.message ?? error)
      log(`HTTP 反代上游错误 ${why} ${request.method} ${request.url}`)
      if (retryable && (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE')) {
        const timer = setTimeout(() => proxyRequest(request, response, attempt + 1), 150 * attempt)
        if (typeof timer.unref === 'function') timer.unref()
        return
      }
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' })
        response.end('bridge: DSH 上游暂时连不上（电脑端可能正在重启），刷新一下重试')
      } else {
        response.destroy()
      }
    })
    request.pipe(upstreamRequest)
  }

  /** 非 /ws 的 WebSocket 升级（DSH 自己的长连接）也照原样透传。 */
  // WebSocket 升级反代：隧道场景下手机 WebView 的 wss 请求可能不带 cookie
  // （ArkWeb 对页面导航和 WebSocket 用不同的 cookie 判据），DSH 会 401 掉整条连接。
  // 桥本来就持有 token，这里在服务端补一个 cookie 进去，避免页面白屏。
  const wsCookieCache = new Map()
  function mintUpgradeCookie(authority) {
    const hit = wsCookieCache.get(authority)
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return Promise.resolve(hit.cookie)
    const browserAuth = ctx.connection?.browserAuth
    if (!browserAuth || typeof browserAuth.authenticatedUrl !== 'function') return Promise.resolve('')
    let authedUrl
    try {
      authedUrl = browserAuth.authenticatedUrl(`http://${authority}/`)
    } catch {
      return Promise.resolve('')
    }
    return fetchAuthCookie(authedUrl, authority).then((cookie) => {
      if (cookie) wsCookieCache.set(authority, { cookie, at: Date.now() })
      return cookie
    })
  }

  function proxyUpgrade(request, socket, head, injectedCookie = '') {
    const upstream = net.connect({ host: options.upstreamHost, port: upstreamPort }, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`]
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`)
      }
      if (injectedCookie) lines.push(`cookie: ${injectedCookie}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head && head.length > 0) upstream.write(head)
      upstream.once('data', (chunk) => {
        log(`WS 上游响应 ${String(chunk).split('\r\n')[0]}`)
      })
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

  function proxyUpgradeWithCookie(request, socket, head) {
    const host = String(request.headers.host ?? '')
    const suffix = `${host}${request.url ?? ''}`
    const hasCookie = String(request.headers.cookie ?? '').length > 0
    if (hasCookie) {
      log(`WS 升级 ${suffix} cookie=client`)
      proxyUpgrade(request, socket, head)
      return
    }
    mintUpgradeCookie(host.toLowerCase()).then((minted) => {
      log(`WS 升级 ${suffix} cookie=${minted ? 'injected' : 'none'}`)
      proxyUpgrade(request, socket, head, minted)
    })
  }

  const handleBridgeRequest = (request, response) => {
    let url
    try {
      const hostHeader = String(request.headers.host ?? '')
      // Host 头是攻击者可控的：非法 authority 会让 new URL 抛异常，
      // 而这里在请求处理链最外层，异常没人接就会打崩整个 DSH 宿主进程。
      if (!hostHeader || /\s/.test(hostHeader)) throw new Error('bad-host')
      url = new URL(request.url ?? '/', `http://${hostHeader}`)
    } catch {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: 'bad-request-url' }))
      return
    }
    const requestHost = String(request.headers.host ?? '')

    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')

    // 桌面端页面跑在 dsh-app://app 这类自定义协议下，请求桥属于跨源。
    // 只对白名单来源回 CORS——用 * 等于把接口开给任意网页。
    const requestOrigin = String(request.headers.origin ?? '')
    if (requestOrigin && isAllowedOrigin(requestOrigin)) {
      response.setHeader('access-control-allow-origin', requestOrigin)
      response.setHeader('vary', 'origin')
      response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      response.setHeader('access-control-allow-headers', 'content-type, x-dsh-token, authorization')
      response.setHeader('access-control-max-age', '600')
    }

    if (request.method === 'OPTIONS') {
      if (requestOrigin && !isAllowedOrigin(requestOrigin)) {
        deny(response, 403, 'bad-origin')
        return
      }
      response.writeHead(204)
      response.end()
      return
    }

    // 敏感接口统一限速：体检/修复/出码/换码都是重操作，也是被打的主要目标。
    const SENSITIVE_PATHS = new Set(['/pair', '/pair.svg', '/pair.png', '/pair.html', '/pair/test', '/pair/claim', '/repair', '/ai-fix'])
    if (SENSITIVE_PATHS.has(url.pathname) && !rateLimit(request, 'sensitive', 40, 0.5)) {
      deny(response, 429, 'rate-limited')
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
      if (!allowToken(request, response, url, requestHost)) return
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
      if (!allowToken(request, response, url, requestHost)) return
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
      if (!allowToken(request, response, url, requestHost)) return
      // 游标优先用服务端自增的 seq（手机时钟不可信），旧的 since=<ts> 仍兼容。
      const afterSeq = Number(url.searchParams.get('afterSeq') ?? '')
      const since = Number(url.searchParams.get('since') ?? '')
      let list = events
      if (Number.isFinite(afterSeq) && afterSeq >= 0 && url.searchParams.has('afterSeq')) {
        list = events.filter((frame) => Number(frame.seq ?? 0) > afterSeq)
      } else if (Number.isFinite(since) && since > 0) {
        list = events.filter((frame) => Number(frame.ts) > since)
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, events: list, latestSeq: eventSeq }))
      return
    }

    if (url.pathname === '/trust') {
      if (!allowToken(request, response, url, requestHost)) return
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
      // 面板（本机进程）取配对信息；公网进来的必须带 token，避免把口令送进隧道。
      if (!allowToken(request, response, url, requestHost)) return
      const includeToken = remoteIsLoopback(request) && !looksPublic(requestHost)
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(JSON.stringify(pairingJson(requestHost, { includeToken })))
      return
    }

    // 一次性配对码换长期凭证：二维码里只有 60 秒有效、单次使用的 code。
    if (url.pathname === '/pair/claim') {
      const code = String(url.searchParams.get('code') ?? request.headers['x-pair-code'] ?? '').trim()
      if (!rateLimit(request, 'claim', 10, 0.2)) {
        deny(response, 429, 'rate-limited')
        return
      }
      const entry = claimPairCode(code)
      if (!entry) {
        deny(response, 401, 'bad-pair-code')
        return
      }
      const info = pairing(requestHost)
      log(`配对码已兑换 peer=${request.socket?.remoteAddress ?? '?'}`)
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({
        ok: true,
        v: 2,
        name: info.name,
        token,
        base: info.lan.base,
        web: info.lan.web,
        lan: info.lan,
        lanAll: info.lanAll,
        tunnel: info.public ? info.public.base : '',
        proxyPort: options.proxyPort,
      }))
      return
    }

    if (url.pathname === '/pair/test') {
      // 面板在生成二维码之前先跑一遍体检：局域网 / 反代 / 隧道三段都通了才出码。
      if (!allowToken(request, response, url, requestHost)) return
      pairTest().then((result) => {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(JSON.stringify(result))
      }).catch((error) => {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, checks: [], error: String(error?.message ?? error) }))
      })
      return
    }

    if (url.pathname === '/pair.svg' || url.pathname === '/pair.png') {
      if (!allowToken(request, response, url, requestHost)) return
      try {
        const svg = svgOf(pairing(requestHost).payload, { scale: 8, margin: 4 })
        response.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'no-store',
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
      // 这页会把配对链接（含一次性 code）整段打出来，只给本机看。
      if (!allowToken(request, response, url, requestHost)) return
      const info = pairing(requestHost)
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
<p>App 首页 →「扫一扫」→ 对准屏幕。二维码里只有 60 秒有效的一次性配对码，扫完自动换成设备凭证。</p>
<div class="card"><img src="/pair.svg" width="280" height="280" alt="pairing qr"/></div>
<p>${publicNote}</p>
<code>${info.payload}</code>
</body></html>`
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
      return
    }

    if (url.pathname === '/public') {
      if (!allowToken(request, response, url, requestHost)) return
      const value = String(url.searchParams.get('url') ?? '').trim()
      if (value) {
        if (!/^https?:\/\/[^\s/]+/i.test(value)) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: false, error: 'bad-url' }))
          return
        }
        const candidate = value.replace(/\/+$/, '')
        // 不采信调用方的自报：自己回打公网 /health，返回 200 且服务名对得上才算"已验证"。
        // 校验失败不是网关错误（502），只是一个"还没验过"的状态，所以回 200 + verified:false，
        // 让调用方自己决定怎么提示；真正写进二维码仍然只认 verified 的结果。
        verifyTunnel(candidate, tunnelAuthority(candidate)).then((ok) => {
          if (ok) {
            publicUrl = candidate
            writePublicUrl(publicUrl)
            tunnelVerifiedAt = Date.now()
            trustHost(tunnelAuthority(candidate))
            log(`公网地址=${publicUrl}（已回打校验）`)
          } else {
            log(`公网地址校验失败，暂不写进二维码：${candidate}`)
          }
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify({
            ok: Boolean(ok),
            verified: Boolean(ok),
            public: ok ? publicUrl : (publicUrl || null),
            candidate,
            error: ok ? undefined : 'public-unverified',
          }))
        })
        return
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, public: publicUrl || null, verified: tunnelFresh() }))
      return
    }

    // 一键修复：把卡住的隧道进程换掉，等到一条真的能被公网访问的地址再返回。
    if (url.pathname === '/repair') {
      // 会杀进程、清公网地址：必须是带 token 的请求，不能被人用 <img> 之类触发。
      if (!allowHeaderToken(request, response)) return
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
        if (tunnelRestartTimer) {
          clearTimeout(tunnelRestartTimer)
          tunnelRestartTimer = null
        }
        const dying = tunnelChild
        if (dying) {
          try {
            dying.kill()
          } catch {
            // 进程可能已经没了，下面的 exit/超时会兜住。
          }
          // 等它真的退出再拉新的：kill 是异步的，干等固定毫秒数会撞上"tunnelChild 还在 → 不重启"。
          await new Promise((resolve) => {
            let finished = false
            const finish = () => {
              if (finished) return
              finished = true
              clearTimeout(timer)
              resolve()
            }
            const timer = setTimeout(finish, 5000)
            dying.once('exit', finish)
          })
        }
        tunnelAttempt = 0
        if (tunnelWaitTimer) {
          clearTimeout(tunnelWaitTimer)
          tunnelWaitTimer = null
        }
        // 2) 重新拉起，最多等 120 秒。
        startTunnel()
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
      // 这是"让 agent 在电脑上跑命令改文件"的动作，只允许本机进程 + 带 token 的请求。
      if (!allowHeaderToken(request, response)) return
      if (!remoteIsLoopback(request)) {
        deny(response, 403, 'loopback-only')
        return
      }
      if (!rateLimit(request, 'ai-fix', 3, 0.02)) {
        deny(response, 429, 'rate-limited')
        return
      }
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

  // 两个客户端都走 HTTP 轮询，桥不再自己实现 WebSocket 服务端（手写 RFC6455 的攻击面不值当）。
  // 升级请求一律按老行为反代给 DSH。
  server.on('upgrade', (request, socket, head) => {
    proxyUpgradeWithCookie(request, socket, head)
  })

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
          // 广播只用来"发现电脑在哪"，故意不带 token：同网段任何设备都能收到这包，
          // 带口令等于把登录凭据撒出去。配对仍然要扫二维码或手动填 token。
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
  /** 等 quick tunnel 地址的定时器：到点没地址就把进程杀掉重来。 */
  let tunnelWaitTimer = null
  /** 重启 cloudflared 的延时定时器。必须和上面那个分开，否则进程快退时重启链会断（旧代码的坑）。 */
  let tunnelRestartTimer = null
  let tunnelAttempt = 0
  let tunnelStopped = false
  /** 本轮 cloudflared 是什么时候拉起的，/pair/test 用它算"已经等了多久"。 */
  let tunnelStartedAt = 0
  /** 只有"最近真的从公网打通 /health"的隧道才会写进二维码；否则宁可不给，免得手机扫到死链。 */
  let tunnelVerifiedAt = 0
  let tunnelWatch = null
  /** 复核连续打不通的次数：quick tunnel 域名会被回收，但单次抖动不该动它。 */
  let tunnelWatchMisses = 0
  const TUNNEL_FRESH_MS = 15 * 60 * 1000

  function tunnelAuthority(value) {
    return String(value ?? '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
  }

  function tunnelFresh() {
    return Boolean(publicUrl) && tunnelVerifiedAt > 0 && Date.now() - tunnelVerifiedAt < TUNNEL_FRESH_MS
  }

  /** 隧道当前的完整状态，给 /pair/test、/repair 和日志用。 */
  function tunnelState() {
    const mode = String(options.tunnel ?? 'off')
    const exe = String(options.cloudflaredPath ?? '')
    return {
      mode,
      exe,
      exeOk: Boolean(exe) && fs.existsSync(exe),
      running: Boolean(tunnelChild),
      pid: tunnelChild?.pid ?? 0,
      startedAt: tunnelStartedAt,
      waitMs: Number(options.tunnelWaitMs ?? 90_000),
      attempt: tunnelAttempt,
      pendingRestart: Boolean(tunnelRestartTimer),
      url: publicUrl,
      fresh: tunnelFresh(),
      tail: tunnelTail.slice(-2).join(' | '),
    }
  }

  /**
   * 隧道不可用时，到底卡在哪一步：开关没开 / 没找到 cloudflared / 正在建 / 正在重试 / 地址没校验过。
   * 以前不管什么原因都写"未启用（config.tunnel 设为 auto 后重启 Desktop）"，最容易把人带沟里。
   */
  function tunnelHint() {
    const state = tunnelState()
    if (state.mode !== 'auto') {
      if (state.url) {
        return `固定地址模式：${state.url}`
      }
      return `未启用：config.tunnel 现在是 ${state.mode}，要快速隧道就改成 auto，要固定地址就填 publicUrl`
    }
    if (!state.exeOk) return `未启用：找不到 cloudflared（cloudflaredPath=${state.exe || '空'}）`
    if (state.running) {
      const waited = state.startedAt > 0 ? Math.round((Date.now() - state.startedAt) / 1000) : 0
      return `cloudflared 正在建隧道 pid=${state.pid}（已等 ${waited}s，超过 ${Math.round(state.waitMs / 1000)}s 没地址会自动重来）`
    }
    if (state.pendingRestart) return `cloudflared 刚退出，正在自动重试（已失败 ${state.attempt} 次）`
    if (state.url) return `地址 ${state.url} 还没通过公网校验（本机 DNS 抖动时会在 Cloudflare 边缘 IP 上重试）`
    return `cloudflared 没有在跑，也没有排重试（看日志 ~/.dsh/dshremote-bridge.log 尾部${state.tail ? `：${state.tail}` : ''}）`
  }

  function scheduleTunnel(delayMs) {
    if (tunnelStopped || tunnelRestartTimer || tunnelChild) return
    tunnelRestartTimer = setTimeout(() => {
      tunnelRestartTimer = null
      startTunnel()
    }, delayMs)
    if (typeof tunnelRestartTimer.unref === 'function') tunnelRestartTimer.unref()
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
        // 地址已经拿到并校验通过，就别再让"等地址"的看门狗到点把这只好隧道杀掉。
        if (tunnelWaitTimer) {
          clearTimeout(tunnelWaitTimer)
          tunnelWaitTimer = null
        }
        if (clean !== publicUrl) {
          publicUrl = clean
          trustHost(authority)
          writePublicUrl(publicUrl)
          log(`隧道就绪 ${publicUrl}`)
        }
        tunnelVerifiedAt = Date.now()
        tunnelAttempt = 0
        tunnelWatchMisses = 0
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

  /**
   * 固定公网地址模式（如 Tailscale Funnel）：地址由外部服务提供、永远不会变，
   * 所以不启用 cloudflared，只在启动后回打一次 /health 自证可用，再交给 watchTunnel 定时复核。
   */
  function verifyConfiguredPublic(attempt = 1) {
    if (tunnelStopped || String(options.tunnel ?? 'off') === 'auto') return
    if (!publicUrl) return
    const authority = tunnelAuthority(publicUrl)
    if (!authority) return
    verifyTunnel(publicUrl, authority).then((ok) => {
      if (ok) {
        tunnelVerifiedAt = Date.now()
        tunnelWatchMisses = 0
        trustHost(authority)
        log(`公网地址=${publicUrl}（固定地址模式，已回打校验）`)
        return
      }
      if (attempt >= 5) {
        log(`固定公网地址校验失败：${publicUrl}（会每 60 秒再试；检查 Tailscale Funnel 是否还开着）`)
        return
      }
      const timer = setTimeout(() => verifyConfiguredPublic(attempt + 1), 3000 * attempt)
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
          tunnelWatchMisses = 0
          return
        }
        tunnelWatchMisses += 1
        // 连续三次打不通才认死：本机 DNS/TLS 抖动很常见，一次失败的代价是把好地址从二维码里撤掉。
        if (tunnelWatchMisses < 3) return
        tunnelWatchMisses = 0
        if (tunnelVerifiedAt > 0) {
          log(`隧道 ${publicUrl} 已失效，等待新地址`)
        }
        tunnelVerifiedAt = 0
        if (tunnelChild && String(options.tunnel ?? 'off') === 'auto') {
          log('隧道域名疑似被回收，重启 cloudflared 换新地址')
          try {
            tunnelChild.kill()
          } catch {
            // 交给退出事件。
          }
        }
      })
    }, 60_000)
    if (typeof tunnelWatch.unref === 'function') tunnelWatch.unref()
  }

  /** 从本机经隧道打一次 /health，确认这条隧道真的能用。 */
  function verifyTunnel(base, authority) {
    const parsed = (() => {
      try {
        return new URL(base)
      } catch {
        return null
      }
    })()
    const secure = !parsed || parsed.protocol === 'https:'
    const host = String(authority ?? '').replace(/:\d+$/, '')
    const tunnelHost = secure && isTunnelHost(host)
    const fixedPublicHost = secure && !tunnelHost && looksPublic(host)
    const port = secure ? 443 : Number(parsed?.port || 80)
    const agent = secure ? https : http
    const attempt = (force) => new Promise((resolve) => {
      let settled = false
      const done = (ok) => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        const request = agent.request({
          hostname: host,
          port,
          path: '/health',
          method: 'GET',
          timeout: 8000,
          headers: { host: authority },
          ...(tunnelHost ? { lookup: tunnelLookup(host, { force }) } : {}),
          ...(fixedPublicHost ? { lookup: publicHostLookup(host, { force }) } : {}),
        }, (response) => {
          if (fixedPublicHost) rememberPublicIp(host, response.socket?.remoteAddress)
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
    // 这一轮没打通也别急着判死：Cloudflare 钉边缘 IP、固定公网域名复用上次解析结果，再验一次。
    const retryable = tunnelHost || fixedPublicHost
    return attempt(false).then((ok) => {
      if (ok || !retryable) return ok
      return attempt(true).then((second) => {
        if (!second && fixedPublicHost) forgetPublicIp(host)
        return second
      })
    })
  }

  function startTunnel() {
    if (tunnelStopped || tunnelChild) return
    if (String(options.tunnel ?? 'off') !== 'auto') return
    const exe = String(options.cloudflaredPath ?? '')
    if (!exe || !fs.existsSync(exe)) {
      // 路径配错或者还没装好也要隔一会儿重来：把 cloudflared 放对位置后不用重启 Desktop 就能自愈。
      log(`隧道未启动：找不到 cloudflared（${exe || '未配置 cloudflaredPath'}），60s 后再试`)
      scheduleTunnel(60_000)
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
    tunnelStartedAt = Date.now()
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
    if (tunnelWaitTimer) clearTimeout(tunnelWaitTimer)
    tunnelWaitTimer = setTimeout(() => {
      tunnelWaitTimer = null
      if (tunnelChild !== child) return
      log(`隧道 ${Math.round(Number(options.tunnelWaitMs ?? 90000) / 1000)}s 内没拿到地址，重启 cloudflared`)
      try {
        child.kill()
      } catch {
        // 杀不掉就让退出事件走重启流程。
      }
    }, Number(options.tunnelWaitMs ?? 90000))
    if (typeof tunnelWaitTimer.unref === 'function') tunnelWaitTimer.unref()
    child.on('error', (error) => log(`隧道进程错误：${error?.message ?? error}`))
    child.on('exit', (code) => {
      if (tunnelChild === child) tunnelChild = null
      // 关键：退出时把"等地址"的定时器清掉。旧代码把它和"重启延时"共用一个变量，
      // 于是 scheduleTunnel 看到非空就 return，cloudflared 一快退自愈链就永久断掉。
      if (tunnelWaitTimer) {
        clearTimeout(tunnelWaitTimer)
        tunnelWaitTimer = null
      }
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
      verifyConfiguredPublic()
    })()

    return () => {
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
      if (tunnelWaitTimer) {
        clearTimeout(tunnelWaitTimer)
        tunnelWaitTimer = null
      }
      if (tunnelRestartTimer) {
        clearTimeout(tunnelRestartTimer)
        tunnelRestartTimer = null
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
        server.close()
      proxy?.close()
      log('已停止')
    }
  })
}

export default { name: 'dshremote-bridge', inject: ['connection', 'webServer', 'typertGateway'], apply }

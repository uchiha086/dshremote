// 自测：/pair、/pair.svg、/public、UDP 自动发现广播。
// 用假 ctx 起一份桥，不需要真的 DSH 宿主。
import dgram from 'node:dgram'
import http from 'node:http'
import { apply } from '../lib/index.mjs'

const TOKEN = 'testtoken0123456789abcdef'
const PORT = 3201
const PROXY_PORT = 3200
const DISCOVERY_PORT = 3202

let disposer = null
const ctx = {
  webServer: { port: 7999 },
  connection: { trustedHosts: [], browserAuth: null },
  on: () => () => {},
  effect: (fn) => {
    disposer = fn()
  },
}

apply(ctx, {
  port: PORT,
  proxyPort: PROXY_PORT,
  token: TOKEN,
  tokenFile: 'C:\\Users\\user\\Documents\\deepseek-harness\\default-workspace\\bridge-test.token',
  hostsFile: 'C:\\Users\\user\\Documents\\deepseek-harness\\default-workspace\\bridge-test.hosts',
  publicUrlFile: 'C:\\Users\\user\\Documents\\deepseek-harness\\default-workspace\\bridge-test.public',
  logFile: 'C:\\Users\\user\\Documents\\deepseek-harness\\default-workspace\\bridge-test.log',
  proxyEnabled: false,
  discoveryPort: DISCOVERY_PORT,
})

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** undici 不允许改 Host 头，要模拟"经隧道域名访问"只能自己发 http 请求。 */
function fetchWithHost(pathname, hostHeader) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers: { host: hostHeader } },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode, body }))
      },
    )
    request.on('error', reject)
    request.end()
  })
}

// 收一次广播
const beacon = new Promise((resolve) => {
  const socket = dgram.createSocket({ type: 'udp4' })
  const timer = setTimeout(() => {
    try {
      socket.close()
    } catch {}
    resolve(null)
  }, 5000)
  socket.on('message', (msg) => {
    clearTimeout(timer)
    try {
      socket.close()
    } catch {}
    resolve(String(msg))
  })
  socket.on('error', () => {})
  socket.bind(DISCOVERY_PORT, () => {})
})

await wait(900)

const base = `http://127.0.0.1:${PORT}`
const pairRes = await fetch(`${base}/pair`)
const pairJson = await pairRes.json()
check('GET /pair 200', pairRes.status === 200)
check('payload 带 scheme/token', pairJson.payload.startsWith('dshremote://pair?') && pairJson.payload.includes(TOKEN), pairJson.payload.slice(0, 60))
check('base 是局域网地址', /^http:\/\/\d+\.\d+\.\d+\.\d+:3201$/.test(pairJson.base), pairJson.base)

const svgRes = await fetch(`${base}/pair.svg`)
const svg = await svgRes.text()
check('GET /pair.svg 200 且是 SVG', svgRes.status === 200 && svg.startsWith('<svg') && svg.includes('<rect'), `${svg.length} bytes`)

const pubRes = await fetch(`${base}/public?token=${TOKEN}&url=https://demo.example.com/`)
const pubJson = await pubRes.json()
check('GET /public 设置成功', pubRes.status === 200 && pubJson.public === 'https://demo.example.com', JSON.stringify(pubJson))

const pairJson2 = await (await fetch(`${base}/pair`)).json()
check('设置后 payload 用公网地址（请求来自回环时仍给局域网）', pairJson2.base === pairJson.base, pairJson2.base)
check('/pair 里能看到公网地址', pairJson2.public?.base === 'https://demo.example.com', JSON.stringify(pairJson2.public))

const badPub = await fetch(`${base}/public?token=wrong&url=https://x.example`)
check('GET /public 错 token → 401', badPub.status === 401)

const html = await (await fetch(`${base}/pair.html`)).text()
check('/pair.html 含二维码链接', html.includes('/pair.svg') && html.includes('扫'))

const publicHostPair = await fetchWithHost(`/pair`, 'demo.example.com')
check('经公网 Host 访问 /pair 无 token → 401', publicHostPair.status === 401, `status=${publicHostPair.status}`)
const publicHostPair2 = await fetchWithHost(`/pair?token=${TOKEN}`, 'demo.example.com')
check('经公网 Host 带 token → 200 且用公网地址', publicHostPair2.status === 200 && JSON.parse(publicHostPair2.body).base === 'https://demo.example.com', `${publicHostPair2.status} ${publicHostPair2.body.slice(0, 60)}`)

const got = await beacon
let beaconJson = null
try {
  beaconJson = JSON.parse(got)
} catch {}
check('收到 UDP 广播', Boolean(beaconJson), got ? got.slice(0, 80) : 'timeout')
check('广播字段齐全', Boolean(beaconJson?.svc === 'dshremote' && beaconJson?.port === PORT && beaconJson?.token === TOKEN))

disposer?.()
const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)

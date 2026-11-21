// 自测：/pair、/pair/claim、/pair.svg、/public、UDP 自动发现广播。
// 用假 ctx 起一份桥，不需要真的 DSH 宿主。
import dgram from 'node:dgram'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.mjs'

const TOKEN = 'testtoken0123456789abcdef'
const PORT = 3201
const PROXY_PORT = 3200
const DISCOVERY_PORT = 3202
const STUB_PORT = 3203
const TMP = path.join(os.tmpdir(), 'dshremote-test')

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
  tokenFile: path.join(TMP, 'bridge-test.token'),
  hostsFile: path.join(TMP, 'bridge-test.hosts'),
  publicUrlFile: path.join(TMP, 'bridge-test.public'),
  logFile: path.join(TMP, 'bridge-test.log'),
  proxyEnabled: false,
  discovery: true,
  discoveryPort: DISCOVERY_PORT,
  tunnel: 'off',
})

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** undici 不允许改 Host 头，要模拟"经隧道域名访问"只能自己发 http 请求。 */
function fetchWithHost(pathname, hostHeader, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers: { ...headers, host: hostHeader } },
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

// 一个"假公网"：/public 会回打它的 /health 校验，返回符合要求的 body 即算通过。
const stub = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: true, service: 'dshremote-bridge', version: '0.2.0' }))
})
await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve))
const PUBLIC_STUB = `http://127.0.0.1:${STUB_PORT}`

// 收一次广播
const beacon = new Promise((resolve) => {
  const socket = dgram.createSocket({ type: 'udp4' })
  const timer = setTimeout(() => {
    try {
      socket.close()
    } catch {}
    resolve(null)
  }, 6000)
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

await wait(1200)

const base = `http://127.0.0.1:${PORT}`
const pairRes = await fetch(`${base}/pair`)
const pairJson = await pairRes.json()
check('GET /pair 200', pairRes.status === 200)
check('payload 是 v2 且带一次性 code', pairJson.payload.startsWith('dshremote://pair?v=2') && Boolean(pairJson.code), pairJson.payload.slice(0, 60))
check('payload 不再带长期 token', !pairJson.payload.includes(TOKEN))
check('base 是局域网地址', /^http:\/\/\d+\.\d+\.\d+\.\d+:3201$/.test(pairJson.base), pairJson.base)

const claim = await fetch(`${base}/pair/claim?code=${encodeURIComponent(pairJson.code)}`)
const claimJson = await claim.json()
check('GET /pair/claim 用 code 换到 token', claim.status === 200 && claimJson.token === TOKEN, JSON.stringify(claimJson).slice(0, 120))
check('claim 返回连接所需地址', claimJson.base === pairJson.base && Boolean(claimJson.web), JSON.stringify(claimJson).slice(0, 120))
const replay = await fetch(`${base}/pair/claim?code=${encodeURIComponent(pairJson.code)}`)
check('同一个 code 不能二次使用', replay.status === 401, String(replay.status))
const badCode = await fetch(`${base}/pair/claim?code=nope`)
check('错误 code → 401', badCode.status === 401, String(badCode.status))

const svgRes = await fetch(`${base}/pair.svg`)
const svg = await svgRes.text()
check('GET /pair.svg 200 且是 SVG', svgRes.status === 200 && svg.startsWith('<svg') && svg.includes('<rect'), `${svg.length} bytes`)

const pubRes = await fetch(`${base}/public?token=${TOKEN}&url=${encodeURIComponent(PUBLIC_STUB)}`)
const pubJson = await pubRes.json()
check('GET /public 校验通过后设置成功', pubRes.status === 200 && pubJson.public === PUBLIC_STUB, JSON.stringify(pubJson))

const badPub = await fetch(`${base}/public?token=${TOKEN}&url=https://no-such-host.example/`)
const badPubJson = await badPub.json()
// 校验失败只是"还没验过"，不该伪装成网关错误（502）；调用方看 verified:false 自己提示。
check('GET /public 校验不通过 → 200 + verified:false', badPub.status === 200 && badPubJson.verified === false, `${badPub.status} ${JSON.stringify(badPubJson)}`)

const pairJson2 = await (await fetch(`${base}/pair`)).json()
check('设置后 payload 仍以局域网为主（回环请求）', pairJson2.base === pairJson.base, pairJson2.base)
check('/pair 里能看到公网地址', pairJson2.public?.base === PUBLIC_STUB, JSON.stringify(pairJson2.public))

const htmlPublic = await fetchWithHost('/pair.html', 'dsh.example.com')
check('公网 Host 打开 /pair.html 无 token → 401', htmlPublic.status === 401, String(htmlPublic.status))
const html = await (await fetch(`${base}/pair.html`)).text()
check('/pair.html 含二维码与一次性码说明', html.includes('/pair.svg') && html.includes('60'))

const publicHostPair = await fetchWithHost('/pair', 'dsh.example.com')
check('经公网 Host 访问 /pair 无 token → 401', publicHostPair.status === 401, `status=${publicHostPair.status}`)
const publicHostPair2 = await fetchWithHost(`/pair?token=${TOKEN}`, 'dsh.example.com')
check('经公网 Host 带 token → 200 且用公网地址', publicHostPair2.status === 200 && JSON.parse(publicHostPair2.body).base === PUBLIC_STUB, `${publicHostPair2.status} ${publicHostPair2.body.slice(0, 60)}`)

// /repair 与 /ai-fix 必须带请求头 token（query 不算），/ai-fix 还要求回环
const repairQuery = await fetchWithHost(`/repair?token=${TOKEN}`, 'dsh.example.com')
check('/repair 只给 query token → 401', repairQuery.status === 401, String(repairQuery.status))
const aiFixRemote = await fetchWithHost('/ai-fix', 'dsh.example.com', { 'x-dsh-token': TOKEN })
check('/ai-fix 非回环 → 403', aiFixRemote.status === 403, String(aiFixRemote.status))

const got = await beacon
let beaconJson = null
try {
  beaconJson = JSON.parse(got)
} catch {}
check('收到 UDP 广播', Boolean(beaconJson), got ? got.slice(0, 80) : 'timeout')
check('广播字段齐全', Boolean(beaconJson?.svc === 'dshremote' && beaconJson?.port === PORT))
check('广播里不含 token', Boolean(beaconJson) && beaconJson.token === undefined)

disposer?.()
stub.close()
const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)

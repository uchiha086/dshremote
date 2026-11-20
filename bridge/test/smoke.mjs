// 冒烟自测：健康检查、事件总线、鉴权边界。
// 用假 ctx 起一份桥，不需要真的 DSH 宿主（也不连网络）。
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.mjs'

const PORT = 3399
const PROXY_PORT = 3398
const TOKEN = 'testtoken-0123456789'

const handlers = new Map()
let disposer = null

const ctx = {
  webServer: { port: 7999 },
  connection: { trustedHosts: [], browserAuth: null },
  on(name, fn) {
    handlers.set(name, fn)
    return () => handlers.delete(name)
  },
  effect(fn) {
    const result = fn()
    if (typeof result === 'function') disposer = result
    return () => {}
  },
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 用自建请求发，才能控制 Host 头（模拟经隧道域名访问）。 */
function request(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const PUBLIC_HOST = 'dsh.example.com'

async function main() {
  apply(ctx, {
    port: PORT,
    proxyPort: PROXY_PORT,
    bind: '127.0.0.1',
    token: TOKEN,
    tokenFile: path.join(os.tmpdir(), 'dshremote-smoke.token'),
    hostsFile: path.join(os.tmpdir(), 'dshremote-smoke.hosts'),
    publicUrlFile: path.join(os.tmpdir(), 'dshremote-smoke.public'),
    logFile: path.join(os.tmpdir(), 'dshremote-smoke.log'),
    proxyEnabled: false,
    discovery: false,
    tunnel: 'off',
  })
  await sleep(700)

  // 1. /health
  const health = JSON.parse((await request('/health')).body)
  check('health 返回 ok', health.ok === true && health.service === 'dshremote-bridge', JSON.stringify(health))

  // 2. 事件总线：伪造宿主事件
  const onSessionEvent = handlers.get('session/event')
  check('注册了 session/event 处理器', typeof onSessionEvent === 'function')

  onSessionEvent(
    { id: 'session-abc' },
    { type: 'session/title', data: { title: '修构建问题' }, seq: 10 },
  )
  onSessionEvent(
    { id: 'session-abc' },
    {
      type: 'user/message',
      data: { content: [{ type: 'text', text: '帮我看下 hvigor 为什么报 00303024' }] },
      seq: 11,
    },
  )
  onSessionEvent(
    { id: 'session-abc' },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '因为 modelVersion 没写一致的版本号，两个文件都要写。' }] } },
      seq: 12,
    },
  )
  onSessionEvent(
    { id: 'session-abc' },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'natural' } }, seq: 13 },
  )

  // 3. /events —— 回环免 token
  const loopback = await request('/events')
  check('/events 回环免 token', loopback.status === 200, String(loopback.status))

  // 4. /events —— 公网 Host 无 token 必须 401
  const noToken = await request('/events', { host: PUBLIC_HOST })
  check('/events 公网 Host 无 token → 401', noToken.status === 401, String(noToken.status))

  // 5. /events —— 公网 Host 用请求头带 token
  const viaHeader = await request('/events', { host: PUBLIC_HOST, 'x-dsh-token': TOKEN })
  const body = JSON.parse(viaHeader.body)
  const turnEnd = body.events.find((item) => item.type === 'turn_end')
  check('/events 请求头带 token → 200', viaHeader.status === 200, String(viaHeader.status))
  check('事件里带 turn_end', Boolean(turnEnd), `${body.events.length} 条`)
  check('turn_end 带会话标题', turnEnd?.sessionTitle === '修构建问题', String(turnEnd?.sessionTitle))
  check('turn_end 带提问', String(turnEnd?.question || '').includes('00303024'))
  check('turn_end 带回复摘要', String(turnEnd?.answerHead || '').includes('modelVersion'))
  check('turn_end 状态归一为 done', turnEnd?.status === 'done', String(turnEnd?.status))
  check('turn_end 带 turn 序号', turnEnd?.turn === 2, String(turnEnd?.turn))
  check('每个事件带单调 seq', body.events.every((item, i) => i === 0 || item.seq > body.events[i - 1].seq))
  check('响应带 latestSeq', Number(body.latestSeq) >= Number(turnEnd?.seq), String(body.latestSeq))

  // 6. afterSeq 增量拉取
  const afterSeq = Number(turnEnd?.seq || 0)
  const incremental = JSON.parse((await request(`/events?afterSeq=${afterSeq}`)).body)
  check('afterSeq 过滤掉已读事件', incremental.events.every((item) => Number(item.seq) > afterSeq))

  // 7. 错误 token 被拒（公网 Host 下）
  const wrong = await request(`/events?token=wrong`, { host: PUBLIC_HOST })
  check('错误 token → 401', wrong.status === 401, String(wrong.status))

  // 8. /auth/url：无 token 401；有 token 但没有 connection 服务 → 503
  check('/auth/url 无 token → 401', (await request('/auth/url', { host: PUBLIC_HOST })).status === 401)
  check('/auth/url 无 browserAuth → 503', (await request(`/auth/url?token=${TOKEN}`, { host: PUBLIC_HOST })).status === 503)

  // 9. 非法 Host 不再崩进程
  const badHost = await request('/', { host: 'bad host with spaces' })
  check('非法 Host → 400 而不是崩溃', badHost.status === 400, String(badHost.status))
  const stillAlive = JSON.parse((await request('/health')).body)
  check('非法 Host 之后进程仍存活', stillAlive.ok === true)

  disposer?.()
  await sleep(200)

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

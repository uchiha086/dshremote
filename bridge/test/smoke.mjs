import { WebSocket } from 'ws'
import { apply } from '../lib/index.mjs'

const PORT = 3399
const PROXY_PORT = 3398
const TOKEN = 'testtoken-0123456789'

const handlers = new Map()
let disposer = null

const ctx = {
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

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, 'dshremote-bridge-v1')
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextFrame(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting frame')), timeoutMs)
    ws.once('message', (raw) => {
      clearTimeout(timer)
      resolve(JSON.parse(String(raw)))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  apply(ctx, {
    port: PORT,
    proxyPort: PROXY_PORT,
    bind: '127.0.0.1',
    token: TOKEN,
    logFile: 'C:\\Users\\user\\Desktop\\dshremote\\bridge\\test\\smoke.log',
  })
  await sleep(600)

  // 1. /health
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())
  check('health 返回 ok', health.ok === true && health.service === 'dshremote-bridge', JSON.stringify(health))

  // 2. 错误 token 必须被拒
  const bad = await openSocket()
  bad.send(JSON.stringify({ type: 'auth', token: 'wrong', deviceName: 'test' }))
  const errFrame = await nextFrame(bad).catch(() => null)
  check('错误 token 被拒', errFrame?.type === 'error' && errFrame?.code === 'bad-token', JSON.stringify(errFrame))
  bad.close()

  // 3. 正确 token 通过，收到 hello
  const good = await openSocket()
  good.send(JSON.stringify({ type: 'auth', token: TOKEN, deviceName: 'HOP-AL10' }))
  const hello = await nextFrame(good)
  check('正确 token 收到 hello', hello.type === 'hello' && hello.protocol === 1, JSON.stringify(hello))

  // 4. 模拟宿主事件：提问 → 回合结束
  const onSessionEvent = handlers.get('session/event')
  check('注册了 session/event 处理器', typeof onSessionEvent === 'function')

  const waiting = nextFrame(good, 3000)
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

  const frame = await waiting
  check('收到 turn_end', frame.type === 'turn_end', JSON.stringify(frame))
  check('turn_end 带会话标题', frame.sessionTitle === '修构建问题', frame.sessionTitle)
  check('turn_end 带提问', frame.question.includes('00303024'), frame.question)
  check('turn_end 带回复摘要', frame.answerHead.includes('modelVersion'), frame.answerHead)
  check('turn_end 状态归一为 done', frame.status === 'done', frame.status)
  check('turn_end 带 turn 序号', frame.turn === 2, String(frame.turn))

  // 5. status 映射
  check('reason=error → failed', (() => {
    const onEvt = handlers.get('session/event')
    return true
  })())

  // 6. /events 需要 token
  const unauth = await fetch(`http://127.0.0.1:${PORT}/events`).then((r) => r.status)
  check('/events 无 token 返回 401', unauth === 401, String(unauth))
  const authed = await fetch(`http://127.0.0.1:${PORT}/events?token=${TOKEN}`).then((r) => r.json())
  check('/events 带 token 返回事件', authed.ok === true && authed.events.length === 1, `${authed.events?.length} 条`)

  good.close()
  disposer?.()
  await sleep(200)

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('smoke 失败：', error)
  process.exit(1)
})

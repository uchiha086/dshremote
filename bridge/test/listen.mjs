// 手动联调客户端：像手机端那样连上桥插件，把收到的帧打到控制台（便于排查）。
// 用法：node test/listen.mjs <host> <port> <token>
import { WebSocket } from 'ws'

const host = process.argv[2] ?? '127.0.0.1'
const port = process.argv[3] ?? '3088'
const token = process.argv[4] ?? ''

if (!token) {
  console.error('缺少 token 参数：node test/listen.mjs 127.0.0.1 3088 <token>')
  process.exit(2)
}

function stamp() {
  return new Date().toISOString().slice(11, 19)
}

const ws = new WebSocket(`ws://${host}:${port}/ws`, 'dshremote-bridge-v1')

ws.on('open', () => {
  console.log(`[${stamp()}] 已连接，发送 auth`)
  ws.send(JSON.stringify({ type: 'auth', token, deviceName: 'pc-test-client' }))
})

ws.on('message', (raw) => {
  console.log(`[${stamp()}] <- ${String(raw)}`)
})

ws.on('close', (code, reason) => {
  console.log(`[${stamp()}] 断开 code=${code} reason=${String(reason)}`)
})

ws.on('error', (error) => {
  console.log(`[${stamp()}] 错误 ${error.message}`)
})

// 每 25 秒发一次应用层 ping，同时验证服务端 pong。
setInterval(() => {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }))
}, 25_000)

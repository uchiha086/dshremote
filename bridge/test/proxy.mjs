/**
 * 隧道反代自测：用一个假的宿主 ctx 起桥，再用一个桩服务当 DSH，
 * 验证「非桥路由 → 原样转给上游（Host 不变）」和「/trust 登记白名单」。
 *
 * 跑法： node test/proxy.mjs
 */
import assert from 'node:assert'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { apply } from '../lib/index.mjs'

const UPSTREAM_PORT = 39101
const BRIDGE_PORT = 39102

const seen = []

// 桩 DSH：回显收到的 Host 与路径
const upstream = http.createServer((req, res) => {
  seen.push({ host: req.headers.host, url: req.url })
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`upstream saw host=${req.headers.host} url=${req.url}`)
})
await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve))

const trustedHosts = []
const ctx = {
  webServer: { port: UPSTREAM_PORT },
  connection: {
    trustedHosts,
    browserAuth: { authenticatedUrl: (base) => `${base}${base.includes('?') ? '&' : '?'}token=stub` },
  },
  on: () => () => {},
  effect: (fn) => {
    fn()
    return () => {}
  },
}

apply(ctx, {
  port: BRIDGE_PORT,
  bind: '127.0.0.1',
  token: 'testtoken0123456789',
  proxyEnabled: false,
  proxyPort: 39103,
  upstreamPort: UPSTREAM_PORT,
  logFile: path.join(os.tmpdir(), 'dshremote-proxy.log'),
  tokenFile: path.join(os.tmpdir(), 'dshremote-proxy.token'),
  hostsFile: path.join(os.tmpdir(), 'dshremote-proxy.hosts'),
})

await new Promise((resolve) => setTimeout(resolve, 500))

function get(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: host ? { host } : {} }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

// 1) /health 走桥自己
const health = await get(BRIDGE_PORT, '/health')
assert.equal(health.status, 200, '/health 应该是 200')
assert.ok(health.body.includes('dshremote-bridge'), '/health 应该是桥的响应')

// 2) 其它路径原样转给上游，Host 必须保持调用方给的值（隧道域名场景）
const proxied = await get(BRIDGE_PORT, '/api/whatever?x=1', 'demo.trycloudflare.com')
assert.equal(proxied.status, 200)
assert.ok(proxied.body.includes('host=demo.trycloudflare.com'), `Host 应被原样透传，实际：${proxied.body}`)
assert.ok(proxied.body.includes('url=/api/whatever?x=1'), `路径应原样透传，实际：${proxied.body}`)

// 3) /trust 把域名登记进 trustedHosts，并落盘
const trust = await get(BRIDGE_PORT, '/trust?token=testtoken0123456789&host=DEMO.trycloudflare.com')
assert.equal(trust.status, 200)
assert.ok(trustedHosts.includes('demo.trycloudflare.com'), 'trustedHosts 应该多了小写化后的域名')

// 4) /trust 也要 token（回环 + 回环 Host 属于"本地面板"，必须换成公网 Host 才能测鉴权）
const badTrust = await get(BRIDGE_PORT, '/trust?token=nope&host=evil.example.com', 'demo.trycloudflare.com')
assert.equal(badTrust.status, 401)

// 5) 未登录的 /events 仍然 401（同样用公网 Host）
const events = await get(BRIDGE_PORT, '/events', 'demo.trycloudflare.com')
assert.equal(events.status, 401)

// 6) WebSocket 升级（非 /ws）应被透传：桩服务不认 upgrade，会回 200，这里只验证连接没被直接掐断
const upgradeStatus = await new Promise((resolve) => {
  const socket = net.connect(BRIDGE_PORT, '127.0.0.1', () => {
    socket.write(
      'GET /live HTTP/1.1\r\nHost: demo.trycloudflare.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    )
  })
  let data = ''
  socket.on('data', (chunk) => {
    data += chunk.toString('latin1')
    if (data.includes('\r\n')) {
      socket.destroy()
      resolve(data.split('\r\n')[0])
    }
  })
  socket.on('error', () => resolve('error'))
  setTimeout(() => {
    socket.destroy()
    resolve(data.split('\r\n')[0] ?? 'timeout')
  }, 2000)
})
assert.ok(/^HTTP\/1\.1 \d{3}/.test(upgradeStatus), `升级请求应该拿到上游的 HTTP 响应，实际：${upgradeStatus}`)

console.log('proxy 相关 6 项全部通过')
upstream.close()
process.exit(0)

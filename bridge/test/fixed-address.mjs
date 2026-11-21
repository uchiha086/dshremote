// 验证「固定地址模式」：假 ctx 起一个桥实例，tunnel: off + publicUrl 指向真实 Funnel。
// 断言：不拉 cloudflared；启动后自动回打校验；/pair 带固定地址；局域网地址是手机能连的家宽私网。
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { apply } from '../lib/index.mjs';

const token = 'testtoken0123456789abcdef';
const config = {
  enabled: true,
  port: 3298,
  bind: '127.0.0.1',
  token,
  proxyEnabled: true,
  proxyPort: 3299,
  upstreamHost: '127.0.0.1',
  upstreamPort: 3297,
  answerHeadChars: 120,
  questionChars: 200,
  // 日志也写临时文件：别把测试实例的启动记录混进真桥的 ~/.dsh/dshremote-bridge.log。
  logFile: path.join(os.tmpdir(), 'dshremote-fixed-test.log'),
  publicUrl: 'https://dsremote.tail5382cc.ts.net',
  publicUrlFile: path.join(os.tmpdir(), 'dshremote-fixed-test.public'),
  // 必须显式给临时 tokenFile：否则桥会把测试用 token 写进 ~/.dsh/dshremote-bridge.token，
  // 覆盖掉真 token（真发生过一次，导致手机端 401）。
  tokenFile: path.join(os.tmpdir(), 'dshremote-fixed-test.token'),
  extraHosts: [],
  hostsFile: path.join(os.tmpdir(), 'dshremote-fixed-test.hosts'),
  discovery: false,
  discoveryPort: 3290,
  tunnel: 'off',
  cloudflaredPath: 'C:\\nothing\\cloudflared.exe',
};

const cleanups = [];
const ctx = {
  connection: { trustedHosts: [], createPeer: () => ({}) },
  webServer: { port: 3297, register: () => () => {} },
  typertGateway: {},
  effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanups.push(d); },
  on: () => () => {},
};

apply(ctx, config);

const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: config.port, path: p, headers: { 'x-dsh-token': token } }, (r) => {
    let b = '';
    r.on('data', (c) => { b += c; });
    r.on('end', () => resolve({ status: r.statusCode, body: b }));
  }).on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

// 1) 等启动自证完成（最多 45 秒；走公网 DNS + TLS 首连可能慢）
let diag = null;
for (let i = 0; i < 15; i++) {
  await sleep(3000);
  try {
    diag = JSON.parse((await get('/pair/test')).body);
    const tunnelRows = (diag.checks || []).filter((c) => c.name.startsWith('隧道'));
    if (tunnelRows.length === 2 && tunnelRows.every((c) => c.ok)) break;
  } catch { /* 还没起来 */ }
}

const health = JSON.parse((await get('/health')).body);
const pair = JSON.parse((await get('/pair')).body);
const tunnelRows = (diag?.checks || []).filter((c) => c.name.startsWith('隧道'));

check('health 起来', health.ok === true, JSON.stringify(health));
check('固定地址模式不拉 cloudflared', !health.tunnel || health.tunnel.mode !== 'running', JSON.stringify(health.tunnel));
check('启动自动回打校验：隧道 → 桥', tunnelRows.some((c) => c.name === '隧道 → 桥' && c.ok), JSON.stringify(tunnelRows.map((c) => `${c.name}:${c.ok}`)));
check('启动自动回打校验：隧道 → DSH', tunnelRows.some((c) => c.name === '隧道 → DSH' && c.ok), JSON.stringify(tunnelRows.map((c) => `${c.name}:${c.ok}`)));
check('/pair 带固定地址', pair.tunnel === 'https://dsremote.tail5382cc.ts.net', String(pair.tunnel));
check('/pair payload 含 tunnel=', String(pair.payload || '').includes('tunnel=https%3A%2F%2Fdsremote.tail5382cc.ts.net'), String(pair.payload).slice(0, 130));
check('/pair payload 不含 token', !String(pair.payload || '').includes('token='), '');
check('局域网地址是家宽私网', /^http:\/\/(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(pair.lan?.base || ''), String(pair.lan?.base));
check('局域网地址不是 tailnet 100.x', !/^http:\/\/100\./.test(pair.lan?.base || ''), String(pair.lan?.base));

for (const fn of cleanups) { try { fn(); } catch { /* noop */ } }

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  (${c.detail})`}`);
  if (!c.ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);

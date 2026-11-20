# 安全策略

DSH Remote 是一个「让手机操作你自己电脑上的 DSH」的工具：电脑端插件 `dshremote-bridge` 会监听局域网端口、可以反代 DSH 的 Web 界面、能拉起 `cloudflared` 隧道、还能用你的身份在 DSH 里开一个会话。**它天生就是一个高权限组件**，所以下面这些边界请务必看清。

## 威胁模型

| 假设 | 说明 |
|---|---|
| 可信 | 你本人、你电脑上的本地进程、你电脑所在的局域网（可配置为不可信） |
| 部分可信 | Cloudflare 快速隧道（域名不可猜，但没有访问控制） |
| 不可信 | 公网上的其他人、同一 Wi-Fi 里的其他设备、二维码/深链可能被旁观者看到 |

## 已经做的防护（0.2.1 起）

- **凭据只走请求头**：`X-DSH-Token` 或 `Authorization: Bearer`。`?token=` 只为老客户端兼容保留，会进代理日志，不建议使用。
- **二维码不含 token**：0.2.1 起二维码里是 `v=2` 的**一次性配对码**（60 秒过期、只能换一次、最多同时存在 200 个）。手机扫到后调 `/pair/claim` 换回 token。
- **所有敏感接口都要 token**：`/pair`、`/pair.svg`、`/pair.png`、`/pair.html`、`/pair/test`、`/pair/claim`、`/repair`、`/ai-fix`、`/public`。公网 Host 访问时，回环地址也必须带 token。
- **`/ai-fix` 只允许本机回环调用**：它会用你的 `owner` 身份在 DSH 里新建会话并让 agent 改代码，等价于本机命令执行。非回环来源返回 403 `loopback-only`，并限流（3 次突发、0.02 次/秒）。
- **限流**：敏感路由统一令牌桶（40 次突发、0.5 次/秒），`/pair/claim` 另有限制（10 次突发、0.2 次/秒）。
- **非法 Host 不再打崩进程**：`new URL()` 包了 try/catch，返回 400 `bad-request-url`。
- **CORS 白名单**：只回显 `dsh-app://app`、`dsh-app://-`、`127.0.0.1`/`localhost` 的来源，不再发 `*`。
- **隧道地址必须自证**：`/public` 与隧道守护都会回打公网 `https://<隧道域名>/health`，返回 200 且 body 含 `dshremote-bridge` 才写进二维码；已发布的地址每 60 秒复核一次，失效就撤下。
- **UDP 发现广播不含 token**，且默认关闭（`discovery: false`）——广播里带口令等于把凭据撒给同网段所有人。
- **深链要用户确认**：两端收到 `dshremote://pair` 都会先弹确认框，不会静默改写配置。

## 仍然存在的风险

- 隧道是**快速隧道**，没有 Cloudflare Access。域名是随机不可猜的，但一旦泄露，任何拿到地址的人都能打到你的桥——只是没有 token 进不去。
- 局域网上仍然是明文 HTTP（`usesCleartextTraffic`）：同一 Wi-Fi 里的其他人可以嗅探到内容。可信网络之外请走隧道，或自建带 TLS 的反向代理。
- DSH 的登录 cookie 是由客户端写进 WebView 的，所以拿不到 `HttpOnly` 保护；同一个 WebView 里的脚本理论上能读到它。
- 电脑端插件以你的用户身份运行，能读写你能读写的所有文件。**不要**把它装在你不信任的机器上。
- 快速隧道地址每次重启都会变。

## 报告漏洞

请用 GitHub 的私密报告渠道：**Security → Report a vulnerability**（<https://github.com/uchiha086/dshremote/security/advisories/new>）。

请在报告里带上：受影响的版本（`/health` 返回的 `version`）、复现步骤、影响面。我会在 7 天内回复；确认后修复并在 Release notes 里致谢（除非你要求匿名）。

请不要在公开 Issue 里贴未修复漏洞的利用细节。

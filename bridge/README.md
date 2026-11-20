# dshremote-bridge

DSH Remote 的**电脑端桥插件**。它做两件事：

1. 监听 DSH 宿主的会话事件，在每个**回合结束**时通过 WebSocket 推送一条 `turn_end` 给手机；
2. 把只监听 `127.0.0.1` 的 DSH Web 用裸 TCP 反代到局域网端口，手机浏览器/WebView 才能打开。

手机端不需要理解 DSH 协议，只认这里定义的几十行帧格式。

## 安装

```powershell
# 用 DSH 自带的插件管理器（本地目录会被 link，不复制）
dsh plugin --profile desktop add -w C:\Users\user\Desktop\dshremote\bridge
```

装完**重启 Desktop** 生效。启动日志与 token 位置：

- 日志：`~/.dsh/dshremote-bridge.log`
- token：`~/.dsh/dshremote-bridge.token`（首次启动随机生成，权限 0600）

## 配置

改 `cordis.patch.yml` 里的 `config`（同名覆盖会整体替换，不要只写要改的项）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `3088` | 宿主端口（WS `/ws`、`/health`、`/events`） |
| `bind` | `0.0.0.0` | 监听地址；只想本机测就改 `127.0.0.1` |
| `token` | 空 | 空则每次启动随机生成并写入 token 文件 |
| `proxyEnabled` | `true` | 是否启动 DSH Web 反代 |
| `proxyPort` | `7627` | 反代对外端口 |
| `upstreamHost` / `upstreamPort` | `127.0.0.1` / `7626` | DSH Web 实际地址 |
| `answerHeadChars` | `120` | 推送里带多少字回复摘要 |
| `questionChars` | `200` | 推送里带多少字提问 |
| `logFile` | 空 | 空则用 `~/.dsh/dshremote-bridge.log` |

## 协议（v1）

握手子协议固定为 `dshremote-bridge-v1`，连接地址 `ws://<电脑IP>:3088/ws`。

客户端 → 服务端：

```json
{"type":"auth","token":"<token>","deviceName":"HOP-AL10"}
{"type":"ping"}
{"type":"ack","id":"turn-<session>-<seq>"}
```

服务端 → 客户端：

```json
{"type":"hello","protocol":1,"bridgeVersion":"0.1.0","host":"DESKTOP","now":1763...,"proxyPort":7627}
{"type":"turn_end","id":"...","ts":1763...,"sessionId":"...","sessionTitle":"...",
 "question":"用户最后一句","answerHead":"回复前 120 字","status":"done|failed|cancelled","turn":3,"seq":42}
{"type":"pong","ts":1763...}
{"type":"error","code":"bad-token|not-authenticated|auth-timeout"}
```

`status` 由宿主 `turn/end` 的 `reason.kind` 归一而来：含 `error/fail` → `failed`，含 `interrupt/cancel/abort/stop/user` → `cancelled`，其余 → `done`。

## HTTP 调试接口

- `GET /health` —— 不需要 token，返回版本、在线客户端数、会话数、反代端口。
- `GET /events?token=<token>` —— 最近 100 条事件，用于手机重连后补拉。

## 安全说明

- token 只在 `auth` 帧里传，**不走 URL**，避免进浏览器历史与代理日志。
- 默认 `bind 0.0.0.0` 只适合**可信局域网**；要跨网请走 Cloudflare Tunnel，并把 ingress 指到 `127.0.0.1:3088`，不要直接把 3088 暴露公网。
- 反代是裸 TCP 透传，不解析内容；DSH Web 自己的鉴权仍然生效。

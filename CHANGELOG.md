# Changelog

## 0.2.1 — 2026-11-20

安全强化（按第三方代码评审报告阶段 0 逐条修复）。

### 安全

- **二维码不再含 token**：改为 60 秒过期、只能兑换一次的一次性配对码（`dshremote://pair?v=2&…&code=…`），手机调 `/pair/claim` 换 token。
- **凭据只走请求头**：新增 `X-DSH-Token` / `Authorization: Bearer`；`?token=` 仅兼容保留。
- **所有敏感路由都要 token**：`/pair*`、`/pair/claim`、`/repair`、`/ai-fix`、`/public`；此前 `/pair.html`、`/repair`、`/ai-fix` 对任意来源开放。
- **`/ai-fix` 仅限本机回环**：它等于用你的身份跑 agent，现在非回环一律 403 `loopback-only`。
- **限流**：敏感路由统一令牌桶，`/pair/claim`、`/ai-fix` 单独收紧。
- **非法 Host 不再打崩进程**：`new URL()` 包 try/catch，返回 400 `bad-request-url`（此前实测能让进程 exit 42）。
- **CORS 收窄**：只回显 `dsh-app://app` 与 `127.0.0.1`/`localhost`，不再发 `*`。
- **`/public` 必须自证**：回打公网 `/health` 校验通过才写进二维码；已发布地址每 60 秒复核，失效即撤下。
- **UDP 发现广播去掉 token**，且默认关闭（`discovery: false`）。
- **深链要用户确认**：鸿蒙端弹确认框，安卓端只填配置、不静默替换。

### 修复

- 安卓：通知正文一直为空（读 `title`/`head`，桥实际发 `sessionTitle`/`answerHead`/`question`）。
- 安卓：Android 12+ 从网络回调里起前台服务会 `ForegroundServiceStartNotAllowedException`，改到 `onResume`。
- 安卓：切页时 WebView 泄漏；`onDestroy` 未销毁。
- 安卓：`MainActivity` 里 `afterClaim()` 死分支导致白屏。
- 鸿蒙：`decodeURIComponent` 未捕获异常。

### 其他

- 移除从未工作的自写 WebSocket 服务端（鸿蒙端根本发不出帧，早已改轮询）。
- `/events` 增加服务端单调 `seq` 与 `afterSeq` 游标（`since=<毫秒>` 兼容），缓冲从 100 提到 1000。
- 补 `SECURITY.md`；订正 6 处文档与实现不符的地方。

## 0.2.0 — 2026-11-20

- 首个可用版本：电脑端桥插件 + 鸿蒙客户端 + 安卓客户端。
- 手机全屏 WebView 操控 DSH、回合完成本地通知、`/auth/cookie` 免登录注入、局域网直连 + Cloudflare 快速隧道双地址。
- DSH 左下角配对面板：五项环境体检、二维码、一键修复、让 AI 修。

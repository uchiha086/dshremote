## 安卓 0.2.1 · 安全强化版

按第三方代码评审报告的阶段 0 逐条修完。**电脑端 `dshremote-bridge` 请一起升到 0.2.1**（配对协议从 v1 的 token 改成 v2 一次性配对码）。

### 装法

1. 下载本页的 APK 直接装（需要允许「未知来源」；Play 保护可能提示，选「仍要安装」）。
2. 电脑上打开 DSH 左下角的二维码面板，点「复制配对链接」。
3. 手机首次打开 → 「粘贴配对链接」→ 粘进去 → 点「连接」。
4. 也可以手动填 IP / 端口 / 令牌。

> 安卓版**没有相机扫码**（没为此引 CameraX 依赖）。要扫码请用鸿蒙版，或在电脑浏览器打开 `http://127.0.0.1:3088/pair.html`。

### 这一版改了什么

- **配对码一次性**：二维码里不再含 token，只有 60 秒有效、只能兑换一次的码（`/pair/claim` 换 token）。
- **鉴权统一**：所有敏感接口都要 token；`/ai-fix` 只允许本机回环调用；敏感路由全部令牌桶限流。
- **安卓端修复**：通知正文为空（字段名对不上）、Android 12+ 从回调里起前台服务崩溃、切页 WebView 泄漏、连接按钮死分支导致白屏。
- **电脑端修复**：非法 Host 会把进程打崩、CORS 发 `*`、`/pair.html` 与 `/repair` 裸奔、隧道地址不校验。

完整列表见 [CHANGELOG](https://github.com/uchiha086/dshremote/blob/main/CHANGELOG.md)，威胁模型见 [SECURITY.md](https://github.com/uchiha086/dshremote/blob/main/SECURITY.md)。

### 校验

- 包名 `com.dshremote.app`，minSdk 24（Android 7.0+），target 34，全 ABI 通用
- 签名：debug keystore 自签（`CN=DSH Remote, O=dshremote, C=CN`），v2 + v3
- SHA-256 `948ED9E107C8230F989EBADDADE6501F6FED570226EFA4FDFD4103C1998CD84E`

> 后续版本必须用同一把钥匙签名，否则覆盖安装会失败（需要先卸载）。

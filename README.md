# DSH Remote

用手机操控电脑上的 **DeepSeek Harness**：发消息、看流式回复，回合结束后手机通知栏弹提醒。

一个人自用的小工具，由两部分组成：

| 部分 | 说明 |
|---|---|
| `bridge/` **电脑端插件** | 装进 DSH 的 desktop profile：把回合结束事件转成手机可拉取的消息，并把 DSH 网页反代到局域网 / 隧道（带鉴权 cookie），还额外提供配对二维码、环境体检、一键修复 |
| `app/` **鸿蒙手机端** | ArkTS 写的 HarmonyOS NEXT 应用：内嵌 DSH 网页 + 后台轮询 + 本地通知 |
| `android/` **安卓手机端** | 纯 Java（零第三方依赖）等价实现，命令行 aapt2/d8/apksigner 构建 |
| `tools/` | `tunnel.ps1` 起 Cloudflare 隧道、图标生成脚本 |

## 下载

见 [Releases](https://github.com/uchiha086/dshremote/releases)：

- `dshremote-harmony-<ver>.hap` — 鸿蒙 NEXT 包（`hdc install` 安装）
- `dshremote-android-<ver>.apk` — 安卓包（Android 7.0+，直接安装）
- `dshremote-bridge-<ver>.zip` — 电脑端插件（解压后用 plugin_manager 装该目录，重启 Desktop）

## 快速开始

1. 电脑装好桥插件并重启 Desktop；
2. DSH 侧边栏左下角点二维码按钮 → 面板里先过体检，通过后出码；
3. 手机 App 首页「扫码连接电脑」扫码 → 直接进入 DSH 全屏界面，只留右上角一个设置齿轮；
4. 出门在外先跑 `tools\tunnel.ps1`，二维码里会自动带上公网地址。

细节见 [docs/使用说明.md](docs/使用说明.md)，设计与取舍见 [开发计划.md](开发计划.md)。

## 构建

- 鸿蒙端：DevEco Studio 自带 hvigor，见使用说明第 8 节。
- 安卓端：`android\build.ps1`（需要 Android SDK build-tools 34 与一个 JDK，脚本里可改路径）。

## 已知限制

- 通知依赖 App 进程存活（鸿蒙 ArkTS 的 WebSocket 发不出帧，走 3 秒 HTTP 轮询；安卓端同样轮询）。
- 电脑休眠 / 关机 = 断。
- Cloudflare 快速隧道地址每次重启都变，且可能被限流；长期用建议命名隧道 + Access。

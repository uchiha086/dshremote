# DSH Remote · Android 0.2.2

用手机远程指挥电脑上的 DeepSeek Harness：全屏 WebView 打开 DSH 网页，回合结束时手机通知栏弹一条提醒。

## 安装（两种方式，二选一）

### 方式一：直接下载 APK

| 项 | 值 |
|---|---|
| 文件 | `dshremote-android-0.2.2.apk` |
| 大小 | 41,446 B |
| SHA-256 | `332104799A12C96EBB648276844B7A26E58C78F73E7DC305A52C8BC62DD15755` |
| 包名 | `com.dshremote.app` |
| 版本 | versionCode 5 / versionName 0.2.2 |
| 系统要求 | **Android 7.0+**（minSdk 24，targetSdk 34） |
| ABI | 全平台通用（纯 Java，无 native 库） |
| 签名 | APK Signature Scheme **v2 + v3**（无 v1，故 7.0 以下装不了） |
| 签名证书 | `CN=DSH Remote, O=dshremote, C=CN`，SHA-256 `DF:51:3C:5E:F9:5B:B3:44:FE:07:2A:65:1D:6C:F0:BA:85:F8:5F:9D:EF:69:B1:84:C3:D8:89:8F:94:52:97:6A` |

安装步骤：

1. 把 APK 传到手机；
2. 首次会提示「禁止安装未知应用」→ 允许对应来源（文件管理器/浏览器）安装；
3. Play 保护机制可能弹「未知开发者、可能有害」→ 选择「仍要安装」；
4. 打开 App，点「粘贴配对链接」把电脑上复制出来的 `dshremote://pair?...` 粘进去，或手动填 IP / 端口 / 令牌。安卓版**没有相机扫码**（不想为此拉 CameraX 依赖）。

> 这是 **debug keystore 自签** 的包，没有上架任何应用商店。安卓的签名不绑定设备，任何人拿到都能装；但**后续版本必须用同一把钥匙签名**，否则覆盖安装会失败（需要先卸载）。

### 方式二：自己从源码构建

```powershell
git clone https://github.com/uchiha086/dshremote.git
cd dshremote/android
.\build.ps1 -Sdk 'C:\path\to\android-sdk' -Jdk 'C:\path\to\jdk'
# 产物：dshremote-android-0.2.2.apk
```

只需要 JDK 17+ 与 Android SDK（`build-tools;34.0.0` + `platforms;android-34`），脚本走 `aapt2 → javac → d8 → zipalign → apksigner`，不需要 Gradle。详见 [docs/使用与签名.md](https://github.com/uchiha086/dshremote/blob/main/docs/使用与签名.md)。

## 用之前先装电脑端

手机 App 只是「遥控器」，真正干活的是电脑上的 DSH：

1. 克隆仓库，把 `bridge/` 目录装进你的 DSH profile（对 Agent 说一句「用 plugin_manager 的 install_bundle 装这个目录」即可）；
2. **重启 Desktop**；
3. DSH 左下角出现二维码按钮 → 点开 → 五项体检全绿后出码；
4. 手机扫这个码，自动填好地址与令牌，直接进 DSH 全屏界面。

不在同一个 Wi-Fi 时，先在电脑上跑 `tools\tunnel.ps1` 起 Cloudflare 隧道，二维码会自动带上公网地址。

## 这一次的改动

- 安卓客户端首发：设置页（粘贴配对链接/手动）、全屏 WebView、右上角齿轮、回合结束本地通知、前台服务保活、`dshremote://pair` 深链。
- 与电脑端 `dshremote-bridge` 0.2.1 配套：`/auth/cookie` 免登录注入、`/events` 的 `afterSeq` 游标、五项环境体检、一次性配对码 `/pair/claim`。

## 说明

- **鸿蒙（HarmonyOS NEXT）包不发二进制**：开发签名会绑定签名人设备的 UDID，别人下载了也装不上。请按 [docs/使用与签名.md](https://github.com/uchiha086/dshremote/blob/main/docs/使用与签名.md) 用你自己的华为账号自动签名后构建。
- 本版本只在构建机上做过静态验证（`aapt2 dump badging` / `apksigner verify` / dex 类清单），没有安卓真机回归——有问题欢迎开 issue。
- MIT License。

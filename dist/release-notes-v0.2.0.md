DSH Remote 0.2.0 — 手机遥控电脑上的 DSH

三个包：手机端有鸿蒙与安卓两份，电脑端一个桥插件。

## 手机端（安卓，.apk，Android 7.0+）

- 首次打开只有一屏「配对链接 + token」，扫码/粘贴后点「连接」进入
- 已配对则直接进全屏 DSH，右上角只留一个设置齿轮
- 前台服务每 3 秒拉一次 `/events`，回合结束弹通知（标题 + 回复开头）
- 支持 `dshremote://pair?...` 深链：手机浏览器打开配对链接即可自动配对
- 纯 Java、零第三方依赖，未上架，自签 debug 证书（首次安装需允许「安装未知来源应用」）

## 手机端（鸿蒙 HarmonyOS NEXT，.hap）

- 首次启动进扫码页；扫码后直接进 DSH 全屏，只保留右上角设置齿轮
- 二维码同时带局域网与隧道地址，换网络不用重扫
- 回合结束后手机通知栏推送（标题 + 回复开头）
- 后台长时任务保活，锁屏也能收到

## 电脑端插件（dshremote-bridge 0.2.0，zip）

- 反代 DSH Web 到局域网端口 7627，提供 3088 控制口
- 左下角二维码面板：先做五项环境体检，全过才出码
- `/pair` 生成配对二维码，`/pair/test` 五项体检，`/repair` 一键重拉隧道，`/ai-fix` 交给 AI 排查
- 自管 cloudflared quick tunnel，只有公网 `/health` 校验通过才写进二维码
- 安装：解压后 plugin_manager 安装该目录，重启 Desktop

## 已知限制

- 通知依赖 App 进程存活（鸿蒙 ArkTS 的 WebSocket 发不出帧，两端都走 3 秒 HTTP 轮询）
- 电脑休眠 / 关机 = 断
- Cloudflare 快速隧道地址每次重启都变且可能被限流，长期用建议命名隧道 + Access

## 安装

- 鸿蒙：下载 `dshremote-harmony-0.2.0.hap`，用 `hdc install` 安装
- 安卓：下载 `dshremote-android-0.2.0.apk`，允许安装未知来源后直接安装
- 电脑：解压 `dshremote-bridge-0.2.0.zip`，用 plugin_manager 安装该目录并重启 Desktop

> 安卓包在本机只做了静态验证（`aapt2 dump badging`、`apksigner verify`、dex 类清单），没有真机可测；遇到问题请带 logcat 反馈。

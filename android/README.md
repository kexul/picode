# 手机提醒 app（android/）

一个自己装的小安卓 app：电脑上跑着 pi-chat 的后端（pichat），它连着后端的提醒流，
「跑完一轮」「等你答题」时在手机上弹一条 Android 的通知；点通知在 app 里直接看那个会话（装的就是后端给的那份界面，跟浏览器页面同一份）。
不用任何第三方推送服务——app 跟后端连的是同一条局域网。

## 后端要改什么

不用改。后端从 2026-11 起（本次改动）自带 `GET /phone-notice` 这条 SSE 推送口：
app 连上去就挂着，弹桌面卡片的同时会往这条流里推一条（`type: notice`），
有人回话、会话关掉、题答完时推一条（`type: close`）把手机那条通知撤下来。
桌面卡片关掉（设置里的 notifyTurnEnd）时这条流也不推。

## 装 app

1. 编 APK（本机就编，要 Android SDK + JDK 17，仓库外不用装别的）：

   ```bash
   cd android
   # 用一份独立的 Gradle 用户目录编：全局 ~/.gradle/gradle.properties 里配了本机代理，
   # 代理没在跑时下载会卡死，别让这个项目跟着走那份配置
   GRADLE_USER_HOME=$PWD/.gradle-home gradle assembleDebug
   ```

   （依赖走阿里云镜像，见 settings.gradle；`gradle` 没在 PATH 里就用
   `~/.gradle/wrapper/dists/gradle-8.14-all/*/gradle-8.14/bin/gradle` 那支。）

   编出来的是 `app/build/outputs/apk/debug/app-debug.apk`，传到手机装上。
2. 手机上打开 app，填后端地址（浏览器里打开的那个，比如 `192.168.1.40:1867`），点「保存并重连」。
3. 通知栏那条常驻提示变成「已连接」就是通了。

## 用的时候要知道的

- **手机要跟电脑在同一个网络里**。出门在外收不到（后端只在内网里听着）。
- **通知不出声 / 不弹横幅**：先看通知栏常驻那条是不是「已连接」；是的话多半是系统把这个 app
  的通知归了静默，或者电池优化把它冻了——到系统设置里关掉这个 app 的电池优化（各品牌入口不一）。
- **点通知**：进 app 里那个会话（WebView 装着的就是后端给的那份界面，跟浏览器页面同一份）。
- **换了后端端口 / 地址**：在 app 里改一下再点「保存并重连」即可，不用重装。

## 为什么这么做（跟别的路子比）

- 不用 FCM / 厂商推送：那些要么在国内手机上不可用，要么接入繁琐；同一局域网里自己连最简单。
- 不用浏览器 Web Push：那条路要 service worker + VAPID 密钥，iOS 还得先加到主屏幕；app 这条最省心。
- 提醒流跟桌面卡片是同一套触发点（chatHost 的 trayNote / closeNotice），不会一边弹一边不弹。

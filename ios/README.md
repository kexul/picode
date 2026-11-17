# 手机提醒 app（ios/）

跟 `android/` 那份是同一个 app 的 iOS 版（iPhone + iPad）：电脑上跑着 pi-chat 的后端（pichat），
app 连着它的提醒流，「跑完一轮」「等你答题」时弹一条本地通知；点通知在 app 里直接看那个会话
（装的是后端给的那份界面，跟浏览器页面同一份）。不用任何第三方推送服务。

## 后端要改什么

不用改。用的就是安卓那份已经在用的东西：`GET /phone-notice`（SSE，`type: notice` / `type: close`）。

`GET /media-manifest.json` 与 `/apk/*` 那四条 iOS 版用不上（见下）。

## 跟安卓那份不一样的地方

这三处是 iOS 本身的限制，不是没做：

- **没有「打包并安装新版」**：iOS 不让 app 自己装一个包。要换新版就在 Mac 上用 Xcode 重装，
  或者重新签一个 ipa 侧载（见下「装到 iPhone / iPad 上」）。
- **没有「包里带的那份界面」**：安卓是拦下 `/media/xxx?v=指纹` 的请求、用 APK 里那份回
  （`shouldInterceptRequest`）。WKWebView 没有这个东西 —— 只能拦自己定义协议的请求，拦不到
  http(s)。所以第一次打开总是从电脑上下那 600 KB，之后靠网页缓存。
  设置画面里因此也没有「包里这份界面旧没旧」那一行。
- **后台收不到**：安卓靠一条常驻前台服务在后台一直连着；iOS 没有这种东西，app 一退到后台，
  系统过几秒就把进程冻住，这条流也跟着停。退到后台那一小会儿（系统给的宽限时间）里还收得到，
  之后就没了；回到 app 会自己接回来。要一直收提醒，就得让 app 留在前台（或者用安卓那台）。

## 编

要 **macOS + Xcode 15 以上**（SwiftUI，最低 iOS 16）。

```bash
bash ios/build-ipa.sh          # 出来 ios/build/PiChat.ipa（没签名）
```

也可以直接用 Xcode：打开 `ios/PiChat.xcodeproj`，选模拟器或插着的设备，点 Run。

这台机器上编不了（是在 Windows 上写的，没法在这儿过 Xcode）。没有 Mac 的话，
`.github/workflows/ios.yml` 会在一台 macOS 机器上跑同一条命令、把 ipa 当 artifact 传上来：
仓库的 Actions 页面里点一次 `ios` 这个 workflow，跑完下 `PiChat-ipa`。

## 装到 iPhone / iPad 上

没签名的 ipa 装不上手机，得先签。三条路：

1. **Xcode 直接 Run**（有 Mac 最省事）：插上设备，`Signing & Capabilities` 里 Team 选自己的
   Apple ID，Run 就是。免费账号签出来的 app 7 天后过期，到期重跑一次。
2. **AltStore / Sideloadly**（Windows 也行）：拿自己的 Apple ID 把 `PiChat.ipa` 签一下再装，
   一样是 7 天；这些工具会提醒你续签。
3. **开发者账号**（一年 99 美元）：签好、把设备加进描述文件，可以用一年。

第一次打开前，手机上要在「设置 → 通用 → VPN 与设备管理」里信任那个开发者证书。

## 用的时候要知道的

- **第一次连局域网地址**：系统会弹「是否允许 Pi Chat 访问本地网络」，得点允许，不然连不上
  （就是 `Info.plist` 里 `NSLocalNetworkUsageDescription` 那句）。
- **明文 http**：`Info.plist` 里 `NSAllowsArbitraryLoads` 开着（跟安卓的 `usesCleartextTraffic`
  一个道理），不然 http://192.168.x.x 会被系统拦掉。
- **通知权限**：第一次开 app 会问；不给的话连照连，只是不弹。不弹横幅再去「设置 → 通知 → Pi Chat」看一眼。
- **回设置**：看对话时点顶上那颗「‹ 设置」。iOS 没有返回键，安卓那边是连按两下返回；
  手机屏幕窄，这颗按钮占一条，所以摆在顶上。
- **iPad**：工程里 `TARGETED_DEVICE_FAMILY = "1,2"`，四个方向都开着；设置画面那一列最宽 560 居中，
  对话页面整块铺满（横竖屏都行）。
- **换了后端端口 / 地址**：在设置里改一下再点「打开」即可，不用重装。
- **包里那份界面**：没有，永远走网络（见上）。

## 代码在哪

- `PiChat/AppModel.swift`：后端地址、用过的地址清单、提醒流（SSE）、弹通知。跟安卓的
  `MainActivity` + `NoticeService` 是同一套协议（同一套键名、同一个退避规矩）。
- `PiChat/SettingsScreen.swift`：设置画面（地址输入框、用过的地址、连接状况）。
- `PiChat/ChatScreen.swift`：网页画面（一台 WKWebView）与「只在页面里切一格」那条路。
- `PiChat/PiChatApp.swift`：两屏之间切、通知权限、点通知进来开那个会话。
- `PiChat/Info.plist`：本地网络、明文 http、iPad 四个方向。
- `PiChat/Assets.xcassets`：桌面图标 —— 照网页那颗标记（`src/pageHtml.ts` 的 `PAGE_ICON_SVG`）
  画的一张 1024 PNG，跟安卓的 `ic_launcher_fg.xml` 同一套坐标。

第一次在 Mac 上打开时可能要顺手补一下签名（Team），别的地方不用改。

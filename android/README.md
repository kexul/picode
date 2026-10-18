# 手机 App（安卓）

一个壳：打开就是连到后端、显示后端给的那份对话页面（跟手机浏览器打开 `http://192.168.x.x:51883/`
看到的是同一份）。壳比浏览器多两件事：

1. **地址清单**：家里那个 `http://…`、出门用的 Tailscale 那个 `https://…` 都填进去。
   打开 App 时按清单顺序试一遍，第一个连得上的就用 —— 在哪都能打开，不用手动换。
2. **能一直连着、能推通知**：一条常驻通知栏条目 + 一条守在后台的连接。
   收到「某个会话跑完了一轮」或「模型在等你答一道选择题」就弹一条系统通知，
   标题是会话名，正文是那一轮回复的开头 / 那道题；**点一下打开 App 并切到那个会话**。

手机上用浏览器打开收不到通知（`http://192.168…` 不是安全来源，浏览器不给通知权限），
这个 App 就是为这件事做的。

## 装

```bash
npm run android:apk
```

产物是 `android/app/build/outputs/apk/debug/app-debug.apk`（不到 1 MB，一个依赖都没有）。
传到手机上点开装；手机连着电脑时也可以：

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

第一次打开是一个填地址的页面：填后端地址（`http://192.168.1.5:51883/` 这样），
按「连上」。后端要在这台电脑上跑着。

装好后允许一次通知权限（系统会问），然后就可以把 App 切后台了。

## 它是怎么一直连着的

- 一个常驻的后台服务挂一条通知栏条目（安卓不让没有它就想长期活着）。这条通知**不能划掉**，
  它就是“我还连着”的凭据。
- 这条连接是**原生写的**，不经过网页：App 退到后台后网页会被系统冻住，网页那条连接迟早死掉。
  它连的是后端的 `/events?role=watch`，只听，不画界面；每 20 秒跟后端报一次活。
- 断了会自己重连（1、2、3、5、10、20、30 秒退一步，连上就从头算）。
- 人在 App 里看着的时候不弹通知（就在眼前，弹了只是打扰）；点通知那一下会自动切会话。

## 要知道的几件事

- **网页那边不再弹浏览器通知**：壳加载页面时会把页面里的通知能力摘掉，通知全归 App 发，
  不然会弹两条。设置面板里那一项会显示“手机 App 里由 App 自己发通知”。
- **设置里那个“跑完发系统通知”开关管不到 App**：App 的通知一直开着。
  （后端“跑完一轮”那条消息本来就照发，网页自己按开关决定弹不弹；App 这边没接那个开关。）
- **手机厂商的省电策略可能把它杀掉**（小米、华为、OPPO 那种）。真收不到通知时，
  去系统设置里给 Pi Chat 设成「不受限制」（不同手机叫法不一样：无限制 / 允许后台活动）。
- **通知堆在一起时，点那一组的标题只是打开 App**，不会切会话 —— 点具体那一条才会。
  这是安卓自己的分组行为。
- **`targetSdk` 特意停在 34**：安卓 15 起对 dataSync 这类常驻服务有“一天只能跑几小时”的上限，
  升到 35 这条后台连接就会被系统掐掉。以后要升 35，得把服务类型换成 `specialUse` 并想清楚。

## 自己验一遍（不用真手机）

模拟器起得来就能整套验：

```bash
# 1. 起后端，监听所有网卡（模拟器要用电脑的局域网地址连进来）
node dev/browserHost.js --port 51991 --host 0.0.0.0 --fake-pi

# 2. 起模拟器
"$LOCALAPPDATA/Android/Sdk/emulator/emulator.exe" -avd Medium_Phone_API_35 -no-window -no-audio -gpu swiftshader_indirect &

# 3. 装、放通知权限
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell pm grant dev.pichat.app android.permission.POST_NOTIFICATIONS

# 4. 打开，填 http://<电脑的局域网地址>:51991/ 按「连上」
adb shell am start -n dev.pichat.app/.MainActivity
adb exec-out screencap -p > /tmp/app.png

# 5. 把它切后台，从电脑那边驱动一轮对话，看通知
adb shell input keyevent 3
node dev/visit.js --url http://127.0.0.1:51991/ --send "你好" --wait-ms 12000
adb shell cmd statusbar expand-notifications
adb exec-out screencap -p > /tmp/notice.png
```

两点容易踩的：

- 模拟器里填 `http://10.0.2.2:端口/` 连得上，但**页面会报“请求来源被拦”** —— 那个地址不是这台电脑的名字，
  服务端按来源挡掉了。要验界面就填电脑的局域网地址（`ipconfig` 里那个 `192.168.x.x`）。
- 点通知验切换会话时，先用 `adb shell am start -n dev.pichat.app/.MainActivity --es sessionId "server:panel-3"`
  单独验一遍这条路（会话标识看后端 `/events` 推下来的 `sessionList`），比在通知堆里点准。

## 改代码

- `app/src/main/java/dev/pichat/app/MainActivity.java` —— 地址首屏、壳里的网页、返回键、下载、选图
- `app/src/main/java/dev/pichat/app/WatchService.java` —— 后台那条连接与通知（这件 App 的正事）
- `app/src/main/java/dev/pichat/app/Prefs.java` —— 地址清单、这条连接的身份

`npm run android:apk` 会自己找 Gradle 和安卓 SDK，并写 `local.properties`（那个文件不进版本库）。

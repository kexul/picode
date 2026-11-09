# Pi Chat

与 [pi coding agent](https://pi.dev) 对话的插件与网页端：会话跑在后端里，插件里的对话面板、浏览器页面都是它的客户端，看到的是同一份会话。

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 420}}}%%
flowchart TD
    Panel["插件里的对话面板（VSCode）"]
    Page["浏览器页面（电脑 / 手机）"]

    Backend["后端 pichat（可随便重启）<br/>网页服务 · 页面登记与补发<br/>文件侧边栏与改动（问 git）<br/>设置 · 消息推送 · 右下角提醒<br/>「编译并重启」在同一终端里编译、起回来<br/>Ctrl+C 全收（pi 也停）"]

    Pi["pi 进程 ×N（一个会话一只）<br/>派出去的子会话、判官各一只<br/>每只里面跑着我们的桥接扩展"]

    Disk["磁盘<br/>会话文件（JSONL，只追加）<br/>会话重开、后端重启、换台机器<br/>认的都是这一份<br/>后台命令日志 / ask 答案"]

    Panel -->|"HTTP + SSE"| Backend
    Page -->|"HTTP + SSE"| Backend
    Backend -->|"三根管子（stdin / stdout / stderr）"| Pi
    Pi -->|"stderr 上的暗号：派子活 / 提问 / 后台命令 / 加载了什么"| Backend
    Pi -->|"pi 自己写"| Disk
    Backend -.->|"只读：会话清单 / 配置 / 地址 / git"| Disk
```

两边看的是同一份会话，只是换了外壳。会话重开、后端重启、换台机器接着看，认的都是磁盘上那份会话文件。

pi 是后端起的子进程：后端重启，它们跟着重开（会话与历史都在磁盘上那份会话文件里，不丢）。
「编译并重启」那颗按钮只换后端这一个进程：在终端里敲 `pichat` 时，留在终端里的是「看着后端的那一层」，
它在同一个终端里拉代码、编译、把后端起回来，窗口和日志都不关（见 `bin/pichat-restart.js` 的 `supervise`）。

## 双击一个 exe 就能跑（Windows）

`npm run build`（或者 `build.bat`）除插件包外，还会打出 `dist\PiChat.exe`：双击它就起后端，
通知区域里出那颗托盘图标，浏览器里打开页面 —— 不用先在终端里敲 `pichat`。
托盘图标右键「打开 / 退出」（双击也是打开）；在终端里敲 `pichat` 起的后端也有这颗图标。

它借本机的 Node（20 以上），自己把后端与界面文件解到 `%LOCALAPPDATA%\PiChat\app-<这一版内容>\`，
后端的输出写进 `%LOCALAPPDATA%\PiChat\pichat.log`。已经有一个后端在跑时，双击它只把那个页面打开，
不会起第二个。

设置浮层里的「编译并重启」两种启动方式都认：终端里起的照旧在那个终端里拉代码、编译、起回来（终端不关）；
双击 exe 起的先让 exe 退掉，重打一遍 exe，再照原来的目录和端口起回来（页面自己连回来，不多开窗口）。
exe 被拷到仓库外面、旁边没有源码时，那颗按钮是灰的。

原来的安装与使用说明不再放这儿，要看就从 git 历史里翻。

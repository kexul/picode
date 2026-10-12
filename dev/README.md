# 开发调试用的小工具

这些文件只在开发时用，不会打进插件（`.vscodeignore` 里排掉了 `dev/**`）。

一句话：**不用装插件、不用开 VS Code，就能把真插件跑起来，在浏览器里看界面。**

原理：整条链只有两处换成调试用的：

- 插件调用 VS Code 的那一层（弹窗、配置存储、diff、侧边栏网页视图）换成 `dev/fakeVscode.js`，
  再按正常用法建一个 `chatViewProvider.ts`（第二步之后它只是后端的一个客户端）；
- 后端不起另一个进程，就在这个进程里用真启动函数 `startBackend()` 起（见 `serverMain.ts`）。

其余全是真的：真会话编排（`chatControllerBase.ts`）、真会话进程（真的拉起 `pi`）、
真网页服务（`webChatServer.ts`）、真界面文件（`media/` 里的 `chat.js` / `chat.css`）。
后端写的那几份文件（设置 / 状态 / 地址）落在 `dev/.scratch/pichat/`（靠 `PICHAT_HOME` 指过去），
不碰你自己 `~/.pi/pichat/` 里的那份。

浏览器里看到的就是装了插件以后在浏览器里看到的那份界面，只是少了 VS Code 那一圈外壳。

## 两条命令

```bash
npm run web:dev        # 起后端，屏幕上打出地址，自己用浏览器打开看（Ctrl+C 退出）
npm run web:shot -- [动作…]   # 自动开浏览器、按动作点界面、截图到 dev/shots/
```

`web:dev` 开着的时候，可以再用 `web:shot --url <地址>` 连着同一个后端跑动作，
两边看的是同一份会话（跟手机 + 电脑同时开着一样）。

## 例子

```bash
# 打开页面、等会话就绪、截一张图
npm run web:shot

# 发一句话，等模型的回复，截图
npm run web:shot -- --send "只回复两个字：收到" --wait-answer 收到 --shot reply.png

# 深色界面，点一下新建会话，截图
npm run web:shot -- --theme dark --click "#newSessionBtn" --shot dark.png

# 显示浏览器窗口，跑完不关，自己接着点（调试布局时最顺手）
npm run web:shot -- --headed --keep

# 动作复杂时写个脚本：module.exports = async (page) => { … }
npm run web:shot -- --script dev/myFlow.js

# 用假模型验界面：不调真模型，按剧本秒回（会话/历史/重放全真，只是“模型”是假的）
# 剧本在 dev/fakePi.js 顶部，读了哪个文件、调了哪些工具都能改
npm run web:dev -- --fake-pi
npm run web:shot -- --fake-pi --send "随便说点什么" --shot fake.png

# 验“一批工具调用全挤在同一条线上”（往页面里投十几条工具消息，前后加正文，截图）：
npm run web:shot -- --width 1000 --height 620 --script dev/toolRow.js

# 验会话那套（顶条名字跟着 pi 标题变 / 切会话 / 列表里关会话）：
npm run web:shot -- --fake-pi --script dev/sessionFlow.js

# 验派子会话（说一句带“派活”的话就会派一个）：跑完自动关、没跑完不关、
# 正看着就不关；子会话跑得比人手快，配慢一点儿的假 pi 才来得及点进去
FAKEPI_THINK_MS=900 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaFlow.js

# 看浏览器本来的滚动条（截图默认把滚动条藏起来；查“输入框冒出一根滚动条”这类毛病要打开）：
npm run web:shot -- --scrollbars --send "你好" --shot send.png
node dev/inputProbe.js            # 量输入框的高度与滚动状态，每步裁一张小图到 dev/shots/

# 量界面吃了多少 CPU（查“手机发烫”这类性能问题；--cpu 4 ≈ 把 CPU 降速到手机的档位）：
node dev/perfProbe.js                                     # 开着什么都不做
node dev/perfProbe.js --stream --prefill 24000 --cpu 4     # 模型正在流式回答（先垫 2.4 万字）
node dev/perfProbe.js --scroll 10 --prefill 24000          # 手指滑动看长会话
node dev/perfProbe.js --batch 30                           # 打开长会话时的整屏重画

# 流式正文现在是按块切开渲染的（只重画尾巴）：改过媒体端渲染逻辑后跑一遍，
# 逐个样例对一下“按块渲染出来的文字”跟“整段渲染的文字”是否一字不差：
node dev/markdownBlocksCheck.js
```

完整参数：`npm run web:shot -- --help`（或 `node dev/visit.js --help`）。

脚本里的 `page` 能用：`page.send(文字)`、`page.type(文字)`、`page.press("Enter")`、
`page.click(选择器)`、`page.eval("return …")`、`page.waitText(文字)`、
`page.waitAnswer(要包含的文字)`、`page.answerText()`、`page.text()`、`page.shot(名字)`、
`page.sleep(毫秒)`。

## 几个注意

- **会话跑在 `dev/.scratch/`**：这是调试专用的工作目录（自动建，里面放了两个小文件与一张 1600x400 的示例图片），
  不进版本库，调试时模型改文件也改不到插件自己的代码。要试别的目录用 `--cwd`。
  后端的设置 / 状态（`--model` / `--piPath` / `--theme` 这些就是往它里面写）在 `dev/.scratch/pichat/`。
- **发消息不用再等会话就绪**：会话没就绪时按回车，字会留在输入框里，就绪后自动补发一次
  （以前是悄声丢掉，得像没事一样再按一次）。要故意在"还没就绪"时动手，加 `--skip-ready`。
  注意无头浏览器在页面刚加载的那几百毫秒里有时会把按键事件丢掉（探针的坑）：脚本里可以先
  `page.sleep(1000)` 再按回车。
- **截图默认把滚动条藏掉**（`--hide-scrollbars`）：图干净，但滚动条也就占不了宽度，
  跟浏览器里看到的会差一行半行。要照真样子看就加 `--scrollbars`，或者用 `node dev/inputProbe.js`
  （它默认就用真滚动条，还会把输入框的高度与滚动状态打印出来）。
- **需要 Node 22 以上**（用到内置的 WebSocket 跟浏览器说话），浏览器用本机的 Chrome 或 Edge。
- **验不到的东西**：diff 编辑器、符号跳转、剪贴板、命令面板入口、状态栏、
  侧边栏网页视图本身 —— 这些还是得用 VSCodium / VS Code 的 F5 开发宿主看。

## 跟独立后端（`pichat`）什么关系

两层壳共用同一个中间层：`chatControllerBase.ts`（会话编排）→ `chatHostBase.ts`（页面通道、
浮层路由、显示选项）→ 两个宿主：`chatViewProvider.ts`（VSCode 侧）与 `serverChatHost.ts`（独立后端）。

- `npm run server`（等于全局装好后的 `pichat`）起的是**真独立后端**：`serverChatHost.ts`，
  不换任何接口，它就是特意不碰 vscode 的那一层。要验它不用假 VSCode：
  `PICHAT_HOME=/tmp/x npm run server -- --cwd /tmp/x/work --port 0`，再用 `web:shot --url <地址>` 链上去。
- `dev/` 这套工具验的是 **插件这一侧 + 真后端**（同一个进程里跑）：插件这侧的代码（`chatViewProvider.ts`、
  `backendClient.ts`、`vscodeScreen.ts`）全是真的，只有它们调 VS Code 的接口是假的；
  会话与网页服务是真后端（`startBackend()`）。改完界面 / 派活 / 会话行为用它最快。
- 两边共用 `chatHostBase.ts`：改这里等于两边一起改，所以两边都要过一眼（web:shot 与
  `npm run server` 各跑一次最稳）。

## 文件

| 文件 | 干什么 |
|---|---|
| `fakeVscode.js` | 假的 VS Code 接口。没实现的接口给空壳并记一行日志，不会把调试拦下来 |
| `harness.js` | 把真代码跑起来（换接口 → 建会话工作区 → 起真后端，设置落在 `dev/.scratch/pichat/`） |
| `cdp.js` | 浏览器驱动：开 Chrome / Edge、执行页面脚本、等条件、截图（零依赖，走浏览器自带的调试接口） |
| `browserHost.js` | `npm run web:dev` 的入口：起服务后常驻 |
| `visit.js` | `npm run web:shot` 的入口：按动作跑一遍并截图 |
| `options.js` | 两条命令共用的命令行参数 |
| `fakePi.js` | 假的 pi（`--fake-pi` 用）：协议跟真 pi 一样，模型换成按剧本演戏，界面调试秒回 |
| `fake-pi.cmd` / `.sh` | 上面那个的包装：Windows 上 piPath 得是 .cmd 才能被 shell 起来 |
| `makePng.js` | 生成示例图片（不依赖任何第三方库）：调试工作目录里那张 1600x400 的图就是它写的 |
| `shots/` | 截图（不进版本库） |

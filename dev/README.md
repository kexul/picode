# 开发调试用的小工具

这些文件只在开发时用，不会打进插件（`.vscodeignore` 里排掉了 `dev/**`）。

一句话：**不用装插件、不用开 VS Code，就能把真插件跑起来，在浏览器里看界面。**

原理：整条链只有两处换成调试用的：

- 插件调用 VS Code 的那一层（弹窗、配置存储、diff、插件里那块对话面板的网页视图）换成 `dev/fakeVscode.js`，
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

**改了后端代码要重启那个进程**：界面文件（`media/`）是每次请求现从磁盘读的，刷新页面就能看到新界面；
但路由、消息处理这些是进程启动时装进内存的，改了 `src/`（后端那侧）就得把那个终端 Ctrl+C 再起一次。
不然会撞上一个很唬人的症状：界面是新的，点下去后端回一句「没有这个地址。」。

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

# 验“一批工具调用全挤在同一条线上”（往页面里投一批工具消息，前后加正文，截图）：
# 同一个名字只出一个标签（标签停在第一次调用的位置），不同名的各占一个，一条线上还是能排好几个
npm run web:shot -- --width 1000 --height 620 --script dev/toolRow.js

# 验合并本身（同名的收成一个、悬浮提示里一条条列出来、读图那条摘出去、不合并的那几个、重放后一样）：
npm run web:shot -- --width 1000 --height 760 --script dev/toolMerge.js

# 验会话那套（顶条名字跟着 pi 标题变 / 切会话 / 列表里关会话）：
npm run web:shot -- --fake-pi --script dev/sessionFlow.js

# 验顶条会话名下拉框里每行那颗关闭叉（点叉先出确认条：整行变红、行尾多一颗勾，
# 点勾才真关；点叉或者干等 4 秒，确认条自己收回；确认条出来时清单宽度不变）：
npm run web:shot -- --fake-pi --script dev/sessionMenuClose.js

# 验派子会话（说一句带“派活”的话就会派一个）：跑完自动关、没跑完不关、
# 正看着就不关；子会话跑得比人手快，配慢一点儿的假 pi 才来得及点进去
FAKEPI_THINK_MS=900 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaFlow.js

# 验子会话那三个工具里平时没人喊的两个（停掉 / 查看）：这两句也由真扩展接（暗号、名录都是它的代码在动），
# 所以要慢一点儿的假 pi，才来得及在它还在跑的时候停掉：
FAKEPI_THINK_MS=4000 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaTools.js

# 验顶条中间那颗小点（本会话闲着、派出去的子会话还在跑时也亮着呼吸；
# 小点与箭头是落在“会话名 + 目录两行”中间，不是只对着会话名那一行；投假会话列表，不真派活）：
npm run web:shot -- --width 900 --height 620 --script dev/childDot.js

# 验「模型的思考也显示成工具行里的一种条目」（当场生成 / 刷新重放 / 同批两段收成一个带次数的标签）：
FAKEPI_TICK_MS=20 npm run web:shot -- --fake-pi --script dev/thinkRow.js

# 验「think 提示框开着、思考还在往外吐」这条路（以前每条增量都重画一遍提示框，思考一长就把主线程占满，
# 浏览器报「页面无响应」）：量开销、看节流有没有生效、内容区跟不跟着贴底、往回滚了还跟不跟：
npm run web:shot -- --fake-pi --script dev/thinkTipPerf.js

# 验顶部「加载更早的消息」（网页端只发最近一段历史）：点完视野得留在原来那几条消息上，
# 不能被甩到底部（ROUNDS 攒消息轮数，AT_BOTTOM=1 是“贴底时点”那种）：
npm run web:shot -- --fake-pi --script dev/historyScroll.js

# 验“每块屏各看各的会话”（两块浏览器页面各开会话互不牵动；模拟的 VSCode 窗口
# 会不会认自己工作区里的会话；别的屏把会话关了，这块屏留在原地、发消息就自动重开）：
node dev/focusCheck.js

# 验问话卡片（模型问的选择题、扩展问的确认 / 输入 / 选一个：都长在会话的消息流里）；
# 假数据、秒回：单选 / 多选 / 自己写 / 停止生成 / 确认 / 输入 / 选一个 / 刷新页面 各走一遍
npm run web:shot -- --fake-pi --script dev/askCards.js

# 真模型那条（慢，一句要等几十秒）：真 pi 加载插件的桥扩展，走完整条协议
npm run web:shot -- --script dev/askQuestion.js

# 真扩展那条：先把 dev/askDialogTrigger.ts 复制到 ~/.pi/agent/extensions/，跑完删掉
npm run web:shot -- --script dev/askDialog.js

# 验消息流末尾那条「继续」（空会话不露面；一轮跑完在末尾露面、点它直接发一条“继续”
# 且输入框里打了一半的字留着、点完先收起来防连点、生成中不露面、再跑完又回到末尾；
# 假模型得每轮停一下才看得见生成中那一下）：
FAKEPI_THINK_MS=1200 npm run web:shot -- --fake-pi --script dev/continueHint.js

# 验断线重连（锁屏 / 切后台 / 断网 / 反复锁屏 / 反复弄断连接 / 断线期间问的选择题）：
#   场景一 冻住、场景二 断网、场景三 冻住+断网、场景四 反复冻住解冻、
#   场景五 反复把连接弄断（验序号补发不重不漏）、
#   场景六 锁屏期间连接悄悄断了（正文到了、尾巴丢了），回来页面自己重开连接补回丢失的消息、
#   场景七 断线那段里模型问的选择题（连接悄悄死掉、卡片没送到），回来重连后卡片要补上、能答
node dev/reconnect.js                    # 全部
node dev/reconnect.js --scene taillost    # 只跑某一个（逗号可写多个）
node dev/reconnect.js --scene askcard     # 只跑场景七（断线期间问的选择题）
RECON_HOLD_MS=60000 node dev/reconnect.js --scene both   # 锁屏时长自己定（毫秒）

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

# 验「项目与会话」面板（顶条最右边那颗 <<<）：
# 正在对话一段、工作区那块的展开 / 收起、组里的「加载更多」、行尾那颗加号新建会话、
# 标题右边那颗加号（挑文件夹）、子会话不显示，一次过一遍：
npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/workspacePanel.js

# 验宽窗下常驻的侧边栏（窗口 ≥ 900px）：开页面右边就是一列（不当浮层、不盖对话）、
# 点 <<< 收起、刷新后还是收起（记住了）、点面板里的行面板不关、开别的浮层时那一列的位置留着；
# 同一趟里把视口改成手机宽再看一次：那一列整个不见，点 <<< 是原来的抽屉：
npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/sidebarDock.js

# 验「对话在更新（开始生成 / 跑完）时，常驻的侧边栏只动『正在对话』那一格」：
# 整个面板连下半「工作区」一起重画会看着整列闪一下；这条查整块一次都没重画、
# 下半那一格的元素与滚动原样，并且重画过后点行（展开 / 收起）还好使：
FAKEPI_TICK_MS=60 npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/sidebarRedraw.js

# 量那颗 <<< 打开一次要多少毫秒、滑入动画顺不顺（长任务 = 一眼能看出的停顿）：
# 默认按手机的样子量（412x915@3x、CPU 降速 4 倍）：
npm run web:shot -- --script dev/sidebarPerf.js
SIDEBAR_BATCHES=40 SIDEBAR_ROUNDS=5 npm run web:shot -- --script dev/sidebarPerf.js   # 先垫 40 轮长对话、开关 5 轮
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
  插件里那块对话面板的网页视图本身 —— 这些还是得用 VSCodium / VS Code 的 F5 开发宿主看。

## 跟独立后端（`pichat`）什么关系

会话编排与页面通道都在后端这一侧：`chatControllerBase.ts`（会话编排）→ `chatHost.ts`（页面通道、
浮层路由、显示选项，也就是独立后端的宿主本身）。插件那一侧是 **纯客户端**：
它跟浏览器页面一样，从后端领一份界面文件、走 HTTP 收发消息，不继承这套。

- `npm run server`（等于全局装好后的 `pichat`）起的是**真独立后端**：`chatHost.ts`，
  不换任何接口，它就是特意不碰 vscode 的那一层。要验它不用假 VSCode：
  `PICHAT_HOME=/tmp/x npm run server -- --cwd /tmp/x/work --port 0`，再用 `web:shot --url <地址>` 链上去。
- `dev/` 这套工具验的是 **插件这一侧 + 真后端**（同一个进程里跑）：插件这侧的代码（`chatViewProvider.ts`、
  `backendClient.ts`、`vscodeScreen.ts`）全是真的，只有它们调 VS Code 的接口是假的；
  会话与网页服务是真后端（`startBackend()`）。改完界面 / 派活 / 会话行为用它最快。
- 改 `chatHost.ts` 只影响后端那一侧（插件那侧不含这份代码）；界面上的表现两边都要过一眼
  （web:shot 与 `npm run server` 各跑一次最稳）。

## 文件

| 文件 | 干什么 |
|---|---|
| `fakeVscode.js` | 假的 VS Code 接口。没实现的接口给空壳并记一行日志，不会把调试拦下来 |
| `harness.js` | 把真代码跑起来（换接口 → 建会话工作区 → 起真后端，设置落在 `dev/.scratch/pichat/`） |
| `cdp.js` | 浏览器驱动：开 Chrome / Edge、执行页面脚本、等条件、截图（零依赖，走浏览器自带的调试接口） |
| `browserHost.js` | `npm run web:dev` 的入口：起服务后常驻 |
| `visit.js` | `npm run web:shot` 的入口：按动作跑一遍并截图 |
| `focusCheck.js` | 验“每块屏各看各的会话”（两块浏览页面 + 模拟的 VSCode 窗口）：`node dev/focusCheck.js` |
| `reconnect.js` | 验断线重连（冻住 / 断网 / 反复锁屏 / 反复弄断连接 / 断线期间问的选择题）：`node dev/reconnect.js` |
| `childDot.js` | 验顶条那颗小点（子会话在跑时父会话那颗点也呼吸；它与箭头落在两行中间）：`npm run web:shot -- --script dev/childDot.js` |
| `thinkRow.js` | 验模型的思考显示成工具行里的 `think` 标签（当场生成 + 刷新重放 + 同批两段合并）：`npm run web:shot -- --fake-pi --script dev/thinkRow.js` |
| `thinkTipPerf.js` | 验 `think` 提示框开着时思考边流边长的开销与表现（节流、跟着贴底、往回滚就不跟）：`npm run web:shot -- --fake-pi --script dev/thinkTipPerf.js` |
| `continueHint.js` | 验消息流末尾那条「继续」（空会话不露面、跑完在末尾露面、点它发一条“继续”、打的字留着、生成中收起来）：`FAKEPI_THINK_MS=1200 npm run web:shot -- --fake-pi --script dev/continueHint.js` |
| `askCards.js` | 验问话卡片（长在消息流里）：假 pi 演模型调 `ask_choice` 与扩展问用户，单选 / 多选 / 自己写 / 停止生成 / 确认 / 输入 / 选一个 / 刷新页面各走一遍：`npm run web:shot -- --fake-pi --script dev/askCards.js` |
| `askQuestion.js` | 同上但那一条是真路的：真模型 → 真 pi（插件给它 `-e` 了桥扩展）→ 卡片 → 回话文件 → 工具结果（慢） |
| `askDialog.js` + `askDialogTrigger.ts` | 验真扩展问的“要你打字 / 要你点是或否 / 选一个”：触发扩展先复制到 `~/.pi/agent/extensions/`，不用模型 |
| `sessionMenuClose.js` | 验顶条会话名下拉框里每行的关闭叉（确认条那颗勾 / 那颗叉 / 超时 / 真关掉 / 宽度不变）：`npm run web:shot -- --fake-pi --script dev/sessionMenuClose.js` |
| `workspacePanel.js` | 验「项目与会话」面板（那颗 `<<<`）：正在对话一段、工作区那块的展开 / 收起（含记住）、组里的「加载更多」、行尾加号新建会话、标题右边那颗加号、子会话不显示：`npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/workspacePanel.js` |
| `sidebarDock.js` | 验宽窗下常驻的侧边栏（`<<<`，窗口 ≥ 900px 才常驻）：打开 / 收起 / 记住收起 / 两根横线对齐 / 点行不关面板 / 开别的浮层时那一列原样留着 / 工作区那两块「加载更多」/ 改窄再拉宽，一次过一遍：`npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/sidebarDock.js` |
| `sidebarRedraw.js` | 验对话更新时常驻那一列的重画范围（只该动「正在对话」那一格）：整块有没有重画、下半那一格的元素与滚动有没有动、重画过后点行还准不准：`FAKEPI_TICK_MS=60 npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/sidebarRedraw.js` |
| `sidebarPerf.js` | 量那颗 `<<<` 打开一次多少毫秒、滑入动画有没有被顶住（长任务 / 逐帧间隔）：`npm run web:shot -- --script dev/sidebarPerf.js` |
| `fileSidebar.js` | 验浏览器页面左边那一列「文件侧边栏」（点消息里的文件链接之后：行号与停在那一行、标签页、跟着刷新、图片直接看、二进制与超大给下载、目录、看不了的几种情形、认得的几种语言带颜色（别的黑白、太大的不上色也不卡页面），以及那条只读文件地址本身的拒绝情形）：`npm run web:shot -- --fake-pi --script dev/fileSidebar.js` |
| `options.js` | 两条命令共用的命令行参数 |
| `tabaTools.js` | 验子会话的「停掉」与「查看」两个工具（派活那条在 `tabaFlow.js`）：`FAKEPI_THINK_MS=4000 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaTools.js` |
| `fakePi.js` | 假的 pi（`--fake-pi` 用）：协议跟真 pi 一样，模型换成按剧本演戏，界面调试秒回。说一句「问单选 / 问多选 / 问确认 / 问输入 / 问选项」就演一次问话。**派子会话与问话那几个工具，它加载的是宿主写下的真扩展**（见 src/bridgeAssets.ts），所以那两段代码每跑一次 dev 脚本就真跑一遍 |
| `fake-pi.cmd` / `.sh` | 上面那个的包装：Windows 上 piPath 得是 .cmd 才能被 shell 起来 |
| `makePng.js` | 生成示例图片（不依赖任何第三方库）：调试工作目录里那张 1600x400 的图就是它写的 |
| `shots/` | 截图（不进版本库） |

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

# 验合并本身（同名的收成一个、悬浮提示里一条条列出来、write / edit 也按名字收且每条的
# 「跳转 / 回滚」排在各自的标题行上、读图那条摘出去、不合并的那几个、重放后一样，
# 读图铺出来的那块图排在这条调用当时的位置上：后面接着调的、后面才到的正文都在它下面）：
npm run web:shot -- --width 1000 --height 760 --script dev/toolMerge.js

# 验「正在跑的那一条」（工具标签下面那行摘要：在跑的那条把命令 / 读哪个文件直接写出来，
# 同时跑几条也只露最近开始的那一条（一条跑完这一块高矮不变、下文不跟着跳），
# 一条都不在跑就冻住（齿轮停转、耗时定住），字一直留着；
# 新的命令来了原地顶掉，下面出正文 / 铺进问话卡片 / 这一轮跑完才整条收掉，
# 一串 60 毫秒跑完的调用连着来也不该一闪一闪，think 与 ask_choice 不出这条，
# 一行放不下的长命令字自己慢慢横向滚、只往一个方向（到头停一下从头来，不看末尾就白滚了；冻住的也滚），
# 放得下的那条一动不动，每条末尾钉一个往上走的耗时（字滚它不滚、冻住后不再变、重放的老调用不写））：
npm run web:shot -- --width 900 --height 620 --script dev/runningLine.js

# 验「正在输出时视野跟不跟着底部走」（有时忽然不跟了：程序自己滚的那一下记的是“滚到底”，
# scroll 事件下一帧才到，中间内容长了一点就被当成“用户往回滚了”；这里按着那个顺序验一遍，
# 顺带验用户自己往回滚时不许被拽回去、点「跳到最新」又贴回底）：
npm run web:shot -- --width 420 --height 800 --script dev/followBottom.js

# 验断线重连之后队列里那几条显示的还是不是真的（重画只重放消息、排队不是消息：
# 断线那段 pi 已经把排队的投出去了，回来还写着“在排队”；重画时后端要补一份排队状态的真相）：
npm run web:shot -- --fake-pi --script dev/queueResync.js

# 验正文右下角那个「消息的时刻」（鼠标停上去才露、原来的复制按钮已经撤了：今天只写时分，
# 别的日子补日期、跨年写全年，title 是完整时刻，没带时刻的按现在算，那颗小字不挡鼠标）：
npm run web:shot -- --fake-pi --script dev/msgTime.js

# 验输入框左边那颗「你说过的话」与它弹出来的清单（按钮常显、点开一行一句、当前那句标亮、
# 点一行跳过去、Esc 与点别处收起、空会话只说一句“还没说过话”、手机上往上弹不出屏）：
npm run web:shot -- --width 900 --height 700 --script dev/saidList.js

# 验会话那套（顶条名字跟着 pi 标题变 / 切会话 / 列表里关会话）：
npm run web:shot -- --fake-pi --script dev/sessionFlow.js

# 验顶条会话名下拉框里每行那颗关闭叉（点叉先出确认条：整行变红、行尾多一颗勾，
# 点勾才真关；点叉或者干等 4 秒，确认条自己收回；确认条出来时清单宽度不变）：
npm run web:shot -- --fake-pi --script dev/sessionMenuClose.js

# 验「关闭会话」快捷键（设置里那一行默认 Ctrl+Alt+W；真按一下就关掉正在看的那个会话、
# 自动切到剩下的；焦点在输入框里按也照样关）：
npm run web:shot -- --fake-pi --width 900 --height 800 --script dev/closeShortcut.js

# 验派子会话（说一句带“派活”的话就会派一个）：跑完自动关、没跑完不关、
# 正看着就不关；子会话跑得比人手快，配慢一点儿的假 pi 才来得及点进去
FAKEPI_THINK_MS=900 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaFlow.js

# 验子会话那三个工具里平时没人喊的两个（停掉 / 查看）：这两句也由真扩展接（暗号、名录都是它的代码在动），
# 所以要慢一点儿的假 pi，才来得及在它还在跑的时候停掉：
FAKEPI_THINK_MS=4000 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaTools.js

# 验目标（/goal）那几条命令：谈验收清单 → 开始 / 暂停 / 继续 / 刷新后还在 / 清除。
# 判官循环会接着转，所以这个脚本自己把假判官拖慢、并且让它一直报不过，
# 好让目标停在“进行中”上验命令本身：
npm run web:shot -- --fake-pi --script dev/goalCommand.js

# 验目标条那几种脸（待确认 / 进行中 / 已暂停 / 已完成 / 点开看全文）：
# 目标状态直接投给页面，不真叫模型：
npm run web:shot -- --fake-pi --script dev/goalFlow.js

# 验判官循环整条路：工人跑完一轮 → 派判官去验 → 没过就把批评发回工人 → 过了就收工；
# 顺便验判官在跑的时候进「项目与会话」列表、报完结论就关掉（列表回到只剩工人一个）：
npm run web:shot -- --fake-pi --script dev/goalLoop.js

# 验“插话不停目标”（目标跑着时你插一句：目标条还是进行中、正在验的判官不被动、
# 它验完的结论照样发回工人、循环接着转；想停还是自己打 /goal 暂停）：
npm run web:shot -- --fake-pi --script dev/goalInterject.js

# 验“判官连着几轮报的是同一批没过条目 → 算没进展，自己停下”（别让工人原地打转烧钱）：
npm run web:shot -- --fake-pi --script dev/goalStale.js

# 验顶条中间那颗小点（本会话闲着、派出去的子会话还在跑时也亮着呼吸，点下面写着还有几个在跑；
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

# 验“跑完发系统通知”（正看着的那个会话也发、别的屏在聊的会话也发、点一下切过去、
# 自己按 Esc 停掉的那一轮不发、派出去的子会话不发、设置里那一项关掉就不发；
# 无头浏览器里把 Notification 换成记账的假的）：
node dev/turnNotice.js

# 验“模型问选择题（ask_choice）也发一条系统通知”（跟“跑完一轮”同一个开关、同一个规矩：
# 正看着它也发、别的屏在聊的会话在问也发、点一下切过去答；扩展问的确认 / 输入 / 选一个不发；
# 开关关掉就不发）：
node dev/askNotice.js

# 验“页面是从 https 反代的地址打开的”（手机上想收到通知就得走 https，见 README 那条）：
# 设置里写下的来源放行、别人的照旧 403、反代后面页面能收能发、那个地址算“安全来源”，
# 顺带看 http 地址下设置里给出的理由对不对（现签一张证书、本机起一个 https 反代来跑）：
node dev/trustedOrigin.js

# 验问话卡片（模型问的选择题、扩展问的确认 / 输入 / 选一个：都长在会话的消息流里）；
# 假数据、秒回：单选 / 多选 / 自己写 / 停止生成 / 确认 / 输入 / 选一个 / 刷新页面 各走一遍；
# 还盯着两行小字：那两个输入框写着 enterkeyhint（手机键盘那颗键是回车，不是“下一项”），
# 以及“自己写”那行里回车交完光标落在下面那个输入框里
npm run web:shot -- --fake-pi --script dev/askCards.js

# 真模型那条（慢，一句要等几十秒）：真 pi 加载插件的桥扩展，走完整条协议
npm run web:shot -- --script dev/askQuestion.js

# 真扩展那条：先把 dev/askDialogTrigger.ts 复制到 ~/.pi/agent/extensions/，跑完删掉
npm run web:shot -- --script dev/askDialog.js

# 验消息流末尾那颗胶囊（空会话不露面；一轮跑完在末尾露面、脸是「继续」、点它直接发一条“继续”
# 且输入框里打了一半的字留着、点完先收起来防连点、生成中换成「卡住了」且跟得住末尾、
# 点「卡住了」这一轮当场停住并补发一条“卡住了”、再跑完又回到末尾；
# 页面重开（整屏重画一条条重放）之后也还在末尾，生成中重开也一样；
# 假模型得每轮停一下才看得见生成中那一下，也得认中止才验得出“停住”那一下；
# 停顿给长一点，生成中重开页面那一幕才来得及看）：
FAKEPI_THINK_MS=2500 npm run web:shot -- --fake-pi --script dev/endHint.js

# 验断线重连（锁屏 / 切后台 / 断网 / 反复锁屏 / 反复弄断连接 / 断线期间问的选择题 / 整屏重画）：
#   场景一 冻住、场景二 断网、场景三 冻住+断网、场景四 反复冻住解冻、
#   场景五 反复把连接弄断（验序号补发不重不漏，重连地址上带着 since）、
#   场景六 锁屏期间连接悄悄断了（正文到了、尾巴丢了），回来页面自己重开连接补回丢失的消息、
#   场景七 断线那段里模型问的选择题（连接悄悄死掉、卡片没送到），回来重连后卡片要补上、能答、
#   场景八 补不上、只能整屏重画时（序号对不上）：视野留在原处、看过的消息不被裁掉
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

# 验 ```mermaid 代码块画成图（消息流里：受支持的画出来、不支持的留代码块加一行说明、
# 中文节点名也画得出、换成深色不重画就跟着变）：
node dev/mermaidCheck.js

# 验文件侧边栏里那份 markdown 文档里的 mermaid（同一个播放器，换个地方）：
node dev/mermaidFileCheck.js

# 验 mermaid 那个 1.5MB 的库没排进首屏（浏览器页面按需加载、地址写在 meta 里带着指纹，
# 面板那边仍然内联）：只拼页面、不开浏览器，几秒跑完。改过 chatUiFiles / pageHtml 后跑一下：
node dev/lazyScripts.js

# 验历史列表那两件事（纯 Node，不开浏览器）：扫描结果的缓存（同一个文件不重扫、
# 文件改了就重扫）、子会话靠清单认（含不走那套文案的判官，老会话的文案兜底还在）：
node dev/childSessions.js

# 验「项目与会话」面板（顶条最右边那颗 <<<）：
# 正在对话一段、工作区那块的展开 / 收起、组里的「加载更多」、行尾那颗加号新建会话、
# 标题右边那颗加号（挑文件夹）、子会话不显示，一次过一遍：
npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/workspacePanel.js

# 验宽窗下常驻的项目与会话侧边栏（窗口 ≥ 900px）：开页面右边就是一列（不当浮层、不盖对话）、
# 点 <<< 收起、刷新后还是收起（记住了）、点面板里的行面板不关、开别的浮层时那一列的位置留着；
# 底部「设置」那条线与对话那边输入区上边线齐（输入框长高时线跟着往上走、按钮不动）；
# 同一趟里把视口改成手机宽再看一次：那一列整个不见，点 <<< 是原来的抽屉（有遮罩、
# 整屏高、贴着右边，不是居中弹出的弹窗）：
npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/sidebarDock.js

# 验「对话在更新（开始生成 / 跑完）时，常驻的项目与会话侧边栏只动『正在对话』那一格」：
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
| `turnNotice.js` | 验“跑完发系统通知”（任何会话都发、点一下切过去、被停的那一轮不发、子会话不发、开关一关就不发；页面的 `Notification` 换成记账的假的）：`node dev/turnNotice.js` |
| `askNotice.js` | 验“模型问选择题（ask_choice）也发一条系统通知”（同一个开关、同一个规矩：正看着它也发、别的屏在聊的会话在问也发、点一下切过去答；扩展问的确认 / 输入 / 选一个不发；开关一关就不发）：`node dev/askNotice.js` |
| `trustedOrigin.js` | 验“页面是从 https 反代的地址打开的”（设置里 `webServer.trustedOrigins` 写下的来源放行、别人的照旧 403、反代后面页面照常收发、那个地址算“安全来源”所以通知发得出去；顺带看 http 地址下设置里给的理由对不对；现签证书 + 本机起一个 https 反代来跑）：`node dev/trustedOrigin.js` |
| `reconnect.js` | 验断线重连（冻住 / 断网 / 反复锁屏 / 反复弄断连接 / 断线期间问的选择题 / 补不上时整屏重画的视野）：`node dev/reconnect.js` |
| `mermaidCheck.js` | 验消息流里的 ```mermaid 画成图（受支持的出图、不支持的留代码块加一行说明、中文节点名不被吞、换深色不重画就跟着变、页面不报错）：`node dev/mermaidCheck.js` |
| `mermaidFileCheck.js` | 验文件侧边栏里那份 markdown 文档里的 mermaid（同一个播放器，换个地方）：`node dev/mermaidFileCheck.js` |
| `lazyScripts.js` | 验 1.5MB 的 mermaid 没排进首屏（浏览器页面按需加载、地址写在 meta 里带着指纹；面板仍然内联）：`node dev/lazyScripts.js` |
| `childSessions.js` | 验历史列表那两件事（扫描结果按改动时间 / 大小缓存、子会话靠清单认而不是看第一条用户说了什么）：`node dev/childSessions.js` |
| `childDot.js` | 验顶条那颗小点与它下面的数字（子会话在跑时父会话那颗点也呼吸、点下面写着还有几个在跑，零个时数字收起来；点与箭头落在两行中间）：`npm run web:shot -- --script dev/childDot.js` |
| `thinkRow.js` | 验模型的思考显示成工具行里的 `think` 标签（当场生成 + 刷新重放 + 同批两段合并 + 正文之后补来的那段跑完并回本段那颗）：`npm run web:shot -- --fake-pi --script dev/thinkRow.js` |
| `thinkTipPerf.js` | 验 `think` 提示框开着时思考边流边长的开销与表现（节流、跟着贴底、往回滚就不跟）：`npm run web:shot -- --fake-pi --script dev/thinkTipPerf.js` |
| `endHint.js` | 验消息流末尾那颗胶囊（空会话不露面、跑完在末尾露面且脸是「继续」、点它发一条“继续”、打的字留着、生成中换成「卡住了」且跟得住末尾、点「卡住了」这一轮当场停住并补发一条“卡住了”、再跑完回到末尾、页面重开（含生成中重开）后还在末尾）：`FAKEPI_THINK_MS=2500 npm run web:shot -- --fake-pi --script dev/endHint.js` |
| `saidList.js` | 验输入框左边那颗「你说过的话」与它弹出来的清单（按钮常显、点开一行一句、当前那句标亮、点一行跳过去、Esc 与点别处收起、空会话只说一句“还没说过话”、手机上往上弹不出屏；假数据，不叫模型）：`npm run web:shot -- --width 900 --height 700 --script dev/saidList.js` |
| `msgTime.js` | 验正文右下角那个「消息的时刻」（不悬停不露面、原来那颗复制按钮确实没了、今天只写时分 / 别的日子补日期 / 跨年写全年、title 是完整年月日时分秒、没带时刻的按现在算、那颗小字不挡鼠标）：`npm run web:shot -- --fake-pi --script dev/msgTime.js` |
| `askCards.js` | 验问话卡片（长在消息流里）：假 pi 演模型调 `ask_choice` 与扩展问用户，单选 / 多选 / 自己写 / 停止生成 / 确认 / 输入 / 选一个 / 刷新页面各走一遍；那两个输入框写着 `enterkeyhint`、“自己写”那行里回车交完光标落回下面那个输入框也在这里盯着：`npm run web:shot -- --fake-pi --script dev/askCards.js` |
| `askQuestion.js` | 同上但那一条是真路的：真模型 → 真 pi（插件给它 `-e` 了桥扩展）→ 卡片 → 回话文件 → 工具结果（慢） |
| `askDialog.js` + `askDialogTrigger.ts` | 验真扩展问的“要你打字 / 要你点是或否 / 选一个”：触发扩展先复制到 `~/.pi/agent/extensions/`，不用模型 |
| `sessionMenuClose.js` | 验顶条会话名下拉框里每行的关闭叉（确认条那颗勾 / 那颗叉 / 超时 / 真关掉 / 宽度不变）：`npm run web:shot -- --fake-pi --script dev/sessionMenuClose.js` |
| `closeShortcut.js` | 验「关闭会话」快捷键（设置里那一行默认 `Ctrl+Alt+W`；真按一下就关掉正在看的那个会话并切到剩下的；焦点在输入框里按也照样关）：`npm run web:shot -- --fake-pi --width 900 --height 800 --script dev/closeShortcut.js` |
| `workspacePanel.js` | 验「项目与会话」面板（那颗 `<<<`）：正在对话一段、工作区那块的展开 / 收起（含记住）、组里的「加载更多」、行尾加号新建会话、标题右边那颗加号、子会话不显示：`npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/workspacePanel.js` |
| `sidebarDock.js` | 验宽窗下常驻的项目与会话侧边栏（`<<<`，窗口 ≥ 900px 才常驻）：打开 / 收起 / 记住收起 / 两根顶线对齐 / 底部那条线与输入区上边线齐（输入框长高时线往上走、设置那颗按钮不动）/ 点行不关面板 / 开别的浮层时那一列原样留着 / 工作区那两块「加载更多」/ 改窄再拉宽（窄窗那一块得贴着右边、整屏高，不是居中的弹窗；居中那几块得还在正中），一次过一遍：`npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/sidebarDock.js` |
| `sidebarRedraw.js` | 验对话更新时常驻那一列的重画范围（只该动「正在对话」那一格）：整块有没有重画、下半那一格的元素与滚动有没有动、重画过后点行还准不准：`FAKEPI_TICK_MS=60 npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/sidebarRedraw.js` |
| `newSessionRedraw.js` | 验开新会话时常驻那一列的重画范围（整块一次都不该重画、下半展开的组不许坍、新会话那一行加进上半、重画过后点上下的行都还准）：`FAKEPI_TICK_MS=60 npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/newSessionRedraw.js` |
| `sidebarPerf.js` | 量那颗 `<<<` 打开一次多少毫秒、滑入动画有没有被顶住（长任务 / 逐帧间隔）：`npm run web:shot -- --script dev/sidebarPerf.js` |
| `fileSidebar.js` | 验浏览器页面左边那一列「文件侧边栏」（点消息里的文件链接之后：行号与停在那一行、标签页、跟着刷新、图片直接看、二进制与超大给下载、目录、光名字（会话碰过的文件里按名字找）、工具卡片那颗「跳转」也开在这里、看不了的几种情形、认得的几种语言带颜色（别的黑白、太大的不上色也不卡页面）、markdown 文件排好版渲染成文档（不留行号，别的文件照旧带行号）、这一列角上那颗折行开关（选过记在这台设备里），以及那条只读文件地址本身的拒绝情形）：`npm run web:shot -- --fake-pi --script dev/fileSidebar.js` |
| `htmlPreview.js` | 验文件侧边栏里把 html 当网页打开（点 `.html` 链接摆出的是渲染好的页面，不是源码：页面里的相对样式与脚本真生效、链接里带的行号等于没带、文件改过这一列自己重载那张网页；以及 `/site/` 那条地址的规矩：HEAD 只给头与修改时间、没这个文件 404、会话目录外的 403）：`npm run web:shot -- --fake-pi --script dev/htmlPreview.js` |
| `options.js` | 两条命令共用的命令行参数 |
| `tabaTools.js` | 验子会话的「停掉」与「查看」两个工具（派活那条在 `tabaFlow.js`）：`FAKEPI_THINK_MS=4000 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaTools.js` |
| `fakePi.js` | 假的 pi（`--fake-pi` 用）：协议跟真 pi 一样，模型换成按剧本演戏，界面调试秒回。说一句「问单选 / 问多选 / 问确认 / 问输入 / 问选项」就演一次问话；说一句「碰文件」就 read 几个铺好的文件（让后端那份「这个会话碰过的文件」清单里有东西）。**派子会话与问话那几个工具，它加载的是宿主写下的真扩展**（见 src/bridgeAssets.ts），所以那两段代码每跑一次 dev 脚本就真跑一遍 |
| `fake-pi.cmd` / `.sh` | 上面那个的包装：Windows 上 piPath 得是 .cmd 才能被 shell 起来 |
| `makePng.js` | 生成示例图片（不依赖任何第三方库）：调试工作目录里那张 1600x400 的图就是它写的 |
| `shots/` | 截图（不进版本库） |

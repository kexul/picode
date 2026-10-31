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

# 验看图那一层（点开带图的工具结果后还能放大缩小）：滚轮定点缩放、手机上两指捏合、
# 放大后按住拖动、双击还原、Esc 关掉（且不顺手停掉正在生成的那一轮）、没放大时点图本身照旧关：
npm run web:shot -- --width 1000 --height 760 --script dev/lightboxZoom.js

# 验「正在跑的那一条」（工具标签下面那行摘要：在跑的那条把命令 / 读哪个文件直接写出来，
# 同时跑几条也只露最近开始的那一条（一条跑完这一块高矮不变、下文不跟着跳），
# 一条都不在跑就冻住（齿轮停转、耗时定住），字一直留着；
# 新的命令来了原地顶掉，下面出正文 / 铺进问话卡片 / 这一轮跑完才整条收掉，
# 一串 60 毫秒跑完的调用连着来也不该一闪一闪，think 与 ask_choice 不出这条，
# 一行放不下的长命令字自己慢慢横向滚、只往一个方向（到头停一下从头来，不看末尾就白滚了；冻住的也滚），
# 放得下的那条一动不动，每条末尾钉一个往上走的耗时（字滚它不滚、冻住后不再变、重放的老调用不写））：
npm run web:shot -- --width 900 --height 620 --script dev/runningLine.js

# 验「结果永远不会回来的工具调用」（那一轮跑到一半被中断 / pi 进程没了）：
# 从前它们会一直转圈、耗时一直往上数；现在标签还在、提示框里写着「这一轮被中断，没有结果」，
# 既不转圈也不再有「正在跑」那行。真把 pi 进程弄死一遍：
npm run web:shot -- --fake-pi --script dev/killedTool.js
# 重放历史里的那种（会话文件里只有调用、没有结果）：先造那份会话，把它打出来的那句照抄
node dev/orphanReplay.js

# 验「正在输出时视野跟不跟着底部走」（有时忽然不跟了：程序自己滚的那一下记的是“滚到底”，
# scroll 事件下一帧才到，中间内容长了一点就被当成“用户往回滚了”；这里按着那个顺序验一遍，
# 顺带验用户自己往回滚时不许被拽回去、点「跳到最新」又贴回底）：
npm run web:shot -- --width 420 --height 800 --script dev/followBottom.js

# 验断线重连之后队列里那几条显示的还是不是真的（重画只重放消息、排队不是消息：
# 断线那段 pi 已经把排队的投出去了，回来还写着“在排队”；重画时后端要补一份排队状态的真相）：
npm run web:shot -- --fake-pi --script dev/queueResync.js

# 验生成速度那颗数（胶囊最右边）：后端算了推过来、界面写出来、刷新页面还在，
# 以及真跑一轮的时候有数、跑完冻住（假模型调慢一点，才有时间看跑着的时候）：
FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tps.js

# 验正文右下角那个「消息的时刻」（鼠标停上去才露、原来的复制按钮已经撤了：今天只写时分，
# 别的日子补日期、跨年写全年，title 是完整时刻，没带时刻的按现在算，那颗小字不挡鼠标）：
npm run web:shot -- --fake-pi --script dev/msgTime.js

# 验输入框右边那颗「你说过的话」与它弹出来的清单（按钮常显、点开一行一句、当前那句标亮、
# 点一行跳过去、Esc 与点别处收起、空会话只说一句“还没说过话”、手机上往上弹不出屏）：
npm run web:shot -- --width 900 --height 700 --script dev/saidList.js

# 验会话那套（顶条名字跟着 pi 标题变 / 切会话 / 关会话：已经跑完的会话，面板与下拉框里那颗 × 点一下就关、点行身只切不关）：
npm run web:shot -- --fake-pi --script dev/sessionFlow.js

# 验关会话的二次确认（会话正在跑的时候点叉才要再点一下；跑完的直接关）。
# 三处入口同一个规矩：顶条那一格点自己的 ×（那一格变红、叉换成勾）、在跑时按 Alt+W
# （落在那一格上）、「项目与会话」里那几行（点叉出确认条、点叉或干等 4 秒撤销）：
# 假 pi 每个工具卡 5 秒，才有时间在“正在跑”的时候去点关闭
FAKEPI_THINK_MS=5000 npm run web:shot -- --fake-pi --width 900 --height 800 --script dev/sessionMenuClose.js

# 验左右划切会话（手机上手指横着划；电脑上在没有文字的地方按住鼠标拖。两种都是跟手、松手过小半屏就切；
# 从文字上按下（选字）、划得不够远、竖着划都不切；走到头（最右 / 最左那个）不绕回另一头，
# 窄窗里是跟手把那一侧的侧边栏拉出来（往左划是右边的「项目与会话」、往右划是左边的文件侧边栏，
# 松手过四成就留下、不够就滑回去）；开着的时候在它身上往它来的那一边横着一划也能推回去；
# 宽窗里那两块是常驻的，滑到头什么都不发生。子会话跳过不占站位）：
npm run web:shot -- --width 420 --height 900 --fake-pi --script dev/swipeSession.js
npm run web:shot -- --width 1000 --height 760 --fake-pi --script dev/dragSession.js

# 验左右划跳过子会话（先派一个子会话挂着，再从它父会话往左划：该落在下一个主会话上）：
FAKEPI_THINK_MS=6000 FAKEPI_TICK_MS=40 npm run web:shot -- --width 420 --height 900 --fake-pi --script dev/swipeSkipChild.js

# 验「关闭会话」快捷键（设置里那一行默认 Alt+W；真按一下就关掉正在看的那个会话、
# 自动切到剩下的；焦点在输入框里按也照样关）：
npm run web:shot -- --fake-pi --width 900 --height 800 --script dev/closeShortcut.js

# 验派子会话（说一句带“派活”的话就会派一个）：跑完自动关、没跑完不关、
# 正看着就不关；子会话跑得比人手快，配慢一点儿的假 pi 才来得及点进去
FAKEPI_THINK_MS=900 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaFlow.js

# 验子会话那三个工具里平时没人喊的两个（停掉 / 查看）：这两句也由真扩展接（暗号、名录都是它的代码在动），
# 所以要慢一点儿的假 pi，才来得及在它还在跑的时候停掉：
FAKEPI_THINK_MS=4000 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaTools.js

# 验「自动模式」：右下角那颗小开关（点一下拨开、再点一下停）、刷新后还开着 →
# 一轮跑完派判官 → 判官说「继续」就再来一轮 → 说「结束」就自己关掉；
# 打 /auto 会被吞掉（不发出去、不回话）；开着的时候模型问的选择题（ask_choice）不弹卡片、
# 直接替你点它推荐的那一项（不然会话就卡在那张卡片上）。判官循环就在这个脚本里跑完，不用另外配参数：
npm run web:shot -- --fake-pi --script dev/autoLoop.js

# 验顶条中间那颗小点（本会话闲着、派出去的子会话还在跑时也亮着呼吸，点下面写着还有几个在跑；
# 小点与箭头是落在“会话名 + 目录两行”中间，不是只对着会话名那一行；投假会话列表，不真派活）：
npm run web:shot -- --width 900 --height 620 --script dev/childDot.js

# 验「模型的思考也显示成工具行里的一种条目」（当场生成 / 刷新重放 / 同批两段收成一个带次数的标签；
# 正在想的时候那颗齿轮在转、想完停住 —— 思考不出「正在跑的那一条」，界面上就这一处在转）：
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

# 验“页面是从 https 反代的地址打开的”（手机上想用 https 打开就得走它，见 README 那条）：
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

# 验 ```mermaid 代码块画成图（消息流里：流程图/时序图/饼图/甘特图都画得出、中文节点名也行、
# 写坏的留代码块加一行说明、画图那个脚本是出现图才去拉的、换成深色不重画就跟着变，
# 顺带把插件里的对话面板那一份也加载一遍看它画不画得出）：
node dev/mermaidCheck.js

# 验文件侧边栏里那份 markdown 文档里的 mermaid（同一个播放器，换个地方）：
node dev/mermaidFileCheck.js

# 验画图那个脚本（pele，700 多 KB）没排进首屏（浏览器页面按需加载、地址写在 meta 里带着指纹，
# 面板那边仍然内联）：只拼页面、不开浏览器，几秒跑完。改过 chatUiFiles / pageHtml 后跑一下：
node dev/lazyScripts.js

# 验历史列表那两件事（纯 Node，不开浏览器）：扫描结果的缓存（同一个文件不重扫、
# 文件改了就重扫）、子会话靠清单认（含不走那套文案的判官，老会话的文案兜底还在）：
node dev/childSessions.js

# 验「改动」那一格背后那个逐行比较（纯 Node）：改了两处、中间隔几千行没动时增删行数不能
# 报成“几千行全换了”；两处挨得近时切出来的两段不能叠；按 diff 拼得回两份原文：
node dev/diffCheck.js

# 验点文件链接时后端怎么挑文件（纯 Node）：写清楚的路径直接开；会话读写过的同名文件先认
# （同名的还有别处也只回它，这一下不扫整个仓库）；没碰过的才列文件清单；目录外那份不认：
node dev/linkCandidates.js

# 验「项目与会话」面板（顶条最右边那颗 <<<）：
# 正在对话一段、工作区那块的展开 / 收起、组里的「加载更多」、行尾那颗加号新建会话、
# 标题右边那颗加号（挑文件夹）、子会话不显示，一次过一遍：
npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/workspacePanel.js

# 验宽窗下常驻的项目与会话侧边栏（窗口 ≥ 900px）：开页面右边就是一列（不当浮层、不盖对话）、
# 点 <<< 收起、刷新后还是收起（记住了）、再展开第一帧就有内容（收起时里头那份留着）、
# 点面板里的行面板不关、开别的浮层时那一列的位置留着；
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
- **`waitReady` 会自己开一个会话**：浏览器页面进来时后端不替人开空会话了（等人挑工作区），
  所以 `page.waitReady()` 看到“没有会话”就顺手发一条新建会话（等于点了 `+`：开在后端的默认目录），
  接着等它就绪。想看“还没有会话”那一屏本身，加 `--skip-ready`。
- **截图默认把滚动条藏掉**（`--hide-scrollbars`）：图干净，但滚动条也就占不了宽度，
  跟浏览器里看到的会差一行半行。要照真样子看就加 `--scrollbars`，或者用 `node dev/inputProbe.js`
  （它默认就用真滚动条，还会把输入框的高度与滚动状态打印出来）。
- **设备像素比默认是 1**（`openPage({ dsf })`）：手机一般是 2～3，影响重画文字与挪图层要多少力，
  量卡不卡的时候别在 1 上量。
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
| `trustedOrigin.js` | 验“页面是从 https 反代的地址打开的”（设置里 `webServer.trustedOrigins` 写下的来源放行、别人的照旧 403、反代后面页面照常收发、现签证书 + 本机起一个 https 反代来跑）：`node dev/trustedOrigin.js` |
| `reconnect.js` | 验断线重连（冻住 / 断网 / 反复锁屏 / 反复弄断连接 / 断线期间问的选择题 / 补不上时整屏重画的视野）：`node dev/reconnect.js` |
| `mermaidCheck.js` | 验消息流里的 ```mermaid 画成图（各种图都出图、写坏的留代码块加一行说明、画图那个脚本出现图才去拉、中文节点名不被吞、换深色不重画就跟着变、面板那一份也画得出、页面不报错）：`node dev/mermaidCheck.js` |
| `mermaidFileCheck.js` | 验文件侧边栏里那份 markdown 文档里的 mermaid（同一个播放器，换个地方；甘特图也画得出、写坏的留说明）：`node dev/mermaidFileCheck.js` |
| `lazyScripts.js` | 验画图的 pele（700 多 KB）没排进首屏（浏览器页面按需加载、地址写在 meta 里带着指纹；面板仍然内联）：`node dev/lazyScripts.js` |
| `childSessions.js` | 验历史列表那两件事（扫描结果按改动时间 / 大小缓存、子会话靠清单认而不是看第一条用户说了什么）：`node dev/childSessions.js` |
| `diffCheck.js` | 验「改动」那一格背后的逐行比较（大文件改两处不报成整段换掉、挨得近的两段不叠、按 diff 拼得回原文）：`node dev/diffCheck.js` |
| `linkCandidates.js` | 验点文件链接时后端怎么挑文件（写清楚的直接开、会话读写过的同名文件先认且不扫仓库、没碰过的才列清单、目录外的不认）：`node dev/linkCandidates.js` |
| `childDot.js` | 验顶条那颗小点与它下面的数字（子会话在跑时父会话那颗点也呼吸、点下面写着还有几个在跑，零个时数字收起来；点与箭头落在两行中间）：`npm run web:shot -- --script dev/childDot.js` |
| `tabClose.js` | 验顶条那排格上的 `×` 与挤了以后怎么收窄、怎么叠：每格都露着 ×（跑着时点一下变成勾、不真关），闲着点一下直接关；挤了（420 宽、五个会话）当前这一张挪到中间写名字、别的收成窄块只露那颗点，越往外越窄也越往旁边那张底下压，开着的会话一个不少（点一张照样切过去）；窗口放宽名字都回来：`FAKEPI_THINK_MS=6000 npm run web:shot -- --fake-pi --script dev/tabClose.js` |
| `tabSlide.js` | 验顶条那排格的过渡：切会话（点别的格 / 手机上左右划）时，换了位置的格子从旧地方滑过去、底色淡过去；左右划到一半时当前那一格已经收窄、要进来的那一格已经涨宽且名字露出来（三个会话挤成一张大的 + 两颗点时；两个会话放得下、每格都写着名字的那种宽度本来就不该动）；松手切过去那一下从手指停下的宽度接着长（不先缩成小标签再弹开）；弹回去以后不留钉住的宽度：`npm run web:shot -- --fake-pi --width 420 --height 700 --script dev/tabSlide.js` |
| `tabSelectStyles.js` | 把顶条「当前这一格」的几种画法（描边 / 下划线 / 灰底 / 蓝底 …）摆成一竖排各照一张，挑样式时用（浅色 / 深色各跑一遭）：`npm run web:shot -- --fake-pi --script dev/tabSelectStyles.js`，加 `--theme dark` 跑深色那张 |
| `thinkRow.js` | 验模型的思考显示成工具行里的 `think` 标签（当场生成 + 刷新重放 + 同批两段合并 + 正文之后补来的那段跑完并回本段那颗；正在想时那颗齿轮在转、想完停住）：`npm run web:shot -- --fake-pi --script dev/thinkRow.js` |
| `thinkTipPerf.js` | 验 `think` 提示框开着时思考边流边长的开销与表现（节流、跟着贴底、往回滚就不跟）：`npm run web:shot -- --fake-pi --script dev/thinkTipPerf.js` |
| `endHint.js` | 验消息流末尾那颗胶囊（空会话不露面、跑完在末尾露面且脸是「继续」、点它发一条“继续”、打的字留着、生成中换成「卡住了」且跟得住末尾、点「卡住了」这一轮当场停住并补发一条“卡住了”、再跑完回到末尾、页面重开（含生成中重开）后还在末尾）：`FAKEPI_THINK_MS=2500 npm run web:shot -- --fake-pi --script dev/endHint.js` |
| `saidList.js` | 验输入框右边那颗「你说过的话」与它弹出来的清单（按钮常显、点开一行一句、当前那句标亮、点一行跳过去、Esc 与点别处收起、空会话只说一句“还没说过话”、手机上往上弹不出屏；假数据，不叫模型）：`npm run web:shot -- --width 900 --height 700 --script dev/saidList.js` |
| `msgTime.js` | 验正文右下角那个「消息的时刻」（不悬停不露面、原来那颗复制按钮确实没了、今天只写时分 / 别的日子补日期 / 跨年写全年、title 是完整年月日时分秒、没带时刻的按现在算、那颗小字不挡鼠标）：`npm run web:shot -- --fake-pi --script dev/msgTime.js` |
| `firstLoad.js` | 量“手机上第一次打开”到底下了多少字节、花了多久：把一个真会话文件装进调试后端，用全新浏览器打开页面，按 URL 与消息类型列字节账，报“从点开到能打字 / 到历史画完”：`node dev/firstLoad.js --session <某个 .jsonl> --cpu 4`（4 ≈ 手机的 CPU 档位） |
| `liveDetail.js` | 验“实时流里思考 / 工具内容一个字都不发”：假模型把思考与 bash 输出撑长（`FAKEPI_LONG=3000`），这一轮推过去的思考增量是 0 字，点开 `think` / 工具标签时提示框先写一行「还有 N 字没带过来，正在取…」，一会儿换成全文；调用参数只带那行摘要（`$ ls` 一直看得见），write 的写入预览要点开才来：`FAKEPI_LONG=3000 npm run web:shot -- --fake-pi --script dev/liveDetail.js` |
| `detailOnDemand.js` | 同上那条路的另一半（历史重放）：用真会话打开页面，标签上只有工具名、点开提示框才把全文取回来：`node dev/detailOnDemand.js --session <某个 .jsonl>` |
| `thinkDetail.js` | 验 `think` 点开不是空的（三种会变成「（没有输出）」的情形）：想一半点「停止生成」后已经想到的那段还在；思考的收尾比正文晚到（真 pi 的 openai-completions 适配器就这样，假模型用 `FAKEPI_LATE_THINK_END=1` 演）时只出一颗标签、点开是全文；模型只给加密内容（一个字都没有）时写「（这段思考没有文字）」：`FAKEPI_LATE_THINK_END=1 FAKEPI_LONG=1500 FAKEPI_TICK_MS=25 npm run web:shot -- --fake-pi --script dev/thinkDetail.js` |
| `toolStats.js` | 验「工具调用耗时」那张弹窗（项目与会话侧边栏底部「设置」旁边那颗「统计」）：空的时候先说一句还没跑过、跑过之后按工具名一张表（次数 / 合计 / 平均 / 最长）+ 花得最久的几次调用（长命令默认截成 …，点一下展开成完整多行、再点收起）、弹窗开着又来一条结果也跟着长、点叉与 Esc 收起；手机上铺满整屏（窄窗要先点 `<<<` 把抽屉拉出来）：`npm run web:shot -- --width 1200 --height 760 --script dev/toolStats.js` |
| `envInfo.js` | 验侧边栏底部那颗「工具」（这个会话加载着什么：工具 / 技能 / MCP 服务器）：真会话那一份（会话刚起来时 MCP 还没连上、过几秒挂上来了跟着变），再投一份假清单看几种少见写法（用不了 / 要从脚本里调 / 要先被搜出来的工具、项目级技能、停用的 MCP、配置读错的 MCP）；点叉与 Esc 收起；窄窗要先点 `<<<` 把抽屉拉出来：`npm run web:shot -- --width 1200 --height 800 --script dev/envInfo.js` |
| `askCards.js` | 验问话卡片（长在消息流里）：假 pi 演模型调 `ask_choice` 与扩展问用户，单选 / 多选 / 自己写 / 停止生成 / 确认 / 输入 / 选一个 / 刷新页面各走一遍；那两个输入框写着 `enterkeyhint`、“自己写”那行里回车交完光标落回下面那个输入框也在这里盯着：`npm run web:shot -- --fake-pi --script dev/askCards.js` |
| `askQuestion.js` | 同上但那一条是真路的：真模型 → 真 pi（插件给它 `-e` 了桥扩展）→ 卡片 → 回话文件 → 工具结果（慢） |
| `askDialog.js` + `askDialogTrigger.ts` | 验真扩展问的“要你打字 / 要你点是或否 / 选一个”：触发扩展先复制到 `~/.pi/agent/extensions/`，不用模型 |
| `closeShortcut.js` | 验「关闭会话」快捷键（设置里那一行默认 `Alt+W`；对已经跑完的会话真按一下就关掉正在看的那个并切到剩下的；焦点在输入框里按也照样关）：`npm run web:shot -- --fake-pi --width 900 --height 800 --script dev/closeShortcut.js` |
| `sessionMenuClose.js` | 验关会话的二次确认（只对正在跑的会话）：顶条上那一格点 × → 那一格变红、叉换成勾（不真关），再点一下才关；在跑时按 `Alt+W` 同样落在那一格上；「项目与会话」里「正在对话」那几行点叉先出确认条（整行变红、行尾一颗勾一颗叉），点叉撤销、干等 4 秒撤销、点勾真关、点行身也算撤销：`FAKEPI_THINK_MS=5000 npm run web:shot -- --fake-pi --width 900 --height 800 --script dev/sessionMenuClose.js` |
| `workspacePanel.js` | 验「项目与会话」面板（那颗 `<<<`）：正在对话一段、工作区那块的展开 / 收起（含记住）、组里的「加载更多」、行尾加号新建会话、标题右边那颗加号、子会话不显示：`npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/workspacePanel.js` |
| `sidebarDock.js` | 验宽窗下常驻的项目与会话侧边栏（`<<<`，窗口 ≥ 900px 才常驻）：打开 / 收起 / 记住收起 / 收起时里头那份留着（再展开第一帧就有内容，不用等宿主扫磁盘）/ 两根顶线对齐 / 底部那条线与输入区上边线齐（输入框长高时线往上走、设置那颗按钮不动）/ 点行不关面板 / 开别的浮层时那一列原样留着 / 工作区那两块「加载更多」/ 改窄再拉宽（窄窗那一块得贴着右边、整屏高，不是居中的弹窗；居中那几块得还在正中），一次过一遍：`npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/sidebarDock.js` |
| `sidebarRedraw.js` | 验对话更新时常驻那一列的重画范围（只该动「正在对话」那一格）：整块有没有重画、下半那一格的元素与滚动有没有动、重画过后点行还准不准：`FAKEPI_TICK_MS=60 npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/sidebarRedraw.js` |
| `newSessionRedraw.js` | 验开新会话时常驻那一列的重画范围（整块一次都不该重画、下半展开的组不许坍、新会话那一行加进上半、重画过后点上下的行都还准）：`FAKEPI_TICK_MS=60 npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/newSessionRedraw.js` |
| `switchPerf.js` | 量「在会话之间切换」多少毫秒（造一个装满消息的会话，跟空会话来回切）：真按快捷键走完后端一圈的耗时 / 只塞一条 `sessionActivated` 只剩挂壳的耗时，细分到排版、算样式、长任务：`node dev/switchPerf.js --pairs 1000 --rounds 3` |
| `sidebarPerf.js` | 量那颗 `<<<` 打开一次多少毫秒、滑入动画有没有被顶住（长任务 / 逐帧间隔）：`npm run web:shot -- --script dev/sidebarPerf.js` |
| `swipePerf.js` | 量「手机上左右划切会话」卡不卡：两个会话各塞一屋子消息，按下 / 跟手 / 松手三段分开报（帧间隔中位与最长、最长那帧在挪动后多久、长任务、排版与算样式各花多少），还能设设备像素比、`--cold`（要进来的那个壳没预排版）、`--extra`（多开几个会话）、`--cpu N`（主线程拖慢几倍，近似手机）、`--profile`（剖整趟）、`--css`（临时塞一段样式试别的写法）：`node dev/swipePerf.js --pairs 800 --rounds 2 --cold --dsf 3 --cpu 4 --profile` |
| `fileSidebar.js` | 验浏览器页面左边那一列「文件侧边栏」（点消息里的文件链接之后：行号与停在那一行、标签页、跟着刷新、图片直接看、二进制与超大给下载、目录、光名字（会话碰过的文件里按名字找）、工具卡片那颗「跳转」也开在这里、看不了的几种情形、认得的几种语言带颜色（别的黑白、太大的不上色也不卡页面）、markdown 文件排好版渲染成文档（不留行号，别的文件照旧带行号）、这一列角上那颗折行开关（选过记在这台设备里），以及那条只读文件地址本身的拒绝情形）：`npm run web:shot -- --fake-pi --script dev/fileSidebar.js` |
| `filePullBack.js` | 验看文件时“往下拉就回清单”那个手势（手机上的）：正文在最上头时手指往下拖，正文跟着走（有阻尼）、缝里先写「继续往下拉，回清单」、过线变「松手，回清单」；松手过线回清单；不到线 / 推回去都当场滑回原处；正文滚过一段、或者根本没在看文件时下拉不算这个手势：`npm run web:shot -- --fake-pi --width 420 --height 900 --script dev/filePullBack.js` |
| `fileSearch.js` | 验 `Ctrl+Shift+F` 那块文件搜索浮层：弹出来 / 再按一次或 Esc 收起、输入框自己拿到焦点；「文件名」一档边打边出、命中处标出来、回车在左边那一列打开；「内容」一档搜文件里的文字（路径:行号 + 那一行）、只在 node_modules 里的不出现、超过 2 MB 的不当正文搜；文件侧边栏头上那颗放大镜也能开；同名不止一个时点链接会弹它出来让人挑（预填名字、挑中的停在链接说的那一行）；消息流里光名字 / 路径写岔了的链接也从同一份文件清单里挑；最后按插件里的对话面板再跑一遍（点一条结果是给插件发 openFile）：`npm run web:shot -- --fake-pi --script dev/fileSearch.js` |
| `weixinInbox.js` | 验「微信里回一句，落进对的会话」（假模型 + 假服务）：跑一轮推到微信 → **引用那条**回一句（落进同一个会话）→ **不引用**直接回（落进最近那个会话）→ 别人发来的不理 → 对账表里几条都指着同一个会话：`npm run web:shot -- --fake-pi --script dev/weixinInbox.js` |
| `weixinGateway.js` | 验「一台机器收发微信，别的机器的事由它代发」（假模型 + 假服务）：本机跑一轮 → 假装另一台往 `/notify` 推一条 → 网关把它也发到微信（正文带「哪台 · 」）→ 引用那条回一句 → 转回那台的 `/weixinReply` 并接进会话 → 跑完再推一条；另外验替别人推的摘要不会被掐到 200 字（这边收到 300 多字得原样留着）、会话标识 / 会话文件对不上时回 409，以及这台自己当“干活的那台”时推出去的通知里带没带回话地址与会话文件：`npm run web:shot -- --fake-pi --script dev/weixinGateway.js` |
| `weixinPush.js` | 验“会话跑完一轮就往微信里推一条”（假模型 + 假 iLink 服务）：把登录态临时换成假的，看那头收到的正文（该是一行 `会话名：摘要`，不带机器名、不带“跑完了一轮”、不带地址）以及 `weixin/sent.json` 里有没有记下“这条是为了哪个会话发的”（大整数编号要原样当字符串收下）；跑完把真登录态放回去。要验“回复比上限长时摘要截在上限、以「…」收尾”（`FAKEPI_REPLY_LONG` 把假模型收尾那句撑长）：`FAKEPI_REPLY_LONG=1000 npm run web:shot -- --fake-pi --script dev/weixinPush.js`。要真发到自己微信上就加 `PICHAT_WEIXIN_REAL=1`（用你扫出来的那份真令牌）：`npm run web:shot -- --fake-pi --script dev/weixinPush.js` |
| `weixinLogin.js` | 验设置里那块「微信」的扫码登录（**假 iLink 服务**：`PICHAT_WEIXIN_API` 指到本地一个假端，先回「还没人扫」→「扫了」→ 要一次数字 → 给一枚假令牌）：二维码画出来了没有、状态字跟不跟着变、数字输入框出不出来、令牌有没有落到 `dev/.scratch/pichat/weixin/account.json`：`npm run web:shot -- --script dev/weixinLogin.js` |
| `weixinScan.js` | 真机扫一次（走真微信那头）：打开设置 → 微信 → 点「扫码登录」，把窗口留着让人扫。先另开一个终端 `npm run web:dev`，再 `npm run web:shot -- --url http://127.0.0.1:51999/ --headed --keep --script dev/weixinScan.js` |
| `changesTab.js` | 验文件侧边栏那一格「改动」（这个会话改过哪些文件，一个地方全看）：常驻在「项目目录」后面且没有那颗叉、没改过文件时一句提示、假模型真改完一个文件之后那一行长出来（相对写法 + `+1` `−1`、没展开时看不到 diff）、点开这一行看到那条删除与新增、刷新页面清单还在（数据在后端会话的内存里，不跟着页面走）、磁盘上把文件删掉后那一行标「已删除」且展开整份都是删掉的、点「回滚」先问一句再把这个文件整份写回去、清单空了回到那句提示：`npm run web:shot -- --fake-pi --script dev/changesTab.js` |
| `htmlPreview.js` | 验文件侧边栏里把 html 当网页打开（点 `.html` 链接摆出的是渲染好的页面，不是源码：页面里的相对样式与脚本真生效、链接里带的行号等于没带、文件改过这一列自己重载那张网页；以及 `/site/` 那条地址的规矩：HEAD 只给头与修改时间、没这个文件 404、会话目录外的 403）：`npm run web:shot -- --fake-pi --script dev/htmlPreview.js` |
| `mdImagePaths.js` | 验正文里的图片路径放宽到整机（会话目录里的相对写法走 `/site/`；`../x.png`、`C:/…`、`file:///…` 走 `/file?anywhere=1`；外站地址照旧不加载；文件侧边栏那份 `.md` 里同样；那条放宽的地址只认图片——非图片 403、带 `download=1` 403、不带开关时会话目录外照旧 403）：`npm run web:shot -- --fake-pi --script dev/mdImagePaths.js` |
| `options.js` | 两条命令共用的命令行参数 |
| `tabaTools.js` | 验子会话的「停掉」与「查看」两个工具（派活那条在 `tabaFlow.js`）：`FAKEPI_THINK_MS=4000 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaTools.js` |
| `fakePi.js` | 假的 pi（`--fake-pi` 用）：协议跟真 pi 一样，模型换成按剧本演戏，界面调试秒回。说一句「问单选 / 问多选 / 问确认 / 问输入 / 问选项」就演一次问话；说一句「碰文件」就 read 几个铺好的文件（让后端那份「这个会话碰过的文件」清单里有东西）。**派子会话与问话那几个工具，它加载的是宿主写下的真扩展**（见 src/bridgeAssets.ts），所以那两段代码每跑一次 dev 脚本就真跑一遍。它还会照真 pi 的样子往会话目录里记一份 `fake-session-<进程号>.jsonl`（一行一条消息）——要读会话文件的那几条路（`#` 引用、派子会话带上父会话的路径）才验得到 |
| `fake-pi.cmd` / `.sh` | 上面那个的包装：Windows 上 piPath 得是 .cmd 才能被 shell 起来 |
| `makePng.js` | 生成示例图片（不依赖任何第三方库）：调试工作目录里那张 1600x400 的图就是它写的 |
| `shots/` | 截图（不进版本库） |

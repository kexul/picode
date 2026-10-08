# Pi Chat

与 [pi coding agent](https://pi.dev) 对话的 **VSCode 插件**：在 VSCode 侧边栏对话。

## 结构

根目录即插件（标准 VSCode 扩展布局）：

```
src/                          插件 TypeScript 源码（tsc 编译到 out/）
  extension.ts                 入口：注册命令、webview view、diff 文档 provider
  chatViewProvider.ts          侧边栏聊天提供者（webview 装载、VSCode API、会话编排宿主）
  editorChatPanel.ts           编辑器区独立聊天 WebviewPanel（关闭/重载即终止）
  chatHtml.ts                  webview HTML：注入 VSCode 特有的 URI 解析 / CSP / chat.css
  renderHtml.ts                聊天界面 HTML 骨架生成（renderHTML()）
  piClient.ts                  pi --mode rpc 客户端（JSONL 协议；统一 request/pending）
  piRpc.ts                     RPC 命令/响应轻量类型与辅助函数
  runtimeTypes.ts              PiConfig / RuntimeHost / FileChange 等共享类型
  messageUtils.ts              消息/工具结果/对话树纯函数（可单测）
  editTracker.ts               工具卡片 + edit 快照/回滚/knownFiles
  sessionRuntime.ts            单个对话 tab 的运行时（独立 pi 进程 + 会话编排）
  chatControllerBase.ts        会话编排基类（标签管理含 tabList 节流、拾取器、模型选择）
  turnNotifier.ts              会话跑完的提醒：发 Windows 系统通知 + 界面内提示
  turnNotifyText.ts            提醒的文字组装（会话名取哪个 / 标题摘要怎么拼，不依赖 vscode，可单测）
  toastScript.ts               生成“弹 Windows 通知”的 PowerShell 脚本（不依赖 vscode，可单测）
  toastAppId.ts                插件激活时写当前用户注册表，让通知来源显示为“Pi Chat”
  sessionStore.ts              pi 会话文件的扫描 / 读取 / 元数据
  canvasData.ts                历史会话：家族消息图合并（共享前缀 / 分叉）
  historyCanvasPanel.ts        编辑器区历史会话（邮件列表 + 阅读预览）WebviewPanel
  historyCanvasHtml.ts         历史会话 HTML / CSP
  modelsConfig.ts              models.json 读写与内置默认模板
  webChatServer.ts             网页服务：用 Node 自带的 http 模块起服务（无第三方依赖）
  browserChatController.ts     “在浏览器里对话”这个工作区（第三个宿主，与侧边栏、编辑器区平级）
  browserHtml.ts               浏览器那份页面的 HTML（复用 renderHtml，补上主题变量与桥接脚本）
  webTransport.ts              网页服务的判断零件：资源白名单 / 本机地址判断 / 请求来源判断 / 消息缓冲（可单测）
  tabaProtocol.ts              派子会话：从 pi 进程 stderr 里挑暗号行的解析（可单测）
  tabaRoles.ts                 派子会话：角色文件（agents 目录里的 .md）的读取与解析（可单测）
  tabaTask.ts                  派子会话：子会话文件怎么写、第一条消息怎么拼（可单测）
  tabaRegistry.ts              派子会话：子会话登记表、状态、交回去的文字（可单测）
  tabaRunFiles.ts              派子会话：写到 ~/.pi/pichat/taba-runs/ 的那份名录（taba_peek 读它）（可单测）
  tabaLaunch.ts                派子会话：优先级怎么算、启动参数怎么拼（可单测）
  tabaBridgeSource.ts          塞进 pi 进程里那个扩展的源码（字符串；运行时写到 ~/.pi/pichat/）
  tabaAssets.ts                把上面那个扩展与自带角色文件写到 ~/.pi/pichat/（可单测）
media/                        对话前端资源（chat.js、chat.css、historyCanvas.js/css、
                              marked.js、highlight.js、settings.js）；webview 直接加载
                              browserBridge.js / browserTheme.css 只有浏览器那份页面用
```

## 环境要求

- Node.js 20+
- npm（自带）
- pi 已全局安装并鉴权（`npm i -g --ignore-scripts @earendil-works/pi-coding-agent`，再 `pi` + `/login`，或设置 API Key 环境变量）

## 构建与安装

```bat
build.bat           # npm install + 编译 + 打包 vsix
build.bat skip      # 跳过 npm install（依赖已装好时用，更快）；也可以设环境变量 SKIP_INSTALL=1
```

`build.bat` **只负责打出 vsix**：跑完 `npm run package`，找出 `pi-chat-*.vsix`，把文件名打印出来就结束了，
不会自动装进编辑器、也不会重载窗口（脚本只认 `skip` 这一个参数，传别的会报 unknown argument；
下面“装进编辑器”那一步要自己跑）。

打包要用 `vsce`，它不在 `devDependencies` 里，得先全局装一次：

```bash
npm i -g @vscode/vsce
```

产物：`pi-chat-vscode-<版本号>.vsix`（0.0.9 是 50 个文件、约 303 KB；插件本身不带第三方依赖）。

**装进编辑器**（用哪个编辑器就跑哪个命令，版本号换成实际的）：

```bat
:: VSCodium（PATH 里没有就写全路径，例如 "D:\Program Files (x86)\VSCodium\bin\codium.cmd"）
codium --install-extension pi-chat-vscode-0.0.9.vsix

:: VSCode
code --install-extension pi-chat-vscode-0.0.9.vsix
```

装完要**重载窗口**（命令面板 → `Developer: Reload Window`）新版本才生效。
注意重载会把插件里所有正在跑的 pi 进程一起结束掉，也就是所有还开着的对话都会没
（编辑器区那些工作区本来就是关掉即终止），所以有活在跑的时候别急着重载。

## 开发

```bash
npm install
npm run build    # tsc 编译到 out/
npm test         # 编译 + node:test（会话逻辑纯函数；网页服务的传输与端到端检查；派子会话的解析/角色/交回）
npm run package  # 打包 VSIX
```

VSCode 里 F5 直接调试（`.vscode/launch.json` 已配置 extensionHost）。

## 配置

| 配置 | 存储 |
|------|------|
| piPath / provider / model / extraArgs / trustProject | `piChat.*` 设置 |
| 显示选项（发送键/新建会话键/tab 切换键/聚焦输入框快捷键/工具显示模式/自动加载上次会话/会话结束提示音/收尾提醒等会话标题） | `globalState` |
| 网页服务（开关 / 端口 / 监听地址） | `piChat.webServer.*` 设置 |
| 派子会话（开关） | `piChat.taba.enabled` 设置 |
| 派子会话用的 pi 扩展文件、自带角色、子会话名录 | `~/.pi/pichat/`（插件激活时写；自带角色只在文件不存在时写；
名录在 `taba-runs/` 下，激活时清掉 7 天前的） |
| pi 的 models.json | `~/.pi/agent/models.json`（应用内设置面板编辑） |
| 通知的“应用标识”（想换成别的来源名/图标时用） | 环境变量 `PICHAT_TOAST_APPID`；PowerShell 路径可用 `PICHAT_POWERSHELL` 指定 |

## 在浏览器里对话

插件启动时会开一个本机网页服务，让你在浏览器里也能用同一套对话界面。

**怎么打开**：点状态栏左边的 `🌐 Pi Chat 网页`，或者命令面板里选 `Pi Chat: 在浏览器里打开对话`。
地址就是干干净净的 `http://机器地址:51883/`，不用带任何口令或参数，手机上一输就能开（也可以加个书签）。
地址同时会写进“输出”面板的 Pi Chat 频道，鼠标悬停在状态栏那项上也能看到，
`Pi Chat: 复制浏览器版访问地址` 可以把整条地址拷走。

**里面是什么**：和侧边栏完全同一份界面（同一个 chat.js / chat.css），能发消息、看工具卡片、
看本次改动的文件、开多个 tab、开分屏、看对话树与分支、读历史会话接着聊。
浏览器里那份是**独立的会话**：自己一个 pi 进程，与侧边栏、编辑器区互不干扰。

**那排功能按钮在哪**：顶部标签栏那一行的最右边有一颗“⋯”，分支 / 模型 / 历史会话 / 导出 /
设置都收在这个菜单里（VSCode 里这些在面板标题栏上，网页端没有标题栏）；点开是和
模型选择器同一套的浮层，可以打字筛选。标签栏在网页端常显，所以新建 tab 的“+”也一直
可见可点；底部原来那条按钮在网页端整条藏掉，省出一行竖向空间。

**网页端长什么样**：白底（浅色主题，按 VSCode 浅色主题的取值写的），输入框起步只占一行、
打字多了自己长高（最高不变）。这两样只改网页端：VSCode 里那份仍然跟随你的主题，
输入框仍然固定占约七行。想调的话就改 `media/browserTheme.css`（颜色、`--pichat-input-min-height`
那个起步高度、代码高亮那套颜色、标签栏与“⋯”按钮的样式都在里面）。

**刷新页面不会丢会话**：pi 进程一直在插件里跑，重连后把整屏重画一遍（会多一行“页面已重新连接”的提示）。
关掉页面也不会杀会话，重新打开还能接着用；关 VSCode 窗口（或重载窗口）时，网页服务和里面的 pi 进程一起结束。

**同时只让一个页面用这份会话**：再开一个页面，前一个会被顶掉并提示（点一下里面的“刷新页面”就接管回来）。
这样不会出现两个页面同时改同一份会话。

**哪些操作仍然发生在 VSCode 里**：点文件名打开文件、看改动前后的对比、回滚某次改动、跳符号，
以及导出会话时选保存位置；页面已经关掉时的确认框也会改在 VSCode 里弹。其余弹窗（确认 / 输入）
在浏览器里用浏览器自带的对话框。

**收尾提醒照常**：跑完一轮仍然弹 Windows 系统通知；提示音在页面里发，页面在后台时发不出声，
这种场景由系统通知补上（与侧边栏一致）。

**安全**：服务不问口令。现在拦人的只有两道：
1. 默认只监听 `127.0.0.1`（只有本机能访问）；
2. 不管监听在哪里，都查请求里的 Origin，所以你在浏览器里打开的**其他网站**里的脚本
   偿偿发请求给本服务（或者拿别的域名指到 127.0.0.1 来试探）都会被拒。

把 `piChat.webServer.host` 改成 `0.0.0.0` 就等于对同一网络里的所有设备开放：**那些设备只要知道地址，
就能读写这台机器的文件、运行命令**（背后是 pi，本来就能改文件跑命令）。
家里的 Wi-Fi 问题不大；笔记本带到公司、咖啡店、酒店那种公用网络就别开。
开放时日志里每次都写一条提醒，并把手机可用的地址列出来。不想开了就把 `host` 改回 `127.0.0.1`，
或者把 `enabled` 设成 `false`（服务关掉，状态栏入口也跟着隐藏）。

**用手机访问（三步）**：
1. 设置里把 `piChat.webServer.host` 改成 `0.0.0.0`（端口默认已是 51883，要换就改 `port`）；
2. 手机和电脑接同一个 Wi-Fi，在“输出”面板的 Pi Chat 频道里找到形如 `http://192.168.x.x:51883/` 的地址；
3. 手机浏览器里输这个地址。

如果手机连不上（一直转圈），十之八九是 **Windows 防火墙**在拦：
第一次对网络开放时系统会弹窗问要不要允许 VSCodium，得选“允许”；当前网络被 Windows 认成
“公用网络”时，入站默认是拦的，把网络改成“专用”或在防火墙里给 VSCodium 放行就行。

**已知差别**（浏览器里没有对应物，不影响对话）：
- 消息里把符号变成可点链接这件事靠 VSCode 的符号信息，浏览器页面拿不到，所以那种链接不出现；
- “把会话活体搬到编辑器 / 侧边栏”那个右键菜单在浏览器里没有（会话仍在自己那份里）；
- 右键“发送选中文本到对话框”是 VSCode 的能力，目标仍是侧边栏或编辑器那两份工作区，不会发到浏览器。

**相关配置**（都在 `piChat.webServer.*` 下）：

| 配置 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 插件启动时开网页服务。改成 `false` 就不监听端口，状态栏入口也隐藏 |
| `port` | `51883` | 监听端口。填 `0` 表示自动挑一个空闲端口；填的端口被占时（比如开了两个 VSCode 窗口）也会自动改挑，实际用的地址看状态栏提示 |
| `host` | `127.0.0.1` | 监听地址。改成 `0.0.0.0` 才能让手机等设备访问（见上面“安全”那段） |

## 会话引用（#）

输入框里打 `#` 会弹出候选列表：别的会话都在里面（侧边栏、编辑器区、浏览器那份互相都看得见），
可以引用单个会话，也可以引用整个 tab（分屏里几个就一起带上）。选中后输入框里出现一张卡片，发送时它变成消息里的一段文字。

**给的是记录文件的路径，不是对话全文**：早期版本会把被引用会话的整段对话转成文字塞进消息，会话越长消息越肥，
而且不管这轮用不用得上都占上下文。现在只给一小段指引：被引用会话的记录文件（`.jsonl`）在哪、多大，外加一句格式与读法说明
（JSON Lines、每行一条记录、别整读——可以先 grep 定位再用 read 分段读，或用 node / python 抽字段）。
模型需要细节时自己按需读，和下面派子会话里 `taba_peek` 的思路一致。

几条细节：

- 路径由被引用会话自己的 pi 进程报上来，写成 `C:/...` 的正斜杠形式，bash 和 read 都能直接用；
- 被引用的会话正在生成时，指引里会标“仍在持续追加”：pi 对这份文件即时追加写，模型读到的是它读取那一刻的内容；
- 引用整个 tab 时逐会话各给一行，行首是分屏里的会话名；卡片标题只标体积，不再数消息条数；
- 会话还没有记录文件（刚开还没跑过，或首轮还没落盘）时引用不了，会提示“所选会话暂无可引用的消息”。

## 派子会话（taba）

一个会话可以把活派给另一个会话：派出去的子会话在**新 tab** 里跑，
跑完第一轮后，它的最后一条回复会自动交回派活的那个会话，那个会话接着往下干。
派活不等结果：模型调完工具立刻拿到“已经派出去了”，可以继续做别的，也可以一次派好几个并行跑。

做法参考 [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)：
那边把子会话开在终端分屏里（要 tmux / cmux 那类工具），这边直接开在插件的 tab 里，
所以既不需要终端管理器，也不需要靠轮询文件猜子会话死没死——子进程的 RPC 事件本来就在插件手里。

**模型那边多四个工具**（名字用 `taba` 前缀，避开你全局装的那些扩展：重名的话 pi 会直接起不来）：

| 工具 | 干什么 |
|---|---|
| `taba` | 派一个子会话去干一件事，立刻返回不等结果 |
| `taba_list` | 列出可以指名的角色 |
| `taba_stop` | 停掉某个子会话正在跑的这一轮（它的 tab 还留着） |
| `taba_peek` | 看某个子会话现在的情况：状态、跑了多久、会话文件在哪、多大多少行、最后一条回复的开头一段 |

`taba` 的参数：`name`（显示名）与 `task`（任务说明）必填；`agent`（角色名）、`model`、`thinking`、
`tools`（工具白名单）、`cwd`（工作目录）、`fork`（带上派活那边的对话）都可选。
`taba_stop` 与 `taba_peek` 的参数都是 `id`（派活时返回的编号）或 `name`（显示名），至少给一个，
而且只能指定**本会话派出去的**那些。

**主对话里的 AI 想看子会话在干什么**，用 `taba_peek`。它不返回整段对话——只返回情况摘要加**那个子会话的
`.jsonl` 路径**，要看细节由 AI 自己拿 `read` / `bash` 去读（pi 是一条记录一行、即时追加写的，所以子会话还在跑
就能读到；返回里也带了文件多大、多少行，以及"别一次整个读进来，用 offset/limit 从末尾往上翻或者 grep 挑重点"的提醒）。

这条路要落地一份很小的名录文件，因为**路径只有插件知道**（全新会话的文件名是 pi 自己起的，带上下文那两档是插件
造的编号），而 pi 进程到插件只有 stderr 那条单向暗号、插件没法直接回话给工具。所以插件在子会话状态变化时
（派出去、任务发出、跑完交回、变成独立会话、tab 关掉）写一份：

```
~/.pi/pichat/taba-runs/<子会话编号>.json
{ v, id, name, task, agent, state, stateText, startedAt, endedAt, deliveries,
  sessionMode, sessionFile, parentSessionFile, lastReplyPreview, writtenAt }
```

`taba_peek` 读的就是它（按名字找时用 `parentSessionFile` 比对，别人的子会话读不到）。里面的
`lastReplyPreview` 是子会话最后一条回复的头 200 字：想知道"那边有结论没有"时看这一段就够，不必去读大文件。
子 tab 关掉以后名录与那个 `.jsonl` 都留着（状态写成 `tab 已经关闭`），事后还能查；插件激活时会清掉 7 天前的名录。

**插件这边怎么连起来的**：插件激活时把一个很小的 pi 扩展写到 `~/.pi/pichat/taba-bridge-<版本号>.ts`，
VSCode 这边的每个会话启动 pi 时都带上 `-e <那个文件>`（备用进程也带）。扩展的工具被调用时，
只往**它自己那个进程的 stderr** 写一行暗号：`##PICHAT_TABA##` 后面跟 base64 的 JSON。
插件本来就在读每个 pi 进程的 stderr，读到暗号就知道是哪个会话要派活、要派什么，于是开 tab、发任务。
所以不开端口、不用管道；结果交回也是插件直接对派活那个会话发 RPC 消息做的，不需要扩展参与。
子会话那个 tab **不加载**这个扩展，所以子会话不能再往下派；就算请求真冒出来了，插件也会挡下来。

**界面上看得到什么**：

- 子会话 tab 的名字就是派活时给的那个名字，左边一道竖线加一个 `↳` 标记；
  派活那边的 tab 上有个 `⇢N` 小标，N 是还在跑的子会话个数。鼠标悬在标记上能看到状态、模型、交回过几次。
- 右键子会话的 tab：把结果交回派活的会话 / 打开派活的那个会话 / 变成独立会话（不再自动交回）。
- 右键派活那边的 tab：列出它派出去的子会话，点一个就切过去。
- 派活与交回时，两边的对话里各有一行灰字提示（这些提示不进对话记录，只是界面上的一行）。
- tab 一多，tab 栏底下有一根细滑动条：滚轮落在栏上就是左右滚，切到屏幕外的 tab 会自动滚过去。

**几条规则**：

- 结果**自动交回只发生一次**：子会话把派给它的那一轮跑完就交；之后你在子会话 tab 里打字接管了就不再自动交，
  改由右键菜单里“把结果交回”手动触发。
- 子会话的 tab 一直留着，不自动关（要看全过程、要接着问都在那儿）。
- 派活那个会话被关掉了，子会话就变成独立会话，界面上写一句。
- 子会话的 tab 在结果交回之前被关掉，会给派活那个会话补一句“tab 被关掉了，没有交回结果”，免得那边一直等。
- 子会话跑完是报错还是被中止，结果照样交回（文字里写清楚是哪种），不然派活那边会一直等。
- 浏览器里那份会话不开这个功能（子会话要开在 VSCode 的 tab 里）。
- 整个功能可以在设置里关掉：`piChat.taba.enabled`（关掉后要新建会话才生效）。

**子会话的内容从哪来**（三种，叫法跟 pi-interactive-subagents 一致）：

| 模式 | 子会话看到什么 |
|---|---|
| `standalone`（默认） | 全新会话，只看到包装过的任务文本 |
| `lineage-only` | 全新会话，但会话文件里记着父会话是谁（翻历史会话能看出关系） |
| `fork` | 带上派活那个会话之前的对话 |

由派发方决定，优先级：派活时的 `fork: true` > 角色文件里的 `session-mode` > 全新会话。
带上下文那两档要先写一个会话文件出来（写在 pi 自己的会话目录里，格式跟 pi 一样：一行会话头 + 复制过来的记录，
截到派活那句之前），再用 `--session` 让 pi 打开它。派活的会话还没落盘时自动退回全新会话，界面上说一句。

**角色文件**（可选）：一个 `.md`，前置元数据 + 正文（正文就是这个角色的说明书，会交给子会话）。
按优先级找三个地方：项目 `.pi/agents/` > 全局 `~/.pi/agent/agents/` > 插件自带的。
插件自带四个，写在 `~/.pi/pichat/taba-roles/`：`scout`（只读摸底）、`worker`（施工，能改）、
`reviewer`（只读评审，只挑毛病）、`planner`（做计划，默认带上下文）。
自带的角色文件**只在不存在时才写**：你自己改过的不会被改回去；想让插件重写一遍，把那个目录删掉再重载窗口。

字段名跟 pi-interactive-subagents 那份保持一致，你已有的角色文件能直接用：

| 字段 | 说明 |
|---|---|
| `name` / `description` | 指名用的名字、一句话说明（`taba_list` 里显示） |
| `model` / `thinking` | 这个角色用什么模型、什么思考强度（拼成 `模型:强度`）；不写就跟着派活那个会话 |
| `tools` | 工具白名单，逗号分隔，例如 `read, bash`；不写就不限制 |
| `skills` | 要自动加载的技能名，逗号分隔；拼在任务文本最前面让 pi 自己展开 |
| `session-mode` | `standalone` / `lineage-only` / `fork` |
| `system-prompt` | `append`（加在默认提示词后面）或 `replace`（整个换掉）：正文改走系统提示词，不再跟任务一起发。不写就跟任务一起发 |
| `cwd` | 这个角色的工作目录（相对项目根或绝对路径） |
| `disable-model-invocation` | `true` 时不在 `taba_list` 里显示，但指名仍能派 |

认不出的字段一律忽略；写了 `runner:`（那是给外部命令行工具用的角色）的文件会被跳过，我们的 tab 只能跑 pi。

顺带修掉的一个坑：Windows 下插件是带 shell 启动 pi 的，而 Node 在 `shell: true` 时**不给参数加引号**，
只是用空格拼起来，所以带空格的路径（比如用户名是 `John Doe` 时的家目录）会被切成两半。
现在带空格的参数会自己引起来（`quoteArgForWindowsShell`，有单测）。

## 会话跑完的提醒

提醒里显示的会话名优先用 **pi 自己给的会话标题**（自动命名扩展生成的那种，如“上传插件到 GitHub”），
它才说得出这次干了什么；还没有标题时（第一轮刚跑完、或没装自动命名扩展）才退回
tab 栏上那个随机名（“沉静的雪豹”）。
标题靠 pi 推的 `session_info_changed` 事件、以及加会话时从 `get_state` 的 `sessionName` 读。
因为自动命名扩展要在本轮跑完后额外问一次模型才能出标题（慢一两秒），所以提醒会
最多等它 **3 秒**（“显示选项 → 收尾提醒等会话标题”可改成不等 / 1 / 3 / 5 / 10 秒）；
等不到就用随机名兜底，提醒一定发得出去。提示音不等，照常立刻响。

任何 session（侧边栏的、编辑器区各工作区的，包括没在前台的 tab）跑完一轮，都会：

1. 弹一条 Windows 系统通知（屏幕右下角卡片）。卡片第一行是会话标题（没标题时是会话显示名）
   加上这一轮的结果，第二行是本轮 AI 回复的首尾句摘要（最多约 80 字，取不到就不显示；
   中止时写“用户中止”）；本轮出错时附上错误摘要。
   卡片在右下角停约 7 秒（系统默认）后收进通知中心，60 秒后连通知中心里的记录一起消失，
   不用你自己去清（失效秒数在 `toastScript.ts` 的 `TOAST_EXPIRE_SECONDS` 里改）。
   通知走 PowerShell 调 Windows 自带的通知接口，插件不加任何第三方依赖。
   每发一批通知，那个 PowerShell 进程会多活约 70 秒才退（失效时间是系统在它身上执行的，
   它退早了通知就一直留在通知中心里）；不发通知时没有常驻进程。
2. 在 VS Code 界面里出一条提示（会话名同样优先用会话标题）；
   窗口不在前台时它还会让 Windows 闪烁任务栏图标。
3. 界面可见时响一声提示音（880Hz 短音）；多个会话几乎同时跑完只响一声。
   提示音可在“显示选项 → 会话结束提示音”里关掉，系统通知不受这个开关影响。

提示音放在网页视图里发是为了不加依赖；网页视图被隐藏或窗口切到后台时它发不出声，
这种场景由上面的系统通知与任务栏闪烁补上。

注：中止（Esc）的一轮不算“任务完成”，通知改写“已中止”（提示音照旧）。

## 改前端注意事项

- 改对话前端（`media/chat.js` / `chat.css` 等）后：重新 `npm run build` 即可生效。这是唯一的对话前端真源，
  VSCode 里的网页视图与浏览器那份页面用的是同一份（浏览器只多两个文件：`browserBridge.js` 接消息通道、
  `browserTheme.css` 补颜色）。改 `chat.js` 时记住它两边都跑：不能直接用只有 VSCode 网页视图里才有的东西（
  比如新的 `vscode.xxx` 调用），需要时先问浏览器桥能不能给。
- 浏览器那份页面给插件发的消息（`openHistory` / `openSettingsPanel` / `exportConversation` / `browserDialogResult`）
  只有 `browserChatController.ts` 认；改那边时两边对着改。
- 改 `src/*` 后：同上，编译时自动引用最新源码。
- 前端资源被 vsce 自动打包进插件（见 `.vscodeignore`）。

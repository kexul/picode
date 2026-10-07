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
media/                        对话前端资源（chat.js、chat.css、historyCanvas.js/css、
                              marked.js、highlight.js、settings.js）；webview 直接加载
                              browserBridge.js / browserTheme.css 只有浏览器那份页面用
```

## 环境要求

- Node.js 20+
- npm（自带）
- pi 已全局安装并鉴权（`npm i -g --ignore-scripts @earendil-works/pi-coding-agent`，再 `pi` + `/login`，或设置 API Key 环境变量）

## 一键构建

双击或命令行运行：

```bat
build.bat           # npm install + 打包 + 自动安装到 VSCode 并重载窗口
build.bat skip      # 跳过 npm install（已装好时用，更快）
build.bat noauto    # 只打包 vsix，不自动安装/重载
```

> 默认构建完会自动 `code --install-extension` 并触发窗口重载（首次安装时可能需手动 Reload Window 一次）；不想自动部署时加 `noauto`。

产物：
- `pi-chat-*.vsix`（VSCode 插件，自包含约 115KB）

## 开发

```bash
npm install
npm run build    # tsc 编译到 out/
npm test         # 编译 + node:test（会话逻辑纯函数；以及网页服务的传输与端到端检查）
npm run package  # 打包 VSIX
```

VSCode 里 F5 直接调试（`.vscode/launch.json` 已配置 extensionHost）。

## 配置

| 配置 | 存储 |
|------|------|
| piPath / provider / model / extraArgs / trustProject | `piChat.*` 设置 |
| 显示选项（发送键/新建会话键/tab 切换键/聚焦输入框快捷键/工具显示模式/自动加载上次会话/会话结束提示音/收尾提醒等会话标题） | `globalState` |
| 网页服务（开关 / 端口 / 监听地址） | `piChat.webServer.*` 设置 |
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

# Pi Chat 插件（pi-chat-vscode）

在 VS Code 里跟 pi coding agent 对话的插件：侧边栏一份会话，浏览器页面接在同一份会话上。

- 目录结构与模块划分：见 `README.md`
- 用户能用的功能与配置：见 `README.md`
- 打包与安装：见 `README.md`

## 改代码时的规矩

- 需求存在歧义时，先给出理解和备选方案，等确认后再改代码。
- 用平白简单的话说事，不用自造的说法，不主动简写。
- 注释用中文，写"为什么这么做"，不写"这行在干什么"。

## 两块东西是怎么分工的（第二步之后）

**会话只有一份，跑在独立后端（pichat）里**：标签、pi 进程、历史会话、项目 / 会话面板、网页服务
都在它那边。VSCode 插件是它的客户端，只剩两件事：一屏界面（侧边栏网页视图）和一双能打开文件的手。

后端这一摊（都在 `serverChatHost.ts` 这条线上）：

```
chatControllerBase.ts   会话编排（标签、会话进程、消息分发）
      ↓
chatHostBase.ts         后端那份宿主基类：页面通道与补发、浮层路由、显示选项、
                        项目 / 文件夹拾取器、"屏"的登记与派活
      ↓
serverChatHost.ts       后端自己的那点事：设置读 config.json、弹窗只问页面、只发系统通知
```

插件这一摊（不继承上面那两个基类，自己一条线）：

```
chatViewProvider.ts     一屏界面：给 BackendClient 当出入口、装界面 HTML、命令入口
      ↓
backendClient.ts        与后端的两条流：页面流（/events + /api，原样转发界面的消息）、
                        屏流（/screen + /screenapi，接后端派的活）；断线自己重连
      ↓
vscodeScreen.ts         只有编辑器干得了的活：按会话目录打开文件、找符号、
                        报编辑器里打开着的文件、算符号表
```

**"屏"与派活的规矩**：窗口连上后端时登记自己打开着哪些文件夹（`screenRegistry.ts`）；
后端要"用编辑器打开这个文件"时，按会话目录挑一个窗口——**只挑打开着这个目录的窗口**
（相等或它落在窗口打开的文件夹里），一个都没有就什么都不做（日志写一行），
同一个目录开着好几个窗口时挑最近在用的那个。界面里点文件名 / 定位 / 符号、
界面上 # 引用里的"编辑器打开着的文件"都走这条路：`chatHostBase.ts` 的
`routeToScreen` / `sendFileList` / `onKnownFilesChangedByHost`（往窗口推"会话动过哪些文件"，
窗口拿它算符号表）与 `vscodeScreen.ts` 的 `handle`。

**页面的消息插件一个字都不改**：界面还是那套 `postMessage`（`chat.js` 感觉不到自己连的是后端），
插件把消息原样转给后端 `/api`，后端推的消息（`/events`）原样转回界面。页面标识是插件
连上后端时现领的（`{type:"newPage"}` → `{pageId}`），重连会再领一个并报一次账（补发对齐）。

**每个会话有自己的工作目录**（1.5 加的）：源是 `SessionRuntime.cwd`（= `launch.cwd` 或宿主默认目录），
`host.getCwd()` 只是“宿主默认目录”。历史列表、文件相对路径、派子会话的默认目录、
标签上的目录后缀都看 `runtime.cwd`；新增代码如果需要“现在这个会话在哪个目录”，
拿 `this.getActive()?.cwd`，别用 `this.getCwd()`。切到别的项目的会话要按那个目录起进程
（pi 的 `switch_session` 不换工作目录）：走 `loadHistorySession(file, folder)` /
`newSessionInDir(dir)`，它们会带 `launch.cwd` 并且不领备用进程（备用进程是按默认目录起的）。
项目 / 文件夹两个浮层的流程在 `chatHostBase.ts`（`showWorkspacePicker` / `switchWorkspacePanel` /`showFolderPicker`），
“项目与会话”面板是一个浮层（kind `workspace`）里上下两块：上面会话、下面工作区；
点工作区走 `workspacePick` 消息就地刷新上面那块（不关面板），点会话走 `pickerChoice`（关面板切过去），
清单来自 `sessionStore.listProjects()` 与 `dirBrowse.listDirectories()`。
网页端 / 侧边栏右上角那颗“三根尖角”（`<<<`）发的是 `openWorkspace`（项目与会话面板），不是 `openHistory`；
图标是手画的（codicon 里没有三层尖括号），在 `media/browserBridge.js` 的 `ICON_MENU_LEFT`。

不带工具依赖的部分用 `dev/` 那套调试工具验：把 `vscode` 这个模块换成假的（`dev/fakeVscode.js`），
其余全是真的 —— 真会话编排、真 pi 进程、真网页服务、真界面文件。于是真插件就能在纯 Node 里跑起来，
用浏览器打开它给的那个地址，看到的就是真界面。

```bash
npm run web:shot                                    # 开无头浏览器打开界面、等就绪、截图
npm run web:shot -- --send "你好" --wait-answer 你好 --shot reply.png   # 发消息、等回复、截图
npm run web:dev                                     # 起后端常驻，自己用浏览器打开看（Ctrl+C 退出）
npm run web:shot -- --headed --keep                 # 显示窗口、跑完不关，自己接着点
```

截图落在 `dev/shots/`（不进版本库），可以用看图工具直接打开，也可以让 AI 自己读图判断。

**改完界面的标准动作**：改 `media/` 或 `src/` → `npm run web:shot -- 动作…` → 看 `dev/shots/` 里的图。
不用等别人装插件再回来告诉你结果。

几条必须知道的：

- **会话跑在 `dev/.scratch/`**（调试专用目录，自动建，不进版本库）。别把 `--cwd` 指到插件仓库本身，
  不然调试时模型会改到真代码。
- **等状态栏显示模型名以后再发消息**：刚打开的一两秒界面已经能打字，但会话进程还没就绪，
  这时候发出去的会丢（`web:shot` 自己会等）。
- **验不到的**：diff 编辑器、符号跳转、系统通知、剪贴板、命令面板入口、状态栏、
  侧边栏网页视图本身，以及"插件连后端 + 后端派活给窗口"这整条路（它要真 VSCode 才算数）。
  这些用 VS Code / VSCodium 的 F5 开发宿主看（`.vscode/launch.json` 已配好），或者打包装 vsix 后
  Reload Window 看。`dev/` 那套假 VSCode 只覆盖到后端那一侧（会话、网页服务、界面文件）。
- **后端那一侧的能力路由能单测**：假后端 + 真 `BackendClient` 见 `backendClient.test.ts`，
  屏登记簿见 `screenRegistry.test.ts`。改派活规矩先改这两条。
  （网页服务本身那几条测试删掉了，那层靠 `dev/` 那套调试工具验。）
- 详细用法和参数：`dev/README.md`，或 `npm run web:shot -- --help`。
- 需要 Node 22 以上；浏览器用本机的 Chrome 或 Edge（自动找，也能用 `--chrome` 指定）。

单元测试与类型检查：`npm test`（编译 + `node:test`，不启动 pi；只留了浏览器验不到的那几类：
网页服务安全校验、派子会话协议与启动参数、派活规矩，其余靠 `dev/` 那套调试工具验）。

**独立后端（pichat）怎么验**：它自己就是纯 Node，不用假 VSCode 也能跑：

```bash
npm run server                              # 直接用当前目录当会话目录起一个（Ctrl+C 退出）
npm run web:shot -- --url http://127.0.0.1:51883/ --send "你好" --wait-answer 你好 --shot server.png
```

第二条是连到一个已经在跑的后端去驱动界面（`--url` 认任意地址，包括独立后端）。
调试时把 `PICHAT_HOME` 指到一个临时目录，就不会动到你自己 `~/.pi/pichat/` 里的设置与地址文件：

```bash
PICHAT_HOME=/tmp/pichat-test npm run server -- --cwd /tmp/pichat-test/work --port 0
```

（`npm run server` 会把参数转给启动器；`--port 0` = 自动挑空闲端口。
地址、日志、单实例冲突都会打在屏幕上。）

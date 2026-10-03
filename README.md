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
media/                        对话前端资源（chat.js、chat.css、historyCanvas.js/css、
                              marked.js、highlight.js、settings.js）；webview 直接加载
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
npm test         # 编译 + node:test（messageUtils / piRpc 纯逻辑）
npm run package  # 打包 VSIX
```

VSCode 里 F5 直接调试（`.vscode/launch.json` 已配置 extensionHost）。

## 配置

| 配置 | 存储 |
|------|------|
| piPath / provider / model / extraArgs / trustProject | `piChat.*` 设置 |
| 显示选项（发送键/新建会话键/tab 切换键/聚焦输入框快捷键/工具显示模式/自动加载上次会话/会话结束提示音/收尾提醒等会话标题） | `globalState` |
| pi 的 models.json | `~/.pi/agent/models.json`（应用内设置面板编辑） |
| 通知的“应用标识”（想换成别的来源名/图标时用） | 环境变量 `PICHAT_TOAST_APPID`；PowerShell 路径可用 `PICHAT_POWERSHELL` 指定 |

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
   加上这一轮的结果，第二行是改动文件数 / 累计花费；本轮出错时写“本轮出错结束”。
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

- 改对话前端（`media/chat.js` / `chat.css` 等）后：重新 `npm run build` 即可生效。这是唯一的对话前端真源。
- 改 `src/*` 后：同上，编译时自动引用最新源码。
- 前端资源被 vsce 自动打包进插件（见 `.vscodeignore`）。

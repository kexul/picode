# Pi Chat

与 [pi coding agent](https://pi.dev) 对话的 **VSCode 插件**：在 VSCode 侧边栏对话。

## 结构

根目录即插件（标准 VSCode 扩展布局）：

```
src/                          插件 TypeScript 源码（tsc 编译到 out/）
  extension.ts                 入口：注册命令、webview view、diff 文档 provider
  chatViewProvider.ts          聊天视图提供者（webview 装载、vscode API、会话编排宿主）
  chatHtml.ts                  webview HTML：注入 VSCode 特有的 URI 解析 / CSP / chat.css
  renderHtml.ts                聊天界面 HTML 骨架生成（renderHTML()）
  piClient.ts                  pi --mode rpc 客户端（JSONL 协议；统一 request/pending）
  piRpc.ts                     RPC 命令/响应轻量类型与辅助函数
  runtimeTypes.ts              PiConfig / RuntimeHost / FileChange 等共享类型
  messageUtils.ts              消息/工具结果/对话树纯函数（可单测）
  editTracker.ts               工具卡片 + edit 快照/回滚/knownFiles
  sessionRuntime.ts            单个对话 tab 的运行时（独立 pi 进程 + 会话编排）
  chatControllerBase.ts        会话编排基类（标签管理含 tabList 节流、拾取器、模型选择）
  sessionStore.ts              pi 会话文件的扫描 / 读取 / 元数据
  modelsConfig.ts              models.json 读写与内置默认模板
media/                        对话前端资源（chat.js、chat.css、marked.js、highlight.js、
                              settings.js）；webview 直接加载，无需拷贝
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
| 显示选项（发送键/新建会话键/tab 切换键/工具显示模式/自动加载上次会话） | globalState |
| pi 的 models.json | `~/.pi/agent/models.json`（应用内设置面板编辑） |

## 改前端注意事项

- 改对话前端（`media/chat.js` / `chat.css` 等）后：重新 `npm run build` 即可生效。这是唯一的对话前端真源。
- 改 `src/*` 后：同上，编译时自动引用最新源码。
- 前端资源被 vsce 自动打包进插件（见 `.vscodeignore`）。

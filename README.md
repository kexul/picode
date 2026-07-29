# Pi Chat 0.0.3

与 [pi coding agent](https://pi.dev) 对话的客户端。两种形态共用一套对话前端：

- **VSCode 插件**（`apps/vscode`）：在 VSCode 侧边栏对话
- **Electron 桌面客户端**（`apps/electron`）：独立应用，核心诉求是可自由切换项目

## 结构

单仓库 + 共用源码目录。

```
src/                          共用源码（一份，两边编译引用）
  shared/                       piClient.ts、sessionStore.ts、modelsConfig.ts
  chat-ui/
    index.ts                    renderHTML() —— 生成聊天界面 HTML
    assets/                     chat.js、chat.css、marked.js、highlight.js、
                                default-models.json、settings.js

apps/
  vscode/                     VSCode 插件
    src/                         插件源码，import 用相对路径 ../../../src/{shared,chat-ui}
    media/                       build 时从 src/chat-ui/assets 拷入（webview 加载）
    scripts/copy-assets.js       拷 assets → media
    tsconfig.json
    package.json
  electron/                   Electron 客户端
    src/                         主进程源码，import 用相对路径 ../../../src/shared
    renderer/                    Electron 专属前端：app.js、app.css、viewer.html
    scripts/copy-assets.js       tsc 后拷 renderer 源 + chat-ui 资源 + 生成 index.html 到 out/
    tsconfig.json
    package.json
```

两个 app 各自独立，分别 `npm install`。共用源码 `src/` 不是包，靠相对路径 import，无 workspace。

## 环境要求

- Node.js 20+
- npm（自带）
- pi 已全局安装并鉴权（`npm i -g --ignore-scripts @earendil-works/pi-coding-agent`，再 `pi` + `/login`，或设置 API Key 环境变量）

## 一键构建

双击或命令行运行：

```bat
build.bat           # 含 npm install，产出 vsix + exe
build.bat skip      # 跳过依赖安装（已装好时用，更快）
```

产物：
- `apps\vscode\pi-chat-*.vsix`（VSCode 插件，自包含约 84KB）
- `apps\electron\dist\Pi Chat Setup *.exe`（Electron 安装包，约 78MB）

## 开发

```bash
# VSCode 插件
cd apps/vscode && npm install
npm run build    # copy-assets + tsc
npm run package  # 打包 VSIX

# Electron 客户端
cd apps/electron && npm install
npm run build    # tsc + copy-assets（生成 index.html）
npm start        # 启动
npm run dist     # electron-builder 打安装包
```

## 配置

| 配置 | VSCode | Electron |
|------|--------|----------|
| piPath / provider / model / extraArgs / trustProject | `piChat.*` 设置 | `~/.pi/chat-client/config.json` |
| 最近项目列表 | — | `~/.pi/chat-client/config.json` 的 `recentProjects` |
| 显示选项（状态栏/发送键/自动加载） | globalState | `~/.pi/chat-client/config.json` 的 `view` |
| pi 的 models.json | `~/.pi/agent/models.json`（应用内设置面板编辑） | 同左 |


## 改前端注意事项

- 改 `src/chat-ui/assets/chat.js` 或 `chat.css` 后：两边都要重新 `npm run build`（在各自 apps/{vscode,electron} 下）才生效。
- 改 `src/shared/*` 后：同上，编译时自动引用最新源码。
- Electron 专属（应用栏、modal、文件查看器）在 `apps/electron/renderer/`（app.js/app.css/viewer.html）。
- VSCode 专属（历史面板、设置面板、活动栏菜单）在 `apps/vscode/src/`（historyPanel/settingsPanel/extension）。

# Pi Chat

与 [pi coding agent](https://pi.dev) 对话的客户端。两种形态共用一套对话前端：

- **VSCode 插件**（`apps/vscode`）：在 VSCode 侧边栏对话
- **Electron 桌面客户端**（`apps/electron`）：独立应用，核心诉求是可自由切换项目

## 结构

单仓库 + 共用源码目录。

```
src/                          共用源码（一份，两边编译引用）
  shared/                       piClient.ts、sessionStore.ts、modelsConfig.ts
  chat-ui/
    index.ts                    renderHTML() —— 生成聊天界面 HTML 骨架

apps/
  vscode/                     VSCode 插件
    src/                         插件源码，import 用相对路径 ../../../src/{shared,chat-ui}
    media/                       对话前端资源单一真源（chat.js、chat.css、marked.js、
                                highlight.js、default-models.json、settings.js）；
                                webview 直接加载，无需拷贝
    tsconfig.json
    package.json
  electron/                   Electron 客户端
    src/                         主进程源码，import 用相对路径 ../../../src/shared
    renderer/                    Electron 专属前端：app.js、app.css、viewer.html
    scripts/copy-assets.js       tsc 后拷 renderer 专属源 + 从 apps/vscode/media 拷共用
                                前端资源 + 用 renderHTML() 生成 index.html，统一输出到 out/.../renderer/
    tsconfig.json
    package.json
```

两个 app 各自独立，分别 `npm install`。共用源码 `src/` 不是包，靠相对路径 import，无 workspace。

### 对话前端资源的单一真源

`apps/vscode/media` 是对话前端资源（chat.js / chat.css / marked.js / highlight.js /
default-models.json / settings.js）的**唯一真源**，切勿在 `apps/electron/renderer/` 下重复维护：

- **VSCode 插件**：webview 直接加载 `apps/vscode/media` 下的资源，无需拷贝。
- **Electron 客户端**：`apps/electron/scripts/copy-assets.js` 在 build 时从
  `apps/vscode/media` 把这些资源拷到 `out/.../renderer/`，再用 `renderHTML()` 生成
  `index.html`（`chat.css` 以文本形式内联进 `<style>`）。

`apps/electron/renderer/` 只保留 Electron 专属文件：`app.js`（应用栏逻辑）、`app.css`、
`viewer.html`（文件查看器）。改动对话前端只需改 `apps/vscode/media` 一处，两边重新
build 即可生效。

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

- 改对话前端（`apps/vscode/media/chat.js` / `chat.css` 等）后：两边都要重新 `npm run build`（在各自 `apps/{vscode,electron}` 下）才生效。这是唯一的对话前端真源，**不要**在 `apps/electron/renderer/` 下改同名文件。
- 改 `src/shared/*` 后：同上，编译时自动引用最新源码。
- Electron 专属（应用栏、modal、文件查看器）在 `apps/electron/renderer/`（`app.js` / `app.css` / `viewer.html`）。
- VSCode 专属（历史面板、设置面板、活动栏菜单）在 `apps/vscode/src/`（historyPanel/settingsPanel/extension）。

## Electron 客户端相对 VSCode 插件的差异

- ✅ 独立运行，**可切换多个项目**
- ✅ pi 进程、JSONL 协议、流式/thinking/工具调用/markdown/分支树/会话历史/模型切换/回滚 —— 全部保留
- ✅ `@ 引用文件`：扫描当前项目文件树（跳过 node_modules 等）
- ✅ edit 卡片跳转：内置简易文件查看器（只读 + 语法高亮 + 跳行）
- ❌ 砍掉：diff 前后对比视图（「修改文件列表」点击改为打开文件查看器）
- ❌ 砍掉：编辑器选中文本发送（无内置编辑器）
- ❌ 砍掉：`@ 引用 VSCode 已打开的文件`（概念不存在）

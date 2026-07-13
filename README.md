# Pi Chat — VSCode 插件

在 VSCode 中通过对话窗口与 [pi coding agent](https://pi.dev) 进行对话。

插件通过 `pi --mode rpc` 启动 pi 子进程，使用 JSONL 协议进行通信，
在侧边栏的 Webview 对话窗口中流式显示 pi 的回复。

## 功能

- 侧边栏活动栏中的 **Pi Chat** 对话面板
- 流式显示 assistant 回复、thinking 过程和工具调用
- **Markdown 渲染**：代码块、行内代码、标题、列表、引用、链接、粗斜体等
- **代码块语法高亮**：内置轻量高亮器，为关键字/字符串/注释/数字/函数着色，并显示语言标签
- **图片粘贴**：在输入框粘贴图片（Ctrl+V）即可预览并随消息发送给 pi
- **模型切换**：输入框下方的 ⚡ 按钮可快速切换 pi 模型（读取 models.json 中的可用模型）
- **@ 引用文件**：输入 `@` 可从 VSCode 当前打开的文件中选择引用（↑↓ 选择，Enter/Tab 确认）
- **状态栏**：输入框上方显示 ↑输入 / ↓输出 token、R 缓存读取、W 缓存写入、成本、上下文使用百分比（每次对话结束后刷新）
- **历史会话**：从 pi 会话目录加载当前工作区的历史会话并重建对话
- 支持中止生成、新建会话
- 处理 pi extension 的 confirm / select / input 交互（转为 VSCode 原生对话框）

## 前置要求

需先全局安装 pi 并可在 PATH 中调用：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

并完成鉴权（`pi` 后 `/login`，或设置 `ANTHROPIC_API_KEY` 等环境变量）。

## 开发运行

```bash
npm install
npm run compile
```

然后在 VSCode 中按 `F5`（运行「运行插件」配置）打开扩展开发宿主窗口。
在新窗口左侧活动栏点击 **Pi Chat** 图标即可开始对话。

## 配置项

| 配置 | 说明 |
|------|------|
| `piChat.piPath` | pi 可执行文件路径，默认 `pi` |
| `piChat.provider` | LLM provider（如 anthropic、openai），留空用 pi 默认 |
| `piChat.model` | 模型 pattern/ID（如 sonnet、gpt-4o），留空用 pi 默认 |
| `piChat.extraArgs` | 传给 `pi --mode rpc` 的额外参数 |

## 命令

- **Pi Chat: 打开对话窗口** — 打开并聚焦对话面板
- **Pi Chat: 新建会话** — 清空并开始新会话（面板标题栏的 + 按钮）
- **Pi Chat: 历史会话** — 选择并加载当前工作区的历史会话（面板标题栏的历史图标）
- **Pi Chat: 设置（编辑 models.json）** — 打开编辑器修改 pi 的 `~/.pi/agent/models.json`（面板标题栏的齿轮图标）。文件不存在时提供默认模板，保存时自动创建；内置 JSON 实时校验、一键格式化、Ctrl+S 保存。

## 工作目录

pi 进程以当前工作区第一个文件夹作为 cwd，因此 pi 的文件读写工具作用于你打开的项目。

## 打包与迁移到其他电脑

### 打包为 .vsix

```bash
npm install
npm run compile
npx vsce package --allow-missing-repository
```

生成 `pi-chat-0.0.1.vsix`（自包含，不需 node_modules）。

### 在新电脑上安装

1. **安装插件**：VSCode 中 `Ctrl+Shift+P` → `Extensions: Install from VSIX...` → 选择 `.vsix`；
   或命令行：`code --install-extension pi-chat-0.0.1.vsix`

2. **安装并鉴权 pi**（插件只是调用 pi，这一步必须做）：
   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   pi        # 然后 /login 选择 provider（推荐，鉴权信息存在 ~/.pi/agent/）
   ```
   或设置 API Key 环境变量（如 ANTHROPIC_API_KEY）。

3. **确保 pi 在 PATH 中**。若不在，在 VSCode 设置里把 `piChat.piPath` 改为 pi 可执行文件完整路径，例如：
   ```json
   { "piChat.piPath": "C:\Users\你的用户名\AppData\Roaming\npm\pi.cmd" }
   ```

### 关于环境变量鉴权（重要）

插件通过子进程启动 pi，并继承启动 VSCode 时的环境变量。因此：
- 若用 **API Key** 方式，VSCode 必须能看到该环境变量。Windows 上设为用户环境变量后需**重启 VSCode**；从终端 `code .` 启动可继承当前 shell 变量。
- 若用 **`/login` 订阅** 方式，鉴权信息存在 `~/.pi/agent/`，不依赖环境变量，**更省心，推荐**。

### 不需要做的

- 插件未硬编码任何绝对路径，无需修改代码
- `.vsix` 自包含，无需在目标机器 `npm install`
- 会话目录位置自动适配（遵循 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`，默认 `~/.pi/agent`）

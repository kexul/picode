# Pi Chat

与 [pi coding agent](https://pi.dev) 对话的 **VSCode 插件**：在 VSCode 侧边栏对话，也能用浏览器（手机）打开同一份会话。

会话跑在独立后端（pichat）里，VSCode 插件和浏览器页面都是它的客户端，两边看的是同一份会话。

## 环境要求

- Node.js 20+
- pi 已全局安装并鉴权（`npm i -g --ignore-scripts @earendil-works/pi-coding-agent`，再 `pi` + `/login`）

## 安装

```bash
build.bat               # npm install + 编译 + 打包 vsix + 装全局 pichat 命令
```

build.bat 不会把插件装进编辑器，要自己装（版本号换成实际的），装完重载窗口（命令面板 → `Developer: Reload Window`）才生效：

```bat
codium --install-extension pi-chat-vscode-0.1.0.vsix   :: VSCodium
code --install-extension pi-chat-vscode-0.1.0.vsix     :: VSCode
```

重载窗口会把所有正在跑的 pi 进程一起结束，有活在跑的时候别急着重载。

## 使用

- **侧边栏**：装好插件后侧边栏就有 Pi Chat 面板，直接对话。
- **浏览器 / 手机**：终端里敲 `pichat`，它会打出地址（形如 `http://192.168.x.x:51883/`），浏览器打开就能对话；VSCode 状态栏的 `🌐 Pi Chat` 也指向同一地址。VSCode 关掉后端照常跑。
  - `pichat --cwd 目录` 指定会话目录；`--host 127.0.0.1` 只给自己用；`--help` 看全部参数。
  - 默认监听 `0.0.0.0`：同一网络里的设备知道地址就能用（背后是 pi，能改文件跑命令），公用网络注意收起来。
- **项目与会话面板**：顶部标签栏右侧的 `<<<` 按钮，里面能切历史会话、切工作区目录、开设置。
- **设置**：`~/.pi/pichat/config.json`（pi 路径、模型、端口等，重启后端生效）；界面颜色、字号这些在界面的设置浮层里改。
- **派子会话**：模型可以把活派给另一个会话（新 tab 里跑，跑完自动交回）；不想用就在 config.json 里把 `tabaEnabled` 设为 `false`。

## 开发

```bash
npm test          # 编译 + 单元测试
npm run web:dev   # 起后端常驻，浏览器打开看界面
```

E2E 验证工具见 `AGENTS.md` 与 `dev/README.md`。

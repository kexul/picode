# Pi Chat 插件（pi-chat-vscode）

在 VS Code 里跟 pi coding agent 对话的插件：侧边栏一份会话，浏览器页面接在同一份会话上。

- 目录结构与模块划分：见 `README.md`
- 用户能用的功能与配置：见 `README.md`
- 打包与安装：见 `README.md`

## 改代码时的规矩

- 需求存在歧义时，先给出理解和备选方案，等确认后再改代码。
- 用平白简单的话说事，不用自造的说法，不主动简写。
- 注释用中文，写"为什么这么做"，不写"这行在干什么"。

## 改完代码怎么验（不用装插件、不用开 VS Code）

插件里真正调用 VS Code 的只有 `chatViewProvider.ts` 那一层皮。`dev/` 下有一套调试工具：
把 `vscode` 这个模块换成假的（`dev/fakeVscode.js`），其余全是真的 —— 真会话编排、
真 pi 进程、真网页服务、真界面文件。于是真插件就能在纯 Node 里跑起来，
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
  侧边栏网页视图本身。这些用 VS Code / VSCodium 的 F5 开发宿主看（`.vscode/launch.json` 已配好）。
- 详细用法和参数：`dev/README.md`，或 `npm run web:shot -- --help`。
- 需要 Node 22 以上；浏览器用本机的 Chrome 或 Edge（自动找，也能用 `--chrome` 指定）。

单元测试与类型检查：`npm test`（编译 + `node:test`，不启动 pi）。

## 已知的小毛病

- （已修）会话还没就绪时按回车：现在把这次回车记下来，字留在输入框里，等 `piReady`
  变真时自动补发一次（`media/chat.js` 的 `pendingAutoSend` / `flushPendingSend`）。
- （已修）页面刚打开、tab 还没建好时打的字，会在 tab 出现那一刻被空草稿冲掉（草稿按 tab 存，
  切到新 tab 时加载了空的那份）。现在切换前先把输入区搬给新 tab（`carryComposerToTab`），
  另外 `applyPanelMessage` 的“安全网”也不再碰输入框。
- 一个容易误会的事实（改之前要心里有数）：`piReady` 是在 **pi 进程刚 spawn 出来**就置真的
  （`sessionRuntime.ts` 的 `startClient`：`client.start()` 后紧跟着 `setPiReady(true)`），
  不代表 pi 已经能收消息。所以“没就绪”的窗口实际上只有页面刚打开的头一两百毫秒。
  要让“就绪”真正反映 pi 能干活，得改成等 pi 的 RPC 握手完成再置真（没做，改动在会话层，慎动）。
- 只见过一次、后来反复试都没再现的现象：输入框被清空了，但对话里既没有自己那条气泡、
  也没有回复。见到时用的是刚写好的调试脚本（那时脚本自己还出过参数转义的乱子），怀疑是页面
  刚连上推送流那刻的重画。以后再碰到，用 `npm run web:shot -- --skip-ready` 配合探针查，
  并注意：无头浏览器在页面刚加载的那几百毫秒里有时会把按键事件丢掉（探针自己的坑，不是插件的）。

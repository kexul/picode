# Pi Chat 插件（pi-chat-vscode）

## 叫法

说话、写注释、写文档用词以根目录 `GLOSSARY.md` 为准：插件、对话面板、浏览器页面、侧边栏
（左边「文件侧边栏」、右边「项目与会话侧边栏」）、文件链接这些词都在那儿定。
那儿标了「别这么叫」的词别用；缺词就往那儿加，别在别处另起一套。

## 改代码时的尺子

- **保持简洁，如无必要勿增实体。** 加新文件、新的一层、新抽象之前，先说清它换来什么；
  能并成一处、能删掉的排在前面。说不出「改完比现在少什么」的，先别做。

## E2E 验证（dev/ 那套调试工具）

不带编辑器依赖的部分用 `dev/` 那套调试工具验：把 `vscode` 这个模块换成假的（`dev/fakeVscode.js`），
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
- **等顶条那颗圆环亮起来（`#ctxIcon` 的 `data-st` 变成 idle）以后再发消息**：刚打开的一两秒界面已经能打字，但会话进程还没就绪，
  这时候发出去的会丢（`web:shot` 自己会等）。
- **验不到的**：diff 编辑器、符号跳转、剪贴板、命令面板入口、状态栏、
  插件里那块对话面板本身（活动栏面板的网页视图），以及"插件连后端 + 后端派活给窗口"这整条路
  （它要真 VSCode 才算数）。
  这些用 VS Code / VSCodium 的 F5 开发宿主看（`.vscode/launch.json` 已配好）。
- 详细用法和参数：`dev/README.md`，或 `npm run web:shot -- --help`。
- 需要 Node 22 以上；浏览器用本机的 Chrome 或 Edge（自动找，也能用 `--chrome` 指定）。

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

（`--port 0` = 自动挑空闲端口。）

测试前端表现的时候不要真给ai发消息，用假数据即可。

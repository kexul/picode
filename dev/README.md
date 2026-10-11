# 开发调试用的小工具

这些文件只在开发时用，不会打进插件（`.vscodeignore` 里排掉了 `dev/**`）。

一句话：**不用装插件、不用开 VS Code，就能把真插件跑起来，在浏览器里看界面。**

原理：插件里真正调用 VS Code 的只有 `chatViewProvider.ts` 那一层皮（弹窗、配置存储、
diff、侧边栏网页视图）。`dev/fakeVscode.js` 把这层皮换成假的，其余全是真的：

- 真会话编排（`chatControllerBase.ts`）、真会话进程（真的拉起 `pi`）、
- 真网页服务（`webChatServer.ts`，这本来就是插件自带的功能）、
- 真界面文件（`media/` 里的 `chat.js` / `chat.css`）。

浏览器里看到的就是装了插件以后在浏览器里看到的那份界面，只是少了 VS Code 那一圈外壳。

## 两条命令

```bash
npm run web:dev        # 起后端，屏幕上打出地址，自己用浏览器打开看（Ctrl+C 退出）
npm run web:shot -- [动作…]   # 自动开浏览器、按动作点界面、截图到 dev/shots/
```

`web:dev` 开着的时候，可以再用 `web:shot --url <地址>` 连着同一个后端跑动作，
两边看的是同一份会话（跟手机 + 电脑同时开着一样）。

## 例子

```bash
# 打开页面、等会话就绪、截一张图
npm run web:shot

# 发一句话，等模型的回复，截图
npm run web:shot -- --send "只回复两个字：收到" --wait-answer 收到 --shot reply.png

# 深色界面，点一下新建标签，截图
npm run web:shot -- --theme dark --click "#newTab" --shot dark.png

# 显示浏览器窗口，跑完不关，自己接着点（调试布局时最顺手）
npm run web:shot -- --headed --keep

# 动作复杂时写个脚本：module.exports = async (page) => { … }
npm run web:shot -- --script dev/myFlow.js
```

完整参数：`npm run web:shot -- --help`（或 `node dev/visit.js --help`）。

脚本里的 `page` 能用：`page.send(文字)`、`page.type(文字)`、`page.press("Enter")`、
`page.click(选择器)`、`page.eval("return …")`、`page.waitText(文字)`、
`page.waitAnswer(要包含的文字)`、`page.answerText()`、`page.text()`、`page.shot(名字)`、
`page.sleep(毫秒)`。

## 几个注意

- **会话跑在 `dev/.scratch/`**：这是调试专用的工作目录（自动建，里面放了两个小文件与一张 1600x400 的示例图片），
  不进版本库，调试时模型改文件也改不到插件自己的代码。要试别的目录用 `--cwd`。
- **发消息不用再等会话就绪**：会话没就绪时按回车，字会留在输入框里，就绪后自动补发一次
  （以前是悄声丢掉，得像没事一样再按一次）。要故意在"还没就绪"时动手，加 `--skip-ready`。
  注意无头浏览器在页面刚加载的那几百毫秒里有时会把按键事件丢掉（探针的坑）：脚本里可以先
  `page.sleep(1000)` 再按回车。
- **需要 Node 22 以上**（用到内置的 WebSocket 跟浏览器说话），浏览器用本机的 Chrome 或 Edge。
- **验不到的东西**：diff 编辑器、符号跳转、系统通知、剪贴板、命令面板入口、状态栏、
  侧边栏网页视图本身 —— 这些还是得用 VSCodium / VS Code 的 F5 开发宿主看。

## 文件

| 文件 | 干什么 |
|---|---|
| `fakeVscode.js` | 假的 VS Code 接口。没实现的接口给空壳并记一行日志，不会把调试拦下来 |
| `harness.js` | 把真插件代码跑起来（换接口 → 建会话工作区 → 起网页服务） |
| `cdp.js` | 浏览器驱动：开 Chrome / Edge、执行页面脚本、等条件、截图（零依赖，走浏览器自带的调试接口） |
| `browserHost.js` | `npm run web:dev` 的入口：起服务后常驻 |
| `visit.js` | `npm run web:shot` 的入口：按动作跑一遍并截图 |
| `options.js` | 两条命令共用的命令行参数 |
| `makePng.js` | 生成示例图片（不依赖任何第三方库）：调试工作目录里那张 1600x400 的图就是它写的 |
| `shots/` | 截图（不进版本库） |

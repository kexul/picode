import { bootMark } from "./bootMark"; // 放第一个：记下插件代码开始加载的时间点
import * as path from "path";
import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";
import { readServerAddress } from "./serverState";

/** 读后端地址文件里记的地址（后端起来时写的）。 */
function backendAddressFromFile(): string | undefined {
    const addr = readServerAddress();
    return addr?.url;
}

export function activate(context: vscode.ExtensionContext): void {
    // 输出面板先建好：启动计时一行一行写在这里。VSCodium 里“查看 → 输出”→ 右上下拉选“Pi Chat”就能看。
    const output = vscode.window.createOutputChannel("Pi Chat");
    context.subscriptions.push(output);

    // 启动计时：activate 一开始记个总时间，每做完一件事报一下这一步花了多久。
    const tStart = performance.now();
    let lastStep = tStart;
    const step = (label: string) => {
        const now = performance.now();
        output.appendLine(`[启动计时] ${label}: ${(now - lastStep).toFixed(0)} ms（activate 开跑后共 ${(now - tStart).toFixed(0)} ms）`);
        lastStep = now;
    };
    output.appendLine(`[启动计时] ${new Date().toLocaleTimeString()} 开始激活插件`);
    output.appendLine(`[启动计时] 加载插件代码: ${(moduleLoadDone - bootMark).toFixed(0)} ms；加载完到 activate 开跑之间隔了 ${(tStart - moduleLoadDone).toFixed(0)} ms（这段是 VSCode 自己的安排，与插件无关）`);

    // 状态栏入口：一眼看到后端连上没有，点一下在浏览器里打开同一个地址（手机上也用这个）
    const backendItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    backendItem.command = "piChat.openInBrowser";
    backendItem.text = "$(globe) Pi Chat";
    backendItem.tooltip = "Pi Chat 后端：连不上";
    backendItem.show();
    context.subscriptions.push(backendItem);

    // 状态栏上那几个字跟着后端的连接状态走：手机上也用同一个地址，点一下就在浏览器里打开
    const provider = new ChatViewProvider(context, output, {
        onStatus: (state, note, url) => {
            if (state === "online" && url) {
                backendItem.text = "$(globe) Pi Chat";
                backendItem.tooltip = `Pi Chat 后端：${url}
点击在浏览器里打开（手机也用这个地址）`;
            } else {
                backendItem.text = "$(globe) Pi Chat（后端没在跑）";
                backendItem.tooltip = note || "Pi Chat 后端连不上。先在终端里敲一次 pichat 起来。";
            }
        },
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.openChat", async () => {
            await vscode.commands.executeCommand("workbench.view.extension.piChatContainer");
            await vscode.commands.executeCommand("piChat.chatView.focus");
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.newSession", () => {
            void provider.newSessionAtLastActive();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.history", () => {
            provider.pickSession();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.openSettings", () => {
            provider.openSettings();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.openViewOptions", () => {
            provider.pickViewOptions();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.pickModel", () => {
            provider.pickModel();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.focusInput", () => {
            provider.focusInput();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.askSelectionAndSend", () => {
            provider.askSelectionAndSend();
        })
    );
    step("创建对话界面、登记命令");

    // ---- 手机 / 浏览器那一屏：现在是后端自己的网页服务（同一个地址，电脑手机都看它）----
    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.openInBrowser", async () => {
            const url = provider.backendUrl ?? backendAddressFromFile();
            if (!url) {
                const choice = await vscode.window.showWarningMessage(
                    "Pi Chat 后端没在跑，没有地址可开。",
                    "怎么启动？"
                );
                if (choice === "怎么启动？") {
                    void vscode.window.showInformationMessage(
                        "在终端里敲一次 pichat 起来（它要一直开着）；装插件的这台机器上已经装好这个命令了。"
                    );
                }
                return;
            }
            output.appendLine(`[${new Date().toLocaleTimeString()}] 在浏览器里打开：${url}`);
            await vscode.env.openExternal(vscode.Uri.parse(url));
        }),
        vscode.commands.registerCommand("piChat.copyWebAddress", async () => {
            const url = provider.backendUrl ?? backendAddressFromFile();
            if (!url) {
                void vscode.window.showInformationMessage("Pi Chat 后端没在跑，没有地址可复制。");
                return;
            }
            await vscode.env.clipboard.writeText(url);
            void vscode.window.showInformationMessage(`Pi Chat 地址已复制到剪贴板：${url}`);
        })
    );
    step("登记“在浏览器里打开 / 复制地址”两个入口");
}

export function deactivate(): void {
    // 收摊都在 ChatViewProvider 构造时登记的 dispose 里做：断开与后端的连接。
    // 会话跑在后端进程里，关掉 VSCode 不影响它（后端是人自己起的，也该由人自己关）。
}

// 插件代码到这里全部加载完。配合最上面 bootMark 记下的时间点，
// 就能算出“加载插件代码”本身用了多久（activate 里的第一行日志会用到）。
const moduleLoadDone = performance.now();

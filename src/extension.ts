import * as path from "path";
import * as vscode from "vscode";
import { ChatViewProvider, DiffContentProvider } from "./chatViewProvider";
import { ensureToastAppId, vsCodeIconPath } from "./toastAppId";
import { PiChatWebServer, type WebServerSettings } from "./webChatServer";
import { ensureTabaAssets } from "./tabaAssets";

/** 读网页服务那几项配置。 */
function readWebServerSettings(): WebServerSettings {
    const cfg = vscode.workspace.getConfiguration("piChat.webServer");
    return {
        enabled: cfg.get<boolean>("enabled", true),
        port: cfg.get<number>("port", 0),
        host: cfg.get<string>("host", "127.0.0.1"),
    };
}

export function activate(context: vscode.ExtensionContext): void {
    // 先在注册表里登记本插件的通知标识（写一次），让 Windows 通知的来源显示成“Pi Chat”。
    let toastAppId: string | undefined;
    try {
        toastAppId = ensureToastAppId("Pi Chat", vsCodeIconPath());
    } catch { /* 写不进去就用系统自带标识，不影响通知发得出去 */ }

    // 派子会话要用的两样东西（那个 pi 扩展文件、自带的角色文件）先写到 ~/.pi/pichat/：
    // 每个会话启动 pi 时都要用这个路径，必须赶在第一个 tab 开出来之前写好。
    const version = String((context.extension?.packageJSON as any)?.version ?? "0");
    const tabaAssets = ensureTabaAssets(version);
    if (!tabaAssets.ok) {
        // 写不了就不开这个能力：不影响对话，只是模型那边不会出现 taba 那几个工具
        console.error("[Pi Chat] 派子会话的文件没写成：", tabaAssets.error);
    }

    const provider = new ChatViewProvider(context, toastAppId);

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            DiffContentProvider.scheme,
            DiffContentProvider.instance
        )
    );

    // diff 文档关闭时回收“修改前”内容副本，避免大文件快照在 Map 中泄漏。
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            if (doc.uri.scheme === DiffContentProvider.scheme) {
                DiffContentProvider.instance.dispose(doc.uri.query);
            }
        })
    );

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
        vscode.commands.registerCommand("piChat.openEditorChat", () => {
            provider.openEditorChat();
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
        vscode.commands.registerCommand("piChat.exportConversation", () => {
            void provider.exportConversation();
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
        vscode.commands.registerCommand("piChat.showTree", () => {
            provider.showTree();
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

    // ---- 网页服务：浏览器里也能对话（一份独立会话，与侧边栏互不干扰）----
    const output = vscode.window.createOutputChannel("Pi Chat");
    context.subscriptions.push(output);
    if (tabaAssets.ok) {
        output.appendLine(`派子会话用的扩展：${tabaAssets.extensionPath}`);
        output.appendLine(`插件自带的角色文件：${path.join(tabaAssets.resourceDir, "taba-roles")}`);
    } else {
        output.appendLine(`派子会话的功能没开（文件没写成：${tabaAssets.error}）`);
    }

    // 状态栏入口：不弹提示也能随时找到地址
    const webItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    webItem.command = "piChat.openInBrowser";
    webItem.text = "$(globe) Pi Chat 网页";
    webItem.hide();
    context.subscriptions.push(webItem);

    const webServer = new PiChatWebServer(
        path.join(context.extensionUri.fsPath, "media"),
        provider,
        {
            log: (text) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${text}`),
            onUrlChanged: (url) => {
                if (url) {
                    webItem.tooltip = `Pi Chat 网页版：${url}\n点击在默认浏览器里打开`;
                    webItem.show();
                } else {
                    webItem.hide();
                }
            },
        },
    );
    context.subscriptions.push({ dispose: () => webServer.dispose() });

    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.openInBrowser", async () => {
            if (!webServer.url) {
                const settings = readWebServerSettings();
                if (!settings.enabled) {
                    const choice = await vscode.window.showWarningMessage(
                        "Pi Chat 的网页服务当前是关闭的（配置项 piChat.webServer.enabled）。",
                        "这一次打开",
                        "去打开配置"
                    );
                    if (choice === "这一次打开") {
                        await webServer.applySettings({ ...settings, enabled: true });
                    } else if (choice === "去打开配置") {
                        await vscode.commands.executeCommand("workbench.action.openSettings", "piChat.webServer");
                    }
                } else {
                    await webServer.applySettings(settings);
                }
            }
            const url = webServer.url;
            if (!url) { return; }
            output.appendLine(`[${new Date().toLocaleTimeString()}] 在浏览器里打开：${url}`);
            output.show(true);
            await vscode.env.openExternal(vscode.Uri.parse(url));
        }),
        vscode.commands.registerCommand("piChat.copyWebAddress", async () => {
            const url = webServer.url;
            if (!url) {
                void vscode.window.showInformationMessage("Pi Chat 的网页服务没在跑。");
                return;
            }
            await vscode.env.clipboard.writeText(url);
            void vscode.window.showInformationMessage("Pi Chat 网页地址已复制到剪贴板。");
        })
    );

    // 配置变了（开关 / 端口 / 监听地址）就重启服务
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("piChat.webServer")) {
                void webServer.applySettings(readWebServerSettings());
            }
        })
    );

    const initial = readWebServerSettings();
    if (initial.enabled) {
        void webServer.applySettings(initial);
    }
}

export function deactivate(): void {
    // WebviewView 的 onDidDispose 会负责关闭 pi 进程
}

import * as vscode from "vscode";
import { ChatViewProvider, DiffContentProvider } from "./chatViewProvider";
import { ensureToastAppId, vsCodeIconPath } from "./toastAppId";

export function activate(context: vscode.ExtensionContext): void {
    // 先在注册表里登记本插件的通知标识（写一次），让 Windows 通知的来源显示成“Pi Chat”。
    let toastAppId: string | undefined;
    try {
        toastAppId = ensureToastAppId("Pi Chat", vsCodeIconPath());
    } catch { /* 写不进去就用系统自带标识，不影响通知发得出去 */ }

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
}

export function deactivate(): void {
    // WebviewView 的 onDidDispose 会负责关闭 pi 进程
}

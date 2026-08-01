import * as vscode from "vscode";
import { ChatViewProvider, DiffContentProvider } from "./chatViewProvider";
import { setExtensionRoot } from "../../../src/shared/modelsConfig";

export function activate(context: vscode.ExtensionContext): void {
    // 注入资源目录，用于定位打包的 default-models.json（位于 media/）
    setExtensionRoot(vscode.Uri.joinPath(context.extensionUri, "media").fsPath);

    const provider = new ChatViewProvider(context);

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
        vscode.commands.registerCommand("piChat.newSession", () => {
            provider.newSession();
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

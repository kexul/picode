import * as vscode from "vscode";
import { ChatViewProvider, DiffContentProvider } from "./chatViewProvider";
import { SettingsPanel } from "./settingsPanel";
import { setExtensionRoot } from "./modelsConfig";

export function activate(context: vscode.ExtensionContext): void {
    // 注入插件根目录，用于定位打包资源（media/default-models.json）
    setExtensionRoot(context.extensionUri.fsPath);

    const provider = new ChatViewProvider(context);

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            DiffContentProvider.scheme,
            DiffContentProvider.instance
        )
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
            SettingsPanel.show(context.extensionUri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.openViewOptions", () => {
            provider.pickViewOptions();
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

import * as vscode from "vscode";
import { ChatViewProvider, DiffContentProvider } from "./chatViewProvider";
import { SettingsPanel } from "./settingsPanel";
import { HooksPanel } from "./hooksPanel";
import { writeHook, readHook, ticketLogHookTemplate } from "./hooksManager";
import { setExtensionRoot } from "./modelsConfig";

/** 确保内置的工单记录 hook 已安装（内容变化时自动更新）。 */
function ensureTicketLogHook(): void {
    const name = "pi-chat-ticket-log";
    const desired = ticketLogHookTemplate();
    const existing = readHook(name);
    if (existing && existing.content === desired) {
        return;
    }
    writeHook(name, desired);
}

export function activate(context: vscode.ExtensionContext): void {
    // 注入插件根目录，用于定位打包资源（media/default-models.json）
    setExtensionRoot(context.extensionUri.fsPath);

    const provider = new ChatViewProvider(context);

    // 安装/更新内置工单记录 hook（依赖它才能按工单记录会话）
    ensureTicketLogHook();

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
        vscode.commands.registerCommand("piChat.openHooks", () => {
            HooksPanel.show(context.extensionUri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("piChat.openViewOptions", () => {
            provider.pickViewOptions();
        })
    );
}

export function deactivate(): void {
    // WebviewView 的 onDidDispose 会负责关闭 pi 进程
}

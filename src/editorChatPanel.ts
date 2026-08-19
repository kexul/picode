import * as vscode from "vscode";
import { ChatControllerBase, type ChatReferenceItem, type TabContainer } from "./chatControllerBase";
import type { NameParts } from "./names";
import { getChatHtml } from "./chatHtml";
import { readModelsJson, writeModelsJson } from "./modelsConfig";
import { probeProviderModels } from "./probeModels";
import type { FileChange, PiConfig } from "./runtimeTypes";

/**
 * 编辑器区中的一个独立 Pi Chat 工作区。
 *
 * 它刻意不注册 WebviewPanelSerializer：关闭面板或重载窗口都会终止其中的
 * pi 进程，下一次只能由侧边栏的“在编辑器中打开”按钮创建全新工作区。
 */
export class EditorChatPanel extends ChatControllerBase {
    public static readonly viewType = "piChat.editorChat";

    private readonly panel: vscode.WebviewPanel;
    private webviewReady = false;
    private disposed = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly owner: EditorChatPanelOwner,
        workspaceId: string,
    ) {
        super(workspaceId);
        this.panel = vscode.window.createWebviewPanel(
            EditorChatPanel.viewType,
            "Pi Chat",
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri],
            }
        );
        this.panel.webview.html = getChatHtml(this.panel.webview, context.extensionUri);
        this.panel.webview.onDidReceiveMessage((msg) => {
            this.owner.markEditorChatActive(this);
            this.processMessage(msg);
        });
        this.panel.onDidChangeViewState(() => {
            if (this.panel.active) { this.owner.markEditorChatActive(this); }
        });
        this.panel.onDidDispose(() => this.dispose());
    }

    public isDisposed(): boolean { return this.disposed; }

    /** 揭示面板、等待 webview 接收器就绪，并聚焦其输入框。 */
    public async revealAndFocus(): Promise<void> {
        if (this.disposed) { return; }
        this.panel.reveal(undefined, false);
        this.owner.markEditorChatActive(this);
        await this.waitWebviewReady();
        this.postToWebview({ type: "focusInput" });
    }

    /** 全局命令投递文本所用：确保有会话后发送到当前 tab，并显示目标面板。 */
    public async sendTextAndFocus(text: string): Promise<void> {
        await this.revealAndFocus();
        if (!this.getActive()) { this.newTab(); }
        this.sendActiveTabText(text);
    }

    /** 由宿主在 models.json 保存后丢弃旧模型配置下预热的进程。 */
    public discardSpare(): void { this.disposeSpare(); }

    public dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        for (const rt of this.panels.values()) {
            rt.stopClient();
            this.releasePanelName(rt.nameParts);
        }
        this.panels.clear();
        this.tabContainers.clear();
        this.activeTabId = undefined;
        this.disposeSpare();
        this.owner.removeEditorChat(this);
    }

    /** # 引用始终由共享宿主在全部当前工作区中解析。 */
    public override processMessage(msg: any): void {
        if (msg?.type === "fetchChat") {
            void this.owner.fetchGlobalChatReference(this, msg);
            return;
        }
        super.processMessage(msg);
    }

    protected allocatePanelName(): NameParts { return this.owner.allocateChatName(); }
    protected releasePanelName(parts: NameParts): void { this.owner.releaseChatName(parts); }
    protected containerDisplayName(c: TabContainer): string {
        return this.owner.uniqueTabName(this.baseContainerDisplayName(c), c.id);
    }
    protected onChatStructureChanged(): void { this.owner.broadcastChatReferences(); }

    protected postToWebview(msg: Record<string, unknown>): void {
        if (!this.disposed) { void this.panel.webview.postMessage(msg); }
    }

    public getConfig(): PiConfig { return this.owner.getConfig(); }
    public getCwd(): string { return this.owner.getCwd(); }
    public async confirmDialog(title: string, message: string): Promise<boolean> {
        return this.owner.confirmDialog(title, message);
    }
    public async selectDialog(title: string, options: string[]): Promise<string | undefined> {
        return this.owner.selectDialog(title, options);
    }
    public async inputDialog(title: string, placeholder: string, prefill: string): Promise<string | undefined> {
        return this.owner.inputDialog(title, placeholder, prefill);
    }
    public persistModel(provider: string, modelId: string): void { this.owner.persistModel(provider, modelId); }
    public async openFileLocation(p: string, line: number, anchor?: string): Promise<void> {
        return this.owner.openFileLocation(p, line, anchor);
    }
    public async openDiff(change: FileChange): Promise<void> { return this.owner.openDiff(change); }
    public async confirmRevert(label: string): Promise<boolean> { return this.owner.confirmRevert(label); }

    // 编辑器工作区始终以空白新会话开始，不受侧边栏“自动加载上次会话”选项影响。
    protected getAutoLoadLast(): boolean { return false; }
    protected getSendKey(): string { return this.owner.getSendKey(); }
    protected getNewSessionKey(): string { return this.owner.getNewSessionKey(); }
    protected getTabSwitchKey(): string { return this.owner.getTabSwitchKey(); }
    protected getFocusInputKey(): string { return this.owner.getFocusInputKey(); }
    protected getRelayPrefix(): string { return this.owner.getRelayPrefix(); }
    protected getToolDisplay(): string { return this.owner.getToolDisplay(); }
    protected getFontSize(): string { return this.owner.getFontSize(); }
    protected mutateViewOption(action: string, value?: string): void {
        this.owner.mutateViewOption(action, value);
    }

    protected sendFileList(): void {
        this.postToWebview({ type: "openFiles", files: this.owner.getOpenFiles() });
    }
    protected openFileFromWebview(p: string, line?: number, col?: number): void {
        void this.owner.openFile(p, line, col);
    }

    protected onWebviewReady(): void {
        this.webviewReady = true;
        this.owner.broadcastChatReferences();
    }
    protected async onFocusChat(): Promise<void> { await this.revealAndFocus(); }
    protected onPiMissing(piPath: string): void { this.owner.showPiMissing(piPath); }

    protected handlePlatformMessage(msg: any): boolean {
        switch (msg.type) {
            case "hostFocus":
                this.owner.markEditorChatActive(this);
                return true;
            case "openSymbol":
                if (typeof msg.name === "string") { void this.owner.openSymbol(msg.name); }
                return true;
            case "app:requestSettings": {
                const r = readModelsJson();
                this.postToWebview({ type: "app:settings", content: r.content, existed: r.existed, path: r.path });
                return true;
            }
            case "app:saveSettings": {
                if (typeof msg.content === "string") {
                    const result = writeModelsJson(msg.content);
                    if (result.ok) {
                        this.postToWebview({ type: "app:settingsResult", ok: true });
                        vscode.window.showInformationMessage("已保存 models.json");
                        this.owner.modelsChanged();
                    } else {
                        this.postToWebview({ type: "app:settingsResult", ok: false, error: result.error });
                    }
                }
                return true;
            }
            case "app:probeModels":
                void probeProviderModels(
                    typeof msg.baseUrl === "string" ? msg.baseUrl : "",
                    typeof msg.apiKey === "string" ? msg.apiKey : "",
                    typeof msg.api === "string" ? msg.api : undefined,
                ).then((result) => this.postToWebview({ type: "app:probeModelsResult", ...result }));
                return true;
        }
        return false;
    }

    private async waitWebviewReady(timeoutMs = 10000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!this.webviewReady && !this.disposed && Date.now() <= deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
}

/** EditorChatPanel 对 VS Code 宿主能力的最小依赖，避免复制聊天平台逻辑。 */
export interface EditorChatPanelOwner {
    getConfig(): PiConfig;
    getCwd(): string;
    confirmDialog(title: string, message: string): Promise<boolean>;
    selectDialog(title: string, options: string[]): Promise<string | undefined>;
    inputDialog(title: string, placeholder: string, prefill: string): Promise<string | undefined>;
    persistModel(provider: string, modelId: string): void;
    openFileLocation(p: string, line: number, anchor?: string): Promise<void>;
    openDiff(change: FileChange): Promise<void>;
    confirmRevert(label: string): Promise<boolean>;
    getSendKey(): string;
    getNewSessionKey(): string;
    getTabSwitchKey(): string;
    getFocusInputKey(): string;
    getRelayPrefix(): string;
    getToolDisplay(): string;
    getFontSize(): string;
    mutateViewOption(action: string, value?: string): void;
    getOpenFiles(): Array<{ label: string; path: string }>;
    openFile(p: string, line?: number, col?: number): Promise<void>;
    openSymbol(name: string): Promise<void>;
    showPiMissing(piPath: string): void;
    modelsChanged(): void;
    allocateChatName(): NameParts;
    releaseChatName(parts: NameParts): void;
    uniqueTabName(base: string, tabId: string): string;
    broadcastChatReferences(): void;
    fetchGlobalChatReference(requester: ChatControllerBase, msg: any): Promise<void>;
    markEditorChatActive(panel: EditorChatPanel): void;
    removeEditorChat(panel: EditorChatPanel): void;
}

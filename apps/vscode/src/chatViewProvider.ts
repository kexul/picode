import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getChatHtml } from "./chatHtml";
import { writeModelsJson, readModelsJson, defaultModelsJson } from "../../../src/shared/modelsConfig";
import {
    SessionRuntime,
    FileChange,
} from "../../../src/shared/sessionRuntime";
import { ChatControllerBase } from "../../../src/shared/chatControllerBase";

/**
 * VSCode 插件的聊天视图提供者。
 *
 * 平台相关部分（webview 装载、globalState 存储读写、vscode API 弹窗 / diff /
 * 文件打开、选中文本发送、符号跳转、models.json 编辑）在此实现；其余与
 * Electron 共享的会话编排逻辑（标签管理、拾取器、模型选择、消息分发等）
 * 继承自 {@link ChatControllerBase}。
 */
export class ChatViewProvider extends ChatControllerBase implements vscode.WebviewViewProvider {
    public static readonly viewType = "piChat.chatView";

    private view?: vscode.WebviewView;
    private static readonly KEY_SHOW_STATS = "piChat.showStatsBar";
    private static readonly KEY_AUTO_LOAD_LAST = "piChat.autoLoadLastSession";
    private static readonly KEY_SEND_KEY = "piChat.sendKey";
    private static readonly KEY_NEW_SESSION_KEY = "piChat.newSessionKey";
    private static readonly KEY_TAB_SWITCH_KEY = "piChat.tabSwitchKey";
    private static readonly SEND_KEYS = ["enter", "shift+enter", "alt+enter", "ctrl+enter"] as const;
    private static readonly NEW_SESSION_KEYS = ["ctrl+alt+n", "ctrl+shift+n", "ctrl+t", "alt+n"] as const;
    private static readonly TAB_SWITCH_KEYS = ["ctrl+alt+arrows", "ctrl+alt+pgupdown", "alt+brackets", "ctrl+alt+brackets"] as const;

    constructor(private readonly context: vscode.ExtensionContext) {
        super();
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };
        webviewView.webview.html = getChatHtml(webviewView.webview, this.context.extensionUri);

        webviewView.webview.onDidReceiveMessage((msg) => this.processMessage(msg));

        webviewView.onDidDispose(() => {
            for (const rt of this.tabs.values()) {
                rt.stopClient();
            }
            this.tabs.clear();
            this.activeId = undefined;
        });
    }

    // ---- transport ----
    protected postToWebview(msg: Record<string, unknown>): void {
        this.view?.webview.postMessage(msg);
    }

    /** webview 尚未就绪时不弹拾取器，直接视为取消。 */
    protected showPicker(kind: string, items: any[], current?: string): Promise<any | undefined> {
        if (!this.view) { return Promise.resolve(undefined); }
        return super.showPicker(kind, items, current);
    }

    // ---- RuntimeHost：配置 / cwd ----
    public getConfig() {
        const cfg = vscode.workspace.getConfiguration("piChat");
        return {
            piPath: cfg.get<string>("piPath", "pi"),
            provider: cfg.get<string>("provider", ""),
            model: cfg.get<string>("model", ""),
            extraArgs: cfg.get<string[]>("extraArgs", []),
            trustProject: cfg.get<boolean>("trustProject", true),
        };
    }

    public getCwd(): string {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders[0].uri.fsPath;
        }
        return process.cwd();
    }

    // ---- RuntimeHost：pi 校验（vscode 追加错误提示 + 打开设置）----
    protected piMissingMessage(piPath: string): string {
        return `未找到 pi 可执行文件（当前配置："${piPath}"）。请确认已安装 pi 并加入系统 PATH，或在设置中指定 piChat.piPath 为完整路径。`;
    }

    protected onPiMissing(piPath: string): void {
        vscode.window
            .showErrorMessage(this.piMissingMessage(piPath), "打开设置")
            .then((choice) => {
                if (choice === "打开设置") {
                    vscode.commands.executeCommand("workbench.action.openSettings", "piChat.piPath");
                }
            });
    }

    // ---- RuntimeHost：UI 弹窗 / diff / 文件跳转 / 持久化 ----
    public async confirmDialog(title: string, message: string): Promise<boolean> {
        const choice = await vscode.window
            .showInformationMessage(`${title}\n${message}`, { modal: true }, "是", "否");
        return choice === "是";
    }

    public async selectDialog(title: string, options: string[]): Promise<string | undefined> {
        const v = await vscode.window.showQuickPick(options, { title });
        return v ?? undefined;
    }

    public async inputDialog(title: string, placeholder: string, prefill: string): Promise<string | undefined> {
        const v = await vscode.window.showInputBox({ title, placeHolder: placeholder, value: prefill });
        return v ?? undefined;
    }

    public persistModel(provider: string, modelId: string): void {
        const cfg = vscode.workspace.getConfiguration("piChat");
        cfg.update("provider", provider, vscode.ConfigurationTarget.Global);
        cfg.update("model", modelId, vscode.ConfigurationTarget.Global);
    }

    public async openFileLocation(p: string, line: number, _anchor?: string): Promise<void> {
        try {
            const uri = vscode.Uri.file(p);
            const line0 = Math.max(0, Math.floor(line) - 1);
            await vscode.window.showTextDocument(uri, {
                selection: new vscode.Range(line0, 0, line0, 0),
            });
        } catch (e: any) {
            vscode.window.showErrorMessage(`无法打开文件: ${e.message}`);
        }
    }

    public async openDiff(change: FileChange): Promise<void> {
        const label = change.label;
        const key = DiffContentProvider.instance.set(change.before);
        const leftUri = vscode.Uri.parse(
            `${DiffContentProvider.scheme}:${encodeURIComponent(label)}?${key}`
        );
        const rightUri = vscode.Uri.file(change.path);
        try {
            await vscode.commands.executeCommand(
                "vscode.diff",
                leftUri,
                rightUri,
                `${label} (本次对话修改)`
            );
        } catch (e: any) {
            vscode.window.showErrorMessage(`无法打开 diff: ${e.message}`);
        }
    }

    public async confirmRevert(label: string): Promise<boolean> {
        const choice = await vscode.window.showWarningMessage(
            `${label} 在此次修改后又被变更过，回滚将丢弃那些后续变更。确定继续？`,
            { modal: true },
            "回滚"
        );
        return choice === "回滚";
    }

    // ---- 显示选项存储（globalState）----
    protected getShowStatsBar(): boolean {
        return this.context.globalState.get<boolean>(ChatViewProvider.KEY_SHOW_STATS, true);
    }
    protected getAutoLoadLast(): boolean {
        return this.context.globalState.get<boolean>(ChatViewProvider.KEY_AUTO_LOAD_LAST, false);
    }
    protected getSendKey(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_SEND_KEY, "enter");
        return (ChatViewProvider.SEND_KEYS as readonly string[]).includes(v) ? v : "enter";
    }
    protected getNewSessionKey(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_NEW_SESSION_KEY, "ctrl+alt+n");
        return (ChatViewProvider.NEW_SESSION_KEYS as readonly string[]).includes(v) ? v : "ctrl+alt+n";
    }
    protected getTabSwitchKey(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_TAB_SWITCH_KEY, "ctrl+alt+arrows");
        return (ChatViewProvider.TAB_SWITCH_KEYS as readonly string[]).includes(v) ? v : "ctrl+alt+arrows";
    }

    protected mutateViewOption(action: string): void {
        if (action === "sendKey") {
            const order = ChatViewProvider.SEND_KEYS;
            const idx = order.indexOf(this.getSendKey() as (typeof order)[number]);
            this.context.globalState.update(ChatViewProvider.KEY_SEND_KEY, order[(idx + 1) % order.length]);
        } else if (action === "newSessionKey") {
            const order = ChatViewProvider.NEW_SESSION_KEYS;
            const idx = order.indexOf(this.getNewSessionKey() as (typeof order)[number]);
            this.context.globalState.update(ChatViewProvider.KEY_NEW_SESSION_KEY, order[(idx + 1) % order.length]);
        } else if (action === "tabSwitchKey") {
            const order = ChatViewProvider.TAB_SWITCH_KEYS;
            const idx = order.indexOf(this.getTabSwitchKey() as (typeof order)[number]);
            this.context.globalState.update(ChatViewProvider.KEY_TAB_SWITCH_KEY, order[(idx + 1) % order.length]);
        } else {
            const cur =
                action === ChatViewProvider.KEY_SHOW_STATS
                    ? this.getShowStatsBar()
                    : this.getAutoLoadLast();
            this.context.globalState.update(action, !cur);
        }
    }

    // ---- 平台独有消息 ----
    protected handlePlatformMessage(msg: any): boolean {
        switch (msg.type) {
            case "openSymbol":
                if (typeof msg.name === "string") { void this.openSymbol(msg.name); }
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
                    } else {
                        this.postToWebview({ type: "app:settingsResult", ok: false, error: result.error });
                    }
                }
                return true;
            }
            case "app:getDefaultModels": {
                this.postToWebview({ type: "app:defaultModels", content: defaultModelsJson() });
                return true;
            }
        }
        return false;
    }

    // ---- 文件列表 / 文件打开（listFiles / openFile）----
    protected sendFileList(): void {
        const cwd = this.getCwd();
        const files: Array<{ label: string; path: string }> = [];
        const seen = new Set<string>();
        const add = (uri: vscode.Uri) => {
            if (uri.scheme !== "file") { return; }
            const full = uri.fsPath;
            if (seen.has(full)) { return; }
            seen.add(full);
            files.push({ label: this.relativeTo(cwd, full), path: full });
        };
        if (vscode.window.activeTextEditor) {
            add(vscode.window.activeTextEditor.document.uri);
        }
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input: any = tab.input;
                if (input && input.uri instanceof vscode.Uri) {
                    add(input.uri);
                }
            }
        }
        this.postToWebview({ type: "openFiles", files });
    }

    protected openFileFromWebview(p: string, line?: number, col?: number): void {
        void this.openFile(p, line, col);
    }

    /** 打开正文中的文件路径（全局，不依赖 tab）。 */
    public async openFile(p: string, line?: number, col?: number): Promise<void> {
        const selection = (): vscode.TextDocumentShowOptions => {
            if (line == null) { return {}; }
            const line0 = Math.max(0, Math.floor(line) - 1);
            const col0 = col != null ? Math.max(0, Math.floor(col) - 1) : 0;
            return { selection: new vscode.Range(line0, col0, line0, col0) };
        };
        const open = async (uri: vscode.Uri): Promise<void> => {
            try { await vscode.window.showTextDocument(uri, selection()); }
            catch (e: any) { vscode.window.showErrorMessage(`无法打开文件: ${e.message}`); }
        };
        const full = this.resolvePath(p);
        if (fs.existsSync(full) && !fs.statSync(full).isDirectory()) {
            await open(vscode.Uri.file(full));
            return;
        }
        const base = path.basename(p);
        if (base) {
            const escapeGlob = (s: string) => s.replace(/[?*\\\[\]{}]/g, "?");
            try {
                const found = await vscode.workspace.findFiles(
                    `**/${escapeGlob(base)}`,
                    "{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.next/**,**/__pycache__/**,**/.venv/**,**/venv/**}",
                    20
                );
                const files = found.filter((u) => { try { return !fs.statSync(u.fsPath).isDirectory(); } catch { return false; } });
                if (files.length > 0) {
                    const target = files.find((u) => u.fsPath.replace(/\\/g, "/").includes(p.replace(/\\/g, "/"))) || files[0];
                    await open(target);
                    return;
                }
            } catch { /* fallthrough */ }
        }
        vscode.window.showInformationMessage(`piChat: 未找到文件 ${p}`);
    }

    public async openSymbol(name: string): Promise<void> {
        try {
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                "vscode.executeWorkspaceSymbolProvider",
                name
            );
            const list = Array.isArray(symbols) ? symbols : [];
            const exact = list.filter((s) => s.name === name);
            const cand = exact.length > 0 ? exact : list;
            if (cand.length > 0) {
                const pick =
                    cand.find((s) => s.kind === vscode.SymbolKind.Function) ||
                    cand.find((s) => s.kind === vscode.SymbolKind.Method) ||
                    cand.find((s) => s.kind === vscode.SymbolKind.Class) ||
                    cand[0];
                const loc = pick.location;
                await vscode.window.showTextDocument(loc.uri, { selection: loc.range });
                return;
            }
        } catch { /* fallthrough */ }
        try {
            const escapeGlob = (s: string) => s.replace(/[?*\\\[\]{}]/g, "?");
            const found = await vscode.workspace.findFiles(
                `**/${escapeGlob(name)}.*`,
                "{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.next/**,**/__pycache__/**,**/.venv/**,**/venv/**}",
                20
            );
            const files = found.filter((u) => { try { return !fs.statSync(u.fsPath).isDirectory(); } catch { return false; } });
            if (files.length > 0) {
                const cwd = this.getCwd();
                const target = files.find((u) => u.fsPath.replace(/\\/g, "/").includes("/scripts/"))
                    || files.find((u) => u.fsPath.replace(/\\/g, "/").toLowerCase().startsWith(cwd.toLowerCase().replace(/\\/g, "/")))
                    || files[0];
                await vscode.window.showTextDocument(target);
                return;
            }
        } catch { /* fallthrough */ }
        vscode.window.showInformationMessage(`piChat: 未找到符号或文件 ${name}`);
    }

    // ---- 命令入口 ----
    public async pickViewOptions(): Promise<void> {
        await this.ensureViewVisible();
        this.showOptionsPicker();
    }

    public async openSettings(): Promise<void> {
        await this.ensureViewVisible();
        this.postToWebview({ type: "openSettings" });
    }

    public async focusInput(): Promise<void> {
        await this.ensureViewVisible();
        this.postToWebview({ type: "focusInput" });
    }

    public async pickSession(): Promise<void> {
        await this.showHistoryPicker();
    }

    public async askSelectionAndSend(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Pi Chat: 没有活动的编辑器。");
            return;
        }
        const document = editor.document;
        const selection = editor.selection;
        const selectedText = document.getText(selection);
        const hasSelection = !selection.isEmpty && selectedText.trim() !== "";
        const codeText = hasSelection
            ? selectedText
            : document.lineAt(selection.active.line).text;
        const fileRef = this.relativeTo(this.getCwd(), document.uri.fsPath);
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const range =
            startLine === endLine
                ? `第 ${startLine} 行`
                : `第 ${startLine}-${endLine} 行`;

        const userText = await vscode.window.showInputBox({
            title: "向 Pi Chat 发送选中文本",
            prompt: "你的消息将连同选中的代码一起发送到 Pi Chat 对话框。",
            placeHolder: "例如：解释这段代码、修复 bug、补充测试…（可留空直接发送选中文本）",
            ignoreFocusOut: true,
        });
        if (userText === undefined) { return; }
        if (userText.trim() === "" && !hasSelection) {
            vscode.window.showWarningMessage("Pi Chat: 没有选中文本且消息为空。");
            return;
        }

        const prefix = userText.trim() ? `${userText.trim()}\n\n` : "";
        const prompt = `${prefix}上下文: ${fileRef} (${range})\n\n\`\`\`${document.languageId}\n${codeText}\n\`\`\`\n`;

        await this.ensureViewVisible();
        const rt = this.getActive() ?? this.newTab();
        this.setActive(rt.id);
        rt.handleSend(prompt);
        vscode.window.showInformationMessage("已发送到 Pi Chat 对话框。");
    }

    protected async onFocusChat(): Promise<void> {
        await vscode.commands.executeCommand("workbench.view.extension.piChatContainer");
        await vscode.commands.executeCommand("piChat.chatView.focus");
    }

    protected async beforeHistoryPicker(): Promise<void> {
        await this.ensureViewVisible();
    }

    protected onNoSessions(): void {
        vscode.window.showInformationMessage("当前工作区没有找到 pi 历史会话。");
    }

    private async ensureViewVisible(): Promise<void> {
        await vscode.commands.executeCommand("piChat.openChat");
        for (let i = 0; i < 60; i++) {
            if (this.view) { return; }
            await new Promise((r) => setTimeout(r, 50));
        }
    }

    // forkAtEntryInNewTab 在 vscode 仍需聚焦侧栏（基类的 onFocusChat 已覆盖）。
    // 这里显式重申返回类型，便于阅读。
    public async forkAtEntryInNewTab(source: SessionRuntime, entryId: string): Promise<void> {
        return super.forkAtEntryInNewTab(source, entryId);
    }
}

/**
 * 为 diff 提供“修改前”的只读虚拟文档内容。
 * URI 方案：pichat-diff:<encoded-path>?<nonce>
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = "pichat-diff";
    public static readonly instance = new DiffContentProvider();

    /** 软上限：防止用户长期不关 diff tab 导致内容只增不减。 */
    private static readonly MAX_ENTRIES = 64;

    private contents = new Map<string, string>();
    private seq = 0;

    set(content: string): string {
        const key = String(++this.seq);
        this.contents.set(key, content);
        // 超出软上限时淘汰最老的条目（seq 最小者）。
        if (this.contents.size > DiffContentProvider.MAX_ENTRIES) {
            const oldest = this.contents.keys().next().value;
            if (oldest !== undefined) {
                this.contents.delete(oldest);
            }
        }
        return key;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.query) ?? "";
    }

    /** diff 文档关闭时回收对应内容，避免大文件快照长期驻留。 */
    dispose(key: string): void {
        this.contents.delete(key);
    }
}

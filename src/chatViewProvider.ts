import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getChatHtml } from "./chatHtml";
import { writeModelsJson, readModelsJson } from "./modelsConfig";
import {
    SessionRuntime,
    FileChange,
    StatusInfo,
} from "./sessionRuntime";
import { ChatControllerBase } from "./chatControllerBase";
import { HistoryCanvasPanel } from "./historyCanvasPanel";

/**
 * VSCode 插件的聊天视图提供者。
 *
 * 平台相关部分（webview 装载、globalState 存储读写、vscode API 弹窗 / diff /
 * 文件打开、选中文本发送、符号跳转、models.json 编辑）在此实现；其余会话编排
 * 逻辑（标签管理、拾取器、模型选择、消息分发等）继承自 {@link ChatControllerBase}。
 */
export class ChatViewProvider extends ChatControllerBase implements vscode.WebviewViewProvider {
    public static readonly viewType = "piChat.chatView";

    private view?: vscode.WebviewView;
    /** webview 的 JS 是否已加载完成并建立消息监听（收到 ready 后为 true）。 */
    private webviewReady = false;
    private statusBar?: vscode.StatusBarItem;
    private statusUpdateTimer?: ReturnType<typeof setTimeout>;
    private lastStatusInfo?: StatusInfo;
    // LSP 符号树缓存：已打开文档 → {version, DocumentSymbol[]}
    private symbolTreeCache = new Map<string, { version: number; symbols: vscode.DocumentSymbol[] }>();
    private symbolSetTimer?: ReturnType<typeof setTimeout>;
    private exportRequestSeq = 0;
    private workspaceSubs: vscode.Disposable[] = [];
    private static readonly KEY_AUTO_LOAD_LAST = "piChat.autoLoadLastSession";
    private static readonly KEY_SEND_KEY = "piChat.sendKey";
    private static readonly KEY_NEW_SESSION_KEY = "piChat.newSessionKey";
    private static readonly KEY_TAB_SWITCH_KEY = "piChat.tabSwitchKey";
    private static readonly KEY_TOOL_DISPLAY = "piChat.toolDisplay";
    private static readonly KEY_FONT_SIZE = "piChat.fontSize";
    private static readonly SEND_KEYS = ["enter", "shift+enter", "alt+enter", "ctrl+enter"] as const;
    private static readonly NEW_SESSION_KEYS = ["ctrl+alt+n", "ctrl+shift+n", "ctrl+t", "alt+n"] as const;
    private static readonly TAB_SWITCH_KEYS = ["ctrl+alt+arrows", "ctrl+alt+pgupdown", "alt+brackets", "ctrl+alt+brackets"] as const;

    private historyCanvas: HistoryCanvasPanel;

    constructor(private readonly context: vscode.ExtensionContext) {
        super();
        this.historyCanvas = new HistoryCanvasPanel(context, {
            getCwd: () => this.getCwd(),
            getActiveSessionPath: () => this.getCurrentSessionPath(),
            openSessionAtEntry: (file, entryId) => this.openSessionAtEntry(file, entryId),
            forkAtEntryFromPath: (file, entryId) => this.forkAtEntryFromPath(file, entryId),
        });
        context.subscriptions.push({ dispose: () => this.historyCanvas.dispose() });
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };
        webviewView.webview.html = getChatHtml(webviewView.webview, this.context.extensionUri);

        // 状态栏项：显示当前活动 tab 的模型 + 上下文用量；点击弹出模型选择器。
        if (!this.statusBar) {
            this.statusBar = vscode.window.createStatusBarItem(
                vscode.StatusBarAlignment.Right, 100
            );
            this.statusBar.command = "piChat.pickModel";
            this.statusBar.text = "$(hubot) pi";
            this.statusBar.tooltip = "Pi Chat：点击切换模型";
            this.statusBar.show();
            this.context.subscriptions.push(this.statusBar);
        }

        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === "exportConversationResult" && typeof msg.tabId === "string" && typeof msg.html === "string") {
                void this.saveExportedConversation(msg.tabId, msg.html);
                return;
            }
            this.processMessage(msg);
        });

        // 工作区文件变化：失效/刷新符号树缓存
        if (this.workspaceSubs.length === 0) {
            this.workspaceSubs.push(
                vscode.workspace.onDidOpenTextDocument(() => this.schedulePushSymbolSet()),
                vscode.workspace.onDidCloseTextDocument((d) => {
                    this.symbolTreeCache.delete(d.uri.fsPath);
                    this.schedulePushSymbolSet();
                }),
                vscode.workspace.onDidSaveTextDocument((d) => {
                    this.symbolTreeCache.delete(d.uri.fsPath);
                    this.schedulePushSymbolSet();
                }),
            );
        }

        webviewView.onDidDispose(() => {
            for (const rt of this.tabs.values()) {
                rt.stopClient();
            }
            this.tabs.clear();
            this.activeId = undefined;
            this.webviewReady = false;
            this.disposeSpare();
            for (const s of this.workspaceSubs) { s.dispose(); }
            this.workspaceSubs = [];
            // webview 关闭后状态栏仍保留为全局入口：重置为中性态。
            this.lastStatusInfo = undefined;
            this.applyStatusBar(undefined);
        });
    }

    // ---- transport ----
    protected postToWebview(msg: Record<string, unknown>): void {
        this.view?.webview.postMessage(msg);
    }

    /** webview 尚未就绪时不弹拾取器，直接视为取消。 */
    protected async showPicker(kind: string, items: any[], current?: string): Promise<any | undefined> {
        if (!this.view) { return Promise.resolve(undefined); }
        // 等 JS 就绪再推送 picker，否则消息会被静默丢弃（表现为点击无反应）。
        await this.waitWebviewReady();
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
    /** 工具调用显示："compact"（简洁标签）| "full"（TUI 风格卡片）。 */
    protected getToolDisplay(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_TOOL_DISPLAY, "compact");
        return v === "full" ? "full" : "compact";
    }
    protected getFontSize(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_FONT_SIZE, "14");
        return /^\d+$/.test(v) ? v : "14";
    }

    protected mutateViewOption(action: string, value?: string): void {
        if (action === "sendKey") {
            const order = ChatViewProvider.SEND_KEYS;
            const next =
                value && (order as readonly string[]).includes(value)
                    ? value
                    : order[(order.indexOf(this.getSendKey() as (typeof order)[number]) + 1) % order.length];
            this.context.globalState.update(ChatViewProvider.KEY_SEND_KEY, next);
        } else if (action === "newSessionKey") {
            const order = ChatViewProvider.NEW_SESSION_KEYS;
            const next =
                value && (order as readonly string[]).includes(value)
                    ? value
                    : order[(order.indexOf(this.getNewSessionKey() as (typeof order)[number]) + 1) % order.length];
            this.context.globalState.update(ChatViewProvider.KEY_NEW_SESSION_KEY, next);
        } else if (action === "tabSwitchKey") {
            const order = ChatViewProvider.TAB_SWITCH_KEYS;
            const next =
                value && (order as readonly string[]).includes(value)
                    ? value
                    : order[(order.indexOf(this.getTabSwitchKey() as (typeof order)[number]) + 1) % order.length];
            this.context.globalState.update(ChatViewProvider.KEY_TAB_SWITCH_KEY, next);
        } else if (action === "toolDisplay") {
            const next =
                value === "full" || value === "compact"
                    ? value
                    : this.getToolDisplay() === "full"
                      ? "compact"
                      : "full";
            this.context.globalState.update(ChatViewProvider.KEY_TOOL_DISPLAY, next);
        } else if (action === "fontSize") {
            const next = typeof value === "string" && /^\d+$/.test(value) ? value : "";
            this.context.globalState.update(ChatViewProvider.KEY_FONT_SIZE, next);
        } else {
            this.context.globalState.update(ChatViewProvider.KEY_AUTO_LOAD_LAST, !this.getAutoLoadLast());
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
        }
        return false;
    }

    /** 让 webview 把当前 tab 的最终 DOM 快照交给宿主保存为独立 HTML。 */
    public async exportConversation(): Promise<void> {
        await this.ensureViewVisible();
        const rt = this.getActive();
        if (!rt) { return; }
        const requestId = `export-${++this.exportRequestSeq}`;
        this.postToWebview({ type: "exportConversationRequest", tabId: rt.id, requestId });
    }

    private async saveExportedConversation(tabId: string, html: string): Promise<void> {
        if (!html || !this.tabs.has(tabId)) { return; }
        const rt = this.tabs.get(tabId);
        const safeTitle = (rt?.title || "pi-会话").replace(/[\\/:*?"<>|]+/g, "-").trim() || "pi-会话";
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(this.getCwd(), `${safeTitle}.html`)),
            filters: { "HTML 文件": ["html"], "所有文件": ["*"] },
            saveLabel: "导出会话",
        });
        if (!uri) { return; }
        try {
            await fs.promises.writeFile(uri.fsPath, html, "utf8");
            vscode.window.showInformationMessage(`会话已导出：${path.basename(uri.fsPath)}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`导出会话失败：${e?.message || String(e)}`);
        }
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
        // 优先在 pi 本会话读写过的文件中匹配，避免大仓库全量 findFiles。
        const known = this.getActive()?.getKnownFiles() ?? [];
        if (known.length > 0) {
            const hit = this.matchKnownFile(known, p);
            if (hit) {
                await open(vscode.Uri.file(hit));
                return;
            }
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

    /** 在 pi 本会话触及的文件中匹配路径（相对/绝对/basename/路径后缀）。 */
    private matchKnownFile(known: string[], query: string): string | undefined {
        const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
        const q = norm(query);
        const cwd = this.getCwd();
        const relOf = (f: string) => norm(this.relativeTo(cwd, f));
        const exact = known.find((f) => relOf(f) === q || norm(f) === q);
        if (exact) { return exact; }
        const base = q.split("/").pop() || q;
        const cands = known.filter((f) => {
            const r = relOf(f);
            return r === base || r.endsWith("/" + base);
        });
        if (cands.length > 0) {
            return cands.find((f) => relOf(f).includes(q)) || cands[0];
        }
        return undefined;
    }

    /** webview 就绪：标记就绪（供推送前等待）+ 推送当前已打开文档的符号集合。 */
    protected onWebviewReady(): void {
        this.webviewReady = true;
        void this.pushSymbolSet();
    }

    /** 合并 open/close/save 事件，防抖推送符号集合。 */
    private schedulePushSymbolSet(): void {
        if (this.symbolSetTimer) { return; }
        this.symbolSetTimer = setTimeout(() => {
            this.symbolSetTimer = undefined;
            void this.pushSymbolSet();
        }, 200);
    }

    /** 取某文件的符号树（带版本缓存：打开文档用 vscode 版本，否则用 mtime，未变复用）。 */
    private async loadSymbolTree(p: string): Promise<vscode.DocumentSymbol[]> {
        const cached = this.symbolTreeCache.get(p);
        const version = this.fileSymbolVersion(p);
        if (cached && cached.version === version) { return cached.symbols; }
        let symbols: vscode.DocumentSymbol[] = [];
        try {
            const r = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                "vscode.executeDocumentSymbolProvider", vscode.Uri.file(p));
            if (Array.isArray(r)) { symbols = r; }
        } catch { /* 该文件无 LS 或解析失败 */ }
        this.symbolTreeCache.set(p, { version, symbols });
        return symbols;
    }

    /** 缓存失效依据：编辑器已打开用文档版本，否则用文件 mtime（毫秒）。 */
    private fileSymbolVersion(p: string): number {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === p);
        if (open) { return open.version; }
        try { return fs.statSync(p).mtimeMs; } catch { return 0; }
    }

    /** 扁平化符号树，为每个符号产出裸名 + 祖先链全限定名（Parent.child）。 */
    private collectSymbols(syms: vscode.DocumentSymbol[], parents: string[], out: Set<string>): void {
        for (const s of syms) {
            out.add(s.name);
            if (parents.length > 0) { out.add(parents.join(".") + "." + s.name); }
            if (s.children && s.children.length > 0) {
                this.collectSymbols(s.children, [...parents, s.name], out);
            }
        }
    }

    /** 合并所有 session 中 pi 工具触及过的文件符号树 → 推送 symbolSet 给 webview。 */
    private async pushSymbolSet(): Promise<void> {
        if (!this.view) { return; }
        const paths = this.getAllKnownFiles();
        const names = new Set<string>();
        await Promise.all(paths.map(async (p) => {
            const syms = await this.loadSymbolTree(p);
            this.collectSymbols(syms, [], names);
        }));
        this.postToWebview({ type: "symbolSet", names: Array.from(names) });
    }

    public async openSymbol(name: string): Promise<void> {
        const parts = name.split(".");
        const tail = parts.pop()!;
        // 优先在 pi 工具触及过的文件中检索
        for (const p of this.getAllKnownFiles()) {
            const hit = await this.findSymbolIn(p, parts, tail);
            if (hit) {
                await this.openFileLocation(p, hit.selectionRange.start.line + 1);
                return;
            }
        }
        // 兜底：所有打开的文档
        for (const d of vscode.workspace.textDocuments) {
            if (d.uri.scheme !== "file") { continue; }
            const hit = await this.findSymbolIn(d.uri.fsPath, parts, tail);
            if (hit) {
                await this.openFileLocation(d.uri.fsPath, hit.selectionRange.start.line + 1);
                return;
            }
        }
        vscode.window.showInformationMessage(`piChat: 未找到符号 ${name}`);
    }

    /** 在某文件的符号树上按限定名逐级查找（Foo.method → 找 Foo 再在其 children 里找 method）。
     * 裸名（无点）时递归搜整棵树：TS 的 DocumentSymbol 顶层是 class，方法/属性嵌套在类 children 里。 */
    private async findSymbolIn(
        p: string, parts: string[], tail: string
    ): Promise<vscode.DocumentSymbol | undefined> {
        const syms = await this.loadSymbolTree(p);
        if (parts.length === 0) {
            return this.dfsFindSymbol(syms, tail);
        }
        let level: vscode.DocumentSymbol[] | undefined = syms;
        for (const part of parts) {
            const next: vscode.DocumentSymbol | undefined = level?.find((s) => s.name === part);
            level = next?.children;
            if (!next) { level = undefined; break; }
        }
        return level?.find((s) => s.name === tail);
    }

    /** DFS 递归找第一个名字匹配的符号（裸名可能嵌套在类/命名空间内）。 */
    private dfsFindSymbol(syms: vscode.DocumentSymbol[], name: string): vscode.DocumentSymbol | undefined {
        for (const s of syms) {
            if (s.name === name) { return s; }
            if (s.children && s.children.length > 0) {
                const hit = this.dfsFindSymbol(s.children, name);
                if (hit) { return hit; }
            }
        }
        return undefined;
    }

    // ---- 命令入口 ----
    public async pickViewOptions(): Promise<void> {
        await this.ensureViewVisible();
        this.postToWebview({ type: "openSettings", tab: "options" });
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
        await this.historyCanvas.show({ focusCurrent: false });
    }

    /** 点击状态栏模型项触发：弹出模型选择器。 */
    public async pickModel(): Promise<void> {
        await this.ensureViewVisible();
        const rt = this.getActive();
        if (rt) { await rt.pickModel(); }
    }

    /** view title 按钮触发：打开对话树/分支覆盖层。 */
    public async showTree(): Promise<void> {
        await this.ensureViewVisible();
        const rt = this.getActive();
        if (rt) { await rt.showTree(); }
    }

    /** 活跃 tab 的模型/上下文状态变化：更新状态栏（500ms 节流）。 */
    protected onActiveStatusUpdate(info: StatusInfo): void {
        this.lastStatusInfo = info;
        if (this.statusUpdateTimer) { return; }
        this.statusUpdateTimer = setTimeout(() => {
            this.statusUpdateTimer = undefined;
            this.applyStatusBar(this.lastStatusInfo);
        }, 500);
    }

    /** 任一 tab 的工具触及文件集合变化：刷新符号集合（200ms 防抖）。 */
    protected onKnownFilesChangedByHost(): void {
        this.schedulePushSymbolSet();
    }

    private applyStatusBar(info?: StatusInfo): void {
        const sb = this.statusBar;
        if (!sb) { return; }
        const modelId = info?.modelId || "";
        const provider = info?.provider || "";
        const modelPart = modelId ? `${provider ? provider + "/" : ""}${modelId}` : "pi";
        let text = `$(hubot) ${modelPart}`;
        let tooltip = "Pi Chat：点击切换模型";
        if (info && typeof info.percent === "number") {
            text += ` · ${info.percent.toFixed(1)}%`;
            const tok = info.tokens != null ? info.tokens.toLocaleString() : "?";
            const win = info.contextWindow != null ? info.contextWindow.toLocaleString() : "?";
            const tl = info.thinkingLevel ? ` · 思考 ${info.thinkingLevel}` : "";
            tooltip = `当前: ${modelPart}${tl}\n上下文: ${tok} / ${win} tokens (${info.percent.toFixed(1)}%)`;
        }
        sb.text = text;
        sb.tooltip = tooltip;
        if (info && typeof info.percent === "number") {
            if (info.percent >= 90) {
                sb.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
                sb.color = undefined;
            } else if (info.percent >= 70) {
                sb.color = new vscode.ThemeColor("editorWarning.foreground");
                sb.backgroundColor = undefined;
            } else {
                sb.color = undefined;
                sb.backgroundColor = undefined;
            }
        } else {
            sb.color = undefined;
            sb.backgroundColor = undefined;
        }
        sb.show();
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

    /** 等待 webview JS 就绪（消息监听已建立）。超时后继续，避免死锁。 */
    private async waitWebviewReady(timeoutMs = 10000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!this.webviewReady) {
            if (Date.now() > deadline) { return; }
            await new Promise((r) => setTimeout(r, 50));
        }
    }

    private async ensureViewVisible(): Promise<void> {
        await vscode.commands.executeCommand("piChat.openChat");
        // 视图已可见但 webview JS 可能尚未加载完：此时 postMessage 会被丢弃
        // （ready 之前 webview 尚未建立消息监听）。等 JS 就绪后再发送。
        await this.waitWebviewReady();
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

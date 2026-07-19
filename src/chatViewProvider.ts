import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { PiClient } from "./piClient";
import { getChatHtml } from "./chatHtml";
import { listSessions } from "./sessionStore";

/** 本次对话中一个被修改文件的记录。 */
interface FileChange {
    /** 绝对路径 */
    path: string;
    /** 相对工作区的显示名 */
    label: string;
    /** 累计新增行数 */
    added: number;
    /** 累计删除行数 */
    removed: number;
    /** 首次修改前的文件内容（用于 diff 的“原始”侧）；文件新建时为空串 */
    before: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "piChat.chatView";

    private view?: vscode.WebviewView;
    private client?: PiClient;
    private streaming = false;
    private piReady = false; // pi 进程是否已 spawn 成功（webview 据此启用发送按钮）
    private reqId = 0;
    // 等待响应的命令回调，按 id 关联
    private pending = new Map<string, (resp: any) => void>();
    // 本次对话被修改的文件，按绝对路径索引
    private fileChanges = new Map<string, FileChange>();
    // 正在执行的编辑工具调用：toolCallId -> { path, beforeContent }
    private pendingEdits = new Map<string, { path: string; before: string }>();
    // 已完成的编辑快照（用于单张卡片 revert / 精确跳转）：toolCallId -> 快照
    // anchorText 记录“首个变更行”在修改后的文本，用于在后续编辑导致行号偏移后仍能定位
    private editSnapshots = new Map<
        string,
        { path: string; before: string; after: string; firstChangedLine: number; anchorText: string }
    >();

    constructor(private readonly context: vscode.ExtensionContext) {}

    // ---- 显示选项（状态栏显示开关）----
    private static readonly KEY_SHOW_STATS = "piChat.showStatsBar";
    private static readonly KEY_AUTO_LOAD_LAST = "piChat.autoLoadLastSession";
    private static readonly KEY_SEND_KEY = "piChat.sendKey";

    /** 合法的发送键组合。 */
    private static readonly SEND_KEYS = ["enter", "shift+enter", "alt+enter", "ctrl+enter"] as const;

    /** 本次激活是否已尝试过自动加载最近会话（避免重复加载）。 */
    private autoLoadDone = false;

    /** 状态栏默认开启。 */
    private getShowStatsBar(): boolean {
        return this.context.globalState.get<boolean>(ChatViewProvider.KEY_SHOW_STATS, true);
    }

    /** 自动打开最近会话，默认关闭。 */
    private getAutoLoadLast(): boolean {
        return this.context.globalState.get<boolean>(ChatViewProvider.KEY_AUTO_LOAD_LAST, false);
    }

    /** 发送消息的键组合，默认 enter。 */
    private getSendKey(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_SEND_KEY, "enter");
        return (ChatViewProvider.SEND_KEYS as readonly string[]).includes(v) ? v : "enter";
    }

    /** 向 webview 推送当前显示选项。 */
    private sendViewOptions(): void {
        this.postToWebview({
            type: "viewOptions",
            showStatsBar: this.getShowStatsBar(),
            autoLoadLastSession: this.getAutoLoadLast(),
            sendKey: this.getSendKey(),
        });
    }

    /**
     * 打开显示选项面板。
     * 使用自建 QuickPick，所有选项（包括四态的发送键）都在同一个面板内点选，
     * 点击某项即时切换并刷新，面板不关闭。
     */
    public async pickViewOptions(): Promise<void> {
        type OptItem = vscode.QuickPickItem & { action: string };

        const labelMap: Record<string, string> = {
            "enter": "Enter",
            "shift+enter": "Shift + Enter",
            "alt+enter": "Alt + Enter",
            "ctrl+enter": "Ctrl + Enter",
        };

        const buildItems = (): OptItem[] => {
            const check = (on: boolean) => (on ? "$(check) " : "$(circle-large-outline) ");
            return [
                {
                    action: ChatViewProvider.KEY_SHOW_STATS,
                    label: check(this.getShowStatsBar()) + "状态栏",
                    description: "对话框上方的 token / 上下文状态栏",
                },
                {
                    action: ChatViewProvider.KEY_AUTO_LOAD_LAST,
                    label: check(this.getAutoLoadLast()) + "启动时自动打开最近会话",
                    description: "进入插件界面时自动加载当前工作区最近的一次会话",
                },
                {
                    action: "sendKey",
                    label: `$(keyboard) 发送键：${labelMap[this.getSendKey()]}`,
                    description: "点击切换：Enter → Shift+Enter → Alt+Enter → Ctrl+Enter",
                },
            ];
        };

        const qp = vscode.window.createQuickPick<OptItem>();
        qp.title = "显示选项";
        qp.placeholder = "点击条目即时切换（完成后按 Esc 关闭）";
        qp.ignoreFocusOut = true;
        qp.items = buildItems();

        qp.onDidAccept(() => {
            const sel = qp.selectedItems[0];
            if (!sel) {
                return;
            }
            if (sel.action === "sendKey") {
                // 四态循环切换
                const order = ChatViewProvider.SEND_KEYS;
                const idx = order.indexOf(this.getSendKey() as (typeof order)[number]);
                const next = order[(idx + 1) % order.length];
                this.context.globalState.update(ChatViewProvider.KEY_SEND_KEY, next);
            } else {
                // 开关取反
                const cur =
                    sel.action === ChatViewProvider.KEY_SHOW_STATS
                        ? this.getShowStatsBar()
                        : this.getAutoLoadLast();
                this.context.globalState.update(sel.action, !cur);
            }
            this.sendViewOptions();
            // 保持选中位置并刷新勾选状态
            const activeAction = sel.action;
            qp.items = buildItems();
            const again = qp.items.find((i) => i.action === activeAction);
            if (again) {
                qp.activeItems = [again];
            }
        });

        qp.onDidHide(() => qp.dispose());
        qp.show();
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };
        webviewView.webview.html = getChatHtml(webviewView.webview, this.context.extensionUri);

        webviewView.webview.onDidReceiveMessage((msg) => this.onWebviewMessage(msg));

        webviewView.onDidDispose(() => {
            this.stopClient();
        });

        this.startClient();
    }

    /** 由命令触发：新建会话（重启 pi 进程）。 */
    public newSession(): void {
        this.resetFileChanges();
        this.postToWebview({ type: "clear" });
        this.postToWebview({ type: "system", text: "已开始新会话。" });
        if (this.client && this.client.isRunning()) {
            this.client.send({ type: "new_session" });
        } else {
            this.startClient();
        }
    }

    /** 由命令触发：选择并加载历史会话。 */
    public async pickSession(): Promise<void> {
        const cwd = this.getCwd();
        const sessions = await listSessions(cwd);
        if (sessions.length === 0) {
            vscode.window.showInformationMessage("当前工作区没有找到 pi 历史会话。");
            return;
        }
        const items = sessions.map((s) => ({
            label: s.title,
            description: `${s.messageCount} 条消息`,
            detail: new Date(s.mtime).toLocaleString(),
            file: s.file,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            title: "选择要加载的 pi 会话",
            placeHolder: "按最近修改时间排序",
            matchOnDetail: true,
        });
        if (!picked) {
            return;
        }
        await this.loadSession(picked.file);
    }

    /**
     * 若「启动时自动打开最近会话」开关开启，则在 webview 首次就绪后
     * 自动加载当前工作区最近修改的一次会话。每次激活只执行一次。
     */
    private async maybeAutoLoadLastSession(): Promise<void> {
        if (this.autoLoadDone) {
            return;
        }
        this.autoLoadDone = true;
        if (!this.getAutoLoadLast()) {
            return;
        }
        const sessions = await listSessions(this.getCwd());
        if (sessions.length === 0) {
            return; // 没有历史会话，保持新会话
        }
        // listSessions 已按最近修改时间倒序，取第一个即最近的一次
        await this.loadSession(sessions[0].file);
    }

    /** 切换到指定会话文件并重建对话显示。 */
    private async loadSession(file: string): Promise<void> {
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
        }
        this.resetFileChanges();
        this.postToWebview({ type: "clear" });
        this.postToWebview({ type: "system", text: "正在加载会话…" });

        const switchResp = await this.request({ type: "switch_session", sessionPath: file });
        if (!switchResp || switchResp.success === false) {
            this.postToWebview({
                type: "systemError",
                text: `加载会话失败: ${switchResp?.error ?? "未知错误"}`,
            });
            return;
        }

        const msgResp = await this.request({ type: "get_messages" });
        const messages: any[] = msgResp?.data?.messages ?? [];
        this.renderMessages(messages);
        this.postToWebview({ type: "system", text: `已加载会话（${messages.length} 条消息）。` });
        this.refreshStats();
    }

    /** 把已有消息数组渲染到 webview。 */
    private renderMessages(messages: any[]): void {
        // 先收集所有 toolResult（按 toolCallId 索引），用于为历史 edit 卡片重建 diff。
        const toolResults = new Map<string, any>();
        for (const m of messages) {
            const parts = Array.isArray(m.content) ? m.content : [];
            for (const c of parts) {
                if (c && c.type === "toolResult" && c.toolCallId) {
                    toolResults.set(c.toolCallId, c);
                }
            }
        }
        for (const m of messages) {
            switch (m.role) {
                case "user":
                    this.postToWebview({ type: "userMessage", text: this.textOf(m.content) });
                    break;
                case "assistant": {
                    const parts = Array.isArray(m.content) ? m.content : [];
                    let text = "";
                    for (const c of parts) {
                        if (c.type === "text") {
                            text += c.text;
                        } else if (c.type === "toolCall") {
                            if (text.trim()) {
                                this.postToWebview({ type: "assistantFull", text });
                                text = "";
                            }
                            // edit/write 历史卡片：重建 diff 并允许展开 / 跳转（不提供回滚）
                            if (c.name === "edit" || c.name === "write") {
                                const p = this.editToolPath(c.name, c.arguments);
                                const id = c.id || `hist-${Math.random()}`;
                                this.postToWebview({
                                    type: "editCardStart",
                                    toolCallId: id,
                                    toolName: c.name,
                                    path: p || "",
                                    label: p ? this.relativeTo(this.getCwd(), p) : "",
                                });
                                const info = this.historyEditInfo(c, toolResults.get(id));
                                this.postToWebview({
                                    type: "editCardResult",
                                    toolCallId: id,
                                    diff: info.diff,
                                    firstChangedLine: info.firstChangedLine,
                                    // 历史卡片不提供回滚（缺少可靠的“修改前”磁盘快照），
                                    // 但仍可展开查看 diff 并跳转到当前文件位置。
                                    canRevert: false,
                                });
                            } else {
                                this.postToWebview({
                                    type: "tool",
                                    toolName: c.name,
                                    args: c.arguments,
                                });
                            }
                        }
                    }
                    if (text.trim()) {
                        this.postToWebview({ type: "assistantFull", text });
                    }
                    break;
                }
                // toolResult / bashExecution 等不在对话气泡中展示
            }
        }
    }

    private textOf(content: unknown): string {
        if (typeof content === "string") {
            return content;
        }
        if (Array.isArray(content)) {
            return content.map((c: any) => (c.type === "text" ? c.text : "")).join("");
        }
        return "";
    }

    /** 发送需要响应的命令，返回带 id 的响应。 */
    private request(cmd: Record<string, unknown>): Promise<any> {
        return new Promise((resolve) => {
            if (!this.client || !this.client.isRunning()) {
                resolve(undefined);
                return;
            }
            const id = `req-${++this.reqId}`;
            this.pending.set(id, resolve);
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    resolve(undefined);
                }
            }, 15000);
            const wrapped = (resp: any) => {
                clearTimeout(timer);
                resolve(resp);
            };
            this.pending.set(id, wrapped);
            try {
                this.client.send({ ...cmd, id });
            } catch {
                this.pending.delete(id);
                clearTimeout(timer);
                resolve(undefined);
            }
        });
    }

    private getConfig() {
        const cfg = vscode.workspace.getConfiguration("piChat");
        return {
            piPath: cfg.get<string>("piPath", "pi"),
            provider: cfg.get<string>("provider", ""),
            model: cfg.get<string>("model", ""),
            extraArgs: cfg.get<string[]>("extraArgs", []),
        };
    }

    private getCwd(): string {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders[0].uri.fsPath;
        }
        return process.cwd();
    }

    /**
     * 检查 pi 可执行文件是否能找到。
     * - 若 piPath 含路径分隔符，直接按文件是否存在判断；
     * - 否则在 PATH 中搜索（Windows 下考虑 PATHEXT）。
     * 找不到时弹出提示并返回 false。
     */
    private checkPiAvailable(piPath: string): boolean {
        if (this.resolveExecutable(piPath)) {
            return true;
        }
        const msg = `未找到 pi 可执行文件（当前配置："${piPath}"）。请确认已安装 pi 并加入系统 PATH，或在设置中指定 piChat.piPath 为完整路径。`;
        this.postToWebview({ type: "systemError", text: msg });
        vscode.window
            .showErrorMessage(msg, "打开设置")
            .then((choice) => {
                if (choice === "打开设置") {
                    vscode.commands.executeCommand(
                        "workbench.action.openSettings",
                        "piChat.piPath"
                    );
                }
            });
        return false;
    }

    /** 解析可执行文件的实际路径，找不到返回 undefined。 */
    private resolveExecutable(cmd: string): string | undefined {
        if (!cmd) {
            return undefined;
        }
        const isWindows = process.platform === "win32";
        const exts = isWindows
            ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
            : [""];

        const existsAsFile = (p: string): boolean => {
            try {
                return fs.statSync(p).isFile();
            } catch {
                return false;
            }
        };
        const tryWithExts = (base: string): string | undefined => {
            // 已带后缀（或非 Windows）时直接判断
            if (existsAsFile(base)) {
                return base;
            }
            if (isWindows) {
                for (const ext of exts) {
                    const withExt = base + ext.toLowerCase();
                    if (existsAsFile(withExt)) {
                        return withExt;
                    }
                    const withExtUpper = base + ext;
                    if (existsAsFile(withExtUpper)) {
                        return withExtUpper;
                    }
                }
            }
            return undefined;
        };

        // 含路径分隔符：当作具体路径处理
        if (cmd.includes("/") || cmd.includes("\\")) {
            const abs = path.isAbsolute(cmd) ? cmd : path.resolve(this.getCwd(), cmd);
            return tryWithExts(abs);
        }

        // 否则在 PATH 中逐目录搜索
        const pathEnv = process.env.PATH || process.env.Path || "";
        const sep = isWindows ? ";" : ":";
        for (const dir of pathEnv.split(sep).filter(Boolean)) {
            const found = tryWithExts(path.join(dir, cmd));
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    private startClient(): void {
        if (this.client && this.client.isRunning()) {
            return;
        }
        // 进入启动中状态：发送按钮先禁用，待 spawn 成功后再启用
        this.setPiReady(false);
        const cfg = this.getConfig();

        // 启动前检查 pi 是否可用（不在 PATH 中 / 路径错误时给出明确提示）。
        if (!this.checkPiAvailable(cfg.piPath)) {
            return;
        }

        this.client = new PiClient({
            piPath: cfg.piPath,
            cwd: this.getCwd(),
            provider: cfg.provider || undefined,
            model: cfg.model || undefined,
            extraArgs: cfg.extraArgs,
        });

        this.client.on("event", (evt) => this.onPiEvent(evt));
        this.client.on("response", (resp) => this.onPiResponse(resp));
        this.client.on("ui", (req) => this.onPiUiRequest(req));
        this.client.on("stderr", (text: string) => {
            console.error("[pi stderr]", text);
        });
        this.client.on("error", (err: Error) => {
            this.postToWebview({ type: "systemError", text: `pi 错误: ${err.message}` });
        });
        this.client.on("exit", (code: number | null) => {
            this.streaming = false;
            this.postToWebview({ type: "streamEnd" });
            // 进程退出后重新允许发送（发送时会自动重启 pi）
            this.setPiReady(true);
            this.postToWebview({
                type: "system",
                text: `pi 进程已退出（code=${code}）。发送消息会自动重启。`,
            });
        });

        try {
            this.client.start();
            // spawn 成功即视为可用：pi 会自行缓冲 stdin 命令，启动期间的请求等就绪后处理
            this.setPiReady(true);
            this.postToWebview({ type: "system", text: "pi 已启动，可以开始对话。" });
        } catch (e: any) {
            this.postToWebview({ type: "systemError", text: `无法启动 pi: ${e.message}` });
        }
    }

    /** 更新 pi 就绪状态并同步给 webview（控制发送按钮启用/禁用）。 */
    private setPiReady(ready: boolean): void {
        this.piReady = ready;
        this.postToWebview({ type: "piReady", ready });
    }

    private stopClient(): void {
        if (this.client) {
            this.client.stop();
            this.client = undefined;
        }
    }

    // ---- Webview -> 扩展 ----
    private onWebviewMessage(msg: any): void {
        switch (msg.type) {
            case "send":
                this.handleSend(msg.text, msg.images);
                break;
            case "newSession":
                this.newSession();
                break;
            case "abort":
                if (this.client && this.client.isRunning()) {
                    // abort 中止 LLM 流式生成；abort_bash 杀掉正在运行的 bash 工具子进程。
                    // 两个都发，覆盖“等模型吐字”和“工具在跑”两种状态。
                    this.client.send({ type: "abort_bash" });
                    this.client.send({ type: "abort" });
                }
                break;
            case "pickModel":
                this.pickModel();
                break;
            case "listFiles":
                this.sendOpenFiles();
                break;
            case "openDiff":
                if (typeof msg.path === "string") {
                    this.openDiff(msg.path);
                }
                break;
            case "openEditLocation":
                if (typeof msg.toolCallId === "string" && this.editSnapshots.has(msg.toolCallId)) {
                    // 优先用锚点在当前磁盘内容中重新定位行号（避免后续编辑导致行号偏移）
                    this.openEditByToolCall(msg.toolCallId);
                } else if (typeof msg.path === "string") {
                    this.openEditLocation(msg.path, typeof msg.line === "number" ? msg.line : 1);
                }
                break;
            case "revertEdit":
                if (typeof msg.toolCallId === "string") {
                    this.revertEdit(msg.toolCallId);
                }
                break;
            case "ready":
                // Webview 加载完成：并行拉取初始状态，避免串行等待叠加延迟/超时
                this.sendViewOptions();
                // 回送当前 pi 就绪状态（webview 默认禁用，避免冷启动期间按钮误以为可用）
                this.postToWebview({ type: "piReady", ready: this.piReady });
                void Promise.all([this.sendCurrentModel(), this.refreshStats()]);
                this.maybeAutoLoadLastSession();
                break;
        }
    }

    /** 列出可用模型并让用户选择切换。 */
    private async pickModel(): Promise<void> {
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
        }
        const resp = await this.request({ type: "get_available_models" });
        const models: any[] = resp?.data?.models ?? [];
        if (models.length === 0) {
            vscode.window.showInformationMessage("没有可用模型（请确认 pi 已鉴权、models.json 已配置）。");
            return;
        }
        const items = models.map((m) => ({
            label: m.id,
            description: m.provider ? `${m.provider}${m.name && m.name !== m.id ? " · " + m.name : ""}` : (m.name || ""),
            detail: m.contextWindow ? `上下文 ${Math.round(m.contextWindow / 1000)}K` : undefined,
            model: m,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            title: "切换模型",
            placeHolder: "选择要使用的模型",
            matchOnDescription: true,
        });
        if (!picked) {
            return;
        }
        const setResp = await this.request({
            type: "set_model",
            provider: picked.model.provider,
            modelId: picked.model.id,
        });
        if (setResp?.success === false) {
            this.postToWebview({ type: "systemError", text: `切换模型失败: ${setResp.error}` });
        } else {
            const m = setResp?.data ?? picked.model;
            this.postToWebview({ type: "modelChanged", modelId: m.id, provider: m.provider });
            this.postToWebview({ type: "system", text: `已切换模型: ${m.id}` });
            // 持久化到 VS Code 设置，下次启动 pi 时自动使用该模型
            const cfg = vscode.workspace.getConfiguration("piChat");
            cfg.update("provider", m.provider || "", vscode.ConfigurationTarget.Global);
            cfg.update("model", m.id || "", vscode.ConfigurationTarget.Global);
        }
    }

    /** 获取当前模型并告知 webview（用于初始显示）。 */
    private async sendCurrentModel(): Promise<void> {
        const resp = await this.request({ type: "get_state" });
        const model = resp?.data?.model;
        if (model && model.id) {
            this.postToWebview({ type: "modelChanged", modelId: model.id, provider: model.provider });
        }
    }

    /** 将 VSCode 当前打开的文件列表发给 webview（用于 @ 引用补全）。 */
    private sendOpenFiles(): void {
        const cwd = this.getCwd();
        const files: Array<{ label: string; path: string }> = [];
        const seen = new Set<string>();

        const add = (uri: vscode.Uri) => {
            if (uri.scheme !== "file") {
                return;
            }
            const full = uri.fsPath;
            if (seen.has(full)) {
                return;
            }
            seen.add(full);
            const rel = this.relativeTo(cwd, full);
            files.push({ label: rel, path: full });
        };

        // 当前活动编辑器优先
        if (vscode.window.activeTextEditor) {
            add(vscode.window.activeTextEditor.document.uri);
        }
        // 所有打开的标签页
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

    private relativeTo(cwd: string, full: string): string {
        const norm = (s: string) => s.replace(/\\/g, "/");
        const c = norm(cwd).replace(/\/$/, "") + "/";
        const f = norm(full);
        if (f.toLowerCase().startsWith(c.toLowerCase())) {
            return f.slice(c.length);
        }
        return full;
    }

    private handleSend(text: string, images?: Array<{ data: string; mimeType: string }>): void {
        const hasImages = Array.isArray(images) && images.length > 0;
        if ((!text || !text.trim()) && !hasImages) {
            return;
        }
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
        }
        this.postToWebview({
            type: "userMessage",
            text,
            imageCount: hasImages ? images!.length : 0,
        });

        const cmd: Record<string, unknown> = { type: "prompt", message: text || "" };
        if (hasImages) {
            cmd.images = images!.map((img) => ({
                type: "image",
                data: img.data,
                mimeType: img.mimeType,
            }));
        }
        // 若正在流式生成，将消息作为 steering 排队
        if (this.streaming) {
            cmd.streamingBehavior = "steer";
        }
        try {
            this.client!.send(cmd);
        } catch (e: any) {
            this.postToWebview({ type: "systemError", text: `发送失败: ${e.message}` });
        }
    }

    // ---- pi -> Webview ----
    private onPiEvent(evt: any): void {
        switch (evt.type) {
            case "agent_start":
                this.streaming = true;
                this.postToWebview({ type: "streamStart" });
                break;
            case "message_update": {
                const a = evt.assistantMessageEvent;
                if (!a) {
                    break;
                }
                if (a.type === "text_delta") {
                    this.postToWebview({ type: "assistantDelta", delta: a.delta });
                } else if (a.type === "thinking_delta") {
                    this.postToWebview({ type: "thinkingDelta", delta: a.delta });
                }
                break;
            }
            case "tool_execution_start":
                this.trackEditStart(evt);
                this.onToolStart(evt);
                break;
            case "tool_execution_end":
                this.trackEditEnd(evt);
                this.onToolEnd(evt);
                break;
            case "agent_settled":
            case "agent_end":
                this.streaming = false;
                this.postToWebview({ type: "streamEnd" });
                this.refreshStats();
                break;
        }
    }

    /** edit/write 工具开始：推送 edit 卡片占位。其他工具走原 tool 行。 */
    private onToolStart(evt: any): void {
        const toolName: string = evt.toolName;
        const isEditLike = toolName === "edit" || toolName === "write";
        const path = isEditLike ? this.editToolPath(toolName, evt.args) : null;
        if (path && evt.toolCallId) {
            this.postToWebview({
                type: "editCardStart",
                toolCallId: evt.toolCallId,
                toolName,
                path,
                label: this.relativeTo(this.getCwd(), path),
            });
        } else {
            this.postToWebview({
                type: "tool",
                toolCallId: evt.toolCallId,
                toolName,
                args: evt.args,
            });
        }
    }

    /** 工具结束：edit/write 回填 diff；其他工具推送状态用于取消流光。 */
    private onToolEnd(evt: any): void {
        const toolName: string = evt.toolName;
        if (toolName !== "edit" && toolName !== "write") {
            if (evt.toolCallId) {
                this.postToWebview({
                    type: "toolResult",
                    toolCallId: evt.toolCallId,
                    isError: !!evt.isError,
                });
            }
            return;
        }
        if (!evt.toolCallId) {
            return;
        }
        const details = !evt.isError ? evt.result?.details : undefined;
        const errorText = evt.isError ? this.extractErrorText(evt.result) : undefined;
        this.postToWebview({
            type: "editCardResult",
            toolCallId: evt.toolCallId,
            diff: typeof details?.diff === "string" ? details.diff : undefined,
            firstChangedLine: typeof details?.firstChangedLine === "number"
                ? details.firstChangedLine : undefined,
            isError: !!evt.isError,
            errorText,
            // 有快照才允许 revert（非错误且成功记录了 before/after）
            canRevert: !evt.isError && this.editSnapshots.has(evt.toolCallId),
        });
    }

    /** 从工具返回结果中提取错误文本。 */
    private extractErrorText(result: any): string | undefined {
        if (!result) {
            return undefined;
        }
        const content = result.content;
        if (Array.isArray(content)) {
            for (const c of content) {
                if (c && c.type === "text" && typeof c.text === "string") {
                    return c.text;
                }
            }
        }
        try {
            return JSON.stringify(result);
        } catch {
            return undefined;
        }
    }

    /** 清空本次对话的文件修改记录并通知 webview。 */
    private resetFileChanges(): void {
        this.fileChanges.clear();
        this.pendingEdits.clear();
        this.editSnapshots.clear();
        this.postFileChanges();
    }

    /**
     * 回滚某一次 edit 卡片对应的修改（将文件恢复到该次 edit 之前的内容）。
     * 若磁盘内容已不等于该次 edit 的结果（后续又被修改过），先让用户确认。
     */
    private async revertEdit(toolCallId: string): Promise<void> {
        const snap = this.editSnapshots.get(toolCallId);
        if (!snap) {
            this.postToWebview({ type: "systemError", text: "无法回滚：缺失修改前的快照。" });
            return;
        }
        const label = this.relativeTo(this.getCwd(), snap.path);

        // 读取当前磁盘内容，判断是否仍为该次 edit 的结果
        let current = "";
        try {
            current = fs.readFileSync(snap.path, "utf8");
        } catch {
            current = "";
        }
        if (current === snap.before) {
            this.postToWebview({ type: "system", text: `无需回滚：${label} 已是修改前的内容。` });
            this.postToWebview({ type: "editReverted", toolCallId });
            return;
        }
        if (current !== snap.after) {
            const choice = await vscode.window.showWarningMessage(
                `${label} 在此次修改后又被变更过，回滚将丢弃那些后续变更。确定继续？`,
                { modal: true },
                "回滚"
            );
            if (choice !== "回滚") {
                return;
            }
        }

        // 将内容写回修改前的版本
        try {
            fs.writeFileSync(snap.path, snap.before, "utf8");
        } catch (e: any) {
            this.postToWebview({ type: "systemError", text: `回滚失败: ${e.message}` });
            return;
        }

        // 更新“本次对话修改的文件”统计：从该文件累计中减去本次 edit 的增删
        const existing = this.fileChanges.get(snap.path);
        if (existing) {
            const { added, removed } = this.diffLineCount(snap.before, snap.after);
            existing.added = Math.max(0, existing.added - added);
            existing.removed = Math.max(0, existing.removed - removed);
            // 若该文件已回到首次修改前的内容，从列表移除
            let latest = "";
            try {
                latest = fs.readFileSync(snap.path, "utf8");
            } catch {
                latest = "";
            }
            if (latest === existing.before) {
                this.fileChanges.delete(snap.path);
            }
            this.postFileChanges();
        }

        // 该快照已消费，移除，避免重复回滚
        this.editSnapshots.delete(toolCallId);
        this.postToWebview({ type: "editReverted", toolCallId });
        this.postToWebview({ type: "system", text: `已回滚: ${label}` });
    }

    /** 将当前文件修改列表推送到 webview。 */
    private postFileChanges(): void {
        const files = Array.from(this.fileChanges.values()).map((c) => ({
            path: c.path,
            label: c.label,
            added: c.added,
            removed: c.removed,
        }));
        this.postToWebview({ type: "fileChanges", files });
    }

    /**
     * 为历史 edit/write 卡片重建展示信息（diff 文本 + 首个变更行）。
     * 优先使用 toolResult.details.diff；无则根据工具参数粗略重建。
     */
    private historyEditInfo(
        call: any,
        result: any
    ): { diff?: string; firstChangedLine?: number } {
        const details = result?.details;
        let diff: string | undefined =
            typeof details?.diff === "string" ? details.diff : undefined;
        const firstChangedLine: number | undefined =
            typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined;

        if (!diff) {
            const args = call?.arguments ?? {};
            if (call?.name === "edit") {
                const oldText =
                    typeof args.old_text === "string"
                        ? args.old_text
                        : typeof args.oldText === "string"
                          ? args.oldText
                          : "";
                const newText =
                    typeof args.new_text === "string"
                        ? args.new_text
                        : typeof args.newText === "string"
                          ? args.newText
                          : "";
                if (oldText || newText) {
                    const del = oldText ? oldText.split("\n").map((l: string) => "-" + l) : [];
                    const add = newText ? newText.split("\n").map((l: string) => "+" + l) : [];
                    diff = del.concat(add).join("\n");
                }
            } else if (call?.name === "write") {
                const content =
                    typeof args.content === "string"
                        ? args.content
                        : typeof args.text === "string"
                          ? args.text
                          : "";
                if (content) {
                    diff = content
                        .split("\n")
                        .map((l: string) => "+" + l)
                        .join("\n");
                }
            }
        }
        return { diff, firstChangedLine };
    }

    /** 判断工具是否会修改文件，并提取目标路径。 */
    private editToolPath(toolName: string, args: any): string | null {
        if (toolName !== "edit" && toolName !== "write") {
            return null;
        }
        const raw =
            typeof args?.path === "string"
                ? args.path
                : typeof args?.file_path === "string"
                  ? args.file_path
                  : null;
        if (!raw) {
            return null;
        }
        return this.resolvePath(raw);
    }

    private resolvePath(p: string): string {
        if (path.isAbsolute(p)) {
            return p;
        }
        return path.resolve(this.getCwd(), p);
    }

    /** 编辑开始：快照文件修改前的内容。 */
    private trackEditStart(evt: any): void {
        const path = this.editToolPath(evt.toolName, evt.args);
        if (!path || !evt.toolCallId) {
            return;
        }
        let before = "";
        try {
            before = fs.readFileSync(path, "utf8");
        } catch {
            before = ""; // 新建文件
        }
        this.pendingEdits.set(evt.toolCallId, { path, before });
    }

    /** 编辑结束：读取修改后内容，计算行数变化并记录。 */
    private trackEditEnd(evt: any): void {
        const id = evt.toolCallId;
        if (!id) {
            return;
        }
        const pend = this.pendingEdits.get(id);
        this.pendingEdits.delete(id);
        if (!pend || evt.isError) {
            return;
        }
        let after = "";
        try {
            after = fs.readFileSync(pend.path, "utf8");
        } catch {
            return;
        }
        if (after === pend.before) {
            return; // 无实际变化
        }
        // 计算首个变更行（在 after 中的行号）及其行文本作为锚点
        const { line: firstChangedLine, anchor: anchorText } = this.firstChangedLineOf(
            pend.before,
            after
        );
        // 保存本次 edit 的快照，供单张卡片 revert / 精确跳转使用
        this.editSnapshots.set(id, {
            path: pend.path,
            before: pend.before,
            after,
            firstChangedLine,
            anchorText,
        });
        const { added, removed } = this.diffLineCount(pend.before, after);
        const existing = this.fileChanges.get(pend.path);
        if (existing) {
            existing.added += added;
            existing.removed += removed;
        } else {
            this.fileChanges.set(pend.path, {
                path: pend.path,
                label: this.relativeTo(this.getCwd(), pend.path),
                added,
                removed,
                before: pend.before, // 保留首次修改前的内容
            });
        }
        this.postFileChanges();
    }

    /** 行级 diff 统计（LCS 滚动数组），返回新增/删除行数。空间 O(min(n,m))。 */
    private diffLineCount(before: string, after: string): { added: number; removed: number } {
        const a = before.length ? before.split("\n") : [];
        const b = after.length ? after.split("\n") : [];
        const n = a.length;
        const m = b.length;
        if (n === 0) { return { added: m, removed: 0 }; }
        if (m === 0) { return { added: 0, removed: n }; }
        // dp[j] 始终保存"上一轮 i+1 行"的值；从右到左计算，用 diag 保存 dp[i+1][j+1]
        const dp = new Array<number>(m + 1).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            let diag = 0; // dp[i+1][m] = 0
            for (let j = m - 1; j >= 0; j--) {
                const tmp = dp[j]; // dp[i+1][j]
                if (a[i] === b[j]) {
                    dp[j] = diag + 1;
                } else {
                    dp[j] = Math.max(tmp, dp[j + 1]);
                }
                diag = tmp;
            }
        }
        const lcs = dp[0];
        return { added: m - lcs, removed: n - lcs };
    }

    /**
     * 找出 before -> after 的首个变更行，返回该行在 after 中的 1-based 行号及行文本（锚点）。
     * 策略：从头部跳过前后相同的公共前缀行，第一个不同位置即为首个变更行。
     */
    private firstChangedLineOf(
        before: string,
        after: string
    ): { line: number; anchor: string } {
        const a = before.length ? before.split("\n") : [];
        const b = after.length ? after.split("\n") : [];
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) {
            i++;
        }
        // i 即首个不同的 0-based 行索引（在 after 中）
        const line = Math.min(i, Math.max(b.length - 1, 0)) + 1;
        const anchor = b[Math.min(i, b.length - 1)] ?? "";
        return { line, anchor };
    }

    /**
     * 在当前磁盘内容中重新定位锚点行的行号（1-based）。
     * 优先在原行号附近搜索（就近医疗），找不到再全文搜索；均失败则回退到原行号。
     */
    private resolveAnchorLine(currentText: string, anchor: string, fallbackLine: number): number {
        if (!anchor) {
            return fallbackLine;
        }
        const lines = currentText.split("\n");
        const fb0 = Math.max(0, fallbackLine - 1);
        // 1) 原位置已匹配，直接返回
        if (lines[fb0] === anchor) {
            return fallbackLine;
        }
        // 2) 在 fallback 附近由近及远搜索（窗口 200 行）
        const WINDOW = 200;
        for (let d = 1; d <= WINDOW; d++) {
            const up = fb0 - d;
            const down = fb0 + d;
            if (down < lines.length && lines[down] === anchor) {
                return down + 1;
            }
            if (up >= 0 && lines[up] === anchor) {
                return up + 1;
            }
        }
        // 3) 全文搜索首个完全匹配
        for (let k = 0; k < lines.length; k++) {
            if (lines[k] === anchor) {
                return k + 1;
            }
        }
        // 4) 悉数失败，回退到原行号（至少不越界）
        return Math.min(fallbackLine, Math.max(lines.length, 1));
    }

    /** 打开某个文件的 diff（首次修改前 vs 当前磁盘内容）。 */
    private async openDiff(path: string): Promise<void> {
        const change = this.fileChanges.get(path);
        if (!change) {
            return;
        }
        const label = change.label;
        // “前”侧：使用只读的虚拟文档。“后”侧：磁盘上的实际文件。
        const key = DiffContentProvider.instance.set(change.before);
        const leftUri = vscode.Uri.parse(
            `${DiffContentProvider.scheme}:${encodeURIComponent(label)}?${key}`
        );
        const rightUri = vscode.Uri.file(path);
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

    /** 打开文件并跳转到指定行（用于 edit 卡片点击跳转）。 */
    private async openEditLocation(path: string, line: number): Promise<void> {
        try {
            const uri = vscode.Uri.file(path);
            const line0 = Math.max(0, Math.floor(line) - 1);
            await vscode.window.showTextDocument(uri, {
                selection: new vscode.Range(line0, 0, line0, 0),
            });
        } catch (e: any) {
            vscode.window.showErrorMessage(`无法打开文件: ${e.message}`);
        }
    }

    /**
     * 依据某次 edit 的快照，在当前磁盘内容中重新定位首个变更行并跳转。
     * 解决同一对话中后续更靠前的编辑导致旧行号偏移的问题。
     */
    private async openEditByToolCall(toolCallId: string): Promise<void> {
        const snap = this.editSnapshots.get(toolCallId);
        if (!snap) {
            return;
        }
        let current = "";
        try {
            current = fs.readFileSync(snap.path, "utf8");
        } catch {
            // 文件读不到就按原行号打开
            await this.openEditLocation(snap.path, snap.firstChangedLine);
            return;
        }
        const line = this.resolveAnchorLine(current, snap.anchorText, snap.firstChangedLine);
        await this.openEditLocation(snap.path, line);
    }

    /** 获取会话统计（token/成本/上下文）并推送给 webview。 */
    private async refreshStats(): Promise<void> {
        const resp = await this.request({ type: "get_session_stats" });
        const d = resp?.data;
        if (!d) {
            return;
        }
        this.postToWebview({
            type: "stats",
            tokens: d.tokens || null,
            cost: typeof d.cost === "number" ? d.cost : null,
            contextUsage: d.contextUsage || null,
        });
    }

    private onPiResponse(resp: any): void {
        if (resp.id && this.pending.has(resp.id)) {
            const cb = this.pending.get(resp.id)!;
            this.pending.delete(resp.id);
            cb(resp);
            return;
        }
        if (resp.success === false && resp.error) {
            this.postToWebview({ type: "systemError", text: `pi: ${resp.error}` });
        }
    }

    // extension UI 请求：对话框类需要回复
    private onPiUiRequest(req: any): void {
        const respond = (payload: Record<string, unknown>) => {
            if (this.client && this.client.isRunning()) {
                this.client.send({ type: "extension_ui_response", id: req.id, ...payload });
            }
        };
        switch (req.method) {
            case "confirm":
                vscode.window
                    .showInformationMessage(
                        `${req.title ?? "确认"}\n${req.message ?? ""}`,
                        { modal: true },
                        "是",
                        "否"
                    )
                    .then((choice) => respond({ confirmed: choice === "是" }));
                break;
            case "select":
                vscode.window
                    .showQuickPick(req.options ?? [], { title: req.title })
                    .then((value) =>
                        value === undefined ? respond({ cancelled: true }) : respond({ value })
                    );
                break;
            case "input":
            case "editor":
                vscode.window
                    .showInputBox({ title: req.title, placeHolder: req.placeholder, value: req.prefill })
                    .then((value) =>
                        value === undefined ? respond({ cancelled: true }) : respond({ value })
                    );
                break;
            case "notify":
                this.postToWebview({ type: "system", text: String(req.message ?? "") });
                break;
            // 其余 fire-and-forget 方法忽略
        }
    }

    private postToWebview(msg: Record<string, unknown>): void {
        this.view?.webview.postMessage(msg);
    }
}

/**
 * 为 diff 提供“修改前”的只读虚拟文档内容。
 * URI 方案：pichat-diff:<encoded-path>?<nonce>
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = "pichat-diff";
    public static readonly instance = new DiffContentProvider();

    // 按唯一 key 保存“修改前”内容（放在 URI query 中）
    private contents = new Map<string, string>();
    private seq = 0;

    /** 存入内容，返回可放入 URI query 的 key。 */
    set(content: string): string {
        const key = String(++this.seq);
        this.contents.set(key, content);
        return key;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.query) ?? "";
    }
}

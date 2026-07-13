import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { PiClient } from "./piClient";
import { getChatHtml } from "./chatHtml";
import { listSessions } from "./sessionStore";
import {
    setActiveTicket,
    getActiveTicket,
    listTickets,
    isValidTicket,
} from "./hooksManager";

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
    private reqId = 0;
    // 等待响应的命令回调，按 id 关联
    private pending = new Map<string, (resp: any) => void>();
    // 本次对话被修改的文件，按绝对路径索引
    private fileChanges = new Map<string, FileChange>();
    // 正在执行的编辑工具调用：toolCallId -> { path, beforeContent }
    private pendingEdits = new Map<string, { path: string; before: string }>();

    constructor(private readonly context: vscode.ExtensionContext) {}

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
        const sessions = listSessions(cwd);
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
                            this.postToWebview({
                                type: "tool",
                                toolName: c.name,
                                args: c.arguments,
                            });
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

    private startClient(): void {
        if (this.client && this.client.isRunning()) {
            return;
        }
        const cfg = this.getConfig();
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
            this.postToWebview({
                type: "system",
                text: `pi 进程已退出（code=${code}）。发送消息会自动重启。`,
            });
        });

        try {
            this.client.start();
            this.postToWebview({ type: "system", text: "pi 已启动，可以开始对话。" });
        } catch (e: any) {
            this.postToWebview({ type: "systemError", text: `无法启动 pi: ${e.message}` });
        }
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
            case "abort":
                if (this.client && this.client.isRunning()) {
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
            case "setTicket":
                this.setTicket(typeof msg.ticket === "string" ? msg.ticket : "");
                break;
            case "ready":
                // Webview 加载完成
                this.sendCurrentModel();
                this.refreshStats();
                this.sendTickets();
                this.sendActiveTicket();
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
                this.postToWebview({
                    type: "tool",
                    toolName: evt.toolName,
                    args: evt.args,
                });
                break;
            case "tool_execution_end":
                this.trackEditEnd(evt);
                break;
            case "agent_settled":
            case "agent_end":
                this.streaming = false;
                this.postToWebview({ type: "streamEnd" });
                this.refreshStats();
                break;
        }
    }

    /** 清空本次对话的文件修改记录并通知 webview。 */
    private resetFileChanges(): void {
        this.fileChanges.clear();
        this.pendingEdits.clear();
        this.postFileChanges();
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

    /** 简单的行级 diff 统计（LCS），返回新增/删除行数。 */
    private diffLineCount(before: string, after: string): { added: number; removed: number } {
        const a = before.length ? before.split("\n") : [];
        const b = after.length ? after.split("\n") : [];
        const n = a.length;
        const m = b.length;
        // LCS 长度矩阵（行数不大，满足日常代码文件）
        const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                if (a[i] === b[j]) {
                    dp[i][j] = dp[i + 1][j + 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
                }
            }
        }
        const lcs = dp[0][0];
        return { added: m - lcs, removed: n - lcs };
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

    /** 设置当前工作区的激活工单（供内置 hook 读取）。 */
    private setTicket(label: string): void {
        const trimmed = label.trim();
        if (trimmed && !isValidTicket(trimmed)) {
            this.postToWebview({
                type: "systemError",
                text: "工单号需以 #+数字 开头，例如 #12031",
            });
            return;
        }
        setActiveTicket(this.getCwd(), trimmed);
        if (trimmed) {
            this.postToWebview({ type: "system", text: `已为本会话启用工单记录: ${trimmed}` });
        } else {
            this.postToWebview({ type: "system", text: "已取消工单记录。" });
        }
        this.sendTickets();
    }

    /** 把历史工单列表推送给 webview。 */
    private sendTickets(): void {
        const tickets = listTickets().map((t) => ({ id: t.id, label: t.label }));
        this.postToWebview({ type: "tickets", tickets });
    }

    /** 把当前工作区激活的工单推送给 webview（用于初始恢复）。 */
    private sendActiveTicket(): void {
        const label = getActiveTicket(this.getCwd());
        if (label) {
            this.postToWebview({ type: "activeTicket", ticket: label });
        }
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

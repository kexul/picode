import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { PiClient } from "../../../src/shared/piClient";
import { getChatHtml } from "./chatHtml";
import { listSessions } from "../../../src/shared/sessionStore";

/** 本次对话中一个被修改文件的记录。 */
interface FileChange {
    /** 绝对路径 */
    path: string;
    /** 相对工作区的显示名 */
    label: string;
    /** 首次修改前的文件内容（用于 diff 的“原始”侧）；文件新建时为空串 */
    before: string;
}

/**
 * 一个并行对话 tab 的全部运行时状态：独立的 pi 进程 + 独立的会话/编辑追踪。
 * 多个 SessionRuntime 各自持有自己的 PiClient，因此可以真正并行流式生成。
 */
class SessionRuntime {
    public id: string = "";
    public title: string = "";
    public streaming = false;
    public piReady = false;
    private client?: PiClient;
    private reqId = 0;
    private pending = new Map<string, (resp: any) => void>();
    private fileChanges = new Map<string, FileChange>();
    private pendingEdits = new Map<string, { path: string; before: string }>();
    private editSnapshots = new Map<
        string,
        { path: string; before: string; after: string }
    >();
    private forkEntries: { entryId: string; text: string }[] = [];
    public currentSessionPath: string | undefined;

    constructor(id: string, title: string, private readonly mgr: ChatViewProvider) {
        this.id = id;
        this.title = title;
    }

    /** 推送给对应 tab 的 webview 消息（自动带 tabId）。 */
    private post(msg: Record<string, unknown>): void {
        this.mgr.postToTab(this.id, msg);
    }

    /** 向 webview 同步该 tab 的会话路径（用于历史面板高亮等）。 */
    public postCurrentSession(): void {
        this.post({ type: "sessionPath", path: this.currentSessionPath ?? null });
    }

    /** 启动该 tab 的 pi 进程。 */
    public startClient(): void {
        if (this.client && this.client.isRunning()) {
            return;
        }
        this.setPiReady(false);
        const cfg = this.mgr.getConfig();

        if (!this.mgr.checkPiAvailable(cfg.piPath, this)) {
            return;
        }

        const extraArgs = cfg.trustProject
            ? [...cfg.extraArgs, "--approve"]
            : cfg.extraArgs;

        this.client = new PiClient({
            piPath: cfg.piPath,
            cwd: this.mgr.getCwd(),
            provider: cfg.provider || undefined,
            model: cfg.model || undefined,
            extraArgs,
        });

        this.client.on("event", (evt) => this.onPiEvent(evt));
        this.client.on("response", (resp) => this.onPiResponse(resp));
        this.client.on("ui", (req) => this.onPiUiRequest(req));
        this.client.on("stderr", (text: string) => {
            console.error("[pi stderr]", text);
        });
        this.client.on("error", (err: Error) => {
            this.post({ type: "systemError", text: `pi 错误: ${err.message}` });
        });
        this.client.on("exit", (code: number | null) => {
            this.streaming = false;
            this.post({ type: "streamEnd" });
            this.mgr.broadcastTabList();
            this.setPiReady(true);
            this.post({
                type: "system",
                text: `pi 进程已退出（code=${code}）。发送消息会自动重启。`,
            });
        });

        try {
            this.client.start();
            this.setPiReady(true);
            this.post({ type: "system", text: "pi 已启动，可以开始对话。" });
            this.mgr.broadcastTabList();
            void this.sendCurrentModel();
            void this.refreshStats();
        } catch (e: any) {
            this.post({ type: "systemError", text: `无法启动 pi: ${e.message}` });
        }
    }

    public stopClient(): void {
        if (this.client) {
            this.client.stop();
            this.client = undefined;
        }
    }

    public isRunning(): boolean {
        return !!this.client && this.client.isRunning();
    }

    private setPiReady(ready: boolean): void {
        this.piReady = ready;
        this.post({ type: "piReady", ready });
        this.mgr.broadcastTabList();
    }

    /** 发送当前模型信息给 webview。 */
    public async sendCurrentModel(): Promise<void> {
        const resp = await this.request({ type: "get_state" });
        const model = resp?.data?.model;
        if (model && model.id) {
            this.post({ type: "modelChanged", modelId: model.id, provider: model.provider });
        }
    }

    /** 中止该 tab 正在进行的生成 + bash 工具。 */
    public abortActiveRun(): void {
        if (this.client && this.client.isRunning() && this.streaming) {
            this.client.send({ type: "abort_bash" });
            this.client.send({ type: "abort" });
        }
    }

    /** 在该 tab 内重置为新会话（保留进程，发 new_session）。 */
    public resetSession(): void {
        this.abortActiveRun();
        this.resetFileChanges();
        this.currentSessionPath = undefined;
        this.post({ type: "clear" });
        this.post({ type: "system", text: "已开始新会话。" });
        if (this.client && this.client.isRunning()) {
            this.client.send({ type: "new_session" });
        } else {
            this.startClient();
        }
    }

    public handleSend(text: string, images?: Array<{ data: string; mimeType: string }>): void {
        const hasImages = Array.isArray(images) && images.length > 0;
        if ((!text || !text.trim()) && !hasImages) {
            return;
        }
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
        }
        this.post({
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
        if (this.streaming) {
            cmd.streamingBehavior = "steer";
        }
        try {
            this.client!.send(cmd);
        } catch (e: any) {
            this.post({ type: "systemError", text: `发送失败: ${e.message}` });
        }
    }

    /** 发送需要响应的命令，返回带 id 的响应。 */
    public request(cmd: Record<string, unknown>): Promise<any> {
        return new Promise((resolve) => {
            if (!this.client || !this.client.isRunning()) {
                resolve(undefined);
                return;
            }
            const id = `req-${++this.reqId}`;
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    resolve(undefined);
                }
            }, 15000);
            const cb = (resp: any) => {
                clearTimeout(timer);
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                }
                resolve(resp);
            };
            this.pending.set(id, cb);
            try {
                this.client!.send({ ...cmd, id });
            } catch {
                this.pending.delete(id);
                clearTimeout(timer);
                resolve(undefined);
            }
        });
    }

    // ---- pi 事件 ----
    private onPiEvent(evt: any): void {
        switch (evt.type) {
            case "agent_start":
                this.streaming = true;
                this.post({ type: "streamStart" });
                this.mgr.broadcastTabList();
                break;
            case "message_update": {
                const a = evt.assistantMessageEvent;
                if (!a) {
                    break;
                }
                if (a.type === "text_delta") {
                    this.post({ type: "assistantDelta", delta: a.delta });
                } else if (a.type === "thinking_delta") {
                    this.post({ type: "thinkingDelta", delta: a.delta });
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
                this.post({ type: "streamEnd" });
                this.refreshStats();
                this.mgr.broadcastTabList();
                break;
        }
    }

    private onPiResponse(resp: any): void {
        if (resp.id && this.pending.has(resp.id)) {
            const cb = this.pending.get(resp.id)!;
            this.pending.delete(resp.id);
            cb(resp);
            return;
        }
        if (resp.success === false && resp.error) {
            this.post({ type: "systemError", text: `pi: ${resp.error}` });
        }
    }

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
                this.post({ type: "system", text: String(req.message ?? "") });
                break;
        }
    }

    // ---- 工具追踪 / diff ----
    private onToolStart(evt: any): void {
        const toolName: string = evt.toolName;
        const isEditLike = toolName === "edit" || toolName === "write";
        const p = isEditLike ? this.editToolPath(toolName, evt.args) : null;
        if (p && evt.toolCallId) {
            this.post({
                type: "editCardStart",
                toolCallId: evt.toolCallId,
                toolName,
                path: p,
                label: this.mgr.relativeTo(this.mgr.getCwd(), p),
            });
        } else {
            this.post({
                type: "tool",
                toolCallId: evt.toolCallId,
                toolName,
                args: evt.args,
            });
        }
    }

    private onToolEnd(evt: any): void {
        const toolName: string = evt.toolName;
        if (toolName !== "edit" && toolName !== "write") {
            if (evt.toolCallId) {
                this.post({
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
        this.post({
            type: "editCardResult",
            toolCallId: evt.toolCallId,
            diff: typeof details?.diff === "string" ? details.diff : undefined,
            isError: !!evt.isError,
            errorText,
            canRevert: !evt.isError && this.editSnapshots.has(evt.toolCallId),
        });
    }

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

    private resetFileChanges(): void {
        this.fileChanges.clear();
        this.pendingEdits.clear();
        this.editSnapshots.clear();
        this.postFileChanges();
    }

    private postFileChanges(): void {
        const files = Array.from(this.fileChanges.values()).map((c) => ({
            path: c.path,
            label: c.label,
        }));
        this.post({ type: "fileChanges", files });
    }

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
        return this.mgr.resolvePath(raw);
    }

    private trackEditStart(evt: any): void {
        const p = this.editToolPath(evt.toolName, evt.args);
        if (!p || !evt.toolCallId) {
            return;
        }
        let before = "";
        try {
            before = fs.readFileSync(p, "utf8");
        } catch {
            before = "";
        }
        this.pendingEdits.set(evt.toolCallId, { path: p, before });
    }

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
            return;
        }
        this.editSnapshots.set(id, { path: pend.path, before: pend.before, after });
        const existing = this.fileChanges.get(pend.path);
        if (!existing) {
            this.fileChanges.set(pend.path, {
                path: pend.path,
                label: this.mgr.relativeTo(this.mgr.getCwd(), pend.path),
                before: pend.before,
            });
        }
        this.postFileChanges();
    }

    public async revertEdit(toolCallId: string): Promise<void> {
        const snap = this.editSnapshots.get(toolCallId);
        if (!snap) {
            this.post({ type: "systemError", text: "无法回滚：缺失修改前的快照。" });
            return;
        }
        const label = this.mgr.relativeTo(this.mgr.getCwd(), snap.path);

        let current = "";
        try {
            current = fs.readFileSync(snap.path, "utf8");
        } catch {
            current = "";
        }
        if (current === snap.before) {
            this.post({ type: "system", text: `无需回滚：${label} 已是修改前的内容。` });
            this.post({ type: "editReverted", toolCallId });
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

        try {
            fs.writeFileSync(snap.path, snap.before, "utf8");
        } catch (e: any) {
            this.post({ type: "systemError", text: `回滚失败: ${e.message}` });
            return;
        }

        const existing = this.fileChanges.get(snap.path);
        if (existing) {
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

        this.editSnapshots.delete(toolCallId);
        this.post({ type: "editReverted", toolCallId });
        this.post({ type: "system", text: `已回滚: ${label}` });
    }

    private historyEditInfo(call: any, result: any): string | undefined {
        const details = result?.details;
        let diff: string | undefined =
            typeof details?.diff === "string" ? details.diff : undefined;

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
        return diff;
    }

    // ---- 会话加载 / 树 / fork ----
    public async loadSession(file: string): Promise<void> {
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
            // 等待客户端就绪后再发 switch
            await new Promise((r) => setTimeout(r, 100));
        }
        this.resetFileChanges();
        this.post({ type: "clear" });
        this.post({ type: "system", text: "正在加载会话…" });

        const switchResp = await this.request({ type: "switch_session", sessionPath: file });
        if (!switchResp || switchResp.success === false) {
            this.post({
                type: "systemError",
                text: `加载会话失败: ${switchResp?.error ?? "未知错误"}`,
            });
            return;
        }

        const [msgResp, forkResp] = await Promise.all([
            this.request({ type: "get_messages" }),
            this.request({ type: "get_fork_messages" }),
        ]);
        const messages: any[] = msgResp?.data?.messages ?? [];
        this.forkEntries = forkResp?.data?.messages ?? [];
        this.renderMessages(messages);
        this.currentSessionPath = file;
        this.post({ type: "system", text: `已加载会话（${messages.length} 条消息）。` });
        this.refreshStats();
    }

    public async showTree(): Promise<void> {
        const resp = await this.request({ type: "get_tree" });
        if (!resp || resp.success === false) {
            this.post({
                type: "systemError",
                text: `获取对话树失败: ${resp?.error ?? "未知错误"}`,
            });
            return;
        }
        this.post({
            type: "treeView",
            tree: resp.data?.tree ?? [],
            leafId: resp.data?.leafId ?? null,
        });
    }

    public async forkFromEntry(entryId: string): Promise<void> {
        this.abortActiveRun();
        this.post({ type: "system", text: "正在从该消息处分叉…" });
        const resp = await this.request({ type: "fork", entryId });
        if (!resp || resp.success === false) {
            this.post({
                type: "systemError",
                text: `分叉失败: ${resp?.error ?? "未知错误"}`,
            });
            return;
        }
        if (resp.data?.cancelled) {
            this.post({ type: "system", text: "分叉已取消。" });
            return;
        }
        this.resetFileChanges();
        const [msgResp, forkResp] = await Promise.all([
            this.request({ type: "get_messages" }),
            this.request({ type: "get_fork_messages" }),
        ]);
        const messages: any[] = msgResp?.data?.messages ?? [];
        this.forkEntries = forkResp?.data?.messages ?? [];
        this.post({ type: "clear" });
        this.renderMessages(messages);
        this.post({ type: "system", text: `已分叉到新分支（${messages.length} 条消息）。` });
        this.refreshStats();
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

    private renderMessages(messages: any[]): void {
        const toolResults = new Map<string, any>();
        for (const m of messages) {
            if (m && m.role === "toolResult" && typeof m.toolCallId === "string") {
                toolResults.set(m.toolCallId, m);
            }
        }
        let userIndex = 0;
        for (const m of messages) {
            switch (m.role) {
                case "user":
                    this.post({
                        type: "userMessage",
                        text: this.textOf(m.content),
                        entryId: this.forkEntries[userIndex]?.entryId,
                    });
                    userIndex++;
                    break;
                case "assistant": {
                    const parts = Array.isArray(m.content) ? m.content : [];
                    let text = "";
                    for (const c of parts) {
                        if (c.type === "text") {
                            text += c.text;
                        } else if (c.type === "toolCall") {
                            if (text.trim()) {
                                this.post({ type: "assistantFull", text });
                                text = "";
                            }
                            if (c.name === "edit" || c.name === "write") {
                                const p = this.editToolPath(c.name, c.arguments);
                                const id = c.id || `hist-${Math.random()}`;
                                this.post({
                                    type: "editCardStart",
                                    toolCallId: id,
                                    toolName: c.name,
                                    path: p || "",
                                    label: p ? this.mgr.relativeTo(this.mgr.getCwd(), p) : "",
                                });
                                this.post({
                                    type: "editCardResult",
                                    toolCallId: id,
                                    diff: this.historyEditInfo(c, toolResults.get(id)),
                                    canRevert: false,
                                });
                            } else {
                                this.post({
                                    type: "tool",
                                    toolName: c.name,
                                    args: c.arguments,
                                });
                            }
                        }
                    }
                    if (text.trim()) {
                        this.post({ type: "assistantFull", text });
                    }
                    break;
                }
            }
        }
    }

    public async pickModel(): Promise<void> {
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
            this.post({ type: "systemError", text: `切换模型失败: ${setResp.error}` });
        } else {
            const m = setResp?.data ?? picked.model;
            this.post({ type: "modelChanged", modelId: m.id, provider: m.provider });
            this.post({ type: "system", text: `已切换模型: ${m.id}` });
            const cfg = vscode.workspace.getConfiguration("piChat");
            cfg.update("provider", m.provider || "", vscode.ConfigurationTarget.Global);
            cfg.update("model", m.id || "", vscode.ConfigurationTarget.Global);
        }
    }

    public async refreshStats(): Promise<void> {
        const resp = await this.request({ type: "get_session_stats" });
        const d = resp?.data;
        if (!d) {
            return;
        }
        this.post({
            type: "stats",
            tokens: d.tokens || null,
            cost: typeof d.cost === "number" ? d.cost : null,
            contextUsage: d.contextUsage || null,
        });
    }

    // ---- 文件跳转 / diff（均相对该 tab 的 fileChanges）----
    public async openDiff(p: string): Promise<void> {
        const change = this.fileChanges.get(p);
        if (!change) {
            vscode.window.showWarningMessage(`piChat: 未找到该文件的修改记录 (${p})。可能会话已重置或路径不匹配。`);
            return;
        }
        const label = change.label;
        const key = DiffContentProvider.instance.set(change.before);
        const leftUri = vscode.Uri.parse(
            `${DiffContentProvider.scheme}:${encodeURIComponent(label)}?${key}`
        );
        const rightUri = vscode.Uri.file(p);
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

    public async openEditLocationWithAnchor(p: string, line: number, anchor: string): Promise<void> {
        let current = "";
        try {
            current = fs.readFileSync(p, "utf8");
        } catch {
            await this.openEditLocation(p, line);
            return;
        }
        await this.openEditLocation(p, this.resolveAnchorLine(current, anchor, line));
    }

    public async openEditLocation(p: string, line: number): Promise<void> {
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

    private resolveAnchorLine(currentText: string, anchor: string, fallbackLine: number): number {
        if (!anchor) {
            return fallbackLine;
        }
        const lines = currentText.split("\n");
        const fb0 = Math.max(0, fallbackLine - 1);
        if (lines[fb0] === anchor) {
            return fallbackLine;
        }
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
        for (let k = 0; k < lines.length; k++) {
            if (lines[k] === anchor) {
                return k + 1;
            }
        }
        return Math.min(fallbackLine, Math.max(lines.length, 1));
    }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "piChat.chatView";

    private view?: vscode.WebviewView;
    private tabs = new Map<string, SessionRuntime>();
    private activeId: string | undefined;
    private tabSeq = 0;
    private autoLoadDone = false;

    constructor(private readonly context: vscode.ExtensionContext) {}

    private static readonly KEY_SHOW_STATS = "piChat.showStatsBar";
    private static readonly KEY_AUTO_LOAD_LAST = "piChat.autoLoadLastSession";
    private static readonly KEY_SEND_KEY = "piChat.sendKey";
    private static readonly SEND_KEYS = ["enter", "shift+enter", "alt+enter", "ctrl+enter"] as const;

    // ---- 显示选项 ----
    private getShowStatsBar(): boolean {
        return this.context.globalState.get<boolean>(ChatViewProvider.KEY_SHOW_STATS, true);
    }
    private getAutoLoadLast(): boolean {
        return this.context.globalState.get<boolean>(ChatViewProvider.KEY_AUTO_LOAD_LAST, false);
    }
    private getSendKey(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_SEND_KEY, "enter");
        return (ChatViewProvider.SEND_KEYS as readonly string[]).includes(v) ? v : "enter";
    }
    private sendViewOptions(): void {
        this.postToWebview({
            type: "viewOptions",
            showStatsBar: this.getShowStatsBar(),
            autoLoadLastSession: this.getAutoLoadLast(),
            sendKey: this.getSendKey(),
        });
    }

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
            if (!sel) { return; }
            if (sel.action === "sendKey") {
                const order = ChatViewProvider.SEND_KEYS;
                const idx = order.indexOf(this.getSendKey() as (typeof order)[number]);
                const next = order[(idx + 1) % order.length];
                this.context.globalState.update(ChatViewProvider.KEY_SEND_KEY, next);
            } else {
                const cur =
                    sel.action === ChatViewProvider.KEY_SHOW_STATS
                        ? this.getShowStatsBar()
                        : this.getAutoLoadLast();
                this.context.globalState.update(sel.action, !cur);
            }
            this.sendViewOptions();
            const activeAction = sel.action;
            qp.items = buildItems();
            const again = qp.items.find((i) => i.action === activeAction);
            if (again) { qp.activeItems = [again]; }
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
            for (const rt of this.tabs.values()) {
                rt.stopClient();
            }
            this.tabs.clear();
            this.activeId = undefined;
        });
    }

    // ---- 共享工具 ----
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

    public relativeTo(cwd: string, full: string): string {
        const norm = (s: string) => s.replace(/\\/g, "/");
        const c = norm(cwd).replace(/\/$/, "") + "/";
        const f = norm(full);
        if (f.toLowerCase().startsWith(c.toLowerCase())) {
            return f.slice(c.length);
        }
        return full;
    }

    public resolvePath(p: string): string {
        if (path.isAbsolute(p)) {
            return p;
        }
        return path.resolve(this.getCwd(), p);
    }

    public checkPiAvailable(piPath: string, rt: SessionRuntime): boolean {
        if (this.resolveExecutable(piPath)) {
            return true;
        }
        const msg = `未找到 pi 可执行文件（当前配置："${piPath}"）。请确认已安装 pi 并加入系统 PATH，或在设置中指定 piChat.piPath 为完整路径。`;
        this.mgrPostError(rt, msg);
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

    /** 给某个 runtime 推一条 systemError（绕过 private post）。 */
    private mgrPostError(rt: SessionRuntime, text: string): void {
        this.postToTab(rt.id, { type: "systemError", text });
    }

    public resolveExecutable(cmd: string): string | undefined {
        if (!cmd) { return undefined; }
        const isWindows = process.platform === "win32";
        const exts = isWindows
            ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
            : [""];
        const existsAsFile = (p: string): boolean => {
            try { return fs.statSync(p).isFile(); } catch { return false; }
        };
        const tryWithExts = (base: string): string | undefined => {
            if (existsAsFile(base)) { return base; }
            if (isWindows) {
                for (const ext of exts) {
                    const withExt = base + ext.toLowerCase();
                    if (existsAsFile(withExt)) { return withExt; }
                    const withExtUpper = base + ext;
                    if (existsAsFile(withExtUpper)) { return withExtUpper; }
                }
            }
            return undefined;
        };
        if (cmd.includes("/") || cmd.includes("\\")) {
            const abs = path.isAbsolute(cmd) ? cmd : path.resolve(this.getCwd(), cmd);
            return tryWithExts(abs);
        }
        const pathEnv = process.env.PATH || process.env.Path || "";
        const sep = isWindows ? ";" : ":";
        for (const dir of pathEnv.split(sep).filter(Boolean)) {
            const found = tryWithExts(path.join(dir, cmd));
            if (found) { return found; }
        }
        return undefined;
    }

    // ---- tab 管理 ----
    public newTab(): SessionRuntime {
        const id = `tab-${++this.tabSeq}`;
        const title = `会话 ${this.tabSeq}`;
        const rt = new SessionRuntime(id, title, this);
        this.tabs.set(id, rt);
        this.activeId = id;
        this.broadcastTabList();
        this.postToWebview({ type: "tabActivated", id });
        rt.startClient();
        return rt;
    }

    public setActive(id: string): void {
        if (!this.tabs.has(id) || this.activeId === id) {
            return;
        }
        this.activeId = id;
        this.postToWebview({ type: "tabActivated", id });
        this.broadcastTabList();
    }

    public closeTab(id: string): void {
        const rt = this.tabs.get(id);
        if (!rt) { return; }
        rt.stopClient();
        this.tabs.delete(id);
        this.postToWebview({ type: "tabClosed", id });
        if (this.activeId === id) {
            this.activeId = this.tabs.size > 0 ? this.tabs.keys().next().value : undefined;
            if (this.activeId) {
                this.postToWebview({ type: "tabActivated", id: this.activeId });
            }
        }
        this.broadcastTabList();
        // 全部关闭后自动新建一个空 tab，保持界面可用
        if (this.tabs.size === 0) {
            this.newTab();
        }
    }

    public getActive(): SessionRuntime | undefined {
        return this.activeId ? this.tabs.get(this.activeId) : undefined;
    }

    /** 同步 tab 列表给 webview（含 streaming/piReady 用于角标）。 */
    public broadcastTabList(): void {
        this.postToWebview({
            type: "tabList",
            tabs: Array.from(this.tabs.values()).map((rt) => ({
                id: rt.id,
                title: rt.title,
                streaming: rt.streaming,
                piReady: rt.piReady,
            })),
            activeId: this.activeId ?? null,
        });
    }

    public postToTab(tabId: string, msg: Record<string, unknown>): void {
        this.view?.webview.postMessage({ ...msg, tabId });
    }

    private postToWebview(msg: Record<string, unknown>): void {
        this.view?.webview.postMessage(msg);
    }

    // ---- 命令入口 ----
    /** 新建并行会话。 */
    public newSession(): void {
        this.newTab();
    }

    public getCurrentSessionPath(): string | undefined {
        return this.getActive()?.currentSessionPath;
    }

    public async loadHistorySession(file: string): Promise<void> {
        // 在活跃 tab 加载；若无 tab 则新建
        let rt = this.getActive();
        if (!rt) {
            rt = this.newTab();
            await new Promise((r) => setTimeout(r, 150));
        }
        this.setActive(rt.id);
        await rt.loadSession(file);
        await vscode.commands.executeCommand("workbench.view.extension.piChatContainer");
        await vscode.commands.executeCommand("piChat.chatView.focus");
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

    private async ensureViewVisible(): Promise<void> {
        await vscode.commands.executeCommand("piChat.openChat");
        for (let i = 0; i < 60; i++) {
            if (this.view) { return; }
            await new Promise((r) => setTimeout(r, 50));
        }
    }

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
        if (!picked) { return; }
        const rt = this.getActive() ?? this.newTab();
        this.setActive(rt.id);
        await rt.loadSession(picked.file);
    }

    private async maybeAutoLoadLastSession(): Promise<void> {
        if (this.autoLoadDone) { return; }
        this.autoLoadDone = true;
        if (!this.getAutoLoadLast()) { return; }
        const sessions = await listSessions(this.getCwd());
        if (sessions.length === 0) { return; }
        const rt = this.getActive();
        if (rt) {
            await rt.loadSession(sessions[0].file);
        }
    }

    /** 将 VSCode 当前打开的文件列表发给 webview（用于 @ 引用补全）。 */
    private sendOpenFiles(): void {
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

    // ---- Webview -> 扩展 ----
    private onWebviewMessage(msg: any): void {
        // 全局消息（不带 tabId）
        switch (msg.type) {
            case "ready": {
                this.sendViewOptions();
                this.broadcastTabList();
                // 确保至少有一个 tab
                if (this.tabs.size === 0) {
                    this.newTab();
                    this.maybeAutoLoadLastSession();
                } else {
                    // 已有 tab：同步各 tab 的 piReady
                    for (const rt of this.tabs.values()) {
                        this.postToTab(rt.id, { type: "piReady", ready: rt.piReady });
                    }
                }
                if (this.activeId) {
                    this.postToWebview({ type: "tabActivated", id: this.activeId });
                }
                return;
            }
            case "newSession":
                this.newTab();
                return;
            case "switchTab":
                if (typeof msg.tabId === "string") { this.setActive(msg.tabId); }
                return;
            case "closeTab":
                if (typeof msg.tabId === "string") { this.closeTab(msg.tabId); }
                return;
            case "listFiles":
                this.sendOpenFiles();
                return;
            case "openFile":
                if (typeof msg.path === "string") {
                    void this.openFile(msg.path, typeof msg.line === "number" ? msg.line : undefined, typeof msg.col === "number" ? msg.col : undefined);
                }
                return;
            case "openSymbol":
                if (typeof msg.name === "string") { void this.openSymbol(msg.name); }
                return;
        }

        // tab 级消息
        const tabId: string | undefined = msg.tabId;
        const rt = tabId ? this.tabs.get(tabId) : undefined;
        // 命令型消息（pickModel 等）回退到活跃 tab
        const target = rt ?? (msg.type === "pickModel" ? this.getActive() : undefined);
        if (!target) { return; }

        switch (msg.type) {
            case "send":
                target.handleSend(msg.text, msg.images);
                break;
            case "abort":
                target.abortActiveRun();
                break;
            case "showTree":
                void target.showTree();
                break;
            case "forkAtEntry":
                if (typeof msg.entryId === "string") { void target.forkFromEntry(msg.entryId); }
                break;
            case "pickModel":
                void target.pickModel();
                break;
            case "openDiff":
                if (typeof msg.path === "string") { void target.openDiff(msg.path); }
                break;
            case "openEditLocation":
                if (typeof msg.path === "string" && typeof msg.anchor === "string" && msg.anchor) {
                    void target.openEditLocationWithAnchor(
                        msg.path,
                        typeof msg.line === "number" ? msg.line : 1,
                        msg.anchor
                    );
                } else if (typeof msg.path === "string") {
                    void target.openEditLocation(msg.path, typeof msg.line === "number" ? msg.line : 1);
                }
                break;
            case "revertEdit":
                if (typeof msg.toolCallId === "string") { void target.revertEdit(msg.toolCallId); }
                break;
        }
    }
}

/**
 * 为 diff 提供“修改前”的只读虚拟文档内容。
 * URI 方案：pichat-diff:<encoded-path>?<nonce>
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = "pichat-diff";
    public static readonly instance = new DiffContentProvider();

    private contents = new Map<string, string>();
    private seq = 0;

    set(content: string): string {
        const key = String(++this.seq);
        this.contents.set(key, content);
        return key;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.query) ?? "";
    }
}

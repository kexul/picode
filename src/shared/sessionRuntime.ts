import * as fs from "fs";
import { PiClient } from "./piClient";

/** 平台无关的 pi 运行时配置（vscode / electron 共用）。 */
export interface PiConfig {
    piPath: string;
    provider: string;
    model: string;
    extraArgs: string[];
    trustProject: boolean;
}

/** 本次对话中一个被修改文件的记录。 */
export interface FileChange {
    /** 绝对路径 */
    path: string;
    /** 相对工作区的显示名 */
    label: string;
    /** 首次修改前的文件内容（用于 diff 的“原始”侧）；文件新建时为空串 */
    before: string;
}

/** 可选模型信息（来自 pi get_available_models）。 */
export interface ModelInfo {
    id: string;
    provider?: string;
    name?: string;
    contextWindow?: number;
}

/** 用户在模型选择器中选中的结果。 */
export interface ModelChoice {
    provider: string;
    modelId: string;
    thinkingLevel?: string;
}

/**
 * 平台适配层：隔离 VSCode 与 Electron 的差异。
 *
 * shared 的 SessionRuntime 只依赖本接口 + PiClient + Node 内置 fs，
 * 不引用 `vscode`，因此两端的 tsc 都能编译。
 */
export interface RuntimeHost {
    getConfig(): PiConfig;
    getCwd(): string;
    relativeTo(cwd: string, full: string): string;
    resolvePath(p: string): string;
    /** 校验 pi 可执行文件存在；失败时自行向 tab 推送 systemError。返回是否可用。 */
    checkPiAvailable(piPath: string, tabId: string): boolean;

    postToTab(tabId: string, msg: Record<string, unknown>): void;
    broadcastTabList(): void;
    /** 当某 tab 的会话路径变化（且可能为活跃 tab）时通知宿主。可选。 */
    onSessionChanged?(tabId: string, sessionPath: string | undefined): void;

    // ---- UI 弹窗（对应当 pi 的 extension_ui_request）----
    confirmDialog(title: string, message: string): Promise<boolean>;
    selectDialog(title: string, options: string[]): Promise<string | undefined>;
    inputDialog(title: string, placeholder: string, prefill: string): Promise<string | undefined>;
    /** 模型选择器；取消返回 undefined。同时返回可选的思考强度及当前值。 */
    pickModelInteractive(
        models: ModelInfo[],
        thinkingLevels: string[],
        currentThinking: string,
        currentModelId: string
    ): Promise<ModelChoice | undefined>;
    /** 持久化用户选中的 model（写各自配置存储）。 */
    persistModel(provider: string, modelId: string): void;

    // ---- 文件跳转 / diff ----
    /** 打开文件到指定行（1-based）。anchor 为高亮定位行文本，可选。 */
    openFileLocation(path: string, line: number, anchor?: string): void;
    /** 打开本次会话修改文件的 diff 或查看器。 */
    openDiff(change: FileChange): void;
    /** 回滚前的二次确认（文件在修改后又被改动时）。返回是否继续。 */
    confirmRevert(label: string): Promise<boolean>;
}

/**
 * 一个并行对话 tab 的全部运行时状态：独立的 pi 进程 + 独立的会话/编辑追踪。
 * 多个 SessionRuntime 各自持有自己的 PiClient，因此可以真正并行流式生成。
 *
 * 平台差异（UI 弹窗、diff、文件打开、配置持久化）全部经由 RuntimeHost 注入，
 * 本类不引用 `vscode`，供 VSCode 插件与 Electron 客户端共用。
 */
export class SessionRuntime {
    public id: string = "";
    public title: string = "";
    public streaming = false;
    public piReady = false;
    public currentSessionPath: string | undefined;

    private client?: PiClient;
    private reqId = 0;
    private pending = new Map<string, (resp: any) => void>();
    private fileChanges = new Map<string, FileChange>();
    private pendingEdits = new Map<string, { path: string; before: string }>();
    private editSnapshots = new Map<string, { path: string; before: string; after: string }>();
    private forkEntries: { entryId: string; text: string }[] = [];

    constructor(id: string, title: string, private readonly host: RuntimeHost) {
        this.id = id;
        this.title = title;
    }

    /** 推送给对应 tab 的消息（自动带 tabId）。 */
    private post(msg: Record<string, unknown>): void {
        this.host.postToTab(this.id, msg);
    }

    /** 启动该 tab 的 pi 进程。 */
    public startClient(): void {
        if (this.client && this.client.isRunning()) {
            return;
        }
        this.setPiReady(false);
        const cfg = this.host.getConfig();

        if (!this.host.checkPiAvailable(cfg.piPath, this.id)) {
            return;
        }

        const extraArgs = cfg.trustProject
            ? [...cfg.extraArgs, "--approve"]
            : cfg.extraArgs;

        this.client = new PiClient({
            piPath: cfg.piPath,
            cwd: this.host.getCwd(),
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
            // 进程退出时清理所有在途请求，避免它们挂到超时才返回
            for (const cb of this.pending.values()) {
                cb(undefined);
            }
            this.pending.clear();
            this.post({ type: "streamEnd" });
            this.host.broadcastTabList();
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
            this.host.broadcastTabList();
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
        this.host.broadcastTabList();
    }

    /** 发送当前模型信息给 webview。 */
    public async sendCurrentModel(): Promise<void> {
        const resp = await this.request({ type: "get_state" });
        const model = resp?.data?.model;
        if (model && model.id) {
            this.post({ type: "modelChanged", modelId: model.id, provider: model.provider });
        }
        const thinkingLevel = resp?.data?.thinkingLevel;
        if (thinkingLevel) {
            this.post({ type: "thinkingChanged", level: thinkingLevel });
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
        this.host.onSessionChanged?.(this.id, this.currentSessionPath);
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
        // user 气泡统一由 pi 的 message_start 事件渲染（见 onPiEvent），
        // 普通消息与 steer 投递的排队消息走同一路径，避免双发。

        // 流式响应中：发 steer 命令把消息排入 steering 队列（当前轮工具执行完后投递），
        // 与 pi TUI 按 Enter 的语义一致；否则发普通 prompt 开启新轮。
        const cmd: Record<string, unknown> = this.streaming
            ? { type: "steer", message: text || "" }
            : { type: "prompt", message: text || "" };
        if (hasImages) {
            cmd.images = images!.map((img) => ({
                type: "image",
                data: img.data,
                mimeType: img.mimeType,
            }));
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
            case "queue_update":
                // steering/followUp 队列变化（steer 排队/投递/abort 后清空）
                this.post({
                    type: "queueUpdate",
                    steering: Array.isArray(evt.steering) ? evt.steering : [],
                    followUp: Array.isArray(evt.followUp) ? evt.followUp : [],
                });
                break;
            case "message_start": {
                // pi 推送 user 消息开始（含 steer 投递的排队消息）：统一在此渲染 user 气泡，
                // 替代 handleSend 里的主动 post，使普通/steer 两种路径行为一致。
                const m = evt.message;
                if (m && m.role === "user") {
                    const parts = Array.isArray(m.content) ? m.content : [];
                    const imgs = parts.filter((c: any) => c && c.type === "image").length;
                    this.post({
                        type: "userMessage",
                        text: this.textOf(m.content),
                        imageCount: imgs > 0 ? imgs : 0,
                    });
                }
                break;
            }
            case "agent_start":
                this.streaming = true;
                this.post({ type: "streamStart" });
                this.host.broadcastTabList();
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
                this.host.broadcastTabList();
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
                this.host
                    .confirmDialog(req.title ?? "确认", req.message ?? "")
                    .then((ok) => respond({ confirmed: ok }));
                break;
            case "select":
                this.host
                    .selectDialog(req.title, req.options ?? [])
                    .then((value) =>
                        value === undefined ? respond({ cancelled: true }) : respond({ value })
                    );
                break;
            case "input":
            case "editor":
                this.host
                    .inputDialog(req.title, req.placeholder, req.prefill)
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
                label: this.host.relativeTo(this.host.getCwd(), p),
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
        return this.host.resolvePath(raw);
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
                label: this.host.relativeTo(this.host.getCwd(), pend.path),
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
        const label = this.host.relativeTo(this.host.getCwd(), snap.path);

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
            const ok = await this.host.confirmRevert(
                `${label} 在此次修改后又被变更过，回滚将丢弃那些后续变更。确定继续？`
            );
            if (!ok) {
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
        this.host.onSessionChanged?.(this.id, this.currentSessionPath);
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
        const [msgResp, forkResp, stateResp] = await Promise.all([
            this.request({ type: "get_messages" }),
            this.request({ type: "get_fork_messages" }),
            this.request({ type: "get_state" }),
        ]);
        const messages: any[] = msgResp?.data?.messages ?? [];
        this.forkEntries = forkResp?.data?.messages ?? [];
        // fork 会切换到新的分支会话文件，需同步路径
        if (stateResp?.data?.sessionFile) {
            this.currentSessionPath = stateResp.data.sessionFile;
            this.host.onSessionChanged?.(this.id, this.currentSessionPath);
        }
        this.post({ type: "clear" });
        this.renderMessages(messages);
        this.post({ type: "system", text: `已分叉到新分支（${messages.length} 条消息）。` });
        this.refreshStats();
    }

    /**
     * 加载指定会话文件后，从 entryId 处分叉到新分支。
     * 用于“在新 tab 打开分支”：由新建的空 tab 调用本方法，源 tab 完全不受影响。
     */
    public async loadSessionAndFork(sessionPath: string, entryId: string): Promise<void> {
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
            await new Promise((r) => setTimeout(r, 100));
        }
        this.resetFileChanges();
        this.post({ type: "clear" });
        this.post({ type: "system", text: "正在加载源会话并分叉…" });

        // 1. 加载源会话（不修改源文件）
        const switchResp = await this.request({ type: "switch_session", sessionPath });
        if (!switchResp || switchResp.success === false) {
            this.post({
                type: "systemError",
                text: `加载源会话失败: ${switchResp?.error ?? "未知错误"}`,
            });
            return;
        }
        this.currentSessionPath = sessionPath;
        this.host.onSessionChanged?.(this.id, this.currentSessionPath);

        // 2. 在该 entry 处分叉：创建新分支会话文件并切换到它
        const forkResp = await this.request({ type: "fork", entryId });
        if (!forkResp || forkResp.success === false) {
            this.post({
                type: "systemError",
                text: `分叉失败: ${forkResp?.error ?? "未知错误"}`,
            });
            return;
        }
        if (forkResp.data?.cancelled) {
            this.post({ type: "system", text: "分叉已取消。" });
        }

        // 3. 读取新分支消息并同步会话路径
        const [msgResp, forkMsgResp, stateResp] = await Promise.all([
            this.request({ type: "get_messages" }),
            this.request({ type: "get_fork_messages" }),
            this.request({ type: "get_state" }),
        ]);
        const messages: any[] = msgResp?.data?.messages ?? [];
        this.forkEntries = forkMsgResp?.data?.messages ?? [];
        if (stateResp?.data?.sessionFile) {
            this.currentSessionPath = stateResp.data.sessionFile;
            this.host.onSessionChanged?.(this.id, this.currentSessionPath);
        }
        this.post({ type: "clear" });
        this.renderMessages(messages);
        this.post({ type: "system", text: `已在新 tab 打开新分支（${messages.length} 条消息）。` });
        this.refreshStats();
        void this.sendCurrentModel();
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
                                    label: p ? this.host.relativeTo(this.host.getCwd(), p) : "",
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
        const [resp, levelsResp, stateResp] = await Promise.all([
            this.request({ type: "get_available_models" }),
            this.request({ type: "get_available_thinking_levels" }),
            this.request({ type: "get_state" }),
        ]);
        const models: ModelInfo[] = resp?.data?.models ?? [];
        if (models.length === 0) {
            this.post({
                type: "system",
                text: "没有可用模型（请确认 pi 已鉴权、models.json 已配置）。",
            });
            return;
        }
        const thinkingLevels: string[] = levelsResp?.data?.levels ?? [];
        const currentThinking: string = stateResp?.data?.thinkingLevel ?? "";
        const currentModelId = stateResp?.data?.model?.id ?? "";
        const choice = await this.host.pickModelInteractive(
            models,
            thinkingLevels,
            currentThinking,
            currentModelId
        );
        if (!choice) {
            return;
        }
        const setResp = await this.request({
            type: "set_model",
            provider: choice.provider,
            modelId: choice.modelId,
        });
        if (setResp?.success === false) {
            this.post({ type: "systemError", text: `切换模型失败: ${setResp.error}` });
            return;
        }
        const m = setResp?.data ?? { id: choice.modelId, provider: choice.provider };
        this.post({ type: "modelChanged", modelId: m.id, provider: m.provider });
        this.post({ type: "system", text: `已切换模型: ${m.id}` });
        this.host.persistModel(m.provider || "", m.id || "");
        // 同步思考强度（切换模型可能改变可用/当前 thinking level）
        await this.sendCurrentModel();
        // 若用户选了思考强度，单独设置
        if (choice.thinkingLevel && thinkingLevels.includes(choice.thinkingLevel)) {
            const tResp = await this.request({ type: "set_thinking_level", level: choice.thinkingLevel });
            if (tResp?.success === false) {
                this.post({ type: "systemError", text: `设置思考强度失败: ${tResp.error}` });
            } else {
                this.post({ type: "thinkingChanged", level: choice.thinkingLevel });
            }
        }
    }

    /** 设置思考强度，返回是否成功。 */
    public async setThinkingLevel(level: string): Promise<boolean> {
        if (!this.client || !this.client.isRunning()) { return false; }
        const resp = await this.request({ type: "set_thinking_level", level });
        if (resp?.success === false) {
            this.post({ type: "systemError", text: `设置思考强度失败: ${resp.error}` });
            return false;
        }
        this.post({ type: "thinkingChanged", level });
        return true;
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
            this.post({
                type: "systemError",
                text: `未找到该文件的修改记录 (${p})。可能会话已重置或路径不匹配。`,
            });
            return;
        }
        this.host.openDiff(change);
    }

    public async openEditLocationWithAnchor(p: string, line: number, anchor: string): Promise<void> {
        let current = "";
        try {
            current = fs.readFileSync(p, "utf8");
        } catch {
            this.host.openFileLocation(p, line);
            return;
        }
        this.host.openFileLocation(p, this.resolveAnchorLine(current, anchor, line), anchor);
    }

    public openEditLocation(p: string, line: number): void {
        this.host.openFileLocation(p, line);
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

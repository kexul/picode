import * as fs from "fs";
import { PiClient } from "./piClient";
import { NameParts, composeName } from "./names";
import { EditTracker } from "./editTracker";
import {
    countImages,
    extractResultText,
    extractTruncation,
    formatPiError,
    getModelThinkingLevels,
    summarizeToolCall,
    resolveAnchorLine,
    slimTree,
    textOf,
} from "./messageUtils";
import {
    forkSelectedText,
    isRpcOk,
    rpcErrorMessage,
    type RpcForkMessage,
    type RpcForkResult,
    type RpcModelInfo,
    type RpcResponse,
    type RpcSessionStats,
    type RpcSessionState,
    type RpcTreeNode,
} from "./piRpc";
import type {
    ModelInfo,
    RuntimeActivity,
    RuntimeHost,
} from "./runtimeTypes";

// 对外仍从 sessionRuntime 导出类型，保持既有 import 路径稳定。
export type {
    FileChange,
    ModelChoice,
    ModelInfo,
    PiConfig,
    RuntimeActivity,
    RuntimeHost,
    StatusInfo,
} from "./runtimeTypes";

/**
 * 一个并行对话 tab 的全部运行时状态：独立的 pi 进程 + 独立的会话/编辑追踪。
 * 多个 SessionRuntime 各自持有自己的 PiClient，因此可以真正并行流式生成。
 *
 * 平台差异（UI 弹窗、diff、文件打开、配置持久化）全部经由 RuntimeHost 注入，
 * 本类不引用 `vscode`。消息/树/工具结果的纯逻辑见 messageUtils；RPC 类型见 piRpc。
 */
export class SessionRuntime {
    public id: string = "";
    /** 名字两部分（形容词/名词）：创建时分配后终身不变；
     *  title 供 pane-head / picker / 导出，tab 栏派生名另由宿主用 noun 拼接。 */
    public readonly nameParts: NameParts = { adjective: "", noun: "" };

    /** 完整显示名（“沉静的雪豹”）。 */
    public get title(): string { return composeName(this.nameParts); }
    /** 名词部分：tab 栏多 panel 拼接名只用它。 */
    public get noun(): string { return this.nameParts.noun; }
    /** Agent 是否仍在运行；这是 steer / Esc 等整体生命周期判断使用的状态。 */
    public streaming = false;
    /** Agent 当前更细的活动阶段，供 webview 区分处理中 / 思考 / 工具调用。 */
    public activity: RuntimeActivity = "idle";
    /** 当前阶段的附加信息，例如正在执行的工具名。 */
    public activityDetail = "";
    public piReady = false;
    /** 正在加载会话 / 分叉（pi 冷启动 + 切换会话期间为 true，供宿主展示加载态）。 */
    public loading = false;
    public currentSessionPath: string | undefined;

    // ---- 当前状态快照（供 host.onStatusUpdate 上报，如 VSCode 状态栏）----
    private statusModelId?: string;
    private statusProvider?: string;
    private statusThinking?: string;
    private statusPercent?: number;
    private statusTokens?: number;
    private statusContextWindow?: number;
    /** 模型列表缓存：pi 启动时读一次 models.json，进程存活期间不变；
     *  点击状态栏弹选择器直接读缓存，避免每次都等 RPC 往返（多 panel 时尤其卡）。 */
    private cachedModels?: ModelInfo[];

    private client?: PiClient;
    private readonly edits: EditTracker;
    private forkEntries: { entryId: string; text: string }[] = [];
    /** 本轮已展示过的错误文本；防止重试期间同一错误刷屏。agent_start 时重置。 */
    private lastShownRunError = "";

    constructor(id: string, name: NameParts, private readonly host: RuntimeHost) {
        this.id = id;
        this.nameParts = name;
        this.edits = new EditTracker({
            getCwd: () => this.host.getCwd(),
            relativeTo: (cwd, full) => this.host.relativeTo(cwd, full),
            resolvePath: (p) => this.host.resolvePath(p),
            post: (msg) => this.post(msg),
            onKnownFilesChanged: () => this.host.onKnownFilesChanged?.(this.id),
            confirmRevert: (label) => this.host.confirmRevert(label),
        });
    }

    /** 推送给对应 tab 的消息（自动带 tabId）。 */
    private post(msg: Record<string, unknown>): void {
        this.host.postToTab(this.id, msg);
    }

    /** 把当前 tab 的模型/上下文状态快照上报给宿主（如 VSCode 状态栏）。
     *  宿主自行按焦点 panel 过滤；这里不多嘴。 */
    public emitStatus(): void {
        this.host.onStatusUpdate?.(this.id, {
            modelId: this.statusModelId,
            provider: this.statusProvider,
            thinkingLevel: this.statusThinking,
            percent: this.statusPercent,
            tokens: this.statusTokens,
            contextWindow: this.statusContextWindow,
        });
    }

    // ---- 状态快照只读视图（供 tabList 携带，webview 重建后恢复状态栏）----
    public get modelId(): string | undefined { return this.statusModelId; }
    public get provider(): string | undefined { return this.statusProvider; }
    public get thinkingLevel(): string | undefined { return this.statusThinking; }
    public get contextPercent(): number | undefined { return this.statusPercent; }

    /** 本 tab 最后一次已知的模型（模型跟 tab 关联：新 tab 默认继承它）。未知返回 undefined。 */
    public currentModel(): { provider?: string; modelId?: string } | undefined {
        if (!this.statusModelId) {
            return undefined;
        }
        return { provider: this.statusProvider, modelId: this.statusModelId };
    }

    /** 启动该 tab 的 pi 进程。优先领取宿主预热的备用进程（免冷启动），
     *  领不到（首 tab / 备用尚未就绪）时自行 spawn。
     *  @param modelOverride 指定启动模型（新 tab 继承活跃 tab 传入）；
     *  缺省时用本 tab 最后已知模型，再缺省才回落宿主全局配置。 */
    public startClient(modelOverride?: { provider?: string; modelId?: string }): void {
        if (this.client && this.client.isRunning()) {
            return;
        }
        this.setPiReady(false);

        const want = modelOverride ?? this.currentModel();

        // 备用进程已就绪：直接挂上，避免 pi 冷启动等待
        const spare = this.host.claimSpareClient?.();
        if (spare) {
            this.attachClient(spare.client);
            // 备用进程按全局配置启动；与继承目标不符时补发一次 set_model
            const mismatch = want && (
                spare.modelId !== want.modelId
                || (spare.provider || "") !== (want.provider || "")
            );
            if (mismatch && want) {
                void this
                    .request<RpcModelInfo>({
                        type: "set_model",
                        provider: want.provider,
                        modelId: want.modelId,
                    })
                    .then(() => this.sendCurrentModel());
            }
            return;
        }

        const cfg = this.host.getConfig();

        if (!this.host.checkPiAvailable(cfg.piPath, this.id)) {
            return;
        }

        const extraArgs = cfg.trustProject
            ? [...cfg.extraArgs, "--approve"]
            : cfg.extraArgs;

        this.attachClient(
            new PiClient({
                piPath: cfg.piPath,
                cwd: this.host.getCwd(),
                provider: want?.provider || cfg.provider || undefined,
                model: want?.modelId || cfg.model || undefined,
                extraArgs,
            })
        );
    }

    /** 把（新建或领取的）pi 客户端挂到本 tab：绑定事件并启动。 */
    private attachClient(client: PiClient): void {
        this.client = client;
        // 新进程 = 重新读 models.json：旧缓存作废
        this.cachedModels = undefined;
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
            // 在途 request 由 PiClient 在 exit 时统一释放
            this.post({ type: "streamEnd", activity: "idle" });
            this.setActivity("idle");
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
            // 预取模型列表：点状态栏选模型时直接读缓存，不等 RPC
            void this.refreshModels();
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
        this.emitStatus();
    }

    /** 发送当前模型信息给 webview。 */
    public async sendCurrentModel(): Promise<void> {
        const resp = await this.request<RpcSessionState>({ type: "get_state" });
        const model = resp?.data?.model;
        if (model && model.id) {
            this.statusModelId = model.id;
            this.statusProvider = model.provider;
            this.post({ type: "modelChanged", modelId: model.id, provider: model.provider });
        }
        const thinkingLevel = resp?.data?.thinkingLevel;
        if (thinkingLevel) {
            this.statusThinking = thinkingLevel;
            this.post({ type: "thinkingChanged", level: thinkingLevel });
        }
        this.emitStatus();
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
        this.edits.reset();
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

    /** 发送需要响应的命令（委托 PiClient；timeoutMs 默认 15s）。 */
    public request<T = unknown>(
        cmd: Record<string, unknown>,
        timeoutMs = 15000
    ): Promise<RpcResponse<T> | undefined> {
        if (!this.client || !this.client.isRunning()) {
            return Promise.resolve(undefined);
        }
        return this.client.request<T>(cmd, timeoutMs);
    }

    /** 等待 pi 进程真正就绪（委托 PiClient 短超时轮询 get_state）。 */
    public async waitReady(timeoutMs = 30000): Promise<boolean> {
        if (!this.client) {
            return false;
        }
        return this.client.waitReady(timeoutMs);
    }

    /** 导出会话全文本流（跨 panel 上下文获取用）：
     *  user/assistant 正文 + 工具调用一行摘要；toolResult 正文不进（v1 定规）。 */
    public async exportChatText(): Promise<{ text: string; messageCount: number } | undefined> {
        if (!this.client || !this.client.isRunning()) {
            return undefined;
        }
        const resp = await this.request<{ messages: any[] }>({ type: "get_messages" });
        const messages: any[] = resp?.data?.messages ?? [];
        const sections: string[] = [];
        let messageCount = 0;
        for (const m of messages) {
            if (m?.role === "user") {
                const t = textOf(m.content).trim();
                if (t) {
                    sections.push(`### 👤 用户\n${t}`);
                    messageCount++;
                }
            } else if (m?.role === "assistant") {
                const parts = Array.isArray(m.content) ? m.content : [];
                const blocks: string[] = [];
                let buf = "";
                for (const c of parts) {
                    if (c?.type === "text" && typeof c.text === "string") {
                        buf += c.text;
                    } else if (c?.type === "toolCall") {
                        if (buf.trim()) { blocks.push(buf.trim()); buf = ""; }
                        const toolName = typeof c.name === "string" ? c.name : "tool";
                        const s = summarizeToolCall(toolName, c.arguments);
                        blocks.push(`> 🔧 ${toolName}${s ? `: ${s}` : ""}`);
                    }
                }
                if (buf.trim()) { blocks.push(buf.trim()); }
                if (blocks.length) {
                    sections.push(`### 🤖 助手\n${blocks.join("\n\n")}`);
                    messageCount++;
                }
            }
            // toolResult 角色：不含结果正文，直接跳过
        }
        return { text: sections.join("\n\n"), messageCount };
    }

    /** 取本会话最后一条 assistant 回复的文本；无则空串（分屏接力用）。 */
    public async getLastAssistantText(): Promise<string> {
        const resp = await this.request<{ text: string | null }>({ type: "get_last_assistant_text" });
        return (resp?.data?.text ?? "").trim();
    }

    /** 把 pi 上报的模型错误展示给 webview；同一 run 内重复文本只展示一次。
     *  返回是否真实展示了（供调用方在同文本重复时补发简短提示）。 */
    private announceRunError(raw: unknown, prefix = "pi 错误: "): boolean {
        if (typeof raw !== "string" || !raw.trim()) {
            return false;
        }
        const text = formatPiError(raw);
        if (!text || text === this.lastShownRunError) {
            return false;
        }
        this.lastShownRunError = text;
        this.post({ type: "systemError", text: prefix + text });
        return true;
    }

    /** 更新当前 agent 阶段，并同步给 webview / tab 列表。 */
    private setActivity(activity: RuntimeActivity, detail = ""): void {
        if (this.activity === activity && this.activityDetail === detail) {
            return;
        }
        this.activity = activity;
        this.activityDetail = detail;
        this.post({ type: "activityChanged", activity, detail });
        this.host.broadcastTabList();
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
                    const imgs = countImages(m.content);
                    const text = textOf(m.content);
                    this.post({
                        type: "userMessage",
                        text,
                        imageCount: imgs > 0 ? imgs : 0,
                    });
                    // panel 名字：创建时命名后终身保留，不随用户消息更新。
                } else if (
                    m && m.role === "assistant"
                    && m.stopReason === "error"
                    && typeof m.errorMessage === "string"
                ) {
                    // LLM 调用失败（鉴权/限流/溢出等）时 pi 不发专门的错误事件，
                    // 而是发一条带 errorMessage 的 assistant 消息（stopReason=error）。
                    this.announceRunError(m.errorMessage);
                }
                break;
            }
            case "agent_start":
                this.streaming = true;
                this.lastShownRunError = "";
                // agent_start 只说明 agent 开始工作，不代表已经进入 thinking block。
                this.post({ type: "streamStart", activity: "working", detail: "" });
                this.setActivity("working");
                break;
            case "message_update": {
                const a = evt.assistantMessageEvent;
                if (!a) {
                    break;
                }
                switch (a.type) {
                    case "thinking_start":
                        this.setActivity("thinking");
                        break;
                    case "thinking_delta":
                        // 某些 provider 可能省略 thinking_start，收到 delta 也应进入 thinking。
                        this.setActivity("thinking");
                        this.post({ type: "thinkingDelta", delta: a.delta });
                        break;
                    case "thinking_end":
                        this.setActivity("working");
                        break;
                    case "text_start":
                    case "text_delta":
                        this.setActivity("working");
                        if (a.type === "text_delta") {
                            this.post({ type: "assistantDelta", delta: a.delta });
                        }
                        break;
                    case "toolcall_start":
                    case "toolcall_delta":
                    case "toolcall_end":
                        // 这里仍在生成工具调用参数，真正执行工具时再切到 tool。
                        this.setActivity("working");
                        break;
                }
                break;
            }
            case "tool_execution_start":
                this.setActivity("tool", typeof evt.toolName === "string" ? evt.toolName : "");
                this.edits.trackEditStart(evt);
                this.edits.onToolStart(evt);
                break;
            case "tool_execution_update":
                this.edits.onToolUpdate(evt);
                break;
            case "tool_execution_end":
                this.edits.trackEditEnd(evt);
                this.edits.onToolEnd(evt);
                this.setActivity("working");
                break;
            case "compaction_start":
            case "summarization_retry_attempt_start":
                // 这些阶段仍属于 agent 工作中，但不是模型 thinking block。
                this.setActivity("working");
                break;
            case "auto_retry_start":
                // 瞬时错误（overloaded / 限流 / 5xx）触发的自动重试。
                // 错误文本可能已由失败 assistant 消息展示过，announceRunError 内部去重。
                this.setActivity("working");
                this.announceRunError(evt.errorMessage);
                {
                    const sec = typeof evt.delayMs === "number"
                        ? Math.max(0, Math.round(evt.delayMs / 100) / 10)
                        : undefined;
                    const parts = ["遇到错误，准备重试"];
                    if (typeof evt.attempt === "number" && typeof evt.maxAttempts === "number") {
                        parts.push(`${evt.attempt}/${evt.maxAttempts}`);
                    }
                    if (sec !== undefined) {
                        parts.push(`${sec}s 后`);
                    }
                    this.post({ type: "system", text: parts.join(" ") });
                }
                break;
            case "auto_retry_end":
                this.setActivity("working");
                if (evt.success === false) {
                    // 错误文本与之前重复时不刷屏，但仍给出“重试耗尽”的收尾信号。
                    if (!this.announceRunError(evt.finalError, "重试失败: ")) {
                        this.post({
                            type: "systemError",
                            text: "重试失败，已停止自动重试。",
                        });
                    }
                }
                break;
            case "summarization_retry_scheduled":
                this.setActivity("working");
                this.announceRunError(evt.errorMessage);
                break;
            case "compaction_end":
                this.setActivity("working");
                if (!evt.aborted && typeof evt.errorMessage === "string" && evt.errorMessage) {
                    this.post({
                        type: "systemError",
                        text: `压缩失败: ${formatPiError(evt.errorMessage)}`,
                    });
                }
                break;
            case "extension_error":
                this.post({
                    type: "systemError",
                    text: `扩展错误${evt.extensionPath ? ` (${evt.extensionPath})` : ""}`
                        + `${evt.event ? ` [${evt.event}]` : ""}: ${evt.error ?? "未知错误"}`,
                });
                break;
            case "agent_end":
                // agent_end 只是一次底层 run 结束；后面可能还有重试、压缩或排队续跑。
                // 不能在这里发送 streamEnd，等 agent_settled 才算真正空闲。
                this.setActivity("working");
                break;
            case "agent_settled":
                this.streaming = false;
                this.post({ type: "streamEnd", activity: "idle" });
                this.setActivity("idle");
                this.refreshStats();
                break;
        }
    }

    /** 未被 request() 认领的响应（例如无 id 的错误）。带 id 的响应已在 PiClient 内消化。 */
    private onPiResponse(resp: RpcResponse): void {
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

    // ---- 工具追踪 / diff（委托 EditTracker）----
    public getKnownFiles(): string[] {
        return this.edits.getKnownFiles();
    }

    public async revertEdit(toolCallId: string): Promise<void> {
        return this.edits.revertEdit(toolCallId);
    }

    // ---- 会话加载 / 树 / fork ----
    public async loadSession(file: string): Promise<void> {
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
        }
        this.loading = true;
        this.host.broadcastTabList();
        this.edits.reset();
        this.post({ type: "clear" });
        this.post({ type: "system", text: "正在加载会话…" });

        // 等待 pi 真正就绪（冷启动需数秒），避免命令挤在超时上
        const ready = await this.waitReady();
        if (!ready) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({
                type: "systemError",
                text: "pi 进程未能就绪，无法加载会话。请确认 pi 可正常启动。",
            });
            return;
        }

        const switchResp = await this.request({ type: "switch_session", sessionPath: file });
        if (!switchResp || switchResp.success === false) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({
                type: "systemError",
                text: `加载会话失败: ${switchResp?.error ?? "未知错误"}`,
            });
            return;
        }

        const [msgResp, forkResp] = await Promise.all([
            this.request<{ messages: any[] }>({ type: "get_messages" }),
            this.request<{ messages: RpcForkMessage[] }>({ type: "get_fork_messages" }),
        ]);
        const messages: any[] = msgResp?.data?.messages ?? [];
        this.forkEntries = forkResp?.data?.messages ?? [];
        this.renderMessages(messages);
        this.currentSessionPath = file;
        this.post({ type: "system", text: `已加载会话（${messages.length} 条消息）。` });
        this.loading = false;
        this.host.broadcastTabList();
        this.refreshStats();
    }

    public async showTree(): Promise<void> {
        const resp = await this.request<{ tree: RpcTreeNode[]; leafId?: string | null }>({ type: "get_tree" });
        if (!isRpcOk(resp)) {
            this.post({
                type: "systemError",
                text: `获取对话树失败: ${rpcErrorMessage(resp)}`,
            });
            return;
        }
        const tree = resp.data?.tree ?? [];
        const leafId = resp.data?.leafId ?? null;
        // slimTree：去掉 bash/diff 等大字段；user 原文完整保留（fork 后 setInput 回填）
        const slim = slimTree(tree);
        // 完整树消息可达数百 KB~数 MB，VSCode webview postMessage 对较大消息会静默丢弃。
        // 改为字符串分块发送（每块 ~60KB），webview 端拼接后再渲染。
        const json = JSON.stringify({ tree: slim, leafId });
        const batchId = `tree-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const CHUNK = 60000;
        const total = Math.max(1, Math.ceil(json.length / CHUNK));
        for (let i = 0; i < total; i++) {
            this.post({
                type: "treeViewChunk",
                batchId,
                index: i,
                total,
                text: json.slice(i * CHUNK, (i + 1) * CHUNK),
            });
        }
        this.post({ type: "treeViewEnd", batchId, leafId, jsonLen: json.length });
    }

    public async forkFromEntry(entryId: string): Promise<void> {
        this.abortActiveRun();
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
        }
        this.loading = true;
        this.host.broadcastTabList();
        this.post({ type: "system", text: "正在从该消息处分叉…" });

        const ready = await this.waitReady();
        if (!ready) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({
                type: "systemError",
                text: "pi 进程未能就绪，无法分叉。请确认 pi 可正常启动。",
            });
            return;
        }

        const resp = await this.request<RpcForkResult>({ type: "fork", entryId });
        if (!isRpcOk(resp)) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({
                type: "systemError",
                text: `分叉失败: ${rpcErrorMessage(resp)}`,
            });
            return;
        }
        if (resp.data?.cancelled) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({ type: "system", text: "分叉已取消。" });
            return;
        }
        // pi fork(position=before) 会返回被分叉的 user 消息原文，供编辑后重发（对齐 TUI）
        const selectedText = forkSelectedText(resp);
        this.edits.reset();
        const [msgResp, forkResp, stateResp] = await Promise.all([
            this.request<{ messages: any[] }>({ type: "get_messages" }),
            this.request<{ messages: RpcForkMessage[] }>({ type: "get_fork_messages" }),
            this.request<RpcSessionState>({ type: "get_state" }),
        ]);
        const messages: any[] = msgResp?.data?.messages ?? [];
        this.forkEntries = forkResp?.data?.messages ?? [];
        // fork 会切换到新的分支会话文件，需同步路径
        if (stateResp?.data?.sessionFile) {
            this.currentSessionPath = stateResp.data.sessionFile;
        }
        this.post({ type: "clear" });
        this.renderMessages(messages);
        // clear 会清空输入框，必须在其后把 user 消息救回（对齐 TUI）
        if (selectedText) {
            this.post({ type: "setInput", text: selectedText });
        }
        this.post({ type: "system", text: `已分叉到新分支（${messages.length} 条消息）。` });
        this.loading = false;
        this.host.broadcastTabList();
        this.refreshStats();
    }

    /**
     * 加载指定会话文件后，从 entryId 处分叉到新分支。
     * 用于“在新 tab 打开分支”：由新建的空 tab 调用本方法，源 tab 完全不受影响。
     */
    public async loadSessionAndFork(sessionPath: string, entryId: string): Promise<void> {
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
        }
        this.loading = true;
        this.host.broadcastTabList();
        this.edits.reset();
        this.post({ type: "clear" });
        this.post({ type: "system", text: "正在加载源会话并分叉…" });

        // 等待 pi 真正就绪（冷启动需数秒），避免命令挤在超时上
        const ready = await this.waitReady();
        if (!ready) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({
                type: "systemError",
                text: "pi 进程未能就绪，无法分叉。请确认 pi 可正常启动。",
            });
            return;
        }

        // 1. 加载源会话（不修改源文件）
        const switchResp = await this.request({ type: "switch_session", sessionPath });
        if (!switchResp || switchResp.success === false) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({
                type: "systemError",
                text: `加载源会话失败: ${switchResp?.error ?? "未知错误"}`,
            });
            return;
        }
        this.currentSessionPath = sessionPath;

        // 2. 在该 entry 处分叉：创建新分支会话文件并切换到它
        const forkResp = await this.request<RpcForkResult>({ type: "fork", entryId });
        if (!isRpcOk(forkResp)) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({
                type: "systemError",
                text: `分叉失败: ${rpcErrorMessage(forkResp)}`,
            });
            return;
        }
        if (forkResp.data?.cancelled) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({ type: "system", text: "分叉已取消。" });
            return;
        }
        // pi fork(position=before) 返回被分叉的 user 消息原文，供编辑后重发
        const selectedText = forkSelectedText(forkResp);

        // 3. 读取新分支消息并同步会话路径
        const [msgResp, forkMsgResp, stateResp] = await Promise.all([
            this.request<{ messages: any[] }>({ type: "get_messages" }),
            this.request<{ messages: RpcForkMessage[] }>({ type: "get_fork_messages" }),
            this.request<RpcSessionState>({ type: "get_state" }),
        ]);
        const messages: any[] = msgResp?.data?.messages ?? [];
        this.forkEntries = forkMsgResp?.data?.messages ?? [];
        if (stateResp?.data?.sessionFile) {
            this.currentSessionPath = stateResp.data.sessionFile;
        }
        this.post({ type: "clear" });
        this.renderMessages(messages);
        // clear 会清空输入框，必须在其后把 user 消息救回（对齐 TUI）
        if (selectedText) {
            this.post({ type: "setInput", text: selectedText });
        }
        this.post({ type: "system", text: `已在新 tab 打开新分支（${messages.length} 条消息）。` });
        this.loading = false;
        this.host.broadcastTabList();
        this.refreshStats();
        void this.sendCurrentModel();
    }

    /**
     * 加载指定会话文件后，在当前位置 clone 到新会话文件。
     * 用于分屏：新 pane 拿到与源会话完全对齐的副本，两侧从此并行，源 tab 不受影响。
     */
    public async loadSessionAndClone(sessionPath: string): Promise<void> {
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
        }
        this.loading = true;
        this.host.broadcastTabList();
        this.edits.reset();
        this.post({ type: "clear" });
        this.post({ type: "system", text: "正在克隆会话…" });
        const t0 = Date.now();

        const ready = await this.waitReady();
        if (!ready) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({
                type: "systemError",
                text: "pi 进程未能就绪，无法克隆会话。请确认 pi 可正常启动。",
            });
            return;
        }
        console.log(`[clone] waitReady ${Date.now() - t0}ms`);

        // 1. 加载源会话（不修改源文件）
        const switchResp = await this.request({ type: "switch_session", sessionPath });
        if (!switchResp || switchResp.success === false) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({
                type: "systemError",
                text: `加载源会话失败: ${switchResp?.error ?? "未知错误"}`,
            });
            return;
        }
        console.log(`[clone] switch_session ${Date.now() - t0}ms`);
        this.currentSessionPath = sessionPath;

        // 2. 在当前位置 clone：创建新会话文件并切换过去（不碰源文件）
        const cloneResp = await this.request<{ cancelled?: boolean }>({ type: "clone" });
        if (!isRpcOk(cloneResp)) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({
                type: "systemError",
                text: `克隆失败: ${rpcErrorMessage(cloneResp)}`,
            });
            return;
        }
        if (cloneResp.data?.cancelled) {
            this.loading = false;
            this.host.broadcastTabList();
            this.post({ type: "system", text: "克隆已取消。" });
            return;
        }
        console.log(`[clone] clone 命令 ${Date.now() - t0}ms`);

        // 3. 读取新会话消息并同步会话路径
        const cloneMsgs = await Promise.all([
            this.request<{ messages: any[] }>({ type: "get_messages" }),
            this.request<{ messages: RpcForkMessage[] }>({ type: "get_fork_messages" }),
            this.request<RpcSessionState>({ type: "get_state" }),
        ]);
        const messages: any[] = cloneMsgs[0]?.data?.messages ?? [];
        this.forkEntries = cloneMsgs[1]?.data?.messages ?? [];
        if (cloneMsgs[2]?.data?.sessionFile) {
            this.currentSessionPath = cloneMsgs[2].data.sessionFile;
        }
        this.post({ type: "clear" });
        this.renderMessages(messages);
        this.post({ type: "system", text: `已克隆为新会话（${messages.length} 条消息），两侧可并行对话。` });
        console.log(`[clone] 回传+渲染共 ${Date.now() - t0}ms`);
        this.loading = false;
        this.host.broadcastTabList();
        this.refreshStats();
        void this.sendCurrentModel();
    }

    private renderMessages(messages: any[]): void {
        const toolResults = new Map<string, any>();
        let lastHistoryError = "";
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
                        text: textOf(m.content),
                        // forkEntries 与树 entry id 对齐；回退 m.id（若 pi 带回）
                        entryId: this.forkEntries[userIndex]?.entryId || m.id,
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
                            this.edits.collectKnownFile(c.name, c.arguments);
                            if (c.name === "edit" || c.name === "write") {
                                const p = this.edits.editToolPath(c.name, c.arguments);
                                const id = c.id || `hist-${Math.random()}`;
                                this.post({
                                    type: "editCardStart",
                                    toolCallId: id,
                                    toolName: c.name,
                                    path: p || "",
                                    label: p ? this.host.relativeTo(this.host.getCwd(), p) : "",
                                    args: c.arguments,
                                });
                                this.post({
                                    type: "editCardResult",
                                    toolCallId: id,
                                    diff: this.edits.historyDiff(c, toolResults.get(id)),
                                    canRevert: false,
                                });
                            } else {
                                const id = c.id || `hist-${Math.random()}`;
                                const res = toolResults.get(id);
                                this.post({
                                    type: "tool",
                                    toolName: c.name,
                                    args: c.arguments,
                                    toolCallId: id,
                                });
                                if (res) {
                                    this.post({
                                        type: "toolResult",
                                        toolCallId: id,
                                        isError: !!res.isError,
                                        resultText: extractResultText(res.content ?? res),
                                        truncation: extractTruncation(res),
                                    });
                                }
                            }
                        }
                    }
                    if (text.trim()) {
                        this.post({
                            type: "assistantFull",
                            text,
                            entryId: typeof m.id === "string" ? m.id : undefined,
                        });
                    }
                    // 历史中的失败消息（stopReason=error）：展示错误文本；
                    // 自动重试可能留下连续多条相同错误，只显示第一条。
                    if (
                        m.stopReason === "error"
                        && typeof m.errorMessage === "string"
                        && m.errorMessage.trim()
                        && m.errorMessage !== lastHistoryError
                    ) {
                        lastHistoryError = m.errorMessage;
                        this.post({
                            type: "systemError",
                            text: "pi 错误: " + formatPiError(m.errorMessage),
                        });
                    }
                    break;
                }
            }
        }
    }

    /** 拉取并缓存模型列表（models.json 在 pi 启动后不变，缓存全程有效）。 */
    public async refreshModels(): Promise<ModelInfo[]> {
        const resp = await this.request<{ models: RpcModelInfo[] }>({ type: "get_available_models" });
        if (!resp?.data) {
            // RPC 失败（进程未就绪/超时）：不动缓存，下次点击重试
            return this.cachedModels ?? [];
        }
        this.cachedModels = (resp.data.models ?? []).map((m) => ({
            id: m.id,
            provider: m.provider,
            name: m.name,
            contextWindow: m.contextWindow,
            reasoning: !!m.reasoning,
            thinkingLevels: getModelThinkingLevels(m),
        }));
        return this.cachedModels;
    }

    public async pickModel(echoT0?: number): Promise<void> {
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
        }
        // 模型列表：启动时已预取，命中缓存即零 RPC；未命中才现查（首屏冷启动兼容）。
        // 当前模型/思考档位直接读本地状态缓存（pi 事件已在同步），不再额外 get_state。
        const models = this.cachedModels ?? (await this.refreshModels());
        if (models.length === 0) {
            this.post({
                type: "system",
                text: "没有可用模型（请确认 pi 已鉴权、models.json 已配置）。",
            });
            return;
        }
        const currentThinking: string = this.statusThinking ?? "";
        const currentProvider: string = this.statusProvider ?? "";
        const currentModelId: string = this.statusModelId ?? "";
        const choice = await this.host.pickModelInteractive(
            models,
            currentThinking,
            currentProvider,
            currentModelId,
            typeof echoT0 === "number" ? { t0: echoT0 } : undefined
        );
        if (!choice) {
            return;
        }

        const modelChanged = choice.provider !== currentProvider || choice.modelId !== currentModelId;
        let model: RpcModelInfo = { id: currentModelId, provider: currentProvider };
        if (modelChanged) {
            const setResp = await this.request<RpcModelInfo>({
                type: "set_model",
                provider: choice.provider,
                modelId: choice.modelId,
            });
            if (setResp?.success === false) {
                this.post({ type: "systemError", text: `切换模型失败: ${setResp.error}` });
                return;
            }
            model = setResp?.data ?? { id: choice.modelId, provider: choice.provider };
            this.post({ modelId: model.id, provider: model.provider, type: "modelChanged" });
            this.host.persistModel(model.provider || "", model.id || "");
            // 切换模型可能自动钳制 thinking level，先同步一次当前状态。
            await this.sendCurrentModel();
        }

        const selectedModel = models.find((m) =>
            m.id === choice.modelId && (m.provider || "") === (choice.provider || "")
        );
        const availableThinking = selectedModel?.thinkingLevels ?? [];
        const thinkingLevel = choice.thinkingLevel && availableThinking.includes(choice.thinkingLevel)
            ? choice.thinkingLevel
            : undefined;
        const thinkingChanged = thinkingLevel !== undefined && thinkingLevel !== currentThinking;
        if (thinkingChanged) {
            const tResp = await this.request({ type: "set_thinking_level", level: thinkingLevel });
            if (tResp?.success === false) {
                this.post({ type: "systemError", text: `设置思考强度失败: ${tResp.error}` });
            } else {
                this.statusThinking = thinkingLevel;
                this.post({ type: "thinkingChanged", level: thinkingLevel });
                this.emitStatus();
            }
        }

        const notices: string[] = [];
        if (modelChanged) {
            notices.push(`已切换模型: ${model.id || choice.modelId}`);
        }
        if (thinkingChanged) {
            notices.push(`思考强度: ${thinkingLevel}`);
        }
        if (notices.length > 0) {
            this.post({ type: "system", text: notices.join(" · ") });
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
        this.statusThinking = level;
        this.post({ type: "thinkingChanged", level });
        this.emitStatus();
        return true;
    }

    public async refreshStats(): Promise<void> {
        const resp = await this.request<RpcSessionStats>({ type: "get_session_stats" });
        const d = resp?.data;
        if (!d) {
            return;
        }
        const cu = d.contextUsage || null;
        if (cu) {
            this.statusPercent = typeof cu.percent === "number" ? cu.percent : undefined;
            this.statusTokens = typeof cu.tokens === "number" ? cu.tokens : undefined;
            this.statusContextWindow = typeof cu.contextWindow === "number" ? cu.contextWindow : undefined;
        }
        this.post({
            type: "stats",
            tokens: d.tokens || null,
            cost: typeof d.cost === "number" ? d.cost : null,
            contextUsage: cu,
        });
        this.emitStatus();
    }

    // ---- 文件跳转 / diff（均相对该 tab 的 EditTracker）----
    public async openDiff(p: string): Promise<void> {
        const change = this.edits.getFileChange(p);
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
        this.host.openFileLocation(p, resolveAnchorLine(current, anchor, line), anchor);
    }

    public openEditLocation(p: string, line: number): void {
        this.host.openFileLocation(p, line);
    }
}

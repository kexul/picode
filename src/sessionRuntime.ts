import * as fs from "fs";
import { PiClient } from "./piClient";
import { ASK_DECODER, AskDoneNotice, AskRequest } from "./askProtocol";
import { BASH_DECODER, BashTaskEvent, BashTaskInfo, readBashLogTail } from "./bashProtocol";
import { parseGoalCommand } from "./goal";
import { StderrFrameSplitter } from "./piFrames";
import { TABA_DECODER, TabaRequest } from "./tabaProtocol";
import { GOAL_DECODER, GoalVerdictRequest } from "./goalProtocol";
import { ENV_DECODER, type EnvSnapshot } from "./envProtocol";
import { NameParts } from "./names";
import { EditTracker, type SessionChangeInfo } from "./editTracker";
import {
    countImages,
    extractResultImages,
    extractResultText,
    extractTruncation,
    formatPiError,
    getModelThinkingLevels,
    readStoredImage,
    resolveAnchorLine,
    textOf,
    type ResultImageBlock,
} from "./messageUtils";
import {
    type RpcCommandInfo,
    type RpcCompactionResult,
    type RpcModelInfo,
    type RpcResponse,
    type RpcSessionStats,
    type RpcSessionState,
} from "./piRpc";
import type {
    MessageSink,
    ModelInfo,
    PanelLaunch,
    RuntimeActivity,
    RuntimeHost,
    TurnEndStatus,
} from "./runtimeTypes";

// 对外仍从 sessionRuntime 导出类型，保持既有 import 路径稳定。
export type {
    MessageSink,
    ModelChoice,
    ModelInfo,
    PanelLaunch,
    PiConfig,
    RuntimeActivity,
    RuntimeHost,
    TurnEndInfo,
    TurnEndStatus,
} from "./runtimeTypes";

// ============================================================================
//  / 命令（技能 / 提示模板 / 扩展命令）纯函数
// ============================================================================

/** / 命令菜单的一条候选：插入文本 + 基础名 + 描述 + 来源。 */
export interface SlashCommandItem {
    /** 菜单选中后插入输入框的文本，如 "/grill-me"（技能用简写，发送时改写回 /skill:）。 */
    insert: string;
    /** 基础命令名（技能已去掉 "skill:" 前缀）。 */
    name: string;
    description: string;
    /** "extension" | "prompt" | "skill"。 */
    source: string;
}

/** 插件自己认下的一条内置命令：pi 的斜杠命令只在终端界面里处理，
 *  走 RPC 发过去只是普通文字，所以由插件接下来、改发 pi 对应的 RPC 命令。 */
export const BUILTIN_COMPACT_ITEM: SlashCommandItem = {
    insert: "/compact",
    name: "compact",
    description: "压缩上下文（省 token；可跟一句要求，如 /compact 保留改过的文件）",
    source: "builtin",
};

/** 目标（/goal）：插件自己接手的命令，见 goal.ts。 */
export const BUILTIN_GOAL_ITEM: SlashCommandItem = {
    insert: "/goal ",
    name: "goal",
    description: "定一个目标，一直干到验收通过（先谈验收清单）",
    source: "builtin",
};

/**
 * 这条消息是不是要插件接手的 /compact。
 * @returns 要压缩就返回 pi 的 customInstructions（没写就是空串）；不是 /compact 返回 null。
 */
export function parseCompactCommand(text: string): string | null {
    if (typeof text !== "string") { return null; }
    const m = text.match(/^\/compact(?:[ \t]+([\s\S]*))?$/i);
    if (!m) { return null; }
    return (m[1] ?? "").trim();
}

/** 命令来源优先级（同名冲突时保留高优者）：与 pi 内部处理顺序一致。 */
function commandSourcePriority(source: string | undefined): number {
    if (source === "extension") { return 0; }
    if (source === "prompt") { return 1; }
    if (source === "skill") { return 2; }
    return 9;
}

/** 把 get_commands 原始条目整理成菜单行：
 *  - 技能（name 为 "skill:xxx"）显示基础名，插入简写 "/xxx"（发送时改写为 "/skill:xxx"）；
 *  - 基础名冲突时按 pi 优先级保留：扩展命令 > 提示模板 > 技能；
 *  - 结果按名字字母序排列。 */
export function commandMenuItems(commands: RpcCommandInfo[]): SlashCommandItem[] {
    const picked = new Map<string, RpcCommandInfo>();
    for (const c of commands) {
        if (!c || typeof c.name !== "string" || !c.name) { continue; }
        const name = c.name.startsWith("skill:") ? c.name.slice("skill:".length) : c.name;
        if (!name) { continue; }
        const prev = picked.get(name);
        if (!prev || commandSourcePriority(c.source) < commandSourcePriority(prev.source)) {
            picked.set(name, c);
        }
    }
    return Array.from(picked.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, c]) => ({
            insert: "/" + name,
            name,
            description: typeof c.description === "string" ? c.description : "",
            source: c.source === "skill" || c.source === "prompt" || c.source === "extension"
                ? c.source
                : "other",
        }))
        // 同名时别盖掉插件自己认下的那几条（/compact、/goal）
        .filter((it) => it.name !== BUILTIN_COMPACT_ITEM.name && it.name !== BUILTIN_GOAL_ITEM.name)
        .concat([BUILTIN_COMPACT_ITEM, BUILTIN_GOAL_ITEM])
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** / 简写改写："/grill-me args" → "/skill:grill-me args"。
 *  仅当首 token 命中技能、且不与扩展命令 / 提示模板同名时才改写；
 *  已是 "/skill:" 全写、或非 "/" 开头的文本原样返回。 */
export function expandSlashCommand(text: string, commands: RpcCommandInfo[]): string {
    if (typeof text !== "string" || commands.length === 0) { return text; }
    const m = text.match(/^\/(\S+)([\s\S]*)$/);
    if (!m) { return text; }
    const name = m[1];
    const rest = m[2];
    if (name.startsWith("skill:")) { return text; } // 全写形式，pi 原生处理
    const base = (n: string) => (n.startsWith("skill:") ? n.slice("skill:".length) : n);
    const has = (src: string) => commands.some((c) => c.source === src && base(c.name) === name);
    if (has("extension")) { return text; } // 扩展命令最先被 pi 检查，保持原样
    if (has("prompt")) { return text; }    // 提示模板 /name 由 pi 原生展开
    if (has("skill")) { return "/skill:" + name + rest; }
    return text;
}

/** 工具参数里这几项整个不带（write / edit 的正文：几十上百 KB，界面上那两处都用不到）。 */
const SummaryOmittedArgKeys: ReadonlySet<string> = new Set(["content", "oldText", "newText"]);

/**
 * 一段模型输出大概是多少 token（真 token 数只有模型自己知道）：
 * 中日韩文字一个字算一个，其余四个字符算一个。生成速度（t/s）用它合计出来的数。
 */
function estTokens(text: string): number {
    if (!text) { return 0; }
    let cjk = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0x3000 && c <= 0x9fff) { cjk++; }
    }
    return cjk + (text.length - cjk) / 4;
}

/** 杀掉整棵进程树（界面上点「停」时用）。后台命令的进程是脱离出去的，按 pid 树收。 */
function killTaskTree(pid: number): void {
    if (!pid) { return; }
    if (process.platform === "win32") {
        try {
            require("node:child_process").spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        } catch { /* 进程可能已经没了 */ }
        return;
    }
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* 同上 */ }
    }
}

/**
 * 一个会话的全部运行时状态：独立的 pi 进程 + 独立的会话/编辑追踪。
 * 多个 SessionRuntime 各自持有自己的 PiClient，因此可以真正并行流式生成。
 *
 * 平台差异（UI 弹窗、diff、文件打开、配置持久化）全部经由 RuntimeHost 注入，
 * 本类不引用 `vscode`。消息/树/工具结果的纯逻辑见 messageUtils；RPC 类型见 piRpc。
 */
export class SessionRuntime {
    public id: string = "";
    /** 名字两部分（形容词/名词）：创建时分配后终身不变；随机名部分（nameParts）在宿主那边用。 */
    public readonly nameParts: NameParts = { adjective: "", noun: "" };

    /** pi 自己给的会话标题（自动命名扩展 / /name 写的）；空串表示还没有。 */
    public get sessionTitle(): string { return this.piSessionTitle; }
    /**
     * 本会话的 pi 进程跑在哪个目录。
     * 多数会话跟宿主默认目录一致；子会话、以及“在别的项目里开的会话”（启动时的 launch.cwd）不一样，
     * 历史列表、文件相对路径、派子会话的默认目录都要看它，不能看宿主那一份。
     */
    public get cwd(): string { return this.launch?.cwd || this.host.getCwd(); }
    /** Agent 是否仍在运行；这是 steer / Esc 等整体生命周期判断使用的状态。 */
    public streaming = false;
    /** 正在压缩上下文（/compact）：界面上照旧显示「工作中」，这里只是防重入。 */
    public compacting = false;
    /** Agent 当前更细的活动阶段，供 webview 区分处理中 / 思考 / 工具调用。 */
    public activity: RuntimeActivity = "idle";
    /** 当前阶段的附加信息，例如正在执行的工具名。 */
    public activityDetail = "";
    public piReady = false;
    /** 正在加载会话 / 分叉（pi 冷启动 + 切换会话期间为 true，供宿主展示加载态）。 */
    public loading = false;
    public currentSessionPath: string | undefined;
    /** 当前界面是否已有用户或助手消息；用于历史会话打开时复用空会话。 */
    private hasConversation = false;
    /** pi 上报的会话标题；来源是 session_info_changed 事件与 get_state 响应里的 sessionName。 */
    private piSessionTitle = "";
    /** pi 报的排队状态（steering / followUp）：整屏重画时把它再递一份权威的给界面。
     *  断线那段里 pi 可能已经把排队的那几条投递出去了，那条“队列空了”的推送界面没收到，
     *  回来就还照着旧的样子写着“在排队”，实际上早就发出去了。 */
    private queuedSteering: string[] = [];
    private queuedFollowUp: string[] = [];

    /** 当前 panel 是否尚未承载会话内容，且不在加载过程中。 */
    public isConversationEmpty(): boolean {
        return !this.hasConversation && !this.loading;
    }

    // ---- 当前状态快照（跟着 sessionList 发给界面，界面自己画输入框底下那颗胶囊）----
    private statusModelId?: string;
    private statusProvider?: string;
    private statusThinking?: string;
    private statusPercent?: number;
    /** 模型列表缓存：pi 启动时读一次 models.json，进程存活期间不变；
     *  点击胶囊弹选择器直接读缓存，避免每次都等 RPC 往返（多 panel 时尤其卡）。 */
    private cachedModels?: ModelInfo[];
    /** 命令列表缓存（get_commands）：供 / 命令菜单展示与简写改写；
     *  进程存活期间有效，attachClient 时失效并预取。 */
    private cachedCommands?: RpcCommandInfo[];

    private client?: PiClient;
    /** 本 panel 启动 pi 时的额外要求（子会话才有）；进程重启时照原样再用一次。 */
    private launch?: PanelLaunch;
    /** 从本进程 stderr 里挑暗号行的切割器（派子会话、问话、目标验收、后台命令四种暗号都走它）。 */
    private readonly piFrames = new StderrFrameSplitter([TABA_DECODER, ASK_DECODER, GOAL_DECODER, BASH_DECODER, ENV_DECODER]);
    /** 这个会话加载着什么（工具 / 技能 / MCP 服务器）：env-bridge 扩展报上来的最近一份。
     *  界面那颗「工具」点开时要它；还没报过来就是 undefined。 */
    private envSnapshot?: EnvSnapshot;
    private readonly edits: EditTracker;
    /** 这个会话的后台命令（任务编号 → 情况）：界面那一格清单、以及「停」要用它。
     *  跟着会话活：会话关掉就没了（日志文件还在磁盘上，但没人再看了）。 */
    private readonly bashTasks = new Map<number, BashTaskInfo>();
    // ---- 网页端「只发最近一段历史」的窗口（宿主 wantsTrimmedHistory 为 true 时启用）----
    /** 当前窗口在完整消息数组里的起点下标；-1 表示没开窗口（全量发过 / 非网页端）。 */
    private historyWindowStart = -1;
    /** 开窗口时第一条消息的指纹：往前补消息前用它校验会话有没有换过（换会话/换分支则作废）。 */
    private historyWindowFingerprint = "";
    /** 开窗口时完整消息数组的长度；长度变短说明底下换过会话，旧下标作废。 */
    private historyWindowLength = 0;
    /** 开窗口时窗口前还有多少条 user/assistant 消息（按钮上「还有 N 条」用）。 */
    private historyWindowHidden = 0;
    /** 网页端首屏一次最多内联多少图片数据（base64 字符数）。
     *
     * 为什么要这个预算：一屏里最常见的大块头就是图（截图动不动几百 KB 一张），手机上
     * 这一屏动辄好几 MB，界面就空着等它传完。现在从最新一张往前数，数到预算为止，
     * 更早的只发一个占位（界面上点开再取）。 */
    private static readonly WEB_INLINE_IMAGE_CHARS = 400 * 1024;
    /** 首屏没带过来的那些图，最多在内存里留多少（base64 字符数）：点开再取时直接从这儿给，
     *  不用再去问 pi。超过上限就从最早留的开始丢（丢了的那张点开时现取）。 */
    private static readonly OMITTED_IMAGE_KEEP_CHARS = 64 * 1024 * 1024;
    /** 首屏没带过来的图（toolCallId → 图块）与它们的总大小。 */
    private readonly omittedImages = new Map<string, ResultImageBlock[]>();
    private omittedImageChars = 0;
    /** 思考与工具输出一次最多带多少字：**0 = 一个字都不带**。
     *
     *  这两样东西在界面上都是收起的（思考只在提示框里看，工具输出要点开才有），
     *  所以干脆不传；消息里只留一个“一共多少字 + 编号”，页面上点开提示框时再来取
     *  （见 clipDetail / loadDetails）。实测一个 919 条消息的真会话，首屏那 782 KB 消息
     *  里九成是它们，全不带之后只剩 109 KB。
     *
     *  想改回“带开头一小段”（点开就不用等那一下）把这个数调大就行，界面那一套两边都认。 */
    private static readonly DETAIL_PREVIEW_CHARS = 0;
    /** 工具参数摘要里单个字段最多带多少字（够那行字用；整行还会再省略一次）。 */
    private static readonly ARGS_SUMMARY_CHARS = 160;
    /** 裁下来的全文最多在内存里留多少（字符数）：超过就从最早留的开始丢（丢了的那段点开时取不到）。
     *  留得住长会话里最近几十轮就够：点开的是刚看到的那些，很久以前的点开时会说“取不到了”。 */
    private static readonly DETAIL_KEEP_CHARS = 4 * 1024 * 1024;
    /** 裁下来的全文（detailKey → 全文）与它们的总大小。 */
    private readonly omittedText = new Map<string, string>();
    private omittedTextChars = 0;
    /** 正在长的这段思考：编号 + 已经攒下的全文 + 已经发出去多少字（见 appendThinkingDetail）。 */
    private thinkDetailKey = "";
    private thinkDetailText = "";
    private thinkDetailSent = 0;
    private thinkDetailCounter = 0;
    /** 刚越过预览字数时已经告诉过界面了（只告诉一次，见 appendThinkingDetail）。 */
    private thinkDetailNotified = false;
    /** 这一段思考收到过逐字增量没有（没收到的那种 provider 只给收尾那条全文，见 onPiEvent 的 thinking_end）。 */
    private thinkSawDelta = false;
    /** 生成速度（t/s）的账：这一轮估出来的 token 数、模型真正在吐字的时间（各次调用累加）、
     *  这一次调用从什么时候开始算，以及上一次算出来的速度（见 noteGenTokens / beginGenCall）。 */
    private genTokens = 0;
    private genMs = 0;
    private genCallStart = 0;
    private genTpsSyncedAt = 0;
    private tps?: number;
    /** 本轮已展示过的错误文本；防止重试期间同一错误刷屏。agent_start 时重置。 */
    private lastShownRunError = "";
    /** 本轮是否真的跑起来过：防止没发消息就收到 agent_settled 时误报“完成”。 */
    private runStarted = false;
    /** 用户是否主动中止了本轮：中止不算“任务完成”。agent_start 时重置。 */
    private abortRequested = false;
    /** 「卡住了」点了之后等着补发的那句话：这一轮停稳（agent_settled）时发出去，见 abortThenSend。 */
    private pendingAfterAbort = "";

    constructor(id: string, name: NameParts, private host: RuntimeHost) {
        this.id = id;
        this.nameParts = name;
        this.edits = new EditTracker({
            getCwd: () => this.cwd,
            relativeTo: (cwd, full) => this.host.relativeTo(cwd, full),
            resolvePath: (p) => this.host.resolvePath(p, this.cwd),
            post: (msg) => this.post(msg),
            onKnownFilesChanged: () => this.host.onKnownFilesChanged?.(this.id),
            confirmRevert: (label) => this.host.confirmRevert(label, this.id),
            clipToolText: (key, text) => this.clipDetail(key, text),
            summaryToolArgs: (id, args) => this.summaryArgs(id, args),
        });
    }

    /** 推送给对应会话的消息（自动带 sessionId）。 */
    private post(msg: Record<string, unknown>): void {
        this.host.postToSession(this.id, msg);
    }


    // ---- 状态快照只读视图（供 sessionList 携带，界面重建后恢复胶囊）----
    public get modelId(): string | undefined { return this.statusModelId; }
    public get provider(): string | undefined { return this.statusProvider; }
    public get thinkingLevel(): string | undefined { return this.statusThinking; }
    public get contextPercent(): number | undefined { return this.statusPercent; }
    /** 上一次算出来的生成速度（t/s）：会话列表带一份，页面刷新后胶囊里那颗数还在。 */
    public get tokensPerSecond(): number | undefined { return this.tps; }

    /** 本会话最后一次已知的模型（模型跟会话关联：新会话默认继承它）。未知返回 undefined。 */
    public currentModel(): { provider?: string; modelId?: string } | undefined {
        if (!this.statusModelId) {
            return undefined;
        }
        return { provider: this.statusProvider, modelId: this.statusModelId };
    }

    /** 启动该会话的 pi 进程。优先领取宿主预热的备用进程（免冷启动），
     *  领不到（首个会话 / 备用尚未就绪）时自行 spawn。
     *  @param modelOverride 指定启动模型（新会话继承当前会话传入）；
     *  缺省时用本会话最后已知模型，再缺省才回落宿主全局配置。
     *  @param launch 额外启动要求（子会话用：自己的会话文件、提示词，且不能再派）。
     *  传过的 launch 会记住：pi 进程退出后重发消息会自动重启，那时要照原样再起一次。 */
    public startClient(modelOverride?: { provider?: string; modelId?: string }, launch?: PanelLaunch): void {
        if (this.client && this.client.isRunning()) {
            return;
        }
        if (launch) { this.launch = launch; }
        this.setPiReady(false);

        const want = modelOverride ?? this.currentModel();

        // 备用进程已就绪：直接挂上，避免 pi 冷启动等待（子会话不行：它的启动参数不一样）
        const spare = this.launch?.skipSpare ? undefined : this.host.claimSpareClient?.();
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
            : [...cfg.extraArgs];

        // “派子会话”那个扩展：配置里有路径、且本 panel 不是子会话时才加载（子会话不能再派）
        const tabaExtension = this.launch?.noTaba ? "" : cfg.tabaExtension || "";
        if (tabaExtension) { extraArgs.push("-e", tabaExtension); }
        // “问话”那个扩展（ask_choice）：每个会话都带（子会话也可能要问用户）
        if (cfg.askExtension) { extraArgs.push("-e", cfg.askExtension); }
        // “自动起标题”：只给主会话带（子会话、判官的名字由派活那边给，不用再花一次请求）
        const titleExtension = this.launch?.noTaba ? "" : cfg.titleExtension || "";
        if (titleExtension) { extraArgs.push("-e", titleExtension); }
        // “会话里的截图挪出会话文件”：每个会话都带（子会话读图一样要挪）
        if (cfg.imageExtension) { extraArgs.push("-e", cfg.imageExtension); }
        // “后台命令”：接管 bash，每个会话都带（子会话、判官也要能跑命令）
        if (cfg.bashExtension) { extraArgs.push("-e", cfg.bashExtension); }
        // “加载了什么”（工具 / 技能 / MCP）：每个会话都带，界面那颗「工具」看的就是它报上来的
        if (cfg.envExtension) { extraArgs.push("-e", cfg.envExtension); }
        if (this.launch?.extraArgs && this.launch.extraArgs.length > 0) {
            extraArgs.push(...this.launch.extraArgs);
        }

        this.attachClient(
            new PiClient({
                piPath: cfg.piPath,
                cwd: this.cwd,
                provider: want?.provider || cfg.provider || undefined,
                model: want?.modelId || cfg.model || undefined,
                extraArgs,
                // 几个扩展各靠一个环境变量找自己的资源目录（taba：子会话名录；ask：回话文件；bash：后台命令的日志与指令）
                env: {
                    ...(cfg.tabaDir ? { PICHAT_TABA_DIR: cfg.tabaDir } : {}),
                    ...(cfg.askDir ? { PICHAT_ASK_DIR: cfg.askDir } : {}),
                    ...(cfg.bashDir ? { PICHAT_BASH_DIR: cfg.bashDir } : {}),
                },
            })
        );
    }

    /** 把（新建或领取的）pi 客户端挂到本会话：绑定事件并启动。 */
    private attachClient(client: PiClient): void {
        // 新进程 = 新会话 = 重新读 models.json / 重新扫描技能：旧标题、旧缓存都作废。
        this.noteSessionReplaced();
        this.client = client;
        this.cachedModels = undefined;
        this.cachedCommands = undefined;
        this.client.on("event", (evt) => this.onPiEvent(evt));
        this.client.on("response", (resp) => this.onPiResponse(resp));
        this.client.on("ui", (req) => this.onPiUiRequest(req));
        this.client.on("stderr", (text: string) => {
            // 两类暗号都写在 stderr 里（一行一帧，base64）：派子会话、问用户选择题。
            // 两种都不能整行打日志（base64 会把控制台刷没）；pi 自己的诊断输出照打 —— 切割器把两样分开。
            const frames = this.piFrames.feed(text);
            for (const line of this.piFrames.takeOtherLines()) { console.error("[pi stderr]", line); }
            for (const frame of frames) {
                if (frame.kind === "taba") {
                    const req = frame.value as TabaRequest;
                    console.error(req.kind === "spawn"
                        ? `[派子会话] 收到派活请求：「${req.name}」（${req.id}，任务 ${req.task.length} 字）`
                        : `[派子会话] 收到停止请求：「${req.name || req.id || ""}」`);
                    this.host.onTabaRequest?.(this.id, req);
                    continue;
                }
                if (frame.kind === "goal") {
                    // 判官会话里 update_goal 的结论：交回宿主去改目标状态
                    const verdict = frame.value as GoalVerdictRequest;
                    console.error(`[目标验收] 判官报了结论：${verdict.pass ? "通过" : "没过"}（${verdict.summary}）`);
                    this.host.onGoalVerdict?.(this.id, verdict);
                    continue;
                }
                if (frame.kind === "bash") {
                    // 后台命令的开始 / 结束：记进这一会话的清单、推给界面；跑完的交给宿主去补一条消息
                    this.noteBashTask(frame.value as BashTaskEvent);
                    continue;
                }
                if (frame.kind === "env") {
                    // 「加载了什么」的清单：存着，推给界面（那颗「工具」开着的话就跟着刷新）
                    this.noteEnvSnapshot(frame.value as EnvSnapshot);
                    continue;
                }
                if (frame.kind === "ask") {
                    const req = frame.value as AskRequest | AskDoneNotice;
                    if (req.kind === "ask") {
                        console.error(`[问话] 收到提问：「${req.question}」（${req.id}，${req.options.length} 个选项${req.multi ? "，可多选" : ""}）`);
                        this.host.askQuestion?.(req, this.id);
                    } else {
                        // 扩展不等了（超时/这一轮被停）：把还开着的那个浮层收掉
                        this.host.cancelAsk?.(req.id);
                    }
                }
            }
        });
        this.client.on("error", (err: Error) => {
            this.post({ type: "systemError", text: `pi 错误: ${err.message}` });
        });
        this.client.on("exit", (code: number | null) => {
            this.streaming = false;
            // 进程没了，等着的那一下“停稳”就不会再来了：那句“卡住了”作废
            //（留着的话，用户下一轮跑完时它会莫名其妙冒出来）。
            this.pendingAfterAbort = "";
            // 在途 request 由 PiClient 在 exit 时统一释放
            // 进程没了，正在跑的工具结果永远不会回来：先把还挂着「在跑」的标签收掉，
            // 不然它们会一直转圈、耗时一直往上数（见 media/chat.js 的 settleInterruptedTools）。
            this.edits.forgetRunningTools();
            this.post({ type: "toolsInterrupted" });
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
            this.host.broadcastSessionList();
            void this.sendCurrentModel();
            void this.refreshStats();
            // 预取模型列表：点胶囊选模型时直接读缓存，不等 RPC
            void this.refreshModels();
            // 预取命令列表（技能/模板/扩展命令）：/ 菜单与简写改写直接用缓存
            void this.refreshCommands();
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

    /** 记下 pi 上报的会话标题；真的变了才通知界面重推会话列表。 */
    private setSessionTitle(name: unknown): void {
        const next = typeof name === "string" ? name.trim() : "";
        if (next === this.piSessionTitle) { return; }
        this.piSessionTitle = next;
        // 界面上显示的会话名跟着换（顶条中间那行 + 会话列表）：通知宿主重推一次。
        this.host.broadcastSessionList();
    }

    /** 会话被换掉：旧标题作废。 */
    private noteSessionReplaced(): void {
        this.piSessionTitle = "";
        // 后台命令清单也跟着会话走：换会话 / 换进程以后旧的那些都不认了
        this.bashTasks.clear();
        // 「加载了什么」同理：新进程会重新报一份
        this.envSnapshot = undefined;
    }

    // ---- 后台命令（那个接管了 bash 的扩展报上来的）----

    /** 这个会话的后台命令清单（新的排前面）：界面那一格「脚本」用它、刷新后重画也用它。 */
    public listBashTasks(): BashTaskInfo[] {
        return Array.from(this.bashTasks.values()).sort((a, b) => b.no - a.no);
    }

    // ---- 「加载了什么」（那个报清单的扩展报上来的）----

    /** 最近一份「工具 / 技能 / MCP」清单；还没报过来就是 undefined。 */
    public envInfo(): EnvSnapshot | undefined {
        return this.envSnapshot;
    }

    /** 扩展报来一份清单（见 envProtocol.ts）：存下并推给界面。 */
    private noteEnvSnapshot(snapshot: EnvSnapshot): void {
        this.envSnapshot = snapshot;
        this.post({ type: "envInfo", env: snapshot });
    }

    /** 扩展报来一条后台命令的开始 / 结束（见 bashProtocol.ts）。 */
    private noteBashTask(ev: BashTaskEvent): void {
        const prev = this.bashTasks.get(ev.no);
        // 界面上点过「停」的那条：扩展那边也会看到进程退出，别把它改写成「失败」
        const stopped = prev?.status === "stopped";
        const status: BashTaskInfo["status"] = ev.kind === "start"
            ? "running"
            : (stopped ? "stopped" : (ev.exitCode === 0 ? "done" : "failed"));
        const info: BashTaskInfo = {
            no: ev.no,
            toolCallId: ev.toolCallId,
            cmd: ev.cmd,
            log: ev.log,
            pid: ev.pid ?? prev?.pid ?? 0,
            startedAt: ev.startedAt ?? prev?.startedAt ?? Date.now(),
            background: ev.background,
            status,
            exitCode: ev.exitCode,
            elapsedMs: ev.elapsedMs,
        };
        this.bashTasks.set(ev.no, info);
        console.error(`[后台命令] #${ev.no} ${ev.kind === "start" ? "转到后台" : status === "done" ? "跑完" : "结束（" + status + "）"}：${ev.cmd.slice(0, 80)}`);
        this.post({ type: "bashTask", task: info });
        if (ev.kind === "end") { this.host.onBashTask?.(this.id, info); }
    }

    /**
     * 界面点「放后台」：给 pi 里那个扩展留一个指令文件，它跑这条命令的时候看着这个目录
     * （见 bashBridgeSource.ts）。会话没了 / 没开这个能力就返回 false。
     */
    public detachBashTool(toolCallId: string): boolean {
        if (!toolCallId) { return false; }
        const base = this.host.getConfig().bashDir ?? "";
        if (!base) { return false; }
        // 文件名跟扩展那边一致：编号里可能带斜杠（嵌套调用是 <父>/<序号>）
        const name = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
        const dir = `${base}/detach`;
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(`${dir}/${name}`, "");
            return true;
        } catch {
            return false;
        }
    }

    /** 界面点开一条后台命令时要看的那段输出（日志尾部）；不属于这个会话就是 undefined。 */
    public bashTaskLog(no: number): string | undefined {
        const task = this.bashTasks.get(no);
        if (!task) { return undefined; }
        return readBashLogTail(task.log, SessionRuntime.BASH_LOG_VIEW_BYTES);
    }

    /** 界面上一次最多给多少输出（字节）：再多让模型/人自己去读文件。 */
    private static readonly BASH_LOG_VIEW_BYTES = 64 * 1024;

    /** 界面点「停」：把这条后台命令连它派出来的进程一起杀掉。停的了返回 true。 */
    public stopBashTask(no: number): boolean {
        const task = this.bashTasks.get(no);
        if (!task || task.status !== "running" || !task.pid) { return false; }
        killTaskTree(task.pid);
        const next: BashTaskInfo = { ...task, status: "stopped" };
        this.bashTasks.set(no, next);
        this.post({ type: "bashTask", task: next });
        return true;
    }

    /**
     * 从 get_state 响应里读会话标题（pi 只在改名时发事件，加载已有会话得靠这里补）。
     *
     * 响应里没带 sessionName 就维持原样，不清空：换会话的路径（新建 / 切换 / 分叉 / 克隆 / 新进程）
     * 已经先调过 noteSessionReplaced 清掉了；反过来清会误伤——get_state 的回包可能比
     * session_info_changed 事件更早发出，到手时标题已经更新过了。
     */
    private captureSessionName(state?: RpcSessionState | null): void {
        if (state && typeof state.sessionName === "string" && state.sessionName.trim()) {
            this.setSessionTitle(state.sessionName);
        }
    }

    /** 主动问 pi 一次当前会话标题（切换到已有会话后用）。 */
    private async refreshSessionTitle(): Promise<void> {
        const resp = await this.request<RpcSessionState>({ type: "get_state" });
        this.captureSessionName(resp?.data);
    }

    public isRunning(): boolean {
        return !!this.client && this.client.isRunning();
    }

    private setPiReady(ready: boolean): void {
        this.piReady = ready;
        this.post({ type: "piReady", ready });
        this.host.broadcastSessionList();
    }

    /** 发送当前模型信息给 webview。 */
    public async sendCurrentModel(): Promise<void> {
        const resp = await this.request<RpcSessionState>({ type: "get_state" });
        this.captureSessionName(resp?.data);
        // 会话文件也顺手记下来：界面上“这个会话被关掉了，重新打开”要靠它；
        // 另外“这个历史会话是不是已经开着”也是比这个路径（见 sessionRunningFile）。
        const sessionFile = resp?.data?.sessionFile;
        if (sessionFile) { this.currentSessionPath = sessionFile; }
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
    }

    /** 中止该会话正在进行的生成 + bash 工具。
     *  与 pi TUI 的 Esc 一致：先 clear_queue 再 abort。否则当前轮结束后 pi 会在轮次边界
     *  把 steering 队列投递出去再被 abort 停掉，表现为“消息先投递一次才中止”。
     *  清空后 pi 推送空队列的 queueUpdate，webview 侧把未投递文本写回输入框。 */
    public abortActiveRun(): void {
        if (this.client && this.client.isRunning() && this.streaming) {
            this.abortRequested = true;
            this.client.send({ type: "abort_bash" });
            this.client.send({ type: "clear_queue" });
            this.client.send({ type: "abort" });
        }
    }

    /** 界面上点了「卡住了」：终止这一轮，等它真正停稳了再把 text 发出去。
     *
     *  不能当下就发：会话正忙时这条会走进 steering 队列，在轮次边界先被投递一次才中止
     *  （abortActiveRun 先 clear_queue 就是为这个）。这句由运行时记着，不靠界面等着 ——
     *  点完刷新页面、关掉页面，那句话照样发得出去。
     *  会话其实已经闲了（点的那一下正好卡在收尾）就直接发。 */
    public abortThenSend(text: string): void {
        const message = text.trim();
        if (!message) { return; }
        if (this.client && this.client.isRunning() && this.streaming) {
            this.pendingAfterAbort = message;
            this.abortActiveRun();
            return;
        }
        this.handleSend(message);
    }

    public handleSend(
        text: string,
        images?: Array<{ data: string; mimeType: string }>,
        opts?: { followUp?: boolean; steer?: boolean }
    ): void {
        const hasImages = Array.isArray(images) && images.length > 0;
        if ((!text || !text.trim()) && !hasImages) {
            return;
        }
        // 插件代发的消息：不当命令解析、也不按「人打的」那种猜法走，投递方式由调用方指定。
        const fromPlugin = opts?.followUp === true || opts?.steer === true;
        // pi 的内置斜杠命令只在终端界面里处理，走 RPC 发过去只会当成普通文字交给模型。
        // 其中 /compact 插件自己接手：改发 pi 的 compact 命令（pi 的 prompt 里做不了这个）。
        // /goal 系列同样由插件接手（目标状态、提示词都在宿主那边）。
        // 带图片、或者是插件代发的（子会话结果交回这类）不当命令看。
        if (!hasImages && !fromPlugin) {
            const instructions = parseCompactCommand(text || "");
            if (instructions !== null) {
                this.hasConversation = true;
                if (!this.client || !this.client.isRunning()) {
                    this.startClient();
                }
                void this.compactContext(instructions);
                return;
            }
            const goalCmd = parseGoalCommand(text || "");
            if (goalCmd && this.host.onGoalCommand) {
                this.hasConversation = true;
                if (!this.client || !this.client.isRunning()) {
                    this.startClient();
                }
                this.host.onGoalCommand(this.id, goalCmd);
                return;
            }
        }
        // 发送即占用当前会话：等待 pi 回传 message_start 的间隙也不能被历史会话覆盖。
        this.hasConversation = true;
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
        }
        // 技能/模板简写改写："/grill-me" → "/skill:grill-me"（命中缓存才改写；
        // 缓存未就绪时原样透传，同时后台补拉，下次可用）
        let message = text || "";
        if (message.startsWith("/")) {
            message = expandSlashCommand(message, this.cachedCommands ?? []);
            if (!this.cachedCommands) {
                void this.refreshCommands();
            }
        }
        // user 气泡统一由 pi 的 message_start 事件渲染（见 onPiEvent），
        // 普通消息与排队投递（steer / followUp）的消息走同一路径，避免双发。

        // 都发 prompt + streamingBehavior，堵住“插件这边看着空闲、pi 那边其实已经在跑”的间隙
        // （两个子会话同时交回结果时，两条消息背靠背发出去：第一条开了轮，第二条还是普通 prompt，
        // pi 就报 “Agent is already processing”，消息直接丢掉）。三种走法：
        // - 插件代发的消息，投递方式由调用方定：
        //   · opts.followUp（子会话结果交回、派活补话这类）：一律 followUp。那是另一件事的产出，
        //     不该在正在跑的那轮半路插进去改方向；pi 在忙就排进 followUp 队列，当前这轮整个跑完
        //     再作为新的一轮处理；空闲就直接开新轮次；
        //   · opts.steer（后台命令跑完交回）：一律 steer。那条命令是模型自己脱手出去、还答应过
        //     「跑完会告诉你」的，结果到了就该在下一个轮次边界投递，别等它把手上这轮全干完；
        //     pi 空闲时 streamingBehavior 不起作用，跟普通新轮次一样；
        // - 人打的消息、会话看着空闲：prompt + followUp。pi 空闲就是普通新轮次；其实在忙就排进
        //   followUp 队列，当前轮跑完接着处理，不报错不丢消息；
        // - 人打的消息、会话看着在跑：prompt + steer。pi 真在忙就排进 steering 队列（当前轮工具
        //   执行完就投递，与原来发 steer 命令等效）；其实已经跑完（结束事件还没送到）就直接开
        //   新轮次，消息不会卡在队列里。
        const streamingBehavior: "steer" | "followUp" = opts?.steer
            ? "steer"
            : opts?.followUp
                ? "followUp"
                : this.streaming ? "steer" : "followUp";
        const cmd: Record<string, unknown> = { type: "prompt", message, streamingBehavior };
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

    /** 更新当前 agent 阶段，并同步给界面 / 会话列表。 */
    private setActivity(activity: RuntimeActivity, detail = ""): void {
        if (this.activity === activity && this.activityDetail === detail) {
            return;
        }
        this.activity = activity;
        this.activityDetail = detail;
        this.post({ type: "activityChanged", activity, detail });
        this.host.broadcastSessionList();
    }

    // ---- 生成速度（t/s）----
    // 只算“模型真在吐字”的那段时间：每次模型调用从 message_start 到 message_end 算一段，
    // 调用之间跑工具的时间不算（不然跑个一分钟的 bash，速度就被摊成个位数）。
    // token 数是估的（见 estTokens），正文、思考、工具参数都算 —— 这三样现在都不整体
    // 往界面传（见 DETAIL_PREVIEW_CHARS），所以在后端这头数：原文只有它全看得见。
    // 一轮（agent_start → agent_settled）里的多次模型调用合起来算一个数；跑的过程中
    // 250ms 发一次，停下来结算成这一轮的最终值，界面一直挂着它到下轮开始。

    /** 一次模型调用开始吐字。 */
    private beginGenCall(): void {
        if (this.genCallStart === 0) { this.genCallStart = Date.now(); }
    }

    /** 一次模型调用结束：这段吐字时间记进总账（之后跑工具时读数就停在那儿不动了）。 */
    private endGenCall(): void {
        if (this.genCallStart === 0) { return; }
        this.genMs += Date.now() - this.genCallStart;
        this.genCallStart = 0;
        this.postTps(true);
    }

    /** 模型吐出来的一段原文（正文 / 思考 / 工具参数）记进这一轮的速度账。 */
    private noteGenTokens(text: string): void {
        const tk = estTokens(text);
        if (tk <= 0) { return; }
        this.genTokens += tk;
        this.postTps();
    }

    /** 到现在为止这一轮的平均速度（token / 秒）；还没吐够 0.3 秒先不报（数太少会蹦出离谱的大数）。 */
    private currentTps(): number | undefined {
        const ms = this.genMs + (this.genCallStart > 0 ? Date.now() - this.genCallStart : 0);
        if (this.genTokens <= 0 || ms < 300) { return undefined; }
        return this.genTokens / (ms / 1000);
    }

    /** 把速度发给界面：增量来得密，跑的当中 250ms 一次；调用结束 / 这一轮结束当场发。 */
    private postTps(force = false): void {
        const now = Date.now();
        if (!force && now - this.genTpsSyncedAt < 250) { return; }
        this.genTpsSyncedAt = now;
        this.tps = this.currentTps();
        this.post({ type: "tps", value: this.tps ?? null });
    }

    // ---- pi 事件 ----
    private onPiEvent(evt: any): void {
        switch (evt.type) {
            case "queue_update":
                // steering/followUp 队列变化（steer 排队/投递/abort 后清空）
                this.queuedSteering = Array.isArray(evt.steering) ? evt.steering.slice() : [];
                this.queuedFollowUp = Array.isArray(evt.followUp) ? evt.followUp.slice() : [];
                this.post({
                    type: "queueUpdate",
                    steering: this.queuedSteering.slice(),
                    followUp: this.queuedFollowUp.slice(),
                });
                break;
            case "message_start": {
                // pi 推送 user 消息开始（含 steer 投递的排队消息）：统一在此渲染 user 气泡，
                // 替代 handleSend 里的主动 post，使普通/steer 两种路径行为一致。
                const m = evt.message;
                if (m && (m.role === "user" || m.role === "assistant")) {
                    this.hasConversation = true;
                }
                // 模型开始吐字：这段时间的账从这刻起算（工具跑完接着调就另开一段）
                if (m && m.role === "assistant") {
                    this.beginGenCall();
                }
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
                this.runStarted = true;
                this.abortRequested = false;
                this.lastShownRunError = "";
                // 新一轮：速度从零开始算（上一个数从这一刻作废，界面 streamStart 也会清空）
                this.genTokens = 0;
                this.genMs = 0;
                this.genCallStart = 0;
                this.genTpsSyncedAt = 0;
                this.tps = undefined;
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
                        // 只发摘要（见 clipDetail）：开一段新的思考账
                        this.beginThinkingDetail();
                        // 先给界面一个开场信号：标签马上出现、带着转圈，增量还没来也不干等。
                        // 编号一并给它：以后点开提示框要取全文，就按这个编号要。
                        this.post({ type: "thinkingStart", detailKey: this.thinkDetailKey });
                        break;
                    case "thinking_delta": {
                        // 某些 provider 可能省略 thinking_start，收到 delta 也应进入 thinking。
                        this.setActivity("thinking");
                        // 速度账算原文，跟“发不发出去”无关（超过预览字数的不发，但 token 照样算）
                        this.thinkSawDelta = true;
                        this.noteGenTokens(a.delta);
                        // 预览字数以内照旧逐字推，超过的不再发（全文留在内存里，点开再取）
                        const clipped = this.appendThinkingDetail(a.delta);
                        if (clipped.delta || clipped.omitted !== undefined) {
                            this.post({
                                type: "thinkingDelta",
                                delta: clipped.delta,
                                omitted: clipped.omitted,
                                detailKey: clipped.omitted === undefined ? undefined : this.thinkDetailKey,
                            });
                        }
                        break;
                    }
                    case "thinking_end": {
                        // 个别 provider 只给收尾、不给逐字增量：这时才拿全文补算速度账（给了 delta 的不能重算）
                        if (!this.thinkSawDelta && typeof a.content === "string") {
                            this.noteGenTokens(a.content);
                        }
                        // pi 在收尾事件里带整段思考文本（个别 provider 只给收尾、不给逐字增量）：
                        // 发给界面把这一段补全（见 media/chat.js 的 endThinking）。
                        const clipped = this.finishThinkingDetail(
                            typeof a.content === "string" && a.content ? a.content : undefined,
                        );
                        if (clipped) {
                            this.post({
                                type: "thinkingFull",
                                text: clipped.text,
                                omitted: clipped.omitted,
                                detailKey: clipped.detailKey,
                            });
                        }
                        this.setActivity("working");
                        break;
                    }
                    case "text_start":
                    case "text_delta":
                        this.setActivity("working");
                        if (a.type === "text_delta") {
                            this.noteGenTokens(a.delta);
                            this.post({ type: "assistantDelta", delta: a.delta });
                        }
                        break;
                    case "toolcall_start":
                    case "toolcall_delta":
                    case "toolcall_end":
                        // 这里仍在生成工具调用参数，真正执行工具时再切到 tool。
                        this.setActivity("working");
                        // 参数的 JSON 也是模型一个字一个字吐出来的（写文件那种几千 token），算进速度账；
                        // 不发出去（界面上那一行摘要另有来路，见 summaryArgs）
                        if (a.type === "toolcall_delta") {
                            this.noteGenTokens(a.delta);
                        }
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
            case "session_info_changed":
                // pi 的会话标题变了（自动命名扩展生成、或用户自己 /name 改的）：界面上的会话名跟着换。
                this.setSessionTitle(evt.name);
                break;
            case "message_end": {
                // 一条 assistant 消息吐完了：这次调用的吐字时间到此为止（之后是工具在跑）
                const m = evt.message;
                if (m && m.role === "assistant") {
                    this.endGenCall();
                }
                break;
            }
            case "agent_end":
                // agent_end 只是一次底层 run 结束；后面可能还有重试、压缩或排队续跑。
                // 不能在这里发送 streamEnd，等 agent_settled 才算真正空闲。
                this.setActivity("working");
                break;
            case "agent_settled":
                this.streaming = false;
                // 这一轮结算速度：没等到 message_end 就停下的（被掐掉、出错的）也在这里封口，
                // 数发给界面留着，下一轮开始才换掉
                this.endGenCall();
                this.postTps(true);
                // 想一半就停了（点了「停止生成」、这一轮被掐掉），或者个别 provider 根本不发收尾：
                // 把已经想到的那段结算给界面，那颗 think 点开才不是空的。
                this.settleThinkingDetail();
                // 这一轮停下来了：还在转圈的工具标签一律收掉。正常收尾时没有这种标签，
                // 有就是这一轮被中途打断（点了「卡住了」、或 pi 把在跑的工具掐了），结果不会再来。
                this.edits.forgetRunningTools();
                this.post({ type: "toolsInterrupted" });
                this.post({ type: "streamEnd", activity: "idle" });
                this.setActivity("idle");
                // 收尾：这一轮真正开始过才报；中止过的一轮只算取消，不打扰用户。
                if (this.runStarted) {
                    const status: TurnEndStatus = this.abortRequested
                        ? "cancelled"
                        : this.lastShownRunError ? "error" : "done";
                    // 子会话把结果交回派活的会话，要用本轮最后一条 AI 回复的原文；
                    // 取不到（出错 / 为空）就是空串。
                    void this.getLastAssistantText()
                        .catch(() => "")
                        .then((replyText) => {
                            this.host.onTurnEnd({
                                panelId: this.id,
                                status,
                                lastReplyText: replyText,
                            });
                        });
                    // 界面上的花费统计照旧刷新。
                    void this.refreshStats();
                }
                this.runStarted = false;
                this.abortRequested = false;
                // 点过「卡住了」：这一轮停稳了，把那句补上（点的那一下只负责终止这一轮）
                if (this.pendingAfterAbort) {
                    const afterAbort = this.pendingAfterAbort;
                    this.pendingAfterAbort = "";
                    this.handleSend(afterAbort);
                }
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
                // 带上会话：弹给正在看这个会话的那块屏（两个窗口时别弹到没在看它的那边去）
                this.host
                    .confirmDialog(req.title ?? "确认", req.message ?? "", this.id)
                    .then((ok) => respond({ confirmed: ok }));
                break;
            case "select":
                this.host
                    .selectDialog(req.title, req.options ?? [], this.id)
                    .then((value) =>
                        value === undefined ? respond({ cancelled: true }) : respond({ value })
                    );
                break;
            case "input":
            case "editor":
                this.host
                    .inputDialog(req.title, req.placeholder, req.prefill, this.id)
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

    /** 这个会话改过哪些文件（文件侧边栏那一格「改动」用）。 */
    public getChanges(): SessionChangeInfo[] {
        return this.edits.changes();
    }

    /** 一个文件的合计 diff（相对写法 = 清单里那一行）。 */
    public changeDiff(relPath: string): string | undefined {
        return this.edits.changeDiff(relPath);
    }

    /** 把一个文件整份回到这个会话第一次改它之前的样子。 */
    public async revertFileChanges(relPath: string): Promise<void> {
        return this.edits.revertFileChanges(relPath);
    }

    // ---- 会话加载 ----
    public async loadSession(file: string): Promise<void> {
        if (!this.client || !this.client.isRunning()) {
            this.startClient();
        }
        this.loading = true;
        this.host.broadcastSessionList();
        this.edits.reset();
        this.hasConversation = false;
        this.post({ type: "clear" });

        // 等待 pi 真正就绪（冷启动需数秒），避免命令挤在超时上
        const ready = await this.waitReady();
        if (!ready) {
            this.loading = false;
            this.host.broadcastSessionList();
            this.post({
                type: "systemError",
                text: "pi 进程未能就绪，无法加载会话。请确认 pi 可正常启动。",
            });
            return;
        }

        const switchResp = await this.request({ type: "switch_session", sessionPath: file });
        if (!switchResp || switchResp.success === false) {
            this.loading = false;
            this.host.broadcastSessionList();
            this.post({
                type: "systemError",
                text: `加载会话失败: ${switchResp?.error ?? "未知错误"}`,
            });
            return;
        }

        const msgResp = await this.request<{ messages: any[] }>({ type: "get_messages" });
        const messages: any[] = msgResp?.data?.messages ?? [];
        this.noteSessionReplaced();
        // replay：这一批是“把历史再画一遍”，跟 replayHistory 同一种东西：界面不给它们挂进场动画
        //（重播几百条各跑一遍 250 毫秒的进场，手机上是看得出来的卡）
        this.renderWindowed(messages, { sink: (msg) => this.post({ ...msg, replay: true }) });
        // 这一屏画完了（跟 replayHistory 那条路的收尾同一个意思）：界面靠它把攒着的重放
        // 画出来（只画最后一截，见 media/chat.js 的 flushReplayBuf）。没有这条，界面会
        // 一直攒到下一次消息才画。
        this.post({ type: "syncPoint" });
        this.currentSessionPath = file;
        // 已有会话的标题不会走 session_info_changed，得主动问一次
        void this.refreshSessionTitle();
        this.loading = false;
        this.host.broadcastSessionList();
        this.refreshStats();
    }

    /**
     * 把已有对话整屏重画一遍：pi 进程仍活着，不重新 switch_session，
     * 直接向 pi 取当前消息树重绘（消息带新的 panel 编号）。
     *
     * 两种情况用它：活体迁移到另一个工作区（会话搬家），以及浏览器页面刷新 / 重连。
     * @param opts.note 重画后额外给用户的一行提示。缺省为“会话已迁入本工作区（…）”；
     *                  传空串表示不发提示；文本里的 {count} 会换成消息条数。
     * @param opts.sink 只把这批重画消息交给这个出口（浏览器那边一个页面一份重画时用）。
     *                  传了 sink 就不再广播会话列表（那份数据每个页面都一样，
     *                  重连的页面本来就有；刚加载的页面由 ready 那条路统一发）。
     * @param opts.full 网页端也发全部历史，不裁成「最近一段」。只有“页面手上本来
     *                  就有这些内容、只是中间缺了一段”的重连才传它：裁掉的那些正是
     *                  人当时看着的地方，一裁视野就没了。刚打开的页面不传（首屏要快）。
     */
    public async replayHistory(opts?: { note?: string; sink?: MessageSink; full?: boolean }): Promise<void> {
        // 缺省出口是这个会话的常规广播；传了 sink 就是"只给某一个页面重画"。
        // 两条路都要带上 sessionId：界面靠它认出消息属于哪一个会话。
        const sink = opts?.sink;
        // replay: 这一批是“把历史再画一遍”，不是刚发生的事。界面靠它区分：重放的要插在
        // “重放到哪儿”的游标处，实时的（断线中间还在长的正文、用户刚发的消息）一律接到末尾
        //（见 media/chat.js 的 placeUnit）。
        const emit: MessageSink = sink
            ? ((msg) => sink({ ...msg, sessionId: this.id, replay: true }))
            : ((msg) => this.host.postToSession(this.id, { ...msg, replay: true }));
        // keepDraft：重画不清输入框里没发出去的文字和附件。重画只是把对话内容重新递一遪，
        // 人打了一半的字不该被抹掉（换会话那种 clear 不带这个标记，草稿仍会重置）。
        // reconcile：后面重放的每条都带编号（id），界面可以按编号认出“这条我已经画过”，
        // 原地留着、只补缺的（见 media/chat.js 的 case "clear" 与 placeNode）。老界面不认
        // 这个标记，照旧清空重画——两边怎么走都对得上。
        emit({ type: "clear", keepDraft: true, reconcile: true });
        emit({ type: "piReady", ready: this.piReady });
        // 排队里的那几条也补一份现在的真相：重画只重放消息，排队不是消息，界面上那一块
        // 只能靠这一条对齐（空的也要发，不然它还照着断线前收到的旧样子显示“在排队”）。
        emit({ type: "queueUpdate", steering: this.queuedSteering.slice(), followUp: this.queuedFollowUp.slice() });
        if (!this.client || !this.client.isRunning()) {
            emit({
                type: "system",
                text: "会话已迁入本工作区（pi 进程当前未运行；发送消息会自动重启）。",
            });
            return;
        }
        const msgResp = await this.request<{ messages: any[] }>({ type: "get_messages" });
        if (!msgResp) {
            emit({ type: "systemError", text: "迁移后重放对话失败（pi 无响应）。" });
            return;
        }
        const messages: any[] = msgResp.data?.messages ?? [];
        // 快照随运行时一起迁过来了：迁移前的 edit/write 仍可回滚
        // 网页端只发最近一段历史：先裁窗口、告诉页面还有没有更早的，再渲染窗口里那几条
        const win = this.host.wantsTrimmedHistory?.() && opts?.full !== true
            ? this.sliceHistoryWindow(messages)
            : null;
        if (win) {
            this.noteHistoryWindow(win, messages);
            emit({ type: "historyWindow", hasMore: win.hasMore, hidden: win.hidden });
        } else {
            this.historyWindowStart = -1;
        }
        this.renderMessages(win ? win.list : messages, {
            revertable: true,
            sink: emit,
            // 编号基数：窗口模式下窗口不是从第一条开始的，用绝对下标，重放两次的编号才一样
            indexBase: win ? win.start : 0,
            // 网页端这一份只带最近的图（更早的界面上点开再取），否则首屏要传的字节数会很大
            inlineImages: win ? this.planInlineImages(win.list) : (opts?.full ? this.planInlineImages(messages) : undefined),
        });
        const count = messages.filter((m) => m && (m.role === "user" || m.role === "assistant")).length;
        const note = opts?.note === undefined
            ? "会话已迁入本工作区（{count} 条消息，pi 进程与上下文原样保留）。"
            : opts.note;
        const noteText = note.replace("{count}", String(count));
        if (noteText) {
            emit({ type: "system", text: noteText });
        }
        // 只给一个页面重画时不再广播会话列表：那份数据每个页面都一模一样，重连的页面本来就有
        if (!sink) { this.host.broadcastSessionList(); }
    }

    // ========================================================================
    //  网页端「只发最近一段历史」（历史窗口）
    // ========================================================================

    /** 首屏窗口的条数上限（默认值；理由与字节预算一起见 historyWindowSize）。 */
    private static readonly WEB_HISTORY_WINDOW = 60;
    /** 首屏窗口的字节预算（UTF-8，默认 250 KB）：长工具输出（一条 bash 几十 KB）靠它挡住。 */
    private static readonly WEB_HISTORY_BUDGET = 250 * 1024;

    /**
     * 定下这一屏里哪些图真带数据（其余的只发占位，界面上点开再取）。
     *
     * 从最新一条往前数，累计到预算为止；最新那一张无论多大都带（不然打开来一张图都没有，
     * 反而像坏了）。返回值是 toolCallId 的集合——一张工具结果里的图要么全带、要么全不带。
     */
    private planInlineImages(list: any[]): Set<string> {
        const budget = SessionRuntime.WEB_INLINE_IMAGE_CHARS;
        const inline = new Set<string>();
        let used = 0;
        for (let i = list.length - 1; i >= 0; i -= 1) {
            const m = list[i];
            if (!m || m.role !== "toolResult" || typeof m.toolCallId !== "string") { continue; }
            const images = extractResultImages(m.content ?? m);
            let chars = 0;
            // 图在会话里的按 base64 长度算，挪出去（只有路径）的按磁盘上的字节折算
            for (const img of images) { chars += img.data ? img.data.length : Math.round(((img.bytes ?? 0) * 4) / 3); }
            if (chars === 0) { continue; }
            if (inline.size > 0 && used + chars > budget) { continue; }
            inline.add(m.toolCallId);
            used += chars;
        }
        return inline;
    }

    /**
     * 一条工具结果的图要不要真带数据：不在“带”名单里的换成占位（界面上点开再取）。
     * 占位的同时把真图留在内存里（见 rememberOmittedImages），点开时就不用再问 pi 了。
     */
    private prepareResultImages(
        toolCallId: string,
        images: ResultImageBlock[],
        inline?: Set<string>,
    ): ResultImageBlock[] {
        const wanted = !inline || inline.has(toolCallId);
        if (wanted) {
            // 挪出会话文件的图（只有路径）：这一屏要真带过去的，现在读进内存
            return images.map((img) => {
                if (!img.path || img.data) { return img; }
                const data = readStoredImage(img.path);
                return data ? { data, mimeType: img.mimeType } : { data: "", mimeType: img.mimeType, onDemand: true, bytes: img.bytes, path: img.path };
            });
        }
        if (!images.some((img) => !!img.data || !!img.path)) {
            return images;
        }
        this.rememberOmittedImages(toolCallId, images);
        // 记住的那份带 path（点开现读要用），发给页面的不带：页面上只要尺寸。
        return images.map((img) => img.data || img.path
            ? { data: "", mimeType: img.mimeType, onDemand: true, bytes: img.bytes ?? Math.round((img.data.length * 3) / 4) }
            : img);
    }

    /** 把“这一屏没带过去的图”记在内存里（点开再取时直接从这儿给）；超上限就从最早的开始丢。 */
    private rememberOmittedImages(toolCallId: string, images: ResultImageBlock[]): void {
        const chars = images.reduce((n, img) => n + img.data.length, 0);
        if (chars === 0) { return; }
        const prev = this.omittedImages.get(toolCallId);
        if (prev) {
            this.omittedImageChars -= prev.reduce((n, img) => n + img.data.length, 0);
            this.omittedImages.delete(toolCallId);
        }
        this.omittedImages.set(toolCallId, images);
        this.omittedImageChars += chars;
        while (this.omittedImageChars > SessionRuntime.OMITTED_IMAGE_KEEP_CHARS) {
            const oldest = this.omittedImages.keys().next().value;
            if (oldest === undefined) { break; }
            const dropped = this.omittedImages.get(oldest) ?? [];
            this.omittedImages.delete(oldest);
            this.omittedImageChars -= dropped.reduce((n, img) => n + img.data.length, 0);
        }
    }

    /** 从一份完整消息里找出某条工具结果的图（内存里没留着时现取的那条路用）。 */
    private imagesOfToolCall(messages: any[], toolCallId: string): ResultImageBlock[] | undefined {
        for (const m of messages) {
            if (m && m.role === "toolResult" && m.toolCallId === toolCallId) {
                const images = extractResultImages(m.content ?? m);
                return images.length > 0 ? images : undefined;
            }
        }
        return undefined;
    }

    /**
     * 界面上点开一张“首屏没带过来”的图：把那张单发回去。
     *
     * 图一般就留在内存里（重画时记的）；没留到（进程重启过 / 已经挤掉了）就去 pi 那里
     * 现取一份完整消息再找。找不到就回一条带 error 的，界面把占位标成“取不到了”。
     *
     * @param toolCallId 哪一次工具调用的结果
     * @param index 这次结果里的第几张图（从 0 数）
     */
    public async loadResultImage(toolCallId: string, index: number): Promise<void> {
        let images = this.omittedImages.get(toolCallId);
        if (!images) {
            const resp = await this.request<{ messages: any[] }>({ type: "get_messages" });
            images = this.imagesOfToolCall(resp?.data?.messages ?? [], toolCallId);
            if (images) { this.rememberOmittedImages(toolCallId, images); }
        }
        const img = images ? images[index] : undefined;
        // 这图可能不在会话里、只在磁盘上（pi 的扩展挪出去了），现读一份
        const data = img && !img.data && img.path ? readStoredImage(img.path) : (img?.data ?? "");
        if (!img || !data) {
            this.post({ type: "resultImage", toolCallId, index, error: "这张图取不到了。" });
            return;
        }
        this.post({ type: "resultImage", toolCallId, index, data, mimeType: img.mimeType });
    }

    // ========================================================================
    //  「只发摘要、点开再取」：思考全文 / 工具参数 / 工具输出
    // ========================================================================
    //
    // 这些东西在界面上默认都是收起的：思考只在提示框里看，工具标签上只有一个名字，
    // 工具输出要点开才有。全发过去等于把看不见的内容也塞进手机上那条网络（实测一个
    // 919 条消息的真会话里，首屏那 782 KB 消息有约 87% 是它们），所以：
    //   - 思考全文、工具输出：一个字都不发（只留“一共多少字 + 编号”），全文留在这边，
    //     界面上点开提示框时一次问回来
    //     （键是 `think:<名字>` 与 `result:<toolCallId>`，见 media/chat.js 的 clipOf / pumpClipDetails）；
    //   - 工具参数：只带“一行字那么多”的摘要字段（命令、路径这些，每个字段最多 160 字，
    //     write / edit 的正文整个不带），整份留在内存里、点开提示框再取（键是
    //     `args:<toolCallId>`）——那行一直看得见的调用摘要（`$ 命令`）要用它。
    // 实时流与历史重放走的是同一套（实时在 onPiEvent / EditTracker，重放在 renderMessages）。

    /**
     * 把一段长文字裁成「预览 + 记号」：不超过预览字数的原样给，超过的只给开头，
     * 全文留在内存里（点开再取）。返回值多一个 `omitted`（一共多少字）与 `detailKey`。
     */
    public clipDetail(detailKey: string, text: string): { text: string; omitted?: number; detailKey?: string } {
        const limit = SessionRuntime.DETAIL_PREVIEW_CHARS;
        if (text.length <= limit) { return { text }; }
        this.rememberDetail(detailKey, text);
        return { text: text.slice(0, limit), omitted: text.length, detailKey };
    }

    /**
     * 工具参数：只带“一行字那么多”的摘要字段，整份不发（全文留在内存里，点开提示框再取，
     * 见 rememberDetail / loadDetails）。
     *
     * 为什么不能一个字段都不带：界面上那行**一直看得见**的调用摘要（正在跑的那一行
     * `$ 命令`、标签提示里那一行、文件名）就是从参数里取出来的，不带就只剩一个工具名了。
     * 所以按“一行字能放下的量”带：短字段原样，长字段裁到一行，嵌套结构不带；
     * write / edit 的正文（content / oldText / newText）整个不带 —— 那些是几十上百 KB 的大头，
     * 卡片上本来也有自己的 diff / 预览（预览要等点开提示框取回参数才画）。
     */
    public summaryArgs(toolCallId: string, args: unknown): {
        args?: Record<string, unknown>; argsOmitted?: number; detailKey?: string;
    } {
        let full = "";
        try { full = JSON.stringify(args ?? {}); } catch { return {}; }
        if (!full || full === "{}") { return {}; }   // 没有参数：什么都不用带
        const detailKey = `args:${toolCallId}`;
        this.rememberDetail(detailKey, full);
        const summary: Record<string, unknown> = {};
        for (const [key, value] of Object.entries((args ?? {}) as Record<string, unknown>)) {
            // write / edit 的正文：几十上百 KB，界面上这两处都用不到（卡片有 diff / 预览）
            if (SummaryOmittedArgKeys.has(key)) { continue; }
            if (typeof value === "string") {
                summary[key] = value.length > SessionRuntime.ARGS_SUMMARY_CHARS
                    ? value.slice(0, SessionRuntime.ARGS_SUMMARY_CHARS)
                    : value;
            } else if (typeof value === "number" || typeof value === "boolean") {
                summary[key] = value;
            }
            // 嵌套结构（数组 / 对象）不带：摘要那一行用不上
        }
        return { args: summary, argsOmitted: full.length, detailKey };
    }

    /** 把一段全文记在内存里（点开再取时从这儿给）；超过上限就从最早留的开始丢。 */
    private rememberDetail(detailKey: string, text: string): void {
        const prev = this.omittedText.get(detailKey);
        if (prev !== undefined) {
            this.omittedTextChars -= prev.length;
            this.omittedText.delete(detailKey);
        }
        this.omittedText.set(detailKey, text);
        this.omittedTextChars += text.length;
        while (this.omittedTextChars > SessionRuntime.DETAIL_KEEP_CHARS) {
            const oldest = this.omittedText.keys().next().value;
            if (oldest === undefined || oldest === detailKey) { break; }
            const dropped = this.omittedText.get(oldest) ?? "";
            this.omittedText.delete(oldest);
            this.omittedTextChars -= dropped.length;
        }
    }

    /** 又开始想一段新的思考：重新开一本账（见 appendThinkingDetail）。 */
    private beginThinkingDetail(): void {
        this.thinkDetailCounter += 1;
        this.thinkDetailKey = `think:${this.id}:${this.thinkDetailCounter}`;
        this.thinkDetailText = "";
        this.thinkDetailSent = 0;
        this.thinkDetailNotified = false;
        this.thinkSawDelta = false;
    }

    /**
     * 一段思考的增量：只把预览范围内的那部分发给界面，超过的攒在内存里（点开再取）。
     * @returns delta：要发给界面的那部分（已经越过预览时是空串）；
     *          omitted：刚越过预览的那一下给一个总字数（界面靠它知道“还有多少字没带过来”）；
     *          之后不再给（接着发的每条空 delta 没有意义）。
     */
    private appendThinkingDetail(delta: string): { delta: string; omitted?: number } {
        if (!this.thinkDetailKey) { this.beginThinkingDetail(); }
        const limit = SessionRuntime.DETAIL_PREVIEW_CHARS;
        this.thinkDetailText += delta;
        this.rememberDetail(this.thinkDetailKey, this.thinkDetailText);
        if (this.thinkDetailSent >= limit) {
            if (this.thinkDetailNotified) { return { delta: "" }; }
            this.thinkDetailNotified = true;
            return { delta: "", omitted: this.thinkDetailText.length };
        }
        const room = limit - this.thinkDetailSent;
        const send = delta.slice(0, room);
        this.thinkDetailSent += send.length;
        return { delta: send };
    }

    /**
     * 一段思考结束：给界面发“预览 + 一共多少字”，全文留在内存里。
     * pi 收尾时会带整段文本（个别 provider 只给收尾不给增量）：以它为准。
     */
    private finishThinkingDetail(full: string | undefined): { text: string; omitted?: number; detailKey?: string } | undefined {
        if (!this.thinkDetailKey) {
            if (!full) { return undefined; }
            this.beginThinkingDetail();
        }
        const text = full || this.thinkDetailText;
        this.thinkDetailText = "";
        this.thinkDetailSent = 0;
        this.thinkDetailNotified = false;
        if (!text) { this.thinkDetailKey = ""; return undefined; }
        const key = this.thinkDetailKey;
        this.thinkDetailKey = "";
        return this.clipDetail(key, text);
    }

    /**
     * 一段思考没等到收尾就停了（这一轮被停掉 / provider 不发 thinking_end）：把已经想到的
     * 那段当成收尾发出去（同正常收尾那条消息），界面上那颗「think」点开才有内容。
     * 正常收尾过的（thinkDetailKey 已经清掉）什么都不做。
     */
    private settleThinkingDetail(): void {
        const clipped = this.finishThinkingDetail(undefined);
        if (!clipped) { return; }
        this.post({
            type: "thinkingFull",
            text: clipped.text,
            omitted: clipped.omitted,
            detailKey: clipped.detailKey,
        });
    }

    /**
     * 界面上点开提示框了：把这一批“没带过来”的内容一次发回去。
     *
     * 一次问一把（而不是一条一条问）：一个合并标签里几十条调用，一条一个来回的话
     * 手机上要等好几秒（页面发消息是排着队的）。回一条 `details`：给到的进 items，
     * 已经挤掉了（留得太久）的进 missing，界面上把那行“正在取…”换成“取不到了”。
     */
    public loadDetails(keys: string[]): void {
        const items: Record<string, string> = {};
        const missing: string[] = [];
        // 上限只防着乱来：一屏里的条目再多也就几百个，取前 200 个够了
        for (const key of keys.slice(0, 200)) {
            if (typeof key !== "string" || !key) { continue; }
            const text = this.omittedText.get(key);
            if (text === undefined) { missing.push(key); } else { items[key] = text; }
        }
        this.post({ type: "details", items, missing });
    }

    /** 一条消息的指纹：优先用 pi 带回的 id；没有就用角色 + 正文开头（反正在同一会话里足够独特）。 */
    private messageFingerprint(m: any): string {
        if (!m) { return ""; }
        if (typeof m.id === "string" && m.id) { return m.id; }
        return `${m.role}:${textOf(m.content).slice(0, 100)}`;
    }

    /**
     * 首屏窗口：默认最多 60 条 user/assistant 消息、或者 250 KB（UTF-8），哪个先到算哪个。
     *
     * 这两个数是量出来定的（`dev/firstLoad.js --cpu 4`，4 倍降速 ≈ 手机，一个 919 条消息的
     * 真会话）：200 条 / 700 KB 时首屏要下 782 KB 消息、从点开到画完 4.1 秒（其中约 87% 是
     * 界面上收起着的思考全文、工具参数与工具输出）；压到 40 条 / 150 KB 时只剩 127 KB、3.2 秒。
     * 现在取中间值（60 条 / 250 KB，约 3～5 屏），更早的由「加载更早的消息」那颗按钮再取
     * （见 loadOlderHistory），一次也是这么多。
     * 图片另有 400 KB 的内联预算（更早的只发占位、点开再取），不随这两个数一起涨。
     *
     * 调试时可以用 PICHAT_HISTORY_WINDOW / PICHAT_HISTORY_BUDGET 改小
     * （dev/historyScroll.js 要一个很小的窗口才出现「加载更早的消息」那颗按钮）。
     */
    private historyWindowSize(): number {
        return overriddenNumber("PICHAT_HISTORY_WINDOW", SessionRuntime.WEB_HISTORY_WINDOW);
    }

    /** 首屏窗口的字节预算（UTF-8）。调试可用 PICHAT_HISTORY_BUDGET 覆盖。 */
    private historyWindowBudget(): number {
        return overriddenNumber("PICHAT_HISTORY_BUDGET", SessionRuntime.WEB_HISTORY_BUDGET);
    }

    /**
     * 从完整消息数组里裁出「最近一段」窗口。
     *
     * 起点落在哪条消息上不讲究（可能是一条工具结果）：渲染时工具结果只跟着它自己那条
     * 调用走，落单的会被忽略，界面上不会出现半截。
     * @param endBefore 只考虑这条下标之前的消息（往前补更早一段时用）；缺省到末尾。
     * @returns 裁好的片段与窗口信息；调用方保证宿主已开「只发一段」。
     */
    private sliceHistoryWindow(messages: any[], endBefore: number = messages.length): {
        list: any[];
        start: number;
        hasMore: boolean;
        hidden: number;
    } {
        // 从最新一条往前装，装到“条数上限”或“字节预算”哪个先到为止。
        // 两个都要：条数管住 DOM 的规模（一堆「哦」能塞几千条），字节管住真实体量
        // （一条 bash 输出几十 KB，十条就顶几百条普通消息）。
        const cap = this.historyWindowSize();
        const budget = this.historyWindowBudget();
        let start = endBefore;
        let count = 0;
        let bytes = 0;
        for (let i = endBefore - 1; i >= 0; i -= 1) {
            const m = messages[i];
            const size = messageBytes(m);
            // 最新那一条无论多大都带上：不然打开来一条都没有，反而像坏了
            if (start !== endBefore && (count >= cap || bytes + size > budget)) { break; }
            start = i;
            bytes += size;
            if (m && (m.role === "user" || m.role === "assistant")) { count += 1; }
        }
        // 起点只能落在 user / assistant 上（跟以前一样）：落在一条工具结果上时，它那条调用
        // 被切到了上一段里——这一屏里落单的结果没人认，往前补的那一批里又只有调用没有结果，
        // 界面上那颗工具标签就永远转圈、输出也看不见了。
        while (start < endBefore && messages[start]
            && messages[start].role !== "user" && messages[start].role !== "assistant") {
            start += 1;
        }
        let hidden = 0;
        for (let i = 0; i < start; i++) {
            const m = messages[i];
            if (!m) { continue; }
            if (m.role === "user" || m.role === "assistant") { hidden++; }
        }
        return {
            list: messages.slice(start, endBefore),
            start,
            hasMore: start > 0,
            hidden,
        };
    }

    /** 记下当前窗口位置（起点、指纹、长度），供「加载更早」时校验。 */private noteHistoryWindow(
        win: { start: number; hidden: number },
        messages: any[],
    ): void {
        this.historyWindowStart = win.start;
        this.historyWindowHidden = win.hidden;
        this.historyWindowFingerprint = this.messageFingerprint(messages[win.start]);
        this.historyWindowLength = messages.length;
    }

    /**
     * 重绘历史消息（带网页端窗口）。
     *
     * 宿主要「只发最近一段」时：先发一条 historyWindow 告诉页面还有没有更早的消息
     * （页面据此在顶部画/收按钮），再渲染窗口里那几条；否则原样全量渲染。
     * @param opts.sink 只发给这一个出口（给某一个页面重画时用）；缺省发给整个工作区。
     */
    private renderWindowed(messages: any[], opts?: { revertable?: boolean; sink?: MessageSink }): void {
        const emit: MessageSink = opts?.sink ?? ((msg) => this.post(msg));
        if (!this.host.wantsTrimmedHistory?.()) {
            this.historyWindowStart = -1;
            this.renderMessages(messages, opts);
            return;
        }
        const win = this.sliceHistoryWindow(messages);
        this.noteHistoryWindow(win, messages);
        emit({ type: "historyWindow", hasMore: win.hasMore, hidden: win.hidden });
        this.renderMessages(win.list, {
            ...opts,
            sink: emit,
            inlineImages: this.planInlineImages(win.list),
            // 窗口不是从第一条开始的：编号用绝对下标（见 renderMessages 里的 base）
            indexBase: win.start,
        });
    }

    /**
     * 网页端顶部的「加载更早的消息」按钮：把当前窗口之前的一段补发给页面。
     *
     * 补发的那批消息逐条包在 historyBatchEvent 里（页面把它们渲染进暂存区），
     * 最后一条 historyBatchEnd 让页面把暂存区整体插到顶部，并更新按钮。
     * 广播发给所有页面：几个页面同时开着时内容保持一致，谁也不用自己重算窗口。
     *
     * 会话在底下换过（换会话 / 换分支后长度变短或第一条对不上）时，旧下标作废，
     * 不往前补了，直接整屏重画一遍重置窗口。
     */
    public async loadOlderHistory(): Promise<void> {
        if (this.historyWindowStart <= 0) { return; }  // 没开过窗口 / 窗口正好从头开始（非网页端、全量发过）：按钮不该出现
        const msgResp = await this.request<{ messages: any[] }>({ type: "get_messages" });
        if (!msgResp) {
            this.post({ type: "historyBatchEnd", hasMore: this.historyWindowStart > 0, hidden: this.historyWindowHidden });
            return;
        }
        const messages: any[] = msgResp.data?.messages ?? [];
        if (
            messages.length < this.historyWindowLength
            || this.messageFingerprint(messages[this.historyWindowStart]) !== this.historyWindowFingerprint
        ) {
            // 窗口记的那份会话已经不在了（压缩过 / 换过分支）：不往前补，整屏重画一遍。
            // 发全量：页面手上本来就有更早的那些，裁成“最近一段”会当场把它们收掉。
            await this.replayHistory({ note: "", full: true });
            return;
        }
        const win = this.sliceHistoryWindow(messages, this.historyWindowStart);
        this.noteHistoryWindow(win, messages);
        const emit: MessageSink = (msg) => {
            // replay：这批是“往上补更早的历史”，界面不给它们挂进场动画（见 media/chat.js 的 enterCls）
            this.host.postToSession(this.id, { type: "historyBatchEvent", event: { ...msg, replay: true } });
        };
        this.renderMessages(win.list, { sink: emit, inlineImages: this.planInlineImages(win.list), indexBase: win.start });
        this.post({ type: "historyBatchEnd", hasMore: win.hasMore, hidden: win.hidden });
    }

    /**
     * 重绘一批历史消息。
     * @param revertable edit/write 卡片是否按内存快照开放“回滚”：活体迁移时快照
     * 还在（true），单纯加载历史会话时快照并不存在（缺省 false）。
     * @param sink 只发给这一个出口（给某一个页面重画时用）；缺省发给整个工作区。
     * @param inlineImages 只有这些 toolCallId 的图真带数据，其余只发占位（见 planInlineImages）；
     *                     不给就是全部带（本机面板、导出等场景）。
     */
    private renderMessages(
        messages: any[],
        opts?: { revertable?: boolean; sink?: MessageSink; inlineImages?: Set<string>; indexBase?: number },
    ): void {
        // 缺省还是走这个会话的常规广播；给了 sink 就只发给那一个页面（消息已经带了 sessionId）
        const emit: MessageSink = opts?.sink ?? ((msg) => this.post(msg));
        const revertable = opts?.revertable === true;
        this.hasConversation = messages.some((m) =>
            m && (m.role === "user" || m.role === "assistant")
        );
        // 消息在历史里的绝对下标（窗口模式下加上基数）：重放出来的编号跨次数稳定，
        // 界面靠它认“这条画过了、原地留着”（见 media/chat.js 的 placeNode）。
        const base = opts?.indexBase ?? 0;
        const toolResults = new Map<string, any>();
        let lastHistoryError = "";
        for (const m of messages) {
            if (m && m.role === "toolResult" && typeof m.toolCallId === "string") {
                toolResults.set(m.toolCallId, m);
            }
        }
        for (let mi = 0; mi < messages.length; mi++) {
            const m = messages[mi];
            // 编号优先用 pi 自己给的消息 id：历史被压缩 / 回滚 / 换分支之后数组下标会指到
            // 别的消息上，而界面是按编号原地复用节点的——那就把助手正文塞进用户气泡里了。
            const mid = typeof m.id === "string" && m.id ? `m${m.id}` : `h${base + mi}`;
            switch (m.role) {
                case "user":
                    emit({
                        type: "userMessage",
                        id: mid,
                        text: textOf(m.content),
                    });
                    break;
                case "assistant": {
                    const parts = Array.isArray(m.content) ? m.content : [];
                    // 一条助手消息里的各块（正文 / 思考 / 工具调用）各得一个编号，
                    // 界面按块认，同一块重放时不会再多画一份
                    let blockNo = 0;
                    const blockId = () => `${mid}:b${blockNo++}`;
                    // 这条消息的时刻（pi 记下的毫秒时间戳）：界面上鼠标停在正文上时写出来
                    // （见 media/chat.js 的 attachMsgTime）。pi 记的是毫秒数，个别调试用的 pi
                    // （dev/fakePi.js）给的是 ISO 字符串：两种都认；认不出来就不带，界面自己按现在算。
                    const rawAt = m.timestamp;
                    const stamp = typeof rawAt === "number" ? rawAt : (typeof rawAt === "string" ? Date.parse(rawAt) : NaN);
                    const at = Number.isFinite(stamp) ? stamp : undefined;
                    let text = "";
                    for (const c of parts) {
                        if (c.type === "text") {
                            text += c.text;
                        } else if (c.type === "thinking") {
                            // 思考块：跟当场生成时一样，在工具行里出一个「think」标签（内容在提示框里看）。
                            // 先把手头攒的正文发出去：免得思考排到了它前面（同 toolCall 那条）。
                            if (typeof c.thinking === "string" && c.thinking.trim()) {
                                if (text.trim()) {
                                    emit({ type: "assistantFull", id: blockId(), text, at });
                                    text = "";
                                }
                                const think = this.clipDetail(`think:${mid}:b${blockNo}`, c.thinking);
                                emit({ type: "thinkingFull", id: blockId(), text: think.text, omitted: think.omitted, detailKey: think.detailKey });
                            }
                        } else if (c.type === "toolCall") {
                            if (text.trim()) {
                                emit({ type: "assistantFull", id: blockId(), text, at });
                                text = "";
                            }
                            blockId();   // 这一块占一个号（工具调用按 toolCallId 认，但次序要跟重放一致）
                            this.edits.collectKnownFile(c.name, c.arguments);
                            if (c.name === "edit" || c.name === "write") {
                                const p = this.edits.editToolPath(c.name, c.arguments);
                                const id = c.id || `${mid}:c${blockNo++}`;
                                const summary = this.summaryArgs(id, c.arguments);
                                emit({
                                    type: "editCardStart",
                                    toolCallId: id,
                                    toolName: c.name,
                                    path: p || "",
                                    label: p ? this.host.relativeTo(this.cwd, p) : "",
                                    ...summary,
                                });
                                emit({
                                    type: "editCardResult",
                                    toolCallId: id,
                                    diff: this.edits.historyDiff(c, toolResults.get(id)),
                                    canRevert: revertable && this.edits.hasSnapshot(id),
                                });
                            } else {
                                const id = c.id || `${mid}:c${blockNo++}`;
                                const res = toolResults.get(id);
                                // 没有结果的调用分两种：这一轮真还在跑（pi 还没报结束），或者那一轮
                                // 被中断 / pi 进程没了，结果永远不会来。后者按「已结束」发给界面（带上
                                // interrupted），否则那条标签会一直转圈、耗时一直往上数（见 media/chat.js
                                // 的 settleInterruptedTools）。
                                const interrupted = !res && !this.edits.isToolRunning(id);
                                const summary = this.summaryArgs(id, c.arguments);
                                emit({
                                    type: "tool",
                                    toolName: c.name,
                                    ...summary,
                                    toolCallId: id,
                                    ...(interrupted ? { interrupted: true } : {}),
                                });
                                if (res) {
                                    const result = this.clipDetail(`result:${id}`, extractResultText(res.content ?? res) ?? "");
                                    emit({
                                        type: "toolResult",
                                        toolCallId: id,
                                        isError: !!res.isError,
                                        resultText: result.text,
                                        resultOmitted: result.omitted,
                                        detailKey: result.detailKey,
                                        truncation: extractTruncation(res),
                                        images: this.prepareResultImages(id, extractResultImages(res.content ?? res), opts?.inlineImages),
                                    });
                                }
                            }
                        }
                    }
                    if (text.trim()) {
                        emit({
                            type: "assistantFull",
                            id: blockId(),
                            text,
                            at,
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
                        emit({
                            type: "systemError",
                            id: `${mid}:e`,
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
            cost: m.cost
                ? {
                    input: m.cost.input,
                    output: m.cost.output,
                    cacheRead: m.cost.cacheRead,
                    cacheWrite: m.cost.cacheWrite,
                }
                : undefined,
        }));
        return this.cachedModels;
    }

    /** 拉取并缓存命令列表（扩展命令 / 提示模板 / 技能，get_commands）。
     *  成功时同步推一份给 webview（/ 命令菜单缓存）；失败不动旧缓存。 */
    public async refreshCommands(): Promise<RpcCommandInfo[]> {
        if (!this.client || !this.client.isRunning()) {
            return this.cachedCommands ?? [];
        }
        const ok = await this.client.waitReady(8000);
        // 等的这段时间里 panel 可能已经关掉（stopClient 把 client 置空），得再查一次。
        if (!ok || !this.client || !this.client.isRunning()) {
            return this.cachedCommands ?? [];
        }
        const resp = await this.request<{ commands?: unknown }>({ type: "get_commands" });
        const raw = Array.isArray(resp?.data?.commands) ? resp!.data!.commands : undefined;
        if (!raw) {
            return this.cachedCommands ?? [];
        }
        const list: RpcCommandInfo[] = [];
        for (const c of raw) {
            if (c && typeof c.name === "string" && c.name) {
                list.push(c as RpcCommandInfo);
            }
        }
        this.cachedCommands = list;
        // 同步给 webview：pi 进程重启 / 技能变更后菜单不掉队
        this.post({ type: "commandList", items: commandMenuItems(list) });
        return list;
    }

    /** / 命令菜单条目（webview listCommands 用）：命中缓存则零 RPC，否则现拉。 */
    public async getSlashCommandItems(): Promise<SlashCommandItem[]> {
        const list = this.cachedCommands ?? (await this.refreshCommands());
        return commandMenuItems(list);
    }

    public async pickModel(echoT0?: number, clientId?: string): Promise<void> {
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
            typeof echoT0 === "number" ? { t0: echoT0 } : undefined,
            // 点的是哪块屏，选择器就弹在哪块屏：别的窗口最近动过不代表它该弹到那边去
            clientId,
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

    /**
     * 用户在输入框里敲了 /compact：直接调 pi 的 compact 命令压缩上下文。
     *
     * 为什么不拼成 prompt 发过去：pi 的 prompt 只展开技能与提示模板，内置斜杠命令（/compact、
     * /new 这些）只在终端界面里处理，发过去只会当成普通文字交给模型。
     * 过程走 pi 的 compaction_start / compaction_end 事件（界面上就是「工作中」，失败会报出来）。
     * pi 会先停掉正在跑的那一轮再压，所以跑着的时候点也不怕。
     * @param instructions 用户跟在命令后面的话（压缩时希望保留什么），可以为空。
     */
    public async compactContext(instructions = ""): Promise<void> {
        if (!this.client || !this.client.isRunning()) {
            this.post({ type: "systemError", text: "压缩失败: pi 进程没在跑" });
            return;
        }
        const why = instructions ? `（要求：${instructions}）` : "";
        if (this.compacting) {
            this.post({ type: "system", text: "正在压缩，等这一遍完。" });
            return;
        }
        this.compacting = true;
        this.setActivity("working");
        this.post({ type: "system", text: `正在压缩上下文${why}…` });
        try {
            // 压缩要真的调一次模型写摘要，一句话可以等很久：给足时间，别被 15s 的默认值截断
            const cmd: Record<string, unknown> = { type: "compact" };
            if (instructions) { cmd.customInstructions = instructions; }
            const resp = await this.request<RpcCompactionResult>(cmd, 10 * 60 * 1000);
            if (resp?.success === false) {
                const text = formatPiError(resp.error || "未知错误");
                this.post({ type: "systemError", text: `压缩失败: ${text}` });
            } else if (!resp) {
                // 超时 / 进程没了：不能当成功（pi 那边的 compaction_end 会把失败报出来）
                this.post({ type: "systemError", text: "压缩失败: pi 没有回应" });
            } else {
                // 压缩前后都是估算值（不是精确计数），带上让用户心里有数
                const before = resp.data?.tokensBefore;
                const after = resp.data?.estimatedTokensAfter;
                const size = typeof before === "number" && typeof after === "number"
                    ? `：约 ${before} → ${after} tokens（估算）`
                    : "";
                this.post({ type: "system", text: `已压缩上下文${size}` });
            }
        } catch (e: any) {
            this.post({ type: "systemError", text: `压缩失败: ${e.message}` });
        } finally {
            this.compacting = false;
            if (!this.streaming) {
                this.setActivity("idle");
            }
            // 上下文用量变了：输入框底下那颗胶囊的横条跟上
            void this.refreshStats();
        }
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
        }
        this.post({
            type: "stats",
            tokens: d.tokens || null,
            cost: typeof d.cost === "number" ? d.cost : null,
            contextUsage: cu,
        });
    }

    // ---- 文件跳转 / diff（均相对该会话的 EditTracker）----
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

/**
 * 一条消息大概占多少字节（UTF-8），给首屏窗口的预算用。
 *
 * 两个讲究：
 *   · 图不算在内——历史里的图是完整 base64（几 MB 很常见），可真发出去时超过
 *     `WEB_INLINE_IMAGE_CHARS` 的会换成占位（几百字节）。按原始 base64 算，读了两张截图的
 *     会话会被算成好几 MB，窗口缩到一两条，首屏反而什么都没了。图交给那个 400 KB 预算管。
 *   · 不用 `JSON.stringify(整条)`：一条 20 MB 的消息那么干就是造一个 20 MB 字符串。
 *     只把文字部分按 UTF-8 累加，再给消息本身加一个小常数。
 */
function messageBytes(m: any): number {
    if (!m) { return 0; }
    const content = m.content;
    let bytes = 64;
    if (typeof content === "string") { return bytes + Buffer.byteLength(content, "utf8"); }
    if (!Array.isArray(content)) { return bytes; }
    for (const block of content) {
        if (!block) { continue; }
        if (typeof block.text === "string") { bytes += Buffer.byteLength(block.text, "utf8"); }
        else if (typeof block.thinking === "string") { bytes += Buffer.byteLength(block.thinking, "utf8"); }
        else if (block.type === "toolCall") {
            try { bytes += Buffer.byteLength(JSON.stringify(block.arguments ?? {}), "utf8"); } catch { bytes += 32; }
        } else if (block.type === "image") { bytes += 128; }   // 占位的大小，不是 base64 的
        else { bytes += 32; }
    }
    return bytes;
}

/** 调试用的数值覆盖（环境变量只写在 dev/ 的脚本里，正式跑不会设）。 */
function overriddenNumber(name: string, fallback: number): number {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

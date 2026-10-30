import type { PiClient } from "./piClient";
import type { AskRequest } from "./askProtocol";
import type { BashTaskInfo } from "./bashProtocol";
import type { AutoCommand } from "./auto";
import type { TabaRequest } from "./tabaProtocol";

/** 平台无关的 pi 运行时配置。 */
export interface PiConfig {
    piPath: string;
    provider: string;
    model: string;
    extraArgs: string[];
    trustProject: boolean;
    /**
     * 人改过的提示词（config.json 里 prompts 那一节）：键见 promptText.ts 的 PromptKey，
     * 键不在 / 值空着就用内置原文。拼提示词的地方拿它比对就行。
     */
    prompts?: Record<string, string>;
    /**
     * “派子会话”要加载的 pi 扩展文件路径（插件写在 ~/.pi/pichat/ 下）。
     * 空串或缺省表示这个工作区不开这个能力：
     * 不给 pi 加载扩展，模型那边就不会出现 taba 这几个工具。
     */
    tabaExtension?: string;
    /** 上面那个扩展要用到的资源目录（插件自带的角色文件在里面）。 */
    tabaDir?: string;
    /**
     * “问话”（ask_choice）要加载的 pi 扩展文件路径（插件写在 pichat 的目录里）。
     * 空串或缺省表示这个工作区不带这个能力：不给 pi 加载扩展，模型那边就没有 ask_choice 这个工具。
     */
    askExtension?: string;
    /** 上面那个扩展的资源目录：回话文件写在它的 ask-answers/ 下面。 */
    askDir?: string;
    /**
     * 自动起标题那个 pi 扩展文件的路径（插件写在 pichat 目录里）。
     * 只有主会话加载它：第一轮跑完让模型起个短标题写进会话名。
     * 子会话、判官不带（它们的名字由派活那边给）。空串或缺省表示不起标题。
     */
    titleExtension?: string;
    /**
     * 「会话里的截图挪出会话文件」那个扩展的路径（插件写在 pichat 目录里）。
     * 每个会话都带（子会话读图一样要挪）。空串或缺省表示图照旧整张存在会话文件里。
     */
    imageExtension?: string;
    /**
     * 「把 bash 换成能脱手到后台的版本」那个扩展的路径（插件写在 pichat 目录里）。
     * 每个会话都带（子会话、判官也跑命令）。空串或缺省表示用 pi 自己的 bash（没有后台命令）。
     */
    bashExtension?: string;
    /** 上面那个扩展的资源目录：后台命令的日志在它的 tasks/ 下，“放后台”的指令写在 detach/ 下。 */
    bashDir?: string;
    /**
     * 「把加载了什么报回来」（工具 / 技能 / MCP 服务器）那个扩展的路径（插件写在 pichat 目录里）。
     * 每个会话都带：界面侧边栏底部那颗「工具」点开看的就是它报上来的清单。
     * 空串或缺省表示那份清单一直取不到（那颗按钮会写着还没取到）。
     */
    envExtension?: string;
}

/**
 * 一个 panel（会话）启动 pi 时的额外要求。
 *
 * 普通会话不用传；派出来的子会话要传（它有自己的会话文件、提示词，
 * 而且不能再派下级）。工具一般不动：子会话跟配置里的 defaultTools 走。
 */
export interface PanelLaunch {
    /** 额外命令行参数（--session / --append-system-prompt / --tools 之类）。
     *  --tools 只在要限制工具时用（目标验收的判官），普通子会话不传。 */
    extraArgs?: string[];
    /** 不领取预热好的备用进程（参数不一样，必须新起一个）。 */
    skipSpare?: boolean;
    /** 不加载“派子会话”那个扩展（子会话不能再派）。 */
    noTaba?: boolean;
    /** 覆盖工作目录（角色文件里指定的时候）。 */
    cwd?: string;
}

/** 可选模型信息（来自 pi get_available_models）。 */
export interface ModelInfo {
    id: string;
    provider?: string;
    name?: string;
    contextWindow?: number;
    /** Whether the model supports reasoning/thinking. */
    reasoning?: boolean;
    /** Thinking levels derived from the model's thinkingLevelMap metadata. */
    thinkingLevels?: string[];
    /** 每百万 token 价格（$）；未配置或全 0 时视为未定价。 */
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** 用户在模型选择器中选中的结果。 */
export interface ModelChoice {
    provider: string;
    modelId: string;
    thinkingLevel?: string;
}

export type RuntimeActivity = "idle" | "working" | "thinking" | "tool";

/** 一条消息的出口：往一个页面（或一批页面）写一条要显示的消息。 */
export type MessageSink = (msg: Record<string, unknown>) => void;

/** 一轮对话收尾时的结果状态。 */
export type TurnEndStatus =
    /** 正常跑完 */
    | "done"
    /** 本轮报过错（模型调用失败 / 重试耗尽等） */
    | "error"
    /** 用户主动中止 */
    | "cancelled";

/** 一轮对话收尾信息，交给宿主决定怎么提醒（弹一张提醒面板；子会话把结果交回派活的会话也走这条）。 */
export interface TurnEndInfo {
    /** 收尾的会话 id */
    panelId: string;
    status: TurnEndStatus;
    /** 本轮最后一条 AI 回复的原文（子会话把结果交回派活的会话时用）；取不到时为 undefined */
    lastReplyText?: string;
}

/**
 * 平台适配层：把 VSCode 的 UI / 存储 / 文件差异隔离在插件实现里。
 * SessionRuntime 只依赖本接口 + PiClient + Node 内置 fs。
 */
export interface RuntimeHost {
    /** 工作区标识：插件里的对话面板固定为 "sidebar"，编辑器工作区为各自面板 id。 */
    readonly workspaceId: string;
    getConfig(): PiConfig;
    getCwd(): string;
    relativeTo(cwd: string, full: string): string;
    /** 把相对路径变成绝对路径。cwd 不传就用宿主默认目录；会话级的路径要传会话自己的目录（子会话 / 别的项目里开的会话）。 */
    resolvePath(p: string, cwd?: string): string;
    /** 校验 pi 可执行文件存在；失败时自行向该会话推送 systemError。返回是否可用。 */
    checkPiAvailable(piPath: string, sessionId: string): boolean;
    /** 领取一个已就绪的备用 pi 进程（无则 undefined）。领取后宿主会自动补新备用。
     *  返回值附带该进程启动时使用的模型，供领取方判断是否需要补发 set_model。 */
    claimSpareClient?(): { client: PiClient; provider?: string; modelId?: string } | undefined;

    postToSession(sessionId: string, msg: Record<string, unknown>): void;
    /**
     * 宿主是否要「整屏重画 / 加载会话时只发最近一段历史」。
     * 网页端是 true：长会话全量发下来太慢，只发最近一段（默认 60 条）消息，
     * 更早的由页面点「加载更早的消息」按钮再取。VSCode 两家维持全量。
     * 可选：缺省当 false。
     */
    wantsTrimmedHistory?(): boolean;
    /**
     * 推送会话列表到 webview（所有开着的会话 + 当前是哪一个）。
     * @param immediate 结构变更（新建/关闭/切换）传 true，跳过节流立刻推送。
     */
    broadcastSessionList(immediate?: boolean): void;
    /** 当某会话的工具触及文件集合（knownFiles）变化时通知宿主。可选。 */
    onKnownFilesChanged?(sessionId: string): void;

    /** 某 panel 的一轮对话真正结束（pi 发出 agent_settled）时调用：
     *  宿主据此决定这个会话该不该弹提醒、并把子会话的结果交回去。 */
    onTurnEnd(info: TurnEndInfo): void;

    /**
     * 某个会话里用户打了 /auto（自动模式），或者点了那颗转圈圈的图标（= 关掉）。
     * 开关状态、判官那一轮的提示都归宿主管（见 chatControllerBase 里 auto 那段）。
     * 不实现就当没这个功能：/auto 会当成普通消息发给模型。可选。
     */
    onAutoCommand?(panelId: string, cmd: AutoCommand): void;

    /**
     * 某个会话里的 pi 扩展要求“派子会话”（从那个进程的 stderr 里读到暗号）。
     * 不开这个能力的工作区（浏览器那份）不会收到。可选。
     */
    onTabaRequest?(panelId: string, request: TabaRequest): void;
    /**
     * 某个会话里的 pi 扩展要问用户一个选择题（ask_choice）：弹给正在看这个会话的那块屏，
     * 用户答完把答案写成回话文件（扩展那边在轮询那个文件）。不必等它结束。可选。
     */
    askQuestion?(request: AskRequest, sessionId?: string): void;
    /** 扩展不等这次提问了（超时/这一轮被停）：把还开着的那个浮层收掉。可选。 */
    cancelAsk?(id: string): void;

    /**
     * 某个会话里的后台命令跑到头了（跑完 / 失败 / 被停；见 bashProtocol.ts）。
     * 宿主接着：把结果当成一条新消息交回这个会话。可选。
     */
    onBashTask?(panelId: string, task: BashTaskInfo): void;

    // ---- UI 弹窗（对应当 pi 的 extension_ui_request）----
    /** @param sessionId 这是哪个会话问的：优先弹给正在看这个会话的那块屏（没人看才找“人最近动的”）。 */
    confirmDialog(title: string, message: string, sessionId?: string): Promise<boolean>;
    selectDialog(title: string, options: string[], sessionId?: string): Promise<string | undefined>;
    inputDialog(title: string, placeholder: string, prefill: string, sessionId?: string): Promise<string | undefined>;
    /** 模型选择器；取消返回 undefined。同时返回可选的思考强度及当前值。
     *  echo：透传给 webview 的调试字段（如点击计时），原样附在 picker 消息上。
     *  clientId：该把选择器弹给哪块屏（不填就现挑“人最近在动的那一块”）。 */
    pickModelInteractive(
        models: ModelInfo[],
        currentThinking: string,
        currentProvider: string,
        currentModelId: string,
        echo?: Record<string, unknown>,
        clientId?: string,
    ): Promise<ModelChoice | undefined>;
    /** 持久化用户选中的 model（写各自配置存储）。 */
    persistModel(provider: string, modelId: string): void;

    // ---- 文件跳转 / diff ----
    /** 打开文件到指定行（1-based）。anchor 为高亮定位行文本，可选。 */
    openFileLocation(path: string, line: number, anchor?: string): void;
    /** 回滚前的二次确认。message 是整句话（不同回滚的说法不一样）。返回是否继续。
     *  @param sessionId 哪个会话要回滚：优先弹给正在看它的那块屏。 */
    confirmRevert(message: string, sessionId?: string): Promise<boolean>;
}

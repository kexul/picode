import type { PiClient } from "./piClient";

/** 平台无关的 pi 运行时配置。 */
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

/** 一个 tab 当前的模型/上下文用量状态快照，供宿主展示（如 VSCode 状态栏）。 */
export interface StatusInfo {
    modelId?: string;
    provider?: string;
    thinkingLevel?: string;
    /** 上下文使用百分比 0-100。 */
    percent?: number;
    /** 已用 tokens。 */
    tokens?: number;
    /** 上下文窗口大小。 */
    contextWindow?: number;
}

export type RuntimeActivity = "idle" | "working" | "thinking" | "tool";

/**
 * 收尾提醒最多等 pi 的会话标题多久（毫秒）。
 *
 * 会话标题由 pi 那边的自动命名扩展在第一轮跑完后生成（额外问一次模型），比提醒本身慢一两秒，
 * 所以等一下再用；等不到就用会话显示名兜底，提醒一定发得出去。
 * 可在设置面板的“显示选项”里改成不等（0 秒）或等更久。
 */
export const DEFAULT_TURN_TITLE_WAIT_MS = 3000;

/** 一轮对话收尾时的结果状态。 */
export type TurnEndStatus =
    /** 正常跑完 */
    | "done"
    /** 本轮报过错（模型调用失败 / 重试耗尽等） */
    | "error"
    /** 用户主动中止 */
    | "cancelled";

/** 一轮对话收尾信息，交给宿主决定怎么提示（系统通知 / 提示音）。 */
export interface TurnEndInfo {
    /** 收尾的 panel（会话）id */
    panelId: string;
    /** panel 显示名，如“沉静的雪豹” */
    panelName: string;
    /** panel 所属 tab（容器）的显示名 */
    tabName: string;
    /** pi 自己给的会话标题（自动命名扩展或 /name 命令写的）；还没有时为空串。
     *  提醒里优先用它，这样用户一眼能认出是哪个任务跑完了。 */
    sessionTitle?: string;
    /** 工作区位置："sidebar" = 侧边栏，其余为编辑器工作区 id */
    workspaceId: string;
    status: TurnEndStatus;
    /** 本轮报错文本（status 为 error 时有值） */
    errorText?: string;
    /** 本次会话累计花费（美元），未知时为 undefined */
    costUsd?: number;
    /** 本次会话中被工具改过的文件数 */
    changedFileCount?: number;
}

/**
 * 平台适配层：把 VSCode 的 UI / 存储 / 文件差异隔离在插件实现里。
 * SessionRuntime 只依赖本接口 + PiClient + Node 内置 fs。
 */
export interface RuntimeHost {
    /** 工作区标识：侧边栏固定为 "sidebar"，编辑器工作区为各自面板 id。 */
    readonly workspaceId: string;
    getConfig(): PiConfig;
    getCwd(): string;
    relativeTo(cwd: string, full: string): string;
    resolvePath(p: string): string;
    /** 校验 pi 可执行文件存在；失败时自行向 tab 推送 systemError。返回是否可用。 */
    checkPiAvailable(piPath: string, tabId: string): boolean;
    /** 领取一个已就绪的备用 pi 进程（无则 undefined）。领取后宿主会自动补新备用。
     *  返回值附带该进程启动时使用的模型，供领取方判断是否需要补发 set_model。 */
    claimSpareClient?(): { client: PiClient; provider?: string; modelId?: string } | undefined;

    postToTab(tabId: string, msg: Record<string, unknown>): void;
    /**
     * 推送 tab 列表到 webview。
     * @param immediate 结构变更（新建/关闭/切换 tab）传 true，跳过节流立刻推送。
     */
    broadcastTabList(immediate?: boolean): void;
    /** 当某 tab 的会话路径变化（且可能为活跃 tab）时通知宿主。可选。 */
    /** 当某 tab 的模型/上下文用量状态变化时通知宿主。可选。 */
    onStatusUpdate?(tabId: string, info: StatusInfo): void;
    /** 当某 tab 的工具触及文件集合（knownFiles）变化时通知宿主。可选。 */
    onKnownFilesChanged?(tabId: string): void;

    /** 某 panel 的一轮对话真正结束（pi 发出 agent_settled）时调用：
     *  宿主据此发系统通知（Windows toast）并决定是否让界面响提示音。 */
    onTurnEnd(info: TurnEndInfo): void;

    // ---- UI 弹窗（对应当 pi 的 extension_ui_request）----
    confirmDialog(title: string, message: string): Promise<boolean>;
    selectDialog(title: string, options: string[]): Promise<string | undefined>;
    inputDialog(title: string, placeholder: string, prefill: string): Promise<string | undefined>;
    /** 模型选择器；取消返回 undefined。同时返回可选的思考强度及当前值。
     *  echo：透传给 webview 的调试字段（如点击计时），原样附在 picker 消息上。 */
    pickModelInteractive(
        models: ModelInfo[],
        currentThinking: string,
        currentProvider: string,
        currentModelId: string,
        echo?: Record<string, unknown>
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

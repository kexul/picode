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
 * 平台适配层：把 VSCode 的 UI / 存储 / 文件差异隔离在插件实现里。
 * SessionRuntime 只依赖本接口 + PiClient + Node 内置 fs。
 */
export interface RuntimeHost {
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

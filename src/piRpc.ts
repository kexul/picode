/**
 * pi --mode rpc 的轻量协议类型。
 *
 * 不直接依赖 @earendil-works/pi-coding-agent 包（插件运行时也不打包它），
 * 只描述本扩展实际用到的命令 / 响应形状，减少 sessionRuntime 里的 any。
 */

/** 发给 pi 的命令（stdin JSONL）。 */
export type RpcCommand =
    | { type: "prompt"; message: string; images?: RpcImage[]; streamingBehavior?: "steer" | "followUp" }
    | { type: "steer"; message: string; images?: RpcImage[] }
    | { type: "follow_up"; message: string; images?: RpcImage[] }
    | { type: "abort" }
    | { type: "abort_bash" }
    | { type: "clear_queue" }
    | { type: "new_session"; parentSession?: string }
    | { type: "get_state" }
    | { type: "set_model"; provider: string; modelId: string }
    | { type: "get_available_models" }
    | { type: "set_thinking_level"; level: string }
    | { type: "get_session_stats" }
    | { type: "compact"; customInstructions?: string }
    | { type: "switch_session"; sessionPath: string }
    | { type: "get_messages" }
    | { type: "get_commands" }
    | { type: "extension_ui_response"; id: string; [k: string]: unknown };

export interface RpcImage {
    type: "image";
    data: string;
    mimeType: string;
}

/** pi 回的统一响应外壳。success=false 时带 error。 */
export interface RpcResponse<T = unknown> {
    id?: string;
    type: "response";
    command?: string;
    success?: boolean;
    data?: T;
    error?: string;
}

/** 每百万 token 费率（pi models.json 的 cost，单位 $）。 */
export interface RpcModelCost {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
}

export interface RpcModelInfo {
    id: string;
    provider?: string;
    name?: string;
    contextWindow?: number;
    reasoning?: boolean;
    /** 每百万 token 价格；models.json 未配置时 pi 返回全 0。 */
    cost?: RpcModelCost;
    /** provider 原始 thinkingLevelMap；key 为档位名，null 表示禁用。 */
    thinkingLevelMap?: Record<string, string | null>;
}

export interface RpcSessionState {
    model?: RpcModelInfo;
    thinkingLevel?: string;
    isStreaming?: boolean;
    sessionFile?: string;
    sessionId?: string;
    sessionName?: string;
    messageCount?: number;
}

/** get_commands 返回的一条命令（扩展命令 / 提示模板 / 技能）。
 *  技能条目 name 带 "skill:" 前缀，如 "skill:grill-me"。 */
export interface RpcCommandInfo {
    name: string;
    description?: string;
    source?: "extension" | "prompt" | "skill";
    location?: string;
    path?: string;
}

export interface RpcContextUsage {
    percent?: number;
    tokens?: number;
    contextWindow?: number;
}

export interface RpcSessionStats {
    tokens?: unknown;
    cost?: number;
    contextUsage?: RpcContextUsage | null;
}

/** compact 命令的结果（改完上下文之后 pi 回报的压缩账）。 */
export interface RpcCompactionResult {
    summary?: string;
    /** 压缩后保留的那一段从哪条开始。 */
    firstKeptEntryId?: string;
    tokensBefore?: number;
    /** 压缩后上下文的估算大小（不是精确计数）。 */
    estimatedTokensAfter?: number;
}


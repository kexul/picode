/**
 * pi --mode rpc 的轻量协议类型。
 *
 * 不直接依赖 @earendil-works/pi-coding-agent 包（插件运行时也不打包它），
 * 只描述本扩展实际用到的命令 / 响应形状，减少 sessionRuntime 里的 any。
 */

/** 发给 pi 的命令（stdin JSONL）。 */
export type RpcCommand =
    | { type: "prompt"; message: string; images?: RpcImage[] }
    | { type: "steer"; message: string; images?: RpcImage[] }
    | { type: "follow_up"; message: string; images?: RpcImage[] }
    | { type: "abort" }
    | { type: "abort_bash" }
    | { type: "new_session"; parentSession?: string }
    | { type: "get_state" }
    | { type: "set_model"; provider: string; modelId: string }
    | { type: "get_available_models" }
    | { type: "set_thinking_level"; level: string }
    | { type: "get_session_stats" }
    | { type: "switch_session"; sessionPath: string }
    | { type: "fork"; entryId: string }
    | { type: "clone" }
    | { type: "get_fork_messages" }
    | { type: "get_tree" }
    | { type: "get_messages" }
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

export interface RpcModelInfo {
    id: string;
    provider?: string;
    name?: string;
    contextWindow?: number;
    reasoning?: boolean;
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

export interface RpcForkResult {
    text?: string;
    cancelled?: boolean;
}

export interface RpcForkMessage {
    entryId: string;
    text: string;
}

export interface RpcTreeNode {
    entry: RpcTreeEntry;
    children?: RpcTreeNode[];
}

export interface RpcTreeEntry {
    type?: string;
    id?: string;
    parentId?: string | null;
    message?: {
        role?: string;
        content?: unknown;
        stopReason?: string;
        errorMessage?: string;
        command?: string;
    };
    summary?: unknown;
    name?: unknown;
    label?: unknown;
    customType?: unknown;
}

/** request() 失败原因（超时 / 进程挂了等）。成功时 reason 为 undefined。 */
export type RpcFailReason = "not_running" | "timeout" | "send_failed" | "process_exit";

export function isRpcOk<T>(resp: RpcResponse<T> | undefined | null): resp is RpcResponse<T> & { success?: true } {
    return !!resp && resp.success !== false;
}

export function rpcErrorMessage(resp: RpcResponse | undefined | null, fallback = "未知错误"): string {
    if (!resp) {
        return fallback;
    }
    if (typeof resp.error === "string" && resp.error.trim()) {
        return resp.error;
    }
    return fallback;
}

/** 从 fork 响应取出可回填输入框的 user 原文。 */
export function forkSelectedText(resp: RpcResponse<RpcForkResult> | undefined | null): string {
    const text = resp?.data?.text;
    return typeof text === "string" ? text : "";
}

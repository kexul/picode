/**
 * 与 pi 消息 / 工具结果 / 对话树相关的纯函数。
 * 不依赖 vscode / 进程，便于单测与从 SessionRuntime 瘦身。
 */

import type { RpcModelInfo, RpcTreeEntry, RpcTreeNode } from "./piRpc";

export const THINKING_LEVEL_ORDER = [
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVEL_ORDER)[number];

/** 从 user/assistant content（string 或 parts 数组）提取纯文本。 */
export function textOf(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((c: any) => (c && c.type === "text" && typeof c.text === "string" ? c.text : ""))
            .join("");
    }
    return "";
}

/** 统计 content parts 里的图片数量。 */
export function countImages(content: unknown): number {
    if (!Array.isArray(content)) {
        return 0;
    }
    return content.filter((c: any) => c && c.type === "image").length;
}

/** 清理工具输出：去 ANSI / 控制字符，限制长度。 */
export function cleanToolOutput(text: string, maxLen = 200_000): string {
    let s = text
        .replace(/\r/g, "")
        .replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    if (s.length > maxLen) {
        s = s.slice(0, maxLen) + "\n…(输出过长已截断)";
    }
    return s;
}

/** 从工具结果 / 部分结果（或历史 toolResult 消息）中提取展示文本。 */
export function extractResultText(result: unknown): string | undefined {
    if (!result) {
        return undefined;
    }
    const r = result as any;
    const content = Array.isArray(result) ? result : r.content;
    if (Array.isArray(content)) {
        const parts = content
            .map((c: any) => (c && c.type === "text" && typeof c.text === "string" ? c.text : ""))
            .filter((s: string) => s.length > 0);
        if (parts.length > 0) {
            return cleanToolOutput(parts.join("\n"));
        }
    }
    if (typeof result === "string") {
        return cleanToolOutput(result);
    }
    if (typeof r.text === "string") {
        return cleanToolOutput(r.text);
    }
    return undefined;
}

export interface TruncationInfo {
    truncated: boolean;
    truncatedBy?: string;
    outputLines?: number;
    totalLines?: number;
    fullOutputPath?: string;
}

/** 提取 bash 等工具的截断信息与全量输出路径。 */
export function extractTruncation(result: unknown): TruncationInfo | undefined {
    const details = (result as any)?.details;
    const t = details?.truncation;
    if (!t || !t.truncated) {
        return undefined;
    }
    return {
        truncated: true,
        truncatedBy: typeof t.truncatedBy === "string" ? t.truncatedBy : undefined,
        outputLines: typeof t.outputLines === "number" ? t.outputLines : undefined,
        totalLines: typeof t.totalLines === "number" ? t.totalLines : undefined,
        fullOutputPath: typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined,
    };
}

/**
 * 把 pi / provider 的原始错误文本整理成可读形式。
 * 常见形态：`401 {"error":{"message":"Invalid API key"}}`、
 * `529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`。
 * 解析失败时原样返回（仅截断超长文本）。
 */
export function formatPiError(raw: string): string {
    const s = (raw || "").trim();
    if (!s) {
        return s;
    }
    const brace = s.indexOf("{");
    if (brace >= 0) {
        try {
            const j: any = JSON.parse(s.slice(brace));
            const m =
                typeof j?.error?.message === "string" ? j.error.message :
                typeof j?.message === "string" ? j.message :
                typeof j?.error?.type === "string" ? j.error.type :
                typeof j?.type === "string" ? j.type : "";
            if (m.trim()) {
                const prefix = brace > 0 ? s.slice(0, brace).trim() : "";
                return prefix ? `${prefix} ${m}` : m;
            }
        } catch {
            // 不是合法 JSON（可能截断），原样返回
        }
    }
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

/** 错误结果的展示文本。 */
export function extractErrorText(result: unknown): string | undefined {
    if (!result) {
        return undefined;
    }
    const content = (result as any).content;
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

/** read/edit/write 参数里的文件路径字段。 */
export function toolFilePath(args: unknown): string | null {
    if (!args || typeof args !== "object") {
        return null;
    }
    const a = args as Record<string, unknown>;
    if (typeof a.path === "string" && a.path) {
        return a.path;
    }
    if (typeof a.file_path === "string" && a.file_path) {
        return a.file_path;
    }
    return null;
}

/**
 * 从 get_available_models 返回的 Model 元数据推导可用思考档位。
 * xhigh/max 是显式 opt-in；map 里为 null 表示禁用。
 */
export function getModelThinkingLevels(model: RpcModelInfo | null | undefined): string[] {
    if (!model?.reasoning) {
        return ["off"];
    }
    const map = model.thinkingLevelMap;
    return THINKING_LEVEL_ORDER.filter((level) => {
        const mapped = map?.[level];
        if (mapped === null) {
            return false;
        }
        if (level === "xhigh" || level === "max") {
            return mapped !== undefined;
        }
        return true;
    });
}

/**
 * 精简对话树后再发给 webview：去掉 bash/diff 等大字段，避免 postMessage 被静默丢弃。
 * user 消息保留完整原文（fork 后 setInput 回填用；展示侧仍会 clip）。
 */
/** 历史会话回放：从 toolResult.details.diff 或 edit/write 参数拼出 diff 文本。 */
export function historyEditInfo(call: any, result: any): string | undefined {
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

/**
 * 按 anchor 文本在文件中定位行号（1-based）。
 * 优先 fallback 行精确匹配；再按距离交替向下/向上搜索窗口；
 * 仍没有则全文首个匹配；最后钳制 fallback。
 */
export function resolveAnchorLine(
    currentText: string,
    anchor: string,
    fallbackLine: number,
    windowSize = 200
): number {
    if (!anchor) {
        return fallbackLine;
    }
    const lines = currentText.split("\n");
    const fb0 = Math.max(0, fallbackLine - 1);
    if (lines[fb0] === anchor) {
        return fallbackLine;
    }
    for (let d = 1; d <= windowSize; d++) {
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

export function slimTree(nodes: RpcTreeNode[] | unknown[]): RpcTreeNode[] {
    if (!Array.isArray(nodes)) {
        return [];
    }
    return nodes.map((n: any) => {
        const e = n?.entry ?? {};
        const entry: RpcTreeEntry = {
            type: e.type,
            id: e.id,
            parentId: e.parentId ?? null,
        };
        if (e.type === "message" && e.message) {
            entry.message = { role: e.message.role };
            if (e.message.role === "user") {
                const text = textOf(e.message.content);
                if (text) {
                    entry.message.content = [{ type: "text", text }];
                }
            } else {
                const text = textOf(e.message.content).replace(/\s+/g, " ").trim().slice(0, 120);
                if (text) {
                    entry.message.content = [{ type: "text", text }];
                }
            }
            if (e.message.stopReason === "aborted") {
                entry.message.stopReason = "aborted";
            }
            if (e.message.errorMessage) {
                entry.message.errorMessage = e.message.errorMessage;
            }
            if (typeof e.message.command === "string") {
                entry.message.command = e.message.command;
            }
        } else if (e.type === "branch_summary") {
            entry.summary = e.summary;
        } else if (e.type === "session_info") {
            entry.name = e.name;
        } else if (e.type === "label") {
            entry.label = e.label;
        } else if (e.type === "custom" || e.type === "custom_message") {
            entry.customType = e.customType;
        }
        return { entry, children: slimTree(n.children || []) };
    });
}

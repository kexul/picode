/**
 * 与 pi 消息 / 工具结果 / 对话树相关的纯函数。
 * 不依赖 vscode / 进程，是从 SessionRuntime 里分出来的。
 */

import type { RpcModelInfo } from "./piRpc";

export const THINKING_LEVEL_ORDER = [
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

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
/** 工具结果里的图片块（read 读图等）：{ data(base64), mimeType }。 */
export interface ResultImageBlock {
    data: string;
    mimeType: string;
    /** base64 超过上限时为 true，data 置空，仅传占位信息。 */
    tooLarge?: boolean;
    /** 解码后的近似字节数（占位提示用）。 */
    bytes?: number;
    /**
     * 首屏没带过来、要等界面上“点开”再取时为 true（data 置空，仅传 mimeType/bytes）。
     * 为什么：手机上刷新一次要把这一屏的图全传过去，一屏能有好几 MB（都是截图），
     * 界面就一直空着等它。现在只带最近几张，更早的给占位，点开再单独取（见 sessionRuntime）。
     */
    onDemand?: boolean;
}

/** 单张图 base64 字符数上限（约 8MB 解码体积），超过只给占位不内联。 */
export const MAX_RESULT_IMAGE_B64 = 8 * 1024 * 1024;

/**
 * 提取工具结果 content 里的 image 块（ pi read 读图返回 {type:"image",data,mimeType} ）。
 * 超大图不内联：返回 tooLarge 占位块，避免 base64 灌爆 webview postMessage。
 */
export function extractResultImages(result: unknown, maxB64Chars: number = MAX_RESULT_IMAGE_B64): ResultImageBlock[] {
    if (!result) {
        return [];
    }
    const r = result as any;
    const content = Array.isArray(result) ? result : r.content;
    if (!Array.isArray(content)) {
        return [];
    }
    const out: ResultImageBlock[] = [];
    for (const c of content) {
        if (!c || c.type !== "image" || typeof c.data !== "string" || c.data.length === 0) {
            continue;
        }
        const mimeType = typeof c.mimeType === "string" && c.mimeType ? c.mimeType : "image/png";
        if (c.data.length > maxB64Chars) {
            out.push({ data: "", mimeType, tooLarge: true, bytes: Math.round((c.data.length * 3) / 4) });
        } else {
            out.push({ data: c.data, mimeType });
        }
    }
    return out;
}

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


// ==================== 两份文本比一遍（「改动」那一格用） ====================

/** 逐行比较的上限：两边行数相乘超过它就退成「整段换掉」，免得一个大文件把页面卡住。 */
const DIFF_MAX_CELLS = 4_000_000;
/** 一段改动前后各带几行没变的行（跟平时看的那种 diff 一样）。 */
const DIFF_CONTEXT = 3;

/**
 * 两份文本的差异，写成统一 diff 的样子：`@@ -起,数 +起,数 @@` 头，下面每行前缀
 * ` `（没变）/ `-`（原本有）/ `+`（改成有的）。没有差异返回空串。
 *
 * 这是给文件侧边栏那一格「改动」看的：页面把它交给现成的 diff 画法直接画。
 * 行尾统一按 `\n` 算（`\r\n` 先归一），最后那个换行不参与比较（有没有它算一样）。
 */
export function makeUnifiedDiff(before: string, after: string): string {
    const a = diffLines(before);
    const b = diffLines(after);
    // 头尾一样的那一截不必参与比较：改中间一行，不用把整个文件过一遍
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) { head++; }
    let tailA = a.length;
    let tailB = b.length;
    while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) { tailA--; tailB--; }
    const rows: DiffRow[] = [];
    for (let i = 0; i < head; i++) { rows.push({ op: 0, text: a[i] }); }
    rows.push(...diffMiddle(a.slice(head, tailA), b.slice(head, tailB)));
    for (let i = tailA; i < a.length; i++) { rows.push({ op: 0, text: a[i] }); }
    if (!rows.some((r) => r.op !== 0)) { return ""; }
    return diffHunks(rows);
}

/** 统一 diff 里的一行：op 0 = 没变，-1 = 原本有，+1 = 改成有。 */
interface DiffRow {
    op: 0 | -1 | 1;
    text: string;
}

/** 按行切（行尾统一成 `\n`；最后那个换行不算一行）。 */
function diffLines(text: string): string[] {
    const s = text.replace(/\r\n/g, "\n");
    const body = s.endsWith("\n") ? s.slice(0, -1) : s;
    return body === "" ? [] : body.split("\n");
}

/** 两段行求差异（最长公共子序列；太大就整段换掉）。 */
function diffMiddle(a: string[], b: string[]): DiffRow[] {
    const n = a.length;
    const m = b.length;
    if (n * m > DIFF_MAX_CELLS) {
        return [
            ...a.map((text): DiffRow => ({ op: -1, text })),
            ...b.map((text): DiffRow => ({ op: 1, text })),
        ];
    }
    const w = m + 1;
    const table = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i * w + j] = a[i] === b[j]
                ? table[(i + 1) * w + j + 1] + 1
                : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
        }
    }
    const out: DiffRow[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { out.push({ op: 0, text: a[i] }); i++; j++; }
        else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) { out.push({ op: -1, text: a[i] }); i++; }
        else { out.push({ op: 1, text: b[j] }); j++; }
    }
    while (i < n) { out.push({ op: -1, text: a[i++] }); }
    while (j < m) { out.push({ op: 1, text: b[j++] }); }
    return out;
}

/** 把逐行的差异切成一段段（每段前后带几行没变的行；挨得近的两段并成一段）。 */
function diffHunks(rows: DiffRow[]): string {
    // 每行在两边各自的起始行号（1 起）
    const aAt = new Int32Array(rows.length);
    const bAt = new Int32Array(rows.length);
    let ap = 1;
    let bp = 1;
    for (let i = 0; i < rows.length; i++) {
        aAt[i] = ap;
        bAt[i] = bp;
        if (rows[i].op !== 1) { ap++; }
        if (rows[i].op !== -1) { bp++; }
    }
    const out: string[] = [];
    let i = 0;
    while (i < rows.length) {
        if (rows[i].op === 0) { i++; continue; }
        const start = Math.max(0, i - DIFF_CONTEXT);
        let last = i;
        for (let k = i; k < rows.length; k++) {
            if (rows[k].op !== 0) { last = k; continue; }
            if (k - last > DIFF_CONTEXT) { break; }   // 中间隔得远：另起一段
        }
        const end = Math.min(rows.length, last + 1 + DIFF_CONTEXT);
        let aCount = 0;
        let bCount = 0;
        for (let k = start; k < end; k++) {
            if (rows[k].op !== 1) { aCount++; }
            if (rows[k].op !== -1) { bCount++; }
        }
        out.push(`@@ -${aAt[start]},${aCount} +${bAt[start]},${bCount} @@`);
        for (let k = start; k < end; k++) {
            const r = rows[k];
            out.push((r.op === 0 ? " " : r.op < 0 ? "-" : "+") + r.text);
        }
        i = end;
    }
    return out.join("\n");
}

/** 一段 diff 文字里加了几行、删了几行（「改动」那一格里每行后面那两个数）。 */
export function diffCounts(diffText: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of diffText.split("\n")) {
        if (line.startsWith("+")) { added++; } else if (line.startsWith("-")) { removed++; }
    }
    return { added, removed };
}

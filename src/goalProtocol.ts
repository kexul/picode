/**
 * 目标（/goal）第二段：判官会话报结论那一行暗号。
 *
 * 判官是个普通子会话（插件开的），它跑在另一个 pi 进程里；它验完以后要把结论交回插件，
 * 靠的还是 taba / ask 那套老办法：往自己进程的 stderr 写一行暗号。
 *
 *     ##PICHAT_GOAL## eyJraW5kIjoidmVyZGljdCIsInBhc3MiOmZhbHNlfQ==
 *
 * 只有单向（插件不用回话）：结论一到，插件就去改目标状态、决定还要不要催工人。
 * 为什么不用"让判官在最后一条回复里写某种格式、插件去解析"：格式一跑偏就白验一轮，
 * 而工具调用是结构化的，模型想少写一个字段都做不到。
 *
 * 本文件不依赖 vscode。
 */

import type { FrameDecoder } from "./piFrames";

/** 暗号行的前缀（跟 taba / ask 那两条不撞）。 */
export const GOAL_FRAME_PREFIX = "##PICHAT_GOAL##";

/** base64 里可能出现的字符集（用于从一行里准确切出 payload）。 */
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** 各字段的上限：超了就截断，避免一行暗号把内存吃爆。 */
const LIMITS = {
    summary: 2000,
    missingItem: 500,
    missingCount: 20,
    next: 4000,
};

/** 判官的结论。 */
export interface GoalVerdictRequest {
    kind: "verdict";
    /** 验收清单是不是全部通过（true 只有在每条都拿得出证据时才许写）。 */
    pass: boolean;
    /** 一句话结论（人看的，也写进目标条）。 */
    summary: string;
    /** 没过的验收条目：照抄目标里那几条原文，一条一句。 */
    missing: string[];
    /** 让工人接着干什么：具体、能照着改。pass 时可以空着。 */
    next: string;
}

function str(raw: unknown, limit: number): string | undefined {
    if (typeof raw !== "string") { return undefined; }
    const t = raw.trim();
    if (!t) { return undefined; }
    return t.length > limit ? t.slice(0, limit) : t;
}

/** 把解出来的 JSON 整理成一个合法结论；不合法返回 undefined。 */
export function normalizeGoalRequest(raw: unknown): GoalVerdictRequest | undefined {
    if (!raw || typeof raw !== "object") { return undefined; }
    const o = raw as Record<string, unknown>;
    if (o.kind !== "verdict") { return undefined; }
    if (typeof o.pass !== "boolean") { return undefined; }
    const summary = str(o.summary, LIMITS.summary);
    if (!summary) { return undefined; }
    const missingRaw = Array.isArray(o.missing) ? o.missing : [];
    const missing: string[] = [];
    for (const item of missingRaw) {
        const t = str(item, LIMITS.missingItem);
        if (t) { missing.push(t); }
        if (missing.length >= LIMITS.missingCount) { break; }
    }
    return {
        kind: "verdict",
        pass: o.pass,
        summary,
        missing,
        next: str(o.next, LIMITS.next) ?? "",
    };
}

/** 解一行暗号（不含换行）：拿不到合法结论就返回 undefined。 */
export function decodeGoalFrame(line: string): GoalVerdictRequest | undefined {
    const at = line.indexOf(GOAL_FRAME_PREFIX);
    if (at < 0) { return undefined; }
    let end = at + GOAL_FRAME_PREFIX.length;
    while (end < line.length && BASE64_CHARS.indexOf(line[end]) >= 0) { end++; }
    const payload = line.slice(at + GOAL_FRAME_PREFIX.length, end);
    if (!payload) { return undefined; }
    let json: string;
    try {
        json = Buffer.from(payload, "base64").toString("utf8");
    } catch {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return undefined;
    }
    return normalizeGoalRequest(parsed);
}

/** 交给 stderr 切割器（见 piFrames.ts）：认领这一种暗号。 */
export const GOAL_DECODER: FrameDecoder<"goal", GoalVerdictRequest> = {
    kind: "goal",
    prefix: GOAL_FRAME_PREFIX,
    decode: decodeGoalFrame,
};

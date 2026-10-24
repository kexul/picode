/**
 * 派子会话（taba）：插件与 pi 进程之间的暗号行协议。
 *
 * 背景：模型想派子会话时，它调用的那个工具是跑在 pi 进程里面的，而开 tab 只有插件能做。
 * 我们不开端口、不用管道：插件里的 pi 扩展往**它自己进程的 stderr** 写一行暗号，
 * 插件本来就在读每个 pi 进程的 stderr，读到暗号就知道是哪个会话要派活、要派什么。
 *
 * 一行的样子（base64 是为了让内容里没有换行、引号、中文标点，怎么切都不会切坏）：
 *
 *     ##PICHAT_TABA##eyJraW5kIjoic3Bhd24iLC4uLn0=
 *
 * 只有单向：插件不需要回话给扩展。子会话编号由扩展自己生成并报上来，
 * 子会话跑完之后的"结果交回父会话"是插件直接对父会话发 RPC 命令做的。
 *
 * 本文件不依赖 vscode。
 */

import type { FrameDecoder } from "./piFrames";

/** 暗号行的前缀。 */
export const TABA_FRAME_PREFIX = "##PICHAT_TABA##";

/** base64 里可能出现的字符集（用于从一行里准确切出 payload）。 */
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** 请求里各字段的上限：超了就截断，避免一行暗号把内存吃爆。 */
const LIMITS = {
    id: 64,
    name: 80,
    task: 20000,
    model: 120,
    thinking: 40,
    cwd: 4096,
    parentSessionFile: 4096,
};

/** 派活请求：新开一个 tab，把 task 交给它。 */
export interface TabaSpawnRequest {
    kind: "spawn";
    /** 子会话编号（扩展生成，8 位十六进制左右）；同一个 pi 进程内唯一。 */
    id: string;
    /** 显示名，例如"侦察: 认证模块"。 */
    name: string;
    /** 任务说明。 */
    task: string;
    /** 指定模型，可空（空则跟随父会话）。 */
    model?: string;
    /** 指定思考强度，可空。 */
    thinking?: string;
    /** 子会话的工作目录，可空（空则跟父会话一样）。 */
    cwd?: string;
    /** 父会话文件路径（扩展从它自己的进程里拿到的），可空。 */
    parentSessionFile?: string;
}

/** 停止请求：只停子会话当前这一轮，tab 留着。 */
export interface TabaStopRequest {
    kind: "stop";
    id?: string;
    name?: string;
}

export type TabaRequest = TabaSpawnRequest | TabaStopRequest;
/** 取字符串字段：非字符串或空串都当没有；顺带截断。 */
function str(raw: unknown, limit: number): string | undefined {
    if (typeof raw !== "string") { return undefined; }
    const t = raw.trim();
    if (!t) { return undefined; }
    return t.length > limit ? t.slice(0, limit) : t;
}

/** 编号只允许字母数字下划线连字符，防止把奇怪东西带进文件名。 */
function idOf(raw: unknown): string | undefined {
    const s = str(raw, LIMITS.id);
    if (!s) { return undefined; }
    return /^[A-Za-z0-9_-]+$/.test(s) ? s : undefined;
}

/** 把解出来的 JSON 整理成一个合法请求；不合法返回 undefined。 */
export function normalizeTabaRequest(raw: unknown): TabaRequest | undefined {
    if (!raw || typeof raw !== "object") { return undefined; }
    const o = raw as Record<string, unknown>;
    if (o.kind === "spawn") {
        const id = idOf(o.id);
        const name = str(o.name, LIMITS.name);
        const task = str(o.task, LIMITS.task);
        if (!id || !name || !task) { return undefined; }
        const req: TabaSpawnRequest = { kind: "spawn", id, name, task };
        const model = str(o.model, LIMITS.model);
        const thinking = str(o.thinking, LIMITS.thinking);
        const cwd = str(o.cwd, LIMITS.cwd);
        const parentSessionFile = str(o.parentSessionFile, LIMITS.parentSessionFile);
        if (model) { req.model = model; }
        if (thinking) { req.thinking = thinking; }
        if (cwd) { req.cwd = cwd; }
        if (parentSessionFile) { req.parentSessionFile = parentSessionFile; }
        return req;
    }
    if (o.kind === "stop") {
        const id = idOf(o.id);
        const name = str(o.name, LIMITS.name);
        if (!id && !name) { return undefined; }
        const req: TabaStopRequest = { kind: "stop" };
        if (id) { req.id = id; }
        if (name) { req.name = name; }
        return req;
    }
    return undefined;
}

/** 解一行暗号（不含换行）：拿不到合法请求就返回 undefined。 */
export function decodeTabaFrame(line: string): TabaRequest | undefined {
    const at = line.indexOf(TABA_FRAME_PREFIX);
    if (at < 0) { return undefined; }
    let end = at + TABA_FRAME_PREFIX.length;
    while (end < line.length && BASE64_CHARS.indexOf(line[end]) >= 0) { end++; }
    const payload = line.slice(at + TABA_FRAME_PREFIX.length, end);
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
    return normalizeTabaRequest(parsed);
}

/** 交给 stderr 切割器（见 piFrames.ts）：认领这一种暗号。 */
export const TABA_DECODER: FrameDecoder<"taba", TabaRequest> = {
    kind: "taba",
    prefix: TABA_FRAME_PREFIX,
    decode: decodeTabaFrame,
};

/**
 * 问话（ask_choice）：插件与 pi 进程之间那条"能来回"的路。
 *
 * taba 那条暗号是单向的（扩展往外说一句就完事，插件不用回话）；问话不行 —— 工具得等答案，
 * 所以这里多一份"回话文件"：
 *
 *   工具被调用   → 往本进程 stderr 写一行暗号（##PICHAT_ASK## + base64 的 JSON）
 *   插件读到     → 在那个会话的消息流里出一张问话卡片 → 用户答完 → 写 <资源目录>/ask-answers/<编号>.json
 *   工具轮询读到 → 当作工具结果交回模型，顺手把那个文件删掉
 *
 * 暗号行的切法与 taba 那条一致（见 tabaProtocol.ts 的说明）：一行、base64，
 * 内容里有换行或中文标点也切不坏。写文件走"先写临时文件再改名"，
 * 轮询那头永远不会读到写了一半的 JSON。
 *
 * 本文件不依赖 vscode。
 */

import * as fs from "fs";
import type { FrameDecoder } from "./piFrames";

/** 暗号行的前缀。 */
export const ASK_FRAME_PREFIX = "##PICHAT_ASK##";

/** base64 里可能出现的字符集（用于从一行里准确切出 payload）。 */
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** 各字段的上限：超了就截断，避免一行暗号把内存吃爆。 */
const LIMITS = {
    id: 64,
    question: 4000,
    option: 400,
    options: 8,
    sessionFile: 4096,
    toolCallId: 128,
};

/** 问话请求：要用户答一个问题。 */
export interface AskRequest {
    kind: "ask";
    /** 提问编号（工具生成，一次一问，插件按它写回话文件）。 */
    id: string;
    /** 问题本身（卡片上的标题）。 */
    question: string;
    /** 选项，2 到 8 个。 */
    options: string[];
    /** 能不能勾多个（false = 单选）。 */
    multi: boolean;
    /** 推荐项的下标（从 1 数起；界面上给这几项加个"我推荐"的标记）。 */
    recommended: number[];
    /** 要不要"自己写"那一行（默认要）。 */
    allowText: boolean;
    /**
     * 这次工具调用的编号（pi 给 ask_choice 那次调用的 id）。
     * 界面拿它把问话卡片挂到那条工具行下面；拿不到就退到消息流末尾。
     */
    toolCallId?: string;
    /** 提问那个会话的文件路径（扩展从自己的进程里拿到的），可空。 */
    parentSessionFile?: string;
}

/** 工具不再等这个问题的通知（超时 / 这一轮被中止）：插件据此把界面上还等着的那张卡片收掉。 */
export interface AskDoneNotice {
    kind: "ask-done";
    id: string;
}

/** 用户答完的结果（插件写、扩展读）。 */
export interface AskAnswer {
    /** 对应哪个提问。 */
    id: string;
    /** 用户按了「不答了」、没作答。 */
    cancelled: boolean;
    /** 勾中的选项（单选就是一项；空数组表示用户没勾）。 */
    picked: string[];
    /** 用户自己写的那句话（没写就是空串）。 */
    text: string;
}

/** 取字符串字段：非字符串或空串都当没有；顺带截断。 */
function str(raw: unknown, limit: number): string | undefined {
    if (typeof raw !== "string") { return undefined; }
    const t = raw.trim();
    if (!t) { return undefined; }
    return t.length > limit ? t.slice(0, limit) : t;
}

/** 编号只允许字母数字下划线连字符：它要进文件名。 */
export function isAskId(raw: unknown): raw is string {
    return typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw);
}

/** 把解出来的 JSON 整理成一个合法请求；不合法返回 undefined。 */
export function normalizeAskRequest(raw: unknown): AskRequest | undefined {
    if (!raw || typeof raw !== "object") { return undefined; }
    const o = raw as Record<string, unknown>;
    if (o.kind !== "ask") { return undefined; }
    if (!isAskId(o.id)) { return undefined; }
    const question = str(o.question, LIMITS.question);
    if (!question) { return undefined; }
    const rawOptions = Array.isArray(o.options) ? o.options : [];
    const options: string[] = [];
    for (const item of rawOptions) {
        const label = str(item, LIMITS.option);
        if (label) { options.push(label); }
        if (options.length >= LIMITS.options) { break; }
    }
    if (options.length < 2) { return undefined; }
    const recommended: number[] = [];
    if (Array.isArray(o.recommended)) {
        for (const item of o.recommended) {
            const n = typeof item === "number" ? item : NaN;
            if (Number.isInteger(n) && n >= 1 && n <= options.length && !recommended.includes(n)) {
                recommended.push(n);
            }
        }
        recommended.sort((a, b) => a - b);
    }
    const req: AskRequest = {
        kind: "ask",
        id: o.id,
        question,
        options,
        multi: o.multi === true,
        recommended,
        allowText: o.allowText !== false,
    };
    // 工具调用编号只用来在界面上认领那一行，字符集放宽一点（模型那边的 id 可能带点、冒号）。
    // 它不是文件名、也不进 HTML，只当界面上的一张查表用，截断就行。
    if (typeof o.toolCallId === "string") {
        const callId = o.toolCallId.trim().replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, LIMITS.toolCallId);
        if (callId) { req.toolCallId = callId; }
    }
    const sessionFile = str(o.parentSessionFile, LIMITS.sessionFile);
    if (sessionFile) { req.parentSessionFile = sessionFile; }
    return req;
}

/** 解一行暗号（不含换行）：拿不到合法请求就返回 undefined。 */
export function decodeAskFrame(line: string): AskRequest | AskDoneNotice | undefined {
    const at = line.indexOf(ASK_FRAME_PREFIX);
    if (at < 0) { return undefined; }
    let end = at + ASK_FRAME_PREFIX.length;
    while (end < line.length && BASE64_CHARS.indexOf(line[end]) >= 0) { end++; }
    const payload = line.slice(at + ASK_FRAME_PREFIX.length, end);
    if (!payload) { return undefined; }
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
        return undefined;
    }
    if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).kind === "ask-done") {
        const id = (parsed as Record<string, unknown>).id;
        return isAskId(id) ? { kind: "ask-done", id } : undefined;
    }
    return normalizeAskRequest(parsed);
}

/** 交给 stderr 切割器（见 piFrames.ts）：认领这一种暗号。 */
export const ASK_DECODER: FrameDecoder<"ask", AskRequest | AskDoneNotice> = {
    kind: "ask",
    prefix: ASK_FRAME_PREFIX,
    decode: decodeAskFrame,
};

/** 回话文件放哪个目录。 */
export function askAnswersDir(resourceDir: string): string {
    return resourceDir ? `${resourceDir}/ask-answers` : "";
}

/** 某次提问的回话文件路径；编号不合法返回空串。 */
export function askAnswerFile(resourceDir: string, id: string): string {
    if (!resourceDir || !isAskId(id)) { return ""; }
    return `${askAnswersDir(resourceDir)}/${id}.json`;
}

/**
 * 把答案写成回话文件（先写临时文件再改名：轮询那头不会读到半截 JSON）。
 * @returns 写成了没有；写不成（目录没了、磁盘满了）返回 false。
 */
export function writeAskAnswer(resourceDir: string, answer: AskAnswer): boolean {
    const file = askAnswerFile(resourceDir, answer.id);
    if (!file) { return false; }
    const payload: AskAnswer = {
        id: answer.id,
        cancelled: answer.cancelled === true,
        picked: Array.isArray(answer.picked) ? answer.picked.filter((x) => typeof x === "string") : [],
        text: typeof answer.text === "string" ? answer.text : "",
    };
    const tmp = `${file}.tmp`;
    try {
        fs.mkdirSync(askAnswersDir(resourceDir), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
        fs.renameSync(tmp, file);
        return true;
    } catch {
        return false;
    }
}

/** 没人来读的残留回话（插件或会话死了留下的）超过这么久就清掉。 */
export const STALE_ANSWER_MS = 24 * 60 * 60 * 1000;

/**
 * 清掉太老的回话文件（插件/后端启动时跑一次）。
 * 不管哪种情况都不会动到刚写的（小于 STALE_ANSWER_MS）。
 */
export function cleanStaleAskAnswers(resourceDir: string, now: number = Date.now()): void {
    const dir = askAnswersDir(resourceDir);
    if (!dir) { return; }
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return;    // 目录还不存在：没什么可清的
    }
    for (const name of names) {
        if (!name.endsWith(".json") && !name.endsWith(".json.tmp")) { continue; }
        const full = `${dir}/${name}`;
        try {
            if (now - fs.statSync(full).mtimeMs > STALE_ANSWER_MS) { fs.rmSync(full, { force: true }); }
        } catch {
            /* 删不掉就算了：下次启动再试 */
        }
    }
}

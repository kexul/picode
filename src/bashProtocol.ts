/**
 * 后台脚本：pi 进程里那个接管了 bash 的扩展，往 stderr 报"哪条命令转到后台了、跑完没有"。
 *
 * 单向暗号（跟派子会话那条一样，一行、base64）：
 *
 *     ##PICHAT_BASH##eyJraW5kIjoic3RhcnQiLC4uLn0=
 *
 * 反过来的那条（"把这条正在跑的命令切到后台"）不用暗号：插件往资源目录下的
 * detach/<这次工具调用的编号> 写一个空文件，扩展在跑命令的时候看着它。
 * 这样不用开端口、不用管道，也不用给 pi 加命令。
 *
 * 本文件不依赖 vscode。
 */

import * as fs from "fs";
import type { FrameDecoder } from "./piFrames";

/** 暗号行的前缀。 */
export const BASH_FRAME_PREFIX = "##PICHAT_BASH##";

/** base64 里可能出现的字符集（用于从一行里准确切出 payload）。 */
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** 各字段的上限：超了就截断，避免一行暗号太长。 */
const LIMITS = {
    id: 128,
    cmd: 2000,
    log: 4096,
};

/**
 * 后台任务的开始 / 结束。
 *
 * start 有两种来路：
 *   - 模型调用 bash 时带了 background：命令一开始就在后台跑（background=true）；
 *   - 前台正跑着，用户在界面上点了"放后台"（background=false，说明是中途转的）。
 */
export interface BashTaskEvent {
    kind: "start" | "end";
    /** 任务编号（扩展在本进程内从 1 往上排）。 */
    no: number;
    /** 是 pi 给的这次工具调用的编号（中途切后台时插件靠它对上号）。 */
    toolCallId: string;
    /** 命令原文（截断）。 */
    cmd: string;
    /** 日志文件路径：输出都接着写在这儿。 */
    log: string;
    /** 一开始就在后台跑（true）还是前台中途转过去的（false）。 */
    background: boolean;
    /** 进程号（拿不到就不带）。 */
    pid?: number;
    /** 这条命令是什么时候开始跑的（毫秒时间戳）：中途转后台时，界面上的用时从这个时刻算。 */
    startedAt?: number;
    /** 结束时的退出码；被信号杀掉时是 null。end 才有。 */
    exitCode?: number | null;
    /** 跑了多久（毫秒）。end 才有。 */
    elapsedMs?: number;
}

/** 一条后台命令在插件这边长什么样（清单、界面、「停」都用它）。 */
export interface BashTaskInfo {
    /** 任务编号（扩展在本进程内从 1 往上排）。 */
    no: number;
    /** pi 给的这次工具调用的编号。 */
    toolCallId: string;
    /** 命令原文（截断）。 */
    cmd: string;
    /** 日志文件路径。 */
    log: string;
    /** 进程号；拿不到就是 0。 */
    pid: number;
    /** 开始时刻（毫秒）。 */
    startedAt: number;
    /** 一开始就在后台跑（true）还是前台中途转过去的（false）。 */
    background: boolean;
    status: "running" | "done" | "failed" | "stopped";
    /** 结束时的退出码（被信号杀掉时是 null）。 */
    exitCode?: number | null;
    /** 跑了多久（毫秒），结束事件才有。 */
    elapsedMs?: number;
}

function str(raw: unknown, limit: number): string | undefined {
    if (typeof raw !== "string") { return undefined; }
    const t = raw.trim();
    if (!t) { return undefined; }
    return t.length > limit ? t.slice(0, limit) : t;
}

function num(raw: unknown): number | undefined {
    return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** 把解出来的 JSON 整理成一个合法事件；不合法返回 undefined。 */
export function normalizeBashTaskEvent(raw: unknown): BashTaskEvent | undefined {
    if (!raw || typeof raw !== "object") { return undefined; }
    const o = raw as Record<string, unknown>;
    if (o.kind !== "start" && o.kind !== "end") { return undefined; }
    const no = num(o.no);
    const toolCallId = str(o.toolCallId, LIMITS.id);
    const cmd = str(o.cmd, LIMITS.cmd);
    const log = str(o.log, LIMITS.log);
    if (!no || no < 1 || !toolCallId || !cmd || !log) { return undefined; }
    const ev: BashTaskEvent = { kind: o.kind, no, toolCallId, cmd, log, background: o.background === true };
    const pid = num(o.pid);
    if (pid) { ev.pid = pid; }
    const startedAt = num(o.startedAt);
    if (startedAt) { ev.startedAt = startedAt; }
    if (o.kind === "end") {
        if (o.exitCode === null) {
            ev.exitCode = null;
        } else {
            const code = num(o.exitCode);
            if (code !== undefined) { ev.exitCode = code; }
        }
        const elapsed = num(o.elapsedMs);
        if (elapsed !== undefined) { ev.elapsedMs = elapsed; }
    }
    return ev;
}

/** 解一行暗号（不含换行）：拿不到合法事件就返回 undefined。 */
export function decodeBashFrame(line: string): BashTaskEvent | undefined {
    const at = line.indexOf(BASH_FRAME_PREFIX);
    if (at < 0) { return undefined; }
    let end = at + BASH_FRAME_PREFIX.length;
    while (end < line.length && BASE64_CHARS.indexOf(line[end]) >= 0) { end++; }
    const payload = line.slice(at + BASH_FRAME_PREFIX.length, end);
    if (!payload) { return undefined; }
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
        return undefined;
    }
    return normalizeBashTaskEvent(parsed);
}

/** 交给 stderr 切割器（见 piFrames.ts）：认领这一种暗号。 */
export const BASH_DECODER: FrameDecoder<"bash", BashTaskEvent> = {
    kind: "bash",
    prefix: BASH_FRAME_PREFIX,
    decode: decodeBashFrame,
};

/** 读日志文件的最后一段（最多 want 字节），给"跑完了"那条消息用；读不到返回空串。 */
export function readBashLogTail(log: string, want: number): string {
    try {
        const size = fs.statSync(log).size;
        const from = Math.max(0, size - want);
        const fd = fs.openSync(log, "r");
        try {
            const buf = Buffer.alloc(size - from);
            let got = 0;
            while (got < buf.length) {
                const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
                if (!n) { break; }
                got += n;
            }
            return buf.subarray(0, got).toString("utf8");
        } finally {
            try { fs.closeSync(fd); } catch { /* 算了 */ }
        }
    } catch {
        return "";
    }
}

/** 跑了多久写成短的（跟界面那份一个意思，别处不好共用）。 */
function elapsedText(ms: number): string {
    const sec = Math.round(Math.max(0, ms) / 1000);
    if (sec < 60) { return sec + " 秒"; }
    const min = Math.floor(sec / 60);
    return min + " 分 " + (sec % 60 < 10 ? "0" : "") + (sec % 60) + " 秒";
}

/**
 * 后台命令跑到头了，交回会话的那段文字（当成一条新消息发过去，模型据此接着干）。
 * @param tail 日志最后一段（见 readBashLogTail）
 */
export function buildBashTaskDelivery(p: {
    no: number;
    cmd: string;
    status: BashTaskInfo["status"];
    exitCode?: number | null;
    elapsedMs?: number;
    log: string;
    tail: string;
}): string {
    const used = elapsedText(p.elapsedMs ?? 0);
    const head = p.status === "done"
        ? `【后台命令 #${p.no} 跑完了（退出码 0，用了 ${used}）】`
        : p.status === "stopped"
            ? `【后台命令 #${p.no} 被停掉了（用了 ${used}）】`
            : `【后台命令 #${p.no} 没跑成（退出码 ${p.exitCode === null || p.exitCode === undefined ? "无" : p.exitCode}，用了 ${used}）】`;
    const body = p.tail.trim() || "（没有输出）";
    return [
        head,
        `命令：${p.cmd}`,
        "",
        "最后一段输出：",
        body,
        "",
        `（完整输出在 ${p.log}；要看别的片段用 bash_tasks ${p.no}。）`,
    ].join("\n");
}

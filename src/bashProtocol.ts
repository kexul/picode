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
import type { FrameDecoder } from "./piFrames";

/** 暗号行的前缀。 */
export const BASH_FRAME_PREFIX = "##PICHAT_BASH##";
/** 只用于插件自己的自动通知，不伪装成用户消息。 */
export const BASH_NOTICE_TYPE = "pichat-bash-notice";
/** 界面已按用户要求清空队列后，取消本实例的通知记录；不操作 pi 队列。 */
export const BASH_CLEAR_NOTICE_COMMAND = "pichat-clear-bash-notice";

/** base64 里可能出现的字符集（用于从一行里准确切出 payload）。 */
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** 各字段的上限：超了就截断，避免一行暗号太长。 */
const LIMITS = {
    id: 128,
    cmd: 2000,
    log: 4096,
};

/** 每条命令待交回的输出最多保留这么多字符；长的留开头和末尾，原文在日志里。 */
export const BASH_OUTPUT_MAX_CHARS = 4000;

export interface BashOutputInfo {
    text: string;
    /** 输出被观察到的时间，不是模型收到消息的时间。 */
    firstAt: number;
    lastAt: number;
    omittedChars?: number;
}

/** 合并尚未交回的输出，不随命令输出量无限增长。 */
export function mergeBashOutput(previous: BashOutputInfo | undefined, next: BashOutputInfo, maxChars = 4000): BashOutputInfo {
    const joined = (previous?.text ?? "") + next.text;
    let text = joined;
    if (joined.length > maxChars) {
        let head = joined.slice(0, maxChars / 2);
        let tail = joined.slice(-maxChars / 2);
        if (/[\uD800-\uDBFF]$/.test(head)) { head = head.slice(0, -1); }
        if (/^[\uDC00-\uDFFF]/.test(tail)) { tail = tail.slice(1); }
        text = head + tail;
    }
    const omittedChars = (previous?.omittedChars ?? 0) + (next.omittedChars ?? 0) + joined.length - text.length;
    return {
        text,
        firstAt: Math.min(previous?.firstAt ?? next.firstAt, next.firstAt),
        lastAt: Math.max(previous?.lastAt ?? next.lastAt, next.lastAt),
        ...(omittedChars > 0 ? { omittedChars } : {}),
    };
}

/**
 * 后台任务的开始 / 结束。输出通知在 pi 内部处理，不再经后端的消息队列转发。
 *
 * start 有两种来路：
 *   - 模型调用 bash 时带了 background：命令一开始就在后台跑（background=true）；
 *   - 前台正跑着，用户在界面上点了"放后台"，或者前台撑过 20 秒自己撤的手（background=false）。
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
    /** 这条命令是怎么收场的（停掉的不看退出码：Windows 上被杀掉也可能是 1）。end 才有。 */
    status?: BashTaskInfo["status"];
    /** 跑了多久（毫秒）。end 才有。 */
    elapsedMs?: number;
    /** 是否开启输出通知。 */
    notifyOutput?: boolean;
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
    /** 只给通知用的输出，不存进任务清单。 */
    output?: BashOutputInfo;
    notifyOutput?: boolean;
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
    if (typeof o.notifyOutput === "boolean") { ev.notifyOutput = o.notifyOutput; }
    const pid = num(o.pid);
    if (pid) { ev.pid = pid; }    const startedAt = num(o.startedAt);
    if (startedAt) { ev.startedAt = startedAt; }
    if (o.kind === "end") {
        if (o.status === "done" || o.status === "failed" || o.status === "stopped") { ev.status = o.status; }
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

/** 判断自己的已填好通知；排队中的占位内容不显示，也不当成用户消息。 */
export function isBashNoticeMessage(raw: any): boolean {
    return raw?.role === "custom" && raw.customType === BASH_NOTICE_TYPE
        && raw.display !== false && raw.details?.ready === true
        && typeof raw.details.owner === "string" && typeof raw.details.noticeId === "number"
        && typeof raw.content === "string" && raw.content.length > 0;
}

/** 当场显示与历史重放用同一个编号，不能把排队占位内容先画出来。 */
export function bashNoticeMessageId(raw: any): string {
    return "bash-notice:" + raw.details.owner + ":" + raw.details.noticeId;
}

/**
 * 生成扩展与测试共用的消息拼接。函数完全自包含，生成脚本时内嵌 toString()，
 * 不再在 pi 进程与后端各维护一份输出通知格式。
 */
export function createBashNoticeFormatter(outputTemplate: string, endTemplate: string) {
    function fill(template: string, vars: Record<string, string>): string {
        return template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (whole, name: string) => vars[name] ?? whole);
    }
    function clip(text: string, max: number): string {
        if (text.length <= max) { return text; }
        let head = text.slice(0, max);
        if (/[\uD800-\uDBFF]$/.test(head)) { head = head.slice(0, -1); }
        return head + "…";
    }
    function preview(output: BashOutputInfo): string {
        let text = output.text;
        if (output.omittedChars) {
            let mid = Math.floor(text.length / 2);
            if (/[\uD800-\uDBFF]/.test(text.charAt(mid - 1))) { mid -= 1; }
            text = text.slice(0, mid) + "\n…中间省略 " + output.omittedChars + " 个字符，完整内容在日志里…\n" + text.slice(mid);
        }
        return "输出观察时间：" + new Date(output.firstAt).toISOString() + " — " + new Date(output.lastAt).toISOString() + "\n" + text;
    }
    function elapsed(ms: number): string {
        const sec = Math.round(Math.max(0, ms) / 1000);
        if (sec < 60) { return sec + " 秒"; }
        return Math.floor(sec / 60) + " 分 " + (sec % 60 < 10 ? "0" : "") + sec % 60 + " 秒";
    }
    return {
        progress(tasks: BashTaskInfo[]): string {
            const output = tasks.filter((task) => task.output).map((task) =>
                "#" + task.no + "\n命令：" + clip(task.cmd, 2000) + "\n" + preview(task.output!) + "\n日志：" + clip(task.log, 4096)
            ).join("\n\n");
            return fill(outputTemplate, { 输出: output });
        },
        completion(task: BashTaskInfo & { tail?: string }): string {
            const used = elapsed(task.elapsedMs ?? 0);
            const head = task.status === "done"
                ? "【后台命令 #" + task.no + " 跑完了（退出码 0，用了 " + used + "）】"
                : task.status === "stopped"
                    ? "【后台命令 #" + task.no + " 被停掉了（用了 " + used + "）】"
                    : "【后台命令 #" + task.no + " 没跑成（退出码 " + (task.exitCode ?? "无") + "，用了 " + used + "）】";
            return fill(endTemplate, {
                标题: head,
                命令: clip(task.cmd, 2000),
                输出: task.output ? preview(task.output) : task.notifyOutput
                    ? "（没有尚未交回的新输出；完整日志仍可按需查看）"
                    : task.tail?.trim() || "（没有输出）",
                日志: clip(task.log, 4096),
                编号: String(task.no),
            });
        },
    };
}

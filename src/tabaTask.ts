/**
 * 派子会话（taba）：子会话的开场怎么准备。
 *
 * 三件事：
 *   1. 子会话的内容从哪来（全新 / 只记父子关系 / 带上父会话之前的对话）
 *   2. 会话文件怎么写（pi 的会话格式就是一条一条 JSON 行，第一行是会话头）
 *   3. 第一条发给子会话的消息怎么写（角色说明 + 任务 + 收尾要求）
 *
 * 全是纯函数，方便单测；真正读父会话文件、写子会话文件在外层做。
 */
import * as path from "path";
import type { TabaSessionMode } from "./tabaRoles";

/** 派活时带的参数与角色定义合起来，决定子会话的内容从哪来。 */
export function resolveSessionMode(
    params: { fork?: boolean },
    role?: { sessionMode?: TabaSessionMode }
): TabaSessionMode {
    if (params.fork === true) { return "fork"; }
    return role?.sessionMode ?? "standalone";
}

/**
 * 某个目录对应的 pi 会话目录。
 *
 * pi 的规则：把路径开头的分隔符去掉，剩下的 `/` `\` `:` 全换成 `-`，两头各加 `--`。
 * 例如 `D:\projects\picode` → `--D--projects-picode--`。
 *
 * @param cwd 子会话的工作目录（绝对路径）
 * @param agentDir pi 的配置目录
 * @param sessionsRootOverride pi 的会话根目录被环境变量改了的话传进来
 */
export function piSessionDirFor(cwd: string, agentDir: string, sessionsRootOverride?: string): string {
    const root = sessionsRootOverride
        || process.env.PI_CODING_AGENT_SESSION_DIR
        || path.join(agentDir, "sessions");
    const normalized = cwd.endsWith(path.sep) ? cwd.slice(0, -1) : cwd;
    const safe = "--" + normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
    return path.join(root, safe);
}

/**
 * 子会话文件的文件名，跟 pi 自己起名一样：时间戳里的 `:` 和 `.` 换成 `-`，接上会话编号。
 * @param iso 形如 2026-10-07T18:30:00.123Z 的时间
 * @param sessionId 会话编号
 */
export function childSessionFileName(iso: string, sessionId: string): string {
    return `${iso.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

/** 会话文件的第一行（会话头）。 */
export function sessionHeaderLine(p: {
    sessionId: string;
    cwd: string;
    timestamp: string;
    parentSessionFile?: string;
}): string {
    const header: Record<string, unknown> = {
        type: "session",
        version: 3,
        id: p.sessionId,
        timestamp: p.timestamp,
        cwd: p.cwd,
    };
    if (p.parentSessionFile) { header.parentSession = p.parentSessionFile; }
    return JSON.stringify(header);
}

/**
 * 带上父会话上下文时，从父会话文件里要复制哪些行：
 *   - 丢掉会话头（子会话用自己的头，里面记着父会话路径）
 *   - 截到"最后一条用户消息之前"：父会话派活那条消息不该被子会话看到
 *   - 解不出来的行丢掉
 */
export function forkContentLines(parentLines: string[]): string[] {
    const entries: Array<{ text: string; type?: string; isUser: boolean }> = [];
    for (const line of parentLines) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        let parsed: any;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            continue;
        }
        entries.push({
            text: trimmed,
            type: typeof parsed?.type === "string" ? parsed.type : undefined,
            isUser: parsed?.type === "message" && parsed?.message?.role === "user",
        });
    }
    let cut = entries.length;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].isUser) { cut = i; break; }
    }
    return entries.slice(0, cut).filter((e) => e.type !== "session").map((e) => e.text);
}

/**
 * 子会话文件的完整内容行。
 * @param mode 只支持 lineage-only / fork（standalone 不写文件，让 pi 自己新建）
 */
export function buildChildSessionLines(p: {
    mode: TabaSessionMode;
    sessionId: string;
    cwd: string;
    timestamp: string;
    parentSessionFile?: string;
    parentLines?: string[];
}): string[] {
    const header = sessionHeaderLine({
        sessionId: p.sessionId,
        cwd: p.cwd,
        timestamp: p.timestamp,
        parentSessionFile: p.parentSessionFile,
    });
    const content = p.mode === "fork" ? forkContentLines(p.parentLines ?? []) : [];
    return [header, ...content];
}

/**
 * 发给子会话的第一条消息。
 *
 * @param roleBody 角色说明书正文；给了 systemPromptMode 时它会走系统提示词，这里就不再重复
 * @param bodyInTask 说明书是不是放进这条消息里（否则放进系统提示词）
 * @param skills 角色要求自动加载的技能名
 * @param task 派活时写的任务说明
 */
export function buildTaskText(p: {
    roleBody?: string;
    bodyInTask: boolean;
    skills?: string;
    task: string;
}): string {
    const parts: string[] = [];
    const skillLines = (p.skills ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => `/skill:${s}`);
    if (skillLines.length > 0) { parts.push(skillLines.join("\n")); }
    if (p.bodyInTask && p.roleBody && p.roleBody.trim()) {
        parts.push(`【你的角色】\n\n${p.roleBody.trim()}`);
    }
    parts.push(`【任务】\n\n${p.task.trim()}`);
    parts.push(TABA_CLOSING_INSTRUCTION);
    return parts.join("\n\n---\n\n");
}

/** 收尾要求：子会话跑完这一轮，最后一条回复会被自动交回派活的那个会话。 */
export const TABA_CLOSING_INSTRUCTION = [
    "【收尾要求】",
    "",
    "你跑完这一轮以后，你的最后一条回复会被自动送回派活给你的那个会话，所以最后一条回复要写成一份完整交代：",
    "结论是什么、动了哪些文件、还有哪些没做完或者需要对方拿主意的地方。中间过程不用重复一遍。",
    "任务说明里没交代清楚的地方，按最合理的做法处理，并在最后一条回复里说明你做了什么判断。",
    "用户随时可能直接在这个会话里跟你说话，那时按用户说的做。",
].join("\n");

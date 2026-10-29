/**
 * 「当前加载了什么」那份清单：工具 / 技能 / MCP 服务器。
 *
 * 这些东西只有 pi 自己知道（插件既没法用 RPC 问，也没法从配置文件里全推出来），
 * 所以还是老办法：塞进 pi 进程里的那个扩展（envBridgeSource.ts）把清单写成一行暗号，
 * 从本进程的 stderr 交回来：
 *
 *     ##PICHAT_ENV## eyJ0b29scyI6W10sInNraWxscyI6W10sIm1jcCI6W119
 *
 * 单向：插件只收不答。什么时候报由扩展自己定（会话起来时报一次，之后清单变了再报），
 * 插件这边存着最近一份，界面点开那颗「工具」时拿来画（见 media/chat.js 的 renderEnv）。
 *
 * 本文件不依赖 vscode。
 */

import type { FrameDecoder } from "./piFrames";

/** 暗号行的前缀（跟别的几条不撞）。 */
export const ENV_FRAME_PREFIX = "##PICHAT_ENV##";

/** base64 里可能出现的字符集（用于从一行里准确切出 payload）。 */
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** 各字段的上限：超了就截断，避免一行暗号把内存吃爆。 */
const LIMITS = {
    list: 400,
    name: 160,
    path: 600,
    text: 400,
};

/** 一个工具（pi 的 getAllTools 里那一条，只留界面要用的几样）。 */
export interface EnvTool {
    name: string;
    /** 在不在「现在真给模型看的那一集」里（pi 的 getActiveTools）。 */
    on: boolean;
    /** 怎么给模型用：direct / model-only / codemode / deferred / hidden（界面自己翻成人话）。 */
    exposure?: string;
    /** 来自哪儿：`builtin:read` 这种、或者某个扩展文件的全路径。 */
    path?: string;
    /** user / project / temporary。 */
    scope?: string;
}

/** 一个技能（pi 的 getCommands 里 source 为 skill 的那几条）。 */
export interface EnvSkill {
    name: string;
    path?: string;
    scope?: string;
}

/** 一个 MCP 服务器：配了哪几个、哪个停用了、真挂上几个工具。 */
export interface EnvMcpServer {
    name: string;
    /** 这一条配置来自哪一级：user / project。 */
    scope?: string;
    /** 配置里有没有停用（`enabled: false`）。 */
    enabled: boolean;
    /** 挂上来的工具数（从工具清单里数出来的：一个都没挂上就是 0）。 */
    tools: number;
    /** 配置这一条的文件全路径（项目里只改了开关时，写的是用户级那份）。 */
    path?: string;
    /** 这一条配置写错了（读不懂 / 缺 command、url 之类），原话在这儿。 */
    error?: string;
}

/** 一份快照：这个会话现在加载着什么。 */
export interface EnvSnapshot {
    /** 什么时候取的（毫秒）。 */
    at: number;
    /** 会话跑在哪个目录。 */
    cwd?: string;
    tools: EnvTool[];
    skills: EnvSkill[];
    mcp: EnvMcpServer[];
}

function str(raw: unknown, limit: number): string | undefined {
    if (typeof raw !== "string") { return undefined; }
    const t = raw.trim();
    if (!t) { return undefined; }
    return t.length > limit ? t.slice(0, limit) : t;
}

function items(raw: unknown): unknown[] {
    return Array.isArray(raw) ? raw.slice(0, LIMITS.list) : [];
}

/** 把扩展报来的那份清单整理成一份合法快照；不成样子返回 undefined。 */
export function normalizeEnvSnapshot(raw: unknown): EnvSnapshot | undefined {
    if (!raw || typeof raw !== "object") { return undefined; }
    const o = raw as Record<string, unknown>;
    if (!Array.isArray(o.tools) || !Array.isArray(o.skills) || !Array.isArray(o.mcp)) { return undefined; }

    const tools: EnvTool[] = [];
    for (const item of items(o.tools)) {
        if (!item || typeof item !== "object") { continue; }
        const t = item as Record<string, unknown>;
        const name = str(t.name, LIMITS.name);
        if (!name) { continue; }
        tools.push({
            name,
            on: t.on === true,
            exposure: str(t.exposure, 40),
            path: str(t.path, LIMITS.path),
            scope: str(t.scope, 20),
        });
    }

    const skills: EnvSkill[] = [];
    for (const item of items(o.skills)) {
        if (!item || typeof item !== "object") { continue; }
        const s = item as Record<string, unknown>;
        const name = str(s.name, LIMITS.name);
        if (!name) { continue; }
        skills.push({ name, path: str(s.path, LIMITS.path), scope: str(s.scope, 20) });
    }

    const mcp: EnvMcpServer[] = [];
    for (const item of items(o.mcp)) {
        if (!item || typeof item !== "object") { continue; }
        const m = item as Record<string, unknown>;
        const name = str(m.name, LIMITS.name);
        if (!name) { continue; }
        const toolCount = typeof m.tools === "number" && isFinite(m.tools) && m.tools > 0 ? Math.floor(m.tools) : 0;
        mcp.push({
            name,
            scope: str(m.scope, 20),
            enabled: m.enabled !== false,
            tools: toolCount,
            path: str(m.path, LIMITS.path),
            error: str(m.error, LIMITS.text),
        });
    }

    const at = typeof o.at === "number" && isFinite(o.at) ? o.at : Date.now();
    return { at, cwd: str(o.cwd, LIMITS.path), tools, skills, mcp };
}

/** 解一行暗号（不含换行）：拿不到合法清单就返回 undefined。 */
export function decodeEnvFrame(line: string): EnvSnapshot | undefined {
    const at = line.indexOf(ENV_FRAME_PREFIX);
    if (at < 0) { return undefined; }
    let end = at + ENV_FRAME_PREFIX.length;
    while (end < line.length && BASE64_CHARS.indexOf(line[end]) >= 0) { end++; }
    const payload = line.slice(at + ENV_FRAME_PREFIX.length, end);
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
    return normalizeEnvSnapshot(parsed);
}

/** 交给 stderr 切割器（见 piFrames.ts）：认领这一种暗号。 */
export const ENV_DECODER: FrameDecoder<"env", EnvSnapshot> = {
    kind: "env",
    prefix: ENV_FRAME_PREFIX,
    decode: decodeEnvFrame,
};

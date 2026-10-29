/**
 * 「当前加载了什么」：塞进 pi 进程里的那个扩展文件的源码。
 *
 * 插件把这份源码写到 ~/.pi/pichat/env-bridge-<插件版本>.ts，每个会话的 pi 进程启动时
 * 都用 `-e <那个文件>` 加载它。它干的事很单一：把「这个会话现在有哪些工具、哪些技能、
 * MCP 配了哪几个」写成一行暗号从 stderr 交回插件（暗号的样子见 envProtocol.ts）。
 *
 * 为什么要这个扩展：这三样东西只有 pi 自己认得全 ——
 *   - 工具：pi 没有对外问的接口，只有扩展 API 里的 getAllTools / getActiveTools；
 *   - 技能：同上（getCommands 里 source 为 skill 的那几条）；
 *   - MCP：`/mcp` 的清单关在 pi 自己的 MCP 扩展里，别的扩展问不到；能问到的只有
 *     配置文件（mcp.json 用户级 + 项目级）和「真挂上来的工具名」（mcp__服务器__工具）。
 *     所以这里自己读一遍 mcp.json（项目那份只在项目被信任时算数，跟 pi 一个规矩），
 *     再把工具名里数出来的个数盖上去：连上了几个工具看得出来，连不上 / 没工具分不出来。
 *
 * 什么时候报：会话起来后 0.6 秒报一次（那会儿 MCP 可能还在后头连着、工具还没齐），
 * 之后每 5 秒比一次，清单变了才再报（界面开着就一直是最新的）。
 * 不监听 mcp_servers_change：按 pi 的规矩，谁接了那个事件谁就被当成「负责连 MCP 的那个」，
 * 这个扩展不干那件事，接了会把 pi 自己的 MCP 顶掉。
 *
 * 注意不能写进 ~/.pi/agent/extensions/：那个目录 pi 会自动发现，
 * 你在终端里手跑的 pi 也会被塞上它。
 *
 * 用 String.raw 包着：里面的反斜杠原样保留（比如正则里的 "\s" 不能被外层先转义）。
 * 里面不要出现 "${"：外层是模板字符串，那样会被当插值。
 */
import { ENV_FRAME_PREFIX } from "./envProtocol";

export const ENV_BRIDGE_SOURCE = String.raw`/**
 * 这是 VSCode 插件 Pi Chat 自动生成的文件，不要手改：插件版本一变就会重新生成，改动会丢。
 *
 * 作用：把「这个会话现在加载着什么」（工具 / 技能 / MCP 服务器）报给插件，
 * 好让界面上那颗「工具」点开就能看到。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 暗号行的前缀（插件那边按它认领这一行）。 */
const FRAME_PREFIX = ${JSON.stringify(ENV_FRAME_PREFIX)};
/** 隔多久比一次清单（变了才报）。 */
const POLL_MS = 5000;
/** 会话起来后隔多久先报一次：MCP 服务器是后台连着玩的，刚起来那一瞬工具还没齐。 */
const FIRST_MS = 600;
/** 挂上来的 MCP 工具名：mcp__<服务器>__<工具>（服务器名里的 - 被换成 _）。 */
const MCP_TOOL_RE = /^mcp__([A-Za-z0-9_]+)__/;
/** 各项的上限：超了就截，一行暗号别把内存吃爆。 */
const LIMITS = { list: 400, name: 160, path: 600, text: 400 };

/** 往 stderr 写一行暗号。 */
function emit(snapshot) {
    try {
        process.stderr.write(FRAME_PREFIX + Buffer.from(JSON.stringify(snapshot), "utf8").toString("base64") + "\n");
    } catch {
        // 写不出去就算了：界面那边表现为「还没取到」
    }
}

/** 字符串字段：不是字、或者只有空白就当没有；太长截断。 */
function clip(value, limit) {
    if (typeof value !== "string") {
        return undefined;
    }
    const text = value.trim();
    if (!text) {
        return undefined;
    }
    return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * 读一份 mcp.json：回里面的服务器条目，外加「这份读不懂」的原话。
 * 文件不在、没有 mcpServers 都算没配（不是错）。
 */
function readMcpFile(file, scope) {
    let raw;
    try {
        raw = readFileSync(file, "utf8");
    } catch {
        return { entries: [], errors: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { entries: [], errors: [file + "：" + (e && e.message ? e.message : String(e))] };
    }
    const servers = parsed && typeof parsed === "object" ? parsed.mcpServers : undefined;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
        return { entries: [], errors: [] };
    }
    const entries = [];
    for (const name of Object.keys(servers)) {
        const cfg = servers[name];
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
            entries.push({
                name,
                scope,
                path: file,
                enabled: true,
                exposure: undefined,
                override: false,
                error: file + "：这一条不是一个对象",
            });
            continue;
        }
        // 只写了开关 / 暴露方式的条目：它改的是用户级那一条，不是新配了一个（跟 pi 的规矩一样）
        const override = cfg.command === undefined && cfg.url === undefined && cfg.type === undefined;
        entries.push({
            name,
            scope,
            path: file,
            enabled: cfg.enabled !== false,
            exposure: clip(cfg.exposure, 40),
            override,
        });
    }
    return { entries, errors: [] };
}

export default function envBridge(pi) {
    /** 最近一次 session_start 给的那份上下文（这份清单只有跟着它才取得出来）。 */
    let ctx;
    /** 上一次报出去那份的指纹：一样就不必再报。 */
    let signature = "";
    let timer;

    /** 现在的清单：工具（含 MCP 来的那几个）/ 技能 / MCP 服务器。 */
    function collect() {
        const active = new Set(pi.getActiveTools());
        const tools = [];
        const mcpToolCount = new Map();
        for (const tool of pi.getAllTools()) {
            const name = clip(tool && tool.name, LIMITS.name);
            if (!name) {
                continue;
            }
            const hit = MCP_TOOL_RE.exec(name);
            if (hit) {
                mcpToolCount.set(hit[1], (mcpToolCount.get(hit[1]) || 0) + 1);
            }
            tools.push({
                name,
                on: active.has(name),
                exposure: clip(tool.exposure, 40),
                path: clip(tool.sourceInfo && tool.sourceInfo.path, LIMITS.path),
                scope: clip(tool.sourceInfo && tool.sourceInfo.scope, 20),
            });
            if (tools.length >= LIMITS.list) {
                break;
            }
        }

        const skills = [];
        for (const command of pi.getCommands()) {
            if (!command || command.source !== "skill") {
                continue;
            }
            const raw = clip(command.name, LIMITS.name);
            if (!raw) {
                continue;
            }
            // 技能的名字带 "skill:" 前缀（发出去是 /skill:grill-me），给人看的清单只留后面那个
            skills.push({
                name: raw.startsWith("skill:") ? raw.slice(6) : raw,
                path: clip(command.sourceInfo && command.sourceInfo.path, LIMITS.path),
                scope: clip(command.sourceInfo && command.sourceInfo.scope, 20),
            });
            if (skills.length >= LIMITS.list) {
                break;
            }
        }

        // 配了哪几个 MCP 服务器：用户级那份 + 项目里那份（项目没被信任时 pi 不读它，这里也不读）
        const servers = new Map();
        const user = readMcpFile(join(getAgentDir(), "mcp.json"), "user");
        for (const entry of user.entries) {
            servers.set(entry.name, entry);
        }
        const errors = user.errors.slice();
        if (ctx && ctx.isProjectTrusted()) {
            const project = readMcpFile(join(ctx.cwd, ".pi", "mcp.json"), "project");
            for (const entry of project.entries) {
                const base = servers.get(entry.name);
                if (!entry.override) {
                    servers.set(entry.name, entry);
                    continue;
                }
                if (!base) {
                    // 项目里说「把某台关掉」，可用户级根本没有这一台：pi 也当配置错误
                    errors.push(entry.path + "：没有叫 " + entry.name + " 的服务器可以覆盖");
                    continue;
                }
                servers.set(entry.name, {
                    name: entry.name,
                    scope: base.scope,
                    path: base.path,
                    enabled: entry.enabled,
                    exposure: entry.exposure || base.exposure,
                    override: false,
                });
            }
            errors.push(...project.errors);
        }

        const mcp = [];
        for (const entry of servers.values()) {
            mcp.push({
                name: entry.name,
                scope: entry.scope,
                enabled: entry.enabled,
                exposure: entry.exposure,
                path: entry.path,
                // 挂上来的工具名里服务器名被换过字（- 变 _）：按同一个换法对回去
                tools: mcpToolCount.get(String(entry.name).replace(/[^A-Za-z0-9_]/g, "_")) || 0,
                error: entry.error,
            });
            if (mcp.length >= LIMITS.list) {
                break;
            }
        }
        // 配置读不懂的那几句话也摆出来：不然人只会看到「我明明配了，怎么没有」
        for (const text of errors) {
            if (mcp.length >= LIMITS.list) {
                break;
            }
            mcp.push({ name: "配置有错", enabled: true, tools: 0, error: clip(text, LIMITS.text) });
        }

        return {
            at: Date.now(),
            cwd: clip(ctx && ctx.cwd, LIMITS.path),
            tools,
            skills,
            mcp,
        };
    }

    /** 取一份清单，跟上次不一样就报出去。 */
    function report() {
        if (!ctx) {
            return;
        }
        let snapshot;
        try {
            snapshot = collect();
        } catch {
            // pi 那边还没就绪（工具 / 命令还没挂上）：下一轮再看
            return;
        }
        // 指纹不带时间：不然每 5 秒都算「变了」
        const current = JSON.stringify([snapshot.cwd, snapshot.tools, snapshot.skills, snapshot.mcp]);
        if (current === signature) {
            return;
        }
        signature = current;
        emit(snapshot);
    }

    pi.on("session_start", (_event, sessionCtx) => {
        ctx = sessionCtx;
        signature = "";
        setTimeout(report, FIRST_MS);
        if (!timer) {
            timer = setInterval(report, POLL_MS);
            // 别让这个定时器把进程留住（pi 该退的时候照退）
            if (timer.unref) {
                timer.unref();
            }
        }
    });

    pi.on("session_shutdown", () => {
        if (timer) {
            clearInterval(timer);
            timer = undefined;
        }
        ctx = undefined;
        signature = "";
    });
}
`;

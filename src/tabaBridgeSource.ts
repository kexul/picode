/**
 * 派子会话（taba）：塞进 pi 进程里的那个扩展文件的源码。
 *
 * 插件启动时把下面这份源码写到 ~/.pi/pichat/taba-bridge-<插件版本>.ts，
 * 每个会话的 pi 进程启动时都用 `-e <那个文件>` 加载它。
 * 注意不能写进 ~/.pi/agent/extensions/：那个目录 pi 会自动发现，
 * 你在终端里手跑的 pi 也会被塞上这几个工具。
 *
 * 用 String.raw 包着：里面的反斜杠原样保留（比如 "\n" 不能被外层先转义成真换行）。
 */
export const TABA_BRIDGE_SOURCE = String.raw`/**
 * 这是 VSCode 插件 Pi Chat 自动生成的文件，不要手改：插件版本一变就会重新生成，改动会丢。
 *
 * 作用：给模型三个工具，让它能派子会话。
 *   taba        新开一个 tab，派一个子会话去干一件事（不等结果）
 *   taba_list   列出可以指名的角色
 *   taba_stop   停掉某个子会话正在跑的这一轮
 *
 * 工具被调用时，这里只往本进程的 stderr 写一行暗号：
 *   ##PICHAT_TABA## 后面跟 base64 编码的 JSON
 * 插件在读这个进程的 stderr，读到暗号就去开 tab、发任务；
 * 子会话跑完后把结果交回来，也是插件直接对父会话发消息做的。
 * 所以这里不用等插件回话，也不用联网、不开端口。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const FRAME_PREFIX = "##PICHAT_TABA##";

/** 往 stderr 写一行暗号。 */
function emit(payload: Record<string, unknown>): void {
    try {
        process.stderr.write(FRAME_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\n");
    } catch {
        // 写不出去就算了：插件那边表现为“派活没反应”，模型不会因此卡住
    }
}

/** 取字符串参数，顺手截断，避免一行暗号太长。 */
function text(v: unknown, limit: number): string | undefined {
    if (typeof v !== "string") { return undefined; }
    const t = v.trim();
    if (!t) { return undefined; }
    return t.length > limit ? t.slice(0, limit) : t;
}

/** 角色文件的三个来源目录，优先级从高到低：项目 > 全局 > 插件自带。 */
function roleDirs(cwd: string): Array<{ dir: string; origin: string }> {
    const home = process.env.USERPROFILE || process.env.HOME || homedir();
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
    const out: Array<{ dir: string; origin: string }> = [];
    if (cwd) { out.push({ dir: join(cwd, ".pi", "agents"), origin: "项目" }); }
    out.push({ dir: join(agentDir, "agents"), origin: "全局" });
    const bundled = process.env.PICHAT_TABA_DIR;
    if (bundled) { out.push({ dir: join(bundled, "taba-roles"), origin: "插件自带" }); }
    return out;
}

interface RoleBrief {
    name: string;
    description: string;
    origin: string;
    /** 这个角色我们的 tab 跑不了（例如声明了要用外部命令行工具）。 */
    unusable?: string;
}

/** 从前置元数据里只取用得上那几项（够列清单用）。 */
function parseRoleBrief(raw: string, fallbackName: string, origin: string): RoleBrief | undefined {
    const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
    if (lines.length === 0 || lines[0].trim() !== "---") {
        return fallbackName ? { name: fallbackName, description: "", origin } : undefined;
    }
    const front: Record<string, string> = {};
    let closed = false;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") { closed = true; break; }
        const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[i]);
        if (m && !(m[1] in front)) { front[m[1]] = m[2].trim(); }
    }
    if (!closed) {
        // 前置元数据没写完：整份文件当说明书，名字用文件名
        return fallbackName ? { name: fallbackName, description: "", origin } : undefined;
    }
    const name = (front.name || fallbackName).replace(/^["']|["']$/g, "").trim();
    if (!name) { return undefined; }
    const brief: RoleBrief = { name, description: (front.description || "").replace(/^["']|["']$/g, "").trim(), origin };
    if ("runner" in front) { brief.unusable = "声明了要用外部命令行工具跑，我们的 tab 只能跑 pi"; }
    const hide = (front["disable-model-invocation"] || "").toLowerCase();
    if (hide === "true" || hide === "yes") { return undefined; }
    return brief;
}

/** 读齐三个目录里的角色，同名只留优先级最高的那个。 */
function collectRoles(cwd: string): RoleBrief[] {
    const out: RoleBrief[] = [];
    const seen = new Set<string>();
    for (const { dir, origin } of roleDirs(cwd)) {
        let files: string[];
        try {
            files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort();
        } catch {
            continue;
        }
        for (const file of files) {
            let raw = "";
            try { raw = readFileSync(join(dir, file), "utf8"); } catch { continue; }
            const brief = parseRoleBrief(raw, file.slice(0, -3), origin);
            if (!brief) { continue; }
            const key = brief.name.toLowerCase();
            if (seen.has(key)) { continue; }
            seen.add(key);
            out.push(brief);
        }
    }
    return out;
}

/** 拿到本进程的会话文件路径（父会话要带上下文时插件需要它）。 */
function sessionFileOf(ctx: any): string {
    try {
        const got = ctx?.sessionManager?.getSessionFile?.();
        return typeof got === "string" ? got : "";
    } catch {
        return "";
    }
}

function cwdOf(ctx: any): string {
    const got = ctx?.cwd;
    return typeof got === "string" && got ? got : process.cwd();
}

// ---- 子会话名录（taba_peek 用）----
// 插件在子会话状态变化时往 <资源目录>/taba-runs/<编号>.json 写一份小名录，
// 里面最要紧的就是那个子会话的 .jsonl 在哪（这个路径只有插件知道）。
// 拿到路径以后，详细内容让模型自己用 read / bash 去读。

/** 名录目录。 */
function runsDir(): string {
    const base = process.env.PICHAT_TABA_DIR;
    return base ? join(base, "taba-runs") : "";
}

/** 按编号读一条名录。 */
function readRunById(dir: string, id: string): any {
    try {
        const parsed = JSON.parse(readFileSync(join(dir, id + ".json"), "utf8"));
        return parsed && parsed.v === 1 ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/** 按名字找：只认本会话派出去的（用父会话文件路径比对）；先精硬后包含。 */
function findRunByName(dir: string, name: string, parentSessionFile: string): any {
    let files: string[];
    try {
        files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    } catch {
        return undefined;
    }
    const want = name.trim().toLowerCase();
    if (!want) { return undefined; }
    const mine: any[] = [];
    for (const f of files) {
        let rec: any;
        try { rec = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
        if (!rec || rec.v !== 1) { continue; }
        if (parentSessionFile && rec.parentSessionFile !== parentSessionFile) { continue; }
        mine.push(rec);
    }
    for (const rec of mine) { if (String(rec.name || "").trim().toLowerCase() === want) { return rec; } }
    for (const rec of mine) { if (String(rec.name || "").toLowerCase().includes(want)) { return rec; } }
    return undefined;
}

function humanSize(bytes: number): string {
    if (bytes < 1024) { return bytes + " B"; }
    if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + " KB"; }
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

/** 会话文件多大、多少行（超过 32MB 就不数行数，免得白等）。 */
function describeSessionFile(file: string): string {
    try {
        const size = statSync(file).size;
        if (size > 32 * 1024 * 1024) { return humanSize(size) + "（太大，没数行数）"; }
        const raw = readFileSync(file, "utf8");
        let lines = 0;
        for (const l of raw.split("\n")) { if (l.trim()) { lines++; } }
        return humanSize(size) + "，" + lines + " 行";
    } catch {
        return "读不到";
    }
}

/** 名录里的时间只存了毫秒数，“跑了多久”在这里算（运行中的要用当前时间）。 */
function elapsedText(rec: any): string {
    const start = Number(rec && rec.startedAt) || 0;
    const end = Number(rec && rec.endedAt) || Date.now();
    const total = Math.max(0, Math.round((end - start) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) { return h + " 小时 " + m + " 分"; }
    if (m > 0) { return m + " 分 " + s + " 秒"; }
    return s + " 秒";
}

const TABA_PARAMS = {
    type: "object",
    properties: {
        name: { type: "string", description: "显示名，一眼能看出这个子会话去干什么，例如“侦察: 认证模块”。" },
        task: { type: "string", description: "任务说明。要自包含：默认开的是全新会话，它看不到你这边的对话，需要的背景都得写进去。" },
        agent: { type: "string", description: "角色名（见 taba_list）。不填就没有角色说明，按任务原文干。" },
        model: { type: "string", description: "指定模型，例如 local/glm-5.3-flash。不填跟随你这边的模型。" },
        thinking: { type: "string", description: "指定思考强度：minimal / low / medium / high / xhigh / max。" },
        tools: { type: "string", description: "工具白名单，逗号分隔，例如 read,bash,edit,write。不填按角色定义，角色也没写就全给。" },
        cwd: { type: "string", description: "子会话的工作目录。不填跟你这边一样。" },
        fork: { type: "boolean", description: "把你这边之前的对话带给子会话（适合它需要上下文才能干活的时候）。默认不带。" },
    },
    required: ["name", "task"],
    additionalProperties: false,
};

const TABA_DESCRIPTION =
    "新开一个 tab，派一个子会话去干一件事。这个工具不等结果：调用完立刻返回，你可以接着做别的、或者直接结束这一轮。" +
    "子会话跑完第一轮后，它的最后一条回复会自动交回到本会话（当成一条新的用户消息），你不用轮询、不用读文件、不用反复查看。" +
    "在结果交回来之前，绝对不要猜测或者编造它的产出。" +
    "适合派出去的活：摸底看清某块代码、照着说明改一批文件、评审改动、把一大段资料读一遍再回报结论。" +
    "一次可以派好几个，它们并行跑，各自跑完各自交回来。" +
    "用户随时能在子会话那个 tab 里直接跟它说话，所以交互式、需要来回确认的活也可以派出去。";

const TABA_PROMPT_SNIPPET =
    "派一个子会话去干一件事：新开一个 tab 跑，不等结果，它跑完第一轮后最后一条回复自动交回本会话。";

const STOP_PARAMS = {
    type: "object",
    properties: {
        id: { type: "string", description: "派活时返回的那个子会话编号。" },
        name: { type: "string", description: "或者用显示名指名（编号和名字至少要给一个）。" },
    },
    additionalProperties: false,
};

/** 注册一个工具；名字被别人占了就跳过（不要让整个 pi 起不来）。 */
function safeRegister(pi: any, def: any): void {
    try {
        pi.registerTool(def);
    } catch (e: any) {
        emit({ kind: "note", tool: def && def.name, error: String((e && e.message) || e).slice(0, 300) });
    }
}

export default function tabaBridge(pi: any): void {
    safeRegister(pi, {
        name: "taba",
        label: "派子会话",
        description: TABA_DESCRIPTION,
        promptSnippet: TABA_PROMPT_SNIPPET,
        parameters: TABA_PARAMS,
        async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
            const name = text(params?.name, 80);
            const task = text(params?.task, 20000);
            if (!name || !task) {
                return {
                    content: [{ type: "text", text: "派活失败：name 和 task 都必填。" }],
                    details: { error: "missing name or task" },
                };
            }
            const id = randomBytes(4).toString("hex");
            const payload: Record<string, unknown> = {
                kind: "spawn",
                id,
                name,
                task,
                cwd: cwdOf(ctx),
                parentSessionFile: sessionFileOf(ctx),
            };
            const agent = text(params?.agent, 80);
            const model = text(params?.model, 120);
            const thinking = text(params?.thinking, 40);
            const tools = text(params?.tools, 400);
            if (agent) { payload.agent = agent; }
            if (model) { payload.model = model; }
            if (thinking) { payload.thinking = thinking; }
            if (tools) { payload.tools = tools; }
            if (params?.fork === true) { payload.fork = true; }
            emit(payload);
            const lines = [
                "已派出子会话「" + name + "」（编号 " + id + "）。它会在插件里新开一个 tab 跑。",
                "它跑完第一轮后，最后一条回复会自动交回到本会话，你不用做任何事。",
                "在那之前不要猜测、不要编造它的结果，也不用反复查看：继续做别的能独立推进的事，或者结束这一轮告诉用户在等它。",
            ];
            return { content: [{ type: "text", text: lines.join("\n") }], details: { id, name } };
        },
    });

    safeRegister(pi, {
        name: "taba_list",
        label: "子会话角色清单",
        description:
            "列出派子会话时可以指名的角色（agents 目录下的那些 .md 文件），带上每个角色的一句话说明、用什么模型、给了哪些工具。" +
            "只在需要挑角色的时候调用一次，不要反复调。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_toolCallId: string, _params: any, _signal: any, _onUpdate: any, ctx: any) {
            const roles = collectRoles(cwdOf(ctx));
            if (roles.length === 0) {
                return {
                    content: [{ type: "text", text: "没有任何角色文件。派活时不填 agent 也可以：直接按任务原文开一个子会话。" }],
                    details: { count: 0 },
                };
            }
            const lines: string[] = ["可以指名的角色（同名时项目里的优先）："];
            for (const r of roles) {
                const unusable = r.unusable ? "（不可用：" + r.unusable + "）" : "";
                lines.push("- " + r.name + " [" + r.origin + "]" + (r.description ? "：" + r.description : "") + unusable);
            }
            return { content: [{ type: "text", text: lines.join("\n") }], details: { count: roles.length } };
        },
    });

    safeRegister(pi, {
        name: "taba_stop",
        label: "停子会话这一轮",
        description:
            "停掉某个子会话正在跑的这一轮。它的 tab 和会话都留着，用户可以接着用；只是当前这轮生成被打断。" +
            "按编号或显示名指名，只能停你这个会话派出去的子会话。",
        parameters: STOP_PARAMS,
        async execute(_toolCallId: string, params: any) {
            const id = text(params?.id, 64);
            const name = text(params?.name, 80);
            if (!id && !name) {
                return {
                    content: [{ type: "text", text: "停不了：id 和 name 至少要给一个。" }],
                    details: { error: "missing ref" },
                };
            }
            const payload: Record<string, unknown> = { kind: "stop" };
            if (id) { payload.id = id; }
            if (name) { payload.name = name; }
            emit(payload);
            return {
                content: [{ type: "text", text: "已发出停止请求（只停它当前这一轮，tab 还留着）。" }],
                details: payload,
            };
        },
    });

    safeRegister(pi, {
        name: "taba_peek",
        label: "看子会话情况",
        description:
            "看一个子会话现在的情况：状态、跑了多久、它的会话文件（.jsonl）在哪、多大多少行，以及它最后一条回复的开头一段。" +
            "要看细节就自己用 read 或 bash 去读那个文件：一行一条记录，用户的话、AI 的话、每次工具调用与返回都在里面。" +
            "文件可能很大，别一次整个读进来：用 read 的 offset / limit 从末尾往上翻，或者用 bash 的 tail / grep 挑重点。" +
            "子会话跑完第一轮后结论会自动交回本会话，所以不要为了等结果反复调用这个工具。",
        promptSnippet: "看一个子会话现在的情况：状态、用时、它的会话文件路径与大小、最后一条回复的开头。",
        parameters: {
            type: "object",
            properties: {
                id: { type: "string", description: "派活时返回的那个子会话编号。" },
                name: { type: "string", description: "或者用显示名指名（编号和名字至少给一个）。" },
            },
            additionalProperties: false,
        },
        async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
            const dir = runsDir();
            if (!dir) {
                return {
                    content: [{ type: "text", text: "看不了：这个会话没拿到派子会话用的资源目录。" }],
                    details: { error: "no resource dir" },
                };
            }
            const id = text(params?.id, 64);
            const name = text(params?.name, 80);
            if (!id && !name) {
                return {
                    content: [{ type: "text", text: "看不了：id 和 name 至少要给一个。" }],
                    details: { error: "missing ref" },
                };
            }
            const byId = id ? readRunById(dir, id) : undefined;
            const found = byId || (name ? findRunByName(dir, name, sessionFileOf(ctx)) : undefined);
            if (!found) {
                return {
                    content: [{
                        type: "text",
                        text: "找不到「" + (name || id) + "」：不是这个会话派出去的，或者刚派出去名录还没写出来（等几秒再看），或者编号记错了。",
                    }],
                    details: { error: "not found" },
                };
            }
            const file = String(found.sessionFile || "");
            const lines: string[] = [];
            lines.push("子会话「" + found.name + "」（编号 " + found.id + "）");
            lines.push(
                "状态：" + (found.stateText || found.state) + "，已用 " + elapsedText(found)
                + "，结果交回过 " + (found.deliveries || 0) + " 次"
            );
            lines.push("派给它的任务：" + String(found.task || "").slice(0, 200));
            if (!file) {
                lines.push("会话文件：还没有（全新会话要等它的第一条消息落盘才会出现）。");
            } else {
                lines.push("会话文件：" + file + "（" + describeSessionFile(file) + "）");
                lines.push(
                    "里面是 pi 的原始记录：一行一条，用户的话、AI 的话、每次工具调用与返回都在里面。"
                    + "太大就别整个读：用 read 的 offset / limit 从末尾往上翻，或者 bash 的 tail / grep 挑重点。"
                );
            }
            if (found.lastReplyPreview) {
                lines.push("它最后一条回复的开头：" + found.lastReplyPreview);
            }
            lines.push("提醒：它跑完第一轮后结论会自动交回本会话，不用为了等结果反复调这个工具。");
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { id: found.id, state: found.state, sessionFile: file },
            };
        },
    });
}
`;

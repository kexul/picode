import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 会话存储读取：历史列表的数据源。
 *
 * 列表（历史会话 / 「项目与会话」面板）每一屏只显示最前面那几个，所以这里也只看最前面那几个：
 *   - 会话清单：按文件名倒序 —— pi 起名时把创建时间写在最前面（2026-07-14T02-12-04-764Z_….jsonl），
 *     这样只读一次目录就拿到顺序，不用把目录里每个文件都 stat 一遍；每批取 N 个，
 *     只对取走的那几个文件做整文件扫描：标题（文件里最新一条 session_info 条目的 name，
 *     没有命名就用第一条用户消息）、消息条数、最后活动时间。
 *   - 项目清单：每个目录只看一眼（readdir 拿文件名清单 + stat 最新那一个），不进目录里逐个 stat，
 *     更不读内容；真要显示哪一行了，才读那个目录最新那个会话文件的开头（拿真实路径）。
 *   - 只列当前项目（cwd 对应目录）的会话。
 */

/** 一条历史会话的展示数据（扫描整个文件得到）。 */
export interface SessionListItem {
    /** 会话文件绝对路径 */
    file: string;
    /** session uuid */
    id: string;
    /** 标题：最新的 session_info 名字；没命名就用第一条用户消息 */
    title: string;
    /** message 条目数 */
    count: number;
    /** 最后一条消息的活动时间（毫秒）；没有任何消息时退回文件修改时间 */
    lastActivity: number;
}

/** 历史列表浮层的一行：扫描结果 + 是否当前焦点会话。 */
export interface HistoryPickerItem extends SessionListItem {
    /** 是当前焦点 panel 正在使用的那个会话（前端高亮用）。 */
    current: boolean;
}

/** 目录里一个会话文件的登记（扫描前的排序依据，来自 stat，几乎免费）。 */
export interface SessionFileEntry {
    file: string;
    mtime: number;
}

/** 一个"项目"：pi 在里面跑过会话的工作目录。 */
export interface ProjectEntry {
    /** 真实工作目录（从会话文件第一行读出来的） */
    cwd: string;
    /** 给人看的名字：目录名（最后一个分隔符后面那段） */
    name: string;
    /** 这个目录里最新一个会话文件的修改时间（毫秒） */
    lastActivity: number;
    /** 这个目录里的会话文件个数 */
    sessionCount: number;
}

/** 标题上限：超长由前端按宽度截断，这里只防极端长文本。 */
const TITLE_MAX_CHARS = 200;

/** pi 配置目录，遵循 PI_CODING_AGENT_DIR 环境变量。 */
function agentDir(): string {
    return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** pi 会话根目录，遵循 PI_CODING_AGENT_SESSION_DIR 环境变量。 */
function sessionsRoot(): string {
    return (
        process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir(), "sessions")
    );
}

/**
 * 将 cwd 转换为 pi 使用的目录名。
 * pi 的规则：把路径中的分隔符（/ 、 \ 、 :）都替换为 `-`，两端加 `--`。
 * 例如 `D:\BackUp\pi_plugin` -> `--D--BackUp-pi_plugin--`（冒号和反斜杠都变 `-`，因此 `D:` 后成为 `--`）。
 */
function encodeCwd(cwd: string): string {
    const dashed = cwd.replace(/[\\/:]/g, "-");
    return "--" + dashed + "--";
}

/** 解析 cwd 对应的会话目录（处理盘符大小写差异）。 */
async function resolveSessionDir(cwd: string): Promise<string | undefined> {
    const candidates = new Set<string>([cwd]);
    const m = cwd.match(/^([a-zA-Z])(:)/);
    if (m) {
        candidates.add(m[1].toUpperCase() + cwd.slice(1));
        candidates.add(m[1].toLowerCase() + cwd.slice(1));
    }
    for (const c of candidates) {
        const d = path.join(sessionsRoot(), encodeCwd(c));
        try {
            await fs.promises.access(d);
            return d;
        } catch {
            /* ignore */
        }
    }
    return undefined;
}

/** 从一段 content（string 或 content blocks）提取纯文本。 */
function contentToText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((b: any) => (b && b.type === "text" ? b.text : ""))
            .join("")
            .trim();
    }
    return "";
}

/** 单条消息条目的活动时间（毫秒）：message.timestamp 优先，退回条目 timestamp。 */
function entryActivityMs(entry: any): number {
    const t = entry?.message?.timestamp;
    if (typeof t === "number") { return t; }
    const s = typeof entry?.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    return Number.isNaN(s) ? 0 : s;
}

/**
 * 列出 cwd 会话目录里的会话文件，最新的在前。
 *
 * 排序只看文件名：pi 给会话文件起名时把创建时间摆在最前面
 * （2026-07-14T02-12-04-764Z_019f5e65-….jsonl），名字倒序就是最新的在前。
 * 于是这里只读一次目录就能定顺序 —— 列表一屏只显示最前面那几个，没必要为了排序
 * 把目录里每个文件都 stat 一遍（会话攒多的目录里，那一遍就是几十毫秒）。
 * 目录不存在（该项目没跑过 pi）返回空。
 */
export async function listSessionFilesNewestFirst(cwd: string): Promise<string[]> {
    const dir = await resolveSessionDir(cwd);
    if (!dir) { return []; }
    let names: string[];
    try {
        names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
        return [];
    }
    // 名字倒序 = 创建时间倒序（同一毫秒里撞上就按 uuid 排，无所谓）
    names.sort((a, b) => b.localeCompare(a));
    return names.map((n) => path.join(dir, n));
}

/**
 * 列出 cwd 会话目录里的全部会话文件，按文件修改时间倒序（最新的在前）。
 * 要挨个 stat 才知道修改时间，所以它是“全碰一遍”的那一个：
 * 只有“启动时自动打开最近会话”用它（而且只看第一项）——判断“最近聊过哪个”绕不开这一遍；
 * 列表那种一屏只显示最前面几个的地方走 listSessionFilesNewestFirst。
 */
export async function listSessionFiles(cwd: string): Promise<SessionFileEntry[]> {
    const dir = await resolveSessionDir(cwd);
    if (!dir) { return []; }
    let names: string[];
    try {
        names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
        return [];
    }
    const stats = await Promise.all(
        names.map(async (f) => {
            const file = path.join(dir, f);
            try {
                const st = await fs.promises.stat(file);
                return { file, mtime: st.mtimeMs };
            } catch {
                return null;
            }
        })
    );
    return stats
        .filter((s): s is SessionFileEntry => s !== null)
        .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 扫描一个会话文件，取展示需要的三样：标题、消息条数、最后活动时间。
 * 文件首行必须是 type:"session" 的 header（否则返回 null，与 pi 的判定一致）。
 */
export function scanSessionInfo(file: string): Promise<SessionListItem | null> {
    return new Promise((resolve) => {
        let stream: fs.ReadStream;
        try {
            stream = fs.createReadStream(file, { encoding: "utf8" });
        } catch {
            resolve(null);
            return;
        }
        let buf = "";
        let sawHeader = false;
        let id = "";
        let name: string | undefined;
        let firstUserMessage = "";
        let count = 0;
        let lastActivity = 0;
        const finish = () => {
            stream.destroy();
            if (!sawHeader) { resolve(null); return; }
            const title = (name || firstUserMessage || "(无消息)").slice(0, TITLE_MAX_CHARS);
            resolve({
                file,
                id,
                title,
                count,
                lastActivity: lastActivity || Date.now(),
            });
        };
        stream.on("data", (chunk) => {
            const d = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            buf += d;
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                let e: any;
                try { e = JSON.parse(line); } catch { continue; }
                if (!e || typeof e.type !== "string") { continue; }
                if (!sawHeader) {
                    if (e.type !== "session") { finish(); return; }
                    sawHeader = true;
                    id = typeof e.id === "string" ? e.id : "";
                    continue;
                }
                if (e.type === "session_info") {
                    const n = typeof e.name === "string" ? e.name.trim() : "";
                    // 取最新的一条（包括显式清空成空串的情况），与 pi 一致
                    name = n || undefined;
                    continue;
                }
                if (e.type !== "message") { continue; }
                count += 1;
                const at = entryActivityMs(e);
                if (at > lastActivity) { lastActivity = at; }
                if (!firstUserMessage && e.message?.role === "user") {
                    const t = contentToText(e.message.content).replace(/\s+/g, " ").trim();
                    if (t) { firstUserMessage = t; }
                }
            }
        });
        stream.on("end", finish);
        stream.on("error", () => resolve(null));
    });
}

/** 一次最多同时进几个项目目录：目录可能上百个，全放出去会同时开一堆文件句柄。 */
const PROJECT_SCAN_CONCURRENCY = 8;

/** 读会话文件开头时最多读这么多字节：header 很小，这个上限防的是没有换行的坏文件。 */
const FIRST_LINE_MAX_BYTES = 16 * 1024;

/** 按固定并发数跑任务，结果数组与输入一一对应。 */
async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= items.length) { return; }
            results[i] = await fn(items[i]);
        }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

/**
 * 只读文件开头，取第一行的文本；读不到返回 null。
 *
 * 会话文件后面可能有几 MB 的消息，而确认工作目录只需要第一行的 header，
 * 所以按块读、读到第一个换行就停，不把整个文件读进来。
 */
async function readFirstLine(file: string): Promise<string | null> {
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(file, "r");
        const buf = Buffer.alloc(FIRST_LINE_MAX_BYTES);
        let total = 0;
        while (total < buf.length) {
            const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
            if (bytesRead <= 0) { break; }
            total += bytesRead;
            const nl = buf.subarray(0, total).indexOf(0x0a);
            if (nl >= 0) { return buf.subarray(0, nl).toString("utf8"); }
        }
        // 一直没换行（或正好读满上限）：把已读到的当第一行，交给 JSON.parse 去判
        return buf.subarray(0, total).toString("utf8");
    } catch {
        return null;
    } finally {
        if (handle) { await handle.close().catch(() => undefined); }
    }
}

/** 从真实路径取显示名：最后一个分隔符后面那段；取不到就用原路径顶着。 */
function projectName(cwd: string): string {
    const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : cwd;
}

/** 一个项目目录的登记：还没读会话文件的内容。 */
export interface ProjectDirEntry {
    /** 会话目录的绝对路径（sessions 根底下那一层） */
    dir: string;
    /** 目录里最新的那个会话文件（名字里带着创建时间，名字最大的就是最新的） */
    newest: string;
    /** 上面那个文件的修改时间（毫秒）—— 排“最近待过的项目”看的就是它 */
    lastActivity: number;
    /** 目录里的会话文件个数 */
    sessionCount: number;
}

/**
 * 列出项目目录本身，按最近活动倒序。
 *
 * 一个目录只碰两下：readdir 看一眼里面有哪些会话文件（顺便得个数），再 stat 最新的那一个。
 * 不再把每个项目里每个会话文件都 stat 一遍（上百个项目加起来往往上千个，那一遍就是几十毫秒），
 * 更不读文件内容 —— 那一行到底是谁、要画几行，留到真要显示时再看（见 readProjectEntry）。
 * 没跑过 pi（目录不存在 / 不是目录）就是空清单，不抛。
 */
export async function listProjectDirs(): Promise<ProjectDirEntry[]> {
    const root = sessionsRoot();
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
    const found = await mapLimit(dirs, PROJECT_SCAN_CONCURRENCY, (dir) => scanProjectDir(dir));
    return found
        .filter((d): d is ProjectDirEntry => d !== null)
        .sort((a, b) => b.lastActivity - a.lastActivity);
}

/** 看一眼一个项目目录：有哪些会话文件、最新那个是谁、它什么时候改的。 */
async function scanProjectDir(dir: string): Promise<ProjectDirEntry | null> {
    let names: string[];
    try {
        names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
        return null;
    }
    if (names.length === 0) { return null; }
    names.sort((a, b) => b.localeCompare(a));
    const newest = path.join(dir, names[0]);
    try {
        const st = await fs.promises.stat(newest);
        return { dir, newest, lastActivity: st.mtimeMs, sessionCount: names.length };
    } catch {
        return null;
    }
}

/**
 * 把一条目录登记读成展示条目：进目录里读它最新那个会话文件的第一行，拿真实工作目录。
 * 一行只读一个文件的开头（几百字节），所以只对真要画的那几行做。
 *
 * 文件夹名是把 cwd 里的 / \ : 全换成 - 拼出来的，不同路径可能编出同一个名字，
 * 反解回去会有歧义（这正是 encodeCwd 只能单向用的原因）；
 * 所以真实路径只认会话文件第一行的 cwd，不拿文件夹名去猜。
 */
export async function readProjectEntry(entry: ProjectDirEntry): Promise<ProjectEntry | null> {
    const firstLine = await readFirstLine(entry.newest);
    if (firstLine === null) { return null; }
    let header: unknown;
    try {
        header = JSON.parse(firstLine);
    } catch {
        // 写到一半或者版本不同的文件：跳过这个目录，别让一份坏文件把整份清单带崩
        return null;
    }
    const cwd = (header as { cwd?: unknown } | null)?.cwd;
    // 老版本的会话文件没有 cwd；空串也算没有
    if (typeof cwd !== "string" || cwd.trim() === "") { return null; }
    return {
        cwd,
        name: projectName(cwd),
        lastActivity: entry.lastActivity,
        sessionCount: entry.sessionCount,
    };
}

/** 某个工作目录自己的项目登记（面板上“当前工作区”那行用）；没跑过 pi 就是 null。 */
export async function readProjectDirForCwd(cwd: string): Promise<ProjectDirEntry | null> {
    const dir = await resolveSessionDir(cwd);
    return dir ? scanProjectDir(dir) : null;
}

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 会话存储读取：历史列表的数据源。
 *
 * 按 pi TUI 的 /resume 列表同款逻辑取数据：
 *   - 目录里每个会话文件按修改时间倒序排（最新在最前），每批取 N 个；
 *   - 只对取走的那几个文件做整文件扫描：标题（文件里最新一条 session_info
 *     条目的 name，没有命名就用第一条用户消息）、消息条数、最后活动时间。
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
 * 列出 cwd 会话目录里的全部会话文件，按文件修改时间倒序（最新的在前）。
 * 只做 readdir + stat，不读内容。目录不存在（该项目没跑过 pi）返回空。
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

/** 一次最多同时扫几个会话文件夹：文件夹可能上百个，全放出去会同时开一堆文件句柄。 */
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

/**
 * 合并同一个目录用的键。
 * 同一个真实目录可能因为盘符大小写不同（D: 与 d:）被记到两个文件夹里，所以要合并；
 * Windows 整个路径不区分大小写，其它系统只把盘符这种形式统一小写，路径本身仍区分。
 */
function cwdMergeKey(cwd: string): string {
    if (process.platform === "win32") { return cwd.toLowerCase(); }
    return cwd.replace(/^([a-zA-Z]):/, (_m, drive: string) => `${drive.toLowerCase()}:`);
}

/**
 * 扫一个会话文件夹，产出一条项目；文件夹里没有可用的会话文件就返回 null。
 *
 * 文件夹名是把 cwd 里的 / \ : 全换成 - 拼出来的，不同路径可能编出同一个名字，
 * 反解回去会有歧义（这正是 encodeCwd 只能单向用的原因）；
 * 所以真实路径只认会话文件第一行的 cwd，不拿文件夹名去猜。
 */
async function scanProjectFolder(dir: string): Promise<ProjectEntry | null> {
    let names: string[];
    try {
        names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
        return null;
    }
    if (names.length === 0) { return null; }
    const stats = await Promise.all(
        names.map(async (name) => {
            const file = path.join(dir, name);
            try {
                const st = await fs.promises.stat(file);
                return { file, mtime: st.mtimeMs };
            } catch {
                return null;
            }
        })
    );
    const files = stats.filter((s): s is { file: string; mtime: number } => s !== null);
    if (files.length === 0) { return null; }
    files.sort((a, b) => b.mtime - a.mtime);
    const newest = files[0];
    const firstLine = await readFirstLine(newest.file);
    if (firstLine === null) { return null; }
    let header: unknown;
    try {
        header = JSON.parse(firstLine);
    } catch {
        // 写到一半或者版本不同的文件：跳过这个文件夹，别让一份坏文件把整份清单带崩
        return null;
    }
    const cwd = (header as { cwd?: unknown } | null)?.cwd;
    // 老版本的会话文件没有 cwd；空串也算没有
    if (typeof cwd !== "string" || cwd.trim() === "") { return null; }
    return {
        cwd,
        name: projectName(cwd),
        lastActivity: newest.mtime,
        sessionCount: names.length,
    };
}

/** 列出用 pi 跑过会话的工作目录，按最后活动时间倒序。 */
export async function listProjects(options?: { limit?: number }): Promise<ProjectEntry[]> {
    const root = sessionsRoot();
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
        // 这台机器还没跑过 pi（目录不存在 / 不是目录）：空清单，不抛
        return [];
    }
    const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(root, e.name))
        .sort();
    const found = await mapLimit(dirs, PROJECT_SCAN_CONCURRENCY, (dir) =>
        scanProjectFolder(dir)
    );
    const byCwd = new Map<string, ProjectEntry>();
    for (const p of found) {
        if (!p) { continue; }
        const key = cwdMergeKey(p.cwd);
        const prev = byCwd.get(key);
        if (!prev) {
            byCwd.set(key, p);
            continue;
        }
        // 同一个真实目录：会话数相加，时间和展示用的名字取更新的那份
        const newer = p.lastActivity > prev.lastActivity ? p : prev;
        byCwd.set(key, {
            cwd: newer.cwd,
            name: newer.name,
            lastActivity: Math.max(prev.lastActivity, p.lastActivity),
            sessionCount: prev.sessionCount + p.sessionCount,
        });
    }
    const list = Array.from(byCwd.values()).sort((a, b) => b.lastActivity - a.lastActivity);
    if (options?.limit === undefined) { return list; }
    return list.slice(0, Math.max(0, options.limit));
}

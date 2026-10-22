import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isKnownChildSession } from "./childSessions";
import { TABA_CLOSING_MARK } from "./tabaTask";

/**
 * 会话存储读取：历史列表的数据源。
 *
 * 列表（历史会话 / 「项目与会话」面板里展开的那一组）每一屏只显示最前面那几个，
 * 所以这里也只看最前面那几个：
 *   - 会话清单：按文件改动时间倒序 —— 最近聊过的在最前；每批取 N 个，只对取走的那几个
 *     文件读两样：标题（最新一条 session_info 的 name，没命名就用第一条用户消息）、
 *     工作目录；子会话（清单里记过的，或者派活那套文字当第一条消息）也在那里认出来，
 *     列表不显示它们。消息条数不数了，最后活动时间就用文件改动时间（见 scanSessionInfo）。
 *   - 项目清单：每个目录只读一次目录 + stat 最新那一个会话文件，不进目录里逐个 stat，
 *     更不读内容；真要显示哪一行了，才读那个目录最新那个会话文件的开头（拿真实路径）。
 */

/** 一条历史会话的展示数据（扫描整个文件得到）。 */
export interface SessionListItem {
    /** 会话文件绝对路径 */
    file: string;
    /** session uuid */
    id: string;
    /** 标题：最新的 session_info 名字；没命名就用第一条用户消息 */
    title: string;
    /** 最后活动时间（毫秒）：就是那个会话文件的改动时间（pi 每记一条就追写，见 scanSessionInfo） */
    lastActivity: number;
    /** 这个会话跑在哪个目录（文件头里那个 cwd）：点开它得按这个目录起进程 */
    cwd: string;
    /** 是不是子会话（派活那套文字当第一条用户消息）：列表不显示它们 */
    child: boolean;
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
 * pi 的规则：先去掉开头那一个 `/` 或 `\`，再把剩下的分隔符（/ 、 \ 、 :）都替换为 `-`，两端加 `--`。
 * 例如 `D:\BackUp\pi_plugin` -> `--D--BackUp-pi_plugin--`（冒号和反斜杠都变 `-`，因此 `D:` 后成为 `--`）；
 * `/home/me/work` -> `--home-me-work--`（开头那个斜杠先去掉，不然会多出一个短杠，跟 pi 对不上）。
 */
function encodeCwd(cwd: string): string {
    const dashed = cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-");
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

/**
 * 列出 cwd 会话目录里的会话文件，按文件改动时间倒序（最近聊过的在前）。
 * 目录不存在（该项目没跑过 pi）返回空。
 */
export async function listSessionFiles(cwd: string): Promise<SessionFileEntry[]> {
    const dir = await resolveSessionDir(cwd);
    return dir ? listDirSessionFiles(dir) : [];
}

/** 一个会话目录里的会话文件（逐个 stat，按改动时间倒序）。 */
async function listDirSessionFiles(dir: string): Promise<SessionFileEntry[]> {
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

/** 扫出来的结果按“文件改动时间 + 大小”记一份（见下面那个缓存）：同一个文件在没动过时
 * 不再整份读一遍 —— 开列表、点「加载更多」、启动自动打开最近会话都会反复扫同一批文件，
 * 而它们每个都可能有好几 MB。 */
const SCAN_CACHE_MAX = 300;

/** 扫过的文件 → 那个文件的改动时间 / 大小 / 当时的扫描结果。 */
const scanCache = new Map<string, { mtimeMs: number; size: number; item: SessionListItem | null }>();

/**
 * 扫描一个会话文件，取展示需要的几样：标题（最新一次改名，没有就用第一条用户消息）、
 * 工作目录、最后活动时间、以及“这是不是子会话”。
 * 文件首行必须是 type:"session" 的 header（否则返回 null，与 pi 的判定一致）。
 *
 * 不数消息条数：那个数字界面不再显示了（历史上那颗小徽标已经删了，见 media/chat.js），
 * 为了它把整份文件逐行 JSON.parse 不值得 —— 一条消息就可能几 MB（内联图片）。
 * 最后活动时间就取文件的改动时间（下面已经 stat 过了）：pi 每记一条就往文件里追加，
 * 两者基本上是同一个时刻，而历史列表本来就是按它排序的（见 listSessionFiles）。
 */
export async function scanSessionInfo(file: string): Promise<SessionListItem | null> {
    let st: fs.Stats;
    try {
        st = await fs.promises.stat(file);
    } catch {
        return null;
    }
    const hit = scanCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        return hit.item ? recheckChild(hit.item, file) : null;
    }
    const item = await scanSessionFile(file, st.mtimeMs);
    if (scanCache.size >= SCAN_CACHE_MAX) {
        const oldest = scanCache.keys().next();
        if (!oldest.done) { scanCache.delete(oldest.value); }
    }
    scanCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, item });
    return item ? recheckChild(item, file) : null;
}

/**
 * 给出扫描结果时重算一次“是不是子会话”：子会话清单（childSessions）可能是在这次扫描之后
 * 才记下这个文件的（派活的那一头拿到 .jsonl 路径得等 pi 落盘），内存里这份缓存不能把它盖掉。
 */
function recheckChild(item: SessionListItem, file: string): SessionListItem {
    const child = item.child || isKnownChildSession(file);
    return child === item.child ? item : { ...item, child };
}

/** 两种行开头的字节（认行类型用，不靠解析整行）。 */
const LINE_SESSION_INFO = Buffer.from('{"type":"session_info"');
const LINE_MESSAGE = Buffer.from('{"type":"message"');

/** “这是条用户消息”只需看行首这么多字节：role 就写在 message 对象的开头。 */
const ROLE_PREFIX_BYTES = 400;

/** 一行开头处的 role 记号。 */
const ROLE_USER = Buffer.from('"role":"user"');

/** 读文件时一次拿这么多字节（找换行是原生实现的，比逐字解码快得多）。 */
const SCAN_CHUNK_BYTES = 1024 * 1024;

/**
 * 真去读那个文件（外面都走 {@link scanSessionInfo}，好蹭上缓存）。
 *
 * 只做三件事：从头找 header（工作目录）、找每条 session_info（最新那次改名）、
 * 找第一条用户消息（标题的备选与子会话的文案兜底）。其余行（大多数是巨大的工具结果）
 * 只按字节找换行跳过去，不解析。
 */
async function scanSessionFile(file: string, mtimeMs: number): Promise<SessionListItem | null> {
    let sawHeader = false;
    let id = "";
    let cwd = "";
    let name: string | undefined;
    let firstUserMessage = "";
    let sawFirstUser = false;
    let child = false;

    /** 处理一整行（不含行尾换行）；是 header 就返回 false（这个文件不认）。 */
    const handleLine = (buf: Buffer, start: number, end: number): boolean => {
        if (!sawHeader) {
            let e: any;
            try { e = JSON.parse(buf.toString("utf8", start, end)); } catch { return false; }
            if (!e || e.type !== "session") { return false; }
            sawHeader = true;
            id = typeof e.id === "string" ? e.id : "";
            // 工作目录：点开这个历史会话要按它起进程（文件所在目录名是拼出来的，反解不可靠）
            cwd = typeof e.cwd === "string" ? e.cwd : "";
            return true;
        }
        if (startsWith(buf, start, LINE_SESSION_INFO)) {
            let e: any;
            try { e = JSON.parse(buf.toString("utf8", start, end)); } catch { return true; }
            if (e && e.type === "session_info") {
                // 取最新的一条（包括显式清空成空串的情况），与 pi 一致
                const n = typeof e.name === "string" ? e.name.trim() : "";
                name = n || undefined;
            }
            return true;
        }
        if (sawFirstUser || !startsWith(buf, start, LINE_MESSAGE)) { return true; }
        // 先看行首的 role：不是用户消息就不必解析这一整行（它可能几 MB）
        const headEnd = Math.min(end, start + ROLE_PREFIX_BYTES);
        if (buf.indexOf(ROLE_USER, start) >= headEnd) { return true; }
        let e: any;
        try { e = JSON.parse(buf.toString("utf8", start, end)); } catch { return true; }
        if (e?.message?.role !== "user") { return true; }
        const raw = contentToText(e.message.content);
        sawFirstUser = true;
        // 子会话：清单里记过就是（见 childSessions）；老会话清单里没有，
        // 只能看第一条用户消息是不是派活那套文字（见 tabaTask.buildTaskText）
        if (raw.includes(TABA_CLOSING_MARK) || isKnownChildSession(file)) { child = true; }
        const t = raw.replace(/\s+/g, " ").trim();
        if (t) { firstUserMessage = t; }
        return true;
    };

    try {
        // 上一块尾巴上没写完的那半行：留到下一块凑齐再处理
        let carry: Buffer = Buffer.alloc(0);
        for await (const chunk of fs.createReadStream(file, { highWaterMark: SCAN_CHUNK_BYTES })) {
            const piece = chunk as Buffer;
            const buf = carry.length === 0 ? piece : Buffer.concat([carry, piece]);
            let start = 0;
            let nl = buf.indexOf(0x0a, start);
            while (nl >= 0) {
                if (!handleLine(buf, start, nl)) { return null; }
                start = nl + 1;
                nl = buf.indexOf(0x0a, start);
            }
            carry = buf.subarray(start);
        }
        // 最后一行没带换行（pi 正常会带，手工改过的文件不一定）
        if (carry.length > 0 && !handleLine(carry, 0, carry.length)) { return null; }
    } catch {
        return null;
    }
    if (!sawHeader) { return null; }
    return {
        file,
        id,
        title: (name || firstUserMessage || "(无消息)").slice(0, TITLE_MAX_CHARS),
        lastActivity: mtimeMs || Date.now(),
        cwd,
        child,
    };
}

/** buf 从 start 开始的那一段是不是以 prefix 开头。 */
function startsWith(buf: Buffer, start: number, prefix: Buffer): boolean {
    const end = start + prefix.length;
    return end <= buf.length && buf.compare(prefix, 0, prefix.length, start, end) === 0;
}

/**
 * 这个会话文件是不是子会话。
 *
 * 先查子会话清单（派活时记下的，见 childSessions）：命中就返回，不用读文件；
 * 清单里没有（老会话、或者这个文件根本不是派活建的）才读文件开头，
 * 看第一条用户消息是不是派活那套文字。
 *
 * 只读到第一条用户消息为止 —— 它在文件开头几行，不用把整个文件读一遍；
 * “启动时自动打开最近会话”靠它跳过子会话（列表那边走整文件扫描，不会多花这一遍）。
 */
export function isChildSessionFile(file: string): Promise<boolean> {
    if (isKnownChildSession(file)) { return Promise.resolve(true); }
    return new Promise((resolve) => {
        let stream: fs.ReadStream;
        try {
            stream = fs.createReadStream(file, { encoding: "utf8" });
        } catch {
            resolve(false);
            return;
        }
        let buf = "";
        let sawHeader = false;
        let done = false;
        const finish = (v: boolean) => {
            if (done) { return; }
            done = true;
            stream.destroy();
            resolve(v);
        };
        stream.on("data", (chunk) => {
            if (done) { return; }
            buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                let e: any;
                try { e = JSON.parse(line); } catch { continue; }
                if (!e || typeof e.type !== "string") { continue; }
                if (!sawHeader) {
                    if (e.type !== "session") { finish(false); return; }
                    sawHeader = true;
                    continue;
                }
                if (e.type !== "message" || e.message?.role !== "user") { continue; }
                finish(contentToText(e.message.content).includes(TABA_CLOSING_MARK));
                return;
            }
        });
        stream.on("end", () => finish(false));
        stream.on("error", () => finish(false));
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
}

/**
 * 列出项目目录本身，按最近活动倒序。
 *
 * 一个目录只碰两下：readdir 看一眼里面有哪些会话文件，再 stat 最新的那一个。
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
        return { dir, newest, lastActivity: st.mtimeMs };
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
    };
}

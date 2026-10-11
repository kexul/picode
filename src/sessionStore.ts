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

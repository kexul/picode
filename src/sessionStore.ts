import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * 会话存储读取：历史列表的家族树 + 尾读预览。
 *
 * 设计：
 *   - {@link buildSessionTree} 全量读每个会话文件第一行 header（仅几十毫秒），
 *     按 parentSession 链构建家族树，按根 timestamp 倒序排列。
 *   - {@link readTailPreview} 从文件末尾取 8KB，按角色拼最后几条消息成预览。
 *   - {@link flattenTreeByFamilies} 按家族切片（不在家族中段截断），供首屏 / 加载更多。
 */

/** 单个会话的 header 信息（仅读文件第一行得到）。 */
export interface SessionHeader {
    file: string; // 绝对路径
    id: string; // session uuid
    timestamp: string; // 创建时间 ISO 字符串（根家族排序用）
    parentSession?: string; // 父会话绝对路径（分支会话才有）
}

/** 家族树节点（按 parentSession 链构建）。 */
export interface SessionTreeNode {
    header: SessionHeader;
    depth: number; // 0=根，1=一级分支…
    children: SessionTreeNode[];
}

/** 扁平化后的会话条目（带缩进层级）。 */
export interface FlatSessionEntry extends SessionHeader {
    depth: number;
}

/** 渲染用的会话条目：header + 尾读预览。 */
export interface SessionItem {
    file: string;
    id: string;
    timestamp: string; // 创建时间
    depth: number; // 缩进层级
    preview: string; // 尾读预览（带“我：/AI：”前缀，已截断）
}

/** 每批加载的家族数（按家族切片，不在家族中段截断）。 */
export const SESSION_FAMILY_PAGE_SIZE = 20;

/** 尾读块大小：从文件末尾取的字节数。8KB 通常覆盖最后几条消息。 */
const TAIL_BYTES = 8 * 1024;

/** 预览目标字符数。 */
const PREVIEW_CHARS = 150;

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

/** 路径归一化：统一分隔符、小写、去盘符，用于 parentSession（盘符大小写可能不一致）匹配。 */
function normPath(p: string): string {
    let s = p.replace(/\\/g, "/").toLowerCase();
    s = s.replace(/^[a-z]:/, "");
    return s;
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

/** ISO timestamp 比较（缺省/非法视为最早）。倒序时大的在前。 */
function compareTs(a: string | undefined, b: string | undefined): number {
    const ta = a ? Date.parse(a) : 0;
    const tb = b ? Date.parse(b) : 0;
    return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
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

/** 读文件第一行并解析为 session header。失败返回 null。 */
function readHeaderLine(file: string): Promise<SessionHeader | null> {
    return new Promise((resolve) => {
        let stream: fs.ReadStream;
        try {
            stream = fs.createReadStream(file, { encoding: "utf8" });
        } catch {
            resolve(null);
            return;
        }
        let buf = "";
        let done = false;
        const finish = (v: SessionHeader | null) => {
            if (done) { return; }
            done = true;
            resolve(v);
        };
        stream.on("data", (chunk) => {
            const d = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            buf += d;
            const i = buf.indexOf("\n");
            if (i >= 0) {
                stream.destroy();
                try {
                    const o = JSON.parse(buf.slice(0, i));
                    if (o && o.type === "session" && o.id) {
                        finish({
                            file,
                            id: o.id,
                            timestamp: o.timestamp || "",
                            parentSession: o.parentSession || undefined,
                        });
                        return;
                    }
                } catch {
                    /* fallthrough */
                }
                finish(null);
            }
        });
        stream.on("end", () => {
            // 文件可能只有一行（无换行）
            if (done) { return; }
            try {
                const o = JSON.parse(buf);
                if (o && o.type === "session" && o.id) {
                    finish({
                        file,
                        id: o.id,
                        timestamp: o.timestamp || "",
                        parentSession: o.parentSession || undefined,
                    });
                    return;
                }
            } catch {
                /* ignore */
            }
            finish(null);
        });
        stream.on("error", () => finish(null));
    });
}

/**
 * 全量读 cwd 下所有会话文件的第一行 header，构建家族树。
 * 家族间按根 timestamp 倒序（最近创建的家族在前）；
 * 家族内子会话按 timestamp 倒序（最近分叉的在前）。
 */
export async function buildSessionTree(cwd: string): Promise<SessionTreeNode[]> {
    const dir = await resolveSessionDir(cwd);
    if (!dir) { return []; }
    let files: string[];
    try {
        files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
        return [];
    }
    // 并发读第一行 header
    const headers = await Promise.all(
        files.map((f) => readHeaderLine(path.join(dir, f)))
    );
    const valid = headers.filter((h): h is SessionHeader => h !== null);
    if (valid.length === 0) { return []; }

    // 路径 -> header 映射（盘符大小写不敏感）
    const byNormFile = new Map<string, SessionHeader>();
    for (const h of valid) { byNormFile.set(normPath(h.file), h); }

    // 建立子列表：parentId -> children
    const childrenOf = new Map<string, SessionHeader[]>();
    const roots: SessionHeader[] = [];
    for (const h of valid) {
        let parent: SessionHeader | undefined;
        if (h.parentSession) {
            parent = byNormFile.get(normPath(h.parentSession));
        }
        if (parent) {
            const arr = childrenOf.get(parent.id) || [];
            arr.push(h);
            childrenOf.set(parent.id, arr);
        } else {
            roots.push(h);
        }
    }
    // 根按 timestamp 倒序
    roots.sort((a, b) => compareTs(b.timestamp, a.timestamp));

    const build = (h: SessionHeader, depth: number): SessionTreeNode => {
        const kids = (childrenOf.get(h.id) || [])
            .slice()
            .sort((a, b) => compareTs(b.timestamp, a.timestamp));
        return { header: h, depth, children: kids.map((k) => build(k, depth + 1)) };
    };
    return roots.map((r) => build(r, 0));
}

/**
 * 把家族树扁平化成展示列表，按家族切片（不在家族中段截断）。
 * limit <= 0 表示取到末尾。返回按“根在前、子孙缩进跟随”的先序遍历顺序。
 */
export function flattenTreeByFamilies(
    roots: SessionTreeNode[],
    familyOffset: number,
    familyLimit: number
): FlatSessionEntry[] {
    if (roots.length === 0) { return []; }
    const start = Math.max(0, Math.min(familyOffset, roots.length));
    const end = familyLimit <= 0 ? roots.length : Math.min(start + familyLimit, roots.length);
    const out: FlatSessionEntry[] = [];
    const walk = (node: SessionTreeNode): void => {
        out.push({ ...node.header, depth: node.depth });
        for (const c of node.children) { walk(c); }
    };
    for (const root of roots.slice(start, end)) { walk(root); }
    return out;
}

/**
 * 按是否分支选择预览读取方式：
 * - 根会话：读开头（会话从什么问题开始，代表主题）
 * - 分支会话：读末尾（这个分支最后聊到哪，区别于父和兄弟）
 */
export function readSessionPreview(
    file: string,
    isBranch: boolean
): Promise<string> {
    return isBranch ? readTailPreview(file) : readHeadPreview(file);
}

/**
 * 从文件开头读前 {@link HEAD_BYTES} 字节，正序找前几条 user/assistant 消息，
 * 按角色拼成预览（带“我：/AI：”前缀），截断到 {@link PREVIEW_CHARS} 字。
 * 保证至少各一条 user / assistant 后再按配额拼。
 */
export function readHeadPreview(file: string): Promise<string> {
    return new Promise((resolve) => {
        let stream: fs.ReadStream;
        try {
            stream = fs.createReadStream(file, { encoding: "utf8" });
        } catch {
            resolve("");
            return;
        }
        let buf = "";
        const lines: string[] = [];
        let bytesRead = 0;
        let stopped = false;
        const finish = (v: string) => {
            if (stopped) { return; }
            stopped = true;
            resolve(v);
        };
        stream.on("data", (chunk) => {
            const d = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            buf += d;
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) {
                lines.push(buf.slice(0, i));
                buf = buf.slice(i + 1);
                bytesRead += lines[lines.length - 1].length;
            }
            if (bytesRead >= HEAD_BYTES) {
                try { stream.destroy(); } catch { /* ignore */ }
                finish(buildPreviewFromHead(lines));
            }
        });
        stream.on("end", () => {
            if (buf) { lines.push(buf); }
            finish(buildPreviewFromHead(lines));
        });
        stream.on("error", () => finish(""));
    });
}

/** 读文件开头取的字节数。 */
const HEAD_BYTES = 16 * 1024;

/** 正序从已读行中取前几条 user/assistant 文本，拼成预览。 */
function buildPreviewFromHead(lines: string[]): string {
    const cand: Array<{ role: "user" | "assistant"; text: string }> = [];
    let sawUser = false;
    let sawAssistant = false;
    for (const line of lines) {
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        if (!e || e.type !== "message" || !e.message) { continue; }
        const role = e.message.role;
        if (role !== "user" && role !== "assistant") { continue; }
        const t = contentToText(e.message.content).replace(/\s+/g, " ");
        if (!t) { continue; }
        cand.push({ role, text: t.slice(0, PREVIEW_CHARS) });
        if (role === "user") { sawUser = true; } else { sawAssistant = true; }
        if (sawUser && sawAssistant) { break; }
    }
    const perPart = (sawUser && sawAssistant)
        ? Math.floor(PREVIEW_CHARS / 2)
        : PREVIEW_CHARS;
    const parts: string[] = [];
    let chars = 0;
    for (const c of cand) {
        if (chars >= PREVIEW_CHARS) { break; }
        const remain = Math.min(perPart, PREVIEW_CHARS - chars);
        const t = c.text.slice(0, remain);
        if (t) {
            parts.push((c.role === "user" ? "我：" : "AI：") + t);
            chars += t.length;
        }
    }
    return parts.join(" ").slice(0, PREVIEW_CHARS);
}

/** 倒序从已读行中取最后几条 user/assistant 文本，拼成预览（最新的在后）。 */
function buildPreviewFromTail(lines: string[]): string {
    const cand: Array<{ role: "user" | "assistant"; text: string }> = [];
    let sawUser = false;
    let sawAssistant = false;
    for (let i = lines.length - 1; i >= 0; i--) {
        let e: any;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        if (!e || e.type !== "message" || !e.message) { continue; }
        const role = e.message.role;
        if (role !== "user" && role !== "assistant") { continue; }
        const t = contentToText(e.message.content).replace(/\s+/g, " ");
        if (!t) { continue; }
        cand.unshift({ role, text: t.slice(0, PREVIEW_CHARS) });
        if (role === "user") { sawUser = true; } else { sawAssistant = true; }
        if (sawUser && sawAssistant) { break; }
    }
    const perPart = (sawUser && sawAssistant)
        ? Math.floor(PREVIEW_CHARS / 2)
        : PREVIEW_CHARS;
    const parts: string[] = [];
    let chars = 0;
    for (const c of cand) {
        if (chars >= PREVIEW_CHARS) { break; }
        const remain = Math.min(perPart, PREVIEW_CHARS - chars);
        const t = c.text.slice(0, remain);
        if (t) {
            parts.push((c.role === "user" ? "我：" : "AI：") + t);
            chars += t.length;
        }
    }
    return parts.join(" ").slice(0, PREVIEW_CHARS);
}

/**
 * 从文件末尾取 {@link TAIL_BYTES} 字节，倒序找最后几条 user/assistant 消息，
 * 按角色拼成预览（带“我：/AI：”前缀），截断到 {@link PREVIEW_CHARS} 字。
 * 分支会话的重放段在文件开头，尾读天然拿到分支独有的最新内容。
 * 无 message 条目时返回空串（调用方按需过滤）。
 */
export function readTailPreview(file: string): Promise<string> {
    return new Promise((resolve) => {
        fs.stat(file, (err, st) => {
            if (err || !st.isFile()) { resolve(""); return; }
            const size = st.size;
            if (size === 0) { resolve(""); return; }
            const start = Math.max(0, size - TAIL_BYTES);
            const stream = fs.createReadStream(file, {
                encoding: "utf8",
                start,
                end: size - 1,
            });
            let buf = "";
            const lines: string[] = [];
            stream.on("data", (chunk) => {
                const d = typeof chunk === "string" ? chunk : chunk.toString("utf8");
                buf += d;
                let i: number;
                while ((i = buf.indexOf("\n")) >= 0) {
                    lines.push(buf.slice(0, i));
                    buf = buf.slice(i + 1);
                }
            });
            stream.on("end", () => {
                if (buf) { lines.push(buf); }
                resolve(buildPreviewFromTail(lines));
            });
            stream.on("error", () => resolve(""));
        });
    });
}

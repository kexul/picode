import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * 会话存储读取：历史列表的家族树 + 尾读预览。
 *
 * 设计：
 *   - {@link buildSessionTree} 全量读每个会话文件第一行 header（仅几十毫秒），
 *     按 parentSession 链构建家族树，按根 timestamp 倒序排列。
 *   - {@link readBranchForkPreview} 分支会话定位 fork 点（重放段后首条新消息）取预览；
 *     纯重放分支退回 {@link readTailPreview}（末尾 8KB = fork 上下文）。
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

/** 渲染用的会话条目：header + 角色拆分的预览（前端分行渲染）。 */
export interface SessionItem {
    file: string;
    id: string;
    timestamp: string; // 创建时间
    depth: number; // 缩进层级
    /** 第一条 / 最后一条 user 文本（无前缀，已截断）——会话主题锚点。 */
    userPreview: string;
    /** 配对的 assistant 文本（无前缀，已截断）——会话摘要佐证。 */
    assistantPreview: string;
}

/** 每批加载的家族数（按家族切片，不在家族中段截断）。 */
export const SESSION_FAMILY_PAGE_SIZE = 20;

/** 尾读块大小：从文件末尾取的字节数。8KB 通常覆盖最后几条消息。 */
const TAIL_BYTES = 8 * 1024;

/** 预览角色拆分结果。前端把 user / assistant 分别渲染成两行，便于扫读会话主题。 */
export interface PreviewPair {
    user: string;
    assistant: string;
}
/** user 预览上限（提问即主题，给更宽以利扫读）。 */
const USER_PREVIEW_CHARS = 160;
/** assistant 预览上限（摘要佐证，略短）。 */
const ASSISTANT_PREVIEW_CHARS = 110;
/** 空 pair：无消息或读取失败时返回，前端按需过滤。 */
const EMPTY_PREVIEW: PreviewPair = { user: "", assistant: "" };

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
 * - 分支会话：读 fork 点（重放段后首条新 user/assistant = 分支自己的开头，
 *   能看出从父会话何处分出去后问了什么）；纯重放分支（无新消息）退回尾读
 *   （末尾几条 = fork 上下文）。headerTimestamp 为分支创建时间（header.timestamp）。
 */
export function readSessionPreview(
    file: string,
    isBranch: boolean,
    headerTimestamp?: string
): Promise<PreviewPair> {
    if (isBranch) {
        return readBranchForkPreview(file, headerTimestamp || "");
    }
    return readHeadPreview(file);
}

/** 二分探测时单次读取的字节数。 */
const PROBE_CHUNK = 8 * 1024;
/** 从 fork 点向后读取的字节数：足以覆盖首条 user/assistant 往返。 */
const FORK_POINT_BYTES = 64 * 1024;

/**
 * 分支会话预览：定位 fork 点（重放段后第一条 timestamp >= 创建时间的 message），
 * 取其后首条 user/assistant（分支自己的开头）。分支文件里重放消息的时间戳
 * 都早于分支创建时间、新消息 >= 创建时间且单调，故按时间戳阈值判定边界。
 * 纯重放分支（无新消息）退回 {@link readTailPreview}（末尾几条 = fork 上下文）。
 */
export function readBranchForkPreview(
    file: string,
    headerTimestamp: string
): Promise<PreviewPair> {
    return new Promise((resolve) => {
        fs.stat(file, (err, st) => {
            if (err || !st.isFile()) { resolve(EMPTY_PREVIEW); return; }
            const size = st.size;
            if (size === 0 || !headerTimestamp) {
                resolve(readTailPreview(file));
                return;
            }
            findForkOffset(file, headerTimestamp, size).then(
                (off) => {
                    if (off < 0) { resolve(readTailPreview(file)); return; }
                    resolve(streamPreviewFromOffset(file, off, size));
                },
                () => resolve(readTailPreview(file))
            );
        });
    });
}

/** 从字节偏移 offset（某 message 行起始）处读一块，按 fromHead 取首条 user/assistant。 */
function streamPreviewFromOffset(
    file: string,
    offset: number,
    size: number
): Promise<PreviewPair> {
    return new Promise((resolve) => {
        const end = Math.min(offset + FORK_POINT_BYTES, size) - 1;
        let stream: fs.ReadStream;
        try {
            stream = fs.createReadStream(file, { encoding: "utf8", start: offset, end });
        } catch {
            resolve(EMPTY_PREVIEW);
            return;
        }
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
            resolve(pickPreviewPair(lines, true));
        });
        stream.on("error", () => resolve(EMPTY_PREVIEW));
    });
}

/**
 * 二分按字节偏移找第一条 timestamp >= threshold 的 message 行的起始偏移。
 * 依赖 message timestamps 单调不减（写文件顺序 = 时间顺序）。返回 -1 表示无此消息
 * （纯重放分支）。以 {@link PROBE_CHUNK} 为探测步长，大文件仅 O(log) 次小读。
 */
function findForkOffset(
    file: string,
    threshold: string,
    size: number
): Promise<number> {
    return new Promise(async (resolve) => {
        let lo = 0;
        let hi = size;
        let ans = -1;
        try {
            for (let iter = 0; iter < 48 && lo < hi; iter++) {
                const mid = lo + ((hi - lo) >> 1);
                const probe = await probeFirstMessage(file, mid, size);
                if (!probe) {
                    // mid 起到 EOF 无 message：答案（若有）在 mid 之前
                    hi = mid;
                    continue;
                }
                if (compareTs(probe.ts, threshold) >= 0) {
                    ans = probe.lineStart;
                    hi = probe.lineStart;
                } else {
                    // 此消息在阈值前，答案在其后
                    lo = probe.lineStart + 1;
                }
            }
            resolve(ans);
        } catch {
            resolve(-1);
        }
    });
}

/**
 * 从字节偏移 offset 起向后读，返回第一条完整 message 行的 { lineStart, ts }。
 * offset>0 时跳过开头不完整的半行。跨 {@link PROBE_CHUNK} 续读直到命中 message 或 EOF。
 * 用 Buffer 按 0x0A 切行，避免 utf8 字符/字节偏移错位（中文会话尤其重要）。
 * 返回 null 表示 offset 起到末尾无 message 行（或读取出错）。
 */
function probeFirstMessage(
    file: string,
    offset: number,
    size: number
): Promise<{ lineStart: number; ts: string } | null> {
    return new Promise((resolve) => {
        if (offset >= size) { resolve(null); return; }
        let buf = Buffer.alloc(0);
        let base = offset; // buf[0] 对应的文件字节偏移
        let pos = offset; // 下一次读取起点
        let skipped = !(offset > 0); // offset>0 时需先跳过半行
        const readNext = () => {
            if (pos >= size) { resolve(null); return; }
            const end = Math.min(pos + PROBE_CHUNK, size) - 1;
            let stream: fs.ReadStream;
            try {
                stream = fs.createReadStream(file, { start: pos, end });
            } catch {
                resolve(null);
                return;
            }
            stream.on("data", (chunk) => {
                const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
                buf = Buffer.concat([buf, b]);
            });
            stream.on("end", () => {
                pos = end + 1; // 已读到 end（含），下次从 end+1
                if (!skipped) {
                    const nl = buf.indexOf(0x0a);
                    if (nl < 0) {
                        if (pos >= size) { resolve(null); return; }
                        // 整块都在一行内：丢弃已读，base 前移到 pos，继续找换行
                        base = pos;
                        buf = Buffer.alloc(0);
                        readNext();
                        return;
                    }
                    buf = buf.slice(nl + 1);
                    base = base + nl + 1;
                    skipped = true;
                }
                let cursor = 0;
                for (;;) {
                    const nl = buf.indexOf(0x0a, cursor);
                    if (nl < 0) {
                        // 当前行不完整：保留 tail，续读
                        buf = buf.slice(cursor);
                        base += cursor;
                        readNext();
                        return;
                    }
                    const lineBytes = buf.slice(cursor, nl);
                    const lineStart = base + cursor;
                    try {
                        const o = JSON.parse(lineBytes.toString("utf8"));
                        if (o && o.type === "message" && typeof o.timestamp === "string") {
                            resolve({ lineStart, ts: o.timestamp });
                            return;
                        }
                    } catch { /* 跳过非法行 */ }
                    cursor = nl + 1;
                }
            });
            stream.on("error", () => resolve(null));
        };
        readNext();
    });
}

/**
 * 从文件开头读前 {@link HEAD_BYTES} 字节，正序找前几条 user/assistant 消息，
 * 按角色拆成预览（无前缀，前端分行渲染）。user 取首条提问（主题），
 * assistant 取其后的首条回复。无 message 条目时返回空 pair。
 */
export function readHeadPreview(file: string): Promise<PreviewPair> {
    return new Promise((resolve) => {
        let stream: fs.ReadStream;
        try {
            stream = fs.createReadStream(file, { encoding: "utf8" });
        } catch {
            resolve(EMPTY_PREVIEW);
            return;
        }
        let buf = "";
        const lines: string[] = [];
        let bytesRead = 0;
        let stopped = false;
        const finish = (v: PreviewPair) => {
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
                finish(pickPreviewPair(lines, true));
            }
        });
        stream.on("end", () => {
            if (buf) { lines.push(buf); }
            finish(pickPreviewPair(lines, true));
        });
        stream.on("error", () => finish(EMPTY_PREVIEW));
    });
}

/** 读文件开头取的字节数。 */
const HEAD_BYTES = 16 * 1024;

/**
 * 从已解析行中按角色各取一条文本（去空白、截断），供前端分行渲染。
 * fromHead=true：取最早出现的 user + 之后的 assistant（根会话主题）。
 * fromHead=false：取最晚一条 user 与最晚一条 assistant（分支最新走向）；
 * 倒序扫描并保持时间顺序，配对到最近一次 user→assistant 往返。
 * 无对应角色时该字段为空串。
 */
function pickPreviewPair(lines: string[], fromHead: boolean): PreviewPair {
    const cand: Array<{ role: "user" | "assistant"; text: string }> = [];
    let sawUser = false;
    let sawAssistant = false;
    const order: readonly string[] = fromHead ? lines : [...lines].reverse();
    for (const line of order) {
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        if (!e || e.type !== "message" || !e.message) { continue; }
        const role = e.message.role;
        if (role !== "user" && role !== "assistant") { continue; }
        const t = contentToText(e.message.content).replace(/\s+/g, " ");
        if (!t) { continue; }
        if (fromHead) {
            cand.push({ role, text: t });
        } else {
            cand.unshift({ role, text: t });
        }
        if (role === "user") { sawUser = true; } else { sawAssistant = true; }
        if (sawUser && sawAssistant) { break; }
    }
    const pick = (r: "user" | "assistant"): string => {
        const matches = cand.filter((x) => x.role === r);
        if (matches.length === 0) { return ""; }
        // head 取首条（主题），tail 取末条（最新）
        const c = fromHead ? matches[0] : matches[matches.length - 1];
        const limit = r === "user" ? USER_PREVIEW_CHARS : ASSISTANT_PREVIEW_CHARS;
        return c.text.slice(0, limit);
    };
    return { user: pick("user"), assistant: pick("assistant") };
}

/**
 * 从文件末尾取 {@link TAIL_BYTES} 字节，倒序找最后几条 user/assistant 消息，
 * 按角色拆成预览（无前缀，前端分行渲染）。分支会话的重放段在文件开头，
 * 尾读天然拿到分支独有的最新内容。user/assistant 取最近一条（最新走向）。
 * 无 message 条目时返回空 pair（调用方按需过滤）。
 */
export function readTailPreview(file: string): Promise<PreviewPair> {
    return new Promise((resolve) => {
        fs.stat(file, (err, st) => {
            if (err || !st.isFile()) { resolve(EMPTY_PREVIEW); return; }
            const size = st.size;
            if (size === 0) { resolve(EMPTY_PREVIEW); return; }
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
                resolve(pickPreviewPair(lines, false));
            });
            stream.on("error", () => resolve(EMPTY_PREVIEW));
        });
    });
}

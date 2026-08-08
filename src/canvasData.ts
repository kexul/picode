/**
 * 历史画布数据：从 session JSONL 直接构建「家族消息图」。
 *
 * - 仅保留有文本的 user / assistant
 * - 跳过空正文 / 工具轮次时沿 parentId 回接到上一则有文本消息
 * - 同家族多 session 按消息 id 合并，共享前缀只出现一次
 * - 每轮 AI 回复只保留最后一条（带工具调用的中间过程消息不展示）
 */
import * as fs from "fs";
import { textOf } from "./messageUtils";
import { SessionTreeNode } from "./sessionStore";

/** 画布首屏 / 每页加载的家族数。 */
export const CANVAS_FAMILY_PAGE_SIZE = 10;

export interface CanvasMsg {
    id: string;
    role: "user" | "assistant";
    text: string;
    parentId: string | null;
    children: string[];
    /** 包含该消息的 session 文件绝对路径。 */
    files: string[];
    timestamp?: string;
}

export interface CanvasSessionMeta {
    id: string;
    file: string;
    timestamp: string;
    parentSession?: string;
    /** 该 session 时间序上最后一条有文本消息 id。 */
    leafId: string | null;
}

export interface CanvasFamily {
    id: string;
    rootFile: string;
    timestamp: string;
    sessions: CanvasSessionMeta[];
    messages: CanvasMsg[];
    roots: string[];
}

interface RawEntry {
    id: string;
    parentId: string | null;
    role?: "user" | "assistant";
    text?: string;
    timestamp?: string;
    isContent: boolean;
}

function compareTs(a: string | undefined, b: string | undefined): number {
    const ta = a ? Date.parse(a) : 0;
    const tb = b ? Date.parse(b) : 0;
    return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
}

/** 读单个会话文件全部行，抽出带 id/parentId 的条目（供回接 parent 链）。 */
export async function readSessionEntries(file: string): Promise<RawEntry[]> {
    let raw: string;
    try {
        raw = await fs.promises.readFile(file, "utf8");
    } catch {
        return [];
    }
    const entries: RawEntry[] = [];
    // 按行扫：大文件一次性读入可接受（按家族分页，不会一次吞全库）。
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
        if (!line) {
            continue;
        }
        let o: any;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        if (!o || typeof o.id !== "string") {
            continue;
        }
        if (o.type === "session") {
            continue;
        }
        const parentId = typeof o.parentId === "string" ? o.parentId : null;
        if (o.type === "message" && o.message) {
            const role = o.message.role;
            if (role === "user" || role === "assistant") {
                const text = textOf(o.message.content).trim();
                entries.push({
                    id: o.id,
                    parentId,
                    role,
                    text,
                    timestamp: typeof o.timestamp === "string" ? o.timestamp : undefined,
                    isContent: text.length > 0,
                });
                continue;
            }
        }
        // toolResult / model_change 等：只参与 parent 链回接
        entries.push({ id: o.id, parentId, isContent: false });
    }
    return entries;
}

/**
 * 把原始条目压成「有文本的 user/assistant」列表，parentId 指向上一则有文本消息。
 * 导出供单测。
 */
export function buildContentMessages(entries: RawEntry[]): Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    parentId: string | null;
    timestamp?: string;
}> {
    const byId = new Map<string, RawEntry>();
    for (const e of entries) {
        byId.set(e.id, e);
    }

    const contentParent = (startParentId: string | null): string | null => {
        let cur = startParentId;
        const seen = new Set<string>();
        while (cur) {
            if (seen.has(cur)) {
                break;
            }
            seen.add(cur);
            const e = byId.get(cur);
            if (!e) {
                break;
            }
            if (e.isContent) {
                return e.id;
            }
            cur = e.parentId;
        }
        return null;
    };

    const out: Array<{
        id: string;
        role: "user" | "assistant";
        text: string;
        parentId: string | null;
        timestamp?: string;
    }> = [];
    for (const e of entries) {
        if (!e.isContent || !e.role || !e.text) {
            continue;
        }
        out.push({
            id: e.id,
            role: e.role,
            text: e.text,
            parentId: contentParent(e.parentId),
            timestamp: e.timestamp,
        });
    }
    return out;
}

function collectFamilySessions(root: SessionTreeNode): SessionTreeNode[] {
    const out: SessionTreeNode[] = [];
    const walk = (n: SessionTreeNode): void => {
        out.push(n);
        for (const c of n.children) {
            walk(c);
        }
    };
    walk(root);
    return out;
}

/** 从一个家族根节点构建画布用合并消息图。 */
export async function buildCanvasFamily(root: SessionTreeNode): Promise<CanvasFamily> {
    const sessions = collectFamilySessions(root);
    const msgMap = new Map<string, CanvasMsg>();
    const sessionMetas: CanvasSessionMeta[] = [];

    for (const s of sessions) {
        const entries = await readSessionEntries(s.header.file);
        const content = buildContentMessages(entries);
        let leafId: string | null = null;
        for (const m of content) {
            leafId = m.id;
            const existing = msgMap.get(m.id);
            if (!existing) {
                msgMap.set(m.id, {
                    id: m.id,
                    role: m.role,
                    text: m.text,
                    parentId: m.parentId,
                    children: [],
                    files: [s.header.file],
                    timestamp: m.timestamp,
                });
            } else if (!existing.files.includes(s.header.file)) {
                existing.files.push(s.header.file);
            }
        }
        sessionMetas.push({
            id: s.header.id,
            file: s.header.file,
            timestamp: s.header.timestamp,
            parentSession: s.header.parentSession,
            leafId,
        });
    }

    for (const m of msgMap.values()) {
        m.children = [];
    }
    for (const m of msgMap.values()) {
        if (m.parentId && msgMap.has(m.parentId)) {
            msgMap.get(m.parentId)!.children.push(m.id);
        }
    }
    for (const m of msgMap.values()) {
        m.children.sort((a, b) => {
            const ma = msgMap.get(a);
            const mb = msgMap.get(b);
            return compareTs(ma?.timestamp, mb?.timestamp);
        });
    }

    // 每轮 AI 回复只保留最后一条，并重接 parent / children
    const messages = keepLastAssistantPerRound([...msgMap.values()]);
    const msgById = new Map(messages.map((m) => [m.id, m]));

    const roots = messages
        .filter((m) => !m.parentId || !msgById.has(m.parentId))
        .map((m) => m.id);
    roots.sort((a, b) => compareTs(msgById.get(a)?.timestamp, msgById.get(b)?.timestamp));

    // leafId 若指向被丢弃的中间回复，向下接到最近的保留消息
    const keptIds = new Set(messages.map((m) => m.id));
    for (const s of sessionMetas) {
        if (s.leafId && !keptIds.has(s.leafId)) {
            s.leafId = nearestKeptDescendant(s.leafId, msgMap, keptIds);
        }
    }

    return {
        id: root.header.id,
        rootFile: root.header.file,
        timestamp: root.header.timestamp,
        sessions: sessionMetas,
        messages,
        roots,
    };
}

/**
 * 每轮（一次 user 提问到下一次提问之间 AI 的完整回复序列）只保留最后一条 assistant。
 * 规则：assistant 若存在 assistant 子消息（该轮回复仍在继续）且没有任何 user 子消息
 * （不存在此轮到此结束的分支），则丢弃；丢弃后子消息 parent 链重接到最近的保留消息。
 */
export function keepLastAssistantPerRound(messages: CanvasMsg[]): CanvasMsg[] {
    const byId = new Map(messages.map((m) => [m.id, m]));
    const dropped = new Set<string>();
    for (const m of messages) {
        if (m.role !== "assistant") {
            continue;
        }
        const kids = (m.children || []).filter((id) => byId.has(id));
        if (kids.length > 0 && kids.every((id) => byId.get(id)!.role === "assistant")) {
            dropped.add(m.id);
        }
    }
    const kept = messages.filter((m) => !dropped.has(m.id));
    const keptIds = new Set(kept.map((m) => m.id));

    // 重接 parent：跳过被丢弃的消息
    for (const m of kept) {
        let p = m.parentId;
        const seen = new Set<string>();
        while (p && dropped.has(p) && !seen.has(p)) {
            seen.add(p);
            const pm = byId.get(p);
            p = pm ? pm.parentId : null;
        }
        m.parentId = p;
    }

    // 重建 children
    for (const m of kept) {
        m.children = [];
    }
    for (const m of kept) {
        const p = m.parentId;
        if (p && keptIds.has(p)) {
            byId.get(p)!.children.push(m.id);
        }
    }
    for (const m of kept) {
        m.children.sort((a, b) =>
            compareTs(byId.get(a)?.timestamp, byId.get(b)?.timestamp)
        );
    }
    return kept;
}

/** 从被丢弃的 leafId 沿子链向下找最近的保留消息（该轮后续的最终回复）。 */
function nearestKeptDescendant(
    id: string,
    byId: Map<string, CanvasMsg>,
    keptIds: Set<string>
): string | null {
    const stack = [id];
    const seen = new Set<string>();
    while (stack.length) {
        const cur = stack.pop()!;
        if (seen.has(cur)) {
            continue;
        }
        seen.add(cur);
        const m = byId.get(cur);
        if (!m) {
            continue;
        }
        if (keptIds.has(cur)) {
            return cur;
        }
        stack.push(...(m.children || []));
    }
    return null;
}

/** 构建若干家族（按 roots 切片）。 */
export async function buildCanvasFamilies(
    roots: SessionTreeNode[],
    offset: number,
    limit: number
): Promise<{ families: CanvasFamily[]; loadedFamilies: number }> {
    if (roots.length === 0 || limit === 0) {
        return { families: [], loadedFamilies: 0 };
    }
    const start = Math.max(0, Math.min(offset, roots.length));
    const end = limit < 0 ? roots.length : Math.min(start + limit, roots.length);
    const slice = roots.slice(start, end);
    const families = await Promise.all(slice.map((r) => buildCanvasFamily(r)));
    return { families, loadedFamilies: end - start };
}

/**
 * 在消息所属 files 中解析打开/fork 用的 session 文件。
 * 优先 highlightFile（当前高亮 path），否则取 timestamp 最新的 session。
 */
export function resolveMessageFile(
    msg: Pick<CanvasMsg, "files">,
    sessions: CanvasSessionMeta[],
    highlightFile?: string | null
): string | undefined {
    if (!msg.files.length) {
        return undefined;
    }
    if (highlightFile && msg.files.some((f) => normFile(f) === normFile(highlightFile))) {
        // 返回 files 里与 highlight 匹配的原始路径
        const hit = msg.files.find((f) => normFile(f) === normFile(highlightFile));
        return hit || highlightFile;
    }
    const byNorm = new Map(sessions.map((s) => [normFile(s.file), s]));
    let best: CanvasSessionMeta | undefined;
    for (const f of msg.files) {
        const s = byNorm.get(normFile(f));
        if (!s) {
            continue;
        }
        if (!best || compareTs(s.timestamp, best.timestamp) > 0) {
            best = s;
        }
    }
    return best?.file || msg.files[msg.files.length - 1];
}

/** 从 leaf 回溯到根的 path id 集合。 */
export function pathIdsToRoot(
    messages: CanvasMsg[],
    leafId: string | null | undefined
): string[] {
    if (!leafId) {
        return [];
    }
    const byId = new Map(messages.map((m) => [m.id, m]));
    const path: string[] = [];
    let cur: string | null | undefined = leafId;
    const seen = new Set<string>();
    while (cur && byId.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        path.push(cur);
        cur = byId.get(cur)!.parentId;
    }
    return path;
}

function normFile(p: string): string {
    let s = p.replace(/\\/g, "/").toLowerCase();
    s = s.replace(/^[a-z]:/, "");
    return s;
}

/** 路径归一化比较（盘符大小写 / 分隔符）。 */
export function sameSessionFile(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    return normFile(a) === normFile(b);
}

/** 在家族列表里找包含某 session 文件的家族。 */
export function findFamilyBySessionFile(
    families: CanvasFamily[],
    sessionFile: string
): CanvasFamily | undefined {
    const target = normFile(sessionFile);
    return families.find((fam) =>
        fam.sessions.some((s) => normFile(s.file) === target)
    );
}

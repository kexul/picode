/**
 * 「这一段里到底是哪几个字变了」：交给 omnidiff（https://github.com/ivankovic/omnidiff）算。
 *
 * 页面照旧自己排行、自己上色，只拿它给的区间把变了的几个字再涂深一点 —— 不然改一个标识符，
 * 整行都算改，看着累。omnidiff 是按语法树比的，能认出「这几个字只是搬了个位置、压根没改」，
 * 自己按字符硬比做不到这个。
 *
 * 它要的是两个文件，给不了区间：所以把这段 diff 里「删行 + 没变的行」拼成 a、「增行 + 没变的行」
 * 拼成 b，临时落在系统临时目录（扩展名跟着改的那个文件走：它按扩展名挑语法），比完就删。
 * 它回的是两边各自的字节区间（0 起的行、行内字节列），这里换算成「这一行正文里的第几个字」。
 *
 * 没装 omnidiff（PATH 里找不到）就什么区间都不给：页面照旧整行上色。
 * 也别把它打进插件一起发：它是 AGPL v3，插件是 MIT，只能调人自己装好的那一个（跟 git difftool 一样）。
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 一行里要涂深的区间：`[起, 止)`，单位是这一行的第几个字（不是字节）。 */
export type LineRanges = Array<[number, number]> | null;

/**
 * 一段 diff 拆开以后的一行：两边各自的真实行号（1 起，不在那一边就是 0）、
 * 去掉前缀以后的原文，以及变了的字在原文里的区间。
 */
export interface DiffRowLine {
    /** `gap` = 两段改动之间省掉的那一截（不是正文，只占一行提示）。 */
    kind: "ctx" | "del" | "add" | "gap";
    before: number;
    after: number;
    text: string;
    hl: Array<[number, number]> | null;
}

/** 一段 diff 最多多大才值得算法：再大的本来也没人一行行看（页面那边也有自己的上限）。 */
const MAX_DIFF_CHARS = 400_000;
/** 它自己的目标是一份 diff 100 毫秒以内；慢成这样就别等了，页面照旧画。 */
const TIMEOUT_MS = 3000;
/** 刚找过没找着的时候，隔一会再翻一遍 PATH（人可能刚装好），别每段 diff 都翻一遍。 */
const RESCAN_MS = 30_000;
/** 算过的留着：同一份 diff 会重画好几遍（历史回放、开关弹窗）。 */
const CACHE_MAX = 64;

let foundBin: string | undefined;
let scannedAt = 0;
const cache = new Map<string, Analyzed>();

/**
 * 一段 diff 里每一行要涂深的区间，跟 `diffText.split("\n")` 一一对应（单位是那一行显示出来的文字）；
 * 这一行不用涂就是 null。undefined = 算不出来（没装 omnidiff / 太大 / 它自己不认这一对文件）。
 */
export async function changedCharRanges(diffText: string, relPath: string): Promise<LineRanges[] | undefined> {
    const got = await analyze(diffText, relPath);
    if (!got || got.ranges === undefined) { return undefined; }
    const out: LineRanges[] = got.lines.map((line, i) => {
        const ranges = rangesOf(got, line, i);
        if (!ranges) { return null; }
        // 显示出来的是「前缀 + 原文」：整体往后挪，再夹到这一行显示出来的长度以内
        const shifted: Array<[number, number]> = [];
        for (const [start, end] of ranges) {
            const from = line.start + start;
            const to = Math.min(line.start + line.content.length, line.start + end);
            if (to > from) { shifted.push([from, to]); }
        }
        return shifted.length ? shifted : null;
    });
    return out.some((one) => one !== null) ? out : undefined;
}

/**
 * 一段 diff 拆成一行行：两边的真实行号、原文、变了的字（见 DiffRowLine）。
 * 页面拿它摆「之前 | 之后」两栏；没装 omnidiff 时 `hl` 全是 null，两栏照旧能看。
 */
export async function diffRows(diffText: string, relPath: string): Promise<DiffRowLine[]> {
    const got = await analyze(diffText, relPath);
    if (!got) { return []; }
    const out: DiffRowLine[] = [];
    let before = 0;
    let after = 0;
    got.lines.forEach((line, i) => {
        if (line.kind === "other") {
            const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line.content);
            if (hunk) {
                before = Number(hunk[1]);
                after = Number(hunk[2]);
            }
            // `@@` 与 pi 那种 `...`（省掉了中间一截）各占一行「这里省了」；`--- a/x` 那种头不占行
            const elided = hunk !== null || ["...", "…"].includes(line.content.trim());
            if (elided && out.length) { out.push({ kind: "gap", before: 0, after: 0, text: "", hl: null }); }
            return;
        }
        const hl = rangesOf(got, line, i);
        if (line.kind === "del") {
            if (line.number !== undefined) { before = line.number; }
            out.push({ kind: "del", before: before++, after: 0, text: line.content, hl });
            return;
        }
        if (line.kind === "add") {
            if (line.number !== undefined) { after = line.number; }
            out.push({ kind: "add", before: 0, after: after++, text: line.content, hl });
            return;
        }
        // 没变的行：两边行号一样（带行号的就照它，否则两边各数各的）
        if (line.number !== undefined) {
            before = line.number;
            after = line.number;
        }
        out.push({ kind: "ctx", before: before++, after: after++, text: line.content, hl });
    });
    return out;
}

/** 这一行变了的字，在它正文里的区间；不涂就是 null。 */
function rangesOf(got: Analyzed, line: DiffLine, i: number): Array<[number, number]> | null {
    if (line.kind !== "del" && line.kind !== "add") { return null; }
    const [own, ranges] = line.kind === "del" ? [got.before, got.beforeRanges] : [got.after, got.afterRanges];
    const row = own.rowOf[i];
    if (row < 0 || row >= own.parts.length) { return null; }
    const bytes = ranges.get(row);
    if (!bytes) { return null; }
    const out = charRanges(bytes, own.parts[row]);
    return out.length ? out : null;
}

// ==================== 一段 diff 拆成两边 ====================

interface DiffLine {
    kind: "ctx" | "del" | "add" | "other";
    /** 这一行去掉前缀（`+` / `-` / 空格，以及 pi 那种行号）以后剩下的原文。 */
    content: string;
    /** 原文在这一行显示出来的文字里从第几个字开始。 */
    start: number;
    /** 这一行自己带着的行号（pi 那种格式有，git 与我们自己那份没有）。 */
    number?: number;
}

interface Side {
    /** 这一边拼起来的全文（行尾都是 `\n`）。 */
    text: string;
    /** 每一行去掉前缀以后的原文。 */
    parts: string[];
    /** diff 里的第几行 → 这一边全文的第几行；-1 = 这一行不在这一边。 */
    rowOf: Int32Array;
}

/** 一段 diff 拆开的结果：哪几行、两边各是哪几行、变了的字各在哪儿（`ranges` 为空 = 没算出区间）。 */
interface Analyzed {
    lines: DiffLine[];
    before: Side;
    after: Side;
    beforeRanges: Map<number, Array<[number, number]>>;
    afterRanges: Map<number, Array<[number, number]>>;
    /** undefined = 这一份算不出区间（没装 omnidiff / 太大 / 它自己不认）。 */
    ranges: true | undefined;
}

/** 两种 diff 的文字都认：git 与我们自己那份是「前缀 + 原文」，pi 那边是「前缀 + 右对齐的行号 + 空格 + 原文」。 */
const NUMBERED = /^[+\- ] *(\d+) /;
const MARKER = /^[+\- ]/;

/** 这几个不是 diff 的正文：git 那几行头（`gitChanges` 里已经去掉了，别处可能有）、`@@` 段头、末行提示。 */
function isHeaderLine(line: string): boolean {
    return line.startsWith("@@") || line.startsWith("diff --git ") || line.startsWith("index ")
        || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\ No newline");
}

function parseDiffLines(diffText: string): DiffLine[] {
    const raw = diffText.split("\n");
    // 带不带行号得整段一起定：一行一行猜的话，原文正好以「3 个」开头就会被吃掉。
    let marked = 0;
    let numbered = 0;
    for (const line of raw) {
        if (!MARKER.test(line) || isHeaderLine(line)) { continue; }
        marked++;
        if (NUMBERED.test(line)) { numbered++; }
    }
    const withNumbers = numbered * 2 > marked;
    return raw.map((line): DiffLine => {
        if (!MARKER.test(line) || isHeaderLine(line)) { return { kind: "other", content: line, start: 0 }; }
        const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx";
        const m = withNumbers ? NUMBERED.exec(line) : null;
        const start = m ? m[0].length : 1;
        return { kind, content: line.slice(start), start, number: m ? Number(m[1]) : undefined };
    });
}

/** 把 diff 拆成一边的全文：前（删行 + 没变的行）或者后（增行 + 没变的行）。 */
function sideOf(lines: DiffLine[], side: "before" | "after"): Side {
    const parts: string[] = [];
    const rowOf = new Int32Array(lines.length).fill(-1);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const take = side === "before" ? line.kind === "ctx" || line.kind === "del" : line.kind === "ctx" || line.kind === "add";
        if (!take) { continue; }
        rowOf[i] = parts.length;
        parts.push(line.content);
    }
    return { text: parts.length ? parts.join("\n") + "\n" : "", parts, rowOf };
}

/**
 * 一段 diff 拆开，并且（如果装了 omnidiff）问一遍变了的字在哪儿。
 * 结果按 diff 文字缓存：同一份 diff 会重画好几遍。
 */
async function analyze(diffText: string, relPath: string): Promise<Analyzed | undefined> {
    if (!diffText || diffText.length > MAX_DIFF_CHARS) { return undefined; }
    const ext = languageExt(relPath);
    const key = ext + "\u0000" + diffText;
    const hit = cache.get(key);
    if (hit) {
        cache.delete(key);   // 用过的挪到队尾（Map 按插入顺序，最前面那个就是最久没用的）
        cache.set(key, hit);
        return hit;
    }
    const lines = parseDiffLines(diffText);
    const before = sideOf(lines, "before");
    const after = sideOf(lines, "after");
    if (before.parts.length === 0 && after.parts.length === 0) { return undefined; }
    const bin = findOmnidiff();    const json = bin ? await runOmnidiff(bin, before.text, after.text, ext) : undefined;
    const got: Analyzed = {
        lines,
        before,
        after,
        beforeRanges: rangesOfSide(json?.before, before),
        afterRanges: rangesOfSide(json?.after, after),
        ranges: json ? true : undefined,
    };
    // 只记算成功过的：没装 omnidiff 时不要把它“算不出来”也记下来（人可能刚装好，下一次该重试）
    if (got.ranges === true) {
        if (cache.size >= CACHE_MAX) { cache.delete(cache.keys().next().value as string); }
        cache.set(key, got);
    }
    return got;
}

// ==================== 它给的那些区间 ====================

interface RowRange {
    start_row?: number;
    start_column?: number;
    end_row?: number;
    end_column?: number;
}

interface Hunk {
    operation?: string;
    range?: RowRange;
}

/** 一边的每个改动行 → 这一行上变了的字节区间。`move` 不算：那几个字只是搬了位置，没改。 */
function rangesOfSide(side: unknown, own: Side): Map<number, Array<[number, number]>> {
    const out = new Map<number, Array<[number, number]>>();
    const hunks = (side as { hunks?: unknown } | undefined)?.hunks;
    if (!Array.isArray(hunks)) { return out; }
    for (const hunk of hunks as Hunk[]) {
        if (!hunk || hunk.operation === "move" || !hunk.range) { continue; }
        const { start_row: sr, start_column: sc = 0, end_row: er, end_column: ec = 0 } = hunk.range;
        if (typeof sr !== "number" || typeof er !== "number" || er < sr) { continue; }
        if (sr === er) { addRange(out, own, sr, sc, ec); continue; }
        addRange(out, own, sr, sc, byteLength(own.parts[sr]));
        for (let row = sr + 1; row < er; row++) { addRange(out, own, row, 0, byteLength(own.parts[row])); }
        addRange(out, own, er, 0, ec);
    }
    return out;
}

function addRange(out: Map<number, Array<[number, number]>>, own: Side, row: number, from: number, to: number): void {
    if (!(row >= 0) || row >= own.parts.length) { return; }
    const end = Math.min(to, byteLength(own.parts[row]));
    const start = Math.max(0, from);
    if (end <= start) { return; }
    const list = out.get(row);
    if (list) { list.push([start, end]); } else { out.set(row, [[start, end]]); }
}

function byteLength(text: string | undefined): number {
    return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
}

/**
 * 字节区间（行内字节列）→ 这一行正文里的字的区间（UTF-16 的计法）。
 * 一个汉字占 3 个字节、算 1 个字符，所以对不上，得按那一行的原文一个个字地数过去。
 */
function charRanges(bytes: Array<[number, number]>, content: string): Array<[number, number]> {
    const chars = charsOf(content);
    const limit = content.length;
    const out: Array<[number, number]> = [];
    for (const [from, to] of bytes) {
        const start = unitsAt(chars, from);
        const end = Math.min(limit, unitsAt(chars, to));
        if (end > start) { out.push([start, end]); }
    }
    out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const range of out) {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1]) { last[1] = Math.max(last[1], range[1]); } else { merged.push([range[0], range[1]]); }
    }
    return merged;
}

/** 一行原文里每个字（码点）从第几个字节起、到第几个字符为止，用来把字节列翻成字符列。 */
function charsOf(text: string): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let bytes = 0;
    let units = 0;
    for (const ch of text) {
        out.push([bytes, units]);
        bytes += Buffer.byteLength(ch, "utf8");
        units += ch.length;
    }
    out.push([bytes, units]);
    return out;
}

/** 第几个字节落在第几个字符：落在字中间（不该有）就取这个字的开头。 */
function unitsAt(chars: Array<[number, number]>, byte: number): number {
    if (byte <= 0) { return 0; }
    let low = 0;
    let high = chars.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (chars[mid][0] <= byte) { low = mid; } else { high = mid - 1; }
    }
    return chars[low][1];
}

// ==================== 叫它干活 ====================

/** 临时文件用哪个扩展名：它按扩展名挑语法（`.py` 按 Python 比，不认识的当纯文本比）。 */
function languageExt(relPath: string): string {
    const ext = path.extname(relPath || "");
    return /^\.[A-Za-z0-9]{1,12}$/.test(ext) ? ext : ".txt";
}

/** 装在哪：PATH 里挨个目录找。找着一次就一直记着。 */
function findOmnidiff(): string | undefined {
    if (foundBin !== undefined) { return foundBin; }
    const now = Date.now();
    if (scannedAt !== 0 && now - scannedAt < RESCAN_MS) { return undefined; }
    scannedAt = now;
    const names = process.platform === "win32" ? ["omnidiff.exe", "omnidiff"] : ["omnidiff"];
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!dir) { continue; }
        for (const name of names) {
            const full = path.join(dir, name);
            try {
                fs.accessSync(full, fs.constants.X_OK);
                foundBin = full;
                return full;
            } catch { /* 这个目录里没有 */ }
        }
    }
    return undefined;
}

/** 让它比一遍两个临时文件，拿它回的 JSON；哪一种失败都当「算不出来」。 */
async function runOmnidiff(bin: string, before: string, after: string, ext: string): Promise<any | undefined> {
    let dir: string | undefined;
    try {
        dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pichat-diff-"));
        const a = path.join(dir, "a" + ext);
        const b = path.join(dir, "b" + ext);
        await fs.promises.writeFile(a, before, "utf8");
        await fs.promises.writeFile(b, after, "utf8");
        const out = await new Promise<string | undefined>((resolve) => {
            execFile(bin, ["--mode", "json", a, b], {
                timeout: TIMEOUT_MS,
                maxBuffer: 8 * 1024 * 1024,
                windowsHide: true,
                env: { ...process.env, NO_COLOR: "1", OMNIDIFF_GRAPHICS: "halfblocks" },
            }, (err, stdout) => { resolve(err ? undefined : stdout); });
        });
        return out ? JSON.parse(out) : undefined;
    } catch {
        return undefined;
    } finally {
        if (dir) { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { /* 删不掉就算了 */ }); }
    }
}

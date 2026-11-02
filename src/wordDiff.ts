/**
 * 「这一段里到底是哪几个字变了」：给页面涂深用（整行都算改太笼统了）。
 *
 * 算的办法：把删的那几行与加的那几行配成对（一行对一行），一对一对地用
 * Google 的 diff-match-patch 按**字**比，把它认出来的那几段区间交出去（见 src/diffMatchPatch.js）。
 * 那一步带上「语义整理」，所以改一个标识符得到的是「这几个字变了」，不是「一个字母一个色块」。
 *
 * 两件事说明白：
 *   · 它不懂语法（要按语法结构比就得带上几十种语言的语法剖析器，那是另一个量级的事）：认得字、认不得结构。所以
 *     「这段只是搬了个位置」会被算成改了，改一个字符也会算成改了一个词——看着不影响用。
 *   · 删 3 行加 1 行这种，哪一行跟哪一行配是猜的（见 pairLines：按像不像挑）；配不上、
 *     或者一对里改掉的字占了大半，就不涂那几个字——整行本来就是变了的，再涂一层只会是一块色。
 */
import diff_match_patch from "./diffMatchPatch";

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

/** 一段 diff 最多多大才值得一行行比：再大的本来也没人一行行看（页面那边也有自己的上限）。 */
const MAX_DIFF_CHARS = 400_000;
/** 一对里改掉的字占这么多就不涂了：整行都算改，涂出来只会是一片色块。 */
const WHOLE_LINE = 0.6;
/** 配对时最多试这么多个组合（删 M 行 × 加 N 行）：再大就直接按顺序配，别在这儿耗时间。 */
const PAIR_TRIES = 100;
/** 太不像的两行不配（相似度低于这个）：配错了，涂出来的颜色反而更乱。 */
const PAIR_MIN = 0.3;

/** 操作码：跟 diff-match-patch 里那几个一致（那个文件是照抄的 JS，没带类型，这里自己写一份）。 */
const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

/**
 * 一段 diff 里每一行要涂深的区间，跟 `diffText.split("\n")` 一一对应（单位是那一行显示出来的文字）；
 * 这一行不用涂就是 null。undefined = 这一份什么都不用涂（没改动 / 太大 / 一行都配不上）。
 */
export function changedCharRanges(diffText: string): LineRanges[] | undefined {
    const got = analyze(diffText);
    if (!got) { return undefined; }
    const out: LineRanges[] = got.lines.map((line) => {
        const ranges = got.hl.get(line);
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
 * 页面拿它摆「之前 | 之后」两栏。
 */
export function diffRows(diffText: string): DiffRowLine[] {
    const got = analyze(diffText);
    if (!got) { return []; }
    const out: DiffRowLine[] = [];
    let before = 0;
    let after = 0;
    for (const line of got.lines) {
        if (line.kind === "other") {
            const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line.content);
            if (hunk) {
                before = Number(hunk[1]);
                after = Number(hunk[2]);
            }
            // `@@` 与 pi 那种 `...`（省掉了中间一截）各占一行「这里省了」；`--- a/x` 那种头不占行
            const elided = hunk !== null || ["...", "…"].includes(line.content.trim());
            if (elided && out.length) { out.push({ kind: "gap", before: 0, after: 0, text: "", hl: null }); }
            continue;
        }
        const hl = got.hl.get(line) ?? null;
        if (line.kind === "del") {
            if (line.number !== undefined) { before = line.number; }
            out.push({ kind: "del", before: before++, after: 0, text: line.content, hl });
            continue;
        }
        if (line.kind === "add") {
            if (line.number !== undefined) { after = line.number; }
            out.push({ kind: "add", before: 0, after: after++, text: line.content, hl });
            continue;
        }
        // 没变的行：两边行号一样（带行号的就照它，否则两边各数各的）
        if (line.number !== undefined) {
            before = line.number;
            after = line.number;
        }
        out.push({ kind: "ctx", before: before++, after: after++, text: line.content, hl: null });
    }
    return out;
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

/** 一段 diff 拆开的结果：哪几行，以及哪几行里变了的字在哪儿（键是 lines 里的下标）。 */
interface Analyzed {
    lines: DiffLine[];
    hl: Map<DiffLine, Array<[number, number]>>;
}

/** 两种 diff 的文字都认：git 与我们自己那份是「前缀 + 原文」，pi 那边是「前缀 + 右对齐的行号 + 空格 + 原文」。 */
const NUMBERED = /^[+\- ] *(\d+) /;
const MARKER = /^[+\- ]/;

/** 这几个不是 diff 的正文：git 那几行头（`gitChanges` 里已经去掉了，别处可能有）、`@@` 段头、末行提示。 */
function isHeaderLine(line: string): boolean {
    return line.startsWith("@@") || line.startsWith("diff --git ") || line.startsWith("index ")
        || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\ No newline");
}

/** 一段 diff 拆开，并且把变了的字算出来（算不出来时 hl 里就没有那一行）。 */
function analyze(diffText: string): Analyzed | undefined {
    if (!diffText || diffText.length > MAX_DIFF_CHARS) { return undefined; }
    const lines = parseDiffLines(diffText);
    if (!lines.some((line) => line.kind === "del" || line.kind === "add")) { return undefined; }
    return { lines, hl: lineRanges(lines) };
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

// ==================== 哪几行配成对、哪几个字变了 ====================

/** 整段 diff 里变了的字：删的那一段与加的那一段成对地比（见 pairLines）。 */
function lineRanges(lines: DiffLine[]): Map<DiffLine, Array<[number, number]>> {
    const out = new Map<DiffLine, Array<[number, number]>>();
    const dmp = new diff_match_patch();
    for (let i = 0; i < lines.length;) {
        if (lines[i].kind !== "del") { i++; continue; }
        const dels: DiffLine[] = [];
        while (i < lines.length && lines[i].kind === "del") { dels.push(lines[i++]); }
        const adds: DiffLine[] = [];
        while (i < lines.length && lines[i].kind === "add") { adds.push(lines[i++]); }
        if (!adds.length) { continue; }
        for (const [left, right] of pairLines(dels, adds, dmp)) {
            if (!left || !right || similar(left.content, right.content, dmp) < PAIR_MIN) { continue; }
            const changed = changedIn(left.content, right.content, dmp);
            if (!changed) { continue; }
            if (changed.left) { out.set(left, changed.left); }
            if (changed.right) { out.set(right, changed.right); }
        }
    }
    return out;
}

/**
 * 删的那几行与加的那几行怎么配成对：行数一样就照顺序配（绝大多数 diff 都是这样），
 * 不一样（删 3 加 1 那种）就按「谁跟谁像」挑，剩下的晾着不配。
 */
function pairLines(dels: DiffLine[], adds: DiffLine[], dmp: diff_match_patch): Array<[DiffLine?, DiffLine?]> {
    if (dels.length === adds.length) { return dels.map((line, i) => [line, adds[i]]); }
    if (dels.length * adds.length > PAIR_TRIES) {
        // 太多组合了：按顺序配，多出来的那几行不配（那种大块多半是整段换掉，涂不涂那几个字无所谓）
        const count = Math.max(dels.length, adds.length);
        const out: Array<[DiffLine?, DiffLine?]> = [];
        for (let i = 0; i < count; i++) { out.push([dels[i], adds[i]]); }
        return out;
    }
    const pairs: Array<{ left: DiffLine; right: DiffLine; score: number }> = [];
    for (const left of dels) {
        for (const right of adds) { pairs.push({ left, right, score: similar(left.content, right.content, dmp) }); }
    }
    pairs.sort((a, b) => b.score - a.score);
    const usedLeft = new Set<DiffLine>();
    const usedRight = new Set<DiffLine>();
    const out: Array<[DiffLine?, DiffLine?]> = [];
    for (const pair of pairs) {
        if (usedLeft.has(pair.left) || usedRight.has(pair.right)) { continue; }
        usedLeft.add(pair.left);
        usedRight.add(pair.right);
        out.push([pair.left, pair.right]);
    }
    for (const left of dels) { if (!usedLeft.has(left)) { out.push([left, undefined]); } }
    for (const right of adds) { if (!usedRight.has(right)) { out.push([undefined, right]); } }
    return out;
}

/** 两行像不像（0—1）：按「改了多少个字」算，1 = 一模一样。 */
function similar(left: string, right: string, dmp: diff_match_patch): number {
    if (left === right) { return 1; }
    const longest = Math.max(left.length, right.length);
    if (longest === 0) { return 1; }
    return 1 - dmp.diff_levenshtein(dmp.diff_main(left, right, false)) / longest;
}

interface Changed {
    left?: Array<[number, number]>;
    right?: Array<[number, number]>;
}

/**
 * 一对行里变了的字：删的那一边给了哪些区间、加的那一边给了哪些区间。
 * 改掉的字占了大半就不给（整行都是新的，涂出来是一块色）；只改了空白也不给（看不见）。
 */
function changedIn(left: string, right: string, dmp: diff_match_patch): Changed | undefined {
    const diffs = dmp.diff_main(left, right, false);
    dmp.diff_cleanupSemantic(diffs);
    const leftRanges: Array<[number, number]> = [];
    const rightRanges: Array<[number, number]> = [];
    let atLeft = 0;
    let atRight = 0;
    for (const [op, text] of diffs) {
        if (op === DIFF_EQUAL) {
            atLeft += text.length;
            atRight += text.length;
        } else if (op === DIFF_DELETE) {
            leftRanges.push([atLeft, atLeft + text.length]);
            atLeft += text.length;
        } else if (op === DIFF_INSERT) {
            rightRanges.push([atRight, atRight + text.length]);
            atRight += text.length;
        }
    }
    const leftTrimmed = trimRanges(left, leftRanges);
    const rightTrimmed = trimRanges(right, rightRanges);
    if (!leftTrimmed.length && !rightTrimmed.length) { return undefined; }
    // 先按「真正变了的字」占多少来判：扩到整个词以后会显得改得更多，拿那个数判会把该涂的也毙掉
    const longest = Math.max(left.length, right.length, 1);
    const biggest = Math.max(changedLength(leftTrimmed), changedLength(rightTrimmed));
    if (biggest / longest > WHOLE_LINE) { return undefined; }
    const leftWide = widenRanges(left, leftTrimmed);
    const rightWide = widenRanges(right, rightTrimmed);
    return { left: leftWide.length ? leftWide : undefined, right: rightWide.length ? rightWide : undefined };
}

/** 区间两头把空白削掉：空白变了界面上看不出来，涂上去只是一道细细的色条。 */
function trimRanges(text: string, ranges: Array<[number, number]>): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const [from, to] of ranges) {
        let start = from;
        let end = to;
        while (start < end && /\s/.test(text[start])) { start++; }
        while (end > start && /\s/.test(text[end - 1])) { end--; }
        if (end > start) { out.push([start, end]); }
    }
    return mergeRanges(out);
}

/** 落在标识符中间的区间扩到整个标识符上（`numbers` 不会只涂成 `number`、剩下那个 `s` 不涂）。 */
function widenRanges(text: string, ranges: Array<[number, number]>): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const [from, to] of ranges) {
        let start = from;
        let end = to;
        while (start > 0 && isWordChar(text[start - 1]) && isWordChar(text[start])) { start--; }
        while (end < text.length && isWordChar(text[end]) && isWordChar(text[end - 1])) { end++; }
        out.push([start, end]);
    }
    return mergeRanges(out);
}

/** 挨上、叠上的区间并成一段（同一个字别被切两遍）。 */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
    const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const range of sorted) {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1]) { last[1] = Math.max(last[1], range[1]); } else { merged.push(range); }
    }
    return merged;
}

/** 算不算标识符里那类字（只认英文字母数字这些：中文不当词切，涂到哪儿算哪儿）。 */
function isWordChar(ch: string | undefined): boolean {
    return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function changedLength(ranges: Array<[number, number]>): number {
    let total = 0;
    for (const [from, to] of ranges) { total += to - from; }
    return total;
}

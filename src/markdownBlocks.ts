/**
 * markdownBlocks —— 把一条回复的 markdown 解析成「怎么画」这么一份结构，交给手机和桌面去画。
 *
 * 为什么放在后端：那两头各有自己的一套界面（安卓用原生控件、Windows 用 WPF），
 * 各自解析一遍的话，同一段字在两边可能画得不一样，加个东西还得改三处。
 * 这里解析一次，两头只负责照着画。
 *
 * 认的是聊天里真会碰到的那几样：段落、标题、列表、表格、引用、代码块、分隔线，
 * 加上行内的粗体 / 斜体 / 删除线 / 行内代码 / 链接文字。脚注、HTML、图片、嵌套列表不认。
 * 断行规矩跟网页端一致（media/chat.js 的 mdOptions：breaks 打开）：
 * **单个换行就是换行**，空行才另起一段。
 *
 * 结构（键名故意短，这条东西每条通知都要塞一份，手机上走的是移动网络）：
 *
 *   Block = { k: "p",    r: Run[] }                       段落
 *         | { k: "h",    n: 1..6, r: Run[] }              标题
 *         | { k: "l",    o: boolean, i: Item[] }          列表（o = 有序）
 *         | { k: "code", v: string }                      代码块
 *         | { k: "q",    r: Run[] }                       引用
 *         | { k: "hr" }                                   分隔线
 *         | { k: "t",    a: number[], g: Run[][][] }      表格（a 每列对齐 0 左 / 1 中 / 2 右，g 是格子）
 *   Item  = { m: string, r: Run[] }                       m 是「•」或者「3.」
 *   Run   = { v: string, b?: 1, i?: 1, s?: 1, c?: 1, l?: 1 }
 *            v 是字（里面可能有 "\n"，客户端照它换行）；
 *            b 粗 / i 斜 / s 删除线 / c 行内代码 / l 链接文字
 */

/** 行内的一段字（同一个样式的连续几个字算一段）。 */
export interface MdRun {
    v: string;
    b?: 1;
    i?: 1;
    s?: 1;
    c?: 1;
    l?: 1;
}

/** 列表里的一项。 */
export interface MdItem {
    m: string;
    r: MdRun[];
}

export type MdBlock =
    | { k: "p"; r: MdRun[] }
    | { k: "h"; n: number; r: MdRun[] }
    | { k: "l"; o: boolean; i: MdItem[] }
    | { k: "code"; v: string }
    | { k: "q"; r: MdRun[] }
    | { k: "hr" }
    | { k: "t"; a: number[]; g: MdRun[][][] };

/** 解析出来的东西：块（给正文用），加一行摘要（给列表上那一行用）。 */
export interface MdDoc {
    blocks: MdBlock[];
    /** 「压成一句话」的预览：去掉记号、去掉代码块、只留头一句。 */
    plain: string;
}

/** 解析一条回复。 */
export function parseMarkdown(text: string): MdDoc {
    const blocks = parseBlocks(text ?? "");
    return { blocks, plain: plainOf(text ?? "") };
}

// ======================================================================
//  块
// ======================================================================

function parseBlocks(text: string): MdBlock[] {
    const blocks: MdBlock[] = [];
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    let i = 0;

    while (i < lines.length) {
        const raw = lines[i];
        const line = raw.trim();
        if (line.length === 0) { i++; continue; }

        // 代码块：``` 或者 ~~~ 开头，一直到同一种栅栏收尾（后面跟着的语言名不管）
        if (line.startsWith("```") || line.startsWith("~~~")) {
            const fence = line.slice(0, 3);
            const body: string[] = [];
            i++;
            while (i < lines.length && !lines[i].trimStart().startsWith(fence)) { body.push(lines[i]); i++; }
            if (i < lines.length) { i++; }          // 收尾的那一行
            blocks.push({ k: "code", v: body.join("\n") });
            continue;
        }

        // 一条横线
        if (isRule(line)) { blocks.push({ k: "hr" }); i++; continue; }

        // 标题：# 到 ######，后面得有个空格
        const hashes = countHashes(line);
        if (hashes >= 1 && hashes <= 6 && line.length > hashes && line[hashes] === " ") {
            blocks.push({ k: "h", n: hashes, r: parseInline(line.slice(hashes + 1).trim()) });
            i++;
            continue;
        }

        // 引用：连着几行以 > 开头的合成一段
        if (line.startsWith(">")) {
            const parts: string[] = [];
            while (i < lines.length && lines[i].trimStart().startsWith(">")) {
                let piece = lines[i].trimStart().slice(1);
                if (piece.startsWith(" ")) { piece = piece.slice(1); }
                parts.push(piece);
                i++;
            }
            blocks.push({ k: "q", r: parseInline(parts.join("\n").trimEnd()) });
            continue;
        }

        // 表格：这一行有竖线、下一行是「|---|:--:|」那种分隔行
        if (line.includes("|") && i + 1 < lines.length && isTableRule(lines[i + 1])) {
            const align = splitRow(lines[i + 1]).map(alignOf);
            const rows: MdRun[][][] = [splitRow(line).map(parseInline)];
            i += 2;
            while (i < lines.length && lines[i].trim().length > 0 && lines[i].includes("|")) {
                const cells = splitRow(lines[i].trim()).map(parseInline);
                // 每行补到列数一样（写 markdown 的人常常少写几格）
                while (cells.length < align.length) { cells.push([]); }
                rows.push(cells);
                i++;
            }
            blocks.push({ k: "t", a: align, g: rows });
            continue;
        }

        // 列表：连着几项，类型得一样
        const first = itemOf(line);
        if (first) {
            const ordered = first.ordered;
            const items: MdItem[] = [{ m: first.marker, r: parseInline(first.text) }];
            i++;
            while (i < lines.length) {
                const item = itemOf(lines[i].trim());
                if (!item || item.ordered !== ordered) { break; }
                items.push({ m: item.marker, r: parseInline(item.text) });
                i++;
            }
            blocks.push({ k: "l", o: ordered, i: items });
            continue;
        }

        // 剩下的就是一段：一直到空行 / 下一个块的开头
        const paragraph: string[] = [trimEnd(raw)];
        i++;
        while (i < lines.length && isParagraphLine(lines[i])) {
            paragraph.push(trimEnd(lines[i]));
            i++;
        }
        blocks.push({ k: "p", r: parseInline(paragraph.join("\n")) });
    }

    return blocks;
}

function isParagraphLine(raw: string): boolean {
    const line = raw.trim();
    if (line.length === 0) { return false; }
    if (line.startsWith("```") || line.startsWith("~~~")) { return false; }
    if (isRule(line)) { return false; }
    if (line.startsWith(">")) { return false; }
    if (itemOf(line)) { return false; }
    if (line.startsWith("|")) { return false; }
    const hashes = countHashes(line);
    return !(hashes >= 1 && hashes <= 6 && line.length > hashes && line[hashes] === " ");
}

function countHashes(line: string): number {
    let n = 0;
    while (n < line.length && line[n] === "#") { n++; }
    return n;
}

function isRule(line: string): boolean {
    if (line.length < 3) { return false; }
    const first = line[0];
    if (first !== "-" && first !== "*" && first !== "_") { return false; }
    for (const ch of line) { if (ch !== first) { return false; } }
    return true;
}

/** 这一行是不是列表项（`- x`、`* x`、`1. x`、`1) x`）。 */
function itemOf(line: string): { ordered: boolean; marker: string; text: string } | undefined {
    if (line.length < 2) { return undefined; }

    const head = line[0];
    if (head === "-" || head === "*" || head === "+") {
        if (line[1] !== " ") { return undefined; }
        const text = line.slice(2).trim();
        return text.length > 0 ? { ordered: false, marker: "•", text } : undefined;
    }

    let digits = 0;
    while (digits < line.length && line[digits] >= "0" && line[digits] <= "9") { digits++; }
    if (digits === 0 || digits > 3 || digits + 1 >= line.length) { return undefined; }
    const sep = line[digits];
    if (sep !== "." && sep !== ")") { return undefined; }
    if (line[digits + 1] !== " ") { return undefined; }
    const text = line.slice(digits + 2).trim();
    return text.length > 0 ? { ordered: true, marker: line.slice(0, digits) + ".", text } : undefined;
}

function trimEnd(text: string): string {
    return text.replace(/\s+$/, "");
}

// ======================================================================
//  表格那些小东西
// ======================================================================

/** `|---|---:|:---:|` 这种分隔行：决定每一列对齐，也用它认出「这是表格」。 */
function isTableRule(raw: string): boolean {
    const cells = splitRow(raw.trim());
    if (cells.length === 0) { return false; }
    for (const cell of cells) {
        const text = cell.trim();
        if (text.length === 0) { return false; }
        const dashes = text.replace(/:/g, "");
        if (dashes.length === 0) { return false; }
        for (const ch of dashes) { if (ch !== "-") { return false; } }
    }
    return true;
}

/** 对齐：0 左 / 1 中 / 2 右（看分隔行那一格两头有没有冒号）。 */
function alignOf(cell: string): number {
    const text = cell.trim();
    const left = text.startsWith(":");
    const right = text.endsWith(":");
    if (left && right) { return 1; }
    return right ? 2 : 0;
}

/** 把一行竖线格切成几格（去掉两头的竖线，`\|` 当普通的竖线）。 */
function splitRow(raw: string): string[] {
    let line = raw.trim();
    if (line.startsWith("|")) { line = line.slice(1); }
    if (line.endsWith("|") && !line.endsWith("\\|")) { line = line.slice(0, -1); }
    const cells: string[] = [];
    let buffer = "";
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "\\" && line[i + 1] === "|") { buffer += "|"; i++; continue; }
        if (ch === "|") { cells.push(buffer.trim()); buffer = ""; continue; }
        buffer += ch;
    }
    cells.push(buffer.trim());
    return cells;
}

// ======================================================================
//  行内：`代码` **粗** *斜* ~~删掉~~ [链接](地址)
// ======================================================================

function parseInline(text: string): MdRun[] {
    const runs: MdRun[] = [];
    let buffer = "";

    const flush = () => {
        if (buffer.length === 0) { return; }
        runs.push({ v: buffer });
        buffer = "";
    };
    /** 加一段带样式的字：紧挨着上一段、样式一样就并进去（省点体积）。 */
    const push = (value: string, style: Partial<MdRun>) => {
        if (value.length === 0) { return; }
        flush();
        const last = runs[runs.length - 1];
        if (last
            && (last.b ?? 0) === (style.b ?? 0) && (last.i ?? 0) === (style.i ?? 0)
            && (last.s ?? 0) === (style.s ?? 0) && (last.c ?? 0) === (style.c ?? 0)
            && (last.l ?? 0) === (style.l ?? 0)) {
            last.v += value;
            return;
        }
        runs.push({ v: value, ...style });
    };

    let i = 0;
    while (i < text.length) {
        const ch = text[i];

        // 行内代码：`这样`
        if (ch === "`") {
            const end = text.indexOf("`", i + 1);
            if (end > i + 1) {
                push(text.slice(i + 1, end), { c: 1 });
                i = end + 1;
                continue;
            }
        }

        // 链接：[这几个字](这个地址) —— 只显示那几个字
        if (ch === "[") {
            const close = text.indexOf("]", i + 1);
            if (close > i + 1 && text[close + 1] === "(") {
                const end = text.indexOf(")", close + 2);
                if (end > close + 1) {
                    push(text.slice(i + 1, close), { l: 1 });
                    i = end + 1;
                    continue;
                }
            }
        }

        // 成对的记号：先试两个字的（** __ ~~），再试一个字的（* _）
        const strong = wrapAt(text, i, "**") ?? wrapAt(text, i, "__");
        if (strong !== undefined) {
            push(strong, { b: 1 });
            i += strong.length + 4;
            continue;
        }
        const struck = wrapAt(text, i, "~~");
        if (struck !== undefined) {
            push(struck, { s: 1 });
            i += struck.length + 4;
            continue;
        }
        const em = wrapAt(text, i, "*") ?? wrapAt(text, i, "_");
        if (em !== undefined) {
            push(em, { i: 1 });
            i += em.length + 2;
            continue;
        }

        buffer += ch;
        i++;
    }
    flush();
    return runs;
}

/**
 * 从 start 开始是不是夹着一对 marker（内容不能空、不能以空格开头或结尾：
 * 这样 `a * b`、`文件名_x` 这类就不会被当成强调）。不是就返回 undefined。
 */
function wrapAt(text: string, start: number, marker: string): string | undefined {
    const from = start + marker.length;
    if (from >= text.length) { return undefined; }
    if (!text.startsWith(marker, start)) { return undefined; }
    if (/\s/.test(text[from])) { return undefined; }
    const end = text.indexOf(marker, from);
    if (end <= from) { return undefined; }
    if (/\s/.test(text[end - 1])) { return undefined; }
    // 单字形的 *_ 不要在词中间动手（snake_case、2*3）
    if (marker.length === 1 && start > 0) {
        const before = text[start - 1];
        if (/[0-9A-Za-z_]/.test(before)) { return undefined; }
    }
    const inner = text.slice(from, end);
    if (marker.length === 2 && inner.includes(marker)) { return undefined; }
    return inner;
}

// ======================================================================
//  列表上那一行的一句话
// ======================================================================

/**
 * 「压成一句话」：去掉 markdown 的记号，只留头一行（代码块就写「代码」）。
 * 给手机上/桌面上那个会话列表用：一行放不下，多的话客户端自己截。
 */
function plainOf(text: string): string {
    const lines = text.replace(/\r/g, "").split("\n");
    for (const raw of lines) {
        const line = raw.trim();
        if (line.length === 0) { continue; }

        if (line.startsWith("```") || line.startsWith("~~~")) {
            const rest = line.slice(3).trim();
            return rest.length > 0 ? rest : "代码";
        }
        if (isTableRule(line)) { continue; }
        if (line.startsWith("|")) {
            // 表格就取第一格
            const cells = splitRow(line).filter((cell) => cell.length > 0);
            if (cells.length > 0) { return plainOfInline(cells[0]); }
            continue;
        }

        let rest = line;
        const hashes = countHashes(rest);
        if (hashes >= 1 && hashes <= 6) { rest = rest.slice(hashes).trim(); }
        if (rest.startsWith(">")) { rest = rest.slice(1).trim(); }
        const item = itemOf(rest);
        if (item) { rest = item.text; }
        return plainOfInline(rest);
    }
    return "";
}

/** 行内那一小段也去掉记号（`code` → code、**粗** → 粗、[字](地址) → 字）。 */
function plainOfInline(text: string): string {
    const runs = parseInline(text);
    return runs.map((run) => run.v).join("").trim();
}

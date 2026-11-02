// @ts-nocheck
/**
 * wordHighlight —— 验「改动」里点开的那份 diff 摆成两栏这件事（见 src/wordDiff.ts 与 media/chat.js 的 renderDiffPanes）：
 * 左「最近一次提交」右「现在」、各带行号、删的那几行与加的那几行对齐；变了的字涂深一层。
 *
 *   npm run web:shot -- --fake-pi --script dev/wordHighlight.js
 *
 * 「哪几个字变了」是把删的那几行与加的那几行配成对、一对一对按字比出来的（Google 的 diff-match-patch，
 * 照抄在 src/diffMatchPatch.js）：它不懂语法，但改一个标识符涂的就是那个标识符。
 *
 * 验三件事：
 *   1. 纯 Node，直接喂 out/server/wordDiff.js 几种 diff 文字：git 那种（`+` / `-` / ` ` 前缀）、
 *      pi 那种（前缀后面还带右对齐行号）、中文（一个汉字三个字节，区间不能按字节算到字中间去）、
 *      两段改动隔得远（中间得插一行「⋯」而不是把没变的那几十行全摆出来）、两边一样（不该有区间）。
 *      每种都钉住一条：**涂深前后那一行的文字一个字都不能变**（只许切、不许丢字重字），
 *      涂到的字里不能有空的，带行号那种不许把行号涂上；两栏的行号得对得上原文的行；
 *   2. 「配对」与「整行换掉不涂」：删三行加一行时挑最像的那一行配（另两行不涂）、
 *      整行都换掉的不涂（那种行了整行本来就是变了的，再涂一层只是一块色）；
 *   3. 真后端、真仓库、真界面：改一个 .py 的一行，点开「改动」里那份 diff：
 *      两栏对得齐（左边那一格与右边那一格同一行同高）、每栏带行号、
 *      被涂深的就是那几个变了的标识符（`numbers` → `values`、`s` → `total`），
 *      没改的那一行（`print(...)`）一个字都不涂。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { SCRATCH_DIR } = require("./harness.js");

const OUT = path.resolve(__dirname, "..", "out", "server");
const { changedCharRanges, diffRows } = require(path.join(OUT, "wordDiff.js"));
const { makeUnifiedDiff } = require(path.join(OUT, "messageUtils.js"));

/** 这一跑自己的干净工作目录（跟 dev/changesTab.js 一样：先提交一份当基线，会话起来以后再改）。 */
const WORK = path.join(SCRATCH_DIR, "wordWork");
const FILE = "示例.py";
const BASE = "def total(numbers):\n    s = sum(numbers)\n    return s / len(numbers)\n\nprint(total([1, 2, 3]))\n";
const AFTER = "def total(values):\n    total = sum(values)\n    return total / len(values)\n\nprint(total([1, 2, 3]))\n";

let failures = 0;

function check(label, ok, detail) {
    console.log((ok ? "  ✓ " : "  ✗ ") + label + (detail === undefined ? "" : "：" + detail));
    if (!ok) { failures++; }
}

/** 按给定的区间把一行切开，把涂深的那几段括起来（只用来看看它对不对）。 */
function markRanges(line, ranges) {
    let out = "";
    let at = 0;
    for (const [start, end] of ranges || []) {
        out += line.slice(at, start) + "[" + line.slice(start, end) + "]";
        at = end;
    }
    return out + line.slice(at);
}

/**
 * 一份 diff 的通用检查：区间不越界、不空、涂完文字一个字不变、顺序是从左到右。
 * 返回每一行涂到的字（按区间切出来，不从文字里猜括号：代码里本来就有一堆 `[` `]`）。
 */
function checkRanges(name, diffText, lines) {
    const raw = diffText.split("\n");
    let paintedCount = 0;
    const paintedPerLine = raw.map(() => []);
    raw.forEach((line, i) => {
        const ranges = lines[i];
        if (!ranges) { return; }
        let last = 0;
        for (const [start, end] of ranges) {
            if (!(start >= last) || !(end > start) || end > line.length) {
                check(name + "：区间越界或反过来（第 " + (i + 1) + " 行）", false, JSON.stringify({ line, ranges }));
                continue;
            }
            last = end;
            paintedCount++;
        }
        const words = (ranges || []).map(([start, end]) => line.slice(start, end));
        paintedPerLine[i] = words;
        if (words.some((text) => text === "")) {
            check(name + "：涂到了空的一段（第 " + (i + 1) + " 行）", false, JSON.stringify(ranges));
        }
        if (markRanges(line, ranges).replace(/[[\]]/g, "") !== line) {
            check(name + "：涂完这一行的文字变了（第 " + (i + 1) + " 行）", false, JSON.stringify(ranges));
        }
    });
    return { paintedCount, marked: raw.map((line, i) => markRanges(line, lines[i])), paintedPerLine };
}

module.exports = async (page) => {
    // ---------------- 1. 纯 Node：几种 diff 文字 ----------------
    console.log("\n【1】纯 Node：diff 拆行 + 变了的字");
    const gitStyle = makeUnifiedDiff(BASE, AFTER);
    const gitRows = diffRows(gitStyle);
    const dels = gitRows.filter((r) => r.kind === "del");
    const adds = gitRows.filter((r) => r.kind === "add");
    check("git 那种：删的那三行在「之前」那份里是 1、2、3 行",
        JSON.stringify(dels.map((r) => r.before)) === "[1,2,3]", JSON.stringify(dels.map((r) => r.before)));
    check("git 那种：加的那三行在「之后」那份里是 1、2、3 行",
        JSON.stringify(adds.map((r) => r.after)) === "[1,2,3]", JSON.stringify(adds.map((r) => r.after)));
    check("git 那种：没变的行两边行号一样（print 那一行两边都是第 5 行）",
        gitRows.filter((r) => r.kind === "ctx").every((r) => r.before === r.after)
        && gitRows.filter((r) => r.kind === "ctx").some((r) => r.before === 5 && r.text.startsWith("print(")),
        JSON.stringify(gitRows.filter((r) => r.kind === "ctx").map((r) => [r.before, r.after])));

    // 两段改动隔得远：中间得是一行「⋯」，不能把没变的那几十行全摆出来
    const long = [];
    for (let i = 0; i < 40; i++) { long.push("第 " + i + " 行"); }
    const longAfter = long.slice();
    longAfter[1] = "改了甲";
    longAfter[38] = "改了乙";
    const farRows = diffRows(makeUnifiedDiff(long.join("\n") + "\n", longAfter.join("\n") + "\n"));
    check("两段改动隔得远：中间只有一行「⋯」（不是把没变的那几十行都摆出来）",
        farRows.filter((r) => r.kind === "gap").length === 1,
        JSON.stringify(farRows.map((r) => r.kind)));
    check("两段改动隔得远：第二段的行号接着原文走（第二段之前那份里是第 39 行）",
        farRows.filter((r) => r.kind === "del").map((r) => r.before).join(",") === "2,39",
        JSON.stringify(farRows.filter((r) => r.kind === "del").map((r) => r.before)));

    // pi 那种：前缀 + 右对齐行号 + 空格 + 原文（没有 `@@` 段头，行号得从行里取）
    const numbered = [
        "  1 def total(numbers):",
        "- 2     s = sum(numbers)",
        "- 3     return s / len(numbers)",
        "- 4 ",
        "+ 2     total = sum(values)",
        "+ 3     return total / len(values)",
        "+ 4 ",
        "  5 print(total([1, 2, 3]))",
    ].join("\n");
    const piRows = diffRows(numbered);
    check("pi 那种（带行号）：删的是原第 2、3、4 行，加的是第 2、3、4 行",
        piRows.filter((r) => r.kind === "del").map((r) => r.before).join(",") === "2,3,4"
        && piRows.filter((r) => r.kind === "add").map((r) => r.after).join(",") === "2,3,4",
        JSON.stringify({ 删: piRows.filter((r) => r.kind === "del").map((r) => r.before),
            加: piRows.filter((r) => r.kind === "add").map((r) => r.after) }));
    check("pi 那种（带行号）：行号没混进正文（原文就是原文）",
        piRows.filter((r) => r.kind === "del")[0].text === "    s = sum(numbers)",
        JSON.stringify(piRows.filter((r) => r.kind === "del").map((r) => r.text)));

    const gitLines = changedCharRanges(gitStyle);
    const git = checkRanges("git 那种", gitStyle, gitLines);
    console.log(git.marked.join("\n"));
    check("git 那种：涂深了（改一个标识符，涂的是那几个字，不是整行）", git.paintedCount > 0, git.paintedCount + " 段");
    const gitRaw = gitStyle.split("\n");
    const gitWords = (prefix) => git.paintedPerLine
        .filter((words, i) => gitRaw[i].startsWith(prefix) && words.length > 0)
        .flat();
    check("git 那种：删的那几行涂到 numbers、加的那几行涂到 values（是整个词，不是半个）",
        gitWords("-").includes("numbers") && gitWords("+").includes("values"),
        JSON.stringify({ 删: gitWords("-"), 加: gitWords("+") }));
    check("git 那种：没改的那一行（print 那一行）一个字都不涂",
        gitWords(" ").length === 0, JSON.stringify(gitWords(" ")));

    const numberedLines = changedCharRanges(numbered);
    const pi = checkRanges("pi 那种（带行号）", numbered, numberedLines);
    console.log(pi.marked.join("\n"));
    const prefixLength = (line) => (/^[+\- ] *\d+ /.exec(line) || [""])[0].length;
    const offByPrefix = numbered.split("\n")
        .some((line, i) => (numberedLines[i] || []).some(([start]) => start < prefixLength(line)));
    check("pi 那种：涂到的字全在原文里（没把行号、前缀涂上）",
        pi.paintedCount > 0 && !offByPrefix,
        JSON.stringify({ 涂到: pi.paintedPerLine.filter((w) => w.length > 0) }));

    // 中文：一个汉字三个字节；区间要是按字节算，切出来就会是半个字或者空
    const cnDiff = makeUnifiedDiff("第一行：支持手动查询当前排行榜\n第二行：随便\n", "第一行：支持手动查询当前榜单\n第二行：随便\n");
    const cnLines = changedCharRanges(cnDiff);
    const cn = checkRanges("中文", cnDiff, cnLines);
    console.log(cn.marked.join("\n"));
    const cnPainted = cn.paintedPerLine.flat();
    check("中文：涂到的是完整的字（汉字三个字节，不算到字中间去）",
        cnPainted.length > 0 && cnPainted.every((w) => Array.from(w).every((ch) => ch.charCodeAt(0) > 0x2e80)),
        JSON.stringify(cnPainted));

    check("两边一样：没有区间（页面什么都不涂）",
        changedCharRanges(makeUnifiedDiff(BASE, BASE)) === undefined);

    // ---------------- 2. 配对与「整行换掉」 ----------------
    console.log("\n【2】删几行加几行时怎么配对");
    const pairDiff = makeUnifiedDiff("a = 1\nb = 2\nc = 3\nd = 4\n", "a = 1\nbbb = 22\n");
    const pairLines = changedCharRanges(pairDiff);
    const pairMarked = pairDiff.split("\n").map((line, i) => markRanges(line, pairLines && pairLines[i]));
    console.log(pairMarked.join("\n"));
    // 最像的一对是「b = 2」与「bbb = 22」：加的那一边涂 bbb / 22，删的那一边一个字都没删
    // （所以它不涂）。要是配到了 c = 3 那两行，删的那一边就会涂上 c / 3。
    const markedDel = pairMarked.filter((line) => line.startsWith("-") && line.indexOf("[") >= 0);
    const markedAdd = pairMarked.filter((line) => line.startsWith("+") && line.indexOf("[") >= 0);
    check("删三行加一行：配到的是最像的那一对（加的那行涂了，另两行删的不涂）",
        markedAdd.length === 1 && markedDel.length === 0, JSON.stringify(pairMarked));
    check("整行都换掉的不涂（那一行本来就是变了的，涂出来只是一块色）",
        changedCharRanges(makeUnifiedDiff("x = 111\n", "qwerty = 999\n")) === undefined,
        String(changedCharRanges(makeUnifiedDiff("x = 111\n", "qwerty = 999\n"))));

    // ---------------- 3. 真页面：点开「改动」里那份 diff ----------------
    console.log("\n【3】真页面：「改动」那一格里点开一份 .py 的 diff");
    await page.waitReady();
    await page.sleep(600);
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(path.join(WORK, FILE), BASE, "utf8");
    const runGit = (...args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: WORK, stdio: "ignore" });
    runGit("init", "-q", ".");
    runGit("add", "-A");
    runGit("-c", "user.email=dev@example.invalid", "-c", "user.name=dev", "commit", "-qm", "基线");
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "newSessionInWorkspace", path: ${JSON.stringify(WORK)} });
        return true;
    `);
    await page.sleep(2500);
    // 会话起来以后再改：这一行就成了「最近一次提交 → 现在」的改动
    fs.writeFileSync(path.join(WORK, FILE), AFTER, "utf8");
    const opened = await page.eval(`return document.body.classList.contains("file-open");`);
    if (!opened) {
        await page.click("#fileSidebarBtn");
        await page.sleep(600);
    }
    // 收起再打开 = 让它把「改动」清单再问一遍
    await page.click("#fileClose");
    await page.sleep(300);
    await page.click("#fileSidebarBtn");
    await page.sleep(900);
    const clicked = await page.eval(`
        const row = Array.from(document.querySelectorAll("#changePane .change-head"))
            .find(function (el) { return el.getAttribute("data-path") === ${JSON.stringify(FILE)}; });
        if (!row) { return "清单里没有这一行"; }
        (row.querySelector(".change-path") || row).click();
        return "点了";
    `);
    check("「改动」那一格里有这个文件，点得开", clicked === "点了", clicked);
    await page.sleep(1800);
    const shown = JSON.parse(await page.eval(`
        const pane = document.querySelector("#fileBody .file-page.active");
        const cells = pane ? Array.from(pane.querySelectorAll(".diff2-cell")) : [];
        const real = cells.filter((el) => !el.classList.contains("empty"));
        const text = (el) => ((el.querySelector(".file-text") || {}).textContent || "");
        const num = (el) => ((el.querySelector(".file-num") || {}).textContent || "");
        let worst = 0;
        for (let i = 0; i + 1 < cells.length; i += 2) {
            const a = cells[i].getBoundingClientRect();
            const b = cells[i + 1].getBoundingClientRect();
            worst = Math.max(worst, Math.abs(a.top - b.top), Math.abs(a.height - b.height));
        }
        return JSON.stringify({
            cells: cells.length,
            empty: cells.length - real.length,
            added: real.filter((el) => el.classList.contains("add")).length,
            removed: real.filter((el) => el.classList.contains("del")).length,
            painted: cells.map((el) => Array.from(el.querySelectorAll(".diff-hl")).map((hl) => hl.textContent)),
            texts: cells.map(text),
            nums: cells.map(num),
            rowGap: Math.round(worst * 100) / 100,
        });
    `));
    await page.shot("word-highlight-1.png");
    console.log("两栏：" + JSON.stringify({ 格: shown.cells, 空位: shown.empty, 加: shown.added, 删: shown.removed,
        行号: shown.nums, 行差: shown.rowGap }));
    check("摆成两栏：左边一列、右边一列（格子数是偶数）", shown.cells > 0 && shown.cells % 2 === 0, shown.cells + " 格");
    check("两栏对齐：左边那一格与右边那一格同一行、同高", shown.rowGap === 0, shown.rowGap + " 像素");
    check("每栏带行号：两边都是从第 1 行数下来",
        shown.nums.filter((n) => n !== "").join(",") === "1,1,2,2,3,3,4,4,5,5",
        shown.nums.join(","));
    check("三行删、三行加", shown.removed === 3 && shown.added === 3,
        JSON.stringify({ 加: shown.added, 删: shown.removed }));
    const paintedWords = new Set(shown.painted.flat());
    check("页面上真涂深了那几个字", paintedWords.size > 0, JSON.stringify([...paintedWords]));
    check("删的那一边涂到 numbers、加的那一边涂到 values（整个词）",
        paintedWords.has("numbers") && paintedWords.has("values"),
        JSON.stringify([...paintedWords]));
    const printAt = shown.texts.findIndex((t) => t.startsWith("print("));
    check("没改的那一行（print 那一行）一个字都不涂",
        printAt >= 0 && shown.painted[printAt].length === 0
        && shown.painted[printAt + 1].length === 0,
        JSON.stringify(shown.painted.slice(Math.max(0, printAt), printAt + 2)));

    console.log("");
    console.log(failures === 0 ? "「改动」里那份 diff：都对上了。" : "「改动」里那份 diff：有 " + failures + " 条不对。");
    if (failures > 0) { throw new Error("有 " + failures + " 条不对（见上面那些 ✗）"); }
};

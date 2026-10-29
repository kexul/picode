// @ts-nocheck
/**
 * diffCheck —— 验「改动」那一格背后那个逐行比较（`makeUnifiedDiff` / `diffCounts`，见 src/messageUtils.ts）。
 *
 *   node dev/diffCheck.js
 *
 * 纯 Node，不开浏览器（跟 dev/childSessions.js 一类）。三件事：
 *   1. 改了两处、中间隔几千行没动：增删行数要跟真改的那么多，不能把中间那几千行报成“全换掉了”
 *      （行数一多，逐行比较的表格放不下，以前一放不下就整段报成换掉：改 21 行报成四千行）；
 *   2. 两处改动挨得近（中间隔 4—6 行）时切出来的两段不能叠在一起（叠了那几行会画两遍、行号往回跳）；
 *   3. 不管哪种情况，按上那段 diff 都能把两份原文一行不差地拼回来。
 */
const fs = require("fs");
const path = require("path");

const OUT = path.resolve(__dirname, "..", "out", "server", "messageUtils.js");
if (!fs.existsSync(OUT)) {
    console.error("还没编译：找不到 out/server/messageUtils.js。先跑 npm run compile（或 npm run web:dev，它会自己编译）。");
    process.exit(1);
}
const { makeUnifiedDiff, diffCounts } = require(OUT);

let bad = 0;
function check(name, ok, extra) {
    console.log("  " + (ok ? "✓" : "✗") + " " + name + (extra === undefined ? "" : "：" + extra));
    if (!ok) { bad++; }
}

/** 按 hunk 头把 diff 拿去走一遍原文：每一行的文字都得跟原文那一行对上，最后两边的行数都得走了个完。 */
function walk(name, before, after) {
    const a = before.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    const b = after.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    const diff = makeUnifiedDiff(before, after);
    let ai = 0;
    let bi = 0;
    let prevEndA = 0;
    let overlap = false;
    for (const line of diff.split("\n")) {
        if (!line) { continue; }
        if (line.startsWith("@@")) {
            const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
            const aStart = Number(m[1]) - 1;
            const bStart = Number(m[3]) - 1;
            if (aStart < prevEndA) { overlap = true; }
            prevEndA = aStart + Number(m[2] === undefined ? 1 : m[2]);
            while (ai < aStart) { ai++; }
            while (bi < bStart) { bi++; }
            continue;
        }
        const op = line[0];
        const text = line.slice(1);
        if (op === " " || op === "-") {
            if (a[ai] !== text) { check(name + "：diff 里这一行对不上原文", false, JSON.stringify([text, a[ai]])); return diff; }
            ai++;
        }
        if (op === " " || op === "+") { bi++; }
    }
    const ok = bi === b.length || b.length === 0;
    // 最后那段没画出来的尾巴（上下文之外没变的地方）：两边得一模一样
    const tailOk = a.slice(ai).join("\n") === b.slice(bi).join("\n");
    check(name + "：拼得回原文", tailOk, `diff 里走了 A ${ai}/${a.length}、B ${bi}/${b.length}，尾巴两边一致 ${tailOk}`);
    check(name + "：切出来的段不叠", !overlap);
    return diff;
}

const lines = [];
for (let i = 0; i < 6000; i++) { lines.push("第 " + i + " 行：随便写点什么，让每一行都不一样"); }
const base = lines.join("\n");

console.log("① 改了两处、中间隔几千行没动（以前会报成四千多行）");
{
    const after = lines.slice();
    after[500] = "这里改了";
    after[5500] = "那里也改了";
    const t = Date.now();
    const diff = walk("6000 行、两处相隔 5000 行", base, after.join("\n"));
    const got = diffCounts(diff);
    check("增删行数就是真改的那两行", got.added === 2 && got.removed === 2, JSON.stringify(got));
    const ms = Date.now() - t;
    check("算一趟不到 1 秒", ms < 1000, ms + " 毫秒");
}

console.log("② 两处改动挨得近（中间隔 1—8 行）");
{
    for (const gap of [1, 4, 5, 6, 7, 8]) {
        const text = lines.slice(0, 40).join("\n");
        const after = lines.slice(0, 40);
        after[5] = "这里改了";
        after[6 + gap] = "那里也改了";
        const diff = walk("隔 " + gap + " 行", text, after.join("\n"));
        const heads = diff.split("\n").filter((l) => l.startsWith("@@"));
        check("隔 " + gap + " 行：增删各两行", JSON.stringify(diffCounts(diff)) === '{"added":2,"removed":2}', heads.join(" | "));
    }
}

console.log("③ 没有改动 / 整份重写 / 末尾换行");
{
    check("一模一样时 diff 是空的", makeUnifiedDiff(base, base) === "");
    check("只差末尾那个换行也算一样", makeUnifiedDiff(base + "\n", base) === "");
    const X = [];
    const Y = [];
    for (let i = 0; i < 3000; i++) { X.push("旧 " + i); Y.push("新 " + i); }
    const got = diffCounts(makeUnifiedDiff(X.join("\n"), Y.join("\n")));
    check("整份重写：两边各 3000 行", got.added === 3000 && got.removed === 3000, JSON.stringify(got));
}

console.log("");
if (bad) {
    console.log("逐行比较：有 " + bad + " 条不对。");
    process.exit(1);
}
console.log("逐行比较：都对上了。");

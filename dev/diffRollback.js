// @ts-nocheck
/**
 * diffRollback —— 验「打开一份 diff 时横条上那颗『回滚』」。
 *
 *   npm run web:shot -- --fake-pi --script dev/diffRollback.js
 *
 * 真后端、真会话、真网页服务、真界面文件，只有模型是假的（假模型那一套老剧本里
 * 第 4 步会真去改 说明.md；说「写新文件」时它会真建一个 新文件.md）。
 * 那颗回滚撤的是：这个文件回到它最近一次提交的样子（`git checkout HEAD -- 那个文件`，
 * 见 src/gitChanges.ts）—— 也就是那份 diff 左边那一份。
 *
 * 验的是外面看得见的行为：
 *   1. 打开一份 diff，横条上有那颗「回滚」（看普通文件时没有，看 diff 时折行开关照旧藏着）；
 *   2. 点第一下只是把按钮变成「确定回滚」（磁盘上一个字都不动；关掉弹窗再打开又回到「回滚」）；
 *   3. 点第二下才真撤：磁盘上那个文件回到最近一次提交，清单里那一行消失、那份 diff 自己关掉，
 *      消息流里多一句「已回滚」；
 *   4. 提交里没有的文件（write 新建、还没提交）：回滚就是把它删掉；
 *   5. 会话里被删掉的文件：点开那份 diff（整份都是删掉的）也能回滚，文件照最近一次提交写回来。
 *
 * 造的话说在前头：脚本自己动 dev/.scratch 里的文件（那个目录不进版本库，随便造）。
 */
const fs = require("fs");
const path = require("path");
const { SCRATCH_DIR } = require("./harness.js");

/** 这一跑自己的干净工作目录：铺好的这一份提交上去，那份 diff 就拿它当左边。 */
const WORK = path.join(SCRATCH_DIR, "diffRollbackWork");
/** 假模型那一套老剧本改的就是这个文件（见 dev/fakePi.js）。 */
const SCRIPT_FILE = "说明.md";
/** 说「写新文件」时假模型建的那个（见 dev/fakePi.js）。 */
const NEW_FILE = "新文件.md";
/** 说明.md 开局的样子。 */
const SCRIPT_BASE = "这是 Pi Chat 插件的调试用工作目录（dev/.scratch）。\n"
    + "调试时起的会话就跑在这里，随便改，它不进版本库，也不会碰到插件自己的代码。\n";

let failures = 0;

/** 把这一份铺好的东西提交上去（那就是“最近一次提交”）。 */
function initRepo(dir) {
    const git = (...args) => require("child_process").execFileSync("git",
        ["-c", "core.autocrlf=false", ...args], { cwd: dir, stdio: "ignore" });
    git("init", "-q", ".");
    git("add", "-A");
    git("-c", "user.email=dev@example.invalid", "-c", "user.name=dev", "commit", "-qm", "基线");
}

function check(label, ok, detail) {
    console.log((ok ? "  ✓ " : "  ✗ ") + label + (detail === undefined ? "" : "：" + detail));
    if (!ok) { failures++; }
}

/** 把 WORK 里那个文件读出来（读不到给 undefined）。 */
function disk(name) {
    try { return fs.readFileSync(path.join(WORK, name), "utf8"); } catch (e) { return undefined; }
}

/** 发一条消息给假模型，等它演完。 */
async function runScript(page, said, done) {
    await page.send(said);
    await page.waitAnswer(done);
    await page.sleep(900);
}

/** 「改动」那一格里现在列着哪几个文件（相对写法 + 右边那几个数）。
 *  假 pi 把它的会话文件也写在会话目录里（真 pi 不会），那一份不算“这个会话改的文件”，跳过。 */
function rowsNow(page) {
    return page.eval(`
        const pane = document.getElementById("changePane");
        if (!pane) { return "[]"; }
        const rows = Array.from(pane.querySelectorAll(".change-head"))
            .filter(function (el) { return !/^fake-session-.*\\.jsonl$/.test(el.getAttribute("data-path") || ""); });
        return JSON.stringify(rows.map((el) => ({
            path: el.getAttribute("data-path"),
            counts: ((el.querySelector(".change-counts") || {}).textContent || "").trim(),
        })));
    `);
}

/** 弹窗那一块现在长什么样：横条写着谁、那颗「回滚」露没露、正文里那份 diff 有几行。 */
function viewerNow(page) {
    return page.eval(`
        const shown = function (el) {
            return !!el && getComputedStyle(el).display !== "none";
        };
        const body = document.getElementById("fileBody");
        const barName = document.querySelector("#fileBar .file-bar-name");
        const rollback = document.getElementById("fileRollback");
        const pane = body ? body.querySelector(".file-page.active") : null;
        // 一份 diff 现在是两栏（见 chat.js 的 renderDiffPanes）：空位那一格不算增删行
        const lines = pane ? Array.from(pane.querySelectorAll(".diff2-cell")).filter((el) => !el.classList.contains("empty")) : [];
        return JSON.stringify({
            fileView: document.body.classList.contains("file-view"),
            stageShown: shown(document.getElementById("fileStage")),
            barName: barName ? (barName.textContent || "") : "",
            rollbackShown: shown(rollback),
            rollbackText: rollback ? (rollback.textContent || "").trim() : "",
            rollbackTitle: rollback ? (rollback.getAttribute("title") || "") : "",
            hasWrap: !!document.getElementById("fileWrap"),
            lines: lines.length,
            added: lines.filter((el) => el.classList.contains("add")).length,
            removed: lines.filter((el) => el.classList.contains("del")).length,
        });
    `);
}

/** 消息流里最后几条系统消息（「已回滚」那一类就写在里面）。 */
function lastSystem(page) {
    return page.eval(`
        const list = Array.from(document.querySelectorAll(".msg.system"));
        return list.length ? (list[list.length - 1].innerText || "").trim() : "";
    `);
}

/** 等一个想看到的样子（清单、diff、确认卡片都是异步来的）。 */
async function waitFor(page, what, read, cond, timeoutMs) {
    const limit = timeoutMs || 10000;
    const started = Date.now();
    let got = {};
    while (Date.now() - started < limit) {
        got = JSON.parse(await read(page));
        if (cond(got)) { return got; }
        await page.sleep(250);
    }
    console.log("（等超时：" + what + "，现在这样：" + JSON.stringify(got) + "）");
    return got;
}

/** 这一列没开着就点开（开着的时候再点会收起，所以先看一眼）。 */
async function ensureOpen(page) {
    const open = await page.eval(`return document.body.classList.contains("file-open");`);
    if (!open) {
        await page.click("#fileSidebarBtn");
        await page.sleep(600);
    }
}

/** 收起再打开：等于让它把「改动」清单再问一遍（后端只在这时候才重新取）。 */
async function reopenSidebar(page) {
    await page.click("#fileClose");
    await page.sleep(300);
    await page.click("#fileSidebarBtn");
    await page.sleep(900);
}

/** 点「改动」清单里某个文件那一行。 */
function clickRow(page, file) {
    return page.eval(`
        const row = Array.from(document.querySelectorAll("#changePane .change-head"))
            .find(function (el) { return el.getAttribute("data-path") === ${JSON.stringify(file)}; });
        if (!row) { return "清单里没有这一行"; }
        const path = row.querySelector(".change-path") || row;
        path.click();
        return "点了";
    `);
}

/** 横条上那颗「回滚」现在写着什么（点第一下之后应该变成「确定回滚」）。 */
function rollbackLabel(page) {
    return page.eval(`
        const btn = document.getElementById("fileRollback");
        if (!btn) { return "{}"; }
        return JSON.stringify({
            text: (btn.textContent || "").trim(),
            armed: btn.classList.contains("armed"),
            hidden: !!btn.hidden || getComputedStyle(btn).display === "none",
        });
    `);
}

module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(600);

    // 这一跑开一个自己的干净工作目录：先铺好文件、提交上去，再起会话（那份 diff 的左边就是提交那一份）
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(path.join(WORK, SCRIPT_FILE), SCRIPT_BASE, "utf8");
    fs.writeFileSync(path.join(WORK, ".gitignore"), "fake-session-*.jsonl\n", "utf8");
    initRepo(WORK);
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "newSessionInWorkspace", path: ${JSON.stringify(WORK)} });
        return true;
    `);
    await page.sleep(2500);
    await ensureOpen(page);

    // ---- 1. 让假模型改一下 说明.md ----
    await runScript(page, "演示一下", "完事。");
    let rows = await waitFor(page, "清单里长出 说明.md", rowsNow, (x) => x.some((one) => one.path === SCRIPT_FILE));
    check("假模型改完，清单里有 说明.md", rows.some((one) => one.path === SCRIPT_FILE), JSON.stringify(rows));
    check("磁盘上真改了", String(disk(SCRIPT_FILE)).indexOf("假模型改的") >= 0);

    // ---- 2. 点开那份 diff：横条上那颗「回滚」在 ----
    console.log("点那一行：" + await clickRow(page, SCRIPT_FILE));
    const diff = await waitFor(page, "diff 打开", viewerNow, (x) => x.fileView && x.lines > 0);
    console.log("打开之后：" + JSON.stringify(diff));
    check("点那一行：那份 diff 打开了", diff.fileView && diff.stageShown && diff.barName === SCRIPT_FILE, diff.barName);
    check("看 diff 时横条上有那颗「回滚」", diff.rollbackShown);
    check("悬停提示写着回滚撤的是什么（回到最近一次提交）",
        diff.rollbackTitle.indexOf("回到最近一次提交") >= 0, diff.rollbackTitle);
    check("折行开关已经拿掉了（看 diff 时也没有）", !diff.hasWrap);
    await page.shot("rollback-1-diff.png");

    // ---- 3. 点回滚：第一下只是把按钮变成「确定回滚」，第二下才真撤 ----
    await page.click("#fileRollback");
    await page.sleep(300);
    const armed = JSON.parse(await rollbackLabel(page));
    console.log("点第一下之后那颗按钮：" + JSON.stringify(armed));
    check("点第一下：按钮变成「确定回滚」、带上告警色", armed.text === "确定回滚" && armed.armed, armed.text);
    check("点第一下：磁盘上一个字都没动", String(disk(SCRIPT_FILE)).indexOf("假模型改的") >= 0);
    await page.shot("rollback-2-armed.png");

    // 关掉弹窗再点开同一份 diff：上一没点完的那一下作废（按钮回到「回滚」）
    await page.click("#fileCloseFile");
    await page.sleep(600);
    console.log("点那一行：" + await clickRow(page, SCRIPT_FILE));
    await waitFor(page, "diff 又打开了", viewerNow, (x) => x.fileView && x.lines > 0);
    const rearmed = JSON.parse(await rollbackLabel(page));
    check("关掉弹窗再打开：按钮回到「回滚」（上一下没点完的作废）",
        rearmed.text === "回滚" && !rearmed.armed, rearmed.text);

    // ---- 4. 点两下：文件回到最近一次提交 ----
    await page.click("#fileRollback");
    await page.sleep(200);
    await page.click("#fileRollback");
    const started = Date.now();
    while (Date.now() - started < 10000 && String(disk(SCRIPT_FILE)) !== SCRIPT_BASE) { await page.sleep(250); }
    check("点第二下：磁盘上的文件回到最近一次提交", disk(SCRIPT_FILE) === SCRIPT_BASE,
        JSON.stringify(disk(SCRIPT_FILE)));
    rows = await waitFor(page, "清单里那一行消失", rowsNow, (x) => !x.some((one) => one.path === SCRIPT_FILE));
    check("回滚之后清单里那一行消失", !rows.some((one) => one.path === SCRIPT_FILE), JSON.stringify(rows));
    const closed = await waitFor(page, "那份 diff 自己关掉", viewerNow, (x) => !x.fileView);
    check("回滚之后那份 diff 自己关掉（内容已经不在清单里了）", !closed.fileView && !closed.stageShown,
        JSON.stringify({ view: closed.fileView, stage: closed.stageShown }));
    const msg = await lastSystem(page);
    check("消息流里多一句「已回滚」", msg.indexOf("已回滚") >= 0 && msg.indexOf(SCRIPT_FILE) >= 0, msg);
    await page.shot("rollback-3-done.png");

    // ---- 5. 提交里没有的文件（会话里新建的）：回滚就是把它删掉 ----
    await runScript(page, "写新文件", "写完了。");
    rows = await waitFor(page, "新文件进清单", rowsNow, (x) => x.some((one) => one.path === NEW_FILE));
    check("新建的文件进清单了", rows.some((one) => one.path === NEW_FILE), JSON.stringify(rows));
    check("磁盘上真建出来了", disk(NEW_FILE) !== undefined);
    console.log("点那一行：" + await clickRow(page, NEW_FILE));
    const newDiff = await waitFor(page, "新文件那份 diff 打开", viewerNow,
        (x) => x.fileView && x.barName === NEW_FILE && x.lines > 0);
    check("新文件那份 diff 打开了，三行都是新加的", newDiff.added === 3 && newDiff.removed === 0,
        JSON.stringify({ added: newDiff.added, removed: newDiff.removed }));
    await page.click("#fileRollback");
    await page.sleep(200);
    await page.click("#fileRollback");
    const goneBy = Date.now();
    while (Date.now() - goneBy < 8000 && disk(NEW_FILE) !== undefined) { await page.sleep(250); }
    check("回滚新文件：磁盘上那个文件没了", disk(NEW_FILE) === undefined);
    rows = await waitFor(page, "新文件那一行消失", rowsNow, (x) => !x.some((one) => one.path === NEW_FILE));
    check("回滚之后清单里也没有它了", !rows.some((one) => one.path === NEW_FILE), JSON.stringify(rows));

    // ---- 6. 会话里被删掉的文件：也能回滚（照最近一次提交写回来）----
    fs.rmSync(path.join(WORK, SCRIPT_FILE), { force: true });
    await reopenSidebar(page);
    rows = await waitFor(page, "删掉文件之后清单刷新", rowsNow,
        (x) => x.some((one) => one.path === SCRIPT_FILE && one.counts.indexOf("已删除") >= 0));
    check("磁盘上删了之后那一行标着「已删除」",
        rows.some((one) => one.path === SCRIPT_FILE && one.counts.indexOf("已删除") >= 0), JSON.stringify(rows));
    console.log("点那一行：" + await clickRow(page, SCRIPT_FILE));
    const goneDiff = await waitFor(page, "删掉的那份 diff 打开", viewerNow,
        (x) => x.fileView && x.barName === SCRIPT_FILE && x.lines > 0);
    check("删掉的文件那份 diff 整份都是删掉的", goneDiff.removed > 0 && goneDiff.added === 0,
        JSON.stringify({ added: goneDiff.added, removed: goneDiff.removed }));
    check("删掉的那份 diff 上也有那颗「回滚」", goneDiff.rollbackShown);
    await page.click("#fileRollback");
    await page.sleep(200);
    await page.click("#fileRollback");
    const backBy = Date.now();
    while (Date.now() - backBy < 10000 && disk(SCRIPT_FILE) !== SCRIPT_BASE) { await page.sleep(250); }
    check("回滚删掉的文件：照最近一次提交写回来了", disk(SCRIPT_FILE) === SCRIPT_BASE, JSON.stringify(disk(SCRIPT_FILE)));
    rows = await waitFor(page, "写回来之后那一行消失", rowsNow, (x) => !x.some((one) => one.path === SCRIPT_FILE));
    check("写回来之后清单里那一行消失", !rows.some((one) => one.path === SCRIPT_FILE), JSON.stringify(rows));
    await page.shot("rollback-4-restored.png");

    // ---- 7. 看普通文件时没有这颗按钮 ----
    await reopenSidebar(page);
    const plainPath = await page.eval(`
        const row = Array.from(document.querySelectorAll("#dirPane .file-entry"))
            .find(function (el) { return !el.classList.contains("dir"); });
        if (!row) { return ""; }
        row.click();
        return row.getAttribute("data-path") || "";
    `);
    console.log("点文件那一格里的一个文件：" + plainPath);
    const plain = await waitFor(page, "普通文件打开", viewerNow,
        (x) => x.fileView && plainPath && x.barName === plainPath);
    check("看一个普通文件时横条上没有那颗「回滚」", !plain.rollbackShown, JSON.stringify(plain));
    await page.shot("rollback-5-plain-file.png");

    console.log("");
    console.log(failures === 0 ? "diff 横条上那颗回滚：都对上了。" : "diff 横条上那颗回滚：有 " + failures + " 条不对。");
    if (failures > 0) { throw new Error("有 " + failures + " 条不对（见上面那些 ✗）"); }
};

// @ts-nocheck
/**
 * changesTab —— 验文件侧边栏那一格「改动」（这个会话目录和它最后一次提交差了什么）。
 *
 *   npm run web:shot -- --fake-pi --script dev/changesTab.js
 *
 * 真后端、真会话、真网页服务、真界面文件，只有模型是假的（假模型那一套老剧本里
 * 第 4 步会真去改这个工作目录里的 说明.md，后端因此重问一次清单）。
 * 这一格现在直接问会话目录所在的 git 仓库（见 src/gitChanges.ts）：口径是
 * 「最近一次提交 → 现在磁盘上的样子」。所以这一跑先搭一个小仓库、把铺好的文件提交上去，
 * 那就是“基线”（会话开始之前就有的未提交改动也会算进来，这一跑里没造那种东西）。
 *
 * 验的是外面看得见的行为：
 *   1. 最上面一行是标题行（写着「文件与改动」，右端是文件搜索那颗放大镜和收起那颗叉），
 *      底下上下两格同时露着：上格「文件」（只有目录清单）、下格「改动」；各滚各的，
 *      下格按内容占高、最多占这一列的 45%；标签条那一套（#fileTabs / .file-tab）整个没了；
 *   2. 跟最后一次提交一样时，「改动」那一格里只有一句「跟最后一次提交一样，没有改动。」；
 *   3. 假模型改完 说明.md 之后（后端推了一条“改动变了”），这一格自己长出那一行：
 *      相对写法、+1 −1，行里不展开 diff；
 *   4. 点那一行：弹窗打开那份 diff（body 上多一个 file-view、#fileStage 露出来），
 *      横条左边一颗返回箭头、右边写着这个文件的写法），diff 在 #fileBody 里，
 *      既有删掉的那行、也有加上的那行（颜色类是 del / add）；点返回箭头回到上下两格；
 *   5. 刷新页面：清单还在（后端每次现问 git，不跟着页面走）——这正是“刷新浏览器不丢”；
 *   6. 把磁盘上那个文件删了以后再问一次：那一行标「已删除」，点开仍看得到整份都是删掉的；
 *   7. 那一行只有文件名、增删数：没有「回滚」那颗按钮（这一格只看不改）；
 *      把文件照原样写回去以后，那一行从清单里消失（清单空了就回到那句提示）；
 *   8. 模型新写一个文件（write 那条路）：清单里那一行是 +3 −0，点开三行都是新加的；
 *   9. 切到别的会话再切回来：还停在该才那份 diff 上（每个会话各记各的）；
 *  10. 整份行尾从 LF 换成 CRLF（Windows 上很常见：仓库按 CRLF 检出、编辑工具按 LF 写回去）：
 *      这不算改动，那一行该从清单里消失；CRLF 的文件里真改一行，数是 +1 −1，不是整份重写；
 *  11. 会话目录不是 git 仓库：这一格整格收起来（那行小字、上面那道分隔线一起没掉，
 *      上面「文件」那格占满）。
 *
 * 造的话说在前头：脚本自己动 dev/.scratch 里的文件（那个目录不进版本库，随便造）。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { SCRATCH_DIR } = require("./harness.js");

/** 这一跑自己的干净工作目录：先把这一份提交上去，那就是「最近一次提交」。 */
const WORK = path.join(SCRATCH_DIR, "changesWork");
/** 假模型那一套老剧本改的就是这个文件（见 dev/fakePi.js）。 */
const SCRIPT_FILE = "说明.md";
/** 「写新文件」那一段建的那个文件（见 dev/fakePi.js）。 */
const NEW_FILE = "新文件.md";
/** 行尾那一段用的文件：开局按 LF 写一份，后来整份换成 CRLF（内容一个字不改）。 */
const EOL_FILE = "行尾.md";
const EOL_BASE = "第一行\n第二行\n第三行\n";
/** 这一份文件开局那一段（跟 dev/harness.js 铺的那一份一样）：剧本要按原文换掉“调试”两个字。 */
const WELCOME_LINE = "这是 Pi Chat 插件的调试用工作目录（dev/.scratch）。";
/** 说明.md 本来的样子（假模型改的就是它；把这份写回去，那一行就从清单里消失）。 */
const SCRIPT_BASE = WELCOME_LINE + "\n调试时起的会话就跑在这里，随便改，它不进版本库，也不会碰到插件自己的代码。\n";
/** 假 pi 把它的会话文件也写在会话目录里（真 pi 不会）：拿 .gitignore 挡在清单外面。 */
const GITIGNORE = "fake-session-*.jsonl\n";

/** 把这一份铺好的东西提交上去（那就是“最后一次提交”）；同样的配置跟后端问 git 时一样。 */
function commitBase(dir) {
    const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: dir, stdio: "ignore" });
    git("init", "-q", ".");
    git("add", "-A");
    git("-c", "user.email=dev@example.invalid", "-c", "user.name=dev", "commit", "-qm", "基线");
}

let failures = 0;

function check(label, ok, detail) {
    console.log((ok ? "  ✓ " : "  ✗ ") + label + (detail === undefined ? "" : "：" + detail));
    if (!ok) { failures++; }
}

/** 这一列现在长什么样：标题、上下两格、打开的样子（整列看文件 / 看 diff）露没露。 */
function sidebarNow(page) {
    return page.eval(`
        const shown = function (el) {
            return !!el && getComputedStyle(el).display !== "none";
        };
        const panel = document.getElementById("filePanel");
        const dir = document.getElementById("dirPane");
        const change = document.getElementById("changePane");
        const barName = document.querySelector("#fileBar .file-bar-name");
        const wrap = document.getElementById("fileWrap");
        const pRect = panel ? panel.getBoundingClientRect() : null;
        const cRect = change ? change.getBoundingClientRect() : null;
        return JSON.stringify({
            hasSidebar: !!document.getElementById("fileSidebar"),
            title: ((document.getElementById("fileTitle") || {}).textContent || "").trim(),
            hasSearch: !!document.getElementById("fileSearchBtn"),
            hasClose: !!document.getElementById("fileClose"),
            hasTabs: !!document.getElementById("fileTabs") || document.querySelectorAll(".file-tab").length > 0,
            panesShown: shown(document.getElementById("filePanes")),
            dirShown: shown(dir),
            changeShown: shown(change),
            stageShown: shown(document.getElementById("fileStage")),
            fileView: document.body.classList.contains("file-view"),
            barShown: shown(document.getElementById("fileBar")),
            barName: barName ? (barName.textContent || "") : "",
            backShown: shown(document.getElementById("fileCloseFile")),
            wrapHidden: !wrap || wrap.hidden,
            dirRows: dir ? dir.querySelectorAll(".file-entry").length : -1,
            panelH: pRect ? Math.round(pRect.height) : -1,
            changeH: cRect ? Math.round(cRect.height) : -1,
            changeBottom: cRect ? Math.round(cRect.bottom) : -1,
            panelBottom: pRect ? Math.round(pRect.bottom) : -1,
            changeBelowDir: !!(dir && change)
                && dir.getBoundingClientRect().bottom <= change.getBoundingClientRect().top + 1,
        });
    `);
}

/** 「改动」那一格里现在列着哪几个文件（相对写法、右边那几个数、有没有画出 diff）。
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
            noDiff: el.classList.contains("no-diff"),
            cursor: getComputedStyle(el).cursor,
            diffLines: el.querySelectorAll(".diff-line").length,
        })));
    `);
}

/** 「改动」那一格里那句提示（没有就给空串）。 */
function changeNote(page) {
    return page.eval(`
        const pane = document.getElementById("changePane");
        const note = pane && pane.querySelector(".file-note");
        return note ? note.textContent : "";
    `);
}

/** 打开那一份 diff 之后，整列那一块长什么样：横条写着谁、diff 行在哪、有几行加 / 删。 */
function diffNow(page) {
    return page.eval(`
        const shown = function (el) {
            return !!el && getComputedStyle(el).display !== "none";
        };
        const body = document.getElementById("fileBody");
        const barName = document.querySelector("#fileBar .file-bar-name");
        const wrap = document.getElementById("fileWrap");
        const pane = body ? body.querySelector(".file-page.active") : null;
        // 一份 diff 现在是两栏（见 chat.js 的 renderDiffPanes）：一格 = 一边的一行，
        // 空位那一格也算一格（.empty），数增删行时得跳过它。
        const lines = pane ? Array.from(pane.querySelectorAll(".diff2-cell")).filter((el) => !el.classList.contains("empty")) : [];
        return JSON.stringify({
            fileView: document.body.classList.contains("file-view"),
            panesShown: shown(document.getElementById("filePanes")),
            stageShown: shown(document.getElementById("fileStage")),
            barShown: shown(document.getElementById("fileBar")),
            barName: barName ? (barName.textContent || "") : "",
            barTitle: barName ? (barName.getAttribute("title") || "") : "",
            backShown: shown(document.getElementById("fileCloseFile")),
            wrapHidden: !wrap || wrap.hidden,
            pages: body ? body.querySelectorAll(".file-page.active").length : 0,
            lines: lines.length,
            added: lines.filter((el) => el.classList.contains("add")).map((el) => el.textContent),
            removed: lines.filter((el) => el.classList.contains("del")).map((el) => el.textContent),
        });
    `);
}

/** 等这一列变成想要的样子（清单、diff 都是异步来的）。 */
async function waitFor(page, what, read, cond, timeoutMs) {
    const limit = timeoutMs || 8000;
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
        await page.sleep(500);
    }
}

/** 收起再打开：等于让它把「改动」清单再问一遍（后端只在这时候才重新取）。 */
async function reopenSidebar(page) {
    await page.click("#fileClose");
    await page.sleep(300);
    await page.click("#fileSidebarBtn");
    await page.sleep(700);
}

/** 点「改动」清单里某个文件那一行（点写法那一截）。 */
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

/** 点横条左边那颗返回箭头：回到上下两格。 */
async function clickBack(page) {
    await page.click("#fileCloseFile");
    await page.sleep(700);
}

/** 右边那两个数（+1 / −1）：紧凑排在一起，检查时分开看更稳。 */
function countsAre(text, add, del) {
    return String(text).indexOf("+" + add) >= 0 && String(text).indexOf("−" + del) >= 0;
}

module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(600);

    // 这一跑开一个自己的干净工作目录，铺好的这一份提交上去当基线（见 src/gitChanges.ts）。
    // 文件得先铺好、提交、再起会话 —— 会话开始之后才动的东西才算“改动”。
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(path.join(WORK, SCRIPT_FILE), SCRIPT_BASE, "utf8");
    fs.writeFileSync(path.join(WORK, EOL_FILE), EOL_BASE, "utf8");   // 行尾那一段就改这一份
    fs.writeFileSync(path.join(WORK, ".gitignore"), GITIGNORE, "utf8");
    fs.rmSync(path.join(WORK, NEW_FILE), { force: true });
    commitBase(WORK);
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "newSessionInWorkspace", path: ${JSON.stringify(WORK)} });
        return true;
    `);
    await page.sleep(2500);

    // ---- 1. 标题行与上下两格：标签条那套已经没有了 ----
    await ensureOpen(page);
    const base = JSON.parse(await sidebarNow(page));
    console.log("这一列：" + JSON.stringify(base));
    check("最上面一行是标题行，写着「文件与改动」", base.title === "文件与改动", base.title);
    check("标题行右端是文件搜索那颗放大镜与收起那颗叉", base.hasSearch && base.hasClose);
    check("标题行底下上下两格同时露着（上格「文件」、下格「改动」）",
        base.panesShown && base.dirShown && base.changeShown && !base.fileView && !base.stageShown,
        JSON.stringify({ panes: base.panesShown, dir: base.dirShown, change: base.changeShown }));
    check("上格的目录清单列出来了（吃掉剩下那块地方）", base.dirRows > 0, String(base.dirRows) + " 行");
    check("下格在上格下面、没被挤出这一列（最多占 45%）",
        base.changeBelowDir && base.changeBottom <= base.panelBottom + 1
        && base.changeH <= Math.round(base.panelH * 0.45) + 2,
        JSON.stringify({ 上格与下格: base.changeBelowDir, 下格高: base.changeH, 这一列高: base.panelH }));
    check("标签条那一套整个没了（#fileTabs / .file-tab 都不存在）", !base.hasTabs);
    await page.shot("changes-1-empty.png");

    // ---- 2. 跟最后一次提交一样：一句提示 ----
    const emptyNote = await changeNote(page);
    check("没有改动时说一句", emptyNote === "跟最后一次提交一样，没有改动。", emptyNote);

    // ---- 3. 让假模型改一下（老剧本第 4 步真改 说明.md）----
    await page.send("演示一下");
    await page.waitAnswer("完事。");
    await page.sleep(800);
    let rows = JSON.parse(await rowsNow(page));
    console.log("改完之后：" + JSON.stringify(rows));
    check("清单里长出 说明.md", !!(rows[0] && rows[0].path === SCRIPT_FILE));
    check("右边写着 +1 −1", !!(rows[0] && countsAre(rows[0].counts, 1, 1)), rows[0] && rows[0].counts);
    check("行里不展开 diff（那一行里一行 diff 都没有）", !!(rows[0] && rows[0].diffLines === 0));
    check("这一行点得开（光标是手型，不是「太大」那一行）",
        !!(rows[0] && rows[0].cursor === "pointer" && !rows[0].noDiff));
    await page.shot("changes-2-row.png");

    // ---- 4. 点开那一行：整列打开那份 diff ----
    console.log("点那一行：" + await clickRow(page, SCRIPT_FILE));
    const diff = await waitFor(page, "diff 打开", diffNow,
        (x) => x.fileView && x.lines > 0);
    console.log("打开之后：" + JSON.stringify({
        view: diff.fileView, bar: diff.barName, lines: diff.lines,
        added: diff.added.length, removed: diff.removed.length,
    }));
    check("点那一行：弹窗打开、左边那两格照旧露着",
        diff.fileView && diff.panesShown && diff.stageShown, JSON.stringify({ view: diff.fileView, panes: diff.panesShown }));
    check("横条写着那个文件的写法、左边那颗返回箭头在",
        diff.barShown && diff.barName === SCRIPT_FILE && diff.backShown, diff.barName);
    check("看 diff 时折行开关藏着（没有长行可折）", diff.wrapHidden);
    check("diff 里只有这一份（#fileBody 里只有一块），加上的那行是假模型改的",
        diff.pages === 1 && diff.added.some((l) => l.indexOf("假模型改的") >= 0),
        JSON.stringify(diff.added));
    check("diff 里也有删掉的那行", diff.removed.length > 0 && diff.added.length > 0);
    await page.shot("changes-3-diff.png");

    // ---- 4b. 切到别的会话再切回来：还停在刚才那份 diff 上（每个会话各记各的）----
    const sessionId = await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return pane ? (pane.dataset.sessionId || "") : "";
    `);
    const otherDir = path.join(SCRATCH_DIR, "另一个会话");
    fs.mkdirSync(otherDir, { recursive: true });
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "newSessionInWorkspace", path: ${JSON.stringify(otherDir)} });
        return true;
    `);
    await page.sleep(2500);
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "switchSession", sessionId: ${JSON.stringify(sessionId)} });
        return true;
    `);
    const diffAgain = await waitFor(page, "切回来还停在那份 diff 上", diffNow,
        (x) => x.fileView && x.lines > 0, 15000);
    check("切到别的会话再切回来：还停在刚才那份 diff 上（每个会话各记各的）",
        diffAgain.fileView && diffAgain.barName === SCRIPT_FILE && diffAgain.lines === diff.lines,
        JSON.stringify({ bar: diffAgain.barName, lines: diffAgain.lines }));

    // 点返回箭头：回到上下两格，清单还在
    await clickBack(page);
    const back = JSON.parse(await sidebarNow(page));
    check("点返回箭头：回到上下两格（打开的样子收起来）",
        !back.fileView && back.panesShown && back.dirShown && back.changeShown && !back.stageShown,
        JSON.stringify({ view: back.fileView, panes: back.panesShown }));
    rows = JSON.parse(await rowsNow(page));
    check("回到两格以后清单还在", !!(rows[0] && rows[0].path === SCRIPT_FILE), JSON.stringify(rows));

    // ---- 5. 刷新页面：清单还在（数据在后端，不跟着页面走）----
    await page.eval("location.reload(); return true;");
    await page.waitReady();
    await page.sleep(1200);
    await ensureOpen(page);
    rows = await waitFor(page, "刷新之后清单回来", rowsNow, (x) => x.length > 0);
    console.log("刷新之后：" + JSON.stringify(rows));
    check("刷新页面后清单还在", !!(rows[0] && rows[0].path === SCRIPT_FILE && countsAre(rows[0].counts, 1, 1)));
    const afterReload = JSON.parse(await sidebarNow(page));
    check("刷新之后也是上下两格（没停在打开的样子上）",
        !afterReload.fileView && afterReload.panesShown && afterReload.dirShown && afterReload.changeShown);
    await page.shot("changes-4-after-reload.png");

    // ---- 6. 磁盘上把文件删了：这一行标「已删除」，点开仍是整份删掉 ----
    fs.rmSync(path.join(WORK, SCRIPT_FILE), { force: true });
    await reopenSidebar(page);
    rows = await waitFor(page, "删掉文件之后清单刷新", rowsNow,
        (x) => !!(x[0] && x[0].counts.indexOf("已删除") >= 0));
    console.log("删掉文件之后：" + JSON.stringify(rows));
    check("那一行标着「已删除」", !!(rows[0] && rows[0].counts.indexOf("已删除") >= 0), rows[0] && rows[0].counts);
    console.log("点那一行：" + await clickRow(page, SCRIPT_FILE));
    const goneDiff = await waitFor(page, "删掉的文件那份 diff 打开", diffNow,
        (x) => x.fileView && x.lines > 0);
    check("删掉的文件点开：整列都是那份整份删掉的 diff", goneDiff.fileView && goneDiff.removed.length > 0
        && goneDiff.barName === SCRIPT_FILE, JSON.stringify({ del: goneDiff.removed.length, bar: goneDiff.barName }));
    check("删掉的那份 diff 里没有加上的行", goneDiff.added.length === 0, String(goneDiff.added.length));
    await page.shot("changes-5-deleted.png");
    await clickBack(page);

    // ---- 7. 这一格只看不改：那一行没有「回滚」那颗按钮 ----
    const rowShape = JSON.parse(await page.eval(`
        const row = document.querySelector("#changePane .change-head");
        return JSON.stringify({
            revert: !!document.querySelector("#changePane .change-revert"),
            buttons: row ? row.querySelectorAll("button").length : -1,
        });
    `));
    check("那一行里没有「回滚」按钮（这一格只看不改）",
        rowShape.revert === false && rowShape.buttons === 0, JSON.stringify(rowShape));

    // 把文件照原样写回去（回到本会话第一次改它之前）：这一行就从清单里消失，回到那句提示
    fs.writeFileSync(path.join(WORK, SCRIPT_FILE), SCRIPT_BASE, "utf8");
    await reopenSidebar(page);
    rows = await waitFor(page, "清单空了", rowsNow, (x) => x.length === 0);
    check("文件改了回原样：那一行从清单里消失", rows.length === 0, JSON.stringify(rows));
    // 假 pi 把它的会话文件也写在会话目录里（真 pi 不会），所以这一跑里清单不一定是真空的：
    // 真没有别的一行时，格里就应该是那句提示（有它那一行的时候当然不会写提示）。
    const reallyEmpty = await page.eval(`return document.getElementById("changePane").querySelectorAll(".change-head").length === 0;`);
    if (reallyEmpty) {
        const backToHint = await changeNote(page);
        check("清单空了就回到那句提示", backToHint === "跟最后一次提交一样，没有改动。", backToHint);
    }
    await page.shot("changes-6-empty-again.png");

    // ---- 8. 新写一个文件：整份都是新加的行（write 那条路）----
    await page.send("写新文件");
    await page.waitAnswer("写完了。");
    await page.sleep(800);
    rows = await waitFor(page, "新写那个文件进清单", rowsNow,
        (x) => !!(x[0] && x[0].path === NEW_FILE));
    console.log("写了个新文件之后：" + JSON.stringify(rows));
    check("新建的文件也进清单", !!(rows[0] && rows[0].path === NEW_FILE));
    check("新建的文件是 +3 −0", !!(rows[0] && countsAre(rows[0].counts, 3, 0)), rows[0] && rows[0].counts);
    console.log("点那一行：" + await clickRow(page, NEW_FILE));
    const newDiff = await waitFor(page, "新文件那份 diff 打开", diffNow,
        (x) => x.fileView && x.lines > 0);
    console.log("打开那个新文件：" + JSON.stringify({ added: newDiff.added.length, removed: newDiff.removed.length }));
    check("点开以后整列都是它，三行都是新加的、没有删掉的行",
        newDiff.fileView && newDiff.barName === NEW_FILE && newDiff.added.length === 3 && newDiff.removed.length === 0,
        JSON.stringify({ added: newDiff.added.length, removed: newDiff.removed.length }));
    await page.shot("changes-8-new-file.png");
    await clickBack(page);
    fs.rmSync(path.join(WORK, NEW_FILE), { force: true });

    // ---- 9. 整份行尾换成 CRLF：不算改动 ----
    // Windows 上很常见：仓库按 CRLF 检出（core.autocrlf），编辑工具按 LF 写回去，
    // 内容是“没改”的，但逐行比出来就是整份重写（一个 2000 行的文件报 +2033 −2034）。
    const eolPath = path.join(WORK, EOL_FILE);
    fs.writeFileSync(eolPath, EOL_BASE.replace(/\n/g, "\r\n"), "utf8");
    await reopenSidebar(page);
    rows = await waitFor(page, "行尾换掉以后清单刷新，那一行不该在",
        rowsNow, (x) => !x.some((one) => one.path === EOL_FILE));
    check("整份行尾从 LF 换成 CRLF：不算改动，那一行不进清单",
        !rows.some((one) => one.path === EOL_FILE), JSON.stringify(rows));

    // ---- 10. CRLF 的文件里真改一行：数是 +1 −1 ----
    fs.writeFileSync(eolPath, "第一行改过了\r\n第二行\r\n第三行\r\n", "utf8");
    await reopenSidebar(page);
    rows = await waitFor(page, "CRLF 的文件改一行", rowsNow, (x) => x.some((one) => one.path === EOL_FILE));
    const eolRow = rows.find((one) => one.path === EOL_FILE);
    check("CRLF 的文件里真改一行：+1 −1（不是整份重写）",
        !!(eolRow && countsAre(eolRow.counts, 1, 1)), eolRow && eolRow.counts);
    console.log("点那一行：" + await clickRow(page, EOL_FILE));
    const eolDiff = await waitFor(page, "行尾那一份 diff 打开", diffNow, (x) => x.fileView && x.lines > 0);
    check("点开也是 +1 −1 那么两行，不是整份",
        eolDiff.added.length === 1 && eolDiff.removed.length === 1,
        JSON.stringify({ added: eolDiff.added.length, removed: eolDiff.removed.length }));
    await page.shot("changes-9-eol.png");
    await clickBack(page);
    fs.rmSync(eolPath, { force: true });

    // ---- 11. 不是 git 仓库的目录：这一格整格收起来 ----
    // 得挑一个在任何仓库外面的目录（dev/.scratch 自己在插件的仓库里，拿它验不出来）
    const plainDir = path.join(require("os").tmpdir(), "pichat-no-git-" + process.pid);
    fs.rmSync(plainDir, { recursive: true, force: true });
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, "随便.md"), "随便\n", "utf8");
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "newSessionInWorkspace", path: ${JSON.stringify(plainDir)} });
        return true;
    `);
    await page.sleep(2500);
    await ensureOpen(page);
    const plain = await waitFor(page, "不是仓库的目录里那一格收起来", sidebarNow,
        (x) => x.changeShown === false, 15000);
    console.log("普通目录里：" + JSON.stringify({
        change: plain.changeShown, dir: plain.dirShown, 这一列高: plain.panelH,
    }));
    check("没有 git 的目录：下格「改动」整格收起来", plain.changeShown === false && plain.dirShown,
        JSON.stringify({ change: plain.changeShown, dir: plain.dirShown }));
    check("收起来以后上格「文件」照样露着、占满这一列",
        plain.dirShown && plain.dirRows > 0, String(plain.dirRows) + " 行");
    await page.shot("changes-10-no-git.png");

    // 切回仓库里那个会话：那一格自己又露出来
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "switchSession", sessionId: ${JSON.stringify(sessionId)} });
        return true;
    `);
    const again = await waitFor(page, "切回仓库里那个会话", sidebarNow, (x) => x.changeShown === true, 15000);
    check("切回仓库里的会话：那一格又露出来", again.changeShown === true, JSON.stringify(again.changeShown));

    console.log("");
    console.log(failures === 0 ? "改动那一格：都对上了。" : "改动那一格：有 " + failures + " 条不对。");
    if (failures > 0) { throw new Error("有 " + failures + " 条不对（见上面那些 ✗）"); }
};

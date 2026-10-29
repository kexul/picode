// @ts-nocheck
/**
 * changesTab —— 验文件侧边栏那一格「改动」（这个会话改过哪些文件，一个地方全看）。
 *
 *   npm run web:shot -- --fake-pi --script dev/changesTab.js
 *
 * 真后端、真会话、真网页服务、真界面文件，只有模型是假的（假模型那一套老剧本里
 * 第 4 步会真去改 dev/.scratch 里的 说明.txt，后端因此记下这一份改动）。
 * 验的是外面看得见的行为：
 *   1. 这一列开着时标签条上固定三格：「文件」「改动」「后台」，都排在文件标签前面、都没有那颗叉；
 *   2. 一个文件都没改过时，这一格里只有一句「这个会话还没改过文件。」；
 *   3. 假模型改完 说明.txt 之后（后端推了一条“改动变了”），这一格自己长出那一行：
 *      相对写法、+1 −1、没展开时看不到 diff；
 *   4. 点那一行展开：这一块的 diff 里既有删掉的那行、也有加上的那行（颜色类是 del / add）；
 *   5. 刷新页面：清单还在（数据在后端会话的内存里，不跟着页面走）——这正是“刷新浏览器不丢”；
 *   6. 把磁盘上那个文件删了以后再问一次：那一行标「已删除」，展开仍看得到整份都是删掉的；
 *   7. 点「回滚」先弹一句确认；点确定之后文件真被写回去、那一行也从清单里消失
 *      （清单空了就回到那句提示）；
 *   8. 模型新写一个文件（write 那条路）：清单里那一行是 +3 −0，展开三行都是新加的。
 *
 * 造的话说在前头：脚本自己动 dev/.scratch 里的文件（那个目录不进版本库，随便造）。
 */
const fs = require("fs");
const path = require("path");
const { SCRATCH_DIR } = require("./harness.js");

/** 假模型那一套老剧本改的就是这个文件（见 dev/fakePi.js）。 */
const SCRIPT_FILE = "说明.txt";
/** 「写新文件」那一段建的那个文件（见 dev/fakePi.js）。 */
const NEW_FILE = "新文件.txt";
/** 这一份文件开局那一段（跟 dev/harness.js 铺的那一份一样）：剧本要按原文换掉“调试”两个字。 */
const WELCOME_LINE = "这是 Pi Chat 插件的调试用工作目录（dev/.scratch）。";

let failures = 0;

function check(label, ok, detail) {
    console.log((ok ? "  ✓ " : "  ✗ ") + label + (detail === undefined ? "" : "：" + detail));
    if (!ok) { failures++; }
}

/** 现在露着的那一块正文里的一句提示（没有就给空串）。 */
function visibleNote(page) {
    return page.eval(`
        const page = document.querySelector("#fileBody .file-page:not([hidden])");
        const note = page && page.querySelector(".file-note");
        return note ? note.textContent : "";
    `);
}

/** 标签条上现在是哪几格（名字、是不是「改动」「文件」、有没有那颗叉）。 */
function tabsNow(page) {
    return page.eval(`
        return JSON.stringify(Array.from(document.querySelectorAll("#fileTabs .file-tab")).map((el) => ({
            name: (el.querySelector(".file-tab-name") || {}).textContent || "",
            changes: el.getAttribute("data-changes") === "1",
            proj: el.getAttribute("data-proj") === "1",
            close: !!el.querySelector(".file-tab-close"),
        })));
    `);
}

/** 这一格里现在列着哪几个文件（相对写法、有没有展开、右边那几个数、有没有画出 diff）。 */
function rowsNow(page) {
    return page.eval(`
        const page = document.querySelector("#fileBody .file-page:not([hidden])");
        if (!page) { return "[]"; }
        return JSON.stringify(Array.from(page.querySelectorAll(".change-item")).map((el) => ({
            path: el.getAttribute("data-path"),
            open: el.classList.contains("open"),
            counts: ((el.querySelector(".change-counts") || {}).textContent || "").trim(),
            diffLines: el.querySelectorAll(".diff-line").length,
        })));
    `);
}

/** 点一下「改动」那一格（已经看着它的时候也点一下：等于重新问一次清单）。 */
async function openChangesTab(page) {
    await page.click("#fileTabs .file-tab[data-changes]");
    await page.sleep(500);
}

/** 右边那两个数（+1 / −1）：紧凑排在一起，检查时分开看更稳。 */
function countsAre(text, add, del) {
    return String(text).indexOf("+" + add) >= 0 && String(text).indexOf("−" + del) >= 0;
}

/** 等问话卡片长出来，把上面的字读回来（没有就给空串）。 */
async function waitConfirm(page) {
    for (let i = 0; i < 60; i++) {
        const text = await page.eval(`
            const cards = document.querySelectorAll(".ask-card:not(.done)");
            const card = cards[cards.length - 1];
            return card ? (card.innerText || "") : "";
        `);
        if (text) { return text; }
        await page.sleep(100);
    }
    return "";
}

/** 等问话卡片长出来，点它上面那颗「确定」。 */
async function answerConfirm(page) {
    for (let i = 0; i < 60; i++) {
        const ready = await page.eval(`
            const cards = document.querySelectorAll(".ask-card:not(.done)");
            const card = cards[cards.length - 1];
            return !!(card && card.querySelector(".ask-btn.primary"));
        `);
        if (ready) { break; }
        await page.sleep(100);
    }
    const pressed = await page.eval(`
        const cards = document.querySelectorAll(".ask-card:not(.done)");
        const card = cards[cards.length - 1];
        const btn = card && card.querySelector(".ask-btn.primary");
        if (!btn) { return false; }
        btn.click();
        return true;
    `);
    await page.sleep(600);
    return pressed;
}

module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(600);

    // ---- 1. 标签条：固定的两格，都在、都没叉 ----
    await page.click("#fileSidebarBtn");
    await page.sleep(400);
    const tabs = JSON.parse(await tabsNow(page));
    console.log("标签条：" + JSON.stringify(tabs));
    check("第一格是「文件」", !!(tabs[0] && tabs[0].proj && tabs[0].name === "文件"));
    check("第二格是「改动」", !!(tabs[1] && tabs[1].changes && tabs[1].name === "改动"));
    check("这两格都没有那颗叉", !tabs[0].close && !tabs[1].close);

    // ---- 2. 还没改过文件：一句提示 ----
    await openChangesTab(page);
    const emptyNote = await visibleNote(page);
    check("没改过文件时说一句", emptyNote === "这个会话还没改过文件。", emptyNote);
    await page.shot("changes-1-empty.png");

    // ---- 3. 让假模型改一下（老剧本第 4 步真改 说明.txt）----
    // 先把那个文件铺成剧本里认的那一句：假模型改的就是这一处（上一次跑完留下的样子不算数）
    fs.writeFileSync(path.join(SCRATCH_DIR, SCRIPT_FILE),
        WELCOME_LINE + "\n调试时起的会话就跑在这里，随便改，它不进版本库，也不会碰到插件自己的代码。\n", "utf8");
    // 「写新文件」那一步新建的那个也要先清掉：上一跑留下来的内容跟剧本一字不差时，那一次
    // write 等于没改（文件本来就是这样），清单里也就不会长出那一行——第二次跑必失败。
    fs.rmSync(path.join(SCRATCH_DIR, NEW_FILE), { force: true });
    await page.send("演示一下");
    await page.waitAnswer("完事。");
    await page.sleep(800);
    let rows = JSON.parse(await rowsNow(page));
    console.log("改完之后：" + JSON.stringify(rows));
    check("清单里长出 说明.txt", !!(rows[0] && rows[0].path === SCRIPT_FILE));
    check("右边写着 +1 −1", !!(rows[0] && countsAre(rows[0].counts, 1, 1)), rows[0] && rows[0].counts);
    check("没展开时看不到 diff", !!(rows[0] && !rows[0].open && rows[0].diffLines === 0));
    await page.shot("changes-2-row.png");

    // ---- 4. 点开那一行：diff 画出来 ----
    await page.click("#fileBody .file-page:not([hidden]) .change-head");
    await page.sleep(500);
    rows = JSON.parse(await rowsNow(page));
    const diff = await page.eval(`
        const page = document.querySelector("#fileBody .file-page:not([hidden])");
        const block = page.querySelector(".change-item[data-path=" + JSON.stringify(${JSON.stringify(SCRIPT_FILE)}) + "]");
        if (!block) { return "{}"; }
        const lines = Array.from(block.querySelectorAll(".diff-line"));
        return JSON.stringify({
            lines: lines.length,
            added: Array.from(block.querySelectorAll(".diff-line.add")).map((el) => el.textContent),
            removed: Array.from(block.querySelectorAll(".diff-line.del")).map((el) => el.textContent),
        });
    `);
    console.log("展开之后：" + JSON.stringify(rows) + " diff：" + diff);
    const parsed = JSON.parse(diff);
    check("展开后这一行是开着的", !!(rows[0] && rows[0].open));
    check("diff 里有加上的那行", parsed.added.some((l) => l.indexOf("假模型改的") >= 0), JSON.stringify(parsed.added));
    check("diff 里有删掉的那行", parsed.removed.length > 0 && parsed.added.length > 0);
    await page.shot("changes-3-diff.png");

    // ---- 5. 刷新页面：清单还在（数据在后端，不跟着页面走）----
    await page.eval("location.reload(); return true;");
    await page.waitReady();
    await page.sleep(1200);
    await openChangesTab(page);
    rows = JSON.parse(await rowsNow(page));
    console.log("刷新之后：" + JSON.stringify(rows));
    check("刷新页面后清单还在", !!(rows[0] && rows[0].path === SCRIPT_FILE && countsAre(rows[0].counts, 1, 1)));
    await page.shot("changes-4-after-reload.png");

    // ---- 6. 磁盘上把文件删了：这一行标「已删除」，展开仍是整份删掉 ----
    fs.rmSync(path.join(SCRATCH_DIR, SCRIPT_FILE), { force: true });
    await openChangesTab(page);
    rows = JSON.parse(await rowsNow(page));
    console.log("删掉文件之后：" + JSON.stringify(rows));
    check("那一行标着「已删除」", !!(rows[0] && rows[0].counts.indexOf("已删除") >= 0), rows[0] && rows[0].counts);
    await page.click("#fileBody .file-page:not([hidden]) .change-head");
    await page.sleep(500);
    const removedLines = await page.eval(`
        const page = document.querySelector("#fileBody .file-page:not([hidden])");
        return page.querySelectorAll(".change-body .diff-line.del").length;
    `);
    check("删掉的文件展开后整份都是删掉的行", Number(removedLines) > 0, "删掉的行数 " + removedLines);
    await page.shot("changes-5-deleted.png");

    // ---- 7. 回滚：先问一句，再真写回去 ----
    await page.click("#fileBody .file-page:not([hidden]) .change-revert");
    const asked = await waitConfirm(page);
    console.log("确认框：" + asked.replace(/\s+/g, " ").slice(0, 80));
    check("点「回滚」先弹一句确认", asked.indexOf("回到这个会话第一次改它之前") >= 0);
    await page.shot("changes-6-confirm.png");
    await answerConfirm(page);
    await page.sleep(900);
    const restored = fs.readFileSync(path.join(SCRATCH_DIR, SCRIPT_FILE), "utf8");
    check("文件真被写回去了（连删掉的那个也回来了）", restored.indexOf("假模型改的") < 0 && restored.length > 0,
        JSON.stringify(restored.slice(0, 40)));
    rows = JSON.parse(await rowsNow(page));
    check("清单空了（那一行没了）", rows.length === 0, JSON.stringify(rows));
    const backToHint = await visibleNote(page);
    check("清单空了就回到那句提示", backToHint === "这个会话还没改过文件。", backToHint);
    await page.shot("changes-7-reverted.png");

    // ---- 8. 新写一个文件：整份都是新加的行（write 那条路）----
    await page.send("写新文件");
    await page.waitAnswer("写完了。");
    await page.sleep(800);
    rows = JSON.parse(await rowsNow(page));
    console.log("写了个新文件之后：" + JSON.stringify(rows));
    check("新建的文件也进清单", !!(rows[0] && rows[0].path === NEW_FILE));
    check("新建的文件是 +3 −0", !!(rows[0] && countsAre(rows[0].counts, 3, 0)), rows[0] && rows[0].counts);
    await page.click("#fileBody .file-page:not([hidden]) .change-head");
    await page.sleep(500);
    const addedOnly = await page.eval(`
        const page = document.querySelector("#fileBody .file-page:not([hidden])");
        const block = page.querySelector(".change-item");
        if (!block) { return "{}"; }
        return JSON.stringify({
            added: block.querySelectorAll(".diff-line.add").length,
            removed: block.querySelectorAll(".diff-line.del").length,
        });
    `);
    console.log("展开那个新文件：" + addedOnly);
    const addedOnlyParsed = JSON.parse(addedOnly);
    check("展开后三行都是新加的、没有删掉的行",
        addedOnlyParsed.added === 3 && addedOnlyParsed.removed === 0, addedOnly);
    await page.shot("changes-8-new-file.png");
    fs.rmSync(path.join(SCRATCH_DIR, NEW_FILE), { force: true });

    console.log("");
    console.log(failures === 0 ? "改动那一格：都对上了。" : "改动那一格：有 " + failures + " 条不对。");
    if (failures > 0) { throw new Error("有 " + failures + " 条不对（见上面那些 ✗）"); }
};

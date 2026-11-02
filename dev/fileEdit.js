// @ts-nocheck
/**
 * fileEdit —— 验「在看文件的弹窗里改一个代码文件、存回磁盘」。
 *
 *   npm run web:shot -- --fake-pi --script dev/fileEdit.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的，这里也根本没用到模型）。
 * 验的是外面看得见的行为：
 *   1. 弹窗横条上那颗铅笔只在能改的文件上露面：会语法上色的代码（这里 .ts / .js）有；
 *      .txt、.md、.html 那几种没有（那三种各有各的画法，不走这条）；
 *   2. 点铅笔：正文换成一块文本框，行号与上色都没了；这时横条上是「放弃」与「存」，
 *      没改过的时候「存」按不下去；
 *   3. 敲字：文件标签上挂一个圆点、「存」亮起来；Ctrl+S 与点「存」都能存；
 *      存完正文按盘上那份重画（文本框收起来、行号回来），磁盘上真是新内容，
 *      左边「改动」那一格也长出这一份（它是按磁盘算的，手改的也算）；
 *   4. 没存的改动不会因为关掉弹窗、切到别的会话就没了：再打开还是编辑态、还是那几句话；
 *      点「放弃」才回到盘上那份（之后再打开就是只读的）；
 *   5. 盘上被别人改过（这里直接写磁盘模拟模型 / 脚本）：点「存」不会默默盖上去，
 *      顶上多一句提示、那颗按钮变成「覆盖」，点它才真盖；
 *   6. 行尾与 BOM 不会被这次编辑顺手改掉：CRLF 的文件存完还是 CRLF，带 BOM 的存完还有 BOM；
 *   7. 后端那条写地址自己那几种拒绝：目录外（`../x`）403、没有这个文件 404、
 *      非文本 415、没给 text 400、带上旧 mtime 而盘上已经变了 409。
 *
 * 素材现写进这一跑自己的干净工作目录（dev/.scratch/editWork，那个目录不进版本库）。
 */
const fs = require("fs");
const path = require("path");
const { SCRATCH_DIR } = require("./harness.js");

const WORK = path.join(SCRATCH_DIR, "editWork");
const TS = "edit.ts";
const TS_LINES = [
    'import { readFile } from "node:fs";',
    "",
    "// 这几行都是现铺的",
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
];
const TS_TEXT = TS_LINES.join("\n") + "\n";
/** 敲进去的那一行（存完该出现在磁盘上和正文里）。 */
const TYPED = "// 手改的这一行";
/** 第二次敲进去、故意不存的那一行。 */
const DRAFT = "// 没存的这一行";
/** CRLF 的文件（Windows 上很常见）：存完还得是 CRLF，不许整份换成 LF。 */
const CRLF = "crlf.js";
const CRLF_TEXT = "const a = 1;\r\nconst b = 2;\r\n";
const CRLF_TYPED = "const c = 3;";
/** 带 BOM 的文件：浏览器把 BOM 吃掉，写回去不能少那三个字节。 */
const BOM = "bom.ts";
const BOM_TEXT = "\uFEFFconst x = 1;\nconst y = 2;\n";
/** 不该有铅笔的几种：纯文本、markdown（排好版）、html（摆 iframe）。 */
const PLAIN = "notes.txt";
/** 会话目录外面那个文件：写地址该拿 403 挡回去（真身存在，就是不在这个会话的目录里）。 */
const OUTSIDE = "外面.ts";
const OUTSIDE_REL = "../" + OUTSIDE;
const OUTSIDE_TEXT = "// 外面那份，不该被写到\n";
/** 一张小图（写回磁盘那条路该拿 415 挡回去：不是文本）。 */
const IMAGE = "img.png";
const IMAGE_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const MD_FILE = "doc.md";
const HTML_FILE = "page.html";

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "  ✓ " : "  ✗ ") + label + (detail === undefined ? "" : "：" + detail));
    if (!ok) { failures++; }
}

/** 弹窗横条与正文现在长什么样。 */
function look(page) {
    return page.eval(`
        const shown = function (el) { return !!el && getComputedStyle(el).display !== "none" && !el.hidden; };
        const bar = document.getElementById("fileBar");
        const editBtn = document.getElementById("fileEdit");
        const saveBtn = document.getElementById("fileSave");
        const revertBtn = document.getElementById("fileRevert");
        const nameEl = bar ? bar.querySelector(".file-bar-name") : null;
        const body = document.getElementById("fileBody");
        const pane = body ? body.querySelector(".file-page.active") : null;
        const area = pane ? pane.querySelector(".file-edit-text") : null;
        const note = pane ? pane.querySelector(".file-edit-note") : null;
        return JSON.stringify({
            viewing: document.body.classList.contains("file-view") && shown(document.getElementById("fileStage")),
            barShown: shown(bar),
            barName: nameEl ? (nameEl.textContent || "") : "",
            editShown: shown(editBtn),
            saveShown: shown(saveBtn),
            saveEnabled: !!saveBtn && !saveBtn.disabled,
            saveText: saveBtn ? (saveBtn.textContent || "").trim() : "",
            revertShown: shown(revertBtn),
            revertText: revertBtn ? (revertBtn.textContent || "").trim() : "",
            textarea: !!area,
            text: area ? area.value : "",
            note: note && !note.hidden ? (note.textContent || "") : "",
            lines: pane ? pane.querySelectorAll(".file-line").length : 0,
            hasPage: !!pane,
            frame: pane ? pane.querySelectorAll("iframe.file-site").length : 0,
        });
    `);
}

function read(page, file) {
    return page.eval(`
        const pane = document.getElementById("dirPane");
        return pane ? !!pane.querySelector('.file-entry[data-path="' + ${JSON.stringify(file)} + '"]') : false;
    `);
}

async function waitFor(page, what, cond, timeoutMs) {
    const limit = timeoutMs || 8000;
    const started = Date.now();
    let got = {};
    while (Date.now() - started < limit) {
        got = JSON.parse(await look(page));
        if (cond(got)) { return got; }
        await page.sleep(200);
    }
    console.log("（等超时：" + what + "，现在这样：" + JSON.stringify(got) + "）");
    return got;
}

/** 这一列开着吗（开着的时候再点顶条那颗按钮就收起来了，所以先看一眼）。 */
async function ensureSidebar(page) {
    const open = await page.eval(`return document.body.classList.contains("file-open");`);
    if (!open) {
        await page.click("#fileSidebarBtn");
        await page.sleep(600);
    }
}

async function waitListing(page, file, timeoutMs) {
    const limit = timeoutMs || 10000;
    const started = Date.now();
    while (Date.now() - started < limit) {
        if (await read(page, file)) { return true; }
        await page.sleep(200);
    }
    return false;
}

/** 从左边「文件」那一格点开一个文件（跟人点链接去同一个地方：弹窗里看它）。 */
async function openFile(page, file) {
    await ensureSidebar(page);
    const listed = await waitListing(page, file);
    if (!listed) { throw new Error("「文件」那一格里没有 " + file); }
    await page.eval(`
        const row = document.querySelector('#dirPane .file-entry[data-path="' + ${JSON.stringify(file)} + '"]');
        row.click();
        return true;
    `);
    await page.sleep(900);
}

/** 点那颗铅笔进编辑态，等文本框出来。 */
async function startEdit(page) {
    await page.click("#fileEdit");
    return waitFor(page, "文本框出来", (x) => x.textarea);
}

/** 在文本框里接着敲一段（走浏览器原生输入，界面当成真人敲的）。 */
async function typeInEditor(page, text) {
    await page.eval(`
        const area = document.querySelector(".file-edit-text");
        if (!area) { return false; }
        area.focus();
        const end = area.value.length;
        area.setSelectionRange(end, end);
        return true;
    `);
    await page.cdp.send("Input.insertText", { text: text });
    await page.sleep(300);
}

/** 按一下 Ctrl+S（走真的键盘事件，验那颗快捷键）。 */
async function pressCtrlS(page) {
    await page.eval(`const area = document.querySelector(".file-edit-text"); if (area) { area.focus(); } return true;`);
    await page.sleep(200);
    await page.cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown", key: "s", code: "KeyS", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 2,
    });
    await page.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "s", code: "KeyS", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 2,
    });
    await page.sleep(1200);
}

/** 磁盘上那个文件现在是什么（读不出来给空串）。 */
function disk(file) {
    try { return fs.readFileSync(path.join(WORK, file), "utf8"); } catch { return ""; }
}

function diskBytes(file) {
    try { return fs.readFileSync(path.join(WORK, file)); } catch { return Buffer.alloc(0); }
}

/** 把盘上那个文件改成另一份（模拟模型 / 脚本刚改过它），顺便把修改时间推后一点。 */
function touchFromOutside(file, text) {
    const full = path.join(WORK, file);
    fs.writeFileSync(full, text, "utf8");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(full, future, future);
}

/** 「改动」那一格里有没有这一份（手改的也算，那一格是按磁盘算的）。 */
function changeRow(page, file) {
    return page.eval(`
        const row = Array.from(document.querySelectorAll("#changePane .change-head"))
            .find(function (el) { return el.getAttribute("data-path") === ${JSON.stringify(file)}; });
        return row ? ((row.querySelector(".change-counts") || {}).textContent || "").trim() : "";
    `);
}

module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(600);

    // 这一跑自己的干净工作目录（会话目录就是它：改来改去都在里面）
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(path.join(WORK, TS), TS_TEXT, "utf8");
    fs.writeFileSync(path.join(WORK, CRLF), CRLF_TEXT, "utf8");
    fs.writeFileSync(path.join(WORK, BOM), BOM_TEXT, "utf8");
    fs.writeFileSync(path.join(WORK, PLAIN), "第一行\n第二行\n", "utf8");
    fs.writeFileSync(path.join(WORK, MD_FILE), "# 标题\n\n一段正文。\n", "utf8");
    fs.writeFileSync(path.join(WORK, HTML_FILE), "<!doctype html><meta charset=\"utf-8\"><p>hi</p>\n", "utf8");
    fs.writeFileSync(path.join(WORK, IMAGE), IMAGE_BYTES);
    fs.mkdirSync(path.join(WORK, "sub"), { recursive: true });
    fs.writeFileSync(path.join(WORK, "sub", "bare.js"), "// 只有子目录里有这个名字\nconst bare = 1;\n", "utf8");
    fs.writeFileSync(path.join(SCRATCH_DIR, OUTSIDE), OUTSIDE_TEXT, "utf8");
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "newSessionInWorkspace", path: ${JSON.stringify(WORK)} });
        return true;
    `);
    await page.sleep(2500);

    // ---- 1. 打开一个代码文件：铅笔露面，存 / 放弃 藏着 ----
    await openFile(page, TS);
    let cur = await waitFor(page, "正文画出来", (x) => x.viewing && x.lines > 0);
    console.log("打开 edit.ts：" + JSON.stringify({ 行: cur.lines, 铅笔: cur.editShown, 存: cur.saveShown }));
    check("打开一个代码文件：正文带行号画出来了", cur.viewing && cur.lines === TS_LINES.length, String(cur.lines) + " 行");
    check("横条上有那颗铅笔（能改）", cur.editShown);
    check("还没进编辑态：没有文本框、也没有「存」「放弃」", !cur.textarea && !cur.saveShown && !cur.revertShown);
    await page.shot("edit-1-view.png");

    // ---- 2. 点铅笔：换成一块文本框 ----
    cur = await startEdit(page);
    console.log("进编辑态：" + JSON.stringify({ 行: cur.lines, 文本框: cur.textarea, 存: cur.saveEnabled }));
    check("点铅笔：正文换成一块文本框，行号与上色都没了", cur.textarea && cur.lines === 0);
    check("文本框里是刚读进来那份原文", cur.text === TS_TEXT, JSON.stringify(cur.text.slice(0, 20)));
    check("横条上换成「存」与「放弃」两颗，铅笔藏起来", cur.saveShown && cur.revertShown && !cur.editShown);
    check("还没改过：「存」按不下去", !cur.saveEnabled);
    check("刚进编辑态、一字未改：写法前面不挂圆点", cur.barName.indexOf("●") !== 0, cur.barName);
    await page.shot("edit-2-editing.png");

    // ---- 3. 敲一行，Ctrl+S 存回磁盘 ----
    await typeInEditor(page, TYPED + "\n");
    cur = JSON.parse(await look(page));
    check("敲了字：「存」亮起来", cur.saveEnabled);
    check("敲了字：横条上写法前面挂了个圆点", cur.barName.indexOf("●") === 0, cur.barName);
    await pressCtrlS(page);
    cur = await waitFor(page, "存完按盘上重画", (x) => !x.textarea && x.lines > 0);
    const afterSave = disk(TS);
    console.log("存完：" + JSON.stringify({ 行: cur.lines, 磁盘上有这句: afterSave.indexOf(TYPED) >= 0 }));
    check("Ctrl+S 存进去了：磁盘上是新内容", afterSave.indexOf(TYPED) >= 0, JSON.stringify(afterSave.slice(-40)));
    check("存完正文按盘上那份重画（文本框收起来、行号回来）", !cur.textarea && cur.lines === TS_LINES.length + 1);
    check("存完那颗圆点没了", cur.barName.indexOf("●") !== 0, cur.barName);
    check("存完铅笔又露面了（还能接着改）", cur.editShown);
    check("存完磁盘上还是原来的行尾（LF）", afterSave.indexOf("\r") < 0);
    const changeCounts = await changeRow(page, TS);
    check("左边「改动」那一格长出这一份（手改的也算）", changeCounts.indexOf("+1") >= 0, changeCounts);
    await page.shot("edit-3-saved.png");

    // ---- 4. 没存的改动不会因为关掉弹窗就没了 ----
    await startEdit(page);
    await typeInEditor(page, DRAFT + "\n");
    await page.click("#fileCloseFile");
    await page.sleep(600);
    check("关掉弹窗以后磁盘上当然没有那一句", disk(TS).indexOf(DRAFT) < 0);
    await openFile(page, TS);
    cur = await waitFor(page, "再打开还是编辑态", (x) => x.textarea);
    check("再打开这个文件：还是编辑态，那几句没存的话还在", cur.textarea && cur.text.indexOf(DRAFT) >= 0);
    check("横条上还是「存」「放弃」（不用人再去点铅笔）", cur.saveShown && cur.revertShown && !cur.editShown);

    // 切到别的会话再切回来：也没丢
    const sessionId = await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return pane ? (pane.dataset.sessionId || "") : "";
    `);
    const otherDir = path.join(SCRATCH_DIR, "editWork另一处");
    fs.mkdirSync(otherDir, { recursive: true });
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "newSessionInWorkspace", path: ${JSON.stringify(otherDir)} });
        return true;
    `);
    await page.sleep(2200);
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "switchSession", sessionId: ${JSON.stringify(sessionId)} });
        return true;
    `);
    await page.sleep(2200);
    await openFile(page, TS);
    cur = await waitFor(page, "切回来还是编辑态", (x) => x.textarea, 12000);
    check("切到别的会话再切回来：那几句没存的话还在", cur.textarea && cur.text.indexOf(DRAFT) >= 0);
    await page.shot("edit-4-draft-back.png");

    // ---- 5. 放弃：回到盘上那份，之后再打开就是只读的 ----
    await page.click("#fileRevert");
    cur = await waitFor(page, "放弃后重读", (x) => !x.textarea && x.lines > 0);
    check("点「放弃」：回到盘上那份（文本框收起来、那一句没了）", !cur.textarea && cur.text === "" && cur.lines > 0);
    check("放弃以后磁盘没被动过", disk(TS).indexOf(DRAFT) < 0);
    await openFile(page, TS);
    await page.sleep(500);
    cur = JSON.parse(await look(page));
    check("放弃之后再打开：只读的（不用人再放弃一次）", !cur.textarea && cur.editShown);

    // ---- 6. 盘上被别人改过：不许默默盖上去 ----
    await startEdit(page);
    await typeInEditor(page, "// 我这一版\n");
    touchFromOutside(TS, "// 外面改的\n");
    await page.click("#fileSave");
    cur = await waitFor(page, "冲突那句提示出来", (x) => x.saveText === "覆盖");
    console.log("冲突时：" + JSON.stringify({ 提示: cur.note.slice(0, 30), 存: cur.saveText, 放弃: cur.revertText }));
    check("盘上变了时点「存」不会盖上去：磁盘还是外面那份", disk(TS) === "// 外面改的\n", JSON.stringify(disk(TS)));
    check("顶上多一句提示，说清两条路", cur.note.indexOf("盘上已经变了") >= 0, cur.note);
    check("那颗按钮变成「覆盖」、放弃那颗变成「用盘上的」", cur.saveText === "覆盖" && cur.revertText === "用盘上的");
    await page.shot("edit-5-conflict.png");
    await page.click("#fileSave");
    cur = await waitFor(page, "覆盖之后重读", (x) => !x.textarea && x.lines > 0);
    check("点「覆盖」：磁盘换成我这一份", disk(TS).indexOf("// 我这一版") >= 0, JSON.stringify(disk(TS)));
    check("覆盖完正文也是我这一份（原来是 7 行，我加了一行）", cur.lines === TS_LINES.length + 2, String(cur.lines) + " 行");
    check("覆盖完那句提示收起来了", cur.note === "");

    // ---- 7. 行尾与 BOM ----
    await openFile(page, CRLF);
    cur = await waitFor(page, "crlf.js 画出来", (x) => x.lines > 0);
    await startEdit(page);
    await typeInEditor(page, CRLF_TYPED + "\n");
    await page.click("#fileSave");
    await waitFor(page, "crlf.js 存完", (x) => !x.textarea);
    const crlfAfter = diskBytes(CRLF).toString("utf8");
    check("CRLF 的文件存完还是 CRLF（没有裸 LF）",
        crlfAfter.indexOf(CRLF_TYPED) >= 0 && !/[^\r]\n/.test(crlfAfter)
        && (crlfAfter.split("\r\n").length - 1) === (crlfAfter.split("\n").length - 1),
        JSON.stringify(crlfAfter));

    await openFile(page, BOM);
    await waitFor(page, "bom.ts 画出来", (x) => x.lines > 0);
    await startEdit(page);
    await typeInEditor(page, "const z = 3;\n");
    await page.click("#fileSave");
    await waitFor(page, "bom.ts 存完", (x) => !x.textarea);
    const bomBytes = diskBytes(BOM);
    check("带 BOM 的文件存完 BOM 还在",
        bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf && bomBytes.toString("utf8").indexOf("const z = 3;") >= 0,
        JSON.stringify(bomBytes.toString("utf8").slice(0, 12)));

    // ---- 8. 不该有铅笔的几种 ----
    for (const [file, why] of [[PLAIN, "纯文本"], [MD_FILE, "markdown（排好版）"], [HTML_FILE, "html（当网页渲染）"]]) {
        await openFile(page, file);
        await page.sleep(700);
        const got = JSON.parse(await look(page));
        check(why + " 上不该有那颗铅笔", !got.editShown && !got.textarea, JSON.stringify({ 铅笔: got.editShown, 网页: got.frame }));
    }
    await page.shot("edit-6-no-pencil-html.png");

    // ---- 9. 后端那条写地址自己那几种拒绝 ----
    await ensureSidebar(page);
    // 光名字 / 路径写豁了的写法：后端会落到真文件上（这里 bare.js 只在 sub/ 里），
    // 回的那个头告诉页面它到底在会话目录哪儿——写回磁盘就照这个写，不能照链接里那个写法写
    const resolved = JSON.parse(await page.eval(`
        const sid = (document.querySelector(".session-view:not(.off) .session-pane") || { dataset: {} }).dataset.sessionId || "";
        return (async function () {
            const resp = await fetch("/file?session=" + encodeURIComponent(sid) + "&path=" + encodeURIComponent("bare.js"));
            return JSON.stringify({ status: resp.status, real: decodeURIComponent(resp.headers.get("x-file-path") || "") });
        })();
    `));
    console.log("光名字那条读地址：" + JSON.stringify(resolved));
    check("光名字的写法读到了子目录里那个文件", resolved.status === 200, String(resolved.status));
    check("回的头说清了它到底在哪儿（写回去照它写）", resolved.real === "sub/bare.js", resolved.real);

    const rejects = JSON.parse(await page.eval(`
        const sid = ${JSON.stringify(sessionId)};
        const url = function (p) { return "/file?session=" + encodeURIComponent(sid) + "&path=" + encodeURIComponent(p); };
        const post = async function (p, body) {
            const resp = await fetch(url(p), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            return resp.status;
        };
        return (async function () { return JSON.stringify({
            outside: await post(${JSON.stringify(OUTSIDE_REL)}, { text: "x" }),
            missing: await post("没有这个文件.ts", { text: "x" }),
            binary: await post(${JSON.stringify(IMAGE)}, { text: "x" }),
            noText: await post(${JSON.stringify(TS)}, { mtime: "" }),
            staleMtime: await post(${JSON.stringify(TS)}, { text: "x", mtime: "1" }),
            ok: await post(${JSON.stringify(TS)}, { text: "// 直接打地址改的\\n", mtime: "" }),
        }); })();
    `));
    console.log("直接打那条写地址：" + JSON.stringify(rejects));
    check("目录外的写法被挡回去（403）", rejects.outside === 403, String(rejects.outside));
    check("目录外那份文件一个字都没动", fs.readFileSync(path.join(SCRATCH_DIR, OUTSIDE), "utf8") === OUTSIDE_TEXT);
    check("没有这个文件（404）", rejects.missing === 404, String(rejects.missing));
    check("不是文本的文件不给改（415）", rejects.binary === 415, String(rejects.binary));
    check("没给 text（400）", rejects.noText === 400, String(rejects.noText));
    check("带上旧的 mtime、盘上已经变了（409）", rejects.staleMtime === 409, String(rejects.staleMtime));
    check("正常一版（200）", rejects.ok === 200, String(rejects.ok));
    check("那一版真写进去了", disk(TS) === "// 直接打地址改的\n", JSON.stringify(disk(TS)));

    if (failures > 0) {
        throw new Error(failures + " 处不对");
    }
    console.log("");
    console.log("全部通过。");
};

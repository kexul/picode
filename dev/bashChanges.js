// @ts-nocheck
/**
 * bashChanges —— 验「改动」那一格能看到 bash 里改的文件（不是只有 edit / write 那两条路）。
 *
 *   npm run web:shot -- --fake-pi --script dev/bashChanges.js
 *
 * 为什么要验这个：这一格以前只认 edit / write（它们在动手之前，插件手上有旧内容），
 * 用命令（sed、脚本、构建）改的文件一个都进不来。现在改成直接问会话目录所在的 git 仓库
 * （见 src/gitChanges.ts，「最近一次提交 → 现在磁盘上的样子」），谁改的都能算出来。
 * 这个脚本一个字都不经过 edit / write：全是 fs 直接动磁盘，等于“bash 里跑的程序改的”。
 *
 * 会话开在一个干净的小仓库里（那个目录每次跑之前重建，不进版本库）。
 *
 * 验的是外面看得见的行为：
 *   1. 磁盘上改一个文件：那一格长出那一行，+N −M 是对的，点开看得到 diff；
 *   2. 磁盘上新写一个文件：+N −0；
 *   3. 删掉一个文件：标「已删除」；
 *   4. .gitignore 挡在外面的（日志、图片这种）不进清单：那一格跟仓库自己的规矩走。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { SCRATCH_DIR } = require("./harness.js");

/** 会话开在这儿：干净、小，先把里面的东西提交上去当基线。 */
const WORK = path.join(SCRATCH_DIR, "bashChangesWork");
const MODIFIED = "说明.md";
const CREATED = "命令建的文件.md";
/** .gitignore 挡在外面的一个文件：改了也不该进清单。 */
const IGNORED = "跑出来的日志.log";

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "  ✓ " : "  ✗ ") + label + (detail === undefined ? "" : "：" + detail));
    if (!ok) { failures++; }
}

function rowsNow(page) {
    return page.eval(`
        const pane = document.getElementById("changePane");
        if (!pane) { return "[]"; }
        return JSON.stringify(Array.from(pane.querySelectorAll(".change-head")).map((el) => ({
            path: el.getAttribute("data-path"),
            counts: ((el.querySelector(".change-counts") || {}).textContent || "").trim(),
        })));
    `);
}

function diffNow(page) {
    return page.eval(`
        const body = document.getElementById("fileBody");
        const pane = body ? body.querySelector(".file-page.active") : null;
        const lines = pane ? Array.from(pane.querySelectorAll(".diff-line")) : [];
        const bar = document.querySelector("#fileBar .file-bar-name");
        return JSON.stringify({
            fileView: document.body.classList.contains("file-view"),
            bar: bar ? bar.textContent || "" : "",
            added: lines.filter((el) => el.classList.contains("add")).map((el) => el.textContent),
            removed: lines.filter((el) => el.classList.contains("del")).map((el) => el.textContent),
        });
    `);
}

/** 收起再打开这一列：等于让它把「改动」清单再问一遍（后端只在这时候才重新取）。 */
async function reopen(page) {
    await page.click("#fileClose");
    await page.sleep(300);
    await page.click("#fileSidebarBtn");
    await page.sleep(900);
}

async function open(page) {
    const isOpen = await page.eval(`return document.body.classList.contains("file-open");`);
    if (!isOpen) {
        await page.click("#fileSidebarBtn");
        await page.sleep(600);
    }
}

async function waitRows(page, cond, timeoutMs) {
    const started = Date.now();
    let got = [];
    while (Date.now() - started < (timeoutMs || 8000)) {
        got = JSON.parse(await rowsNow(page));
        if (cond(got)) { return got; }
        await page.sleep(250);
    }
    return got;
}

module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(600);

    // 干净的小仓库：里面这一份提交上去，就是“最后一次提交”
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(path.join(WORK, MODIFIED), "第一行\n第二行\n第三行\n", "utf8");
    fs.writeFileSync(path.join(WORK, "另一个文件.md"), "随便\n", "utf8");
    fs.writeFileSync(path.join(WORK, ".gitignore"), "*.log\n", "utf8");
    const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: WORK, stdio: "ignore" });
    git("init", "-q", ".");
    git("add", "-A");
    git("-c", "user.email=dev@example.invalid", "-c", "user.name=dev", "commit", "-qm", "基线");

    // 在这个目录里开一个新会话
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "newSessionInWorkspace", path: ${JSON.stringify(WORK)} });
        return true;
    `);
    await page.sleep(2500);
    await open(page);
    let rows = await waitRows(page, (x) => x.length === 0, 4000);
    check("刚开的时候清单是空的（跟最后一次提交一样）", rows.length === 0, JSON.stringify(rows));

    // ---- 1. 磁盘上改一行（不经过 edit / write）----
    fs.writeFileSync(path.join(WORK, MODIFIED), "第一行\n第二行改过\n第三行\n", "utf8");
    await reopen(page);
    rows = await waitRows(page, (x) => x.some((one) => one.path === MODIFIED));
    const modified = rows.find((one) => one.path === MODIFIED);
    check("命令改的文件出现在清单里", !!modified, JSON.stringify(rows));
    check("行数对得上（+1 −1）", !!modified && modified.counts.includes("+1") && modified.counts.includes("−1"),
        modified && modified.counts);
    console.log("点那一行：" + await page.eval(`
        const row = Array.from(document.querySelectorAll("#changePane .change-head"))
            .find(function (el) { return el.getAttribute("data-path") === ${JSON.stringify(MODIFIED)}; });
        if (!row) { return "清单里没有"; }
        (row.querySelector(".change-path") || row).click();
        return "点了";
    `));
    await page.sleep(900);
    const diff = JSON.parse(await diffNow(page));
    check("点开看得到那份 diff（改过的那行在里面）",
        diff.fileView && diff.bar === MODIFIED && diff.added.some((l) => l.indexOf("第二行改过") >= 0),
        JSON.stringify(diff));
    await page.eval(`document.getElementById("fileCloseFile").click(); return true;`);
    await page.sleep(600);

    // ---- 2. 磁盘上新写一个文件 ----
    fs.writeFileSync(path.join(WORK, CREATED), "甲\n乙\n", "utf8");
    await reopen(page);
    rows = await waitRows(page, (x) => x.some((one) => one.path === CREATED));
    const created = rows.find((one) => one.path === CREATED);
    check("命令建的新文件也进清单（+2 −0）", !!created && created.counts.includes("+2") && created.counts.includes("−0"),
        created && created.counts);

    // ---- 3. 删掉一个文件 ----
    fs.rmSync(path.join(WORK, MODIFIED), { force: true });
    await reopen(page);
    rows = await waitRows(page, (x) => {
        const one = x.find((it) => it.path === MODIFIED);
        return !!one && one.counts.includes("已删除");
    });
    const gone = rows.find((one) => one.path === MODIFIED);
    check("删掉的文件标「已删除」", !!gone && gone.counts.includes("已删除"), gone && gone.counts);

    // ---- 4. .gitignore 挡在外面的（日志这种）不进清单 ----
    fs.writeFileSync(path.join(WORK, IGNORED), "随便写点什么\n", "utf8");
    await reopen(page);
    await page.sleep(900);
    rows = JSON.parse(await rowsNow(page));
    check(".gitignore 挡在外面的日志不进清单", !rows.some((one) => one.path === IGNORED), JSON.stringify(rows));

    await page.shot("bash-changes.png");

    console.log("");
    console.log(failures === 0 ? "命令改的也进清单：都对上了。" : "命令改的也进清单：有 " + failures + " 条不对。");
    if (failures > 0) { throw new Error("有 " + failures + " 条不对（见上面那些 ✗）"); }
};

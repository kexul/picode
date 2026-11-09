// @ts-nocheck
/**
 * 验「选择文件夹」那一层（顶条最右那颗 <<< 下面「工作区」标题右边那颗加号开出来的，
 * 见 chatHost 的 showFolderPicker）与它里面的「新建文件夹」。
 *
 *   npm run web:shot -- --fake-pi --script dev/newFolder.js
 *
 * 这一层照资源管理器那套摆：顶上一条工具条（↑ 回上一层、＋ 新建文件夹）、
 * 清单里只有子目录、底部「取消」与「就在这里新建会话」。这一趟验这些：
 *   ① 清单里只有目录：没有「上一层」「新建文件夹」「就用这个目录」那三行，
 *     工具条上那两颗在、底部那颗主按钮在（盘符那一层没有「新建文件夹」那一颗）；
 *   ② 点「新建文件夹」就地摊一个输入框（清单最上面，不关面板、不另开一层）；
 *      Esc 只收这个框；空着回车什么也不发；
 *   ③ 名字敲好回车 → 磁盘上真建出来了，而且直接进到那个新目录里；
 *   ④ 再进一层建一个，点上头那颗 ↑ 退回上一层，两个目录都在清单里；
 *   ⑤ 重名的、名字带斜杠的建不成：留在原处，原因写在标题上；
 *   ⑥ 底部那颗「就在这里新建会话」= 在这个目录里开一个新会话，然后这一层收起。
 * 建的目录都在 dev/.scratch 里，跑完删掉；⑥ |那一下开出来的会话就跑在 .scratch 里。
 */
const fs = require("fs");
const path = require("path");

/** 页面上这一刻能看到的东西：面板开没开、标题 / 目录那两行写的什么、清单里有哪些行、工具条与页脚长什么样。 */
const LOOK = `
    const root = document.getElementById("pickerOverlay");
    const body = document.getElementById("pickerBody");
    const panel = document.getElementById("pickerPanel");
    const tools = panel.querySelector(".pk-folder-tools");
    const footer = document.getElementById("pickerFooter");
    const input = body.querySelector(".pk-newfolder-input-row input");
    return {
        open: !root.classList.contains("hidden"),
        folders: root.classList.contains("pk-folders"),
        title: (document.getElementById("pickerTitle") || {}).textContent || "",
        subtitle: (document.getElementById("pickerSubtitle") || {}).textContent || "",
        rows: Array.from(body.querySelectorAll(".pk-item")).map(function (r) { return r.textContent.trim(); }),
        toolUp: !!(tools && tools.querySelector(".pk-folder-up")),
        toolNew: !!(tools && tools.querySelector(".pk-folder-new")),
        toolLine: tools ? getComputedStyle(tools).borderBottomWidth : "(没有工具条)",
        subLine: getComputedStyle(document.getElementById("pickerSubtitle")).borderBottomWidth,
        footer: footer.classList.contains("hidden") ? "(收着)" : Array.from(footer.querySelectorAll("button")).map(function (b) { return b.textContent.trim(); }).join(" / "),
        inputRow: !!input,
        focused: !!(input && document.activeElement === input),
    };
`;

module.exports = async (page) => {
    const look = async (label) => {
        const r = JSON.parse(await page.eval(`return JSON.stringify((function () { ${LOOK} })());`));
        console.log(`${label}\n    开着：${r.open}（文件夹那层：${r.folders}）｜标题：${r.title}｜目录：${r.subtitle}`);
        console.log(`    工具条：↑ ${r.toolUp}｜新建文件夹 ${r.toolNew}（工具条下线 ${r.toolLine}，路径下线 ${r.subLine}）｜底部：${r.footer}`);
        console.log(`    清单：${JSON.stringify(r.rows.slice(0, 6))}${r.rows.length > 6 ? ` …（共 ${r.rows.length} 行）` : ""}｜输入框：${r.inputRow}${r.inputRow ? "（焦点在框里：" + r.focused + "）" : ""}`);
        return r;
    };
    /** 等到某一件事成真（面板重画是异步的：宿主那边要重新列一遍目录）。 */
    const until = async (what, check, timeoutMs = 8000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await check()) { return true; }
            if (Date.now() > deadline) { throw new Error("等了 " + Math.round(timeoutMs / 1000) + " 秒也没等到：" + what); }
            await page.sleep(150);
        }
    };
    const textOf = (id) => page.eval(`return (document.getElementById(${JSON.stringify(id)}) || {}).textContent || ""`);
    const subtitleIs = (want) => async () => (await textOf("pickerSubtitle")) === want;
    const titleHas = (want) => async () => (await textOf("pickerTitle")).indexOf(want) >= 0;

    const clickSel = async (sel, what) => {
        const ok = await page.eval(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) { return false; } el.click(); return true;`);
        if (!ok) { throw new Error("页面上没有：" + what); }
        await page.sleep(200);
    };
    const clickToolsNew = () => clickSel("#pickerPanel .pk-folder-tools .pk-folder-new", "工具条上的「新建文件夹」");
    const clickToolsUp = () => clickSel("#pickerPanel .pk-folder-tools .pk-folder-up", "工具条上的 ↑");
    /** 往摊出来的那个框里敲名字（走浏览器原生输入，跟真人敲一样）。 */
    const typeName = async (text) => {
        await page.eval(`const el = document.getElementById("pickerBody").querySelector(".pk-newfolder-input-row input"); if (!el) { return false; } el.focus(); el.select(); return true;`);
        if (text) { await page.cdp.send("Input.insertText", { text }); }
        await page.sleep(120);
    };
    const pressEnter = () => page.press("Enter");
    const pressEsc = () => page.press("Escape");

    await page.waitReady();
    await page.sleep(600);

    // ---- ① 开「选择文件夹」那一层（跟点「工作区」标题右边那颗加号一个入口） ----
    const startDir = await page.eval(`return (document.getElementById("sessionName") || { dataset: {} }).dataset.cwd || "";`);
    await page.eval(`window.acquireVsCodeApi().postMessage({ type: "workspaceBrowse" }); return true;`);
    await until("文件夹那一层开出来", subtitleIs(startDir));
    const first = await look("开出来的这一层（清单里只有目录，那三件事在工具条与底部）");
    console.log(`    是会话目录那一层吗：${first.subtitle === startDir}`);
    console.log(`    清单里干净吗（那三行都不在）：${["上一层", "新建文件夹", "就用这个目录（在这里新建会话）"].every((t) => first.rows.indexOf(t) < 0)}`);
    console.log(`    底部那两颗对吗：${first.footer === "取消 / 就在这里新建会话"}｜只有一条线吗（路径那条让给工具条）：${first.subLine === "0px" && first.toolLine !== "0px"}`);
    await page.shot("newfolder-row.png");

    // ---- ② 点工具条上那颗：清单最上面摊一个输入框；Esc 只收它 ----
    await clickToolsNew();
    const typing = await look("点过「新建文件夹」（清单最上面多一行输入框、光标已经在里面）");
    console.log(`    面板还开着吗：${typing.open}｜多了一行输入框吗：${typing.inputRow}`);
    await page.shot("newfolder-input.png");
    await pressEsc();
    await page.sleep(250);
    const escaped = await look("在框里按 Esc（框收起来，面板照旧开着）");
    console.log(`    Esc 收的是框不是面板吗：${escaped.open && !escaped.inputRow}`);

    // ---- ②b 空着回车：什么也不发，框还在 ----
    await clickToolsNew();
    await pressEnter();
    await page.sleep(400);
    const empty = await look("名字空着就回车（框还在，什么都没建）");
    console.log(`    框还在吗：${empty.inputRow}｜还在原来那一层吗：${empty.subtitle === startDir}`);

    // ---- ③ 敲个名字回车：磁盘上真建出来，而且进到里面去 ----
    const nameA = "验新建-" + Date.now().toString(36);
    const dirA = path.join(startDir, nameA);
    await typeName(nameA);
    await pressEnter();
    await until("进到新建的那个目录里", subtitleIs(dirA));
    const insideA = await look("建好之后（直接进了这个新目录，底部那颗主按钮就在那儿）");
    console.log(`    磁盘上有这个目录吗：${fs.existsSync(dirA) && fs.statSync(dirA).isDirectory()}`);
    console.log(`    空目录里那句提示在吗：${insideA.rows.indexOf("（这里没有子文件夹）") >= 0}`);
    await page.shot("newfolder-made.png");

    // ---- ④ 再进一层，然后点 ↑ 退回上一层看这两个目录 ----
    const nameB = "子目录";
    const dirB = path.join(dirA, nameB);
    await clickToolsNew();
    await typeName(nameB);
    await pressEnter();
    await until("进到第二层新目录里", subtitleIs(dirB));
    await look("第二层也建出来了");
    await clickToolsUp();
    await until("点 ↑ 退回上一层", subtitleIs(dirA));
    const backRows = await look("退回到上一层（刚建的那一层就在清单里）");
    console.log(`    清单里有「${nameB}」吗：${backRows.rows.indexOf(nameB) >= 0}`);
    await page.shot("newfolder-list.png");

    // ---- ⑤ 重名 / 带斜杠：建不成，留在原处，原因写在标题上 ----
    await clickToolsNew();
    await typeName(nameB);
    await pressEnter();
    await until("标题上写出「这里有同名的了」", titleHas("这里有同名的了"));
    const dup = await look("重名的那个（建不成）");
    console.log(`    还在原来那一层吗：${dup.subtitle === dirA}`);

    await clickToolsNew();
    await typeName("a/b");
    await pressEnter();
    await until("标题上写出「名字里不能有斜杠」", titleHas("斜杠"));
    await look("名字带斜杠的（建不成）");
    console.log(`    没顺手建出两个目录来吧：${!fs.existsSync(path.join(dirA, "a"))}`);
    await page.shot("newfolder-failed.png");

    // ---- ⑥ 底部那颗「就在这里新建会话」：在这个目录里开一个会话，然后这一层收起 ----
    await clickSel("#pickerFooter .primary", "底部那颗「就在这里新建会话」");
    await until("新会话开在这个目录里（这一层收起、顶条那一格换成新目录）", async () => {
        const cwd = await page.eval(`return (document.getElementById("sessionName") || { dataset: {} }).dataset.cwd || "";`);
        const open = await page.eval(`return !document.getElementById("pickerOverlay").classList.contains("hidden");`);
        return !open && cwd === dirA;
    }, 20000);
    console.log("点过底部那颗主按钮：这一层收起了，新会话就开在刚建的那个目录里");
    await page.shot("newfolder-session.png");

    // ---- 收尾：先把这个会话关掉（它跑在刚建的那个目录里，Windows 上进程占着当前目录就删不掉），再删目录 ----
    const sid = await page.eval(`const v = document.querySelector(".session-view:not(.off)"); return (v && v.dataset.sessionId) || "";`);
    if (sid) {
        await page.eval(`window.acquireVsCodeApi().postMessage({ type: "closeSession", sessionId: ${JSON.stringify(sid)} }); return true;`);
    }
    // 会话关掉以后 pi 还要几百毫秒才真退（Windows 上它退干净了那个目录才会松手）：等一会儿再删
    for (let i = 0; i < 20 && fs.existsSync(dirA); i += 1) {
        try { fs.rmSync(dirA, { recursive: true, force: true }); } catch { /* 还没松手，下一轮再试 */ }
        if (fs.existsSync(dirA)) { await page.sleep(500); }
    }
    console.log(`    收尾：那个会话（${sid || "没找到会话号"}）关掉了｜${dirA} 删掉了（${!fs.existsSync(dirA)}）`);
};

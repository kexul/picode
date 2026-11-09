// @ts-nocheck
/**
 * 验「选择文件夹」那一层里那颗「新建文件夹」。
 *
 *   npm run web:shot -- --fake-pi --script dev/newFolder.js
 *
 * 这一层是顶条最右那颗 <<< 下面「工作区」标题右边那颗加号开出来的（见 chatHost 的 showFolderPicker）。
 * 这一趟验这几件事：
 *   ① 每一层都有一行「新建文件夹」（盘符那一层没有：那一层没地方建）；
 *   ② 点那一行，就地摊一个输入框（不关面板、不另开一层）；Esc 只收这个框，面板照旧开着；
 *   ③ 名字敲好回车 → 磁盘上真建出来了，而且直接进到那个新目录里（第一行就是「就用这个目录」）；
 *   ④ 再进一层建一个、退回上一层，两个目录都在清单里；
 *   ⑤ 重名的、名字带斜杠的建不成：留在原处，原因写在标题上；空着回车什么也不发。
 * 建的目录都在 dev/.scratch 里，跑完删掉。
 */
const fs = require("fs");
const path = require("path");

/** 页面上这一刻能看到的东西：面板开没开、标题 / 目录那两行写的什么、清单里有哪些行、输入框在不在。 */
const LOOK = `
    const root = document.getElementById("pickerOverlay");
    const open = !root.classList.contains("hidden");
    const rows = Array.from(document.querySelectorAll("#pickerBody .pk-item"));
    const input = document.querySelector("#pickerBody .pk-newfolder-input-row input");
    return {
        open: open,
        folders: root.classList.contains("pk-folders"),
        title: (document.getElementById("pickerTitle") || {}).textContent || "",
        subtitle: (document.getElementById("pickerSubtitle") || {}).textContent || "",
        rows: rows.map(function (r) { return r.textContent.trim(); }),
        inputRow: !!document.querySelector("#pickerBody .pk-newfolder-input-row"),
        focused: !!(input && document.activeElement === input),
    };
`;

module.exports = async (page) => {
    const look = async (label) => {
        const r = JSON.parse(await page.eval(`return JSON.stringify((function () { ${LOOK} })());`));
        console.log(`${label}\n    开着：${r.open}（文件夹那层：${r.folders}）｜标题：${r.title}｜目录：${r.subtitle}`);
        console.log(`    行：${JSON.stringify(r.rows)}｜输入框：${r.inputRow}${r.inputRow ? "（焦点在框里：" + r.focused + "）" : ""}`);
        return r;
    };
    /** 等到某一件事成真（面板重画是异步的：宿主那边要重新列一遍目录）。 */
    const until = async (what, check, timeoutMs = 8000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const ok = await check();
            if (ok) { return true; }
            if (Date.now() > deadline) { throw new Error("等了 " + Math.round(timeoutMs / 1000) + " 秒也没等到：" + what); }
            await page.sleep(150);
        }
    };
    const titleIs = (want) => async () => (await page.eval(`return document.getElementById("pickerTitle").textContent`)) === want;
    const subtitleIs = (want) => async () => (await page.eval(`return document.getElementById("pickerSubtitle").textContent`)) === want;

    /** 点「新建文件夹」那一行（走真鼠标那一下：界面上就是点这一行）。 */
    const clickNewFolderRow = async () => {
        const ok = await page.eval(`const el = document.querySelector("#pickerBody .pk-item.pk-newfolder"); if (!el) { return false; } el.click(); return true;`);
        if (!ok) { throw new Error("清单里没有「新建文件夹」那一行"); }
        await page.sleep(200);
    };
    /** 往摊出来的那个框里敲名字（走浏览器原生输入，跟真人敲一样）。 */
    const typeName = async (text) => {
        await page.eval(`const el = document.querySelector("#pickerBody .pk-newfolder-input-row input"); if (!el) { return false; } el.focus(); el.select(); return true;`);
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
    const first = await look("开出来的这一层（第一行「就用这个目录」、第二行「新建文件夹」、然后是「上一层」与子目录）");
    console.log(`    是会话目录那一层吗：${first.subtitle === startDir}`);
    console.log(`    有「新建文件夹」这一行吗：${first.rows.indexOf("新建文件夹") >= 0}`);
    await page.shot("newfolder-row.png");

    // ---- ② 点那一行：就地摊一个输入框；Esc 只收它 ----
    await clickNewFolderRow();
    const typing = await look("点过「新建文件夹」（它底下多一行输入框、光标已经在里面）");
    console.log(`    面板还开着吗：${typing.open}｜多了一行输入框吗：${typing.inputRow}`);
    await page.shot("newfolder-input.png");
    await pressEsc();
    await page.sleep(250);
    const escaped = await look("在框里按 Esc（框收起来，面板照旧开着）");
    console.log(`    Esc 收的是框不是面板吗：${escaped.open && !escaped.inputRow}`);

    // ---- ②b 空着回车：什么也不发，框还在 ----
    await clickNewFolderRow();
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
    const insideA = await look("建好之后（直接进了这个新目录，第一行就是「就用这个目录」）");
    console.log(`    磁盘上有这个目录吗：${fs.existsSync(dirA) && fs.statSync(dirA).isDirectory()}`);
    console.log(`    第一行是「就用这个目录」吗：${/^就用这个目录/.test(insideA.rows[0] || "")}`);
    await page.shot("newfolder-made.png");

    // ---- ④ 再进一层，然后退回上一层看这两个目录 ----
    const nameB = "子目录";
    const dirB = path.join(dirA, nameB);
    await clickNewFolderRow();
    await typeName(nameB);
    await pressEnter();
    await until("进到第二层新目录里", subtitleIs(dirB));
    await look("第二层也建出来了");
    const back = await page.eval(`
        const rows = Array.from(document.querySelectorAll("#pickerBody .pk-item"));
        const up = rows.find(function (r) { return r.textContent.trim() === "上一层"; });
        if (!up) { return false; }
        up.click();
        return true;
    `);
    if (!back) { throw new Error("清单里没有「上一层」那一行"); }
    await until("退回上一层", subtitleIs(dirA));
    const backRows = await look("退回到上一层（刚建的那一层就在清单里）");
    console.log(`    清单里有「${nameB}」吗：${backRows.rows.indexOf(nameB) >= 0}`);
    await page.shot("newfolder-list.png");

    // ---- ⑤ 重名 / 带斜杠：建不成，留在原处，原因写在标题上 ----
    await clickNewFolderRow();
    await typeName(nameB);
    await pressEnter();
    await until("标题上写出「这里有同名的了」", async () => (await page.eval(`return document.getElementById("pickerTitle").textContent`)).indexOf("这里有同名的了") >= 0);
    const dup = await look("重名的那个（建不成）");
    console.log(`    还在原来那一层吗：${dup.subtitle === dirA}`);

    await clickNewFolderRow();
    await typeName("a/b");
    await pressEnter();
    await until("标题上写出「名字里不能有斜杠」", async () => (await page.eval(`return document.getElementById("pickerTitle").textContent`)).indexOf("斜杠") >= 0);
    await look("名字带斜杠的（建不成）");
    console.log(`    没顺手建出两个目录来吧：${!fs.existsSync(path.join(dirA, "a"))}`);
    await page.shot("newfolder-failed.png");

    // ---- 收尾：把这几层试出来的目录删掉 ----
    try { fs.rmSync(dirA, { recursive: true, force: true }); } catch { /* 删不掉就算了，是调试目录 */ }
    console.log(`    收尾：${dirA} 删掉了（${!fs.existsSync(dirA)}）`);
};

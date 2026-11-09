// @ts-nocheck
/**
 * closeSessionFiles —— 验「会话没了，长在它身上的那两块跟着收起来」。
 *
 *   npm run web:shot -- --fake-pi --script dev/closeSessionFiles.js
 *
 * 看文件的弹窗和改动层都是“这个会话的文件”：会话被关掉（别的窗口关的、或者自己点的叉）以后，
 * 屏幕上不能还留着一份点不动的它 —— 尤其那份 diff 横条上的「回滚」：点下去后端那个会话
 * 已经不在了，消息被丢掉，看着就是“点了没反应”。这里验：开着看文件的弹窗时把会话关掉，
 * 弹窗跟着收起来（改动层同一条路，但它要拖出来才开，这里只验看得见的那一个）。
 */
module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(600);
    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };

    const viewerOpen = () => page.eval(`return document.body.classList.contains("file-view");`);
    const tabCount = () => page.eval(`return document.querySelectorAll("#sessionTabs .sn-tab").length;`);

    // 让会话先跑一轮，等它落定（这样“关会话”点一下就走，不用等确认）
    await page.send("你好");
    for (let i = 0; i < 200; i++) {
        const st = await page.eval(`return (document.getElementById("ctxIcon") || {}).dataset?.st || "";`);
        if (st === "idle") { break; }
        await page.sleep(100);
    }

    // 用文件搜索打开一个文件：点一条结果就在看文件的弹窗里打开它（真路）
    for (const type of ["keyDown", "keyUp"]) {
        await page.cdp.send("Input.dispatchKeyEvent", {
            type, key: "F", code: "KeyF", modifiers: 10 /* Ctrl+Shift */,
            windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70,
        });
    }
    await page.sleep(500);
    await page.eval(`
        const input = document.getElementById("fileSearchInput");
        if (input) { input.focus(); input.value = "示例"; input.dispatchEvent(new Event("input", { bubbles: true })); }
        return true;
    `);
    await page.sleep(800);
    const rows = await page.eval(`return document.querySelectorAll("#fileSearchBody .fs-row").length;`);
    check(rows > 0, "文件搜索没出结果（这一条没法验）");
    if (rows === 0) { throw new Error("没法验：文件搜索没出结果"); }
    await page.eval(`document.querySelector("#fileSearchBody .fs-row").click(); return true;`);
    await page.sleep(600);
    check(await viewerOpen(), "点开文件搜索结果，看文件的弹窗没露面（这一条没法验）");
    console.log("  打开文件弹窗：开着=" + (await viewerOpen()));

    // 关掉这个会话：闲着，点一下 × 就走
    await page.eval(`
        const tab = document.querySelector("#sessionTabs .sn-tab.current") || document.querySelector("#sessionTabs .sn-tab");
        const close = tab ? tab.querySelector(".sn-close") : null;
        if (close) { close.click(); }
        return true;
    `);
    let closed = false;
    for (let i = 0; i < 100; i++) {
        await page.sleep(100);
        if ((await tabCount()) === 0) { closed = true; break; }
    }
    check(closed, "会话没关掉（这一条没法验）");
    await page.sleep(400);
    check(!(await viewerOpen()), "会话关掉了，看文件的弹窗还开着（那份 diff 上点回滚没人接）");
    console.log("  关掉会话：弹窗还开着=" + (await viewerOpen()));

    if (problems.length) {
        console.log("");
        console.log("有问题（" + problems.length + " 条）：");
        for (const p of problems) { console.log("  ! " + p); }
        throw new Error("会话关掉以后那两块没验过：" + problems.length + " 条");
    }
    console.log("");
    console.log("会话关掉：看文件的弹窗跟着收了。");
};

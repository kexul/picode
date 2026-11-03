// @ts-nocheck
/**
 * toolTipExpand —— 验工具标签的提示框：打开只画输入，点那一行才铺开输出。
 *
 * 为什么要这样：打开时就向后端要全文的话，正文一回来整块高矮就跳一下，读的人正看着的那一段被挤走。
 * 现在收着的那些一个字都不问，所以提示框打开之后高矮不会自己变。
 *
 * 这个脚本验这几件事：
 *   · 悬浮出来只写那几行调用（输入）：一条结果块都没有、也没有「还有 N 字没带过来」那行小字；
 *   · 就那么放着（后端那边全文留着），提示框的高矮一秒多之后跟刚打开时一样；
 *   · 点一行输入 → 这一条的输出铺开（后端只带了开头的，这一下才去取）、提示框跟着变高；
 *     别的条照旧收着；
 *   · 再点那行 → 收回去，高矮回到刚打开那一刻；
 *   · write / edit 的标题行也是这一套：点它才画 diff / 写入预览；
 *   · 关掉提示框再悬浮回来，又是只画输入（上回点开过也不记得）。
 *
 *   npm run web:shot -- --width 1000 --height 760 --script dev/toolTipExpand.js
 * 图落在 dev/shots/。
 */

/** 往页面里投一批后端消息（跟后端推给页面的形状一样）。 */
function post(page, messages) {
    return page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
}

/** 让「工具名 + 次数」那颗标签进入悬浮状态（电脑上没有触屏那一套，靠 mouseenter 触发提示框）。 */
function hoverNamed(page, name) {
    return page.eval(`
        const el = Array.from(document.querySelectorAll(".tool-row .tool-group"))
            .filter((t) => { const n = t.querySelector(".tg-name"); return n && n.textContent === " " + ${JSON.stringify(name)}; })
            .pop();
        if (!el) { throw new Error("页面上没有这个标签：" + ${JSON.stringify(name)}); }
        el.dispatchEvent(new MouseEvent("mouseenter"));
        return true;
    `);
}

/** 鼠标离开那颗标签（提示框宽限片刻才收，跟真人移开手一样）。 */
function leaveNamed(page, name) {
    return page.eval(`
        const el = Array.from(document.querySelectorAll(".tool-row .tool-group"))
            .filter((t) => { const n = t.querySelector(".tg-name"); return n && n.textContent === " " + ${JSON.stringify(name)}; })
            .pop();
        if (el) { el.dispatchEvent(new MouseEvent("mouseleave")); }
        return true;
    `);
}

/** 提示框现在的样子：高矮、有几行输入、铺开了几条结果、那行「没带过来」的小字在不在、写着什么。 */
function tipState(page) {
    return page.eval(`
        const el = document.querySelector(".tag-tip");
        if (!el || el.classList.contains("hidden")) { return JSON.stringify({ open: false }); }
        const r = el.getBoundingClientRect();
        return JSON.stringify({
            open: true,
            width: Math.round(r.width),
            height: Math.round(r.height),
            inputs: el.querySelectorAll(".tag-tip-click").length,
            outputs: el.querySelectorAll(".tag-tip-result").length,
            clips: el.querySelectorAll(".tag-tip-clip").length,
            diffs: el.querySelectorAll(".edit-diff").length,
            previews: el.querySelectorAll(".tc-args").length,
            text: el.textContent.replace(/\\s+/g, " ").trim(),
        });
    `);
}

const LONG_PREFIX = "第 1 行：这一段只是开头，全文留在后端\n第 2 行：慢慢看\n第 3 行：差不多了";

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];
    const need = (ok, why) => { if (!ok) { problems.push(why); } };
    const state = async () => JSON.parse(await tipState(page));

    // ---- 第一批：两条 bash（结果只带开头，全文留在后端）+ 一条 edit ----
    await post(page, [
        { type: "assistantFull", text: "先看两处：" },
        { type: "tool", toolName: "bash", args: { command: "git status --short" }, toolCallId: "b1" },
        { type: "tool", toolName: "bash", args: { command: "npm run compile" }, toolCallId: "b2" },
        { type: "toolResult", toolCallId: "b1", isError: false, durationMs: 120, resultText: LONG_PREFIX, resultOmitted: 5120, detailKey: "detail-b1" },
        { type: "toolResult", toolCallId: "b2", isError: false, durationMs: 40, resultText: " M media/chat.js" },
        {
            type: "editCardStart", toolCallId: "e1", toolName: "edit", path: "media/chat.js", label: "media/chat.js",
            args: { path: "media/chat.js", oldText: "a", newText: "b" },
        },
        { type: "editCardResult", toolCallId: "e1", diff: "- 1 const a = 1;\n+ 1 const a = 2;", canRevert: true },
        { type: "assistantFull", text: "改完了。" },
    ]);
    await page.sleep(400);

    // ---- 一、悬浮：只画输入 ----
    await hoverNamed(page, "bash");
    await page.sleep(600);
    const opened = await state();
    console.log("\n一、悬浮出来（只画输入）：\n  高 " + opened.height + "，输入 " + opened.inputs + " 行，铺开的结果 " + opened.outputs
        + " 块，「没带过来」小字 " + opened.clips + " 条\n  写着：" + opened.text);
    await page.shot("tip-input-only.png");
    need(opened.open, "悬浮之后提示框没出来");
    need(opened.outputs === 0, "刚打开就把结果铺开了（该只画输入）：" + JSON.stringify(opened));
    need(opened.clips === 0, "刚打开就写了「还有 N 字没带过来」（那说明正在取，高矮会跳）：" + JSON.stringify(opened));

    // ---- 二、就那么放着：高矮不许自己变 ----
    await page.sleep(1400);
    const still = await state();
    console.log("\n二、放一秒多（高矮该一点没变）：\n  高 " + still.height + "（刚打开时 " + opened.height + "）");
    need(still.height === opened.height, "打开之后高矮自己变了（" + opened.height + " → " + still.height + "），读的人会被挤走");

    // ---- 三、点第一条输入：这一条铺开，别的照旧收着 ----
    await page.eval(`const el = document.querySelectorAll(".tag-tip .tag-tip-click")[0];
        el.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true;`);
    await page.sleep(800);
    const expanded = await state();
    console.log("\n三、点了第一条输入（这一条的输出铺开，第二条还收着）：\n  高 " + expanded.height + "，铺开的结果 "
        + expanded.outputs + " 块，「没带过来」小字 " + expanded.clips + " 条\n  写着：" + expanded.text);
    await page.shot("tip-row-expanded.png");
    need(expanded.outputs === 1, "点了那一行没把它自己的输出铺开：" + JSON.stringify(expanded));
    need(expanded.height > opened.height, "铺开了输出，提示框却没变高（" + opened.height + " → " + expanded.height + "）");
    need(expanded.text.includes("第 1 行"), "铺开之后没看到那一条的结果内容：" + expanded.text);

    // ---- 四、再点一下：收回去，回到刚打开时的样子 ----
    await page.eval(`const el = document.querySelectorAll(".tag-tip .tag-tip-click")[0];
        el.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true;`);
    await page.sleep(200);
    const collapsed = await state();
    console.log("\n四、再点一下（收回去，高矮回到刚打开那一刻）：\n  高 " + collapsed.height + "，铺开的结果 " + collapsed.outputs + " 块");
    need(collapsed.outputs === 0, "再点一下没把输出收回去：" + JSON.stringify(collapsed));
    need(collapsed.height === opened.height, "收回去之后高矮跟刚打开时不一样（" + opened.height + " → " + collapsed.height + "）");
    await leaveNamed(page, "bash");
    await page.sleep(300);

    // ---- 五、write / edit 的标题行：点它才画 diff ----
    await hoverNamed(page, "edit");
    await page.sleep(600);
    const editOpened = await state();
    console.log("\n五、edit 的提示框（开头只写改了哪个文件）：\n  高 " + editOpened.height + "，diff " + editOpened.diffs + " 块\n  写着：" + editOpened.text);
    need(editOpened.open, "edit 那颗标签悬浮之后提示框没出来");
    need(editOpened.diffs === 0, "edit 的提示框一打开就把 diff 画出来了（该点标题行才画）：" + JSON.stringify(editOpened));
    await page.eval(`const el = document.querySelectorAll(".tag-tip .tag-tip-click")[0];
        el.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true;`);
    await page.sleep(300);
    const editOpen = await state();
    console.log("  点了标题行（diff 铺开）：高 " + editOpen.height + "，diff " + editOpen.diffs + " 块");
    await page.shot("tip-edit-expanded.png");
    need(editOpen.diffs === 1, "点了 edit 那条的标题行没画 diff：" + JSON.stringify(editOpen));
    await leaveNamed(page, "edit");
    await page.sleep(400);

    // ---- 六、关掉再悬浮回来：又是只画输入 ----
    await hoverNamed(page, "bash");
    await page.sleep(600);
    const reopened = await state();
    console.log("\n六、关掉再悬浮回来（上回点开过也不记得）：\n  铺开的结果 " + reopened.outputs + " 块，高 " + reopened.height);
    need(reopened.outputs === 0, "重新悬浮时还记着上回铺开的状态：" + JSON.stringify(reopened));
    need(reopened.height === opened.height, "重新悬浮时的高矮跟第一次打开不一样（" + opened.height + " → " + reopened.height + "）");
    await leaveNamed(page, "bash");

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

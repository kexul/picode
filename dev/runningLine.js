// @ts-nocheck
/**
 * runningLine —— 验消息流末尾那条「正在跑」的（贴在当前这批工具标签下面）。
 *
 * 工具标签只说得出工具名（命令行、读哪个文件、grep 找什么都在提示框里）；这一条把摘要直接写出来。
 * 真让模型按剧本一条条工具这么跑不好凑，这里直接往页面里投工具调用消息（跟后端推的是同一种消息）。
 * 退场是分两步的（一串很快跑完的调用不该让它一闪一闪）：一条都不在跑之后先把字留 300 毫秒
 * （下一批能接上），到点淡出去，位置还占着，直到下面出了正文 / 问话卡片、或者这一轮跑完。一次验这几件事：
 *   · 在跑的调用 → 标签下面一条「$ 命令」（read 是「read 哪个文件」、edit 是「edit 哪个文件」）；
 *   · 同时跑两条 → 一条一行，顺序跟着标签走；跑完一条只少一条；
 *   · 一条都不在跑 → 先留着字，过一会儿淡出去（不是一下没了）；位置一直留到这一批过去（下面出正文 / 这一轮跑完）；
 *   · 一串 60 毫秒跑完的调用连着来 → 这条只出现一次、一次没被摘掉，只是换名字，下面一次都不跳；
 *   · think（思考）与 ask_choice（问话卡片）不出这条；
 *   · 跑着的时候又来了正文 → 这条仍在它那批标签下面；之后又开了一批标签 → 跟着挪到新那批下面。
 *   · 整屏重画（刷新页面 / 重连后重放历史）：历史里那条还没结果的调用重放出来后，这条也在（只一条）。
 *
 *   npm run web:shot -- --width 900 --height 620 --script dev/runningLine.js
 * 图落在 dev/shots/。
 */

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];

    /** 这条「正在跑」的现状：一条条写着什么（藏起来的不算）、转圈的有几个、贴在谁下面、是不是消息流末尾。
     *  hasNode：这个盒子还在不在页面上 —— 一条都不在跑之后它是先清字、位置还留着（见 chat.js 里
     *  syncRunningLine / endRunningLine 那段说明），所以「字没了」跟「位置没了」是两回事。 */
    const state = () => page.eval(`
        const pane = document.querySelector(".session-pane");
        const line = pane ? pane.querySelector(".tool-running") : null;
        const shown = line
            ? Array.from(line.querySelectorAll(".tool-running-item")).filter((el) => getComputedStyle(el).visibility !== "hidden")
            : [];
        const prev = line ? line.previousElementSibling : null;
        const next = line ? line.nextElementSibling : null;
        return {
            hasNode: Boolean(line),
            items: shown.map((el) => el.textContent.trim()),
            spin: shown.filter((el) => el.querySelector(".tool-icon")).length,
            afterRow: Boolean(prev) && prev.classList.contains("tool-row"),
            afterText: Boolean(prev) && prev.classList.contains("assistant"),
            beforeEndHint: Boolean(next) && next.classList.contains("msg-endhint"),
            lastName: Boolean(line) && pane.lastElementChild === line,
        };
    `);
    const post = (messages) => page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
    const show = (s) => "盒子还在=" + s.hasNode + " items=" + JSON.stringify(s.items) + " 转圈=" + s.spin
        + " 贴工具行下面=" + s.afterRow + " 贴正文下面=" + s.afterText + " 在末尾胶囊前面=" + s.beforeEndHint;

    // ---- 第一幕：一条还在跑（带部分结果）→ 标签下面写出它的命令 ----
    await post([
        { type: "assistantFull", text: "先把要动的地方看一遍：" },
        { type: "tool", toolName: "bash", args: { command: "npm run compile" }, toolCallId: "a1" },
        { type: "toolResultUpdate", toolCallId: "a1", resultText: "正在编译…", durationMs: 400 },
    ]);
    await page.sleep(300);
    let s = await state();
    console.log("第一幕（一条 bash 还在跑）：\n  " + show(s));
    if (JSON.stringify(s.items) !== JSON.stringify(["$ npm run compile"])) { problems.push("在跑的那条 bash 没把命令行写出来：" + JSON.stringify(s.items)); }
    if (!s.afterRow) { problems.push("这条没贴在工具标签下面"); }
    if (s.spin !== 1) { problems.push("这条里的齿轮没转圈"); }

    // ---- 第二幕：同时跑两条（read + bash）→ 一条一行，顺序跟着标签走 ----
    await post([
        { type: "tool", toolName: "read", args: { path: "media/chat.js" }, toolCallId: "a2" },
    ]);
    await page.sleep(200);
    s = await state();
    console.log("\n第二幕（又一条 read 在跑，两条同时）：\n  " + show(s));
    if (JSON.stringify(s.items) !== JSON.stringify(["$ npm run compile", "read media/chat.js"])) { problems.push("同时在跑的两条没各占一行、或摘要不对：" + JSON.stringify(s.items)); }
    // 齿轮要对齐：这条里的齿轮跟上面那排标签里的齿轮得在同一条竖线上。
    // 量的是中心（齿轮在转，转着的盒子四周会变，只有中心不动）。
    const gears = await page.eval(`
        const pill = document.querySelector(".session-pane .tool-row .tool .tool-icon");
        const item = document.querySelector(".session-pane .tool-running .tool-running-item .tool-icon");
        if (!pill || !item) { return null; }
        const mid = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
        return { dx: Math.round((mid(item) - mid(pill)) * 100) / 100 };
    `);
    console.log("   齿轮对位（这条跟上面标签里那颗比，同一竖线上就是 0）：dx=" + (gears && gears.dx));
    if (!gears || Math.abs(gears.dx) > 0.5) { problems.push("这条里的齿轮没跟上面标签里那颗对齐：" + JSON.stringify(gears)); }

    // ---- 第三幕：read 回来了 → 只少它自己那一行，bash 还在 ----
    await post([{ type: "toolResult", toolCallId: "a2", isError: false, resultText: "…（40 行）", durationMs: 60 }]);
    await page.sleep(200);
    s = await state();
    console.log("\n第三幕（read 跑完，bash 还在跑）：\n  " + show(s));
    if (JSON.stringify(s.items) !== JSON.stringify(["$ npm run compile"])) { problems.push("一条跑完没能只收掉它自己那一行：" + JSON.stringify(s.items)); }

    // ---- 第四幕：跑着的时候又来了一段正文 → 这条仍贴在它那批标签下面（正文排在它后面）----
    await post([{ type: "assistantFull", text: "顺手把上面那条结果也说一句。" }]);
    await page.sleep(300);
    s = await state();
    console.log("\n第四幕（bash 还在跑，中间来了一段正文）：\n  " + show(s));
    if (!s.afterRow) { problems.push("来了正文之后，这条没留在它那批标签下面：" + JSON.stringify(s)); }
    const textAfter = await page.eval(`
        const line = document.querySelector(".session-pane .tool-running");
        const next = line ? line.nextElementSibling : null;
        return Boolean(next) && next.classList.contains("assistant");
    `);
    if (!textAfter) { problems.push("正文没排在这条后面（它该跟住它那批标签）：" + JSON.stringify(s)); }

    // ---- 第五幕：正文之后又开了一批标签 → 这条挪到新那批下面 ----
    await post([{ type: "tool", toolName: "grep", args: { pattern: "tool-running", path: "media" }, toolCallId: "a3" }]);
    await page.sleep(200);
    s = await state();
    console.log("\n第五幕（正文之后又是一批工具调用）：\n  " + show(s));
    if (!s.afterRow || !s.beforeEndHint) { problems.push("新一批标签上来之后，这条没挪到它下面：" + JSON.stringify(s)); }
    if (JSON.stringify(s.items) !== JSON.stringify(["$ npm run compile", "grep /tool-running/ in media"])) { problems.push("新一批里的那条没写进这条：" + JSON.stringify(s.items)); }
    await page.shot("running-line.png");

    // ---- 第六幕：think 与 ask_choice 都不出这条 ----
    await post([
        { type: "toolResult", toolCallId: "a1", isError: false, resultText: "编译完成", durationMs: 3200 },
        { type: "toolResult", toolCallId: "a3", isError: false, resultText: "media/chat.css:212", durationMs: 200 },
        { type: "thinkingStart" },
        { type: "tool", toolName: "ask_choice", args: { question: "选一个", options: ["甲", "乙"] }, toolCallId: "a4" },
    ]);
    await page.sleep(500);   // 过了留字那 300 毫秒再看
    s = await state();
    console.log("\n第六幕（think 与 ask_choice 都在转圈，别的都跑完了）：\n  " + show(s));
    if (s.items.length !== 0) { problems.push("think / ask_choice 不该出这条（别的都跑完了就该把字清掉）：" + JSON.stringify(s.items)); }
    if (!s.hasNode) { problems.push("这一批还没过去（下面没出别的东西），这条的位置就先没了：" + JSON.stringify(s)); }

    // ---- 第七幕：write / edit 在跑 → 也写出来（改的是哪个文件）----
    await post([
        { type: "toolResult", toolCallId: "a4", isError: false, resultText: "选了「甲」", durationMs: 2000 },
        { type: "editCardStart", toolCallId: "a5", toolName: "edit", path: "media/chat.css", label: "media/chat.css", args: { path: "media/chat.css", oldText: "a", newText: "b" } },
    ]);
    await page.sleep(300);
    s = await state();
    console.log("\n第七幕（一条 edit 在跑）：\n  " + show(s));
    if (JSON.stringify(s.items) !== JSON.stringify(["edit media/chat.css"])) { problems.push("在跑的 edit 没写出来：" + JSON.stringify(s.items)); }
    await page.shot("running-line-edit.png");

    // ---- 第八幕：还在跑的那条结果带图（read 读图）→ 它从这条里也摘掉；字先留着，位置留到这一批过去 ----
    await post([{ type: "editCardResult", toolCallId: "a5", diff: "", canRevert: false }]);
    await post([
        { type: "tool", toolName: "read", args: { path: "示例图片.png" }, toolCallId: "a6" },
        {
            type: "toolResult", toolCallId: "a6", isError: false, durationMs: 60,
            resultText: "Read image file [image/png]",
            images: [{ data: require("fs").readFileSync(require("path").join(__dirname, ".scratch", "示例图片.png")).toString("base64").slice(0, 4), mimeType: "image/png" }],
        },
    ]);
    await page.sleep(120);   // 留字那 300 毫秒还没到：一条都不在跑了，字该还挂着（下一批才能接上）
    s = await state();
    console.log("\n第八幕（读图那条结果回来、铺成一整块图）：\n   刚跑完 120 毫秒：" + show(s));
    if (JSON.stringify(s.items) !== JSON.stringify(["read 示例图片.png"])) { problems.push("一条都不在跑了之后，这条没把字先留着（一串快调用靠它接上）：" + JSON.stringify(s.items)); }
    await page.sleep(210);   // 留字那 300 毫秒过去了：开始淡出（150 毫秒）
    const fading = await page.eval(`
        const el = document.querySelector(".session-pane .tool-running .tool-running-item");
        if (!el) { return null; }
        const cs = getComputedStyle(el);
        return { opacity: Math.round(Number(cs.opacity) * 100) / 100, h: el.offsetHeight, visibility: cs.visibility };
    `);
    console.log("   淡出中（刚过留字那一段）：透明到 " + (fading && fading.opacity) + "、这条还高 " + (fading && fading.h) + "px、visibility=" + (fading && fading.visibility));
    if (!fading || fading.visibility === "hidden" || !(fading.opacity > 0)) { problems.push("字不是淡出去的（到点就是一下没了）：" + JSON.stringify(fading)); }
    if (!fading || fading.h <= 0) { problems.push("淡出的时候这条不占位置了（下面要跟着跳）：" + JSON.stringify(fading)); }
    await page.sleep(200);   // 淡完了
    s = await state();
    console.log("   淡完了（这一批还没过去，下面还没正文）：" + show(s));
    if (s.items.length !== 0) { problems.push("过了留字那一段、也淡完了，这条上的字还在：" + JSON.stringify(s.items)); }
    if (!s.hasNode) { problems.push("这一批还没过去（下面还没出正文），这条的位置就先收了 —— 下一条工具一来又得重开，下面要跳一下：" + JSON.stringify(s)); }
    // 下面出正文（这一批工具过去了）→ 连位置一起收掉
    await post([{ type: "assistantFull", text: "这张图看完了。" }]);
    await page.sleep(200);
    s = await state();
    console.log("   下面出了正文：" + show(s));
    if (s.hasNode) { problems.push("下面出了正文（这一批过去了），这条的位置还留着：" + JSON.stringify(s)); }

    // ---- 第九幕：整屏重画（刷新页面 / 重连时重放历史）→ 历史里那条还没结果的调用重放出来后，这条也在 ----
    await post([{ type: "clear", keepDraft: true }]);
    await post([
        { type: "assistantFull", text: "重放：这句话之前调过一次 bash。" },
        { type: "tool", toolName: "bash", args: { command: "npm test" }, toolCallId: "b1" },
        { type: "tool", toolName: "bash", args: { command: "git status" }, toolCallId: "b2" },
        { type: "toolResult", toolCallId: "b1", isError: false, resultText: "53 个测试都过了", durationMs: 900 },
    ]);
    await page.sleep(400);
    s = await state();
    const lines = await page.eval(`return document.querySelectorAll(".session-pane .tool-running").length;`);
    console.log("\n第九幕（整屏重画，历史里还留着一条没结果的 bash）：\n  " + show(s) + " 这行的个数=" + lines);
    if (JSON.stringify(s.items) !== JSON.stringify(["$ git status"])) { problems.push("重放之后这条没跟上（该只剩那条没结果的）：" + JSON.stringify(s.items)); }
    if (lines !== 1) { problems.push("重放之后这条出现了不止一个（该只有一个）：" + lines); }
    // 这一条也收尾，免得它跟着进下一幕
    await post([{ type: "toolResult", toolCallId: "b2", isError: false, resultText: "", durationMs: 900 }]);
    await page.sleep(100);

    // ---- 第十幕：一串很快跑完的调用不该让这条一闪一闪 ----
    // 连着读几个文件（每条 60 毫秒跑完、紧接着下一条）就是这样：这条该只出现一次、一直写着，
    // 只是换个文件名；位置一次都不动，下面不跟着上下跳。
    // 怎么量「下面动不动」：先把消息流撑长到能滚，再盯着滚动高度 —— 跳一次它就变一次。
    await post([{ type: "assistantFull", text: Array.from({ length: 80 }, (_, i) => "第 " + i + " 行，用来把消息流撑长一点。").join("\n\n") }]);
    await page.sleep(300);
    await page.eval(`
        const pane = document.querySelector(".session-pane");
        window.__flick = { add: 0, remove: 0, h: [] };
        const note = () => window.__flick.h.push(pane.scrollHeight);
        new MutationObserver((records) => {
            for (const r of records) {
                for (const n of r.addedNodes) { if (n.nodeType === 1 && n.classList.contains("tool-running")) { window.__flick.add++; } }
                for (const n of r.removedNodes) { if (n.nodeType === 1 && n.classList.contains("tool-running")) { window.__flick.remove++; } }
            }
            note();
        }).observe(pane, { childList: true, subtree: true });
        return true;
    `);
    const written = [];
    for (let i = 0; i < 6; i++) {
        await post([{ type: "tool", toolName: "read", args: { path: "文件" + i + ".ts" }, toolCallId: "f" + i }]);
        await page.sleep(60);
        await post([{ type: "toolResult", toolCallId: "f" + i, isError: false, resultText: "…", durationMs: 60 }]);
        await page.sleep(20);
        written.push((await state()).items.join(" | "));
    }
    const flick = await page.eval("return window.__flick;");
    const moves = flick.h.filter((h, i) => i === 0 || h !== flick.h[i - 1]).length - 1;
    console.log("\n第十幕（连着 6 条快调用，每条 60 毫秒跑完）：");
    console.log("   这条被挂上页面 " + flick.add + " 次、被摘掉 " + flick.remove + " 次；滚动高度变了 " + moves + " 次");
    console.log("   每一步写着：" + JSON.stringify(written));
    if (flick.add !== 1 || flick.remove !== 0) { problems.push("一串快调用把这条挂上 / 摘下了好几回（一闪一闪）：挂上 " + flick.add + " 次、摘下 " + flick.remove + " 次"); }
    if (moves !== 0) { problems.push("一串快调用让下面的内容上下跳了 " + moves + " 次（位置该一直不动）：滚动高度出现过 " + JSON.stringify(Array.from(new Set(flick.h))) + "）"); }
    const wantWritten = ["read 文件0.ts", "read 文件1.ts", "read 文件2.ts", "read 文件3.ts", "read 文件4.ts", "read 文件5.ts"];
    if (JSON.stringify(written) !== JSON.stringify(wantWritten)) { problems.push("这条没跟着一条条换名字（该一直写着当前那条）：" + JSON.stringify(written)); }
    await page.shot("running-line-burst.png");

    // ---- 第十一幕：这一轮跑完（streamEnd）→ 字先清掉、位置也一并收掉 ----
    await page.sleep(400);
    s = await state();
    console.log("\n第十一幕（快调用跑完、过了留字那一段）：\n  " + show(s));
    if (s.items.length !== 0 || !s.hasNode) { problems.push("快调用跑完后该只把字清掉、位置还留着：" + JSON.stringify(s)); }
    await post([{ type: "streamEnd" }]);
    await page.sleep(200);
    s = await state();
    console.log("   这一轮跑完（streamEnd）：" + show(s));
    if (s.hasNode) { problems.push("这一轮跑完了，这条的位置还留着：" + JSON.stringify(s)); }

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

// @ts-nocheck
/**
 * runningLine —— 验消息流末尾那条「正在跑」的（贴在当前这批工具标签下面）。
 *
 * 工具标签只说得出工具名（命令行、读哪个文件、grep 找什么都在提示框里）；这一条把摘要直接写出来，
 * 跑完就少一条、全跑完整条连节点一起收掉。真让模型按剧本一条条工具这么跑不好凑，
 * 这里直接往页面里投工具调用消息（跟后端推的是同一种消息）。一次验这几件事：
 *   · 在跑的调用 → 标签下面一条「$ 命令」（read 是「read 哪个文件」、edit 是「edit 哪个文件」）；
 *   · 同时跑两条 → 一条一行，顺序跟着标签走；跑完一条只少一条；
 *   · 全跑完 → 整条连节点一起没；
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

    /** 这条「正在跑」的现状：一条条写着什么、转圈的有几个、贴在谁下面、是不是消息流末尾。 */
    const state = () => page.eval(`
        const pane = document.querySelector(".session-pane");
        const line = pane ? pane.querySelector(".tool-running") : null;
        const items = line ? Array.from(line.querySelectorAll(".tool-running-item")) : [];
        const prev = line ? line.previousElementSibling : null;
        const next = line ? line.nextElementSibling : null;
        return {
            items: items.map((el) => el.textContent.trim()),
            spin: items.filter((el) => el.querySelector(".tool-icon")).length,
            afterRow: Boolean(prev) && prev.classList.contains("tool-row"),
            afterText: Boolean(prev) && prev.classList.contains("assistant"),
            beforeEndHint: Boolean(next) && next.classList.contains("msg-endhint"),
            lastName: Boolean(line) && pane.lastElementChild === line,
        };
    `);
    const post = (messages) => page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
    const show = (s) => "items=" + JSON.stringify(s.items) + " 转圈=" + s.spin
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
    await page.sleep(300);
    s = await state();
    console.log("\n第六幕（think 与 ask_choice 都在转圈，别的都跑完了）：\n  " + show(s));
    if (s.items.length !== 0) { problems.push("think / ask_choice 不该出这条（别的都跑完了就该整条收掉）：" + JSON.stringify(s.items)); }

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

    // ---- 第八幕：还在跑的那条结果带图（read 读图）→ 它从这条里也摘掉，整条跟着收 ----
    await post([{ type: "editCardResult", toolCallId: "a5", diff: "", canRevert: false }]);
    await post([
        { type: "tool", toolName: "read", args: { path: "示例图片.png" }, toolCallId: "a6" },
        {
            type: "toolResult", toolCallId: "a6", isError: false, durationMs: 60,
            resultText: "Read image file [image/png]",
            images: [{ data: require("fs").readFileSync(require("path").join(__dirname, "..", "示例图片.png")).toString("base64").slice(0, 4), mimeType: "image/png" }],
        },
    ]);
    await page.sleep(300);
    s = await state();
    const gone = await page.eval(`return !document.querySelector(".session-pane .tool-running");`);
    console.log("\n第八幕（在读图的那条结果回来、要铺成一整块图）：\n   整条还在吗=" + !gone);
    if (!gone) { problems.push("读图那条不在跑了，这条却没收掉：" + JSON.stringify(s.items)); }

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

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

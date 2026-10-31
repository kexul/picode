// @ts-nocheck
/**
 * toolMerge —— 验"同一个名字的工具调用收成一个标签"。
 *
 * 真让模型按剧本一口气调一堆工具不好凑，这里直接往页面里投工具调用消息（跟后端推的是同一种消息），
 * 一次验这几件事：
 *   · 同一个名字一个标签（工具名 + 一个写着次数的小方块，这批里一共调了几次，只调一次就不写数字）；
 *     名字不同 → 各占一个；中间夹了别的调用（不同名的）不影响它攒数；
 *   · 鼠标停上去 → 提示框里一条条列出各条的调用与结果；
 *   · 结果乱序回来、有的失败、有一条还在跑 → 各自归位，标签上跟着转圈（失败不标红，只在提示框里看）；
 *   · taba（点名不合并）单独一个；codemode 跟别的工具一样收成一个（带次数）；
 *   · write / edit 也照这一套收（标签上只有工具名和次数）：改了哪个文件、diff / 写入预览、
 *     跳转 / 回滚都在提示框里，一条调用一块；
 *   · 结果带图的 read → 从组里摘出去，在对话里铺成一整块图（组里剩几条，小方块里的数字跟着重算）；
 *     图排在它那条调用所在那一批的位置上（后面接着调的、后面才到的正文都在图下面），不往消息流末尾扔。
 *
 *   npm run web:shot -- --width 1000 --height 760 --script dev/toolMerge.js
 * 图落在 dev/shots/。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/** 读图片块用的示例图（用 dev/makePng.js 现生成一张，跟调试会话里那张一样）。 */
const tmpPng = path.join(os.tmpdir(), "pichat-toolmerge-sample.png");
require("./makePng.js").writeSamplePng(tmpPng, 900, 240);
const PNG_BASE64 = fs.readFileSync(tmpPng).toString("base64");

/** 往页面里投一批后端消息（跟 webChat/扩展推给页面的形状一样）。 */
function post(page, messages) {
    return page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
}
/** 页面上每一块都长什么样：工具行里各标签的文字、图片块的说明行、正文块。 */
function dump(page) {
    return page.eval(`
        const rows = [];
        const tagText = (el) => el.textContent.trim().replace(/\\s+/g, " ");
        for (const pane of document.querySelectorAll(".session-view:not(.off) .session-pane")) {
            for (const el of pane.children) {
                const cls = el.className || "";
                if (cls.indexOf("tool-row") >= 0) {
                    rows.push("工具行：" + Array.from(el.children).map((c) => "[" + tagText(c)
                        + (c.classList.contains("running") ? " 转圈" : "")
                        + (c.classList.contains("reverted") ? " 划掉" : "") + "]").join(""));
                } else if (cls.indexOf("tool-image-block") >= 0) {
                    rows.push("图片块：" + el.querySelector(".tib-text").textContent.trim());
                } else if (cls.indexOf("assistant") >= 0) {
                    rows.push("正文：" + el.textContent.trim().slice(0, 20));
                }
            }
        }
        return rows.join(" | ");
    `);
}
const call = (id, toolName, args) => ({ type: "tool", toolName, args, toolCallId: id });
const done = (id, resultText, isError) => ({ type: "toolResult", toolCallId: id, isError: !!isError, resultText, durationMs: 120 });
/** write / edit 的一次调用：开始一条、结果一条（跟后端推的是同一种消息，见 editTracker）。
 *  extra 里可以给 isError / errorText / canRevert。 */
const editStart = (id, toolName, file, args) => ({
    type: "editCardStart", toolCallId: id, toolName, path: file, label: file,
    args: args || { path: file, oldText: "a", newText: "b" },
});
const editDone = (id, diff, extra) => Object.assign({ type: "editCardResult", toolCallId: id, diff, canRevert: true }, extra || {});
const editCard = (id, toolName, file) => ([editStart(id, toolName, file), editDone(id, "", { canRevert: false })]);

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];

    // ---- 第一幕：连着 4 条同名（bash）→ 一个标签；结果乱序、其中一条失败、最后一条还在跑 ----
    await post(page, [
        { type: "assistantFull", text: "先把要动的地方看一遍：" },
        call("a1", "bash", { command: "git status --short" }),
        call("a2", "bash", { command: "git diff --stat" }),
        call("a3", "bash", { command: "npm run compile" }),
        { type: "toolResult", toolCallId: "a3", isError: true, resultText: "src/chatViewProvider.ts(12,3): error TS2304: 找不到名称「x」。", durationMs: 3200 },
        done("a1", " M media/chat.js\n M media/chat.css"),
        done("a2", " media/chat.js | 40 +++---\n media/chat.css |  5 ++"),
        // 还在跑的一条（带部分结果）：方块里的数字接着涨、齿轮转圈，提示框里那一条显示部分结果
        call("a4", "bash", { command: "npm test" }),
        { type: "toolResultUpdate", toolCallId: "a4", resultText: "✔ 53 个测试都过了\n（还在跑…）", durationMs: 400 },
    ]);
    await page.sleep(300);
    // 鼠标停上去看提示框：跟单个标签一个触发方式（见 attachTagTipHandlers）
    await hover(page, ".tool-group");
    await page.sleep(500);
    await page.shot("merge-tip.png");
    await leave(page, ".tool-group");
    await page.sleep(300);
    console.log("第一幕（连着 4 条同名，结果乱序、一条失败、最后一条还在跑）——标签上应该写 bash 加一个「4」的方块：\n" + await dump(page));

    // ---- 第二幕：同名的并成一个、不同名的各占一个（中间夹了别的调用也照样攒数）----
    await post(page, [
        call("b1", "grep", { pattern: "tool-group", path: "media" }),
        call("b2", "grep", { pattern: "tg-count", path: "media" }),
        call("b3", "read", { path: "media/chat.js", offset: 1060, limit: 40 }),
        call("b4", "grep", { pattern: "syncGroupTag", path: "media" }),
        call("b5", "ls", { path: "src" }),
        done("b1", "media/chat.js:12"),
        done("b2", "media/chat.css:165"),
        done("b3", "…（40 行）"),
        done("b4", "media/chat.js:1135"),
        done("b5", "chatViewProvider.ts\ntabaBridgeSource.ts"),
    ]);
    console.log("\n第二幕（grep,grep,read,grep,ls —— 同名的一个标签，不同名各占一个）：\n" + await dump(page));

    // ---- 第三幕：codemode 跟普通工具一样收成一个（带次数），只剩 taba 单独一个 ----
    await post(page, [
        call("c1", "codemode", { code: "return 1" }),
        call("c2", "bash", { command: "node scripts/compile.mjs --check" }),
        call("c3", "bash", { command: "npm run compile" }),
        ...editCard("c4", "edit", "media/chat.css"),
        call("c5", "bash", { command: "git diff --stat" }),
        call("c6", "codemode", { code: "return 2" }),
        call("c7", "taba", { name: "侦察: 工具调用显示", task: "看一遍 chat.js" }),
        call("c8", "find", { pattern: "**/*.md", path: "dev" }),
        done("c1", "1"),
        done("c2", "文件在"),
        done("c3", "编译完成"),
        done("c5", " media/chat.js | 40 +++---"),
        done("c6", "2"),
        done("c7", "派了子会话（假数据，没真派）"),
        done("c8", "dev/README.md"),
    ]);
    console.log("\n第三幕（codemode,bash,bash,edit,bash,codemode,taba,find —— 两个 codemode 和三个 bash 各算一起，taba 单独一个）：\n" + await dump(page));

    // codemode 收成一个之后，鼠标停上去：两次调用（带结果）应该一条条列出来
    await page.eval(`
        const el = Array.from(document.querySelectorAll(".tool-group")).find((t) => t.textContent.trim().startsWith("codemode"));
        if (!el) { throw new Error("页面上没有 codemode 标签"); }
        el.dispatchEvent(new MouseEvent("mouseenter"));
        return true;
    `);
    await page.sleep(500);
    await page.shot("merge-codemode-tip.png");
    await page.eval(`
        const el = Array.from(document.querySelectorAll(".tool-group")).find((t) => t.textContent.trim().startsWith("codemode"));
        if (el) { el.dispatchEvent(new MouseEvent("mouseleave")); }
        return true;
    `);
    await page.sleep(200);

    // ---- 第四幕：同名组里夹着一条"读图"（结果带图）——那一条摘出去单独铺一块图，方块里的数字跟着减 ----
    await post(page, [
        { type: "assistantFull", text: "再看一眼这张图：" },
        call("d1", "read", { path: "media/chat.css" }),
        call("d2", "read", { path: "示例图片.png" }),
        call("d3", "read", { path: "media/chat.js" }),
        done("d1", "…"),
        {
            type: "toolResult", toolCallId: "d2", isError: false, durationMs: 60,
            resultText: "Read image file [image/png]",
            images: [{ data: PNG_BASE64, mimeType: "image/png" }],
        },
        done("d3", "…"),
    ]);
    await page.sleep(400);
    await leave(page, ".tool-group");
    await page.sleep(300);
    console.log("\n第四幕（read 调了 3 次里夹着一张图：摘出去之后剩下 read 和「2」）：\n" + await dump(page));
    await page.shot("merge-scenes.png");

    // ---- 第五幕：write / edit 也跟别的工具一样按名字收（标签上只有工具名和次数），
    //      改了哪个文件、diff、按钮都在提示框里，一条调用一块 ----
    const DIFF_JS = "- 1 const pill = document.createElement(\"span\");\n+ 1 const entry = addToolToGroup(st, toolName, argStr, toolCallId, fillEntry);";
    const DIFF_CSS = "- 1 .tool.et-pill { cursor: pointer; }\n+ 1 .tool.reverted { text-decoration: line-through; }";
    await post(page, [
        { type: "assistantFull", text: "两处都改了：" },
        editStart("e1", "edit", "media/chat.js"),
        editStart("e2", "edit", "media/chat.css"),
        editDone("e1", DIFF_JS),   // 一条结果先回来，另一条还在跑
    ]);
    await page.sleep(300);
    const editRow = await dump(page);
    console.log("\n第五幕·一条回来了、一条还在跑（edit 收成一颗带次数 2、齿轮转圈）：\n  " + editRow);
    await hoverNamed(page, "edit");
    await page.sleep(400);
    const halfTip = await tipText(page);
    const halfCounts = JSON.parse(await tipCounts(page));
    console.log("  提示框（该是两条的文件名：一条带 diff 与「回滚」，一条写「生成中…」）：" + halfTip);
    await page.shot("merge-edit-running-tip.png");
    await leaveNamed(page, "edit");
    await page.sleep(200);
    if (!editRow.includes("[edit2 转圈]")) { problems.push("连着两次 edit 没收成一颗带次数 2 的标签，或还有一条在跑却没转圈"); }
    if (halfCounts.calls !== 2 || halfCounts.diff !== 1 || halfCounts.revert !== 1 || halfCounts.loading !== 1) {
        problems.push("edit 的提示框没按「一条调用一块」画（该两条：一条带 diff 与回滚、一条写「生成中…」）：" + JSON.stringify(halfCounts));
    }
    if (!halfTip.includes("media/chat.js") || !halfTip.includes("media/chat.css")) { problems.push("提示框里没把两次改的文件名列出来"); }

    // 第二条结果也回来了：标签停住，两条各自的 diff 与「回滚」都在
    await post(page, [editDone("e2", DIFF_CSS)]);
    await page.sleep(300);
    const settledRow = await dump(page);
    await hoverNamed(page, "edit");
    await page.sleep(400);
    const bothTip = await tipText(page);
    const bothCounts = JSON.parse(await tipCounts(page));
    console.log("\n  两条都回来了（提示框里两条各自的 diff + 「回滚」）：\n    " + bothTip);
    await page.shot("merge-edit-tip.png");
    await leaveNamed(page, "edit");
    await page.sleep(200);
    if (settledRow.includes("[edit2 转圈]")) { problems.push("两条结果都回来了，edit 那颗标签还在转圈"); }
    if (bothCounts.calls !== 2 || bothCounts.diff !== 2 || bothCounts.revert !== 2) {
        problems.push("两条 edit 的 diff / 回滚没在提示框里各列一块：" + JSON.stringify(bothCounts));
    }
    if (bothCounts.inHead !== 2) { problems.push("「回滚」没排在各条改动的标题行上（该两条都在标题行里）：" + JSON.stringify(bothCounts)); }

    // ---- 回滚：回滚过的那一条在自己标题上标「（已回滚）」、自己的按钮收掉；
    //      一组里的改动都回滚了，整颗标签才划掉 ----
    await post(page, [{ type: "editReverted", toolCallId: "e1" }]);
    await page.sleep(300);
    const oneBackRow = await dump(page);
    await hoverNamed(page, "edit");
    await page.sleep(400);
    const oneBackTip = await tipText(page);
    const oneBackCounts = JSON.parse(await tipCounts(page));
    console.log("\n  回滚了第一条（提示框里那一条标「（已回滚）」、自己的按钮收掉，另一条不受影响）：\n    " + oneBackTip);
    await page.shot("merge-edit-reverted.png");
    await leaveNamed(page, "edit");
    await page.sleep(200);
    if (!oneBackTip.includes("media/chat.js（已回滚）")) { problems.push("回滚过的那一条没在标题上标「（已回滚）」：" + oneBackTip); }
    if (oneBackCounts.revert !== 1) { problems.push("回滚过的那一条该把自己的「回滚」收掉（另一条还留着）：" + JSON.stringify(oneBackCounts)); }
    if (oneBackRow.includes("[edit2 划掉]")) { problems.push("只回滚了一条，整颗标签就划掉了"); }

    await post(page, [{ type: "editReverted", toolCallId: "e2" }]);
    await page.sleep(300);
    const allBackRow = await dump(page);
    console.log("\n  两条都回滚了（整颗标签划掉）：\n  " + allBackRow);
    if (!allBackRow.includes("[edit2 划掉]")) { problems.push("两条都回滚了，标签没划掉：" + allBackRow); }

    // ---- 第六幕：write 也一样收；一条成功一条失败 —— 提示框里各一块（失败的只在提示框里看，标签不标红）----
    await post(page, [
        { type: "assistantFull", text: "再写两个文件：" },
        editStart("w1", "write", "dev/note.txt", { path: "dev/note.txt", content: "第一行\n第二行\n第三行" }),
        editStart("w2", "write", "dev/note2.txt", { path: "dev/note2.txt", content: "只有一行" }),
        editDone("w1", "", { canRevert: false }),
        editDone("w2", undefined, { canRevert: false, isError: true, errorText: "写不进去：没有那个目录" }),
    ]);
    await page.sleep(400);
    const writeRow = await dump(page);
    console.log("\n第六幕（连着两次 write：收成一颗带次数 2；一条成功一条失败 → 标签不标红）：\n  " + writeRow);
    await hoverNamed(page, "write");
    await page.sleep(400);
    const writeTip = await tipText(page);
    const writeCounts = JSON.parse(await tipCounts(page));
    console.log("  提示框（一条带写入预览与「跳转」，一条是错误）：" + writeTip);
    await page.shot("merge-write-tip.png");
    await leaveNamed(page, "write");
    await page.sleep(200);
    if (!writeRow.includes("[write2]")) { problems.push("两次 write 没收成一颗带次数 2 的标签"); }
    if (writeRow.includes("标红")) { problems.push("标签不该因为一条失败就标红（失败只在提示框里看）"); }
    if (writeCounts.calls !== 2 || writeCounts.writeArgs !== 1 || writeCounts.jump !== 1 || writeCounts.err !== 1) {
        problems.push("write 的提示框没按「一条调用一块」画（该一条带写入预览与跳转、一条是错误）：" + JSON.stringify(writeCounts));
    }
    if (writeCounts.inHead !== 1) { problems.push("「跳转」没排在写入那一条的标题行上：" + JSON.stringify(writeCounts)); }

    // ---- 第七幕：图排在它那条调用的位置上（不往消息流末尾扔）----
    // 一条路：图的结果回来了，这一批里接着又调了一个工具 —— 新的那排标签得排在图下面；
    // 另一条路：图的结果回来得晚（后面的正文都已经到了）—— 图还待在自己那一批的位置上。
    const IMAGE = { data: PNG_BASE64, mimeType: "image/png" };
    const imageResult = (id) => ({
        type: "toolResult", toolCallId: id, isError: false, durationMs: 60,
        resultText: "Read image file [image/png]", images: [IMAGE],
    });
    await post(page, [
        { type: "assistantFull", text: "看一眼图，接着再查一遍：" },
        // 先读一个文本文件（这一组里还留着它，那排标签不会因为摘掉读图那条而整个收掉）
        call("f0", "read", { path: "media/chat.js" }),
        call("f1", "read", { path: "示例图片.png" }),
        done("f0", "…（40 行）"),
        imageResult("f1"),
        call("f2", "bash", { command: "git status --short" }),
        done("f2", " M media/chat.js"),
    ]);
    await page.sleep(400);
    const orderA = await dump(page);
    console.log("\n第七幕·图回来之后同一批里又调了一个工具（新的那排标签该在图下面）：\n  " + orderA);
    const aImage = orderA.lastIndexOf("图片块：read 示例图片.png");
    const aBash = orderA.lastIndexOf("工具行：[bash");
    if (aImage < 0) { problems.push("第一张图没铺出来：" + orderA); }
    else if (aBash < aImage) { problems.push("图回来之后又调的那一条排到了图上面（该在图下面）：" + orderA); }

    await post(page, [
        { type: "assistantFull", text: "再瞄一眼这张图：" },
        call("h1", "read", { path: "示例图片.png" }),
        call("h2", "bash", { command: "git diff --stat" }),
        done("h2", " media/chat.js | 40 +++---"),
        { type: "assistantFull", text: "图就排在这儿：" },
        imageResult("h1"),   // 结果回来得晚：正文已经在它后面了
    ]);
    await page.sleep(400);
    const orderB = await dump(page);
    console.log("\n第七幕·图的结果回来得晚（该待在「再瞄一眼这张图：」下面，不跑到后一条正文后面）：\n  " + orderB);
    await page.shot("merge-image-order.png");
    const bSay = orderB.lastIndexOf("正文：再瞄一眼这张图");
    const bImage = orderB.indexOf("图片块：read 示例图片.png", bSay);
    const bLate = orderB.lastIndexOf("正文：图就排在这儿");
    if (bImage < 0) { problems.push("回来得晚的那张图没铺出来：" + orderB); }
    else if (!(bSay >= 0 && bSay < bImage && bImage < bLate)) {
        problems.push("回来得晚的那张图没排在自己那一批的位置上（该在「再瞄一眼这张图：」与「图就排在这儿：」之间）：" + orderB);
    }

    // ---- 收场：整屏重放一遍，看合并标签在刷新/重连后是不是一样 ----
    await post(page, [{ type: "clear", keepDraft: true }]);
    await post(page, [
        { type: "assistantFull", text: "先把要动的地方看一遍：" },
        call("r1", "bash", { command: "git status --short" }),
        call("r2", "bash", { command: "git diff --stat" }),
        // 重放：一次 edit 的开始与结果成对地来（跟后端按历史推的一样）
        editStart("r4", "edit", "media/chat.js"), editDone("r4", DIFF_JS),
        editStart("r5", "edit", "media/chat.css"), editDone("r5", DIFF_CSS),
        call("r3", "grep", { pattern: "tool-group", path: "media" }),
        done("r1", " M media/chat.js"),
        done("r2", " media/chat.js | 40 +++---"),
        done("r3", "media/chat.js:12"),
        { type: "assistantFull", text: "重放之后还是收成一个标签（刷新、重连、翻历史都走这条路）。" },
    ]);
    await page.sleep(400);
    const replayRow = await dump(page);
    console.log("\n整屏重放后（连着 2 条 bash → bash 加一个「2」，2 条 edit → edit 加一个「2」，grep 单独一个）：\n  " + replayRow);
    await page.shot("merge-replay.png");
    if (!replayRow.includes("[bash2]") || !replayRow.includes("[edit2]")) {
        problems.push("重放之后没照原样收成一个标签（该看到 bash2 与 edit2）：" + replayRow);
    }

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

/** 让页面上的某个元素进入悬浮状态（电脑上没有触屏那一套，靠 mouseenter 触发提示框）。 */
function hover(page, selector) {
    return page.eval(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) { throw new Error("页面上没有这个元素："); } el.dispatchEvent(new MouseEvent("mouseenter")); return true;`);
}

/** 悬浮结束（提示框有一段宽限时间才收，见 scheduleTagTipHide）。 */
function leave(page, selector) {
    return page.eval(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) { return false; } el.dispatchEvent(new MouseEvent("mouseleave")); return true;`);
}

/** 让「工具名 + 次数」那颗标签进入悬浮状态：按标签上的工具名找，页面上有好几颗时取最后那一颗
 *  （就是刚投进去的那一批）。 */
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

/** 同一颗标签的悬浮结束。 */
function leaveNamed(page, name) {
    return page.eval(`
        const el = Array.from(document.querySelectorAll(".tool-row .tool-group"))
            .filter((t) => { const n = t.querySelector(".tg-name"); return n && n.textContent === " " + ${JSON.stringify(name)}; })
            .pop();
        if (!el) { return false; }
        el.dispatchEvent(new MouseEvent("mouseleave"));
        return true;
    `);
}

/** 提示框里现在写着什么（没出来就说明没挂上）。 */
function tipText(page) {
    return page.eval(`
        const el = document.querySelector(".tag-tip");
        if (!el || el.classList.contains("hidden")) { return "（提示框没出来）"; }
        return el.textContent.replace(/\\s+/g, " ").trim();
    `);
}

/** 提示框里各种东西各有多少个（块数 / 按钮 / 按钮是不是待在标题行里 / 还在跑的那一块 / 出错那一块 / 写入预览）。 */
function tipCounts(page) {
    return page.eval(`return JSON.stringify({
        calls: document.querySelectorAll(".tag-tip .tag-tip-call").length,
        diff: document.querySelectorAll(".tag-tip .edit-diff").length,
        revert: document.querySelectorAll(".tag-tip .et-revert").length,
        jump: document.querySelectorAll(".tag-tip .et-jump").length,
        inHead: document.querySelectorAll(".tag-tip .tag-tip-head .et-jump, .tag-tip .tag-tip-head .et-revert").length,
        loading: document.querySelectorAll(".tag-tip .tip-loading").length,
        err: document.querySelectorAll(".tag-tip .tip-err").length,
        writeArgs: document.querySelectorAll(".tag-tip .tc-args").length,
    });`);
}

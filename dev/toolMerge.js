// @ts-nocheck
/**
 * toolMerge —— 验"同一个名字的工具调用收成一个标签"。
 *
 * 真让模型按剧本一口气调一堆工具不好凑，这里直接往页面里投工具调用消息（跟后端推的是同一种消息），
 * 一次验这几件事：
 *   · 同一个名字一个标签（工具名 + 一个写着次数的小方块，这批里一共调了几次，只调一次就不写数字）；
 *     名字不同 → 各占一个；中间夹了别的调用（不同名的、编辑卡片）不影响它攒数；
 *   · 鼠标停上去 → 提示框里一条条列出各条的调用与结果；
 *   · 结果乱序回来、有的失败、有一条还在跑 → 各自归位，标签上跟着标红、转圈；
 *   · taba / codemode（点名不合并）各自单独一个；
 *   · 结果带图的 read → 从组里摘出去，在对话里铺成一整块图（组里剩几条，小方块里的数字跟着重算）。
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
        // 标签上可能正飘着“+1”小动画（见 chat.js 的 popPlusOne）：它只是动画，不算标签的文字
        const tagText = (el) => {
            const c = el.cloneNode(true);
            for (const n of c.querySelectorAll(".tg-plus")) { n.remove(); }
            return c.textContent.trim().replace(/\\s+/g, " ");
        };
        for (const pane of document.querySelectorAll(".session-pane")) {
            for (const el of pane.children) {
                const cls = el.className || "";
                if (cls.indexOf("tool-row") >= 0) {
                    rows.push("工具行：" + Array.from(el.children).map((c) => "[" + tagText(c) + "]").join(""));
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
const editCard = (id, toolName, file) => ([
    { type: "editCardStart", toolCallId: id, toolName, path: file, label: file, args: { path: file, oldText: "a", newText: "b" } },
    { type: "editCardResult", toolCallId: id, canRevert: false, diff: "" },
]);

module.exports = async (page) => {
    await page.waitReady();

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

    // ---- 第三幕：不合并的（codemode / taba）各自单独一个，编辑卡片也不影响同名的攒数 ----
    await post(page, [
        call("c1", "codemode", { code: "return 1" }),
        call("c2", "bash", { command: "node scripts/compile.mjs --check" }),
        call("c3", "bash", { command: "npm run compile" }),
        ...editCard("c4", "edit", "media/chat.css"),
        call("c5", "bash", { command: "git diff --stat" }),
        call("c6", "taba", { name: "侦察: 工具调用显示", task: "看一遍 chat.js" }),
        call("c7", "find", { pattern: "**/*.md", path: "dev" }),
        done("c1", "1"),
        done("c2", "文件在"),
        done("c3", "编译完成"),
        done("c5", " media/chat.js | 40 +++---"),
        done("c6", "派了子会话（假数据，没真派）"),
        done("c7", "dev/README.md"),
    ]);
    console.log("\n第三幕（codemode,bash,bash,edit,bash,taba,find —— 三个 bash 算一起，标签停在第一个 bash 的位置）：\n" + await dump(page));

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

    // ---- 收场：整屏重放一遍，看合并标签在刷新/重连后是不是一样 ----
    await post(page, [{ type: "clear", keepDraft: true }]);
    await post(page, [
        { type: "assistantFull", text: "先把要动的地方看一遍：" },
        call("r1", "bash", { command: "git status --short" }),
        call("r2", "bash", { command: "git diff --stat" }),
        call("r3", "grep", { pattern: "tool-group", path: "media" }),
        done("r1", " M media/chat.js"),
        done("r2", " media/chat.js | 40 +++---"),
        done("r3", "media/chat.js:12"),
        { type: "assistantFull", text: "重放之后还是收成一个标签（刷新、重连、翻历史都走这条路）。" },
    ]);
    await page.sleep(400);
    console.log("\n整屏重放后（连着 2 条 bash → bash 加一个「2」，grep 单独一个）：\n" + await dump(page));
    await page.shot("merge-replay.png");
};

/** 让页面上的某个元素进入悬浮状态（电脑上没有触屏那一套，靠 mouseenter 触发提示框）。 */
function hover(page, selector) {
    return page.eval(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) { throw new Error("页面上没有这个元素："); } el.dispatchEvent(new MouseEvent("mouseenter")); return true;`);
}

/** 悬浮结束（提示框有一段宽限时间才收，见 scheduleTagTipHide）。 */
function leave(page, selector) {
    return page.eval(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) { return false; } el.dispatchEvent(new MouseEvent("mouseleave")); return true;`);
}

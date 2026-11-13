// @ts-nocheck
/**
 * fullMode —— 验「完整模式」：设置里把「消息显示」切成完整，思考和工具调用的内容直接铺在消息流里；
 * 切回简洁，那些块收掉（跟原来一样，内容只在点开的提示框里看）。
 *
 * 要验的几件事：
 *   · 设置面板里能切（点「完整」→ 后端把选项存下来、界面这边跟着换；点「简洁」→ 收回去）；
 *   · 思考整段摆出来（不再收在提示框里），后来补来的全文换上去；
 *   · 工具调用：一行摘要 + 它的输出（writ / edit 那一块带 diff）；
 *   · 内容长了在块里自己滚（有高度上限，不把消息流撑成几十屏）；
 *   · 后端把全文送来（details）时块里跟着换上新内容。
 *
 *   npm run web:shot -- --width 980 --height 760 --script dev/fullMode.js
 * 图落在 dev/shots/。
 */

/** 往页面里投一批后端消息（跟后端推给页面的形状一样）。 */
function post(page, messages) {
    return page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
}

/** 点设置面板里的某个按钮（按上面的字找）。 */
function clickOption(page, label) {
    return page.eval(`
        const btn = Array.from(document.querySelectorAll(".vo-group-btn"))
            .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
        if (!btn) { throw new Error("设置面板里没有这个按钮：" + ${JSON.stringify(label)}); }
        btn.click();
        return true;
    `);
}

/** 消息流里那些内容块现在是什么样（完整模式下才有）。 */
function dump(page) {
    return page.eval(`
        const rows = [];
        for (const el of document.querySelectorAll(".session-view:not(.off) .session-pane > *")) {
            const cls = el.className || "";
            if (cls.indexOf("tool-row") >= 0) {
                rows.push("标签行：" + Array.from(el.children).map((c) => c.textContent.trim().replace(/\\s+/g, " ")).join(" / "));
            } else if (cls.indexOf("tc-full") >= 0) {
                const out = el.querySelector(".tc-full-out, .tc-full-think");
                rows.push("内容块：" + el.textContent.trim().replace(/\\s+/g, " ").slice(0, 90)
                    + (out ? "（滚动区 " + out.scrollHeight + ">" + out.clientHeight + "）" : ""));
            } else if (cls.indexOf("assistant") >= 0) {
                rows.push("正文：" + el.textContent.trim().replace(/\\s+/g, " ").slice(0, 20));
            }
        }
        return rows.join(" | ");
    `);
}

const THINK_SHORT = "先看看这个目录里有什么，再决定改哪儿。";
const THINK_LONG = THINK_SHORT + "\n第二段：命令要一条条跑，输出多了就在块里滚。";
const BASH_PREFIX = "（后端只带了开头）";
const BASH_FULL = BASH_PREFIX + "\n" + Array.from({ length: 40 }, (_, i) => "第 " + (i + 2) + " 行：一堆输出").join("\n");

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];
    const need = (ok, why) => { if (!ok) { problems.push(why); } };

    // ---- 一、设置面板里切到「完整」 ----
    await post(page, [{ type: "openSettings" }]);
    await page.sleep(600);
    await clickOption(page, "完整");
    await page.sleep(600);
    await page.shot("full-settings.png");
    const inSettings = await page.eval(`return document.getElementById("settingsOverlay").classList.contains("hidden") ? "关了" : "开着";`);
    console.log("\n一、设置面板（点「完整」之后）：" + inSettings);
    await page.eval(`document.getElementById("settingsOverlay").classList.add("hidden"); return true;`);
    await page.sleep(200);

    // ---- 二、投一批消息：思考 + 两条工具 + 一条 edit ----
    await post(page, [
        { type: "assistantFull", text: "先看一眼目录：" },
        { type: "thinkingStart", detailKey: "think-1" },
        { type: "thinkingDelta", delta: "", detailKey: "think-1", omitted: THINK_SHORT.length },
        { type: "thinkingFull", text: "", omitted: THINK_SHORT.length, detailKey: "think-1" },
        { type: "tool", toolName: "bash", args: { command: "ls -la && npm run compile" }, toolCallId: "b1" },
        { type: "toolResult", toolCallId: "b1", isError: false, durationMs: 120, resultText: BASH_PREFIX, resultOmitted: 4096, detailKey: "res-b1" },
        { type: "tool", toolName: "grep", args: { pattern: "tool-row", path: "media" }, toolCallId: "g1" },
        { type: "toolResult", toolCallId: "g1", isError: false, durationMs: 20, resultText: "media/chat.js:338\nmedia/chat.css:338" },
        {
            type: "editCardStart", toolCallId: "e1", toolName: "edit", path: "media/chat.js", label: "media/chat.js",
            args: { path: "media/chat.js", oldText: "a", newText: "b" },
        },
        { type: "editCardResult", toolCallId: "e1", diff: "- 1 const a = 1;\n+ 1 const a = 2;", canRevert: true },
        { type: "assistantFull", text: "看完了。" },
    ]);
    await page.sleep(500);
    // 后端把全文送来（跟真后端回 details 那条一个形状）
    await post(page, [{
        type: "details",
        items: { "think-1": THINK_LONG, "res-b1": BASH_FULL },
        missing: [],
    }]);
    await page.sleep(500);

    const full = await dump(page);
    console.log("\n二、完整模式（思考、一行摘要 + 输出、edit 的 diff）：\n  " + full.replace(/ \| /g, "\n  "));
    const stats = JSON.parse(await page.eval(`
        return JSON.stringify({
            blocks: document.querySelectorAll(".session-view:not(.off) .session-pane > .tc-full").length,
            thinks: Array.from(document.querySelectorAll(".tc-full-think")).map((el) => el.textContent.trim()).join(" || "),
            outs: document.querySelectorAll(".tc-full-out").length,
            diffs: document.querySelectorAll(".tc-full .edit-diff").length,
            capped: Array.from(document.querySelectorAll(".tc-full-out, .tc-full-think"))
                .every((el) => el.scrollHeight > el.clientHeight ? getComputedStyle(el).overflowY === "auto" : true),
        });
    `));
    console.log("  块 " + stats.blocks + "，思考：" + stats.thinks + "，输出 " + stats.outs + " 块，diff " + stats.diffs + " 块，长的能滚 " + stats.capped);
    await page.shot("full-mode.png");
    need(stats.blocks >= 4, "完整模式下没铺出内容块（思考 / 两条工具 / edit 各一块）：" + stats.blocks);
    need(stats.thinks.includes("第二段"), "思考没铺出来（或全文没换上去）：" + stats.thinks);
    need(stats.outs >= 2, "工具输出没铺出来：" + stats.outs);
    need(stats.diffs === 1, "edit 的 diff 没画出来：" + stats.diffs);
    need(stats.capped, "长内容没有在块里自己滚（把消息流撑长了）");

    // ---- 三、切回「简洁」：那些块收掉 ----
    await post(page, [{ type: "openSettings" }]);
    await page.sleep(500);
    await clickOption(page, "简洁");
    await page.sleep(500);
    await page.eval(`document.getElementById("settingsOverlay").classList.add("hidden"); return true;`);
    await page.sleep(200);
    const brief = JSON.parse(await page.eval(`
        return JSON.stringify({
            blocks: document.querySelectorAll(".session-view:not(.off) .session-pane > .tc-full").length,
            tags: document.querySelectorAll(".session-view:not(.off) .session-pane .tool-row .tool").length,
        });
    `));
    console.log("\n三、切回简洁（内容块收回、标签还在）：块 " + brief.blocks + "，标签 " + brief.tags);
    await page.shot("brief-mode.png");
    need(brief.blocks === 0, "切回简洁之后内容块还在：" + brief.blocks);
    need(brief.tags >= 3, "切回简洁之后工具标签没了：" + brief.tags);

    if (problems.length) {
        console.log("\n有问题：");
        for (const p of problems) { console.log("  · " + p); }
        throw new Error("完整模式有几处不对，见上面的清单");
    }
    console.log("\n都对。");
};

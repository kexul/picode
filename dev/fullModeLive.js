// @ts-nocheck
/**
 * fullModeLive —— 完整模式的真链路：假模型真跑一轮（真会话、真后端、真网页），
 * 再把页面刷一遍（历史重放），看思考和工具的内容是不是都铺出来了。
 *
 *   npm run web:shot -- --fake-pi --script dev/fullModeLive.js
 *
 * 验的是「后端一个字都不发、界面问回来」这条路在完整模式下也走得通：
 *   · 设置里切成「完整」→ 这一轮跑下来，消息流里铺出内容块（思考整段、命令输出、edit 的 diff）；
 *   · 刷新页面（整屏重放）→ 还是铺开着的（设置记在后端）；
 *   · 切回「简洁」→ 块收掉，标签照旧。
 */

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

async function setMode(page, label) {
    await page.eval(`window.acquireVsCodeApi().postMessage({ type: "openSettings" }); return true;`);
    await page.sleep(500);
    await clickOption(page, label);
    await page.sleep(600);
    await page.eval(`document.getElementById("settingsOverlay").classList.add("hidden"); return true;`);
    await page.sleep(200);
}

/** 页面上那些内容块现在长什么样。 */
function dump(page) {
    return page.eval(`
        const blocks = Array.from(document.querySelectorAll(".session-view:not(.off) .session-pane > .tc-full"));
        return JSON.stringify({
            count: blocks.length,
            thinks: blocks.map((b) => (b.querySelector(".tc-full-think") || {}).textContent || "").filter(Boolean),
            outs: blocks.map((b) => (b.querySelector(".tc-full-out") || {}).textContent || "").filter(Boolean),
            diffs: document.querySelectorAll(".session-view:not(.off) .session-pane > .tc-full .edit-diff").length,
            clips: blocks.map((b) => (b.querySelector(".tag-tip-clip") || {}).textContent || "").filter(Boolean),
        });
    `).then(JSON.parse);
}

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];
    const need = (ok, why) => { if (!ok) { problems.push(why); } };

    // ---- 一、切成完整，真跑一轮（假模型：想一段 + 说话 + read 图 + bash + edit + 收尾）----
    await setMode(page, "完整");
    await page.send("随便说点什么");
    await page.waitAnswer(null, 60000);
    await page.sleep(2500);   // 等详情那一趟问回来、画上去

    const live = await dump(page);
    console.log("\n一、这一轮跑下来的内容块：" + JSON.stringify({
        count: live.count, thinks: live.thinks.map((t) => t.slice(0, 30)), outs: live.outs.map((t) => t.slice(0, 30)),
        diffs: live.diffs, clips: live.clips.length,
    }, null, 0));
    await page.shot("full-mode-live.png");
    need(live.count >= 3, "完整模式下没铺出内容块：" + live.count);
    need(live.thinks.some((t) => t.trim().length > 10), "思考的内容没铺出来（或一直没取到全文）：" + JSON.stringify(live.thinks));
    need(live.outs.some((t) => t.trim().length > 5), "工具输出的内容没铺出来：" + JSON.stringify(live.outs));
    need(live.diffs >= 1, "edit 的 diff 没画出来：" + live.diffs);
    need(live.clips.length === 0, "内容块底下还挂着「没带过来 / 取不到」的小字：" + JSON.stringify(live.clips));

    // ---- 二、刷新页面（历史重放）：设置记在后端，重放出来照样铺开 ----
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await page.waitReady(90000);
    await page.sleep(2500);
    const replay = await dump(page);
    console.log("\n二、刷新之后（历史重放）：" + JSON.stringify({
        count: replay.count, thinks: replay.thinks.map((t) => t.slice(0, 30)),
        outs: replay.outs.map((t) => t.slice(0, 30)), diffs: replay.diffs,
    }, null, 0));
    await page.shot("full-mode-replay.png");
    need(replay.count >= 3, "刷新（历史重放）之后内容块没了：" + replay.count);
    need(replay.thinks.some((t) => t.trim().length > 10), "重放之后思考的内容取不回来：" + JSON.stringify(replay.thinks));
    need(replay.outs.some((t) => t.trim().length > 5), "重放之后工具输出取不回来：" + JSON.stringify(replay.outs));

    // ---- 三、切回简洁：块收掉 ----
    await setMode(page, "简洁");
    const brief = await page.eval(`
        return JSON.stringify({
            blocks: document.querySelectorAll(".session-view:not(.off) .session-pane > .tc-full").length,
            tags: document.querySelectorAll(".session-view:not(.off) .session-pane .tool-row .tool").length,
        });
    `).then(JSON.parse);
    console.log("\n三、切回简洁：块 " + brief.blocks + "，标签 " + brief.tags);
    need(brief.blocks === 0, "切回简洁之后内容块还在：" + brief.blocks);
    need(brief.tags >= 2, "切回简洁之后工具标签没了：" + brief.tags);

    if (problems.length) {
        console.log("\n有问题：");
        for (const p of problems) { console.log("  · " + p); }
        throw new Error("完整模式的真链路有几处不对，见上面的清单");
    }
    console.log("\n都对。");
};

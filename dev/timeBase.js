// @ts-nocheck
/**
 * timeBase —— 验「耗时从真正开始的那一刻算」，不是从打开页面算。两处：
 *
 *   一、「正在跑」那一行右边的耗时：后端把这条工具开始的那一毫秒随消息一起发过来
 *      （tool / editCardStart 的 startedAt），页面按它算。所以页面后开、刷新、重连都一样。
 *      这里直接投一条带 startedAt 的调用（跟后端推的是同一种消息），看那一行写的是
 *      「那条命令跑了多久」（1分35秒）还是一点点往上数的「0.3s」。
 *   二、侧边栏底部「统计」：整张表是整个会话的。刷新页面（重连 + 整屏重放历史）之后
 *      那几句数还在、一个字都不差；同一条调用重放一遍也不会被算两遍。
 *
 * 假模型默认一跑就是 read / bash / edit 三个工具，拿来凑数正好；每轮停 800 毫秒，
 * 好让每次调用的用时不是 0：
 *
 *   FAKEPI_THINK_MS=800 npm run web:shot -- --fake-pi --script dev/timeBase.js
 *
 * 图落在 dev/shots/。
 */

module.exports = async (page) => {
    const problems = [];
    const say = (ok, text) => { console.log((ok ? "  ✓ " : "  ✗ ") + text); if (!ok) { problems.push(text); } };

    /** 页面收到过哪些工具消息（重放的也算）：自己那只监听、只记不看，跟界面那份一模一样。 */
    const installRecorder = () => page.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `window.__toolMsgs = [];
                 window.addEventListener("message", function (ev) {
                     var d = ev.data;
                     if (!d || typeof d !== "object") { return; }
                     if (d.type === "tool" || d.type === "toolResult"
                         || d.type === "editCardStart" || d.type === "editCardResult") {
                         window.__toolMsgs.push({
                             type: d.type,
                             id: d.toolCallId || "",
                             startedAt: typeof d.startedAt === "number" ? d.startedAt : null,
                             durationMs: typeof d.durationMs === "number" ? d.durationMs : null,
                         });
                     }
                 });`,
    });

    const statsButton = async () => {
        const visible = (sel) => page.eval(
            `const el = document.querySelector(${JSON.stringify(sel)});
             return !!el && el.getBoundingClientRect().width > 0;`);
        if (await visible("#dockFooter .pk-footer-stats")) { return "#dockFooter .pk-footer-stats"; }
        const overlayOpen = await page.eval(`return !document.getElementById("pickerOverlay").classList.contains("hidden")`);
        if (!overlayOpen) { await page.click("#browserMenuBtn"); }
        for (let i = 0; i < 40; i++) {
            if (await visible("#pickerFooter .pk-footer-stats")) { return "#pickerFooter .pk-footer-stats"; }
            await page.sleep(100);
        }
        throw new Error("侧边栏底部没长出那颗「统计」");
    };
    const statsText = async () => {
        await page.click(await statsButton());
        await page.sleep(300);
        const text = await page.eval(
            `const b = document.getElementById("toolStatsBody");
             return (b.innerText || "").replace(/\\s+/g, " ").trim();`);
        await page.eval(`document.getElementById("toolStatsClose").click(); return true;`);
        await page.sleep(150);
        return text;
    };

    await page.waitReady();
    await page.sleep(500);

    // ---------- 一、「正在跑」那一行：按后端给的开始时刻算 ----------
    console.log("一、「正在跑」那一行的耗时从真开始时刻算：");
    await page.eval(`window.postMessage({ type: "tool", toolName: "bash",
        args: { command: "sleep 600" }, toolCallId: "tb_run_1",
        startedAt: Date.now() - 95000 }, "*"); return true;`);
    await page.sleep(300);
    const shown = await page.eval(`
        const item = document.querySelector(".session-view:not(.off) .tool-running-item");
        const time = item ? item.querySelector(".tr-time") : null;
        return time ? time.textContent.trim() : "(没有耗时)";`);
    say(shown.indexOf("1分3") === 0, `那一行写的是「${shown}」（该是 1分3x秒：这条 95 秒前就开始了）`);
    await page.shot("timebase-1-running.png");

    // 收掉这条：别让后面重放的时候它还挂在页面上
    await page.eval(`window.postMessage({ type: "toolResult", toolCallId: "tb_run_1",
        resultText: "（验完收掉）" }, "*"); return true;`);
    await page.sleep(300);

    // ---------- 二、「统计」是整个会话的：刷新之后数还在 ----------
    console.log("二、「统计」跨刷新不重算：");
    await page.send("演示一下");
    await page.waitText("完事");
    await page.sleep(600);

    const before = await statsText();
    say(/共 \d+ 次调用/.test(before), `刷新前：${before}`);
    const beforeCalls = Number((before.match(/共 (\d+) 次调用/) || [])[1] || 0);
    say(beforeCalls >= 3, `刷新前记到了 ${beforeCalls} 次调用（假模型这一轮跑 read / bash / edit）`);

    // 刷新页面：连回来时后端把整段历史重放一遍（跟人手动刷新一模一样）
    await installRecorder();
    await page.cdp.send("Page.reload", { ignoreCache: false });
    await page.waitReady();
    await page.sleep(1200);

    const after = await statsText();
    say(after === before, `刷新后还是那几句：${after}`);

    const msgs = await page.eval(`return JSON.stringify((window.__toolMsgs || []).filter(function (m) { return m.type === "toolResult" || m.type === "editCardResult"; }))`);
    const results = JSON.parse(msgs || "[]");
    const withDur = results.filter((m) => m.durationMs !== null);
    say(results.length > 0, `重放过来的结果有 ${results.length} 条`);
    say(withDur.length === results.length, `这 ${results.length} 条都带着当时用了多久（${withDur.length} 条带了）`);

    // 还没跑完的那些（重放里没有结果的调用）得带着真开始时刻，页面才不会从 0 数起
    const tools = JSON.parse(await page.eval(`return JSON.stringify((window.__toolMsgs || []).filter(function (m) { return m.type === "tool"; }))`) || "[]");
    const ended = new Set(results.map((m) => m.id));
    const running = tools.filter((m) => !ended.has(m.id));
    say(running.every((m) => m.startedAt === null || m.startedAt > 0),
        `重放里还在跑的那 ${running.length} 条：开始时刻都是真的（不是 0）`);

    await page.shot("timebase-2-stats.png");

    // ---------- 三、后端那边：开始时刻与用时都记着，重放时才拿得到 ----------
    // 为什么不在浏览器里验这一节：假 pi 要等这一轮跑完才把那条助手消息写进历史（真 pi 是工具一调就写），
    // 所以“历史里重放一条还在跑的调用”这个情形假 pi 演不出来。这条路上只有两句话（开始时刻、用时
    // 存在会话那本账里，重放时取出来随消息发），所以直接问那本账。
    console.log("三、后端记着开始时刻与用时（重放时随消息发）：");
    const { EditTracker } = require("../out/server/editTracker.js");
    const posted = [];
    const tracker = new EditTracker({
        getCwd: () => process.cwd(),
        relativeTo: (cwd, full) => full,
        resolvePath: (p) => p,
        post: (msg) => posted.push(msg),
        onKnownFilesChanged: () => {},
        confirmRevert: async () => true,
        clipToolText: (key, text) => ({ text, detailKey: key }),
        summaryToolArgs: () => ({}),
    });
    tracker.onToolStart({ toolCallId: "tb_t1", toolName: "bash", args: { command: "sleep 600" } });
    const started = posted[0] || {};
    say(started.type === "tool" && started.startedAt > 0, `「工具开始」那条消息带着真开始时刻（${started.startedAt}）`);
    say(tracker.toolStartedAtOf("tb_t1") === started.startedAt, "重放历史时问得到这条的开始时刻（= 发出去的那个）");
    await page.sleep(50);
    tracker.onToolEnd({ toolCallId: "tb_t1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] } });
    const endMsg = posted[posted.length - 1] || {};
    say(endMsg.type === "toolResult" && typeof endMsg.durationMs === "number" && endMsg.durationMs >= 50,
        `结果那条带着这次用了多久（${endMsg.durationMs} 毫秒）`);
    say(tracker.toolDurationMsOf("tb_t1") === endMsg.durationMs, "这本书里也记下了同一份用时（重放时结果里带上它）");
    say(tracker.toolStartedAtOf("tb_t1") === 0, "跑完之后不再算「还在跑」（重放时不会给它发开始时刻）");

    console.log("");
    if (problems.length) {
        console.log("没对上的（" + problems.length + " 条）：");
        for (const p of problems) { console.log("  ! " + p); }
        throw new Error("timeBase 没全过");
    }
    console.log("都对上了。");
};

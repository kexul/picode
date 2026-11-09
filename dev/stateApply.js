// @ts-nocheck
/**
 * stateApply —— 验「页面上那份会话状态」更新时的四条正经路（都是“只有一个入口”的事）：
 *
 *   npm run web:shot -- --fake-pi --script dev/stateApply.js
 *
 * 一、会话列表说“这一轮停了”时，要跟“这一轮结束”那条事件走同一个入口：它顺带收掉
 *     「正在跑的那一条」。以前这里是直接赋值，于是断线期间跑完再回来，那条冻住的命令
 *     还挂在消息流末尾（下面第一段就摆这个现场）。
 * 二、补完更早的历史以后，“这是老消息”的标记要复位：不复位的话，之后新长出来的工具调用
 *     会被当成老消息 —— 不记开始时刻，「正在跑的那一条」末尾就不写耗时。
 * 三、关掉一个还挂着「后台任务」的会话，它那只每半秒走一次的钟要跟着停：以前没清，
 *     钟的退出条件看“那一块还有没有父节点”，而整棵树只是从文档上摘下来、父节点还在，
 *     于是那只钟会一直空转下去。
 * 四、补完更早的历史以后，后面新来的调用还得落在“现在这一批”那一行里、思考的段数不能被多算：
 *     往暂存区里画的时候要是没把“这批落在哪一行 / 这批的名字计数表 / 正在想的那条”存还掉，
 *     新调用会接进顶上那一行（次数越攒越多、命令跑到上面去）；而「收尾时强制新开一段思考」
 *     会让顶上那行多出一颗空的 think（手机上断线重连、加载更早之后“命令顺序乱了”就是这个）。
 */
module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(600);
    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };
    const post = (messages) => page.eval(
        `for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);

    // 记下会话号：会话列表里那一条就是
    await page.eval(`
        window.__sid = "";
        window.addEventListener("message", (e) => {
            const m = e.data;
            if (!m || m.type !== "sessionList" || !Array.isArray(m.sessions) || !m.sessions.length) { return; }
            const main = m.sessions.find((s) => !s.parentId) || m.sessions[0];
            if (main && main.id) { window.__sid = main.id; }
        });
        return true;
    `);
    let sid = "";
    for (let i = 0; i < 20 && !sid; i++) { await page.sleep(100); sid = await page.eval("return window.__sid;"); }
    if (!sid) {
        // 页面刚就绪时那一份列表在装记录器之前就发过了：说一句话，让后端再推一份
        await page.send("你好");
        for (let i = 0; i < 100 && !sid; i++) { await page.sleep(100); sid = await page.eval("return window.__sid;"); }
        for (let i = 0; i < 100; i++) {
            const st = await page.eval(`return (document.getElementById("ctxIcon") || {}).dataset?.st || "";`);
            if (st === "idle") { break; }
            await page.sleep(100);
        }
    }
    check(!!sid, "拿不到会话号（等不到带会话的会话列表）");
    if (!sid) { throw new Error("没法验：没有会话号"); }

    // 右边那一列开着，才看得到「正在对话」那几行的行首点
    await page.eval(`
        if (!document.body.classList.contains("dock-sidebar") && window.pichatSidebar && window.pichatSidebar.toggle) {
            window.pichatSidebar.toggle();
        }
        return true;
    `);
    await page.sleep(400);

    /** 这个会话在右边那一列上那颗点是什么（" done" = 绿点 / " running" = 蓝点 / "" = 不亮）。 */
    const rowDot = () => page.eval(`
        const row = document.querySelector(".pk-item.pk-open");
        const dot = row ? row.querySelector(".pk-open-dot") : null;
        return dot ? (dot.className || "") : "<没有这一行>";
    `);

    // ---- 一、会话列表说“在跑”时要清掉上一轮那颗绿点（跟 streamStart 走同一个入口）----
    // 绿点只说“这一轮跑完了”，下一轮开始就该灭。以前会话列表那条路直接写 streaming，
    // 绕过了那一下清理：断线/重开页面回来，一个刚跑起来的会话会同时说“在跑”和“跑完了”。
    const listWith = (streaming) => ({
        type: "sessionList",
        sessions: [{ id: sid, name: "主会话", streaming, bashRunning: false, activity: streaming ? "working" : "idle", piReady: true, modelId: "fake-model" }],
    });
    await post([listWith(false), { type: "turnEnd", sessionId: sid, status: "done", text: "跑完了一轮" }]);
    await page.sleep(400);
    const doneDot = await rowDot();
    check(/\bdone\b/.test(doneDot), `投完一轮以后那一行该是绿点，实际类名 ${JSON.stringify(doneDot)}（这一条没法验）`);
    await post([listWith(true)]);          // 下一轮开跑：绿点该灭
    await page.sleep(400);
    await post([listWith(false)]);         // 又停了：不该再冒出一颗绿点（它上一轮已经看过了）
    await page.sleep(400);
    const afterStart = await rowDot();
    check(!/\bdone\b/.test(afterStart), `会话列表说“在跑”时没清掉上一轮那颗绿点（停了以后又亮成 ${JSON.stringify(afterStart)}）`);
    console.log("  一、会话列表说“在跑”：绿点 " + JSON.stringify(doneDot) + " → " + JSON.stringify(afterStart));

    // ---- 二、补完更早的历史 → 新调用照样记开始时刻（「正在跑」末尾有耗时）----
    await post([
        { type: "historyBatchEvent", sessionId: sid, event: { type: "assistantFull", text: "更早的一句话" } },
        { type: "historyBatchEnd", sessionId: sid, hasMore: false, hidden: 0 },
    ]);
    await page.sleep(500);
    // 不带 startedAt：界面按“从这一刻起”算耗时（老消息才会被判成没有开始时刻）
    await post([{ type: "tool", toolName: "bash", args: { command: "echo hi" }, toolCallId: "a2" }]);
    await page.sleep(300);
    const timeText = await page.eval(`
        const el = document.querySelector(".session-view:not(.off) .session-pane .tool-running .tr-time");
        return el ? (el.textContent || "").trim() : "<没有那只时间>";
    `);
    check(!!timeText && timeText !== "<没有那只时间>", "补完更早的历史以后，新调用那一行没有耗时（被当成老消息了）");
    console.log("  二、补完更早历史后新调用：耗时写着 " + JSON.stringify(timeText));

    // 收掉这条在跑的，免得挡着下面关会话
    await post([{ type: "toolResult", toolCallId: "a2", resultText: "hi" }]);
    await page.sleep(200);

    // ---- 四、补完更早的历史 → 后面新来的调用还落在“现在这一批”，不该塞进顶上那一批 ----
    // 以前往暂存区里画的时候，只存还了“本段那颗思考”，没存还“这批工具落在哪一行 / 这批的名字计数表 /
    // 正在写的正文 / 正在想的那条”。于是更早那批画完、节点被插到窗格顶上以后，这几样还指着那批里的行，
    // 后面实时来的调用全塞进顶上那行：上面那行的次数越攒越多，「正在跑」那条也跟着跑到上面去
    //（手机上断线重连、点一下「加载更早」之后，就是“命令的顺序乱了”那个样子）。
    const pair = (id, cmd) => [
        { type: "tool", sessionId: sid, toolName: "bash", args: { command: cmd }, toolCallId: id },
        { type: "toolResult", sessionId: sid, toolCallId: id, resultText: "ok" },
    ];
    await post([
        { type: "userMessage", sessionId: sid, text: "四·第一段" },
        ...pair("f1", "echo a"),
        { type: "userMessage", sessionId: sid, text: "四·第二段" },
        ...pair("f2", "echo b"),
    ]);
    await page.sleep(400);
    // 往上补一截更早的历史（里面也有一条工具调用：它那一行会落在窗格顶上）：这条道以前会把
    // “这批落在哪一行”丢在暂存区里，之后新来的调用全接进顶上那一行
    await post([
        { type: "historyBatchEvent", sessionId: sid, event: { type: "assistantFull", text: "更早的一段" } },
        { type: "historyBatchEvent", sessionId: sid, event: { type: "thinkingStart" } },
        { type: "historyBatchEvent", sessionId: sid, event: { type: "thinkingFull", text: "更早的那一段思考" } },
        { type: "historyBatchEvent", sessionId: sid, event: { type: "tool", toolName: "bash", args: { command: "echo 早" }, toolCallId: "old1" } },
        { type: "historyBatchEvent", sessionId: sid, event: { type: "toolResult", toolCallId: "old1", resultText: "ok" } },
        { type: "historyBatchEnd", sessionId: sid, hasMore: false, hidden: 0 },
    ]);
    await page.sleep(400);
    // 补完以后又来了一条新调用：它该落在「四·第二段」下面那一行（那一行变成 2 条）
    await post(pair("f3", "echo c"));
    await page.sleep(400);
    const rows = await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        const out = [];
        let at = "";
        for (const el of pane.children) {
            if (el.classList.contains("user")) { at = (el.textContent || "").trim().slice(0, 6); }
            if (el.classList.contains("tool-row")) {
                out.push({ at: at, chips: Array.from(el.children).map((t) => (t.textContent || "").trim()) });
            }
        }
        return out;
    `);
    const A = rows.find((r) => r.at === "");                    // 顶上那行：更早那批自己的
    const B = rows.find((r) => r.at === "四·第二段");
    const show = rows.map((r) => (r.at || "（顶上）") + ":" + r.chips.join("+")).join(" / ");
    // 顶上那行不该多出东西；第一段下面那行只有 1 条（标签不写数字）；第二段下面那行该是 2 条（bash2）
    check(!!A && A.chips.join("+") === "think+bash", `补完更早的历史以后，顶上那行不对（思考该是一段、命令该是一条；现在是：${show}）`);
    check(!!B && B.chips.length === 1 && B.chips[0] === "bash2", `补完更早的历史以后，新来的调用没落在下面那行（各行现在是：${show}）`);
    console.log("  四、补完更早历史后新调用落在：" + show);

    // ---- 三、关掉带「后台任务」的会话 → 那只钟停掉 ----
    await page.eval(`
        window.__timers = new Set();
        const si = window.setInterval, ci = window.clearInterval;
        window.setInterval = function () { const id = si.apply(this, arguments); window.__timers.add(id); return id; };
        window.clearInterval = function (id) { window.__timers.delete(id); return ci.call(this, id); };
        return true;
    `);
    const baseTimers = await page.eval("return window.__timers.size;");
    await post([{ type: "bashTasks", sessionId: sid, tasks: [{ no: 1, status: "running", cmd: "sleep 600", startedAt: Date.now() }] }]);
    await page.sleep(400);
    const withClock = await page.eval("return window.__timers.size;");
    check(withClock > baseTimers, "后台任务那一块出来了，但没见它起那只钟（这一条没法验）");
    // 这个会话闲着，点一下 × 就关（不留确认条）
    await page.eval(`
        const tab = document.querySelector("#sessionTabs .sn-tab.current") || document.querySelector("#sessionTabs .sn-tab");
        const close = tab ? tab.querySelector(".sn-close") : null;
        if (close) { close.click(); }
        return true;
    `);
    let after = withClock;
    for (let i = 0; i < 50; i++) {
        await page.sleep(100);
        after = await page.eval("return window.__timers.size;");
        if (after <= baseTimers) { break; }
    }
    check(after <= baseTimers, `关掉带后台命令的会话以后还有 ${after - baseTimers} 只定时器在跑（那只半秒一次的钟没停）`);
    console.log("  三、关会话前后定时器：" + baseTimers + " → " + withClock + " → " + after);

    if (problems.length) {
        console.log("");
        console.log("有问题（" + problems.length + " 条）：");
        for (const p of problems) { console.log("  ! " + p); }
        throw new Error("页面状态更新这三条没验过：" + problems.length + " 条");
    }
    console.log("");
    console.log("页面状态更新：会话列表走同一个入口、老消息标记复位、关会话把钟停掉，都对上了。");
};

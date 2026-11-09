// @ts-nocheck
/**
 * runEnd —— 验「一轮怎么算结束」这台机器的两个缺口（都只在异常路上才看得见）：
 *
 *   FAKEPI_THINK_MS=2500 npm run web:shot -- --fake-pi --script dev/runEnd.js
 *
 * 一、跑到一半 pi 进程没了（假 pi 的「假装被杀」剧本）：这一轮照样得有个收尾。
 *     以前进程一死就再也没有 agent_settled，于是“这一轮结束了”这件事整个不会发生 ——
 *     不弹提醒、派出去的子会话结果交不回、自动模式等不到下一轮，界面上那颗点还蓝着。
 *     现在按“出错”收一条 turnEnd 出去，界面跟着回到闲着。
 * 二、点过「卡住了」再自己发一句：那句“卡住了”作废，不许等这一轮停稳之后又冒出来。
 *     以前不清这个待发件，于是会同一条会话里多出一句“卡住了”。
 */
module.exports = async (page) => {
    await page.waitReady();
    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };

    /** 记下页面收到的全部消息（只看类型与状态，不碰内容）。 */
    const installRecorder = () => page.eval(`
        window.__msgs = [];
        window.addEventListener("message", (e) => {
            const m = e.data;
            if (m && typeof m.type === "string") { window.__msgs.push({ type: m.type, status: m.status, sessionId: m.sessionId }); }
        });
        return true;
    `);
    const turnEnds = () => page.eval(`
        return (window.__msgs || []).filter((m) => m.type === "turnEnd");
    `);
    const surfaces = () => page.eval(`
        const tab = document.querySelector("#sessionTabs .sn-tab.current") || document.querySelector("#sessionTabs .sn-tab");
        const icon = document.getElementById("ctxIcon");
        const hint = document.querySelector(".session-view:not(.off) .msg-endhint:not(.msg-endhint-close):not(.msg-endhint-quick):not(.msg-endhint-stop)");
        return {
            st: icon ? (icon.dataset.st || "") : "",
            tabBusy: !!(tab && tab.classList.contains("streaming")),
            hintMode: hint ? (hint.dataset.mode || "") : "",
            hintShown: !!(hint && !hint.classList.contains("hidden")),
        };
    `);
    const userBubbles = () => page.eval(`
        return [...document.querySelectorAll(".msg.user")].map((el) => (el.innerText || "").trim());
    `);

    // ---- 一、进程在跑到一半时没了 ----
    await installRecorder();
    await page.send("假装被杀");
    // 先确认这一轮真跑起来了（不然“进程没了”验的是个空场）
    let wentStreaming = false;
    for (let i = 0; i < 60; i++) {
        if ((await surfaces()).st === "streaming") { wentStreaming = true; break; }
        await page.sleep(100);
    }
    check(wentStreaming, "「假装被杀」这一轮没跑起来（等不到 streaming），这一条没法验");
    // 等 pi 死掉、后端把收尾的话说完
    await page.sleep(3500);
    const ends = await turnEnds();
    check(ends.length === 1, `进程没了以后该收一条 turnEnd，实际收到 ${ends.length} 条`);
    if (ends.length) {
        check(ends[0].status === "error", `进程没了那一轮该按“出错”收尾，实际是 ${JSON.stringify(ends[0].status)}`);
    }
    const s1 = await surfaces();
    check(s1.st === "idle", `进程没了以后模型胶囊该回到 idle，实际 ${s1.st}`);
    check(!s1.tabBusy, "进程没了以后会话格那颗点还在呼吸");
    check(s1.hintShown && s1.hintMode === "continue", `进程没了以后末尾那颗胶囊该回到「继续」，实际 ${JSON.stringify(s1)}`);
    await page.shot("run-end-crash.png");

    // ---- 二、点了「卡住了」又自己发一句 ----
    await page.eval("window.__msgs = []; return true;");
    await page.send("先跑一轮");
    let streaming = false;
    for (let i = 0; i < 80; i++) {
        if ((await surfaces()).st === "streaming") { streaming = true; break; }
        await page.sleep(100);
    }
    check(streaming, "第二轮没跑起来，「卡住了」这一条没法验");
    if (streaming) {
        // 点主胶囊那颗「卡住了」（点完这一轮会被中止，停稳之后本来要补发一句“卡住了”）
        await page.eval(`
            const btn = document.querySelector(".session-view:not(.off) .msg-endhint:not(.msg-endhint-close):not(.msg-endhint-quick):not(.msg-endhint-stop)");
            if (btn) { btn.click(); }
            return true;
        `);
        // 紧接着人自己又发一句：那句“卡住了”就该作废
        await page.send("我说的是另一件事");
        // 等这一轮彻底停稳
        for (let i = 0; i < 120; i++) {
            if ((await surfaces()).st === "idle") { break; }
            await page.sleep(100);
        }
        await page.sleep(800);   // 补发那一下是停稳之后才发的，多等一会儿才看得见“多出来的那条”
        const bubbles = await userBubbles();
        const stuckCount = bubbles.filter((t) => t === "卡住了").length;
        check(stuckCount === 0, `点了「卡住了」又自己发一句，还是多冒出来 ${stuckCount} 条“卡住了”（应该一条都不发）`);
        check(bubbles.some((t) => t.includes("我说的是另一件事")), "自己发的那一句没进消息流");
        await page.shot("run-end-no-stuck.png");
    }

    if (problems.length) {
        console.log("");
        console.log("有问题（" + problems.length + " 条）：");
        for (const p of problems) { console.log("  ! " + p); }
        throw new Error("一轮收尾这台机器没验过：" + problems.length + " 条");
    }
    console.log("一轮收尾：进程没了照样报收尾（error）、点过「卡住了」又自己发话不再补发，都对上了。");
};

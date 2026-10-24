// @ts-nocheck
/**
 * msgTime —— 验正文右下角那个「消息的时刻」。
 *
 * 原来鼠标停在正文上，右下角冒出一颗「复制」按钮；现在那个位置改成写这条消息的时刻（复制那颗撤了）。
 * 时刻用 pi 记下的那条消息的开始时刻（历史重放时后端随 assistantFull 带过来，见 src/sessionRuntime.ts
 * 的 renderMessages）；没带就按现在算（当场流出来的那一段）。
 * 一次验这几件事：
 *   · 不悬停不露面（跟原来那颗按钮一样，只在鼠标停上去时出来）；
 *   · 原来那颗复制按钮确实没了（页面上没有 .msg-copy）；
 *   · 今天的只写时分（15:04），同年的别的日子前面补日期（10-17 15:04），跨年的写全年；
 *     鼠标停上去的 title 是完整的年月日时分秒；
 *   · 没带时刻的（当场生成的那一段）写的是现在，不是空着、也不是 1970；
 *   · 那颗小字不挡鼠标（pointer-events: none，选字、点下面的东西都不受影响）。
 *
 *   npm run web:shot -- --fake-pi --script dev/msgTime.js
 * 图落在 dev/shots/。
 */

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];

    const post = (messages) => page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
    /** 把真鼠标挪到某个地方（CSS 的 :hover 只认真鼠标，dispatchEvent 糊弄不了它）。 */
    const move = (x, y) => page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y), button: "none" });
    const pad2 = (n) => (n < 10 ? "0" : "") + n;
    /**
     * 界面上该写成什么（这里照 GLOSSARY 的规矩独立算一遍）：今天只写时分；同年的别的日子补「月-日」；
     * 跨年的写全年。测的是「写进去的跟该写的一样」，不是「某个函数自己调自己」。
     */
    const want = (ms, now) => {
        const d = new Date(ms);
        const t = new Date(now);
        const hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
        if (d.toDateString() === t.toDateString()) { return hm; }
        if (d.getFullYear() === t.getFullYear()) { return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + hm; }
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + hm;
    };
    const full = (ms) => {
        const d = new Date(ms);
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " "
            + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    };

    const now = Date.now();
    const TODAY = now - 2 * 60 * 1000;                 // 今天（两分钟前）
    const OTHER_DAY = now - 3 * 24 * 3600 * 1000;      // 同年、别的日子（跨年附近就按跨年算）
    const OTHER_YEAR = new Date(2024, 2, 5, 9, 7, 12).getTime();   // 2024-03-05 09:07:12（本地时刻）
    const LIVE = now;                                  // 这条没带时刻：按现在算

    await post([
        { type: "userMessage", text: "几条带时刻的消息：" },
        { type: "assistantFull", text: "今天这条：两分钟前。", at: TODAY },
        { type: "assistantFull", text: "这是前几天的（同年）。", at: OTHER_DAY },
        { type: "assistantFull", text: "这条是 2024 年的。", at: OTHER_YEAR },
        { type: "assistantFull", text: "这条是当场流出来的（后端没带时刻）。" },
    ]);
    await page.sleep(500);

    /** 第 index 条正文现在写着什么、露没露；先把鼠标挪到它身上再读。 */
    const lookAt = async (index) => {
        const box = await page.eval(`
            const el = document.querySelectorAll(".session-view:not(.off) .session-pane .msg.assistant")[${index}];
            if (!el) { return null; }
            el.scrollIntoView({ block: "center" });
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + Math.min(r.width / 2, 200)), y: Math.round(r.top + r.height / 2) };
        `);
        if (!box) { return null; }
        await move(box.x, box.y);
        await page.sleep(200);
        return page.eval(`
            const el = document.querySelectorAll(".session-view:not(.off) .session-pane .msg.assistant")[${index}];
            const t = el ? el.querySelector(".msg-time") : null;
            if (!t) { return null; }
            return {
                // 画出来的字在伪元素里（见 chat.css 的 .msg-time::after）：content 带引号，剥掉
                text: (getComputedStyle(t, "::after").content || "").replace(/^"|"$/g, ""),
                inText: (el.textContent || "").includes(t.dataset.time),
                title: t.title,
                opacity: Math.round(Number(getComputedStyle(t).opacity) * 100) / 100,
                events: getComputedStyle(t).pointerEvents,
                inside: Boolean(el.contains(t)),
            };
        `);
    };

    // ---- 第一幕：鼠标不在正文上 → 不露；那一块也确实没有复制按钮了 ----
    await move(2, 2);
    await page.sleep(200);
    const idle = await page.eval(`
        const shown = Array.from(document.querySelectorAll(".session-view:not(.off) .session-pane .msg.assistant .msg-time"))
            .map((t) => Math.round(Number(getComputedStyle(t).opacity) * 100) / 100);
        const el = document.querySelectorAll(".session-view:not(.off) .session-pane .msg.assistant")[0];
        const t = el ? el.querySelector(".msg-time") : null;
        return {
            opacities: shown,
            inCorner: t ? (() => {
                const er = el.getBoundingClientRect();
                const tr = t.getBoundingClientRect();
                return { right: Math.round(er.right - tr.right), bottom: Math.round(er.bottom - tr.bottom) };
            })() : null,
            copyButtons: document.querySelectorAll(".msg-copy").length,
        };
    `);
    console.log("第一幕（没人悬停、也没有复制按钮了）：每条的透明度 " + JSON.stringify(idle.opacities)
        + "，复制按钮 " + idle.copyButtons + " 个");
    if (!idle.opacities.length) { problems.push("正文上根本没有时刻那颗小字"); }
    if (idle.opacities.some((o) => o !== 0)) { problems.push("没悬停也露着时刻：" + JSON.stringify(idle.opacities)); }
    if (idle.copyButtons !== 0) { problems.push("原来说好的复制按钮还在（" + idle.copyButtons + " 个）"); }

    // ---- 第二幕：一条条停上去，看写的时刻对不对 ----
    const cases = [
        { index: 0, at: TODAY, what: "今天（只写时分）" },
        { index: 1, at: OTHER_DAY, what: "同年、别的日子（补月-日）" },
        { index: 2, at: OTHER_YEAR, what: "跨年（写全年）" },
        { index: 3, at: LIVE, what: "没带时刻（按现在算）" },
    ];
    console.log("\n第二幕（一条条停上去）：");
    for (const c of cases) {
        const got = await lookAt(c.index);
        const expect = want(c.at, Date.now());
        console.log("   " + c.what + "：写着「" + (got && got.text) + "」，该是「" + expect + "」，title=" + (got && got.title));
        if (!got) { problems.push(c.what + "：页面上没找到这一条的时刻"); continue; }
        if (got.opacity !== 1) { problems.push(c.what + "：鼠标停上去了，时刻没露出来（透明度 " + got.opacity + "）"); }
        if (!got.inside) { problems.push(c.what + "：时刻没挂在这条正文里"); }
        if (got.events !== "none") { problems.push(c.what + "：那颗小字会挡鼠标（该 pointer-events: none）：" + got.events); }
        if (got.text !== expect) { problems.push(c.what + "：时刻写的不对（「" + got.text + "」该是「" + expect + "」）"); }
        // 它不该算进正文的文字里：选中这一条复制、或者按 Ctrl+A，都不该把时刻带上
        if (got.inText) { problems.push(c.what + "：时刻进了正文的文字里（复制会带上它，该走 ::after 画）"); }
        if (c.index !== 3 && got.title !== full(c.at)) { problems.push(c.what + "：title 不是完整时刻（「" + got.title + "」该是「" + full(c.at) + "」）"); }
    }
    // 没带时刻的那一条按“现在”算：给一分钟的宽限（别把跑得慢当成写错）
    const live = await page.eval(`
        const el = document.querySelectorAll(".session-view:not(.off) .session-pane .msg.assistant")[3];
        const t = el ? el.querySelector(".msg-time") : null;
        return t ? t.title : "";
    `);
    const liveMs = Date.parse(String(live).replace(" ", "T"));
    if (!(Math.abs(Date.now() - liveMs) < 60 * 1000)) { problems.push("没带时刻的那条没按现在算（title=「" + live + "」）"); }

    // ---- 第三幕：当场流出来的那一条，刷新后重放还是原来那一刻（后端把 pi 记下的时刻带过来了）----
    // 这一条走真路（真 pi 进程 → 后端 → 界面）：要是后端回放时忘了带时刻，重放出来就会写成“现在”，
    // 跟原来那一刻对不上。中间特意停 10 秒再刷新：差得开，蒙不过去。
    const lastTime = () => page.eval(`
        const els = Array.from(document.querySelectorAll(".session-view:not(.off) .session-pane .msg.assistant"));
        const el = els[els.length - 1];
        const t = el ? el.querySelector(".msg-time") : null;
        return t ? { text: t.dataset.time, title: t.title } : null;
    `);
    const asMs = (title) => Date.parse(String(title || "").replace(" ", "T"));
    await page.send("说点什么，好让这条有个时刻可以验。");
    await page.waitAnswer();
    await page.sleep(800);
    const liveOne = await lastTime();
    console.log("\n第三幕（当场那条 vs 刷新后重放的那条）：");
    console.log("   当场写的：" + JSON.stringify(liveOne));
    await page.sleep(10000);
    await page.cdp.send("Page.reload");
    await page.sleep(1500);
    await page.waitReady();
    await page.sleep(1500);
    const replayOne = await lastTime();
    console.log("   刷新后写的：" + JSON.stringify(replayOne) + "（隔了 10 秒才刷新）");
    if (!liveOne || !replayOne) {
        problems.push("没找到正文上的时刻（当场=" + JSON.stringify(liveOne) + "，重放=" + JSON.stringify(replayOne) + "）");
    } else {
        if (Math.abs(asMs(replayOne.title) - asMs(liveOne.title)) > 5000) {
            problems.push("刷新后重放的那条时刻变了（该还是原来那一刻）：" + liveOne.title + " → " + replayOne.title);
        }
        if (Date.now() - asMs(replayOne.title) < 5000) {
            problems.push("刷新后重放的那条写成了“现在”（该是 pi 记下的那一刻）：" + replayOne.title);
        }
        if (replayOne.text !== liveOne.text) {
            problems.push("刷新前后写的时刻不一样（同一分钟里该一样）：" + liveOne.text + " → " + replayOne.text);
        }
    }

    // ---- 第四幕：条条都在右下角（跟原来的复制按钮同一个地方），不挤正文 ----
    // 刷新过了，前三幕那几条假消息不在了：这一条拿重放出来的那条看位置
    const corner = await lookAt(0);
    console.log("\n第四幕（那颗小字的位置）：透明度 " + (corner && corner.opacity) + "，不挡鼠标=" + (corner && corner.events === "none"));
    await page.shot("msg-time.png");

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

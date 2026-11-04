// @ts-nocheck
/**
 * bashTasks —— 验消息流最末尾那一块「后台在跑的命令」。
 *
 * 真让 pi 往后台放一条命令不好凑，这里直接往页面里投假消息（跟后端推的是同一种消息：bashTasks 是
 * 界面问后端要来的那份整清单，bashTask 是某一条有动静）。一次验：
 *   · 一条都没在跑时，消息流末尾没有那一块；
 *   · 有命令在跑时那一块出现在消息流最末尾（末尾那颗胶囊前面），一条一行、就一行：
 *     钟 + 编号 + 命令 + 跑了多久 + 停；放不下的命令字自己横向滚（跟「正在跑的那一条」同一套，
 *     不折行、不把这一块撑高）；新的那条排最前；跑完的不列；
 *   · 钟跟齿轮不是一回事：这一块里的钟针会自己走（转的是针、绕的是表盘正中）；
 *   · 用时自己往上走（半秒一跳，不重画那一块，钟的相位不被打回十二点）；
 *   · 点「停」：那条的按钮先灰掉，等后端推送回来再按真实状态画；
 *   · 后端推 bashTask（跑完了）：那一行当场收掉，跑光了整块收掉；
 *   · 手机上：不出屏、字照旧横向滚（不折腾高度）。
 *
 *   npm run web:shot -- --width 900 --height 700 --script dev/bashTasks.js
 * 图落在 dev/shots/。
 */

/** 投进去的那几条后台命令（跟后端 listBashTasks 给的字段一样）。 */
const LONG_CMD = "cd dev/.scratch && node dev/visit.js --fake-pi --send 你好 --wait-answer 你好 "
    + "--shot extra-long-name.png --width 900 --height 700 --keep --script dev/bashTasks.js "
    + "--cwd dev/.scratch/a-rather-long-directory-name | tee run.log";
const tasksAt = (now) => ([
    { no: 7, toolCallId: "c7", cmd: LONG_CMD, log: "l7", pid: 1234, startedAt: now - 65000, background: true, status: "running", exitCode: null, elapsedMs: 0 },
    { no: 6, toolCallId: "c6", cmd: "node dev/visit.js --fake-pi --send 你好", log: "l6", pid: 1235, startedAt: now - 4000, background: true, status: "running", exitCode: null, elapsedMs: 0 },
    { no: 5, toolCallId: "c5", cmd: "npm test", log: "l5", pid: 1236, startedAt: now - 300000, background: true, status: "done", exitCode: 0, elapsedMs: 300000 },
]);

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];

    /** 当前会话的标识（投假消息要带上它，界面只认这个会话那份）。 */
    const activeId = () => page.eval(`
        const view = document.querySelector(".session-view:not(.off)");
        return view ? view.dataset.sessionId || "" : "";
    `);

    /** 投一份整清单（跟后端回的那条消息一模一样）。 */
    const feed = async (list) => {
        const id = await activeId();
        await page.eval(`window.postMessage(${JSON.stringify({ type: "bashTasks", sessionId: id, tasks: list })}, "*"); return true;`);
        await page.sleep(250);
    };

    /** 投一条「某条命令有动静」（转到后台 / 跑完 / 被停）。 */
    const push = async (task) => {
        const id = await activeId();
        await page.eval(`window.postMessage(${JSON.stringify({ type: "bashTask", sessionId: id, task })}, "*"); return true;`);
        await page.sleep(250);
    };

    /**
     * 那一块现在什么样：在不在、几行、每行写了什么、块在窗格里的位置（是不是最末尾）、
     * 钟的针转到哪儿了、那行字滚不滚。
     */
    const blockState = () => page.eval(`
        const view = document.querySelector(".session-view:not(.off)");
        const pane = view ? view.querySelector(".session-pane") : null;
        if (!pane) { return { none: true }; }
        const block = pane.querySelector(".bash-running");
        const rows = block ? Array.from(block.children) : [];
        const pr = pane.getBoundingClientRect();
        return {
            none: !block,
            rows: rows.length,
            // 块是不是窗格最末尾那一样（末尾那颗胶囊在它后面是允许的）
            atEnd: !!block && (pane.lastElementChild === block
                || (block.nextElementSibling && block.nextElementSibling.classList.contains("end-hint-row")
                    && pane.lastElementChild === block.nextElementSibling)),
            items: rows.map((el) => {
                const text = el.querySelector(".tr-text");
                const time = el.querySelector(".tr-time");
                const stop = el.querySelector(".tr-act");
                const run = el.querySelector(".tr-run");
                const more = el.querySelector(".tr-more");
                const hands = el.querySelectorAll(".bash-clock .ck-min, .bash-clock .ck-hour");
                const r = el.getBoundingClientRect();
                return {
                    no: (el.querySelector(".bash-run-no") || {}).textContent || "",
                    time: time ? time.textContent : "",
                    cmd: text ? text.textContent : "",
                    hasClock: !!el.querySelector(".bash-clock svg"),
                    handCount: hands.length,
                    minName: hands.length ? getComputedStyle(el.querySelector(".bash-clock .ck-min")).animationName : "",
                    minDur: hands.length ? getComputedStyle(el.querySelector(".bash-clock .ck-min")).animationDuration : "",
                    minTransform: hands.length ? getComputedStyle(el.querySelector(".bash-clock .ck-min")).transform : "",
                    origin: hands.length ? getComputedStyle(el.querySelector(".bash-clock .ck-min")).transformOrigin : "",
                    stop: !!stop,
                    stopDisabled: !!stop && stop.disabled,
                    more: more ? more.textContent : "",
                    stopLeft: stop ? Math.round(stop.getBoundingClientRect().left) : 0,
                    timeLeft: time ? Math.round(time.getBoundingClientRect().left) : 0,
                    roll: !!text && text.classList.contains("roll"),
                    rollAnim: run ? getComputedStyle(run).animationName : "",
                    tipClick: el.classList.contains("tip-click"),
                    // 折没折行：一行字该不折（nowrap），也不会在竖着多出一截
                    nowrap: !!text && getComputedStyle(text).whiteSpace === "nowrap",
                    overY: text ? text.scrollHeight - text.clientHeight : 0,
                    h: Math.round(r.height),
                    right: Math.round(r.right),
                    title: el.title || "",
                };
            }),
            paneRight: Math.round(pr.right),
            winW: window.innerWidth,
        };
    `);

    // ---- 第一幕：一条都没在跑：消息流末尾没有那一块 ----
    const s0 = await blockState();
    console.log("\n第一幕（一条都没在跑）：\n  有那一块=" + !s0.none + " 行数=" + (s0.rows || 0));
    if (!s0.none) { problems.push("一条命令都没在跑，消息流末尾不该有那一块"); }
    await page.shot("bash-1-empty.png");

    // ---- 第二幕：投两条在跑的 + 一条跑完的：只列在跑的那两条，排在消息流最末尾 ----
    await feed(tasksAt(Date.now()));
    const s1 = await blockState();
    console.log("\n第二幕（两条在跑、一条跑完）：\n  行数=" + s1.rows + " 在最末尾=" + s1.atEnd
        + "\n  " + s1.items.map((it) => it.no + " " + it.time + " 停=" + it.stop + " 滚=" + it.roll
            + " 字行数=" + it.lines + " 高=" + it.h + " " + it.cmd).join("\n  "));
    if (s1.none) { problems.push("有命令在后台跑，消息流末尾该出现那一块"); }
    if (s1.rows !== 2) { problems.push("该只列还在跑的两条，实际 " + s1.rows + " 行"); }
    if (!s1.atEnd) { problems.push("那一块该在消息流最末尾（末尾那颗胶囊前面）"); }
    if (s1.items[0] && s1.items[0].no !== "#7") { problems.push("新的那条该排最前：#7，实际 " + (s1.items[0] || {}).no); }
    if (s1.items.some((it) => it.no === "#5")) { problems.push("跑完的那条（#5）不该列出来"); }
    if (!s1.items.every((it) => it.stop)) { problems.push("在跑的那几条右边该有一颗「停」"); }
    if (!s1.items.every((it) => it.stopLeft < it.timeLeft)) { problems.push("「停」该排在耗时左边（跟「正在跑的那一条」上那颗「放后台」一个位置）"); }
    if (!s1.items.every((it) => it.hasClock && it.handCount === 2)) { problems.push("每行头上该有一只钟（两根针）"); }
    if (!s1.items.every((it) => it.minName === "bash-clock-min" && it.minDur === "60s")) {
        problems.push("钟的长针该一分钟转一圈（实际 " + (s1.items[0] || {}).minName + " / " + (s1.items[0] || {}).minDur + "）");
    }
    if (!s1.items.every((it) => /8px 8px/.test(it.origin))) {
        problems.push("针该绕表盘正中转（transform-origin 实际 " + (s1.items[0] || {}).origin + "）");
    }
    if (!/不耽误你说话/.test(s1.items[0].title)) { problems.push("那一行的悬停提示该说清“在后台跑、不耽误你说话”，实际 " + JSON.stringify(s1.items[0].title)); }
    // 命令也走「正在跑的那一条」那一套：一长串只写核心那一段，后面灰一个「+N」，整条点开看
    console.log("  核心段：#7 " + JSON.stringify(s1.items[0].cmd) + " 后面 " + JSON.stringify(s1.items[0].more)
        + "；#6 " + JSON.stringify(s1.items[1].cmd) + " 后面 " + JSON.stringify(s1.items[1].more));
    if (!s1.items[0].cmd.startsWith("$ node dev/visit.js")) { problems.push("长命令该只写核心那一段（实际 " + JSON.stringify(s1.items[0].cmd) + "）"); }
    if (s1.items[0].more !== "+2") { problems.push("掐掉的那几段该写成一个「+2」（实际 " + JSON.stringify(s1.items[0].more) + "）"); }
    if (!s1.items[0].tipClick) { problems.push("长命令那一行该点得开（看整条命令）"); }
    if (s1.items[1].more !== "") { problems.push("只有一段的短命令后面不该挂「+N」（实际 " + JSON.stringify(s1.items[1].more) + "）"); }
    // 一行就是一行：放不下的字自己横向滚（跟「正在跑的那一条」同一套），不折行、不把这一块撑高
    if (!s1.items.every((it) => it.nowrap && it.overY <= 0)) {
        problems.push("每行都该是一行字、不折行（不折=" + s1.items.map((it) => it.nowrap).join("/") + "，竖着多出来=" + s1.items.map((it) => it.overY).join("/") + "）");
    }
    if (!s1.items[0].roll || !/^tr-roll-/.test(s1.items[0].rollAnim)) {
        problems.push("放不下的那条命令该跑马灯（滚=" + s1.items[0].roll + " 动画=" + s1.items[0].rollAnim + "）");
    }
    if (s1.items[1].roll) { problems.push("放得下的那条命令不该滚（" + s1.items[1].cmd + "）"); }
    if (s1.items[0].h !== s1.items[1].h) { problems.push("长命令与短命令那两行该一样高（" + s1.items[0].h + " vs " + s1.items[1].h + "）"); }
    if (s1.items.some((it) => it.right > s1.paneRight + 1)) { problems.push("那一块出窗格了（右 " + s1.items[0].right + " > 窗格右 " + s1.paneRight + "）"); }
    await page.shot("bash-2-running.png");

    // ---- 第二幕半：长命令那一行点得开：提示框里是整条命令（跟「正在跑的那一条」同一套） ----
    await page.eval(`document.querySelector(".session-view:not(.off) .bash-run.tip-click").click(); return true;`);
    await page.sleep(300);
    const tip = await page.eval(`
        const el = document.querySelector(".tag-tip");
        return el && !el.classList.contains("hidden") ? { shown: true, text: el.textContent } : { shown: false };
    `);
    console.log("\n第二幕半（点开那一行看整条命令）：\n  提示框开着=" + tip.shown
        + " 里面有整条命令（cd 起头、tee 收尾）=" + (tip.shown && tip.text.includes("cd dev/.scratch") && tip.text.includes("tee run.log")));
    if (!tip.shown) { problems.push("点那一行该打开提示框（看整条命令）"); }
    if (tip.shown && !(tip.text.includes("cd dev/.scratch") && tip.text.includes("tee run.log"))) {
        problems.push("提示框里该是整条命令（实际 " + JSON.stringify((tip.text || "").slice(0, 80)) + "）");
    }
    await page.eval(`document.body.click(); return true;`);
    await page.sleep(200);
    const tipClosed = await page.eval(`
        const el = document.querySelector(".tag-tip");
        return !el || el.classList.contains("hidden");
    `);
    if (!tipClosed) { problems.push("点别处没把提示框收起来"); }

    // ---- 第三幕：钟的针在走 + 用时自己往上走（不重画那一块，针的相位不被打回十二点） ----
    const t0 = await blockState();
    await page.sleep(1300);
    const t1 = await blockState();
    console.log("\n第三幕（针在走、用时在数）：\n  用时 " + t0.items[0].time + " → " + t1.items[0].time
        + "\n  长针 " + t0.items[0].minTransform + " → " + t1.items[0].minTransform);
    if (t0.items[0].time === t1.items[0].time) { problems.push("在跑的那几条用时该自己往上走（" + t0.items[0].time + " 没变）"); }
    if (t0.items[0].minTransform === t1.items[0].minTransform) { problems.push("钟的长针该在走（1.3 秒过去还停在原处：" + t1.items[0].minTransform + "）"); }

    // ---- 第四幕：点「停」：那颗按钮先灰掉，等后端推送回来再按真实状态画 ----
    await page.eval(`document.querySelector(".session-view:not(.off) .bash-run .tr-act").click(); return true;`);
    await page.sleep(200);
    const s2 = await blockState();
    console.log("\n第四幕（点停）：\n  第一行那颗「停」灰掉了=" + (s2.items[0] || {}).stopDisabled);
    if (!(s2.items[0] || {}).stopDisabled) { problems.push("点了「停」，那颗按钮该先灰掉（等后端推送回来）"); }

    // ---- 第五幕：后端推 bashTask（一条跑完、再一条跑完）：那一行当场收掉，跑光了整块收掉 ----
    const at = Date.now();
    await push({ no: 7, toolCallId: "c7", cmd: LONG_CMD, log: "l7", pid: 1234, startedAt: at - 70000, background: true, status: "done", exitCode: 0, elapsedMs: 70000 });
    const s3 = await blockState();
    console.log("\n第五幕（推一条跑完）：\n  行数=" + s3.rows + " 剩下的=" + (s3.items[0] || {}).no);
    if (s3.rows !== 1) { problems.push("跑完的那条该当场从那一块里收掉，实际还剩 " + s3.rows + " 行"); }
    if (s3.items[0] && s3.items[0].no !== "#6") { problems.push("剩下的该是还在跑的 #6，实际 " + s3.items[0].no); }
    await push({ no: 6, toolCallId: "c6", cmd: "node dev/visit.js --fake-pi --send 你好", log: "l6", pid: 1235, startedAt: at - 90000, background: true, status: "done", exitCode: 0, elapsedMs: 90000 });
    const s4 = await blockState();
    console.log("  最后一条也跑完：那一块还在=" + !s4.none);
    if (!s4.none) { problems.push("跑光了那一块该整块收掉"); }

    // ---- 第六幕：手机 400 宽：不出屏、字照旧滚（不折腾高度） ----
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 1, mobile: true });
    await page.sleep(400);
    await feed(tasksAt(Date.now()));
    await page.sleep(300);
    const phone = await blockState();
    const w = phone.items[0] || {};
    console.log("\n第六幕（手机 400 宽）：\n  行数=" + phone.rows + " 最右=" + w.right + "（屏宽 " + phone.winW + "）"
        + " 高 " + w.h + "，滚=" + w.roll + "，不折=" + w.nowrap);
    if (phone.rows !== 2) { problems.push("手机上也该有两条，实际 " + phone.rows); }
    if (w.right > phone.winW + 1) { problems.push("手机上那一块出屏了：最右 " + w.right + "、屏宽 " + phone.winW); }
    if (!w.nowrap || w.overY > 0) { problems.push("手机上也该是一行字、不折行（不折=" + w.nowrap + "，竖着多出来=" + w.overY + "）"); }
    if (!w.roll) { problems.push("手机上放不下的命令也该滚起来"); }
    if (w.h < 14) { problems.push("手机上那一行太矮了：高 " + w.h); }
    await page.shot("bash-6-phone.png");

    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
    await page.sleep(200);

    // ---- 第七幕：有了对话以后，那一块仍旧排在最后（所有消息后面、末尾那颗胶囊前面） ----
    await page.send("随便说点什么");
    await page.sleep(2500);
    await feed(tasksAt(Date.now()));
    const order = await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        const block = pane.querySelector(".bash-running");
        const row = pane.querySelector(".end-hint-row");
        const msgs = Array.from(pane.querySelectorAll(".msg"));
        return {
            msgs: msgs.length,
            blockIsLastMsg: !!block && msgs[msgs.length - 1] === block,
            rowHidden: !row || row.classList.contains("hidden"),
            rowAfter: !!block && !!row && block.nextElementSibling === row,
        };
    `);
    console.log("\n第七幕（有了对话）：\n  消息条数=" + order.msgs + " 那一块排在最后一条消息上=" + order.blockIsLastMsg
        + " 末尾胶囊排在它后面=" + (order.rowHidden ? "（没露面）" : order.rowAfter));
    if (!order.blockIsLastMsg) { problems.push("有了对话以后，那一块该排在所有消息后面"); }
    if (!order.rowHidden && !order.rowAfter) { problems.push("末尾那颗胶囊该排在那一块后面（它是页脚）"); }
    await page.shot("bash-7-with-chat.png");

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

// @ts-nocheck
/**
 * phaseMatrix —— 验「一个会话此刻处在哪个阶段」这一台机器：
 * 后端只算一处（src/sessionPhase.ts），界面五处只读，不再各挑几个字段自己拼。
 *
 *   npm run web:shot -- --fake-pi --script dev/phaseMatrix.js
 *
 * 三段：
 *   一、纯函数那张表（不碰浏览器）：每个分支各算一遍，包括“不可能凑法”该向谁低头
 *       （streaming 与 !piReady 同时为真、压缩中 streaming 是 false、工具在跑且正文在流…）；
 *   二、真跑一轮（假 pi）：跑着的时候胶囊是 streaming、末尾那颗写「卡住了」；跑完是 idle、「继续」；
 *   三、逐档投 phaseChanged 进去，看五处是不是同一个答案：
 *       模型胶囊 data-st、顶边那颗小图形 data-act、会话格那颗点（蓝 / 黄 / 绿）、末尾那颗胶囊。
 *       其中「压缩中」和「等你答」是这次新补的两档（以前界面上看不见）。
 */
const path = require("path");

const OUT = path.resolve(__dirname, "..", "out", "server", "sessionPhase.js");

/** 纯函数那张表：输入 → 阶段 / 算不算忙。 */
function checkTable() {
    const { sessionPhase, isBusyPhase, phaseNote } = require(OUT);
    const base = {
        hasSession: true, piReady: true, loading: false, hasModel: true,
        compacting: false, streaming: false, activity: "idle", writing: false,
    };
    const cases = [
        // 一档一个：从“还不能干活”到“在跑”再到“在等”
        [{ hasSession: false }, "none", false],
        [{ loading: true }, "loading", true],
        [{ loading: true, streaming: true, activity: "tool" }, "loading", true, "加载中压过一切"],
        [{ piReady: false }, "starting", false],
        [{ piReady: false, loading: true }, "loading", true],
        [{ hasModel: false }, "nomodel", false],
        [{}, "idle", false],
        [{ compacting: true }, "compacting", true, "压缩时 streaming 是 false，也得算忙"],
        [{ compacting: true, streaming: true }, "compacting", true],
        [{ streaming: true, activity: "working" }, "waiting", true],
        [{ streaming: true, activity: "working", writing: true }, "writing", true],
        [{ streaming: true, activity: "thinking", writing: true }, "thinking", true, "想压过写"],
        [{ streaming: true, activity: "tool", writing: true }, "tool", true, "工具压过写"],
        [{ streaming: true, activity: "idle" }, "waiting", true, "报 idle 但还在跑：当等"],
        [{ streaming: false, activity: "tool" }, "idle", false, "没在跑就不是工具"],
        [{ compacting: true, hasModel: false }, "nomodel", false, "没模型先说要选模型"],
        [{ piReady: false, hasSession: false }, "none", false],
    ];
    for (const [patch, want, wantBusy, why] of cases) {
        const input = { ...base, ...patch };
        const got = sessionPhase(input);
        if (got !== want) {
            throw new Error(`阶段算错了${why ? "（" + why + "）" : ""}：${JSON.stringify(patch)} 得到 ${got}，应当是 ${want}`);
        }
        if (isBusyPhase(got) !== wantBusy) {
            throw new Error(`“算不算没干完”不对：${got} 得到 ${isBusyPhase(got)}，应当是 ${wantBusy}`);
        }
        if (typeof phaseNote(got) !== "string") { throw new Error(`phaseNote(${got}) 没给一句话`); }
    }
    // 界面认的那几个 data-st 取值不许变（dev/ 下一批脚本靠它判断“可以发消息了 / 这轮跑完没”）
    const dataSt = { none: "none", loading: "loading", starting: "wait", nomodel: "nomodel", idle: "idle" };
    const phases = ["none", "loading", "starting", "nomodel", "idle", "compacting", "waiting", "writing", "thinking", "tool"];
    for (const p of phases) {
        const st = dataSt[p] || "streaming";
        if (!["none", "loading", "wait", "nomodel", "idle", "streaming"].includes(st)) {
            throw new Error(`阶段 ${p} 会落到 data-st="${st}"，那不在老那几个取值里`);
        }
    }
    console.log("一、纯函数那张表：" + cases.length + " 条全对 ✓（含不可能凑法与压缩中）");
}

module.exports = async (page) => {
    checkTable();
    await page.waitReady();
    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };
    const post = (messages) => page.eval(
        `for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);

    /** 五处各自怎么说（都是界面上看得见的东西，不是内部变量）。 */
    const read = () => page.eval(`
        const tab = document.querySelector("#sessionTabs .sn-tab.current") || document.querySelector("#sessionTabs .sn-tab");
        const icon = document.getElementById("ctxIcon");
        const act = document.getElementById("ctxAct");
        // 末尾那一行里这四颗都叫 msg-endhint，主胶囊是唯一不带后缀的那一颗
        const hint = document.querySelector(".session-view:not(.off) .msg-endhint:not(.msg-endhint-close):not(.msg-endhint-quick):not(.msg-endhint-stop)");
        return {
            st: icon ? (icon.dataset.st || "") : "",
            act: act ? (act.dataset.act || "") : "",
            tabBusy: !!(tab && tab.classList.contains("streaming")),
            tabAwaiting: !!(tab && tab.classList.contains("awaiting")),
            hintMode: hint ? (hint.dataset.mode || "") : "",
            hintShown: !!(hint && !hint.classList.contains("hidden")),
        };
    `);

    const show = (r) => `胶囊 ${r.st} / 小图 ${r.act || "（无）"} / 格子 ${r.tabBusy ? "蓝点" : r.tabAwaiting ? "黄点" : "绿点"}`
        + ` / 末尾 ${r.hintShown ? (r.hintMode === "stuck" ? "卡住了" : "继续") : "（没有）"}`;

    // ---- 二、真跑一轮（假 pi）：跑着 → 跑完 ----
    await page.send("随便说点什么");
    let live = null;
    for (let i = 0; i < 100; i++) {
        const r = await read();
        if (r.st === "streaming") { live = r; break; }
        await page.sleep(50);
    }
    check(!!live, "真跑一轮的时候，模型胶囊一直没进 streaming");
    if (live) {
        check(live.act !== "", `跑着的时候顶边那颗小图形是空的（阶段该给出等 / 写 / 想 / 工具之一）`);
        check(live.tabBusy, "跑着的时候会话格那颗点没在呼吸（不是蓝点）");
        check(live.hintShown && live.hintMode === "stuck", `跑着的时候末尾那颗胶囊该写「卡住了」，实际 ${show(live)}`);
    }
    let done = null;
    for (let i = 0; i < 200; i++) {
        const r = await read();
        if (r.st === "idle") { done = r; break; }
        await page.sleep(100);
    }
    check(!!done, "这一轮跑完之后模型胶囊没回到 idle");
    if (done) {
        check(done.act === "", `跑完了顶边那颗小图形还挂着：${done.act}`);
        check(!done.tabBusy, "跑完了会话格那颗点还在呼吸");
        check(done.hintShown && done.hintMode === "continue", `跑完了末尾那颗胶囊该写「继续」，实际 ${show(done)}`);
    }
    await page.shot("phase-matrix-idle.png");

    // 等后端安静下来（会话列表是节流的，别让它把投进去的假阶段盖回去）
    await page.sleep(800);

    // ---- 三、逐档投进去：五处同一个答案 ----
    // [阶段, attention, 期望 st, 期望 act, 期望格子, 期望末尾]
    const matrix = [
        ["waiting", "", "streaming", "waiting", "busy", "stuck"],
        ["writing", "", "streaming", "writing", "busy", "stuck"],
        ["thinking", "", "streaming", "thinking", "busy", "stuck"],
        ["tool", "", "streaming", "tool", "busy", "stuck"],
        ["tool", "answer", "streaming", "answer", "awaiting", "stuck"],
        ["compacting", "", "streaming", "waiting", "busy", "none"],
        ["loading", "", "loading", "", "busy", "none"],
        ["starting", "", "wait", "", "free", "none"],
        ["nomodel", "", "nomodel", "", "free", "none"],
        ["idle", "", "idle", "", "free", "continue"],
    ];
    const busy = (p) => ["loading", "compacting", "waiting", "writing", "thinking", "tool"].includes(p);
    console.log("");
    console.log("三、逐档投 phaseChanged（五处是不是同一个答案）：");
    for (const [phase, attention, wantSt, wantAct, wantDot, wantHint] of matrix) {
        await post([{ type: "phaseChanged", phase, busy: busy(phase), attention }]);
        // 小图形有个 300ms 的防抖（见 syncStatus 的 ACT_MIN_MS）：等它落定再读
        await page.sleep(420);
        const r = await read();
        const label = phase + (attention === "answer" ? "（等你答）" : "") + " → " + show(r);
        console.log("  " + label);
        check(r.st === wantSt, `${phase} 的模型胶囊 data-st 是 ${r.st}，应当是 ${wantSt}`);
        check(r.act === wantAct, `${phase} 的小图形 data-act 是 ${JSON.stringify(r.act)}，应当是 ${JSON.stringify(wantAct)}`);
        if (wantDot === "awaiting") {
            check(r.tabAwaiting && !r.tabBusy, `${phase} 的会话格该是黄点（等你答），实际 ${show(r)}`);
        } else if (wantDot === "busy") {
            check(r.tabBusy && !r.tabAwaiting, `${phase} 的会话格该是蓝点（没干完）`);
        } else {
            check(!r.tabBusy && !r.tabAwaiting, `${phase} 的会话格该是绿点（闲着）`);
        }
        if (wantHint === "none") {
            check(!r.hintShown, `${phase} 的时候末尾那颗胶囊不该露面，实际 ${show(r)}`);
        } else if (wantHint === "stuck") {
            check(r.hintShown && r.hintMode === "stuck", `${phase} 的时候末尾该写「卡住了」`);
        } else {
            check(r.hintShown && r.hintMode === "continue", `${phase} 的时候末尾该写「继续」`);
        }
    }
    await page.shot("phase-matrix-answer.png");

    // 「等你答」那一档截一张：黄的沙漏（跟右下角那张卡片的黄线一个意思）
    await post([{ type: "phaseChanged", phase: "tool", busy: true, attention: "answer" }]);
    await page.sleep(200);
    await page.shot("phase-matrix-answer.png");

    // 收尾回到 idle，别把页面留在假状态上
    await post([{ type: "phaseChanged", phase: "idle", busy: false, attention: "" }]);
    await page.sleep(120);

    if (problems.length) {
        console.log("");
        console.log("有问题（" + problems.length + " 条）：");
        for (const p of problems) { console.log("  ! " + p); }
        throw new Error("阶段这台机器没验过：" + problems.length + " 条");
    }
    console.log("");
    console.log("阶段这台机器：纯函数表、真跑一轮、十档逐档一致，全对上了。");
};

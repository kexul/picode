// @ts-nocheck
/**
 * endHint —— 验消息流末尾那颗胶囊（插件里的对话面板与浏览器页面共用同一份界面）。
 *
 *   FAKEPI_THINK_MS=2500 npm run web:shot -- --fake-pi --script dev/endHint.js
 *
 * 它按会话的状态换脸，两副面孔都长在消息流最末尾：
 *   1. 会话就绪、一条消息都没有时它不露面（空会话没什么可“继续”的）；
 *   2. 第一轮跑完、会话闲下来时它露面，脸是「继续」，而且就在窗格最末尾（不是输入框那一带）；
 *      同一行左边还多出两颗快捷按钮「压缩」「啊？」（只在闲着时露面）；
 *   3. 点它直接发一条“继续”：输入框里打了一半的字留在原地（不被顶掉、不被清空）；
 *   4. 生成中它换成「卡住了」，而且一直跟在最新内容后面（新内容涌上来也还在末尾）；
 *   5. 点「卡住了」：这一轮当场停住（没跑完），停稳之后补发出一条“卡住了”给模型；
 *   6. 补发的那一轮跑完，它回到「继续」；
 *   7. 页面重开（刷新 / 断线重连后整屏重画）之后，它还在最末尾 —— 重画是一条条重放的，
 *      没在重放收尾时重算，它会停在重放到的那条用户消息后面；
 *   8. 生成中重开页面（手机锁屏回来、手动刷新都算）：整屏重画完它还在末尾，脸还是「卡住了」；
 *   9. 「啊？」点下去发的是 bro 技能的正文（让人用大白话把上一条重说一遍）；
 *  10. 「压缩」点下去发 /compact，后端接下这活去调 pi 的压缩命令（假 pi 秒回）。
 *
 * 假模型每轮要停一下（FAKEPI_THINK_MS），不然生成中那一下来不及看；它认中止（见 fakePi 的 pause），
 * 所以第 5 幕点下去那一轮是真停住的（剧本没跑完就不会说出结尾那句“完事”）；
 * 第 8 幕要先看见「卡住了」再重开页面，停得够久才稳（所以这里用 2500 而不是 1200）。
 */
module.exports = async (page) => {
    /** 这颗胶囊的现状：在不在、哪一副脸、是不是末尾那一条、输入框里有什么、停止图标露没露。 */
    const state = () => page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        const row = pane ? pane.querySelector(".end-hint-row") : null;
        const h = row ? row.querySelector(".msg-endhint:not(.msg-endhint-stop):not(.msg-endhint-quick)") : null;
        const q = row ? Array.from(row.querySelectorAll(".msg-endhint-quick")) : [];
        const s = document.querySelector(".session-view:not(.off) .msg-endhint-stop");
        const inp = document.getElementById("input");
        const users = pane ? Array.from(pane.querySelectorAll(".msg.user")) : [];
        const text = pane ? pane.innerText.replace(/\\s+/g, " ") : "";
        return {
            hint: Boolean(h) && !h.classList.contains("hidden"),
            face: h ? (h.dataset.mode || "") : "",
            faceText: h ? h.innerText.replace(/\\s+/g, " ").trim() : "",
            atEnd: Boolean(row) && pane.lastElementChild === row,
            stop: Boolean(s) && !s.classList.contains("hidden"),
            // 那两颗快捷按钮（「压缩」「啊？」）：露着哪几颗（按行里的顺序）
            quick: q.filter((b) => !b.classList.contains("hidden")).map((b) => b.innerText.trim()),
            input: inp.value,
            lastUser: users.length ? users[users.length - 1].innerText.replace(/\\s+/g, " ").slice(0, 40) : "",
            // 剧本结尾那句“完事”每跑完一轮就多一句：点「卡住了」当场停住的那一轮不会说它，
            // 所以那一刻数到的句数就能看出这一轮是停住了还是自己跑完了。
            doneCount: (text.match(/完事/g) || []).length,
            // 压缩那一步看消息流里后端报的两句（「正在压缩上下文…」「已压缩上下文…」）
            compacting: text.includes("正在压缩上下文"),
            compacted: text.includes("已压缩上下文"),
        };
    `);

    /** 等某个条件成立（每 200ms 看一次，超时返回 null）。 */
    const waitFor = async (want, tries = 120) => {
        for (let i = 0; i < tries; i++) {
            const s = await state();
            if (want(s)) { return s; }
            await page.sleep(200);
        }
        return null;
    };

    await page.sleep(600);
    const empty = await state();
    console.log("① 空会话（刚就绪、一条消息都没有）：", JSON.stringify(empty));
    await page.shot("endhint-1-empty.png");

    // 第一轮：发一句，等它跑完
    await page.send("随便说点什么");
    const idle = await waitFor((s) => s.hint && s.face === "continue");
    console.log("② 第一轮跑完（闲着，脸是「继续」）：", JSON.stringify(idle));
    await page.shot("endhint-2-idle.png");

    // 打一半字留在输入框里，再点那颗「继续」
    await page.eval(`
        const el = document.getElementById("input");
        el.focus();
        el.value = "打了一半的字";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return el.value;
    `);
    await page.click(".session-view:not(.off) .session-pane .msg-endhint:not(.msg-endhint-stop):not(.msg-endhint-quick)");
    await page.sleep(300);
    console.log("③ 点完那一下：", JSON.stringify(await state()));

    // 生成中：它换成「卡住了」
    const busy = await waitFor((s) => s.hint && s.face === "stuck");
    console.log("④ 生成中（脸是「卡住了」，旁边那颗停止生成露着）：", JSON.stringify(busy));
    if (busy && !busy.stop) { console.log("  ！生成中止那颗方块该露面"); }
    if (busy && busy.quick.length) { console.log("  ！生成中不该露那两颗快捷按钮"); }
    await page.shot("endhint-3-stuck.png");

    // 生成中它一直跟在最新内容后面（正文、工具一批批长出来，它不该被落在前头）
    let drifted = null;
    for (let i = 0; i < 5; i++) {
        await page.sleep(250);
        const s = await state();
        if (s.hint && s.face === "stuck" && !s.atEnd) { drifted = s; break; }
    }

    // 点「卡住了」：这一轮当场停住，停稳之后补发一条“卡住了”
    await page.click(".session-view:not(.off) .session-pane .msg-endhint:not(.msg-endhint-stop):not(.msg-endhint-quick)");
    const stuckSent = await waitFor((s) => s.lastUser === "卡住了");
    console.log("⑤ 点完「卡住了」（这一轮停住、补发了“卡住了”）：", JSON.stringify(stuckSent));
    await page.shot("endhint-4-stuck-clicked.png");

    // 补发的那一轮跑完：它回到「继续」，还在末尾
    const again = await waitFor((s) => s.lastUser === "卡住了" && s.hint && s.face === "continue" && s.atEnd);
    console.log("⑥ 补发的那一轮跑完（回到「继续」）：", JSON.stringify(again));
    await page.shot("endhint-5-idle-again.png");

    // 页面重开：整屏重画一遍（clear + 一条条重放），它该还在末尾
    await page.cdp.send("Page.reload", { ignoreCache: false });
    await page.waitReady(60000);
    const redrawn = await waitFor((s) => s.hint && s.face === "continue" && s.atEnd);
    console.log("⑦ 页面重开、整屏重画完：", JSON.stringify(redrawn));
    await page.shot("endhint-6-after-redraw.png");

    // 「啊？」：把 bro 技能的正文发出去（正文照技能文件抄在界面代码里，不去读磁盘）
    await page.eval(`
        const q = document.querySelectorAll(".session-view:not(.off) .session-pane .msg-endhint-quick");
        if (q.length !== 2) { return false; }
        q[1].click();
        return true;
    `);
    const bro = await waitFor((s) => s.lastUser.startsWith("Restate your last message"));
    console.log("⑧ 点「啊？」（发出去的是 bro 技能的正文）：", JSON.stringify(bro));
    await page.shot("endhint-7-bro.png");
    // 等这一轮跑完（跑着的时候那颗「压缩」点不动，跟那颗「继续」一个规矩）
    const broIdle = await waitFor((s) => s.hint && s.face === "continue" && s.quick.length === 2);

    // 「压缩」：发 /compact，后端接手去调 pi 的压缩命令（假 pi 秒回）
    await page.eval(`
        const q = document.querySelectorAll(".session-view:not(.off) .session-pane .msg-endhint-quick");
        if (q.length !== 2) { return false; }
        q[0].click();
        return true;
    `);
    const compacted = await waitFor((s) => s.compacted);
    console.log("⑨ 点「压缩」（后端接了这条 /compact，pi 压完报了结果）：", JSON.stringify(compacted));
    await page.shot("endhint-8-compact.png");

    // 生成中重开页面（手机锁屏回来、手动刷新都算）：整屏重画完它还该在末尾，脸还是「卡住了」
    await page.send("继续");
    const midRunStart = await waitFor((s) => s.hint && s.face === "stuck");
    await page.cdp.send("Page.reload", { ignoreCache: false });
    const midRun = await waitFor((s) => s.hint && s.face === "stuck" && s.atEnd, 60);
    console.log("⑩ 生成中重开页面（重画完）：", JSON.stringify(midRun));
    await page.shot("endhint-7-reload-midrun.png");

    if (empty.hint) { throw new Error("空会话里不该有末尾那颗胶囊"); }
    if (empty.quick.length) { throw new Error("空会话里不该有那两颗快捷按钮"); }
    if (!idle) { throw new Error("第一轮跑完没看到「继续」"); }
    if (!idle.atEnd) { throw new Error("「继续」没在消息流末尾"); }
    if (idle.faceText !== "继续") { throw new Error("闲着时那颗胶囊写的不是「继续」：" + idle.faceText); }
    if (idle.quick.join(",") !== "压缩,啊？") { throw new Error("闲着时那两颗快捷按钮不对：" + idle.quick.join(",")); }
    if (!busy) { throw new Error("没看到生成中的「卡住了」（把 FAKEPI_THINK_MS 调大一点再跑）"); }
    if (busy.faceText !== "卡住了") { throw new Error("生成中那颗胶囊写的不是「卡住了」：" + busy.faceText); }
    if (busy.quick.length) { throw new Error("生成中那两颗快捷按钮不该露面：" + busy.quick.join(",")); }
    if (drifted) { throw new Error("生成中那颗胶囊没跟住末尾：" + JSON.stringify(drifted)); }
    if (!stuckSent) { throw new Error("点了「卡住了」之后没看到补发的那条用户消息"); }
    if (stuckSent.doneCount >= 2) { throw new Error("点了「卡住了」这一轮没停住：它自己跑完了"); }
    if (!again) { throw new Error("补发的那一轮跑完「继续」没回来"); }
    if (again.lastUser !== "卡住了") { throw new Error("点了「卡住了」没发出“卡住了”（最后一条用户消息是：" + again.lastUser + "）"); }
    if (again.input !== "打了一半的字") { throw new Error("输入框里打了一半的字被动了：" + again.input); }
    if (!redrawn) { throw new Error("页面重开（整屏重画）之后末尾那颗胶囊没回到消息流末尾"); }
    if (!bro) { throw new Error("点了「啊？」没看到 bro 技能的正文发出去"); }
    if (!broIdle) { throw new Error("点了「啊？」那一轮跑完，那两颗快捷按钮没回来"); }
    if (!compacted) { throw new Error("点了「压缩」没看到压缩完成（假 pi 的压缩结果没回来）"); }
    if (!midRunStart) { throw new Error("第二轮的「卡住了」没露面（把 FAKEPI_THINK_MS 调大一点再跑）"); }
    if (!midRun) { throw new Error("生成中重开页面之后它没回到末尾、也没换成「卡住了」"); }
};

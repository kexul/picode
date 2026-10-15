// @ts-nocheck
/**
 * continueHint —— 验消息流末尾那条「继续」（插件里的对话面板与浏览器页面共用同一份界面）。
 *
 *   FAKEPI_THINK_MS=1200 npm run web:shot -- --fake-pi --script dev/continueHint.js
 *
 * 盯六件事：
 *   1. 会话就绪、一条消息都没有时它不露面（空会话没什么可“继续”的）；
 *   2. 第一轮跑完、会话闲下来时它露面，而且就在窗格最末尾（不是输入框那一带）；
 *   3. 点它直接发一条“继续”：输入框里打了一半的字留在原地（不被顶掉、不被清空）；
 *   4. 点完它先收起来（防手快连点），生成中不露面，输入框角上是“停止生成”；
 *   5. 这一轮再跑完，它回到最末尾；
 *   6. 页面重开（刷新 / 断线重连后整屏重画）之后，它还在最末尾 —— 重画是一条条重放的，
 *      没在重放收尾时重算，它会停在重放到的那条用户消息后面。
 *
 * 假模型每轮要停一下（FAKEPI_THINK_MS），不然生成中那一下来不及看。
 */
module.exports = async (page) => {
    /** 这条提示的现状：在不在、是不是末尾那一条、输入框里有什么、停止图标露没露。 */
    const state = () => page.eval(`
        const pane = document.querySelector(".session-pane");
        const h = pane ? pane.querySelector(".msg-continue") : null;
        const s = document.getElementById("stopBtn");
        const inp = document.getElementById("input");
        const users = pane ? Array.from(pane.querySelectorAll(".msg.user")) : [];
        return {
            hint: Boolean(h) && !h.classList.contains("hidden"),
            atEnd: Boolean(h) && pane.lastElementChild === h,
            stop: Boolean(s) && !s.classList.contains("hidden"),
            padRight: getComputedStyle(inp).paddingRight,
            input: inp.value,
            lastUser: users.length ? users[users.length - 1].innerText.replace(/\\s+/g, " ").slice(0, 40) : "",
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
    await page.shot("hint-1-empty.png");

    // 第一轮：发一句，等它跑完
    await page.send("随便说点什么");
    const idle = await waitFor((s) => s.hint);
    console.log("② 第一轮跑完（闲着）：", JSON.stringify(idle));
    await page.shot("hint-2-idle.png");

    // 打一半字留在输入框里，再点那条「继续」
    await page.eval(`
        const el = document.getElementById("input");
        el.focus();
        el.value = "打了一半的字";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return el.value;
    `);
    await page.click(".session-pane .msg-continue");
    console.log("③ 点完那一下：", JSON.stringify(await state()));

    // 生成中：它收起来、角上是“停止生成”
    const busy = await waitFor((s) => s.stop);
    console.log("④ 生成中：", JSON.stringify(busy));
    await page.shot("hint-3-streaming.png");

    // 这一轮跑完：它回到末尾
    const again = await waitFor((s) => s.hint);
    console.log("⑤ 又跑完（闲着）：", JSON.stringify(again));
    await page.shot("hint-4-idle-again.png");

    // 页面重开：整屏重画一遍（clear + 一条条重放），它该还在末尾
    await page.cdp.send("Page.reload", { ignoreCache: false });
    await page.waitReady(60000);
    const redrawn = await waitFor((s) => s.hint && s.atEnd);
    console.log("⑥ 页面重开、整屏重画完：", JSON.stringify(redrawn));
    await page.shot("hint-5-after-redraw.png");
    if (!redrawn) { throw new Error("页面重开（整屏重画）之后「继续」没回到消息流末尾"); }

    if (empty.hint) { throw new Error("空会话里不该有「继续」"); }
    if (!idle) { throw new Error("第一轮跑完没看到「继续」"); }
    if (!idle.atEnd) { throw new Error("「继续」没在消息流末尾"); }
    if (!busy) { throw new Error("没看到生成中的「停止生成」（把 FAKEPI_THINK_MS 调大一点再跑）"); }
    if (!again) { throw new Error("第二轮跑完「继续」没回来"); }
    if (again.lastUser !== "继续") { throw new Error("点那条「继续」没发出“继续”（最后一条用户消息是：" + again.lastUser + "）"); }
    if (again.input !== "打了一半的字") { throw new Error("输入框里打了一半的字被动了：" + again.input); }
};

// @ts-nocheck
/**
 * continueBtn —— 验输入框角上那颗「继续」按钮（插件里的对话面板与浏览器页面共用同一份）。
 *
 *   FAKEPI_THINK_MS=1200 npm run web:shot -- --fake-pi --script dev/continueBtn.js
 *
 * 盯三件事：
 *   1. 会话就绪、闲着时那颗位置是「继续」（还没就绪时它不露面，用 --skip-ready 看）；
 *   2. 点它直接发一条“继续”，输入框里打了一半的字留在原地（不被顶掉、不被清空）；
 *   3. 生成中那颗位置换成「停止生成」，这一轮跑完再换回「继续」。
 *
 * 假模型每轮要停一下（FAKEPI_THINK_MS），不然生成中那一下来不及看。
 */
module.exports = async (page) => {
    /** 输入区这条的现状：那颗位置是谁、输入框里有什么、最后一条用户消息是什么。 */
    const state = () => page.eval(`
        const c = document.getElementById("continueBtn");
        const s = document.getElementById("stopBtn");
        const inp = document.getElementById("input");
        const row = document.getElementById("inputRow");
        const users = Array.from(document.querySelectorAll(".session-pane .msg.user"));
        return {
            cont: Boolean(c) && c.classList.contains("hidden") === false,
            stop: Boolean(s) && s.classList.contains("hidden") === false,
            hasCont: row.classList.contains("has-continue"),
            padRight: getComputedStyle(inp).paddingRight,
            input: inp.value,
            lastUser: users.length ? users[users.length - 1].innerText.replace(/\\s+/g, " ").slice(0, 30) : "",
        };
    `);

    console.log("① 刚就绪（闲着）：", JSON.stringify(await state()));
    await page.shot("cont-1-ready.png");

    // 打一半字留在输入框里，再点「继续」
    await page.eval(`
        const el = document.getElementById("input");
        el.focus();
        el.value = "打了一半的字";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return el.value;
    `);
    await page.click("#continueBtn");

    // 盯着那颗位置：生成中换成「停止生成」，跑完还得换回「继续」
    const line = [];
    let sawStop = false;
    for (let i = 0; i < 60; i++) {
        const s = await state();
        const mark = s.stop ? "停止" : (s.cont ? "继续" : "都没");
        if (line[line.length - 1] !== mark) { line.push(mark); }
        if (s.stop && !sawStop) { await page.shot("cont-2-streaming.png"); sawStop = true; }
        if (sawStop && s.cont) {
            console.log("② 这一轮跑完（闲着）：", JSON.stringify(s));
            await page.shot("cont-3-idle-again.png");
            break;
        }
        await page.sleep(200);
    }
    console.log("③ 那颗位置的换脸顺序：", line.join(" → ") || "（没看清）");
    console.log("④ 最后状态：", JSON.stringify(await state()));
    if (!sawStop) { throw new Error("没看到生成中的「停止生成」（把 FAKEPI_THINK_MS 调大一点再跑）"); }
};

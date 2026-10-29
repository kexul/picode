// @ts-nocheck
/**
 * queueResync —— 验「断线重连之后，排队里那几条显示的还是不是真的」。
 *
 * 要复现的那一路（手机上常见）：会话正跑着，我插了一句 → pi 把它排进 steering 队列（界面显示
 * “在排队”）；随后页面断线重连。断线那段里 pi 已经把排队的投递出去了（队列空了），
 * 而“队列空了”那条推送界面没收到 —— 回来之后界面上还写着“还在排队”，实际上早就发出去了。
 *
 * 这里不真叫模型（跑的时候加 `--fake-pi`，模型那头是假的、会话/历史/重放全真）：
 * 先发一句让会话里有东西（空会话不重画），排队那几条直接投给页面（跟后端推的是同一种消息），
 * 重连走真路（页面报一次 ready → 后端整屏重画，重画里会补一份排队状态的真相）。
 *
 *   npm run web:shot -- --fake-pi --script dev/queueResync.js
 */
module.exports = async (page) => {
    await page.waitReady();
    const problems = [];
    // 空会话不重画（新建的空会话本来就没什么可画）：先发一句，让这个会话有内容
    await page.send("先随便说一句，让这个会话里有东西");
    await page.waitAnswer();
    const post = (m) => page.eval(`for (const x of ${JSON.stringify(m)}) { window.postMessage(x, "*"); } return true;`);
    const bar = () => page.eval(`
        const el = document.getElementById("queueBar");
        if (!el) { return { exists: false }; }
        return {
            exists: true,
            hidden: el.classList.contains("hidden"),
            texts: Array.from(el.querySelectorAll(".qb-preview")).map((x) => x.textContent.trim()),
        };
    `);
    const sid = await page.eval(`const p = document.querySelector(".session-view:not(.off) .session-pane"); return p ? p.dataset.sessionId : "";`);

    // ---- 第一幕：pi 说有两句在排队 → 界面上写着这两句 ----
    await post([{ type: "queueUpdate", sessionId: sid, steering: ["先别看文件，直接改", "改完再跑一遍测试"], followUp: [] }]);
    await page.sleep(300);
    let b = await bar();
    console.log("第一幕（pi 说有两句在排队）：\n  队列条=" + JSON.stringify(b));
    if (!b.exists || b.hidden || b.texts.length !== 2) { problems.push("排队的那两句没显示出来：" + JSON.stringify(b)); }

    // ---- 第二幕：断线重连（页面报一次 ready → 后端整屏重画）----
    // 这期间 pi 已经把两句都投递出去了，后端手上是空队列：重画该把那块清空。
    // 重画本身没有提示文字（刷新是用户自己的动作），所以就看那块真清掉没有。
    await page.eval(`window.acquireVsCodeApi().postMessage({ type: "ready" }); return true;`);
    const started = Date.now();
    let cleared = false;
    while (Date.now() - started < 20000) {
        const b0 = await bar();
        if (!b0.exists || b0.hidden || !b0.texts.length) { cleared = true; break; }
        await page.sleep(300);
    }
    await page.sleep(600);
    b = await bar();
    console.log("第二幕（重连、整屏重画之后）：\n  重画后队列条已清空=" + cleared + " 队列条=" + JSON.stringify(b));
    if (!cleared) { problems.push("重连的整屏重画没发生（还是重画了但队列条没清）：" + JSON.stringify(b)); }
    if (b.exists && !b.hidden && b.texts.length) { problems.push("重连之后队列条里还写着那两条（实际上早发出去了）：" + JSON.stringify(b)); }

    // ---- 第三幕：重连之后 pi 又排队一句 → 照旧显示（别把这块弄成永远空着）----
    await post([{ type: "queueUpdate", sessionId: sid, steering: ["这一句是真在排队"], followUp: [] }]);
    await page.sleep(300);
    b = await bar();
    console.log("\n第三幕（重连之后又排了一句）：\n  队列条=" + JSON.stringify(b));
    if (!b.exists || b.hidden || b.texts.length !== 1 || b.texts[0] !== "这一句是真在排队") { problems.push("重连之后新排进来的那句没显示：" + JSON.stringify(b)); }

    if (problems.length) { throw new Error("有对不上的地方：\n  - " + problems.join("\n  - ")); }
    console.log("\n  全部通过。");
};

// @ts-nocheck
/**
 * deadScreen —— 验「谁在看这个会话」里的一件事：已经走掉的屏不算在看。
 *
 *   node dev/deadScreen.js
 *
 * 为什么要这一条：需要人回答的弹窗（确认框 / 输入框 / 问答题）先看“有没有屏在看这个会话”：
 * 有就让那块屏出卡片、等它答；没有就走兜底（当“否 / 没填”）。而“谁在看哪个会话”那本登记簿
 * 只登记不销号（页面的标识重连回来还要接着看原来那个，所以断开时不清它是故意的）。
 * 于是关掉的标签页永远算“有人看着”——弹窗白等到超时（确认框 2 分钟、问答 25 分钟）才走兜底。
 * 现在“在看”要再问一句“那条推送通道还在不在”（ChatHost.isClientLive → broadcaster）。
 *
 * 这里用真后端、真页面验两条：
 *   一、页面还开着、看着这个会话 → clientsViewing 里有它；
 *   二、把页面带走（离开这个地址，推送连接跟着断）→ 它立刻不算在看了，
 *       而且后端问“要不要”时当场走兜底（不到 2 秒就回来，不是等满 2 分钟）。
 */
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

async function main() {
    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };

    const harness = createHarness({
        fakePi: true,
        port: 0,
        log: (text) => { if (/错误|失败/.test(text)) { console.log("  [日志] " + text); } },
    });
    let open;
    try {
        const url = await harness.start();
        open = await openPage({ url, timeoutMs: 60000 });
        const page = open.page;
        await page.waitReady();
        await page.send("你好");
        // 等这一轮跑完：会话与“这块屏在看它”这时候才都定下来
        for (let i = 0; i < 200; i++) {
            const st = await page.eval(`return (document.getElementById("ctxIcon") || {}).dataset?.st || "";`);
            if (st === "idle") { break; }
            await sleep(100);
        }

        const host = harness.host();
        // 主会话：子会话（判官 / 派活的）不占屏
        const sessionId = [...host.panels.keys()].find((id) => !host.taba.byChildPanel(id));
        check(!!sessionId, "后端一个会话都没有（假 pi 那一轮没跑起来？）");
        if (!sessionId) { throw new Error("没法验：没有会话"); }

        const viewersNow = host.clientsViewing(sessionId);
        check(viewersNow.length === 1, `页面开着、正看着这个会话时，说有 ${viewersNow.length} 块屏在看（应当 1 块）`);
        console.log("  一、页面还在：" + viewersNow.length + " 块屏在看（" + viewersNow.join(",") + "）");

        // 把页面带走：离开这个地址，EventSource 跟着断（后端收到通道关闭）
        await page.eval("location.href = 'about:blank'; return true;");
        let gone = 0;
        for (let i = 0; i < 100; i++) {
            gone = host.clientsViewing(sessionId).length;
            if (gone === 0) { break; }
            await sleep(100);
        }
        check(gone === 0, `页面走了以后还有 ${gone} 块屏算“在看”（已经断开的通道不该算）`);
        console.log("  二、页面走了：" + gone + " 块屏在看");

        // 问一句“要不要”：没人看着就该当场走兜底（当“否”），不许等满 2 分钟。
        // 盖个 8 秒的盖：真挂着的话，这一条也不能把脚本拖成两分钟。
        const t0 = Date.now();
        const yes = await Promise.race([
            host.confirmDialog("验一下", "随便问一句", sessionId),
            sleep(8000).then(() => "一直没回来"),
        ]);
        const ms = Date.now() - t0;
        check(ms < 2000, `页面走了以后问“要不要”，等了 ${ms} 毫秒才回来（应当当场按“否”，不到 2 秒）`);
        check(yes === false, `没人看着的时候不该得到“是”，实际 ${yes}`);
        console.log("  三、没人看着时问一句：" + ms + " 毫秒后按“否”回来");

        if (problems.length) {
            console.log("");
            console.log("有问题（" + problems.length + " 条）：");
            for (const p of problems) { console.log("  ! " + p); }
            throw new Error("「谁在看」没验过：" + problems.length + " 条");
        }
        console.log("");
        console.log("「谁在看这个会话」：断开的屏不算在内，弹窗当场走兜底。");
    } finally {
        if (open) { try { await open.close(); } catch { /* 收摊出错不拦路 */ } }
        try { await harness.stop(); } catch { /* 收摊出错不拦路 */ }
    }
}

main().catch((err) => {
    console.error("出错了：" + (err && err.message ? err.message : String(err)));
    process.exit(1);
});

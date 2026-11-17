// @ts-nocheck
/**
 * queueMode —— 验输入框上头那一条（#queueBar）现在兼着「发送方式」：插话 / 排队。
 *
 *   npm run web:shot -- --fake-pi --script dev/queueMode.js
 *
 * 要验的几件事：
 *   ① 会话闲着的时候整条藏着（那会儿两种发法没区别）；
 *   ② 跑起来就露面，头一行写着「插话」、左边一颗黄点、不呼吸；
 *   ③ 点它一下变「排队」：绿点、在呼吸（animationName 是 pi-pulse）；
 *   ④ 排着的消息照旧列在下面，插话排着的黄点、排队排着的绿点；
 *   ⑤ 排队只管下一句：发出去以后自己回「插话」；页面发出去的那条消息带着 followUp: true；
 *   ⑥ Alt+Enter 也是按排队发（普通回车还是插话）；
 *   ⑦ 这一轮跑完（streaming 收掉）、队列也空了，整条自己收掉。
 *
 * 跑着/排队这些状态直接投给页面（跟后端推的是同一种消息），不靠真模型 —— 只有发消息那两下
 * 走真路（--fake-pi：模型是假的，会话编排是真的）。
 */
module.exports = async (page) => {
    await page.waitReady();
    // 空会话不重画：先发一句，让这个会话有东西
    await page.send("先随便说一句，让这个会话里有东西");
    await page.waitAnswer();

    const problems = [];
    const note = (what, ok, detail) => {
        console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? "  " + detail : ""}`);
        if (!ok) { problems.push(what + (detail ? "：" + detail : "")); }
    };
    const sid = await page.eval(`const p = document.querySelector(".session-view:not(.off) .session-pane"); return p ? p.dataset.sessionId : "";`);
    const post = (m) => page.eval(`for (const x of ${JSON.stringify(m)}) { window.postMessage(x, "*"); } return true;`);

    // 页面往外发的消息留一份（照旧照发，只是记下来看 followUp 那一格）
    await page.eval(`
        const api = window.acquireVsCodeApi();
        if (!window.__sent) {
            window.__sent = [];
            const orig = api.postMessage.bind(api);
            api.postMessage = (m) => { try { window.__sent.push(m); } catch (e) {} return orig(m); };
        }
        return true;
    `);
    const sentSends = () => page.eval(`return (window.__sent || []).filter((m) => m && m.type === "send").map((m) => ({ text: String(m.text || "").slice(0, 20), followUp: m.followUp === true }));`);

    /** 那一条现在长什么样。 */
    const look = () => page.eval(`
        const bar = document.getElementById("queueBar");
        if (!bar) { return { exists: false }; }
        const mode = bar.querySelector(".qb-mode");
        const dot = mode ? mode.querySelector(".qb-dot") : null;
        const cs = dot ? getComputedStyle(dot) : null;
        const label = mode ? mode.querySelector(".qb-mode-label") : null;
        return {
            exists: true,
            hidden: bar.classList.contains("hidden"),
            mode: label ? label.textContent.trim() : null,
            queued: mode ? mode.classList.contains("queued") : null,
            dotColor: cs ? cs.backgroundColor : null,
            dotAnim: cs ? cs.animationName : null,
            queuedTexts: [...bar.querySelectorAll(".qb-block .qb-preview")].map((e) => e.textContent.trim()),
            queuedDots: [...bar.querySelectorAll(".qb-block .qb-dot")].map((e) => getComputedStyle(e).backgroundColor),
        };
    `);
    /** 那颗点是什么颜色，只看红绿蓝谁高：黄（红绿高、蓝低）、绿（绿最高）。 */
    const rgb = (c) => String(c).match(/\d+/g)?.map(Number) || [0, 0, 0];
    const isYellow = (c) => { const [r, g, b] = rgb(c); return r > 140 && g > 90 && b < 80 && r >= g; };
    const isGreen = (c) => { const [r, g, b] = rgb(c); return g > 120 && g > r + 30 && g > b + 30; };

    // ---- ① 闲着：整条藏着 ----
    let b = await look();
    note("闲着的时候那一条藏着（不占位置）", b.exists && b.hidden, JSON.stringify({ hidden: b.hidden }));

    // ---- ② 跑起来：露面，默认「插话」黄点、不呼吸 ----
    await post([{ type: "streamStart", sessionId: sid, activity: "working" }]);
    await page.sleep(300);
    b = await look();
    note("跑着的时候露面了", b.exists && !b.hidden, JSON.stringify({ hidden: b.hidden }));
    note("默认那一档写着「插话」", b.mode === "插话", JSON.stringify({ mode: b.mode }));
    note("插话那颗点是黄点、不呼吸", isYellow(b.dotColor) && b.dotAnim === "none", JSON.stringify({ dotColor: b.dotColor, anim: b.dotAnim }));

    // ---- ③ 点一下：变「排队」，绿点、呼吸 ----
    await page.click("#queueBar .qb-mode");
    await page.sleep(300);
    b = await look();
    note("点一下变「排队」", b.mode === "排队" && b.queued === true, JSON.stringify({ mode: b.mode, queued: b.queued }));
    note("排队那颗点是绿点、在呼吸", isGreen(b.dotColor) && b.dotAnim === "pi-pulse", JSON.stringify({ dotColor: b.dotColor, anim: b.dotAnim }));

    // ---- ④ 排着的消息：插话排着的黄点、排队排着的绿点 ----
    await post([{ type: "queueUpdate", sessionId: sid, steering: ["半路插一句"], followUp: ["这一句等这一轮跑完"] }]);
    await page.sleep(300);
    b = await look();
    note("排着的两句都列出来了", b.queuedTexts.length === 2, JSON.stringify({ texts: b.queuedTexts }));
    note("插话排着的黄点、排队排着的绿点（跟上面那一档一个色）",
        isYellow(b.queuedDots[0]) && isGreen(b.queuedDots[1]), JSON.stringify({ dots: b.queuedDots }));

    // ---- ⑤ 排队只管下一句：发出去就回「插话」，而且 message 上带着 followUp ----
    const before = (await sentSends()).length;
    await page.send("这句按排队发");
    await page.sleep(300);
    const after = await sentSends();
    const last = after[before] || after[after.length - 1] || {};
    note("排队模式下发出去的那条带着 followUp: true", last.followUp === true, JSON.stringify(last));
    b = await look();
    note("发完自己回「插话」", b.mode !== "排队" || b.hidden, JSON.stringify({ mode: b.mode, hidden: b.hidden }));
    await page.waitAnswer();

    // ---- ⑥ Alt+Enter 也是排队；普通回车还是插话 ----
    const n1 = (await sentSends()).length;
    await page.eval(`
        const el = document.getElementById("input");
        el.focus();
        el.value = "Alt 回车这一句";
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
        return true;
    `);
    await page.sleep(300);
    const alt = (await sentSends())[n1] || {};
    note("Alt+Enter 发的是排队（followUp: true）", alt.followUp === true, JSON.stringify(alt));
    await page.waitAnswer();

    const n2 = (await sentSends()).length;
    await page.send("普通回车这一句");
    await page.sleep(300);
    const plain = (await sentSends())[n2] || {};
    note("普通回车还是插话（followUp: false）", plain.followUp === false, JSON.stringify(plain));
    await page.waitAnswer();

    // ---- ⑦ 跑完了、队列也空了：整条收掉 ----
    await post([{ type: "queueUpdate", sessionId: sid, steering: [], followUp: [] }, { type: "streamEnd", sessionId: sid, activity: "idle" }]);
    await page.sleep(400);
    b = await look();
    note("跑完、队列也空了以后整条收掉", b.exists && b.hidden, JSON.stringify({ hidden: b.hidden }));

    // 再看一眼排队那一档的样子（截图用：把这句空着的那一档摆出来）
    await post([{ type: "streamStart", sessionId: sid, activity: "working" },
        { type: "queueUpdate", sessionId: sid, steering: [], followUp: ["等这一轮跑完再把这一句交给它"] }]);
    await page.sleep(300);
    await page.click("#queueBar .qb-mode");
    await page.sleep(400);
    await page.shot("queue-mode.png");

    if (problems.length) {
        console.log("\n没验过：" + problems.length + " 处");
        for (const p of problems) { console.log("  · " + p); }
        throw new Error("queueMode 有 " + problems.length + " 处没过");
    }
    console.log("\n都过了。");
    return true;
};

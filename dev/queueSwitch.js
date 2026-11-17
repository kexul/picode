// @ts-nocheck
/**
 * queueSwitch —— 验输入框上头那些排着的消息：点一条就换一种发法（插话 ⇄ 排队）。
 *
 *   npm run web:shot -- --fake-pi --script dev/queueSwitch.js
 *
 * 要验的几件事：
 *   ① 只是跑着、没有排着的消息时，那一条整条藏着（不先露出一行"插话"式的提示）；
 *   ② 插了一句、又排了一句：一条一行，插话的黄点、排队的绿点；
 *   ③ 点插话那条：页面发出去一条 queueSwitch（kind / index / text 都对得上）；
 *   ④ 后端收下以后真把它挪到排队的队尾（走 pi 的 clear_queue + 按新方式重排）：两条都成绿点；
 *   ⑤ 每句话在对话里只出现一次（清空重排没弄出重复的一遍）；
 *   ⑥ 这一轮跑完、队列空了，整条自己收掉；
 *   ⑦ 排进去那两句的发送方式是对的：普通回车＝插话（followUp: false）、Alt+Enter＝排队（true）。
 *
 * 这一轮得跑得够久，人才来得及插两句进去：第一句说「慢慢来」，假模型会先说一句、停 6 秒再收尾
 * （见 dev/fakePi.js 里那一段）。跑着的时候不靠真模型：只有发消息、清空重排那几下走真路。
 */
module.exports = async (page) => {
    await page.waitReady();
    const problems = [];
    const note = (what, ok, detail) => {
        console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? "  " + detail : ""}`);
        if (!ok) { problems.push(what + (detail ? "：" + detail : "")); }
    };
    const rgb = (c) => String(c).match(/\d+/g)?.map(Number) || [0, 0, 0];
    const isYellow = (c) => { const [r, g, b] = rgb(c); return r > 140 && g > 90 && b < 80 && r >= g; };
    const isGreen = (c) => { const [r, g, b] = rgb(c); return g > 120 && g > r + 30 && g > b + 30; };

    /** 那条排着的消息现在长什么样。 */
    const bar = () => page.eval(`
        const el = document.getElementById("queueBar");
        if (!el) { return { exists: false }; }
        return {
            exists: true,
            hidden: el.classList.contains("hidden"),
            rows: Array.from(el.querySelectorAll(".qb-block")).map((b) => {
                const dot = b.querySelector(".qb-dot");
                const text = b.querySelector(".qb-preview");
                return {
                    text: text ? text.textContent.trim() : "",
                    follow: b.classList.contains("follow"),
                    dot: dot ? getComputedStyle(dot).backgroundColor : null,
                };
            }),
        };
    `);

    // 页面往外发的消息留一份（照旧照发，只是记下来看 followUp / queueSwitch）
    await page.eval(`
        const api = window.acquireVsCodeApi();
        if (!window.__sent) {
            window.__sent = [];
            const orig = api.postMessage.bind(api);
            api.postMessage = (m) => { try { window.__sent.push(m); } catch (e) {} return orig(m); };
        }
        return true;
    `);
    const sentOf = (type) => page.eval(`return (window.__sent || []).filter((m) => m && m.type === ${JSON.stringify(type)});`);

    // 让这个会话里有东西（空会话不重画），再等着它闲着
    await page.send("先随便说一句，让这个会话里有东西");
    await page.waitAnswer();

    // ---- ① 跑着但没排着的消息：整条藏着 ----
    await page.send("慢慢来，这一轮跑久一点");
    await page.sleep(800);
    let b = await bar();
    note("只是跑着、没有排着的消息时整条藏着", b.exists && b.hidden && b.rows.length === 0,
        JSON.stringify({ hidden: b.hidden, rows: b.rows.length }));

    // ---- ② 插一句（普通回车）、排一句（Alt+Enter）：一条一行，黄点 / 绿点 ----
    await page.send("插话这一句");
    await page.eval(`
        const el = document.getElementById("input");
        el.focus();
        el.value = "排队这一句";
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
        return true;
    `);
    await page.sleep(900);
    b = await bar();
    note("插话那句在前、排队那句在后，各占一行",
        b.rows.length === 2 && b.rows[0].text === "插话这一句" && b.rows[1].text === "排队这一句",
        JSON.stringify(b.rows.map((r) => r.text)));
    note("插话那条是黄点、排队那条是绿点",
        isYellow(b.rows[0]?.dot) && isGreen(b.rows[1]?.dot) && !b.rows[0]?.follow && b.rows[1]?.follow,
        JSON.stringify(b.rows));

    // ---- ⑦ 这两句的发送方式（普通回车 / Alt+Enter）----
    const sends = await sentOf("send");
    const steerSend = sends.find((m) => m.text === "插话这一句") || {};
    const followSend = sends.find((m) => m.text === "排队这一句") || {};
    note("普通回车发出去的是插话（followUp: false）", steerSend.followUp === false, JSON.stringify({ followUp: steerSend.followUp }));
    note("Alt+Enter 发出去的是排队（followUp: true）", followSend.followUp === true, JSON.stringify({ followUp: followSend.followUp }));

    // ---- ③ 点插话那条：页面发一条 queueSwitch ----
    await page.click("#queueBar .qb-block:not(.follow) .qb-head");
    await page.sleep(400);
    const switches = await sentOf("queueSwitch");
    const sw = switches[switches.length - 1] || {};
    note("点那条发出去的是 queueSwitch，认的就是这一条",
        sw.kind === "steer" && sw.index === 0 && sw.text === "插话这一句",
        JSON.stringify({ kind: sw.kind, index: sw.index, text: sw.text }));

    // ---- ④ 后端真把它挪到排队的队尾：两条都成绿点 ----
    let moved = null;
    for (let i = 0; i < 20; i++) {
        b = await bar();
        if (b.rows.length === 2 && b.rows.every((r) => r.follow)) { moved = b; break; }
        await page.sleep(300);
    }
    note("挪过去以后两条都排在「排队」那一队（绿点）",
        !!moved && isGreen(moved.rows[0].dot) && isGreen(moved.rows[1].dot) && moved.rows[1].text === "插话这一句",
        JSON.stringify(moved ? moved.rows.map((r) => ({ t: r.text, follow: r.follow })) : b.rows));

    // ---- ⑤⑥ 这一轮跑完、队列空了：整条自己收掉；每句话只说了一次 ----
    let idle = false;
    for (let i = 0; i < 120; i++) {
        const state = await page.eval(`
            const el = document.getElementById("queueBar");
            const ctx = document.getElementById("ctxIcon");
            return { hidden: !el || el.classList.contains("hidden"), st: ctx ? ctx.dataset.st : "" };
        `);
        if (state.hidden && state.st !== "streaming") { idle = true; break; }
        await page.sleep(500);
    }
    note("跑完、队列也空了以后整条自己收掉", idle, JSON.stringify({ idle }));
    const userTexts = await page.eval(`return Array.from(document.querySelectorAll(".msg.user")).map((e) => e.innerText.trim());`);
    const count = (t) => userTexts.filter((x) => x.indexOf(t) >= 0).length;
    note("两句在对话里各只出现一次（清空重排没弄出重复的）",
        count("插话这一句") === 1 && count("排队这一句") === 1,
        JSON.stringify({ 插话: count("插话这一句"), 排队: count("排队这一句") }));

    // 截图用：把排着的两条摆出来看一眼
    await page.eval(`for (const x of [
        { type: "streamStart", sessionId: (document.querySelector(".session-pane") || {}).dataset?.sessionId, activity: "working" },
        { type: "queueUpdate", sessionId: (document.querySelector(".session-pane") || {}).dataset?.sessionId,
          steering: ["半路插一句，改个方向"], followUp: ["等这一轮跑完再把这一句交给它"] }
    ]) { window.postMessage(x, "*"); } return true;`);
    await page.sleep(400);
    await page.shot("queue-switch.png");

    if (problems.length) {
        console.log("\n没验过：" + problems.length + " 处");
        for (const p of problems) { console.log("  · " + p); }
        throw new Error("queueSwitch 有 " + problems.length + " 处没过");
    }
    console.log("\n都过了。");
    return true;
};

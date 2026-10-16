// @ts-nocheck
/**
 * userRail —— 验消息流右边那条「用户消息导航」（一排短横线，停上去出一行字，点一下跳过去）。
 *
 * 真让模型攒出几十轮对话不好凑，这里直接往页面里投假消息（跟后端推的是同一种消息）；一次验：
 *   · 条数与位置：一句一根，第 1 根在最上头、最后一条在最下头，中间等分；条数多了整列挤紧；
 *   · 停上去出一行字（那条消息的开头），字在导航条左边、不出屏幕；
 *   · 点一根：那一条滚到窗格顶上、闪一下底色；
 *   · 往回滚：亮着的是「正读着的那一条」；贴底时永远亮最后一根；
 *   · 空会话、只有一条用户消息：整条不出现，而且那一条不挡消息流右边的鼠标；
 *   · 整屏重画（刷新 / 切会话 / 重连）之后跟着重画一次，条数还是对的。
 *
 *   npm run web:shot -- --width 900 --height 700 --script dev/userRail.js
 * 图落在 dev/shots/。
 */

/** 投进去的九句用户的话。 */
const ROUNDS = [
    "消息流右边想加一条导航，一排短横线，点一下跳到我说过的那一句，先做出来看看样子。",
    "条数少的时候会怎么样？",
    "停上去出什么字？",
    "点一下之后呢？会不会滚得太生硬？",
    "把我这几句话的先后顺序记住就行，别的不用。",
    "手机上怎么办？手机没有「停上去」。",
    "这条导航会不会挡住消息流右边那根滚动条？",
    "刷新页面、切会话、点「加载更早」之后它还准吗？",
    "最后一句：空会话里它长什么样？",
];

/** 模型的回复（每轮都这一长段，撑出可以滚动的长会话）。 */
const REPLY = [
    "记下了，这几条先这么做：",
    "",
    "1. 位置：贴消息流右边一条细导航，平时淡淡的，鼠标扫上去才清楚；",
    "2. 排列：等间距，第 1 条在最上头、最后一条在最下头，条数多了挤紧；",
    "3. 停上去：出一行字，是那条消息的开头；",
    "4. 点一下：那一条滚到顶上，闪一下底色；",
    "5. 读着的那一条亮着，手机上点一下直接跳。",
    "",
    "有不对的地方你说一句，我照着改。",
].join("\n");

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];

    /** 投一批假对话（n 轮：一句用户的话 + 一段回复），先把窗格清空重来。 */
    const feed = async (n) => {
        const messages = [{ type: "clear" }];
        for (let i = 0; i < n; i++) {
            messages.push({ type: "userMessage", text: ROUNDS[i % ROUNDS.length] });
            messages.push({ type: "assistantFull", text: REPLY + "\n\n" + REPLY });
        }
        await page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
        await page.sleep(600);
    };

    /** 导航条此刻的样子：几根、间距、第一根与最后一根在条里的位置、哪根亮着、挡不挡鼠标。 */
    const look = () => page.eval(`
        const rail = document.querySelector(".session-view .user-rail");
        if (!rail) { return { none: true }; }
        const rb = rail.getBoundingClientRect();
        const ticks = Array.from(rail.querySelectorAll(".rail-tick"));
        const rel = (t) => Math.round(t.getBoundingClientRect().top - rb.top);
        let current = -1;
        ticks.forEach((t, i) => { if (t.classList.contains("current")) { current = i; } });
        return {
            n: ticks.length,
            empty: rail.classList.contains("empty"),
            pointer: getComputedStyle(rail).pointerEvents,
            height: Math.round(rb.height),
            gap: ticks.length > 1 ? rel(ticks[1]) - rel(ticks[0]) : 0,
            first: ticks.length ? rel(ticks[0]) : 0,
            last: ticks.length ? rel(ticks[ticks.length - 1]) : 0,
            current,
        };
    `);
    /** 窗格顶上第一条露出来的用户消息是第几条（0 起）与它离窗格顶多远。 */
    const topUser = () => page.eval(`
        const pane = document.querySelector(".session-view .session-pane");
        const pt = pane.getBoundingClientRect().top;
        const all = Array.from(pane.querySelectorAll(".msg.user"));
        let idx = -1, at = 0;
        all.forEach((el, i) => {
            const t = el.getBoundingClientRect().top;
            if (idx < 0 && t >= pt - 2) { idx = i; at = Math.round(t - pt); }
        });
        return { idx, at };
    `);
    const move = (x, y) => page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y), button: "none" });
    const clickAt = async (x, y) => {
        await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
        await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
    };
    /** 第 i 根短横线在屏幕上的位置。 */
    const tickAt = (i) => page.eval(`
        const rail = document.querySelector(".session-view .user-rail");
        const t = rail.querySelectorAll(".rail-tick")[${i}];
        if (!t) { return null; }
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    const show = (s) => "根数=" + s.n + " 间距=" + s.gap + " 第一根=" + s.first + " 最后一根=" + s.last + " 亮着=" + s.current;

    // ---- 第一幕：九句话：一句一根，整列居中（每根之间最松 26 像素） ----
    await feed(9);
    await move(20, 20);
    await page.sleep(200);
    let s = await look();
    console.log("\n第一幕（九句话）：\n  " + show(s) + " 整条高=" + s.height);
    if (s.n !== 9) { problems.push("九句话该有九根，实际 " + s.n + " 根"); }
    if (s.gap > 26) { problems.push("相邻两根之间该最多 26 像素，实际 " + s.gap); }
    if (s.first < 1 || s.last > s.height - 1) { problems.push("整列跑出这条了：第一根 " + s.first + "、最后一根 " + s.last + "、条高 " + s.height); }
    if (Math.abs(s.first - (s.height - s.last)) > 2) { problems.push("整列没居中：上头留 " + s.first + "、下头留 " + (s.height - s.last)); }
    if (s.current !== 8) { problems.push("贴着底的时候该亮最后一根，实际亮第 " + s.current + " 根"); }
    await page.shot("rail-1-overview.png");

    // ---- 第二幕：停在第五根上：左边出一行字 ----
    const mid = await tickAt(4);
    await move(mid.x, mid.y);
    await page.sleep(300);
    const tip = await page.eval(`
        const el = document.querySelector(".rail-tip");
        const rail = document.querySelector(".session-view .user-rail");
        if (!el || el.classList.contains("hidden")) { return { shown: false }; }
        const b = el.getBoundingClientRect();
        return { shown: true, text: el.textContent, left: Math.round(b.left), right: Math.round(b.right), railLeft: Math.round(rail.getBoundingClientRect().left), top: Math.round(b.top) };
    `);
    console.log("\n第二幕（停在第五根上）：\n  出了一行字=" + tip.shown + " 写的=" + JSON.stringify(tip.text));
    if (!tip.shown) { problems.push("停在那一根上没出那行字"); }
    if (tip.shown && !tip.text.startsWith("把")) { problems.push("那行字不是那一条消息的开头：" + JSON.stringify(tip.text)); }
    if (tip.shown && tip.right > tip.railLeft + 1) { problems.push("那行字压到导航条上了：右 " + tip.right + " > 条左 " + tip.railLeft); }
    if (tip.shown && tip.left < 4) { problems.push("那行字出屏幕了：左 " + tip.left); }
    await page.shot("rail-2-tip.png");

    // ---- 第三幕：点这一根：那一条滚到窗格顶上，闪一下底色 ----
    await clickAt(mid.x, mid.y);
    await page.sleep(140);
    const jumped = await topUser();
    const flashing = await page.eval(`
        const el = document.querySelector(".session-view .session-pane .msg.user.msg-flash");
        return el ? (el.dataset.raw || "").slice(0, 10) : "";
    `);
    console.log("\n第三幕（点第五根）：\n  顶上这条是第 " + (jumped.idx + 1) + " 句（离窗格顶 " + jumped.at + " 像素）在闪=" + JSON.stringify(flashing));
    if (jumped.idx !== 4) { problems.push("点第五根该跳到第五句，实际顶上这条是第 " + (jumped.idx + 1) + " 句"); }
    if (jumped.at < 0 || jumped.at > 20) { problems.push("跳过去之后那条没贴到窗格顶上，离着 " + jumped.at + " 像素"); }
    if (!flashing.startsWith("把")) { problems.push("跳过去的那条没在闪：" + JSON.stringify(flashing)); }
    await page.shot("rail-3-jumped.png");
    await page.sleep(1500);

    // ---- 第四幕：往回滚：亮着的是「正读着的那一条」 ----
    await page.eval(`
        const pane = document.querySelector(".session-view .session-pane");
        pane.scrollTop = pane.querySelectorAll(".msg.user")[2].offsetTop + 40;
        return true;
    `);
    await move(20, 20);
    await page.sleep(300);
    s = await look();
    console.log("\n第四幕（滚到第三句那儿）：\n  " + show(s));
    if (s.current !== 2) { problems.push("这时该亮第 3 根，实际亮第 " + (s.current + 1) + " 根"); }
    await page.shot("rail-4-current.png");

    // ---- 第五幕：空会话 / 只有一条用户消息：整条不出现，也不挡鼠标 ----
    await feed(0);
    let empty = await look();
    await feed(1);
    s = await look();
    console.log("\n第五幕（空会话、只有一句）：\n  空会话：" + show(empty) + " 收着=" + empty.empty + " 挡不挡鼠标=" + empty.pointer
        + "\n  只有一句：" + show(s) + " 收着=" + s.empty);
    if (!empty.empty || !s.empty) { problems.push("空会话 / 只有一句时整条该收着"); }
    if (empty.n || s.n) { problems.push("空会话 / 只有一句时不该画短横线"); }
    if (empty.pointer !== "none" || s.pointer !== "none") { problems.push("收着的时候还挡着鼠标：" + empty.pointer + " / " + s.pointer); }
    await page.shot("rail-5-single.png");

    // ---- 第六幕：六十句：整列挤紧、铺满这一条；点最上面那根回到第一句 ----
    await feed(60);
    await move(20, 20);
    await page.sleep(300);
    s = await look();
    console.log("\n第六幕（六十句）：\n  " + show(s) + " 整条高=" + s.height);
    if (s.n !== 60) { problems.push("六十句该有六十根，实际 " + s.n + " 根"); }
    if (s.gap < 2) { problems.push("挤得两根叠在一起了，间距 " + s.gap); }
    if (s.first > 1 || s.last < s.height - 2) { problems.push("条数多的时候该铺满这一条：第一根 " + s.first + "、最后一根 " + s.last + "、条高 " + s.height); }
    const top0 = await tickAt(0);
    await clickAt(top0.x, top0.y);
    await page.sleep(200);
    const back = await topUser();
    console.log("  点最上面那根：顶上这条是第 " + (back.idx + 1) + " 句");
    if (back.idx !== 0) { problems.push("点最上面那根该回到第一句，实际第 " + (back.idx + 1) + " 句"); }
    await page.shot("rail-6-many.png");

    // ---- 第七幕：整屏重画（刷新 / 切会话 / 重连）：跟着重画一次，条数还是对的 ----
    await page.eval(`window.postMessage({ type: "clear", keepDraft: true }, "*"); return true;`);
    await page.sleep(200);
    const cleared = await look();
    await feed(9);
    s = await look();
    console.log("\n第七幕（整屏重画）：\n  清空时：" + show(cleared) + " 收着=" + cleared.empty + "\n  重放完：" + show(s));
    if (!cleared.empty || cleared.n) { problems.push("清空之后导航条该收着"); }
    if (s.n !== 9) { problems.push("重放完该还是九根，实际 " + s.n + " 根"); }

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

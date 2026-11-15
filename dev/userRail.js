// @ts-nocheck
/**
 * userRail —— 验消息流右边那条「用户消息导航」（一排短横线，停上去出一行字，点一下跳过去）。
 *
 * 真让模型攒出几十轮对话不好凑，这里直接往页面里投假消息（跟后端推的是同一种消息）；一次验：
 *   · 条数与位置：一句一根，第 1 根在最上头、最后一条在最下头，中间等分；条数多了整列挤紧；
 *   · 停上去在它左边弹出整张清单：你发过的每一句一行（开头那几个字，一行放不下的省略），
 *     正读着的那一行蓝着；沿着这一条上下挑，清单里对应那行跟着亮；鼠标走开就收起来；
 *   · 点清单里一行 / 直接点一根：那一条滚到窗格顶上、闪一下底色；
 *   · 往回滚：亮着的是「正读着的那一条」；贴底时永远亮最后一根；
 *   · 空会话、只有一条用户消息：整条不出现，而且那一条不挡消息流右边的鼠标；
 *   · 三十句：整列挤紧、铺满这一条；点最上面那根回到第一句；
 *   · 整屏重画（刷新 / 切会话 / 重连）之后跟着重画一次，条数还是对的；
 *   · 画的那一下还没排上版（量出来 0 高）：露出来以后自己补画，不用等人再发一条；
 *   · 轮数超了、老几轮被搬到顶上那条占位里：导航条只画窗格里摆着的那几条；
 *   · 手机上（触屏 + 窄屏）这一条不露面。
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
    "5. 读着的那一条亮着，手机上这一条不露面。",
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
            display: getComputedStyle(rail).display,
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
    /** 清单里第 i 行在屏幕上的位置。 */
    const rowAt = (i) => page.eval(`
        const list = document.querySelector(".session-view .rail-list");
        const row = list && list.querySelectorAll(".rail-row")[${i}];
        if (!row) { return null; }
        const r = row.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    /** 清单此刻的样子：开着没、几行、各行写的字、哪行亮着、哪行是“正读着的那一句”、出没出屏。 */
    const listNow = () => page.eval(`
        const list = document.querySelector(".session-view .rail-list");
        const rail = document.querySelector(".session-view .user-rail");
        if (!list || list.classList.contains("hidden")) { return { shown: false }; }
        const rows = Array.from(list.querySelectorAll(".rail-row"));
        const b = list.getBoundingClientRect();
        return {
            shown: true,
            n: rows.length,
            texts: rows.map((r) => r.querySelector(".rr-text").textContent),
            hovered: rows.findIndex((r) => r.classList.contains("hover")),
            current: rows.findIndex((r) => r.classList.contains("current")),
            left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom),
            railLeft: Math.round(rail.getBoundingClientRect().left),
            vh: window.innerHeight, vw: window.innerWidth,
        };
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
    if (s.current !== 8) { problems.push("贴着底的时候该亮最后一根，实际亮第 " + (s.current + 1) + " 根"); }
    await page.shot("rail-1-overview.png");

    // ---- 第二幕：停到这一条上：左边弹出整张清单（你发过的每一句一行） ----
    const mid = await tickAt(4);
    await move(mid.x, mid.y);
    await page.sleep(300);
    const list = await listNow();
    console.log("\n第二幕（停到第五根上）：\n  清单开着=" + list.shown + " 行数=" + list.n
        + " 亮着第 " + (list.hovered + 1) + " 行、正读着第 " + (list.current + 1) + " 行"
        + "\n  第一行=" + JSON.stringify(list.texts && list.texts[0])
        + "\n  第五行=" + JSON.stringify(list.texts && list.texts[4]));
    if (!list.shown) { problems.push("停到这一条上没弹出清单"); }
    if (list.shown && list.n !== 9) { problems.push("清单里该是九行，实际 " + list.n + " 行"); }
    if (list.shown && !list.texts[0].startsWith("消息流右边")) { problems.push("第一行不是第一句的开头：" + JSON.stringify(list.texts[0])); }
    if (list.shown && !list.texts[4].startsWith("把我这几句话")) { problems.push("第五行不是第五句的开头：" + JSON.stringify(list.texts[4])); }
    if (list.shown && list.hovered !== 4) { problems.push("鼠标停在第 5 根，该亮第 5 行，实际第 " + (list.hovered + 1) + " 行"); }
    if (list.shown && list.current !== 8) { problems.push("贴着底时「正读着」该是最后一行，实际第 " + (list.current + 1) + " 行"); }
    if (list.shown && list.right > list.railLeft + 1) { problems.push("清单压到导航条上了：右 " + list.right + " > 条左 " + list.railLeft); }
    if (list.shown && list.left < 4) { problems.push("清单出屏幕了：左 " + list.left); }
    if (list.shown && (list.top < 0 || list.bottom > list.vh)) { problems.push("清单上下一头出屏幕了：上 " + list.top + "、下 " + list.bottom + "、屏高 " + list.vh); }
    await page.shot("rail-2-list.png");

    // ---- 第三幕：点清单里的第五行：那一条滚到窗格顶上，闪一下底色，清单收起来 ----
    const row4 = await rowAt(4);
    await clickAt(row4.x, row4.y);
    await page.sleep(140);
    const jumped = await topUser();
    const flashing = await page.eval(`
        const el = document.querySelector(".session-view .session-pane .msg.user.msg-flash");
        return el ? (el.dataset.raw || "").slice(0, 10) : "";
    `);
    const afterClick = await listNow();
    console.log("\n第三幕（点清单第五行）：\n  顶上这条是第 " + (jumped.idx + 1) + " 句（离窗格顶 " + jumped.at + " 像素）在闪=" + JSON.stringify(flashing)
        + " 清单还开着=" + afterClick.shown);
    if (jumped.idx !== 4) { problems.push("点第五行该跳到第五句，实际顶上这条是第 " + (jumped.idx + 1) + " 句"); }
    if (jumped.at < 0 || jumped.at > 20) { problems.push("跳过去之后那条没贴到窗格顶上，离着 " + jumped.at + " 像素"); }
    if (!flashing.startsWith("把")) { problems.push("跳过去的那条没在闪：" + JSON.stringify(flashing)); }
    if (afterClick.shown) { problems.push("点完一行清单该收起来"); }
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

    // ---- 第六幕：三十句：整列挤紧、铺满这一条；点最上面那根回到第一句 ----
    //（窗格里最多留 LIVE_MAX_TURNS = 40 轮，多出去的会被搬到顶上那条占位里，导航条只画窗格里的，
    // 所以这里用 30 句：还在窗格里，条数就是 30）
    await feed(30);
    await move(20, 20);
    await page.sleep(300);
    s = await look();
    console.log("\n第六幕（三十句）：\n  " + show(s) + " 整条高=" + s.height);
    if (s.n !== 30) { problems.push("三十句该有三十根，实际 " + s.n + " 根"); }
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

    // ---- 第八幕：沿着这一条上下挑：清单里对应那行跟着亮；鼠标走开就收起来 ----
    //（鼠标沿着导航条挪时清单是开着的：先停第一根，再停第九根，亮的行跟着换）
    const first2 = await tickAt(0);
    await move(first2.x, first2.y);
    await page.sleep(250);
    const hoverA = await listNow();
    const last2 = await tickAt(8);
    await move(last2.x, last2.y);
    await page.sleep(250);
    const hoverB = await listNow();
    console.log("\n第八幕（沿着这一条挪）：\n  停第一根：亮第 " + (hoverA.hovered + 1) + " 行（" + JSON.stringify(hoverA.texts && hoverA.texts[0]) + "）"
        + "\n  再停第九根：亮第 " + (hoverB.hovered + 1) + " 行（" + JSON.stringify(hoverB.texts && hoverB.texts[8]) + "）");
    if (!hoverA.shown || hoverA.hovered !== 0) { problems.push("停第一根时该亮第一行，实际 " + (hoverA.shown ? hoverA.hovered + 1 : "清单没开") + " 行"); }
    if (!hoverB.shown || hoverB.hovered !== 8) { problems.push("停第九根时该亮第九行，实际 " + (hoverB.shown ? hoverB.hovered + 1 : "清单没开") + " 行"); }
    if (hoverB.shown && !hoverB.texts[8].startsWith("最后一句")) { problems.push("第九行不是最后一句的开头：" + JSON.stringify(hoverB.texts[8])); }
    await page.shot("rail-8-hover-row.png");
    await move(20, 20);   // 鼠标离开这一条
    await page.sleep(250);
    const left = await listNow();
    console.log("  鼠标走开：清单还开着=" + left.shown);
    if (left.shown) { problems.push("鼠标走开后清单该收起来"); }

    // ---- 第九幕：画的那一下还没排上版（量出来 0 高）：露出来以后它该自己补画 ----
    await feed(9);
    await page.eval(`document.getElementById("messages").style.display = "none"; return true;`);   // 窗格被藏起来 = 量出来 0 高
    await page.eval(`window.postMessage({ type: "userMessage", text: "藏起来的时候来的这一条" }, "*"); return true;`);
    await page.sleep(400);
    await page.eval(`document.getElementById("messages").style.display = ""; return true;`);
    await page.sleep(500);   // 不再发消息、不点任何东西，只等它自己补画
    await move(20, 20);
    s = await look();
    console.log("\n第九幕（画的时候窗格还没排上版）：\n  " + show(s) + " 整条高=" + s.height + "（没发新消息，它自己补画的）");
    if (s.n !== 10) { problems.push("补画之后该有十根（九句 + 藏起来时来的那一句），实际 " + s.n + " 根"); }
    if (s.first <= 0 || s.last >= s.height) { problems.push("补画出来的位置不对：第一根 " + s.first + "、最后一根 " + s.last + "、条高 " + s.height); }
    await page.shot("rail-9-after-layout.png");

    // ---- 第十幕：轮数超了、老几轮被搬到顶上那条占位里：导航条只画窗格里摆着的那几条 ----
    //（窗格里最多留 LIVE_MAX_TURNS = 40 轮，一次搬走之后留 LIVE_KEEP_TURNS = 24 轮）
    await feed(45);
    await page.sleep(900);   // 搬那一轮是延后 400 毫秒做的（见 scheduleTrimLive）
    await move(20, 20);
    s = await look();
    const inPane = await page.eval(`return document.querySelectorAll(".session-view .session-pane > .msg.user").length;`);
    console.log("\n第十幕（四十五句、老几轮已被搬出去）：\n  " + show(s) + " 窗格里还剩 " + inPane + " 句");
    if (inPane >= 45) { problems.push("四十五句该把最老的几轮搬出去，实际窗格里还有 " + inPane + " 句"); }
    if (s.n !== inPane) { problems.push("导航条的根数该跟着窗格里的句数变：条上 " + s.n + " 根、窗格里 " + inPane + " 句"); }
    await page.shot("rail-10-trimmed.png");

    // ---- 第十一幕：手机上（触屏 + 窄屏）这一条不露面 ----
    // 页面认手机看的就是 (hover: none) and (pointer: coarse)（见 chat.css 那两段），这儿照着模拟一份。
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 1, mobile: true });
    await page.sleep(300);
    const phone = await look();
    console.log("\n第十一幕（手机上）：\n  这根条的 display=" + phone.display + "（不露出就行：收起来的内容量不出高矮，根数是 0 也算正常）");
    if (phone.none) { problems.push("手机上也该有这根条，只是看不见（现在整个都没有）"); }
    if (phone.display !== "none") { problems.push("手机上这一条该收起来，实际 display=" + phone.display); }
    await page.shot("rail-11-phone.png");
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
    await page.sleep(300);
    const desk = await look();
    console.log("  回到电脑上：" + show(desk) + " display=" + desk.display);
    if (desk.display === "none") { problems.push("回到电脑上这一条该露出来，实际还收着"); }

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

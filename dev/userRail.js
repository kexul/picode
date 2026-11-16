// @ts-nocheck
/**
 * userRail —— 验消息流右边那条「用户消息导航」（一列短横线；停上去字与卡片底淡进来，点一行跳过去）。
 *
 * 真让模型攒出几十轮对话不好凑，这里直接往页面里投假消息（跟后端推的是同一种消息）；一次验：
 *   · 条数与位置：一句一行，第 1 行在最上头、最后一行在最下头，中间等分；条数多了整列挤紧；
 *   · 平时只有一列短横线：字是透明的、卡片底不露面、行不接鼠标（不挡消息流）；
 *   · 停上去：字与卡片底淡进来，一行一句（开头那几个字）、正读着的那一行蓝着；
 *     短线一根都不动（开之前和开之后，线的位置一模一样）；
 *   · 从短线横着往左挑就落在那一行上（不能一挪就收，不然根本点不到）；
 *   · 点一行：那一条滚到窗格顶上、闪一下底色，清单留着（还能接着挑下一句）；
 *   · 往回滚：亮着的是「正读着的那一行」；贴底时永远亮最后一行；
 *   · 空会话、只有一条用户消息：整条不出现，也不挡消息流的鼠标；
 *   · 三十句：整列挤紧；点最上面那行回到第一句；
 *   · 整屏重画（刷新 / 切会话 / 重连）之后跟着重画，条数还是对的；
 *   · 插件代发的那些（后台命令结果、子会话交回）不进这一条：只数人自己说过的话；
 *   · 画的那一下还没排上版（量出来 0 高）：露出来以后自己补画；
 *   · 轮数超了、老几轮被搬到顶上那条占位里：只画窗格里摆着的那几条；
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
    "3. 停上去：字跟卡片底一起淡进来，是那条消息的开头；",
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

    /** 导航条此刻的样子：几行、行距、第一行与最后一行在条里的位置、哪行是“正读着”、开着没、字与卡片底露出来没。 */
    const look = () => page.eval(`
        const rail = document.querySelector(".session-view .user-rail");
        if (!rail) { return { none: true }; }
        const rb = rail.getBoundingClientRect();
        const rows = Array.from(rail.querySelectorAll(".rail-row"));
        const dashes = Array.from(rail.querySelectorAll(".rr-dash"));
        const rel = (t) => Math.round(t.getBoundingClientRect().top - rb.top);
        const text = rows.length ? rows[0].querySelector(".rr-text") : null;
        const bg = rail.querySelector(".rail-bg");
        let current = -1;
        rows.forEach((r, i) => { if (r.classList.contains("current")) { current = i; } });
        return {
            n: rows.length,
            open: rail.classList.contains("open"),
            empty: rail.classList.contains("empty"),
            pointer: getComputedStyle(rail).pointerEvents,
            display: getComputedStyle(rail).display,
            height: Math.round(rb.height),
            rowPointer: rows.length ? getComputedStyle(rows[0]).pointerEvents : "",
            textOpacity: text ? Number(getComputedStyle(text).opacity) : -1,
            bgOpacity: bg ? Number(getComputedStyle(bg).opacity) : -1,
            gap: rows.length > 1 ? rel(rows[1]) - rel(rows[0]) : 0,
            first: dashes.length ? rel(dashes[0]) : 0,
            last: dashes.length ? rel(dashes[dashes.length - 1]) : 0,
            dashX: dashes.length ? Math.round(dashes[0].getBoundingClientRect().left) : -1,
            current,
            texts: rows.map((r) => r.querySelector(".rr-text").textContent),
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
    /** 第 i 行的那根短横线在屏幕上的位置（点它 / 停它都算这一行）。 */
    const tickAt = (i) => page.eval(`
        const rail = document.querySelector(".session-view .user-rail");
        const t = rail.querySelectorAll(".rr-dash")[${i}];
        if (!t) { return null; }
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    const under = (x, y) => page.eval(`
        const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
        const row = el && el.closest ? el.closest(".rail-row") : null;
        return { row: row ? Number(row.dataset.idx) : -1, cls: el ? String(el.className || el.tagName) : "" };
    `);
    const show = (s) => "行数=" + s.n + " 行距=" + s.gap + " 第一行=" + s.first + " 最后一行=" + s.last + " 亮着=" + s.current;

    // ---- 第一幕：九句话：一句一行，整列居中（每行之间最松 26 像素）；平时只露一列短线 ----
    await feed(9);
    await move(20, 20);
    await page.sleep(200);
    let s = await look();
    console.log("\n第一幕（九句话、没停上去）：\n  " + show(s) + " 整条高=" + s.height);
    console.log("  字的不透明度=" + s.textOpacity + " 卡片底=" + s.bgOpacity + " 行接不接鼠标=" + s.rowPointer + " 开着=" + s.open);
    if (s.n !== 9) { problems.push("九句话该有九行，实际 " + s.n + " 行"); }
    if (s.gap > 26) { problems.push("相邻两行之间该最多 26 像素，实际 " + s.gap); }
    if (s.first < 1 || s.last > s.height - 1) { problems.push("整列跑出这条了：第一行 " + s.first + "、最后一行 " + s.last + "、条高 " + s.height); }
    if (Math.abs(s.first - (s.height - s.last)) > 3) { problems.push("整列没居中：上头留 " + s.first + "、下头留 " + (s.height - s.last)); }
    if (s.current !== 8) { problems.push("贴着底的时候该亮最后一行，实际亮第 " + (s.current + 1) + " 行"); }
    if (s.textOpacity !== 0) { problems.push("平时字该是透明的，实际不透明度 " + s.textOpacity); }
    if (s.bgOpacity !== 0) { problems.push("平时卡片底不该露面，实际不透明度 " + s.bgOpacity); }
    if (s.rowPointer !== "none") { problems.push("平时行不该接鼠标（不然一片看不见的字挡住消息流），实际 " + s.rowPointer); }
    const dashXClosed = s.dashX;
    await page.shot("rail-1-overview.png");

    // ---- 第二幕：停到第五根上：字与卡片底淡进来，短线一根都不动 ----
    const mid = await tickAt(4);
    await move(mid.x, mid.y);
    await page.sleep(300);
    const open = await look();
    console.log("\n第二幕（停到第五根上）：\n  " + show(open) + " 开着=" + open.open
        + "\n  字的不透明度=" + open.textOpacity + " 卡片底=" + open.bgOpacity + " 行接不接鼠标=" + open.rowPointer
        + "\n  第一行=" + JSON.stringify(open.texts[0])
        + "\n  第五行=" + JSON.stringify(open.texts[4]));
    if (!open.open) { problems.push("停到这一条上没把字与卡片底淡进来"); }
    if (open.textOpacity !== 1) { problems.push("开着的时候字该露出来，实际不透明度 " + open.textOpacity); }
    if (open.bgOpacity !== 1) { problems.push("开着的时候卡片底该露出来，实际不透明度 " + open.bgOpacity); }
    if (open.rowPointer !== "auto") { problems.push("开着的时候行该接鼠标（好点得到），实际 " + open.rowPointer); }
    if (!open.texts[0].startsWith("消息流右边")) { problems.push("第一行不是第一句的开头：" + JSON.stringify(open.texts[0])); }
    if (!open.texts[4].startsWith("把我这几句话")) { problems.push("第五行不是第五句的开头：" + JSON.stringify(open.texts[4])); }
    if (open.current !== 8) { problems.push("贴着底时「正读着」该是最后一行，实际第 " + (open.current + 1) + " 行"); }
    if (open.gap !== s.gap || open.first !== s.first) { problems.push("开卡片之后行距或位置变了（线该一根都不动）：开前 " + s.gap + "/" + s.first + "，开后 " + open.gap + "/" + open.first); }
    if (open.dashX !== dashXClosed) { problems.push("开卡片之后短线的横坐标变了（该一动不动）：开前 " + dashXClosed + "，开后 " + open.dashX); }
    // 蓝的只能有一根：「正读着的那一句」那一根。鼠标停着的那一行只是亮起来（字变正常色、线变实），
    // 不换蓝 —— 两个都蓝、都变长，看着就像有两处“当前”。
    const blueCount = await page.eval(`
        const rows = Array.from(document.querySelectorAll(".session-view .user-rail .rail-row"));
        const cur = rows.find((r) => r.classList.contains("current"));
        if (!cur) { return -1; }
        const want = getComputedStyle(cur.querySelector(".rr-dash")).backgroundColor;
        return rows.filter((r) => getComputedStyle(r.querySelector(".rr-dash")).backgroundColor === want).length;
    `);
    console.log("  变蓝的短线有几根=" + blueCount + "（只能有一根：正读着的那一句）");
    if (blueCount !== 1) { problems.push("蓝色的短横线该只有一根（正读着的那一句），实际 " + blueCount + " 根"); }
    const onRow = await under(mid.x, mid.y);
    console.log("  鼠标底下是第 " + (onRow.row + 1) + " 行（" + onRow.cls + "）");
    if (onRow.row !== 4) { problems.push("停在第五根上，鼠标底下该是第 5 行，实际第 " + (onRow.row + 1) + " 行"); }
    await page.shot("rail-2-open.png");

    // ---- 第二幕之二：从那一根横着往左挪一点，就落在那一行上（不能一挪就收，不然根本点不到） ----
    const into = mid.x - 40;   // 往左 40 像素：这是卡片里的字
    await move(into, mid.y);
    await page.sleep(250);
    const hovered = await look();
    const deep = await under(into, mid.y);
    console.log("\n第二幕之二（从第五根往左挑进卡片）：\n  还开着=" + hovered.open + " 鼠标底下是第 " + (deep.row + 1) + " 行（" + deep.cls + "）");
    if (!hovered.open) { problems.push("鼠标从短线往左一挪卡片就收了（这样根本点不到）"); }
    if (deep.row !== 4) { problems.push("往左挪到的那一行该是第 5 行，实际第 " + (deep.row + 1) + " 行，底下是 " + deep.cls); }
    await page.shot("rail-2b-into-list.png");

    // ---- 第三幕：点第五行：那一条滚到窗格顶上，闪一下底色，卡片留着（还能接着挑下一句） ----
    await clickAt(into, mid.y);
    await page.sleep(140);
    const jumped = await topUser();
    const flashing = await page.eval(`
        const el = document.querySelector(".session-view .session-pane .msg.user.msg-flash");
        return el ? (el.dataset.raw || "").slice(0, 10) : "";
    `);
    const afterClick = await look();
    console.log("\n第三幕（点第五行）：\n  顶上这条是第 " + (jumped.idx + 1) + " 句（离窗格顶 " + jumped.at + " 像素）在闪=" + JSON.stringify(flashing)
        + " 还开着=" + afterClick.open + "，蓝着的第 " + (afterClick.current + 1) + " 行");
    if (jumped.idx !== 4) { problems.push("点第五行该跳到第五句，实际顶上这条是第 " + (jumped.idx + 1) + " 句"); }
    if (jumped.at < 0 || jumped.at > 20) { problems.push("跳过去之后那条没贴到窗格顶上，离着 " + jumped.at + " 像素"); }
    if (!flashing.startsWith("把")) { problems.push("跳过去的那条没在闪：" + JSON.stringify(flashing)); }
    if (!afterClick.open) { problems.push("点完一行不该马上收起来（鼠标还在这一条上）"); }
    if (afterClick.open && afterClick.current !== 4) { problems.push("跳过去之后蓝着的该是第 5 行，实际第 " + (afterClick.current + 1) + " 行"); }
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
    console.log("\n第四幕（滚到第三句那儿）：\n  " + show(s) + " 还开着=" + s.open);
    if (s.current !== 2) { problems.push("这时该亮第 3 行，实际亮第 " + (s.current + 1) + " 行"); }
    if (s.open) { problems.push("鼠标走开之后卡片该收起来"); }
    await page.shot("rail-4-current.png");

    // ---- 第五幕：空会话 / 只有一条用户消息：整条不出现，也不挡鼠标 ----
    await feed(0);
    let empty = await look();
    await feed(1);
    s = await look();
    console.log("\n第五幕（空会话、只有一句）：\n  空会话：" + show(empty) + " 收着=" + empty.empty + " 挡不挡鼠标=" + empty.pointer
        + "\n  只有一句：" + show(s) + " 收着=" + s.empty);
    if (!empty.empty || !s.empty) { problems.push("空会话 / 只有一句时整条该收着"); }
    if (empty.n || s.n) { problems.push("空会话 / 只有一句时不该画行"); }
    if (empty.pointer !== "none" || s.pointer !== "none") { problems.push("收着的时候还挡着鼠标：" + empty.pointer + " / " + s.pointer); }
    await page.shot("rail-5-single.png");

    // ---- 第六幕：三十句：整列挤紧、铺满这一条；点最上面那行回到第一句 ----
    //（窗格里最多留 LIVE_MAX_TURNS = 40 轮，多出去的会被搬到顶上那条占位里，导航条只画窗格里的，
    // 所以这里用 30 句：还在窗格里，行数就是 30）
    await feed(30);
    await move(20, 20);
    await page.sleep(300);
    s = await look();
    console.log("\n第六幕（三十句）：\n  " + show(s) + " 整条高=" + s.height);
    if (s.n !== 30) { problems.push("三十句该有三十行，实际 " + s.n + " 行"); }
    if (s.gap < 2) { problems.push("挤得两行叠在一起了，行距 " + s.gap); }
    if (s.first > 1 || s.last < s.height - 2) { problems.push("条数多的时候该铺满这一条：第一行 " + s.first + "、最后一行 " + s.last + "、条高 " + s.height); }
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
    if (s.n !== 9) { problems.push("重放完该还是九行，实际 " + s.n + " 行"); }

    // ---- 第七幕之二：插件代发的那些（后台命令结果 / 子会话交回）不算“我说过的话” ----
    await page.eval(`
        const msg = (o) => window.postMessage(o, "*");
        msg({ type: "userMessage", text: "【后台命令 #3 跑完了（退出码 0，用了 2 分 12 秒）】", injected: true });
        msg({ type: "userMessage", text: "【子会话「侦察」跑完了，用时 1 分 2 秒】结果在这。", injected: true });
        msg({ type: "assistantFull", text: "收到。" });
        return true;
    `);
    await page.sleep(500);
    s = await look();
    const bubbles = await page.eval(`return document.querySelectorAll(".session-view .session-pane > .msg.user").length;`);
    console.log("");
    console.log("第七幕之二（又来两条插件代发的）：");
    console.log("  窗格里的用户气泡=" + bubbles + " 条，导航条=" + s.n + " 行");
    if (bubbles !== 11) { problems.push("窗格里该有 11 条用户气泡（九句 + 两条插件代发的），实际 " + bubbles); }
    if (s.n !== 9) { problems.push("导航条只该数人自己说的那九句，实际 " + s.n + " 行"); }
    await page.shot("rail-7b-injected.png");

    // ---- 第八幕：沿着这一条上下挑：鼠标底下换行、亮的就是那一行；鼠标走开就收起 ----
    const first2 = await tickAt(0);
    await move(first2.x, first2.y);
    await page.sleep(250);
    const hoverA = await under(first2.x, first2.y);
    const last2 = await tickAt(8);
    await move(last2.x, last2.y);
    await page.sleep(250);
    const hoverB = await under(last2.x, last2.y);
    const stillOpen = await look();
    console.log("\n第八幕（沿着这一条挪）：\n  停第一根：" + (hoverA.row + 1) + " 行  再停第九根：" + (hoverB.row + 1) + " 行  还开着=" + stillOpen.open);
    if (hoverA.row !== 0) { problems.push("停第一根时鼠标底下该是第 1 行，实际第 " + (hoverA.row + 1) + " 行"); }
    if (hoverB.row !== 8) { problems.push("停第九根时鼠标底下该是第 9 行，实际第 " + (hoverB.row + 1) + " 行"); }
    if (!stillOpen.open) { problems.push("沿着这一条挪的时候卡片不该收起来"); }
    await page.shot("rail-8-hover-row.png");
    await move(20, 20);   // 鼠标离开这一条
    await page.sleep(250);
    const left = await look();
    console.log("  鼠标走开：还开着=" + left.open + "，字的不透明度=" + left.textOpacity);
    if (left.open) { problems.push("鼠标走开后卡片该收起来"); }
    if (left.textOpacity !== 0) { problems.push("收起之后字该又变透明，实际 " + left.textOpacity); }

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
    if (s.n !== 10) { problems.push("补画之后该有十行（九句 + 藏起来时来的那一句），实际 " + s.n + " 行"); }
    if (s.first <= 0 || s.last >= s.height) { problems.push("补画出来的位置不对：第一行 " + s.first + "、最后一行 " + s.last + "、条高 " + s.height); }
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
    if (s.n !== inPane) { problems.push("导航条的行数该跟着窗格里的句数变：条上 " + s.n + " 行、窗格里 " + inPane + " 句"); }
    await page.shot("rail-10-trimmed.png");

    // ---- 第十一幕：手机上（触屏 + 窄屏）这一条不露面 ----
    // 页面认手机看的就是 (hover: none) and (pointer: coarse)（见 chat.css 那段），这儿照着模拟一份。
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 1, mobile: true });
    await page.sleep(300);
    const phone = await look();
    console.log("\n第十一幕（手机上）：\n  这根条的 display=" + phone.display);
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

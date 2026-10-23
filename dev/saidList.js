// @ts-nocheck
/**
 * saidList —— 验输入框右边那颗「你说过的话」与它弹出来的清单。
 *
 * 真让模型攒出几十轮对话不好凑，这里直接往页面里投假消息（跟后端推的是同一种消息）；一次验：
 *   · 那颗按钮一直露着（空会话里也露着，点开只说一句“还没说过话”）；
 *   · 点开是从输入行上头往上弹的一小张清单：一行一句（序号 + 开头）、正读着的那一句标亮；
 *   · 点一行：清单收起、按钮灭掉、跳到那条消息；
 *   · 按 Esc、点别处也收起；
 *   · 手机上往上弹、不出屏、行高够点。
 *
 *   npm run web:shot -- --width 900 --height 700 --script dev/saidList.js
 * 图落在 dev/shots/。
 */

/** 投进去的九句用户的话。 */
const ROUNDS = [
    "输入框左边想加一颗按钮，点开看看我自己都说过些什么。",
    "条数少的时候会怎么样？",
    "清单里一行写什么？",
    "点一行之后呢？会不会跳得太生硬？",
    "把我这几句话的先后顺序记住就行，别的不用。",
    "手机上怎么办？手机上没有悬浮这回事。",
    "这张清单往上弹还是往下弹？",
    "刷新页面、切会话之后它还准吗？",
    "最后一句：空会话里点它是什么样？",
];

/** 模型的回复（每轮都这一长段，撑出可以滚动的长会话）。 */
const REPLY = [
    "记下了，这几条先这么做：",
    "",
    "1. 那颗按钮贴在输入框左边，跟输入框起步一样高；",
    "2. 点开是一小张清单：一行一句，前面带序号；",
    "3. 正读着的那一句标亮；",
    "4. 点一行就跳到那条消息；",
    "5. 按 Esc、点别处都收起。",
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

    /** 像用户那样滚回底部：分两步（先把可能残留的「程序滚动」标记用掉，再滚到底）。 */
    const scrollToBottom = async () => {
        await page.eval(`
            const pane = document.querySelector(".session-view .session-pane");
            pane.scrollTop = Math.max(0, pane.scrollTop - 240);
            return true;
        `);
        await page.sleep(180);
        await page.eval(`
            const pane = document.querySelector(".session-view .session-pane");
            pane.scrollTop = pane.scrollHeight;
            return true;
        `);
        await page.sleep(350);
    };

    // ---- 第一幕：按钮常在，点开是往上弹的清单 ----
    await feed(9);
    await scrollToBottom();
    const btn = await page.eval(`
        const b = document.getElementById("saidBtn");
        if (!b) { return { none: true }; }
        const r = b.getBoundingClientRect();
        return { hidden: b.classList.contains("hidden"), inInputRow: !!b.closest("#inputRow"), w: Math.round(r.width), h: Math.round(r.height) };
    `);
    console.log("\n第一幕（按钮常显）：\n  在输入行里=" + btn.inInputRow + " 藏着=" + btn.hidden + " 大小=" + btn.w + "x" + btn.h);
    if (btn.none) { problems.push("没有那颗「你说过的话」按钮"); }
    if (btn.hidden) { problems.push("这颗按钮该一直露着"); }

    await page.click("#saidBtn");
    await page.sleep(300);
    const list = await page.eval(`
        const menu = document.getElementById("saidMenu");
        const row = document.getElementById("inputRow");
        const rows = Array.from(menu.querySelectorAll(".said-item"));
        const cur = rows.findIndex((r) => r.classList.contains("current"));
        const mb = menu.getBoundingClientRect();
        const rb = row.getBoundingClientRect();
        return {
            open: !menu.classList.contains("hidden"),
            n: rows.length,
            first: rows.length ? rows[0].querySelector(".said-text").textContent : "",
            no3: rows.length > 2 ? rows[2].querySelector(".said-no").textContent : "",
            cur,
            above: Math.round(rb.top - mb.bottom),
            h: Math.round(mb.height),
            btnOn: document.getElementById("saidBtn").classList.contains("on"),
        };
    `);
    console.log("  清单开着=" + list.open + " 行数=" + list.n + " 第一行=" + JSON.stringify(list.first)
        + " 亮着第 " + (list.cur + 1) + " 行 贴着输入行上头=" + list.above + "px 高=" + list.h + " 按钮亮着=" + list.btnOn);
    if (!list.open) { problems.push("点按钮没打开清单"); }
    if (list.n !== 9) { problems.push("清单该有九行，实际 " + list.n + " 行"); }
    if (!list.first.startsWith("输入框左边")) { problems.push("第一行该是第一句的开头：" + JSON.stringify(list.first)); }
    if (list.no3 !== "3") { problems.push("第三行的序号该是 3，实际 " + JSON.stringify(list.no3)); }
    if (list.cur !== 8) { problems.push("贴着底时该亮最后一行，实际第 " + (list.cur + 1) + " 行"); }
    if (list.above < 0) { problems.push("清单该往上弹、落在输入行上头，实际压住输入行 " + (-list.above) + " 像素"); }
    if (!list.btnOn) { problems.push("清单开着的时候那颗按钮该一直亮着"); }
    await page.shot("said-1-list.png");

    // ---- 第二幕：点一行：清单收起、按钮灭掉、跳到那条 ----
    await page.eval(`document.querySelectorAll("#saidMenu .said-item")[2].click(); return true;`);
    await page.sleep(300);
    const afterJump = await page.eval(`
        const menu = document.getElementById("saidMenu");
        return { open: !menu.classList.contains("hidden"), btnOn: document.getElementById("saidBtn").classList.contains("on") };
    `);
    const landed = await topUser();
    console.log("\n第二幕（点第三行）：\n  清单开着=" + afterJump.open + " 按钮还亮着=" + afterJump.btnOn + " 顶上这条是第 " + (landed.idx + 1) + " 句");
    if (afterJump.open) { problems.push("点了一行之后清单该收起"); }
    if (afterJump.btnOn) { problems.push("清单收起之后那颗按钮该灭掉"); }
    if (landed.idx !== 2) { problems.push("点第三行该跳到第三句，实际第 " + (landed.idx + 1) + " 句"); }
    await page.shot("said-2-jumped.png");

    // ---- 第三幕：Esc 与点别处都能收起 ----
    await page.click("#saidBtn");
    await page.sleep(200);
    await page.press("Escape");
    await page.sleep(250);
    const escClosed = await page.eval(`const menu = document.getElementById("saidMenu"); return !menu || menu.classList.contains("hidden");`);
    console.log("\n第三幕（Esc 与点别处）：\n  按 Esc 收起=" + escClosed);
    if (!escClosed) { problems.push("按 Esc 没把清单收起来"); }

    await page.click("#saidBtn");
    await page.sleep(200);
    await page.eval(`document.querySelector(".session-view .session-pane").click(); return true;`);
    await page.sleep(200);
    const outClosed = await page.eval(`const menu = document.getElementById("saidMenu"); return !menu || menu.classList.contains("hidden");`);
    console.log("  点别处收起=" + outClosed);
    if (!outClosed) { problems.push("点了外头没把清单收起来"); }

    // ---- 第四幕：空会话：按钮照旧常在，点开只有一句提示 ----
    await feed(0);
    await page.sleep(350);
    const emptyState = await page.eval(`
        const b = document.getElementById("saidBtn");
        return { hidden: !b || b.classList.contains("hidden") };
    `);
    await page.click("#saidBtn");
    await page.sleep(250);
    const emptyList = await page.eval(`
        const menu = document.getElementById("saidMenu");
        return { open: !menu.classList.contains("hidden"), n: menu.querySelectorAll(".said-item").length, text: (menu.querySelector(".said-empty") || {}).textContent || "" };
    `);
    console.log("\n第四幕（空会话）：\n  按钮藏着=" + emptyState.hidden + " 清单开着=" + emptyList.open + " 行数=" + emptyList.n + " 写的=" + JSON.stringify(emptyList.text));
    if (emptyState.hidden) { problems.push("空会话里那颗按钮也该露着"); }
    if (!emptyList.open || emptyList.n !== 0) { problems.push("空会话里点开该只有一句提示、没有行"); }
    if (!emptyList.text) { problems.push("空会话里点开该说一句“还没说过话”"); }
    await page.eval(`document.getElementById("saidBtn").click(); return true;`);
    await page.sleep(150);

    // ---- 第五幕：手机上的清单：往上弹、不出屏、行高够点 ----
    await feed(9);
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 820, deviceScaleFactor: 1, mobile: true });
    await page.sleep(400);
    await page.click("#saidBtn");
    await page.sleep(300);
    const phoneList = await page.eval(`
        const menu = document.getElementById("saidMenu");
        const rows = menu.querySelectorAll(".said-item");
        const b = menu.getBoundingClientRect();
        const r0 = rows.length ? rows[0].getBoundingClientRect() : null;
        return { w: Math.round(b.width), h: Math.round(b.height), left: Math.round(b.left), right: Math.round(b.right), rows: rows.length, rowH: r0 ? Math.round(r0.height) : 0, winW: window.innerWidth, winH: window.innerHeight };
    `);
    console.log("\n第五幕（手机 400 宽）：\n  清单 " + phoneList.w + "x" + phoneList.h + "（屏 " + phoneList.winW + "x" + phoneList.winH + "）行数=" + phoneList.rows + " 行高=" + phoneList.rowH);
    if (phoneList.rows !== 9) { problems.push("手机上的清单该有九行，实际 " + phoneList.rows); }
    if (phoneList.left < 0 || phoneList.right > phoneList.winW) { problems.push("手机上的清单出屏幕了：左 " + phoneList.left + "、右 " + phoneList.right + "、屏宽 " + phoneList.winW); }
    if (phoneList.h > phoneList.winH * 0.6) { problems.push("手机上的清单太高了（该封顶）：高 " + phoneList.h + "、屏高 " + phoneList.winH); }
    if (phoneList.rowH < 28) { problems.push("手机上的清单行太矮，不好点：行高 " + phoneList.rowH); }
    await page.shot("said-5-phone.png");

    await page.eval(`document.getElementById("saidBtn").click(); return true;`);
    await page.sleep(150);
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
    await page.sleep(200);

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

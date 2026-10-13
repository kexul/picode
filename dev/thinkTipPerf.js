// @ts-nocheck
/**
 * thinkTipPerf —— 验「think 提示框开着、思考还在往外吐」这条路的开销与表现。
 *
 * 起因：以前每条思考增量都把提示框整个重画一遍（等于把全文重排一遍），代价随思考长度涨，
 * 思考几万字时主线程被占满，浏览器报「页面无响应」（复现时的数：12 万字的思考、1000 条增量
 * 用了 19.2 秒，其中 16.9 秒花在排版上）。
 * 现在：内容还在长、又已经长了的话，最多每 300 毫秒重画一次；并且内容区跟着贴底
 * （用户往回滚了就不跟）。
 *
 *   npm run web:shot -- --fake-pi --script dev/thinkTipPerf.js
 *
 * 不调真模型：思考内容自己往页面里投（thinkingStart / thinkingDelta 与后端推的同一种形状）。
 */

/** 一段像真模型思考的文字（有长句、有换行）。 */
function chunk(round) {
    return `第 ${round} 步：先看这里的实现是不是跟前面那条路一样。` +
        `要确认的点有一串：调用参数对不对、结果有没有截断、提示框开着的时侯会不会把整段重新排版一遍。\n` +
        `再看下一处：如果每次增量都重建一遍文本节点，代价是随着总长度线性涨的，总量一大就顶不住了。\n`;
}

/** 往页面里投一批思考增量，返回每条从「投出去」到「页面处理完」的耗时（毫秒）。
 *  postMessage 是异步任务，所以每投一条就等一个 setTimeout(0)：消息任务排在前面，
 *  等它回来的时候这条已经处理完了（重画、排版都算在里面）。 */
async function feed(page, deltas) {
    const msgs = deltas.map((d) => ({ type: "thinkingDelta", delta: d }));
    return await page.eval(`
        return (async () => {
        const msgs = ${JSON.stringify(msgs)};
        const out = [];
        const settle = () => new Promise(function (r) { setTimeout(r, 0); });
        for (const m of msgs) {
            const t0 = performance.now();
            window.postMessage(m, "*");
            await settle();
            out.push(performance.now() - t0);
        }
        return out.map(function (v) { return Math.round(v * 100) / 100; });
        })();
    `);
}

async function stats(cdp) {
    const { metrics: list } = await cdp.send("Performance.getMetrics");
    const m = {};
    for (const item of list) { m[item.name] = item.value; }
    return m;
}

/** 提示框现在的样子：出来了没、里面多少字、内容区滚到哪了。 */
function tipState(page) {
    return page.eval(`
        const el = document.querySelector(".tag-tip");
        if (!el || el.classList.contains("hidden")) { return { shown: false }; }
        const c = el.querySelector(".tag-tip-content");
        return {
            shown: true,
            chars: el.textContent.replace(/\\s+/g, " ").trim().length,
            fromBottom: c.scrollHeight - c.scrollTop - c.clientHeight,
            scrollTop: Math.round(c.scrollTop),
            scrollHeight: c.scrollHeight,
            clientHeight: c.clientHeight,
        };
    `);
}

/** 悬浮到某个工具标签上（电脑上没有触屏那一套，靠 mouseenter 触发提示框）。 */
function hoverTag(page, name) {
    return page.eval(`
        const el = Array.from(document.querySelectorAll(".tool-group")).find((t) => t.textContent.trim().startsWith(${JSON.stringify(name)}));
        if (!el) { throw new Error("页面上没有这个标签：" + ${JSON.stringify(name)}); }
        el.dispatchEvent(new MouseEvent("mouseenter"));
        return true;
    `);
}

function leaveTag(page, name) {
    return page.eval(`
        const el = Array.from(document.querySelectorAll(".tool-group")).find((t) => t.textContent.trim().startsWith(${JSON.stringify(name)}));
        if (el) { el.dispatchEvent(new MouseEvent("mouseleave")); }
        return true;
    `);
}

/** 数提示框内容被重画了几次：一次重画在整个内容区里换一批节点，算一次 MutationObserver 回调。 */
async function countFills(page) {
    await page.eval(`
        window.__fills = 0;
        if (window.__mo) { window.__mo.disconnect(); }
        window.__mo = new MutationObserver(function () { window.__fills++; });
        window.__mo.observe(document.querySelector(".tag-tip-content"), { childList: true });
        return true;
    `);
}

/** 读走计数并停掉观察。 */
async function takeFills(page) {
    return await page.eval("window.__mo.disconnect(); return window.__fills");
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

module.exports = async (page) => {
    const cdp = page.cdp;
    await cdp.send("Performance.enable");
    await page.waitReady();
    const problems = [];
    await page.eval(`
        window.__tips = [];
        try { new PerformanceObserver(function (l) { for (const e of l.getEntries()) { window.__tips.push(Math.round(e.duration)); } }).observe({ entryTypes: ["longtask"] }); }
        catch (e) { window.__tips = null; }
        return true;
    `);

    // ---- 第一幕：先攒一段没多长的思考（此时没人悬浮，提示框没开）----
    await page.eval(`
        window.postMessage({ type: "clear", keepDraft: true }, "*");
        window.postMessage({ type: "thinkingStart" }, "*");
        return true;
    `);
    const idle = [];
    for (let r = 0; r < 200; r++) { idle.push(chunk(r)); }
    const t0 = Date.now();
    const idleMs = (await feed(page, idle));
    const idleWall = Date.now() - t0;
    console.log(`提示框没开：投 ${idle.length} 条增量（共 ${idle.join("").length} 字）用了 ${idleWall} 毫秒，` +
        `每条最大 ${Math.max(...idleMs).toFixed(1)} 毫秒`);

    // ---- 第二幕：提示框开着继续吐思考（以前就是这里卡到浏览器报无响应）----
    await hoverTag(page, "think");
    await page.sleep(400);
    const opened = await tipState(page);
    console.log(`\n悬浮 think 标签后提示框：${JSON.stringify(opened)}`);
    if (!opened.shown) { problems.push("悬浮 think 标签没能把提示框开出来"); }

    // 数一数提示框内容被重画了几次（一次重画在整个内容区里换一批节点，算一次 MutationObserver 回调）
    await countFills(page);

    const before = await stats(cdp);
    const more = [];
    for (let r = 200; r < 1200; r++) { more.push(chunk(r)); }
    const t1 = Date.now();
    const openMs = (await feed(page, more));
    const wall = Date.now() - t1;
    const sorted = openMs.slice().sort((a, b) => a - b);
    const totalText = more.reduce((n, d) => n + d.length, 0);
    console.log(`提示框开着：投 ${more.length} 条增量（共 ${totalText} 字）用了 ${wall} 毫秒（以前同样的量是 19.2 秒）`);
    console.log(`  每条耗时：最大 ${Math.max(...openMs).toFixed(1)} 毫秒，中位 ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} 毫秒`);
    {
        const after = await stats(cdp);
        const d = (k) => ((after[k] || 0) - (before[k] || 0));
        console.log(`  这 ${(wall / 1000).toFixed(1)} 秒里：排版 ${(d("LayoutDuration") * 1000).toFixed(0)} 毫秒（${d("LayoutCount")} 次，` +
            `以前 16877 毫秒 / 1854 次），算样式 ${(d("RecalcStyleDuration") * 1000).toFixed(0)} 毫秒`);
    }

    if (wall > 8000) { problems.push(`提示框开着投 ${more.length} 条还是太慢：${wall} 毫秒（以前 19200 毫秒）`); }

    // 收尾：等最后一次重画落下去，提示框里该是这段思考的全文一字不差
    await page.sleep(500);
    const shown = await tipState(page);
    const full = norm("think " + more.join("") + "");
    const tipText = norm(await page.eval(`return document.querySelector(".tag-tip").textContent`));
    console.log(`  提示框里 ${shown.chars} 字，离底 ${Math.round(shown.fromBottom)} 像素，内容区 ${shown.clientHeight}/${shown.scrollHeight}`);
    if (!tipText.endsWith(norm(more[more.length - 1]).slice(-40))) { problems.push("提示框里的内容没跟上最新的那段思考"); }
    const fills = await takeFills(page);
    console.log(`  ${more.length} 条增量只重画了 ${fills} 次（节流生效）`);
    if (fills >= more.length / 4) { problems.push(`节流没生效：${more.length} 条增量重画了 ${fills} 次`); }

    // ---- 第三幕：还在长的时候内容区跟着贴底（看得到最新想到的那段）----
    if (shown.scrollHeight > shown.clientHeight + 8) {
        if (shown.fromBottom > 8) { problems.push(`长思考还在往外吐时，内容区没跟着贴底（离底 ${Math.round(shown.fromBottom)} 像素）`); }
        else { console.log("\n第三幕：增长期间内容区贴着底看最新一段（对）"); }
        await page.shot("think-tip-follow.png");
    } else {
        console.log("\n第三幕：内容区还没长到要滚动，跳过贴底这一项");
    }

    // ---- 第四幕：用户往回滚了就不再跟着往下走 ----
    await page.eval(`
        const c = document.querySelector(".tag-tip-content");
        c.scrollTop = 0;
        return true;
    `);
    await page.sleep(200);   // 等浏览器把 scroll 事件发出来（滚动事件是异步的）
    const scrollBefore = await page.eval("return Math.round(document.querySelector('.tag-tip-content').scrollTop)");
    await feed(page, ["往回滚之后新加的一段：这一步不该把视野拽回底部。\n"]);
    await page.sleep(500);
    const scrollAfter = await page.eval("return Math.round(document.querySelector('.tag-tip-content').scrollTop)");
    console.log(`\n第四幕：用户滚到顶（scrollTop=${scrollBefore}）后再来增量，scrollTop=${scrollAfter}` +
        `（该留在原处不跟到底）`);
    if (scrollAfter > 8) { problems.push(`用户往回滚了，提示框还是把他拽回了底部（scrollTop ${scrollBefore} → ${scrollAfter}）`); }
    await page.shot("think-tip-scrolled.png");

    // ---- 第五幕：想完了（thinkingFull）提示框该显示全文 ----
    const fullText = more.join("") + "往回滚之后新加的一段：这一步不该把视野拽回底部。\n";
    await page.eval(`window.postMessage({ type: "thinkingFull", text: ${JSON.stringify(fullText)} }, "*"); return true;`);
    await page.sleep(300);
    const finalText = norm(await page.eval(`return document.querySelector(".tag-tip").textContent`));
    const want = norm("think" + fullText);
    console.log(`\n第五幕：想完之后的提示框共 ${finalText.length} 字，该有 ${want.length} 字`);
    if (finalText !== want) { problems.push("想完之后提示框里不是全文（跟整段思考一字不差地比过不去）"); }

    // ---- 第六幕：短内容不节流（每来一条增量提示框里就该有它）----
    await leaveTag(page, "think");
    await page.sleep(300);
    await page.eval(`
        window.postMessage({ type: "clear", keepDraft: true }, "*");
        window.postMessage({ type: "thinkingStart" }, "*");
        return true;
    `);
    await hoverTag(page, "think");
    await page.sleep(400);
    const shortBits = [];
    let lagged = 0;
    for (let i = 0; i < 8; i++) {
        const bit = `短思考第 ${i + 1} 段；\n`;
        shortBits.push(bit);
        await feed(page, [bit]);
        const inside = await page.eval(`return document.querySelector(".tag-tip").textContent.includes(${JSON.stringify(bit.trim())})`);
        if (!inside) { lagged++; }
    }
    console.log(`\n第六幕：短思考（一共 ${shortBits.join("").length} 字）连投 8 条，提示框没跟上的有 ${lagged} 条（该是 0）`);
    if (lagged) { problems.push(`短内容也被节流了：8 条里有 ${lagged} 条没马上跟上`); }
    await page.shot("think-tip-short.png");

    // ---- 第七幕：单独一个标签（taba 这类不合并的）连着长，也一样节流 ----
    await page.eval(`
        window.postMessage({ type: "clear", keepDraft: true }, "*");
        window.postMessage({ type: "tool", toolName: "taba_peek", toolCallId: "taba-1", args: { id: "taba-1" } }, "*");
        return true;
    `);
    await page.sleep(300);
    await page.eval(`
        const el = Array.from(document.querySelectorAll(".tool")).find((t) => !t.classList.contains("tool-group") && t.textContent.includes("taba_peek"));
        if (!el) { throw new Error("没找到单独那个 taba_peek 标签"); }
        el.dispatchEvent(new MouseEvent("mouseenter"));
        return true;
    `);
    await page.sleep(400);
    await countFills(page);
    let partial = "";
    const bits = [];
    for (let i = 0; i < 200; i++) { bits.push(chunk(2000 + i)); }
    const beforeSingle = Date.now();
    for (const bit of bits) {
        partial += bit;
        await page.eval(`window.postMessage({ type: "toolResultUpdate", toolCallId: "taba-1", resultText: ${JSON.stringify(partial)} }, "*"); return true;`);
    }
    await page.sleep(500);
    const singleFills = await takeFills(page);
    console.log(`\n第七幕：单独一个标签（taba_peek）边跑边长 ${partial.length} 字，提示框重画了 ${singleFills} 次` +
        `（${bits.length} 次更新，用了 ${Date.now() - beforeSingle} 毫秒）`);
    if (singleFills >= bits.length / 4) { problems.push(`单独标签的提示框没节流：${bits.length} 次更新重画了 ${singleFills} 次`); }
    await page.shot("think-tip-single.png");

    const longTasks = await page.eval("return window.__tips || []");
    console.log(`\n≥50 毫秒的长任务：${longTasks === null ? "（不支持观察）" : longTasks.length + " 条 " + JSON.stringify(longTasks.slice(0, 10))}`);

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

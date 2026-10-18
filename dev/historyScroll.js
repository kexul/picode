// @ts-nocheck
/**
 * historyScroll —— 验「加载更早的消息」那颗按钮点下去之后视野会不会跑。
 *
 *   npm run web:shot -- --fake-pi --script dev/historyScroll.js
 *   ROUNDS=25 AT_BOTTOM=1 npm run web:shot -- --fake-pi --script dev/historyScroll.js   # 多批 + 贴底时点
 *
 * 做法：先用假模型攒够十几轮对话，刷新页面让窗口生效（顶上会出现「加载更早的消息」按钮：
 * 这里把首屏窗口压到 20 条才挤得出它——正式跑时窗口是 200 条或 700 KB），把视野滚到中间，
 * 记下点之前 / 点之后（等新内容插进来）的滚动位置与“视野顶上那条消息”的位置，
 * 打印结论并截两张图。
 *
 * 判据有两条：
 *   1. 贴底时点（AT_BOTTOM=1）：点完还应该贴着底；
 *   2. 回看时点（默认）：点完看着的还是原来那条消息（位置差不超过几像素），
 *      且不能跑到最下方——bug 版本会整整甩到底部。
 */
// 首屏窗口压小：正式跑是 200 条 / 700 KB，那点对话挤不出「加载更早」按钮
process.env.PICHAT_HISTORY_WINDOW = process.env.PICHAT_HISTORY_WINDOW || "20";

const ROUNDS = Number(process.env.ROUNDS || 18);
const AT_BOTTOM = process.env.AT_BOTTOM === "1";

const PANE = "#messages .session-view .session-pane";

async function userBubbles(page) {
    return await page.eval("return document.querySelectorAll('.session-pane .msg.user').length");
}

/**
 * 窗格状态 + 视野顶上那条消息（顺便打个记号，回头按记号找它——
 * 假模型每轮说的话一模一样，靠文字认不出是哪一条）。
 */
async function paneState(page) {
    return await page.eval(`
        const pane = document.querySelector(${JSON.stringify(PANE)});
        if (!pane) { return null; }
        let anchor = null;
        for (const el of pane.children) {
            const r = el.getBoundingClientRect();
            const pr = pane.getBoundingClientRect();
            if (r.bottom > pr.top + 4) {
                if (!pane.querySelector('[data-scroll-anchor]')) { el.dataset.scrollAnchor = '1'; }
                anchor = {
                    cls: String(el.className).replace(/\\s+/g, '.').slice(0, 30),
                    text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 20),
                    viewTop: Math.round(r.top - pr.top),
                    offsetTop: Math.round(el.offsetTop),
                };
                break;
            }
        }
        return {
            top: Math.round(pane.scrollTop),
            height: Math.round(pane.scrollHeight),
            view: Math.round(pane.clientHeight),
            atBottom: pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 40,
            anchor: anchor,
            btn: (function () { const b = pane.querySelector('.history-more'); return b ? b.textContent : null; })(),
            btnInPane: !!pane.querySelector('.history-more'),
        };
    `);
}

/** 点之前标住的那条消息，现在跑到哪儿了。 */
async function anchorNow(page) {
    return await page.eval(`
        const pane = document.querySelector(${JSON.stringify(PANE)});
        const el = pane && pane.querySelector('[data-scroll-anchor]');
        if (!el) { return null; }
        const r = el.getBoundingClientRect();
        const pr = pane.getBoundingClientRect();
        return { viewTop: Math.round(r.top - pr.top), offsetTop: Math.round(el.offsetTop) };
    `);
}

/** 攒够消息：每轮假模型都会回一大段（user + assistant 两条，凑够窗口要的条数）。 */
async function fillMessages(page, rounds) {
    console.log(`  攒消息：${rounds} 轮`);
    for (let i = 1; i <= rounds; i++) {
        await page.send(`第 ${i} 轮：随便回两句就行`);
        let ok = false;
        for (let t = 0; t < 200; t++) {
            if ((await userBubbles(page)) >= i) { ok = true; break; }
            await page.sleep(200);
        }
        if (!ok) { throw new Error(`第 ${i} 轮没发出去`); }
    }
    console.log(`  消息攒好了：${await userBubbles(page)} 条用户消息`);
}

/** 刷新页面：走「只发最近一段历史」那条路（顶上才有「加载更早的消息」）。 */
async function reloadWithWindow(page) {
    await page.eval("location.reload(); return true;");
    await page.waitReady();
    for (let t = 0; t < 100; t++) {
        const st = await paneState(page);
        if (st && st.btnInPane) { break; }
        await page.sleep(300);
    }
}

/** 点一次「加载更早」，返回点之前 / 点之后的状态与那条记号消息的位置。 */
async function clickLoadMore(page, tag) {
    // 到点之前先回到“离底部远一点”的样子，或者按要求贴底
    await page.eval(`
        const pane = document.querySelector(${JSON.stringify(PANE)});
        pane.scrollTop = ${AT_BOTTOM ? "pane.scrollHeight" : "Math.round(pane.scrollHeight * 0.35)"};
        pane.querySelectorAll('[data-scroll-anchor]').forEach(function (el) { el.removeAttribute('data-scroll-anchor'); });
        return pane.scrollTop;
    `);
    await page.sleep(600);
    const before = await paneState(page);
    await page.shot(`history-${tag}-before.png`);
    await page.eval(`document.querySelector(${JSON.stringify(PANE)} + ' .history-more').click(); return true;`);

    // 等那批消息插进来（内容高度变了就是插完了），再多等一会儿看有没有“后到的滚动”
    for (let t = 0; t < 200; t++) {
        const now = await paneState(page);
        if (now && now.height !== before.height) { break; }
        await page.sleep(100);
    }
    await page.sleep(1200);
    const after = await paneState(page);
    const nowAnchor = await anchorNow(page);
    await page.shot(`history-${tag}-after.png`);

    console.log(`  点之前：${JSON.stringify(before)}`);
    console.log(`  点之后：${JSON.stringify(after)}`);
    let ok;
    if (AT_BOTTOM) {
        ok = after.atBottom;
        console.log(ok ? "  ✅ 贴底时点：点完还贴着底" : `  ❌ 贴底时点：点完离开了底（差 ${after.height - after.top - after.view} 像素）`);
    } else {
        const shift = nowAnchor ? nowAnchor.viewTop - before.anchor.viewTop : NaN;
        ok = !!nowAnchor && Math.abs(shift) <= 4 && !after.atBottom;
        console.log(`  视野顶上那条（${before.anchor.text}）在视野里的位置：${before.anchor.viewTop} → ${nowAnchor ? nowAnchor.viewTop : "没了"}（差 ${shift} 像素）`);
        console.log(ok
            ? "  ✅ 回看时点：看着的还是原来那处，没有被甩到底部"
            : `  ❌ 回看时点：视野跑了（滚到 ${after.top}，内容高 ${before.height} → ${after.height}）`);
    }
    return ok;
}

module.exports = async (page) => {
    await page.waitReady();
    await fillMessages(page, ROUNDS);
    await reloadWithWindow(page);

    const results = [];
    results.push(await clickLoadMore(page, "1"));
    // 还有更早的（ROUNDS 够多时）：再点一次，确认连着点也不会跑
    const st = await paneState(page);
    if (st && st.btnInPane && process.env.ONCE !== "1") {
        results.push(await clickLoadMore(page, "2"));
    }

    // 默认窗口（200 条 / 700 KB）下这些对话应该一次全发下来：把刚才压小的窗口撤掉，
    // 重新开一次页面。这条抓的是“默认值被改小”（改回 30 条的话，按钮会冒出来、消息也只剩一半）
    delete process.env.PICHAT_HISTORY_WINDOW;
    await page.eval("location.reload(); return true;");
    await page.waitReady();
    await page.sleep(2500);
    const plain = await page.eval(`return {
        users: document.querySelectorAll('#messages .msg.user').length,
        moreBtn: !!document.querySelector('.history-more'),
    }`);
    console.log(`  默认窗口下：用户消息 ${plain.users} 条、「加载更早」${plain.moreBtn ? "有" : "没有"}`);
    if (plain.moreBtn) { throw new Error("默认窗口下不该出现「加载更早」（窗口默认值是不是被改小了）"); }
    if (plain.users < ROUNDS) { throw new Error(`默认窗口下 ${ROUNDS} 轮对话该全在（只有 ${plain.users} 条用户消息）`); }

    if (results.some((ok) => !ok)) { throw new Error("有一步的视野跑掉了"); }
    console.log("  全部通过。");
};

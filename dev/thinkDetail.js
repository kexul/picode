// @ts-nocheck
/**
 * thinkDetail —— 验「think 点开不是空的」（三种都会让那颗标签点开写着「（没有输出）」）。
 *
 *   FAKEPI_LATE_THINK_END=1 FAKEPI_LONG=1500 FAKEPI_TICK_MS=25 \
 *     npm run web:shot -- --fake-pi --script dev/thinkDetail.js
 *
 * 三个环境变量是给假模型（dev/fakePi.js）的：思考撑长一点、慢一点，才有时间中途点「停止生成」；
 * FAKEPI_LATE_THINK_END=1 让思考的收尾拖到正文开始之后才发 —— 真 pi 的 openai-completions
 * 适配器就是这样（正文边流边给，整条流跑完才把每个块收尾），所以会先撞上“正文开始了，这段想完了”。
 *
 * 验三件事：
 *   1. 想一半点「停止生成」：已经想到的那段还在（点开有字），不是「（没有输出）」；
 *   2. 收尾比正文晚到：界面上只有一颗 think（不是一颗空的 + 一颗有内容的），点开是全文；
 *   3. 模型只给了加密的思考（一个字都没有）：点开写「（这段思考没有文字）」，不是「（没有输出）」。
 */
const LONG = Number(process.env.FAKEPI_LONG || 0);

/** 页面上所有 think 标签里的条目（每条：有没有正文、有没有编号可以取全文、显示成什么）。 */
function thinkEntries(page) {
    return page.eval(`
        const tags = Array.from(document.querySelectorAll('.session-view:not(.off) .session-pane .tool'));
        const out = [];
        tags.forEach(function (t) {
            if (!/^think/.test((t.innerText || '').trim())) { return; }
            const g = t._tipGroup;
            if (!g) { return; }
            g.entries.forEach(function (e) {
                out.push({
                    len: (e.resultText || '').length,
                    clip: e.clip ? e.clip.key : '',
                    done: e.done,
                });
            });
        });
        return out;
    `);
}

/** 悬浮到最后一颗 think 标签上，把提示框里的字读回来。 */
async function hoverLastThink(page) {
    const ok = await page.eval(`
        const tags = Array.from(document.querySelectorAll('.session-view:not(.off) .session-pane .tool'))
            .filter(function (t) { return /^think/.test((t.innerText || '').trim()); });
        const tag = tags[tags.length - 1];
        if (!tag) { return false; }
        tag.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        return true;
    `);
    if (!ok) { return { open: false, text: "" }; }
    await page.sleep(1500);      // 200 毫秒弹出来，之后还要等取全文那一趟
    return await page.eval(`
        const el = document.querySelector('.tag-tip');
        if (!el || el.classList.contains('hidden')) { return { open: false, text: '' }; }
        return { open: true, text: el.innerText || '' };
    `);
}

function hideTip(page) {
    return page.eval(`
        document.querySelectorAll('.session-view:not(.off) .session-pane .tool').forEach(function (t) {
            t.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
        });
        return true;
    `);
}

/** 等到模型这一轮停下来（圆环回到 idle）。 */
async function waitIdle(page, timeoutMs) {
    const limit = Date.now() + (timeoutMs || 90000);
    while (Date.now() < limit) {
        const st = await page.eval(`const el = document.getElementById('ctxIcon'); return el ? el.dataset.st : '';`);
        if (st === "idle") { return true; }
        await page.sleep(200);
    }
    return false;
}

/** 发一句、等这一轮真跑完（先等它动起来：刚发出去那一下圆环还是闲着的，直接等 idle 会当场返回）。 */
async function sendAndWait(page, text) {
    await page.send(text);
    const limit = Date.now() + 15000;
    while (Date.now() < limit) {
        const st = await page.eval(`const el = document.getElementById('ctxIcon'); return el ? el.dataset.st : '';`);
        if (st !== "idle" && st !== "") { break; }
        await page.sleep(50);
    }
    return await waitIdle(page);
}

/** 等那颗 think 标签转起来（正在想）。 */
async function waitThinking(page, timeoutMs) {
    const limit = Date.now() + (timeoutMs || 30000);
    while (Date.now() < limit) {
        const running = await page.eval(`
            const tags = Array.from(document.querySelectorAll('.session-view:not(.off) .session-pane .tool'));
            return tags.some(function (t) { return /^think/.test((t.innerText || '').trim()) && t.classList.contains('running'); });
        `);
        if (running) { return true; }
        await page.sleep(50);
    }
    return false;
}

module.exports = async (page) => {
    console.log(`\n【think 点开是不是空的】假模型：思考 ${LONG} 字、收尾晚到 ${process.env.FAKEPI_LATE_THINK_END ? "是" : "否（这个检查要看它，记得设 FAKEPI_LATE_THINK_END=1）"}`);
    const results = [];
    const check = (name, ok, detail) => {
        results.push(ok);
        console.log(`  ${ok ? "✅" : "❌"} ${name}：${detail}`);
    };

    // ---- 1. 想一半点「停止生成」----
    console.log("  —— 第一轮：想一半就点「停止生成」——");
    await page.send("你好");
    const thinking = await waitThinking(page, 30000);
    if (!thinking) { check("看到 thinking 行", false, "假模型的思考没跑起来（FAKEPI_TICK_MS 是不是 0？那样一次就发完了）"); }
    const clicked = await page.eval(`
        const btn = document.querySelector('.session-view:not(.off) .session-pane .msg-endhint-stop');
        if (!btn) { return false; }
        btn.click();
        return true;
    `);
    check("点到了「停止生成」", clicked, clicked ? "点到了" : "那颗按钮没露面");
    await waitIdle(page);
    await page.sleep(1200);
    const afterStop = await thinkEntries(page);
    const stopped = afterStop[afterStop.length - 1] || null;
    check("停下来的那颗还有字号可取", !!stopped && stopped.done && !!stopped.clip,
        JSON.stringify(afterStop));
    const stopTip = await hoverLastThink(page);
    check("点开看得到已经想到的那段", /用户要的是|用户要的是演示/.test(stopTip.text) && !/（没有输出）/.test(stopTip.text),
        JSON.stringify(stopTip.text.slice(0, 60)));
    await hideTip(page);
    await page.sleep(300);

    // ---- 2. 收尾比正文晚到：一颗，不是两颗 ----
    console.log("  —— 第二轮：完整跑一遍（收尾晚到）——");
    await sendAndWait(page, "你好");
    await page.sleep(1500);
    const all = await thinkEntries(page);
    const second = all.slice(afterStop.length);
    check("这一轮只出一颗 think", second.length === 1, `${second.length} 颗：${JSON.stringify(second)}`);
    const tip = await hoverLastThink(page);
    const body = tip.text.replace(/^think\s*/, "");
    check("点开是那段思考全文", tip.open && body.trim().length > 20 && !/（没有输出）/.test(tip.text),
        JSON.stringify(body.slice(0, 40)));
    await page.shot("think-detail.png");
    await hideTip(page);
    await page.sleep(300);

    // ---- 3. 加密的思考：模型只给了密文，一个字都没有 ----
    // 后端这种什么都不发（没有正文、没有编号），界面只收到「开始想了」和「不在想了」两条。
    console.log("  —— 第三轮：只给加密内容的思考（往后端推的那两条消息就是这么来的）——");
    await page.eval(`
        window.postMessage({ type: 'thinkingStart', detailKey: 'think:enc:1' }, '*');
        window.postMessage({ type: 'activityChanged', activity: 'working' }, '*');
        return true;
    `);
    await page.sleep(800);
    const encEntries = await thinkEntries(page);
    const encTip = await hoverLastThink(page);
    check("点开写清“没有文字”", /（这段思考没有文字）/.test(encTip.text),
        JSON.stringify(encEntries.slice(-1)) + " 提示框：" + JSON.stringify(encTip.text.slice(0, 80)));
    await page.shot("think-encrypted.png");
    await hideTip(page);

    const ok = results.every(Boolean);
    console.log(ok ? "\n全部通过。" : "\n有不通过的。");
    return ok;
};

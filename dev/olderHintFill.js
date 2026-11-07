// @ts-nocheck
/**
 * olderHintFill —— 验「往上滑到顶上那片空白（占位）跟前，它自己会补出来」。
 *
 *   FAKEPI_THINK_MS=8000 npm run web:shot -- --fake-pi --script dev/olderHintFill.js
 *
 * 为什么要有这条：从零重画只画最后几轮，上面没画的缩成一条占位（.older-hint，
 * 写着「往上还有 N 轮」），高度是估的。它得在“人划到跟前”时补出来；生成中也是一样——
 * 以前生成中一律不补，人往上翻就撞见一大片空白（写着「往上还有 3 轮」），一直空到这一轮跑完。
 *
 * 做法：往界面里塞 60 轮（跟 dev/liveTrimTurns.js 一样，直接走消息那条路，最快），
 * 最老的会被搬到占位上；再发一句话让这一轮真的在跑，趁着还在跑把视野扔进占位中间。
 * 判据两条：
 *   1. 占位要缩（说明补进去了），视野里要看得见真东西（不能整屏都是占位）；
 *   2. 会话闲下来以后滚到顶也一样（补完占位收掉）。
 *
 * FAKEPI_THINK_MS 得给在命令行上：假模型每轮开头停这么久，才有“正在生成”那几秒可以翻历史。
 * 不给的话这一轮秒回，第一步就验不到（脚本自己会指出来）。
 */

const ROUNDS = Number(process.env.ROUNDS || 60);
const PANE = "#messages .session-view:not(.off) .session-pane";

/** 往当前会话里塞 n 轮（一轮 = 用户一句 + 助手一段），跟后端推消息走同一条路。 */
async function stuff(page, from, to) {
    return await page.eval(`
        const pane = document.querySelector(${JSON.stringify(PANE)});
        const sessionId = pane.dataset.sessionId;
        const send = function (msg) {
            window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: sessionId }, msg) }));
        };
        for (let i = ${from}; i <= ${to}; i += 1) {
            send({ type: "userMessage", text: "第 " + i + " 轮：看一下这段。" });
            send({ type: "assistantFull", text: "第 " + i + " 轮的回话：先看状态，再决定要不要改，改完把结果写回。" });
        }
        return true;
    `);
}

/** 窗格现在什么样：占位多高、写着什么、视野顶上第一块东西是什么。 */
async function shape(page) {
    return await page.eval(`
        const pane = document.querySelector(${JSON.stringify(PANE)});
        const hint = pane.querySelector(".older-hint");
        const pr = pane.getBoundingClientRect();
        let first = null;
        for (const el of pane.children) {
            const r = el.getBoundingClientRect();
            if (r.bottom > pr.top + 2) {
                first = { cls: String(el.className).slice(0, 18), at: Math.round(r.top - pr.top) };
                break;
            }
        }
        return {
            top: Math.round(pane.scrollTop),
            users: pane.querySelectorAll(".msg.user").length,
            hintH: hint ? Math.round(hint.offsetHeight) : null,
            hintText: hint ? hint.innerText.replace(/\\s+/g, " ").slice(0, 18) : null,
            first: first,
        };
    `);
}

/** 把视野扔进占位中间（拖滚动条、手指快滑到一个位置就是这个效果）。 */
async function scrollIntoHint(page) {
    return await page.eval(`
        const pane = document.querySelector(${JSON.stringify(PANE)});
        const hint = pane.querySelector(".older-hint");
        if (!hint) { return false; }
        pane.scrollTop = Math.round(hint.offsetTop + hint.offsetHeight * 0.5);
        return true;
    `);
}

/** 等占位缩下去（补进去一截），返回这时候的样子。 */
async function waitFilled(page, before, tag) {
    for (let t = 0; t < 40; t += 1) {
        await page.sleep(200);
        const now = await shape(page);
        const shrank = now.hintH === null || before.hintH === null || now.hintH < before.hintH;
        const seen = !!now.first && now.first.cls !== "older-hint";
        if (shrank && seen) { return now; }
    }
    const now = await shape(page);
    console.log(`  ❌ ${tag}：占位没补（还是 ${now.hintH} 像素、写着「${now.hintText}」），视野顶上=${now.first ? now.first.cls : "-"}`);
    await page.shot(`older-hint-${tag}.png`);
    return null;
}

module.exports = async (page) => {
    await page.waitReady();
    await stuff(page, 1, ROUNDS);
    await page.sleep(1500);
    let s = await shape(page);
    console.log(`  塞了 ${ROUNDS} 轮：窗格里 ${s.users} 条用户气泡，占位「${s.hintText}」${s.hintH} 像素`);
    if (!s.hintH) { throw new Error("顶上没有那条占位（窗格里的轮数没超上限？）"); }

    // 1. 这一轮正在生成时滚进占位
    await page.send("随便说一句");
    let casting = false;
    for (let t = 0; t < 20; t += 1) {
        await page.sleep(150);
        if (await page.eval("const el = document.getElementById('ctxIcon'); return el ? el.dataset.st : '';") === "streaming") { casting = true; break; }
    }
    if (!casting) {
        throw new Error("这一轮秒回完了，赶不上“正在生成”——在命令行上给 FAKEPI_THINK_MS=8000 再跑");
    }
    if (!(await scrollIntoHint(page))) { throw new Error("发完这句占位没了"); }
    const filled = await waitFilled(page, await shape(page), "生成中");
    if (!filled) { throw new Error("生成中滚进占位，它一直空着（生成中不补 → 一大片空白）"); }
    console.log(`  ✅ 生成中滚进占位：补到还剩 ${filled.hintH} 像素（视野顶上是 ${filled.first.cls}）`);

    // 2. 等这一轮跑完，会话闲下来，再滚进去一次：这次要能补到底（占位收掉）
    for (let t = 0; t < 100; t += 1) {
        const busy = await page.eval(`
            const pane = document.querySelector(${JSON.stringify(PANE)});
            return !!(pane && pane.querySelector(".run-clock, .running-line, .msg.streaming"));
        `);
        if (!busy) { break; }
        await page.sleep(300);
    }
    await page.sleep(500);
    await page.eval(`
        const pane = document.querySelector(${JSON.stringify(PANE)});
        pane.scrollTop = Math.round(pane.scrollHeight * 0.3);
        return true;
    `);
    await page.sleep(400);
    await scrollIntoHint(page);
    // 塞了 ROUNDS 轮，另外真发过一句（那一句自己也是一轮）
    const want = ROUNDS + 1;
    let idle = null;
    for (let t = 0; t < 60; t += 1) {
        await page.sleep(200);
        idle = await shape(page);
        if (!idle.hintH && idle.users === want) { break; }
        await scrollIntoHint(page);
    }
    if (idle.hintH || idle.users !== want) {
        console.log(`  ❌ 闲着的时候滚进占位：占位「${idle.hintText}」（${idle.hintH} 像素），窗格里 ${idle.users} 条用户气泡，应该是 ${want} 条、占位收掉`);
        await page.shot("older-hint-idle.png");
        throw new Error("闲着的时候滚到顶，占位没收掉");
    }
    console.log(`  ✅ 闲着的时候滚到顶：${idle.users} 轮全补回来了，占位收掉`);

    const errors = (page.pageErrors || []).filter((text) => text && !/acquireVsCodeApi 被调用了多次/.test(text));
    if (errors.length) {
        console.log("  页面报错：" + errors.slice(0, 3).join(" / "));
        throw new Error("页面上有报错");
    }
    console.log("  全部通过。");
};

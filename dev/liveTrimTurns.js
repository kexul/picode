// @ts-nocheck
/**
 * liveTrimTurns —— 验「窗格里的轮数超了就把最老的几轮搬去顶上那条占位」。
 *
 *   npm run web:shot -- --fake-pi --script dev/liveTrimTurns.js
 *
 * 为什么要有这条：页面一直开着、会话一直在跑，新消息就一路往 DOM 里加。跑久了窗格里几千条，
 * 手机上切一次会话要几百毫秒（58 条时 25~80 毫秒，2855 条时 130~340 毫秒；量法见
 * dev/switchPerf.js 的 --cpu / --width / --height 那几个参数）。所以要跟「往上还有」那套一样
 * 限个量：超过 40 轮就把最老的搬到占位上，往上滑再原样画回来。
 *
 * 这里不去等假模型一轮一轮地回（太慢），直接往界面里塞消息——跟后端推来的那条路一样。
 * 判据：
 *   1. 塞完 60 轮，窗格里留着的用户气泡不超过 40 条，顶上有「往上还有 N 轮」；
 *   2. 一路往上滑，60 轮全都能补回来，一条不少，补完占位收掉；
 *   3. 切到另一个会话再切回来，内容还在、没有重复；
 *   4. 页面上没有报错。
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

/** 窗格里现在什么样：用户气泡几条、总节点几个、占位写着什么。 */
async function state(page) {
    return await page.eval(`
        const pane = document.querySelector(${JSON.stringify(PANE)});
        const hint = pane.querySelector(".older-hint");
        return {
            users: pane.querySelectorAll(".msg.user").length,
            nodes: pane.querySelectorAll("*").length,
            hint: hint ? (hint.innerText || "").trim() : "",
            lastUser: (function () {
                const all = pane.querySelectorAll(".msg.user");
                return all.length ? all[all.length - 1].innerText.trim().slice(0, 12) : "";
            })(),
        };
    `);
}

/** 一路往上滚到底：每帧看一眼，等占位消失（说明能补的全补回来了）。 */
async function scrollToTopUntilDone(page) {
    for (let round = 0; round < 200; round += 1) {
        await page.eval(`
            const pane = document.querySelector(${JSON.stringify(PANE)});
            pane.scrollTop = 0;
            return true;
        `);
        await page.sleep(120);
        const hint = await page.eval(`
            const pane = document.querySelector(${JSON.stringify(PANE)});
            return !!pane.querySelector(".older-hint");
        `);
        if (!hint) { return true; }
    }
    return false;
}

module.exports = async (page) => {
    await page.waitReady();

    await stuff(page, 1, ROUNDS);
    await page.sleep(1200);

    const kept = await state(page);
    console.log(`  塞了 ${ROUNDS} 轮之后：窗格里还剩 ${kept.users} 条用户气泡、${kept.nodes} 个节点，占位写着「${kept.hint}」`);
    if (kept.users > 40) { throw new Error(`窗格里留了 ${kept.users} 轮，该搬到 40 轮以内`); }
    if (!kept.hint) { throw new Error("顶上没有「往上还有 N 轮」那条占位"); }
    if (!/往上还有 \d+ 轮/.test(kept.hint)) { throw new Error(`占位上的字不对：「${kept.hint}」`); }
    if (!kept.lastUser.includes(`第 ${ROUNDS} 轮`)) { throw new Error(`最后一条用户气泡不是最新那轮（是「${kept.lastUser}」）`); }

    // 往上滑：搬出去的要能原样补回来
    const done = await scrollToTopUntilDone(page);
    if (!done) { throw new Error("一路滚到顶，占位一直没消失（补不回来）"); }
    const all = await state(page);
    console.log(`  滚到顶之后：用户气泡 ${all.users} 条、${all.nodes} 个节点，占位上「${all.hint}」`);
    if (all.users !== ROUNDS) { throw new Error(`补回来之后应该有 ${ROUNDS} 轮，实际 ${all.users} 轮`); }
    if (all.hint) { throw new Error("都补回来了，占位还在"); }

    // 再往上顶一遍：补回来的那几轮长得对不对（第一条是不是第 1 轮）
    const first = await page.eval(`
        const pane = document.querySelector(${JSON.stringify(PANE)});
        const first = pane.querySelector(".msg.user");
        return first ? first.innerText.trim().slice(0, 12) : "";
    `);
    if (!first.includes("第 1 轮")) { throw new Error(`最上面那条应该是「第 1 轮」，实际是「${first}」`); }

    // 切走再切回来：内容还在、没有重复
    const originId = await page.eval(`return document.querySelector(${JSON.stringify(PANE)}).dataset.sessionId;`);
    await page.eval(`document.getElementById("newSessionBtn").click(); return true;`);
    await page.sleep(1500);
    const otherId = await page.eval(`return document.querySelector(${JSON.stringify(PANE)}).dataset.sessionId;`);
    if (otherId === originId) { throw new Error("没建出第二个会话"); }
    await page.eval(`
        window.acquireVsCodeApi().postMessage({ type: "switchSession", sessionId: ${JSON.stringify(originId)} });
        return true;
    `);
    await page.sleep(1500);
    const back = await state(page);
    console.log(`  切走再切回来：用户气泡 ${back.users} 条、${back.nodes} 个节点，占位上「${back.hint}」`);
    if (back.users !== ROUNDS) { throw new Error(`切回来之后有 ${back.users} 轮，应该是 ${ROUNDS} 轮（少了=丢了，多了=重复）`); }

    const errors = (page.pageErrors || []).filter((text) => text && !/acquireVsCodeApi 被调用了多次/.test(text));
    if (errors.length) {
        console.log("  页面报错：" + errors.slice(0, 3).join(" / "));
        throw new Error("页面上有报错");
    }
    console.log("  全部通过。");
};

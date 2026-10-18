// @ts-nocheck
/**
 * followBottom —— 验「正在输出的时候，视野还跟不跟着底部走」。
 *
 * 人报过的症状：有时跟着，有时忽然不跟了（内容照旧往下长，视野停在原地，
 * 右下角那颗「跳到最新」自己冒出来）。原因是程序自己滚的那一下记的是“滚到底”，
 * 而 scroll 事件要下一帧才派发；中间内容只要又长了一点，这一下就被当成“用户自己往回滚了”，
 * 从此不再跟随。这里把那个顺序按下来：
 *   1. 先把消息流撑到能滚，确认贴着底；
 *   2. 走一次“工具结果 → 自己滚到底”，等那一帧过去，再在两帧之间让内容长一截
 *      （用一块撑高的空盒子代表“消息落在两帧之间”），然后接着流一小段：还得贴着底；
 *   3. 用户自己往回滚一下：接着流，视野不许被拽回底部（那颗「跳到最新」该露出来）；
 *   4. 点那颗「跳到最新」：又贴回去了。
 *
 *   npm run web:shot -- --width 420 --height 800 --script dev/followBottom.js
 */
module.exports = async (page) => {
    await page.waitReady();
    const problems = [];
    const post = (m) => page.eval(`for (const x of ${JSON.stringify(m)}) { window.postMessage(x, "*"); } return true;`);
    const view = () => page.eval(`
        const pane = document.querySelector(".session-pane");
        const jump = document.getElementById("jumpBottom");
        return {
            dist: pane ? Math.round(pane.scrollHeight - pane.scrollTop - pane.clientHeight) : -1,
            top: pane ? Math.round(pane.scrollTop) : -1,
            jump: jump ? !jump.classList.contains("hidden") : null,
        };
    `);
    const sid = await page.eval(`const p = document.querySelector(".session-pane"); return p ? p.dataset.sessionId : "";`);
    const para = "这一句是为了把高度撑起来，一句一句地往下写。";

    // ---- 第一幕：把消息流撑到能滚，并且贴着底 ----
    await post([{ type: "userMessage", sessionId: sid, text: "开始" }]);
    await post([{ type: "streamStart", sessionId: sid }]);
    for (let i = 0; i < 6; i++) {
        await post([{ type: "assistantFull", sessionId: sid, text: para.repeat(6) }]);
        await page.sleep(60);
    }
    let v = await view();
    console.log("第一幕（流了几段，应该贴着底）：\n  " + JSON.stringify(v));
    if (v.dist > 2) { problems.push("一开始就没贴着底（后面几幕无从验起）：" + JSON.stringify(v)); }

    // ---- 第二幕：一整段正文落下来（自己滚到底），紧接着内容又在两帧之间长了一截 ----
    // 这就是现实里的那一刻：一段文字落下来、程序自己滚到底，紧跟着又有东西（工具行、图、
    // 下一段文字）在两帧之间把内容撑长。滚动位置是我们自己设的，那一下不该被当成“用户往回滚了”。
    await post([{ type: "assistantFull", sessionId: sid, text: para.repeat(8) }]);
    // 在这一帧里排在“自己滚到底”之后跑：它滚完，内容紧接着又长一截（这就是“两条消息落在两帧之间”）
    await page.eval(`
        requestAnimationFrame(() => {
            const pane = document.querySelector(".session-pane");
            const filler = document.createElement("div");
            filler.className = "msg assistant";
            filler.style.height = "300px";
            filler.dataset.followTest = "1";
            pane.appendChild(filler);
        });
        return true;
    `);
    await page.sleep(200);   // 再等一帧：这一次的 scroll 事件就是那一帧派发下来的
    await post([{ type: "assistantDelta", sessionId: sid, delta: para }]);
    await page.sleep(300);
    v = await view();
    console.log("第二幕（一段正文落下来、自己滚到底之后内容又长了一截，再流一小段）：\n  " + JSON.stringify(v));
    if (v.dist > 2) { problems.push("内容在两帧之间长了一截，视野就不跟着了（该继续贴着底）：离底 " + v.dist + " 像素"); }
    await page.eval(`const el = document.querySelector('[data-follow-test]'); if (el) { el.remove(); } return true;`);

    // ---- 第三幕：用户自己往回滚 → 接着流，视野不该被拽回去 ----
    const before = await page.eval(`
        const pane = document.querySelector(".session-pane");
        pane.scrollTop = Math.max(0, pane.scrollTop - 200);
        return Math.round(pane.scrollTop);
    `);
    await page.sleep(150);
    await post([{ type: "assistantDelta", sessionId: sid, delta: para.repeat(3) }]);
    await page.sleep(400);
    v = await view();
    console.log("第三幕（自己往回滚了 200 像素，再流一段）：\n  滚之前在 " + before + " → " + JSON.stringify(v));
    if (v.top < before - 4) { problems.push("用户往回滚之后视野被拽回去了：" + before + " → " + v.top); }
    if (!v.jump) { problems.push("往回滚着、正流式输出，那颗「跳到最新」该露出来：" + JSON.stringify(v)); }

    // ---- 第四幕：点一下「跳到最新」→ 又贴回底部 ----
    await page.click("#jumpBottom");
    await page.sleep(400);
    v = await view();
    console.log("\n第四幕（点了「跳到最新」）：\n  " + JSON.stringify(v));
    if (v.dist > 2) { problems.push("点了「跳到最新」没贴回底部：" + JSON.stringify(v)); }
    if (v.jump) { problems.push("贴回底部之后那颗「跳到最新」还露着：" + JSON.stringify(v)); }
    await page.shot("follow-bottom.png");

    if (problems.length) { throw new Error("有对不上的地方：\n  - " + problems.join("\n  - ")); }
    console.log("\n  全部通过。");
};

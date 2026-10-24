// @ts-nocheck
/**
 * thinkRow —— 验「模型的思考也显示成工具行里的一种条目」。
 *
 * 要配假模型跑（`--fake-pi`）：前半截真跑一轮，后端发什么、页面画什么都是真的；
 * 后半截直接往页面里投消息（跟后端推的同一种形状），凑真模型不好凑的情形。
 * 一次验这几件事：
 *   · 开始想 → 工具行里出现 think 标签、齿轮在转，提示框里的文字随增量长大；
 *   · 想完（thinking_full）→ 标签停住；
 *   · 刷新页面（历史重放）→ 历史里的思考块一样出标签、跟当时一样；
 *   · 同一批里想两段 → 收成一个标签、带次数「2」，提示框里两段各列出来；
 *   · 思考跟工具排在同一条工具行里；来了正文就另起一条行；
 *   · 正文之后补来一段思考（provider 只给收尾那种）→ 先在末尾出一颗；这一轮跑完它还留在末尾，
 *     就并回本段那颗（次数接上、三段都在提示框里），末尾不留孤零零一颗；
 *   · 它后面还跟着工具的，留在原位（位置本身就是信息），跑完一轮也不动它；
 *   · 换了用户消息（新的一段）→ 下一段思考另开一颗；
 *   · 整屏重画收尾（重连 / 刷新后补一份会话列表）时，末尾那颗也并回去；
 *   · 「开头先宣布要开始想了 + 正文 + 收尾才把整段思考送来」→ 并回上面那颗（同一段思考不拆成两颗）。
 *
 *   FAKEPI_TICK_MS=20 npm run web:shot -- --fake-pi --script dev/thinkRow.js
 * 图落在 dev/shots/（think-*.png）。
 */

/** 往页面里投一批后端消息（跟 webChat/扩展推给页面的形状一样）。 */
function post(page, messages) {
    return page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
}

/** 页面上每一块现在长什么样：工具行里各标签的文字（转圈的额外标一下）+ 正文块。 */
function dump(page) {
    return page.eval(`
        const rows = [];
        const tagText = (el) => {
            const c = el.cloneNode(true);
            // +1 小动画只是动画，不算标签文字（见 chat.js 的 popPlusOne）
            for (const n of c.querySelectorAll(".tg-plus")) { n.remove(); }
            return c.textContent.trim().replace(/\\s+/g, " ");
        };
        for (const pane of document.querySelectorAll(".session-view:not(.off) .session-pane")) {
            for (const el of pane.children) {
                const cls = el.className || "";
                if (cls.indexOf("tool-row") >= 0) {
                    rows.push("工具行：" + Array.from(el.children).map((c) => "[" + tagText(c) + (c.classList.contains("running") ? " 转圈" : "") + "]").join(""));
                } else if (cls.indexOf("assistant") >= 0) {
                    rows.push("正文：" + el.textContent.trim().replace(/\\s+/g, " ").slice(0, 14));
                }
            }
        }
        return rows.join(" | ");
    `);
}

/** 提示框里现在写着什么（没出来就说明没挂上）。 */
function tipText(page) {
    return page.eval(`
        const el = document.querySelector(".tag-tip");
        if (!el || el.classList.contains("hidden")) { return "（提示框没出来）"; }
        return el.textContent.replace(/\\s+/g, " ").trim();
    `);
}

/** 让名字开头是 name 的那个标签进入悬浮状态（电脑上没有触屏那一套，靠 mouseenter 触发提示框）。 */
function hoverTag(page, name) {
    return page.eval(`
        const el = Array.from(document.querySelectorAll(".tool-group")).find((t) => t.textContent.trim().startsWith(${JSON.stringify(name)}));
        if (!el) { throw new Error("页面上没有这个标签：" + ${JSON.stringify(name)}); }
        el.dispatchEvent(new MouseEvent("mouseenter"));
        return true;
    `);
}

/** 悬浮结束（提示框有一段宽限时间才收，见 scheduleTagTipHide）。 */
function leaveTag(page, name) {
    return page.eval(`
        const el = Array.from(document.querySelectorAll(".tool-group")).find((t) => t.textContent.trim().startsWith(${JSON.stringify(name)}));
        if (!el) { return false; }
        el.dispatchEvent(new MouseEvent("mouseleave"));
        return true;
    `);
}

/** 刷新页面：走历史重放那条路（后端把 pi 会话里的消息重新推一遍）。 */
async function reload(page) {
    await page.eval("location.reload(); return true;");
    await page.waitReady();
    await page.sleep(800);
}

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];

    // ---- 第一幕：真跑一轮（假 pi 先想一段，再说、再调工具、再收尾） ----
    await page.send("随便说点什么");
    await page.waitAnswer("完事");
    await page.sleep(400);
    const live = await dump(page);
    console.log("第一幕（当场生成：think 标签排在正文前面，跟工具分开两条行；想完了不该还转圈）：\n  " + live);
    await hoverTag(page, "think");
    await page.sleep(500);
    const liveTip = await tipText(page);
    console.log("  提示框（该是那一段思考的全文）：" + liveTip);
    await page.shot("think-live-tip.png");
    await leaveTag(page, "think");
    await page.sleep(250);

    if (!live.includes("工具行：[think]")) { problems.push("当场生成时没看到 think 标签"); }
    if (live.includes("[think 转圈]")) { problems.push("想完了，think 标签还在转圈"); }
    if (!/工具行：\[read\]\[bash\]/.test(live)) { problems.push("工具没跟思考分开、按批排在同一条行里"); }
    if (!liveTip.includes("用户要的是演示")) { problems.push("提示框里没看到那段思考的全文"); }

    // ---- 第二幕：刷新页面（历史重放）——历史里的思考块也该出标签，跟当时一样 ----
    await reload(page);
    const replay = await dump(page);
    console.log("\n第二幕（刷新后重放：历史里的思考块照样出标签、照样停住）：\n  " + replay);
    await page.shot("think-replay.png");
    if (!replay.includes("工具行：[think]")) { problems.push("刷新重放后历史里的思考块没出标签"); }
    if (replay.includes("[think 转圈]")) { problems.push("重放出来的 think 标签在转圈（该是停住的）"); }

    // ---- 第三幕：同一批里想两段 → 一个标签带次数「2」；和工具挤在同一条行里 ----
    await post(page, [{ type: "clear", keepDraft: true }]);
    await post(page, [
        { type: "thinkingStart" },
        { type: "thinkingDelta", delta: "先看要改哪几处：" },
    ]);
    await page.sleep(300);
    console.log("\n第三幕·正在想（标签该转圈，提示框里是已经想到的那半句）：\n  " + await dump(page));
    await hoverTag(page, "think");
    await page.sleep(500);
    const runningTip = await tipText(page);
    console.log("  提示框：" + runningTip);
    await page.shot("think-running-tip.png");
    await leaveTag(page, "think");
    await page.sleep(250);
    if (!(await dump(page)).includes("[think 转圈]")) { problems.push("正在想的时候 think 标签没转圈"); }
    if (!runningTip.includes("先看要改哪几处")) { problems.push("正在想的时候提示框里没跟着长出来"); }

    await post(page, [
        { type: "thinkingFull", text: "先看要改哪几处：chat.js 里加条目、后端把整段发过来。" },
        { type: "tool", toolName: "bash", args: { command: "npm run compile" } },
        { type: "tool", toolName: "read", args: { path: "media/chat.js" } },
        { type: "thinkingStart" },
        { type: "thinkingDelta", delta: "编译过了，再确认一下提示框。" },
        { type: "thinkingFull", text: "编译过了，再确认一下提示框。" },
    ]);
    await page.sleep(400);
    const merged = await dump(page);
    console.log("\n第三幕（同一批里想两段 + 两个工具：思考带次数「2」，跟工具同一条行）：\n  " + merged);
    await hoverTag(page, "think");
    await page.sleep(500);
    const mergedTip = await tipText(page);
    console.log("  提示框（两段思考都该列出来）：" + mergedTip);
    await page.shot("think-merged-tip.png");
    await leaveTag(page, "think");
    await page.sleep(250);
    if (!merged.includes("工具行：[think2][bash][read]")) { problems.push("同批两段思考没收成一个带次数 2 的标签，或没跟工具排在同一条行里"); }
    if (!mergedTip.includes("先看要改哪几处") || !mergedTip.includes("编译过了")) { problems.push("合并标签的提示框里没把两段思考都列出来"); }

    // ---- 第四幕：正文之后又来一段思考（只来一条全文，没有开始事件）→ 先在末尾出一颗；
    //      这一轮还没完，不急着并（后面可能还有东西） ----
    await post(page, [
        { type: "assistantFull", text: "接着往下：" },
        { type: "thinkingFull", text: "这一段是正文完了才补来的思考。" },
    ]);
    await page.sleep(400);
    const second = await dump(page);
    console.log("\n第四幕（正文之后补来一段思考：先在末尾出一颗）：\n  " + second);
    await page.shot("think-after-text.png");
    if (!second.includes("工具行：[think2][bash][read]")) { problems.push("第四幕本段那颗 think 不见了（该还是 think2，末尾那颗还没并）"); }
    if (!/\| 工具行：\[think\]$/.test(second)) { problems.push("第四幕正文之后补来的那段思考没在末尾出一颗"); }

    // ---- 第五幕：这一轮跑完（streamEnd）→ 末尾那颗并回本段那颗（末尾不留东西），
    //      次数接上、提示框里三段思考都列着 ----
    await post(page, [{ type: "streamEnd", activity: "idle" }]);
    await page.sleep(400);
    const folded = await dump(page);
    console.log("\n第五幕（跑完一轮：末尾那颗并回本段那颗）：\n  " + folded);
    await page.shot("think-tail-folded.png");
    if (!folded.includes("工具行：[think3][bash][read]")) { problems.push("末尾那颗没并回本段那颗（该收成 think3）"); }
    if (/工具行：\[think\]/.test(folded)) { problems.push("跑完一轮了，末尾还孤零零挂着一颗 think"); }
    await hoverTag(page, "think");
    await page.sleep(500);
    const foldedTip = await tipText(page);
    console.log("  提示框：" + foldedTip);
    await page.shot("think-tail-folded-tip.png");
    await leaveTag(page, "think");
    await page.sleep(250);
    if (!foldedTip.includes("先看要改哪几处") || !foldedTip.includes("编译过了") || !foldedTip.includes("补来的思考")) {
        problems.push("并回去之后，提示框里没把三段思考都列出来");
    }

    // ---- 第六幕：正文之后来一段思考、后面还跟着工具 → 这一颗留在原位（位置本身就是信息）；
    //      这时的 streamEnd 也不该动它 ----
    await post(page, [
        { type: "assistantFull", text: "再看一处：" },
        { type: "thinkingFull", text: "想一下要不要动这里。" },
        { type: "tool", toolName: "bash", args: { command: "ls" } },
    ]);
    await page.sleep(400);
    await post(page, [{ type: "streamEnd", activity: "idle" }]);
    await page.sleep(400);
    const kept = await dump(page);
    console.log("\n第六幕（后面还有工具：这一颗留在原位）：\n  " + kept);
    await page.shot("think-before-tool.png");
    if (!/\| 工具行：\[think\]\[bash\]$/.test(kept)) { problems.push("后面还有工具的那颗思考没留在原位（该是 [think][bash] 这一行）"); }

    // ---- 第七幕：来了用户消息（新的一段）→ 下一段思考重新开一颗，不并到上一段 ----
    await post(page, [
        { type: "userMessage", text: "接着改下一处" },
        { type: "thinkingFull", text: "新的一段：先看现在是哪一版。" },
    ]);
    await page.sleep(400);
    const third = await dump(page);
    console.log("\n第七幕（新的一段另开一颗）：\n  " + third);
    await page.shot("think-next-segment.png");
    if (!/\| 工具行：\[think\]$/.test(third)) { problems.push("换段之后没另开一颗 think"); }
    if (!third.includes("工具行：[think][bash]")) { problems.push("换段把上一段那颗（后面跟着工具的那颗）也动了"); }

    // ---- 第八幕：整屏重画收尾（重连 / 刷新）会补一份会话列表；末尾那颗也靠这一步并回去 ----
    const sid = await page.eval(`return document.querySelector(".session-view:not(.off) .session-pane").dataset.sessionId;`);
    await post(page, [
        { type: "assistantFull", text: "重画前那段：" },
        { type: "thinkingFull", text: "重画收尾时该并回上一段那颗。" },
    ]);
    await page.sleep(300);
    await post(page, [{ type: "sessionList", sessions: [{ id: sid, name: "假标题：随便说点什么", streaming: false, activity: "idle", piReady: true, loading: false }] }]);
    await page.sleep(400);
    const afterList = await dump(page);
    console.log("\n第八幕（会话列表到、收尾一算：末尾那颗并回上一段那颗）：\n  " + afterList);
    await page.shot("think-after-resync.png");
    if (/工具行：\[think\](?: \| |$)/.test(afterList)) { problems.push("重画收尾之后末尾还留着一颗孤零零的 think"); }
    if (!afterList.includes("工具行：[think2]")) { problems.push("重画收尾没把末尾那颗并回上一段那颗（该收成 think2）"); }

    // ---- 第九幕：开头先宣布「要开始想了」（一个字都还没有）+ 正文 + 收尾时才把整段思考送来：
    //      同一段思考不能拆成两颗（上面一颗空的 + 末尾一颗有字的） ----
    await post(page, [{ type: "clear", keepDraft: true }]);
    await post(page, [
        { type: "userMessage", text: "再试一次" },
        { type: "streamStart", activity: "working" },
        { type: "activityChanged", activity: "thinking" },
        { type: "thinkingStart" },
        { type: "activityChanged", activity: "working" },   // 正文一开始，那颗空标签就停住了
        { type: "assistantDelta", delta: "先把这局的观察说清楚。" },
        { type: "thinkingFull", text: "整段思考是收尾那一刻才送来的。" },
        { type: "streamEnd", activity: "idle" },
    ]);
    await page.sleep(400);
    const late = await dump(page);
    console.log("\n第九幕（收尾才送来整段思考：并回上面那颗空的）：\n  " + late);
    await page.shot("think-late-whole.png");
    if (/工具行：\[think\]$/.test(late)) { problems.push("第九幕末尾还留着一颗孤零零的 think"); }
    if (!/工具行：\[think\] \| 正文：先把这局的观察说清楚/.test(late)) { problems.push("第九幕那段思考没并回上面那颗、排到正文前面去"); }
    await hoverTag(page, "think");
    await page.sleep(500);
    const lateTip = await tipText(page);
    console.log("  提示框：" + lateTip);
    await page.shot("think-late-whole-tip.png");
    await leaveTag(page, "think");
    await page.sleep(250);
    if (!lateTip.includes("整段思考是收尾那一刻才送来的")) { problems.push("第九幕并回去之后，提示框里没看到那段思考的全文"); }

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

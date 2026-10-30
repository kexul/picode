// @ts-nocheck
/**
 * coreCommand —— 验「正在跑的那一条」只写一长串命令里的核心那一段。
 *
 * 模型爱写一长串：cd 到某个目录 && 跑个脚本 | sed 看头几行。整条摆在那一行上，人一眼看不出在干什么
 * （一行放不下还得横着滚半天）。现在按字面把命令切成几段，只写「正经干活」的那段，后面灰一句「+N 段」，
 * 整条留在这一行的悬浮提示里（跟工具标签用的同一套提示框，见 chat.js 的 runningLineText）。
 * 一次验这几件事：
 *   · cd 到某个目录 && 跑脚本 | sed 看输出 → 只写脚本那条，后面「+2 段」；
 *   · npm test 2>&1 | tail -30 → 2>&1 不算分隔符，只写「npm test 2>&1」，「+1 段」；
 *   · 一段正经活都没有（cd + echo）→ 照原样整条写，不写「+N 段」；
 *   · 只有一段（git status --short）→ 照原样；
 *   · 两段都在干活（npm run build && npm test）→ 写头一段，「+1 段」；
 *   · for 循环那句 → 不拿「for f in …」当核心，写循环体里那句（「do」那层剥掉）；
 *   · 悬浮这一行 → 提示框里是整条命令（一个字不少）；
 *   · 「+N 段」那一句不跟着字横向滚（放不下的字自己滚，它不动）；
 *   · 不是 bash 的调用（read / grep）照旧整条写，不写「+N 段」。
 *
 *   npm run web:shot -- --width 1000 --height 620 --script dev/coreCommand.js
 * 图落在 dev/shots/。
 */

/** 投进去的 bash 命令，以及这一行该写出来的字（main）与后面那句灰字（more）。 */
const CASES = [
    {
        cmd: "cd /d/projects/picode/dev && python run_checks.py --all 2>&1 | sed -n '1,40p'",
        main: "$ python run_checks.py --all 2>&1",
        more: "+2 段",
        why: "cd 挪位置、sed 只看头几行，核心是跑脚本那条",
    },
    { cmd: "npm test 2>&1 | tail -30", main: "$ npm test 2>&1", more: "+1 段", why: "2>&1 不是分隔符；tail 是收尾巴" },
    { cmd: "cd /tmp && echo 开始", main: "$ cd /tmp && echo 开始", more: "", why: "一段正经活都没有：照原样整条写" },
    { cmd: "git status --short", main: "$ git status --short", more: "", why: "只有一段：照原样" },
    { cmd: "npm run build && npm test", main: "$ npm run build", more: "+1 段", why: "两段都在干活：写头一段" },
    { cmd: 'for f in a.py b.py; do python "$f"; done', main: '$ python "$f"', more: "+2 段", why: "别拿 for 那截当核心，写循环体里那句" },
    { cmd: "ls -la | head -5", main: "$ ls -la", more: "+1 段", why: "管道后面修输出的不算事" },
];

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];

    const post = (messages) => page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
    /** 把真鼠标挪到某个地方（CSS 的 :hover 只认真鼠标，dispatchEvent 糊弄不了它）。 */
    const move = (x, y) => page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y), button: "none" });
    /** 这一行现在写着什么。 */
    const state = () => page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        const item = pane ? pane.querySelector(".tool-running .tool-running-item") : null;
        if (!item) { return null; }
        const t = item.querySelector(".tr-text");
        const more = item.querySelector(".tr-more");
        return {
            text: t ? t.textContent.trim() : "",
            more: more ? more.textContent.trim() : "",
            roll: t ? t.classList.contains("roll") : false,
        };
    `);
    const show = (s) => (s ? JSON.stringify([s.text, s.more, s.roll ? "自己在滚" : "不滚"]) : "（没有这一行）");

    // ---- 一幕一条：投一条 bash 调用，看这一行写什么 ----
    let seq = 0;
    for (const c of CASES) {
        seq++;
        const id = "cmd" + seq;
        // 前面垫一段正文：上一批工具到此为止，这一条单独算一批
        await post([
            { type: "assistantFull", text: "第 " + seq + " 条：" + c.why + "。" },
            { type: "tool", toolName: "bash", args: { command: c.cmd }, toolCallId: id },
        ]);
        await page.sleep(220);
        const s = await state();
        console.log("\n第 " + seq + " 幕（" + c.why + "）\n   投进去：" + JSON.stringify(c.cmd) + "\n   这一行：" + show(s));
        if (!s) { problems.push("这一行没出现：" + JSON.stringify(c.cmd)); continue; }
        if (s.text !== c.main) { problems.push("核心那段挑得不对：该写 " + JSON.stringify(c.main) + "，写成了 " + JSON.stringify(s.text)); }
        if (s.more !== c.more) { problems.push("后面那句「+N 段」不对：该是 " + JSON.stringify(c.more) + "，写成了 " + JSON.stringify(s.more)); }

        // ---- 第一幕：悬浮这一行 → 提示框里是整条命令（一个字不少）----
        if (seq === 1) {
            const at = await page.eval(`
                const item = document.querySelector(".session-view:not(.off) .session-pane .tool-running .tool-running-item");
                if (!item) { return null; }
                const r = item.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            `);
            if (at) {
                await move(at.x, at.y);
                await page.sleep(500);
                const tip = await page.eval(`
                    const el = document.querySelector(".tag-tip");
                    if (!el || el.classList.contains("hidden")) { return null; }
                    return el.textContent;
                `);
                console.log("   悬浮这一行：提示框里写的是 " + JSON.stringify(tip));
                if (!tip) { problems.push("悬浮这一行没出提示框（整条命令就没地方看了）"); }
                else if (!tip.includes(c.cmd)) { problems.push("提示框里不是整条命令：" + JSON.stringify(tip)); }
                await page.shot("core-command-tip.png");
                await move(6, 6);   // 鼠标挪开，别挡着后面的截图
                await page.sleep(300);
            }
        }

        await post([{ type: "toolResult", toolCallId: id, isError: false, resultText: "好了", durationMs: 120 }]);
        await page.sleep(80);
    }

    // ---- 「+N 段」那一句不跟着字横向滚 ----
    // 一条故意写得超长的（放不下就得滚）：滚起来是 .tr-text 里套一层 .tr-run，
    // 「+N 段」得在外面（跟着滚的话它一会儿就滚没了）。
    await post([
        { type: "assistantFull", text: "再投一条长得放不下的。" },
        {
            type: "tool", toolName: "bash", toolCallId: "cmd-long",
            args: { command: "cd /d/projects/picode && python dev/some_really_long_script_name_that_keeps_going_for_quite_a_while.py --with-a-lot-of-arguments --and-even-more-of-them --and-then-some 2>&1 | tail -40" },
        },
    ]);
    await page.sleep(300);
    const rolled = await page.eval(`
        const item = document.querySelector(".session-view:not(.off) .session-pane .tool-running .tool-running-item");
        if (!item) { return null; }
        const t = item.querySelector(".tr-text");
        const more = item.querySelector(".tr-more");
        const run = t ? t.querySelector(".tr-run") : null;
        return {
            roll: t ? t.classList.contains("roll") : false,
            inRun: Boolean(run) && Boolean(more) && run.contains(more),
            text: t ? t.textContent.trim() : "",
            more: more ? more.textContent.trim() : "",
        };
    `);
    console.log("\n放不下的那条：" + JSON.stringify(rolled));
    if (!rolled) { problems.push("长命令那一行没了"); }
    else {
        if (!rolled.roll) { problems.push("这么长的命令该自己横向滚（这一行没滚）：" + JSON.stringify(rolled)); }
        if (rolled.inRun) { problems.push("「+N 段」跟着字一起滚了（该钉在外面一直看得见）"); }
    }
    await page.shot("core-command.png");

    // ---- 不是 bash 的调用照旧整条写 ----
    await post([
        { type: "assistantFull", text: "换成不是命令的调用。" },
        { type: "tool", toolName: "read", args: { path: "media/chat.js" }, toolCallId: "cmd-read" },
    ]);
    await page.sleep(250);
    const s2 = await state();
    console.log("\n不是 bash 的一条：\n   这一行：" + show(s2));
    if (!s2 || s2.text !== "read media/chat.js" || s2.more) { problems.push("不是 bash 的调用被乱切了：" + JSON.stringify(s2)); }

    if (problems.length) {
        console.log("\n有问题：\n  - " + problems.join("\n  - "));
        throw new Error("coreCommand 验出 " + problems.length + " 处不对");
    }
    console.log("\n都对。");
};

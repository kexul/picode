// @ts-nocheck
/**
 * runningLine —— 验消息流末尾那条「正在跑」的（贴在当前这批工具标签下面）。
 *
 * 工具标签只说得出工具名（命令行、读哪个文件、grep 找什么都在提示框里）；这一条把摘要直接写出来。
 * 真让模型按剧本一条条工具这么跑不好凑，这里直接往页面里投工具调用消息（跟后端推的是同一种消息）。
 * 跑完的那条不走：字留着，只是冻住（齿轮停转、耗时定在跑完那一刻），新的命令来了原地顶掉它；
 * 整条在这一批过去（下面出正文 / 问话卡片、或者这一轮跑完）时才会收。一次验这几件事：
 *   · 在跑的调用 → 标签下面一条「$ 命令」（read 是「read 哪个文件」、edit 是「edit 哪个文件」）；
 *   · 同时跑两条 → 一条一行，顺序跟着标签走；先跑完的那条立刻少一条，只留最后跑完的那条冻着；
 *   · 一条都不在跑 → 字不走，齿轮停转、耗时定住（长命令照旧自己滚），位置也不动；
 *   · 一串 60 毫秒跑完的调用连着来 → 这条只出现一次、一次没被摘掉，只是换名字，下面一次都不跳；
 *   · think（思考）与 ask_choice（问话卡片）不出这条；
 *   · 跑着的时候又来了正文 → 这条仍在它那批标签下面；之后又开了一批标签 → 跟着挪到新那批下面。
 *   · 整屏重画（刷新页面 / 重连后重放历史）：历史里那条还没结果的调用重放出来后，这条也在（只一条）。
 *   · 一行放不下的字自己横向滚、只往一个方向（跑马灯，不回程）：滚的距离够看到末尾、
 *     快慢按每秒 30 像素算，两端各停半秒（固定时间，不随命令长短变；按一趟的百分比算的话
 *     一千字的命令开头要死六秒多，看着就是没动），
 *     放得下的那条一动不动；系统里开了「减少动态效果」也照旧慢慢滚（停下来就只剩截断，
 *     后面那半条命令看不全）。
 *   · 每条末尾钉一个耗时（跑了多久）：数字自己往上走、钉在这一条的右端，字滚它不滚；
 *     冻住之后这个数字不再变；重放出来的老调用不知道什么时候开始的，不写耗时。
 *
 *   npm run web:shot -- --width 900 --height 620 --script dev/runningLine.js
 * 图落在 dev/shots/。
 */

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];

    /** 这条「正在跑」的现状：一条条写着什么、几条在转圈、几条冻住、贴在谁下面、是不是消息流末尾。
     *  跑完的那条不走、只是冻住（齿轮停转，见 chat.js 的 freezeRunningLine）：所以「写着几条」
     *  跟「几条在转圈」是两回事 —— 在跑的 spin=1，冻住的 frozen=1 且 spin=0。 */
    const state = () => page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        const line = pane ? pane.querySelector(".tool-running") : null;
        const items = line ? Array.from(line.querySelectorAll(".tool-running-item")) : [];
        const spinning = (el) => {
            const g = el.querySelector(".tool-icon");
            return Boolean(g) && getComputedStyle(g).animationName !== "none";
        };
        const prev = line ? line.previousElementSibling : null;
        const next = line ? line.nextElementSibling : null;
        return {
            hasNode: Boolean(line),
            items: items.map((el) => { const t = el.querySelector(".tr-text"); return (t || el).textContent.trim(); }),
            times: items.map((el) => { const t = el.querySelector(".tr-time"); return t ? t.textContent.trim() : ""; }),
            spin: items.filter(spinning).length,
            frozen: items.filter((el) => el.classList.contains("done")).length,
            afterRow: Boolean(prev) && prev.classList.contains("tool-row"),
            afterText: Boolean(prev) && prev.classList.contains("assistant"),
            // 末尾那一行是一个盒子（装「继续 / 卡住了」和停止生成），不是单个胶囊了
            beforeEndHint: Boolean(next) && (next.classList.contains("end-hint-row") || next.classList.contains("msg-endhint")),
            lastName: Boolean(line) && pane.lastElementChild === line,
        };
    `);
    const post = (messages) => page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
    const show = (s) => "盒子还在=" + s.hasNode + " items=" + JSON.stringify(s.items)
        + (s.times && s.times.some(Boolean) ? " 耗时=" + JSON.stringify(s.times) : "") + " 转圈=" + s.spin
        + (s.frozen ? " 冻住=" + s.frozen : "")
        + " 贴工具行下面=" + s.afterRow + " 贴正文下面=" + s.afterText + " 在末尾胶囊前面=" + s.beforeEndHint;

    // ---- 第一幕：一条还在跑（带部分结果）→ 标签下面写出它的命令 ----
    await post([
        { type: "assistantFull", text: "先把要动的地方看一遍：" },
        { type: "tool", toolName: "bash", args: { command: "npm run compile" }, toolCallId: "a1" },
        { type: "toolResultUpdate", toolCallId: "a1", resultText: "正在编译…", durationMs: 400 },
    ]);
    await page.sleep(300);
    let s = await state();
    console.log("第一幕（一条 bash 还在跑）：\n  " + show(s));
    if (JSON.stringify(s.items) !== JSON.stringify(["$ npm run compile"])) { problems.push("在跑的那条 bash 没把命令行写出来：" + JSON.stringify(s.items)); }
    if (!s.afterRow) { problems.push("这条没贴在工具标签下面"); }
    if (s.spin !== 1) { problems.push("这条里的齿轮没转圈"); }
    // 这一批是“投进页面的老消息”（跟重放历史一个待遇）：开始时刻不知道，不该写耗时
    if (s.times && s.times.some(Boolean)) { problems.push("来历不明的调用也写上了耗时（该不写）：" + JSON.stringify(s.times)); }
    // 工具标签（上面那排）的齿轮不转：这一排是“跑过哪些调用”的记账，转的只有下面这条
    const pillSpin = await page.eval(`
        const el = document.querySelector(".session-view:not(.off) .session-pane .tool-row .tool.running .tool-icon");
        return el ? getComputedStyle(el).animationName : "（没有那颗齿轮）";
    `);
    console.log("   工具标签里那颗齿轮的动画：" + pillSpin);
    if (pillSpin !== "none") { problems.push("工具标签里的齿轮不该转：" + pillSpin); }

    // ---- 第二幕：同时跑两条（bash + read）→ 也只露一条：最近开始的那条（后来的 read）----
    const lineH = () => page.eval(`
        const el = document.querySelector(".session-view:not(.off) .session-pane .tool-running");
        return el ? el.offsetHeight : 0;
    `);
    await post([
        { type: "tool", toolName: "read", args: { path: "media/chat.js" }, toolCallId: "a2" },
    ]);
    await page.sleep(200);
    s = await state();
    console.log("\n第二幕（又一条 read 在跑，两条同时）：\n  " + show(s));
    if (JSON.stringify(s.items) !== JSON.stringify(["read media/chat.js"])) { problems.push("同时跑两条时该只露最近开始的那条（read）：" + JSON.stringify(s.items)); }
    if (s.items.length !== 1) { problems.push("同时跑两条时这一块该只有一条：" + JSON.stringify(s.items)); }
    const hTwo = await lineH();
    // 齿轮要对齐：这条里的齿轮跟上面那排标签里的齿轮得在同一条竖线上。
    // 量的是中心（齿轮在转，转着的盒子四周会变，只有中心不动）。
    const gears = await page.eval(`
        const pill = document.querySelector(".session-view:not(.off) .session-pane .tool-row .tool .tool-icon");
        const item = document.querySelector(".session-view:not(.off) .session-pane .tool-running .tool-running-item .tool-icon");
        if (!pill || !item) { return null; }
        const mid = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
        return { dx: Math.round((mid(item) - mid(pill)) * 100) / 100 };
    `);
    console.log("   齿轮对位（这条跟上面标签里那颗比，同一竖线上就是 0）：dx=" + (gears && gears.dx));
    if (!gears || Math.abs(gears.dx) > 0.5) { problems.push("这条里的齿轮没跟上面标签里那颗对齐：" + JSON.stringify(gears)); }

    // ---- 第三幕：read 回来了 → 这一行原地换回还在跑的 bash，高矮一点没变 ----
    await post([{ type: "toolResult", toolCallId: "a2", isError: false, resultText: "…（40 行）", durationMs: 60 }]);
    await page.sleep(200);
    s = await state();
    console.log("\n第三幕（read 跑完，bash 还在跑）：\n  " + show(s));
    if (JSON.stringify(s.items) !== JSON.stringify(["$ npm run compile"])) { problems.push("read 跑完该换回还在跑的 bash：" + JSON.stringify(s.items)); }
    if (s.spin !== 1 || s.frozen !== 0) { problems.push("还有一条在跑（该是它转着、没有冻住的）：" + show(s)); }
    const hOne = await lineH();
    console.log("   这一块的高矮：两条同时 " + hTwo + "px → 一条跑完 " + hOne + "px");
    if (hOne !== hTwo) { problems.push("一条跑完时这一块变高 / 变矮了（下面的内容会跟着跳一下）：" + hTwo + " → " + hOne); }

    // ---- 第四幕：跑着的时候又来了一段正文 → 这条仍贴在它那批标签下面（正文排在它后面）----
    await post([{ type: "assistantFull", text: "顺手把上面那条结果也说一句。" }]);
    await page.sleep(300);
    s = await state();
    console.log("\n第四幕（bash 还在跑，中间来了一段正文）：\n  " + show(s));
    if (!s.afterRow) { problems.push("来了正文之后，这条没留在它那批标签下面：" + JSON.stringify(s)); }
    const textAfter = await page.eval(`
        const line = document.querySelector(".session-view:not(.off) .session-pane .tool-running");
        const next = line ? line.nextElementSibling : null;
        return Boolean(next) && next.classList.contains("assistant");
    `);
    if (!textAfter) { problems.push("正文没排在这条后面（它该跟住它那批标签）：" + JSON.stringify(s)); }

    // ---- 第五幕：正文之后又开了一批标签 → 这条挪到新那批下面 ----
    await post([{ type: "tool", toolName: "grep", args: { pattern: "tool-running", path: "media" }, toolCallId: "a3" }]);
    await page.sleep(200);
    s = await state();
    console.log("\n第五幕（正文之后又是一批工具调用）：\n  " + show(s));
    if (!s.afterRow || !s.beforeEndHint) { problems.push("新一批标签上来之后，这条没挪到它下面：" + JSON.stringify(s)); }
    if (JSON.stringify(s.items) !== JSON.stringify(["grep /tool-running/ in media"])) { problems.push("新一批里的那条没换上来（还是只露一条）：" + JSON.stringify(s.items)); }
    await page.shot("running-line.png");

    // ---- 第六幕：think 与 ask_choice 都不出这条 ----
    await post([
        { type: "toolResult", toolCallId: "a1", isError: false, resultText: "编译完成", durationMs: 3200 },
        { type: "toolResult", toolCallId: "a3", isError: false, resultText: "media/chat.css:212", durationMs: 200 },
        { type: "thinkingStart" },
        { type: "tool", toolName: "ask_choice", args: { question: "选一个", options: ["甲", "乙"] }, toolCallId: "a4" },
    ]);
    await page.sleep(500);
    s = await state();
    console.log("\n第六幕（think 与 ask_choice 都在转圈，别的都跑完了）：\n  " + show(s));
    // 别的都跑完了：最后跑完的那条（grep）冻着，think / ask_choice 不往这条里写
    if (JSON.stringify(s.items) !== JSON.stringify(["grep /tool-running/ in media"])) { problems.push("跑完的那条没冻着留着，或者 think / ask_choice 也写进来了：" + JSON.stringify(s.items)); }
    if (s.frozen !== 1 || s.spin !== 0) { problems.push("冻住的该是齿轮停转的那一条（转圈的不该还有）：" + show(s)); }
    if (!s.hasNode) { problems.push("这一批还没过去（下面没出别的东西），这条就先没了：" + JSON.stringify(s)); }

    // ---- 第七幕：write / edit 在跑 → 也写出来（改的是哪个文件）----
    await post([
        { type: "toolResult", toolCallId: "a4", isError: false, resultText: "选了「甲」", durationMs: 2000 },
        { type: "editCardStart", toolCallId: "a5", toolName: "edit", path: "media/chat.css", label: "media/chat.css", args: { path: "media/chat.css", oldText: "a", newText: "b" } },
    ]);
    await page.sleep(300);
    s = await state();
    console.log("\n第七幕（一条 edit 在跑）：\n  " + show(s));
    if (JSON.stringify(s.items) !== JSON.stringify(["edit media/chat.css"])) { problems.push("在跑的 edit 没写出来：" + JSON.stringify(s.items)); }
    await page.shot("running-line-edit.png");

    // ---- 第八幕：还在跑的那条结果带图（read 读图）→ 它从这条里也摘掉；字留着不动，位置也留到这一批过去 ----
    await post([{ type: "editCardResult", toolCallId: "a5", diff: "", canRevert: false }]);
    await post([
        { type: "tool", toolName: "read", args: { path: "示例图片.png" }, toolCallId: "a6" },
        {
            type: "toolResult", toolCallId: "a6", isError: false, durationMs: 60,
            resultText: "Read image file [image/png]",
            images: [{ data: require("fs").readFileSync(require("path").join(__dirname, ".scratch", "示例图片.png")).toString("base64").slice(0, 4), mimeType: "image/png" }],
        },
    ]);
    await page.sleep(400);   // 过了不止一段时间：字不该淡、不该不见
    s = await state();
    console.log("\n第八幕（读图那条结果回来、铺成一整块图）：\n   跑完 400 毫秒后：" + show(s));
    if (JSON.stringify(s.items) !== JSON.stringify(["read 示例图片.png"])) { problems.push("一条都不在跑了之后，这条上的字不见了（该留着）：" + JSON.stringify(s.items)); }
    if (s.frozen !== 1 || s.spin !== 0) { problems.push("跑完了齿轮还在转（该停住）：" + show(s)); }
    const look = await page.eval(`
        const el = document.querySelector(".session-view:not(.off) .session-pane .tool-running .tool-running-item");
        if (!el) { return null; }
        const cs = getComputedStyle(el);
        return { opacity: Math.round(Number(cs.opacity) * 100) / 100, h: el.offsetHeight, visibility: cs.visibility };
    `);
    console.log("   看起来：透明到 " + (look && look.opacity) + "、这条还高 " + (look && look.h) + "px、visibility=" + (look && look.visibility));
    if (!look || look.visibility === "hidden" || look.opacity <= 0) { problems.push("留着的字被藏起来了（该照旧露着）：" + JSON.stringify(look)); }
    if (!look || look.h <= 0) { problems.push("这条不占位置了（下面要跟着跳）：" + JSON.stringify(look)); }
    // 下面出正文（这一批工具过去了）→ 连位置一起收掉
    await post([{ type: "assistantFull", text: "这张图看完了。" }]);
    await page.sleep(200);
    s = await state();
    console.log("   下面出了正文：" + show(s));
    if (s.hasNode) { problems.push("下面出了正文（这一批过去了），这条还留着：" + JSON.stringify(s)); }

    // ---- 第九幕：整屏重画（刷新页面 / 重连时重放历史）→ 历史里那条还没结果的调用重放出来后，这条也在 ----
    await post([{ type: "clear", keepDraft: true }]);
    await post([
        { type: "assistantFull", text: "重放：这句话之前调过一次 bash。" },
        { type: "tool", toolName: "bash", args: { command: "npm test" }, toolCallId: "b1" },
        { type: "tool", toolName: "bash", args: { command: "git status" }, toolCallId: "b2" },
        { type: "toolResult", toolCallId: "b1", isError: false, resultText: "53 个测试都过了", durationMs: 900 },
    ]);
    await page.sleep(400);
    s = await state();
    const lines = await page.eval(`return document.querySelectorAll(".session-view:not(.off) .session-pane .tool-running").length;`);
    console.log("\n第九幕（整屏重画，历史里还留着一条没结果的 bash）：\n  " + show(s) + " 这行的个数=" + lines);
    if (JSON.stringify(s.items) !== JSON.stringify(["$ git status"])) { problems.push("重放之后这条没跟上（该只剩那条没结果的）：" + JSON.stringify(s.items)); }
    if (lines !== 1) { problems.push("重放之后这条出现了不止一个（该只有一个）：" + lines); }
    // 这一条也收尾，免得它跟着进下一幕
    await post([{ type: "toolResult", toolCallId: "b2", isError: false, resultText: "", durationMs: 900 }]);
    await page.sleep(100);

    // ---- 第十幕：一串很快跑完的调用不该让这条一闪一闪 ----
    // 连着读几个文件（每条 60 毫秒跑完、紧接着下一条）就是这样：这条该只出现一次、一直写着，
    // 只是换个文件名；位置一次都不动，下面不跟着上下跳。
    // 怎么量「下面动不动」：先把消息流撑长到能滚，再盯着滚动高度 —— 跳一次它就变一次。
    await post([{ type: "assistantFull", text: Array.from({ length: 80 }, (_, i) => "第 " + i + " 行，用来把消息流撑长一点。").join("\n\n") }]);
    await page.sleep(300);
    await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        window.__flick = { add: 0, remove: 0, h: [] };
        const note = () => window.__flick.h.push(pane.scrollHeight);
        new MutationObserver((records) => {
            for (const r of records) {
                for (const n of r.addedNodes) { if (n.nodeType === 1 && n.classList.contains("tool-running")) { window.__flick.add++; } }
                for (const n of r.removedNodes) { if (n.nodeType === 1 && n.classList.contains("tool-running")) { window.__flick.remove++; } }
            }
            note();
        }).observe(pane, { childList: true, subtree: true });
        return true;
    `);
    const written = [];
    for (let i = 0; i < 6; i++) {
        await post([{ type: "tool", toolName: "read", args: { path: "文件" + i + ".ts" }, toolCallId: "f" + i }]);
        await page.sleep(60);
        await post([{ type: "toolResult", toolCallId: "f" + i, isError: false, resultText: "…", durationMs: 60 }]);
        await page.sleep(20);
        written.push((await state()).items.join(" | "));
    }
    const flick = await page.eval("return window.__flick;");
    const moves = flick.h.filter((h, i) => i === 0 || h !== flick.h[i - 1]).length - 1;
    console.log("\n第十幕（连着 6 条快调用，每条 60 毫秒跑完）：");
    console.log("   这条被挂上页面 " + flick.add + " 次、被摘掉 " + flick.remove + " 次；滚动高度变了 " + moves + " 次");
    console.log("   每一步写着：" + JSON.stringify(written));
    if (flick.add !== 1 || flick.remove !== 0) { problems.push("一串快调用把这条挂上 / 摘下了好几回（一闪一闪）：挂上 " + flick.add + " 次、摘下 " + flick.remove + " 次"); }
    if (moves !== 0) { problems.push("一串快调用让下面的内容上下跳了 " + moves + " 次（位置该一直不动）：滚动高度出现过 " + JSON.stringify(Array.from(new Set(flick.h))) + "）"); }
    const wantWritten = ["read 文件0.ts", "read 文件1.ts", "read 文件2.ts", "read 文件3.ts", "read 文件4.ts", "read 文件5.ts"];
    if (JSON.stringify(written) !== JSON.stringify(wantWritten)) { problems.push("这条没跟着一条条换名字（该一直写着当前那条）：" + JSON.stringify(written)); }
    await page.shot("running-line-burst.png");

    // ---- 第十一幕：这一轮跑完（streamEnd）→ 整条连位置一并收掉 ----
    await page.sleep(400);
    s = await state();
    console.log("\n第十一幕（快调用跑完、这轮还没结束）：\n  " + show(s));
    if (JSON.stringify(s.items) !== JSON.stringify(["read 文件5.ts"])) { problems.push("最后跑完的那条没冻着留着：" + JSON.stringify(s.items)); }
    if (s.frozen !== 1 || s.spin !== 0) { problems.push("最后跑完的那条该冻住（齿轮停转）：" + show(s)); }
    await page.shot("running-line-frozen.png");
    await post([{ type: "streamEnd" }]);
    await page.sleep(200);
    s = await state();
    console.log("   这一轮跑完（streamEnd）：" + show(s));
    if (s.hasNode) { problems.push("这一轮跑完了，这条的位置还留着：" + JSON.stringify(s)); }

    // ---- 第十二幕：一行放不下的字自己横向滚，只往一个方向；放得下的那条一动不动 ----
    // 同时跑几条也只露一条，所以分三步看：先投长命令（该滚）→ 又来一条短的（换成它、不动、
    // 这一块还是那么高）→ 短的那条跑完（换回长的那条，照旧滚）。
    const LONG_CMD = "git log --oneline --all --graph --decorate --date=short --pretty=format:'%h %ad %an %s' -- media src | head -200 && npm run compile && npm run web:shot -- --width 900 --height 700";
    const rolls = () => page.eval(`
        const items = Array.from(document.querySelectorAll(".session-view:not(.off) .session-pane .tool-running .tool-running-item"));
        return items.map((el) => {
            const t = el.querySelector(".tr-text");
            const run = el.querySelector(".tr-run");
            const box = t.getBoundingClientRect();
            const cs = run ? getComputedStyle(run) : null;
            return {
                text: (run || t).textContent,
                roll: t.classList.contains("roll"),
                anim: cs ? cs.animationName : "none",
                dir: cs ? cs.animationDirection : "-",
                left: run ? Math.round(run.getBoundingClientRect().left - box.left) : 0,
                shift: parseFloat(t.style.getPropertyValue("--tr-shift")) || 0,
                dur: parseFloat(t.style.getPropertyValue("--tr-dur")) || 0,
                over: t.scrollWidth - t.clientWidth,
                h: el.offsetHeight,
            };
        });
    `);
    await post([
        { type: "assistantFull", text: "这一条命令很长。" },
        { type: "tool", toolName: "bash", args: { command: LONG_CMD }, toolCallId: "r1" },
    ]);
    await page.sleep(300);
    const rl = await rolls();
    const long = rl[0] || {};
    console.log("\n第十二幕（一行放不下的命令）：");
    console.log("   行数=" + rl.length + " 滚=" + long.roll + " 动画=" + long.anim + " 位移=" + long.shift + "px 溢出=" + long.over + "px 一趟=" + long.dur + "s");
    if (rl.length !== 1) { problems.push("这一块该只有一条：" + JSON.stringify(rl.map((x) => x.text))); }
    if (!long.roll || !/^tr-roll/.test(long.anim)) { problems.push("长命令没自己滚起来：" + JSON.stringify(long)); }
    if (long.dir !== "normal") { problems.push("滚是来回滚的（该只往一个方向）：" + long.dir); }
    // 一趟 = 走的那段（每秒 30 像素）+ 两头各停 0.5 秒
    if (Math.abs(long.dur - (Math.abs(long.shift) / 30 + 1)) > 0.05) { problems.push("一趟的时长不对（该是「走完每秒 30 像素 + 两头各停半秒」）：一趟 " + long.dur + " 秒、位移 " + long.shift + "px"); }
    // 两头的停顿是固定的半秒，不能像以前那样按一趟的百分之几算（那会让长命令开头死很久）
    const hold = await page.eval(`
        const t = document.querySelector(".session-view:not(.off) .session-pane .tool-running .tool-running-item .tr-text");
        const run = t.querySelector(".tr-run");
        const name = run ? getComputedStyle(run).animationName : "";
        let pct = null;
        for (const sheet of document.styleSheets) {
            let rules = [];
            try { rules = Array.from(sheet.cssRules); } catch { continue; }
            for (const rule of rules) {
                if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === name) {
                    // 0%、X%、(100-X)% 三格：第二格的百分比就是「两头各停多久」占一趟的多少
                    pct = parseFloat(rule.cssRules[1].keyText);
                }
            }
        }
        const dur = parseFloat(t.style.getPropertyValue("--tr-dur")) || 0;
        return { name: name, pct: pct, dur: dur, holdMs: pct === null ? null : Math.round(pct / 100 * dur * 1000) };
    `);
    console.log("   两头停：" + hold.holdMs + " 毫秒（keyframes 「" + hold.name + "」第一格 " + hold.pct + "%，一趟 " + hold.dur + " 秒）");
    if (hold.holdMs === null || Math.abs(hold.holdMs - 500) > 15) { problems.push("两头的停顿不是固定的半秒：" + JSON.stringify(hold)); }
    // 滚到底能看到末尾：把位移直接当作静态位置量一次（不然得等它慢慢滚到头）。
    const tail = await page.eval(`
        const t = document.querySelector(".session-view:not(.off) .session-pane .tool-running .tool-running-item .tr-text");
        const run = t.querySelector(".tr-run");
        if (!run) { return { ok: false, why: "没滚起来" }; }
        const box = t.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(run);
        const textW = range.getBoundingClientRect().width;
        const shift = parseFloat(t.style.getPropertyValue("--tr-shift")) || 0;
        run.style.animation = "none";
        run.style.transform = "translateX(" + shift + "px)";
        const end = run.getBoundingClientRect();
        const ok = end.right <= box.right + 1;
        run.style.animation = ""; run.style.transform = "";
        return { textW: Math.round(textW), boxW: Math.round(box.width), shift, ok };
    `);
    console.log("   滚到底：字宽 " + tail.textW + "、框 " + tail.boxW + "、位移 " + tail.shift + " → 末尾" + (tail.ok ? "整条都在框里" : "还露在框外"));
    if (!tail.ok) { problems.push("滚到底也看不到命令的末尾：" + JSON.stringify(tail)); }
    await page.sleep(2000);
    const moved = (await rolls())[0] || {};
    console.log("   2 秒后：位移 " + moved.left + "（刚才是 " + long.left + "）");
    if (!(moved.left < long.left - 20)) { problems.push("字没在动（位移该一直往左走）：" + long.left + " → " + moved.left); }
    // 只往一个方向：接着量一会儿，位移只能一直变小（有一点误差），不能倒回去（倒回去就是往右滚了）
    const steps = [];
    for (let i = 0; i < 8; i++) { await page.sleep(300); steps.push(((await rolls())[0] || {}).left); }
    const back = steps.filter((x, i) => i > 0 && x > steps[i - 1] + 1);
    console.log("   接着的 2.4 秒：位移 " + JSON.stringify(steps) + (back.length ? "（有往回走的）" : "（一直往一个方向走）"));
    if (back.length) { problems.push("字滚到头又倒回来了（该只往一个方向）：" + JSON.stringify(steps)); }
    await page.shot("running-line-roll.png");

    // 又来一条放得下的：换成它、一动不动，这一块还是那么高（高度不变，下面就不跳）
    await post([{ type: "tool", toolName: "bash", args: { command: "npm test" }, toolCallId: "r2" }]);
    await page.sleep(300);
    const shortLine = (await rolls())[0] || {};
    console.log("   又来一条放得下的（" + shortLine.text + "）：滚=" + shortLine.roll + " 动画=" + shortLine.anim + " 位移=" + shortLine.left + " 高 " + shortLine.h + "px");
    if (shortLine.text !== "$ npm test" || shortLine.roll || shortLine.anim !== "none" || shortLine.left !== 0) { problems.push("放得下的那条不该动，而且该换成它（最近开始的）：" + JSON.stringify(shortLine)); }
    if (shortLine.h !== long.h) { problems.push("换成短的那条时这一块变高了 / 变矮了：" + long.h + " → " + shortLine.h); }

    // 短的那条跑完：露回还在跑的长命令，照旧滚
    await post([{ type: "toolResult", toolCallId: "r2", isError: false, resultText: "53 个测试都过了", durationMs: 900 }]);
    await page.sleep(400);
    const backLong = (await rolls())[0] || {};
    console.log("   短的那条跑完，露回来的是：" + backLong.text + "（滚=" + backLong.roll + "）");
    if (!backLong.text || backLong.text.indexOf("$ git log") !== 0 || !backLong.roll) { problems.push("短的那条跑完之后该换回还在跑的长命令（它该照旧滚）：" + JSON.stringify(backLong)); }
    // 系统里开了「减少动态效果」：照旧慢慢滚（停下来就只剩截断，后半条命令在界面上看不全）
    await page.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.sleep(100);
    const reduced = (await rolls())[0] || {};
    await page.sleep(600);
    const reducedLater = (await rolls())[0] || {};
    await page.cdp.send("Emulation.setEmulatedMedia", { features: [] });
    console.log("   开了「减少动态效果」：动画=" + reduced.anim + " 位移 " + reduced.left + " → " + reducedLater.left);
    if (!/^tr-roll/.test(reduced.anim)) { problems.push("开了「减少动态效果」字就不滚了（该照旧慢慢滚）：" + JSON.stringify(reduced)); }
    if (!(reducedLater.left < reduced.left - 5)) { problems.push("开了「减少动态效果」字没在动：" + reduced.left + " → " + reducedLater.left); }

    // ---- 第十三幕：末尾钉一个耗时（自己往上走；字滚它不滚）----
    // 两条一起跑时露的是最近开始的那条：把长命令放后投，露着的这条既在滚、又带着耗时。
    await post([{ type: "toolResult", toolCallId: "r1", isError: false, resultText: "…", durationMs: 900 }]);
    await page.sleep(300);
    await post([
        // 这一轮开始了（真跑的时候是 streamStart 把“新消息”这个状态翻过来的，见 chat.js 的 noCountPop）：
        // 这之后的调用才记开始时刻、才有耗时
        { type: "streamStart" },
        { type: "assistantFull", text: "再跑两个慢一点的：" },
        { type: "tool", toolName: "bash", args: { command: "npm test" }, toolCallId: "k2" },
        { type: "tool", toolName: "bash", args: { command: "node scripts/长一点的命令 --flag-one --flag-two --flag-three --flag-four --flag-five --flag-six --flag-seven --flag-eight" }, toolCallId: "k1" },
    ]);
    await page.sleep(300);
    const clock = () => page.eval(`
        const line = document.querySelector(".session-view:not(.off) .session-pane .tool-running");
        const items = Array.from(document.querySelectorAll(".session-view:not(.off) .session-pane .tool-running .tool-running-item"));
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; };
        return {
            lineRight: line ? Math.round(line.getBoundingClientRect().right) : null,
            texts: items.map((el) => { const t = el.querySelector(".tr-text"); return t ? t.textContent.trim() : ""; }),
            times: items.map((el) => { const t = el.querySelector(".tr-time"); return t ? t.textContent.trim() : null; }),
            timeBox: items.map((el) => { const t = el.querySelector(".tr-time"); return t ? box(t) : null; }),
            roll: items.map((el) => { const t = el.querySelector(".tr-text"); return !!t && t.classList.contains("roll"); }),
            shift: items.map((el) => {
                const t = el.querySelector(".tr-text");
                const run = el.querySelector(".tr-run");
                if (!t) { return 0; }
                return run ? Math.round(run.getBoundingClientRect().left - t.getBoundingClientRect().left) : 0;
            }),
        };
    `);
    /** "3.2s" / "12s" / "1分05秒" / "1时02分" → 毫秒（量它是不是在往上走）。 */
    const ms = (text) => {
        if (!text) { return -1; }
        let m = text.match(/^([0-9.]+)s$/);
        if (m) { return Math.round(parseFloat(m[1]) * 1000); }
        m = text.match(/^([0-9]+)分([0-9]+)秒$/);
        if (m) { return (Number(m[1]) * 60 + Number(m[2])) * 1000; }
        m = text.match(/^([0-9]+)时([0-9]+)分$/);
        if (m) { return (Number(m[1]) * 3600 + Number(m[2]) * 60) * 1000; }
        return -2;
    };
    const c1 = await clock();
    console.log("\n第十三幕（末尾的耗时）：");
    console.log("   露着的那条：" + JSON.stringify(c1.texts) + " 耗时=" + JSON.stringify(c1.times) + " 右端=" + JSON.stringify(c1.timeBox.map((b) => b && b.right)) + "（这一条右端 " + c1.lineRight + "）");
    if (c1.texts.length !== 1 || !c1.texts[0] || c1.texts[0].indexOf("$ node scripts/") !== 0) { problems.push("两条一起跑时该露最近开始的那一条（长命令）：" + JSON.stringify(c1.texts)); }
    if (c1.times.length !== 1 || !c1.times[0]) { problems.push("露着的那条没写耗时：" + JSON.stringify(c1.times)); }
    if (c1.times[0] && ms(c1.times[0]) < 0) { problems.push("耗时的写法不认识（该是 3.2s / 12s / 1分05秒 这样）：" + JSON.stringify(c1.times)); }
    if (c1.timeBox[0] && Math.abs(c1.lineRight - 14 - c1.timeBox[0].right) > 2) { problems.push("耗时没钉在这一条的右端：" + JSON.stringify(c1.timeBox[0]) + " 这一条右端 " + c1.lineRight); }
    if (!c1.roll[0]) { problems.push("这条长命令没滚起来（要验的「字滚它不滚」就无从验起）"); }
    await page.sleep(900);
    const c2 = await clock();
    console.log("   0.9 秒后：耗时=" + JSON.stringify(c2.times) + " 字在滚=" + JSON.stringify(c2.roll));
    if (!(ms(c2.times[0]) > ms(c1.times[0]))) { problems.push("耗时没往上走：" + JSON.stringify(c1.times) + " → " + JSON.stringify(c2.times)); }
    // 字在滚（位移在变），耗时的位置一动不动
    const c3 = await clock();
    console.log("   再隔 0.9 秒（字的位置 " + c1.shift[0] + " → " + c3.shift[0] + "）：耗时左边 " + (c1.timeBox[0] && c1.timeBox[0].left) + " → " + (c3.timeBox[0] && c3.timeBox[0].left));
    if (c3.shift[0] === c1.shift[0]) { problems.push("字没在滚（量不到「滚的时候耗时不跟着动」）"); }
    if (c1.timeBox[0] && c3.timeBox[0] && c3.timeBox[0].left !== c1.timeBox[0].left) { problems.push("字滚的时候耗时跟着动了（该钉住）：" + c1.timeBox[0].left + " → " + c3.timeBox[0].left); }
    await page.shot("running-line-clock.png");
    // 先跑完那条没露着的（npm test）：露着的那条一个字都不动
    await post([{ type: "toolResult", toolCallId: "k2", isError: false, resultText: "53 个测试都过了", durationMs: 900 }]);
    await page.sleep(200);
    s = await state();
    console.log("\n   没露着的那条跑完：" + show(s));
    if (s.items.length !== 1 || !s.items[0] || s.items[0].indexOf("$ node scripts/") !== 0 || s.spin !== 1 || s.frozen !== 0) {
        problems.push("没露着的那条跑完不该影响露着的这条：" + show(s));
    }
    // 长的也跑完了（一条都不在跑了）：冻着留着 —— 耗时定在跑完那一刻、不再往上走，字照旧滚
    await post([{ type: "toolResult", toolCallId: "k1", isError: false, resultText: "好了", durationMs: 1200 }]);
    await page.sleep(300);
    s = await state();
    const frozen1 = await clock();
    console.log("   最后那条也跑完了：" + show(s) + " 耗时 " + JSON.stringify(frozen1.times));
    if (s.items.length !== 1 || !s.items[0] || s.items[0].indexOf("$ node scripts/") !== 0) { problems.push("跑完了该只留最后露着的那条：" + JSON.stringify(s.items)); }
    if (s.frozen !== 1 || s.spin !== 0) { problems.push("最后跑完的那条该冻住（齿轮停转）：" + show(s)); }
    if (!frozen1.times[0]) { problems.push("冻住的那条没写耗时：" + JSON.stringify(frozen1.times)); }
    if (!frozen1.roll[0]) { problems.push("冻住的那条（长命令）不滚了（滚是为了看全命令，跟还在不在跑无关）：" + JSON.stringify(frozen1.roll)); }
    await page.sleep(700);
    const frozen2 = await clock();
    console.log("   0.7 秒后：耗时 " + JSON.stringify(frozen2.times));
    if (!frozen2.times[0] || frozen1.times[0] !== frozen2.times[0]) {
        problems.push("冻住之后耗时还在涨（该定在跑完那一刻）：" + JSON.stringify(frozen1.times) + " → " + JSON.stringify(frozen2.times));
    }

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

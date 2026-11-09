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
            items: items.map((el) => { const t = el.querySelector(".tr-text"); return ((el.querySelector(".tr-prompt") ? "$ " : "") + (t || el).textContent).trim(); }),
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
    // 折行之后这一块的高矮跟命令长短有关（一个像素的取整差不算「一闪」），只挡那种明显的跳动
    const heights = Array.from(new Set(flick.h));
    if (Math.max(...heights) - Math.min(...heights) > 2) { problems.push("一串快调用让下面的内容上下跳了 " + moves + " 次（位置该一直不动）：滚动高度出现过 " + JSON.stringify(heights) + "）"); }
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

    // ---- 第十二幕：只有分隔符换行（一步一行），一步太长就在行尾省掉（不折行）----
    // 同时跑几条也只露一条，所以分两步看：先投长命令（该折成两行）→ 又来一条短的（换成它、一行）。
    const LONG_CMD = "git log --oneline --all --graph --decorate --date=short --pretty=format:'%h %ad %an %s' -- media src | head -200 && npm run compile && npm run web:shot -- --width 900 --height 700";
    const wrapState = () => page.eval(`
        const items = Array.from(document.querySelectorAll(".session-view:not(.off) .session-pane .tool-running .tool-running-item"));
        return items.map((el) => {
            const t = el.querySelector(".tr-text");
            const lh = parseFloat(getComputedStyle(t).lineHeight) || 13;
            return {
                text: (el.querySelector(".tr-prompt") ? "$ " : "") + t.textContent,
                rows: Math.round(t.offsetHeight / lh),
                overX: t.scrollWidth - t.clientWidth,
                cut: t.scrollHeight > t.clientHeight + 1,
                tip: el.classList.contains("tip-click"),
                // 有哪一步在行尾被省掉了（那一步自己横向溢出）
                clipped: Array.from(el.querySelectorAll(".tr-step")).some((st) => st.scrollWidth > st.clientWidth + 1),
                h: t.offsetHeight,
            };
        });
    `);
    await post([
        { type: "assistantFull", text: "这一条命令很长。" },
        { type: "tool", toolName: "bash", args: { command: LONG_CMD }, toolCallId: "r1" },
    ]);
    await page.sleep(300);
    const rl = await wrapState();
    const long = rl[0] || {};
    console.log("\n第十二幕（写不完的长命令）：");
    console.log("   行数=" + rl.length + " 折成几行=" + long.rows + " 横向溢出=" + long.overX + "px 截断=" + long.cut + " 高=" + long.h + "px");
    if (rl.length !== 1) { problems.push("这一块该只有一条：" + JSON.stringify(rl.map((x) => x.text))); }
    if (!(long.rows >= 2 && long.rows <= 7)) { problems.push("这条长命令该折行（两行到七行之间），实际折成 " + long.rows + " 行：" + JSON.stringify(long)); }
    if (long.overX > 1) { problems.push("折行之后不该再横向溢出（多出 " + long.overX + "px）：" + JSON.stringify(long)); }
    await page.shot("running-line-wrap.png");

    // 又来一条短的：换成它、只有一行、不横向溢出（这一块的高矮会变，折行的代价，不再强求不变）
    await post([{ type: "tool", toolName: "bash", args: { command: "npm test" }, toolCallId: "r2" }]);
    await page.sleep(300);
    const shortLine = (await wrapState())[0] || {};
    console.log("   又来一条短的（" + shortLine.text + "）：折成几行=" + shortLine.rows + " 横向溢出=" + shortLine.overX + "px");
    if (shortLine.text !== "$ npm test" || shortLine.rows !== 1 || shortLine.overX > 1) { problems.push("短的那条该就一行、不横向溢出，而且该换成它（最近开始的）：" + JSON.stringify(shortLine)); }

    // 短的那条跑完：露回还在跑的长命令，照旧折行
    await post([{ type: "toolResult", toolCallId: "r2", isError: false, resultText: "53 个测试都过了", durationMs: 900 }]);
    await page.sleep(400);
    const backLong = (await wrapState())[0] || {};
    console.log("   短的那条跑完，露回来的是：" + backLong.text.slice(0, 24) + "…（折成 " + backLong.rows + " 行）");
    if (!backLong.text || backLong.text.indexOf("$ git log") !== 0 || !(backLong.rows >= 2)) { problems.push("短的那条跑完之后该换回还在跑的长命令（照旧折行）：" + JSON.stringify(backLong)); }

    // 七行还不够：切字（末尾「…」）且点得开看整条
    await post([{ type: "toolResult", toolCallId: "r1", isError: false, resultText: "…", durationMs: 900 }]);
    await post([{ type: "tool", toolName: "bash", toolCallId: "r3", args: {
        command: "node scripts/build.js " + Array.from({ length: 80 }, (_, i) => "--flag-number-" + i).join(" "),
    } }]);
    await page.sleep(300);
    const huge = (await wrapState())[0] || {};
    console.log("   特别长的那条：折成几行=" + huge.rows + " 末尾=" + JSON.stringify(huge.text.slice(-3)) + " 点得开=" + huge.tip + " 横向溢出=" + huge.overX + "px");
    if (huge.rows !== 1) { problems.push("一步长的命令也是占一行：" + JSON.stringify(huge)); }
    if (!huge.clipped) { problems.push("一步太长时该在行尾省掉（后面那些字不摆）：" + JSON.stringify(huge.text.slice(-20))); }
    if (!huge.tip) { problems.push("截断了却没挂提示框（点开看不到整条）"); }
    if (huge.overX > 1) { problems.push("特别长的那条横向溢出了：" + huge.overX + "px"); }

    await post([{ type: "toolResult", toolCallId: "r3", isError: false, resultText: "好了", durationMs: 900 }]);

    // ---- 第十三幕：末尾钉一个耗时（自己往上走；折行的时候它不动）----
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
            texts: items.map((el) => { const t = el.querySelector(".tr-text"); return ((el.querySelector(".tr-prompt") ? "$ " : "") + (t ? t.textContent : "")).trim(); }),
            times: items.map((el) => { const t = el.querySelector(".tr-time"); return t ? t.textContent.trim() : null; }),
            timeBox: items.map((el) => { const t = el.querySelector(".tr-time"); return t ? box(t) : null; }),
            roll: items.map((el) => { const t = el.querySelector(".tr-text"); return !!t && t.offsetHeight > (parseFloat(getComputedStyle(t).lineHeight) || 13) * 1.5; }),
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

    await page.sleep(900);
    const c2 = await clock();
    console.log("   0.9 秒后：耗时=" + JSON.stringify(c2.times) + " 字在滚=" + JSON.stringify(c2.roll));
    if (!(ms(c2.times[0]) > ms(c1.times[0]))) { problems.push("耗时没往上走：" + JSON.stringify(c1.times) + " → " + JSON.stringify(c2.times)); }
    // 这一条的字折着（长命令摆不下），耗时钉在右上角不动
    const c3 = await clock();
    console.log("   再隔 0.9 秒：耗时 " + JSON.stringify(c3.times) + " 折成 " + JSON.stringify(c3.rows) + " 行？耗时左边 " + (c1.timeBox[0] && c1.timeBox[0].left) + " → " + (c3.timeBox[0] && c3.timeBox[0].left));
    if (c1.timeBox[0] && c3.timeBox[0] && c3.timeBox[0].top !== c1.timeBox[0].top) { problems.push("字折行的时候耗时跟着上下动了（该钉在右上角）：" + c1.timeBox[0].top + " → " + c3.timeBox[0].top); }
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

    await page.sleep(700);
    const frozen2 = await clock();
    console.log("   0.7 秒后：耗时 " + JSON.stringify(frozen2.times));
    if (!frozen2.times[0] || frozen1.times[0] !== frozen2.times[0]) {
        problems.push("冻住之后耗时还在涨（该定在跑完那一刻）：" + JSON.stringify(frozen1.times) + " → " + JSON.stringify(frozen2.times));
    }

    // ---- 第十四幕：整条命令摆出来（一段不藏），heredoc 的正文也拼在那一步里 ----
    // 一条命令切成几段就摆几段：段间的 && | ; 照原样写在链上，打杂的（cd 这种）字淡一点；
    // heredoc 那种把一整段脚本塞进来的也拼成一步（换行只发生在分隔符上，太长就在行尾省掉；以前只写 `python - <<'PY'` 那一行，
    // 后面几行代码一个字都看不到，而那段代码才是真正在跑的东西）。
    const drawn = () => page.eval(`
        const item = document.querySelector(".session-view:not(.off) .session-pane .tool-running .tool-running-item");
        if (!item) { return null; }
        const line = item.querySelector(".tr-text");
        // 一步一个 .tr-step（分隔符 + 那一段命令）：摊开来数那几段
        const own = (el) => Number(getComputedStyle(el).opacity);
        const parts = [];
        // 那个 $ 提示符现在摆在链外面（折行时第二行起跟第一个字对齐），数起来补上当开头那一截
        if (item.querySelector(".tr-prompt")) { parts.push("$ "); }
        for (const step of (line ? line.querySelectorAll(".tr-step") : [])) {
            for (const el of step.children) {
                if (el.classList.contains("tr-sep")) { parts.push("[" + el.textContent.trim() + "]"); }
                else if (el.classList.contains("tr-prompt")) { parts.push("$ "); }
                else { parts.push(el.textContent); }
            }
        }
        const bodyEls = Array.from(item.querySelectorAll(".tr-body > div"));
        return {
            parts: parts,
            dim: Array.from(line ? line.querySelectorAll(".tr-seg-dim") : []).map(own),
            plain: Array.from(line ? line.querySelectorAll(".tr-seg") : []).map(own),
            body: bodyEls.map((el) => el.textContent),
            more: (item.querySelector(".tr-more") || {}).textContent || "",
            tip: item.classList.contains("tip-click"),
        };
    `);
    console.log("\n第十四幕（整条命令摆出来）：");
    await post([{ type: "tool", toolName: "bash", toolCallId: "z1", args: { command: "cd /d/projects/picode && git log --oneline -5 ; rm -rf dist ; npm run build" } }]);
    await page.sleep(200);
    let d = await drawn();
    console.log("   四段那条：" + JSON.stringify(d));
    // 一段都不许藏：`git log; rm -rf dist; npm run build` 以前只写 git log 那一段
    if (JSON.stringify(d.parts) !== JSON.stringify(["$ ", "cd /d/projects/picode", "[&&]", "git log --oneline -5", "[;]", "rm -rf dist", "[;]", "npm run build"])) {
        problems.push("这条命令没整条摆出来（链上是这些）：" + JSON.stringify(d.parts));
    }
    if (d.dim.length !== 2 || d.plain.length !== 2) {
        problems.push("只看一眼的两段（cd、git log）该淡，会改东西的两段（rm、npm run build）该是正常字：淡 " + JSON.stringify(d.dim) + " 正常 " + JSON.stringify(d.plain));
    }
    if (!(d.dim[0] < d.plain[0])) { problems.push("只看一眼的那段没比会改东西的那段淡：" + JSON.stringify(d.dim) + " vs " + JSON.stringify(d.plain)); }

    // 只读 / 会改 的界线不能只看程序名：带了会改东西的开关（sed -i、find -delete）或者往文件里写（>）
    // 的不淡；`git log` 这种子命令认得的才淡（`git commit` 不淡）。
    await post([{ type: "toolResult", toolCallId: "z1", isError: false, resultText: "done", durationMs: 900 }]);
    await post([{ type: "tool", toolName: "bash", toolCallId: "z1b", args: { command: "git status ; git commit -m x ; sed -n '1,40p' a.txt ; sed -i s/a/b/ a.txt ; cat > /tmp/c.txt" } }]);
    await page.sleep(200);
    d = await drawn();
    console.log("   只读/会改 那条：" + JSON.stringify({ dim: d.dim, plain: d.plain }));
    if (d.dim.length === d.plain.length) { problems.push("只读与会改没分开：" + JSON.stringify({ dim: d.dim, plain: d.plain })); }
    if (d.parts.filter((p) => p === "git status").length !== 1 || d.dim.length !== 2) {
        problems.push("git status / sed -n 这两个只读的该淡（实际淡了 " + JSON.stringify(d.dim) + " 个）：" + JSON.stringify(d.parts));
    }
    if (d.plain.length !== 3) {
        problems.push("git commit / sed -i / cat > 这三个会改东西的该是正常字（实际正常 " + JSON.stringify(d.plain) + " 个）：" + JSON.stringify(d.parts));
    }

    await post([{ type: "toolResult", toolCallId: "z1", isError: false, resultText: "done", durationMs: 900 }]);
    await post([{ type: "tool", toolName: "bash", toolCallId: "z2", args: { command: [
        "cat > /tmp/a.sh <<'EOF'",
        "#!/bin/bash",
        "set -e",
        "for f in *.ts; do npx tsc --noEmit \"$f\"; done",
        "EOF",
        "bash /tmp/a.sh | sed -n \"1,40p\"",
    ].join("\n") } }]);
    await page.sleep(200);
    d = await drawn();
    console.log("   heredoc 那条：" + JSON.stringify(d));
    // heredoc 的正文也拼回一步（换行只发生在分隔符上），那一步会长、由行尾省掉
    if (JSON.stringify(d.parts) !== JSON.stringify(["$ ", "cat > /tmp/a.sh <<'EOF' #!/bin/bash set -e for f in *.ts; do npx tsc --noEmit \"$f\"; done EOF", "[;]", "bash /tmp/a.sh", "[|]", "sed -n \"1,40p\""])) {
        problems.push("heredoc 那条的链不对（heredoc 那段该拼成一步，后面两段仍在链上）：" + JSON.stringify(d.parts));
    }
    if (d.body.length) { problems.push("不该另起一块正文（换行只发生在分隔符上）：" + JSON.stringify(d.body)); }
    if (d.more) { problems.push("没裁的情况下不该有「+N」：" + d.more); }

    await post([{ type: "toolResult", toolCallId: "z2", isError: false, resultText: "done", durationMs: 900 }]);
    await post([{ type: "tool", toolName: "bash", toolCallId: "z3", args: { command: "a; b; c; d; e; f; g" } }]);
    await page.sleep(200);
    d = await drawn();
    console.log("   七段那条：" + JSON.stringify(d));
    if (d.parts.length !== 10 || d.parts.filter((p) => p.startsWith("[")).length !== 4) {
        problems.push("段太多时该摆前五段（链上的段数与分隔符数对不上）：" + JSON.stringify(d.parts));
    }
    if (d.more !== "+2") { problems.push("没摆出来的两段该写成「+2」：" + JSON.stringify(d.more)); }
    if (!d.tip) { problems.push("有字没写出来时点开这一行该能看到整条（没挂提示框）"); }

    await post([{ type: "toolResult", toolCallId: "z3", isError: false, resultText: "done", durationMs: 900 }]);
    const longBody = ["cat > /tmp/b.sh <<'EOF'"].concat(Array.from({ length: 10 }, (_, i) => "echo line" + i), ["EOF"]).join("\n");
    await post([{ type: "tool", toolName: "bash", toolCallId: "z4", args: { command: longBody } }]);
    await page.sleep(200);
    d = await drawn();
    console.log("   正文十行那条：parts=" + JSON.stringify(d.parts.map((p) => p.slice(0, 24))) + " body=" + JSON.stringify(d.body));
    if (d.parts.length !== 2 || d.body.length) { problems.push("长 heredoc 也只占一步（不另起正文、不折行）：" + JSON.stringify(d.parts)); }
    if (!d.tip) { problems.push("有字没写出来（行尾省掉）却没挂提示框"); }
    await page.shot("running-line-chain.png");

    // 不是 heredoc 的多行命令（`&& \` 续行那种）：拼回一条链，不多出第二行，也不留一个孤零零的「\」
    await post([{ type: "toolResult", toolCallId: "z4", isError: false, resultText: "done", durationMs: 900 }]);
    await post([{ type: "tool", toolName: "bash", toolCallId: "z5", args: { command: "npm test 2>&1 && \\\n  npx tsc --noEmit" } }]);
    await page.sleep(200);
    d = await drawn();
    console.log("   续行那条：parts=" + JSON.stringify(d.parts) + " body=" + JSON.stringify(d.body));
    if (JSON.stringify(d.parts) !== JSON.stringify(["$ ", "npm test 2>&1", "[&&]", "npx tsc --noEmit"])) {
        problems.push("续行的命令该拼回一条链（不留反斜杠、不多出一段）：" + JSON.stringify(d.parts));
    }
    if (d.body.length) { problems.push("不是 heredoc 的命令不该在链下面多出正文行：" + JSON.stringify(d.body)); }

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

// @ts-nocheck
/**
 * liveDetail —— 验「实时流里思考 / 工具内容一个字都不发」：模型正在想 / 正在跑工具的时候，
 * 推送流里没有思考正文、没有输出、没有调用参数，全文留在后端，点开提示框再取。
 *
 *   FAKEPI_LONG=3000 npm run web:shot -- --fake-pi --script dev/liveDetail.js
 *
 * 假模型（dev/fakePi.js）在 FAKEPI_LONG 里把思考与 bash 输出撑长，一个来回里验五件事：
 *   · 推送流里思考增量是 0 字（不是那 3000 字）；
 *   · 收尾的 thinkingFull 带上了“一共多少字”；
 *   · 点开只画那一行调用（输入）：一个字都不取、也没有「正在取…」（取就会让高矮跳一下）；
 *   · 点开那一行：“还有 N 字没带过来，正在取…” → 一会儿换成全文；
 *   · bash 标签、write 的写入预览也一样：“先只有输入、点了才取”。
 */
const LONG = Number(process.env.FAKEPI_LONG || 3000);

/** 点开名字是 name 的那个标签。 */
function hover(page, name) {
    return page.eval(`
        const tags = Array.from(document.querySelectorAll('.session-view:not(.off) .session-pane .tool'));
        const tag = tags.find(function (t) { return ((t.innerText || '').trim().split(/\\s+/)[0] === ${JSON.stringify(name)}); });
        if (!tag) { return false; }
        tag.click();
        return true;
    `);
}

function tipState(page) {
    return page.eval(`
        const el = document.querySelector('.tag-tip');
        if (!el || el.classList.contains('hidden')) { return { open: false }; }
        const body = el.querySelector('.tag-tip-content') || el;
        const note = el.querySelector('.tag-tip-clip');
        return { open: true, chars: (body.innerText || '').length, note: note ? note.textContent : '' };
    `);
}

function hideTip(page) {
    return page.eval(`
        document.querySelectorAll('.session-view:not(.off) .session-pane .tool').forEach(function (t) {
            document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        return true;
    `);
}

module.exports = async (page) => {
    console.log(`\n【实时流里的“只发摘要”】假模型把思考与 bash 输出撑到 ${LONG} 字`);
    const results = [];
    const check = (name, ok, detail) => {
        results.push(ok);
        console.log(`  ${ok ? "✅" : "❌"} ${name}：${detail}`);
    };

    // 本机零延迟时“正在取…”那一行几乎一闪就换成全文，验不到“先看到开头”。
    // 这里把 /api 暂时堵上：那一次取全文的请求发不出去，提示框就停在“还有 N 字没带过来”；
    // 验完把堵撤掉，请求照常回来（两段之间不留副作用）。
    await page.cdp.send("Network.enable");
    const blockApi = (on) => page.cdp.send("Network.setBlockedURLs", { urls: on ? ["*api*"] : [] });

    // 量“这一轮推了多少思考内容”：在页面里挂一个监听（chat.js 收的是同一个 window 上的消息）
    await page.eval(`
        window.__live = { thinkDelta: 0, thinkFull: 0, fullOmitted: 0 };
        window.addEventListener('message', function (ev) {
            const d = ev.data || {};
            if (d.type === 'thinkingDelta') { window.__live.thinkDelta += String(d.delta || '').length; }
            if (d.type === 'thinkingFull') {
                window.__live.thinkFull += String(d.text || '').length;
                if (typeof d.omitted === 'number') { window.__live.fullOmitted = d.omitted; }
            }
        });
        return true;
    `);

    await page.send("你好");
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        const st = await page.eval(`const el = document.getElementById('ctxIcon'); return el ? el.dataset.st : '';`);
        if (st === "idle") { break; }
        await page.sleep(300);
    }
    await page.sleep(1500);

    const live = await page.eval("return window.__live;");
    check("思考内容一个字都没推", live.thinkDelta === 0,
        `推送流里 thinkingDelta 合计 ${live.thinkDelta} 字（全文 ${LONG} 字）`);
    check("收尾那条带了“一共多少字”", live.fullOmitted >= LONG * 0.9,
        `thinkingFull 带了 ${live.thinkFull} 字正文，omitted=${live.fullOmitted}`);

    await blockApi(true);
    console.log("  —— 点开 think 标签 ——");
    if (!(await hover(page, "think"))) { check("找到 think 标签", false, "页面上没有这颗标签"); }
    await page.sleep(600);
    const first = await tipState(page);
    check("点开只画那一行输入（一个字都不取）", first.open && first.chars < 200 && !first.note,
        `${first.chars} 字，小字：${first.note || "（没有）"}`);
    await page.expandTip();     // 点开那一行：这一下才去要全文
    await page.sleep(400);
    const fetching = await tipState(page);
    check("点开来才取全文（先看到“正在取…”）", fetching.open && !!fetching.note,
        `${fetching.chars} 字，小字：${fetching.note || "（没有）"}`);
    await page.shot("detail-note.png");     // 这一张：“还有 3000 字没带过来，正在取…”
    await blockApi(false);
    await page.sleep(2500);
    const after = await tipState(page);
    check("思考全文取回来了", after.open && after.chars >= LONG * 0.9 && !after.note,
        `${after.chars} 字，小字：${after.note || "（没有）"}`);
    await hideTip(page);
    await page.sleep(300);

    await blockApi(true);
    console.log("  —— 点开 bash 标签 ——");
    if (!(await hover(page, "bash"))) { check("找到 bash 标签", false, "页面上没有这颗标签"); }
    await page.sleep(600);
    const toolFirst = await tipState(page);
    check("点开时只写那一行调用摘要（输出收着、不取）", toolFirst.open && toolFirst.chars < 200 && !toolFirst.note,
        `${toolFirst.chars} 字，小字：${toolFirst.note || "（没有）"}`);
    await page.expandTip();
    await page.sleep(400);
    const toolFetching = await tipState(page);
    check("点开来才去取输出（“正在取…”）", toolFetching.open && !!toolFetching.note,
        `${toolFetching.chars} 字，小字：${toolFetching.note || "（没有）"}`);
    await blockApi(false);
    await page.sleep(2500);
    const toolAfter = await tipState(page);
    check("bash 输出全文取回来了", toolAfter.open && toolAfter.chars > toolFetching.chars + 500 && !toolAfter.note,
        `${toolFetching.chars} → ${toolAfter.chars} 字，小字：${toolAfter.note || "（没有）"}`);
    // 调用参数只带“一行字那么多”的摘要：那行一直看得见的调用摘要（`$ ls`）不用点开就有，
    // 整份参数（write 的正文那种几十 KB 的）才要点开取。
    const callLine = await page.eval(`
        const el = document.querySelector('.tag-tip .tag-tip-call');
        return el ? el.textContent : '';
    `);
    const tagCall = await page.eval(`
        const tags = Array.from(document.querySelectorAll('.session-view:not(.off) .session-pane .tool'));
        const tag = tags.find(function (t) { return (t.innerText || '').trim().startsWith("bash"); });
        if (!tag) { return ""; }
        const g = tag._tipGroup;
        return g ? (g.entries.map(function (e) { return e.tipCall || ""; }).join(" | ")) : (tag._tipCall || "");
    `);
    check("调用摘要一直就有（正在跑的那一行用它）", /ls/.test(tagCall) && /ls/.test(callLine),
        `标签上的摘要：${tagCall || "（空）"}；提示框里那行：${callLine || "（空）"}`);
    await hideTip(page);
    await page.sleep(300);

    // ---- 第二轮：write 卡片的写入预览（参数同样没带过来，点开才取）----
    console.log("  —— 发“写新文件”，看 write 卡片的预览 ——");
    await page.send("写新文件");
    const done = Date.now() + 60000;
    while (Date.now() < done) {
        const st = await page.eval(`const el = document.getElementById('ctxIcon'); return el ? el.dataset.st : '';`);
        const has = await page.eval(`return !!document.querySelector('.session-view:not(.off) .session-pane .tool');`);
        if (st === "idle" && has) { break; }
        await page.sleep(300);
    }
    await page.sleep(1200);
    await blockApi(true);
    if (!(await hover(page, "write"))) { check("找到 write 标签", false, "页面上没有这颗标签"); }
    await page.sleep(600);
    const noPreview = await page.eval(`
        const el = document.querySelector('.tag-tip .tc-args');
        return el ? el.textContent : '';
    `);
    check("点开只写改了哪个文件（不画预览、不取参数）", noPreview === "", noPreview ? `先有了：${noPreview.slice(0, 20)}` : "预览还没有");
    await page.expandTip();     // 点标题行：这才去要参数
    await page.sleep(400);
    const stillNoPreview = await page.eval(`
        const el = document.querySelector('.tag-tip .tc-args');
        return el ? el.textContent : '';
    `);
    check("点开来才去取参数（预览这会儿还画不出来）", stillNoPreview === "", stillNoPreview ? `先有了：${stillNoPreview.slice(0, 20)}` : "预览还没有");
    await blockApi(false);
    await page.sleep(2500);
    const preview = await page.eval(`
        const el = document.querySelector('.tag-tip .tc-args');
        return el ? el.textContent : '';
    `);
    const oneLine = preview ? preview.split("\n").join(" / ").slice(0, 40) : "";
    check("预览取回来了", /第一行/.test(preview), oneLine || "（没有预览）");
    await hideTip(page);

    const ok = results.every(Boolean);
    console.log(ok ? "\n全部通过。" : "\n有不通过的。");
    return ok;
};

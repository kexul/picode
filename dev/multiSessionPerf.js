// @ts-nocheck
/**
 * multiSessionPerf —— 量「同时有好几个会话在跑」时界面吃多少 CPU，以及「不停地切 tab」时的情况。
 *
 * 一个机器上常常是两三个会话一起跑，屏幕上却只有一个：其余几个的字照样一个字一个字地回来。
 * 屏幕上看不见的那些，排版和绘制省了（浏览器不给不显示的排），但「把新来的那段重新解析、
 * 把没写完那个代码块重新上色」这一项照付——手机上这一项最贵，所以它按 HIDDEN_RENDER_MS
 * 慢慢画（见 chat.js 的 renderInterval），切过去时补画一次。
 *
 *   node dev/multiSessionPerf.js                                 # 3 个会话一起吐字，停在同一个上
 *   node dev/multiSessionPerf.js --switch-every 2000             # 一边吐字一边每 2 秒切一次
 *   node dev/multiSessionPerf.js --sessions 1                    # 只有一个会话（基线）
 *   node dev/multiSessionPerf.js --no-anim                       # 把所有循环动画关掉再量
 *   node dev/multiSessionPerf.js --sessions 3 --profile          # 顺便报一份采样热点（谁在吃 CPU）
 *
 * 报的是这十几秒里主线程忙了多少（拆成脚本 / 排版 / 算样式），最后还验一遍「切过去有没有
 * 漏画」：后端发过来多少字、页面上原文多长，两个数得对上。
 *
 * 只用来查性能，不动别人的环境（后端用 PICHAT_HOME 指到 dev/.scratch，用假 pi）。
 */
const { createHarness, openSessionIn } = require("./harness.js");
const { openPage, sleep, printHotspots } = require("./cdp.js");

async function metrics(cdp) {
    const { metrics: list } = await cdp.send("Performance.getMetrics");
    const out = {};
    for (const item of list) { out[item.name] = item.value; }
    return out;
}

/** 一段像真模型回复的长文（几段说明、每段两个代码块）：流式期间一直往尾巴上长。 */
function buildAnswer() {
    const out = ["## 结论\n\n下面按你问的三件事分开说。\n"];
    for (let i = 0; i < 6; i++) {
        out.push(`\n### ${i + 1}. 第 ${i + 1} 段说明\n\n这段文字在说一个实现细节：先看当前状态，再决定要不要改，改完把结果写回。这里要足够长，才能看出渲染长文本时的开销。\n`);
        for (let c = 0; c < 2; c++) {
            out.push("\n```typescript\n");
            for (let l = 0; l < 18; l++) {
                out.push(`function step${i}_${c}_${l}(input: string, count: number): string {\n  const parts = input.split("\\n").filter((line) => line.length > ${l});\n  return parts.join("\\n");\n}\n`);
            }
            out.push("```\n");
        }
    }
    return out.join("");
}

async function main() {
    const argv = process.argv.slice(2);
    const arg = (name, fallback) => {
        const i = argv.indexOf("--" + name);
        return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
    };
    const sessions = Number(arg("sessions", 3));
    const seconds = Number(arg("seconds", 15));
    const switchEvery = Number(arg("switch-every", 0));
    const noAnim = argv.includes("--no-anim");
    const profile = argv.includes("--profile");   // 顺便报一份采样热点：谁在吃 CPU

    const harness = createHarness({ fakePi: true });
    const url = await harness.start();
    const open = await openPage({ url, width: 412, height: 915, timeoutMs: 60000 });
    const { page, cdp } = open;
    try {
        await page.waitReady();
        // 手机的样子：3 倍像素密度 + CPU 降速 4 倍（≈ 手机的档位）
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 3, mobile: true });
        // 界面认手机看的是 (hover: none) and (pointer: coarse)：触屏也模拟上，手机上才走的分支才量得到
        try { await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }); } catch (e) { /* 不支持就算了 */ }
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await cdp.send("Performance.enable");
        if (noAnim) {
            await page.eval(`const s = document.createElement("style"); s.textContent = "*{animation:none!important}"; document.head.appendChild(s); return true;`);
        }

        // 凑够会话：走「项目与会话」那条路（顶条那颗加号现在是 /new 那套，旧的闲着就关掉，
        // 开不出第二个壳，见 harness 的 openSessionIn）
        for (let i = 1; i < sessions; i++) { await openSessionIn(page, harness.cwd); }
        const ids = await page.eval(`
            return Array.from(document.querySelectorAll(".session-view")).map(function (v) {
                return v.querySelector(".session-pane").dataset.sessionId;
            });
        `);

        // 每个会话都先垫 2.4 万字，再每 25 毫秒来 5 个字（跟真模型吐字差不多快）
        await page.eval(`
            const answer = ${JSON.stringify(buildAnswer())};
            const ids = ${JSON.stringify(ids)};
            const send = function (sessionId, m) {
                window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: sessionId }, m) }));
            };
            window.__timers = [];
            window.__sent = ids.map(function () { return 24000; });
            ids.forEach(function (id, i) {
                send(id, { type: "streamStart", activity: "working" });
                send(id, { type: "assistantDelta", delta: answer.slice(0, 24000) });
                let at = 24000;
                window.__timers.push(setInterval(function () {
                    if (at >= answer.length) { return; }
                    send(id, { type: "assistantDelta", delta: answer.slice(at, at + 5) });
                    at += 5;
                    window.__sent[i] = at;
                }, 25));
            });
            window.__switch = function (id) { window.acquireVsCodeApi().postMessage({ type: "switchSession", sessionId: id }); };
            return true;
        `);
        await sleep(4000);   // 先让它们跑起来，别把"刚垫进去那一下"算进来

        const before = await metrics(cdp);
        if (profile) {
            await cdp.send("Profiler.enable");
            await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
            await cdp.send("Profiler.start");
        }
        const t0 = Date.now();
        if (switchEvery > 0) {
            let n = 0;
            while (Date.now() - t0 < seconds * 1000) {
                await page.eval(`window.__switch(${JSON.stringify(ids[n++ % ids.length])}); return true;`);
                await sleep(switchEvery);
            }
        } else {
            await sleep(seconds * 1000);
        }
        const wall = Date.now() - t0;
        const after = await metrics(cdp);
        const prof = profile ? (await cdp.send("Profiler.stop")).profile : null;
        const d = (k) => Math.max(0, (after[k] || 0) - (before[k] || 0));
        const pct = (v) => ((v * 1000 / wall) * 100).toFixed(1) + "%";
        console.log("");
        console.log("=== " + ids.length + " 个会话一起吐字，"
            + (switchEvery > 0 ? "每 " + switchEvery + " 毫秒切一次，" : "停在同一个会话上，")
            + (wall / 1000).toFixed(0) + " 秒（412x915@3x，CPU 降速 4 倍" + (noAnim ? "，动画全关" : "") + "） ===");
        console.log("主线程忙：" + pct(d("TaskDuration")) + "（脚本 " + pct(d("ScriptDuration"))
            + "，排版 " + pct(d("LayoutDuration")) + "，算样式 " + pct(d("RecalcStyleDuration")) + "）");
        console.log("排版 " + d("LayoutCount") + " 次，算样式 " + d("RecalcStyleCount") + " 次");
        const dom = await page.eval("return { views: document.querySelectorAll('.session-view').length, nodes: document.getElementsByTagName('*').length };");
        console.log("DOM：" + dom.nodes + " 个元素，" + dom.views + " 个会话壳");
        if (prof) { printHotspots(prof); }

        // 漏不漏画：停掉吐字，挨个切过去，看画出来的原文是不是已经到最新
        await page.eval("window.__timers.forEach(clearInterval); window.__timers = []; return true;");
        await sleep(1200);
        const sent = await page.eval("return window.__sent;");
        console.log("");
        console.log("切过去补画了没有（后端发来的字 / 页面上的原文）：");
        for (let i = 0; i < ids.length; i++) {
            await page.eval(`window.__switch(${JSON.stringify(ids[i])}); return true;`);
            await sleep(300);
            const got = await page.eval(`
                const pane = document.querySelector(".session-view:not(.off) .session-pane");
                const md = pane.querySelector(".assistant .md");
                return { id: pane.dataset.sessionId, raw: md ? (md.dataset.raw || "").length : 0 };
            `);
            console.log("  " + got.id + "：" + sent[i] + " 字 / " + got.raw + " 字"
                + (sent[i] === got.raw ? "（对上了）" : "（差 " + (sent[i] - got.raw) + " 字）"));
        }
    } finally {
        await open.close();
        await harness.stop();
    }
}

main().catch((err) => { console.error("\n出错了：" + (err?.message || err)); process.exit(1); });

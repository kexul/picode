// @ts-nocheck
/**
 * 量「项目与会话」面板（顶条最右边那颗 <<<）打开时卡不卡：
 *  - 点击 → 面板可见：多少毫秒（这里面全是等宿主扫磁盘）；
 *  - 从点击那一刻起，主线程上有没有长任务（>50 毫秒的一帧 = 一眼能看出的停顿）；
 *  - 第一次打开时 CPU 到底花在哪（采样剖析的热点）。
 *
 * 默认按手机的样子量（412x915、3 倍像素密度、CPU 降速 4 倍）。
 * 参数走环境变量（visit.js 的参数表不认自定义开关）：
 *   SIDEBAR_BATCHES=40  先垫多少轮长对话
 *   SIDEBAR_CPU=4       CPU 降速倍数（1 = 不降速）
 *   SIDEBAR_ROUNDS=5    开开关关几轮
 *
 *   npm run web:shot -- --script dev/sidebarPerf.js
 */
module.exports = async (page) => {
    const batches = Number(process.env.SIDEBAR_BATCHES || 0);
    const cpu = Number(process.env.SIDEBAR_CPU || 4);
    const rounds = Number(process.env.SIDEBAR_ROUNDS || 3);

    await page.waitReady();

    try {
        await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 3, mobile: true });
        if (cpu > 1) { await page.cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu }); }
        console.log(`视口 412x915@3x，CPU 降速 ${cpu} 倍`);
    } catch (e) { console.log("（设不了手机参数：" + e.message + "）"); }

    if (batches > 0) {
        await page.eval(`
            const pane = document.querySelector(".session-view:not(.off) .session-pane");
            const sessionId = pane.dataset.sessionId;
            const send = function (msg) {
                window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: sessionId }, msg) }));
            };
            const para = "这段文字在说一个实现细节：先看当前状态，再决定要不要改，改完把结果写回。为了够长，再补一句。\\n\\n";
            send({ type: "clear" });
            for (let i = 0; i < ${batches}; i++) {
                send({ type: "userMessage", text: "第 " + (i + 1) + " 轮：请解释一下这段实现。" });
                send({ type: "assistantFull", text: "## 第 " + (i + 1) + " 轮回答\\n\\n" + para.repeat(4) });
            }
            return true;
        `);
        await page.sleep(500);
        const dom = await page.eval("return { nodes: document.getElementsByTagName('*').length, messages: document.querySelectorAll('.msg').length }");
        console.log(`先垫了 ${batches} 轮对话：DOM ${dom.nodes} 个元素、消息 ${dom.messages} 条`);
    }

    await page.eval(`
        (function () {
            window.__frames = [];
            window.__longTasks = [];
            let last = 0;
            function tick(t) {
                if (last) { window.__frames.push({ at: t, dt: +(t - last).toFixed(1) }); }
                last = t;
                window.__rafId = requestAnimationFrame(tick);
            }
            window.__rafId = requestAnimationFrame(tick);
            try {
                new PerformanceObserver(function (list) {
                    for (const e of list.getEntries()) {
                        window.__longTasks.push({ start: e.startTime, d: Math.round(e.duration) });
                    }
                }).observe({ entryTypes: ["longtask"] });
            } catch (e) { /* 老浏览器不支持就算了 */ }
            return true;
        })();
    `);

    const rows = [];
    const profiles = [];
    for (let i = 1; i <= rounds; i++) {
        await page.eval(`
            (function () {
                const overlay = document.getElementById("pickerOverlay");
                window.__t = { click: 0, visible: 0 };
                const mo = new MutationObserver(function () {
                    const open = !overlay.classList.contains("hidden") && overlay.classList.contains("pk-workspace");
                    if (open && !window.__t.visible) { window.__t.visible = performance.now(); }
                });
                mo.observe(overlay, { attributes: true, attributeFilter: ["class"] });
                window.__frames.length = 0;
                window.__longTasks.length = 0;
                return true;
            })();
        `);
        await page.cdp.send("Profiler.enable");
        await page.cdp.send("Profiler.setSamplingInterval", { interval: 200 });
        await page.cdp.send("Profiler.start");
        await page.eval(`
            window.__t.click = performance.now();
            document.getElementById("browserMenuBtn").click();
            return true;
        `);
        await page.sleep(700);
        const profile = (await page.cdp.send("Profiler.stop")).profile;
        profiles.push(profile);
        const r = await page.eval(`
            const t = window.__t;
            const click = t.click;
            const frames = window.__frames.filter(function (f) { return f.at >= click - 5; }).slice(0, 20)
                .map(function (f) { return [Math.round(f.at - click), f.dt]; });
            return {
                toVisible: Math.round((t.visible - click) * 10) / 10,
                frames: frames,
                longTasks: window.__longTasks.filter(function (e) { return e.start >= click - 5; })
                    .map(function (e) { return { 起: Math.round(e.start - click), 毫秒: e.d }; }),
            };
        `);
        const worst = r.frames.reduce((m, f) => Math.max(m, f[1]), 0);
        console.log(`\n【第 ${i} 次打开】点击→可见 ${r.toVisible} 毫秒   最长一帧 ${worst} 毫秒`);
        console.log("  帧（[点击后多少毫秒, 这一帧多长]）：" + JSON.stringify(r.frames.slice(0, 8)));
        console.log("  长任务：" + JSON.stringify(r.longTasks));
        rows.push(worst);
        if (i < rounds) {
            // 收起面板：按 Esc（界面的关法）。别再找那个已经不存在的 #pickerClose 了 ——
            // 点空了的话，下一轮量的「打开耗时」其实是在开关一次已经开着的面板，数是假的。
            await page.press("Escape");
            await page.sleep(350);
            const stillOpen = await page.eval("return !document.getElementById('pickerOverlay').classList.contains('hidden');");
            if (stillOpen) { throw new Error("面板没收起来，后面量的时长不作数"); }
        }
    }
    console.log("\n各次最长一帧：" + rows.join(", ") + " 毫秒");
    printHotspots(profiles[0], "第一次打开期间");
    if (profiles[1]) { printHotspots(profiles[1], "第二次打开期间"); }
    await page.shot("sidebar-open.png");
};

/** 采样剖析里"自己花时间最多"的函数。 */
function printHotspots(profile, title) {
    if (!profile || !profile.nodes) { return; }
    const byId = new Map();
    for (const n of profile.nodes) { byId.set(n.id, n); }
    const selfHits = new Map();
    for (const id of profile.samples || []) { selfHits.set(id, (selfHits.get(id) || 0) + 1); }
    const rows = [];
    for (const [id, hits] of selfHits) {
        const node = byId.get(id);
        if (!node) { continue; }
        const f = node.callFrame || {};
        const name = f.functionName || "(匿名)";
        const where = (f.url || "").replace(/^.*\//, "") + ":" + ((f.lineNumber || 0) + 1);
        rows.push({ hits, what: name + "  @ " + where });
    }
    rows.sort((a, b) => b.hits - a.hits);
    const total = (profile.samples || []).length;
    const wall = ((profile.timeDeltas || []).reduce((a, b) => a + b, 0) || 0) / 1000;
    console.log("\n=== CPU 采样热点（" + title + "，共 " + total + " 个采样 / " + Math.round(wall) + " 毫秒） ===");
    const seen = new Set();
    let printed = 0;
    for (const row of rows) {
        if (seen.has(row.what)) { continue; }
        seen.add(row.what);
        console.log("  " + String(((row.hits / (total || 1)) * 100).toFixed(1)).padStart(5) + "%  " + row.what);
        if (++printed >= 12) { break; }
    }
    if (!printed) { console.log("  （没有采到任何脚本执行）"); }
}

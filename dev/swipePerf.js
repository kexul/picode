// @ts-nocheck
/**
 * swipePerf —— 量「手机上左右划切会话」这一趟卡不卡。
 *
 *   node dev/swipePerf.js                          # 两个会话各塞 300 轮，来回划 3 趟
 *   node dev/swipePerf.js --pairs 800 --rounds 5   # 更大的会话、多划几趟
 *   node dev/swipePerf.js --css "...."             # 试验用：划之前先往页面塞一段样式
 *
 * 分三段看时间都花在哪：
 *   1. 手指划的这一段（从认成横划那一下，到松手前）：主线程每帧隔了多久（rAF 间隔）、
 *      最长的一帧隔了多久、有没有长任务 —— 这一段就是“跟不跟手”；
 *   2. 松手到真切过去（#messages 摘掉 .swiping）：这里面有后端那一圈（切会话 → 推列表 → 回话）
 *      再加最后 180 毫秒的滑完；
 *   3. 顺带记一下后端那一圈单独要多久（只塞 switchSession，等画面上真的换过来）。
 *
 * 只用来查性能，不动别人的环境（后端用 PICHAT_HOME 指到 dev/.scratch，用假 pi）。
 */
const { createHarness, openSessionIn } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

function buildText(bytes) {
    const base = "这段文字在说一个实现细节：先看当前状态，再决定要不要改，改完把结果写回。";
    let out = "";
    while (out.length < bytes) { out += base; }
    return out.slice(0, bytes);
}

async function main() {
    const argv = process.argv.slice(2);
    const arg = (name, fallback) => {
        const i = argv.indexOf("--" + name);
        return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
    };
    const pairs = Number(arg("pairs", 300));
    const rounds = Number(arg("rounds", 3));
    const bytes = Number(arg("bytes", 600));
    const width = Number(arg("width", 420));
    const height = Number(arg("height", 900));
    const css = arg("css", "");
    const dsf = Number(arg("dsf", 1));          // 设备像素比（手机上一般是 2—3）
    const cpu = Number(arg("cpu", 0));           // 主线程拖慢几倍（手机上近似效果，0 = 不拖慢）
    const cold = argv.includes("--cold");        // 划之前把进来的那个壳的“停着”摘掉（模拟它刚来过消息）
    const extra = Number(arg("extra", 0));       // 再开几个会话（让会话清单重一点）
    const profile = argv.includes("--profile");  // 松手那一段剖一下

    const harness = createHarness({ fakePi: true, log: () => {} });
    const url = await harness.start();
    const open = await openPage({ url, width, height, dsf, timeoutMs: 60000 });
    const { page, cdp } = open;
    try {
        await page.waitReady();
        await cdp.send("Performance.enable");
        if (cpu > 1) {
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
            console.log(`主线程拖慢 ${cpu} 倍（近似手机）`);
        }
        const firstId = await page.eval(`return document.querySelector("#messages .session-view:not(.off) .session-pane").dataset.sessionId`);

        /** 走后端那条真路切一个会话（等画面上真换过来）。 */
        const switchTo = (sessionId) => page.eval(`
            const want = ${JSON.stringify(sessionId)};
            const t0 = performance.now();
            const go = function () {
                const pane = document.querySelector("#messages .session-view:not(.off) .session-pane");
                if (pane && pane.dataset.sessionId === want) { return Math.round(performance.now() - t0); }
                return -1;
            };
            if (go() >= 0) { return 0; }
            window.acquireVsCodeApi().postMessage({ type: "switchSession", sessionId: want });
            return new Promise(function (resolve) {
                function step() {
                    const ms = go();
                    if (ms >= 0) { resolve(ms); return; }
                    requestAnimationFrame(step);
                }
                requestAnimationFrame(step);
            });
        `);

        // 造内容：两个会话各塞 pairs 轮（用户说“这两个会话”，两个都得是有内容的）
        const text = buildText(bytes);
        const fill = (sessionId, tag) => page.eval(`
            const sessionId = ${JSON.stringify(sessionId)};
            const text = ${JSON.stringify(text)};
            const send = function (msg) {
                window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: sessionId }, msg) }));
            };
            for (let i = 0; i < ${pairs}; i++) {
                send({ type: "userMessage", text: ${JSON.stringify(tag)} + " 第 " + (i + 1) + " 轮：请解释一下这段实现。" });
                send({ type: "assistantFull", text: "第 " + (i + 1) + " 轮。" + text });
            }
            return true;
        `);
        await fill(firstId, "A");
        await sleep(2500);

        // 顶条那颗加号是 /new 那套（旧的闲着就关掉），要两个壳得走「项目与会话」那条路
        await openSessionIn(page, harness.cwd);
        await sleep(2500);
        const secondId = await page.eval(`return document.querySelector("#messages .session-view:not(.off) .session-pane").dataset.sessionId`);
        if (!secondId || secondId === firstId) { throw new Error("没建出第二个会话"); }
        await fill(secondId, "B");
        // 再开几个空会话（会话清单重的时候，切一下要处理的列表和界面更多）
        for (let i = 0; i < extra; i++) {
            await openSessionIn(page, harness.cwd);
            await sleep(1200);
        }
        // 回到第一个会话（从它开始划）：走后端那条真路，不然后端记的“这块屏在看哪个”
        // 跟画面对不上，后面每一次切换都会落在“本来就是它”上（后端直接不理）。
        await switchTo(firstId);
        await sleep(3000);   // 等“停着”那一步把两个壳都排好版（KEEP_DELAY_MS = 1500）

        if (css) {
            await page.eval(`
                const style = document.createElement("style");
                style.textContent = ${JSON.stringify(css)};
                document.head.appendChild(style);
                return true;
            `);
            await sleep(500);
        }

        const dom = await page.eval(`
            const views = Array.from(document.querySelectorAll(".session-view"));
            return {
                nodes: document.getElementsByTagName("*").length,
                messages: document.querySelectorAll(".msg").length,
                kept: views.filter((v) => v.classList.contains("kept")).length,
                views: views.length,
                shown: views.filter((v) => !v.classList.contains("off")).length,
                paneHeight: Math.round(views[0].querySelector(".session-pane").scrollHeight),
            };
        `);
        console.log(`两个会话各 ${pairs} 轮：DOM ${dom.nodes} 个元素，${dom.messages} 条消息，` +
            `壳 ${dom.views} 个（停着排好版的 ${dom.kept} 个），内容高 ${dom.paneHeight} 像素，视口 ${width}x${height}`);

        // 量具：每帧的时间戳、长任务、几件事发生的那一下
        await page.eval(`
            window.__frames = [];
            window.__longTasks = [];
            window.__marks = {};
            window.__rec = false;
            try {
                new PerformanceObserver(function (list) {
                    for (const e of list.getEntries()) {
                        if (window.__rec) { window.__longTasks.push(Math.round(e.duration)); }
                    }
                }).observe({ entryTypes: ["longtask"] });
            } catch (e) { /* 没有 longtask 就算了 */ }
            const loop = function (t) {
                if (window.__rec) { window.__frames.push(t); }
                requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
            const messages = document.getElementById("messages");
            window.__watch = function (label) {
                new MutationObserver(function () {
                    window.__marks[label + ":swiping"] = performance.now();
                }).observe(messages, { attributes: true, attributeFilter: ["class"] });
            };
            window.__residueReset = function () {
                window.__frames = [];
                window.__longTasks = [];
                window.__marks = {};
                window.__rec = true;
                return true;
            };
            return true;
        `);
        await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

        const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", {
            type,
            touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y) }],
        });

        const box = JSON.parse(await page.eval(`
            const r = document.getElementById("messages").getBoundingClientRect();
            return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
        `));
        const cy = box.y + box.h * 0.5;

        const metrics = async () => {
            const { metrics: list } = await cdp.send("Performance.getMetrics");
            const out = {};
            for (const item of list) { out[item.name] = item.value; }
            return out;
        };
        const delta = (a, b) => {
            const d = (k) => Math.max(0, (b[k] || 0) - (a[k] || 0));
            return {
                layout: Math.round(d("LayoutDuration") * 1000),
                layouts: d("LayoutCount"),
                style: Math.round(d("RecalcStyleDuration") * 1000),
                script: Math.round(d("ScriptDuration") * 1000),
                task: Math.round(d("TaskDuration") * 1000),
            };
        };

        /** 划一趟：left = 往前划（下一个），right = 往回划（上一个）。返回这一段里的数。 */
        const swipe = async (dir) => {
            // 冷的那一趟：把要进来的那个壳的“停着”摘掉（它刚来过消息，没排好版）。
            // 摘完要等一会儿再划：浏览器是在下一次排版 / 画的时候才真把那份版丢掉，
            // 摘完就立刻划的话量出来永远是“不用排版”（这一条踩过坑）。
            if (cold) {
                await page.eval(`
                    const views = Array.from(document.querySelectorAll(".session-view"));
                    const shown = views.find(function (v) { return !v.classList.contains("off"); });
                    views.forEach(function (v) { if (v !== shown) { v.classList.remove("kept"); } });
                    return true;
                `);
                await sleep(600);
            }
            const before = await metrics();
            const t0 = Date.now();
            const from = dir === "left" ? box.x + box.w * 0.85 : box.x + box.w * 0.15;
            const to = dir === "left" ? box.x + box.w * 0.15 : box.x + box.w * 0.85;
            const steps = 18;
            if (profile) {
                await cdp.send("Profiler.enable");
                await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
                await cdp.send("Profiler.start");
            }
            // 先按下（这一段里做的活——比如给要进来的那个壳排版——人看不见，单独算一笔）
            const pressStart = Date.now();
            await touch("touchStart", from, cy);
            const pressMs = Date.now() - pressStart;
            await sleep(150);
            const afterPress = await metrics();
            // 挑此时才开始记帧与长任务：看的是“跟手那一段”卡不卡
            await page.eval(`window.__residueReset(); return true;`);
            const marks = [];
            for (let i = 1; i <= steps; i++) {
                const t = Date.now();
                await touch("touchMove", from + (to - from) * (i / steps), cy);
                marks.push(Date.now() - t);
                await sleep(16);
            }
            const dragMs = Date.now() - t0;
            // 松手：从这里开始算“真切过去”要多久
            const frames = await page.eval(`
                window.__rec = false;
                window.__marks["松手"] = performance.now();
                const f = window.__frames.slice();
                return f;
            `);
            const afterDrag = await metrics();
            const releaseStart = await page.eval(`return performance.now();`);
            await touch("touchEnd", to, cy);
            const finished = await page.eval(`
                const started = ${releaseStart};
                return new Promise(function (resolve) {
                    const messages = document.getElementById("messages");
                    function step() {
                        if (!messages.classList.contains("swiping")) {
                            resolve({ ms: Math.round(performance.now() - started), id: (document.querySelector("#messages .session-view:not(.off) .session-pane") || {dataset:{}}).dataset.sessionId });
                            return;
                        }
                        requestAnimationFrame(step);
                    }
                    requestAnimationFrame(step);
                });
            `);
            const after = await metrics();
            const longTasks = await page.eval(`return window.__longTasks || []`);
            if (profile && dir === "left") {
                const prof = (await cdp.send("Profiler.stop")).profile;
                printHotspots(prof, "整趟（按下 → 跟手 → 松手 → 切完）");
            }

            // 帧间隔：拖动这一段
            const gaps = [];
            for (let i = 1; i < frames.length; i++) { gaps.push(frames[i] - frames[i - 1]); }
            const sorted = gaps.slice().sort((a, b) => a - b);
            const median = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : 0;
            const worst = sorted.length ? Math.round(sorted[sorted.length - 1]) : 0;
            // 最长那一帧落在哪儿（从开始跟手算起，毫秒）：起手还是半路
            const worstAt = sorted.length ? Math.round(frames[gaps.indexOf(sorted[sorted.length - 1]) + 1] - frames[0]) : 0;
            return {
                dir, dragMs, frames: frames.length, median, worst, worstAt,
                over33: gaps.filter((g) => g > 33).length,
                switched: finished.id === (dir === "left" ? secondId : firstId),
                releaseMs: finished.ms,
                dragCost: delta(afterPress, afterDrag),
                pressCost: delta(before, afterPress),
                pressMs,
                releaseCost: delta(afterDrag, after),
                allCost: delta(before, after),
                longTasks,
                moveCost: marks.length ? Math.round(Math.max(...marks)) : 0,
            };
        };

        console.log("");
        console.log("=== 左右划切会话 ===");
        for (let i = 0; i < rounds; i++) {
            for (const dir of ["left", "right"]) {
                const r = await swipe(dir);
                console.log(`  往${dir === "left" ? "左（下一个）" : "右（上一个）"}：` +
                    `${r.switched ? "切过去了" : "（没切成）"}　` +
                    `拖了 ${r.dragMs} 毫秒 / ${r.frames} 帧：帧间隔中位 ${r.median} 毫秒、最长 ${r.worst} 毫秒、` +
                    `超过 33 毫秒的 ${r.over33} 帧` +
                    (r.worst > 33 ? `（最长那一帧在挪动后 ${r.worstAt} 毫秒）` : "") +
                    (r.longTasks.length ? `，长任务 ${JSON.stringify(r.longTasks)}` : "，没长任务") +
                    `\n      按下那一下（画面还没动）：${r.pressMs} 毫秒，里头排版 ${r.pressCost.layout} 毫秒，算样式 ${r.pressCost.style} 毫秒` +
                    `\n      拿着跟手这一段：排版 ${r.dragCost.layout} 毫秒/${r.dragCost.layouts} 次，算样式 ${r.dragCost.style} 毫秒，跑脚本 ${r.dragCost.script} 毫秒` +
                    `\n      松手到切完：${r.releaseMs} 毫秒（含最后那 180 毫秒滑完）：` +
                    `排版 ${r.releaseCost.layout} 毫秒/${r.releaseCost.layouts} 次，算样式 ${r.releaseCost.style} 毫秒，` +
                    `跑脚本 ${r.releaseCost.script} 毫秒，主线程忙 ${r.releaseCost.task} 毫秒` +
                    `\n      整趟总账：排版 ${r.allCost.layout} 毫秒/${r.allCost.layouts} 次，算样式 ${r.allCost.style} 毫秒，` +
                    `跑脚本 ${r.allCost.script} 毫秒，主线程忙 ${r.allCost.task} 毫秒`);
                await sleep(1200);   // 等它闲下来、把停着的那个再排好版
            }
        }

        // 后端那一圈单独量：自己发一条 switchSession（跟松手时发的是同一条），
        // 等后端回话（sessionActivated 到手）要多久，以及画面上真换过来要多久。
        console.log("");
        console.log("=== 只走一次后端那一圈（switchSession → 回话 → 画面换过来）===");
        for (let i = 0; i < rounds; i++) {
            const want = (await page.eval(`return document.querySelector("#messages .session-view:not(.off) .session-pane").dataset.sessionId`)) === firstId ? secondId : firstId;
            const r = await page.eval(`
                const want = ${JSON.stringify(want)};
                const t0 = performance.now();
                return new Promise(function (resolve) {
                    const out = { reply: 0, mounted: 0 };
                    function onMsg(e) {
                        const d = e.data;
                        if (!d || d.type !== "sessionActivated" || d.sessionId !== want) { return; }
                        window.removeEventListener("message", onMsg);
                        out.reply = Math.round(performance.now() - t0);
                        requestAnimationFrame(step);
                    }
                    function step() {
                        const pane = document.querySelector("#messages .session-view:not(.off) .session-pane");
                        if (pane && pane.dataset.sessionId === want) {
                            out.mounted = Math.round(performance.now() - t0);
                            resolve(out);
                            return;
                        }
                        requestAnimationFrame(step);
                    }
                    window.addEventListener("message", onMsg);
                    window.acquireVsCodeApi().postMessage({ type: "switchSession", sessionId: want });
                });
            `);
            console.log(`  切到${want === firstId ? "A" : "B"}：后端回话 ${r.reply} 毫秒，画面换过来 ${r.mounted} 毫秒`);
            await sleep(1200);
        }
    } finally {
        await open.close();
        await harness.stop();
    }
}

main().catch((err) => { console.error("\n出错了：" + (err?.message || err)); process.exit(1); });

/** 把一份 profile 里自己占时间最多的几处打出来（只是看主线程在哪儿花掉了）。 */
function printHotspots(profile, title) {
    if (!profile || !profile.nodes) { return; }
    const byId = new Map();
    for (const n of profile.nodes) { byId.set(n.id, n); }
    const hits = new Map();
    for (const id of profile.samples || []) { hits.set(id, (hits.get(id) || 0) + 1); }
    const rows = [];
    for (const [id, count] of hits) {
        const node = byId.get(id);
        if (!node) { continue; }
        const f = node.callFrame || {};
        const name = (f.functionName || "(匿名)") + "  " + String(f.url || "").split("/").pop() + ":" + (f.lineNumber + 1);
        rows.push({ name, count });
    }
    rows.sort((a, b) => b.count - a.count);
    console.log(`\n  —— ${title}：主线程时间最多的几处 ——`);
    for (const r of rows.slice(0, 12)) { console.log(`     ${String(r.count).padStart(5)} 次采样  ${r.name}`); }
}

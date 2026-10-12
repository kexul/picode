// @ts-nocheck
/**
 * perfProbe —— 量界面的 CPU 占用：手机尺寸 + 3 倍像素密度下，开无头浏览器跑一段，
 * 报告主线程忙了多少（TaskDuration / ScriptDuration / LayoutDuration），
 * 以及这段时间里一直在跑的动画、长任务、DOM 规模。
 *
 *   node dev/perfProbe.js                        # 空页面（打开就量，什么都不做）
 *   node dev/perfProbe.js --send 你好            # 发一句再看（配合假 pi 看流式渲染）
 *   node dev/perfProbe.js --seconds 20 --fake-pi
 *
 * 只用来查性能，不截图、不动别人的环境（后端用 PICHAT_HOME 指到 dev/.scratch）。
 */
const path = require("path");
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

/** 一段像真模型回复的内容（长文 + 几个代码块）：用来量流式渲染的开销。 */
function buildAnswer(paragraphs, codeBlocks) {
    const out = ["## 结论\n\n下面按你问的三件事分开说。\n"];
    for (let i = 0; i < paragraphs; i++) {
        out.push(`\n### ${i + 1}. 第 ${i + 1} 段说明\n\n这段文字在说一个实现细节：先看当前状态，再决定要不要改，改完把结果写回。` +
            `这里要足够长，才能看出渲染长文本时的开销（模型回复经常就是这么长）。\n`);
        if (i % 2 === 0) {
            out.push("\n- 第一点：先读取\n- 第二点：再判断\n- 第三点：最后写回\n");
        }
        for (let c = 0; c < codeBlocks; c++) {
            out.push("\n```typescript\n");
            for (let l = 0; l < 18; l++) {
                out.push(`function step${i}_${c}_${l}(input: string, count: number): string {\n`);
                out.push(`  const parts = input.split("\\n").filter((line) => line.length > ${l});\n`);
                out.push(`  return parts.slice(0, count).join("\\n");\n}\n`);
            }
            out.push("```\n");
        }
    }
    return out.join("");
}


async function metrics(cdp) {
    const { metrics: list } = await cdp.send("Performance.getMetrics");
    const out = {};
    for (const item of list) { out[item.name] = item.value; }
    return out;
}

/** 只挑我们在意的几项，算差值。 */
const KEYS = [
    "TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration",
    "LayoutCount", "RecalcStyleCount", "JSHeapUsedSize", "Nodes", "Documents",
];

async function main() {
    const argv = process.argv.slice(2);
    const arg = (name, fallback) => {
        const i = argv.indexOf("--" + name);
        return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
    };
    const flag = (name) => argv.includes("--" + name);
    const seconds = Number(arg("seconds", 15));
    const toSend = arg("send", "");
    const stream = flag("stream");
    const charsPerSec = Number(arg("chars-per-sec", 200));
    const prefill = Number(arg("prefill", 0));
    const cpuRate = Number(arg("cpu", 1));
    const scrollSwipes = Number(arg("scroll", 0));
    const batch = Number(arg("batch", 0));

    const harness = createHarness({ fakePi: flag("fake-pi") });
    const url = await harness.start();
    const open = await openPage({ url, width: 412, height: 915, timeoutMs: 60000 });
    const { page, cdp } = open;
    // 音频上下文：手机上一个�running� 的 WebAudio 会让音频通路一直通电（耗电发烫）
    const audio = [];
    try {
        cdp.on("WebAudio.contextCreated", (p) => { audio.push({ id: p.context.id, state: p.context.contextState, type: p.context.contextType }); });
        cdp.on("WebAudio.contextChanged", (p) => {
            const hit = audio.find((a) => a.id === p.context.id);
            if (hit) { hit.state = p.context.contextState; } else { audio.push({ id: p.context.id, state: p.context.contextState, type: p.context.contextType }); }
        });
        await cdp.send("WebAudio.enable");
    } catch (e) { /* 旧浏览器没有这个域就算了 */ }
    try {
        if (!flag("skip-ready")) { await page.waitReady(); }
        // 手机的样子：3 倍像素密度 + 触屏（headless 里不真的按设备像素算，但布局一样宽）
        await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: 412, height: 915, deviceScaleFactor: 3, mobile: true,
        });
        if (cpuRate > 1) { await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate }); }
        console.log(`地址：${url}  （视口 412x915 @3x，${stream ? "流式回复中" : toSend ? "发消息后" : "什么都不做"}，量 ${seconds} 秒）`);

        if (stream) {
            const answer = buildAnswer(6, 2);
            const chunk = Math.max(1, Math.round(charsPerSec * 0.025));   // 每 25 毫秒投一批
            console.log(`投流式内容：${answer.length} 个字符，每 25 毫秒一批 ${chunk} 个字符（约 ${charsPerSec} 字符/秒）`);
            await page.eval(`
                const answer = ${JSON.stringify(answer)};
                const pane = document.querySelector(".session-pane");
                const sessionId = pane.dataset.sessionId;
                const send = function (msg) {
                    window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: sessionId }, msg) }));
                };
                send({ type: "streamStart", activity: "working" });
                // 先把一段内容"一下就绪"（模拟已经流了一阵的长回复）：看长文本下每次重画的代价
                const prefill = ${prefill};
                if (prefill > 0) {
                    send({ type: "assistantDelta", delta: answer.slice(0, prefill) });
                    window.__prefilled = prefill;
                }
                let at = prefill;
                window.__streamTimer = setInterval(function () {
                    if (at >= answer.length) { return; }
                    const next = answer.slice(at, at + ${chunk});
                    at += ${chunk};
                    send({ type: "assistantDelta", delta: next });
                }, 25);
                window.__streamDone = function () {
                    if (window.__streamTimer) { clearInterval(window.__streamTimer); window.__streamTimer = 0; }
                    send({ type: "streamEnd", activity: "idle" });
                };
                return true;
            `);
            // 让它先跑一会儿再开始计数
            await sleep(3000);
        }
        if (scrollSwipes > 0) {
            // 先把一段长内容一次性投进去（像刚打开一个长会话），再像看消息那样往上滑着看
            const answer = buildAnswer(6, 2).slice(0, Math.max(4000, prefill));
            await page.eval(`
                const pane = document.querySelector(".session-pane");
                const sessionId = pane.dataset.sessionId;
                const send = function (msg) {
                    window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: sessionId }, msg) }));
                };
                send({ type: "streamStart", activity: "working" });
                send({ type: "assistantDelta", delta: ${JSON.stringify(answer)} });
                send({ type: "streamEnd", activity: "idle" });
                return true;
            `);
            await sleep(1500);
        }
        if (batch > 0) {
            // 模拟刚打开一个长会话：后端整屏重画（clear + 一条条消息）
            const one = buildAnswer(1, 1).slice(0, 2000);
            const items = [];
            for (let i = 0; i < batch; i++) {
                items.push({ type: "userMessage", text: "第 " + (i + 1) + " 轮：请解释一下这段实现。" });
                items.push({ type: "assistantFull", text: one });
            }
            const took = await page.eval(`
                const pane = document.querySelector(".session-pane");
                const sessionId = pane.dataset.sessionId;
                const send = function (msg) {
                    window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: sessionId }, msg) }));
                };
                const items = ${JSON.stringify(items)};
                const t0 = performance.now();
                send({ type: "clear" });
                for (const msg of items) { send(msg); }
                return Math.round(performance.now() - t0);
            `);
            console.log(`整屏重画 ${items.length} 条消息（约 ${Math.round(items.length * 2000 / 1024)} KB）花了 ${took} 毫秒（只算脚本，不含排版绘制）`);
            await sleep(3000);
        }
        if (toSend) { await page.send(toSend); }

        // 在页面里装一个长任务观察器（超过 50 毫秒卡顿算一条）
        await page.eval(`
            window.__longTasks = [];
            try {
                new PerformanceObserver(function (list) {
                    for (const e of list.getEntries()) { window.__longTasks.push(Math.round(e.duration)); }
                }).observe({ entryTypes: ["longtask"] });
            } catch (e) { window.__longTasks = null; }
            return true;
        `);

        await cdp.send("Performance.enable");
        // 先空转一会儿，把"刚打开的忙"和"稳定下来后的忙"分开看
        await sleep(2000);
        // 采样剖析：谁在吃 CPU（自己时间最多的那些函数）
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
        await cdp.send("Profiler.start");
        const before = await metrics(cdp);
        const animationsA = await page.eval(`
            return document.getAnimations().map(function (a) {
                const t = a.effect && a.effect.target;
                return (a.animationName || "?") + " @ " + (t && t.className ? String(t.className).slice(0, 40) : "?");
            });
        `);
        const t0 = Date.now();
        // 如果是"滑着看"：一边滑动一边量（真触摸手势，走浏览器的滚动管线）
        if (scrollSwipes > 0) {
            for (let i = 0; i < scrollSwipes; i++) {
                await cdp.send("Input.synthesizeScrollGesture", {
                    x: 206, y: 500, xDistance: 0, yDistance: i % 2 === 0 ? 1200 : -1200,
                    speed: 1200, gestureSourceType: "touch",
                });
            }
        } else {
            await sleep(seconds * 1000);
        }
        const after = await metrics(cdp);
        const longTasks = await page.eval("return window.__longTasks || []");
        const animationsB = await page.eval(`
            return document.getAnimations().map(function (a) {
                const t = a.effect && a.effect.target;
                return (a.animationName || "?") + " @ " + (t && t.className ? String(t.className).slice(0, 40) : "?");
            });
        `);
        const domInfo = await page.eval(`
            const pane = document.querySelector(".session-pane");
            return {
                nodes: document.getElementsByTagName("*").length,
                messages: document.querySelectorAll(".msg").length,
                toolCards: document.querySelectorAll(".tool").length,
                paneScrollHeight: pane ? pane.scrollHeight : 0,
                paneHeight: pane ? pane.clientHeight : 0,
            };
        `);

        const profile = (await cdp.send("Profiler.stop")).profile;
        const wall = Date.now() - t0;
        const delta = (k) => Math.max(0, (after[k] || 0) - (before[k] || 0));
        // TaskDuration 这些以秒计，墙钟以毫秒计
        const pct = (v) => ((v * 1000 / wall) * 100).toFixed(1) + "%";
        console.log("");
        console.log("=== 稳定后这 " + (wall / 1000).toFixed(1) + " 秒" + (cpuRate > 1 ? "（CPU 降速 " + cpuRate + " 倍）" : "") + " ===");
        console.log("主线程忙（TaskDuration）  ：" + pct(delta("TaskDuration")) + "   (" + (delta("TaskDuration") * 1000).toFixed(0) + " 毫秒)");
        console.log("   其中跑脚本            ：" + pct(delta("ScriptDuration")));
        console.log("   其中排版（layout）    ：" + pct(delta("LayoutDuration")));
        console.log("   其中算样式            ：" + pct(delta("RecalcStyleDuration")));
        console.log("排版次数：" + delta("LayoutCount") + "   算样式次数：" + delta("RecalcStyleCount"));
        console.log("≥50 毫秒的长任务：" + (longTasks === null ? "（这个浏览器不支持观察）" : longTasks.length + " 条 " + JSON.stringify(longTasks.slice(0, 12))));
        console.log("堆内存：" + (delta("JSHeapUsedSize") / 1048576).toFixed(1) + " MB 增量，当前 " + ((after.JSHeapUsedSize || 0) / 1048576).toFixed(1) + " MB");
        console.log("");
        console.log("DOM：" + domInfo.nodes + " 个元素，消息 " + domInfo.messages + " 条，工具卡片 " + domInfo.toolCards + " 个");
        console.log("会话窗格：" + domInfo.paneScrollHeight + " 像素内容 / " + domInfo.paneHeight + " 像素可见");
        console.log("");
        console.log("这段时间在跑的动画（开始）：" + (animationsA.length ? JSON.stringify(animationsA, null, 0) : "没有"));
        console.log("这段时间在跑的动画（结束）：" + (animationsB.length ? JSON.stringify(animationsB, null, 0) : "没有"));
        console.log("");
        console.log("音频上下文：" + (audio.length ? JSON.stringify(audio) : "（没有创建过）"));
        printHotspots(profile);
        if (stream) {
            const state = await page.eval("return { streaming: !!document.querySelector('.typing'), chars: (document.querySelector('.msg.assistant .md') || {}).textContent ? document.querySelector('.msg.assistant .md').textContent.length : 0 }");
            console.log("流式状态：" + JSON.stringify(state));
            await page.eval("window.__streamDone && window.__streamDone(); return true;");
        }
    } finally {
        await open.close();
        await harness.stop();
    }
}

main().catch((err) => { console.error("\n出错了：" + (err?.message || err)); process.exit(1); });

/** 把采样剖析里的"自己花时间最多"的函数挑出来打印。 */
function printHotspots(profile) {
    if (!profile || !profile.nodes) { return; }
    const byId = new Map();
    for (const n of profile.nodes) { byId.set(n.id, n); }
    // 统计每个节点被采样到的次数（含内联进来的子节点）
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
    const perSample = (profile.timeDeltas || []).reduce((a, b) => a + b, 0) / 1e6 / (total || 1);
    console.log("=== CPU 采样热点（共 " + total + " 个采样，每个约 " + (perSample * 1000).toFixed(2) + " 毫秒） ===");
    const seen = new Set();
    let printed = 0;
    for (const row of rows) {
        if (seen.has(row.what)) { continue; }
        seen.add(row.what);
        console.log("  " + String(((row.hits / (total || 1)) * 100).toFixed(1)).padStart(5) + "%  " + row.what);
        if (++printed >= 20) { break; }
    }
    if (!printed) { console.log("  （没有采到任何脚本执行）"); }
}

// @ts-nocheck
/**
 * switchPerf —— 量「在会话之间切换」要多久：一个装了很多条消息的会话 ↔ 一个空会话来回切。
 *
 *   node dev/switchPerf.js --pairs 400                # 造一个 400 轮的会话再量
 *   node dev/switchPerf.js --pairs 800 --rounds 5     # 多量几轮
 *
 * 两条路分开量：
 *   1. 真按快捷键（Ctrl+Alt+←/→）：走完后端一圈（界面发 switchSession → 后端推 sessionList
 *      → 再单发 sessionActivated），跟人手切一模一样；
 *   2. 只往界面里塞一条 sessionActivated：跳过网络与 sessionList，只剩「把那个会话的壳挂回去」
 *      这一步的开销。两个数的差就是后端那一圈 + sessionList 处理。
 *
 * 只用来查性能，不动别人的环境（后端用 PICHAT_HOME 指到 dev/.scratch，用假 pi）。
 */
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

async function metrics(cdp) {
    const { metrics: list } = await cdp.send("Performance.getMetrics");
    const out = {};
    for (const item of list) { out[item.name] = item.value; }
    return out;
}

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
    const pairs = Number(arg("pairs", 400));
    const rounds = Number(arg("rounds", 3));
    const bytes = Number(arg("bytes", 600));
    const css = arg("css", "");   // 试验用：临时往页面里塞一段样式（看它能不能把这件事变快）

    const flag = (name) => argv.includes("--" + name);
    const harness = createHarness({ fakePi: true, log: () => {} });
    const url = await harness.start();
    const open = await openPage({ url, width: 1280, height: 860, timeoutMs: 60000 });
    const { page, cdp } = open;
    try {
        await page.waitReady();
        const firstId = await page.eval(`return document.querySelector("#messages .session-view:not(.off) .session-pane").dataset.sessionId`);

        // 造内容：一个会话里塞 pairs 轮（用户一句 + 助手一段）
        const text = buildText(bytes);
        const injected = await page.eval(`
            const sessionId = ${JSON.stringify(firstId)};
            const send = function (msg) {
                window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: sessionId }, msg) }));
            };
            const text = ${JSON.stringify(text)};
            const t0 = performance.now();
            for (let i = 0; i < ${pairs}; i++) {
                send({ type: "userMessage", text: "第 " + (i + 1) + " 轮：请解释一下这段实现。" });
                send({ type: "assistantFull", text: text + "\\n\\n\`\`\`typescript\\nfunction step" + i + "() {\\n  return " + i + ";\\n}\\n\`\`\`\\n" });
            }
            return Math.round(performance.now() - t0);
        `);
        await sleep(2500);
        const dom = await page.eval(`
            return {
                nodes: document.getElementsByTagName("*").length,
                messages: document.querySelectorAll(".msg").length,
                paneHeight: document.querySelector(".session-view:not(.off) .session-pane").scrollHeight,
            };
        `);
        if (css) {
            await page.eval(`
                const style = document.createElement("style");
                style.textContent = ${JSON.stringify(css)};
                document.head.appendChild(style);
                return true;
            `);
            await sleep(500);
        }
        console.log(`造了 ${pairs} 轮（约 ${Math.round((text.length + 60) * pairs / 1024)} KB）：注入用 ${injected} 毫秒，` +
            `DOM ${dom.nodes} 个元素，${dom.messages} 条消息，内容高 ${dom.paneHeight} 像素`);

        // 建第二个会话（空的那个），量完再切回来
        await page.eval(`document.getElementById("newSessionBtn").click(); return true;`);
        await sleep(2000);
        const secondId = await page.eval(`return document.querySelector("#messages .session-view:not(.off) .session-pane").dataset.sessionId`);
        if (!secondId || secondId === firstId) { throw new Error("没建出第二个会话"); }

        // 页面上装两个量具：等「画面换成某个会话」、记长任务与每帧耗时
        const installMeasures = () => page.eval(`
            window.__frames = [];
            window.__longTasks = [];
            try {
                new PerformanceObserver(function (list) {
                    for (const e of list.getEntries()) { window.__longTasks.push(Math.round(e.duration)); }
                }).observe({ entryTypes: ["longtask"] });
            } catch (e) { window.__longTasks = null; }
            window.__waitSwitch = function (want) {
                return new Promise(function (resolve) {
                    const t0 = performance.now();
                    let hitAt = 0;
                    function step() {
                        const pane = document.querySelector("#messages .session-view:not(.off) .session-pane");
                        const id = pane && pane.dataset.sessionId;
                        if (!hitAt && id === want) {
                            hitAt = performance.now();
                            requestAnimationFrame(function () {
                                requestAnimationFrame(function () {
                                    resolve({ mount: Math.round(hitAt - t0), paint: Math.round(performance.now() - t0) });
                                });
                            });
                            return;
                        }
                        requestAnimationFrame(step);
                    }
                    requestAnimationFrame(step);
                });
            };
            window.__resetMeasures = function () { window.__longTasks = []; return true; };
            return true;
        `);
        await installMeasures();

        const press = (key, vk) => cdp.send("Input.dispatchKeyEvent", {
            type: "keyDown", key, code: key, modifiers: 3,
            windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        }).then(() => cdp.send("Input.dispatchKeyEvent", {
            type: "keyUp", key, code: key, modifiers: 3,
            windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        }));

        await cdp.send("Performance.enable");

        /** 真按快捷键切一次（amount: 量到的东西）。 */
        const byKey = async (dir) => {
            const cur = await page.eval(`return document.querySelector("#messages .session-view:not(.off) .session-pane").dataset.sessionId`);
            const want = cur === firstId ? secondId : firstId;
            await page.eval(`window.__resetMeasures(); window.__swp = window.__waitSwitch(${JSON.stringify(want)}); return true;`);
            const before = await metrics(cdp);
            const key = dir === "next" ? "ArrowRight" : "ArrowLeft";
            await press(key, dir === "next" ? 39 : 37);
            const res = await page.eval(`return window.__swp;`);
            res.atBottom = await page.eval(`
                const p = document.querySelector(".session-view:not(.off) .session-pane");
                return Math.round(p.scrollHeight - p.scrollTop - p.clientHeight);
            `);
            const after = await metrics(cdp);
            const lt = await page.eval(`return window.__longTasks || []`);
            const d = (k) => Math.max(0, (after[k] || 0) - (before[k] || 0));
            return {
                to: want === firstId ? "大的" : "小的",
                mount: res.mount, paint: res.paint, atBottom: res.atBottom,
                layout: Math.round(d("LayoutDuration") * 1000),
                style: Math.round(d("RecalcStyleDuration") * 1000),
                script: Math.round(d("ScriptDuration") * 1000),
                layouts: d("LayoutCount"),
                longTasks: lt,
            };
        };

        /** 只塞一条 sessionActivated（不走后端、不处理 sessionList）。 */
        const byMessage = async () => {
            const cur = await page.eval(`return document.querySelector("#messages .session-view:not(.off) .session-pane").dataset.sessionId`);
            const want = cur === firstId ? secondId : firstId;
            const res = await page.eval(`
                const want = ${JSON.stringify(want)};
                const cur = document.querySelector("#messages .session-view:not(.off) .session-pane").dataset.sessionId;
                window.__resetMeasures();
                const p = window.__waitSwitch(want);
                window.dispatchEvent(new MessageEvent("message", { data: { type: "sessionActivated", sessionId: want } }));
                return p;
            `);
            const lt = await page.eval(`return window.__longTasks || []`);
            return { to: res.mount !== undefined && want === firstId ? "大的" : "小的", mount: res.mount, paint: res.paint, longTasks: lt };
        };

        const fmt = (r) => `切到${r.to}：画面换过来 ${r.mount} 毫秒，到下一帧画完 ${r.paint} 毫秒` +
            (r.layout !== undefined ? `（排版 ${r.layout} 毫秒/${r.layouts} 次，算样式 ${r.style} 毫秒，跑脚本 ${r.script} 毫秒）` : "") +
            (r.atBottom !== undefined ? `，离底 ${r.atBottom} 像素` : "") +
            (r.longTasks && r.longTasks.length ? `，长任务 ${JSON.stringify(r.longTasks)}` : "");

        console.log("");
        console.log("=== 真按快捷键（走后端一圈）===");
        for (let i = 0; i < rounds; i++) {
            console.log("  " + fmt(await byKey("next")));
            await sleep(600);
            console.log("  " + fmt(await byKey("prev")));
            await sleep(600);
        }

        console.log("");
        console.log("=== 只塞 sessionActivated（只剩挂壳这一步）===");
        for (let i = 0; i < rounds; i++) {
            console.log("  " + fmt(await byMessage()));
            await sleep(600);
            console.log("  " + fmt(await byMessage()));
            await sleep(600);
        }

        // 说明一下这几十毫秒里谁在吃时间：切到大会话时剖一下
        const cur = await page.eval(`return document.querySelector("#messages .session-view:not(.off) .session-pane").dataset.sessionId`);
        if (cur !== firstId) { await byMessage(); await sleep(600); }
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
        await cdp.send("Profiler.start");
        await page.eval(`
            window.dispatchEvent(new MessageEvent("message", { data: { type: "sessionActivated", sessionId: ${JSON.stringify(secondId)} } }));
            return true;
        `);
        await sleep(400);
        await page.eval(`
            window.dispatchEvent(new MessageEvent("message", { data: { type: "sessionActivated", sessionId: ${JSON.stringify(firstId)} } }));
            return true;
        `);
        await sleep(900);
        const profile = (await cdp.send("Profiler.stop")).profile;
        printHotspots(profile, "切到大会话 / 切回小会话");
    } finally {
        await open.close();
        await harness.stop();
    }
}

main().catch((err) => { console.error("\n出错了：" + (err?.message || err)); process.exit(1); });

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
    console.log("");
    console.log("=== CPU 采样热点（" + title + "，共 " + total + " 个采样）===");
    const seen = new Set();
    let printed = 0;
    for (const row of rows) {
        if (seen.has(row.what)) { continue; }
        seen.add(row.what);
        console.log("  " + String(((row.hits / (total || 1)) * 100).toFixed(1)).padStart(5) + "%  " + row.what);
        if (++printed >= 20) { break; }
    }
    if (!printed) { console.log("  （没采到脚本执行：时间都花在排版/绘制上）"); }
}

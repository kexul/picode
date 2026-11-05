// @ts-nocheck
/**
 * iconAnim —— 量「输入框顶边上那颗状态图一直在转」到底吃多少 CPU。
 *
 * 四颗状态图（沙漏 / 笔 / 灯泡 / 扳手）各自慢慢动，动的只有 transform（灯泡那个是缩放，
 * 原来拿 filter: brightness 做明暗，那是每帧重画一遍，量完换成缩放了）。这份脚本就是那次的量法：
 * 同一份页面、同一轮里交替量「转着 / 停着」（不跨进程比，免得被两轮的噪声骗了）。
 *
 *   node dev/iconAnim.js                        # 412x915@3x、触屏、CPU 降 4 倍，转着 / 停着各量 3 轮
 *   node dev/iconAnim.js --seconds 15 --rounds 3
 *   node dev/iconAnim.js --act thinking         # 换一颗（waiting / writing / thinking / tool）
 *   node dev/iconAnim.js --profile 1            # 顺便报一份采样热点，看看谁在吃 CPU
 *
 * 停着那一半是把 animation 强行关掉（html.no-anim），别的条件一模一样。
 * 结论（这台机器上量的）：不转 0.03~0.11%、转着 0.29~0.65%，算样式 0~1 次、排版 0 次，
 * 采样剖面里 99.8% 是空的 —— 动画在合成层上跑，不进主线程。
 */
const { createHarness } = require("./harness.js");
const { openPage, sleep, printHotspots } = require("./cdp.js");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf("--" + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const SECONDS = Number(arg("seconds", 15));
const ROUNDS = Number(arg("rounds", 3));
const ACT = arg("act", "tool");
const PROFILE = arg("profile", "0") === "1";

/** 基线那一半：把动画停掉（真样式不动，只加这一条开关） */
const OFF_CSS = "html.no-anim #ctxTop .ct-act[data-act] { animation: none !important; }";

async function metrics(cdp) {
    const { metrics: list } = await cdp.send("Performance.getMetrics");
    const out = {};
    for (const item of list) { out[item.name] = item.value; }
    return out;
}

async function main() {
    const harness = createHarness({ fakePi: true });
    const url = await harness.start();
    const open = await openPage({ url, width: 412, height: 915, timeoutMs: 60000 });
    const { page, cdp } = open;
    try {
        await page.waitReady();
        // 手机的样子：3 倍像素密度 + 触屏 + CPU 降 4 倍（跟 perfProbe 那套一样）
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 3, mobile: true });
        try { await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }); } catch (e) { /* 旧浏览器不支持就算了 */ }
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        // 让那颗状态图挂在页面上（跑着的样子），页面上没有别的东西在动
        await page.eval(`
            const style = document.createElement("style"); style.textContent = ${JSON.stringify(OFF_CSS)};
            document.head.appendChild(style);
            document.getElementById("ctxAct").dataset.act = ${JSON.stringify(ACT)};
            document.getElementById("ctxIcon").dataset.st = "streaming";
            return true;`);
        await sleep(1500);
        await cdp.send("Performance.enable");

        const runs = [];
        for (let i = 0; i < ROUNDS; i++) {
            for (const mode of ["no-anim", "anim"]) {
                await page.eval(`document.documentElement.className = ${JSON.stringify(mode)}; return true;`);
                await sleep(400);
                const anims = await page.eval(`
                    return document.getAnimations().map(function (a) {
                        const t = a.effect && a.effect.target;
                        return (a.animationName || "?") + " @ " + (t && t.className ? String(t.className).slice(0, 40) : "?");
                    });`);
                if (PROFILE) {
                    await cdp.send("Profiler.enable");
                    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
                    await cdp.send("Profiler.start");
                }
                const before = await metrics(cdp);
                const t0 = Date.now();
                await sleep(SECONDS * 1000);
                const profile = PROFILE ? (await cdp.send("Profiler.stop")).profile : null;
                const after = await metrics(cdp);
                const wall = Date.now() - t0;
                const d = (k) => Math.max(0, (after[k] || 0) - (before[k] || 0));
                const pct = (v) => (v * 1000 / wall) * 100;
                if (profile) { printHotspots(profile, `第 ${i + 1} 轮·${mode}`); }
                runs.push({
                    mode, task: pct(d("TaskDuration")), script: pct(d("ScriptDuration")),
                    style: pct(d("RecalcStyleDuration")), layout: pct(d("LayoutDuration")),
                    layoutCount: d("LayoutCount"), styleCount: d("RecalcStyleCount"), anims,
                });
            }
        }

        console.log("");
        console.log(`=== 每一轮 ${SECONDS} 秒，CPU 降 4 倍，412x915@3x，页面上只挂着那颗「${ACT}」 ===`);
        for (const r of runs) {
            console.log(`${r.mode.padEnd(8)} 主线程 ${r.task.toFixed(2)}%  算样式 ${r.style.toFixed(2)}%` +
                `  排版 ${r.layout.toFixed(2)}%  脚本 ${r.script.toFixed(2)}%` +
                `  算样式 ${r.styleCount} 次  排版 ${r.layoutCount} 次  动画[${r.anims.join(", ")}]`);
        }
        const avg = (mode, k) => {
            const xs = runs.filter((r) => r.mode === mode).map((r) => r[k]);
            return xs.reduce((a, b) => a + b, 0) / xs.length;
        };
        console.log("");
        console.log(`不转：${avg("no-anim", "task").toFixed(2)}%   转：${avg("anim", "task").toFixed(2)}%` +
            `   差 ${(avg("anim", "task") - avg("no-anim", "task")).toFixed(2)} 个点`);
        console.log(`算样式：不转 ${avg("no-anim", "style").toFixed(2)}%  转 ${avg("anim", "style").toFixed(2)}%` +
            `   排版次数：不转 ${Math.round(avg("no-anim", "layoutCount"))}  转 ${Math.round(avg("anim", "layoutCount"))}`);
    } finally {
        await open.close();
        await harness.stop();
    }
}
main().catch((e) => { console.error("\n出错了：" + (e && e.message || e)); process.exit(1); });

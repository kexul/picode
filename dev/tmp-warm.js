// @ts-nocheck
/**
 * 临时：验证「空闲时把藏着的会话偷偷排一遍版」能不能让第一次切换也不卡。
 * 做法：造一个 1000 轮的会话，克隆出两份壳当“从没露过面的会话”，
 * 一份直接露出来（冷），一份先按预热的办法排过版再露出来（暖）。
 */
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

function buildText(bytes) {
    const base = "这段文字在说一个实现细节：先看当前状态，再决定要不要改，改完把结果写回。";
    let out = "";
    while (out.length < bytes) { out += base; }
    return out.slice(0, bytes);
}

async function main() {
    const pairs = Number(process.argv[process.argv.indexOf("--pairs") + 1] || 1000);
    const harness = createHarness({ fakePi: true, log: () => {} });
    const url = await harness.start();
    const open = await openPage({ url, width: 1200, height: 760, timeoutMs: 60000 });
    const { page } = open;
    try {
        await page.waitReady();
        const text = buildText(600);
        const big = await page.eval(`return document.querySelector("#messages .session-view:not(.off) .session-pane").dataset.sessionId`);
        await page.eval(`
            const sessionId = ${JSON.stringify(big)};
            const send = function (msg) {
                window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: sessionId }, msg) }));
            };
            const text = ${JSON.stringify(text)};
            for (let i = 0; i < ${pairs}; i++) {
                send({ type: "userMessage", text: "第 " + (i + 1) + " 轮：请解释一下这段实现。" });
                send({ type: "assistantFull", text: text });
            }
            return true;
        `);
        await sleep(2500);

        // 页面上先临时加一条“预热用的样式”，跟真实现里那段一样
        await page.eval(`
            const style = document.createElement("style");
            style.textContent = ".session-view { position: absolute; inset: 0; } .session-view.warm { visibility: hidden; pointer-events: none; }";
            document.head.appendChild(style);
            const host = document.getElementById("messages");
            window.__host = host;
            window.__real = document.querySelector("#messages .session-view:not(.off)");
            window.__cold = window.__real.cloneNode(true);
            window.__warm = window.__real.cloneNode(true);
            return true;
        `);

        const reveal = async (label, which) => {
            const res = await page.eval(`
                return new Promise(function (resolve) {
                    const host = window.__host;
                    const el = window.${which};
                    // 先把它摆成“藏着的会话”：挂在 #messages 里、盖着 .off（浏览器不排版）
                    el.classList.remove("warm");
                    el.classList.add("off");
                    if (el.parentElement !== host) { host.appendChild(el); }
                    el.offsetHeight;   // 挂上但藏着：不排版
                    requestAnimationFrame(function () { requestAnimationFrame(function () {
                        const t0 = performance.now();
                        el.classList.remove("off");
                        requestAnimationFrame(function () { requestAnimationFrame(function () {
                            el.classList.add("off");
                            el.offsetHeight;
                            requestAnimationFrame(function () { requestAnimationFrame(function () {
                                resolve(Math.round(performance.now() - t0));
                            }); });
                        }); });
                    }); });
                });
            `);
            console.log(`  ${label}：${res} 毫秒`);
        };

        const revealFromParked = async (label, which) => {
            const res = await page.eval(`
                return new Promise(function (resolve) {
                    const el = window.${which};
                    const t0 = performance.now();
                    el.classList.remove("warm");
                    requestAnimationFrame(function () { requestAnimationFrame(function () {
                        resolve(Math.round(performance.now() - t0));
                    }); });
                });
            `);
            console.log(`  ${label}：${res} 毫秒`);
        };

        const warmUp = async () => {
            const res = await page.eval(`
                return new Promise(function (resolve) {
                    const host = window.__host;
                    const el = window.__warm;
                    el.classList.remove("off");
                    el.classList.add("warm");
                    if (el.parentElement !== host) { host.appendChild(el); }
                    const t0 = performance.now();
                    requestAnimationFrame(function () { requestAnimationFrame(function () {
                        const took = Math.round(performance.now() - t0);
                        el.classList.remove("warm");
                        el.classList.add("off");
                        requestAnimationFrame(function () { requestAnimationFrame(function () {
                            resolve(took);
                        }); });
                    }); });
                });
            `);
            console.log(`  预热那一遍自己花了：${res} 毫秒`);
        };

        console.log(`（${pairs} 轮内容，两份替身都没露过面）`);
        await reveal("冷：第一次露出来", "__cold");
        await sleep(400);
        await warmUp();
        await revealFromParked("停着的会话：直接露出来（不经过 .off）", "__warm");
        await sleep(400);
        await page.eval("window.__warm.classList.add('warm'); return true;");
        await sleep(300);
        await revealFromParked("再停回去、再露出来", "__warm");
        await sleep(400);
        await page.eval("window.__warm.classList.add('warm'); return true;");
        await page.eval("const el = window.__warm; el.classList.remove('warm'); el.offsetHeight; el.classList.add('warm'); return true;");
        await revealFromParked("停着、被逼着重排一遍之后再露出来", "__warm");

        const sizes = await page.eval(`
            const out = {};
            for (const k of ["__real", "__cold", "__warm"]) {
                const el = window[k];
                const r = el.getBoundingClientRect();
                out[k] = [Math.round(r.width), Math.round(r.height), el.className];
            }
            return out;
        `);
        console.log("三份替身的尺寸/类名：", JSON.stringify(sizes));
        console.log("（尺寸相同就说明预热时用的约束跟真露出来时一致，排版结果能直接用）");
    } finally {
        await open.close();
        await harness.stop();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });

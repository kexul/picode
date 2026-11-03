// @ts-nocheck
/**
 * desktopLive —— 验「按住截图按钮不放，看这台电脑的桌面实时画面」（跑一遍就报结果，
 * 截图落在 dev/shots/）。
 *
 *   node dev/desktopLive.js
 *
 * 走的是真路：真的按住那颗按钮、真的起那支一直拍桌面的小程序（bin/live.exe）、
 * 真的把帧推到页面上画出来。验的是
 *   1. 点一下还是截一张（跟从前一样），不会顺带弹出实时画面那一层；
 *   2. 按住不放约半秒才弹那一层，里面有画面、画面一直在换、松手之后那一层还在
 *      （按住不放不是“另一次点击”）、点黑底 / 点叉 / Esc 都能收掉；
 *   3. 两块屏一起看只起一支小程序（一台机器只拍一份），关掉其中一块还在拍，全关了才停；
 *   4. 收起来以后那一支小程序真没了（别留着在后台一直拍）。
 *
 * 只能在 Windows 上跑（桌面是这台机器的真桌面）；屏幕锁着 / 没有交互桌面时第二段会红。
 */
const path = require("path");
const { execFileSync } = require("child_process");
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

let failed = 0;
function ok(text) { console.log("  ✔ " + text); }
function bad(text) { console.log("  ✘ " + text); failed += 1; }
function check(cond, text) { (cond ? ok : bad)(text); }

/** 页面上那一层现在什么状态。 */
async function liveState(page) {
    return page.eval(`
        const layer = document.getElementById("desktopLiveLayer");
        if (!layer) { return { built: false }; }
        const img = layer.querySelector("img");
        const note = layer.querySelector(".desktop-live-note");
        return {
            built: true,
            open: !layer.classList.contains("hidden"),
            naturalW: img ? img.naturalWidth : 0,
            naturalH: img ? img.naturalHeight : 0,
            hasSrc: !!(img && img.getAttribute("src")),
            noteShown: note ? note.style.display !== "none" && !!(note.textContent || "").trim() : false,
            noteText: note ? (note.textContent || "") : "",
            swaps: window.__liveSwap || 0,
        };
    `);
}

/** 开始数「画面换了几次」（盯住那张图的 src 变化）。 */
async function watchSwaps(page) {
    return page.eval(`
        window.__liveSwap = 0;
        const img = document.querySelector("#desktopLiveLayer img");
        if (!img) { return false; }
        if (window.__liveObs) { window.__liveObs.disconnect(); }
        window.__liveObs = new MutationObserver(function () { window.__liveSwap++; });
        window.__liveObs.observe(img, { attributes: true, attributeFilter: ["src"] });
        return true;
    `);
}

/** 「看文件」那一层（截图用的就是它）开着没。 */
async function lightboxOpen(page) {
    return page.eval(`
        const box = document.querySelector(".lightbox");
        return !!box && !box.classList.contains("hidden");
    `);
}

/** 那颗「📷」在屏幕上的位置。 */
async function buttonCenter(page) {
    return page.eval(`
        const b = document.getElementById("browserScreenshotBtn");
        if (!b) { return null; }
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
}

/** 真按下 / 松开鼠标（走浏览器输入，不是页面里 dispatch 一个合成事件）。 */
async function mouse(page, type, at) {
    await page.cdp.send("Input.dispatchMouseEvent", {
        type,
        x: at.x,
        y: at.y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
        pointerType: "mouse",
    });
}

/** 长按一会儿（按下去不放）。 */
async function pressAndHold(page, ms) {
    const at = await buttonCenter(page);
    if (!at) { throw new Error("页面上找不到那颗截图按钮"); }
    await mouse(page, "mousePressed", at);
    await page.sleep(ms);
    return at;
}

/** 现在有几支「一直拍桌面」的小程序在跑（没有就是 0）。 */
function liveProcessCount() {
    try {
        const text = execFileSync("tasklist", ["/FI", "IMAGENAME eq live.exe", "/NH"], { encoding: "utf8" });
        return (text.match(/live\.exe/gi) || []).length;
    } catch {
        return 0;
    }
}

/** 等一个条件成立，最多等 ms 毫秒。 */
async function waitFor(fn, ms, what) {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await fn();
        if (value) { return value; }
        if (Date.now() > deadline) { throw new Error("等超时了：" + what); }
        await sleep(150);
    }
}

async function main() {
    if (process.platform !== "win32") {
        console.log("桌面实时画面只在 Windows 上能用，这台机器上没得验。");
        return;
    }
    const harness = createHarness({ fakePi: true, log: (text) => {
        if (/实时画面|live\.exe/.test(text)) { console.log("  [日志] " + text); }
    } });
    const url = await harness.start();
    console.log("调试后端：" + url);
    const opened = [];
    const openOne = async () => {
        const { page, browser, close } = await openPage({ url, shotDir: path.join(__dirname, "shots") });
        opened.push({ page, browser, close });
        await page.waitReady();
        return page;
    };

    try {
        const a = await openOne();
        await a.sleep(500);

        // ---- 一、点一下：还是截一张，不会弹出实时画面那一层 ----
        const at = await buttonCenter(a);
        check(!!at, "输入框底下有那颗「📷」");
        await mouse(a, "mousePressed", at);
        await a.sleep(80);                       // 比“按住不放”短得多：这一次是点一下
        await mouse(a, "mouseReleased", at);
        const shotOpen = await waitFor(() => lightboxOpen(a).then((open) => open || false), 8000, "截图那张图");
        const liveAfterClick = await liveState(a);
        check(shotOpen, "点一下之后截图那张图出来了（老行为还在）");
        check(!liveAfterClick.open, "点一下没有顺带弹出实时画面那一层");
        await a.press("Escape");
        await a.sleep(300);

        // ---- 二、按住不放：弹出那一层，画面一直在换 ----
        const heldAt = await pressAndHold(a, 700);
        const opened = await waitFor(async () => (await liveState(a)).open, 3000, "实时画面那一层")
            .then(() => true, () => false);
        check(opened, "按住不放弹出了实时画面那一层");
        const firstFrame = await waitFor(async () => (await liveState(a)).hasSrc, 8000, "第一帧画面")
            .then(() => true, () => false);
        check(firstFrame, "弹出之后很快就有画面了");
        const first = await liveState(a);
        check(first.naturalW > 0 && first.naturalW <= 512 && first.naturalH <= 512,
            `画面大小在 512 以内（${first.naturalW}×${first.naturalH}）`);
        check(!(first.noteShown && /正在连/.test(first.noteText)), "第一帧到了以后「正在连」那句就收了");
        await watchSwaps(a);
        await a.sleep(1700);
        const swapped = (await liveState(a)).swaps;
        check(swapped >= 2, `画面一直在换（1.7 秒里换了 ${swapped} 次）`);
        await a.shot("live-on.png");

        await mouse(a, "mouseReleased", heldAt);
        await a.sleep(400);
        const afterRelease = await liveState(a);
        check(afterRelease.open, "松手之后那一层还在（按住不放不等于点一下）");
        check(!(await lightboxOpen(a)), "松手那一下没有顺手再截一张图");
        check(liveProcessCount() === 1, `这会儿机器上只有一支拍桌面小程序（实际 ${liveProcessCount()} 支）`);

        // ---- 三、第二块屏一起看：还是一支小程序；关掉一块还在拍 ----
        const b = await openOne();
        await b.sleep(500);
        const heldB = await pressAndHold(b, 700);
        const bHasFrame = await waitFor(async () => (await liveState(b)).hasSrc, 8000, "第二块屏的画面")
            .then(() => true, () => false);
        check(bHasFrame, "第二块屏按住不放也有画面");
        await a.sleep(600);
        check(liveProcessCount() === 1, `两块屏一起看还是一支小程序（实际 ${liveProcessCount()} 支）`);
        await b.shot("live-second-screen.png");

        // 甲那块屏点叉收起来：乙还在看，拍的那支不该停
        await a.click("#desktopLiveLayer .desktop-live-close");
        await a.sleep(600);
        const aClosed = await liveState(a);
        check(!aClosed.open, "点叉收起了甲那块屏的实时画面");
        check(liveProcessCount() === 1, `甲收了以后乙还在看，照旧在拍（实际 ${liveProcessCount()} 支）`);

        // ---- 四、Esc 收起：两支小程序也没了 ----
        await b.press("Escape");
        await b.sleep(300);
        const bClosed = await liveState(b);
        check(!bClosed.open, "按 Esc 收起了乙那块屏的实时画面");
        const gone = await waitFor(() => Promise.resolve(liveProcessCount() === 0), 4000, "拍桌面那支小程序退掉")
            .then(() => true, () => false);
        const left = liveProcessCount();
        check(gone, `没人看了以后那支小程序自己退掉了（剩 ${left} 支）`);

        // ---- 五、收起来之后那颗按钮还是老样子（点一下截一张），也能再按住不放看一次 ----
        await mouse(a, "mousePressed", at);
        await a.sleep(80);
        await mouse(a, "mouseReleased", at);
        const shotAgain = await waitFor(() => lightboxOpen(a).then((open) => open || false), 8000, "收起之后再点一下的截图")
            .then(() => true, () => false);
        check(shotAgain, "收起实时画面以后点一下照旧能截一张（那一颗没被长按弄坏）");
        await a.press("Escape");
        await a.sleep(300);

        const heldAgain = await pressAndHold(a, 700);
        const reopened = await waitFor(async () => (await liveState(a)).hasSrc, 8000, "再一次的实时画面")
            .then(() => true, () => false);
        check(reopened, "再按住不放看一次也行（小程序又起了一支）");
        await mouse(a, "mouseReleased", heldAgain);
        await a.sleep(200);
        // 点黑底也能收
        await a.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 6, y: 6, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
        await a.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 6, y: 6, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
        await a.sleep(400);
        check(!(await liveState(a)).open, "点黑底也收起了那一层");
        const gone2 = await waitFor(() => Promise.resolve(liveProcessCount() === 0), 4000, "小程序再退一次")
            .then(() => true, () => false);
        check(gone2, `收起来以后那支小程序又退了（剩 ${liveProcessCount()} 支）`);

        // ---- 六、页面报错 ----
        const errs = [...(a.pageErrors || []), ...(b.pageErrors || [])];
        check(errs.length === 0, errs.length ? "页面有报错：" + errs.slice(0, 3).join(" / ") : "两块屏都没有报错");

        if (failed) { throw new Error("桌面实时画面没验过：" + failed + " 处"); }
        console.log("\n✓ 点一下截图、按住不放看实时画面、两块屏共用一份、收起来就停，都验过了");
    } finally {
        for (const item of opened) { await item.close().catch(() => { /* 已经关了 */ }); }
        await harness.stop().catch(() => { /* 已经停了 */ });
    }
}

main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
});

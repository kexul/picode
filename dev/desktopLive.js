// @ts-nocheck
/**
 * desktopLive —— 验「按住截图按钮不放，看这台电脑的桌面实时画面」（跑一遍就报结果，
 * 截图落在 dev/shots/）。
 *
 *   node dev/desktopLive.js
 *
 * 走的是真路：真的按住那颗按钮、真的起那支一直拍桌面的小程序（bin/live.exe）、
 * 真的把帧推到页面上画出来（浏览器页面那条是直连 `/live`，一帧一段往同一张图上写）。验的是
 *   1. 点一下还是截一张（跟从前一样），不会顺带弹出实时画面那一层；
 *   2. 按住不放约半秒才弹那一层，里面有画面、画面一直在换、松手之后那一层还在
 *      （按住不放不是“另一次点击”）、点黑底 / 点叉 / Esc 都能收掉；
 *   3. 两块屏一起看只起一支小程序（一台机器只拍一份），关掉其中一块还在拍，全关了才停；
 *   4. 收起来以后那一支小程序真没了（别留着在后台一直拍）。
 *
 * 只能在 Windows 上跑（桌面是这台机器的真桌面）；屏幕锁着 / 没有交互桌面时第二段会红。
 */
const path = require("path");
const { execFileSync, spawn } = require("child_process");
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
            // “有画面了”看的是真解出来的一张图：直连那条地址一开始就有、图却要等第一帧下来
            hasPicture: !!(img && img.naturalWidth > 0),
            noteShown: note ? note.style.display !== "none" && !!(note.textContent || "").trim() : false,
            noteText: note ? (note.textContent || "") : "",
            swaps: window.__liveSwap || 0,
        };
    `);
}

/**
 * 开始数「画面换了几次」：隔一会儿把那张图上画着的像素算个和，变了就算换了一张。
 *
 * 为什么不算图的地址：浏览器页面那条是直连（`/live`，一帧一段往同一张图上写，地址从头到尾
 * 不变），面板那条才是一帧一个新地址。像素对两条路都算数。
 */
async function watchSwaps(page) {
    return page.eval(`
        window.__liveSwap = 0;
        window.__liveSig = "";
        if (window.__liveTimer) { clearInterval(window.__liveTimer); }
        window.__liveTimer = setInterval(function () {
          const img = document.querySelector("#desktopLiveLayer img");
          if (!img || !img.naturalWidth) { return; }
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let s = 0;
          for (let i = 0; i < d.length; i += 97) { s = (s * 31 + d[i]) % 1000000007; }
          if (s !== window.__liveSig) { window.__liveSig = s; window.__liveSwap++; }
        }, 100);
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

/** 按住时的反馈：按钮上是“按着”那个类吗、那圈进度是不是露着并在转。 */
async function holdState(page) {
    return page.eval(`
        const btn = document.getElementById("browserScreenshotBtn");
        const ring = btn ? btn.querySelector(".hold-ring") : null;
        // 动的是圈里那个 circle（svg 只是个框），所以动画看它
        const circle = ring ? ring.querySelector("circle") : null;
        const cs = circle ? getComputedStyle(circle) : null;
        return {
            holding: !!(btn && btn.classList.contains("holding")),
            ringOpacity: ring ? getComputedStyle(ring).opacity : null,
            ringAnimation: cs ? cs.animationName : null,
            ringDuration: cs ? cs.animationDuration : null,
        };
    `);
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

/**
 * 让桌面动一下（开一个记事本再关掉）。
 *
 * 桌面一动不动的时候小程序一帧都不发（省流量，见 src/desktopLive.ts），所以「等下一帧」
 * 可能白等：第二块屏接上时那支小程序已经在拍了，它不会为后来的人补一帧。
 */
async function nudgeDesktop() {
    let p;
    try {
        p = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
        p.unref();
    } catch {
        return;   // 起不来就算了，后面的等待会超时报红
    }
    await sleep(900);
    try { p.kill(); } catch { /* 已经关了 */ }
    await sleep(500);
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

        // ---- 一、按得快：还是截一张，不会弹出实时画面那一层；按着的时候按钮上看得见“在按” ----
        const at = await buttonCenter(a);
        check(!!at, "输入框底下有那颗「📷」");
        await mouse(a, "mousePressed", at);
        await a.sleep(150);
        const holdingShort = await holdState(a);
        check(holdingShort.holding && holdingShort.ringOpacity === "1", "按下去按钮当场有反应（压暗 + 那一圈进度露出来）");
        check(holdingShort.ringAnimation === "pichat-hold-ring" && holdingShort.ringDuration === "0.45s",
            `那一圈是按着住的时长转的（${holdingShort.ringAnimation} / ${holdingShort.ringDuration}）`);
        await a.sleep(100);                        // 一共 250ms：还不到 450ms，算点一下
        const holdingBeforeThreshold = await holdState(a);
        check(holdingBeforeThreshold.holding, "不到时间之前那一圈还在转（看得出来还没到）");
        check(!(await liveState(a)).open, "没转满的时候还没有弹出实时画面");
        await mouse(a, "mouseReleased", at);
        const shotOpen = await waitFor(() => lightboxOpen(a).then((open) => open || false), 8000, "截图那张图");
        const liveAfterClick = await liveState(a);
        check(shotOpen, "松手得早了一点：算点一下，截图那张图出来了（老行为还在）");
        check(!liveAfterClick.open, "点一下没有顺带弹出实时画面那一层");
        check(!(await holdState(a)).holding, "松手以后那一圈收了（不留在那儿一直转）");
        await a.press("Escape");
        await a.sleep(300);

        // ---- 二、按住不放：转满才弹，弹出之后画面一直在换 ----
        const heldAt = await pressAndHold(a, 200);
        check((await holdState(a)).holding, "按住不放的时候那一圈在转");
        check(!(await liveState(a)).open, "才按了 200ms，还没到（没提前弹）");
        const opened = await waitFor(async () => (await liveState(a)).open, 3000, "实时画面那一层")
            .then(() => true, () => false);
        check(opened, "按住不放弹出了实时画面那一层");
        check(!(await holdState(a)).holding, "弹出来以后那一圈收了");
        const firstFrame = await waitFor(async () => (await liveState(a)).hasPicture, 8000, "第一帧画面")
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
        await nudgeDesktop();   // 桌面不动的话乙这块屏一帧都等不到
        const bHasFrame = await waitFor(async () => (await liveState(b)).hasPicture, 8000, "第二块屏的画面")
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
        const reopened = await waitFor(async () => (await liveState(a)).hasPicture, 8000, "再一次的实时画面")
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

        // ---- 六、手机上按住不放：松手那一下不能把刚弹出来的那一层关掉 ----
        // 手指按住是 pointerdown 起算的，等那一层弹出来时手指还在屏上；松手时浏览器会在
        // 手指下面那个元素（就是刚弹出来的黑底）上补一个 click，正好撞上“点黑底就关”。
        await a.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        const touchAt = await buttonCenter(a);
        await a.cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: touchAt.x, y: touchAt.y, radiusX: 8, radiusY: 8, force: 1, id: 1 }],
        });
        // 按久一点：松手时离弹出那一刻早过了一秒，靠“刚弹出来那会儿”的时间窗口糊弄不过去
        await a.sleep(1500);
        await a.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await a.sleep(500);
        const touchReleased = await liveState(a);
        check(touchReleased.open, "手指按住 1.5 秒再松手，那一层还在（松手补的那一下 click 已经吃掉）");
        check(!/×/.test(touchReleased.noteText), "等着的那句里没有多出来的字");
        // 那一层只用来“看”，长按不该能选中里面的字（手机长按会选中，连那颗叉都会）
        const notSelectable = await a.eval(`
            const layer = document.getElementById("desktopLiveLayer");
            const close = layer.querySelector(".desktop-live-close");
            const range = document.createRange();
            range.selectNodeContents(close);
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(range);
            const captured = s.toString();
            s.removeAllRanges();
            return { userSelect: getComputedStyle(layer).userSelect, captured };
        `);
        check(notSelectable.userSelect === "none" && notSelectable.captured === "", "那一层里的字选不中（长按不会选中那颗叉）");
        // 眼睛自己点的黑底照旧能关
        await a.cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: 4, y: 4, radiusX: 8, radiusY: 8, force: 1, id: 2 }],
        });
        await a.sleep(60);
        await a.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await a.sleep(500);
        check(!(await liveState(a)).open, "手指点黑底照样收得起（吃掉的是松手那一颗，不是人点的）");
        await waitFor(() => Promise.resolve(liveProcessCount() === 0), 4000, "小程序最后再退一次").catch(() => { /* 下面那行会报 */ });
        check(liveProcessCount() === 0, `收了以后那支小程序也退了（剩 ${liveProcessCount()} 支）`);
        await a.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });

        // 系统开着“减少动画”时那一环也照转：它是这一层唯一一个“还在办事”的信号
        await a.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        const spinUnderReduce = await a.eval(`
            const layer = document.getElementById("desktopLiveLayer");
            const spin = layer.querySelector(".desktop-live-spin");
            return spin ? getComputedStyle(spin).animationName : null;
        `);
        check(spinUnderReduce === "desktop-live-spin", `系统开“减少动画”时那一环还转（${spinUnderReduce}）`);
        await a.cdp.send("Emulation.setEmulatedMedia", { features: [] });

        // ---- 七、等第一帧的时候看得见“正在连接”和前面那一环转圈 ----
        // 平时第一帧几十毫秒就到、提示一闪就收了，看不准；这一段把 `/live` 这条堵掉，
        // 一帧都到不了，提示就一直露着。
        await a.cdp.send("Network.enable");
        await a.cdp.send("Network.setBlockedURLs", { urls: ["*/live?*"] });
        const waitingAt = await pressAndHold(a, 700);
        await a.sleep(400);
        const waiting = await a.eval(`
            const layer = document.getElementById("desktopLiveLayer");
            const note = layer.querySelector(".desktop-live-note");
            const spin = layer.querySelector(".desktop-live-spin");
            return {
                open: !layer.classList.contains("hidden"),
                shown: !!note && note.style.display !== "none",
                text: note ? note.textContent.trim() : "",
                spinAnimation: spin ? getComputedStyle(spin).animationName : null,
                spinRunning: spin ? spin.getAnimations().some((x) => x.playState === "running") : false,
            };
        `);
        check(waiting.open && waiting.shown, "等第一帧的时候那句提示是露着的");
        check(waiting.text === "正在连接", `提示就写着“正在连接”（实际“${waiting.text}”）`);
        check(waiting.spinAnimation === "desktop-live-spin" && waiting.spinRunning, "提示前面那一环正在转");
        await a.shot("live-waiting.png");
        await mouse(a, "mouseReleased", waitingAt);
        await a.sleep(200);
        await a.click("#desktopLiveLayer .desktop-live-close");
        await a.sleep(400);
        await a.cdp.send("Network.setBlockedURLs", { urls: [] });

        // ---- 八、页面报错 ----
        const errs = [...(a.pageErrors || []), ...(b.pageErrors || [])];
        check(errs.length === 0, errs.length ? "页面有报错：" + errs.slice(0, 3).join(" / ") : "两块屏都没有报错");

        if (failed) { throw new Error("桌面实时画面没验过：" + failed + " 处"); }
        console.log("\n✓ 点一下截图、按住不放看实时画面、两块屏共用一份、收起来就停、手机上松手不误关、等画面时提示看得见，都验过了");
    } finally {
        for (const item of opened) { await item.close().catch(() => { /* 已经关了 */ }); }
        await harness.stop().catch(() => { /* 已经停了 */ });
    }
}

main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
});

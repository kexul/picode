// @ts-nocheck
/**
 * lightboxZoom —— 验"点开图片之后还能放大缩小"。
 *
 * 往页面里投一条带图的工具结果（假数据，不惊动模型），点开那张图，然后真的用鼠标 / 键盘走一遍：
 *   · 打开时图按窗口缩放显示，滚轮往下滚一点不缩小（1 倍是下限，缩不了别缩成一颗枣）；
 *   · 滚轮往上滚 → 放大，鼠标所指那一处在屏幕上不动（定点缩放，不是从图中心长）；
 *   · 放大后按住拖动 → 图跟着手走；
 *   · 拖动松手不算点击，这一层不会关；
 *   · 双击 → 回到刚打开的样子（scale 回 1，平移清掉）；
 *   · Esc → 关掉这一层（这条键不能顺手把正在生成的那一轮也停了）；
 *   · 没放大时点图本身 → 关（老习惯）。
 *
 *   npm run web:shot -- --width 1000 --height 760 --script dev/lightboxZoom.js
 * 图落在 dev/shots/。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/** 示例图（现生成一张，跟调试会话里那张一样）。 */
const tmpPng = path.join(os.tmpdir(), "pichat-lightbox-sample.png");
require("./makePng.js").writeSamplePng(tmpPng, 900, 600);
const PNG_BASE64 = fs.readFileSync(tmpPng).toString("base64");

/** 往页面里投一批后端消息（跟后端推给页面的形状一样）。 */
function post(page, messages) {
    return page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
}

/** 这一层现在什么状态：开着没、scale 多少、平移多少、图中心在屏幕哪儿。 */
function view(page) {
    return page.eval(`
        const box = document.querySelector(".lightbox");
        if (!box) { return { open: false }; }
        const img = box.querySelector("img");
        const r = img.getBoundingClientRect();
        return {
            open: !box.classList.contains("hidden"),
            zoomed: box.classList.contains("zoomed"),
            transform: img.style.transform || "",
            w: Math.round(r.width), h: Math.round(r.height),
            cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
            fitW: Math.round(img.naturalWidth), fitH: Math.round(img.naturalHeight),
        };
    `);
}

/** 真按一下鼠标滚轮（走浏览器输入，不是脚本里 dispatch 一个合成事件）。 */
async function wheel(page, x, y, deltaY) {
    await page.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers: 0, pointerType: "mouse",
    });
    await page.sleep(120);
}

/** 真按住拖一段（按下 → 几步移动 → 松开）。 */
async function drag(page, fromX, fromY, toX, toY) {
    const base = { button: "left", buttons: 1, clickCount: 0, pointerType: "mouse", modifiers: 0 };
    await page.cdp.send("Input.dispatchMouseEvent", Object.assign({ type: "mousePressed", x: fromX, y: fromY, clickCount: 1 }, base));
    for (let i = 1; i <= 4; i++) {
        await page.cdp.send("Input.dispatchMouseEvent", Object.assign({
            type: "mouseMoved",
            x: Math.round(fromX + (toX - fromX) * i / 4),
            y: Math.round(fromY + (toY - fromY) * i / 4),
        }, base));
        await page.sleep(40);
    }
    await page.cdp.send("Input.dispatchMouseEvent", Object.assign({ type: "mouseReleased", x: toX, y: toY, clickCount: 1 }, base));
    await page.sleep(120);
}

/**
 * 真的两根手指捏一下（走浏览器的触摸输入：从 p1/p2 挪到 q1/q2）。
 * p1、p2 是两根手指各自从哪儿起，q1、q2 是到哪儿。
 */
async function pinch(page, p1, p2, q1, q2) {
    const points = (a, b) => [
        { x: Math.round(a.x), y: Math.round(a.y), id: 1, radiusX: 12, radiusY: 12, force: 1 },
        { x: Math.round(b.x), y: Math.round(b.y), id: 2, radiusX: 12, radiusY: 12, force: 1 },
    ];
    await page.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(p1, p2) });
    for (let i = 1; i <= 5; i++) {
        const a = { x: p1.x + (q1.x - p1.x) * i / 5, y: p1.y + (q1.y - p1.y) * i / 5 };
        const b = { x: p2.x + (q2.x - p2.x) * i / 5, y: p2.y + (q2.y - p2.y) * i / 5 };
        await page.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(a, b) });
        await page.sleep(60);
    }
    await page.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.sleep(250);
}

/** 真双击一下。 */
async function doubleClick(page, x, y) {
    const base = { button: "left", pointerType: "mouse", modifiers: 0 };
    for (const clickCount of [1, 2]) {
        await page.cdp.send("Input.dispatchMouseEvent", Object.assign({ type: "mousePressed", x, y, buttons: 1, clickCount }, base));
        await page.cdp.send("Input.dispatchMouseEvent", Object.assign({ type: "mouseReleased", x, y, buttons: 0, clickCount }, base));
        await page.sleep(30);
    }
    await page.sleep(150);
}

/** 把要点的位置收进窗口里（窄窗口 / 手机上，图放大后中心早跑到窗外去了，点不到）。 */
async function safePoint(page, x, y) {
    return page.eval(`return { x: Math.min(Math.max(${Math.round(x)}, 12), innerWidth - 12),
                              y: Math.min(Math.max(${Math.round(y)}, 12), innerHeight - 12) };`);
}

/** 按住拖的起点：还得留得出 120x80 那么一段路（不然拖不动，也没啥好验的）。 */
async function dragSpot(page, x, y) {
    return page.eval(`return { x: Math.min(Math.max(${Math.round(x)}, 20), innerWidth - 160),
                              y: Math.min(Math.max(${Math.round(y)}, 20), innerHeight - 120) };`);
}

/** scale 从 transform 里读出来（没写 transform 就是 1）。 */
function scaleOf(v) {
    const m = /scale\(([\d.]+)\)/.exec(v.transform || "");
    return m ? Number(m[1]) : 1;
}

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];
    const say = (what) => console.log("  " + what);

    // ---- 投一条带图的工具结果（read 读了一张图）----
    await post(page, [
        { type: "assistantFull", text: "看图：" },
        { type: "tool", toolName: "read", args: { path: "示例图片.png" }, toolCallId: "z1" },
        {
            type: "toolResult", toolCallId: "z1", isError: false, durationMs: 80,
            resultText: "Read image file [image/png]",
            images: [{ data: PNG_BASE64, mimeType: "image/png" }],
        },
    ]);
    await page.sleep(600);
    await page.shot("zoom-1-thumb.png");

    // ---- 点开那张缩略图 ----
    await page.click(".tc-img");
    await page.sleep(400);
    let v = await view(page);
    await page.shot("zoom-2-open.png");
    say("打开：" + JSON.stringify(v));
    if (!v.open) { problems.push("点了缩略图，看图那一层没出来"); }
    if (scaleOf(v) !== 1) { problems.push("刚打开时不该已经放大：" + v.transform); }

    // ---- 往下滚：已经是最小，不该缩得更小 ----
    const cPt = await safePoint(page, v.cx, v.cy);
    await wheel(page, cPt.x, cPt.y, 400);
    let tiny = await view(page);
    if (scaleOf(tiny) !== 1) { problems.push("往下滚把图缩到 1 倍以下了：" + tiny.transform); }

    // ---- 往上滚：放大；鼠标所指那一处该稳住不动 ----
    // 挑一个明显偏离中心的点（图的左上四分之一处），好看出“定点”是不是真在哪
    const wPt = await safePoint(page, v.cx - v.w / 4, v.cy - v.h / 4);
    const px = wPt.x, py = wPt.y;
    const before = await page.eval(`
        const img = document.querySelector(".lightbox img");
        const r = img.getBoundingClientRect();
        const cx = ${px}, cy = ${py};
        // 那个屏幕点下面是图上哪个位置（按图当前尺寸换算成 0..1 的比例）
        return { u: (cx - r.left) / r.width, v: (cy - r.top) / r.height };
    `);
    await wheel(page, px, py, -300);
    await wheel(page, px, py, -300);
    v = await view(page);
    await page.shot("zoom-3-wheel.png");
    say("滚轮放大后：" + JSON.stringify(v));
    if (scaleOf(v) <= 1) { problems.push("往上滚没有放大：" + v.transform); }
    const after = await page.eval(`
        const img = document.querySelector(".lightbox img");
        const r = img.getBoundingClientRect();
        const cx = ${px}, cy = ${py};
        return { u: (cx - r.left) / r.width, v: (cy - r.top) / r.height };
    `);
    if (Math.abs(after.u - before.u) > 0.05 || Math.abs(after.v - before.v) > 0.05) {
        problems.push("缩放不是以鼠标所指那一点为定点（同一屏幕上那一点，放大前在图上的位置是 "
            + JSON.stringify(before) + "，放大后成了 " + JSON.stringify(after) + "）");
    }

    // ---- 放大后按住拖动：图跟着手走，松手不算点击（这一层不关）----
    const z = await view(page);
    const from = await dragSpot(page, z.cx, z.cy);
    await drag(page, from.x, from.y, from.x + 120, from.y + 80);
    const dragged = await view(page);
    await page.shot("zoom-4-drag.png");
    say("拖动后：" + JSON.stringify(dragged));
    if (!dragged.open) { problems.push("拖动松手把看图那一层关掉了（拖动不该算点击）"); }
    if (dragged.cx - z.cx < 80) { problems.push("拖动没让图跟着走：" + z.cx + " → " + dragged.cx); }

    // ---- 双击：回到刚打开的样子 ----
    const resetPt = await safePoint(page, dragged.cx, dragged.cy);
    await doubleClick(page, resetPt.x, resetPt.y);
    const reset = await view(page);
    await page.shot("zoom-5-reset.png");
    say("双击还原后：" + JSON.stringify(reset));
    if (scaleOf(reset) !== 1) { problems.push("双击没还原：" + reset.transform); }
    if (reset.transform) { problems.push("还原后 transform 应该清掉，图重新居中：" + reset.transform); }

    // ---- 手机上：两指捏合缩放（走真触摸输入；两指中点那一处不该跑）----
    // 手机上没滚轮，全靠这一手。用桌面无头浏览器也行：触摸事件是直接注进浏览器的。
    const mid = await safePoint(page, reset.cx, reset.cy);
    // 两指拉开多远：窄窗口里 220 像素会跑出屏外，按窗口收一下
    const far = Math.max(60, Math.min(220, Math.round(mid.x) - 16, (await page.eval("return innerWidth")) - Math.round(mid.x) - 16));
    const near = Math.min(60, Math.round(far / 2));
    const anchor = await page.eval(`
        const img = document.querySelector(".lightbox img");
        const r = img.getBoundingClientRect();
        const cx = ${mid.x}, cy = ${mid.y};
        return { u: (cx - r.left) / r.width, v: (cy - r.top) / r.height };
    `);
    await pinch(page, { x: mid.x - near, y: mid.y }, { x: mid.x + near, y: mid.y },
        { x: mid.x - far, y: mid.y }, { x: mid.x + far, y: mid.y });
    const pinched = await view(page);
    await page.shot("zoom-5b-pinch.png");
    say("两指拉开后：" + JSON.stringify(pinched));
    if (!pinched.open) { problems.push("捏合缩放松手把看图那一层关掉了（捏完不该当成点了一下）"); }
    if (scaleOf(pinched) < 1.8) { problems.push("两指拉开没有放大（间距从 " + (near * 2) + " 到 " + (far * 2) + " 像素，该放大 1.8 倍以上）：" + pinched.transform); }
    const anchored = await page.eval(`
        const img = document.querySelector(".lightbox img");
        const r = img.getBoundingClientRect();
        const cx = ${mid.x}, cy = ${mid.y};
        return { u: (cx - r.left) / r.width, v: (cy - r.top) / r.height };
    `);
    if (Math.abs(anchored.u - anchor.u) > 0.06 || Math.abs(anchored.v - anchor.v) > 0.06) {
        problems.push("双指缩放不是以两指中点为定点（放大前 " + JSON.stringify(anchor) + "，放大后 " + JSON.stringify(anchored) + "）");
    }

    // 两指合上：缩回 1 倍就停住，不缩成一颗枣
    await pinch(page, { x: mid.x - far, y: mid.y }, { x: mid.x + far, y: mid.y },
        { x: mid.x - near / 2, y: mid.y }, { x: mid.x + near / 2, y: mid.y });
    const pinchedIn = await view(page);
    await page.shot("zoom-5c-pinch-in.png");
    say("两指合上后：" + JSON.stringify(pinchedIn));
    if (!pinchedIn.open) { problems.push("两指合上之后这一层没了"); }
    if (scaleOf(pinchedIn) !== 1) { problems.push("两指合上没缩回到 1 倍（也不该缩到 1 倍以下）：" + pinchedIn.transform); }
    if (pinchedIn.transform) { problems.push("缩回 1 倍后 transform 应该清掉，图重新居中：" + pinchedIn.transform); }

    // ---- Esc：关掉这一层（而且这条键不能被永久吃掉，见最后那条探针）----
    await page.eval(`window.__escHeard = 0;
        window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented) { window.__escHeard++; } });
        return true;`);
    await page.press("Escape");
    await page.sleep(300);
    const closed = await view(page);
    const heardWhileOpen = await page.eval("return window.__escHeard");
    await page.shot("zoom-6-esc.png");
    say("Esc 之后：" + JSON.stringify(closed) + "（Esc 传到下面那些处理器的次数：" + heardWhileOpen + "）");
    if (closed.open) { problems.push("按 Esc 没关掉看图那一层"); }
    if (heardWhileOpen !== 0) { problems.push("Esc 明明被看图那一层用掉了，还传到了后面（默认动作没拦住）"); }
    // 这层关着的时候，Esc 还是原来那个 Esc（别为了关图把这条键永久拦下）
    await page.press("Escape");
    await page.sleep(300);
    const heardWhenClosed = await page.eval("return window.__escHeard");
    say("图关着时再按 Esc，传到底下的次数：" + heardWhenClosed);
    if (heardWhenClosed === 0) { problems.push("图关着的时候 Esc 传不到后面了（看图的 Esc 处理没判断开没开）"); }

    // ---- 没放大时点图本身：关（老习惯，别因为加了缩放就点不动了）----
    await page.click(".tc-img");
    await page.sleep(300);
    const again = await view(page);
    await page.eval(`const img = document.querySelector(".lightbox img");
        const r = img.getBoundingClientRect();
        img.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 }));
        return true;`);
    await page.sleep(200);
    const clicked = await view(page);
    say("再次打开 → 点图本身：" + JSON.stringify(clicked));
    if (!again.open) { problems.push("第二次点缩略图没能再打开"); }
    if (clicked.open) { problems.push("没放大的时候点图本身没关掉（老习惯丢了）"); }

    // ---- 冒烟：整页没冒错 ----
    if (problems.length) {
        console.log("\n✗ 有问题：");
        for (const p of problems) { console.log("  · " + p); }
        throw new Error("看图缩放没验过：" + problems.length + " 处");
    }
    console.log("\n✓ 滚轮缩放、两指捏合、拖动、双击还原、Esc 关闭都验过了");
};

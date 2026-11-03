// @ts-nocheck
/**
 * fileViewerBox —— 验电脑上那块「看文件的弹窗」能拖、能改大小，而且下次打开还记得。
 *
 *   npm run web:shot -- --fake-pi --width 1280 --height 800 --script dev/fileViewerBox.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的），验的是外面看得见的行为：
 *   1. 点清单里一个文件：弹窗浮在页面上（居中的一块，顶条底下、不盖顶条）；
 *   2. 拖顶上那条：整块跟着走（按在标签、按钮上不算）；
 *   3. 拖右下角那个角：大小跟着变（有最小值）；
 *   4. 刷新页面再打开同一个文件：还摆在刚才那儿、还是刚才那么大（记在这台设备里）；
 *   5. 顶上那两颗 A− / A+：只改正文的字号（一次一像素），到两头那颗按钮按下去，
 *      字号也记在这台设备里（刷新之后还是这个字号）；记着的字号要是落在能调的范围外
 *      （以前调小过、后来界面字号又改大了），不当数：正文回到跟界面字号一样大、A− 不灰；
 *   6. 手机上不出拖、改大小这两样（那一块铺满整屏）——由 dev/filePullDown.js 那一遍验。
 *
 * 测试文件现写进会话目录（dev/.scratch），那个目录不进版本库，随便造。
 */
const fs = require("fs");
const path = require("path");
const { SCRATCH_DIR } = require("./harness.js");

const FILE = "0-box.txt";

module.exports = async (page) => {
    const checks = [];
    const check = (name, pass, detail) => {
        checks.push([name, !!pass]);
        console.log((pass ? "✓ " : "✗ ") + name + (detail === undefined ? "" : "   " + detail));
    };
    const cwd = await page.eval(`return ((document.getElementById("sessionName") || {}).dataset || {}).cwd || "";`);
    const dir = cwd || SCRATCH_DIR;
    fs.writeFileSync(path.join(dir, FILE), "第 1 行\n第 2 行\n第 3 行\n", "utf8");

    /** 那一块现在在哪、多大、露没露、顶上那条能不能拖。 */
    const box = async () => JSON.parse(await page.eval(`
        const stage = document.getElementById("fileStage");
        const bar = document.getElementById("fileBar");
        const grip = document.getElementById("fileStageGrip");
        const r = stage.getBoundingClientRect();
        const barRect = bar.getBoundingClientRect();
        const topBar = document.getElementById("sessionBar").getBoundingClientRect();
        return JSON.stringify({
            shown: getComputedStyle(stage).display !== "none",
            floating: stage.classList.contains("floating"),
            left: Math.round(r.left), top: Math.round(r.top),
            w: Math.round(r.width), h: Math.round(r.height),
            barX: Math.round(barRect.left + 60), barY: Math.round(barRect.top + barRect.height / 2),
            gripX: Math.round(r.right - 8), gripY: Math.round(r.bottom - 8),
            gripShown: !!grip && getComputedStyle(grip).display !== "none",
            dragCursor: getComputedStyle(bar).cursor,
            topBarBottom: Math.round(topBar.bottom),
            stored: localStorage.getItem("pichat.fileViewerBox"),
        });
    `));

    /** 鼠标按住某个点、拖到另一个点、松手（真发到浏览器里，走的是 pointer 那套）。 */
    const dragMouse = async (x0, y0, x1, y1) => {
        await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, button: "none" });
        await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1 });
        for (let i = 1; i <= 6; i += 1) {
            await page.cdp.send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: Math.round(x0 + (x1 - x0) * i / 6),
                y: Math.round(y0 + (y1 - y0) * i / 6),
                button: "left",
            });
            await page.sleep(20);
        }
        await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1 });
        await page.sleep(250);
    };

    await page.waitReady();
    await page.sleep(600);
    await page.eval(`localStorage.removeItem("pichat.fileViewerBox"); return true;`);
    const open = await page.eval(`return document.body.classList.contains("file-open");`);
    if (!open) { await page.click("#fileSidebarBtn"); await page.sleep(700); }
    const rowClick = await page.eval(`
        const row = Array.from(document.querySelectorAll("#dirPane .file-entry"))
            .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(FILE)}; });
        if (!row) { return "没找到那一行"; }
        row.click();
        return "点了";
    `);
    await page.sleep(900);
    const first = await box();
    check("点清单里那个文件：弹窗浮在页面上、顶条底下（不盖顶条）",
        rowClick === "点了" && first.shown && first.floating && first.top >= first.topBarBottom,
        JSON.stringify({ shown: first.shown, floating: first.floating, top: first.top, topBar: first.topBarBottom }));
    check("浮着的时候顶条能拖（光标是「移动」）、右下角有那颗改大小的角",
        first.dragCursor === "move" && first.gripShown, JSON.stringify({ cursor: first.dragCursor, grip: first.gripShown }));
    await page.shot("viewerbox-1-default.png");

    // 拖顶上那条：整块跟着走（往上、往左拖：这一块本来就差不多占满高，往下没什么地方可去）
    await dragMouse(first.barX, first.barY, first.barX - 80, first.barY - 10);
    const moved = await box();
    check("拖顶上那条：整块跟着走（不是只挪一点点，也没跳）",
        Math.abs((moved.left - first.left) + 80) <= 6 && Math.abs((moved.top - first.top) + 10) <= 6,
        JSON.stringify({ dx: moved.left - first.left, dy: moved.top - first.top }));
    check("拖完那一下记进了本机", !!moved.stored, String(moved.stored));
    await page.shot("viewerbox-2-moved.png");

    // 拖右下角：大小跟着变
    await dragMouse(moved.gripX, moved.gripY, moved.gripX - 120, moved.gripY - 90);
    const resized = await box();
    check("拖右下角那个角：那一块跟着变小",
        Math.abs((moved.w - resized.w) - 120) <= 8 && Math.abs((moved.h - resized.h) - 90) <= 8,
        JSON.stringify({ dw: moved.w - resized.w, dh: moved.h - resized.h }));
    check("改大小的时候左上角不动", resized.left === moved.left && resized.top === moved.top,
        JSON.stringify({ left: resized.left, top: resized.top }));
    await page.shot("viewerbox-3-resized.png");

    // 往左上拖太多：不许跑出窗口、不许压到顶条上
    await dragMouse(resized.barX, resized.barY, 0, 0);
    const clamped = await box();
    check("拖出界也不许跑到窗口外面、不许压到顶条上",
        clamped.left >= 0 && clamped.top >= clamped.topBarBottom,
        JSON.stringify({ left: clamped.left, top: clamped.top, topBar: clamped.topBarBottom }));

    // 刷新：再打开同一个文件，还摆在刚才那儿、还是刚才那么大
    const before = await box();
    await page.eval("location.reload(); return true;");
    await page.waitReady();
    await page.sleep(1200);
    const reopened = await page.eval(`
        const open = document.body.classList.contains("file-open");
        if (!open) { document.getElementById("fileSidebarBtn").click(); }
        return open;
    `);
    await page.sleep(800);
    const rowAgain = await page.eval(`
        const row = Array.from(document.querySelectorAll("#dirPane .file-entry"))
            .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(FILE)}; });
        if (!row) { return "没找到那一行"; }
        row.click();
        return "点了";
    `);
    await page.sleep(900);
    const after = await box();
    check("刷新以后再打开：还摆在刚才那儿、还是刚才那么大",
        rowAgain === "点了" && after.shown
        && Math.abs(after.left - before.left) <= 1 && Math.abs(after.top - before.top) <= 1
        && Math.abs(after.w - before.w) <= 1 && Math.abs(after.h - before.h) <= 1,
        JSON.stringify({ before: [before.left, before.top, before.w, before.h], after: [after.left, after.top, after.w, after.h], reopened: reopened }));
    await page.shot("viewerbox-4-remembered.png");

    // 顶上那两颗字号按钮：只改正文（代码行的字号），一次一像素；到两头按下去
    const fontNow = async () => JSON.parse(await page.eval(`
        const body = document.getElementById("fileBody");
        const row = body.querySelector(".file-line .file-text") || body.querySelector(".file-line");
        const minus = document.getElementById("fileFontMinus");
        const plus = document.getElementById("fileFontPlus");
        return JSON.stringify({
            body: parseFloat(getComputedStyle(body).fontSize),
            row: row ? parseFloat(getComputedStyle(row).fontSize) : 0,
            bar: parseFloat(getComputedStyle(document.getElementById("fileBar")).fontSize),
            base: parseFloat(getComputedStyle(document.body).fontSize),
            minusShown: !!minus && getComputedStyle(minus).display !== "none",
            plusShown: !!plus && getComputedStyle(plus).display !== "none",
            minusOff: !!minus && minus.disabled,
            plusOff: !!plus && plus.disabled,
            stored: localStorage.getItem("pichat.fileViewerFont"),
        });
    `));
    const font0 = await fontNow();
    check("顶上那两颗字号的按钮在（看文件的时候露面）", font0.minusShown && font0.plusShown,
        JSON.stringify({ minus: font0.minusShown, plus: font0.plusShown }));
    await page.eval(`document.getElementById("fileFontPlus").click(); return true;`);
    await page.sleep(200);
    const font1 = await fontNow();
    check("点 A+：正文的字大了一像素（顶上那条不变）",
        Math.abs(font1.body - font0.body - 1) < 0.01 && Math.abs(font1.row - font0.row - 1) < 0.01
        && font1.bar === font0.bar,
        JSON.stringify({ body: [font0.body, font1.body], row: [font0.row, font1.row], bar: font1.bar }));
    await page.eval(`document.getElementById("fileFontMinus").click(); document.getElementById("fileFontMinus").click(); return true;`);
    await page.sleep(200);
    const font2 = await fontNow();
    check("点两下 A−：又回到原来那么大、再小一像素",
        Math.abs(font2.body - font0.body + 1) < 0.01, JSON.stringify({ body: font2.body, was: font0.body }));
    check("改过的字号记进了本机", font2.stored === String(Math.round(font2.body)), String(font2.stored));
    // 一直点到底：那颗按钮按下去，字号不再变小
    for (let i = 0; i < 20; i += 1) {
        await page.eval(`const b = document.getElementById("fileFontMinus"); if (!b.disabled) { b.click(); } return true;`);
    }
    await page.sleep(200);
    const fontMin = await fontNow();
    check("一直点 A−：到最小那头那颗按钮按下去、字号不再小",
        fontMin.minusOff && fontMin.body >= 9 && fontMin.body < font1.body,
        JSON.stringify({ body: fontMin.body, off: fontMin.minusOff }));
    await page.shot("viewerbox-5-font.png");

    // 刷新之后字号还是那个
    await page.eval("location.reload(); return true;");
    await page.waitReady();
    await page.sleep(1200);
    await page.eval(`
        if (!document.body.classList.contains("file-open")) { document.getElementById("fileSidebarBtn").click(); }
        return true;
    `);
    await page.sleep(800);
    await page.eval(`
        const row = Array.from(document.querySelectorAll("#dirPane .file-entry"))
            .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(FILE)}; });
        if (row) { row.click(); }
        return true;
    `);
    await page.sleep(900);
    const fontAfterReload = await fontNow();
    check("刷新之后再打开：字号还是刚才那个",
        Math.abs(fontAfterReload.body - fontMin.body) < 0.01,
        JSON.stringify({ before: fontMin.body, after: fontAfterReload.body }));
    await page.eval(`localStorage.removeItem("pichat.fileViewerFont"); return true;`);

    // 记着的字号落在能调的范围外（比现在能调的最小还小：以前调小过、后来界面字号又改大了）：
    // 这个数不作数，正文回到跟界面字号一样大，那颗 A− 不能一打开就灰着按不动
    // —— 以前得先按一下 A+ 才「活过来」（见 applyFileViewerFont）
    const stale = await page.eval(`
        const base = Math.round(parseFloat(getComputedStyle(document.body).fontSize) || 13);
        const stale = String(Math.max(1, base - 5));
        localStorage.setItem("pichat.fileViewerFont", stale);
        return stale;
    `);
    await page.eval("location.reload(); return true;");
    await page.waitReady();
    await page.sleep(1200);
    await page.eval(`
        if (!document.body.classList.contains("file-open")) { document.getElementById("fileSidebarBtn").click(); }
        return true;
    `);
    await page.sleep(800);
    await page.eval(`
        const row = Array.from(document.querySelectorAll("#dirPane .file-entry"))
            .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(FILE)}; });
        if (row) { row.click(); }
        return true;
    `);
    await page.sleep(900);
    const fontStale = await fontNow();
    check("记着的字号落出范围外：正文回到跟界面字号一样大、A− 不是灰的",
        Math.abs(fontStale.base - fontStale.body) < 0.01 && !fontStale.minusOff && fontStale.stored === null,
        JSON.stringify({ stale: stale, body: fontStale.body, base: fontStale.base, off: fontStale.minusOff, stored: fontStale.stored }));

    const passed = checks.filter((c) => c[1]).length;
    console.log("");
    console.log("=== 判断 ===");
    console.log("通过 " + passed + " / " + checks.length);
    if (passed !== checks.length) {
        checks.filter((c) => !c[1]).forEach((c) => console.log("  ✗ " + c[0]));
        process.exitCode = 1;
    }
};

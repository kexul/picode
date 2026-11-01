// @ts-nocheck
/**
 * filePullDown —— 验手机上「往下拉收起看文件那一块」那个手势。
 *
 *   npm run web:shot -- --fake-pi --width 420 --height 900 --script dev/filePullDown.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的），验的是外面看得见的行为：
 *   1. 手机上看一个文件：那一块铺满整屏（不是电脑上那种浮着的小窗）；
 *   2. 正文在最上头时手指往下拖：整块跟着手指往下走（有阻尼，走的路比手指短），
 *      上面浮一句「继续往下拉，收起」，拖过那条线变成「松手，收起」；
 *   3. 松手过线：那一块收起来（回对话），左边那一列没被这一下开出来；
 *   4. 不到线松手、或者拖着又推回去：那一块滑回原处，还留在文件上；
 *   5. 正文滚过一段时往下拖：不算这个手势（那是正常滚动）。
 *
 * 手指是用 CDP 的 Input.dispatchTouchEvent 真派下去的（界面里挂的就是 touch 监听）。
 * 测试文件现写进会话目录（dev/.scratch），那个目录不进版本库，随便造。
 */
const fs = require("fs");
const path = require("path");
const { SCRATCH_DIR } = require("./harness.js");

const FILE = "0-pulldown.txt";
const LINES = 200;

module.exports = async (page) => {
    const checks = [];
    const check = (name, pass, detail) => {
        checks.push([name, !!pass]);
        console.log((pass ? "✓ " : "✗ ") + name + (detail === undefined ? "" : "   " + detail));
    };
    const cwd = await page.eval(`return ((document.getElementById("sessionName") || {}).dataset || {}).cwd || "";`);
    const dir = cwd || SCRATCH_DIR;
    const lines = [];
    for (let i = 1; i <= LINES; i += 1) { lines.push("第 " + i + " 行"); }
    fs.writeFileSync(path.join(dir, FILE), lines.join("\n") + "\n", "utf8");

    /** 那一块现在什么样：下去了多少、够没够、那句话写的什么、还开着没有。 */
    const state = async () => JSON.parse(await page.eval(`
        const stage = document.getElementById("fileStage");
        const hint = document.getElementById("filePullHint");
        const hintText = hint.querySelector("span");
        const body = document.getElementById("fileBody");
        const r = stage.getBoundingClientRect();
        return JSON.stringify({
            view: document.body.classList.contains("file-view"),
            floating: stage.classList.contains("floating"),
            shown: getComputedStyle(stage).display !== "none",
            left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width),
            hintText: hintText ? (hintText.textContent || "") : "",
            hintOpacity: Number(getComputedStyle(hint).opacity),
            armed: hintText ? hintText.classList.contains("armed") : false,
            scrollTop: Math.round(body.scrollTop),
            open: document.body.classList.contains("file-open"),
            tabs: Array.from(document.querySelectorAll("#fileViewTabs .file-tab")).length,
        });
    `));
    const touch = (type, x, y) => page.cdp.send("Input.dispatchTouchEvent", {
        type: type,
        touchPoints: type === "touchEnd" ? [] : [{ x: x, y: y, id: 1 }],
    });
    /** 从正文某一点起、往下拖 dy。 */
    const pullDown = async (dy, step) => {
        const at = JSON.parse(await page.eval(`
            const r = document.getElementById("fileBody").getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 60) });
        `));
        await touch("touchStart", at.x, at.y);
        for (let d = step || 10; d <= dy; d += step || 10) {
            await touch("touchMove", at.x, at.y + d);
            await page.sleep(16);
        }
        return at;
    };
    const lift = () => touch("touchEnd", 0, 0);
    /** 在清单里点开那个文件。 */
    const openFile = () => page.eval(`
        const row = Array.from(document.querySelectorAll("#dirPane .file-entry"))
            .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(FILE)}; });
        if (!row) { return "没找到那一行"; }
        row.click();
        return "点了";
    `);

    await page.waitReady();
    await page.sleep(600);
    const open = await page.eval(`return document.body.classList.contains("file-open");`);
    if (!open) { await page.click("#fileSidebarBtn"); await page.sleep(700); }
    await page.sleep(400);
    const opened = await openFile();
    await page.sleep(900);
    const atFile = await state();
    check("手机上看一个文件：那一块铺满整屏（不是电脑上那种浮着的小窗）",
        opened === "点了" && atFile.view && atFile.shown && !atFile.floating
        && atFile.left === 0 && atFile.top === 0 && atFile.w === 420,
        JSON.stringify({ view: atFile.view, floating: atFile.floating, left: atFile.left, w: atFile.w }));

    console.log("手指往下拖 40px（还没过线）：");
    await pullDown(40);
    await page.sleep(200);
    const half = await state();
    check("整块跟着手指往下走（走的路比手指短：有阻尼）",
        half.top > 0 && half.top < 40, "那一块下去了 " + half.top + "px（手指拖了 40px）");
    check("上面那句话先写「继续往下拉，收起」",
        half.hintText === "继续往下拉，收起" && half.hintOpacity > 0.5 && !half.armed,
        JSON.stringify({ text: half.hintText, opacity: half.hintOpacity }));
    check("还没过线：弹窗还开着、还留在这个文件上", half.view && half.tabs === 1, JSON.stringify({ tabs: half.tabs }));
    await page.shot("pulldown-1-half.png");

    console.log("接着拖到 160px（过线了）：");
    await pullDown(160, 20);
    const armed = await state();
    check("过线以后那句变成「松手，收起」", armed.hintText === "松手，收起" && armed.armed === true,
        JSON.stringify({ text: armed.hintText, armed: armed.armed }));
    await page.shot("pulldown-2-armed.png");

    console.log("松手：");
    await lift();
    await page.sleep(600);
    const closed = await state();
    check("松手过线：那一块收起来、回到对话", !closed.view && !closed.shown,
        JSON.stringify({ view: closed.view, shown: closed.shown }));
    check("这一下没顺手把左边那一列开出来（它就是原来那样）", closed.open === true,
        JSON.stringify({ open: closed.open }));
    await page.shot("pulldown-3-closed.png");

    // 不到线松手：滑回原处，还留在文件上
    console.log("再点开那个文件，拖 50px 就松手：");
    await page.eval(`if (!document.body.classList.contains("file-open")) { document.getElementById("fileSidebarBtn").click(); } return true;`);
    await page.sleep(600);
    await openFile();
    await page.sleep(900);
    await pullDown(50);
    await lift();
    await page.sleep(600);
    const short = await state();
    check("不到线松手：那一块滑回原处，还留在文件上",
        short.view && short.top === 0 && short.hintText === "",
        JSON.stringify({ view: short.view, top: short.top, hint: short.hintText }));

    // 拖出去再推回来：不算数
    console.log("拖出去再推回来，然后松手：");
    const start = await pullDown(160, 20);
    for (let d = 160; d >= 0; d -= 20) {
        await touch("touchMove", start.x, start.y + d);
        await page.sleep(16);
    }
    await lift();
    await page.sleep(600);
    const pushedBack = await state();
    check("拖着又推回去：不算数，那一块滑回原处", pushedBack.view && pushedBack.top === 0,
        JSON.stringify({ view: pushedBack.view, top: pushedBack.top }));

    // 正文滚过一段：那是正常滚动
    console.log("把正文往下滚一段，再往下拖：");
    await page.eval(`document.getElementById("fileBody").scrollTop = 400; return true;`);
    await page.sleep(200);
    await pullDown(160, 20);
    const whileScrolled = await state();
    await lift();
    await page.sleep(500);
    const afterScrolled = await state();
    check("滚过一段以后往下拖不算这个手势（那一块没跟着走、也没收起）",
        whileScrolled.top === 0 && whileScrolled.hintText === "" && afterScrolled.view,
        JSON.stringify({ top: whileScrolled.top, hint: whileScrolled.hintText }));
    await page.shot("pulldown-4-scrolled.png");

    const passed = checks.filter((c) => c[1]).length;
    console.log("");
    console.log("=== 判断 ===");
    console.log("通过 " + passed + " / " + checks.length);
    if (passed !== checks.length) {
        checks.filter((c) => !c[1]).forEach((c) => console.log("  ✗ " + c[0]));
        process.exitCode = 1;
    }
};

// @ts-nocheck
/**
 * fileSwipeBack —— 验看文件时“往右划就回清单”那个手势。
 *
 *   npm run web:shot -- --fake-pi --width 420 --height 900 --script dev/fileSwipeBack.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的），验的是外面看得见的行为：
 *   1. 看一个文件、手指往右划：写着文件路径的那条横条 + 正文这一块（#fileSheet）
 *      跟着手指一起往右走（有阻尼，走的路比手指短），最上面那行标题不动；
 *   2. 左边那道缝里露出那层清单（#fileBehind，就是点 ← 会回去的那一层，长得跟真清单一样，
 *      不糊也不淡）；上面那句话先写「往右划，回清单」，划过了那条线变成「松手，回清单」；
 *   3. 松手过线：回到刚才那一层清单（横条收起来、清单那一行行出来）；
 *   4. 不到线松手、或者划出去又推回来：那一块滑回原处，还留在文件上；
 *   5. 竖着划（滚正文）：不算这个手势，那一块一点不动；
 *   6. 长行不折行、已经横着滚出去一段时往右划：那是正文自己滚回去，不算这个手势；
 *   7. 清单那一格（没在看文件）往右划：不算这个手势；
 *   8. 往左划不是回清单，还是原来那件事：把这一列收回去（跟侧边栏那条手势不打架）。
 *
 * 手指是用 CDP 的 Input.dispatchTouchEvent 真派下去的（界面里挂的就是 touch 监听）。
 * 测试文件现写进会话目录（dev/.scratch），那个目录不进版本库，随便造。
 */
const fs = require("fs");
const path = require("path");
const { SCRATCH_DIR } = require("./harness.js");

// 名字往前面排（目录里的东西多，清单只列前 500 个；会话目录里已经攒了一堆文件了）
const FILE = "0-swipe.txt";
const FILE_LINES = 200;
/** 一行长到要横着滚的：验第 6 条。 */
const WIDE_FILE = "0-swipe-wide.txt";

module.exports = async (page) => {
    const checks = [];
    const check = (name, pass, detail) => {
        checks.push([name, !!pass]);
        console.log((pass ? "✓ " : "✗ ") + name + (detail === undefined ? "" : "   " + detail));
    };
    const info = JSON.parse(await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return JSON.stringify({ cwd: document.getElementById("sessionName").dataset.cwd || "",
            sessionId: pane ? (pane.dataset.sessionId || "") : "" });
    `));
    const cwd = info.cwd || SCRATCH_DIR;
    // 文件先写好再开这一列：清单是带缓存的，开出来以后再写可能一时看不着
    const lines = [];
    for (let i = 1; i <= FILE_LINES; i += 1) { lines.push("第 " + i + " 行"); }
    fs.writeFileSync(path.join(cwd, FILE), lines.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(cwd, WIDE_FILE),
        "第一行很长：" + "长".repeat(400) + "\n" + "第二行\n" + "第三行\n", "utf8");
    console.log("测试文件写进 " + cwd);

    /** 这一片现在什么样：那一块往右挪了多少、最上面那行标题动没动、背后那层露没露、那句话写的什么。 */
    const state = async () => JSON.parse(await page.eval(`
        const sheet = document.getElementById("fileSheet");
        const stage = document.getElementById("fileStage");
        const header = document.getElementById("fileHeader");
        const behind = document.getElementById("fileBehind");
        const hint = document.getElementById("filePullHint");
        const hintText = hint.querySelector("span");
        const body = document.getElementById("fileBody");
        const stageLeft = stage.getBoundingClientRect().left;
        const behindStyle = getComputedStyle(behind);
        return JSON.stringify({
            sheetLeft: Math.round(sheet.getBoundingClientRect().left - stageLeft),
            headerLeft: Math.round(header.getBoundingClientRect().left),
            behindShown: behindStyle.display !== "none",
            behindRows: behind.querySelectorAll(".file-entry").length,
            behindHasFile: (behind.textContent || "").indexOf(${JSON.stringify(FILE)}) >= 0,
            behindBlur: parseFloat((behindStyle.filter.match(/blur\\(([\\d.]+)px\\)/) || [0, "0"])[1]),
            behindOpacity: Number(behindStyle.opacity),
            hintOpacity: Number(getComputedStyle(hint).opacity),
            hintText: hintText ? hintText.textContent : "",
            armed: hintText ? hintText.classList.contains("armed") : false,
            scrollLeft: Math.round(body.scrollLeft),
            scrollTop: Math.round(body.scrollTop),
            barShown: !document.getElementById("fileBar").hidden,
            rows: document.querySelectorAll("#dirPane .file-entry").length,
            open: document.body.classList.contains("file-open"),
            springing: document.body.classList.contains("file-pull-spring"),
        });
    `));

    /** 真派一下手指（touchEnd 时触点要留空）。 */
    const touch = (type, x, y) => page.cdp.send("Input.dispatchTouchEvent", {
        type: type,
        touchPoints: type === "touchEnd" ? [] : [{ x: x, y: y, id: 1 }],
    });
    /** 从正文某一点起、往右划 dx（分几步走，跟真手指一样）。 */
    const swipeRight = async (dx, step) => {
        const at = JSON.parse(await page.eval(`
            const r = document.getElementById("fileBody").getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.left + 30), y: Math.round(r.top + 40) });
        `));
        await touch("touchStart", at.x, at.y);
        for (let d = step || 10; d <= dx; d += step || 10) {
            await touch("touchMove", at.x + d, at.y);
            await page.sleep(16);
        }
        return at;
    };
    /** 从正文某一点起、往左划 dx。 */
    const swipeLeft = async (dx, step) => {
        const at = JSON.parse(await page.eval(`
            const r = document.getElementById("fileBody").getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.left + 300), y: Math.round(r.top + 40) });
        `));
        await touch("touchStart", at.x, at.y);
        for (let d = step || 10; d <= dx; d += step || 10) {
            await touch("touchMove", at.x - d, at.y);
            await page.sleep(16);
        }
        return at;
    };
    /** 从正文某一点起、往上划 dy（竖着滚）。 */
    const swipeUp = async (dy, step) => {
        const at = JSON.parse(await page.eval(`
            const r = document.getElementById("fileBody").getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.left + 60), y: Math.round(r.top + 300) });
        `));
        await touch("touchStart", at.x, at.y);
        for (let d = step || 10; d <= dy; d += step || 10) {
            await touch("touchMove", at.x, at.y - d);
            await page.sleep(16);
        }
        return at;
    };
    const lift = () => touch("touchEnd", 0, 0);
    /** 背后那一层是划起来才去取的：等一下它铺出来（手指按着不动的时候）。 */
    const waitBehind = async (timeoutMs) => {
        const limit = timeoutMs || 3000;
        const started = Date.now();
        let got = await state();
        while (Date.now() - started < limit && got.behindRows === 0) {
            await page.sleep(100);
            got = await state();
        }
        return got;
    };
    /** 在清单里点开一个文件（点之前先保证在清单里）。 */
    const openFile = async (name) => {
        const clicked = await page.eval(`
            const row = Array.from(document.querySelectorAll("#dirPane .file-entry"))
                .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(name)}; });
            if (!row) { return false; }
            row.click();
            return true;
        `);
        await page.sleep(900);
        return clicked;
    };

    // ==================== 一、打开一个文件 ====================
    await page.eval(`document.getElementById("fileSidebarBtn").click(); return true;`);
    await page.sleep(900);
    const openedIt = await openFile(FILE);
    const atFile = await state();
    check("清单里点开那个文件（横条露出来、正文在最左边）",
        openedIt === true && atFile.barShown && atFile.sheetLeft === 0, JSON.stringify(atFile));
    check("平时背后那一层不露面", atFile.behindShown === false, JSON.stringify(atFile));

    // ==================== 二、划着的时候是什么样 ====================
    console.log("手指往右划 40px（还没过线）：");
    await swipeRight(40);
    const half = await waitBehind();
    await page.sleep(200);
    check("写着文件路径的横条 + 正文这一块跟着往右走（走的路比手指短：有阻尼）",
        half.sheetLeft > 0 && half.sheetLeft < 40, "那一块往右挪了 " + half.sheetLeft + "px（手指划了 40px）");
    check("最上面那行标题一动不动", half.headerLeft === atFile.headerLeft,
        JSON.stringify({ before: atFile.headerLeft, now: half.headerLeft }));
    check("左边那道缝里露出一层清单（就是点 ← 会回去的那一层）",
        half.behindShown && half.behindRows > 0 && half.behindHasFile,
        JSON.stringify({ shown: half.behindShown, rows: half.behindRows }));
    check("上面那句话先写「往右划，回清单」",
        half.hintText === "往右划，回清单" && half.hintOpacity > 0.5 && !half.armed,
        JSON.stringify({ text: half.hintText, opacity: half.hintOpacity }));
    check("还没过线：背后那层清单也跟真清单一样清楚（不糊也不淡）",
        half.behindBlur === 0 && half.behindOpacity === 1,
        JSON.stringify({ blur: half.behindBlur, opacity: half.behindOpacity }));
    await page.shot("swipe-0-half.png");

    console.log("接着划到 160px（过线了）：");
    await swipeRight(160, 20);
    const armed = await state();
    check("过线以后那句变成「松手，回清单」", armed.hintText === "松手，回清单" && armed.armed === true,
        JSON.stringify({ text: armed.hintText, armed: armed.armed }));
    check("过线以后那一块已经挪出去够远了（左边那道缝宽得能让人看清是回哪儿）",
        armed.sheetLeft >= 110 && armed.behindOpacity === 1,
        JSON.stringify({ sheetLeft: armed.sheetLeft, opacity: armed.behindOpacity }));
    await page.shot("swipe-1-armed.png");

    console.log("松手：");
    await lift();
    await page.sleep(600);
    const back = await state();
    check("回到刚才那一层清单（横条收起来、清单出来了）",
        !back.barShown && back.rows > 0, JSON.stringify({ barShown: back.barShown, rows: back.rows }));
    check("那句话收干净了、那一块也回原位、背后那层藏起来",
        back.hintText === "" && back.hintOpacity === 0 && back.sheetLeft === 0 && back.behindShown === false,
        JSON.stringify({ text: back.hintText, sheetLeft: back.sheetLeft, behind: back.behindShown }));
    await page.shot("swipe-2-back-to-list.png");

    // ==================== 三、不到线松手 / 划出去又推回来 ====================
    console.log("再点开那个文件，划 50px 就松手：");
    await openFile(FILE);
    await swipeRight(50);
    await lift();
    await page.sleep(600);
    const short = await state();
    check("不到线松手：那一块滑回原处，还留在文件上",
        short.barShown && short.sheetLeft === 0 && short.hintText === "" && short.behindShown === false,
        JSON.stringify(short));

    console.log("划出去再推回来，然后松手：");
    const start = await swipeRight(140);
    for (let d = 140; d >= 0; d -= 20) {
        await touch("touchMove", start.x + d, start.y);
        await page.sleep(16);
    }
    await lift();
    await page.sleep(600);
    const pushedBack = await state();
    check("划着又推回去：不算数，那一块滑回原处", pushedBack.barShown && pushedBack.sheetLeft === 0,
        JSON.stringify({ sheetLeft: pushedBack.sheetLeft, barShown: pushedBack.barShown }));

    // ==================== 四、往左划还是收整列（不打架）====================
    console.log("往左划 200px：");
    await swipeLeft(200, 20);
    const whileLeft = await state();
    await lift();
    await page.sleep(700);
    const afterLeft = await state();
    check("往左划不是回清单：这一列整个收回去（跟原来那条手势一样）",
        whileLeft.sheetLeft === 0 && whileLeft.hintText === "" && afterLeft.open === false,
        JSON.stringify({ sheetLeft: whileLeft.sheetLeft, open: afterLeft.open }));
    check("收回去以后那个文件还开着（这一下只是收起整列，没把文件关掉）", afterLeft.barShown === true,
        JSON.stringify({ barShown: afterLeft.barShown }));

    // ==================== 五、竖着划 ====================
    console.log("再开这一列、点开文件，往上划 160px：");
    await page.eval(`document.getElementById("fileSidebarBtn").click(); return true;`);
    await page.sleep(900);
    await openFile(FILE);
    const beforeVertical = await state();
    await swipeUp(160, 20);
    const whileVertical = await state();
    await lift();
    await page.sleep(500);
    const afterVertical = await state();
    check("竖着划：那一块一点不动、那句话也不露面（那不是这个手势）",
        whileVertical.sheetLeft === 0 && whileVertical.hintText === "" && !whileVertical.behindShown,
        JSON.stringify({ sheetLeft: whileVertical.sheetLeft, text: whileVertical.hintText }));
    check("竖着划就是滚正文（内容往上走了）",
        whileVertical.scrollTop > beforeVertical.scrollTop,
        JSON.stringify({ before: beforeVertical.scrollTop, now: whileVertical.scrollTop }));
    check("竖着划完还留在文件上", afterVertical.barShown === true, JSON.stringify(afterVertical));

    // ==================== 六、长行横着滚出去一段 ====================
    console.log("回到清单，点开那个长行的文件，横着滚出去一段再往右划：");
    await page.eval(`document.getElementById("fileCloseFile").click(); return true;`);
    await page.sleep(600);
    const wideOpened = await openFile(WIDE_FILE);
    const wideAt0 = JSON.parse(await page.eval(`
        const b = document.getElementById("fileBody");
        return JSON.stringify({ canScrollX: b.scrollWidth > b.clientWidth + 4 });
    `));
    check("那个文件的长行确实要横着滚", wideOpened === true && wideAt0.canScrollX === true,
        JSON.stringify(wideAt0));
    await page.eval(`document.getElementById("fileBody").scrollLeft = 80; return true;`);
    await page.sleep(200);
    await swipeRight(160, 20);
    const whileScrolledX = await state();
    await lift();
    await page.sleep(500);
    const afterScrolledX = await state();
    check("横着滚出去一段以后往右划：那一块不动（那是正文自己滚回去）",
        whileScrolledX.sheetLeft === 0 && whileScrolledX.hintText === "",
        JSON.stringify({ sheetLeft: whileScrolledX.sheetLeft, text: whileScrolledX.hintText }));
    check("滚回去以后还留在那个文件上", afterScrolledX.barShown === true && afterScrolledX.sheetLeft === 0,
        JSON.stringify({ barShown: afterScrolledX.barShown, sheetLeft: afterScrolledX.sheetLeft }));

    // ==================== 七、清单那一格不认这个手势 ====================
    console.log("回到清单，在清单上往右划：");
    await page.eval(`document.getElementById("fileCloseFile").click(); return true;`);
    await page.sleep(600);
    const atList = await state();
    await swipeRight(160, 20);
    const listSwiped = await state();
    await lift();
    await page.sleep(500);
    const listAfter = await state();
    check("没在看文件时往右划：不算这个手势（那一列照旧开着、清单没动）",
        atList.barShown === false && listSwiped.hintText === "" && listSwiped.sheetLeft === 0
            && !listAfter.barShown && listAfter.open === true,
        JSON.stringify({ text: listSwiped.hintText, sheetLeft: listSwiped.sheetLeft, open: listAfter.open }));

    // ==================== 判断 ====================
    const passed = checks.filter((c) => c[1]).length;
    console.log("");
    console.log("=== 判断 ===");
    console.log("通过 " + passed + " / " + checks.length);
    if (passed !== checks.length) {
        checks.filter((c) => !c[1]).forEach((c) => console.log("  ✗ " + c[0]));
        process.exitCode = 1;
    }
};

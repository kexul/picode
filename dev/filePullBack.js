// @ts-nocheck
/**
 * filePullBack —— 验看文件时“往下拉就回清单”那个手势。
 *
 *   npm run web:shot -- --fake-pi --width 420 --height 900 --script dev/filePullBack.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的），验的是外面看得见的行为：
 *   1. 看一个文件、正文在最上头，手指往下拖：写着文件路径的那条横条 + 正文这一块（#fileSheet）
 *      跟着手指一起往下走（有阻尼，走的路比手指短），最上面那一行（标签条）不动；
 *   2. 上面那道缝里露出一层清单（#fileBehind，就是点 ← 会回去的那一层）：越往下拉越清楚、
 *      越实，过了那条线就全清楚；缝里先写「继续往下拉，回清单」，拖过那条线变成「松手，回清单」；
 *   3. 松手过线：回到刚才那一层清单（横条收起来、清单那一行行出来）；
 *   4. 不到线松手、或者拖着拖着又推回去：那一块滑回原处，还留在文件上；
 *   5. 正文不在最上头（往下滚过一段）时下拉：不算这个手势，还是普通滚动；
 *   6. 清单那一格（没在看文件）下拉：不算这个手势。
 *
 * 手指是用 CDP 的 Input.dispatchTouchEvent 真派下去的（界面里挂的就是 touch 监听）。
 * 测试文件现写进会话目录（dev/.scratch），那个目录不进版本库，随便造。
 */
const fs = require("fs");
const path = require("path");
const { SCRATCH_DIR } = require("./harness.js");

/** 够长，好验“往下滚过一段再拉不算”。 */
const PULL_FILE = "pull.txt";
const PULL_LINES = 200;

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
    for (let i = 1; i <= PULL_LINES; i += 1) { lines.push("第 " + i + " 行"); }
    fs.writeFileSync(path.join(cwd, PULL_FILE), lines.join("\n") + "\n", "utf8");
    console.log("测试文件写进 " + path.join(cwd, PULL_FILE));

    /** 这一片现在什么样：那一块下去了多少、标签条动没动、背后那层露没露、提示词写的什么。 */
    const state = async () => JSON.parse(await page.eval(`
        const sheet = document.getElementById("fileSheet");
        const stage = document.getElementById("fileStage");
        const header = document.getElementById("fileHeader");
        const behind = document.getElementById("fileBehind");
        const hint = document.getElementById("filePullHint");
        const body = document.getElementById("fileBody");
        const stageTop = stage.getBoundingClientRect().top;
        const behindShown = getComputedStyle(behind).display !== "none";
        const behindStyle = getComputedStyle(behind);
        return JSON.stringify({
            sheetTop: Math.round(sheet.getBoundingClientRect().top - stageTop),
            headerTop: Math.round(header.getBoundingClientRect().top),
            behindShown: behindShown,
            behindRows: behind.querySelectorAll(".file-entry").length,
            behindHasFile: (behind.textContent || "").indexOf(${JSON.stringify(PULL_FILE)}) >= 0,
            behindBlur: parseFloat((behindStyle.filter.match(/blur\\(([\\d.]+)px\\)/) || [0, "0"])[1]),
            behindOpacity: Number(behindStyle.opacity),
            hintHeight: Math.round(hint.getBoundingClientRect().height),
            hintText: hint.textContent,
            armed: hint.classList.contains("armed"),
            scrollTop: Math.round(body.scrollTop),
            barShown: !document.getElementById("fileBar").hidden,
            rows: body.querySelectorAll(".file-entry").length,
            springing: document.body.classList.contains("file-pull-spring"),
        });
    `));

    /** 真派一下手指（touchEnd 时触点要留空）。 */
    const touch = (type, x, y) => page.cdp.send("Input.dispatchTouchEvent", {
        type: type,
        touchPoints: type === "touchEnd" ? [] : [{ x: x, y: y, id: 1 }],
    });
    /** 从正文某一点起、往下拖 dy（分几步走，跟真手指一样）。 */
    const pullDown = async (dy, step) => {
        const at = JSON.parse(await page.eval(`
            const r = document.getElementById("fileBody").getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40) });
        `));
        await touch("touchStart", at.x, at.y);
        for (let d = step || 10; d <= dy; d += step || 10) {
            await touch("touchMove", at.x, at.y + d);
            await page.sleep(16);
        }
        return at;
    };
    const lift = () => touch("touchEnd", 0, 0);
    /** 背后那一层是拉起来才去取的：等一下它铺出来（拉着手不动的时候）。 */
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

    // ==================== 一、打开一个文件 ====================
    await page.eval(`document.getElementById("fileSidebarBtn").click(); return true;`);
    await page.sleep(900);
    await page.eval(`document.querySelector("#fileTabs .file-tab").click(); return true;`);
    await page.sleep(400);
    const openedIt = await page.eval(`
        const row = Array.from(document.querySelectorAll("#fileBody .file-entry"))
            .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(PULL_FILE)}; });
        if (!row) { return false; }
        row.click();
        return true;
    `);
    await page.sleep(900);
    const atFile = await state();
    check("清单里点开那个文件（横条露出来、正文在最上头）",
        openedIt === true && atFile.barShown && atFile.scrollTop === 0, JSON.stringify(atFile));
    check("平时背后那一层不露面", atFile.behindShown === false, JSON.stringify(atFile));

    // ==================== 二、拖着的时候是什么样 ====================
    console.log("手指往下拖 40px（还没过线）：");
    await pullDown(40);
    const half = await waitBehind();
    check("写着文件路径的横条 + 正文这一块跟着往下走（走的路比手指短：有阻尼）",
        half.sheetTop > 0 && half.sheetTop < 40, "那一块下去了 " + half.sheetTop + "px（手指走了 40px）");
    check("最上面那一行（标签条）一动不动", half.headerTop === atFile.headerTop,
        JSON.stringify({ before: atFile.headerTop, now: half.headerTop }));
    check("上头那道缝里露出一层清单（就是点 ← 会回去的那一层）",
        half.behindShown && half.behindRows > 0 && half.behindHasFile,
        JSON.stringify({ shown: half.behindShown, rows: half.behindRows }));
    check("缝里先写「继续往下拉，回清单」",
        half.hintText === "继续往下拉，回清单" && half.hintHeight > 0 && !half.armed,
        JSON.stringify({ text: half.hintText, h: half.hintHeight }));
    check("还没过线：背后那层清单还糊着、还淡着",
        half.behindBlur > 1 && half.behindOpacity < 0.9,
        JSON.stringify({ blur: half.behindBlur, opacity: half.behindOpacity }));
    await page.shot("pull-0-half.png");

    console.log("接着拖到 160px（过线了）：");
    await pullDown(160, 20);
    const armed = await state();
    check("过线以后那句变成「松手，回清单」", armed.hintText === "松手，回清单" && armed.armed === true,
        JSON.stringify({ text: armed.hintText, armed: armed.armed }));
    check("缝跟着手指张高（正好是那一块让出来的那截）",
        armed.hintHeight > 80 && armed.hintHeight === armed.sheetTop,
        JSON.stringify({ h: armed.hintHeight, sheetTop: armed.sheetTop }));
    check("过线以后背后那层清单全清楚了（越拉越清楚）",
        armed.behindBlur === 0 && armed.behindOpacity >= 0.99 && armed.behindBlur < half.behindBlur,
        JSON.stringify({ blur: armed.behindBlur, opacity: armed.behindOpacity, wasBlur: half.behindBlur }));
    await page.shot("pull-1-armed.png");

    console.log("松手：");
    await lift();
    await page.sleep(600);
    const back = await state();
    check("回到刚才那一层清单（横条收起来、清单出来了）",
        !back.barShown && back.rows > 0, JSON.stringify({ barShown: back.barShown, rows: back.rows }));
    check("那句话收干净了、那一块也回原位、背后那层藏起来",
        back.hintHeight === 0 && back.hintText === "" && back.sheetTop === 0 && back.behindShown === false,
        JSON.stringify({ h: back.hintHeight, sheetTop: back.sheetTop, behind: back.behindShown }));
    await page.shot("pull-2-back-to-list.png");

    // ==================== 三、不到线松手 / 推回去 ====================
    console.log("再点开那个文件，拖 50px 就松手：");
    await page.eval(`
        const row = Array.from(document.querySelectorAll("#fileBody .file-entry"))
            .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(PULL_FILE)}; });
        if (row) { row.click(); }
        return true;
    `);
    await page.sleep(900);
    await pullDown(50);
    await lift();
    await page.sleep(600);
    const short = await state();
    check("不到线松手：那一块滑回原处，还留在文件上",
        short.barShown && short.sheetTop === 0 && short.hintHeight === 0 && short.behindShown === false,
        JSON.stringify(short));

    console.log("拉出去再推回去，然后松手：");
    const start = await pullDown(140);
    for (let d = 140; d >= 0; d -= 20) {
        await touch("touchMove", start.x, start.y + d);
        await page.sleep(16);
    }
    await lift();
    await page.sleep(600);
    const pushedBack = await state();
    check("拖着又推回去：不算数，那一块滑回原处", pushedBack.barShown && pushedBack.sheetTop === 0,
        JSON.stringify(pushedBack));

    // ==================== 四、正文不在最上头 ====================
    console.log("把正文往下滚一段，再往下拖：");
    await page.eval(`document.getElementById("fileBody").scrollTop = 400; return true;`);
    await page.sleep(200);
    await pullDown(160, 20);
    const whileScrolled = await state();
    await lift();
    await page.sleep(500);
    const afterScrolled = await state();
    check("滚过一段以后下拉不算这个手势（那一块没跟着走、也没回清单）",
        whileScrolled.sheetTop === 0 && afterScrolled.barShown,
        JSON.stringify({ sheetTop: whileScrolled.sheetTop, barShown: afterScrolled.barShown }));
    check("滚过一段时那道缝、那句提示、背后那层都不露面",
        whileScrolled.hintHeight === 0 && whileScrolled.hintText === "" && !whileScrolled.behindShown,
        JSON.stringify({ h: whileScrolled.hintHeight, text: whileScrolled.hintText, behind: whileScrolled.behindShown }));

    // ==================== 五、清单那一格不认这个手势 ====================
    console.log("回到清单，在清单上往下拖：");
    await page.eval(`document.getElementById("fileCloseFile").click(); return true;`);
    await page.sleep(600);
    const atList = await state();
    await pullDown(160, 20);
    const listPulled = await state();
    await lift();
    await page.sleep(500);
    const listAfter = await state();
    check("没在看文件时下拉：不算这个手势（那一列照旧开着、清单没动）",
        atList.barShown === false && listPulled.hintHeight === 0 && listPulled.hintText === ""
            && listPulled.sheetTop === 0 && !listAfter.barShown,
        JSON.stringify({ hint: listPulled.hintHeight, sheetTop: listPulled.sheetTop, barShown: listAfter.barShown }));

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

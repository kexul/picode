// @ts-nocheck
/**
 * fileSearch —— 验「按 Ctrl+Shift+F 搜文件」那块浮层。
 *
 *   npm run web:shot -- --fake-pi --script dev/fileSearch.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的），验的是外面看得见的行为：
 *   1. 按 Ctrl+Shift+F 弹出浮层，输入框自己拿到焦点；再按一次（或 Esc）收起；
 *   2. 「文件名」那一档边打边出：命中的那几个字母标出来；回车（或点一行）在左边的文件侧边栏
 *      打开那个文件；文件侧边栏头上那颗放大镜也能开它（手机上没键盘时的入口）；
 *   3. 「内容」那一档搜文件里的文字：一条结果两行——「路径:行号」和那一行（命中处标出来）；
 *      点一条就在文件侧边栏打开、停在那一行；只在 node_modules 里的不出现，超过 2 MB 的
 *      文件不当正文搜（但它的名字照样能按名字搜到）；
 *   4. 消息流里那种只有光名字、或者路径写岔了的链接：现在也从同一份文件清单里挑
 *      （第三档，见 fileSearch.ts 的 findListedFile）——光名字找得到、写岔了找得到、
 *      只在 node_modules 里的找不到、写全了照样打得开；
 *   5. 最后一趟按「插件里的对话面板」跑（在页面脚本里先塞一个网页视图接口）：
 *      浮层还在、也还能按快捷键打开，点一条结果是给插件发 openFile（那边没有左边那一列）。
 *
 * 测试文件现写进会话目录（dev/.scratch/find/），那个目录不进版本库，随便造。
 */
const fs = require("fs");
const path = require("path");
const { SCRATCH_DIR } = require("./harness.js");

/** 测试素材（相对会话目录的写法）。 */
const FIX = {
    dir: "find",
    alpha: "find/alpha.md",
    beta: "find/beta.txt",
    gamma: "find/deep/gamma.txt",
    hidden: "find/node_modules/hidden.js",
    big: "find/big.txt",
    /** 只用来验「光名字 / 路径写岔了」那一档：名字在整个测试目录里不会撞上别的。 */
    only: "find/deep/qqonly.txt",
};
/** 内容那一档搜的那个词：alpha 与 beta 里有（big、hidden 里也有，但它们不该出现）。 */
const MARK = "青鸟标记";
const ALPHA_LINE = 2;
const ALPHA_LINES = 4;
const BETA_LINE = 3;
const BETA_LINES = 4;
const GAMMA_LINES = 3;
/** 比 `/file` 那道 2 MB 的线大出一点：内容那一档不该读它。 */
const BIG_BYTES = 2.2 * 1024 * 1024;

/** 把测试文件铺好（每次跑都重写一遍）。 */
function prepareFiles(cwd) {
    const dir = path.join(cwd, FIX.dir);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "deep"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(cwd, FIX.alpha), [
        "alpha 第 1 行",
        "alpha 里也有 " + MARK,
        "alpha 第 3 行",
        "alpha 第 4 行",
        "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(cwd, FIX.beta), [
        "beta 第 1 行",
        "beta 第 2 行",
        "beta 里也有 " + MARK,
        "beta 第 4 行",
        "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(cwd, FIX.gamma), [
        "gamma 第 1 行",
        "gamma 第 2 行",
        "gamma 第 3 行",
        "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(cwd, FIX.hidden), MARK + "（只在 node_modules 里）\n", "utf8");
    fs.writeFileSync(path.join(cwd, FIX.only), "qqonly 第 1 行\n", "utf8");
    fs.writeFileSync(path.join(cwd, FIX.big), MARK + "\n" + "x".repeat(BIG_BYTES) + "\n", "utf8");
}

module.exports = async (page) => {
    const checks = [];
    const check = (name, pass, detail) => {
        checks.push([name, !!pass]);
        console.log((pass ? "✓ " : "✗ ") + name + (detail === undefined ? "" : "   " + detail));
    };
    const info = JSON.parse(await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return JSON.stringify({
            cwd: (((document.getElementById("sessionName") || {}).dataset || {}).cwd) || "",
            sessionId: pane ? (pane.dataset.sessionId || "") : "",
        });
    `));
    check("页面上说得出会话跑在哪个目录", info.cwd !== "" && info.sessionId !== "", JSON.stringify(info));
    const cwd = info.cwd || SCRATCH_DIR;
    prepareFiles(cwd);
    console.log("测试文件写进 " + path.join(cwd, FIX.dir));

    /** 真按一下 Ctrl+Shift+F（Ctrl=2、Shift=8）。 */
    const pressSearchKey = () => page.cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown", key: "f", code: "KeyF", modifiers: 10,
        windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70,
    }).then(() => page.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "f", code: "KeyF", modifiers: 10,
        windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70,
    }));
    const pressEsc = () => page.cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    }).then(() => page.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    }));
    /** 往搜索框里敲一段字（整段替换掉现有的：先全选再插入，跟人选中后打字一样）。 */
    const typeSearch = async (text) => {
        await page.eval(`const el = document.getElementById("fileSearchInput"); el.focus(); el.select(); return true;`);
        await page.cdp.send("Input.insertText", { text });
    };
    const searchState = async () => JSON.parse(await page.eval(`
        const overlay = document.getElementById("fileSearchOverlay");
        return JSON.stringify({
            shown: !!overlay && !overlay.classList.contains("hidden"),
            focused: (document.activeElement || {}).id || "",
            mode: (document.querySelector("#fileSearchModes .fs-mode.on") || {}).id || "",
            placeholder: (document.getElementById("fileSearchInput") || {}).placeholder || "",
            rows: Array.from(document.querySelectorAll("#fileSearchBody .fs-row")).map(function (r) {
                return {
                    text: r.innerText || "",
                    marks: Array.from(r.querySelectorAll("mark")).map(function (m) { return m.textContent; }),
                    on: r.classList.contains("on"),
                };
            }),
            note: (document.querySelector("#fileSearchBody .fs-note") || {}).textContent || "",
        });
    `));
    const waitSearch = async (what, cond, timeoutMs) => {
        const limit = timeoutMs || 8000;
        const started = Date.now();
        let got = null;
        while (Date.now() - started < limit) {
            got = await searchState();
            if (cond(got)) { return got; }
            await page.sleep(150);
        }
        console.log("（等超时：" + what + "，现在这样：" + JSON.stringify(got) + "）");
        return got;
    };
    /** 左边那一列现在开着哪个文件、停在哪一行（正文里那一行有 .hit）。 */
    const openFile = async () => JSON.parse(await page.eval(`
        const page = document.querySelector("#fileBody .file-page:not([hidden])");
        const rows = page ? Array.from(page.querySelectorAll(".file-line")) : [];
        const hit = rows.find(function (r) { return r.classList.contains("hit"); });
        const name = document.querySelector("#fileBar .file-bar-name");
        return JSON.stringify({
            barName: name ? (name.textContent || "") : "",
            rowCount: rows.length,
            hitNum: hit ? (((hit.querySelector(".file-num") || {}).textContent) || "") : "",
            hitText: hit ? (hit.innerText || "") : "",
        });
    `));
    const waitOpenFile = async (what, cond, timeoutMs) => {
        const limit = timeoutMs || 8000;
        const started = Date.now();
        let got = null;
        while (Date.now() - started < limit) {
            got = await openFile();
            if (cond(got)) { return got; }
            await page.sleep(200);
        }
        console.log("（等超时：" + what + "，现在这样：" + JSON.stringify(got) + "）");
        return got;
    };

    // ==================== 一、按快捷键弹出 / 收起 ====================
    console.log("按 Ctrl+Shift+F：");
    await pressSearchKey();
    await page.sleep(500);
    const opened = await searchState();
    check("浮层弹出来了，输入框自己拿到焦点", opened.shown && opened.focused === "fileSearchInput",
        JSON.stringify({ shown: opened.shown, focused: opened.focused }));
    check("默认是「文件名」那一档", opened.mode === "fsModeFiles" && opened.placeholder.indexOf("文件名") >= 0,
        opened.mode + " / " + opened.placeholder);
    check("空着先把文件列出来（不是空白一张）", opened.rows.length > 0, String(opened.rows.length));
    await page.shot("search-1-open.png");

    console.log("再按一次 Ctrl+Shift+F：");
    await pressSearchKey();
    await page.sleep(250);
    check("再按一次收起来了", !(await searchState()).shown);

    console.log("打开后按 Esc：");
    await pressSearchKey();
    await page.sleep(300);
    await pressEsc();
    await page.sleep(250);
    check("Esc 也收起来", !(await searchState()).shown);

    // ==================== 二、按文件名找 ====================
    console.log("搜文件名 gamma：");
    await pressSearchKey();
    await page.sleep(400);
    await typeSearch("gamma");
    const named = await waitSearch("按名字搜到 gamma", (s) => s.rows.some((r) => r.text.indexOf("find/deep/gamma.txt") >= 0));
    const gammaRow = named.rows.find((r) => r.text.indexOf("find/deep/gamma.txt") >= 0);
    check("按文件名搜到子目录里的那个文件", !!gammaRow, JSON.stringify(named.rows.slice(0, 4)));
    check("命中的那几个字母标出来了", !!gammaRow && gammaRow.marks.join("").toLowerCase() === "gamma",
        gammaRow ? JSON.stringify(gammaRow.marks) : "");
    await page.shot("search-2-name.png");

    console.log("回车打开第一条：");
    await page.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    const openedGamma = await waitOpenFile("gamma.md 在左边打开", (x) => x.barName === FIX.gamma && x.rowCount === GAMMA_LINES);
    check("回车那一下在左边的文件侧边栏打开那个文件",
        openedGamma.barName === FIX.gamma && openedGamma.rowCount === GAMMA_LINES, JSON.stringify(openedGamma));
    check("打开以后浮层自己收起来", !(await searchState()).shown);
    await page.shot("search-3-open-gamma.png");

    // ==================== 三、按内容找 ====================
    console.log("换到「内容」那一档，搜 " + MARK + "：");
    await pressSearchKey();
    await page.sleep(400);
    await page.click("#fsModeText");
    await page.sleep(250);
    check("切到「内容」那一档（输入框里的提示也跟着换）",
        (await searchState()).placeholder.indexOf("文字") >= 0);
    await typeSearch(MARK);
    const found = await waitSearch("内容里搜到 beta.txt", (s) => s.rows.some((r) => r.text.indexOf(FIX.beta) >= 0));
    const betaRow = found.rows.find((r) => r.text.indexOf(FIX.beta) >= 0);
    const alphaRow = found.rows.find((r) => r.text.indexOf(FIX.alpha) >= 0);
    check("内容那一档搜到了 beta.txt 与 alpha.md", !!betaRow && !!alphaRow,
        JSON.stringify(found.rows.map((r) => r.text.split("\n")[0])));
    check("一条结果两行：先写「路径:行号」", !!betaRow && betaRow.text.split("\n")[0] === FIX.beta + ":" + BETA_LINE,
        betaRow ? JSON.stringify(betaRow.text) : "");
    check("第二行是那一行文字（命中处标出来）",
        !!betaRow && betaRow.text.indexOf("beta 里也有 " + MARK) >= 0 && betaRow.marks.indexOf(MARK) >= 0,
        betaRow ? JSON.stringify({ text: betaRow.text, marks: betaRow.marks }) : "");
    check("只在 node_modules 里的那份不出现（两档都不进去）",
        found.rows.every((r) => r.text.indexOf("node_modules") < 0),
        JSON.stringify(found.rows.map((r) => r.text.split("\n")[0])));
    check("超过 2 MB 的文件不当正文搜（big.txt 不出现）",
        found.rows.every((r) => r.text.indexOf(FIX.big) < 0),
        JSON.stringify(found.rows.map((r) => r.text.split("\n")[0])));
    await page.shot("search-4-text.png");

    console.log("点 beta.txt 那一条：");
    await page.eval(`
        const want = ${JSON.stringify(FIX.beta)};
        const row = Array.from(document.querySelectorAll("#fileSearchBody .fs-row"))
            .find(function (r) { return (r.innerText || "").indexOf(want) === 0; });
        if (!row) { return false; }
        row.click();
        return true;
    `);
    const openedBeta = await waitOpenFile("beta.txt 在左边打开", (x) => x.barName === FIX.beta && x.rowCount === BETA_LINES);
    check("点一条内容结果：在左边打开那个文件", openedBeta.barName === FIX.beta && openedBeta.rowCount === BETA_LINES,
        JSON.stringify(openedBeta));
    check("停在那条结果说的那一行", openedBeta.hitNum === String(BETA_LINE) && openedBeta.hitText.indexOf(MARK) >= 0,
        JSON.stringify({ hit: openedBeta.hitNum, text: openedBeta.hitText }));
    await page.shot("search-5-open-beta.png");

    // 名字那一档也还认大文件的名字（只是不读它的内容）
    await pressSearchKey();
    await page.sleep(300);
    await page.click("#fsModeFiles");
    await typeSearch("big.txt");
    const bigNamed = await waitSearch("按名字搜到 big.txt", (s) => s.rows.some((r) => r.text.indexOf(FIX.big) >= 0));
    check("超过 2 MB 的文件按名字照样搜得到", bigNamed.rows.some((r) => r.text.indexOf(FIX.big) >= 0),
        JSON.stringify(bigNamed.rows.map((r) => r.text)));
    await pressEsc();
    await page.sleep(200);

    // ==================== 四、放大镜入口（手机上没键盘） ====================
    console.log("点文件侧边栏头上那颗放大镜：");
    await page.eval(`document.getElementById("fileSearchBtn").click(); return true;`);
    await page.sleep(400);
    check("放大镜也能把搜索浮层开出来", (await searchState()).shown);
    await pressEsc();
    await page.sleep(200);

    // ==================== 五、光名字 / 路径写岔了：也从这份文件清单里挑 ====================
    // 直接打那条只读文件地址：第三档现在用的是跟搜索同一份清单（findListedFile）。
    const fileRequest = (wantPath) => page.eval(`
        return fetch("/file?session=" + encodeURIComponent(${JSON.stringify(info.sessionId)})
            + "&path=" + encodeURIComponent(${JSON.stringify(wantPath)}))
            .then(function (r) { return r.text().then(function (t) { return JSON.stringify({ status: r.status, body: t.slice(0, 200) }); }); });
    `).then((text) => JSON.parse(text));
    const bare = await fileRequest("qqonly.txt");
    check("链接里只有光名字：从文件清单里挑到它", bare.status === 200 && bare.body.indexOf("qqonly 第 1 行") >= 0,
        JSON.stringify(bare));
    const wrongDir = await fileRequest("somewhere/qqonly.txt");
    check("路径写岔了（那个目录不存在）：也按名字挑到它",
        wrongDir.status === 200 && wrongDir.body.indexOf("qqonly 第 1 行") >= 0, JSON.stringify(wrongDir));
    const hiddenByName = await fileRequest("hidden.js");
    check("只在 node_modules 里有的名字：清单里没有它，按找不到算", hiddenByName.status === 404,
        String(hiddenByName.status));
    const hiddenExact = await fileRequest(FIX.hidden);
    check("写全了照样打得开（写全的那一档不受清单管）",
        hiddenExact.status === 200 && hiddenExact.body.indexOf(MARK) >= 0, String(hiddenExact.status));

    // ==================== 六、插件里的对话面板那一趟 ====================
    // 在页面脚本里先塞一个网页视图接口（真 VSCode 里本来就有这个函数），界面就会按
    // 「插件里的对话面板」那套跑起来；然后重新加载页面看区别。这一段摆在最后。
    console.log("按插件里的对话面板再跑一遍：");
    await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
            window.__sentToHost = [];
            window.acquireVsCodeApi = function () {
                return {
                    postMessage: function (m) { window.__sentToHost.push(m); },
                    getState: function () { return null; },
                    setState: function () {},
                };
            };
        `,
    });
    await page.eval("location.reload(); return true;");
    await page.sleep(1600);
    check("插件里的对话面板里没有左边那一列", (await page.eval(`return !document.getElementById("fileSidebar")`)) === true);
    await pressSearchKey();
    await page.sleep(400);
    const panelOpen = await searchState();
    check("插件里的对话面板里也按得开搜索浮层", panelOpen.shown && panelOpen.focused === "fileSearchInput");
    const asked = JSON.parse(await page.eval(`
        const list = (window.__sentToHost || []).filter(function (m) { return m && m.type === "findFiles"; });
        return JSON.stringify(list.length ? list[list.length - 1] : null);
    `));
    check("浮层一开就向后端要了一份文件清单", !!asked && asked.mode === "files", JSON.stringify(asked));
    // 后端那份回话（这里没有真后端，自己喂一条）：演一遍画结果、点一条。
    await page.eval(`
        window.postMessage({
            type: "findResults", seq: ${JSON.stringify(asked ? asked.seq : 0)}, mode: "files", query: ${JSON.stringify(asked ? asked.query : "")},
            files: ${JSON.stringify([FIX.gamma, FIX.beta])}, hits: [],
        }, "*");
        return true;
    `);
    await page.sleep(300);
    const panelRows = (await searchState()).rows;
    check("结果画得出来", panelRows.length === 2 && panelRows[0].text.indexOf(FIX.gamma) >= 0,
        JSON.stringify(panelRows.map((r) => r.text)));
    await page.eval(`
        const row = document.querySelector("#fileSearchBody .fs-row");
        if (row) { row.click(); }
        return true;
    `);
    await page.sleep(300);
    const sent = JSON.parse(await page.eval(`
        return JSON.stringify((window.__sentToHost || []).filter(function (m) { return m && m.type === "openFile"; }));
    `));
    check("点一条结果是交给编辑器打开（跟那边点正文里的文件链接一样）",
        sent.length === 1 && sent[0].path === FIX.gamma && sent[0].line === 0, JSON.stringify(sent));
    await page.shot("search-6-webview.png");

    const failed = checks.filter((c) => !c[1]).map((c) => c[0]);
    console.log("\n=== 判断 ===");
    console.log("通过 " + (checks.length - failed.length) + " / " + checks.length);
    if (failed.length) { throw new Error("有 " + failed.length + " 项没通过：\n  - " + failed.join("\n  - ")); }
};

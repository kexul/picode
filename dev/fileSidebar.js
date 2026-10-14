// @ts-nocheck
/**
 * fileSidebar —— 验「点消息流里的文件链接，左边开出一列看文件」。
 *
 *   npm run web:shot -- --fake-pi --script dev/fileSidebar.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的），验的是外面看得见的行为：
 *   1. 往页面里投带文件链接的假消息（照 dev/toolRow.js 的做法），点它，读左边那一列的 DOM：
 *      文件内容、行号、停在链接说的那一行并高亮；看过的文件在面板头上排成一排标签——
 *      点另一个文件新开一个标签、原来那个还留着，点已经开着的文件切回那个标签并按这次
 *      链接说的行滚过去（不新开重复标签），点标签上那颗叉关掉它，全关光后面板不收起、
 *      里面留一句提示，切会话标签清空，刷新页面标签不恢复；
 *      ≥1200px 常驻在左边、窄了滑入、点外面收起；手机上两块侧边栏互斥；
 *      顶条左边那颗按钮点开点收、刷新后还是刚才的样子；
 *      目录外 / 不存在 / 超过 2 MB 时页面上给一句说明；
 *      正看着的文件被改（脚本直接改会话目录里的文件，见下）以后，面板不用重新点链接就换成
 *      新内容，而读到哪儿还停在哪儿；文件没变的那几轮里，正文一个字节都不再传一遍；
 *   2. 在页面里用 fetch 直接打那条只读文件地址，核对拒绝的几种情形（目录外含 .. 绕出去的写法、
 *      没有这个文件、超过 2 MB），以及「没变就别再给一遍正文」那条条件请求。
 * 最后一件事：把页面按“插件里的对话面板”跑一遍（在页面脚本里先塞一个网页视图接口），
 * 核对那边既没有这一列也没有这颗按钮、点链接照旧是交给编辑器打开那条消息。
 *
 * 测试用的文件（long.js / sample.js / big.txt）现写进会话目录（dev/.scratch），
 * 那个目录不进版本库，随便造。
 */
const fs = require("fs");
const path = require("path");

const LONG_LINES = 400;
const HIT_LINE = 137;
/** 第二次点 long.js 时链接说的那一行（换成另一行：切回原来那个标签、按这次的行滚）。 */
const HIT_LINE_AGAIN = 260;
const SAMPLE_HIT = 3;
/** 比 2 MB 大一点点：只用来验“太大”，不读出来。 */
const BIG_BYTES = 2 * 1024 * 1024 + 64 * 1024;
/** live.js：面板正看着它的时候脚本改它（验“跟着刷新”那个文件）。 */
const LIVE_LINES = 300;
const LIVE_HIT = 100;

const FILE = {
    long: "long.js",
    sample: "sample.js",
    live: "live.js",
    missing: "missing.txt",
    big: "big.txt",
    outside: "outside/package.json",
};
const LINK_TEXT =
    "看这几个文件：\n\n" +
    "`" + FILE.long + ":" + HIT_LINE + "` 这一行、`" + FILE.sample + ":" + SAMPLE_HIT + "` 这一行，\n" +
    "`" + FILE.long + ":" + HIT_LINE_AGAIN + "` 这个文件再说一次，\n" +
    "`" + FILE.live + ":" + LIVE_HIT + "` 这个是拿着看的，\n" +
    "再试试 `" + FILE.missing + ":1`、`" + FILE.outside + ":1`、`" + FILE.big + ":1`。\n";

/** live.js 每次都整份重写：marker 为真就把第 LIVE_HIT 行换个说法（行数不变），extra 是末尾多加几行。 */
function writeLive(cwd, marker, extra) {
    const lines = [];
    for (let i = 1; i <= LIVE_LINES + (extra || 0); i++) {
        lines.push(i === LIVE_HIT && marker ? "// live 第 " + i + " 行（改过了）" : "// live 第 " + i + " 行");
    }
    fs.writeFileSync(path.join(cwd, FILE.live), lines.join("\n") + "\n", "utf8");
}

/** 往会话目录里造测试用的文件（每次跑都重写一遍，内容与行数固定）。 */
function prepareFiles(cwd) {
    const long = [];
    for (let i = 1; i <= LONG_LINES; i++) { long.push("// 第 " + i + " 行"); }
    fs.writeFileSync(path.join(cwd, FILE.long), long.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(cwd, FILE.sample),
        "// sample 1\n// sample 2\n// sample 3 这一行\n// sample 4\n// sample 5\n", "utf8");
    writeLive(cwd, false, 0);
    fs.writeFileSync(path.join(cwd, FILE.big), Buffer.alloc(BIG_BYTES, 0x78));
    const outside = path.join(cwd, "outside");
    if (fs.existsSync(outside)) { return "已经有了"; }
    // 目录外那份用一个目录软链接（Windows 上 junction 不需要管理员权限）指到仓库根上：
    // 这样“路径字符串看着在目录里、真实路径在目录外”那条边界才有东西可验。
    try {
        fs.symlinkSync(path.resolve(__dirname, ".."), outside, "junction");
        return "建好了";
    } catch (err) {
        return "建不了（" + (err && err.message ? err.message : String(err)) + "）";
    }
}

/** 页面上把假消息投进去（同一份内容刷新之后要再投一次）。 */
const POST_LINKS = `for (const m of ${JSON.stringify([{ type: "assistantFull", text: LINK_TEXT }])}) { window.postMessage(m, "*"); } return true;`;

module.exports = async (page) => {
    const checks = [];
    const check = (name, pass, detail) => {
        checks.push([name, !!pass]);
        console.log((pass ? "✓ " : "✗ ") + name + (detail === undefined ? "" : "   " + detail));
    };

    await page.waitReady();
    await page.sleep(500);

    // 会话目录（顶条上那行小字）与会话标识（轮到自己看的那个会话）
    const sessionInfo = JSON.parse(await page.eval(`
        const pane = document.querySelector(".session-pane");
        return JSON.stringify({
            cwd: (document.querySelector("#sessionPath .sp-text") || {}).textContent || "",
            sessionId: pane ? (pane.dataset.sessionId || "") : "",
        });
    `));
    console.log("会话：" + JSON.stringify(sessionInfo));
    check("页面上说得出会话跑在哪个目录", sessionInfo.cwd !== "" && sessionInfo.sessionId !== "");

    const cwd = sessionInfo.cwd || require("./harness.js").SCRATCH_DIR;
    const made = prepareFiles(cwd);
    console.log("测试文件写进 " + cwd + "（目录外那个软链接：" + made + "）");

    // ==================== 宽窗：这一列常驻在左边 ====================
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(500);

    const LOOK = `
        const f = function () {
            const root = document.getElementById("fileSidebar");
            const body = document.getElementById("fileBody");
            const rows = body ? Array.from(body.querySelectorAll(".file-line")) : [];
            const hit = rows.find(function (r) { return r.classList.contains("hit"); });
            const bodyRect = body ? body.getBoundingClientRect() : null;
            const hitRect = hit ? hit.getBoundingClientRect() : null;
            const rootRect = root && getComputedStyle(root).display !== "none" ? root.getBoundingClientRect() : null;
            const chat = document.getElementById("chatColumn").getBoundingClientRect();
            const btn = document.getElementById("fileSidebarBtn");
            const backdrop = document.getElementById("fileBackdrop");
            const note = body ? body.querySelector(".file-note") : null;
            const bar = document.getElementById("fileTabs");
            const tabs = bar ? Array.from(bar.querySelectorAll(".file-tab")) : [];
            return {
                vw: window.innerWidth,
                hasPanel: !!root,
                hasButton: !!btn,
                buttonAtBarLeft: !!btn && !!btn.parentElement && btn.parentElement.id === "sessionBar"
                    && btn.parentElement.firstElementChild === btn,
                panelShown: !!rootRect,
                panelLeft: rootRect ? Math.round(rootRect.left) : -1,
                panelWidth: rootRect ? Math.round(rootRect.width) : -1,
                dock: document.body.classList.contains("file-dock"),
                open: document.body.classList.contains("file-open"),
                hidden: document.hidden,
                chatLeft: Math.round(chat.left),
                title: (document.getElementById("fileTitle") || {}).textContent || "",
                note: note ? (note.textContent || "") : "",
                rowCount: rows.length,
                firstRow: rows.length ? rows[0].innerText : "",
                hitText: hit ? hit.innerText : "",
                hitNum: hit ? ((hit.querySelector(".file-num") || {}).textContent || "") : "",
                hitVisible: !!(hitRect && bodyRect
                    && hitRect.top >= bodyRect.top - 1 && hitRect.bottom <= bodyRect.bottom + 1),
                tabShown: !!bar && getComputedStyle(bar).display !== "none" && bar.getBoundingClientRect().height > 0,
                tabCount: tabs.length,
                tabNames: tabs.map(function (t) { return (t.querySelector(".file-tab-name") || {}).textContent || ""; }),
                tabPaths: tabs.map(function (t) { return t.getAttribute("data-path") || ""; }),
                tabActive: tabs.findIndex(function (t) { return t.classList.contains("active"); }),
                tabCloseCount: tabs.filter(function (t) { return !!t.querySelector(".file-tab-close"); }).length,
                backdropShown: !!backdrop && getComputedStyle(backdrop).display !== "none",
                bodyTop: body ? Math.round(body.scrollTop) : -1,
                bodyMax: body ? Math.round(body.scrollHeight - body.clientHeight) : -1,
                barBottom: Math.round(document.getElementById("sessionBar").getBoundingClientRect().bottom),
                fileHeaderBottom: document.getElementById("fileHeader")
                    ? Math.round(document.getElementById("fileHeader").getBoundingClientRect().bottom) : -1,
                dockHeaderBottom: document.getElementById("dockHeader")
                    ? Math.round(document.getElementById("dockHeader").getBoundingClientRect().bottom) : -1,
                topAtChat: (document.elementFromPoint(Math.round(window.innerWidth * 0.5), 400) || { id: "" }).id,
                topAtRight: (document.elementFromPoint(Math.round(window.innerWidth - 40), 400) || { id: "" }).id,
            };
        };
        return JSON.stringify(f());
    `;
    const look = async (label) => {
        const r = JSON.parse(await page.eval(LOOK));
        console.log(label + "：" + JSON.stringify(r));
        return r;
    };
    /** 等面板变成想要的样子（换内容、换成一句提示都是异步来的）：cond 拿一次读数判断行不行。 */
    const waitLook = async (what, cond, timeoutMs) => {
        const limit = timeoutMs || 8000;
        const started = Date.now();
        let got = null;
        while (Date.now() - started < limit) {
            got = JSON.parse(await page.eval(LOOK));
            if (cond(got)) { return got; }
            await page.sleep(250);
        }
        console.log("（等超时：" + what + "，现在这样：" + JSON.stringify(got) + "）");
        return got;
    };
    /** 装上探针：记下每一条打 /file 的请求（带没带修改时间、回什么状态、正文几字节）。 */
    const PROBE = `
        window.__fileProbe = window.__fileProbe || [];
        if (!window.__fileProbeOn) {
            window.__fileProbeOn = true;
            const realFetch = window.fetch.bind(window);
            window.fetch = function (input, init) {
                const url = typeof input === "string" ? input : String((input && input.url) || "");
                const p = realFetch(input, init);
                if (url.indexOf("/file?") >= 0) {
                    const rec = { mtime: url.indexOf("mtime=") >= 0, status: 0, bytes: 0 };
                    window.__fileProbe.push(rec);
                    p.then(function (resp) { rec.status = resp.status; return resp.clone().text(); })
                        .then(function (text) { rec.bytes = text.length; })
                        .catch(function () { /* 这条请求塌了，不影响页面 */ });
                }
                return p;
            };
        }
        return true;
    `;
    /** 点消息流里某个文件的链接。给了 line 就挑说的那一行那一个（同一个文件可能有好几个链接）。 */
    const clickLink = (file, line) => page.eval(`
        const want = { file: ${JSON.stringify(file)}, line: ${line === undefined ? "null" : JSON.stringify(String(line))} };
        const a = Array.from(document.querySelectorAll("a.file-link")).find(function (x) {
            return x.getAttribute("data-file") === want.file
                && (want.line === null || x.getAttribute("data-line") === want.line);
        });
        if (!a) { return "没有这个链接"; }
        a.click();
        return "点了";
    `);
    /** 点某一个标签（按标签说的文件找）、或者点它那颗叉。 */
    const clickTab = (file, what) => page.eval(`
        const tabs = Array.from(document.querySelectorAll("#fileTabs .file-tab"));
        const t = tabs.find(function (x) { return x.getAttribute("data-path") === ${JSON.stringify(file)}; });
        if (!t) { return "没有这个标签"; }
        const el = ${JSON.stringify(what)} === "close" ? t.querySelector(".file-tab-close") : t;
        if (!el) { return "标签上没有这个东西"; }
        el.click();
        return "点了";
    `);

    await page.eval(POST_LINKS);
    await page.sleep(400);
    const linkCount = await page.eval(`return document.querySelectorAll("a.file-link").length`);
    check("消息流里出现了文件链接", linkCount >= 5, "共 " + linkCount + " 个");

    const wide0 = await look("宽窗 · 还没点任何链接");
    check("顶条左边有一颗文件侧边栏按钮", wide0.hasButton && wide0.buttonAtBarLeft);
    check("没点开时左边那一列不占地方", !wide0.open && !wide0.dock && wide0.chatLeft === 0);

    await page.click("#fileSidebarBtn");
    await page.sleep(300);
    const wide1 = await look("宽窗 · 点顶条那颗按钮");
    check("点按钮开出来、并且在左边常驻", wide1.open && wide1.dock && wide1.panelLeft === 0 && wide1.panelWidth === 320);
    check("对话让出左边这块宽度", wide1.chatLeft === 320);
    check("面板头跟顶条的横线齐", wide1.fileHeaderBottom === wide1.barBottom && wide1.dockHeaderBottom === wide1.barBottom,
        JSON.stringify({ bar: wide1.barBottom, file: wide1.fileHeaderBottom, dock: wide1.dockHeaderBottom }));
    check("还没点文件时面板里有一句提示", wide1.rowCount === 0 && wide1.note.length > 0);
    check("一个标签都没有时标签条不占地方", !wide1.tabShown && wide1.tabCount === 0);
    await page.shot("file-1-open-empty.png");

    // 刷新：开没收起记在这台设备里
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await page.waitReady();
    await page.sleep(500);
    await page.eval(POST_LINKS);
    await page.sleep(300);
    const wide2 = await look("宽窗 · 刷新之后");
    check("刷新之后还是开着（记在这台设备里）", wide2.open && wide2.dock && wide2.panelShown);

    await page.click("#fileSidebarBtn");
    await page.sleep(300);
    const wide3 = await look("宽窗 · 再点一下那颗按钮");
    check("再点一下收起来、对话铺满", !wide3.open && !wide3.dock && wide3.chatLeft === 0);
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await page.waitReady();
    await page.sleep(500);
    await page.eval(POST_LINKS);
    await page.sleep(300);
    const wide4 = await look("宽窗 · 收起之后刷新");
    check("收起之后刷新还是收起", !wide4.open && !wide4.dock);

    // 点文件链接：左边开出来、显示那个文件、停在链接说的那一行
    console.log("点文件链接：" + await clickLink(FILE.long));
    await page.sleep(600);
    const wide5 = await look("宽窗 · 点 long.js:" + HIT_LINE);
    check("点链接左边开出来（不用先点按钮）", wide5.open && wide5.dock && wide5.panelLeft === 0);
    check("标题上是那个文件", wide5.title === FILE.long);
    check("内容带行号、行数对得上", wide5.rowCount === LONG_LINES && wide5.firstRow.indexOf("1") >= 0, wide5.firstRow);
    check("停在链接说的那一行并高亮", wide5.hitNum === String(HIT_LINE) && wide5.hitText.indexOf("第 " + HIT_LINE + " 行") >= 0 && wide5.hitVisible);
    check("这个文件占上了第一个标签", wide5.tabShown && wide5.tabCount === 1 && wide5.tabActive === 0
        && wide5.tabNames[0] === "long.js" && wide5.tabPaths[0] === FILE.long);
    check("标签上有一颗叉", wide5.tabCloseCount === 1);
    check("正文很长也不把面板头挤扁（跟顶条的横线还是齐的）", wide5.fileHeaderBottom === wide5.barBottom,
        JSON.stringify({ bar: wide5.barBottom, file: wide5.fileHeaderBottom }));
    await page.shot("file-2-line.png");

    // 再点另一个文件：新开一个标签，原来那个还留着
    console.log("点文件链接：" + await clickLink(FILE.sample));
    await page.sleep(500);
    const wide6 = await look("宽窗 · 点 sample.js:" + SAMPLE_HIT);
    check("换一个文件：内容跟着换", wide6.rowCount === 5);
    check("也停在那个文件的第 " + SAMPLE_HIT + " 行", wide6.hitNum === String(SAMPLE_HIT) && wide6.hitText.indexOf("sample " + SAMPLE_HIT) >= 0);
    check("新开一个标签（一共两个），原来那个还留着", wide6.tabCount === 2
        && wide6.tabPaths[0] === FILE.long && wide6.tabPaths[1] === FILE.sample);
    check("新开的那个是当前这个标签，面板头写着它", wide6.tabActive === 1 && wide6.title === FILE.sample);
    await page.shot("file-2b-two-tabs.png");

    // 再点已经开着的文件：切回它那个标签、按这次链接说的行滚过去，不新开标签
    console.log("点文件链接：" + await clickLink(FILE.long, HIT_LINE_AGAIN));
    await page.sleep(600);
    const wide7 = await look("宽窗 · 再点一次 long.js:" + HIT_LINE_AGAIN);
    check("同一个文件不再开一个标签（还是两个）", wide7.tabCount === 2
        && wide7.tabPaths[0] === FILE.long && wide7.tabPaths[1] === FILE.sample);
    check("切回 long.js 那个标签（第 1 个）", wide7.tabActive === 0 && wide7.title === FILE.long);
    check("按这次链接说的第 " + HIT_LINE_AGAIN + " 行滚过去", wide7.hitNum === String(HIT_LINE_AGAIN) && wide7.hitVisible);
    await page.shot("file-8-switch-back.png");

    // 关掉一个没在看的标签：正看着的那个不许跟着换
    console.log("点标签上的叉：" + await clickTab(FILE.sample, "close"));
    await page.sleep(300);
    const wide7b = await look("宽窗 · 关掉没在看的 sample.js 那个标签");
    check("关掉没在看的标签：画面不换，还停在原来那一行", wide7b.tabCount === 1 && wide7b.tabActive === 0
        && wide7b.title === FILE.long && wide7b.hitNum === String(HIT_LINE_AGAIN) && wide7b.hitVisible);
    // 关过的文件再点开：又占一个新标签
    console.log("点文件链接：" + await clickLink(FILE.sample));
    await page.sleep(500);
    const wide7c = await look("宽窗 · 再点一次刚关掉的 sample.js");
    check("关过的文件再点开：又开一个标签、摆上来的还是它", wide7c.tabCount === 2
        && wide7c.tabPaths[1] === FILE.sample && wide7c.tabActive === 1);

    // 点标签切过去：回到那个标签上次读到的地方
    console.log("点标签：" + await clickTab(FILE.long, "tab"));
    await page.sleep(600);
    const wide8 = await look("宽窗 · 点 long.js 那个标签");
    check("点标签切到那个文件", wide8.tabActive === 0 && wide8.title === FILE.long && wide8.rowCount === LONG_LINES);
    check("回到它上次读到的地方（还停在刚才那一行）", wide8.hitNum === String(HIT_LINE_AGAIN) && wide8.hitVisible);
    check("两个标签都还在", wide8.tabCount === 2);

    // 关掉正看着的那个：摆上剩下那一个
    console.log("点标签上的叉：" + await clickTab(FILE.long, "close"));
    await page.sleep(600);
    const wide9 = await look("宽窗 · 关掉正看着的 long.js 那个标签");
    check("关掉的那个标签没了、另一个还在", wide9.tabCount === 1 && wide9.tabPaths[0] === FILE.sample);
    check("面板还开着、没跟着标签一起收起", wide9.open && wide9.dock && wide9.panelShown);
    check("剩下那个标签摆上来（内容换成它的）", wide9.tabActive === 0 && wide9.title === FILE.sample && wide9.rowCount === 5);
    await page.shot("file-8b-one-tab-closed.png");

    // 标签全关掉：面板不收起，留一句提示
    console.log("点标签上的叉：" + await clickTab(FILE.sample, "close"));
    await page.sleep(500);
    const wide10 = await look("宽窗 · 标签全关掉");
    check("标签全关掉：面板不收起", wide10.open && wide10.dock && wide10.panelShown);
    check("里面留一句提示（说点消息里的文件链接就能看）", wide10.tabCount === 0 && !wide10.tabShown
        && wide10.rowCount === 0 && wide10.note.indexOf("文件链接") >= 0, wide10.note);
    check("面板头上的字回到「文件」", wide10.title === "文件");
    await page.shot("file-9-all-closed.png");

    // 刷新：标签不恢复（面板本身还留着开或收的样子）
    await page.eval("location.reload(); return true;");
    await page.sleep(1500);
    await page.waitReady();
    await page.sleep(500);
    const wide11 = await look("宽窗 · 开过标签之后刷新");
    check("刷新之后标签不恢复（面板还开着、里面还是提示）", wide11.open && wide11.dock && wide11.tabCount === 0 && wide11.note.length > 0);
    await page.eval(POST_LINKS);
    await page.sleep(300);

    // ==================== 跟着刷新：正看着的文件被改了，面板自己跟上 ====================
    // 脚本直接改会话目录里的 live.js（谁改的都一样：模型改的、脚本改的）：面板该自己把新内容
    // 换上来，而读到哪儿还停在哪儿；文件没变的那几轮里，正文一个字节都不该再传一遍。
    console.log("点文件链接：" + await clickLink(FILE.live, LIVE_HIT));
    const live0 = await waitLook("live.js 上来", (x) => x.rowCount === LIVE_LINES && x.tabActive === 0);
    check("点链接打开 live.js、停在链接说的那一行", live0.rowCount === LIVE_LINES
        && live0.hitNum === String(LIVE_HIT) && live0.hitVisible);
    check("停在中间一段（后面验“位置不动”才不是白验）", live0.bodyTop > 0 && live0.bodyTop < live0.bodyMax,
        JSON.stringify({ top: live0.bodyTop, max: live0.bodyMax }));
    await page.shot("file-11-live.png");

    await page.eval(PROBE);
    await page.eval("window.__fileProbe.length = 0; return true;");
    console.log("文件没变，等两轮（界面在后台？" + live0.hidden + "）…");
    await page.sleep(3600);
    const probe0 = JSON.parse(await page.eval("return JSON.stringify(window.__fileProbe)"));
    const polled = probe0.filter((r) => r.mtime);
    console.log("这 3.6 秒里打 /file 的请求：" + JSON.stringify(probe0));
    check("面板按固定间隔自己问（文件没变也问）", polled.length >= 2, "问了 " + polled.length + " 次");
    check("没变的那些轮：回的是空响应、正文一个字节都没再传一遍",
        probe0.length > 0 && probe0.length === polled.length && polled.every((r) => r.status === 204 && r.bytes === 0),
        JSON.stringify(probe0.map((r) => [r.status, r.bytes])));
    const idle = await look("干等两轮 · 文件没变");
    check("文件没变：画面也不动（还停在同一行）", idle.rowCount === LIVE_LINES && idle.bodyTop === live0.bodyTop
        && idle.hitNum === String(LIVE_HIT), JSON.stringify({ top: idle.bodyTop }));

    // 脚本改文件：改的是正看着的那一行，行数不变
    writeLive(cwd, true, 0);
    const changed = await waitLook("面板换成改过的内容", (x) => x.hitText.indexOf("改过了") >= 0);
    check("文件被改以后，面板自己换成新内容（不用重新点链接）", changed.hitText.indexOf("改过了") >= 0, changed.hitText);
    check("行数、停在的那一行都还在", changed.rowCount === LIVE_LINES && changed.hitNum === String(LIVE_HIT));
    check("滚动位置一点没动（读到哪儿还停在哪儿）", changed.bodyTop === live0.bodyTop,
        JSON.stringify({ before: live0.bodyTop, after: changed.bodyTop }));
    check("标签没被这次刷新搅乱（还是那一个、还是当前这个）", changed.tabCount === 1 && changed.tabActive === 0);
    const probe1 = JSON.parse(await page.eval("return JSON.stringify(window.__fileProbe)"));
    check("变了才给正文：这回有一条 200 带着新正文回来",
        probe1.some((r) => r.status === 200 && r.bytes > 0), JSON.stringify(probe1.slice(-3)));
    await page.shot("file-12-follow-change.png");

    // 文件变长（末尾多出几行）：内容跟着长，人读到的位置还是不动
    writeLive(cwd, true, 40);
    const grown = await waitLook("面板换成多出 40 行的内容", (x) => x.rowCount === LIVE_LINES + 40);
    check("文件变长：面板也跟着长（末尾多了那 40 行）", grown.rowCount === LIVE_LINES + 40, String(grown.rowCount));
    check("文件变长也不动滚动位置", grown.bodyTop === live0.bodyTop,
        JSON.stringify({ before: live0.bodyTop, after: grown.bodyTop }));

    // 删掉又被写回来：先给一句「没有这个文件」，写回来以后自己换回内容
    fs.rmSync(path.join(cwd, FILE.live), { force: true });
    const gone = await waitLook("面板说没有这个文件", (x) => x.note.indexOf("没有这个文件") >= 0);
    check("文件被删掉：面板自己给一句「没有这个文件」", gone.rowCount === 0 && gone.note.indexOf("没有这个文件") >= 0, gone.note);
    writeLive(cwd, false, 0);
    const back = await waitLook("面板换回内容", (x) => x.rowCount === LIVE_LINES);
    check("文件写回来：面板自己又显示出来（还停在原来那一行）", back.rowCount === LIVE_LINES
        && back.hitNum === String(LIVE_HIT), String(back.rowCount));
    check("一路都是 live.js 那一个标签", back.tabCount === 1 && back.tabPaths[0] === FILE.live && back.tabActive === 0);
    await page.shot("file-13-live-back.png");

    // ==================== 门槛：1200px ====================
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1199, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(500);
    const edge1 = await look("1199px");
    check("1199px 不是常驻（从左边滑入）", edge1.open && !edge1.dock && edge1.backdropShown && edge1.chatLeft === 0);
    check("滑入式里对话那边盖着一层（点它就是点外面）", edge1.topAtChat === "fileBackdrop" && edge1.topAtRight === "fileBackdrop",
        JSON.stringify({ chat: edge1.topAtChat, right: edge1.topAtRight }));
    await page.shot("file-3-narrow-drawer.png");
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(500);
    const edge2 = await look("1200px");
    check("1200px 起常驻在左边、对话让出宽度", edge2.dock && edge2.chatLeft === 320 && !edge2.backdropShown);

    // 滑入式里点外面收起（不写进记忆：宽回来还是开着的那种要单独验，这里只验收起）
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(400);
    await page.eval(`document.getElementById("fileBackdrop").dispatchEvent(new MouseEvent("click", { bubbles: true })); return true;`);
    await page.sleep(300);
    const edge3 = await look("1000px · 点外面");
    check("滑入式里点外面收起", !edge3.open && !edge3.panelShown);

    // ==================== 手机上两块侧边栏互斥 ====================
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.sleep(600);
    await page.click("#browserMenuBtn");
    await page.sleep(800);
    const phone1 = JSON.parse(await page.eval(`
        return JSON.stringify({
            right: !document.getElementById("pickerOverlay").classList.contains("hidden"),
            left: document.body.classList.contains("file-open"),
        });
    `));
    check("手机上先把右边那块开起来", phone1.right && !phone1.left);
    console.log("点文件链接：" + await clickLink(FILE.long));
    await page.sleep(600);
    const phone2 = JSON.parse(await page.eval(`
        return JSON.stringify({
            right: !document.getElementById("pickerOverlay").classList.contains("hidden"),
            left: document.body.classList.contains("file-open"),
            dock: document.body.classList.contains("file-dock"),
        });
    `));
    check("手机上开左边这块：右边那块自己收起", phone2.left && !phone2.right && !phone2.dock);
    await page.shot("file-4-phone-left.png");
    await page.click("#browserMenuBtn");
    await page.sleep(800);
    const phone3 = JSON.parse(await page.eval(`
        return JSON.stringify({
            right: !document.getElementById("pickerOverlay").classList.contains("hidden"),
            left: document.body.classList.contains("file-open"),
        });
    `));
    check("手机上再开右边那块：左边那块自己收起", phone3.right && !phone3.left);
    await page.shot("file-5-phone-right.png");
    // 收掉右边的抽屉，后面的检查别被它挡着
    await page.eval(`document.getElementById("pickerOverlay").dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 3, clientY: 3 })); return true;`);
    await page.sleep(400);

    // ==================== 看不了的时候给一句人话 ====================
    await page.click("#fileSidebarBtn");
    await page.sleep(300);
    console.log("点文件链接：" + await clickLink(FILE.missing));
    await page.sleep(500);
    const miss = await look("点不存在的文件");
    check("不存在的文件：页面上给一句说明、不给内容", miss.rowCount === 0 && miss.note.indexOf("没有这个文件") >= 0, miss.note);
    console.log("点文件链接：" + await clickLink(FILE.outside));
    await page.sleep(500);
    const out = await look("点会话目录外面的文件");
    check("会话目录外：页面上给一句说明、不给内容", out.rowCount === 0 && out.note.indexOf("会话目录外") >= 0, out.note);
    console.log("点文件链接：" + await clickLink(FILE.big));
    await page.sleep(700);
    const big = await look("点超过 2 MB 的文件");
    check("超过 2 MB：页面上给一句说明、不给内容", big.rowCount === 0 && big.note.indexOf("太大") >= 0, big.note);
    // 手机那一段点过一次 long.js（占了第一个标签），这里又点了三个看不了的文件，各占一个
    check("看不了的文件也各占一个标签",
        big.tabPaths.indexOf(FILE.missing) >= 0 && big.tabPaths.indexOf(FILE.outside) >= 0
        && big.tabPaths.indexOf(FILE.big) >= 0 && big.tabActive === big.tabCount - 1,
        JSON.stringify(big.tabPaths));
    await page.shot("file-6-refused.png");

    // ==================== 直接打那条文件地址（拒绝的几种情形 + 条件请求）====================
    const raw = await page.eval(`
        const sid = (document.querySelector(".session-pane") || { dataset: {} }).dataset.sessionId || "";
        const get = async function (p, opts) {
            const o = opts || {};
            const session = o.session === undefined ? sid : o.session;
            let url = "/file?session=" + encodeURIComponent(session) + "&path=" + encodeURIComponent(p);
            if (o.mtime) { url += "&mtime=" + encodeURIComponent(o.mtime); }
            const resp = await fetch(url);
            const text = await resp.text();
            return { status: resp.status, mtime: resp.headers.get("x-file-mtime") || "", text: text.trim() };
        };
        return (async function () {
            const out = {};
            out.ok = await get(${JSON.stringify(FILE.long)});
            out.dotdot = await get("../../package.json");
            out.absolute = await get(${JSON.stringify(path.resolve(cwd, "..", "..", "package.json"))});
            out.outside = await get(${JSON.stringify(FILE.outside)});
            out.missing = await get(${JSON.stringify(FILE.missing)});
            out.big = await get(${JSON.stringify(FILE.big)});
            out.noSession = await get(${JSON.stringify(FILE.long)}, { session: "不存在的会话" });
            // 条件请求：拿上次那份的修改时间再问一次（该给空响应），换一个对不上的（该给正文）
            out.same = await get(${JSON.stringify(FILE.long)}, { mtime: out.ok.mtime });
            out.stale = await get(${JSON.stringify(FILE.long)}, { mtime: "1" });
            return JSON.stringify(out);
        })();
    `);
    const f = JSON.parse(raw);
    console.log("直接打那条地址：" + JSON.stringify({
        ok: f.ok.status, dotdot: f.dotdot.status, absolute: f.absolute.status, outside: f.outside.status,
        missing: f.missing.status, big: f.big.status, noSession: f.noSession.status,
    }));
    check("地址能取到内容（200、按 UTF-8 的正文）",
        f.ok.status === 200 && f.ok.text.split("\n").length === LONG_LINES && f.ok.text.indexOf("第 " + HIT_LINE + " 行") >= 0);
    check("用 .. 绕出去的写法：403", f.dotdot.status === 403 && f.dotdot.text.indexOf("会话目录外") >= 0);
    check("写成绝对路径且在外面：403", f.absolute.status === 403);
    check("软链接指到目录外：403", f.outside.status === 403);
    check("文件不存在：404", f.missing.status === 404);
    check("超过 2 MB：413、响应里带着字节数",
        f.big.status === 413 && f.big.text.indexOf(String(BIG_BYTES)) >= 0, f.big.text);
    check("不认识的会话：不给内容", f.noSession.status !== 200);
    check("回话里带着这份内容的修改时间（页面下次带它回来问）",
        f.ok.status === 200 && f.ok.mtime !== "", f.ok.mtime);
    check("带着同一个修改时间再问：空响应（正文不重复传）",
        f.same.status === 204 && f.same.text === "", JSON.stringify({ status: f.same.status, len: f.same.text.length }));
    check("修改时间对不上：给正文",
        f.stale.status === 200 && f.stale.text.split("\n").length === LONG_LINES);

    // ==================== 切会话：面板里的标签清空 ====================
    // 往页面里投一份假会话列表、把当前会话切到另一个上去（照 dev/childDot.js 的做法：消息形状
    // 与后端推的那份一样）。这一趟之后页面看的是个假会话，所以放在最后、下面那条真会话的检查之前。
    const otherId = "file-sidebar-other";
    check("切会话之前面板里开着好几个标签", (await look("切会话之前")).tabCount >= 2);
    await page.eval(`
        const sessions = [
            { id: ${JSON.stringify(sessionInfo.sessionId)}, name: "测试会话", cwd: ${JSON.stringify(cwd)},
              streaming: false, loading: false, activity: "idle", piReady: true, modelId: "fake/model", provider: "fake" },
            { id: ${JSON.stringify(otherId)}, name: "另一个会话", cwd: ${JSON.stringify(cwd)},
              streaming: false, loading: false, activity: "idle", piReady: false, modelId: "fake/model", provider: "fake" },
        ];
        window.postMessage({ type: "sessionList", sessions: sessions }, "*");
        window.postMessage({ type: "sessionActivated", sessionId: ${JSON.stringify(otherId)} }, "*");
        return true;
    `);
    await page.sleep(700);
    const switched = await look("切到另一个会话");
    check("切会话：标签清空、面板还开着、里面留提示",
        switched.tabCount === 0 && switched.open && switched.note.indexOf("文件链接") >= 0, switched.note);
    check("切会话：上一个会话的文件内容也不留在面板里", switched.rowCount === 0 && switched.title === "文件");
    await page.shot("file-10-session-switch.png");

    // ==================== 插件里的对话面板：这一列与这颗按钮都不该有 ====================
    // 在页面脚本里先塞一个网页视图接口（真 VSCode 里本来就有这个函数），界面就会按
    // “插件里的对话面板”那套跑起来；然后重新加载页面看区别。
    // 剩下这一趟都按网页视图跑，所以放在最后。
    await page.eval(`
        window.__sentToHost = [];
        return true;
    `);
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
    await page.sleep(1500);
    // 没有推送通道，界面得自己喂一份会话列表；下面这条消息的内容按后端真正推的那份写。
    await page.eval(`
        window.postMessage({ type: "sessionList", sessions: [{
            id: ${JSON.stringify(sessionInfo.sessionId)}, name: "测试会话", streaming: false, activity: "idle",
            piReady: true, modelId: "fake", provider: "fake", cwd: ${JSON.stringify(cwd)},
        }] }, "*");
        return true;
    `);
    await page.sleep(300);
    const view0 = await look("按插件里的对话面板跑：");
    check("插件里的对话面板里没有这一列", !view0.hasPanel);
    check("插件里的对话面板里没有这颗按钮", !view0.hasButton);
    await page.eval(`window.postMessage({ type: "assistantFull", text: ${JSON.stringify(LINK_TEXT)}, sessionId: ${JSON.stringify(sessionInfo.sessionId)} }, "*"); return true;`);
    await page.sleep(400);
    const panelLink = await page.eval(`return document.querySelectorAll("a.file-link").length`);
    await clickLink(FILE.long);
    await page.sleep(500);
    const sent = JSON.parse(await page.eval(`return JSON.stringify((window.__sentToHost || []).filter(function (m) { return m && m.type === "openFile"; }));`));
    check("插件里的对话面板里点链接照旧交给编辑器打开", panelLink >= 5 && sent.length === 1 && sent[0].path === FILE.long && sent[0].line === HIT_LINE, JSON.stringify(sent));
    await page.shot("file-7-webview.png");

    const failed = checks.filter((c) => !c[1]).map((c) => c[0]);
    console.log("\n=== 判断 ===");
    console.log("通过 " + (checks.length - failed.length) + " / " + checks.length);
    if (failed.length) { throw new Error("有 " + failed.length + " 项没通过：\n  - " + failed.join("\n  - ")); }
};

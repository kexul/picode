// @ts-nocheck
/**
 * noticeRaise —— 验「人点了右下角那张卡片，开着页面的地方被弄到眼前，页面同时切到那个会话」。
 *
 *   node dev/noticeRaise.js
 *
 * 只在 Windows 上有意义（那张卡片只在 Windows 上弹）：别的系统上这条直接跳过。
 * 真起后端、真弹卡片、真开一个**显示出来**的浏览器窗口（跑的时候会看见一个 Chrome 窗口自己
 * 最小化到任务栏、又被叫回来到前台，属正常现象）。
 *
 * 弄到眼前分两层（见 src/browserJump.ts 与 bin/notice.cs 的 Raiser），这条脚本两层各验一次：
 *   一、**按窗口标题找**（浏览器没开调试端口时走这条）：验后端报给小程序的那个标题
 *       跟页面自己的标题一样（两边的拼法不同就永远找不到窗口，而且不报错），
 *       以及最小化了的窗口被还原并提到前台；
 *   二、**走浏览器的调试接口**（`--remote-debugging-port=`）：验页面压在背景标签页里、
 *       窗口还最小化着的时候也能跳到眼前（这种情形标题那条路永远认不出来：
 *       窗口标题跟着活动的那张标签页走）。
 *
 * 两层都还验：页面同时切到了卡片说的那个会话（切会话这条本来就有，顺带一起看），
 * 以及找不到窗口时什么也不做（不新开浏览器、不把小程序弄死）。
 *
 * 点那一下，用「往小程序的标准输出里推一行 click」顶替：那正是人真点一下时它写给后端的东西
 * （真鼠标点过的那条路在加这个功能的时候量过：那一下正落在小程序自己的窗口上，它是 Windows 眼里
 * “收到最后一次输入事件的进程”，所以它有权把别的窗口提到前面；换成别的进程去提就未必了）。
 *
 * 要 bin/notice.exe 是新编的（改了 bin/notice.cs 记得先 npm run compile）。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

const CONFIG_FILE = path.join(__dirname, ".scratch", "pichat", "config.json");
const NOTICE_CS = path.join(__dirname, "..", "bin", "notice.cs");
const NOTICE_EXE = path.join(__dirname, "..", "bin", "notice.exe");
const LABEL = "卡片这台";

/** 把浏览器窗口最小化 / 还原（调试接口的 Browser 那一段，只在浏览器级连接上说话，得先把会话摘掉）。 */
async function setWindowState(open, targetId, state) {
    const cdp = open.cdp;
    const saved = cdp.sessionId;
    cdp.sessionId = undefined;
    try {
        const got = await cdp.send("Browser.getWindowForTarget", { targetId });
        await cdp.send("Browser.setWindowBounds", { windowId: got.windowId, bounds: { windowState: state } });
        return got.windowId;
    } finally {
        cdp.sessionId = saved;
    }
}

async function main() {
    if (process.platform !== "win32") {
        console.log("这台不是 Windows：那张卡片本来就不弹，提窗口这条也不用验。");
        return;
    }
    if (!fs.existsSync(NOTICE_EXE)) {
        throw new Error(`没有 ${NOTICE_EXE}：这台弹不出卡片，先 npm run compile 把它编出来。`);
    }
    if (fs.statSync(NOTICE_EXE).mtimeMs < fs.statSync(NOTICE_CS).mtimeMs) {
        throw new Error("bin/notice.exe 比 bin/notice.cs 旧：先 npm run compile 再验这条。");
    }

    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };
    // 第一段（按窗口标题找）要确定走的是退回那条路：把调试端口指到一个没人听的号上
    const debugPortWas = process.env.PICHAT_BROWSER_DEBUG_PORT;
    process.env.PICHAT_BROWSER_DEBUG_PORT = "1";

    const before = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, "utf8") : undefined;
    const harness = createHarness({ fakePi: true, port: 0, log: () => { /* 安静跑 */ } });
    let open;
    let notifyWas = true;
    try {
        // 设置里先写死一个标签（页面标题就是 `卡片这台-pi`；跑完把文件放回去）
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ label: LABEL, notify: {} }, null, 2), "utf8");

        const url = await harness.start();
        const host = harness.host();
        notifyWas = host.getNotifyTurnEnd();
        if (!notifyWas) { host.mutateViewOption("notifyTurnEnd"); }
        check(host.getNotifyTurnEnd() === true, "「弹窗通知」拨不开，这条验不了");

        // 真开一个显示出来的浏览器窗口（无头窗口没有可提的东西）
        open = await openPage({ url, headed: true, width: 900, height: 700, timeoutMs: 60000 });
        const page = open.page;
        await page.waitReady();

        const pageId = await page.eval(`return (document.querySelector('meta[name="pichat-page"]') || {}).content || ""`);
        const targetInfo = await open.cdp.send("Target.getTargetInfo", {});
        const targetId = targetInfo.targetInfo.targetId;
        const pageTitleInBrowser = await page.eval("return document.title");
        check(pageTitleInBrowser === `${LABEL}-pi`, `页面自己的标题是 ${JSON.stringify(pageTitleInBrowser)}，应当是 "${LABEL}-pi"`);

        // 页面上这个会话叫 A；再造一个 B（拿别的"屏"的名义造，页面不会跟着切过去）
        const sessionA = host.clientSessions.get(pageId);
        check(!!sessionA, "这个页面还没有对上一个会话，后面几条没法验");
        const runtimeB = host.newSession(0, "验提窗口用的另一块屏");
        const sessionB = runtimeB.id;
        await sleep(600);
        console.log(`  页面停在会话 ${String(sessionA).slice(-6)}；卡片要说的是另一个会话 ${String(sessionB).slice(-6)}`);

        // 后端报给小程序的标题记下来（照旧真发过去，别把它截胡）
        const notice = host.notice;
        let raisedTitle;
        const realRaise = notice.raise.bind(notice);
        notice.raise = (title) => { raisedTitle = title; realRaise(title); };

        const idxBefore = await page.eval(`const el = document.querySelector(".sn-tab.current"); return el ? el.dataset.idx : "";`);
        const tabCountBefore = await page.eval(`return document.querySelectorAll(".sn-tab").length`);
        check(tabCountBefore >= 2, `顶条上该有两格了，实际 ${tabCountBefore} 格`);

        // 弹一张卡片：说的是会话 B（这是弹卡片那支小程序真起来的时候，它得画在屏幕上）
        host.trayNote(sessionB, "验提窗口的会话", "这一轮跑完了");
        for (let i = 0; i < 40 && !notice.shownKeys().includes(sessionB); i++) { await sleep(100); }
        check(notice.shownKeys().includes(sessionB), "卡片没弹出来（后端那份镜像里没有它），后面验不了");

        // 把浏览器窗口最小化：这才看得出"提上来"那一下
        await setWindowState(open, targetId, "minimized");
        for (let i = 0; i < 30; i++) {
            const st = await page.eval("return document.visibilityState");
            if (st === "hidden") { break; }
            await sleep(100);
        }
        check(await page.eval("return document.visibilityState") === "hidden", "浏览器窗口没能最小化，看不出后面有没有提上来");
        console.log("  窗口最小化了（页面报 hidden），现在去点那张卡片…");

        // 人点了那张：真鼠标点不了（脚本点不到别的进程的窗口），就推一行它点了以后会写的那条
        const stdout = notice.child && notice.child.stdout;
        check(!!stdout, "画卡片那支小程序没起来（notice.child 是空的）");
        if (stdout) { stdout.push(Buffer.from("click\t" + sessionB + "\n", "utf8")); }

        // 1) 窗口被叫回来了（最小化那个状态解了，页面重新看得见）
        let visible = "";
        let focused = false;
        for (let i = 0; i < 60; i++) {
            const st = await page.eval("return [document.visibilityState, document.hasFocus()]");
            visible = st[0];
            focused = st[1];
            if (visible === "visible" && focused) { break; }
            await sleep(100);
        }
        check(visible === "visible", `点完卡片，页面还是 "${visible}"（那个窗口没被还原回来）`);
        // 到不到前台这一条不硬要：小程序提前面得 Windows 给权限（“收到最后一次输入事件的进程”），
        // 而这里那一下点击是往它标准输出里塞一行假的，它并没真收到鼠标输入，所以可能被拦下（只还原、不提前面）。
        // 真人点过的那条路量过：真鼠标点一下，小程序就拿到了权限，最小化的窗口又还原又提前面。
        if (!focused) { console.log("  （这一下没拿到前台：假点击没输入权限，Windows 拦了提前面那一下；只验“还原回来了”）"); }

        // 2) 后端报给小程序的窗口标题要跟页面自己的标题一样（两边拼法不同就永远找不到那个窗口）。
        // 放在轮完之后才看：提窗口这层要先问一次调试接口（这里指到一个没人听的端口），问完才退回按标题找。
        check(raisedTitle === pageTitleInBrowser,
            `后端报给小程序的窗口标题是 ${JSON.stringify(raisedTitle)}，页面自己的标题是 ${JSON.stringify(pageTitleInBrowser)}（两边得一样，不然找不到窗口）`);

        // 3) 页面同时切到了卡片说的那个会话（后端记着的、页面自己画着的，都得是 B）
        check(host.clientSessions.get(pageId) === sessionB,
            `后端记着这个页面还在看 ${String(host.clientSessions.get(pageId)).slice(-6)}，应当切到卡片那个会话 ${String(sessionB).slice(-6)}`);
        const idxAfter = await page.eval(`const el = document.querySelector(".sn-tab.current"); return el ? el.dataset.idx : "";`);
        check(idxAfter !== idxBefore, `顶条上当前那一格没换（点之前与之后都是第 ${idxAfter} 格）`);
        console.log(`  窗口还原回来了（到前台没有 = ${focused}），当前那一格从第 ${idxBefore} 格换到第 ${idxAfter} 格`);

        // ---- 二、页面压在背景标签页里 + 窗口最小化：走浏览器的调试接口把它跳到眼前 ----
        // 这种情形按标题那条路认不出来（窗口标题跟着活动的那张标签页走），只能靠调试接口。
        const portFile = path.join(open.profileDir, "DevToolsActivePort");
        const debugPort = fs.existsSync(portFile) ? Number(fs.readFileSync(portFile, "utf8").split("\n")[0]) : 0;
        check(debugPort > 0, `读不出浏览器的调试端口（${portFile}）`);
        const cdp = open.cdp;
        const savedSession = cdp.sessionId;
        cdp.sessionId = undefined;                       // Browser 那一组只能在浏览器级连接上说话
        const targets = await cdp.send("Target.getTargets", {});
        const tabPages = targets.targetInfos.filter((t) => t.type === "page");
        const piTab = tabPages.find((t) => t.url.startsWith(url));
        const blankTab = tabPages.find((t) => !t.url.startsWith(url));
        check(!!piTab && !!blankTab, `调试接口的清单里该有两张标签页（pi 页面 + 一张空白），实际 ${tabPages.length} 张`);
        await cdp.send("Target.activateTarget", { targetId: blankTab.targetId });   // 把空白那张切到前面
        const windowId = (await cdp.send("Browser.getWindowForTarget", { targetId: piTab.targetId })).windowId;
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
        cdp.sessionId = savedSession;
        for (let i = 0; i < 30; i++) {
            if (await page.eval("return document.visibilityState") === "hidden") { break; }
            await sleep(100);
        }
        check(await page.eval("return document.visibilityState") === "hidden", "没能把 pi 页面弄到背景（它还看得见），这一段验不了");
        console.log(`  pi 页面压到背景标签页里了、窗口也最小化了（浏览器调试端口 = ${debugPort}）`);

        process.env.PICHAT_BROWSER_DEBUG_PORT = String(debugPort);
        const idxBeforeJump = await page.eval(`const el = document.querySelector(".sn-tab.current"); return el ? el.dataset.idx : ""`);
        const raisedInstead = [];
        notice.raise = (title) => { raisedInstead.push(title); realRaise(title); };
        host.trayNote(sessionA, "验跳标签页的会话", "这一轮也跑完了");   // 这张卡片说的是会话 A
        for (let i = 0; i < 40 && !notice.shownKeys().includes(sessionA); i++) { await sleep(100); }
        check(notice.shownKeys().includes(sessionA), "会话 A 那张卡片没弹出来，这一段验不了");
        if (stdout) { stdout.push(Buffer.from("click\t" + sessionA + "\n", "utf8")); }

        let backVisible = "";
        let backFocused = false;
        for (let i = 0; i < 60; i++) {
            const st = await page.eval("return [document.visibilityState, document.hasFocus()]");
            backVisible = st[0];
            backFocused = st[1];
            if (backVisible === "visible" && backFocused) { break; }
            await sleep(100);
        }
        check(backVisible === "visible", `点了卡片，压在背景的那张标签页还是 "${backVisible}"（调试接口没把它切到前面）`);
        check(backFocused, "点了卡片，那个窗口没到前台");
        check(raisedInstead.length === 0,
            `调试接口那一层应当已经办完了，却又走了按窗口标题找那条路（${JSON.stringify(raisedInstead)}）`);
        check(host.clientSessions.get(pageId) === sessionA,
            `页面应当切到卡片说的那个会话（${String(sessionA).slice(-6)}），实际还在 ${String(host.clientSessions.get(pageId)).slice(-6)}`);
        const idxAfterJump = await page.eval(`const el = document.querySelector(".sn-tab.current"); return el ? el.dataset.idx : ""`);
        check(idxAfterJump !== idxBeforeJump, `顶条上当前那一格没换（点之前与之后都是第 ${idxAfterJump} 格）`);
        console.log(`  调试接口把那张背景标签页切到了前面（窗口也从最小化回来了），当前那一格回到第 ${idxAfterJump} 格`);

        // ---- 三、别台推来的那张：点了以后回头请那台叫它自己的页面切过去 ----
        // 会话在那台，这台切不了；那台推过来的地址（pageUrl）就存在这张卡片的账上，
        // 点它时往那儿丢一条 `activate` 过去（这里用一个假收口顶替那台）。
        const pushed = [];
        const fakeHome = http.createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
                try { pushed.push(JSON.parse(body)); } catch { pushed.push({}); }
                res.writeHead(204, { "Cache-Control": "no-store" });
                res.end();
            });
        });
        await new Promise((resolve) => fakeHome.listen(0, "127.0.0.1", resolve));
        const homeBase = "http://127.0.0.1:" + fakeHome.address().port;
        const remoteLabel = "家里那台";
        const remoteKey = "remote:" + remoteLabel + ":" + sessionB;
        const raisedRemote = [];
        notice.raise = (title) => { raisedRemote.push(title); realRaise(title); };
        // 那台推来一条“有事”，同时它自己的页面也在这台浏览器里开着一张标签页（标题是那台的标签 + -pi）
        host.acceptRemoteNotice({ label: remoteLabel, sessionId: sessionB, name: "推来的会话", text: "跑完了", kind: "done", pageUrl: homeBase });
        for (let i = 0; i < 40 && !notice.shownKeys().includes(remoteKey); i++) { await sleep(100); }
        check(notice.shownKeys().includes(remoteKey), "别台推来的那张卡片没弹出来，这一段验不了");
        const onBeforeRemote = host.clientSessions.get(pageId);
        if (stdout) { stdout.push(Buffer.from("click\t" + remoteKey + "\n", "utf8")); }
        let asked;
        for (let i = 0; i < 40 && !asked; i++) {
            asked = pushed.find((one) => one.activate === true);
            if (!asked) { await sleep(100); }
        }
        check(!!asked, `点了别台推来的那张，没有往那台丢一条“把页面切过去”（收到 ${pushed.length} 条：${JSON.stringify(pushed)}）`);
        if (asked) {
            check(asked.sessionId === sessionB, `丢过去那条带的是 ${JSON.stringify(asked.sessionId)}，应当是那张卡片说的会话`);
            check(asked.label === LABEL, `丢过去那条的标签是 ${JSON.stringify(asked.label)}，应当是这台的「${LABEL}」`);
        }
        // 这边的页面不能跟着瞎切（那不是这台的会话）；找标签页找的是**那台**的标题，不是这台的
        check(host.clientSessions.get(pageId) === onBeforeRemote,
            "点了别台推来的那张，这边的页面竟然自己切走了（那张说的会话不在这台，切不了）");
        for (let i = 0; i < 40 && raisedRemote.length === 0; i++) { await sleep(100); }
        check(raisedRemote.includes(`${remoteLabel}-pi`),
            `按标题找那一步应当找的是「${remoteLabel}-pi」（那台页面的标题），实际找的是 ${JSON.stringify(raisedRemote)}`);
        console.log(`  别台推来的那张：点完往那台丢了一条 activate（会话 ${String(asked && asked.sessionId).slice(-6)}），这边按「${remoteLabel}-pi」去找那张标签页`);

        // 反过来：这台当“那台”收到一条 activate（那台点了卡片以后发回来的），就把自己那些页面切过去
        host.acceptRemoteNotice({ label: remoteLabel, sessionId: sessionA, name: "推来的会话", activate: true });
        for (let i = 0; i < 40 && host.clientSessions.get(pageId) !== sessionA; i++) { await sleep(100); }
        check(host.clientSessions.get(pageId) === sessionA,
            `收到那台的 activate 以后，这边的页面应当切到那个会话（现在还在 ${String(host.clientSessions.get(pageId)).slice(-6)}）`);
        console.log("  反过来收到那台的 activate：这边把页面切过去了");

        // 那台推来一条“收掉”：这张卡片与它那份账（点它要用的地址）都抹了
        host.acceptRemoteNotice({ label: remoteLabel, sessionId: sessionB, name: "推来的会话", pageUrl: homeBase, close: true });
        await sleep(300);
        check(!host.remoteNoticePages.has(remoteKey), "那台说没事了，这边还留着那张卡片的账（地址与标签）");
        fakeHome.close();

        // 四、找不到窗口时：什么也不做，别出事
        const alive = notice.child && notice.child.exitCode === null;
        realRaise("这台根本没有这个标题的窗口");
        await sleep(400);
        check(!!alive && notice.child.exitCode === null, "找一个不存在的窗口标题，把那支小程序弄死了");
        console.log("  找一个不存在的标题：什么都没发生，小程序还活着");

        if (problems.length) {
            console.log("");
            console.log(`有问题（${problems.length} 条）：`);
            for (const p of problems) { console.log("  ! " + p); }
            throw new Error(`点卡片把页面弄到眼前这条没验过：${problems.length} 条`);
        }
        console.log("");
        console.log("点卡片：按标题找到窗口提上来了、页面压在背景标签页里时靠调试接口也跳到了眼前，两种都把页面切到了卡片说的会话；" +
            "别台推来的那张点了会回头请那台切页面（不碰这边的页面）、收到那台的请求也会把自己页面切过去；找不到时什么都不做，都对上了。");
    } finally {
        if (debugPortWas === undefined) { delete process.env.PICHAT_BROWSER_DEBUG_PORT; }
        else { process.env.PICHAT_BROWSER_DEBUG_PORT = debugPortWas; }
        if (open) { try { await open.close(); } catch { /* 收摊出错不拦路 */ } }
        try { await harness.stop(); } catch { /* 收摊出错不拦路 */ }
        try {
            if (before === undefined) { fs.rmSync(CONFIG_FILE, { force: true }); }
            else { fs.writeFileSync(CONFIG_FILE, before, "utf8"); }
        } catch { /* 放不回去就算了 */ }
        try {
            const host = harness.host();
            if (host && host.getNotifyTurnEnd() !== notifyWas) { host.mutateViewOption("notifyTurnEnd"); }
        } catch { /* 收摊了就算了 */ }
    }
}

main().catch((err) => {
    console.error("出错了：" + (err && err.message ? err.message : String(err)));
    process.exit(1);
});

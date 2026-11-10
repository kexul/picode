// @ts-nocheck
/**
 * noticeRaise —— 验「人点了右下角那张卡片，开着页面的窗口被提到前面，页面同时切到那个会话」。
 *
 *   node dev/noticeRaise.js
 *
 * 只在 Windows 上有意义（那张卡片只在 Windows 上弹、提窗口也是调 Windows 的接口，见 bin/notice.cs）：
 * 别的系统上这条直接跳过。真起后端、真弹卡片、真开一个**显示出来**的浏览器窗口（跑的时候会看见
 * 一个 Chrome 窗口自己最小化到任务栏、又被叫回来到前台，属正常现象）。
 *
 * 验这四条：
 *   一、后端报给小程序的那个窗口标题 == 页面自己的标题（标题的拼法只在 src/pageHtml.ts 的 pageTitle 一处；
 *       两边对不上就永远找不到那个窗口，提不起来也不报错 —— 所以这一条最容易悄悄坏）；
 *   二、最小化了的那个窗口被还原，并且真的到了前台；
 *   三、页面同时切到了卡片说的那个会话（切会话这条本来就有，顺带一起看）；
 *   四、找不到窗口时什么也不做：不新开浏览器、不把小程序弄死（别的机器推来的卡片就是这种情况）。
 *
 * 点那一下，用「往小程序的标准输出里推一行 click」顶替：那正是人真点一下时它写给后端的东西
 * （真鼠标点过的那条路在加这个功能的时候量过：那一下正落在小程序自己的窗口上，它是 Windows 眼里
 * “收到最后一次输入事件的进程”，所以它有权把别的窗口提到前面；换成别的进程去提就未必了）。
 *
 * 要 bin/notice.exe 是新编的（改了 bin/notice.cs 记得先 npm run compile）。
 */
const fs = require("fs");
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

        // 一、后端报过去的标题要跟页面自己的标题一样（不然永远找不到那个窗口）
        check(raisedTitle === pageTitleInBrowser,
            `后端报给小程序的窗口标题是 ${JSON.stringify(raisedTitle)}，页面自己的标题是 ${JSON.stringify(pageTitleInBrowser)}（两边得一样，不然找不到窗口）`);

        // 二、窗口被叫回来了：页面重新看得见，而且那个窗口在前台
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
        check(focused, "点完卡片，那个窗口没到前台（document.hasFocus() 还是 false）");

        // 三、页面同时切到了卡片说的那个会话（后端记着的、页面自己画着的，都得是 B）
        check(host.clientSessions.get(pageId) === sessionB,
            `后端记着这个页面还在看 ${String(host.clientSessions.get(pageId)).slice(-6)}，应当切到卡片那个会话 ${String(sessionB).slice(-6)}`);
        const idxAfter = await page.eval(`const el = document.querySelector(".sn-tab.current"); return el ? el.dataset.idx : "";`);
        check(idxAfter !== idxBefore, `顶条上当前那一格没换（点之前与之后都是第 ${idxAfter} 格）`);
        console.log(`  窗口回来了、在前台，当前那一格从第 ${idxBefore} 格换到第 ${idxAfter} 格`);

        // 四、找不到窗口的那种（别的机器推来的卡片就长这样）：什么也不做，别出事
        const alive = notice.child && notice.child.exitCode === null;
        realRaise("这台根本没有这个标题的窗口");
        await sleep(400);
        check(!!alive && notice.child.exitCode === null, "找一个不存在的窗口标题，把那支小程序弄死了");
        console.log("  找一个不存在的标题：什么都没发生，小程序还活着");

        if (problems.length) {
            console.log("");
            console.log(`有问题（${problems.length} 条）：`);
            for (const p of problems) { console.log("  ! " + p); }
            throw new Error(`点卡片提窗口这条没验过：${problems.length} 条`);
        }
        console.log("");
        console.log("点卡片提窗口：报过去的窗口标题跟页面自己的标题对得上、最小化的窗口被还原并提到前台、页面同时切到了那个会话、找不到窗口时什么都不做，都对上了。");
    } finally {
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

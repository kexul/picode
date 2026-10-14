// @ts-nocheck
/**
 * focusCheck —— 验「每块屏各看各的会话」（跑一遍就报结果，截图落在 dev/shots/）。
 *
 *   node dev/focusCheck.js
 *
 * 两块屏各看各的：浏览器页面甲 / 乙是两块独立的屏。验的是
 *   1. 甲自己新建会话，乙还停在原来那个上（后端不再“一个当前会话，所有屏跟着切”）；
 *   2. 两块屏各自给会话发消息，互不串台；
 *   3. 一个 VSCode 窗口连上来（模拟它的屏连接 + 页面标识 + 界面就绪），
 *      会自动认自己工作区里的会话（后端默认目录是 dev/.scratch，窗口打开的是另一个目录）。
 *
 * 后端、会话编排、界面文件全是真的，只有“模型”是假的（dev/fake-pi）。
 * 假 VSCode 那份插件也会连上后端，但它没有网页视图，不会说 ready，不参与这几步。
 */
const fs = require("fs");
const path = require("path");
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

let failed = 0;
function ok(text) { console.log("  ✔ " + text); }
function bad(text) { console.log("  ✘ " + text); failed += 1; }
function check(cond, text) { (cond ? ok : bad)(text); }

/** 这块屏现在显示的是哪个会话（页面上挂着的那块窗格）。 */
async function activeSessionOf(page) {
    return page.eval(`
        const pane = document.querySelector('#messages .session-pane');
        return pane ? pane.dataset.sessionId : null;
    `);
}

async function waitFor(fn, ms, what) {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await fn();
        if (value) { return value; }
        if (Date.now() > deadline) { throw new Error("等超时了：" + what); }
        await sleep(300);
    }
}

async function main() {
    const quiet = (text) => { if (/错误|error|失败/.test(text)) { console.log("  [日志] " + text); } };
    const harness = createHarness({ fakePi: true, log: quiet });
    const url = await harness.start();
    console.log("调试后端：" + url);
    const opened = [];
    const openOne = async (name) => {
        const { page, browser, close } = await openPage({ url, shotDir: path.join(__dirname, "shots") });
        opened.push({ name, page, browser, close });
        return page;
    };

    try {
        // ---- 两块屏：两个浏览器页面 ----
        const a = await openOne("甲");
        await a.waitReady();
        const b = await openOne("乙");
        await b.waitReady();

        const a0 = await activeSessionOf(a);
        const b0 = await activeSessionOf(b);
        console.log(`甲看的会话：${a0}\n乙看的会话：${b0}`);
        check(!!a0 && a0 === b0, "两块屏刚打开时看的是同一个会话（新屏跟前一块屏当前在看的那一个）");

        // 甲点“＋”：只有甲该换到新会话
        await a.click("#newSessionBtn");
        const a1 = await waitFor(async () => {
            const id = await activeSessionOf(a);
            return id && id !== a0 ? id : null;
        }, 20000, "甲换到新会话");
        const bStill = await activeSessionOf(b);
        check(a1 !== a0, "甲自己新建会话后换过去了");
        check(bStill === b0, "乙没被牵动（它还停在原来那个会话上）");

        // 乙也点“＋”：两块屏各看各的
        await b.click("#newSessionBtn");
        const b1 = await waitFor(async () => {
            const id = await activeSessionOf(b);
            return id && id !== b0 ? id : null;
        }, 20000, "乙换到新会话");
        const aStill = await activeSessionOf(a);
        check(b1 !== b0 && aStill === a1, "乙新建会话后乙换了、甲没动");

        // 两块屏各自发一句话，各在各的会话里（假模型的回复是固定剧本，所以只看“自己发的那句”）
        await a.send("甲这边的一句话");
        await b.send("乙这边的一句话");
        await sleep(2000);
        const aSees = await a.text();
        const bSees = await b.text();
        check(aSees.includes("甲这边的一句话") && !aSees.includes("乙这边的一句话"), "甲那边只有甲发的消息");
        check(bSees.includes("乙这边的一句话") && !bSees.includes("甲这边的一句话"), "乙那边只有乙发的消息");

        // ---- 模拟一个 VSCode 窗口连上来：它该认自己工作区里的会话 ----
        const host = harness.host();
        const winDir = path.join(harness.cwd, "另一个项目");
        fs.mkdirSync(winDir, { recursive: true });
        const sent = [];
        // 屏连接：这个窗口打开着 winDir（后端默认目录是另一个）
        host.attachScreen("s-win-1", [winDir], (msg) => sent.push(msg));
        const { pageId } = host.processScreenMessage({ type: "newPage" }, "s-win-1");
        // 界面上那块网页视图就绪
        host.processPageMessage({ type: "ready" }, pageId);
        const winSession = await waitFor(() => {
            const rt = host.getActive(pageId);
            return rt && rt.cwd === winDir ? rt : null;
        }, 30000, "窗口的会话在它自己的工作区里起来");
        ok(`窗口自动认了自己工作区里的会话（${winSession.cwd}）`);
        check(winSession.cwd === winDir, "会话跑在窗口打开的那个目录里，而不是后端默认目录");
        check((await activeSessionOf(a)) === a1 && (await activeSessionOf(b)) === b1,
            "这个窗口起来后，两块浏览器页面的会话都没被牵动");

        // 同一块屏再说一次 ready：不该换会话
        host.processPageMessage({ type: "ready" }, pageId);
        await sleep(500);
        check(host.getActive(pageId)?.id === winSession.id, "同一块屏再说一次 ready，会话不换");

        // 窗口“重连”（插件换个新页面标识）：该接着看原来那个会话
        const again = host.processScreenMessage({ type: "newPage" }, "s-win-1");
        check(host.getActive(again.pageId)?.id === winSession.id, "窗口重连换了新页面标识，接着看原来那个会话");

        // 另一个窗口、另一个目录：各开各的
        const winDir2 = path.join(harness.cwd, "第三个项目");
        fs.mkdirSync(winDir2, { recursive: true });
        host.attachScreen("s-win-2", [winDir2], () => { /* 这一个不看它发什么 */ });
        const p2 = host.processScreenMessage({ type: "newPage" }, "s-win-2").pageId;
        host.processPageMessage({ type: "ready" }, p2);
        const rt2 = await waitFor(() => {
            const rt = host.getActive(p2);
            return rt && rt.cwd === winDir2 ? rt : null;
        }, 30000, "第二个窗口的会话起来");
        check(rt2.id !== winSession.id, "第二个窗口开了自己的会话（没跟第一个窗口共用）");
        check(host.getActive(pageId)?.id === winSession.id, "第一个窗口没被第二个牵动");

        // ---- 关掉一个正在被别的屏看着的会话：看它的屏留在原地 ----
        host.processPageMessage({ type: "closeSession", sessionId: rt2.id }, p2);
        await sleep(500);
        check(!host.panels.has(rt2.id), "会话被关掉了（进程停了、列表里没了）");
        check(host.focusedIdFor(pageId) === winSession.id, "关的是别人的会话：第一个窗口没被换走");

        // ---- 关掉一个正在被别的屏看着的会话：看它的屏留在原地，接着发消息会自动重开 ----
        const closedId = await activeSessionOf(a);
        host.processPageMessage({ type: "closeSession", sessionId: closedId }, p2);
        await sleep(2500);
        check(!host.panels.has(closedId), "会话被关掉了（进程停了、列表里没了）");
        check((await activeSessionOf(a)) === closedId, "甲还停在那个被关掉的会话上（画面留着）");
        const aText = await a.text();
        check(aText.includes("pi 进程已退出"), "甲那边有那行“进程已退出、发消息会自动重启”的提示");
        check(!(await a.eval("return !!document.querySelector('.closed-reopen')")), "没有额外加的按钮（不靠它）");
        await a.shot("focus-closed.png");
        // 接着往里发一句话：后端把这个会话重新打开，并从这话接着聊
        await a.send("接着聊");
        const reopened = await waitFor(async () => {
            const id = await activeSessionOf(a);
            return id && id !== closedId ? id : null;
        }, 30000, "发了一句话后会话被重新打开");
        check(reopened !== closedId, "往里发消息：会话自己重开了，画面切到新起来的那个");

        // ---- 那个 <<< 面板（项目与会话）：两块屏各开各的，一处开了不会把另一处收掉 ----
        await a.click("#browserMenuBtn");
        await sleep(1500);
        await b.click("#browserMenuBtn");
        await sleep(1500);
        const aOpen = await a.eval("return !document.getElementById('pickerOverlay').classList.contains('hidden')");
        const bOpen = await b.eval("return !document.getElementById('pickerOverlay').classList.contains('hidden')");
        check(aOpen, "甲开着“项目与会话”面板，乙也点开之后它还开着（不被顶掉）");
        check(bOpen, "乙那边也开着");
        await a.shot("focus-picker-a.png");
        await b.shot("focus-picker-b.png");
        // 点遮罩收掉两边的面板，别影响后面几步
        await a.eval("document.getElementById('pickerOverlay').click(); return true");
        await b.eval("document.getElementById('pickerOverlay').click(); return true");
        await sleep(800);

        const shotA = await a.shot("focus-a.png");
        const shotB = await b.shot("focus-b.png");
        console.log("截图：" + shotA);
        console.log("截图：" + shotB);
    } finally {
        for (const one of opened) { try { one.close(); } catch { /* 已经关了 */ } }
        await harness.stop();
    }
    console.log(failed === 0 ? "\n全部通过。" : `\n有 ${failed} 项没过。`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });

// @ts-nocheck
/**
 * turnNotice —— 验「某个会话跑完一轮发一条系统通知」（跑一遍就报结果，截图落在 dev/shots/）。
 *
 *   node dev/turnNotice.js
 *
 *   1. 正看着它跑完 —— 也发（这条规矩是“任何会话跑完都发”，不看你在不在看它）；
 *   2. 别的屏在聊的会话跑完 —— 这边也发（标题是那个会话的名字），点一下切过去；
 *   3. 自己按 Esc 停掉的那一轮 —— 不算跑完，不发；
 *   4. 派出去的子会话跑完 —— 不发（它的结果交回派它的会话，那边跑完再发一条）；
 *   5. 设置里那一项 —— 点一下关掉之后就不再发了。
 *
 * 无头浏览器里看不到真的通知卡片，所以把页面上的 Notification 换成一个只记账的假的：
 * 发不发、什么时候不发、标题正文写什么，仍然由页面上那段真代码决定。
 * 后端、会话编排、界面文件全是真的，只有“模型”是假的（dev/fake-pi）。
 */
const path = require("path");
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

let failed = 0;
function ok(text) { console.log("  ✔ " + text); }
function bad(text) { console.log("  ✘ " + text); failed += 1; }
function check(cond, text) { (cond ? ok : bad)(text); }

/** 把页面上的 Notification 换成记账的假的：每次 new 都进 window.__pops。 */
const STUB_NOTIFY = `
    window.__pops = [];
    window.Notification = function (title, opts) {
        this.title = title;
        this.body = (opts || {}).body || "";
        this.tag = (opts || {}).tag || "";
        this.onclick = null;
        window.__pops.push(this);
    };
    window.Notification.permission = "granted";
    window.Notification.requestPermission = function () { return Promise.resolve("granted"); };
    return true;
`;

/** 这块屏现在显示的是哪个会话（页面上挂着的那块窗格）。 */
async function activeSessionOf(page) {
    return page.eval(`
        const pane = document.querySelector('#messages .session-view:not(.off) .session-pane');
        return pane ? pane.dataset.sessionId : null;
    `);
}

/** 这块屏收到过的通知（没装假 Notification 时是空表）。 */
async function popsOf(page) {
    return (await page.eval("return (window.__pops || []).map((n) => ({ title: n.title, body: n.body, tag: n.tag, click: typeof n.onclick }))")) || [];
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

/** 打开设置浮层，点一下「跑完发系统通知」那一项。 */
async function clickNotifySwitch(page) {
    await page.eval(`
        const rows = Array.from(document.querySelectorAll('#viewOptsRoot .vo-item'));
        const row = rows.find((r) => {
            const label = r.querySelector('.vo-label');
            return label && label.textContent.indexOf('跑完发系统通知') >= 0;
        });
        if (!row) { return false; }
        row.click();
        return true;
    `);
}

async function main() {
    // 假模型每轮先停一下：验“按 Esc 停掉”那一步要来得及按下去
    process.env.FAKEPI_THINK_MS = "2500";
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
        const host = harness.host();
        const a = await openOne("甲");
        await a.waitReady();
        await a.eval(STUB_NOTIFY);

        // 通知是后端存着的总开关（这台调试机上可能是关着的）：先按界面上的那一项把它打开
        if (!host.getNotifyTurnEnd()) {
            await a.click("#browserMenuBtn");
            await sleep(1200);
            await a.click(".pk-footer-settings");
            await sleep(1200);
            await clickNotifySwitch(a);
            await sleep(1200);
        }
        check(host.getNotifyTurnEnd() === true, "「跑完发系统通知」开着（设置里那一项点得动）");

        // ---- 1. 正看着它跑完：也发 ----
        const sessA = await activeSessionOf(a);
        await a.send("你好");
        await a.waitAnswer("完事");
        const first = await waitFor(async () => ((await popsOf(a)).length >= 1 ? (await popsOf(a))[0] : null), 20000, "甲这边收到第一条通知");
        check(first.title && first.title !== "Pi Chat", "通知标题是会话名（" + first.title + "）");
        check(first.body.indexOf("好，我用三个工具") === 0, "正文是这一轮最后一段回复的开头（" + first.body.slice(0, 24) + "…）");
        check(first.tag === "pichat-turn-end-" + sessA, "同一条通知带着这个会话的标记（再来一条会原地替换）");
        check(first.click === "function", "通知上挂着“点一下切过去”");
        await a.shot("turnNotice-a.png");

        // ---- 2. 乙那边跑完的会话：甲没在看它，也该收到 ----
        const b = await openOne("乙");
        await b.waitReady();
        await b.eval(STUB_NOTIFY);
        await b.click("#newSessionBtn");
        const sessB = await waitFor(async () => {
            const id = await activeSessionOf(b);
            return id && id !== sessA ? id : null;
        }, 20000, "乙换到自己的会话");
        await b.send("乙这边的一句话");
        await b.waitAnswer("完事");
        const second = await waitFor(async () => {
            const pops = await popsOf(a);
            return pops.length >= 2 ? pops[pops.length - 1] : null;
        }, 20000, "甲这边收到乙那个会话跑完的通知");
        check(second.tag === "pichat-turn-end-" + sessB, "甲收到的是乙那个会话的通知（甲正在看的不是它）");
        // 点一下：甲该切到那个会话去
        await a.eval("window.__pops[window.__pops.length - 1].onclick(); return true;");
        const switched = await waitFor(async () => {
            const id = await activeSessionOf(a);
            return id === sessB ? id : null;
        }, 10000, "点了通知以后甲切过去");
        check(switched === sessB, "点通知把这块屏切到了那个会话");
        await a.shot("turnNotice-clicked.png");

        // ---- 3. 自己按 Esc 停掉的那一轮：不算跑完，不发 ----
        const before = (await popsOf(a)).length;
        await a.send("这一句会被停掉");
        await waitFor(() => a.eval("const b = document.querySelector('.session-view:not(.off) .msg-endhint-stop'); return !!(b && !b.classList.contains('hidden'));"), 20000, "停止按钮出现");
        await a.click("#messages .session-view:not(.off) .msg-endhint-stop");
        await sleep(6000);   // 等这一轮收尾（假模型会把剩下的剧本演完；真 pi 是收到 abort 就收）
        check((await popsOf(a)).length === before, "按 Esc 停掉的那一轮不发通知");

        // ---- 4. 子会话跑完：不发（结果交回派它的会话，那边跑完再发） ----
        const beforeChild = (await popsOf(a)).length;
        const parentId = await activeSessionOf(a);
        const panelsBefore = host.panels.size;
        await a.send("派活：看看认证模块");
        const spawned = await waitFor(() => host.panels.size > panelsBefore, 30000, "子会话被派出去");
        check(spawned === true, "这一步确实派出了一个子会话（不然下面一条等于白验）");
        await waitFor(async () => (await popsOf(a)).length > beforeChild, 60000, "父会话把结果接上、跑完");
        await sleep(2000);
        const fresh = (await popsOf(a)).slice(beforeChild);
        check(fresh.length >= 1 && fresh.every((p) => p.tag === "pichat-turn-end-" + parentId),
            "新来的通知都是父会话的（子会话跑完那一条没发）");

        // ---- 5. 把开关关掉：就不再发了 ----
        await a.click("#browserMenuBtn");
        await sleep(1200);
        await a.click(".pk-footer-settings");
        await sleep(1200);
        await clickNotifySwitch(a);
        await sleep(1200);
        check(host.getNotifyTurnEnd() === false, "设置里那一项点一下关掉了");
        const quietBefore = (await popsOf(a)).length;
        await a.send("关掉之后这一句");
        await a.waitAnswer("完事");
        await sleep(1500);
        check((await popsOf(a)).length === quietBefore, "关掉之后跑完不再发通知");
    } finally {
        for (const one of opened) { try { one.close(); } catch { /* 已经关了 */ } }
        await harness.stop();
    }
    console.log(failed === 0 ? "\n全部通过。" : `\n有 ${failed} 项没过。`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });

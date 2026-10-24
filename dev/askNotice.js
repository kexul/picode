// @ts-nocheck
/**
 * askNotice —— 验「模型问选择题（ask_choice）也发一条系统通知」（跑一遍就报结果，截图落在 dev/shots/）。
 *
 *   node dev/askNotice.js
 *
 *   1. 正看着它问 —— 也发（跟“跑完一轮”一个规矩：任何会话都发，不看你在不在看它）；
 *      标题是会话名，正文就是那个问题；标签按会话分开，跟“跑完一轮”那条互不顶掉；
 *   2. 别的屏在聊的会话在问 —— 这边也发（卡片只发给正看着那个会话的屏，这条谁都收得到），
 *      点一下切过去，那张卡片就在眼前；
 *   3. 扩展问的确认 / 输入 / 选一个 —— 不发（只管模型的 ask_choice）；
 *   4. 设置里那一项关掉 —— 不发。
 *
 * 无头浏览器里看不到真的通知卡片，所以把页面上的 Notification 换成只记账的假的（跟 turnNotice.js
 * 同一套）：发不发、标题正文写什么，仍然由页面上那段真代码决定。模型是假的（dev/fake-pi），
 * 后端、会话编排、界面文件全是真的。
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

/** 打开设置浮层，点一下「跑完发系统通知」那一项（它现在管两件事：跑完一轮、模型提问）。 */
async function clickNotifySwitch(page) {
    await page.eval(`
        const rows = Array.from(document.querySelectorAll('#viewOptsRoot .vo-item'));
        const row = rows.find((r) => {
            const label = r.querySelector('.vo-label');
            return label && label.textContent.indexOf('系统通知') >= 0;
        });
        if (!row) { return false; }
        row.click();
        return true;
    `);
}

/** 等消息流里出现一张还等着作答的问话卡片。 */
async function waitCard(page, ms) {
    await waitFor(
        () => page.eval("return document.querySelectorAll('#messages .ask-card:not(.done)').length > 0;"),
        ms,
        "问话卡片出来",
    );
}

/** 在最后一张还等着作答的卡片里点第 index 个选项（选完这张卡片就定住了）。 */
async function pickOption(page, index) {
    await page.eval(`
        const cards = document.querySelectorAll('#messages .ask-card:not(.done)');
        const card = cards[cards.length - 1];
        if (!card) { return false; }
        const opts = card.querySelectorAll('.ask-opt');
        if (opts.length <= ${index}) { return false; }
        opts[${index}].click();
        return true;
    `);
}

/** 等这一轮跑完（停止生成那颗按钮收起来）。 */
async function waitIdle(page) {
    await waitFor(
        () => page.eval("const b = document.querySelector('.session-view:not(.off) .msg-endhint-stop'); return !!(b && b.classList.contains('hidden'));"),
        30000,
        "这一轮跑完",
    );
    await sleep(500);
}

async function main() {
    const quiet = (text) => { if (/错误|error|失败/.test(text)) { console.log("  [日志] " + text); } };
    const harness = createHarness({ fakePi: true, notifyTurnEnd: true, log: quiet });
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

        // 通知是后端存着的总开关（调试默认是关着的，见 harness.js 的 patch）：先按界面上那一项把它打开
        if (!host.getNotifyTurnEnd()) {
            await a.click("#browserMenuBtn");
            await sleep(1200);
            await a.click(".pk-footer-settings");
            await sleep(1200);
            await clickNotifySwitch(a);
            await sleep(1200);
            await a.click("#settingsClose");   // 收起来：截图要的是对话那边
            await sleep(600);
        }
        check(host.getNotifyTurnEnd() === true, "「跑完发系统通知」开着（它同时也管模型提问那一条）");

        // ---- 1. 甲正看着自己的会话，模型在那儿问：也发 ----
        const sessA = await activeSessionOf(a);
        await a.send("问单选");
        await waitCard(a, 20000);
        const askA = await waitFor(async () => {
            const pops = await popsOf(a);
            return pops.length > 0 ? pops[pops.length - 1] : null;
        }, 20000, "甲这边收到“模型在问”那条通知");
        check(askA.tag === "pichat-ask-" + sessA, "标签按会话分开，跟“跑完一轮”那条不撞：" + askA.tag);
        check(askA.title && askA.title !== "Pi Chat", "标题是会话名（" + askA.title + "）");
        check(askA.body === "选 A 还是 B？", "正文就是模型问的那句话（" + askA.body + "）");
        check(askA.click === "function", "通知上挂着“点一下切过去”");
        await a.shot("askNotice-a.png");
        // 答掉它，这一轮好接着往下走（跑完那一轮还会再来一条“跑完”的通知，那条不管）
        await pickOption(a, 0);
        await waitIdle(a);

        // ---- 2. 乙的会话在问：甲没在看它，也该收到；点一下切过去 ----
        const askedInA = await popsOf(a);   // 此刻甲这边的表（1 里那条“跑完”的通知也在里头）
        const b = await openOne("乙");
        await b.waitReady();
        await b.eval(STUB_NOTIFY);
        await b.click("#newSessionBtn");
        const sessB = await waitFor(async () => {
            const id = await activeSessionOf(b);
            return id && id !== sessA ? id : null;
        }, 20000, "乙换到自己的会话");
        await b.send("问单选");
        await waitCard(b, 20000);
        const askB = await waitFor(async () => {
            const pops = await popsOf(a);
            const last = pops[pops.length - 1];
            return last && last.tag === "pichat-ask-" + sessB ? last : null;
        }, 20000, "甲这边收到乙那个会话在问的通知");
        check(askB.body === "选 A 还是 B？", "甲收到的是乙那个会话的问题（甲正在看的不是它）");
        check(askedInA.every((p) => p.tag !== askB.tag), "这条是刚来的，不是 1 里那条");
        // 点一下：甲该切到那个会话去，卡片就在那儿等着答
        await a.eval("window.__pops[window.__pops.length - 1].onclick(); return true;");
        const switched = await waitFor(async () => {
            const id = await activeSessionOf(a);
            return id === sessB ? id : null;
        }, 10000, "点了通知以后甲切过去");
        check(switched === sessB, "点通知把这块屏切到了那个会话");
        await sleep(500);   // 等那一屏的淡入绘完（截图好看）
        await a.shot("askNotice-clicked.png");
        await waitCard(a, 10000);
        await pickOption(a, 0);
        await waitIdle(a);

        // ---- 3. 扩展问的确认：不发（只管模型的 ask_choice） ----
        const beforeConfirm = (await popsOf(a)).length;
        await a.send("问确认");
        await waitCard(a, 20000);
        check((await popsOf(a)).length === beforeConfirm, "扩展问的确认 / 输入 / 选一个不发通知（只管模型问的选择题）");
        await a.shot("askNotice-confirm.png");
        await a.eval(`
            const cards = document.querySelectorAll('#messages .ask-card:not(.done)');
            cards[cards.length - 1].querySelector('.ask-btn.primary').click();
            return true;
        `);
        await waitIdle(a);

        // ---- 4. 把开关关掉：就不再发了 ----
        await a.click("#browserMenuBtn");
        await sleep(1200);
        await a.click(".pk-footer-settings");
        await sleep(1200);
        await clickNotifySwitch(a);
        await sleep(1200);
        check(host.getNotifyTurnEnd() === false, "设置里那一项点一下关掉了");
        await a.click("#settingsClose");   // 收起来：下一张截图要的是对话那边
        await sleep(600);
        const beforeQuiet = (await popsOf(a)).length;
        await a.send("问单选");
        await waitCard(a, 20000);
        await sleep(1000);
        check((await popsOf(a)).length === beforeQuiet, "关掉之后模型提问不再发通知");
        await a.shot("askNotice-off.png");
        // 收摊前把这张卡片答掉：留着它，后端那条“最多等 25 分钟”的定时器撑着，这个进程就不退出了
        await pickOption(a, 0);
        await waitIdle(a);
    } finally {
        for (const one of opened) { try { one.close(); } catch { /* 已经关了 */ } }
        await harness.stop();
    }
    console.log(failed === 0 ? "\n全部通过。" : `\n有 ${failed} 项没过。`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });

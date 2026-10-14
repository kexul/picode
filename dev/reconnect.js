// @ts-nocheck
/**
 * reconnect —— 验「断线重连」（跑一遍就报结果，截图落在 dev/shots/）。
 *
 *   node dev/reconnect.js                  # 全部场景
 *   node dev/reconnect.js --scene freeze    # 只跑某一个
 *   RECON_HOLD_MS=60000 node dev/reconnect.js --scene both    # 锁屏时长自己定
 *
 * 要复现的是手机上的那一路：会话正在输出，页面被切到后台 / 锁屏（系统把页面冻住、
 * 连接被掐掉或看着还活着其实已经死了），回来之后会话已经输出完了。这时界面上：
 *   - 停止生成那颗方块该收起来；
 *   - 状态栏那三点动画该停；
 *   - 会话名字那颗点该不闪；
 *   - 正文该跟着输出继续长（不是等跑完一次性冒出来）。
 *
 * 冻住用浏览器调试接口的 Page.setWebLifecycleState(frozen/active) 做（手机锁屏时
 * 浏览器冻页面就是这回事）；断网用 Network.emulateNetworkConditions(offline) 做。
 * 会话、网页服务、界面文件全是真的，只有"模型"是假的（dev/fake-pi）。
 *
 * 两个调试接口的坑，验之前知道一下：
 *   - 解冻后 document.visibilityState 不会变回 visible（无头浏览器就这样），所以
 *     那以后浏览器再也不出帧——流式正文得靠"工具卡片 / streamEnd"这类消息顺手重画
 *     （真人手机上会出帧，正文自己会继续长，不在本工具验的范围）；
 *   - 断网只管新请求：已经建好的推送连接照旧收得到东西（所以场景二、三能验到
 *     "连接还在、钩子断过"那一档）。
 *
 * 场景六验的是“锁屏期间连接悄悄断了、回来时页面该自己重开一次连接并补回丢掉的消息”。
 * 场景七验的是同一件事的第二面：断线那段里后端发出的问话卡片（定向发、不带走序号的那套补发账）
 * 回来之后不该丢，且页面手上已经有的那张不该被重发打扰。
 * 还留了一个小口子（故意没堵）：离开不到 3 秒就回来的不重开，
 * 那点时间里丢的尾部消息要等“75 秒没收到心跳”的看门狗才能补上。
 */
const fs = require("fs");
const path = require("path");
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

// 假模型：慢一点，让"正在输出"的那几秒足够长（每轮思考 1200ms、文字每 6 个字 60ms）
process.env.FAKEPI_THINK_MS = process.env.FAKEPI_THINK_MS || "1200";
process.env.FAKEPI_TICK_MS = process.env.FAKEPI_TICK_MS || "60";
/** 冻住 / 断网一次停多久（毫秒）：默认够假模型把一整轮跑完。 */
const HOLD_MS = Number(process.env.RECON_HOLD_MS || 12000);

let failed = 0;
function ok(text) { console.log("  ✔ " + text); }
function bad(text) { console.log("  ✘ " + text); failed += 1; }
function check(cond, text) { (cond ? ok : bad)(text); }

// ============================================================================
//  页面上的读数与等待
// ============================================================================

/** 界面上"正在输出"相关的几处状态。 */
async function uiState(page) {
    return page.eval(`
        const stop = document.getElementById('stopBtn');
        const status = document.querySelector('.pane-status');
        const nameBtn = document.getElementById('sessionName');
        const bubbles = document.querySelectorAll('.msg.assistant');
        return {
            stopShown: !!(stop && !stop.classList.contains('hidden')),
            typing: !!document.querySelector('.typing'),
            nameStreaming: !!(nameBtn && nameBtn.classList.contains('streaming')),
            status: status ? status.innerText.replace(/\\s+/g, ' ').trim() : '',
            answer: Array.from(bubbles).map(function (e) { return e.innerText; }).join('\\n'),
            lastAnswer: bubbles.length ? bubbles[bubbles.length - 1].innerText : '',
        };
    `);
}

function printState(tag, st) {
    console.log(`  · ${tag}：停止键=${st.stopShown ? "显示" : "收起"} 三点动画=${st.typing ? "在动" : "停了"} ` +
        `名字闪=${st.nameStreaming ? "是" : "否"} 状态栏="${st.status}"`);
}

/** 页面上的正文（助手气泡）。 */
async function answerText(page) {
    return page.eval("return Array.from(document.querySelectorAll('.msg.assistant')).map(function (e) { return e.innerText; }).join('\\n')");
}

/** 三条"还在输出"的界面证据都齐了吗（停止键 + 三点动画 + 名字在闪）。 */
function looksStreaming(st) { return st.stopShown && st.typing; }

/** 等界面上出现"正在输出"的样子。 */
async function waitStreaming(page, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        const st = await uiState(page);
        if (looksStreaming(st)) { return st; }
        if (Date.now() > deadline) { return null; }
        await sleep(200);
    }
}

/** 一直等到界面上不再显示"正在输出"为止；返回最后的界面状态。 */
async function waitIdle(page, ms) {
    const deadline = Date.now() + ms;
    let st = await uiState(page);
    while (Date.now() < deadline) {
        st = await uiState(page);
        if (!st.stopShown && !st.typing && !st.nameStreaming) { return st; }
        await sleep(300);
    }
    return st;
}

/** 页面上收到的每条消息记一笔（诊断用，失败时能看出是"没收到"还是"收到了没画"）。 */
async function watchMessages(page) {
    await page.eval(`
        window.__msgLog = [];
        window.addEventListener('message', function (ev) {
            var d = ev.data;
            if (!d || typeof d.type !== 'string') { return; }
            var item = { t: Date.now(), type: d.type, seq: d.seq };
            if (d.type === 'sessionList') {
                item.sessions = (d.sessions || []).map(function (s) { return s.id + ':' + (s.streaming ? '跑' : '闲'); }).join(' ');
            }
            window.__msgLog.push(item);
        });
        return true;
    `);
}

/** 打印页面收到了哪些消息（张数 + 与状态有关的那几类的时间线）。 */
async function dumpMessages(page, tag) {
    const log = await page.eval("return window.__msgLog");
    const t0 = log.length > 0 ? log[0].t : 0;
    const counts = new Map();
    for (const m of log) { counts.set(m.type, (counts.get(m.type) || 0) + 1); }
    console.log(`  · ${tag}收到的消息（共 ${log.length} 条）：` +
        Array.from(counts.entries()).map(([k, v]) => `${k}×${v}`).join(" "));
    const keep = log.filter((m) => ["hello", "syncPoint", "sessionList", "sessionActivated", "streamStart", "streamEnd", "clear", "historyWindow", "systemError"].includes(m.type));
    for (const m of keep) {
        console.log(`      +${String(m.t - t0).padStart(6)}ms ${m.type}${m.seq === undefined ? "" : " #" + m.seq}${m.sessions ? " [" + m.sessions + "]" : ""}`);
    }
}

/** 这块屏是哪一个页面（服务写在 meta 里），后端靠它认连接。 */
async function pageIdOf(page) {
    return page.eval("const m = document.querySelector('meta[name=pichat-page]'); return m ? m.getAttribute('content') : '';");
}

/** 后端还挂着的问话卡片（发出去等作答的那些）。 */
async function backendCards(host) {
    const out = [];
    for (const [id, st] of host.openCards || []) {
        out.push({ id, settled: st.settled, screens: Array.from(st.screens) });
    }
    return out;
}

/** 等后端挂出一张还没收尾的卡片（页面收不到也没关系，等着作答的那张就算）。 */
async function waitBackendCard(host, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        const cards = await backendCards(host);
        const open = cards.filter((c) => !c.settled);
        if (open.length > 0) { return open[open.length - 1]; }
        if (Date.now() > deadline) { return null; }
        await sleep(200);
    }
}

/** 消息流里有没有一张还等着作答的问话卡片。 */
async function cardOnPage(page) {
    return page.eval("return document.querySelectorAll('.ask-card:not(.done)').length > 0;");
}

/** 消息流里有没有一张已经定住的问话卡片。 */
async function cardDoneOnPage(page) {
    return page.eval("return document.querySelectorAll('.ask-card.done').length > 0;");
}

/** 一直等到消息流里出现一张还等着作答的卡片（或超时返回 false）。 */
async function waitCardOnPage(page, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        if (await cardOnPage(page)) { return true; }
        if (Date.now() > deadline) { return false; }
        await sleep(300);
    }
}

// ============================================================================
//  场景
// ============================================================================

async function sceneFreeze(page) {
    console.log("\n【场景一】正在输出时页面被冻住（手机锁屏），回来时会话已经跑完");
    await page.send("随便说点什么");
    const before = await waitStreaming(page, 15000);
    if (!before) { bad("没等到“正在输出”（停止键 + 三点动画）出现，后面没法验"); return; }
    printState("冻住前", before);
    await page.shot("recon-1-freeze-before.png");

    await page.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    console.log(`  · 页面已冻住，等 ${HOLD_MS} 毫秒（这段时间会话会跑完）`);
    await sleep(HOLD_MS);
    await page.cdp.send("Page.setWebLifecycleState", { state: "active" });
    console.log("  · 页面已解冻");

    await waitIdle(page, 10000);
    await page.sleep(500);
    const final = await uiState(page);
    printState("回来之后", final);
    await dumpMessages(page, "场景一");
    await page.shot("recon-1-freeze-after.png");
    check(!final.stopShown, "停止生成那颗方块收起来了");
    check(!final.typing, "状态栏那三点动画停了");
    check(!final.nameStreaming, "会话名字那颗点不闪了");
    check(final.answer.includes("完事"), "会话的最后一句话在页面上");
}

async function sceneOffline(page) {
    console.log("\n【场景二】正在输出时断网（Wi-Fi 切流量），网络回来时会话已经跑完");
    await page.cdp.send("Network.enable");
    await page.send("再随便说点什么");
    const before = await waitStreaming(page, 15000);
    if (!before) { bad("没等到“正在输出”出现，后面没法验"); return; }
    printState("断网前", before);
    await page.shot("recon-2-offline-before.png");

    await page.cdp.send("Network.emulateNetworkConditions", {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    console.log(`  · 已断网，等 ${HOLD_MS} 毫秒（这段时间会话会跑完）`);
    await sleep(HOLD_MS);
    await page.cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    console.log("  · 网络已恢复");

    await waitIdle(page, 10000);
    await page.sleep(500);
    const final = await uiState(page);
    printState("网络恢复后", final);
    await page.shot("recon-2-offline-after.png");
    check(!final.stopShown, "停止生成那颗方块收起来了");
    check(!final.typing, "状态栏那三点动画停了");
    check(!final.nameStreaming, "会话名字那颗点不闪了");
}

async function sceneBoth(page) {
    console.log("\n【场景三】页面冻住 + 断网（锁屏、无线电也停了），回来时会话已经跑完");
    await page.cdp.send("Network.enable");
    await page.send("再随便说点什么");
    const before = await waitStreaming(page, 15000);
    if (!before) { bad("没等到“正在输出”出现，后面没法验"); return; }
    printState("锁屏前", before);
    await page.shot("recon-3-both-before.png");

    await page.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    await page.cdp.send("Network.emulateNetworkConditions", {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    console.log(`  · 已冻住 + 断网，等 ${HOLD_MS} 毫秒（这段时间会话会跑完）`);
    await sleep(HOLD_MS);
    await page.cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    await page.cdp.send("Page.setWebLifecycleState", { state: "active" });
    console.log("  · 网络已恢复、页面已解冻");

    await waitIdle(page, 12000);
    await page.sleep(500);
    const final = await uiState(page);
    printState("回来之后", final);
    await dumpMessages(page, "场景三");
    await page.shot("recon-3-both-after.png");
    check(!final.stopShown, "停止生成那颗方块收起来了");
    check(!final.typing, "状态栏那三点动画停了");
    check(!final.nameStreaming, "会话名字那颗点不闪了");
    check(final.answer.includes("完事"), "会话的最后一句话在页面上");
}

/**
 * 断线期间模型问的那道选择题：连接悄悄死了（后端不知道，卡片写进去看着成功、页面其实没收到），
 * 回来重连对账之后卡片该补回消息流里，并且照常答得下去。
 *
 * 模拟“悄悄死掉”的办法：把后端那条连接的 send 换成黑洞 —— 写进去当成功，页面收不到
 * （手机锁屏后网络那头把会话收了、浏览器不报错，就是这个样子）。之后的断网 + 收掉旧连接,
 * 对应“人回到前台、页面自己重开一条连接回来”。
 */
async function sceneAskCard(page, harness) {
    console.log("\n【场景七】断线期间问的选择题：回来重连之后卡片还在不在、还能不能答");
    const pageId = await pageIdOf(page);
    const host = harness.host();
    const channel = host.getBroadcaster().getChannel(pageId);
    if (!channel) { bad("拿不到页面的推送连接，没法验"); return; }
    await page.send("随便说点什么");
    await waitIdle(page, 20000);

    // 这条连接变成黑洞：卡片写进去当成功，页面其实收不到
    const original = channel.send;
    channel.send = () => { /* 丢掉 */ };
    await page.send("问单选");
    const card = await waitBackendCard(host, 20000);
    channel.send = original;
    if (!card) { bad("后端没挂出卡片，后面没法验"); return; }
    console.log(`  · 卡片 ${card.id} 已问出、后端以为发给了：${JSON.stringify(card.screens)}（页面其实没收到）`);
    check(card.screens.length === 1, "卡片发出时后端以为页面收到了（正是那条死连接骗过它的地方）");

    // 人回到前台：网络通一下、旧连接被收掉，页面自己重开一条连接回来
    console.log("  · 模拟人回到前台（旧连接收掉、页面重连对账）");
    await page.cdp.send("Network.enable");
    await page.cdp.send("Network.emulateNetworkConditions", {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    channel.close("");
    await sleep(1500);
    await page.cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });

    const shown = await waitCardOnPage(page, 25000);
    await page.sleep(500);
    await page.shot("recon-7-askcard-back.png");
    check(shown, "重连之后卡片补回到消息流里了");
    if (!shown) { return; }

    // 补回来的卡片得能答：点第一行选项
    await page.eval(`(() => {
        const cs = document.querySelectorAll('.ask-card:not(.done)');
        const c = cs[cs.length - 1];
        c.querySelectorAll('.ask-opt')[0].click();
    })(); return true;`);
    const deadline = Date.now() + 20000;
    let done = false;
    while (Date.now() < deadline) {
        if (await cardDoneOnPage(page)) { done = true; break; }
        await sleep(300);
    }
    await page.sleep(800);
    await page.shot("recon-7-askcard-done.png");
    check(done, "补回来的卡片答得下去（点完就定住）");
    check(/用户选了|选的是/.test(await page.text()), "答案送到了模型那边（工具结果里写着你选的哪一项）");

    // 顺带验一下：页面手上本来就有的卡片，重连对账重发时不该被动
    // （动它就等于把人打了一半的字捎掉、把滚动位置抖一下）
    console.log("  · 再验一次：页面手上已经有这张卡片时，重连不去动它");
    await page.send("问单选");
    const again = await waitCardOnPage(page, 25000);
    check(again, "第二张卡片正常画出来了");
    if (!again) { return; }
    // 在卡片上做个记号、往“自己写”里打一半的字
    await page.eval(`(() => {
        const cs = document.querySelectorAll('.ask-card:not(.done)');
        const c = cs[cs.length - 1];
        c.dataset.probe = "kept";
        c.querySelector('.ask-input').value = "写了一半";
    })(); return true;`);
    // 再来一次断线重连（这次卡片已经在页面上了）
    const channel2 = host.getBroadcaster().getChannel(pageId);
    await page.cdp.send("Network.emulateNetworkConditions", {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    if (channel2) { channel2.close(""); }
    await sleep(1500);
    await page.cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    await sleep(6000);
    const kept = await page.eval(`
        const c = document.querySelector('.ask-card[data-probe=kept]');
        const i = c ? c.querySelector('.ask-input') : null;
        return i ? i.value : "";
    `);
    await page.shot("recon-7-askcard-kept.png");
    check(kept === "写了一半", "重连重发没动页面上那张卡片（记号与打了一半的字都留着）");
    // 把这张答掉收尾，别让它挂着等 25 分钟
    await page.eval(`(() => {
        const cs = document.querySelectorAll('.ask-card:not(.done)');
        if (cs.length) { cs[cs.length - 1].querySelectorAll('.ask-opt')[1].click(); }
    })(); return true;`);
    await sleep(800);
}

/** 一边输出一边反复冻住 / 解冻（手机上反复锁屏、亮屏）。 */
async function sceneFuzz(page) {
    console.log("\n【场景四】一边输出一边反复冻住 / 解冻");
    await page.send("随便说点什么");
    const before = await waitStreaming(page, 15000);
    if (!before) { bad("没等到“正在输出”出现，后面没法验"); return; }
    printState("开始前", before);
    const started = Date.now();
    let cycles = 0;
    while (Date.now() - started < Number(process.env.RECON_FUZZ_MS || 14000)) {
        await page.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
        await sleep(300 + Math.random() * 1200);
        await page.cdp.send("Page.setWebLifecycleState", { state: "active" });
        await sleep(300 + Math.random() * 900);
        cycles += 1;
    }
    console.log(`  · ${cycles} 轮冻住 / 解冻做完了，等它收尾`);
    await waitIdle(page, 20000);
    await page.sleep(600);
    const final = await uiState(page);
    printState("收尾后", final);
    await dumpMessages(page, "场景四");
    await page.shot("recon-4-fuzz-after.png");
    check(!final.stopShown, "停止生成那颗方块收起来了");
    check(!final.typing, "状态栏那三点动画停了");
    check(final.answer.includes("完事"), "会话的最后一句话在页面上");
}

/**
 * 反复把页面那条推送连接从服务端杀掉（模拟网络抽风、浏览器把连接搞丢）。
 * 验补发那套序号账：正文不能多一段（重复补发）也不能少一段（漏补）。
 */
async function sceneChurn(page, harness) {
    console.log("\n【场景五】一边输出一边反复把连接弄断（验序号补发：不重不漏）");
    const pageId = await pageIdOf(page);
    const broadcaster = harness.host().getBroadcaster();
    await page.send("随便说点什么");
    const before = await waitStreaming(page, 15000);
    if (!before) { bad("没等到“正在输出”出现，后面没法验"); return; }
    const started = Date.now();
    let kills = 0;
    while (Date.now() - started < Number(process.env.RECON_CHURN_MS || 12000)) {
        const channel = broadcaster.getChannel(pageId);
        if (channel) { channel.close(""); kills += 1; }
        await sleep(400 + Math.random() * 900);
    }
    console.log(`  · 弄断了 ${kills} 次，等它收尾`);
    await waitIdle(page, 20000);
    await page.sleep(800);
    const final = await uiState(page);
    printState("收尾后", final);
    await page.shot("recon-5-churn-after.png");
    check(!final.stopShown, "停止生成那颗方块收起来了");
    check(!final.typing, "状态栏那三点动画停了");
    // 假模型的收尾那句话在一条回复里只能出现一次：两次就是补发重复了，一次都没有就是漏补
    const hits = (final.lastAnswer.match(/完事。三个工具都跑过了/g) || []).length;
    check(hits === 1, `这一轮的收尾那句话出现了 ${hits} 次（应为 1 次）`);
}

/**
 * 锁屏期间那条连接其实是死的（运营商把会话收掉、浏览器不报错），断之前最后那几下
 * 心跳已经进了浏览器手里 —— 页面不重连，死后发出去的尾巴（跑完那条 streamEnd、
 * 带“不再生成”的会话列表）就再也收不到。
 *
 * 这里把后半段直接造出来：正文照发（那些在断线之前），尾巴那两条不给它。
 * 应该看到的是：回来时页面把连接重开一次、把丢的那几条补回来，界面自己变正常。
 */
async function sceneTailLost(page, harness) {
    console.log("\n【场景六】锁屏期间连接悄悄断了：正文到了、尾巴丢了，回来能不能自己恢复");
    const pageId = await pageIdOf(page);
    const channel = harness.host().getBroadcaster().getChannel(pageId);
    if (!channel) { bad("拿不到页面的推送连接，没法验"); return; }
    await page.send("随便说点什么");
    const before = await waitStreaming(page, 15000);
    if (!before) { bad("没等到“正在输出”出现，后面没法验"); return; }
    printState("开始前", before);

    // 从现在起，尾巴那两条不给它（正文照发、心跳照发）
    const original = channel.send;
    let dropped = 0;
    channel.send = (msg) => {
        const t = msg && msg.type;
        if (t === "streamEnd" || t === "sessionList") { dropped += 1; return; }
        return original(msg);
    };
    console.log(`  · 尾巴（streamEnd / sessionList）不再发给页面；冻住页面，等这一轮跑完`);
    await page.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    await sleep(Number(process.env.RECON_TAIL_MS || 10000));
    await page.cdp.send("Page.setWebLifecycleState", { state: "active" });
    channel.send = original;
    console.log("  · 页面已解冻（这之后它该自己重开连接、把丢的补回来）");

    const settled = await waitIdle(page, 10000);
    await page.sleep(500);
    const final = await uiState(page);
    printState("回来之后", final);
    await dumpMessages(page, "场景六");
    await page.shot("recon-6-taillost-after.png");
    check(final.answer.includes("完事"), "正文是完整的");
    check(!final.stopShown && !final.typing && !final.nameStreaming,
        "界面不卡在“正在输出”（停止键收起来、三点动画停、名字不闪）" +
        (settled.stopShown || settled.typing ? "  ← 卡住了：正文到了、状态没跟上" : ""));
}

// ============================================================================
//  入口
// ============================================================================

async function main() {
    const at = process.argv.indexOf("--scene");
    // 可以写一个场景名，也可以用逗号连线写几个：--scene freeze,offline
    const sceneArg = at >= 0 ? (process.argv[at + 1] || "all") : "all";
    const scenes = {
        freeze: (page) => sceneFreeze(page),
        offline: (page) => sceneOffline(page),
        both: (page) => sceneBoth(page),
        fuzz: (page) => sceneFuzz(page),
        churn: (page, harness) => sceneChurn(page, harness),
        taillost: (page, harness) => sceneTailLost(page, harness),
        askcard: (page, harness) => sceneAskCard(page, harness),
    };
    const chosen = sceneArg === "all" ? Object.keys(scenes) : sceneArg.split(",");
    for (const name of chosen) {
        if (!scenes[name]) { throw new Error(`不认识这个场景：${name}（可用的：${Object.keys(scenes).join(" / ")} / all）`); }
    }

    const quiet = (text) => { if (/错误|error|失败/.test(text)) { console.log("  [日志] " + text); } };
    const harness = createHarness({ fakePi: true, log: quiet });
    const url = await harness.start();
    console.log("调试后端：" + url);
    let open;
    try {
        open = await openPage({ url, shotDir: path.join(__dirname, "shots"), timeoutMs: 60000 });
        // 页面里的 console 都收下来（重连、看门狗那几条 warn 是判断走了哪条路的关键）
        open.page.cdp.on("Runtime.consoleAPICalled", (params) => {
            if (!params || (params.type !== "warning" && params.type !== "error")) { return; }
            const text = (params.args || []).map((a) => (a && (a.value ?? a.description)) || "").join(" ");
            console.log("  [页面] " + text);
        });
        await open.page.waitReady();
        console.log("界面已就绪");
        await watchMessages(open.page);

        for (const name of chosen) { await scenes[name](open.page, harness); }

        const errs = open.page.pageErrors || [];
        if (errs.length) {
            console.log("\n页面报错（" + errs.length + " 条）：");
            for (const e of errs.slice(0, 10)) { console.log("  ! " + e); }
        }
    } finally {
        if (open) { try { await open.close(); } catch { /* 收摊出错不拦路 */ } }
        try { await harness.stop(); } catch { /* 收摊出错不拦路 */ }
    }
    console.log("");
    console.log(failed === 0 ? "结果：全部通过" : `结果：${failed} 项没过`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("\n出错了：" + (err?.stack || err?.message || err));
    process.exit(1);
});

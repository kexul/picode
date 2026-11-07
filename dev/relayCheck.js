// @ts-nocheck
/**
 * relayCheck —— 验「后端重启不掐 pi」（中转那一层，第一笔）。
 *
 *   npm run compile && node dev/relayCheck.js
 *
 * 纯 Node，不开浏览器、不叫真模型：起一个真后端（PICHAT_HOME 指到临时目录），
 * 用假 pi 跑一轮，然后照「编译并重启」那套（quiet + keepPi）把后端停掉、再起一个，
 * 看这几件事：
 *
 *   一、pi 没死：中转手里还是同一只（key / pid 不变），会话文件也一样；
 *   二、会话认回来了：新后端的会话表里还是原来那个会话 id，页面重连就看得见；
 *   三、还在接着说话：新后端往同一只 pi 发一句话，照样有回话（pid 还是那个）；
 *   四、Ctrl+C 才是全收：正常收摊以后中转退出、pi 没了、地址文件清掉。
 */
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-relay-"));
process.env.PICHAT_HOME = path.join(tmpRoot, "pichat");
const workDir = path.join(tmpRoot, "work");
fs.mkdirSync(workDir, { recursive: true });
// 假模型：每轮慢一点，好在"正在跑"的当中重启（秒回的话来不及看）
process.env.PICHAT_PI = path.join(__dirname, process.platform === "win32" ? "fake-pi.cmd" : "fake-pi.sh");
process.env.FAKEPI_THINK_MS = process.env.FAKEPI_THINK_MS || "1500";
process.env.FAKEPI_TICK_MS = process.env.FAKEPI_TICK_MS || "40";
// 「长话」那一场要慢慢吐够几秒，好在中间重启（见下面四之三）
process.env.FAKEPI_LONG_PIECES = process.env.FAKEPI_LONG_PIECES || "80";

const { startBackend } = require(path.join(repoRoot, "out", "server", "serverMain.js"));
const { relayLink } = require(path.join(repoRoot, "out", "server", "relayClient.js"));

// 桥接扩展（派子活 / 提问 / 后台命令 / 加载了什么）:真后端的 main() 里会写一份，
// 这里直接调 startBackend，所以得自己写（跟 dev/harness.js 一个道理），不然问话/后台命令都是坏的。
const bridgeAssets = require(path.join(repoRoot, "out", "server", "bridgeAssets.js"));
const { readServerConfig, seedPrompts } = require(path.join(repoRoot, "out", "server", "serverConfig.js"));
const { appVersion } = require(path.join(repoRoot, "out", "server", "appAssets.js"));
const VERSION = appVersion();
seedPrompts();
const PROMPTS = readServerConfig().config.prompts;
bridgeAssets.ensureTabaAssets(VERSION, PROMPTS);
bridgeAssets.ensureAskAssets(VERSION, PROMPTS);
bridgeAssets.ensureImageAssets(VERSION);
bridgeAssets.ensureBashAssets(VERSION, PROMPTS);
bridgeAssets.ensureEnvAssets(VERSION);

let failed = 0;
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readAddr = () => JSON.parse(fs.readFileSync(path.join(process.env.PICHAT_HOME, "relay.json"), "utf8"));

/** 一条装着"页面"的连接：收后端推来的消息，也能往回发。 */
function openPage(baseUrl, pageId) {
    const state = { messages: [], closed: false };
    const url = new URL("events?pageId=" + pageId, baseUrl);
    const req = http.get(url, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
                const block = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
                if (!dataLine) { continue; }
                try { state.messages.push(JSON.parse(dataLine.slice(6))); } catch { /* 不是 JSON 就算了 */ }
            }
        });
        res.on("end", () => { state.closed = true; });
        res.on("error", () => { state.closed = true; });
    });
    req.on("error", () => { state.closed = true; });
    state.req = req;
    state.close = () => { try { req.destroy(); } catch { /* 已经断了 */ } };
    state.post = (msg) => new Promise((resolve) => {
        const body = JSON.stringify(msg);
        const r = http.request(new URL("api?pageId=" + pageId, baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, (res) => { res.resume(); res.on("end", resolve); });
        r.on("error", resolve);
        r.end(body);
    });
    /**
     * 等"下一条"满足条件的消息（从上次等到的那条往后找）。
     * 不能扫全部历史：会话表那种消息一路都在推，旧的一条（当时还没在跑）会让断言当场通过。
     */
    state.cursor = 0;
    state.waitFor = async (pred, timeoutMs = 20000) => {
        const limit = Date.now() + timeoutMs;
        while (Date.now() < limit) {
            for (let i = state.cursor; i < state.messages.length; i++) {
                if (pred(state.messages[i], i)) {
                    state.cursor = i + 1;
                    return state.messages[i];
                }
            }
            await sleep(80);
        }
        return undefined;
    };
    state.last = (type) => [...state.messages].reverse().find((m) => m.type === type);
    return state;
}

/**
 * 页面收到的正文增量接起来（正文是逐字推的，一条只有几个字）。
 * @param from 从第几条消息起算（默认全部）
 * @param only 只看这个会话（默认全都算：一个页面会同时收到好几个会话的消息）
 */
function joinedText(page, only) {
    // 从最后一次 streamStart 往后算：前面那几轮的正文也在同一个页面里
    let start = 0;
    page.messages.forEach((m, i) => {
        if (m.type === "streamStart" && (only === undefined || m.sessionId === only)) { start = i + 1; }
    });
    return page.messages.slice(start)
        .filter((m) => (m.type === "assistantDelta" || m.type === "assistantFull")
            && (only === undefined || m.sessionId === only))
        .map((m) => (typeof m.delta === "string" ? m.delta : (typeof m.text === "string" ? m.text : "")))
        .join("");
}

/** 拿状态码（不解析正文）。 */
function postStatus(baseUrl, pageId, msg) {
    return new Promise((done) => {
        const body = JSON.stringify(msg);
        const r = http.request(new URL("api?pageId=" + pageId, baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, (res) => { res.resume(); res.on("end", () => done(res.statusCode)); });
        r.on("error", () => done(0));
        r.end(body);
    });
}

/**
 * 直接问某只 pi 要它的消息树（经中转发一条 get_messages，收它回的那条）。
 * 比盯页面硬：页面那边这句话有时是增量、有时是随后来的历史批次，形状不一样。
 */
async function askPiMessages(link, key, timeoutMs = 15000) {
    const seen = [];
    const off = link.onFrame(key, (frame) => {
        if (frame.ch !== "out") { return; }
        try { seen.push(JSON.parse(frame.line)); } catch { /* 不是 JSON 就算了 */ }
    });
    try {
        link.sendLine(key, JSON.stringify({ type: "get_messages", id: "probe-" + Date.now() }));
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            const resp = seen.find((m) => m && m.type === "response" && String(m.id || "").startsWith("probe-") && m.command === "get_messages");
            if (resp) { return JSON.stringify(resp.data || resp); }
            await sleep(100);
        }
        return "";
    } finally {
        off();
    }
}

/** 会话表里那个会话（后端推的 sessionList）。 */
function sessionFrom(list, id) {
    const msg = [...list.messages].reverse().find((m) => m.type === "sessionList");
    if (!msg) { return undefined; }
    return (msg.sessions || []).find((s) => s.id === id);
}

(async () => {
    const { RelayLink } = require(path.join(repoRoot, "out", "server", "relayClient.js"));

    // ---- 一、起后端、开一个会话、发一句话 ----
    console.log("一、起后端 + 新会话 + 发一句话");
    let back = await startBackend({ cwd: workDir, port: 0, host: "127.0.0.1" });
    let page = openPage(back.url, "probe-1");
    await page.post({ type: "newSession" });
    const list1 = await page.waitFor((m) => m.type === "sessionList" && (m.sessions || []).length > 0);
    check(!!list1, "新会话开出来了");
    const sessionId = list1.sessions[0].id;
    console.log("  · 会话 id：" + sessionId);

    await page.post({ type: "send", sessionId, text: "重启前那句话", images: [] });
    // 等到这一轮真的在跑（正文开始流了），再动手重启
    await page.waitFor((m) => m.type === "assistantDelta");
    const runningList = await page.waitFor((m) => m.type === "sessionList" && (m.sessions || []).some((s) => s.id === sessionId && s.streaming));
    check(!!runningList, "这一轮在跑（会话表里 streaming=true）");

    const relay1 = relayLink();
    check(!!relay1, "后端真的连上了中转");
    const before = await relay1.list();
    const piBefore = before.find((p) => p.panelId === sessionId);
    check(!!piBefore, "中转手里有这只 pi（认着这个会话）");
    const fileBefore = (before.find((p) => p.panelId === sessionId) || {}).sessionFile;
    check(!!fileBefore, "中转记着这个会话的会话文件");
    console.log("  · 重启前：pid=" + (piBefore && piBefore.pid) + " key=" + (piBefore && piBefore.key));

    // ---- 二、照「编译并重启」那套停掉后端（keepPi：pi 留着） ----
    console.log("二、后端放手（不杀 pi），起一个新的");
    page.close();
    await back.stop(true, true);
    await sleep(300);

    // 旧后端已经走了：直接读地址文件连回去看 pi 还在不在
    const addrFile = path.join(process.env.PICHAT_HOME, "relay.json");
    check(fs.existsSync(addrFile), "中转还活着（地址文件还在）");
    const addr = JSON.parse(fs.readFileSync(addrFile, "utf8"));
    const probe = await RelayLink.connect(addr);
    check(!!probe, "能重新连上中转");
    const afterStop = probe ? await probe.list() : [];
    const piAfterStop = afterStop.find((p) => p.panelId === sessionId);
    check(!!piAfterStop, "后端走了以后 pi 还在");
    check(piAfterStop && piBefore && piAfterStop.pid === piBefore.pid, "还是同一只 pi（pid 没变）");
    probe && probe.close();

    // ---- 三、起新后端：会话该被认回来 ----
    console.log("三、新后端把会话认回来");
    back = await startBackend({ cwd: workDir, port: 0, host: "127.0.0.1" });
    // 刚重启时页面手里还是上一份服务发的标识、推送流还在重连：这时发一条不该被 409 顶回去
    const early = await postStatus(back.url, "page-from-before-restart", { type: "switchSession", sessionId });
    check(early === 204 || early === 200, "刚重启时拿旧标识发消息也照收（不是 409，实际 " + early + "）");
    page = openPage(back.url, "probe-2");
    const list2 = await page.waitFor((m) => m.type === "sessionList" && (m.sessions || []).length > 0);
    check(!!list2, "会话表回来了");
    const restored = list2 && (list2.sessions || []).find((s) => s.id === sessionId);
    check(!!restored, "还是原来那个会话 id（页面上的会话格对得上）");
    check(!!restored && restored.file === fileBefore, "会话文件也对得上");

    const relay2 = relayLink();
    const after = relay2 ? await relay2.list() : [];
    const piAfter = after.find((p) => p.panelId === sessionId);
    check(!!piAfter, "新后端接上了同一只 pi");
    check(piAfter && piBefore && piAfter.pid === piBefore.pid, "pid 还是那个（没有重开进程）");

    // ---- 四、还在接着说话 ----
    console.log("四、在同一只 pi 上再来一句");
    await page.post({ type: "send", sessionId, text: "重启后那句话", images: [] });
    const answered = await page.waitFor(
        (m) => m.type === "system" || m.type === "systemError" ? false : true,
        1000,
    );
    const settled = await page.waitFor((m) => m.type === "sessionList" && (m.sessions || []).some((s) => s.id === sessionId && !s.streaming && !!s.tps), 30000);
    check(!!settled, "这一轮跑完了（会话表里回到不跑、还带着速度）");
    const relay3 = relayLink();
    const piFinal = relay3 ? (await relay3.list()).find((p) => p.panelId === sessionId) : undefined;
    check(piFinal && piBefore && piFinal.pid === piBefore.pid, "跑完的还是那同一只 pi");

    // ---- 四之二、stderr 那条侧信道也要通（派子会话：桥接扩展往 stderr 写一行暗号）----
    console.log("四之二、派个子会话（stderr 暗号经中转转给后端）");
    await page.post({ type: "send", sessionId, text: "来，派活", images: [] });
    const childList = await page.waitFor((m) => m.type === "sessionList"
        && (m.sessions || []).some((s) => s.parentId === sessionId), 30000);
    check(!!childList, "子会话开出来了（stderr 上的暗号没丢）");
    // 正文是逐字推下来的（assistantDelta 一条几个字），得把它们接起来再找
    const waitText = async (needle, timeoutMs = 30000) => {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            const text = page.messages
                .filter((m) => m.type === "assistantDelta" || m.type === "assistantFull")
                .map((m) => (typeof m.delta === "string" ? m.delta : (typeof m.text === "string" ? m.text : "")))
                .join("");
            if (text.includes(needle)) { return true; }
            await sleep(80);
        }
        return false;
    };
    const replied = await waitText("子会话工具回话");
    check(!!replied, "派活的回话也回来了");

    // ---- 四之三、正在写的那半句话，重启以后接得上 ----
    console.log("四之三、流式当中重启：正在写的那半句接得上");
    // 开一个干净的新会话演这一段：前面那些会话的尾巴（子会话那几轮）还在收尾，
    // 混进来就分不清哪句是"正在写的那半句"了。
    await page.post({ type: "newSession" });
    const withTwo = await page.waitFor((m) => m.type === "sessionList" && (m.sessions || []).length >= 2, 30000);
    const longId = withTwo && (withTwo.sessions || []).map((s) => s.id).find((id) => id !== sessionId);
    check(!!longId, "又开了一个新会话（" + longId + "）");
    await page.post({ type: "send", sessionId: longId, text: "说段长话", images: [] });
    const firstDelta = await page.waitFor((m) => m.type === "assistantDelta", 20000);
    check(!!firstDelta, "长话开始往外吐了");
    await sleep(600);                    // 多攒一会儿，好确认"前面那截"确实在屏幕上
    const partial = joinedText(page, longId);
    check(partial.length > 6, "已经吐出来一截（" + partial.length + " 字）");

    page.close();
    await back.stop(true, true);         // 重启（pi 留着）
    back = await startBackend({ cwd: workDir, port: 0, host: "127.0.0.1" });
    const page3 = openPage(back.url, "probe-3");
    const adopted3 = await page3.waitFor((m) => m.type === "sessionList" && (m.sessions || []).some((s) => s.id === longId), 30000);
    check(!!adopted3, "会话又认回来了");
    // 等这一段吐完（末尾那句"再接着说下去。"到了就是到齐了）
    const tail = "再接着说下去。";
    const endBy = Date.now() + 60000;
    let resumed = "";
    while (Date.now() < endBy) {
        resumed = joinedText(page3, longId);
        if (resumed.length >= partial.length && resumed.endsWith(tail)) { break; }
        await sleep(100);
    }
    console.log("  · 重启前：" + JSON.stringify(partial.slice(0, 60)) + "（共 " + partial.length + " 字）");
    console.log("  · 重启后：" + JSON.stringify(resumed.slice(0, 60)) + "（共 " + resumed.length + " 字）");
    const partialKept = resumed.startsWith(partial);
    check(partialKept, "重启前吐出来的那截还接在前面（" + partial.length + " 字 → 共 " + resumed.length + " 字）");
    check(resumed.length > partial.length, "后面那截也接着写完了");
    const finished = await page3.waitFor((m) => m.type === "sessionList" && (m.sessions || []).some((s) => s.id === longId && !s.streaming), 30000);
    check(!!finished, "这一轮在会话表里回到不跑了");

    // 接着用：再来一句，证明认回来的这只 pi 还在正常干活
    await page3.post({ type: "send", sessionId: longId, text: "收尾那句", images: [] });
    const again = await page3.waitFor((m) => m.type === "sessionList" && (m.sessions || []).some((s) => s.id === longId && !s.streaming && !!s.tps), 60000);
    check(!!again, "认回来以后照常能接着聊");
    page3.close();

    // ---- 四之四、等答题的卡片：重启以后还在、点了还能答 ----
    // 用 longId（页面现在正看着的就是它）：问话卡片只发给"正看着这个会话"的屏
    console.log("四之四、选择题卡片跨重启还在");
    // 让 longId 里的假 pi 问一道选择题（走中转的事件口，不是 stderr）。
    // 卡片只发给"正看着这个会话"的屏，这一趟主要验的是"重启以后它还在、还答得了"，
    // 所以这里只管把题发出去，不赌这一屏当前盯着谁。
    await page3.post({ type: "switchSession", sessionId: longId });
    await page3.post({ type: "send", sessionId: longId, text: "问单选", images: [] });
    await sleep(1500);

    page3.close();
    await back.stop(true, true);         // 重启（pi 留着，题还等在中转那儿）
    back = await startBackend({ cwd: workDir, port: 0, host: "127.0.0.1" });
    const page4 = openPage(back.url, "probe-4");
    // 页面重连以后会回到自己原来那个会话（真页面也这么干）：切回去，还等着的卡片才会送到这块屏
    await sleep(500);
    await page4.post({ type: "switchSession", sessionId: longId });
    const card2 = await page4.waitFor((m) => m.type === "askCard" && m.card && m.card.question === "选 A 还是 B？", 30000);
    check(!!card2, "重启以后这张卡片又画回来了");
    const answerId = card2 && card2.id;
    if (answerId) { await page4.post({ type: "askCardAnswer", id: answerId, picks: ["A"], text: "" }); }
    // 直接问 pi：它自己的消息树里有没有这句（比盯页面稳 —— 页面那边有时是增量、有时是历史批次）
    const treeLink = await RelayLink.connect(readAddr());
    const piKey = treeLink ? (await treeLink.list()).find((p) => p.panelId === longId) : undefined;
    const tree = treeLink && piKey ? await askPiMessages(treeLink, piKey.key) : "";
    if (treeLink) { treeLink.close(); }
    const heard = tree.indexOf("用户选了：A") >= 0;
    if (!heard) { console.log("  · pi 的消息树里没找到，前 200 字：" + JSON.stringify(tree.slice(0, 200))); }
    check(heard, "点了以后答案交回了模型（它把结果说出来了）");
    page4.close();

    // ---- 五、Ctrl+C 是全收 ----
    console.log("五、正常收摊：连 pi 一起收");
    page.close();
    await back.stop();
    await sleep(800);
    check(!fs.existsSync(addrFile), "中转退了（地址文件清掉）");
    let gone = false;
    try { process.kill(piBefore.pid, 0); } catch { gone = true; }
    check(gone, "pi 也停了");

    console.log("");
    if (failed === 0) {
        console.log("全部通过。");
    } else {
        console.log(`有 ${failed} 项没过。`);
    }
    process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});

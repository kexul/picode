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

const { startBackend } = require(path.join(repoRoot, "out", "server", "serverMain.js"));
const { relayLink } = require(path.join(repoRoot, "out", "server", "relayClient.js"));

let failed = 0;
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    /** 等一条满足条件的消息（已经在手上的也算）。 */
    state.waitFor = async (pred, timeoutMs = 20000) => {
        const limit = Date.now() + timeoutMs;
        while (Date.now() < limit) {
            const found = state.messages.find(pred);
            if (found) { return found; }
            await sleep(80);
        }
        return undefined;
    };
    state.last = (type) => [...state.messages].reverse().find((m) => m.type === type);
    return state;
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

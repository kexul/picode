// @ts-nocheck
/**
 * firstLoad —— 量“第一次打开页面”到底下了多少字节、花了多久（手机上第一次打开就是这条量法）。
 *
 *   node dev/firstLoad.js --session <某个 .jsonl> [--cpu 4]
 *
 * 做法：把那个会话文件复制进一个临时会话目录，起真后端（真 pi，不发消息），
 * 先让后端把会话装进来，再用一个全新的浏览器 profile 打开页面（等于手机上第一次打开），
 * 用 CDP 的 Network 域记下每一个请求的字节数，记下到“能打字 / 历史画完”的时间。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf("--" + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes("--" + name);

const session = arg("session", "");
if (!session) {
    console.error("要给 --session <会话文件.jsonl>");
    process.exit(1);
}
const cpu = Number(arg("cpu", 1));

const scratch = path.join(__dirname, ".scratch", "firstload");
const work = path.join(scratch, "work");
const sessionsRoot = path.join(scratch, "sessions");
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

/** 与 src/sessionStore.ts 的 encodeCwd 同一套规则。 */
function encodeCwd(cwd) {
    const dashed = cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-");
    return "--" + dashed + "--";
}
const sessionDir = path.join(sessionsRoot, encodeCwd(work));
fs.mkdirSync(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, path.basename(session));
fs.copyFileSync(session, sessionFile);

process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;

const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

/** 一个请求的字节账。 */
function netRecorder() {
    const byId = new Map();       // requestId -> { url, type, bytes, start, end }
    return {
        attach(cdp) {
            cdp.on("Network.requestWillBeSent", (p) => {
                byId.set(p.requestId, {
                    url: p.request.url, type: p.type, bytes: 0,
                    start: p.timestamp * 1000, end: 0,
                });
            });
            cdp.on("Network.dataReceived", (p) => {
                const rec = byId.get(p.requestId);
                if (rec) { rec.bytes += p.encodedDataLength || p.dataLength || 0; }
            });
            cdp.on("Network.loadingFinished", (p) => {
                const rec = byId.get(p.requestId);
                if (!rec) { return; }
                rec.bytes = p.encodedDataLength || rec.bytes;
                rec.end = p.timestamp * 1000;
            });
            cdp.on("Network.loadingFailed", (p) => {
                const rec = byId.get(p.requestId);
                if (rec && !rec.end) { rec.end = p.timestamp * 1000; rec.failed = p.errorText; }
            });
        },
        rows() { return Array.from(byId.values()); },
    };
}

/** 首页（不含推送流）与推送流分开算。 */
function summarize(rows) {
    const groups = new Map();
    for (const r of rows) {
        let key;
        if (r.url.includes("/media/")) { key = "界面脚本 " + r.url.split("?")[0].replace(/^.*\/media\//, ""); }
        else if (r.url.includes("/events")) { key = "推送流 /events（消息）"; }
        else if (r.url.endsWith("/") || r.url.includes("127.0.0.1") && !r.url.includes("?pageId")) { key = "整页 HTML（含内联样式）"; }
        else { key = r.url.replace(/^http:\/\/[^/]+/, "").split("?")[0] || "(其它)"; }
        const hit = groups.get(key) || { key, n: 0, bytes: 0 };
        hit.n += 1;
        hit.bytes += r.bytes;
        groups.set(key, hit);
    }
    return Array.from(groups.values()).sort((a, b) => b.bytes - a.bytes);
}

const kb = (n) => (n / 1024).toFixed(1) + " KB";

async function main() {
    const harness = createHarness({ cwd: work, piPath: "pi", log: (t) => { if (/错误|Error|失败|会话|加载/.test(t)) { console.log("[后端] " + t); } } });
    const url = await harness.start();
    console.log(`会话：${path.basename(session)}（${(fs.statSync(session).size / 1048576).toFixed(1)} MB，` +
        `${fs.readFileSync(session, "utf8").split("\n").filter((l) => l.startsWith('{"type":"message"')).length} 条消息）`);
    console.log(`后端：${url}   工作目录：${work}`);

    // 第一趟：只是为了把会话装进后端（不量）
    const warm = await openPage({ url, width: 412, height: 915, timeoutMs: 90000 });
    await warm.page.waitReady(120000);
    // 用本页标识去开那个历史会话（等同于点「项目与会话」里那一行）
    const resp = await warm.page.eval(`
        const pageId = (document.querySelector('meta[name="pichat-page"]') || {}).content || "";
        const body = JSON.stringify({ type: 'workspaceOpenSession', path: ${JSON.stringify(sessionFile)}, cwd: ${JSON.stringify(work)} });
        return fetch('/api?pageId=' + encodeURIComponent(pageId), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body,
        }).then((res) => res.status);
    `);
    console.log(`打开历史会话：HTTP ${resp}，等它画完…`);
    // 等消息真的到页面上（最多 3 分钟：几十 MB 的会话要 pi 解析 + 后端渲染）
    let painted = 0;
    const limit = Date.now() + 180000;
    while (Date.now() < limit) {
        painted = await warm.page.eval(`
            return document.querySelectorAll('.session-view:not(.off) .session-pane .msg').length;
        `);
        if (painted > 0) { break; }
        await sleep(1000);
    }
    await sleep(4000);
    painted = await warm.page.eval(`return document.querySelectorAll('.session-view:not(.off) .session-pane .msg').length;`);
    const extra = await warm.page.eval(`
        const pane = document.querySelector('.session-view:not(.off) .session-pane');
        return {
            nodes: document.querySelectorAll('*').length,
            height: pane ? Math.round(pane.scrollHeight) : 0,
            more: !!(pane && pane.querySelector('.history-more')),
        };
    `);
    if (painted === 0) {
        console.log("没画出来，页面上的字：");
        console.log(await warm.page.eval("return document.body.innerText.slice(0, 600)"));
    }
    console.log(`会话已装在页面上：${painted} 条消息气泡，DOM ${extra.nodes} 个节点，内容高 ${extra.height}px，` +
        (extra.more ? "顶上有「加载更早的消息」" : "没有「加载更早」"));
    await warm.close();

    // 第二趟：全新浏览器（没有缓存）+ 网络记账，等于手机上第一次打开
    const open = await openPage({ url: "about:blank", width: 412, height: 915, timeoutMs: 90000 });
    const { page, cdp } = open;
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (cpu > 1) { await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu }); }
    // 记下每条推送消息的体量（按类型、按工具输出文字 / 图片分开算）：开了新页面再注入，
    // 保证在 chat.js 之前挂上监听。
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
        window.__msgBytes = {};
        window.addEventListener("message", function (ev) {
            var d = ev.data;
            if (!d || typeof d !== "object") { return; }
            var t = String(d.type || "?");
            var n = 0;
            try { n = JSON.stringify(d).length; } catch (e) { n = 0; }
            var hit = window.__msgBytes[t] || (window.__msgBytes[t] = { n: 0, chars: 0, bytes: 0, toolText: 0, imgChars: 0 });
            hit.n += 1;
            hit.chars += n;
            try { hit.bytes += new TextEncoder().encode(JSON.stringify(d)).length; } catch (e) { }
            if (t === "toolResult") {
                hit.toolText += (d.resultText || "").length;
                for (const img of d.images || []) { hit.imgChars += (img.data || "").length; }
            }
        });
    ` });
    const recorder = netRecorder();
    recorder.attach(cdp);
    await page.eval(`
        window.__marks = [];
        window.__longTasks = [];
        try {
            new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__longTasks.push(Math.round(e.duration)); } })
                .observe({ entryTypes: ["longtask"] });
        } catch (e) { window.__longTasks = null; }
        return true;
    `).catch(() => true);
    const t0 = Date.now();
    await cdp.send("Page.navigate", { url });
    await page.waitReady(180000);
    const readyMs = Date.now() - t0;
    // 等历史画完：消息数稳定下来
    let last = -1;
    let stableSince = Date.now();
    while (Date.now() - t0 < 180000) {
        const n = await page.eval(`return document.querySelectorAll('.session-view:not(.off) .session-pane .msg').length;`);
        if (n !== last) { last = n; stableSince = Date.now(); }
        else if (Date.now() - stableSince > 1500 && last > 0) { break; }
        await sleep(250);
    }
    const paintedMs = Date.now() - t0;
    await sleep(1500);
    const perf = await page.eval(`
        const nav = performance.getEntriesByType('navigation')[0] || {};
        return {
            dcl: Math.round((nav.domContentLoadedEventEnd || 0)),
            load: Math.round((nav.loadEventEnd || 0)),
            paints: performance.getEntriesByType('paint').map((p) => p.name + ' ' + Math.round(p.startTime)),
            longTasks: (window.__longTasks || []).slice(0, 20),
            msgs: document.querySelectorAll('.session-view:not(.off) .session-pane .msg').length,
            nodes: document.querySelectorAll('*').length,
        };
    `);
    const rows = recorder.rows();
    const live = summarize(rows);
    const total = rows.reduce((n, r) => n + r.bytes, 0);
    console.log("");
    console.log(`—— 第一次打开（全新浏览器、不走缓存${cpu > 1 ? "、CPU 降速 " + cpu + " 倍" : ""}）——`);
    console.log(`  从点开到能打字（输入框底下的胶囊 idle）：${(readyMs / 1000).toFixed(2)} 秒`);
    console.log(`  从点开到历史画完（${perf.msgs} 条气泡）：${(paintedMs / 1000).toFixed(2)} 秒`);
    console.log(`  HTML 解析完 ${perf.dcl} ms，load 事件 ${perf.load} ms，首屏绘制 ${perf.paints.join(" / ") || "无"}`);
    console.log(`  DOM ${perf.nodes} 个节点；长任务（>50ms）：${perf.longTasks && perf.longTasks.length ? perf.longTasks.join(", ") + " ms" : "没有"}`);
    console.log(`  总字节：${kb(total)}`);
    for (const g of live) { console.log(`    ${kb(g.bytes).padStart(10)}  ${g.n} 个  ${g.key}`); }
    const byType = await page.eval(`return window.__msgBytes || {};`);
    const resTiming = await page.eval(`
        return performance.getEntriesByType('resource').map(function (r) {
            var rest = r.name.slice(r.name.indexOf('://') + 3);
            return { name: rest.slice(rest.indexOf('/')).slice(0, 70), size: r.transferSize || 0, body: r.encodedBodySize || 0 };
        });
    `);
    const list = Object.entries(byType).map(([t, v]) => ({ t, ...v })).sort((a, b) => b.chars - a.chars);
    const utf8Total = list.reduce((n, it) => n + (it.bytes || 0), 0);
    console.log(`  页面收到的推送消息合计：${(utf8Total / 1024).toFixed(0)} KB（UTF-8，按消息实际内容算）`);
    for (const r of resTiming) { console.log(`    资源 ${r.name}  传输 ${(r.size / 1024).toFixed(1)} KB，正文 ${(r.body / 1024).toFixed(1)} KB`); }
    console.log("  推送流里按消息类型分：");
    for (const it of list) {
        const extra = it.t === "toolResult" ? `（其中工具输出文字 ${(it.toolText / 1024).toFixed(0)}K 字符、图片 ${(it.imgChars / 1024).toFixed(0)}K 字符）` : "";
        console.log(`    ${String(it.t).padEnd(16)} ${String(it.n).padStart(4)} 条  ${((it.bytes || 0) / 1024).toFixed(0).padStart(6)} KB${extra}`);
    }
    // 推送流里消息的类型分布（顺带看看都是些什么）
    const pageText = await page.eval(`return 1`);
    await open.close();
    await harness.stop();
}

main().catch((e) => { console.error(e); process.exit(1); });

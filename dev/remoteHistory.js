// @ts-nocheck
/**
 * remoteHistory —— 在看别台那台上一条会话时，历史浮窗列的得是**那台那个目录**的会话。
 *
 * 病根：历史浮窗（顶条那颗 <<< 那一路来的 openHistory，插件里还有命令入口）一直只从本机盘上扫，
 * 目录还是按当前会话的 cwd 取的。看的是别台的会话时，cwd 是那边的路径，于是两个错凑在一起：
 * 要么列出本机某个目录的会话，要么一个都列不出来。
 *
 * 现在：浮窗那一页由后端问对地方 —— 本机的照旧扫本机盘，别台的走新开的 `GET /history?dir=&offset=&size=`
 * （那台自己扫它自己的盘，扫法与本机同一个函数 sessionStore.scanHistoryPage）；点一条别台的会话
 * 走“请那台打开它”那条老路（按会话文件认领，认下来再切过去）。
 *
 *   npm run compile && node dev/remoteHistory.js
 *
 * 两台真后端（B 用真 pi：点开它的一条会话要真读会话文件）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { openPage, sleep } = require("./cdp.js");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-rhistory-"));
const launcher = path.join(repoRoot, "bin", "pichat.js");

let failed = 0;
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);

function startBackend(name, home, work, pi) {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const child = spawn(process.execPath, [launcher, "--no-open", "--cwd", work, "--port", "0", "--host", "127.0.0.1"], {
        cwd: repoRoot,
        env: {
            ...process.env,
            HOME: path.join(home, "user"),
            USERPROFILE: path.join(home, "user"),
            PICHAT_HOME: home,
            PICHAT_PI: pi || process.env.PICHAT_PI || path.join(repoRoot, "dev", "fake-pi.cmd"),
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const log = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (t) => log.push(t));
    child.stderr.on("data", (t) => log.push(t));
    return { name, home, work, child, log };
}

async function waitUrl(one) {
    const file = path.join(one.home, "server.json");
    for (let i = 0; i < 200; i += 1) {
        try {
            const info = JSON.parse(fs.readFileSync(file, "utf8"));
            if (info && info.url) { return String(info.url).replace(/\/+$/, ""); }
        } catch { /* 还没写出来 */ }
        await sleep(200);
    }
    throw new Error(one.name + " 没起来");
}

/** 造一条会话文件（标题就是第一句用户消息；时间戳早的排在后面）。 */
function writeSession(userHome, cwd, id, title, stamp) {
    const dashed = cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-");
    const out = path.join(userHome, ".pi", "agent", "sessions", "--" + dashed + "--");
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, (stamp || "2099-03-03T00-00-00-000Z") + "_" + id + ".jsonl");
    const lines = [
        { type: "session", id, cwd, timestamp: new Date().toISOString() },
        { type: "message", message: { role: "user", content: [{ type: "text", text: title }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: title + " —— 回答" }] } },
    ];
    fs.writeFileSync(file, lines.map((one) => JSON.stringify(one)).join("\n") + "\n");
    return file;
}

const aHome = path.join(tmpRoot, "A");
const bHome = path.join(tmpRoot, "B");
const aWork = path.join(tmpRoot, "a-work");
const bWork = path.join(tmpRoot, "b-work");
let a = null;
let b = null;
let open = null;

(async () => {
    // B 的 b-work 里造 12 条会话（第一页 10 条，剩下 2 条在「加载更多」后面）
    for (let i = 0; i < 12; i += 1) {
        const n = String(i).padStart(2, "0");
        writeSession(path.join(bHome, "user"), bWork, "deadbeef-4444-4000-8000-0000000c00" + n,
            "B 的历史第 " + n + " 条", "2099-04-04T00-00-" + n + "-000Z");
    }
    // 本机这边也造一条，用来确认浮窗里没有本机的会话混进来
    writeSession(path.join(aHome, "user"), aWork, "deadbeef-5555-4000-8000-0000000c0001", "A 自己的会话", "2099-05-05T00-00-00-000Z");

    b = startBackend("B", bHome, bWork, "pi");
    const urlB = await waitUrl(b);
    fs.mkdirSync(aHome, { recursive: true });
    fs.writeFileSync(path.join(aHome, "config.json"), JSON.stringify({ label: "B", machines: [urlB] }, null, 2));
    a = startBackend("A", aHome, aWork);
    const urlA = await waitUrl(a);
    await sleep(1500);

    // 先看那台的 /history 本身：一页 10 条、有「加载更多」，翻一页接上剩下的 2 条
    const pageUrl = (offset, size) => `${urlB}/history?dir=${encodeURIComponent(bWork)}&offset=${offset}&size=${size}`;
    const first = await (await fetch(pageUrl(0, 10))).json();
    check(Array.isArray(first.items) && first.items.length === 10, "一、那台的 /history 一页给 10 条");
    check(first.hasMore === true, "一、后面还有（hasMore）");
    const second = await (await fetch(pageUrl(first.nextOffset, 10))).json();
    check(Array.isArray(second.items) && second.items.length === 2, "一、翻一页接着给剩下的 2 条");
    check(second.hasMore === false, "一、翻到头了（hasMore=false）");
    check((second.items[0].cwd || "") === bWork, "一、条目里带着它自己的目录");

    open = await openPage({ url: urlA, width: 1200, height: 900 });
    const page = open.page;
    await page.waitReady();

    const waitFor = async (expr, ms = 30000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            if (await page.eval(expr)) { return true; }
            await sleep(200);
        }
        return false;
    };
    const current = () => page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return pane ? pane.dataset.sessionId : "";
    `);
    /** 浮窗（#pickerBody，别跟侧边栏那些行混了）里那几行的标题。 */
    const pickerTitles = () => page.eval(`
        const rows = Array.from(document.querySelectorAll("#pickerBody .pk-item"));
        return rows.map((el) => (el.querySelector(".pk-history-title") || el).innerText.trim());
    `);
    /** 浮窗里“那个目录的历史会话”那几行（浮层头上还挂着开着的会话，那些不算）。 */
    const historyTitles = async () => (await pickerTitles()).filter((t) => t.indexOf("B 的历史第") >= 0);
    /** 点浮窗里标题是某一句的那一行。 */
    const clickHistoryRow = (title) => page.eval(`
        const rows = Array.from(document.querySelectorAll("#pickerBody .pk-item"));
        const row = rows.find((el) => (el.querySelector(".pk-history-title") || el).innerText.trim() === ${JSON.stringify(title)});
        if (row) { row.click(); }
        return !!row;
    `);

    const localId = await current();
    // 在「项目与会话」里点开那台的一条会话（先让当前会话变成别台的）
    if (!(await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')"))) {
        await page.eval(`window.acquireVsCodeApi().postMessage({ type: "openWorkspace", expanded: [] }); return true;`);
        await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')");
    }
    await page.eval(`document.querySelector('#sidebarDock .pk-space-head.pk-remote-space').click(); return true;`);
    // 那一组会话是回头再要的（workspaceSessions），等它真挂上再点
    const groupReady = await waitFor(`
        const rows = Array.from(document.querySelectorAll("#sidebarDock .pk-item.pk-group-session"));
        return rows.some((el) => el.innerText.indexOf("B 的历史第") >= 0);
    `);
    check(groupReady, "前置：侧边栏别台那一节里有它的会话行");
    // 点那台那一节里的一条（侧边栏里本机那边也可能有会话行，按标题认准了再点）
    await page.eval(`
        const rows = Array.from(document.querySelectorAll("#sidebarDock .pk-item.pk-group-session"));
        const row = rows.find((el) => el.innerText.indexOf("B 的历史第") >= 0);
        if (row) { row.click(); }
        return !!row;
    `);
    await waitFor(`return !!(Array.from(document.querySelectorAll(".session-view:not(.off) .session-pane")).find((p) => p.dataset.sessionId !== ${JSON.stringify(localId)}))`);
    await sleep(2500);
    const sid = await current();
    check(!!sid && sid.indexOf("remote:") === 0, "前置：现在看的是那台的一条会话（" + sid + "）");

    // 顶条那颗 <<< 那一路：打开历史浮窗
    await page.eval(`window.acquireVsCodeApi().postMessage({ type: "openHistory" }); return true;`);
    await waitFor("return document.querySelectorAll('#pickerBody .pk-item').length > 0");
    let titles = await historyTitles();
    console.log("    浮窗里第一页：" + JSON.stringify(titles) + " … 共 " + titles.length + " 行");
    check(titles.length === 10, "二、浮窗第一页是 10 行（" + titles.length + "）");
    check(titles.every((t) => t.indexOf("B 的历史第") >= 0), "二、列的是那台那个目录的会话（没有本机的混进来）");

    // 「加载更多」：后面 2 条接着来
    await page.eval(`
        const btn = document.querySelector("#pickerBody .pk-loadmore");
        if (btn) { btn.click(); }
        return !!btn;
    `);
    await sleep(1500);
    titles = await historyTitles();
    console.log("    点过「加载更多」之后：" + titles.length + " 行");
    check(titles.length === 12, "三、点一下「加载更多」把后面 2 条也取回来了（" + titles.length + "）");

    // 点一条没开着的那台会话：那台打开它、这边切过去、正文画出来
    const clicked = await clickHistoryRow("B 的历史第 03 条");
    check(clicked, "四、浮窗里有「B 的历史第 03 条」那一行");
    const switched = await waitFor(`return (() => {
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return !!pane && pane.dataset.sessionId !== ${JSON.stringify(sid)};
    })()`, 40000);
    await sleep(2000);
    const opened = await current();
    const text = await page.text();
    check(switched && opened !== sid, "四、点那一行就切过去了（" + opened + "）");
    check(opened.indexOf("remote:") === 0, "四、打开的还是那台上的会话（" + opened + "）");
    check(text.indexOf("B 的历史第 03 条 —— 回答") >= 0, "四、正文是那一份（看到了它的回答）");

    await page.shot("remote-history.png");
})()
    .catch((err) => {
        console.log("跑挂了：" + ((err && err.stack) || err));
        failed += 1;
    })
    .finally(async () => {
        try { if (open) { await open.close(); } } catch { /* 收摊 */ }
        for (const one of [a, b]) { try { if (one) { one.child.kill(); } } catch { /* 已经退了 */ } }
        if (failed > 0) {
            for (const one of [a, b]) {
                if (!one) { continue; }
                console.log(one.name + " 的日志尾巴：");
                console.log(String(one.log.join("")).split("\n").slice(-12).join("\n"));
            }
        }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
        console.log("");
        console.log(failed === 0 ? "全部通过。" : `${failed} 项没通过。`);
        process.exit(failed === 0 ? 0 : 1);
    });

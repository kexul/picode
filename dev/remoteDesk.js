// @ts-nocheck
/**
 * remoteDesk —— 正在看别台上一条会话时，截图按钮拍的得是**那台**的桌面。
 *
 * 病根：`/shot` 与 `/live` 一直是“拍这台电脑”，跟当前看的是哪条会话没有关系。看别台的会话时，
 * 拍出来的画面是这台（你没在干活的那台），等于拍错。
 *
 * 现在：页面把当前会话号一起带上（`/shot?pageId=&session=`、`/live?pageId=&session=`），
 * 本机后端按它判断 —— 是别台的会话就问那台要：那台新开了机器对机器的两门口子
 * `GET /desk`（一张 JPEG）与 `GET /desk/live`（帧流，写法跟本机那支小程序一样），
 * 这边取回来再照原来的样子交给页面（一张图 / 一条 multipart 流）。
 *
 *   npm run compile && node dev/remoteDesk.js
 *
 * 两台真后端都跑在这台机器上，画面当然一模一样 —— 所以这一趟验的是“路由”：
 * 请求确实转去了那台（后端的日志里有那一行）、拿回来的确实是 JPEG / 帧流，
 * 本机那一条（不带会话号）也不受影响。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { openPage } = require("./cdp.js");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-rdesk-"));
const launcher = path.join(repoRoot, "bin", "pichat.js");
let failed = 0;
let page = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);

function startBackend(name) {
    const home = path.join(tmpRoot, name);
    const work = path.join(tmpRoot, name.toLowerCase() + "-work");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ label: name }, null, 2));
    const child = spawn(process.execPath, [launcher, "--no-open", "--cwd", work, "--port", "0", "--host", "127.0.0.1"], {
        cwd: repoRoot,
        env: {
            ...process.env,
            HOME: path.join(home, "user"),
            USERPROFILE: path.join(home, "user"),
            PICHAT_HOME: home,
            PICHAT_PI: process.env.PICHAT_PI || path.join(repoRoot, "dev", "fake-pi.cmd"),
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

/** 发一条请求，拿回完整响应（图片那种用这个）。 */
function fetchBinary(url, timeoutMs = 20000) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on("timeout", () => { req.destroy(new Error("等太久")); });
        req.on("error", (err) => resolve({ status: 0, headers: {}, body: Buffer.from(String(err.message)) }));
    });
}

function post(url, body) {
    return new Promise((resolve) => {
        const text = JSON.stringify(body);
        const req = http.request(url, {
            method: "POST",
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) },
        }, (res) => {
            let out = "";
            res.setEncoding("utf8");
            res.on("data", (c) => { out += c; });
            res.on("end", () => resolve({ status: res.statusCode, text: out }));
        });
        req.on("error", (err) => resolve({ status: 0, text: String(err.message) }));
        req.write(text);
        req.end();
    });
}

/** 收一条流，攒到够长或者到点为止。 */
function fetchStream(url, ms) {
    return new Promise((resolve) => {
        const chunks = [];
        let status = 0;
        let headers = {};
        const req = http.get(url, (res) => {
            status = res.statusCode;
            headers = res.headers;
            res.on("data", (c) => chunks.push(c));
            setTimeout(() => { try { req.destroy(); } catch { /* 已经断了 */ } }, ms);
        });
        req.on("error", () => { /* 收摊 */ });
        req.on("close", () => resolve({ status, headers, body: Buffer.concat(chunks) }));
    });
}

function writeFakeSession(home, cwd, id, text) {
    const dashed = cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-");
    const out = path.join(home, "user", ".pi", "agent", "sessions", "--" + dashed + "--");
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, "2099-03-03T00-00-00-000Z_" + id + ".jsonl");
    const lines = [
        { type: "session", id, cwd, timestamp: new Date().toISOString() },
        { type: "message", message: { role: "user", content: [{ type: "text", text }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "收到。" }] } },
    ];
    fs.writeFileSync(file, lines.map((one) => JSON.stringify(one)).join("\n") + "\n");
    return file;
}

(async () => {
    const bWork = path.join(tmpRoot, "b-work");
    fs.mkdirSync(bWork, { recursive: true });
    const bHome = path.join(tmpRoot, "B");
    const file = writeFakeSession(bHome, bWork, "deadbeef-8888-4000-8000-0000000c0001", "这条在 B 上");

    const a = startBackend("A");
    const b = startBackend("B");
    const cleanup = () => {
        try { if (page) { page = null; } } catch { /* 收摊 */ }
        for (const one of [a, b]) { try { one.child.kill(); } catch { /* 已经退了 */ } }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
    };
    const logText = (one) => String(one.log.join(""));
    try {
        const [urlA, urlB] = await Promise.all([waitUrl(a), waitUrl(b)]);
        fs.writeFileSync(path.join(a.home, "config.json"), JSON.stringify({ label: "A", machines: [urlB] }, null, 2));
        await sleep(2000);

        // 领一个页面标识（/shot 要求它是本服务发出的）：随便发一条无害的消息，后端会认下来
        const pageId = "desk-" + Date.now();
        await post(urlA + "/api?pageId=" + encodeURIComponent(pageId), { type: "channelPing" });

        // 从 B 的清单里认下那条会话，请 A 打开它
        const sessionsB = JSON.parse((await fetchBinary(urlB + "/sessions")).body.toString("utf8") || "{}");
        let remoteId = "";
        for (const project of sessionsB.projects || []) {
            for (const one of project.sessions || []) {
                if (one.file === file) { remoteId = one.id; }
            }
        }
        check(!!remoteId, "B 的清单里找到了那条会话（" + remoteId + "）");
        await post(urlA + "/api?pageId=" + encodeURIComponent(pageId), {
            type: "workspaceOpenSession", sessionId: "remote:" + urlB + ":" + remoteId, path: file, cwd: bWork,
        });
        await sleep(2500);

        // 那台开出来以后号会换成它那边的面板号：从 A 的清单里认一下
        const stream = await fetchStream(urlA + "/events?pageId=" + encodeURIComponent(pageId), 1500);
        const lists = stream.body.toString("utf8").split("\n")
            .filter((line) => line.indexOf("data:") === 0)
            .map((line) => { try { return JSON.parse(line.slice(5).trim()); } catch { return null; } })
            .filter((msg) => msg && msg.type === "sessionList");
        const last = lists.length ? lists[lists.length - 1] : { sessions: [] };
        const entry = (last.sessions || []).find((one) => one.machine === urlB && one.file === file);
        check(!!entry, "A 的清单里已经有那台那条会话了");
        if (!entry) { throw new Error("没有可用的远程会话号"); }

        // 一、带会话号：问那台要一张
        const remoteShot = await fetchBinary(urlA + "/shot?pageId=" + encodeURIComponent(pageId)
            + "&session=" + encodeURIComponent(entry.id));
        check(remoteShot.status === 200, "一、带那台的会话号：/shot 回 200（" + remoteShot.status + "）");
        check(remoteShot.body.length > 2 && remoteShot.body[0] === 0xff && remoteShot.body[1] === 0xd8,
            "一、拿回来的是一张 JPEG（" + remoteShot.body.length + " 字节）");
        check(logText(a).indexOf("要一张桌面截图") >= 0, "一、A 的日志里写着它去问那台要了（路由走对了）");

        // 二、不带会话号：本机那一条照旧
        const localShot = await fetchBinary(urlA + "/shot?pageId=" + encodeURIComponent(pageId));
        check(localShot.status === 200, "二、不带会话号：本机这张也照旧（" + localShot.status + "）");
        check(localShot.body.length > 2 && localShot.body[0] === 0xff && localShot.body[1] === 0xd8, "二、拿回来的也是一张 JPEG");

        // 三、实时画面那条流也跟着会话走
        const remoteLive = await fetchStream(urlA + "/live?pageId=" + encodeURIComponent(pageId)
            + "&session=" + encodeURIComponent(entry.id), 4000);
        const liveText = remoteLive.body.toString("latin1");
        check(remoteLive.status === 200, "三、带那台的会话号：/live 回 200（" + remoteLive.status + "）");
        const liveType = String(remoteLive.headers["content-type"] || "");
        check(liveType.indexOf("multipart/x-mixed-replace") >= 0, "三、给页面的还是那条 multipart 流（" + liveType + "）");
        check(liveText.indexOf("image/jpeg") >= 0, "三、里面真的来了 JPEG 帧（" + remoteLive.body.length + " 字节）");
        check(logText(a).indexOf("桌面实时画面") >= 0, "三、A 的日志里写着它在看那台的画面（路由走对了）");
        // 四、真页面上那一下：地址里要带着会话号，按钮的提示要写清拍的是哪一台
        const open = await openPage({ url: urlA, width: 1000, height: 800 });
        page = open.page;
        try {
            await page.waitReady();
            const waitFor = async (expr, ms = 25000) => {
                const t0 = Date.now();
                while (Date.now() - t0 < ms) {
                    if (await page.eval(expr)) { return true; }
                    await sleep(200);
                }
                return false;
            };
            if (!(await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')"))) {
                await page.eval(`window.acquireVsCodeApi().postMessage({ type: "openWorkspace", expanded: [] }); return true;`);
                await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')");
            }
            await page.eval(`document.querySelector('#sidebarDock .pk-space-head.pk-remote-space').click(); return true;`);
            await waitFor(`
                const rows = Array.from(document.querySelectorAll("#sidebarDock .pk-item.pk-group-session"));
                return rows.length > 0;
            `);
            await page.eval(`
                const row = document.querySelector("#sidebarDock .pk-item.pk-group-session");
                if (row) { row.click(); }
                return !!row;
            `);
            await sleep(3000);

            const title = await page.eval(`
                const btn = document.getElementById("browserScreenshotBtn");
                return btn ? btn.title : "";
            `);
            console.log("    截图按钮的提示：" + title);
            check(title.indexOf("那台") >= 0 && title.indexOf("B") >= 0,
                "四、按钮的提示写明了拍的是那台（" + title + "）");

            // 记下页面发出的请求地址，再点一下那颗按钮
            const asked = [];
            open.cdp.on("Network.requestWillBeSent", (params) => { asked.push(String(params && params.request && params.request.url || "")); });
            await open.cdp.send("Network.enable");
            await page.eval(`const btn = document.getElementById("browserScreenshotBtn"); if (btn) { btn.click(); } return !!btn;`);
            await sleep(2500);
            const shotUrl = asked.find((one) => one.indexOf("/shot?") >= 0) || "";
            console.log("    页面去要截图：" + shotUrl.replace(/^https?:\/\/[^/]+/, ""));
            check(shotUrl.indexOf("session=") >= 0, "四、页面要截图时带上了会话号");
            check(shotUrl.indexOf(encodeURIComponent("remote:") ) >= 0, "四、带的是那台那条会话的号（remote:…）");
            await page.shot("remote-desk.png");
        } finally {
            try { await open.close(); } catch { /* 收摊 */ }
        }
    } catch (err) {
        console.log("跑挂了：" + ((err && err.stack) || err));
        failed += 1;
    } finally {
        cleanup();
        if (failed > 0) {
            for (const one of [a, b]) {
                if (!one) { continue; }
                console.log(one.name + " 的日志尾巴：");
                console.log(String(one.log.join("")).split(String.fromCharCode(10)).slice(-16).join(String.fromCharCode(10)));
            }
        }
        console.log("");
        console.log(failed === 0 ? "全部通过。" : `${failed} 项没通过。`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();

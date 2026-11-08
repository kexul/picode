// @ts-nocheck
/**
 * remoteAuto —— 别台那条会话的「自动接着干」开关，这边要看得见（点一下转过去、那台的清单再报回来）。
 *
 * 病根：会话清单把别台那条的 taba / auto / autoTitle 一律写成 null（那会儿觉得“那是那台自己的事”）。
 * 可是开关就是这边的界面点出来的、转给那台去拨的：拨完那台在它的清单里报回来，这边又扔掉，
 * 于是那颗开关永远不亮 —— 看着像“点了没反应”。子会话标记同理（那台的清单里也带着）。
 *
 * 这一趟只看数据有没有搬过来：A 打开 B 的一条会话，替它把自动接着干打开，A 推给自己的
 * sessionList 里那一条应当带着 auto；关掉又应当回到 null。
 *
 *   npm run compile && node dev/remoteAuto.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-rauto-"));
const launcher = path.join(repoRoot, "bin", "pichat.js");
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);

function startBackend(name, pi) {
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

function request(url, { method = "GET", body } = {}) {
    return new Promise((resolve) => {
        const req = http.request(url, {
            method,
            headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {},
        }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => { text += c; });
            res.on("end", () => resolve({ status: res.statusCode, text }));
        });
        req.on("error", (err) => resolve({ status: 0, text: String(err.message) }));
        if (body) { req.write(body); }
        req.end();
    });
}

/** 开一条推送流，把消息按 JSON 收着（要看的就是其中的 sessionList）。 */
function openStream(url) {
    const messages = [];
    const req = http.get(url, (res) => {
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
                const block = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const line = block.split("\n").find((one) => one.indexOf("data:") === 0);
                if (!line) { continue; }
                try { messages.push(JSON.parse(line.slice(5).trim())); } catch { /* 不是 JSON 的跳过 */ }
            }
        });
    });
    req.on("error", () => { /* 收摊时断开是正常的 */ });
    return { req, messages };
}

/** 在这台的用户目录里造一条会话文件（B 启动时扫到它，才点得开）。 */
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
    const home = path.join(tmpRoot, "B");
    fs.mkdirSync(home, { recursive: true });
    const file = writeFakeSession(home, bWork, "deadbeef-7777-4000-8000-0000000c0001", "这条在 B 上");

    const a = startBackend("A");
    const b = startBackend("B");
    const cleanup = () => {
        for (const one of [a, b]) { try { one.child.kill(); } catch { /* 已经退了 */ } }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
    };
    try {
        const [urlA, urlB] = await Promise.all([waitUrl(a), waitUrl(b)]);
        fs.writeFileSync(path.join(a.home, "config.json"), JSON.stringify({ label: "A", machines: [urlB] }, null, 2));
        await sleep(2000);

        const pageId = "rauto-" + Date.now();
        const stream = openStream(urlA + "/events?pageId=" + encodeURIComponent(pageId));
        await sleep(1200);

        // 从 B 的清单里认下那条会话，请 A 打开它
        const sessionsB = JSON.parse((await request(urlB + "/sessions")).text || "{}");
        let remoteId = "";
        for (const project of sessionsB.projects || []) {
            for (const one of project.sessions || []) {
                if (one.file === file) { remoteId = one.id; }
            }
        }
        check(!!remoteId, "B 的清单里找到了那条会话（" + remoteId + "）");
        const localId = "remote:" + urlB + ":" + remoteId;
        await request(urlA + "/api?pageId=" + encodeURIComponent(pageId), {
            method: "POST",
            body: JSON.stringify({ type: "workspaceOpenSession", sessionId: localId, path: file, cwd: bWork }),
        });

        /** 等 A 推来的清单里那条会话（按会话文件认：那台开出来以后号会换成它那边的面板号）。 */
        const waitEntry = async (want, ms = 25000) => {
            const t0 = Date.now();
            let last = null;
            while (Date.now() - t0 < ms) {
                for (const msg of stream.messages) {
                    if (msg.type !== "sessionList" || !Array.isArray(msg.sessions)) { continue; }
                    for (const one of msg.sessions) {
                        if (one.machine !== urlB || one.file !== file) { continue; }
                        last = one;
                        if (want(one)) { return one; }
                    }
                }
                await sleep(400);
            }
            return last;
        };

        const opened = await waitEntry((one) => true);
        check(!!opened, "前置：A 的清单里已经有那台那条会话了");

        // 打开：A 把 autoAct 转给那台，那台的 auto 消息再转回来（界面那颗开关就是靠它亮的）
        const entryId = opened.id;
        await request(urlA + "/api?pageId=" + encodeURIComponent(pageId), {
            method: "POST",
            body: JSON.stringify({ type: "autoAct", sessionId: entryId, act: "start" }),
        });
        const saidOn = async (want, ms = 15000) => {
            const t0 = Date.now();
            while (Date.now() - t0 < ms) {
                const hits = stream.messages.filter((m) => m.type === "auto" && m.sessionId === entryId);
                const last = hits.length ? hits[hits.length - 1] : null;
                if (last && want(last)) { return last; }
                await sleep(300);
            }
            return null;
        };
        const on = await saidOn((m) => !!m.auto);
        check(!!on, "一、那台的 auto 消息转回来了（界面那颗开关靠它亮）：" + JSON.stringify(on && on.auto));
        check(!!on && typeof on.title === "string" && on.title.length > 0, "一、悬停提示也带过来了（" + (on && on.title) + "）");

        // 那台的会话清单里也带着这个开关（页面刷新后靠它补回来）：
        // 让那台来一次结构变化（它自己新开一个会话）逼它推一份新清单
        // （走那台的“在工作区里开新会话”那条口子：它只新开一个、不碰别的会话）
        await request(urlA + "/api?pageId=" + encodeURIComponent(pageId), {
            method: "POST",
            body: JSON.stringify({ type: "newSessionInWorkspace", machine: urlB, path: bWork }),
        });
        const withAuto = await waitEntry((one) => !!one.auto);
        check(!!withAuto && !!withAuto.auto, "二、新的清单里那一条也带着 auto（不是 null）：" + JSON.stringify(withAuto && withAuto.auto));

        // 关掉：又回到 null
        await request(urlA + "/api?pageId=" + encodeURIComponent(pageId), {
            method: "POST",
            body: JSON.stringify({ type: "autoAct", sessionId: entryId, act: "stop" }),
        });
        const off = await saidOn((m) => !m.auto, 20000);
        check(!!off && !off.auto, "三、关掉以后也转回来了（auto 为 null）");
    } finally {
        cleanup();
        if (failed > 0) {
            for (const one of [a, b]) {
                if (!one) { continue; }
                console.log(one.name + " 的日志尾巴：");
                console.log(String(one.log.join("")).split("\n").slice(-12).join("\n"));
            }
        }
        console.log("");
        console.log(failed === 0 ? "全部通过。" : `${failed} 项没通过。`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();

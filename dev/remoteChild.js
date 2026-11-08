// @ts-nocheck
/**
 * remoteChild —— 那台上派出去的子会话，这边也该看得到（缩在父会话下面，跟本机一个规矩）。
 *
 * 病根：后端只把“这边点开过的那几条会话”往外报，那台派出去的子会话在这边没有条目 ——
 * `parentId` / `taba` 搬过来了也没东西可缩，界面上就是“那台也会派子会话，但这边看不出来”。
 *
 * 现在：那台报清单时，父会话在这边开着的，就把它下面的子会话一并认下来（`opened` 里加一条），
 * 界面按 `parentId` 缩进在父会话下面、那颗点跟着亮；父会话关掉 / 那台不再报它，就一并摘掉。
 *
 *   npm run compile && node dev/remoteChild.js
 *
 * 两台真后端（都是假 pi）：假模型收到带「派活」的话会演一次子会话工具，那台于是真派一个子会话。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-rchild-"));
const launcher = path.join(repoRoot, "bin", "pichat.js");
let failed = 0;
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

/** 开一条推送流，把消息按 JSON 收着。 */
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
    const file = writeFakeSession(bHome, bWork, "deadbeef-9999-4000-8000-0000000c0001", "这条在 B 上");

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

        const pageId = "rchild-" + Date.now();
        const stream = openStream(urlA + "/events?pageId=" + encodeURIComponent(pageId));
        await sleep(1200);

        const sessionsB = JSON.parse((await request(urlB + "/sessions")).text || "{}");
        let remoteId = "";
        for (const project of sessionsB.projects || []) {
            for (const one of project.sessions || []) {
                if (one.file === file) { remoteId = one.id; }
            }
        }
        check(!!remoteId, "B 的清单里找到了那条会话（" + remoteId + "）");
        await request(urlA + "/api?pageId=" + encodeURIComponent(pageId), {
            method: "POST",
            body: JSON.stringify({ type: "workspaceOpenSession", sessionId: "remote:" + urlB + ":" + remoteId, path: file, cwd: bWork }),
        });

        /** 等 A 推来的清单里那条会话满足条件（按会话文件认：那台开出来以后号会换）。 */
        const waitEntries = async (want, ms = 25000) => {
            const t0 = Date.now();
            let last = [];
            while (Date.now() - t0 < ms) {
                const lists = stream.messages.filter((m) => m.type === "sessionList" && Array.isArray(m.sessions));
                last = lists.length ? lists[lists.length - 1].sessions : [];
                const mine = last.filter((one) => one.machine === urlB);
                if (want(mine, last)) { return last; }
                await sleep(400);
            }
            return last;
        };

        const opened = await waitEntries((mine) => mine.some((one) => one.file === file));
        const parent = (opened || []).find((one) => one.machine === urlB && one.file === file);
        check(!!parent, "前置：那台那条会话已经认下了");
        if (!parent) { throw new Error("没有可用的远程会话号"); }

        // 让它派一个子会话（假模型看到「派活」两个字就会演一次子会话工具）
        await request(urlA + "/api?pageId=" + encodeURIComponent(pageId), {
            method: "POST",
            body: JSON.stringify({ type: "send", sessionId: parent.id, text: "帮我派活，跑一件事" }),
        });

        const withChild = await waitEntries((mine) => mine.some((one) => one.parentId === parent.id), 40000);
        const mine = (withChild || []).filter((one) => one.machine === urlB);
        const child = mine.find((one) => one.parentId === parent.id);
        console.log("    那台这边认下的几条：" + JSON.stringify(mine.map((one) => ({ id: one.id, parentId: one.parentId, taba: one.taba && one.taba.role }))));
        check(!!child, "一、那台派出来的子会话出现在了这边的清单里");
        check(!!child && child.parentId === parent.id, "一、它挂在父会话下面（父会话号换成了这边的写法）");
        check(!!child && !!child.taba && child.taba.role === "child", "一、它带着“我是子会话”那一份（taba.role = child）");
        check(!!child && String(child.id).indexOf("remote:") === 0, "一、它的号也是这边的写法（" + (child && child.id) + "）");

        // 关掉父会话：那台上那个子会话也跟着不报了，这边就该摘掉
        await request(urlA + "/api?pageId=" + encodeURIComponent(pageId), {
            method: "POST",
            body: JSON.stringify({ type: "closeSession", sessionId: parent.id }),
        });
        const afterClose = await waitEntries((mine2) => !mine2.some((one) => one.file === file), 30000);
        const left = (afterClose || []).filter((one) => one.machine === urlB);
        check(!left.some((one) => one.id === parent.id), "二、父会话关掉以后它自己不在清单里了");
        check(!left.some((one) => one.parentId === parent.id), "二、挂在它下面的子会话也一并摘掉了（" + JSON.stringify(left.map((one) => one.id)) + "）");
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

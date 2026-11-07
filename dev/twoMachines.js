// @ts-nocheck
/**
 * twoMachines —— 验「多台 pichat 互联」现在是后端在做（页面只跟一台说话）。
 *
 *   npm run compile && node dev/twoMachines.js
 *
 * 从前这些活是页面自己干的：问本机要机器地址、再对每台另开一条推送流、自己翻译会话号、
 * 自己认领新会话、自己列目录……每加一个功能都要想两遍“别台那一路怎么走”。现在都收进了
 * `src/machineHub.ts`，页面（手机 / 浏览器 / 插件面板）只跟本机那一台打交道。
 *
 * 这一趟起两台真后端（各自的 PICHAT_HOME 与临时会话目录），把 B 写进 A 的「远程机器」，然后验：
 *   一、A 把 B 当成「另一台」报出来（/health 里的 machines）；
 *   二、A 能列自己的目录（这也是别的 pichat 来问它时用的那条 `/dirs`）；
 *   三、从 A 点开 B 上的一条会话：B 把它开出来，A 的会话清单里就多了这一条（带 machine 与那台的名字），
 *       而且这条会话的正文（历史）也经转发送到 A 这边——这是“点开别台一条会话就能看”的全部含义；
 *   四、那条会话的文件由 A 替页面去 B 上取（`/file`），页面拿到的还是自己这台的地址；
 *   五、设置里没填的地址不给转（拿别台的会话号来问 A，A 不能替它去问）；
 *   六、B 连不上的时候，A 这边那条会话被标成“那台不在”（machineOnline === false），不会一直挂着。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-two-"));
const launcher = path.join(repoRoot, "bin", "pichat.js");

let failed = 0;
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startBackend(name) {
    const home = path.join(tmpRoot, name);
    const work = path.join(tmpRoot, name.toLowerCase() + "-work");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ label: name }, null, 2));
    const child = spawn(process.execPath, [launcher, "--no-open", "--cwd", work, "--port", "0", "--host", "127.0.0.1"], {
        cwd: repoRoot,
        env: { ...process.env, PICHAT_HOME: home, PICHAT_PI: process.env.PICHAT_PI },
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
    for (let i = 0; i < 150; i += 1) {
        try {
            const info = JSON.parse(fs.readFileSync(file, "utf8"));
            if (info && info.url) { return String(info.url).replace(/\/+$/, ""); }
        } catch { /* 还没写出来 */ }
        await sleep(200);
    }
    throw new Error(`${one.name} 没起来`);
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

/** 开一条推送流，把消息按 JSON 收着（够这一趟用：会话清单与正文都在里面）。 */
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

/** 在某个目录里造一条假会话（pi 的会话文件：一行一条记录）。 */
function writeFakeSession(cwd, id, text) {
    const dashed = cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-");
    const out = path.join(os.homedir(), ".pi", "agent", "sessions", "--" + dashed + "--");
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, "2099-03-03T00-00-00-000Z_" + id + ".jsonl");
    const lines = [
        { type: "session", id, cwd, timestamp: new Date().toISOString() },
        { type: "message", message: { role: "user", content: [{ type: "text", text }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "收到，这一条是从那台回来的。" }] } },
    ];
    fs.writeFileSync(file, lines.map((one) => JSON.stringify(one)).join("\n") + "\n");
    return file;
}

const MARK = "两台机器验一下：这条会话在那台上";

(async () => {
    // 先造好那条假会话，再起后端：那边启动时才去扫有哪些项目（扫完就记着，不跟着磁盘变）
    const bWork = path.join(tmpRoot, "b-work");
    fs.mkdirSync(bWork, { recursive: true });
    const file = writeFakeSession(bWork, "deadbeef-3333-4000-8000-0000000c0001", MARK);
    const a = startBackend("A");
    const b = startBackend("B");
    const cleanup = () => {
        for (const one of [a, b]) { try { one.child.kill(); } catch { /* 已经退了 */ } }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
    };
    try {
        const [urlA, urlB] = await Promise.all([waitUrl(a), waitUrl(b)]);

        console.log("一、这台认识的别的机器");
        fs.writeFileSync(path.join(a.home, "config.json"), JSON.stringify({ label: "A", machines: [urlB] }, null, 2));
        await sleep(1500);
        const healthA = JSON.parse((await request(urlA + "/health")).text || "{}");
        check(!!healthA.machines && healthA.machines.indexOf(urlB) >= 0, `A 的 /health 报出 B（${JSON.stringify(healthA.machines)}）`);

        console.log("二、别台来问目录用的是同一条口子");
        const dirs = await request(urlB + "/dirs?path=" + encodeURIComponent(bWork));
        check(dirs.status === 200 && dirs.text.indexOf("\"dirs\"") >= 0, `B 的 /dirs 能列（回 ${dirs.status}）`);

        console.log("三、从 A 点开 B 上的一条会话");
        const pageId = "two-" + Date.now();
        const stream = openStream(urlA + "/events?pageId=" + encodeURIComponent(pageId));
        await sleep(1200);
        const sessionsB = JSON.parse((await request(urlB + "/sessions")).text || "{}");
        let remoteId = "";
        for (const project of sessionsB.projects || []) {
            for (const one of project.sessions || []) {
                if (one.file === file) { remoteId = one.id; }
            }
        }
        check(!!remoteId, `B 的清单里找到了那条会话（${remoteId}）`);
        const localId = "remote:" + urlB + ":" + remoteId;
        const opened = await request(urlA + "/api?pageId=" + encodeURIComponent(pageId), {
            method: "POST",
            body: JSON.stringify({ type: "workspaceOpenSession", sessionId: localId, path: file, cwd: bWork }),
        });
        check(opened.status === 204, `请 A 打开它（回 ${opened.status}）`);

        let entry = null;
        for (let i = 0; i < 20; i += 1) {
            await sleep(500);
            for (const msg of stream.messages) {
                if (msg.type !== "sessionList" || !Array.isArray(msg.sessions)) { continue; }
                for (const one of msg.sessions) {
                    if (one.machine === urlB && one.file === file) { entry = one; }
                }
            }
            if (entry) { break; }
        }
        const lists = stream.messages.filter((m) => m.type === "sessionList");
        const lastList = lists[lists.length - 1];
        console.log("    A 收到的 sessionList 份数：" + lists.length
            + "；最后一份里的条数：" + (lastList ? lastList.sessions.length : 0)
            + "；内容：" + JSON.stringify((lastList ? lastList.sessions : []).map((one) => ({ id: one.id, machine: one.machine, file: one.file })).slice(0, 4)));
        console.log("    要找的 file：" + file);
        console.log("    清单里那一条：" + JSON.stringify(entry && { id: entry.id, machine: entry.machine, machineName: entry.machineName, file: entry.file }));
        check(!!entry, "A 的会话清单里多了这条（带 machine）");
        check(!!entry && entry.machineName === "B", "清单里写着它跑在哪台（那台的名字）");

        let body = "";
        for (let i = 0; i < 20; i += 1) {
            await sleep(500);
            const hit = stream.messages.find((msg) => msg.type === "userMessage"
                && typeof msg.text === "string" && msg.text.indexOf(MARK) >= 0);
            if (hit) { body = hit.text; break; }
        }
        check(!!body, "那条会话的正文（历史）经转发送到了 A 这边");

        console.log("四、那条会话的文件由 A 替页面去 B 上取");
        const idForFile = entry ? entry.id : localId;
        const inside = "hello-from-b.txt";
        fs.writeFileSync(path.join(bWork, inside), "这一份在 B 的会话目录里");
        const got = await request(urlA + "/file?session=" + encodeURIComponent(idForFile)
            + "&path=" + encodeURIComponent(inside));
        check(got.status === 200 && got.text.indexOf("这一份在 B 的会话目录里") >= 0, `A 的 /file 转去了 B（回 ${got.status}，${got.text.length} 字）`);

        console.log("五、名单里没填的不给转");
        const stray = await request(urlA + "/file?session=" + encodeURIComponent("remote:http://127.0.0.1:9:x")
            + "&path=" + encodeURIComponent("x"));
        check(stray.status !== 200, `没填在「远程机器」里的地址不给读（回 ${stray.status}）`);

        console.log("六、那台连不上时，这边标成“不在”");
        fs.writeFileSync(path.join(a.home, "config.json"), JSON.stringify({ label: "A", machines: [] }, null, 2));
        await sleep(3000);
        let gone = false;
        for (let i = 0; i < 30; i += 1) {
            const lists = stream.messages.filter((msg) => msg.type === "sessionList" && Array.isArray(msg.sessions));
            const last = lists[lists.length - 1];
            if (last && last.sessions.every((one) => one.machine !== urlB)) { gone = true; break; }
            await sleep(500);
        }
        check(gone, "那台从名单里拿掉后，这条会话从清单里消失（不再对着一个连不上的会话干等）");
        try { stream.req.destroy(); } catch { /* 收摊 */ }
    } finally {
        if (failed > 0) {
            console.log("");
            console.log("A 的日志（最后 20 行）：");
            console.log(String(a.log.join("")).split(String.fromCharCode(10)).slice(-20).join(String.fromCharCode(10)));
            console.log("B 的日志（最后 10 行）：");
            console.log(String(b.log.join("")).split(String.fromCharCode(10)).slice(-10).join(String.fromCharCode(10)));
        }
        cleanup();
        try { fs.rmSync(path.join(os.homedir(), ".pi", "agent", "sessions",
            "--" + b.work.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-") + "--"), { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
    }
    console.log("");
    console.log(failed === 0 ? "全部通过。" : `${failed} 项没通过。`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
    console.log("跑挂了：" + ((err && err.stack) || err));
    process.exit(1);
});

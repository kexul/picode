// @ts-nocheck
/**
 * remoteTabs —— 别台开着的会话要跟本机一个规矩：都在顶条上摆着。
 *
 * 从前只摆这边点开过的：那台自己开着好几条，这边一条都看不见，得先去侧边栏里一条条点出来，
 * 多台用起来跟本机差一截。现在那台每次报清单，它的主会话（子会话不占格）全并进顶条；
 * 正文仍旧按需：头一回切到某一格才请那台整段重放一遍。
 *
 * 这一趟起两台真后端（各自一个 HOME、假的 pi，秒回），验四件事：
 *   一、B 上开着两条会话，A 的页面在没点过它们的时候，顶条那本账（sessionList）里就有这两条；
 *   二、这时正文一条都没推过来（按需，不然那台开十条就要灌十条）；
 *   三、A 切到其中一条：那一条的正文过来了，另一条的一条都没有；
 *   四、A 点 × 关掉它：那一格从清单里消失，而且不会因为 B 下一次报清单又冒回来。
 *
 *   npm run compile && node dev/remoteTabs.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-rtabs-"));
const launcher = path.join(repoRoot, "bin", "pichat.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);

function startBackend(name, machines) {
    const home = path.join(tmpRoot, name);
    const work = path.join(tmpRoot, name.toLowerCase() + "-work");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ label: name, machines: machines || [] }, null, 2));
    const child = spawn(process.execPath, [launcher, "--no-open", "--cwd", work, "--port", "0", "--host", "127.0.0.1"], {
        cwd: repoRoot,
        // 两台各自一个 HOME：不然两边扫的是同一份 ~/.pi 会话目录
        env: {
            ...process.env,
            HOME: path.join(home, "user"),
            USERPROFILE: path.join(home, "user"),
            PICHAT_HOME: home,
            PICHAT_PI: process.env.PICHAT_PI || path.join(repoRoot, "dev", process.platform === "win32" ? "fake-pi.cmd" : "fake-pi.sh"),
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

function post(url, pageId, msg) {
    return request(url + "/api?pageId=" + encodeURIComponent(pageId), {
        method: "POST",
        body: JSON.stringify(msg),
    });
}

/** 最后一份会话清单里，跑在别台那台上的那几条。 */
function remoteEntries(stream, urlB) {
    const lists = stream.messages.filter((m) => m.type === "sessionList" && Array.isArray(m.sessions));
    const last = lists[lists.length - 1];
    return last ? last.sessions.filter((one) => one.machine === urlB) : [];
}

/** 这条会话的正文来了几条（不带会话号的系统消息不算）。 */
function contentOf(stream, sessionId) {
    return stream.messages.filter((m) => m.sessionId === sessionId
        && ["userMessage", "assistantMessage", "message", "chunk", "tool", "syncPoint", "historyWindow"].indexOf(m.type) >= 0);
}

const MARK = "两条会话各说一句";

/**
 * 假的那台：只会报清单（而且一直报同一个）、把收到的指令记下来。
 *
 * 用来验“这边点了 × 之后，那台还没真关掉、照旧每半秒报一遍它”—— 那一格不能又冒回来。
 * 真后端那边关得太快，抓不到这个窗口。
 */
function startFakeMachine() {
    const commands = [];
    const streams = new Set();
    const sessions = [
        { id: "fake-1", title: "假的那台第一条", name: "假的那台第一条", cwd: "/fake/w", file: "/fake/one.jsonl", streaming: false },
        { id: "fake-2", title: "假的那台第二条", name: "假的那台第二条", cwd: "/fake/w", file: "/fake/two.jsonl", streaming: false },
    ];
    let seq = 0;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://x");
        if (req.method === "POST" && url.pathname === "/api") {
            let body = "";
            req.setEncoding("utf8");
            req.on("data", (c) => { body += c; });
            req.on("end", () => {
                try { commands.push(JSON.parse(body)); } catch { /* 不是 JSON 就忽略 */ }
                res.writeHead(204).end();
            });
            return;
        }
        if (url.pathname === "/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, app: "pichat", name: "F", version: "fake" }));
            return;
        }
        if (url.pathname === "/sessions") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ projects: [], hasMore: false }));
            return;
        }
        if (url.pathname === "/events") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
            streams.add(res);
            const send = (msg) => {
                seq += 1;
                res.write("event: msg\ndata: " + JSON.stringify({ ...msg, seq }) + "\n\n");
            };
            send({ type: "hello" });
            send({ type: "sessionList", sessions });
            // 每半秒再报一遍（那台还没真关掉它）
            const timer = setInterval(() => { send({ type: "sessionList", sessions }); }, 500);
            req.on("close", () => { clearInterval(timer); streams.delete(res); });
            return;
        }
        res.writeHead(404).end();
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const url = "http://127.0.0.1:" + server.address().port;
            resolve({
                url,
                commands,
                close: () => { for (const one of streams) { try { one.end(); } catch { /* 已经断了 */ } } server.close(); },
            });
        });
    });
}

(async () => {
    const a = startBackend("A");
    const b = startBackend("B");
    const cleanup = () => {
        for (const one of [a, b]) { try { one.child.kill(); } catch { /* 已经退了 */ } }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
    };
    try {
        const [urlA, urlB] = await Promise.all([waitUrl(a), waitUrl(b)]);
        // A 认识 B：写设置后看门狗会自己接上（不必重启）
        fs.writeFileSync(path.join(a.home, "config.json"), JSON.stringify({ label: "A", machines: [urlB] }, null, 2));

        console.log("零、B 上开两条会话（两个不同的工作区），各说一句");
        const dir1 = path.join(b.work, "w1");
        const dir2 = path.join(b.work, "w2");
        fs.mkdirSync(dir1, { recursive: true });
        fs.mkdirSync(dir2, { recursive: true });
        const bStream = openStream(urlB + "/events?pageId=bpage");
        await sleep(800);
        await post(urlB, "bpage", { type: "newSessionInWorkspace", path: dir1 });
        await sleep(2500);
        await post(urlB, "bpage", { type: "newSessionInWorkspace", path: dir2 });
        await sleep(2500);
        let openIds = [];
        for (let i = 0; i < 40; i += 1) {
            const lists = bStream.messages.filter((m) => m.type === "sessionList" && Array.isArray(m.sessions));
            const last = lists[lists.length - 1];
            openIds = last ? last.sessions.map((one) => one.id) : [];
            if (openIds.length >= 2) { break; }
            await sleep(250);
        }
        check(openIds.length >= 2, `B 上开着 ${openIds.length} 条会话（${openIds.join("、")}）`);
        for (const id of openIds) {
            await post(urlB, "bpage", { type: "send", sessionId: id, text: MARK, images: [] });
            await sleep(1200);
        }
        await sleep(1500);

        console.log("一、A 的顶条上，没点过也该有 B 开着的每一条");
        const aPage = "apage-" + Date.now();
        const aStream = openStream(urlA + "/events?pageId=" + encodeURIComponent(aPage));
        let entries = [];
        for (let i = 0; i < 60; i += 1) {
            await sleep(500);
            entries = remoteEntries(aStream, urlB);
            if (entries.length >= openIds.length) { break; }
        }
        check(entries.length === openIds.length,
            `A 的清单里有 B 那 ${openIds.length} 条（拿到 ${entries.length} 条：${entries.map((one) => one.id.split(":").pop()).join("、")}）`);
        check(entries.every((one) => !one.parentId), "这几位都是主会话（子会话不占格）");
        check(entries.every((one) => one.machineName === "B"), "每一条都写着跑在 B 上");

        console.log("二、没切过去的会话，正文一条都不推（按需）");
        const quiet = entries.filter((one) => contentOf(aStream, one.id).length > 0);
        check(quiet.length === 0, `这会儿谁都没推过正文（有正文的是 ${quiet.length} 条）`);

        console.log("三、A 切到其中一条：它自己的正文过来，另一条的一条都不来");
        const first = entries[0];
        const second = entries.find((one) => one.id !== first.id);
        await post(urlA, aPage, { type: "switchSession", sessionId: first.id });
        let got = 0;
        for (let i = 0; i < 40; i += 1) {
            await sleep(500);
            got = contentOf(aStream, first.id).length;
            if (got > 0) { break; }
        }
        check(got > 0, `切过去的那条正文到了（${got} 条）`);
        check(!!second && contentOf(aStream, second.id).length === 0, "另一条的还是没推（没切过去就不推）");

        console.log("四、A 点 × 关掉它：那一格消失，不会被下一次清单顶回来");
        await post(urlA, aPage, { type: "closeSession", sessionId: first.id });
        let goneAt = -1;
        for (let i = 0; i < 40; i += 1) {
            await sleep(250);
            const now = remoteEntries(aStream, urlB).map((one) => one.id);
            if (now.indexOf(first.id) < 0) { goneAt = i; break; }
        }
        check(goneAt >= 0, "关掉后它从 A 的清单里消失了");
        // 再看几秒：B 那台还在报清单，不能又摆回来（在 B 上发一句，那边就会重新报一遍清单）
        const listsBefore = aStream.messages.filter((m) => m.type === "sessionList").length;
        await post(urlB, "bpage", { type: "send", sessionId: second.id.split(":").pop(), text: "再报一遍清单", images: [] });
        await sleep(5000);
        const stillGone = remoteEntries(aStream, urlB).map((one) => one.id).indexOf(first.id) < 0;
        const listsAfter = aStream.messages.filter((m) => m.type === "sessionList").length;
        check(stillGone, `那台又报了 ${listsAfter - listsBefore} 份新清单，那一格没回来`);
        // B 那边也该真关掉了
        let bHas = true;
        for (let i = 0; i < 20; i += 1) {
            await sleep(300);
            const lists = bStream.messages.filter((m) => m.type === "sessionList" && Array.isArray(m.sessions));
            const last = lists[lists.length - 1];
            const ids = last ? last.sessions.map((one) => one.id) : [];
            bHas = ids.indexOf(first.id.split(":").pop()) >= 0;
            if (!bHas) { break; }
        }
        check(!bHas, "B 那边那条也真关掉了（关的是那台的会话，不只是这边的一格）");

        console.log("五、那台还没真关掉、还在报它的时候，那一格不能自己冒回来");
        const fake = await startFakeMachine();
        fs.writeFileSync(path.join(a.home, "config.json"), JSON.stringify({ label: "A", machines: [urlB, fake.url] }, null, 2));
        let fakeEntries = [];
        for (let i = 0; i < 60; i += 1) {
            await sleep(500);
            fakeEntries = remoteEntries(aStream, fake.url);
            if (fakeEntries.length >= 2) { break; }
        }
        check(fakeEntries.length === 2, `那台开着的两条摆到了顶条上（拿到 ${fakeEntries.length} 条）`);
        const firstFake = fakeEntries[0];
        await post(urlA, aPage, { type: "closeSession", sessionId: firstFake.id });
        let afterClose = [];
        for (let i = 0; i < 20; i += 1) {
            await sleep(250);
            afterClose = remoteEntries(aStream, fake.url);
            if (afterClose.map((one) => one.id).indexOf(firstFake.id) < 0) { break; }
        }
        // 那台每半秒报一遍它（一共报了十来遍），这一格一直不能回来
        let cameBack = false;
        for (let i = 0; i < 16; i += 1) {
            await sleep(250);
            if (remoteEntries(aStream, fake.url).map((one) => one.id).indexOf(firstFake.id) >= 0) { cameBack = true; break; }
        }
        check(!cameBack, "那台连着报了四秒它，那一格没再出现");
        const asked = fake.commands.some((one) => one.type === "closeSession"
            && String(one.sessionId) === firstFake.id.split(":").pop());
        check(asked, "× 也真转给那台了（那台收到了 closeSession）");
        const kept = remoteEntries(aStream, fake.url).map((one) => one.id).indexOf(fakeEntries[1].id) >= 0;
        check(kept, "那台的另一条照旧摆着（只关点的那一格）");
        fake.close();

        try { aStream.req.destroy(); } catch { /* 收摊 */ }
        try { bStream.req.destroy(); } catch { /* 收摊 */ }
    } finally {
        if (failed > 0) {
            console.log("");
            console.log("A 的日志（最后 20 行）：");
            console.log(String(a.log.join("")).split("\n").slice(-20).join("\n"));
            console.log("B 的日志（最后 20 行）：");
            console.log(String(b.log.join("")).split("\n").slice(-20).join("\n"));
        }
        cleanup();
    }
    console.log("");
    console.log(failed === 0 ? "全部通过。" : `${failed} 项没通过。`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
    console.log("跑挂了：" + ((err && err.stack) || err));
    process.exit(1);
});

// @ts-nocheck
/**
 * machineProxy —— 验「别台的会话由这台后端转过去」（`/m/<对方的地址>/…`）。
 *
 *   npm run compile && node dev/machineProxy.js
 *
 * 为什么有这条：手机是拿局域网地址打开页面的，而「远程机器」那栏填的往往是别台自己那个网里的
 * 地址（tailscale 的 100.x 之类）。以前页面自己去连那台，手机不一定到得了，界面上连那一节都不出现
 * （问不到的时候页面一直等，没有超时）；现在页面只连本机，去那台的东西都由本机后端转。
 *
 * 纯 Node（不开浏览器、不叫模型）：起两台真后端（各自的 PICHAT_HOME、临时会话目录），B 写进 A 的
 * 「远程机器」，然后验：
 *   一、`/m/<B>/health`、`/m/<B>/sessions` 跟直接问 B 拿到的一模一样；
 *   二、名单里没有的地址一律 403（不做成谁都能用的中转）；
 *   三、往那台发一条消息（`/api`）能送到，那边推来的东西（推送流 `/events`）能原样转回来；
 *   四、那台到不了时，8 秒就给一句「连不上那台（8 秒没回应）」，页面不必一直干等；
 *   五、页面自己的安全策略只剩本站（它不再直接连那台）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-proxy-"));
const launcher = path.join(repoRoot, "bin", "pichat.js");

/** 到不了的地址（tailscale 网段里一个不存在的号）：连上去没人应，只能等超时。 */
const BLACKHOLE = "http://100.93.255.250:51883";

let failed = 0;
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一台后端（`bin/pichat.js` 自己会把它那份 server.json 写进 home）。 */
function startBackend(name) {
    const home = path.join(tmpRoot, name);
    const work = path.join(tmpRoot, name + "-work");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ label: name }, null, 2));
    const child = spawn(process.execPath, [launcher, "--no-open", "--cwd", work, "--port", "0", "--host", "127.0.0.1"], {
        cwd: repoRoot,
        env: { ...process.env, PICHAT_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    return { name, home, work, child };
}

/** 等那台把地址写出来（server.json），最多等 30 秒。 */
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
        const req = http.request(url, { method, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} }, (res) => {
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

/** 开一条推送流，把事件按顺序收着（只记类型与出现过的会话号，正文用来找关键词）。 */
function openStream(url) {
    const seen = [];
    let sessionId = "";
    const req = http.get(url, (res) => {
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
                const block = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const type = /"type":"([a-zA-Z]+)"/.exec(block);
                if (!type) { continue; }
                seen.push(type[1]);
                const id = /"id":"([^"]+)"/.exec(block);
                if (!sessionId && type[1] === "sessionList" && id) { sessionId = id[1]; }
            }
        });
    });
    req.on("error", () => { /* 收摊时断开是正常的 */ });
    return { seen, req, sessionOf: () => sessionId };
}

const writeConfig = (one, patch) => fs.writeFileSync(path.join(one.home, "config.json"), JSON.stringify(patch, null, 2));

(async () => {
    const a = startBackend("A");
    const b = startBackend("B");
    const stops = [() => { try { a.child.kill(); } catch { /* 已经退了 */ } }, () => { try { b.child.kill(); } catch { /* 同上 */ } }];
    const cleanup = () => { stops.forEach((stop) => stop()); try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ } };
    try {
        const [urlA, urlB] = await Promise.all([waitUrl(a), waitUrl(b)]);
        writeConfig(a, { label: "A", machines: [urlB] });
        await sleep(300);

        console.log("一、转过去的东西跟直接问那台一模一样");
        const directHealth = await request(urlB + "/health");
        const proxiedHealth = await request(urlA + "/m/" + encodeURIComponent(urlB) + "/health");
        const direct = JSON.parse(directHealth.text || "{}");
        const proxied = JSON.parse(proxiedHealth.text || "{}");
        check(proxiedHealth.status === 200, `/m/<B>/health 回了 200（拿到的是 ${proxiedHealth.status}）`);
        check(proxied.app === "pichat" && proxied.name === direct.name, `报的还是那台（名字 ${proxied.name}）`);
        check(proxied.pid === direct.pid, "pid 也是那台的（说明真是它答的，不是这台替它编的）");
        const proxiedSessions = await request(urlA + "/m/" + encodeURIComponent(urlB) + "/sessions");
        const directSessions = await request(urlB + "/sessions");
        check(proxiedSessions.status === 200 && proxiedSessions.text === directSessions.text, "/m/<B>/sessions 跟直接问那台一个字节都不差");

        console.log("二、名单里没有的不给转");
        const notListed = await request(urlA + "/m/" + encodeURIComponent("http://127.0.0.1:1") + "/health");
        check(notListed.status === 403, `没填在「远程机器」里的地址回 403（拿到的是 ${notListed.status}）`);

        console.log("三、发过去、推回来");
        const pageId = "proxy-probe-" + Date.now();
        const stream = openStream(urlA + "/m/" + encodeURIComponent(urlB) + "/events?pageId=" + encodeURIComponent(pageId));
        await sleep(1200);
        const posted = await request(urlA + "/m/" + encodeURIComponent(urlB) + "/api?pageId=" + encodeURIComponent(pageId), {
            method: "POST",
            body: JSON.stringify({ type: "channelPing" }),
        });
        check(posted.status === 204, `往那台发一条消息能送到（回 ${posted.status}）`);
        await sleep(1500);
        check(stream.seen.includes("hello"), "那台的推送流转过来了（收到 hello）");
        check(stream.seen.includes("sessionList"), "那台推的会话清单也转过来了");
        stream.req.destroy();

        console.log("四、到不了的时候不让人干等");
        writeConfig(a, { label: "A", machines: [BLACKHOLE] });
        const started = Date.now();
        const unreachable = await request(urlA + "/m/" + encodeURIComponent(BLACKHOLE) + "/health");
        const waited = Date.now() - started;
        check(unreachable.status === 504, `回 504（拿到的是 ${unreachable.status}）`);
        check(/8 秒没回应/.test(unreachable.text), `正文写着「${String(unreachable.text).trim()}」`);
        check(waited >= 7000 && waited <= 20000, `等了 ${(waited / 1000).toFixed(1)} 秒就回了，不是一直挂着`);

        console.log("五、页面不再自己去连那台");
        const page = await request(urlA + "/");
        const csp = /content="(default-src[^"]+)"/.exec(page.text);
        check(!!csp && /connect-src 'self';/.test(csp[1]), "页面的 connect-src 只有本站（别台的地址一个都不放行）");
    } finally {
        cleanup();
    }
    console.log("");
    console.log(failed === 0 ? "全部通过。" : `${failed} 项没通过。`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
    console.log("跑挂了：" + (err && err.stack || err));
    process.exit(1);
});

// @ts-nocheck
/**
 * trustedOrigin —— 验「页面是从 https 反代的地址打开的」这条路（设置文件里的 webServer.trustedOrigins）。
 *
 *   node dev/trustedOrigin.js
 *
 * 为什么要验：手机想用 https 打开页面（比如 `tailscale serve --bg --https=443 http://127.0.0.1:51883`）。
 * 可那样页面就是从另一个地址打开的，后端原来只认「http + 本机那几个名字/端口」，会把页面发来的
 * 请求当成别人网站偷偷发来的顶回去（403）。人在设置里写下 trustedOrigins 之后，那些地址才算自己人。
 *
 * 这一跑分两段：
 *  一、来源这道关（直接打 /api，看是 403 还是放行）：
 *       1. 名单里的 https 来源       → 放行
 *       2. 别人网站的 https 来源     → 403
 *       3. 本机 http 地址            → 照旧放行
 *       4. 不带 Origin（命令行那种） → 照旧放行
 *  二、真走一遍 https（本机现起一个 https 反代，证书现签，浏览器开它）：
 *       5. 页面是从反代那个地址打开的
 *       6. 消息发得出去、回复收得回来（相对地址、SSE、POST 在反代后面都对得上）
 *
 * 反代是自己现起的：tailscale serve 在这儿跑不起来（要 tailnet 里先开 HTTPS 证书）。
 * 但两件事跟真的一样：https 终止后转给本机 http；转过去时 Host 头照真那样原样带（不改成 127.0.0.1）。
 * 没有 openssl（现签证书要用它）时只跑第一段，说一声。
 */
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { execFileSync } = require("child_process");

const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

/** 假装这是那台机器的域名；真用起来是 `xxx.ts.net` 这种。 */
const HOSTNAME = "pichat-test.example";
const CERT_DIR = path.join(__dirname, ".scratch", "trusted-origin");
const SHOT_DIR = path.join(__dirname, "shots");

let failed = 0;
function ok(text) { console.log("  ✔ " + text); }
function bad(text) { console.log("  ✘ " + text); failed += 1; }
function check(cond, text) { (cond ? ok : bad)(text); }

/** 现签一张自签证书（只有这一跑用，落在 dev/.scratch 里）。签名器不在了就返回 undefined。 */
function makeCert() {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    const key = path.join(CERT_DIR, "key.pem");
    const cert = path.join(CERT_DIR, "cert.pem");
    try {
        execFileSync("openssl", [
            "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", key, "-out", cert, "-days", "2",
            "-subj", `/CN=${HOSTNAME}`,
            "-addext", `subjectAltName=DNS:${HOSTNAME}`,
        ], { stdio: "ignore" });
    } catch {
        return undefined;
    }
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/** 先占一个空闲端口再放掉：下面那个 http 地址要写进 trustedOrigins，起后端之前就得知道端口。 */
function pickFreePort() {
    return new Promise((resolve) => {
        const server = http.createServer();
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

/** 打一次 /api（带指定 Origin），返回状态码。 */
function postApi(port, origin) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ type: "channelPing" });
        const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
        if (origin) { headers.origin = origin; }
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api?pageId=nobody", headers }, (res) => {
            res.resume();
            resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end(body);
    });
}

async function main() {
    process.env.FAKEPI_THINK_MS = "0";
    const quiet = (text) => { if (/错误|失败/.test(text)) { console.log("  [日志] " + text); } };

    const backendPort = await pickFreePort();
    const insecureOrigin = `http://${HOSTNAME}:${backendPort}`;

    // 反代先起来（它转发时现读后端端口），端口定下来才知道该把哪个 https 地址写进名单
    let backendHostPort = 0;
    const tls = makeCert();
    let proxy = null;
    let proxyPort = 0;
    if (tls) {
        proxy = https.createServer(tls, (req, res) => {
            if (!backendHostPort) { res.writeHead(503); res.end("后端还没起来"); return; }
            // Host 头原样带过去（tailscale serve 就是这样），后端那边靠 trustedOrigins 里的域名认它
            const up = http.request({ host: "127.0.0.1", port: backendHostPort, method: req.method, path: req.url, headers: req.headers }, (upRes) => {
                res.writeHead(upRes.statusCode || 502, upRes.headers);
                upRes.pipe(res);
            });
            up.on("error", () => {
                try { res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }); res.end("反代连不上后端"); } catch { /* 已经断了 */ }
            });
            req.pipe(up);
        });
        await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        proxyPort = proxy.address().port;
    }
    const trustOrigin = tls ? `https://${HOSTNAME}:${proxyPort}` : undefined;

    const harness = createHarness({
        fakePi: true,
        host: "127.0.0.1",
        port: backendPort,
        trustedOrigins: trustOrigin ? [trustOrigin, insecureOrigin] : [insecureOrigin],
        log: quiet,
    });
    const url = await harness.start();
    backendHostPort = Number(new URL(url).port);
    console.log("调试后端：" + url);
    if (trustOrigin) { console.log("反代这一层：" + trustOrigin + "/"); }

    const opened = [];
    const openAt = async (target) => {
        const one = await openPage({
            url: target,
            shotDir: SHOT_DIR,
            // 这台机器上 Chrome 走系统代理，那两个假域名会被代理挡成 502（127.0.0.1 不走代理，
            // 所以别的检查碰不到这事）；这里不走代理，再让域名解析到本机。
            extraArgs: ["--ignore-certificate-errors", "--no-proxy-server", `--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1`],
        });
        opened.push(one);
        return one;
    };

    try {
        // ---- 一、来源这道关 ----
        const good = await postApi(backendPort, trustOrigin);
        check(good !== 403, `名单里写下的 https 来源放行（收到 ${good}，不是 403）`);
        const evil = await postApi(backendPort, "https://evil.example.com");
        check(evil === 403, `没写在名单里的 https 来源顶回去（收到 ${evil}）`);
        const local = await postApi(backendPort, `http://127.0.0.1:${backendPort}`);
        check(local !== 403, `本机 http 地址照旧放行（收到 ${local}）`);
        const none = await postApi(backendPort, undefined);
        check(none !== 403, `不带 Origin 的请求（命令行那种）照旧放行（收到 ${none}）`);

        if (!tls) {
            console.log("  （这台机器上没有 openssl，现签不了证书：https 那一半跳过）");
        } else {
            // ---- 二、真走一遍 https ----
            const secure = await openAt(`${trustOrigin}/`);
            // 打不开 / 连不上时把页面上看到的东西一并报出来，省得只看到一句超时
            await secure.page.waitReady().catch(async (err) => {
                console.log("  [诊断] 页面文字：" + JSON.stringify((await secure.page.text()).slice(0, 400)));
                console.log("  [诊断] 页面报错：" + JSON.stringify((secure.page.pageErrors || []).slice(0, 5)));
                throw err;
            });
            const originNow = await secure.page.eval("return location.origin");
            check(originNow === trustOrigin, `页面是从反代那个地址打开的（${originNow}）`);

            await secure.page.send("你好");
            await secure.page.waitAnswer("完事");
            ok("消息发得出去、回复收得回来（反代后面相对地址 / SSE / POST 都对得上）");
            await secure.page.shot("trusted-origin.png");
        }
    } finally {
        for (const one of opened) { try { one.close(); } catch { /* 已经关了 */ } }
        await harness.stop();
        if (proxy) { try { proxy.close(); } catch { /* 已经关了 */ } }
    }

    console.log(failed === 0 ? "\n全部通过。" : `\n有 ${failed} 项没过。`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });

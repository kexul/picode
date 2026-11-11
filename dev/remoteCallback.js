// @ts-nocheck
/**
 * remoteCallback —— 验「点别台推来的那张卡片，这边回头请那台切会话」用的是哪条地址。
 *
 *   node dev/remoteCallback.js
 *
 * 为什么单独验这一条：那台推过来的消息里自己带着一个网页地址（`pageUrl`），可那是它挑的
 * 第一个网卡；两台之间真正通的那条路未必是它（实测踩过：一台报 10.61.x，而两台实际是
 * 经 100.x 那条通的）。拿错的地址回话，请求发不出去也不报错，看着就是“点了卡片，
 * 浏览器的那张标签页切到前面了，可那边的会话没换”。
 *
 * 所以回话地址要用“这条推送实际是从哪个地址进来的” + 那台报的端口。这条脚本就验这个：
 * 假的那台故意把 pageUrl 报成一个连不通的地址，只把 pagePort 报对，
 * 然后点卡片，看那条 activate 有没有落到假的那台身上、带的是哪个会话。
 *
 * 真后端、真卡片、真 HTTP；只有假的那台是个本地小服务。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

const CONFIG_FILE = path.join(__dirname, ".scratch", "pichat", "config.json");

main().catch((err) => {
    console.error("出错了：" + (err && err.message ? err.message : String(err)));
    process.exit(1);
});

async function main() {
    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };

    const before = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, "utf8") : undefined;
    const harness = createHarness({ fakePi: true, port: 0, log: () => { /* 安静跑 */ } });
    let open;
    let notifyWas = true;
    try {
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ label: "公司这台", notify: {} }, null, 2), "utf8");
        const url = await harness.start();
        const host = harness.host();
        notifyWas = host.getNotifyTurnEnd();
        if (!notifyWas) { host.mutateViewOption("notifyTurnEnd"); }

        // 假的那台：收这边回头发的请求，记下来
        const got = [];
        const fakeHome = http.createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
                try { got.push(JSON.parse(body)); } catch { got.push({}); }
                res.writeHead(204, { "Cache-Control": "no-store" });
                res.end();
            });
        });
        await new Promise((resolve) => fakeHome.listen(0, "127.0.0.1", resolve));
        const homePort = fakeHome.address().port;

        open = await openPage({ url, timeoutMs: 60000 });
        const page = open.page;
        await page.waitReady();
        const pageId = await page.eval(`return (document.querySelector('meta[name="pichat-page"]') || {}).content || ""`);
        const sessionId = host.clientSessions.get(pageId);
        check(!!sessionId, "这个页面还没对上会话，后面没法验");

        // 那台推一条“有事”过来：地址故意报成连不通的（10.255.255.1 是保留的、路由不到的），
        // 端口报对（它真正在听的那个）。这正是真机上会发生的：地址挑错网卡、端口没错。
        const badUrl = "http://10.255.255.1:" + homePort;
        const posted = await fetch(url.replace(/\/+$/, "") + "/notify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                label: "家里那台", sessionId: "home-session-7", name: "家里那个会话",
                text: "跑完了", kind: "done", pageUrl: badUrl, pagePort: homePort,
            }),
        });
        check(posted.status === 204, `推一条过去，响应应当是 204，实际 ${posted.status}`);
        const remoteKey = "remote:家里那台:home-session-7";
        for (let i = 0; i < 40 && !host.notice.shownKeys().includes(remoteKey); i++) { await sleep(100); }
        check(host.notice.shownKeys().includes(remoteKey), "推过来的那张卡片没弹出来，后面验不了");

        // 这边存下来的回话地址应当是“这次请求从哪儿进来的 + 它报的端口”，不是那个连不通的地址
        const memo = host.remoteNoticePages.get(remoteKey);
        check(!!memo, "那张卡片的账没存下来（点它的时候就没地址可用了）");
        if (memo) {
            check(!memo.pageUrl.includes("10.255.255.1"),
                `回话地址还是那台自己报的那个（${memo.pageUrl}）：多网卡时就会发到不通的地方去`);
            check(memo.pageUrl === "http://127.0.0.1:" + homePort,
                `回话地址应当是这次连接进来的地址 + 它报的端口（http://127.0.0.1:${homePort}），实际 ${memo.pageUrl}`);
            console.log(`  存下来的回话地址：${memo.pageUrl}（那台自己报的是 ${badUrl}，连不通）`);
        }

        // 点那张卡片（真鼠标点不了别的进程的窗口，推一行它点了以后会写的那条）
        const stdout = host.notice.child && host.notice.child.stdout;
        check(!!stdout, "画卡片那支小程序没起来，这一段验不了");
        if (stdout) { stdout.push(Buffer.from("click\t" + remoteKey + "\n", "utf8")); }
        let asked;
        for (let i = 0; i < 60 && !asked; i++) {
            asked = got.find((one) => one.activate === true);
            if (!asked) { await sleep(100); }
        }
        check(!!asked, `点了卡片，那条“请那台切会话”没落到它身上（收到 ${got.length} 条：${JSON.stringify(got)}）`);
        if (asked) {
            check(asked.sessionId === "home-session-7", `带过去的会话是 ${JSON.stringify(asked.sessionId)}，应当是那张卡片说的那个`);
            check(asked.label === "公司这台", `带过去的标签是 ${JSON.stringify(asked.label)}，应当是这台的「公司这台」`);
            console.log(`  那条请求落到了那台上：会话 ${asked.sessionId}、标签 ${asked.label}`);
        }
        // 这边的页面不跟着切（那不是这台的会话）
        check(host.clientSessions.get(pageId) === sessionId, "点了别台推来的卡片，这边的页面竟然自己切走了");

        fakeHome.close();
        if (problems.length) {
            console.log("");
            console.log(`有问题（${problems.length} 条）：`);
            for (const p of problems) { console.log("  ! " + p); }
            throw new Error(`别台推来的卡片回话地址没对上：${problems.length} 条`);
        }
        console.log("");
        console.log("点别台推来的卡片：回话地址用的是“这条请求从哪儿进来的 + 它报的端口”，不是它自己报的那个地址；请求确实落到了那台上。");
    } finally {
        if (open) { try { await open.close(); } catch { /* 收摊出错不拦路 */ } }
        try { await harness.stop(); } catch { /* 收摊出错不拦路 */ }
        try {
            if (before === undefined) { fs.rmSync(CONFIG_FILE, { force: true }); }
            else { fs.writeFileSync(CONFIG_FILE, before, "utf8"); }
        } catch { /* 放不回去就算了 */ }
        try {
            const host = harness.host();
            if (host && host.getNotifyTurnEnd() !== notifyWas) { host.mutateViewOption("notifyTurnEnd"); }
        } catch { /* 收摊了就算了 */ }
    }
}

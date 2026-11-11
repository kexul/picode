// @ts-nocheck
/**
 * remoteCallback —— 验「点别台推来的那张卡片，这边回头请那台切会话」用的是哪条地址。
 *
 *   node dev/remoteCallback.js
 *
 * 这件事的规矩就一条：**别信对方自报的地址，用它连进来的那个地址**。
 * 对方自报的是它挑的第一个网卡，两台之间真正通的那条未必是它（实测踩过：一台报 10.61.x，
 * 而两台实际是经 100.x 那条通的）。用错的地址回话，请求发不出去也不报错，看着就是
 * “点了卡片，浏览器那张标签页切到前面了，可那边的会话没换”。
 *
 * 所以推送里只报端口（`pagePort`），地址那半由收到的那台按 TCP 连接进来的地址拼。
 * 这条脚本分三种推法各验一遍（都走真 HTTP，落到真后端的 /notify 上）：
 *
 *   一、**新版本**：只报 pagePort —— 回话地址该是“连进来的地址 + 这个端口”；
 *   二、**旧版本**：还带着一个连不通的 pageUrl（10.255.255.1）—— 不许用它，仍按第一种算；
 *   三、**更老的版本**：只带 pageUrl、没端口 —— 没别的可用，只能回退用 pageUrl（发不出去）。
 *
 * 真后端、真卡片、真 HTTP；只有“那台”是个本地小服务。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

const CONFIG_FILE = path.join(__dirname, ".scratch", "pichat", "config.json");
/** 路由不到的地址：用它假装“那台挑错了网卡”。 */
const UNREACHABLE = "10.255.255.1";

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
    let fakeHome;
    try {
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ label: "公司这台", notify: {} }, null, 2), "utf8");
        const url = await harness.start();
        const host = harness.host();
        notifyWas = host.getNotifyTurnEnd();
        if (!notifyWas) { host.mutateViewOption("notifyTurnEnd"); }

        // 假的“那台”：收这边回头发的请求，记下来
        const got = [];
        fakeHome = http.createServer((req, res) => {
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
        const notifyUrl = url.replace(/\/+$/, "") + "/notify";

        open = await openPage({ url, timeoutMs: 60000 });
        const page = open.page;
        await page.waitReady();
        const pageId = await page.eval(`return (document.querySelector('meta[name="pichat-page"]') || {}).content || ""`);
        const sessionId = host.clientSessions.get(pageId);
        check(!!sessionId, "这个页面还没对上会话，后面没法验");

        /** 推一条过来，返回那张卡片在账上的东西。 */
        const push = async (body) => {
            const res = await fetch(notifyUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            check(res.status === 204, `推一条过去，响应应当是 204，实际 ${res.status}`);
            const key = "remote:" + body.label + ":" + body.sessionId;
            for (let i = 0; i < 40 && !host.notice.shownKeys().includes(key); i++) { await sleep(100); }
            check(host.notice.shownKeys().includes(key), `${body.label} 那张卡片没弹出来，后面验不了`);
            return { key, memo: host.remoteNoticePages.get(key) };
        };

        const stdout = () => host.notice.child && host.notice.child.stdout;

        // ---- 一、新版本：只报端口 ----
        const one = await push({ label: "新版本那台", sessionId: "s-new", name: "会话 A", text: "跑完了", kind: "done", pagePort: homePort });
        check(one.memo && one.memo.pageUrl === `http://127.0.0.1:${homePort}`,
            `只报端口时，回话地址该是“连进来的地址 + 那个端口”（http://127.0.0.1:${homePort}），实际 ${one.memo && one.memo.pageUrl}`);
        if (stdout()) { stdout().push(Buffer.from("click\t" + one.key + "\n", "utf8")); }
        let asked;
        for (let i = 0; i < 60 && !asked; i++) {
            asked = got.find((o) => o.activate === true && o.sessionId === "s-new");
            if (!asked) { await sleep(100); }
        }
        check(!!asked, `点了卡片，那条“请那台切会话”没落到它身上（收到 ${JSON.stringify(got)}）`);
        if (asked) { check(asked.label === "公司这台", `带过去的标签是 ${JSON.stringify(asked.label)}，应当是这台的「公司这台」`); }
        console.log("  一、新版本只报端口：回话地址 " + (one.memo && one.memo.pageUrl) + "，请求落到了那台上");

        // ---- 二、旧版本：还带着一个连不通的地址，不许用它 ----
        const two = await push({
            label: "旧版本那台", sessionId: "s-old", name: "会话 B", text: "跑完了", kind: "done",
            pageUrl: `http://${UNREACHABLE}:${homePort}`, pagePort: homePort,
        });
        check(two.memo && !String(two.memo.pageUrl).includes(UNREACHABLE),
            `旧版本自报的那个地址（${UNREACHABLE}）不许拿来回话，实际存成了 ${two.memo && two.memo.pageUrl}`);
        check(two.memo && two.memo.pageUrl === `http://127.0.0.1:${homePort}`,
            `旧版本带了错地址时，也该按“连进来的地址 + 端口”算，实际 ${two.memo && two.memo.pageUrl}`);
        console.log("  二、旧版本带错地址：回话地址仍是 " + (two.memo && two.memo.pageUrl) + "（那个错的没被用）");

        // ---- 三、更老的版本：只带 pageUrl、没有端口 —— 只能回退，且失败会写日志 ----
        const three = await push({ label: "更老那台", sessionId: "s-oldest", name: "会话 C", text: "跑完了", kind: "done", pageUrl: `http://${UNREACHABLE}:9` });
        check(three.memo && three.memo.pageUrl === `http://${UNREACHABLE}:9`,
            `没报端口时只能回退用它自报的地址，实际 ${three.memo && three.memo.pageUrl}`);
        console.log("  三、更老的版本（没报端口）：只能回退用它自报的地址（发不出去，但那是旧版本的账）");

        // 这边的页面不跟着切（那些会话都不在这台）
        check(host.clientSessions.get(pageId) === sessionId, "点了别台推来的卡片，这边的页面竟然自己切走了");

        if (problems.length) {
            console.log("");
            console.log(`有问题（${problems.length} 条）：`);
            for (const p of problems) { console.log("  ! " + p); }
            throw new Error(`别台推来的卡片回话地址没对上：${problems.length} 条`);
        }
        console.log("");
        console.log("点别台推来的卡片：回话地址按“这条请求从哪儿进来的 + 那台报的端口”算，那台自报的地址一个都不信；只报端口的、带错地址的、老到没端口的三种都验过了。");
    } finally {
        if (fakeHome) { try { fakeHome.close(); } catch { /* 已经关了 */ } }
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

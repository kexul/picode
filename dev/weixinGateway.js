// @ts-nocheck
/**
 * 验「一台机器收发微信，别的机器的事由它代发」（假模型 + 假 iLink 服务）。
 *
 *   npm run web:shot -- --fake-pi --script dev/weixinGateway.js
 *
 * 这一遍把一条机器之间的路走完（都在同一个进程里，用自己这台当“另一台”）：
 *   ① 本机跑一轮 → 推一条到微信（同时记下了这个会话的标识与会话文件）；
 *   ② 假装“另一台机器”往 /notify 推一条（带它的回话地址）→ 网关把它也发到微信，
 *      正文前面带「哪台 · 」；
 *   ③ 微信里引用②那条回一句 → 网关认出来这是替别人发的 → 把这句话 POST 回那台的
 *      /weixinReply（这里那台就是自己）→ 接进那个会话 → 跑完再推一条回微信；
 *   ④ 顺手验两种拒绝：会话标识不对、会话文件对不上（都得回 409 而且带一句人话）。
 *
 * 走的是假服务，不会真发到微信；真登录态跑完会放回去。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
// 摘要上限跟服务端那份走（从编好的读，别两处各写一个数）
const { REMOTE_TEXT_CHARS } = require("../out/server/remoteNotice.js");

const WEIXIN_DIR = path.join(__dirname, ".scratch", "pichat", "weixin");
const ACCOUNT_FILE = path.join(WEIXIN_DIR, "account.json");
const SENT_FILE = path.join(WEIXIN_DIR, "sent.json");
const CURSOR_FILE = path.join(WEIXIN_DIR, "cursor.json");

const OWNER = "user@fake-9";
/** 假的“另一台机器”叫什么。 */
const OTHER_LABEL = "家里那台";
/** ② 里那条长摘要塞了多少段（验长度够不够用，见下文）。 */
const LONG_PIECES = 50;
const CONFIG_FILE = path.join(__dirname, ".scratch", "pichat", "config.json");

let pushed = 0;

function startFakeIlink() {
    const sent = [];
    const inbox = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            if (url.pathname.endsWith("/ilink/bot/sendmessage")) {
                let parsed = {};
                try { parsed = JSON.parse(body); } catch { /* 当空消息 */ }
                pushed++;
                const messageId = String(7521950497986457000 + pushed);
                sent.push({ messageId, body: parsed });
                res.end(`{"message_id":${messageId}}`);
                return;
            }
            if (url.pathname.endsWith("/ilink/bot/getupdates")) {
                const give = () => {
                    const msgs = inbox.splice(0, inbox.length);
                    res.end(JSON.stringify({ ret: 0, msgs, get_updates_buf: `cursor-${Date.now()}-${msgs.length}` }));
                };
                if (inbox.length) { give(); } else { setTimeout(give, 800); }
                return;
            }
            res.statusCode = 404;
            res.end("{}");
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve({ server, sent, inbox, port: server.address().port }));
    });
}

function incoming(text, ref) {
    return {
        message_id: String(Date.now()),
        message_type: 1,
        from_user_id: OWNER,
        item_list: [{
            type: 1,
            text_item: { text },
            ...(ref ? { ref_msg: { svr_id: ref, title: "（引用了一条推送）" } } : {}),
        }],
    };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitPushed(fake, n, label) {
    for (let i = 0; i < 200; i++) {
        if (fake.sent.length >= n) { return fake.sent[n - 1]; }
        await sleep(100);
    }
    throw new Error(`等不到第 ${n} 条（${label}），现在只有 ${fake.sent.length} 条`);
}

function textOf(entry) {
    return entry?.body?.msg?.item_list?.[0]?.text_item?.text || "";
}

/** POST 一下那台（就是自己）的 /weixinReply，看它接不接。 */
async function postReply(base, payload) {
    const res = await fetch(`${base}/weixinReply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    return { status: res.status, text: (await res.text()).trim() };
}

/** 设置里那颗「弹窗通知」（跨机器推送跟着它走）。 */
const NOTIFY_ROW = `Array.from(document.querySelectorAll("#viewOptsRoot .vo-item"))
    .find((r) => (r.querySelector(".vo-label") || {}).textContent === "弹窗通知")`;

/** 打开设置浮层（宽窗里那一列常驻着；窄窗先点开右上角那颗菜单）。 */
async function openSettings(page) {
    for (let i = 0; i < 3; i++) {
        if (await page.eval('return !!document.querySelector(".pk-footer-settings");')) { break; }
        await page.click("#browserMenuBtn");
        await sleep(400);
    }
    await page.click(".pk-footer-settings");
    await sleep(500);
}

/** 保证「弹窗通知」开着（跨机器推送那道门）；返回原来是不是开着的。 */
async function ensureNotifyOn(page) {
    await openSettings(page);
    const wasOn = await page.eval(`const hit = ${NOTIFY_ROW};
return hit ? !!hit.querySelector(".vo-check.on") : null;`);
    if (wasOn === null) { throw new Error("设置里没找到「弹窗通知」那一行"); }
    if (!wasOn) {
        await page.eval(`const hit = ${NOTIFY_ROW}; hit.click(); return true;`);
        await sleep(500);
    }
    await page.click("#settingsOverlay");
    await sleep(300);
    return wasOn;
}

/**
 * 把设置里的「消息推送」指向一个本地收件口，跑一轮，看它推过来的那条。
 * 跑完把设置文件放回原样。
 */
async function watchNotify(page) {
    const configBefore = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, "utf8") : undefined;
    const received = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            received.push(body);
            res.writeHead(204, { "Cache-Control": "no-store" });
            res.end();
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const notifyWasOn = await ensureNotifyOn(page);
    try {
        let config = {};
        try { config = JSON.parse(configBefore || "{}"); } catch { config = {}; }
        config.notify = { ...(config.notify || {}), pushTo: [`http://127.0.0.1:${port}`], pushLabel: OTHER_LABEL };
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");

        await page.send("再说一句");
        for (let i = 0; i < 200; i++) {
            if (received.length) { break; }
            await sleep(100);
        }
        if (!received.length) { throw new Error("跑完一轮了，网关那边没收到推送"); }
        return JSON.parse(received[received.length - 1]);
    } finally {
        server.close();
        try {
            if (configBefore === undefined) { fs.rmSync(CONFIG_FILE, { force: true }); }
            else { fs.writeFileSync(CONFIG_FILE, configBefore, "utf8"); }
        } catch { /* 放不回去也别盖住真错误 */ }
        if (!notifyWasOn) {
            try {
                await openSettings(page);
                await page.eval(`const hit = ${NOTIFY_ROW}; if (hit) { hit.click(); } return true;`);
                await sleep(400);
                await page.click("#settingsOverlay");
            } catch { /* 点不回去就算了 */ }
        }
    }
}

module.exports = async (page) => {
    fs.mkdirSync(WEIXIN_DIR, { recursive: true });
    const realAccount = fs.existsSync(ACCOUNT_FILE) ? fs.readFileSync(ACCOUNT_FILE, "utf8") : undefined;
    try { fs.rmSync(SENT_FILE, { force: true }); } catch { /* 没有就算了 */ }
    try { fs.rmSync(CURSOR_FILE, { force: true }); } catch { /* 没有就算了 */ }

    const fake = await startFakeIlink();
    console.log(`  · 假 iLink 服务：http://127.0.0.1:${fake.port}`);
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify({
        botToken: "FAKE-BOT-TOKEN-1234",
        accountId: "bot@fake-5678",
        baseUrl: `http://127.0.0.1:${fake.port}`,
        userId: OWNER,
        savedAt: Date.now(),
    }, null, 2), "utf8");

    try {
        const base = await page.eval("return location.origin");

        // ① 本机跑一轮：拿到这个会话的标识与会话文件（真机器之间推的就是这两样）
        await page.send("随便说点什么");
        const first = await waitPushed(fake, 1, "本机跑完的推送");
        let record = undefined;
        for (let i = 0; i < 50; i++) {
            const all = JSON.parse(fs.readFileSync(SENT_FILE, "utf8"));
            record = all[first.messageId];
            if (record) { break; }
            await sleep(100);
        }
        if (!record) { throw new Error("本机那条推送没记进 sent.json"); }
        console.log(`  · ① 本机会话：${record.name}（${record.panelId}）`);

        // ② 假装另一台机器推一条过来（回话地址写自己，这样转回来能验到）
        //    摘要故意写长（超过老上限 200）：这台往微信推时不该只剩前半截
        const longText = `另一台机器上那个会话跑完了：${"很长的说明，".repeat(LONG_PIECES)}`;
        const notify = {
            label: OTHER_LABEL,
            sessionId: record.panelId,
            sessionFile: record.sessionFile,
            name: record.name,
            text: longText,
            kind: "done",
            pageUrl: base,
        };
        const res = await fetch(`${base}/notify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(notify),
        });
        if (res.status !== 204) { throw new Error(`/notify 回了 ${res.status}`); }
        const second = await waitPushed(fake, 2, "替别的机器推的那条");
        const secondText = textOf(second);
        console.log("  · ② 替别的机器推出去：", secondText);
        if (!secondText.startsWith(`${OTHER_LABEL} · `)) { throw new Error(`正文该以「${OTHER_LABEL} · 」开头：${secondText}`); }
        if (!secondText.includes("另一台机器上那个会话跑完了")) { throw new Error("那条的摘要没带上"); }
        // 推过来那段的长度得原样留着（readRemoteNotice 那头不该再掐到 200）
        const kept = (secondText.split("很长的说明").length - 1);
        console.log(`  · ② 摘要留了多少：${kept} 段（推过来的上限 ${REMOTE_TEXT_CHARS} 字）`);
        if (longText.length <= REMOTE_TEXT_CHARS && kept !== LONG_PIECES) {
            throw new Error(`替别人推的那条只剩 ${kept} 段（该是 ${LONG_PIECES}）：/notify 那头还把摘要掐在 200`);
        }

        // ③ 微信里引用②那条回一句：该转回“那台”（就是自己）并接进会话
        fake.inbox.push(incoming("引用那条：只回复两个字：收到", second.messageId));
        await page.waitText("引用那条");
        console.log("  · ③ 引用回复转回来，落进会话了（页面上看到这句话）");
        await waitPushed(fake, 3, "转进来那句跑完的推送");

        // ④ 两种拒绝：会话标识对不上、会话文件对不上
        const bogusId = await postReply(base, { sessionId: "server:panel-nope", text: "喂" });
        console.log("  · ④ 会话标识不对：", bogusId.status, bogusId.text);
        if (bogusId.status !== 409) { throw new Error("会话标识不对该回 409"); }
        const bogusFile = await postReply(base, { sessionId: record.panelId, sessionFile: "D:/nope/别的会话.jsonl", text: "喂" });
        console.log("  · ④ 会话文件对不上：", bogusFile.status, bogusFile.text);
        if (bogusFile.status !== 409) { throw new Error("会话文件对不上该回 409"); }
        // 带对的会话文件就该接（只验状态，不再跑一轮）
        const good = await postReply(base, { sessionId: record.panelId, sessionFile: record.sessionFile, text: "这一句也该接进去" });
        await page.waitText("这一句也该接进去");
        console.log("  · ④ 对得上就接：", good.status);
        if (good.status !== 204) { throw new Error(`该回 204，实际 ${good.status}`); }

        // ⑤ 反方向：这台当“干活的那台”，设置里把「消息推送」指向网关，跑完一轮该把
        //    「哪台 · 哪个会话 · 摘要 · 回话地址 · 会话文件」推过去
        const got = await watchNotify(page);
        console.log("  · ⑤ 推给网关的通知：", JSON.stringify(got));
        if (!got.pageUrl) { throw new Error("推进去的通知里没有回话地址（网关就没法把话送回来）"); }
        if (!got.sessionFile) { throw new Error("推进去的通知里没有会话文件"); }
        if (!got.sessionId || !got.name) { throw new Error("推进去的通知缺会话标识或名字"); }
        // 推出去的那段摘要也放宽了（FAKEPI_REPLY_LONG 把假模型的收尾那句撑长时看得到）
        const long = Number(process.env.FAKEPI_REPLY_LONG || 0);
        if (long > REMOTE_TEXT_CHARS) {
            const pushedText = String(got.text || "");
            console.log(`  · ⑤ 推过去的摘要长度：${pushedText.length} 字`);
            if (pushedText.length <= 200) {
                throw new Error(`推过去的摘要只有 ${pushedText.length} 字：还是原来那个短上限`);
            }
        }
    } finally {
        fake.server.close();
        if (realAccount === undefined) { try { fs.rmSync(ACCOUNT_FILE, { force: true }); } catch { /* 算了 */ } }
        else { fs.writeFileSync(ACCOUNT_FILE, realAccount, "utf8"); }
    }
};

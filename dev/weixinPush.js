// @ts-nocheck
/**
 * 验「会话跑完一轮就往微信里推一条」（假模型 + 假 iLink 服务）。
 *
 *   npm run web:shot -- --fake-pi --script dev/weixinPush.js
 *
 * 验长回复（全文分块）：回复超过一条微信消息的长度（`FAKEPI_REPLY_LONG` 把假模型那段撑长），
 * 该切成几条发（每条不超过 `WEIXIN_CHUNK_CHARS`），拼起来不少一个字：
 *   FAKEPI_REPLY_LONG=9000 npm run web:shot -- --fake-pi --script dev/weixinPush.js
 *
 * 做法：把登录态临时换成一份假的（baseUrl 指到本地那个假服务，userId 是个假号），
 * 跑一轮假模型的对话，看那头收到的几条消息长什么样（头一条：会话名 + 空行 + 回复原文，
 * markdown 原样）、`weixin/sent.json` 里有没有把每条都记下“这是为了哪个会话发的”
 * （以后微信里引用回复要靠它认会话，引用哪一块都认）。
 * 跑完把原来的登录态放回去（你扫出来的真令牌别被我这一遍弄没了）。
 *
 * 不发到真微信：这一遍走的是假服务。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");

const WEIXIN_DIR = path.join(__dirname, ".scratch", "pichat", "weixin");
const ACCOUNT_FILE = path.join(WEIXIN_DIR, "account.json");
const SENT_FILE = path.join(WEIXIN_DIR, "sent.json");

/** 假 iLink 服务：只认发消息那一个地址，收到就记下来。 */
function startFakeIlink() {
    const sent = [];
    let seq = 0;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            if (url.pathname.endsWith("/ilink/bot/sendmessage")) {
                let parsed = {};
                try { parsed = JSON.parse(body); } catch { /* 下面会当空消息 */ }
                // 每条给不同的编号，且故意超过 2^53：后端得原样当字符串收下，分块时每块也都得记下
                seq += 1;
                const messageId = String(7521950497986457864n + BigInt(seq));
                sent.push({ messageId, body: parsed });
                res.end(`{"message_id":${messageId}}`);
                return;
            }
            res.statusCode = 404;
            res.end("{}");
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve({ server, sent, port: server.address().port }));
    });
}

/**
 * 真发到微信（不发假服务）：
 *   PICHAT_WEIXIN_REAL=1 npm run web:shot -- --fake-pi --script dev/weixinPush.js
 * 用的是 `weixin/account.json` 里那份真令牌（就是你扫出来的那个），所以手机上会真收到一条。
 */
const REAL = process.env.PICHAT_WEIXIN_REAL === "1";

/**
 * 这一轮回复的原文：从假 pi 落的会话文件里把最后一条 assistant 的 text 拼起来
 * （跟后端 `get_last_assistant_text` 拿到的是同一份；页面上的 `.md` 块只是它的一部分）。
 */
function lastAssistantText(startedAt) {
    const dir = path.join(__dirname, ".scratch");
    const files = fs.readdirSync(dir)
        .filter((name) => /^fake-session-.*\.jsonl$/.test(name))
        .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
        .filter((entry) => entry.mtime >= startedAt - 1000)
        .sort((a, b) => b.mtime - a.mtime);
    for (const { name } of files) {
        const lines = fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            let rec = null;
            try { rec = JSON.parse(lines[i]); } catch { continue; }
            if (rec?.type !== "message" || rec.message?.role !== "assistant") { continue; }
            const parts = Array.isArray(rec.message.content) ? rec.message.content : [];
            const text = parts.filter((c) => c && c.type === "text" && typeof c.text === "string")
                .map((c) => c.text).join("").trim();
            if (text) { return text; }
        }
    }
    return "";
}

module.exports = async (page) => {
    const startedAt = Date.now();
    fs.mkdirSync(WEIXIN_DIR, { recursive: true });
    // 原来的登录态（可能是你真扫出来的那份）先收好，跑完放回去
    const before = fs.existsSync(ACCOUNT_FILE) ? fs.readFileSync(ACCOUNT_FILE, "utf8") : undefined;
    try { fs.rmSync(SENT_FILE, { force: true }); } catch { /* 没有就算了 */ }


    let fake = undefined;
    if (REAL) {
        console.log("  · 走真微信（用 weixin/account.json 里那份登录态）");
        if (!fs.existsSync(ACCOUNT_FILE)) { throw new Error(`没有登录态：${ACCOUNT_FILE}`); }
    } else {
        fake = await startFakeIlink();
        console.log(`  · 假 iLink 服务：http://127.0.0.1:${fake.port}`);
        fs.writeFileSync(ACCOUNT_FILE, JSON.stringify({
            botToken: "FAKE-BOT-TOKEN-1234",
            accountId: "bot@fake-5678",
            baseUrl: `http://127.0.0.1:${fake.port}`,
            userId: "user@fake-9",
            savedAt: Date.now(),
        }, null, 2), "utf8");
    }

    try {
        // 跑一轮：用假模型，秒回
        await page.send("随便说点什么");
        await page.waitAnswer();

        if (REAL) {
            // 真发：这边收不到，去手机上看；只把"推了一条"那行日志留下来
            await page.sleep(3000);
            await page.shot("weixin-real-push.png");
            console.log("  · 已经真发出去了：看看手机上有没有那一条。");
            return;
        }

        // 等那条推送到达假服务
        // 先等页面上的流吐完（长度不再变），再拿原文来对
        let lastLen = -1;
        for (let i = 0; i < 100; i++) {
            const len = (await page.answerText()).length;
            if (len === lastLen) { break; }
            lastLen = len;
            await page.sleep(300);
        }
        // 等这一轮的推送全部到达假服务：回复长的时候会分好几条，条数不再长就算齐了
        const squash = (text) => String(text || "").replace(/\s+/g, "");
        const raw = lastAssistantText(startedAt);
        if (!raw) { throw new Error("从假会话文件里拿不到这一轮的回复原文"); }
        const textOf = (entry) => String(entry?.body?.msg?.item_list?.[0]?.text_item?.text || "");
        let seen = -1;
        let stable = 0;
        for (let i = 0; i < 300; i++) {
            if (fake.sent.length === seen) { stable += 1; } else { seen = fake.sent.length; stable = 0; }
            if (fake.sent.length > 0 && stable >= 6) { break; }
            await page.sleep(100);
        }
        if (!fake.sent.length) { throw new Error("跑完一轮了，但微信那头什么也没收到"); }

        const texts = fake.sent.map(textOf);
        const { WEIXIN_CHUNK_CHARS } = require("../out/server/weixinPush.js");
        const to = fake.sent[0].body?.msg?.to_user_id;
        console.log("  · 发给了：", to, "；一共", texts.length, "条");
        for (const [i, text] of texts.entries()) {
            console.log(`  · 第 ${i + 1} 条（${text.length} 字）：`);
            for (const line of String(text).split("\n").slice(0, 6)) { console.log("      " + line); }
            if (String(text).split("\n").length > 6) { console.log("      …"); }
        }

        for (const entry of fake.sent) {
            if (entry.body?.msg?.to_user_id !== "user@fake-9") { throw new Error(`发给谁不对：${entry.body?.msg?.to_user_id}`); }
            if (entry.body?.msg?.message_type !== 2) { throw new Error("message_type 该是 2（机器人发的）"); }
        }
        if (to !== "user@fake-9") { throw new Error(`发给谁不对：${to}`); }
        for (const text of texts) {
            if (text.length > WEIXIN_CHUNK_CHARS) { throw new Error(`有一条 ${text.length} 字，超过单条上限 ${WEIXIN_CHUNK_CHARS}`); }
            if (String(text).includes("跑完了一轮") || /https?:\/\//.test(text)) {
                throw new Error(`正文里不该有“跑完了一轮”或地址：${text.slice(0, 200)}`);
            }
        }

        // 记下“这些是为了哪个会话发的”了没有：每一条都得记（引用哪一块都要能认出来）
        if (!fs.existsSync(SENT_FILE)) { throw new Error("sent.json 没写出来（引用回复以后认不出会话）"); }
        const sent = JSON.parse(fs.readFileSync(SENT_FILE, "utf8"));
        const records = Object.values(sent);
        const name = String(records[0]?.name || "会话");
        if (records.length !== texts.length) {
            throw new Error(`发了 ${texts.length} 条，sent.json 里只有 ${records.length} 条记录`);
        }
        for (const entry of fake.sent) {
            if (!sent[entry.messageId]) { throw new Error(`sent.json 里没有这一条的编号：${entry.messageId}`); }
        }
        if (new Set(records.map((r) => r.panelId)).size !== 1) { throw new Error("几条记录指的不是同一个会话"); }
        console.log("  · 记下了", records.length, "条，都是：", records[0].name);

        // 头一条：会话名 + 空行 + 回复原文；后面的接着往下，拼起来不少一个字（markdown 原样，不截）
        if (!texts[0].startsWith(`${name}\n\n`)) {
            throw new Error(`头一条该是“会话名”空一行接正文，实际是：${texts[0].slice(0, 80)}`);
        }
        const body = [texts[0].slice(name.length + 2), ...texts.slice(1)].join("");
        if (squash(body) !== squash(raw)) {
            throw new Error(`微信里收到的正文跟回复原文对不上：收到 ${squash(body).length} 字，原文 ${squash(raw).length} 字`);
        }
        const long = Number(process.env.FAKEPI_REPLY_LONG || 0);
        if (long > WEIXIN_CHUNK_CHARS * 2 && texts.length < 2) {
            throw new Error(`回复 ${raw.length} 字，该分成几条发，实际只有 1 条`);
        }
        if (long <= WEIXIN_CHUNK_CHARS && texts.length !== 1) {
            throw new Error(`回复只有 ${raw.length} 字，不该分块，实际发了 ${texts.length} 条`);
        }
    } finally {
        if (fake) { fake.server.close(); }
        // 先把登录态放回去（那是你自己的令牌，比开关要紧），再管开关
        if (before === undefined) { try { fs.rmSync(ACCOUNT_FILE, { force: true }); } catch { /* 算了 */ } }
        else { fs.writeFileSync(ACCOUNT_FILE, before, "utf8"); }
    }
};

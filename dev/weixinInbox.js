// @ts-nocheck
/**
 * 验「微信里回一句，落进对的会话」（假模型 + 假 iLink 服务）。
 *
 *   npm run web:shot -- --fake-pi --script dev/weixinInbox.js
 *
 * 这一遍把几件事一次走完：
 *   ⓪ 人先在微信里说一句（先拿到回信凭据）→ 后端回一句“怎么用”（那句也带凭据）；
 *   ① 跑一轮 → 后端往微信推一条（记下这一个是哪个会话）；
 *   ② 微信里**引用那条**回一句 → 同一句话落到那个会话里，像人在输入框里敲的一样；
 *   ③ 不引用直接回一句 → 落到最近一次推过的那个会话；
 *   另外顺手验一下：别人（不是绑这个机器人的那个微信号）发来的不理。
 *
 * 假服务照真服务那条规矩：`sendmessage` 不带（或带错）回信凭据就回 `ret=-2 prepare failed`，
 * 所以这一遍能验出“凭据有没有存下来、发的时候有没有带上”。
 *
 * 走的是假服务，不会真发到微信；真登录态跑完会放回去。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");

const WEIXIN_DIR = path.join(__dirname, ".scratch", "pichat", "weixin");
const ACCOUNT_FILE = path.join(WEIXIN_DIR, "account.json");
const SENT_FILE = path.join(WEIXIN_DIR, "sent.json");
const CURSOR_FILE = path.join(WEIXIN_DIR, "cursor.json");
const CONTEXT_FILE = path.join(WEIXIN_DIR, "context.json");

const OWNER = "user@fake-9";
const STRANGER = "user@stranger-1";
/** 后端推出去的那几条在这里排着一张服务端编号；引用回复就引用它们的编号。 */
let pushed = 0;
/** 发出去过的回信凭据（假服务只认这几个，跟真的那样：不带或带旧的都回 ret=-2）。 */
const validTokens = new Set();

/** 假 iLink 服务：收发两条路都在这里。 */
function startFakeIlink() {
    const sent = [];            // 后端发出去的（推送 + 回话）
    const inbox = [];           // 排着等后端来收的（我们替"微信里的人"塞进去的）
    const stats = { updates: 0 };   // 后端来收了几次（用来看它是不是已经改盯这个假服务了）
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            if (url.pathname.endsWith("/ilink/bot/sendmessage")) {
                let parsed = {};
                try { parsed = JSON.parse(body); } catch { /* 当空消息 */ }
                // 跟真服务一条规矩：没带着最近那份回信凭据就不收
                if (!validTokens.has(parsed?.msg?.context_token)) {
                    res.end("{\"ret\":-2,\"errmsg\":\"prepare failed\"}");
                    return;
                }
                pushed++;
                const messageId = String(7521950497986457000 + pushed);
                sent.push({ messageId, body: parsed });
                res.end(`{"message_id":${messageId}}`);
                return;
            }
            if (url.pathname.endsWith("/ilink/bot/getupdates")) {
                stats.updates++;
                // 有就立刻给，没有就压一会儿给空的（像真的长轮询）
                const give = () => {
                    const msgs = inbox.splice(0, inbox.length);
                    res.end(JSON.stringify({
                        ret: 0,
                        msgs,
                        get_updates_buf: `cursor-${Date.now()}-${msgs.length}`,
                    }));
                };
                if (inbox.length) { give(); } else { setTimeout(give, 800); }
                return;
            }
            res.statusCode = 404;
            res.end("{}");
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve({ server, sent, inbox, stats, port: server.address().port }));
    });
}

/** 把一条"微信里发来的消息"塞进收件箱（每条来信都带一份新的回信凭据，像真的那样）。 */
function incoming(text, opts = {}) {
    const token = `ctx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    validTokens.add(token);
    return {
        message_id: String(Date.now()),
        message_type: 1,
        from_user_id: opts.from || OWNER,
        context_token: token,
        item_list: [{
            type: 1,
            text_item: { text },
            ...(opts.ref ? { ref_msg: { svr_id: opts.ref, title: "（引用了一条推送）" } } : {}),
        }],
    };
}

/** 等到某个条件成立（没等到就报错）。 */
async function waitFor(check, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) { return; }
        await sleep(100);
    }
    throw new Error(`等不到：${label}`);
}

/** 等到「后端发出去的第 n 条」出现（n 从 1 数）。 */
async function waitPushed(fake, n, label) {
    for (let i = 0; i < 200; i++) {
        if (fake.sent.length >= n) { return fake.sent[n - 1]; }
        await sleep(100);
    }
    throw new Error(`等不到第 ${n} 条（${label}），现在只有 ${fake.sent.length} 条`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = async (page) => {
    fs.mkdirSync(WEIXIN_DIR, { recursive: true });
    const realAccount = fs.existsSync(ACCOUNT_FILE) ? fs.readFileSync(ACCOUNT_FILE, "utf8") : undefined;
    try { fs.rmSync(SENT_FILE, { force: true }); } catch { /* 没有就算了 */ }
    try { fs.rmSync(CURSOR_FILE, { force: true }); } catch { /* 没有就算了 */ }
    try { fs.rmSync(CONTEXT_FILE, { force: true }); } catch { /* 没有就算了 */ }

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
        // 这一跑可能接过上一跑留下的真登录态（比如刚跑过 weixinScan）：后端起来时先指着它。
        // 等它真的改盯这个假服务了再往下走，不然刚塞进去的那句话得排在一条长轮询后面
        await waitFor(() => fake.stats.updates > 0, "后端来假服务收消息", 45000);

        // ⓪ 人先在微信里说一句：这时还没推过任何东西，后端会回一句“怎么用”。
        // 这一句本身也得发出得去（凭据就是这条来信里带的那份）
        fake.inbox.push(incoming("在吗"));
        const hint = await waitPushed(fake, 1, "第一次收到消息时的回话");
        const hintText = hint.body?.msg?.item_list?.[0]?.text_item?.text || "";
        if (!hintText.includes("引用")) { throw new Error(`第一次收到消息该回一句“怎么用”，回的是：${hintText}`); }
        console.log("  · ⓪ 微信里先说一句，后端带着凭据回了一句怎么用");

        // ① 跑一轮：后端推一条到微信，记下这条编号
        await page.send("随便说点什么");
        const first = await waitPushed(fake, 2, "跑完一轮的推送");
        const firstText = first.body?.msg?.item_list?.[0]?.text_item?.text || "";
        console.log("  · ① 推送到了，正文第一行：", firstText.split("\n")[0]);

        // ② 引用那条回一句：该落进同一个会话
        fake.inbox.push(incoming("引用那条：只回复两个字：收到", { ref: first.messageId }));
        await page.waitText("引用那条");
        console.log("  · ② 引用回复落进会话了（页面上看到这句话）");
        const second = await waitPushed(fake, 3, "引用回复跑完的推送");
        const secondText = second.body?.msg?.item_list?.[0]?.text_item?.text || "";
        // 新样子：头一行是会话名，空一行，底下是回复原文（这里验形状；分块与全文在 weixinPush.js）
        if (!secondText.includes("\n\n") || secondText.split("\n\n")[1].trim().length === 0) {
            throw new Error(`引用回复跑完没推回来（该是会话名 + 空行 + 回复原文）：${secondText}`);
        }

        // ③ 不引用直接回一句：该落进最近那个会话
        fake.inbox.push(incoming("不引用也说一句：只回复两个字：好"));
        await page.waitText("不引用也说一句");
        console.log("  · ③ 不引用的也落进会话了");
        await waitPushed(fake, 4, "不引用那句跑完的推送");

        // ④ 别人发来的：不理（不跑、不推）
        const before = fake.sent.length;
        fake.inbox.push(incoming("我不是这个号的主人，随便指挥一下", { from: STRANGER }));
        await sleep(3000);
        if (fake.sent.length !== before) { throw new Error("别人发来的消息居然也被办了"); }
        console.log("  · ④ 别人的消息没理（条数没变）");

        // ⑤ 对账表里几条记录都指着同一个会话；凭据存到盘上了（重启后推送还用得上）
        const sent = JSON.parse(fs.readFileSync(SENT_FILE, "utf8"));
        const panels = new Set(Object.values(sent).map((r) => r.panelId));
        console.log("  · ⑤ 对账表：", JSON.stringify(Object.values(sent).map((r) => r.name), null, 0));
        if (panels.size !== 1) { throw new Error(`推送指的会话不是一个：${Array.from(panels).join(",")}`); }
        const context = JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf8"));
        if (context.accountId !== "bot@fake-5678" || !context.tokens?.[OWNER]) {
            throw new Error(`回信凭据没存下来：${JSON.stringify(context)}`);
        }
        console.log("  · ⑥ 回信凭据存到盘上了（这个号的）：", Object.keys(context.tokens).join(","));
    } finally {
        fake.server.close();
        if (realAccount === undefined) { try { fs.rmSync(ACCOUNT_FILE, { force: true }); } catch { /* 算了 */ } }
        else { fs.writeFileSync(ACCOUNT_FILE, realAccount, "utf8"); }
    }
};

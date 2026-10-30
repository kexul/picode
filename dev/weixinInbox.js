// @ts-nocheck
/**
 * 验「微信里回一句，落进对的会话」（假模型 + 假 iLink 服务）。
 *
 *   npm run web:shot -- --fake-pi --script dev/weixinInbox.js
 *
 * 这一遍把三件事一次走完：
 *   ① 跑一轮 → 后端往微信推一条（记下这一个是哪个会话）；
 *   ② 微信里**引用那条**回一句 → 同一句话落到那个会话里，像人在输入框里敲的一样；
 *   ③ 不引用直接回一句 → 落到最近一次推过的那个会话；
 *   另外顺手验一下：别人（不是绑这个机器人的那个微信号）发来的不理。
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

const OWNER = "user@fake-9";
const STRANGER = "user@stranger-1";
/** 后端推出去的那几条在这里排着一张服务端编号；引用回复就引用它们的编号。 */
let pushed = 0;

/** 假 iLink 服务：收发两条路都在这里。 */
function startFakeIlink() {
    const sent = [];            // 后端发出去的（推送 + 回话）
    const inbox = [];           // 排着等后端来收的（我们替"微信里的人"塞进去的）
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
        server.listen(0, "127.0.0.1", () => resolve({ server, sent, inbox, port: server.address().port }));
    });
}

/** 把一条"微信里发来的消息"塞进收件箱。 */
function incoming(text, opts = {}) {
    return {
        message_id: String(Date.now()),
        message_type: 1,
        from_user_id: opts.from || OWNER,
        item_list: [{
            type: 1,
            text_item: { text },
            ...(opts.ref ? { ref_msg: { svr_id: opts.ref, title: "（引用了一条推送）" } } : {}),
        }],
    };
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
        // ① 跑一轮：后端推一条到微信，记下这条编号
        await page.send("随便说点什么");
        const first = await waitPushed(fake, 1, "跑完一轮的推送");
        const firstText = first.body?.msg?.item_list?.[0]?.text_item?.text || "";
        console.log("  · ① 推送到了，正文第一行：", firstText.split("\n")[0]);

        // ② 引用那条回一句：该落进同一个会话
        fake.inbox.push(incoming("引用那条：只回复两个字：收到", { ref: first.messageId }));
        await page.waitText("引用那条");
        console.log("  · ② 引用回复落进会话了（页面上看到这句话）");
        const second = await waitPushed(fake, 2, "引用回复跑完的推送");
        const secondText = second.body?.msg?.item_list?.[0]?.text_item?.text || "";
        if (!/^[^：]+：/.test(secondText) || /[\r\n]/.test(secondText)) {
            throw new Error(`引用回复跑完没推回来（该是一行“会话名：摘要”）：${secondText}`);
        }

        // ③ 不引用直接回一句：该落进最近那个会话
        fake.inbox.push(incoming("不引用也说一句：只回复两个字：好"));
        await page.waitText("不引用也说一句");
        console.log("  · ③ 不引用的也落进会话了");
        await waitPushed(fake, 3, "不引用那句跑完的推送");

        // ④ 别人发来的：不理（不跑、不推）
        const before = fake.sent.length;
        fake.inbox.push(incoming("我不是这个号的主人，随便指挥一下", { from: STRANGER }));
        await sleep(3000);
        if (fake.sent.length !== before) { throw new Error("别人发来的消息居然也被办了"); }
        console.log("  · ④ 别人的消息没理（条数没变）");

        // ⑤ 对账表里两条记录都指着同一个会话
        const sent = JSON.parse(fs.readFileSync(SENT_FILE, "utf8"));
        const panels = new Set(Object.values(sent).map((r) => r.panelId));
        console.log("  · ⑤ 对账表：", JSON.stringify(Object.values(sent).map((r) => r.name), null, 0));
        if (panels.size !== 1) { throw new Error(`推送指的会话不是一个：${Array.from(panels).join(",")}`); }
    } finally {
        fake.server.close();
        if (realAccount === undefined) { try { fs.rmSync(ACCOUNT_FILE, { force: true }); } catch { /* 算了 */ } }
        else { fs.writeFileSync(ACCOUNT_FILE, realAccount, "utf8"); }
    }
};

// @ts-nocheck
/**
 * 验「会话跑完一轮就往微信里推一条」（假模型 + 假 iLink 服务）。
 *
 *   npm run web:shot -- --fake-pi --script dev/weixinPush.js
 *
 * 做法：把登录态临时换成一份假的（baseUrl 指到本地那个假服务，userId 是个假号），
 * 跑一轮假模型的对话，看那头收到的那条消息长什么样、`weixin/sent.json` 里有没有记下
 * "这条是为了哪个会话发的"（以后微信里引用回复要靠它认会话）。
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
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            if (url.pathname.endsWith("/ilink/bot/sendmessage")) {
                let parsed = {};
                try { parsed = JSON.parse(body); } catch { /* 下面会当空消息 */ }
                sent.push(parsed);
                // 编号故意给一个超过 2^53 的大数：后端得原样当字符串收下（不然引用回复认不出是哪条）
                res.end(`{"message_id":7521950497986457864}`);
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

/** 设置里那颗开关的字：微信这条推送跟着「弹窗通知」走（关掉提醒的人不该在微信里被吵）。 */
const NOTIFY_ROW = `Array.from(document.querySelectorAll("#viewOptsRoot .vo-item"))
    .find((r) => (r.querySelector(".vo-label") || {}).textContent === "弹窗通知")`;

/** 打开设置浮层（宽窗里那一列常驻着；窄窗要先点开右上角那颗菜单把抽屉拉出来）。 */
async function openSettings(page) {
    for (let i = 0; i < 3; i++) {
        if (await page.eval('return !!document.querySelector(".pk-footer-settings");')) { break; }
        await page.click("#browserMenuBtn");
        await page.sleep(400);
    }
    await page.click(".pk-footer-settings");
    await page.sleep(500);
}

/**
 * 保证「弹窗通知」是开着的（调试目录里可能被前几遍脚本关掉了）。
 * @returns 原来是开着的吗（跑完要按原样放回去）
 */
async function ensureNotifyOn(page) {
    await openSettings(page);
    const wasOn = await page.eval(`const hit = ${NOTIFY_ROW};
return hit ? !!hit.querySelector(".vo-check.on") : null;`);
    if (wasOn === null) { throw new Error("设置里没找到「弹窗通知」那一行"); }
    if (!wasOn) {
        await page.eval(`const hit = ${NOTIFY_ROW}; hit.click(); return true;`);
        await page.sleep(500);
    }
    // 收起浮层（点它身边那圈灰）与抽屉，回到看对话的样子
    await page.click("#settingsOverlay");
    await page.sleep(300);
    return wasOn;
}

/**
 * 真发到微信（不发假服务）：
 *   PICHAT_WEIXIN_REAL=1 npm run web:shot -- --fake-pi --script dev/weixinPush.js
 * 用的是 `weixin/account.json` 里那份真令牌（就是你扫出来的那个），所以手机上会真收到一条。
 */
const REAL = process.env.PICHAT_WEIXIN_REAL === "1";

module.exports = async (page) => {
    fs.mkdirSync(WEIXIN_DIR, { recursive: true });
    // 原来的登录态（可能是你真扫出来的那份）先收好，跑完放回去
    const before = fs.existsSync(ACCOUNT_FILE) ? fs.readFileSync(ACCOUNT_FILE, "utf8") : undefined;
    try { fs.rmSync(SENT_FILE, { force: true }); } catch { /* 没有就算了 */ }

    const notifyWasOn = await ensureNotifyOn(page);

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
        let note = null;
        for (let i = 0; i < 100; i++) {
            if (fake.sent.length > 0) { note = fake.sent[fake.sent.length - 1]; break; }
            await page.sleep(100);
        }
        if (!note) { throw new Error("跑完一轮了，但微信那头什么也没收到"); }

        const to = note.msg && note.msg.to_user_id;
        const text = note.msg && note.msg.item_list && note.msg.item_list[0] && note.msg.item_list[0].text_item
            ? note.msg.item_list[0].text_item.text : "";
        console.log("  · 发给了：", to);
        console.log("  · 正文：");
        for (const line of String(text).split("\n")) { console.log("      " + line); }

        if (to !== "user@fake-9") { throw new Error(`发给谁不对：${to}`); }
        if (note.msg.message_type !== 2) { throw new Error("message_type 该是 2（机器人发的）"); }
        if (!String(text).includes("跑完了一轮")) { throw new Error("正文里没写跑完了一轮"); }
        if (!/\?session=[^&\s]+/.test(String(text))) { throw new Error("正文里没有能点开那个会话的地址"); }

        // 记下"这条是为了哪个会话发的"了没有
        if (!fs.existsSync(SENT_FILE)) { throw new Error("sent.json 没写出来（引用回复以后认不出会话）"); }
        const sent = JSON.parse(fs.readFileSync(SENT_FILE, "utf8"));
        const key = "7521950497986457864";
        if (!sent[key]) { throw new Error(`sent.json 里没有那条的编号（现有：${Object.keys(sent).join(",")}）`); }
        console.log("  · 记下了：", JSON.stringify(sent[key]));
    } finally {
        if (fake) { fake.server.close(); }
        // 先把登录态放回去（那是你自己的令牌，比开关要紧），再管开关
        if (before === undefined) { try { fs.rmSync(ACCOUNT_FILE, { force: true }); } catch { /* 算了 */ } }
        else { fs.writeFileSync(ACCOUNT_FILE, before, "utf8"); }
        if (!notifyWasOn) {
            // 原来是关着的：点回去（调试目录里别人的偏好别被我改了）；点不动就算了，别盖住真错误
            try {
                await openSettings(page);
                await page.eval(`const hit = ${NOTIFY_ROW}; if (hit) { hit.click(); } return true;`);
                await page.sleep(400);
                await page.click("#settingsOverlay");
            } catch (err) {
                console.log(`  ！「弹窗通知」没点回去（${err && err.message ? err.message : err}），设置文件在 dev/.scratch/pichat/state.json`);
            }
        }
    }
};

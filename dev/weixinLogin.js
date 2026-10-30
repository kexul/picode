// @ts-nocheck
/**
 * 验「微信」那块扫码登录（设置浮层里）：假 iLink 服务 + 真界面 + 真后端。
 *
 *   npm run web:shot -- --script dev/weixinLogin.js
 *
 * 真微信那头在这里换成一个本地假服务（靠 PICHAT_WEIXIN_API 指过去，见 src/weixinIlink.ts）：
 * 取二维码 → 先回「还没人扫」→ 再回「扫了」→ 要一次手机上的数字 → 最后回「成了」并给一枚假令牌。
 * 因此这一遍验得到的是：二维码画出来了没有、状态字对不对、数字输入框会不会出来、
 * 令牌有没有落盘（dev/.scratch/pichat/weixin/account.json）、界面最后是不是「已登录」。
 * 真扫码那一步得拿真微信试（本机没有 ClawBot 账号）。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");

const ACCOUNT_FILE = path.join(__dirname, ".scratch", "pichat", "weixin", "account.json");

/** 假 iLink 服务：状态由剧本拨，请求一律记在 calls 里（验有没有按协议问）。 */
function startFakeIlink() {
    const calls = [];
    const state = { status: "wait", confirmed: false };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        calls.push(url.pathname);
        const reply = (body) => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(body));
        };
        if (url.pathname.endsWith("/ilink/bot/get_bot_qrcode")) {
            reply({ qrcode: "fake-qr-1", qrcode_img_content: "https://weixin.qq.com/x/FAKE-QR-FOR-TEST" });
            return;
        }
        if (url.pathname.endsWith("/ilink/bot/get_qrcode_status")) {
            // 装一下长轮询：压 150 毫秒再回（界面那边就有一点“等”的意思）
            setTimeout(() => {
                if (state.confirmed) {
                    reply({
                        status: "confirmed",
                        bot_token: "FAKE-BOT-TOKEN-1234",
                        ilink_bot_id: "bot@fake-5678",
                        ilink_user_id: "user@fake-9",
                        baseurl: "http://127.0.0.1:1/",
                    });
                    return;
                }
                reply({ status: state.status });
            }, 150);
            return;
        }
        res.statusCode = 404;
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({ server, calls, state, port: server.address().port });
        });
    });
}

/** 设置浮层里那块「微信」可能有半截在框外（这一份设置挺长的）：截图前把它滚出来。 */
const SCROLL_WX = `const el = document.querySelector('#viewOptsRoot .vo-item-weixin');
if (el) { el.scrollIntoView({ block: 'end' }); }
return true;`;

/** 设置浮层里那颗按钮（按字认：那块里按钮就那么几颗）。 */
const CLICK_WX_BUTTON = (text) => `const el = Array.from(document.querySelectorAll('#viewOptsRoot .vo-item-weixin .vo-btn')).find((b) => b.textContent === ${JSON.stringify(text)});
if (!el) { return false; }
el.click();
return true;`;

module.exports = async (page) => {
    // 这里会往调试目录里写一枚**假**令牌。你真扫出来的那份（真实登录态）先收好、跑完放回去，
    // 不然跑一遍这个脚本就把你自己的微信登录态盖掉了。
    const realAccount = fs.existsSync(ACCOUNT_FILE) ? fs.readFileSync(ACCOUNT_FILE, "utf8") : undefined;
    // 上一遍留下的令牌会让人一打开就是「已登录」，这一遍要看的是“从没登录开始”
    try { fs.rmSync(ACCOUNT_FILE, { force: true }); } catch { /* 没有就算了 */ }
    const fake = await startFakeIlink();
    // 后端是在这个进程里跑的（见 dev/harness.js）：登录那一刻现读这个变量，所以现在设也来得及
    process.env.PICHAT_WEIXIN_API = `http://127.0.0.1:${fake.port}`;
    console.log(`  · 假 iLink 服务：http://127.0.0.1:${fake.port}`);

    try {
        // 设置浮层里那块「微信」：还没登录时一颗「扫码登录」
        // （设置入口在「项目与会话」那边：宽窗里那一列本来就常驻着，窄窗先点开菜单）
        const docked = await page.eval('return document.body.classList.contains("dock-sidebar");');
        if (!docked) { await page.click("#browserMenuBtn"); }
        await page.sleep(500);
        await page.click(".pk-footer-settings");
        await page.sleep(500);
        await page.waitText("微信");
        console.log("  · 设置浮层打开了，看到「微信」那块");
        await page.eval(SCROLL_WX);
        await page.sleep(200);
        await page.shot("weixin-idle.png");

        // 点「扫码登录」：要码、画码。
        // 上一遍留下的令牌是后端进程刚起来时就读进去的（删文件删不掉它记着的那份），
        // 那种情况下这一块直接是「已登录」：先点「重新扫码」，走的是同一套流程。
        const started = (await page.eval(CLICK_WX_BUTTON("扫码登录")))
            || (await page.eval(CLICK_WX_BUTTON("重新扫码")));
        if (!started) { throw new Error("没找到「扫码登录」那颗按钮"); }
        // 等二维码画出来（canvas 有宽高即算画上了）
        let drawn = false;
        for (let i = 0; i < 60; i++) {
            drawn = await page.eval(`const c = document.querySelector('#viewOptsRoot .vo-wx-qr canvas');
return !!(c && c.width > 0 && c.height > 0);`);
            if (drawn) { break; }
            await page.sleep(100);
        }
        if (!drawn) { throw new Error("二维码没画出来"); }
        const box = await page.eval(`const c = document.querySelector('#viewOptsRoot .vo-wx-qr canvas');
const ctx = c.getContext('2d');
const data = ctx.getImageData(0, 0, c.width, c.height).data;
let dark = 0;
for (let i = 0; i < data.length; i += 4) { if (data[i] < 128) { dark++; } }
return { w: c.width, h: c.height, dark };`);
        console.log(`  · 二维码：${box.w}×${box.h}，黑格 ${box.dark} 点`);
        if (!box.dark) { throw new Error("二维码是空白的"); }
        await page.eval(SCROLL_WX);
        await page.sleep(200);
        await page.shot("weixin-qr.png");

        // 手机上扫了
        fake.state.status = "scaned";
        await page.waitText("在手机上点一下确认");
        console.log("  · 状态跟着变成「扫到了」");

        // 手机微信上出了个数字：界面要问
        fake.state.status = "need_verifycode";
        await page.waitText("显示的数字");
        console.log("  · 状态跟着变成「要输数字」");
        await page.eval(SCROLL_WX);
        await page.sleep(200);
        await page.shot("weixin-code.png");
        await page.eval(`const input = document.querySelector('#viewOptsRoot .vo-wx-code');
input.value = '4321';
Array.from(document.querySelectorAll('#viewOptsRoot .vo-item-weixin .vo-btn')).find((b) => b.textContent === '确定').click();
return true;`);

        // 服务器认了数字、人也确认了：给令牌
        fake.state.status = "confirmed";
        fake.state.confirmed = true;
        let done = false;
        for (let i = 0; i < 100; i++) {
            done = await page.eval(`return (document.getElementById('viewOptsRoot').innerText || '').includes('已登录');`);
            if (done) { break; }
            await page.sleep(100);
        }
        if (!done) { throw new Error("界面一直没变成「已登录」"); }
        console.log("  · 界面变成「已登录」");
        await page.eval(SCROLL_WX);
        await page.sleep(200);
        await page.shot("weixin-done.png");

        // 令牌落盘了没有（这是这一遍真正要看的：能不能拿到令牌）
        if (!fs.existsSync(ACCOUNT_FILE)) { throw new Error(`令牌没落盘：${ACCOUNT_FILE}`); }
        const account = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8"));
        console.log(`  · 令牌文件：${ACCOUNT_FILE}`);
        console.log(`    token=${account.botToken} accountId=${account.accountId} userId=${account.userId}`);
        if (account.botToken !== "FAKE-BOT-TOKEN-1234" || account.accountId !== "bot@fake-5678") {
            throw new Error("落盘的令牌不对");
        }

        // 都问对了没有：一张码、若干次状态
        const asked = fake.calls.filter((p) => p.endsWith("/get_bot_qrcode")).length;
        const polled = fake.calls.filter((p) => p.endsWith("/get_qrcode_status")).length;
        console.log(`  · 请求：要码 ${asked} 次、问状态 ${polled} 次`);
        if (asked !== 1 || polled < 2) { throw new Error("请求次数不对"); }
    } finally {
        fake.server.close();
        delete process.env.PICHAT_WEIXIN_API;
        // 把你那份真的登录态放回去（这一遍写进去的是假的）
        try {
            if (realAccount === undefined) { fs.rmSync(ACCOUNT_FILE, { force: true }); }
            else { fs.writeFileSync(ACCOUNT_FILE, realAccount, "utf8"); }
        } catch { /* 放不回去也别盖住真错误 */ }
    }
};

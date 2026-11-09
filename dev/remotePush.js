// @ts-nocheck
/**
 * 验「消息推送」这一路：设置文件里 notify.pushTo 填了别处的地址，跑完一轮就往那儿推一条。
 *
 *   npm run web:shot -- --fake-pi --notify-turn-end --script dev/remotePush.js
 *
 * 起一个本地收件口、把它写成 pushTo，发一句话等假 pi 回完，看收件口有没有收到那条；
 * 再敲一句，看推方有没有再推一条“收掉”（那边手上那张记的是推方的钥匙，只能靠这一条收）。
 * 跑完把设置文件放回原样。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, ".scratch", "pichat", "config.json");

module.exports = async (page) => {
    const got = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            try { got.push(JSON.parse(body)); } catch { got.push({}); }
            res.writeHead(204, { "Cache-Control": "no-store" });
            res.end();
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const before = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, "utf8") : undefined;
    try {
        let config = {};
        try { config = JSON.parse(before || "{}"); } catch { config = {}; }
        // 标签写成写下的那个，收到的通知里带的就是它
        config.label = "公司那台";
        config.notify = { ...(config.notify || {}), pushTo: [`http://127.0.0.1:${port}`] };
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");

        await page.send("你好");
        for (let i = 0; i < 300; i++) {
            if (got.length) { break; }
            await page.sleep(100);
        }
        if (!got.length) { throw new Error("跑完一轮了，推送地址那边一条也没收到"); }
        const notice = got[got.length - 1];
        console.log("  · 收到推送：" + JSON.stringify(notice));
        if (notice.label !== "公司那台") { throw new Error("推送里没带上这台的标签：" + notice.label); }
        if (!notice.sessionId || !notice.pageUrl) { throw new Error("推送缺 sessionId / pageUrl"); }

        // 那边再敲一句：推方该再推一条“收掉”过来。
        // 收到那台上的那张记的是“推方的标签 + 推方的会话号”，本机这些动作碰不到它
        // （见 chatHost 的 closeNotice、remoteNotice 的 pushRemoteClose）
        const asked = got.length;
        await page.send("再说一句");
        let recall;
        for (let i = 0; i < 100 && !recall; i++) {
            recall = got.slice(asked).find((one) => one.close === true);
            if (!recall) { await page.sleep(100); }
        }
        if (!recall) { throw new Error("那边又说话了，一条“收掉”也没推过来"); }
        console.log("  · 收到“收掉”：" + JSON.stringify(recall));
        // 收到那台照这两样拼钥匙：对不上就收不掉那张
        if (recall.label !== "公司那台" || recall.sessionId !== notice.sessionId) {
            throw new Error("“收掉”那条的标签 / 会话号对不上：" + JSON.stringify(recall));
        }
    } finally {
        server.close();
        try {
            if (before === undefined) { fs.rmSync(CONFIG_FILE, { force: true }); }
            else { fs.writeFileSync(CONFIG_FILE, before, "utf8"); }
        } catch { /* 放不回去也别盖住真错误 */ }
    }
};

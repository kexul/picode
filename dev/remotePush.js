// @ts-nocheck
/**
 * 验「远程机器」这一路：设置文件里 machines 填了别处的地址，跑完一轮就往那儿推一条。
 *
 *   npm run web:shot -- --fake-pi --notify-turn-end --script dev/remotePush.js
 *
 * （--notify-turn-end 不能少：默认关着提醒开关的话，跑完一轮既不弹本机、也不推。）
 *
 * 起一个本地收件口、把它写进 machines，发一句话等假 pi 回完，看收件口有没有收到那条。
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
        config.machines = [`http://127.0.0.1:${port}`];
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
    } finally {
        server.close();
        try {
            if (before === undefined) { fs.rmSync(CONFIG_FILE, { force: true }); }
            else { fs.writeFileSync(CONFIG_FILE, before, "utf8"); }
        } catch { /* 放不回去也别盖住真错误 */ }
    }
};

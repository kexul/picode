// @ts-nocheck
/**
 * autoNotify —— 验「自动模式开着的时候每轮跑完都不弹提醒」。
 *
 * 要验的两件事：
 *   1. 自动模式开着、一轮接一轮地跑，一条提醒都不发；
 *   2. 关掉开关以后再跑完一轮，提醒照常弹一张，正文还是主会话最后那条回复的开头。
 *
 * 提醒那头走「消息推送」：这里起一个本地收件口当 pushTo（同 dev/remotePush.js），
 * 看它一共收到几条、什么时候收到的。
 *
 *   npm run web:shot -- --fake-pi --notify-turn-end --script dev/autoNotify.js
 */
const fs = require("fs");
const http = require("http");
const path = require("path");

const SCRATCH = path.join(__dirname, ".scratch");
const CONFIG_FILE = path.join(process.env.PICHAT_HOME || path.join(SCRATCH, "pichat"), "config.json");

module.exports = async (page) => {
    try { fs.rmSync(path.join(process.env.PICHAT_HOME || path.join(SCRATCH, "pichat"), "auto.json"), { force: true }); } catch { /* 没有就算了 */ }

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

    const problems = [];
    const check = (what, ok, detail) => {
        if (!ok) { problems.push(what + (detail ? "：" + JSON.stringify(detail) : "")); }
        console.log((ok ? "✓ " : "✗ ") + what + (detail ? "  " + JSON.stringify(detail) : ""));
    };
    /** 那颗自动模式的小开关现在开着没有。 */
    const autoOn = () => page.eval(`
      const el = document.getElementById("autoBtn");
      return !!el && el.classList.contains("on");
    `);
    const userSays = () => page.eval(`
      return Array.from(document.querySelectorAll(".msg.user")).map((el) => el.textContent.trim());
    `);
    const lastReply = () => page.eval(`
      const list = Array.from(document.querySelectorAll(".msg.assistant"));
      return list.length ? list[list.length - 1].textContent.trim() : "";
    `);
    const until = async (fn, ms) => {
        const limit = Date.now() + (ms || 60000);
        let last = null;
        while (Date.now() < limit) {
            last = await fn();
            if (last && last.ok) { return last; }
            await page.sleep(200);
        }
        return last;
    };
    /** 主会话收到过几句「继续」= 自动模式自己跑了几轮。 */
    const continues = async () => (await userSays()).filter((t) => t === "继续").length;
    /** 收件口收到的“有事”那几条（同一台还会推“把卡片收掉”，那种没有 kind、也没正文）。 */
    const notes = () => got.filter((n) => n && n.kind);

    try {
        let config = {};
        try { config = JSON.parse(before || "{}"); } catch { config = {}; }
        config.notify = { ...(config.notify || {}), pushTo: [`http://127.0.0.1:${port}`] };
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");

        await page.waitReady();

        // ---- 开自动模式 ----
        await page.click("#autoBtn");
        await page.sleep(600);
        check("（前提）自动模式开了", await autoOn());

        await page.send("随便干点活，演示一下");

        // ---- 第 1、2 轮：一轮接一轮地跑，这会儿一条提醒都不该有 ----
        const first = await until(async () => {
            const n = await continues();
            return { ok: n >= 1, n };
        }, 30000);
        check("（前提）第 1 轮跑完：主会话收到一句「继续」", first && first.ok, first);
        check("自动模式开着跑完一轮：不弹提醒", notes().length === 0, notes().length);

        const second = await until(async () => {
            const n = await continues();
            return { ok: n >= 2, n };
        }, 30000);
        check("（前提）又跑完一轮：主会话又收到一句「继续」", second && second.ok, second);
        check("自动模式开着跑完两轮：还是不弹提醒，开关也还开着",
            notes().length === 0 && (await autoOn()), { pushes: notes().length, on: await autoOn() });
        await page.shot("auto-notify-quiet.png");

        // ---- 关掉开关，等手上那一轮跑完（它跑完会弹一张），从那儿重新数 ----
        await page.click("#autoBtn");
        await page.sleep(500);
        check("（前提）开关关掉了", !(await autoOn()));
        await page.sleep(4000);
        got.length = 0;   // 关开关时手上那一轮跑完弹的那张不算在这一段里

        // ---- 关着的时候再跑完一轮：这才弹一张 ----
        await page.send("收工了");
        const pushed = await until(async () => ({ ok: notes().length > 0 }), 30000);
        check("自动模式关着：跑完一轮弹了一张提醒", !!pushed && pushed.ok, notes().length);
        const notice = notes()[notes().length - 1] || {};
        check("只推了这一条", notes().length === 1, notes().map((n) => n.text && n.text.slice(0, 20)));
        check("这条是「跑完一轮」那种", notice.kind === "done", notice.kind);
        // 推送比界面快一步：等最后那条回复画出来再比
        await page.sleep(800);
        const reply = await lastReply();
        const opened = (reply || "").trim().split(/\r?\n/)[0].slice(0, 12);
        check("正文是主会话最后那条回复",
            !!opened && (notice.text || "").includes(opened),
            { notice: (notice.text || "").slice(0, 40), reply: reply.slice(0, 40) });
        await page.shot("auto-notify-done.png");

        if (problems.length) {
            throw new Error("自动模式的提醒有问题：\n- " + problems.join("\n- "));
        }
        console.log("自动模式的提醒全过。");
    } finally {
        server.close();
        try {
            if (before === undefined) { fs.rmSync(CONFIG_FILE, { force: true }); }
            else { fs.writeFileSync(CONFIG_FILE, before, "utf8"); }
        } catch { /* 放不回去也别盖住真错误 */ }
    }
};

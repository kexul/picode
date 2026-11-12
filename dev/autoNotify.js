// @ts-nocheck
/**
 * autoNotify —— 验「自动模式开着的时候，提醒只在判官说结束时弹，不是每轮跑完都弹」。
 *
 * 要验的两件事：
 *   1. 自动模式开着、判官还在说「继续」的这几轮跑完，一条提醒都不发；
 *   2. 判官说「结束」那一下弹一张，正文还是主会话最后那条回复的开头。
 *
 * 提醒那头走「消息推送」：这里起一个本地收件口当 pushTo（同 dev/remotePush.js），
 * 看它一共收到几条、什么时候收到的。假判官第 3 轮才说结束（FAKEPI_AUTO_STOP_ON=3），
 * 这样前两轮都是「判官说继续」，有地方可以先看一眼“这会儿一条都没推”。
 *
 *   npm run web:shot -- --fake-pi --notify-turn-end --script dev/autoNotify.js
 */
const fs = require("fs");
const http = require("http");
const path = require("path");

// 判官跑慢一点：不然一轮到下一轮太快，看不出“这几轮没推”
process.env.FAKEPI_JUDGE_MS = process.env.FAKEPI_JUDGE_MS || "1200";
process.env.FAKEPI_AUTO_STOP_ON = process.env.FAKEPI_AUTO_STOP_ON || "3";

const SCRATCH = path.join(__dirname, ".scratch");
const CONFIG_FILE = path.join(process.env.PICHAT_HOME || path.join(SCRATCH, "pichat"), "config.json");

module.exports = async (page) => {
    // 判官轮数记在会话目录里：上一次跑剩的会让这一跑从第二轮开始
    for (const name of [path.join(SCRATCH, ".judge-rounds"), path.join(SCRATCH, "pichat", "auto.json")]) {
        try { fs.rmSync(name, { force: true }); } catch { /* 没有就算了 */ }
    }

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
    /** 等某件事发生（最多等 ms 毫秒）。 */
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
    /** 攒着「继续」的条数（判官每说一次继续，主会话就多一条这个）。 */
    const continues = async () => {
        const said = await userSays();
        return said.filter((t) => t === "继续").length;
    };

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

        // ---- 第 1、2 轮：判官都还说「继续」，这会儿一条提醒都不该有 ----
        const first = await until(async () => {
            const n = await continues();
            return { ok: n >= 1, n };
        }, 90000);
        check("（前提）判官第 1 轮说继续：主会话收到一句「继续」", first && first.ok, first);
        check("第 1 轮跑完不弹提醒（判官还没说结束）", got.length === 0, got.length);

        const second = await until(async () => {
            const n = await continues();
            return { ok: n >= 2, n };
        }, 90000);
        check("（前提）判官第 2 轮说继续：主会话又收到一句「继续」", second && second.ok, second);
        check("第 2 轮跑完还是不弹提醒，开关也还开着",
            got.length === 0 && (await autoOn()), { pushes: got.length, on: await autoOn() });
        await page.shot("auto-notify-quiet.png");

        // ---- 第 3 轮：判官说「结束」→ 这时候才弹 ----
        const stopped = await until(async () => ({ ok: !(await autoOn()) }), 120000);
        check("判官第 3 轮说结束：开关自己关掉", !!stopped && stopped.ok, stopped);
        const pushed = await until(async () => ({ ok: got.length > 0 }), 15000);
        check("判官说结束：这才推了一条提醒出去", !!pushed && pushed.ok, got.length);
        const notice = got[got.length - 1] || {};
        check("只推了这一条（前面几轮跑完都没推）", got.length === 1, got.map((n) => n.text && n.text.slice(0, 20)));
        check("这条是「跑完一轮」那种", notice.kind === "done", notice.kind);
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

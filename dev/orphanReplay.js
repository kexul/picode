// @ts-nocheck
/**
 * orphanReplay —— 验「重放历史时，没有结果的工具调用不再画成还在转圈」。
 *
 * 会话历史里只有「调用」、没有「结果」的那种（那一轮跑到一半被中断 / pi 进程被杀掉），从前
 * 重放出来又是一颗转圈的标签，一直转。现在后端给这种调用带上 interrupted（见
 * src/sessionRuntime.ts 的 renderMessages），界面按「已结束」画，提示框里写一句中断
 * （见 media/chat.js 的 settleInterruptedTools）。
 *
 * 两步：
 *
 *   node dev/orphanReplay.js --make-fixture     # 造一份「有两个调用没有结果」的会话，打出环境变量
 *   PI_CODING_AGENT_SESSION_DIR=<它打出来的> \
 *     npm run web:shot -- --piPath pi --script dev/orphanReplay.js
 *
 * 为什么要单独指一个会话目录：这份会话是编出来的，不能混进真会话列表（`--piPath pi` 是为了让
 * 真 pi 去读那份文件——假 pi 报的是自己的剧本，不看文件）。
 * 图落在 dev/shots/。
 */
"use strict";

const fs = require("fs");
const path = require("path");

/** 编出来的会话放这儿：调试目录里，不进版本库。 */
const FIXTURE_ROOT = path.join(__dirname, ".scratch", "orphan-sessions");
/** 会话文件得落在按 cwd 编出来的那个目录名里（规则见 src/sessionStore.ts 的 encodeCwd）。 */
const FIXTURE_CWD = path.join(__dirname, ".scratch");

/** 造那份会话文件：一个用户消息 + 一条带两个工具调用、却没有结果的助手消息 + 后面的收尾。 */
function makeFixture() {
    const dir = path.join(FIXTURE_ROOT, "--" + FIXTURE_CWD.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-") + "--");
    fs.mkdirSync(dir, { recursive: true });
    const msg = (id, parentId, ts, message) => ({ type: "message", id, parentId, timestamp: ts, message });
    const lines = [
        { type: "session", version: 3, id: "11111111-2222-3333-4444-555555555555", timestamp: "2026-10-22T02:00:00.000Z", cwd: FIXTURE_CWD },
        { type: "model_change", id: "m1", parentId: null, timestamp: "2026-10-22T02:00:00.100Z", provider: "local", modelId: "deepseek-flash" },
        msg("u1", null, "2026-10-22T02:00:01.000Z", { role: "user", content: [{ type: "text", text: "commit & push" }], timestamp: 1792637600000 }),
        msg("a1", "u1", "2026-10-22T02:00:02.000Z", {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "先跑编译，再看一眼截图。" },
                { type: "toolCall", id: "call_bash_orphan", name: "bash", arguments: { command: "npm run compile" } },
                { type: "toolCall", id: "call_read_orphan", name: "read", arguments: { path: "dev/shots/linux-backend.png" } },
            ],
            provider: "local",
            model: "deepseek-flash",
        }),
        msg("u2", "a1", "2026-10-22T02:01:00.000Z", { role: "user", content: [{ type: "text", text: "刚才那条 read 还在转圈吧？" }], timestamp: 1792637660000 }),
        msg("a2", "u2", "2026-10-22T02:01:05.000Z", {
            role: "assistant",
            content: [{ type: "text", text: "那一轮被中断了，这两个调用没有结果。" }],
            provider: "local",
            model: "deepseek-flash",
        }),
    ];
    const file = path.join(dir, "2026-10-22T02-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl");
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    return { dir, file };
}

const PROBE = `
    const tags = Array.from(document.querySelectorAll(".tool"));
    const line = document.querySelector(".tool-running");
    return "标签：" + tags.map((t) => t.innerText).join("；")
        + " || 转圈的：" + document.querySelectorAll(".tool.running").length
        + " || 正在跑那行：" + (line ? JSON.stringify(line.innerText) : "（没有）");
`;

module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(800);
    // 默认开的是「新会话」：从侧边栏历史里点开那份造好的会话（标题是它的第一条用户消息）
    const opened = await page.eval(`
        const row = Array.from(document.querySelectorAll(".pk-item.pk-history"))
            .find((el) => el.innerText.includes("commit & push"));
        if (!row) { return false; }
        (row.querySelector(".pk-history-main") || row).click();
        return true;
    `);
    console.log("点开历史会话：" + opened);
    await page.sleep(3000);   // 等 pi 起来 + 历史重放画完
    console.log("重放完：" + await page.eval(PROBE));
    await page.shot("orphan-replay.png");

    // 鼠标停到那条 read 上：提示框里应该写着「这一轮被中断，没有结果」
    await page.eval(`
        const tag = Array.from(document.querySelectorAll(".tool")).find((e) => e.innerText.includes("read"));
        if (tag) { tag.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })); }
        return true;
    `);
    await page.sleep(500);
    console.log("提示框：" + await page.eval(`
        const tip = document.querySelector(".tag-tip");
        return tip && !tip.classList.contains("hidden") ? JSON.stringify(tip.innerText) : "（没弹出来）";
    `));
    await page.shot("orphan-replay-tip.png");
};

// 只造会话文件（npm run web:shot 是 require 这个文件，不会跑到这儿）
if (require.main === module) {
    const { file } = makeFixture();
    console.log("会话文件：" + file);
    console.log("用法：");
    console.log(`  PI_CODING_AGENT_SESSION_DIR="${FIXTURE_ROOT}" npm run web:shot -- --piPath pi --script dev/orphanReplay.js`);
}

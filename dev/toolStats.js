// @ts-nocheck
/**
 * toolStats —— 验「工具调用耗时」那张弹窗（项目与会话侧边栏底部「设置」旁边那颗「统计」）。
 *
 * 真让模型跑几个慢工具不好凑，所以这里直接往页面里投一批工具调用与结果
 * （跟后端推的是同一种消息，结果里带 durationMs），然后点那颗按钮看弹窗：
 *   · 空的时候先说一句「还没跑过工具调用」；
 *   · 跑过之后：上面一句汇总，中间按工具名一张表（次数 / 合计 / 平均 / 最长），
 *     下面是花得最久的几次调用（工具名 + 那次在干什么 + 耗时）；
 *   · 统计弹窗开着时又来一条结果，数跟着长；
 *   · 点外面 / 点右上角叉 / 按 Esc 都能收起来。
 *
 *   npm run web:shot -- --width 1200 --height 760 --script dev/toolStats.js
 * 图落在 dev/shots/。
 */

/** 投进去的调用：[工具名, 参数, 耗时毫秒]；["editCard", 工具名, 参数, 耗时] 是编辑卡片。 */
const ITEMS = [
    ["bash", { command: "npm test" }, 12500],
    ["bash", { command: "node scripts/compile.mjs" }, 64200],
    ["read", { path: "src/editTracker.ts" }, 180],
    ["grep", { pattern: "durationMs", path: "src" }, 3250],
    ["ls", { path: "src" }, 90],
    ["editCard", "edit", { path: "media/chat.css", oldText: "a", newText: "b" }, 2600],
    ["codemode", { code: "await tools.bash({ command: 'git status', timeout: 10 })" }, 8100],
];

/** 投一批消息：调用 + 结果（带耗时）。 */
function buildMessages(items, seq0) {
    const messages = [{ type: "assistantFull", text: "跑一批工具看看各花了多久：" }];
    let seq = seq0;
    for (const item of items) {
        const id = `t${++seq}`;
        if (item[0] === "editCard") {
            const [, toolName, args, durationMs] = item;
            messages.push({ type: "editCardStart", toolCallId: id, toolName, path: args.path, label: args.path, args });
            messages.push({ type: "editCardResult", toolCallId: id, canRevert: false, diff: "", durationMs });
        } else {
            const [toolName, args, durationMs] = item;
            messages.push({ type: "tool", toolName, args, toolCallId: id });
            messages.push({ type: "toolResult", toolCallId: id, resultText: "ok", durationMs });
        }
    }
    return messages;
}

const post = (page, messages) =>
    page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);

/** 侧边栏底部那颗「统计」在哪儿：宽窗在常驻那一列里；窄窗先把抽屉拉出来（等它画出来）。
 *  抽屉关掉时底部那些按钮会被清空（见 media/chat.js 的 hidePicker），所以每次开弹窗都得重新找一遍。 */
async function statsButton(page) {
    const visible = (sel) => page.eval(
        `const el = document.querySelector(${JSON.stringify(sel)});
         return !!el && el.getBoundingClientRect().width > 0;`);
    if (await visible("#dockFooter .pk-footer-stats")) { return "#dockFooter .pk-footer-stats"; }
    const overlayOpen = await page.eval(`return !document.getElementById("pickerOverlay").classList.contains("hidden")`);
    if (!overlayOpen) { await page.click("#browserMenuBtn"); }
    for (let i = 0; i < 40; i++) {
        if (await visible("#pickerFooter .pk-footer-stats")) { return "#pickerFooter .pk-footer-stats"; }
        await page.sleep(100);
    }
    throw new Error("侧边栏底部没长出那颗「统计」");
}

/** 点开统计弹窗（每次先找一遍那颗按钮：抽屉可能刚被关过）。 */
async function openStats(page) {
    await page.click(await statsButton(page));
    await page.sleep(300);
}

const look = (page, label) => page.eval(`return JSON.stringify({
    open: !document.getElementById("toolStatsOverlay").classList.contains("hidden"),
    body: (document.getElementById("toolStatsBody").innerText || "").replace(/\\n+/g, " | "),
})`).then((raw) => console.log(label + "：" + raw));

module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(700);

    // 一条都还没跑过：先说一句
    await openStats(page);
    await look(page, "刚打开（还没跑过工具）");
    await page.shot("tool-stats-1-empty.png");

    // 关掉（点右上角那颗叉）
    await page.click("#toolStatsClose");
    await page.sleep(200);

    // 投一批调用与结果，再打开
    await post(page, buildMessages(ITEMS, 0));
    await page.sleep(400);
    await openStats(page);
    await look(page, "跑过一批之后");
    await page.shot("tool-stats-2-rows.png");

    // 弹窗开着又来一条结果：数应该跟着长
    await post(page, buildMessages([["find", { pattern: "**/*.md", path: "dev" }, 1500]], 100));
    await page.sleep(400);
    await look(page, "开着时又来一条结果");
    await page.shot("tool-stats-3-live.png");

    // Esc 收起来
    await page.eval(`
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return true;
    `);
    await page.sleep(200);
    await look(page, "按过 Esc 之后");
};

// @ts-nocheck
/**
 * toolRow —— 验“一批工具调用全挤在同一条线上”（不折行、跟正文分开）。
 *
 * 真让模型一口气调十几个工具不好凑，所以这里直接往页面里投一批工具调用消息
 * （跟后端推的是同一种消息），前后各加一段正文，看排版：
 *   · 工具标签单独占一行、跟正文分开（不接在正文段尾）；一条放不下就折行；
 *   · 两条正文之间的调用共用一条线（下一条正文到来后另起一条）。
 *
 *   npm run web:shot -- --width 1000 --height 620 --script dev/toolRow.js
 * 图落在 dev/shots/。
 */

/** 投进去的调用：工具名 + 参数（跟 pi 报给后端的一样）。 */
const TOOLS = [
    ["bash", { command: "git status --short" }],
    ["bash", { command: "npm run compile" }],
    ["read", { path: "src/extension.ts" }],
    ["read", { path: "src/chatViewProvider.ts" }],
    ["grep", { pattern: "tool-row", path: "media" }],
    ["read", { path: "tsconfig.extension.json" }],
    ["ls", { path: "src" }],
    ["bash", { command: "node scripts/compile.mjs" }],
    ["read", { path: "media/chat.css" }],
    ["read", { path: "media/chat.js" }],
    ["write", { path: "out/note.txt" }],
    ["edit", { path: "media/chat.css" }],
    ["edit", { path: "media/chat.js" }],
    ["bash", { command: "npm test" }],
    ["read", { path: "dev/README.md" }],
    ["bash", { command: "unzip -l pi-chat-vscode-0.0.9.vsix" }],
];

module.exports = async (page) => {
    await page.waitReady();
    // 投消息（不带 toolCallId：直接算完成，省掉转圈动画）
    await page.eval(`(() => {
        const post = (m) => window.postMessage(m, "*");
        post({ type: "assistantFull", text: "先把要动的地方看一遍：" });
        for (const [toolName, args] of ${JSON.stringify(TOOLS)}) {
            post({ type: "tool", toolName, args });
        }
        post({ type: "assistantFull", text: "上面那条线就是全部工具调用（单独一行，跟正文分开）。下面是正文，各自一块。" });
        return true;
    })()`);
    await page.sleep(600);
    await page.shot("tool-row.png");
};

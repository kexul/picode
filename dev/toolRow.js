// @ts-nocheck
/**
 * toolRow —— 验“一批工具调用全挤在同一条线上”（不折行、跟正文分开）。
 *
 * 真让模型一口气调十几个工具不好凑，所以这里直接往页面里投一批工具调用消息
 * （跟后端推的是同一种消息），前后各加一段正文，看排版：
 *   · 工具标签单独占一行、跟正文分开（不接在正文段尾）；一条放不下就折行；
 *   · 两条正文之间的调用共用一条线（下一条正文到来后另起一条）；
 *   · 同一个名字只出一个标签（工具名 + 一个写着次数的小方块），停在第一次调用的位置——名字不同就各占一个，
 *     taba 那几个每次各占一个（见 chat.js 的 NO_MERGE_TOOLS），write / edit 则跟别的工具一样收，
 *     这样一条线上能排好几个标签；
 *     合并本身（提示框里一条条列出来、读图那条摘出去）看 dev/toolMerge.js。
 *
 *   npm run web:shot -- --width 1000 --height 620 --script dev/toolRow.js
 * 图落在 dev/shots/。
 */

/** 投进去的调用：工具名 + 参数（跟 pi 报给后端的一样）；["editCard", 工具名, 参数] 是编辑卡片。 */
const ITEMS = [
    ["bash", { command: "git status --short" }],
    ["bash", { command: "npm run compile" }],
    ["grep", { pattern: "tool-row", path: "media" }],
    ["taba", { name: "侦察: 工具调用", task: "把 chat.js 里工具标签那段看一遍" }],
    ["read", { path: "src/extension.ts" }],
    ["read", { path: "src/chatViewProvider.ts" }],
    ["ls", { path: "src" }],
    ["editCard", "edit", { path: "media/chat.css", oldText: "a", newText: "b" }],
    ["codemode", { code: "return 1" }],
    ["bash", { command: "node scripts/compile.mjs" }],
    ["find", { pattern: "**/*.md", path: "dev" }],
    ["read", { path: "media/chat.js" }],
    ["editCard", "write", { path: "out/note.txt" }],
    ["bash", { command: "npm test" }],
    ["bash", { command: "unzip -l pi-chat-vscode-0.1.0.vsix" }],
];

module.exports = async (page) => {
    await page.waitReady();
    // 投消息（普通调用不带 toolCallId：直接算完成，省掉转圈动画）
    const messages = [{ type: "assistantFull", text: "先把要动的地方看一遍：" }];
    let seq = 0;
    for (const item of ITEMS) {
        if (item[0] === "editCard") {
            const [, toolName, args] = item;
            const id = `edit-${++seq}`;
            messages.push({ type: "editCardStart", toolCallId: id, toolName, path: args.path, label: args.path, args });
            messages.push({ type: "editCardResult", toolCallId: id, canRevert: false, diff: "" });
        } else {
            const [toolName, args] = item;
            messages.push({ type: "tool", toolName, args });
        }
    }
    messages.push({ type: "assistantFull", text: "上面那条线就是全部工具调用（单独一行，跟正文分开）。下面是正文，各自一块。" });
    await page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
    await page.sleep(600);
    await page.shot("tool-row.png");
};

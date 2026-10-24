// @ts-nocheck
/**
 * markdownBlocksCheck —— 对照检查：流式里「按块渲染」出来的东西，跟「整段渲染」是不是一样。
 *
 * 流式正文现在是按顶层块切开渲染的（media/chat.js 的 syncStreamBlocks）：已经定型的块
 * 只渲染一次、不再解析，只有尾巴重新切块重画。这样长回复流式时不会每次都把全文
 * 重解析、重新高亮、重建全部节点（手机上那样会把一颗核心跑满）。
 *
 * 这个脚本就是它的回归检查：一批 markdown 样例逐小块喂进去（走真流式那条路），
 * 把结果的文字与 marked 整段渲染的结果逐字对比（比较时忽略空白——块之间的空行
 * 不影响视觉，代码块后面多一个换行也没有视觉差别）。收尾（streamEnd）之后再比一次。
 *
 *   node dev/markdownBlocksCheck.js
 *
 * 会话目录 / 设置都指到 dev/.scratch，不碰用户自己的环境。
 */
const { createHarness } = require("./harness.js");
const { openPage } = require("./cdp.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 样例：能覆盖到的都放一份，括号里写明预期走哪条路。 */
const CASES = {
    "标题+段落": "## 标题\n\n第一段。\n\n第二段，带 `行内代码` 与 **粗体**。\n",
    "嵌套列表": "- 一\n- 二\n  - 二一\n  - 二二\n\n1. 甲\n2. 乙\n",
    "表格": "| 左 | 右 |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |\n",
    "围栏代码块": "前置段落。\n\n```typescript\nfunction f() {\n  return 1;\n}\n```\n\n后续段落。\n",
    "未闭合围栏（流式半途）": "前置。\n\n```python\ndef g():\n    return 2\n",
    "引用": "> 第一行\n> 第二行\n\n普通段落。\n",
    "链接与图片": "看 [链接](https://example.com) 和 ![图](https://example.com/a.png)。\n",
    "任务列表": "- [ ] 没做\n- [x] 做了\n",
    "分隔线与 setext": "标题文字\n---\n\nabc\n\n***\n\n后面。\n",
    "HTML 块（应回退）": "<div class=\"x\">\n块内容\n</div>\n\n后面的段落。\n",
    "引用式定义（应回退）": "看 [这个][a] 链接。\n\n[a]: https://example.com/doc\n",
    "段落里单换行": "第一行\n第二行\n第三行\n\n另一段。\n",
    "长段落与代码交替": "第一段。\n\n```js\nlet a = 1;\n```\n\n第二段。\n\n```js\nlet b = 2;\n```\n\n第三段。\n",
};

/** 页面里读回来的对比结果（忽略空白后逐字比）。 */
const READ_BACK = (markdown) => `
  const md = document.querySelector(".msg.assistant .md");
  const text = (el) => Array.from(el.textContent).filter((c) => c.trim() !== "").join("");
  const whole = document.createElement("div");
  whole.innerHTML = marked.parse(${JSON.stringify(markdown)}, { breaks: true, gfm: true });
  return { blocks: md.querySelectorAll(":scope > .md-block").length, got: text(md), want: text(whole) };
`;

async function main() {
    const harness = createHarness({ fakePi: true });
    const url = await harness.start();
    const open = await openPage({ url, width: 412, height: 915, timeoutMs: 60000 });
    const { page } = open;
    let bad = 0;
    try {
        await page.waitReady();
        await page.eval(`
            const pane = document.querySelector(".session-view:not(.off) .session-pane");
            const id = pane.dataset.sessionId;
            window.__send = (m) => window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: id }, m) }));
            return true;
        `);
        for (const [name, markdown] of Object.entries(CASES)) {
            await page.eval(`window.__send({ type: "clear" }); window.__send({ type: "streamStart", activity: "working" }); return true;`);
            // 每次喂 4 个字符：跟真流式一样是"一小块一小块"进来的
            for (let i = 0; i < markdown.length; i += 4) {
                await page.eval(`window.__send({ type: "assistantDelta", delta: ${JSON.stringify(markdown.slice(i, i + 4))} }); return true;`);
            }
            await sleep(320);
            const mid = await page.eval(READ_BACK(markdown));
            const midSame = mid.got === mid.want && mid.got.length > 0;
            // 收尾：走 finalizeCurrentAssistant，会整段重画一次
            await page.eval(`window.__send({ type: "streamEnd", activity: "idle" }); return true;`);
            await sleep(200);
            const end = await page.eval(READ_BACK(markdown));
            const endSame = end.got === end.want && end.got.length > 0;
            if (!midSame || !endSame) { bad += 1; }
            console.log((midSame && endSame ? "一致  " : "不一致") + "  " + name + "（流式中 " + mid.blocks + " 个块容器）");
            if (!midSame) { console.log("    流式中： " + JSON.stringify(mid.got.slice(0, 140)) + "\n    整段：   " + JSON.stringify(mid.want.slice(0, 140))); }
            if (!endSame) { console.log("    收尾后： " + JSON.stringify(end.got.slice(0, 140)) + "\n    整段：   " + JSON.stringify(end.want.slice(0, 140))); }
        }
        const errs = page.pageErrors || [];
        if (errs.length) { console.log("页面报错：" + JSON.stringify(errs.slice(0, 5))); }
        console.log("");
        console.log(bad === 0 ? "全部样例都一致（流式中与收尾后各比一次）。" : "有 " + bad + " 个样例不一致。");
    } finally {
        await open.close();
        await harness.stop();
    }
    if (bad !== 0) { process.exit(1); }
}

main().catch((err) => { console.error("\n出错了：" + (err?.message || err)); process.exit(1); });

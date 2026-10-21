// @ts-nocheck
/**
 * mermaidCheck —— 消息流里的 ```mermaid 代码块是不是画成了图。
 *
 * 投一段正文进去（流式一小块一小块喂，跟真流式一样），收尾之后检查：
 *   - 支持的两种图（流程图、时序图）各出一个 SVG，尺寸不是 0；
 *   - 不支持的（饼图）留着代码块，底下有一行说明；
 *   - 普通代码块不动；
 *   - 流式途中已定型的块先画出来（不叠图），收尾后两张图各一份；
 *   - 页面没有报错。
 *
 *   node dev/mermaidCheck.js
 *
 * 会话目录 / 设置都指到 dev/.scratch，不碰用户自己的环境；模型是假的（fakePi），秒回。
 */
const { createHarness } = require("./harness.js");
const { openPage } = require("./cdp.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MD = [
    "## 图表示例",
    "",
    "一段流程图：",
    "",
    "```mermaid",
    "graph TD",
    "  用户[用户] --> 网关",
    "  网关 --> 服务",
    "  服务 --> 数据库[(数据库)]",
    "```",
    "",
    "中文节点名 + 连线中间写字 + classDef / style：",
    "",
    "```mermaid",
    "graph LR",
    "  甲 -- 说明 --> 乙",
    "  classDef 热 fill:#f96",
    "  class 甲 热",
    "```",
    "",
    "一段时序图：",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  张三->>李四: 打个招呼",
    "  李四-->>张三: 在呢",
    "```",
    "",
    "一段不支持的：",
    "",
    "```mermaid",
    "pie title 占比",
    '  "甲" : 40',
    '  "乙" : 60',
    "```",
    "",
    "普通代码块不该被当成图：",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "结束。",
].join("\n");

const LOOK = () => {
    const md = document.querySelector(".msg.assistant .md");
    if (!md) { return null; }
    const figs = [...md.querySelectorAll(".md-mermaid")];
    const notes = [...md.querySelectorAll(".md-mermaid-note")];
    return {
        figs: figs.length,
        notes: notes.length,
        svgs: figs.map((f) => {
            const s = f.querySelector("svg");
            if (!s) { return null; }
            const r = s.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height), viewBox: s.getAttribute("viewBox") };
        }),
        pre: md.querySelectorAll("pre").length,
        noteText: notes[0] ? notes[0].textContent.trim() : "",
    };
};

function check(name, ok, detail) {
    console.log((ok ? "OK   " : "不行 ") + name + (detail === undefined ? "" : "（" + detail + "）"));
    return ok ? 0 : 1;
}

async function main() {
    const harness = createHarness({ fakePi: true });
    const url = await harness.start();
    const open = await openPage({ url, width: 900, height: 760, timeoutMs: 60000 });
    const { page } = open;
    let bad = 0;
    try {
        await page.waitReady();
        await page.eval(`
            const pane = document.querySelector(".session-pane");
            const id = pane.dataset.sessionId;
            window.__send = (m) => window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: id }, m) }));
            return true;
        `);
        await page.eval(`window.__send({ type: "clear" }); window.__send({ type: "streamStart", activity: "working" }); return true;`);
        for (let i = 0; i < MD.length; i += 4) {
            await page.eval(`window.__send({ type: "assistantDelta", delta: ${JSON.stringify(MD.slice(i, i + 4))} }); return true;`);
        }
        await sleep(400);
        const mid = await page.eval("const look = " + LOOK.toString() + "; return look();");
        // 冻结线之前的块定型了就可以先画；要紧的是别叠、别把还没定型的尾巴画成残图
        bad += check("流式途中：已定型的先画，不叠图", mid.figs <= 3 && mid.notes <= 1, "已画 " + mid.figs + " 个、说明 " + mid.notes + " 行");

        await page.eval(`window.__send({ type: "streamEnd", activity: "idle" }); return true;`);
        await sleep(500);
        const end = await page.eval("const look = " + LOOK.toString() + "; return look();");
        bad += check("收尾后：三张图都出来了（含中文节点名的两张）", end.figs === 3, "图 " + end.figs + " 个");
        bad += check("图有实际尺寸（不是 0×0）", end.svgs.every((s) => s && s.w > 40 && s.h > 40), JSON.stringify(end.svgs));
        bad += check("不支持的图：代码块留着，底下有一行说明", end.notes === 1 && end.pre >= 2, "说明 " + end.notes + " 行、代码块 " + end.pre + " 个");
        bad += check("说明写清了只支持哪几种", /只支持/.test(end.noteText) && /流程图/.test(end.noteText), JSON.stringify(end.noteText.slice(0, 80)));
        bad += check("普通代码块没被当成图（它还在）", end.pre >= 2, "代码块 " + end.pre + " 个");
        bad += check("中文节点名没把图吞掉（三张图的尺寸都正常）", end.svgs.every((s) => s && s.w > 40 && s.h > 40), JSON.stringify(end.svgs));

        // 滚到顶看前两张（中文节点名的那两张在上面）
        await page.eval(`document.querySelector(".session-pane").scrollTop = 0; return true;`);
        await sleep(300);
        await page.shot("mermaid-1-light.png");
        // 深色：只换界面那套颜色变量（图里的颜色是 var(...)，应该不用重画就跟着变）
        await page.eval(`
            document.body.style.setProperty("--vscode-editor-background", "#1f1f1f");
            document.body.style.setProperty("--vscode-foreground", "#cccccc");
            document.documentElement.style.colorScheme = "dark";
            return true;
        `);
        await sleep(300);
        const dark = await page.eval("const look = " + LOOK.toString() + "; return look();");
        bad += check("换深色不重画、图还在", dark.figs === 3, "图 " + dark.figs + " 个");
        await page.shot("mermaid-2-dark.png");

        const errs = page.pageErrors || [];
        bad += check("页面没有报错", errs.length === 0, JSON.stringify(errs.slice(0, 3)));
    } finally {
        await open.close();
        await harness.stop();
    }
    console.log("");
    console.log(bad === 0 ? "全部通过。" : "有 " + bad + " 项不对。");
    if (bad !== 0) { process.exit(1); }
}

main().catch((err) => { console.error("\n出错了：" + (err?.message || err)); process.exit(1); });

// @ts-nocheck
/**
 * mermaidCheck —— 消息流里的 ```mermaid 代码块是不是画成了图。
 *
 * 投一段正文进去（流式一小块一小块喂，跟真流式一样），检查：
 *   - 各种图各出一个 SVG，尺寸不是 0（流程图、中文节点名 + classDef、时序图、饼图、甘特图）；
 *   - 画图那个脚本（pele.js）是按需拉的：正文里没有 mermaid 之前页面上没有它，
 *     出现之后只拉了这一次，拉到了才画（这几张图就是拉回来之后画出来的）；
 *   - 写坏的图留着代码块，底下有一行说明，说明里点出是第几行；
 *   - 普通代码块不动；
 *   - 流式途中已定型的块先画出来（不叠图），收尾后几张图各一份；
 *   - 换深色不重画（同一批节点），图里的颜色自己跟着变；
 *   - 插件里的对话面板那一份（脚本全内联）也画得出来、不用去拉脚本；
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
    "一段饼图（以前那种库里画不出来，现在能画）：",
    "",
    "```mermaid",
    "pie title 占比",
    '  "甲" : 40',
    '  "乙" : 60',
    "```",
    "",
    "一段甘特图：",
    "",
    "```mermaid",
    "gantt",
    "  title 计划",
    "  section 一",
    "  做事 :a1, 2024-01-01, 3d",
    "```",
    "",
    "一段写坏的：",
    "",
    "```mermaid",
    "graph TD",
    "  A --> ",
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

/** 正文里有几张图、几行说明、剩几个代码块。 */
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

/** 画图那个脚本在页面上待着的样子：拉了没有、拉了几次、全局的库到了没。 */
const LIB = () => ({
    tags: [...document.querySelectorAll('script[src*="pele.js"]')].map((s) => s.getAttribute("src")),
    loaded: typeof globalThis.pele === "object" || typeof globalThis.pele === "function",
});

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
            const pane = document.querySelector(".session-view:not(.off) .session-pane");
            const id = pane.dataset.sessionId;
            window.__send = (m) => window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: id }, m) }));
            return true;
        `);
        // 一条消息都没有的时候，画图那个脚本不该已经在页面上（1.5MB 那种事不再有；pele 也有 700 多 KB）
        const before = await page.eval("const lib = " + LIB.toString() + "; return lib();");
        bad += check("正文里还没出现 mermaid：画图那个脚本没去拉", before.tags.length === 0 && before.loaded === false,
            JSON.stringify(before));

        await page.eval(`window.__send({ type: "clear" }); window.__send({ type: "streamStart", activity: "working" }); return true;`);
        for (let i = 0; i < MD.length; i += 4) {
            await page.eval(`window.__send({ type: "assistantDelta", delta: ${JSON.stringify(MD.slice(i, i + 4))} }); return true;`);
        }
        await sleep(1500);
        const mid = await page.eval("const look = " + LOOK.toString() + "; return look();");
        const midLib = await page.eval("const lib = " + LIB.toString() + "; return lib();");
        // 冻结线之前的块定型了就可以先画；要紧的是别叠、别把还没定型的尾巴画成残图、也别急着报错
        bad += check("出现 mermaid 之后才去拉，而且只拉一次", midLib.tags.length === 1 && midLib.loaded === true,
            JSON.stringify(midLib));
        // 写坏的那一块定型之后会先挂一行说明（它的源码到那儿就完了），其余块照常先画
        bad += check("流式途中：已定型的先画，不叠图", mid.figs <= 5 && mid.notes <= 1,
            "已画 " + mid.figs + " 个、说明 " + mid.notes + " 行");

        await page.eval(`window.__send({ type: "streamEnd", activity: "idle" }); return true;`);
        await sleep(800);
        const end = await page.eval("const look = " + LOOK.toString() + "; return look();");
        bad += check("收尾后：五张图都出来了（含中文节点名的、饼图、甘特图）", end.figs === 5, "图 " + end.figs + " 个");
        bad += check("图有实际尺寸（不是 0×0）", end.svgs.every((s) => s && s.w > 40 && s.h > 40), JSON.stringify(end.svgs));
        bad += check("写坏的图：代码块留着，底下有一行说明", end.notes === 1 && end.pre >= 2,
            "说明 " + end.notes + " 行、代码块 " + end.pre + " 个");
        bad += check("说明里有库说的“错在第几行”", /Parse error on line \d+/.test(end.noteText), JSON.stringify(end.noteText.slice(0, 90)));
        bad += check("普通代码块没被当成图（它还在）", end.pre >= 2, "代码块 " + end.pre + " 个");

        // 滚到顶看上面几张
        await page.eval(`document.querySelector(".session-view:not(.off) .session-pane").scrollTop = 0; return true;`);
        await sleep(300);
        await page.shot("mermaid-1-light.png");

        // 换深色：切主题那一步就是把深色那套变量行内写到 body 上（见 browserBridge.js 的 applyTheme）。
        // 图里存的是 var(...)，所以不该重画：给每个 SVG 打个记号，换完记号都还在，而颜色（框的底）变了。
        const FILL = `return (() => { const r = document.querySelector(".md-mermaid .pele-node rect"); return r ? getComputedStyle(r).fill : ""; })()`;
        const lightFill = await page.eval(FILL);
        await page.eval(`
            document.querySelectorAll(".md-mermaid svg").forEach(function (s) { s.setAttribute("data-mark", "1"); });
            document.body.style.setProperty("--vscode-editor-background", "#1f1f1f");
            document.body.style.setProperty("--vscode-foreground", "#cccccc");
            document.body.style.setProperty("--vscode-editorWidget-background", "#1f1f1f");
            document.body.style.setProperty("--vscode-panel-border", "#2b2b2b");
            document.documentElement.style.colorScheme = "dark";
            return true;
        `);
        await sleep(400);
        const dark = await page.eval("const look = " + LOOK.toString() + "; const o = look(); o.marked = document.querySelectorAll('.md-mermaid svg[data-mark=\"1\"]').length; return o;");
        const darkFill = await page.eval(FILL);
        bad += check("换深色不重画（还是原来那批节点）", dark.figs === 5 && dark.marked === 5, "图 " + dark.figs + " 个、带记号的 " + dark.marked + " 个");
        bad += check("换深色图里的颜色跟着变（没重画也算数）", !!lightFill && darkFill !== lightFill, lightFill + " → " + darkFill);
        await page.shot("mermaid-2-dark.png");

        const errs = page.pageErrors || [];
        bad += check("页面没有报错", errs.length === 0, JSON.stringify(errs.slice(0, 3)));

        // ==================== 插件里的对话面板那一份 ====================
        // 面板的整页是后端拼的：所有脚本（含 pele）都内联在里面，没有 /media 那些地址。
        // 这里把它原样取下来当页面加载（先塞一个 acquireVsCodeApi，界面就按“面板”那套跑），
        // 只验一件事：那边不用去拉脚本、图也画得出来。
        await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
            source: `window.acquireVsCodeApi = function () {
                return { postMessage: function () {}, getState: function () { return null; }, setState: function () {} };
            };`,
        });
        await page.cdp.send("Page.navigate", { url: url.replace(/\/$/, "") + "/panel?theme=light" });
        await sleep(2000);
        const panelBoot = await page.eval(`
            return JSON.stringify({
                webview: window.pichatInWebview === true,
                external: document.querySelectorAll("script[src]").length,
                pele: typeof globalThis.pele === "object" || typeof globalThis.pele === "function",
            });
        `);
        const boot = JSON.parse(panelBoot);
        bad += check("面板那一份：脚本全内联（没有外链、pele 已就位）",
            boot.webview === true && boot.external === 0 && boot.pele === true, panelBoot);
        if (boot.webview === true) {
            await page.eval(`
                window.postMessage({ type: "sessionList", sessions: [{
                    id: "panel-1", name: "测试会话", streaming: false, activity: "idle",
                    piReady: true, modelId: "fake", provider: "fake", cwd: ".",
                }] }, "*");
                return true;
            `);
            await sleep(300);
            const panelMd = ["```mermaid", "graph LR", "  面板 --> 图", "```"].join("\n");
            await page.eval(`
                window.postMessage({ type: "assistantFull", sessionId: "panel-1", text: ${JSON.stringify(panelMd)} }, "*");
                return true;
            `);
            await sleep(800);
            const panelLook = JSON.parse(await page.eval(`
                const figs = [...document.querySelectorAll(".md-mermaid")];
                return JSON.stringify({
                    figs: figs.length,
                    ok: figs.every(function (f) {
                        const s = f.querySelector("svg");
                        const r = s ? s.getBoundingClientRect() : null;
                        return !!r && r.width > 40 && r.height > 40;
                    }),
                });
            `));
            bad += check("面板里 ```mermaid 也画得出来", panelLook.figs === 1 && panelLook.ok === true, JSON.stringify(panelLook));
            await page.shot("mermaid-3-panel.png");
            const panelErrs = (page.pageErrors || []).filter(function (e) { return !/favicon/.test(e); });
            bad += check("面板那一份页面没有报错", panelErrs.length === 0, JSON.stringify(panelErrs.slice(0, 3)));
        }
    } finally {
        await open.close();
        await harness.stop();
    }
    console.log("");
    console.log(bad === 0 ? "全部通过。" : "有 " + bad + " 项不对。");
    if (bad !== 0) { process.exit(1); }
}

main().catch((err) => { console.error("\n出错了：" + (err?.message || err)); process.exit(1); });

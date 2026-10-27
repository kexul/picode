// @ts-nocheck
/**
 * mermaidFileCheck —— 文件侧边栏里那份 markdown 文档里的 ```mermaid 是不是也画成了图。
 *
 * 铺一个 mermaid-readme.md（流程图 + 时序图 + 甘特图 + 一段写坏的），在消息流里点它的链接，
 * 检查文档里：能画的都出来了（饼图、甘特图这些以前那个库画不了）、写坏的留着代码块加一行说明。
 *
 *   node dev/mermaidFileCheck.js
 */
const fs = require("fs");
const path = require("path");
const { createHarness, SCRATCH_DIR } = require("./harness.js");
const { openPage } = require("./cdp.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOC = "mermaid-readme.md";
const DOC_TEXT = [
    "# 图表",
    "",
    "```mermaid",
    "graph LR",
    "  前端 --> 后端 --> 数据库",
    "```",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  甲->>乙: 请求",
    "  乙-->>甲: 结果",
    "```",
    "",
    "```mermaid",
    "gantt",
    "  title 计划",
    "  section 一",
    "  任务 :a1, 2024-01-01, 3d",
    "```",
    "",
    "```mermaid",
    "graph TD",
    "  A --> ",
    "```",
    "",
    "普通代码块：",
    "",
    "```js",
    "const a = 1;",
    "```",
].join("\n") + "\n";

const LOOK = () => {
    // 每个标签各留自己那一块正文（切走只是藏起来，见 chat.js 的 fileTabPage）：
    // 正看着的那一块才装得下刚打开的那个文件，别从整个 #fileBody 查。
    const box = document.getElementById("fileBody");
    const body = box ? (box.querySelector(".file-page:not([hidden])") || box) : null;
    const doc = body ? body.querySelector(".file-md") : null;
    if (!doc) { return { doc: false }; }
    const figs = [...doc.querySelectorAll(".md-mermaid")];
    const notes = [...doc.querySelectorAll(".md-mermaid-note")];
    return {
        doc: true,
        figs: figs.length,
        svgs: figs.map((f) => {
            const s = f.querySelector("svg");
            if (!s) { return null; }
            const r = s.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
        }),
        notes: notes.length,
        noteText: notes[0] ? notes[0].textContent.trim() : "",
        pre: doc.querySelectorAll("pre").length,
        // 正看着的那一格是哪个文件（头上不写路径了，看标签的 data-path）
        activePath: (function () {
            const t = Array.from(document.querySelectorAll("#fileTabs .file-tab"))
                .filter(function (x) { return x.classList.contains("active"); })[0];
            return t ? (t.getAttribute("data-path") || "") : "";
        })(),
    };
};

async function waitLook(page, name, ok, timeoutMs) {
    const limit = Date.now() + (timeoutMs || 10000);
    let last = null;
    while (Date.now() < limit) {
        last = await page.eval("const look = " + LOOK.toString() + "; return look();");
        if (ok(last)) { return last; }
        await sleep(200);
    }
    throw new Error("等不到「" + name + "」：" + JSON.stringify(last));
}

let bad = 0;
function check(name, ok, detail) {
    console.log((ok ? "OK   " : "不行 ") + name + (detail === undefined ? "" : "（" + detail + "）"));
    if (!ok) { bad += 1; }
}

async function main() {
    const harness = createHarness({ fakePi: true });
    const url = await harness.start();
    const open = await openPage({ url, width: 1280, height: 820, timeoutMs: 60000 });
    const { page } = open;
    try {
        await page.waitReady();
        await sleep(500);
        const info = JSON.parse(await page.eval(`
            const pane = document.querySelector(".session-view:not(.off) .session-pane");
            return JSON.stringify({
                cwd: (((document.getElementById("sessionName") || {}).dataset || {}).cwd) || "",
                sessionId: pane ? (pane.dataset.sessionId || "") : "",
            });
        `));
        const cwd = info.cwd || SCRATCH_DIR;
        fs.writeFileSync(path.join(cwd, DOC), DOC_TEXT, "utf8");
        console.log("写进 " + path.join(cwd, DOC));

        // 投一句话、顺手把它点开（链接是消息流那条渲染路挂上去的文件链接）
        await page.eval(`
            const pane = document.querySelector(".session-view:not(.off) .session-pane");
            const id = pane.dataset.sessionId;
            const send = (m) => window.dispatchEvent(new MessageEvent("message", { data: Object.assign({ sessionId: id }, m) }));
            send({ type: "clear" });
            send({ type: "streamStart", activity: "working" });
            send({ type: "assistantDelta", delta: ${JSON.stringify("看这个 `" + DOC + ":1` 文件。")} });
            send({ type: "streamEnd", activity: "idle" });
            return true;
        `);
        await sleep(600);
        const clicked = await page.eval(`
            const a = Array.from(document.querySelectorAll("a.file-link")).find(function (x) {
                return x.getAttribute("data-file") === ${JSON.stringify(DOC)};
            });
            if (!a) { return "没有这个链接"; }
            a.click();
            return "点了";
        `);
        console.log("点链接：" + clicked);

        const look = await waitLook(page, "文档渲染上来", (x) => x.doc === true, 15000);
        check("文档里三张能画的都画出来了（含甘特图）", look.figs === 3, "图 " + look.figs + " 个");
        check("图有实际尺寸（不是 0×0）", look.svgs.every((s) => s && s.w > 40 && s.h > 40), JSON.stringify(look.svgs));
        check("写坏的图：代码块留着，底下有一行说明", look.notes === 1 && look.pre >= 2, "说明 " + look.notes + " 行、代码块 " + look.pre + " 个");
        check("说明里有库说的“错在第几行”", /Parse error on line \d+/.test(look.noteText), JSON.stringify(look.noteText.slice(0, 90)));
        check("普通代码块还在（没被当成图）", look.pre >= 2, "代码块 " + look.pre + " 个");
        check("点的是这个文件（正看着的那一格是它）", look.activePath === DOC, JSON.stringify(look.activePath));
        await page.shot("mermaid-file.png");

        const errs = page.pageErrors || [];
        check("页面没有报错", errs.length === 0, JSON.stringify(errs.slice(0, 3)));
    } finally {
        await open.close();
        await harness.stop();
    }
    console.log("");
    console.log(bad === 0 ? "全部通过。" : "有 " + bad + " 项不对。");
    if (bad !== 0) { process.exit(1); }
}

main().catch((err) => { console.error("\n出错了：" + (err?.message || err)); process.exit(1); });

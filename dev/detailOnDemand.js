// @ts-nocheck
/**
 * detailOnDemand —— 验「只发摘要、点开再取」（历史重放那一路）：用真会话打开页面，
 * 思考全文与工具输出一个字都不带，点开提示框才把全文取回来。
 *
 *   node dev/detailOnDemand.js --session <某个 .jsonl>
 *
 * 假模型那边的那一路（实时流）见 dev/liveDetail.js。
 *
 * 用真后端 + 真 pi 打开一个真会话（不发消息），在页面上挨个悬浮标签，检查：
 *   · 提示框里先什么都没有、只有一行「还有 N 字没带过来，正在取…」；
 *   · 一秒内全文回来，提示框里变成完整内容，那行小字消失。
 */
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf("--" + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const session = arg("session", "");
if (!session) { console.error("要给 --session <会话文件.jsonl>"); process.exit(1); }

const scratch = path.join(__dirname, ".scratch", "detail");
const work = path.join(scratch, "work");
const sessionsRoot = path.join(scratch, "sessions");
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const encodeCwd = (cwd) => "--" + cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-") + "--";
const sessionDir = path.join(sessionsRoot, encodeCwd(work));
fs.mkdirSync(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, path.basename(session));
fs.copyFileSync(session, sessionFile);
process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;

const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

/** 悬浮到第 n 个标签上，返回提示框内容。 */
async function hoverTip(page, index) {
    return await page.eval(`
        const tags = Array.from(document.querySelectorAll('.session-view:not(.off) .session-pane .tool'));
        const tag = tags[${index}];
        if (!tag) { return { error: "没有第 ${index} 个标签（一共 " + tags.length + " 个）" }; }
        tag.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        return { total: tags.length, cls: tag.className, name: (tag.innerText || '').trim().slice(0, 30) };
    `);
}

async function tipState(page) {
    return await page.eval(`
        const el = document.querySelector('.tag-tip');
        if (!el || el.classList.contains('hidden')) { return { open: false }; }
        const body = el.querySelector('.tag-tip-content') || el;
        const note = el.querySelector('.tag-tip-clip');
        return {
            open: true,
            chars: (body.innerText || "").length,
            note: note ? note.textContent : "",
            head: (body.innerText || "").slice(0, 60),
        };
    `);
}

async function hideTip(page) {
    await page.eval(`
        document.querySelectorAll('.session-view:not(.off) .session-pane .tool').forEach((t) => {
            t.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
        });
        return true;
    `);
    await sleep(400);
}

async function main() {
    const harness = createHarness({ cwd: work, piPath: "pi", log: () => { } });
    const url = await harness.start();
    const warm = await openPage({ url, width: 412, height: 915, timeoutMs: 90000 });
    await warm.page.waitReady(120000);
    const resp = await warm.page.eval(`
        const pageId = (document.querySelector('meta[name="pichat-page"]') || {}).content || "";
        const body = JSON.stringify({ type: 'workspaceOpenSession', path: ${JSON.stringify(sessionFile)}, cwd: ${JSON.stringify(work)} });
        return fetch('/api?pageId=' + encodeURIComponent(pageId), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body,
        }).then((r) => r.status);
    `);
    console.log(`打开历史会话：HTTP ${resp}`);
    const limit = Date.now() + 180000;
    while (Date.now() < limit) {
        const n = await warm.page.eval(`return document.querySelectorAll('.session-view:not(.off) .session-pane .tool').length;`);
        if (n > 0) { break; }
        await sleep(1000);
    }
    await sleep(3000);
    const tags = await warm.page.eval(`return document.querySelectorAll('.session-view:not(.off) .session-pane .tool').length;`);
    console.log(`页面上有 ${tags} 个工具标签`);
    const dump = await warm.page.eval(`
        const tags = Array.from(document.querySelectorAll('.session-view:not(.off) .session-pane .tool'));
        return tags.slice(0, 5).map(function (t) {
            const g = t._tipGroup;
            return {
                name: (t.innerText || '').trim().slice(0, 12),
                tagClip: t._resultClip ? { omitted: t._resultClip.omitted } : null,
                entries: g ? g.entries.map(function (e) {
                    return { len: (e.resultText || '').length, clip: e.clip ? { omitted: e.clip.omitted, loaded: e.clip.loaded } : null, done: e.done };
                }) : null,
            };
        });
    `);
    console.log(JSON.stringify(dump));

    // 本机零延迟时“正在取…”那一行几乎一闪就换成全文，验不到“先什么都没有”。这里把 /api
    // 暂时堵上：那一次取全文的请求发不出去，提示框就停在“还有 N 字没带过来”；验完再撤掉。
    await warm.cdp.send("Network.enable");
    const blockApi = (on) => warm.cdp.send("Network.setBlockedURLs", { urls: on ? ["*api*"] : [] });

    /** 每个标签里被裁过的条目（只看合并组里的；单条标签也带上）。 */
    async function clippedTags(page) {
        return await page.eval(`
            const tags = Array.from(document.querySelectorAll('.session-view:not(.off) .session-pane .tool'));
            return tags.map(function (t, i) {
                const g = t._tipGroup;
                const clips = g ? g.entries.filter(function (e) { return !!e.clip; }) : (t._resultClip ? [t] : []);
                return { i: i, name: (t.innerText || '').trim().slice(0, 12), clips: clips.length };
            }).filter(function (x) { return x.clips > 0; });
        `);
    }

    const targets = await clippedTags(warm.page);
    console.log(`其中“只带了开头”的标签：${targets.length} 个`);
    let agreed = 0;
    for (const t of targets.slice(0, 3)) {
        await hideTip(warm.page);
        await blockApi(true);
        await hoverTip(warm.page, t.i);
        await sleep(600);                 // 提示框 200 毫秒后弹出，之后才发出取全文的请求
        const first = await tipState(warm.page);
        const noteOk = first.open && !!first.note;
        await blockApi(false);
        await sleep(2500);                // 请求发出去、回话回来
        const after = await tipState(warm.page);
        const stuck = await warm.page.eval(`
            const t = document.querySelectorAll('.session-view:not(.off) .session-pane .tool')[${t.i}];
            const g = t._tipGroup;
            const list = g ? g.entries.filter(function (e) { return e.clip && !e.clip.loaded; }) : [];
            return list.map(function (e) {
                return { len: (e.resultText || '').length, omitted: e.clip.omitted, waiting: !!e.clip.waiting, failed: !!e.clip.failed };
            });
        `);
        if (stuck.length > 0) { console.log("    还差：" + JSON.stringify(stuck)); }
        if (!noteOk) { console.log("    （这次没看到那行小字：提示框弹出来时内容已经取到了）"); }
        const grown = after.open && after.chars > first.chars;
        const noteGone = after.open && !after.note;
        console.log(`  [${t.i}] ${t.name}：先 ${first.chars} 字（小字${noteOk ? "在" : "没在"}）→ ${after.chars} 字，小字${noteGone ? "收了" : "还在"} ${noteOk && grown && noteGone ? "✅" : "❌"}`);
        if (noteOk && grown && noteGone) { agreed += 1; }
    }
    console.log(`
验过的“只带开头”的标签：${Math.min(targets.length, 3)} 个，点开取到全文的：${agreed} 个`);
    await hideTip(warm.page);
    await warm.close();
    await harness.stop();
    if (targets.length === 0) { console.log("！这次会话里没有超过预览长度的思考/工具输出，换个更长的会话再验"); process.exit(2); }
    process.exit(agreed === Math.min(targets.length, 3) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

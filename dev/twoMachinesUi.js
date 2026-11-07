// @ts-nocheck
/**
 * twoMachinesUi —— 两台机器互联时，界面上那几件“跑在那台上的会话”的事（纯前端表现）。
 *
 * 一、在侧边栏点那台那一节里的一条会话，界面要切过去（后端会单发一声“切到它”；
 *     这中间排队来的“还没有它”的会话清单不能把这份等待当成过期扔掉，见 media/chat.js 的 pendingActivateId）；
 * 二、当前看的是那台上的会话时，变蓝的应当是那台那一节里对应的那一行目录（本机那几行都不蓝）；
 * 三、在那条会话里拉到最底，切走再切回来，视野还在最底（见下面的病根）。
 *
 * 人报的症状：在别台那台上的一条会话里已经拉到最下面，切到别的会话再切回来，视野落在中间某处。
 *
 * 三的病根有两处（都在“这台后端替页面去跟那台打交道”这一层，见 src/machineHub.ts）：
 *   一、每切一次就请那台把整条会话重画一遍（本来只要在“这块屏还没拿到过它的正文”时要一遍）。
 *       切来切去画面一直重摆，滚动位置跟着被推来推去；
 *   二、那台画完时发的那声 syncPoint 是按屏发的、没有会话号，后端把它当“不相干的消息”丢了。
 *       于是界面以为重放没结束，一直憋着不跟底，要等 8 秒的兜底才收 —— 这 8 秒里就停在半空。
 *
 * 这一趟起两台真后端（B 用真 pi 读会话文件：假 pi 不读盘，那边一条正文都没有，量不出高度），
 * 在 A 的页面上点开 B 的会话、拉到最底，切到本机会话再切回来，三次都比一次“离底多少像素”。
 *
 *   npm run compile && node dev/twoMachinesUi.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { openPage } = require("./cdp.js");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-rscroll-"));
const launcher = path.join(repoRoot, "bin", "pichat.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);

function startBackend(name, home, work, pi) {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const child = spawn(process.execPath, [launcher, "--no-open", "--cwd", work, "--port", "0", "--host", "127.0.0.1"], {
        cwd: repoRoot,
        // 两台各自一个 HOME：不然两边扫的是同一份 ~/.pi 会话目录，本机那节里也会冒出那台的项目
        env: {
            ...process.env,
            HOME: path.join(home, "user"),
            USERPROFILE: path.join(home, "user"),
            PICHAT_HOME: home,
            PICHAT_PI: pi || process.env.PICHAT_PI || path.join(repoRoot, "dev", "fake-pi.cmd"),
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const log = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (t) => log.push(t));
    child.stderr.on("data", (t) => log.push(t));
    return { name, home, work, child, log };
}

async function waitUrl(one) {
    const file = path.join(one.home, "server.json");
    for (let i = 0; i < 200; i += 1) {
        try {
            const info = JSON.parse(fs.readFileSync(file, "utf8"));
            if (info && info.url) { return String(info.url).replace(/\/+$/, ""); }
        } catch { /* 还没写出来 */ }
        await sleep(200);
    }
    throw new Error(one.name + " 没起来");
}

/** 造一条够长的会话（一对对 user / assistant），在那边打开时才有好几屏可滚。 */
function writeLongSession(userHome, cwd, id, turns) {
    const dashed = cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-");
    const out = path.join(userHome, ".pi", "agent", "sessions", "--" + dashed + "--");
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, "2099-03-03T00-00-00-000Z_" + id + ".jsonl");
    const lines = [{ type: "session", id, cwd, timestamp: new Date().toISOString() }];
    for (let i = 0; i < turns; i += 1) {
        lines.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "第 " + (i + 1) + " 问：这一句是为了把高度撑起来。" }] } });
        lines.push({
            type: "message",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "第 " + (i + 1) + " 答：" + "这是一段比较长的回答，用来把窗格撑出好几屏的高度。".repeat(6) }],
            },
        });
    }
    fs.writeFileSync(file, lines.map((one) => JSON.stringify(one)).join("\n") + "\n");
    return file;
}

const aHome = path.join(tmpRoot, "A");
const bHome = path.join(tmpRoot, "B");
const aWork = path.join(tmpRoot, "a-work");
const bWork = path.join(tmpRoot, "b-work");
let a = null;
let b = null;
let page = null;

(async () => {
    writeLongSession(path.join(bHome, "user"), bWork, "deadbeef-3333-4000-8000-0000000c0001", 24);
    // B 用真 pi：假 pi 不读会话文件，那边那条会话就一条正文都没有（这里要量的正是“有正文时切回来的视野”）
    b = startBackend("B", bHome, bWork, "pi");
    const urlB = await waitUrl(b);
    fs.mkdirSync(aHome, { recursive: true });
    fs.writeFileSync(path.join(aHome, "config.json"), JSON.stringify({ label: "B", machines: [urlB] }, null, 2));
    a = startBackend("A", aHome, aWork);
    const urlA = await waitUrl(a);
    await sleep(1500);

    const open = await openPage({ url: urlA, width: 1400, height: 900 });
    page = open.page;
    await page.waitReady();

    const measure = (sid) => page.eval(`
        const pane = Array.from(document.querySelectorAll(".session-pane")).find((el) => el.dataset.sessionId === ${JSON.stringify(sid)});
        if (!pane) { return null; }
        return {
            top: Math.round(pane.scrollTop), height: Math.round(pane.scrollHeight), client: Math.round(pane.clientHeight),
            dist: Math.round(pane.scrollHeight - pane.scrollTop - pane.clientHeight),
        };
    `);
    const current = () => page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return pane ? pane.dataset.sessionId : "";
    `);
    const waitFor = async (expr, ms = 20000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            if (await page.eval(expr)) { return true; }
            await sleep(300);
        }
        return false;
    };
    const switchTo = (sid) => page.eval(`window.acquireVsCodeApi().postMessage({ type: "switchSession", sessionId: ${JSON.stringify(sid)} }); return true;`);

    const localId = await current();
    if (!(await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')"))) {
        await page.eval(`window.acquireVsCodeApi().postMessage({ type: "openWorkspace", expanded: [] }); return true;`);
        if (!(await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')"))) {
            throw new Error("侧边栏里没冒出别台那一节");
        }
    }

    // 点开那台那一节里的目录（展开），再点里面那条会话（切过去）
    await page.eval(`document.querySelector('#sidebarDock .pk-space-head.pk-remote-space').click(); return true;`);
    await waitFor("return !!document.querySelector('#sidebarDock .pk-group-session')");
    await page.eval(`document.querySelector('#sidebarDock .pk-group-session').click(); return true;`);
    await waitFor(`return !!(Array.from(document.querySelectorAll(".session-view:not(.off) .session-pane")).find((p) => p.dataset.sessionId !== ${JSON.stringify(localId)}))`);
    await sleep(2500);

    const sid = await current();
    check(!!sid && sid !== localId, "一、点那一行就切到别台那条会话了（" + sid + "）");

    const rows = await page.eval(`
        return Array.from(document.querySelectorAll("#sidebarDock .pk-space-head")).map((el) => ({
            text: (el.querySelector(".pk-history-title") || {}).textContent || "",
            remote: el.classList.contains("pk-remote-space"),
            blue: !!(el.querySelector(".pk-history-title") && el.querySelector(".pk-history-title").classList.contains("pk-space-current")),
        }));
    `);
    const blueFacts = rows.map((one) => (one.blue ? "蓝 " : "   ") + (one.remote ? "[那台] " : "[本机] ") + one.text);
    console.log("    侧边栏里的目录行：" + String.fromCharCode(10) + "      " + blueFacts.join(String.fromCharCode(10) + "      "));
    const remoteRows = rows.filter((one) => one.remote);
    check(remoteRows.filter((one) => one.blue).length === 1, "二、那台那一节里正好一行是蓝的");
    check(rows.filter((one) => !one.remote).every((one) => !one.blue), "二、本机那几行都不是蓝的");

    // 一、拉到最底
    await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        pane.scrollTop = 1e9;
        return true;
    `);
    await sleep(600);
    const first = await measure(sid);
    console.log("    拉到底：" + JSON.stringify(first));
    check(!!first && first.dist === 0, "三、那条会话拉到最底以后确实贴底");

    // 二、切到本机会话再切回来：应当还在最底（以前要等 8 秒才落下去）
    for (let round = 1; round <= 3; round += 1) {
        await switchTo(localId);
        await sleep(1200);
        await switchTo(sid);
        await sleep(1500);
        const back = await measure(sid);
        console.log("    第 " + round + " 次切回来：" + JSON.stringify(back));
        check(!!back && back.dist <= 8, "三、第 " + round + " 次切回来还在最底");
    }

    await page.shot("two-machines-ui.png");
})()
    .catch((err) => {
        console.log("跑挂了：" + ((err && err.stack) || err));
        failed += 1;
    })
    .finally(async () => {
        try { if (page) { await page.close(); } } catch { /* 收摊 */ }
        for (const one of [a, b]) { try { one.child.kill(); } catch { /* 已经退了 */ } }
        if (failed > 0) {
            for (const one of [a, b]) {
                if (!one) { continue; }
                console.log(one.name + " 的日志尾巴：");
                console.log(String(one.log.join("")).split(String.fromCharCode(10)).slice(-12).join(String.fromCharCode(10)));
            }
        }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
        console.log("");
        console.log(failed === 0 ? "全部通过。" : `${failed} 项没通过。`);
        process.exit(failed === 0 ? 0 : 1);
    });

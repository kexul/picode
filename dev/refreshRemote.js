// @ts-nocheck
/**
 * refreshRemote —— 刷新浏览器页面以后，还接着看别台那条会话（别跳回本机会话、正文也还在）。
 *
 * 病根：浏览器页面一刷新就换了新标识，后端不知道它原来在看哪个会话，只能按“最近有人切过去的那个”
 * 猜。可那本账从前只记本机的会话（别台的会话在这台没有进程，也就进不去），于是刷新后跳到本机会话上，
 * 别台那条像是“不见了”。现在别台的会话也算进那本账里（见 chatControllerBase 的 lastViewedId 与
 * ensureClientSession），刷新回来仍是它，正文也按老规矩请那台重画一遍。
 *
 *   npm run compile && node dev/refreshRemote.js
 *
 * 两台真后端（B 用真 pi：假 pi 不读会话文件，那边一条正文都没有，量不出“正文回没回来”）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { openPage, sleep } = require("./cdp.js");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-refresh-"));
const launcher = path.join(repoRoot, "bin", "pichat.js");

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

/** 在那边造一条有内容的会话（那台打开它时才有正文可看）。 */
function writeSession(userHome, cwd, id, turns) {
    const dashed = cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-");
    const out = path.join(userHome, ".pi", "agent", "sessions", "--" + dashed + "--");
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, "2099-03-03T00-00-00-000Z_" + id + ".jsonl");
    const lines = [{ type: "session", id, cwd, timestamp: new Date().toISOString() }];
    for (let i = 0; i < turns; i += 1) {
        lines.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "第 " + (i + 1) + " 问" }] } });
        lines.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "第 " + (i + 1) + " 答" }] } });
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
let open = null;

(async () => {
    writeSession(path.join(bHome, "user"), bWork, "deadbeef-3333-4000-8000-0000000c0001", 8);
    b = startBackend("B", bHome, bWork, "pi");
    const urlB = await waitUrl(b);
    fs.mkdirSync(aHome, { recursive: true });
    fs.writeFileSync(path.join(aHome, "config.json"), JSON.stringify({ label: "B", machines: [urlB] }, null, 2));
    a = startBackend("A", aHome, aWork);
    const urlA = await waitUrl(a);
    await sleep(1500);

    open = await openPage({ url: urlA, width: 1000, height: 800 });
    const page = open.page;
    await page.waitReady();

    const waitFor = async (expr, ms = 20000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            if (await page.eval(expr)) { return true; }
            await sleep(200);
        }
        return false;
    };
    /** 现在正文里显示的是哪条会话（没有正显示的就是空串）。 */
    const current = () => page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return pane ? pane.dataset.sessionId : "";
    `);
    /** 页面上助手气泡有几条（量“正文回没回来”）。 */
    const answers = () => page.eval(`
        return document.querySelectorAll(".session-view:not(.off) .msg.assistant").length;
    `);

    const localId = await current();
    if (!(await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')"))) {
        await page.eval(`window.acquireVsCodeApi().postMessage({ type: "openWorkspace", expanded: [] }); return true;`);
        await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')");
    }
    // 点开那台那一节里的目录（展开），再点里面那条会话（切过去）
    await page.eval(`document.querySelector('#sidebarDock .pk-space-head.pk-remote-space').click(); return true;`);
    await waitFor("return !!document.querySelector('#sidebarDock .pk-group-session')");
    await page.eval(`document.querySelector('#sidebarDock .pk-group-session').click(); return true;`);
    await waitFor(`return !!(Array.from(document.querySelectorAll(".session-view:not(.off) .session-pane")).find((p) => p.dataset.sessionId !== ${JSON.stringify(localId)}))`);
    await sleep(2500);
    const sid = await current();
    check(!!sid && sid !== localId, "前置：点那一行就切到别台那条会话了（" + sid + "）");
    const before = await answers();
    check(before > 0, "前置：那条会话的正文已经画出来了（" + before + " 条回答）");

    // 刷新页面
    await open.cdp.send("Page.reload", {});
    await sleep(1200);
    await page.waitReady();
    await sleep(2500);

    const after = await current();
    const shell = await page.eval(`
        return Array.from(document.querySelectorAll(".session-pane")).map((el) => el.dataset.sessionId);
    `);
    check(after === sid, "一、刷新回来还在看别台那条（" + after + "）");
    check(shell.indexOf(sid) >= 0, "二、顶条/窗格里还有它那一份画面壳");
    const answersAfter = await answers();
    check(answersAfter === before, "三、正文也回来了（" + answersAfter + " 条回答，应为 " + before + " 条）");

    await page.shot("refresh-remote.png");
})()
    .catch((err) => {
        console.log("跑挂了：" + ((err && err.stack) || err));
        failed += 1;
    })
    .finally(async () => {
        try { if (open) { await open.close(); } } catch { /* 收摊 */ }
        for (const one of [a, b]) { try { if (one) { one.child.kill(); } } catch { /* 已经退了 */ } }
        if (failed > 0) {
            for (const one of [a, b]) {
                if (!one) { continue; }
                console.log(one.name + " 的日志尾巴：");
                console.log(String(one.log.join("")).split("\n").slice(-12).join("\n"));
            }
        }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
        console.log("");
        console.log(failed === 0 ? "全部通过。" : `${failed} 项没通过。`);
        process.exit(failed === 0 ? 0 : 1);
    });

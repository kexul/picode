// @ts-nocheck
/**
 * newSessionRemote —— 输入框左头那颗加号，在“别台的会话”里点，要跟本机一个规矩：
 * 在同一个目录里开一个新的、切过去，旧的那个没在跑就一起关掉。
 *
 * 病根（改之前）：页面点加号发的 `newSession` 不带会话号，后端按“这块屏看的会话的目录”取；
 * 而别台的会话在这台上没有进程（见 chatControllerBase 的 getActive），取到的是空，
 * 于是回落到本机后端自己的默认目录 —— 在本机开了一个跟当前工作区无关的会话，
 * 那台那条会话还留在顶条上，人以为是在那台里接着干。
 *
 * 现在这条路：那块屏看的是别台的会话 → 请那台在同一个目录里开一个（machineHub.newSession），
 * 等它报上新清单认领下来再切过去，并把旧的那个（没在跑的话）在那台上关掉。
 *
 *   npm run compile && node dev/newSessionRemote.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { openPage } = require("./cdp.js");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-newremote-"));
const launcher = path.join(repoRoot, "bin", "pichat.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);
const sameDir = (a, b) => path.resolve(a || ".").toLowerCase() === path.resolve(b || ".").toLowerCase();

function startBackend(name, home, work) {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const child = spawn(process.execPath, [launcher, "--no-open", "--cwd", work, "--port", "0", "--host", "127.0.0.1"], {
        cwd: repoRoot,
        // 两台各自一个 HOME：不然两边扫的是同一份 ~/.pi 会话目录
        env: {
            ...process.env,
            HOME: path.join(home, "user"),
            USERPROFILE: path.join(home, "user"),
            PICHAT_HOME: home,
            PICHAT_PI: process.env.PICHAT_PI || path.join(repoRoot, "dev", "fake-pi.cmd"),
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

/** 在那边盘上造一条会话（侧边栏里点得到它，才有一格别台的会话可看）。 */
function writeSession(userHome, cwd, id) {
    const dashed = cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-");
    const out = path.join(userHome, ".pi", "agent", "sessions", "--" + dashed + "--");
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, "2099-03-04T00-00-00-000Z_" + id + ".jsonl");
    const lines = [{ type: "session", id, cwd, timestamp: new Date().toISOString() }];
    lines.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "别台上的这一句" }] } });
    lines.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "别台上的这一答" }] } });
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
let pageB = null;

(async () => {
    writeSession(path.join(bHome, "user"), bWork, "deadbeef-4444-4000-8000-0000000d0001");
    b = startBackend("B", bHome, bWork);
    const urlB = await waitUrl(b);
    fs.mkdirSync(aHome, { recursive: true });
    fs.writeFileSync(path.join(aHome, "config.json"), JSON.stringify({ label: "B", machines: [urlB] }, null, 2));
    a = startBackend("A", aHome, aWork);
    const urlA = await waitUrl(a);
    await sleep(1500);

    const open = await openPage({ url: urlA, width: 1400, height: 900 });
    page = open.page;
    await page.waitReady();

    const current = () => page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return pane ? pane.dataset.sessionId : "";
    `);
    const tabs = () => page.eval(`
        return Array.from(document.querySelectorAll("#sessionTabs .sn-tab"))
            .filter((el) => !el.classList.contains("hidden"))
            .map((el) => ({
                text: (el.querySelector(".sn-text") || {}).textContent || "",
                cwd: el.dataset.cwd || "",
                current: el.classList.contains("current"),
            }));
    `);
    const waitFor = async (expr, ms = 20000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            if (await page.eval(expr)) { return true; }
            await sleep(300);
        }
        return false;
    };

    // —— 前置：点开那台那一节里的那条会话，切过去（这一格就是“别台的会话”）——
    if (!(await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')"))) {
        await page.eval(`window.acquireVsCodeApi().postMessage({ type: "openWorkspace", expanded: [] }); return true;`);
        if (!(await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')"))) {
            throw new Error("侧边栏里没冒出别台那一节");
        }
    }
    await page.eval(`document.querySelector('#sidebarDock .pk-space-head.pk-remote-space').click(); return true;`);
    await waitFor("return !!document.querySelector('#sidebarDock .pk-group-session')");
    await page.eval(`document.querySelector('#sidebarDock .pk-group-session').click(); return true;`);
    await sleep(2500);

    const oldId = await current();
    check(!!oldId && oldId.startsWith("remote:"), "前置：当前看的是那台上的会话（" + oldId + "）");
    const hasView = (sid) => page.eval(`return !!document.querySelector('.session-view[data-session-id="' + ${JSON.stringify(sid)} + '"]');`);
    check(await hasView(oldId), "前置：旧那个会话的画面还在");
    const before = await tabs();
    console.log("    点加号之前顶条上的格：" + JSON.stringify(before.map((one) => one.text + " @" + one.cwd)));
    const localBefore = before.filter((one) => sameDir(one.cwd, aWork)).length;

    // —— 点输入框左头那颗加号 ——
    await page.eval(`document.getElementById("newSessionBtn").click(); return true;`);
    const changed = await waitFor(`return (() => {
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return !!pane && pane.dataset.sessionId !== ${JSON.stringify(oldId)};
    })()`, 20000);
    await sleep(2500);
    check(changed, "一点加号就换到了新会话");

    const newId = await current();
    const after = await tabs();
    console.log("    点完加号顶条上的格：" + JSON.stringify(after.map((one) => one.text + " @" + one.cwd)));

    // 一、新会话在那台上（本机开出来的号里没有 remote: 前缀）
    check(newId.startsWith("remote:" + urlB + ":"), "一、新会话开在那台上（" + newId + "）");

    // 二、而且就在原来那个目录里
    const newTab = after.find((one) => one.current);
    check(!!newTab && sameDir(newTab.cwd, bWork), "二、新会话跑在同一个目录里（" + (newTab && newTab.cwd) + "）");

    // 三、旧的那个没在跑，一起关掉：顶条上不再有它那一格（它那一整份画面都摘掉了）
    check(!(await hasView(oldId)), "三、旧的那一格已经不在了");

    // 四、本机没有因此多出会话
    check(after.filter((one) => sameDir(one.cwd, aWork)).length === localBefore,
        "四、本机的会话数没变（" + localBefore + " → " + after.filter((one) => sameDir(one.cwd, aWork)).length + "）");

    // 五、那台上是真的关掉了：另开一个页面直接看那台，它那一格也没了
    const oldRemoteId = oldId.slice(("remote:" + urlB + ":").length);
    pageB = (await openPage({ url: urlB, width: 1000, height: 700 })).page;
    await pageB.waitReady();
    await sleep(2000);
    const tabsB = () => pageB.eval(`
        return Array.from(document.querySelectorAll(".session-pane")).map((el) => el.dataset.sessionId);
    `);
    const hasOldB = (await tabsB()).includes(oldRemoteId);
    check(!hasOldB, "五、那台上那条会话也已经关掉（" + oldRemoteId + " 不在它的清单里）");

    await page.shot("new-session-remote.png");
})()
    .catch((err) => {
        console.log("跑挂了：" + ((err && err.stack) || err));
        failed += 1;
    })
    .finally(async () => {
        try { if (page) { await page.close(); } } catch { /* 收摊 */ }
        try { if (pageB) { await pageB.close(); } } catch { /* 收摊 */ }
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

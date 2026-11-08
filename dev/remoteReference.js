// @ts-nocheck
/**
 * remoteReference —— # 引用菜单里也要有别台那些会话（引用了给模型的是那台盘上的路径）。
 *
 * 病根：`#` 引用目录（getChatReferenceItems）从前只遍历本机的 panels，别台的会话在这台没有进程，
 * 就永远进不了菜单；就算进了，拼内容那一段也是问本机进程要会话文件、还要 stat 一下大小，别台那条
 * 一律拿不到。于是“引用另一条会话”这个功能在远程会话里等于没有。
 *
 * 现在：引用目录里把别台认下的那些也列上（附注写那台的名字）；拼内容时问对地方 —— 本机问它的 pi 进程，
 * 别台用那台报来的会话文件路径（模型在那边跑，那个路径它读得到，大小这边看不见就不写）。
 *
 *   npm run compile && node dev/remoteReference.js
 *
 * 两台真后端（B 用真 pi：会话文件是它读进来、报出来的那份）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { openPage, sleep } = require("./cdp.js");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-rref-"));
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

function writeSession(userHome, cwd, id, title, stamp) {
    const dashed = cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-");
    const out = path.join(userHome, ".pi", "agent", "sessions", "--" + dashed + "--");
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, (stamp || "2099-03-03T00-00-00-000Z") + "_" + id + ".jsonl");
    const lines = [
        { type: "session", id, cwd, timestamp: new Date().toISOString() },
        { type: "message", message: { role: "user", content: [{ type: "text", text: title }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: title + " —— 回答" }] } },
    ];
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
    writeSession(path.join(bHome, "user"), bWork, "deadbeef-6666-4000-8000-0000000c0001", "B 的旧会话", "2099-06-06T00-00-00-000Z");
    const newer = writeSession(path.join(bHome, "user"), bWork, "deadbeef-6666-4000-8000-0000000c0002", "B 的新会话", "2099-06-07T00-00-00-000Z");

    fs.mkdirSync(bHome, { recursive: true });
    fs.writeFileSync(path.join(bHome, "config.json"), JSON.stringify({ label: "B" }, null, 2));
    b = startBackend("B", bHome, bWork, "pi");
    const urlB = await waitUrl(b);
    fs.mkdirSync(aHome, { recursive: true });
    fs.writeFileSync(path.join(aHome, "config.json"), JSON.stringify({ label: "B", machines: [urlB] }, null, 2));
    a = startBackend("A", aHome, aWork);
    const urlA = await waitUrl(a);
    await sleep(1500);

    open = await openPage({ url: urlA, width: 1200, height: 900 });
    const page = open.page;
    await page.waitReady();

    const waitFor = async (expr, ms = 30000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            if (await page.eval(expr)) { return true; }
            await sleep(200);
        }
        return false;
    };
    const current = () => page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return pane ? pane.dataset.sessionId : "";
    `);

    const localId = await current();
    if (!(await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')"))) {
        await page.eval(`window.acquireVsCodeApi().postMessage({ type: "openWorkspace", expanded: [] }); return true;`);
        await waitFor("return !!document.querySelector('#sidebarDock .pk-space-head.pk-remote-space')");
    }
    await page.eval(`document.querySelector('#sidebarDock .pk-space-head.pk-remote-space').click(); return true;`);
    const openFromSidebar = async (title) => {
        await waitFor(`
            const rows = Array.from(document.querySelectorAll("#sidebarDock .pk-item.pk-group-session"));
            return rows.some((el) => el.innerText.indexOf(${JSON.stringify(title)}) >= 0);
        `);
        await page.eval(`
            const rows = Array.from(document.querySelectorAll("#sidebarDock .pk-item.pk-group-session"));
            const row = rows.find((el) => el.innerText.indexOf(${JSON.stringify(title)}) >= 0);
            if (row) { row.click(); }
            return !!row;
        `);
        await sleep(3000);
        return current();
    };
    // 两条都在这边打开（# 引用菜单列的就是开着的会话，跟本机一个规矩）；
    // 最后看的是“新会话”，下一步引用的就是另一条“旧会话”
    await openFromSidebar("B 的旧会话");
    const sid = await openFromSidebar("B 的新会话");
    check(!!sid && sid.indexOf("remote:") === 0, "前置：现在看的是那台上的「B 的新会话」（" + sid + "）");

    // 在输入框里敲一个 #：菜单里应当有那台的另一条会话（附注写着那台的名字）
    await page.eval(`document.getElementById('input').focus(); return true;`);
    await page.type("#");
    await waitFor("return document.querySelectorAll('#fileMenu .file-item, .file-menu .file-item').length > 0", 8000);
    const menu = await page.eval(`
        return Array.from(document.querySelectorAll(".file-item")).map((el) => ({
            text: el.innerText.replace(/[\s ]+/g, " ").trim(),
            sub: ((el.querySelector(".dir") || {}).textContent || "").trim(),
        }));
    `);
    console.log("    # 菜单：" + JSON.stringify(menu));
    // 那台那条：附注写的是那台的名字（本机那些行没有附注）
    const remoteRow = menu.find((one) => one.sub === "B");
    check(!!remoteRow, "一、# 菜单里列出了那台那条会话");
    const remoteLabel = remoteRow ? remoteRow.text.replace(/[\s ]*B$/, "").trim() : "";
    check(!!remoteLabel, "一、那一行带着那台的名字（" + (remoteRow ? remoteRow.text : "") + "）");

    // 点它：草稿里多一张引用卡片，正文是那台那个会话文件的路径
    await page.eval(`
        const rows = Array.from(document.querySelectorAll(".file-item"));
        const row = rows.find((el) => ((el.querySelector(".dir") || {}).textContent || "").trim() === "B");
        // 菜单那几行认的是 mousedown（见 media/chat.js 的 renderHashMenu）
        if (row) { row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); }
        return !!row;
    `);
    const gotCard = await waitFor("return !!document.querySelector('.text-block .tb-title')", 15000);
    check(gotCard, "二、点一下就变成草稿里的一张引用卡片");
    const card = await page.eval(`
        const el = document.querySelector(".text-block");
        if (!el) { return null; }
        return {
            title: (el.querySelector(".tb-title") || {}).innerText || "",
            body: (el.querySelector(".tb-body") || {}).innerText || "",
        };
    `);
    console.log("    卡片标题：" + (card && card.title));
    console.log("    卡片正文：" + (card && card.body.replace(/\\s+/g, " ").slice(0, 160)));
    check(!!card && !!remoteLabel && card.title.indexOf(remoteLabel) >= 0, "三、卡片标题是那条会话的名字（" + remoteLabel + "）");
    const olderFile = path.basename(path.join(bWork, "x")).length > 0 ? "2099-06-06T00-00-00-000Z_deadbeef-6666-4000-8000-0000000c0001.jsonl" : "";
    check(!!card && card.body.indexOf(olderFile) >= 0, "三、正文里是那台那个会话文件的路径（" + olderFile + "）");
    check(!!card && card.body.indexOf(":/") >= 0, "三、路径是那台的写法（盘符开头）");

    // 本机那条：先真跑一轮（假 pi 收到消息才把它那个 .jsonl 写出来，# 引用才有文件可指）
    const switchTo = (id) => page.eval(`window.acquireVsCodeApi().postMessage({ type: "switchSession", sessionId: ${JSON.stringify(id)} }); return true;`);
    await switchTo(localId);
    await waitFor(`return (() => { const p = document.querySelector(".session-view:not(.off) .session-pane"); return !!p && p.dataset.sessionId === ${JSON.stringify(localId)}; })()`, 20000);
    await page.waitReady();
    await page.send("本机先跑一轮");
    await page.waitAnswer(undefined, 60000);
    await switchTo(sid);
    await waitFor(`return (() => { const p = document.querySelector(".session-view:not(.off) .session-pane"); return !!p && p.dataset.sessionId === ${JSON.stringify(sid)}; })()`, 20000);
    await sleep(800);
    // 本机那条也再引一次：确认改写之后本机这半还是老样子（标题带体积、正文带“约 xx”）
    await page.eval(`document.getElementById('input').focus(); return true;`);
    await page.type("#");
    await waitFor("return document.querySelectorAll('.file-item').length > 0", 8000);
    const localClicked = await page.eval(`
        const rows = Array.from(document.querySelectorAll(".file-item"));
        const row = rows.find((el) => !((el.querySelector(".dir") || {}).textContent || "").trim());
        if (row) { row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); }
        return !!row;
    `);
    const twoCards = localClicked ? await waitFor("return document.querySelectorAll('.text-block').length === 2", 15000) : false;
    const localCard = await page.eval(`
        const el = document.querySelectorAll(".text-block")[1];
        if (!el) { return null; }
        return {
            title: (el.querySelector(".tb-title") || {}).innerText || "",
            body: (el.querySelector(".tb-body") || {}).innerText || "",
        };
    `);
    console.log("    本机那张：" + (localCard && localCard.title) + " / " + (localCard && localCard.body.replace(/[\s ]+/g, " ").slice(0, 120)));
    check(twoCards, "四、本机那条也引得了（草稿里两张卡片）");
    check(!!localCard && /约/.test(localCard.body), "四、本机这张正文里带着体积（约 xx）");

    await page.shot("remote-reference.png");
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

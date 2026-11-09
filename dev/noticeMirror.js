// @ts-nocheck
/**
 * noticeMirror —— 验右下角那张提醒卡片在后端的这一份账（它以前是“屏幕上有什么，后端一概不知道”）。
 *
 *   node dev/noticeMirror.js
 *
 * 三处以前各说各话、现在要咬合在一起：
 *   一、屏幕上本来没那张卡时，“收掉它”不许把已经退了的小程序再拉起来一支
 *       （收垃圾动作顺手拉起一个看不见的窗口，是原来的毛病）；
 *   二、推给别台那张卡片的钥匙里带着“推的那一刻的标签”：中途在设置里改了标签，
 *       收的时候还得用旧的，不然那台永远收不掉；
 *   三、小程序那边自己收掉一张（三张挤掉最老、或者人点了那颗叉）要告诉后端，
 *       后端那份镜像跟着删 —— 不然它以为还开着，后面就不再写 close 了。
 *       这里验“挤掉最老”那一条（点叉得人去点窗口，脚本点不了）。
 *
 * 真起后端、真弹卡片（要 Windows + bin/notice.exe）。只有假模型，会话与网页服务都是真的。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { execSync } = require("child_process");
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

const CONFIG_FILE = path.join(__dirname, ".scratch", "pichat", "config.json");

/** 现在有几支 notice.exe（没弹卡片时应当是 0）。 */
function noticeCount() {
    try {
        const out = execSync('tasklist /FI "IMAGENAME eq notice.exe" /NH', { encoding: "utf8", windowsHide: true });
        return out.split(/\r?\n/).filter((line) => /notice\.exe/i.test(line)).length;
    } catch {
        return 0;
    }
}

async function main() {
    if (process.platform !== "win32") {
        console.log("这台不是 Windows：右下角那张卡片本来就不弹，这条不用验。");
        return;
    }
    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };

    const before = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, "utf8") : undefined;
    const got = [];
    const receiver = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            try { got.push(JSON.parse(body)); } catch { got.push({}); }
            res.writeHead(204, { "Cache-Control": "no-store" });
            res.end();
        });
    });
    await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const port = receiver.address().port;

    const harness = createHarness({ fakePi: true, port: 0, log: () => { /* 安静跑 */ } });
    let open;
    /** 跑之前「弹窗通知」是开的还是关的（跑完拨回去，不给下一个脚本留意外状态）。 */
    let notifyWas = true;
    try {
        // 推送地址与标签先写进设置文件（跑完放回原样）
        let config = {};
        try { config = JSON.parse(before || "{}"); } catch { config = {}; }
        config.label = "卡片这台";
        config.notify = { ...(config.notify || {}), pushTo: [`http://127.0.0.1:${port}`] };
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");

        const url = await harness.start();
        const host = harness.host();

        // 「弹窗通知」开关就在后端这份存储里（默认开）：这里要用真的开关把它拨开。
        // （开发目录里可能被别的脚本关过；一开始就是开的就不动它。）
        const notifyWas0 = host.getNotifyTurnEnd();
        notifyWas = notifyWas0;
        if (!notifyWas0) { host.mutateViewOption("notifyTurnEnd"); }
        check(host.getNotifyTurnEnd() === true, "把「弹窗通知」拨开以后，后端读到的还是关的");

        // ---- 一、屏幕上没那张卡时，“收掉”不许拉起小程序 ----
        const n0 = noticeCount();
        host.onUserMessage("根本没有这个会话");
        await sleep(800);
        const n1 = noticeCount();
        check(n1 === n0, `收一张不存在的卡片，凭空多出来 ${n1 - n0} 支 notice.exe（应当一支不多）`);
        check(host.notice.shownKeys().length === 0, "一张卡都没弹过，后端那份镜像里却有东西");
        console.log("  一、收一张不存在的卡：notice.exe " + n0 + " 支 → " + n1 + " 支");

        // ---- 二、标签：推的时候存，收的时候用存着的那个 ----
        open = await openPage({ url, timeoutMs: 60000 });
        const page = open.page;
        await page.waitReady();
        await page.send("你好");
        for (let i = 0; i < 200; i++) {
            const st = await page.eval(`return (document.getElementById("ctxIcon") || {}).dataset?.st || "";`);
            if (st === "idle") { break; }
            await sleep(100);
        }
        const sessionId = [...host.panels.keys()].find((id) => !host.taba.byChildPanel(id));
        check(!!sessionId, "一个会话都没有，后面几条没法验");
        if (!sessionId) { throw new Error("没法验：没有会话"); }

        let pushed;
        for (let i = 0; i < 100 && !pushed; i++) {
            pushed = got.find((one) => one.sessionId === sessionId && !one.close);
            if (!pushed) { await sleep(100); }
        }
        check(!!pushed, "这一轮跑完了，推送地址那边一条也没收到");
        if (pushed) {
            check(pushed.label === "卡片这台", `推过去那条的标签是 ${JSON.stringify(pushed.label)}，应当是推的那一刻的「卡片这台」`);
        }
        // 中途改标签，再让这个会话“说上话”（提醒作废、要推一条收掉过去）
        host.mutateViewOption("machineLabel", "改过名的这台");
        await sleep(200);
        const asked = got.length;
        host.onUserMessage(sessionId);
        let recall;
        for (let i = 0; i < 100 && !recall; i++) {
            recall = got.slice(asked).find((one) => one.close === true);
            if (!recall) { await sleep(100); }
        }
        check(!!recall, "改完标签再收那张卡，一条“收掉”也没推过去");
        if (recall) {
            check(recall.label === "卡片这台", `“收掉”那条带的是现在的标签 ${JSON.stringify(recall.label)}，那台就收不掉了（该用推的时候那个）`);
        }
        console.log("  二、改标签后收卡：推出去的“收掉”标签 = " + JSON.stringify(recall && recall.label));

        // ---- 三、小程序那边自己挤掉最老的，后端镜像跟着删 ----
        for (const id of ["m1", "m2", "m3", "m4"]) {
            host.acceptRemoteNotice({ label: "家里", sessionId: id, name: "会话" + id, text: "干完了", kind: "done" });
            await sleep(150);
        }
        // 屏幕上最多三张：第四张进来时最老的那张被挤掉，小程序该回一条 closed 过来
        let keys = host.notice.shownKeys();
        for (let i = 0; i < 50 && keys.length !== 3; i++) {
            await sleep(100);
            keys = host.notice.shownKeys();
        }
        check(keys.length === 3, `弹了四张以后后端镜像里该剩三张（最老的被挤掉），实际 ${keys.length} 张：${JSON.stringify(keys)}`);
        console.log("  三、弹四张以后后端镜像：" + JSON.stringify(keys));

        if (problems.length) {
            console.log("");
            console.log("有问题（" + problems.length + " 条）：");
            for (const p of problems) { console.log("  ! " + p); }
            throw new Error("提醒卡片这份账没验过：" + problems.length + " 条");
        }
        console.log("");
        console.log("提醒卡片：收不存在的卡不拉起小程序、收卡用推的时候那个标签、小程序自己收掉的后端跟着删，都对上了。");
    } finally {
        if (open) { try { await open.close(); } catch { /* 收摊出错不拦路 */ } }
        try { await harness.stop(); } catch { /* 收摊出错不拦路 */ }
        receiver.close();
        try {
            if (before === undefined) { fs.rmSync(CONFIG_FILE, { force: true }); }
            else { fs.writeFileSync(CONFIG_FILE, before, "utf8"); }
        } catch { /* 放不回去就算了 */ }
        // 开关拨回原来的样子（开发目录别留给下一个脚本一个意外状态）
        try {
            const host = harness.host();
            if (host && host.getNotifyTurnEnd() !== notifyWas) { host.mutateViewOption("notifyTurnEnd"); }
        } catch { /* 收摊了就算了 */ }
    }
}

main().catch((err) => {
    console.error("出错了：" + (err && err.message ? err.message : String(err)));
    process.exit(1);
});

// @ts-nocheck
/**
 * liveDrop —— 验「桌面实时画面的帧在页面读得慢时整条丢掉」这条账。
 *
 *   npm run compile && node dev/liveDrop.js
 *
 * 纯 Node（不开浏览器、不叫模型、不拍桌面）：起一个真后端（会话目录用临时目录，
 * PICHAT_HOME 指到临时目录），然后
 *
 *   一、门槛本身：积压过了 128 KB 时，可丢的那类消息一个字都不往连接里写；别的消息照写；
 *       积压没过线时可丢的也不丢（画面该动就动）。
 *   二、真连接：开一条 /events 但不读（页面读得慢的样子），灌一大段把积压顶上去，
 *       确认这个门槛真会被摸到 —— 不是永远判不到的死条件。
 *   三、真连接 + 真消息：积压过线时推一帧实时画面，连接里的字节不涨；紧接着推一条
 *       普通消息（assistantDelta），字节照涨。这就是这一条改动的全部承诺：
 *       画面可以被丢弃，正经内容一条都不能少。
 *
 * 为什么要这条：它是「页面读得慢」时才走的那条路，平时永远碰不到；写错了只会
 * 在手机网络差的那一刻表现成「画面卡住 / 整屏重画」，跑起来一声不响。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-livedrop-"));
process.env.PICHAT_HOME = path.join(tmpRoot, "pichat");
const workDir = path.join(tmpRoot, "work");
fs.mkdirSync(workDir, { recursive: true });

const { startBackend } = require(path.join(repoRoot, "out", "server", "serverMain.js"));

/** 门槛（跟 webChatServer.ts 里的 STREAM_STALE_BYTES 一致）。 */
const STALE_BYTES = 128 * 1024;

let failed = 0;
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取一小段页面 HTML（够找出页面标识就行）。 */
function fetchText(url, maxBytes = 65536) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                text += chunk;
                if (text.length >= maxBytes) {
                    res.destroy();
                    resolve(text);
                }
            });
            res.on("end", () => resolve(text));
        });
        req.on("error", reject);
    });
}

/** 一个假连接：只记写进来的东西（给第一部分用）。 */
function fakeStream(backlog) {
    const writes = [];
    return { writes, get backlog() { return backlog; }, write: (text) => { writes.push(text); return "ok"; } };
}

async function main() {
    const started = await startBackend({ cwd: workDir, port: 0, host: "127.0.0.1", log: () => {} });
    const server = started.server;
    const broadcaster = started.host.getBroadcaster();
    let eventsReq = null;
    try {
        // ====================================================================
        //  一、门槛本身
        // ====================================================================
        console.log("【一】积压过线时，可丢的那类消息（实时画面的帧）不写；别的照写");
        {
            const channel = { id: "p-fake", close: () => {} };
            const write = (stream, chunk, droppable) => server["writeChunk"](channel, stream, chunk, droppable);

            const busy = fakeStream(STALE_BYTES + 100 * 1024);
            write(busy, "event: msg\n", true);
            check(busy.writes.length === 0, "积压 " + Math.round(busy.backlog / 1024) + " KB 时，可丢的一条都没写");

            const busy2 = fakeStream(STALE_BYTES + 100 * 1024);
            write(busy2, "event: msg\n", false);
            check(busy2.writes.length === 1, "同样积压下，不可丢的照写（内容不能少）");

            const calm = fakeStream(10 * 1024);
            write(calm, "event: msg\n", true);
            check(calm.writes.length === 1, "积压才 " + Math.round(calm.backlog / 1024) + " KB 时，可丢的照常写（画面该动就动）");
        }

        // ====================================================================
        //  二、真连接：把积压顶上去，看这个门槛摸不摸得到
        // ====================================================================
        console.log("【二】真连接（不读）上灌一大段：积压确实会过线");
        const pageId = (await fetchText(started.url)).match(/name="pichat-page" content="([^"]+)"/)?.[1] ?? "";
        check(pageId !== "", "取到页面标识：" + pageId);

        const res = await new Promise((resolve, reject) => {
            eventsReq = http.request(started.url + "events?pageId=" + encodeURIComponent(pageId), (r) => resolve(r));
            eventsReq.setTimeout(5000, () => reject(new Error("推送连接没接上")));
            eventsReq.on("error", reject);
            eventsReq.end();
        });
        res.pause();   // 页面读得慢：从这一刻起一个字节都不读
        await sleep(200);

        const stream = server["streams"].get(pageId);
        check(!!stream, "服务那头记着这条推送连接");
        if (!stream) { throw new Error("没有推送连接，后面的验不了"); }

        // 灌到积压过线：客户端不读，这些字节只能堆在连接里。一次灌一大段是因为本机来回的
        // 内核缓冲比想象中大（一次 2 MB 它能一口吞下去），得灌到它真吞不下为止
        let poured = 0;
        while (stream.backlog <= STALE_BYTES && poured < 32 * 1024 * 1024) {
            stream.write("x".repeat(1024 * 1024));
            poured += 1024 * 1024;
            await sleep(100);
        }
        check(stream.backlog > STALE_BYTES,
            "灌了 " + Math.round(poured / 1024 / 1024) + " MB，积压 " + Math.round(stream.backlog / 1024) +
            " KB，过了 " + Math.round(STALE_BYTES / 1024) + " KB 那条线");

        // ====================================================================
        //  三、真消息：过线时帧不写、普通消息照写
        // ====================================================================
        console.log("【三】积压过线时推一帧画面：连接里一个字都不多；推一条普通消息：照涨");
        {
            const before = stream.backlog;
            broadcaster.sendTo(pageId, { type: "desktopLiveFrame", data: "A".repeat(30000), mimeType: "image/jpeg" });
            const after = stream.backlog;
            check(after - before < 1024,
                "推一帧画面（约 30 KB）：积压从 " + Math.round(before / 1024) + " KB 变成 " + Math.round(after / 1024) + " KB");

            const before2 = stream.backlog;
            broadcaster.sendTo(pageId, { type: "assistantDelta", delta: "y".repeat(30000) });
            const after2 = stream.backlog;
            check(after2 - before2 > 10 * 1024,
                "推一条普通消息（同样 30 KB）：积压涨了 " + Math.round((after2 - before2) / 1024) + " KB，没被丢");
        }
    } finally {
        try { eventsReq?.destroy(); } catch { /* 已经断了 */ }
        await started.stop(true);
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
    }

    console.log(failed === 0 ? "\n全过了。" : `\n有 ${failed} 条没过。`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
    console.error("跑挂了：" + (err?.stack || err));
    process.exitCode = 1;
});

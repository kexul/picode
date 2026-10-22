// @ts-nocheck
/**
 * childSessions —— 验「历史列表那两件事」：扫描结果的缓存、子会话靠清单认。
 *
 *   npm run compile && node dev/childSessions.js
 *
 * 纯 Node（不开浏览器、不起 pi）：直接把编好的 sessionStore / childSessions 拿来用，
 * PICHAT_HOME 指到临时目录，验完就删。
 *
 * 验的几条：
 *   - 同一个会话文件第二次扫不再读文件（缓存命中），文件改过以后结果跟着变；
 *   - 子会话两种认法：清单里记过（判官那种不走那套文案的也认得出来）、
 *     老会话靠第一条用户消息里那句收尾要求（兜底还在）；
 *   - 已经扫过、记了缓存的条目，清单后来才记上它时也要立刻改口；
 *   - “启动时自动打开最近会话”那条路查清单就够，不读文件；
 *   - 文件被删掉时扫不出来，但不抛错。
 *
 * 为什么要这条：这两条都属于「不看界面、跑起来也不报错」的静默行为 —— 缓存卡住了没人看得见，
 * 子会话没认出来只会让历史列表里多一行。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-child-"));
process.env.PICHAT_HOME = path.join(tmpRoot, "pichat");
const sessionsDir = path.join(tmpRoot, "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

const out = path.join(repoRoot, "out", "server");
const sessionStore = require(path.join(out, "sessionStore.js"));
const childSessions = require(path.join(out, "childSessions.js"));

// 数一数到底读了几次文件：缓存命中时不该再 createReadStream
const realCreate = fs.createReadStream;
let opens = 0;
fs.createReadStream = function (...args) {
    opens += 1;
    return realCreate.apply(this, args);
};

/** 铺一个会话文件：第一行是 header，后面是消息。 */
function writeSession(name, firstUserText, extraMessages = 0, opts = {}) {
    const file = path.join(sessionsDir, name + ".jsonl");
    const lines = [
        JSON.stringify({ type: "session", id: name, cwd: opts.cwd || tmpRoot }),
        JSON.stringify({
            type: "message",
            timestamp: new Date().toISOString(),
            message: { role: "user", content: [{ type: "text", text: firstUserText }], timestamp: Date.now() },
        }),
    ];
    for (let i = 0; i < extraMessages; i += 1) {
        lines.push(JSON.stringify({
            type: "message",
            timestamp: new Date().toISOString(),
            message: { role: "assistant", content: [{ type: "text", text: "回复 " + i }], timestamp: Date.now() },
        }));
    }
    // 后面再追加的条目（改名、超长消息、没带换行的那一行）：测试里各取所需
    for (const extra of opts.append || []) { lines.push(JSON.stringify(extra)); }
    fs.writeFileSync(file, lines.join("\n") + (opts.noTrailingNewline ? "" : "\n"), "utf8");
    return file;
}

const plain = writeSession("普通会话", "帮我看看这个项目", 3);
// 老会话：第一条用户消息就是派活那套文字（见 src/tabaTask.ts）
const dispatched = writeSession(
    "派活的子会话",
    "【任务】\n\n摸一下认证模块\n\n---\n\n【收尾要求】\n\n你跑完这一轮以后，你的最后一条回复会被自动送回去。",
    2
);
// 判官：任务说明不走那套文案（rawTask），所以只能靠清单认
const judge = writeSession("判官", "【验收第 1 轮】你是判官：验工人这一轮的活，别自己动手改。", 1);
// 后面才改过名的：标题要取最新那一次（不是第一条用户消息）
const renamed = writeSession("改过名的", "第一句", 2, {
    append: [{ type: "session_info", name: "后来起的名字", timestamp: new Date().toISOString() }],
});
// 中间隔了一条超大消息（超过一块 1MB），末尾才改名：半行跨块的那条路子
const bigLine = writeSession("超大消息后面改名", "第一句", 0, {
    append: [
        { type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1200 * 1024) }], timestamp: Date.now() } },
        { type: "session_info", name: "大消息之后的名字" },
    ],
});
// 最后一行没带换行
const noNewline = writeSession("末行没换行", "第一句", 1, {
    append: [{ type: "session_info", name: "没有结尾换行的名字" }],
    noTrailingNewline: true,
});
// 改名被显式清空（name 空串）：退回第一条用户消息
const cleared = writeSession("名字被清空", "就用这一句", 1, {
    append: [{ type: "session_info", name: "" }],
});
// 第一行不是 header：整个文件不认
const notSession = path.join(sessionsDir, "坏文件.jsonl");
fs.writeFileSync(notSession, JSON.stringify({ type: "message", message: { role: "user", content: [] } }) + "\n", "utf8");

(async () => {
    const checks = [];

    // ---- 缓存 ----
    opens = 0;
    const first = await sessionStore.scanSessionInfo(plain);
    const firstOpens = opens;
    opens = 0;
    const second = await sessionStore.scanSessionInfo(plain);
    const secondOpens = opens;
    checks.push(["第一次扫：真读了文件", firstOpens === 1]);
    checks.push(["第二次扫：没再读文件（缓存命中）", secondOpens === 0]);
    checks.push([
        "两次结果一样（标题 / 子会话标记 / 工作目录）",
        first.title === second.title && first.child === second.child && first.cwd === second.cwd,
    ]);

    // ---- 标题与时间 ----
    const renamedItem = await sessionStore.scanSessionInfo(renamed);
    checks.push(["改名过的会话：标题取最新那一次", renamedItem.title === "后来起的名字"]);
    const bigItem = await sessionStore.scanSessionInfo(bigLine);
    checks.push(["超大消息（跨块）后面才改名：一样取得回来", bigItem.title === "大消息之后的名字"]);
    const noNewlineItem = await sessionStore.scanSessionInfo(noNewline);
    checks.push(["最后一行没带换行：也读得到", noNewlineItem.title === "没有结尾换行的名字"]);
    const clearedItem = await sessionStore.scanSessionInfo(cleared);
    checks.push(["名字被显式清空：退回第一条用户消息", clearedItem.title === "就用这一句"]);
    checks.push([
        "最后活动时间就是文件的改动时间（不再数消息）",
        Math.abs((await sessionStore.scanSessionInfo(plain)).lastActivity - fs.statSync(plain).mtimeMs) < 1,
    ]);
    checks.push(["第一行不是 header 的文件：不认（不抛错）", (await sessionStore.scanSessionInfo(notSession)) === null]);

    fs.appendFileSync(plain, JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "又一条" }], timestamp: Date.now() },
    }) + "\n");
    const after = await sessionStore.scanSessionInfo(plain);
    checks.push(["文件改过以后重扫，时间跟着变（缓存没卡住）", after.lastActivity > first.lastActivity]);

    // ---- 子会话判定 ----
    const textChild = await sessionStore.scanSessionInfo(dispatched);
    checks.push(["文案里有收尾要求的老会话：认得出来（兜底还在）", textChild.child === true]);

    const judgeBefore = await sessionStore.scanSessionInfo(judge);
    checks.push(["判官那种不走那套文案的：清单里没记过就分不出来", judgeBefore.child === false]);

    checks.push(["记进清单：第一次算新条目", childSessions.noteChildSession(judge) === true]);
    checks.push(["记第二次：不重复写", childSessions.noteChildSession(judge) === false]);
    checks.push(["清单文件落在 PICHAT_HOME 里", fs.existsSync(path.join(process.env.PICHAT_HOME, "child-sessions.json"))]);

    opens = 0;
    const judgeAfter = await sessionStore.scanSessionInfo(judge);
    checks.push(["已经缓存过的条目：记进清单后立刻改口（不被缓存盖住）", judgeAfter.child === true]);
    checks.push(["这一趟没读文件", opens === 0]);

    opens = 0;
    const childByHelper = await sessionStore.isChildSessionFile(judge);
    checks.push(["自动打开最近会话那条路：查清单就够，不读文件", childByHelper === true && opens === 0]);

    if (process.platform === "win32") {
        checks.push(["路径大小写不同也认（Windows）", childSessions.isKnownChildSession(judge.toUpperCase()) === true]);
    }

    // ---- 文件没了 ----
    fs.rmSync(plain);
    const gone = await sessionStore.scanSessionInfo(plain);
    checks.push(["文件被删了：扫不出来（不是抛错）", gone === null]);

    let bad = 0;
    for (const [name, ok] of checks) {
        if (!ok) { bad += 1; }
        console.log((ok ? "OK   " : "FAIL ") + name);
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log(bad === 0 ? "\n全部通过。" : `\n${bad} 条没过。`);
    process.exit(bad === 0 ? 0 : 1);
})().catch((err) => {
    console.error(err);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
    process.exit(1);
});

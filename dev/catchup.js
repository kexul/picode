// @ts-nocheck
/**
 * catchup —— 验“断线补发”那本账（纯 Node，几秒跑完；不起浏览器、不叫模型、不碰界面）。
 *
 *   npm run compile && node dev/catchup.js
 *
 * 验三样（都是这次改动的立身之本）：
 *   1. 连着来的逐字增量在补发暂存里只占**一段**（按条记的话，一段回答几千条就把额度吃光了）；
 *   2. 页面报“段中间”的序号时，补回来的文字与原文**逐字相同**（合并了也要能精确截开）；
 *   3. 三种结果各走一遍：正好接上 = 一条不缺、落后几条 = 补上、缺得太多 / 序号比后端还新 = 整屏重画。
 *
 * 用的是真代码：out/server/chatBroadcaster.js（npm run compile 编出来的）。
 */
const { ChatBroadcaster } = require("../out/server/chatBroadcaster.js");

let failed = 0;
const ok = (text) => console.log("  ✔ " + text);
const bad = (text) => { console.log("  ✘ " + text); failed += 1; };
const check = (cond, text) => (cond ? ok : bad)(text);

/** 开一条连接，把收到的消息收进数组。 */
function connect(b, id) {
    const got = [];
    b.addChannel(id, (msg) => got.push(msg), () => {});
    return got;
}

/** 一段“一个字一个字推”的回答；返回全文。 */
function pushAnswer(b, text, chunk = 3, sessionId = "s1") {
    for (let i = 0; i < text.length; i += chunk) {
        b.broadcast({ type: "assistantDelta", delta: text.slice(i, i + chunk), sessionId });
    }
    return text;
}

// ============================================================================
//  一、合并与截开
// ============================================================================
console.log("【一】一整段回答进补发暂存：只占一段，段中间报序号能精确截开");
{
    const b = new ChatBroadcaster();
    const chunk = 3;
    const text = "先看代码，再改配置。".repeat(150);   // 1500 字，按 3 字一段 = 500 条增量
    pushAnswer(b, text, chunk);
    check(b.catchupLog.length === 1, `500 条增量在暂存里占 ${b.catchupLog.length} 条（应为 1 条）`);

    const pieces = b.catchupLog[0].run.pieces;
    const mid = 300;                                  // 页面处理到第 300 条（0 起）
    const since = pieces[mid].seq;
    const got = connect(b, "p-mid");
    const result = b.resume("p-mid", since);
    const joined = got.filter((m) => m.type === "assistantDelta").map((m) => m.delta).join("");
    check(result === "resumed", `报段中间的序号 → resumed（实际 ${result}）`);
    check(joined === text.slice((mid + 1) * chunk), "补回来的文字与原文逐字相同（从断掉那条之后起）");
    check(got.some((m) => m.type === "syncPoint"), "补完给了一条 syncPoint");
}

// ============================================================================
//  二、三种结果
// ============================================================================
console.log("\n【二】三种结果：一条不缺 / 补上 / 整屏重画");
{
    const b = new ChatBroadcaster();
    pushAnswer(b, "一二三四五六", 2);                  // 3 条增量
    b.broadcast({ type: "streamEnd", activity: "idle", sessionId: "s1" });
    const openSeq = b.currentSeq();

    const fresh = connect(b, "p-fresh");
    check(b.resume("p-fresh", openSeq) === "caught-up", "正好接上（报的序号等于建立时的序号）→ 一条不缺");
    check(fresh.length === 0, "一条不缺时什么都不发");

    const behind = connect(b, "p-behind");
    const res = b.resume("p-behind", openSeq - 2);
    const bodies = behind.map((m) => m.type);
    check(res === "resumed", `落后两条 → resumed（实际 ${res}）`);
    check(bodies.includes("assistantDelta") && bodies.includes("streamEnd"), "落后的那两条补回来了");

    const ahead = connect(b, "p-ahead");
    check(b.resume("p-ahead", openSeq + 1000) === "reset", "序号比后端还新（后端重启过）→ 整屏重画");
}

// ============================================================================
//  三、缺得太多（暂存里已经没有了）
// ============================================================================
console.log("\n【三】断太久、暂存里已经补不上了：整屏重画");
{
    const b = new ChatBroadcaster();
    for (let i = 0; i < 3000; i += 1) { b.broadcast({ type: "system", text: "第 " + i + " 行" }); }
    connect(b, "p-late");
    check(b.resume("p-late", 1) === "reset", "最老的那条都比页面报的新 → reset");
}

// ============================================================================
//  四、正文与思考交替：各成一段、顺序不乱
// ============================================================================
console.log("\n【四】正文与思考交替：各成一段，补回去的顺序不乱");
{
    const b = new ChatBroadcaster();
    b.broadcast({ type: "thinkingDelta", delta: "想一", sessionId: "s1" });
    b.broadcast({ type: "integer-not-mergeable" });
    b.broadcast({ type: "system", text: "插一行系统提示" });
    b.broadcast({ type: "assistantDelta", delta: "答一", sessionId: "s1" });
    b.broadcast({ type: "assistantDelta", delta: "答二", sessionId: "s1" });
    b.broadcast({ type: "thinkingDelta", delta: "想二", sessionId: "s1" });
    const got = connect(b, "p-mix");
    const result = b.resume("p-mix", 0);
    const kinds = got.filter((m) => m.type !== "syncPoint").map((m) => m.type + (m.delta ? ":" + m.delta : ""));
    check(result === "resumed", `交替的一串 → resumed（实际 ${result}）`);
    check(kinds.join(" | ") === "thinkingDelta:想一 | integer-not-mergeable | system | assistantDelta:答一答二 | thinkingDelta:想二",
        "顺序与分段都对：" + kinds.join(" | "));
}

// ============================================================================
//  五、一次性消息占位不补发
// ============================================================================
console.log("\n【五】一次性消息（确认框 / 浮层那类）只占序号位，不补发");
{
    const b = new ChatBroadcaster();
    b.broadcast({ type: "picker", items: [] });        // 一次性：只有序号位
    b.broadcast({ type: "assistantDelta", delta: "正文", sessionId: "s1" });
    const got = connect(b, "p-transient");
    const result = b.resume("p-transient", 0);
    check(result === "resumed", `跨过一次性消息照常补 → resumed（实际 ${result}）`);
    check(!got.some((m) => m.type === "picker"), "一次性消息没有补发（它本来就不该补）");
    check(got.filter((m) => m.type === "assistantDelta").map((m) => m.delta).join("") === "正文", "正文补回来了");
}

console.log("");
console.log(failed === 0 ? "结果：全部通过" : `结果：${failed} 项没过`);
process.exit(failed === 0 ? 0 : 1);

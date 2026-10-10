/**
 * 网页端「只发最近一段历史」（历史窗口）。
 *
 * 网页端的宿主声明 wantsTrimmedHistory：整屏重画 / 加载会话只发最近 30 条
 * user/assistant 消息，更早的由页面点「加载更早的消息」（loadOlderHistory）往前取。
 * 这里用假宿主 + 假 pi 客户端把窗口裁剪、往前补、换会话作废这几条路都过一遍。
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { SessionRuntime } from "./sessionRuntime";
import { randomNameParts } from "./names";
import type { RuntimeHost } from "./runtimeTypes";

/** 造一段 pairs 问 pairs 答的假历史，id 规律：user=e{序号}，assistant=a{序号}。 */
function makeHistory(pairs: number): any[] {
    const out: any[] = [];
    for (let i = 0; i < pairs; i++) {
        out.push({ role: "user", content: `问题${i}`, id: `e${i}` });
        out.push({ role: "assistant", content: [{ type: "text", text: `回答${i}` }], id: `a${i}` });
    }
    return out;
}

function fakeHost(trimmed: boolean): { host: RuntimeHost; posted: Array<Record<string, unknown>> } {
    const posted: Array<Record<string, unknown>> = [];
    const host: any = {
        workspaceId: "test",
        wantsTrimmedHistory: () => trimmed,
        getConfig: () => ({ piPath: "pi", provider: "", model: "", extraArgs: [], trustProject: true }),
        getCwd: () => process.cwd(),
        relativeTo: (_cwd: string, full: string) => full,
        resolvePath: (p: string) => p,
        checkPiAvailable: () => true,
        postToTab: (tabId: string, msg: Record<string, unknown>) => { posted.push({ ...msg, tabId }); },
        broadcastTabList: () => {},
        onTurnEnd: () => {},
        pickModelInteractive: async () => undefined,
        persistModel: () => {},
        openFileLocation: () => {},
        openDiff: () => {},
        confirmRevert: async () => true,
    };
    return { host: host as RuntimeHost, posted };
}

/** 建一个不真起 pi 的会话；messages 由外部持有，测试里可以改它来模拟会话变化。 */
function makeRuntime(box: { host: RuntimeHost }, messages: any[]): SessionRuntime {
    const rt = new SessionRuntime("test:panel-1", randomNameParts(), box.host);
    (rt as any).client = {
        isRunning: () => true,
        request: async (cmd: any) => (
            cmd?.type === "get_messages"
                ? { data: { messages } }
                : {
                    data: {
                        messages: messages
                            .filter((m: any) => m.role === "user")
                            .map((m: any) => ({ entryId: m.id, text: m.content })),
                    },
                }
        ),
    };
    return rt;
}

test("网页宿主整屏重画：只发最近 30 条 user/assistant，historyWindow 告诉页面还有更早的", async () => {
    const box = fakeHost(true);
    const history = makeHistory(35); // 70 条 user/assistant，窗口 30 条 = 最后 15 问 15 答
    const rt = makeRuntime(box, history);

    await rt.replayHistory({ note: "" });

    const types = box.posted.map((msg) => msg.type);
    assert.ok(types.includes("historyWindow"), "要先发一条 historyWindow");
    const win = box.posted.find((msg) => msg.type === "historyWindow")!;
    assert.equal(win.hasMore, true, "还有更早的没发");
    assert.equal(win.hidden, 40, "窗口前还有 40 条 user/assistant 没发");
    assert.equal(box.posted.filter((msg) => msg.type === "userMessage").length, 15, "只发最后 15 问");
    assert.equal(box.posted.filter((msg) => msg.type === "assistantFull").length, 15, "和最后 15 答");
    assert.ok(box.posted.every((msg) => msg.tabId === "test:panel-1"), "每条都带 tabId");
});

test("窗口里 user 消息的 fork 条目跟着往后对齐（entryOffset）", async () => {
    const box = fakeHost(true);
    const history = makeHistory(35);
    const rt = makeRuntime(box, history);

    await rt.replayHistory({ note: "" });

    const users = box.posted.filter((msg) => msg.type === "userMessage");
    assert.equal(users[0].entryId, "e20", "窗口第一条是第 21 问，fork 条目也要取第 21 个");
    assert.equal(users[users.length - 1].entryId, "e34");
});

test("加载更早：补发一批包装过的消息（historyBatchEvent），窗口往前挪", async () => {
    const box = fakeHost(true);
    const history = makeHistory(35);
    const rt = makeRuntime(box, history);
    await rt.replayHistory({ note: "" });
    box.posted.length = 0;

    await rt.loadOlderHistory();

    const batches = box.posted.filter((msg) => msg.type === "historyBatchEvent");
    assert.equal(batches.length, 30, "往前补 30 条");
    assert.ok(batches.every((msg) => msg.tabId === "test:panel-1"), "外层带 tabId");
    const innerTypes = batches.map((msg) => (msg.event as any)?.type);
    assert.deepEqual(innerTypes.slice(0, 2), ["userMessage", "assistantFull"], "里面还是原来那套消息");
    assert.equal((batches[0].event as any).entryId, "e5", "这批从第 11 条消息（第 6 问）开始，条目对齐跟着挪");
    const end = box.posted.find((msg) => msg.type === "historyBatchEnd")!;
    assert.equal(end.hasMore, true, "再往前还有");
    assert.equal(end.hidden, 10, "窗口前还剩 10 条");
});

test("加载更早到顶：hasMore 变假，窗口前没有更多了", async () => {
    const box = fakeHost(true);
    const history = makeHistory(35);
    const rt = makeRuntime(box, history);
    await rt.replayHistory({ note: "" });
    await rt.loadOlderHistory(); // 窗口挪到第 11 问
    box.posted.length = 0;

    await rt.loadOlderHistory();

    const batches = box.posted.filter((msg) => msg.type === "historyBatchEvent");
    assert.equal(batches.length, 10, "只剩开头 10 条");
    const end = box.posted.find((msg) => msg.type === "historyBatchEnd")!;
    assert.equal(end.hasMore, false, "到顶了");
    assert.equal(end.hidden, 0);
});

test("会话换过了（长度变短）：不往前补，整屏重画重置窗口", async () => {
    const box = fakeHost(true);
    const history = makeHistory(35);
    const rt = makeRuntime(box, history);
    await rt.replayHistory({ note: "" });
    box.posted.length = 0;

    // 底下换了一个短会话：旧窗口的下标作废
    history.length = 0;
    history.push({ role: "user", content: "新会话的问题", id: "n0" });
    history.push({ role: "assistant", content: [{ type: "text", text: "新会话的回答" }], id: "n1" });

    await rt.loadOlderHistory();

    assert.ok(box.posted.some((msg) => msg.type === "clear"), "走整屏重画（先 clear）");
    assert.equal(box.posted.filter((msg) => msg.type === "historyBatchEvent").length, 0, "不补旧窗口之前的内容");
    const win = box.posted.find((msg) => msg.type === "historyWindow")!;
    assert.equal(win.hasMore, false, "重画后窗口就是全部");
});

test("没开过窗口（非网页宿主 / 全量发过）：加载更早直接忽略", async () => {
    const box = fakeHost(true);
    const rt = makeRuntime(box, makeHistory(2));

    await rt.loadOlderHistory();

    assert.equal(box.posted.length, 0, "没有窗口就什么都不发");
});

test("非网页宿主：整屏重画照旧全量，不发 historyWindow", async () => {
    const box = fakeHost(false);
    const history = makeHistory(35);
    const rt = makeRuntime(box, history);

    await rt.replayHistory({ note: "" });

    assert.ok(!box.posted.some((msg) => msg.type === "historyWindow"), "VSCode 两家没有这个事件");
    assert.equal(box.posted.filter((msg) => msg.type === "userMessage").length, 35, "全量发");
});

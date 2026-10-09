/**
 * 整屏重画（replayHistory）的出口检查。
 *
 * 浏览器那边可以同时开着几个页面（手机 + 电脑）。手机回到前台重连时要重画，
 * 但只能重画它自己那一份：广播出去的话，电脑上那个页面会白闪一下，
 * 正在生成的半句话还会被清掉。这里用假的宿主和假的 pi 客户端把两条路都跑一遍。
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { SessionRuntime } from "./sessionRuntime";
import { randomNameParts } from "./names";
import type { RuntimeHost } from "./runtimeTypes";

interface FakeHost {
    host: RuntimeHost;
    /** 走常规广播（postToTab）发出去的消息。 */
    posted: Array<Record<string, unknown>>;
    /** 广播 tab 列表的次数。 */
    tabLists: number;
}

function fakeHost(): FakeHost {
    const box: FakeHost = { host: undefined as unknown as RuntimeHost, posted: [], tabLists: 0 };
    const host: any = {
        workspaceId: "test",
        getConfig: () => ({ piPath: "pi", provider: "", model: "", extraArgs: [], trustProject: true }),
        getCwd: () => process.cwd(),
        relativeTo: (_cwd: string, full: string) => full,
        resolvePath: (p: string) => p,
        checkPiAvailable: () => true,
        postToTab: (tabId: string, msg: Record<string, unknown>) => { box.posted.push({ ...msg, tabId }); },
        broadcastTabList: () => { box.tabLists += 1; },
        onTurnEnd: () => {},
        pickModelInteractive: async () => undefined,
        persistModel: () => {},
        openFileLocation: () => {},
        openDiff: () => {},
        confirmRevert: async () => true,
    };
    box.host = host as RuntimeHost;
    return box;
}

/** 两条消息的假历史：一问一答。 */
const HISTORY = [
    { role: "user", content: "问题", id: "e1" },
    { role: "assistant", content: [{ type: "text", text: "回答" }], id: "e2" },
];

/** 建一个不真起 pi 的会话：只把取历史那两个请求换成假的。 */
function makeRuntime(box: FakeHost): SessionRuntime {
    const rt = new SessionRuntime("test:panel-1", randomNameParts(), box.host);
    (rt as any).client = {
        isRunning: () => true,
        request: async (cmd: any) => (
            cmd?.type === "get_messages"
                ? { data: { messages: HISTORY } }
                : { data: { messages: [] } }
        ),
    };
    return rt;
}

test("重画只发给一个页面时：消息全走那个出口，带着 tabId，一点也没广播出去", async () => {
    const box = fakeHost();
    const rt = makeRuntime(box);
    const toPage: Array<Record<string, unknown>> = [];

    await rt.replayHistory({ note: "页面回来了（{count} 条消息）。", sink: (msg) => toPage.push(msg) });

    assert.deepEqual(
        toPage.map((msg) => msg.type),
        ["clear", "piReady", "userMessage", "assistantFull", "fileChanges", "system"],
        "重画那一整套都要发给这个页面",
    );
    assert.ok(toPage.every((msg) => msg.tabId === "test:panel-1"), "每条都要带 tabId（界面靠它认出是哪个窗格）");
    const note = toPage.find((msg) => msg.type === "system")!;
    assert.equal(note.text, "页面回来了（2 条消息）。", "{count} 要换成消息数（一问一答就是 2 条）");
    assert.equal(box.posted.length, 0, "别的页面一条都不该收到（电脑上那个不该跟着白闪）");
    assert.equal(box.tabLists, 0, "只重画一个页面时不必广播 tab 列表");
});

test("重画发给整个工作区时（没有指定出口）：照常广播，也照常刷 tab 列表", async () => {
    const box = fakeHost();
    const rt = makeRuntime(box);

    await rt.replayHistory({ note: "" });

    assert.deepEqual(
        box.posted.map((msg) => msg.type),
        ["clear", "piReady", "userMessage", "assistantFull", "fileChanges"],
        "整套重画都从常规出口出去",
    );
    assert.ok(box.posted.every((msg) => msg.tabId === "test:panel-1"), "tabId 照旧带上");
    assert.equal(box.tabLists, 1, "广播那份仍然刷新一次 tab 列表");
});

test("pi 进程没在跑：重画也要把话说明白，且同样只发给指定的那一个页面", async () => {
    const box = fakeHost();
    const rt = new SessionRuntime("test:panel-2", randomNameParts(), box.host);
    const toPage: Array<Record<string, unknown>> = [];

    await rt.replayHistory({ sink: (msg) => toPage.push(msg) });

    assert.deepEqual(toPage.map((msg) => msg.type), ["clear", "piReady", "system"], "没进程就不重画历史，只交代一句");
    assert.ok(toPage.every((msg) => msg.tabId === "test:panel-2"));
    assert.equal(box.posted.length, 0);
});

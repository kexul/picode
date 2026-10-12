import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BackendClient, type BackendState } from "./backendClient";
import { PiChatWebServer, type WebServerHost, type WebServerTimings } from "./webChatServer";
import { ChatBroadcaster } from "./chatBroadcaster";
import { ScreenRegistry } from "./screenRegistry";
import { writeServerAddress } from "./serverState";
import { serverAddressFile } from "./serverPaths";

/**
 * 插件连后端这条线的检查：真的起一个网页服务，真的用 http 连上去。
 * 不建会话、不启动 pi。
 */

const MEDIA_DIR = path.join(__dirname, "..", "..", "media");

/** 一个够用的假后端：屏登记簿是真的（挑窗口的逻辑要真），会话相关的都记下来不干活。 */
function fakeBackend() {
    const broadcaster = new ChatBroadcaster();
    const screens = new ScreenRegistry();
    const fromScreen: any[] = [];
    const fromPage: Array<{ msg: any; pageId: string }> = [];
    const connectedPages: string[] = [];
    let issued = 0;
    const host: WebServerHost = {
        getBroadcaster: () => broadcaster,
        getScreens: () => screens,
        attachScreen: (id, folders, send) => {
            screens.add(id, folders, send);
            // 跟真的宿主一样：窗口一连上就先把"这个工作区改动过哪些文件"报给它
            send({ kind: "sessionFiles", files: [] });
        },
        detachScreen: (id) => { screens.remove(id); },
        processScreenMessage: (msg, screenId) => {
            fromScreen.push(msg);
            if (msg?.type === "active") { screens.markActive(screenId); return undefined; }
            if (msg?.type === "newPage") {
                const pageId = `p-test-${++issued}`;
                broadcaster.markIssued(pageId);
                return { pageId };
            }
            return undefined;
        },
        processPageMessage: (msg, pageId) => { fromPage.push({ msg, pageId }); },
        onPageConnected: (pageId) => { connectedPages.push(pageId); },
        onPageDisconnected: () => {},
        onServerStarted: () => {},
        onServerStopped: () => {},
        getThemeMode: () => "light",
    };
    return { host, broadcaster, screens, fromScreen, fromPage, connectedPages };
}

type Backend = ReturnType<typeof fakeBackend>;

/** 起一个后端服务（测试结束自动关掉）。timings 可换小值：验证心跳巡检不用等真的一分钟。 */
async function startServer(backend: Backend, timings?: WebServerTimings): Promise<PiChatWebServer> {
    const server = new PiChatWebServer(MEDIA_DIR, backend.host, { log: () => {} }, timings);
    await server.applySettings({ enabled: true, port: 0, host: "127.0.0.1" });
    assert.ok(server.url, "服务应该给出访问地址");
    return server;
}

/** 造一个客户端，把它的收发都记下来（timings 调小：测试不用等 25 秒）。 */
function makeClient(url: string | undefined, timings?: { pingMs?: number }) {
    const states: Array<{ state: BackendState; note?: string }> = [];
    const pageEvents: any[] = [];
    const screenRequests: any[] = [];
    const sessionFiles: string[][] = [];
    const client = new BackendClient({
        url,
        folders: () => ["D:/projects/picode"],
        onPageEvent: (msg) => pageEvents.push(msg),
        onScreenRequest: (msg) => screenRequests.push(msg),
        onSessionFiles: (files) => sessionFiles.push(files),
        onStatus: (state, note) => states.push({ state, note }),
        timings: { pingMs: 60_000, watchdogMs: 60_000, tickTimeoutMs: 60_000, retryDelaysMs: [20, 40, 80], ...timings },
    });
    return { client, states, pageEvents, screenRequests, sessionFiles };
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > deadline) { throw new Error("等条件成立超时"); }
        await new Promise((r) => setTimeout(r, 20));
    }
}

function lastState(states: Array<{ state: BackendState }>): BackendState | undefined {
    return states.length > 0 ? states[states.length - 1].state : undefined;
}

/** 临时 PICHAT_HOME：地址文件写到那儿，不碰用户自己的。 */
async function withPichatHome(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-client-"));
    const before = process.env.PICHAT_HOME;
    process.env.PICHAT_HOME = dir;
    try {
        await run(dir);
    } finally {
        if (before === undefined) { delete process.env.PICHAT_HOME; } else { process.env.PICHAT_HOME = before; }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test("插件连上后端：状态变 online，这个窗口登记进去，后端推来的消息收得到", async () => {
    const backend = fakeBackend();
    const server = await startServer(backend);
    const c = makeClient(server.url!);
    try {
        c.client.start();
        await waitFor(() => lastState(c.states) === "online");
        // 等后端那头也确认页面连上了，下面推的消息才不会掉（推给还没连上的页面是发不出去的）
        await waitFor(() => backend.connectedPages.includes(c.client.currentPageId));
        assert.equal(backend.screens.count, 1, "窗口在后端登记了一条");
        assert.deepEqual(backend.screens.list()[0].folders, ["D:/projects/picode"], "打开着的文件夹报上去了");
        assert.match(c.client.currentPageId, /^p-/, "后端发了一个页面标识");

        // 后端推给页面的消息：原样转到插件这边（插件再给网页视图）
        backend.broadcaster.broadcast({ type: "sessionList", sessions: [], activeId: null });
        await waitFor(() => c.pageEvents.some((m) => m.type === "sessionList"));

        // 网页视图发的消息：原样转给后端（带的是后端发的那块页面标识）
        c.client.sendPage({ type: "newSession" });
        await waitFor(() => backend.fromPage.some((p) => p.msg?.type === "newSession"));
        assert.equal(backend.fromPage[0].pageId, c.client.currentPageId);
    } finally {
        c.client.stop();
        await server.stop();
    }
});

test("后端派来的活（打开文件、符号跳转、列编辑器文件）都到了屏这一层", async () => {
    const backend = fakeBackend();
    const server = await startServer(backend);
    const c = makeClient(server.url!);
    try {
        c.client.start();
        await waitFor(() => backend.screens.count === 1);
        c.client.markActive();

        backend.screens.sendTo("D:/projects/picode", { kind: "openFile", path: "src/a.ts", line: 12, cwd: "D:/projects/picode" });
        backend.screens.sendTo("D:/projects/picode", { kind: "openSymbol", name: "Foo.bar" });
        backend.screens.sendTo("D:/projects/picode", { kind: "listFiles" });
        backend.screens.sendTo("D:/projects/picode", { kind: "sessionFiles", files: ["src/a.ts"] });
        await waitFor(() => c.screenRequests.length >= 3 && c.sessionFiles.some((f) => f.length === 1));

        assert.deepEqual(c.screenRequests.map((m) => m.kind), ["openFile", "openSymbol", "listFiles"]);
        assert.equal(c.screenRequests[0].line, 12, "行号这些细节原样带过来");
        assert.deepEqual(c.sessionFiles[c.sessionFiles.length - 1], ["src/a.ts"]);
    } finally {
        c.client.stop();
        await server.stop();
    }
});

test("屏给后端回话：符号集合、执行结果都送得到；同一个目录多个窗口时按“最近在用”挑", async () => {
    const backend = fakeBackend();
    const server = await startServer(backend);
    const a = makeClient(server.url!);
    const b = makeClient(server.url!);
    try {
        a.client.start();
        await waitFor(() => backend.screens.count === 1);
        await new Promise((r) => setTimeout(r, 5));
        b.client.start();
        await waitFor(() => backend.screens.count === 2);

        // 两个窗口都开着同一个目录：默认按标识排；谁最后有人在用就派给谁
        b.client.markActive();
        await waitFor(() => backend.fromScreen.some((m) => m.type === "active"));
        await waitFor(() => backend.screens.pick("D:/projects/picode")?.id === b.client.id);

        b.client.reportSymbols(["foo", "Bar.baz"]);
        await waitFor(() => backend.fromScreen.some((m) => m.type === "symbolSet" && m.names.length === 2));
    } finally {
        a.client.stop();
        b.client.stop();
        await server.stop();
    }
});

test("后端没在跑：状态是 offline，能自己重试；后端起来后（地址文件里出现）自己连上", async () => {
    await withPichatHome(async () => {
        const c = makeClient(undefined);   // 不给地址：走"读地址文件 + 探活"
        const backend = fakeBackend();
        let server: PiChatWebServer | undefined;
        try {
            c.client.start();
            await waitFor(() => lastState(c.states) === "offline");
            assert.ok(c.states.some((s) => typeof s.note === "string" && s.note.includes("pichat")),
                "要把“先敲 pichat 起来”这句话说给用户：" + JSON.stringify(c.states));

            server = await startServer(backend);
            const parsed = new URL(server.url!);
            writeServerAddress({
                app: "pichat",
                version: "0.0.9",
                pid: process.pid,
                port: Number(parsed.port),
                host: "127.0.0.1",
                url: server.url!,
                startedAt: Date.now(),
            }, serverAddressFile());
            await waitFor(() => lastState(c.states) === "online");
            assert.equal(backend.screens.count, 1, "连上后窗口登记进去");
        } finally {
            c.client.stop();
            if (server) { await server.stop(); }
        }
    });
});

test("屏定时报活：窗口开着没人动也不会被后端当死连接採掉", async () => {
    const backend = fakeBackend();
    // 服务端心跳 50ms 一巡、200ms 没动静就算死；客户端 80ms 报一次活——报得比採得快。
    // 报活之前屏只有"有事才说话"，没人动就静默，会被误採还连坐页面流。
    const server = await startServer(backend, { heartbeatMs: 50, pageStaleMs: 200 });
    const c = makeClient(server.url!, { pingMs: 80 });
    try {
        c.client.start();
        await waitFor(() => lastState(c.states) === "online");
        // 屏的报活真到了后端
        await waitFor(() => backend.fromScreen.some((m) => m.type === "screenPing"));
        // 跨过几个"该採"的周期，屏还在登记簿里，连接也没断过（屏被採会连坐页面流）
        await new Promise((r) => setTimeout(r, 500));
        assert.ok(backend.screens.get(c.client.id), "屏一直没被採");
        assert.equal(lastState(c.states), "online", "连接没有断过");
    } finally {
        c.client.stop();
        await server.stop();
    }
});

test("后端停了：插件回到 offline 并继续重试（界面据此提示）", async () => {
    const backend = fakeBackend();
    const server = await startServer(backend);
    const c = makeClient(server.url!);
    try {
        c.client.start();
        await waitFor(() => lastState(c.states) === "online");
        await server.stop();
        await waitFor(() => lastState(c.states) === "offline", 8000);
    } finally {
        c.client.stop();
    }
});

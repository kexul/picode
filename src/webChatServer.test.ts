import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import { PiChatWebServer } from "./webChatServer";
import type { BrowserChatOwner, ExternalChatWorkspace } from "./browserChatController";
import type { ChatControllerBase } from "./chatControllerBase";

/**
 * 网页服务的端到端检查（真的起一个服务、真的发请求）。
 *
 * 只走到"通道两端能对上"这一步：不发 ready（不让控制器建会话、不启动 pi），
 * 所以测试里不会真的启动任何 pi 进程。
 *
 * 注意：每个响应的内容都要读掉。不读的话连接一直被占着，测试跑完进程也不会退出。
 */

const MEDIA_DIR = path.join(__dirname, "..", "..", "media");

function fakeOwner(): BrowserChatOwner {
    return {
        getConfig: () => ({ piPath: "pi", provider: "", model: "", extraArgs: [], trustProject: true }),
        getCwd: () => process.cwd(),
        confirmDialog: async () => true,
        selectDialog: async () => undefined,
        inputDialog: async () => undefined,
        showInfo: () => {},
        persistModel: () => {},
        openFileLocation: async () => {},
        openFile: async () => {},
        openSymbol: async () => {},
        openDiff: async () => {},
        confirmRevert: async () => true,
        saveExportedConversation: async () => {},
        getSendKey: () => "enter",
        getNewSessionKey: () => "ctrl+alt+n",
        getTabSwitchKey: () => "ctrl+alt+arrows",
        getFocusInputKey: () => "ctrlAltI",
        getRelayPrefix: () => "",
        getToolDisplay: () => "compact",
        getFontSize: () => "",
        getNotifyBeep: () => true,
        getTurnTitleWaitSeconds: () => 3,
        notifyTurnEndFor: () => {},
        mutateViewOption: () => {},
        getOpenFiles: () => [],
        showPiMissing: () => {},
        modelsChanged: () => {},
        allocateChatName: () => ({ adjective: "测试", noun: "豹子" }),
        releaseChatName: () => {},
        uniqueTabName: (base: string) => base,
        broadcastChatReferences: () => {},
        fetchGlobalChatReference: async (_requester: ChatControllerBase, _msg: any) => {},
        registerExternalWorkspace: (_c: ExternalChatWorkspace) => {},
        unregisterExternalWorkspace: (_c: ExternalChatWorkspace) => {},
    };
}

/** 取"协议 + 主机 + 端口"，不带结尾斜杠（免得拼出 "//media/…" 这种地址）。 */
function baseOf(url: string): string {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
}

/** 起一个服务，测试结束时自动关掉。 */
async function withServer(run: (url: string, logs: string[]) => Promise<void>): Promise<void> {
    const logs: string[] = [];
    const server = new PiChatWebServer(MEDIA_DIR, fakeOwner(), { log: (t) => logs.push(t) });
    await server.applySettings({ enabled: true, port: 0, host: "127.0.0.1" });
    const url = server.url;
    assert.ok(url, "服务应该给出访问地址");
    try {
        await run(url!, logs);
    } finally {
        await server.stop();
    }
}

/** 发 GET，读完内容后只回状态码。 */
async function statusOf(target: string, headers?: Record<string, string>): Promise<number> {
    const res = await fetch(target, { headers });
    await res.text();
    return res.status;
}

/** 取一次对话页面，并从页面里读出服务发给这个页面的标识。 */
async function fetchPage(url: string): Promise<{ html: string; pageId: string }> {
    const res = await fetch(baseOf(url));
    const html = await res.text();
    assert.equal(res.status, 200, `取页面应该成功（实际 ${res.status}）`);
    const match = html.match(/name="pichat-page" content="([^"]+)"/);
    assert.ok(match, "页面里应该写有本页面标识");
    return { html, pageId: match![1] };
}

type Stream = Awaited<ReturnType<typeof openStream>>;

/** 打开一条推送连接，返回一个能读到累计内容、也能关掉的把手。 */
async function openStream(url: string, pageId: string, signal: AbortSignal) {
    const res = await fetch(`${baseOf(url)}/events?pageId=${pageId}`, {
        headers: { Accept: "text/event-stream" },
        signal,
    });
    assert.equal(res.status, 200, "推送连接应该建立");
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return {
        /** 一直读到出现期望的文字为止；超时抛出。 */
        async readUntil(wanted: string, timeoutMs = 3000): Promise<string> {
            const deadline = Date.now() + timeoutMs;
            while (!buffer.includes(wanted)) {
                if (Date.now() > deadline) {
                    throw new Error(`等 "${wanted}" 超时；已收到：${buffer.slice(0, 400)}`);
                }
                const { value, done } = await reader.read();
                if (done) { break; }
                buffer += decoder.decode(value, { stream: true });
            }
            return buffer;
        },
        received: () => buffer,
        /** 把流关掉：不读完的响应会让测试结束不了。 */
        async close(): Promise<void> {
            try { await reader.cancel(); } catch { /* 已经关了 */ }
        },
    };
}

/** 页面发一条消息给插件，回状态码（内容一并读掉）。 */
async function postMessage(url: string, pageId: string, msg: Record<string, unknown>): Promise<number> {
    const res = await fetch(`${baseOf(url)}/api?pageId=${pageId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg),
    });
    await res.text();
    return res.status;
}

test("访问地址是干净的：不用带口令，手机上一输就能开", async () => {
    await withServer(async (url) => {
        const parsed = new URL(url);
        assert.equal(parsed.search, "", "地址里不该再有任何参数");
        assert.equal(parsed.pathname, "/");
        assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    });
});

test("别的网站里的脚本偷偷发来的请求（Origin 对不上）一律拒绝", async () => {
    await withServer(async (url) => {
        const { pageId } = await fetchPage(url);
        const base = baseOf(url);
        const port = new URL(url).port;
        const evil = { Origin: `http://evil.example.com:${port}` };

        assert.equal(await statusOf(`${base}/`, evil), 403);
        assert.equal(await statusOf(`${base}/media/chat.js`, evil), 403);
        const sent = await fetch(`${base}/api?pageId=${pageId}`, {
            method: "POST", headers: { ...evil, "Content-Type": "text/plain" }, body: "{}",
        });
        await sent.text();
        assert.equal(sent.status, 403, "别的网站发来的消息不能进");

        // 本服务自己的页面发来的照常放行
        assert.equal(await statusOf(`${base}/`, { Origin: `http://127.0.0.1:${port}` }), 200);
    });
});

test("页面与界面资源能取到，白名单外的文件取不到", async () => {
    await withServer(async (url) => {
        const base = baseOf(url);
        const { html } = await fetchPage(url);

        assert.match(html, /Content-Security-Policy/, "页面里要有安全策略");
        assert.match(html, /name="pichat-page"/, "页面里要写有本页面标识");
        assert.doesNotMatch(html, /pichat-token/, "不再需要访问口令");
        assert.match(html, /browserBridge\.js/, "桥接脚本必须在页面里");
        // 按真的 <script src> 比位置：样式文件的注释里也提到过这些文件名，不能拿文件名直接找
        const bridgeAt = html.indexOf('src="/media/browserBridge.js"');
        const chatAt = html.indexOf('src="/media/chat.js"');
        assert.ok(bridgeAt > 0 && chatAt > 0, "两个脚本都该在页面里");
        assert.ok(bridgeAt < chatAt, "桥接脚本要排在 chat.js 前面");
        assert.match(html, /--vscode-editor-background: #ffffff/, "网页端是白底（浅色主题）");
        assert.match(html, /--pichat-input-min-height/, "网页端把输入框起步高度设成一行");
        assert.ok(
            html.indexOf('id="browser-theme"') > html.indexOf("--vscode-textCodeBlock-background"),
            "网页专用的样式要排在 chat.css 之后（否则压不过它那套固定取值）",
        );
        assert.match(html, /id="input"/, "对话界面的输入框要在");

        const js = await fetch(`${base}/media/chat.js`);
        const jsText = await js.text();
        assert.equal(js.status, 200);
        assert.match(js.headers.get("content-type") || "", /javascript/);
        assert.equal(js.headers.get("cache-control"), "no-store");
        assert.ok(jsText.length > 10000, "chat.js 应该是完整的那份");

        // 白名单外的文件（同目录下的历史画布资源、已经内联进页面的那份样式）不给
        assert.equal(await statusOf(`${base}/media/historyCanvas.js`), 404);
        assert.equal(await statusOf(`${base}/media/browserTheme.css`), 404, "这份已经写进页面里，不走静态文件");
        // 目录穿越：编码过的 ../ 也不行
        assert.equal(await statusOf(`${base}/media/%2e%2e%2fpackage.json`), 404);
        assert.equal(await statusOf(`${base}/nope`), 404);
    });
});

test("两个方向都通：页面发的消息有回应，回应从推送流回来", async () => {
    await withServer(async (url) => {
        const { pageId } = await fetchPage(url);
        const abort = new AbortController();
        let stream: Stream | undefined;
        try {
            stream = await openStream(url, pageId, abort.signal);
            assert.match(await stream.readUntil(": connected"), /: connected/);

            // "打开设置面板"这条消息由浏览器工作区接，并把 openSettings 推回页面
            assert.equal(await postMessage(url, pageId, { type: "openSettingsPanel", tab: "options" }), 204);

            const received = await stream.readUntil('"type":"openSettings"');
            assert.match(received, /"type":"openSettings"/);
            assert.match(received, /"tab":"options"/);
        } finally {
            await stream?.close();
            abort.abort();
        }
    });
});

test("页面还没连上就发消息：回应先攒着，连上后照原顺序补发", async () => {
    await withServer(async (url) => {
        const { pageId } = await fetchPage(url);
        const abort = new AbortController();
        let stream: Stream | undefined;
        try {
            // 页面刚打开的那一瞬间就是这样：chat.js 的消息比推送连接先到
            assert.equal(
                await postMessage(url, pageId, { type: "openSettingsPanel", tab: "models" }),
                204,
                "取过页面就算有效，不能当成过期页面拒掉",
            );

            stream = await openStream(url, pageId, abort.signal);
            await stream.readUntil(": connected");
            // 刚才攒下的那条回应这时补发出来
            assert.match(await stream.readUntil('"type":"openSettings"'), /"tab":"models"/);

            // 别的页面（例如已被顶掉的旧页面）发消息：拒掉
            assert.equal(await postMessage(url, "p-别的页面", { type: "hostFocus" }), 409);
        } finally {
            await stream?.close();
            abort.abort();
        }
    });
});

test("再开一个页面会顶掉前一个：旧页面收到结束事件，且不能再发消息", async () => {
    await withServer(async (url) => {
        const abortOld = new AbortController();
        const abortNew = new AbortController();
        let old: Stream | undefined;
        let fresh: Stream | undefined;
        try {
            old = await openStream(url, "p-old", abortOld.signal);
            await old.readUntil(": connected");

            fresh = await openStream(url, "p-new", abortNew.signal);
            await fresh.readUntil(": connected");

            assert.match(await old.readUntil("event: end", 3000), /event: end/);

            // 被顶掉的页面还在发消息：明确拒绝，让它提示用户
            assert.equal(await postMessage(url, "p-old", { type: "openSettingsPanel" }), 409);

            // 新页面照常用
            assert.equal(await postMessage(url, "p-new", { type: "hostFocus" }), 204);
        } finally {
            await old?.close();
            await fresh?.close();
            abortOld.abort();
            abortNew.abort();
        }
    });
});

test("不合法的请求地址不会一律变成 500", async () => {
    await withServer(async (url) => {
        // 百分号后面不是两位十六进制：解不开，明确回 400
        assert.equal(await statusOf(`${baseOf(url)}/media/%zz.js`), 400);
        // 原始报文里塞多余斜杠的地址：要么正常给页面，要么回 400，不该是 500
        const status = await statusOf(`${baseOf(url)}///`);
        assert.ok(status !== 500, `不该是 500（实际 ${status}）`);
    });
});

test("端口被占用时自动改挑一个，并把这件事写进日志", async () => {
    // 先占住一个真端口（避免写死 51883：万一这台机器上已经有东西在用）
    const port = await freePort();
    const first = new PiChatWebServer(MEDIA_DIR, fakeOwner(), { log: () => {} });
    const logs: string[] = [];
    const second = new PiChatWebServer(MEDIA_DIR, fakeOwner(), { log: (t) => logs.push(t) });
    try {
        await first.applySettings({ enabled: true, port, host: "127.0.0.1" });
        const firstUrl = first.url!;
        assert.match(firstUrl, new RegExp(`:${port}/$`), "第一个服务用上了指定端口");

        await second.applySettings({ enabled: true, port, host: "127.0.0.1" });
        assert.ok(second.url, "第二个服务也该起来（换一个端口）");
        assert.notEqual(second.url, firstUrl, "两个服务不该是同一个地址");
        assert.ok(
            logs.some((line) => line.includes(String(port)) && line.includes("已被占用")),
            "日志里要写清端口被占了",
        );
    } finally {
        await first.stop();
        await second.stop();
    }
});

/** 找一个当下空闲的端口（先绑再放，中间有极短的竞争窗口，测试可接受）。 */
async function freePort(): Promise<number> {
    const net = await import("net");
    return await new Promise<number>((resolve, reject) => {
        const probe = net.createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            const port = address && typeof address === "object" ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });
}

test("停掉以后端口就不再监听了", async () => {
    const server = new PiChatWebServer(MEDIA_DIR, fakeOwner(), { log: () => {} });
    await server.applySettings({ enabled: true, port: 0, host: "127.0.0.1" });
    const url = server.url!;
    assert.ok(url);
    assert.equal(await statusOf(baseOf(url)), 200);
    await server.stop();
    assert.equal(server.url, undefined);
    await assert.rejects(() => fetch(baseOf(url)));
});

test("配置改成不开启时就把服务停掉，并报出'没有地址了'", async () => {
    const seen: Array<string | undefined> = [];
    const server = new PiChatWebServer(MEDIA_DIR, fakeOwner(), {
        log: () => {},
        onUrlChanged: (url) => seen.push(url),
    });
    await server.applySettings({ enabled: true, port: 0, host: "127.0.0.1" });
    assert.ok(server.url);
    assert.deepEqual(seen, [server.url], "启动后只报一次地址");
    await server.applySettings({ enabled: false, port: 0, host: "127.0.0.1" });
    assert.equal(server.url, undefined);
    assert.deepEqual(seen, [seen[0], undefined], "停掉之后报一次'没有地址了'");
});

test("从没开过又改成不开启：不白报'没有地址了'", async () => {
    const seen: Array<string | undefined> = [];
    const server = new PiChatWebServer(MEDIA_DIR, fakeOwner(), {
        log: () => {},
        onUrlChanged: (url) => seen.push(url),
    });
    await server.applySettings({ enabled: false, port: 0, host: "127.0.0.1" });
    assert.equal(server.url, undefined);
    assert.deepEqual(seen, [], "本来就没开，不该有通知（免得状态栏白闪一下）");
});

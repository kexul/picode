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

/** 起一个服务，测试结束时自动关掉。
 *  @param timings 心跳间隔 / 页面静默上限；测试里传小值（默认 25 秒 / 90 秒等不起） */
async function withServer(
    run: (url: string, logs: string[]) => Promise<void>,
    timings?: { heartbeatMs?: number; pageStaleMs?: number },
): Promise<void> {
    const logs: string[] = [];
    const server = new PiChatWebServer(MEDIA_DIR, fakeOwner(), { log: (t) => logs.push(t) }, timings);
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
        /** 一直读到服务那头把连接断开为止（读报错也算断了），回读到的全部内容。 */
        async readToEnd(timeoutMs = 3000): Promise<string> {
            for (;;) {
                let chunk: { value?: Uint8Array; done?: boolean };
                try {
                    chunk = await Promise.race([
                        reader.read(),
                        new Promise<never>((_ok, no) => setTimeout(
                            () => no(new Error(`等流断开超时；已收到：${buffer.slice(0, 400)}`)),
                            timeoutMs,
                        )),
                    ]);
                } catch {
                    return buffer;   // 服务那头直接把连接掐了：这就是我们要的结局
                }
                if (chunk.value) { buffer += decoder.decode(chunk.value, { stream: true }); }
                if (chunk.done) { return buffer; }
            }
        },
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
        assert.match(html, /#bottomBar \{ display: none !important/, "网页端把底部按钮条整条藏掉");
        assert.match(html, /#browserMenuBtn/, "网页端有顶部⋯菜单按钮的样式");
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

            // 服务从没见过的页面标识（服务重启前的旧页面）发消息：拒掉，并让它刷新
            const refused = await fetch(`${baseOf(url)}/api?pageId=p-别的页面`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "hostFocus" }),
            });
            assert.equal(refused.status, 409);
            assert.match(await refused.text(), /刷新/);
        } finally {
            await stream?.close();
            abort.abort();
        }
    });
});

test("手机和电脑同时开着：插件推的消息两边都收到，谁也不会把谁顶掉", async () => {
    await withServer(async (url) => {
        const abortPhone = new AbortController();
        const abortPc = new AbortController();
        let phone: Stream | undefined;
        let pc: Stream | undefined;
        try {
            phone = await openStream(url, "p-phone", abortPhone.signal);
            await phone.readUntil(": connected");
            pc = await openStream(url, "p-pc", abortPc.signal);
            await pc.readUntil(": connected");

            // 先连上来的那个页面没被顶掉，两边都能继续发消息
            assert.equal(await postMessage(url, "p-phone", { type: "openSettingsPanel", tab: "models" }), 204);
            assert.equal(await postMessage(url, "p-pc", { type: "openSettingsPanel", tab: "options" }), 204);

            // 插件回的消息，两个页面都收得到
            assert.match(await phone.readUntil('"tab":"options"'), /"type":"openSettings"/);
            assert.match(await pc.readUntil('"tab":"options"'), /"type":"openSettings"/);
            assert.doesNotMatch(phone.received(), /event: end/, "先来的页面不该收到「你被顶掉了」");
            assert.doesNotMatch(pc.received(), /接管/, "谁都不该被说成「接管了别人的会话」");
        } finally {
            await phone?.close();
            await pc?.close();
            abortPhone.abort();
            abortPc.abort();
        }
    });
});

test("同一个页面重连（手机退到后台再回来）：旧连接安静收掉，不发「被接管」", async () => {
    await withServer(async (url) => {
        const abortOld = new AbortController();
        const abortNew = new AbortController();
        let before: Stream | undefined;
        let after: Stream | undefined;
        try {
            before = await openStream(url, "p-phone", abortOld.signal);
            await before.readUntil(": connected");

            // 同一个页面标识又来了一条连接：这是它自己重连，不是别的页面来抢
            after = await openStream(url, "p-phone", abortNew.signal);
            await after.readUntil(": connected");

            const received = await before.readToEnd();
            assert.doesNotMatch(received, /接管/, "同一个页面重连，不能说成「被别的页面接管」");
            assert.doesNotMatch(received, /event: end/, "重连不用跟旧连接道别：页面那头早就不在听了");

            // 重连之后照常能用
            assert.equal(await postMessage(url, "p-phone", { type: "openSettingsPanel", tab: "options" }), 204);
            assert.match(await after.readUntil('"type":"openSettings"'), /"tab":"options"/);
        } finally {
            await before?.close();
            await after?.close();
            abortOld.abort();
            abortNew.abort();
        }
    });
});

test("页面断开、正在重连的那一下发来的消息照收：回应先攒着，重连后补发", async () => {
    await withServer(async (url) => {
        const { pageId } = await fetchPage(url);
        const abortFirst = new AbortController();
        const abortAgain = new AbortController();
        let first: Stream | undefined;
        let again: Stream | undefined;
        try {
            first = await openStream(url, pageId, abortFirst.signal);
            await first.readUntil(": connected");

            // 手机退到后台：连接断了（服务那头也察觉了），页面标识没变
            await first.close();
            abortFirst.abort();
            await sleep(200);

            // 回到前台那一下，消息往往比推送连接先出去：这一条以前会被当成「被顶掉的旧页面」拒掉
            assert.equal(
                await postMessage(url, pageId, { type: "openSettingsPanel", tab: "options" }),
                204,
                "同一个页面在重连之前发的消息也要收下（手机上「此页面已被接管」就是这么来的）",
            );

            again = await openStream(url, pageId, abortAgain.signal);
            await again.readUntil(": connected");
            assert.match(
                await again.readUntil('"type":"openSettings"'),
                /"tab":"options"/,
                "断线时攒下的回应，连上之后要补发出来",
            );
        } finally {
            await first?.close();
            await again?.close();
            abortFirst.abort();
            abortAgain.abort();
        }
    });
});

test("页面收得到心跳；一直不报活的连接会被服务收掉，报活的就不会", async () => {
    await withServer(async (url, logs) => {
        const abortDead = new AbortController();
        const abortAlive = new AbortController();
        let dead: Stream | undefined;
        let alive: Stream | undefined;
        try {
            dead = await openStream(url, "p-dead", abortDead.signal);
            await dead.readUntil(": connected");
            // 心跳得是页面收得到的（页面靠它判断「连接是不是其实已经死了」），不能是看不见的注释行
            assert.match(await dead.readUntil("event: tick"), /event: tick/);

            alive = await openStream(url, "p-alive", abortAlive.signal);
            await alive.readUntil(": connected");

            // 一条不报活（像退到后台那样），另一条每 40 毫秒报一次活
            const keepAlive = setInterval(() => { void postMessage(url, "p-alive", { type: "channelPing" }); }, 40);
            const received = await dead.readToEnd(3000);
            clearInterval(keepAlive);

            assert.doesNotMatch(received, /event: end/, "当成死连接的，安静收掉就行（页面会自己重连）");
            assert.ok(
                logs.some((line) => line.includes("p-dead")),
                "日志里要写清哪个页面因为没动静被收掉了：" + logs.join(" | "),
            );

            // 一直报活的那条还连着：能继续收消息
            assert.equal(await postMessage(url, "p-alive", { type: "openSettingsPanel", tab: "options" }), 204);
            assert.match(await alive.readUntil('"type":"openSettings"'), /"tab":"options"/);
            // 报活本身不会让插件推东西回来（它只是"我还在"，不是一条会话消息）
            assert.doesNotMatch(alive.received(), /channelPing/, "报活的内容不该被回给页面");
        } finally {
            await dead?.close();
            await alive?.close();
            abortDead.abort();
            abortAlive.abort();
        }
    }, { heartbeatMs: 60, pageStaleMs: 250 });
});

/** 等一会儿（让服务那头的异步清理跑完）。 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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

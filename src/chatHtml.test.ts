import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import { fetchChatUiFiles, getChatHtml, type ChatUiFiles } from "./chatHtml";
import { PiChatWebServer, type WebServerHost } from "./webChatServer";
import { ChatBroadcaster } from "./chatBroadcaster";
import { ScreenRegistry } from "./screenRegistry";

/**
 * 插件里的对话面板从后端现取界面这条线的检查：
 * 真的起一个网页服务，真的把界面文件抓回来，真的把 HTML 拼一遍。
 * 不建会话、不启动 pi、不碰 vscode。
 */

const MEDIA_DIR = path.join(__dirname, "..", "..", "media");

function fakeHost(): WebServerHost {
    return {
        getBroadcaster: () => new ChatBroadcaster(),
        getScreens: () => new ScreenRegistry(),
        attachScreen: () => {},
        detachScreen: () => {},
        processScreenMessage: () => undefined,
        processPageMessage: () => {},
        onPageConnected: () => {},
        onPageDisconnected: () => {},
        onServerStarted: () => {},
        onServerStopped: () => {},
        getThemeMode: () => "dark",
    };
}

async function startServer(): Promise<PiChatWebServer> {
    const server = new PiChatWebServer(MEDIA_DIR, fakeHost(), { log: () => {} });
    await server.applySettings({ enabled: true, port: 0, host: "127.0.0.1" });
    assert.ok(server.url, "服务应该给出访问地址");
    return server;
}

test("界面文件从后端 /media/ 抓得齐：七个都有内容", async () => {
    const server = await startServer();
    try {
        const files = await fetchChatUiFiles(server.url!);
        assert.ok(files, "应该抓到全部界面文件");
        for (const [name, content] of Object.entries(files!)) {
            assert.ok(content.length > 0, `${name} 不该是空的`);
        }
        // 抓回来的就是后端 media/ 里那份原文
        assert.ok(files!.chatJs.includes("acquireVsCodeApi"), "chat.js 应该是聊天前端那份");
        assert.ok(files!.chatCss.includes("#messages"), "chat.css 应该是界面样式那份");
    } finally {
        await server.stop();
    }
});

test("后端连不上时抓不到：返回 undefined 而不是抛错", async () => {
    const files = await fetchChatUiFiles("http://127.0.0.1:9/");
    assert.equal(files, undefined);
});

/** 造一份能看出顺序的假界面文件。 */
function fakeFiles(overrides?: Partial<ChatUiFiles>): ChatUiFiles {
    return {
        chatCss: "/*CHAT_CSS*/body{}",
        browserCss: "/*BROWSER_CSS*/.x{}",
        markedJs: "/*MARKED*/",
        highlightJs: "/*HIGHLIGHT*/",
        chatJs: "/*CHAT_JS*/",
        bridgeJs: "/*BRIDGE*/",
        ...overrides,
    };
}

test("拼出来的 HTML：CSS 内联、脚本按序内联且带同一个 nonce", () => {
    const html = getChatHtml(fakeFiles(), { themeMode: "dark", imgCspSource: "https://csp.test" });
    // 顺序：桥在最前（比 chat.js 先加载），然后 marked → highlight → chat
    const order = ["/*BRIDGE*/", "/*MARKED*/", "/*HIGHLIGHT*/", "/*CHAT_JS*/"]
        .map((marker) => html.indexOf(marker));
    assert.ok(order.every((pos) => pos >= 0), "四份脚本都应该内联进 HTML");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "脚本顺序应该是桥最前、chat 最后");
    // CSS：界面样式进 <style>，网页端配色单独一份
    assert.ok(html.includes("/*CHAT_CSS*/"), "chat.css 应该内联");
    assert.ok(html.includes('<style id="browser-theme">/*BROWSER_CSS*/'), "browserTheme.css 应该单独内联");
    // 主题与 CSP
    assert.ok(html.includes('<meta name="pichat-theme" content="dark" />'), "初始颜色要写进 meta");
    assert.ok(html.includes("img-src https://csp.test data:"), "CSP 里要有图片来源");
    // 所有内联脚本共用一个 nonce
    const nonces = [...html.matchAll(/<script nonce="([0-9a-zA-Z]+)">/g)].map((m) => m[1]);
    assert.ok(nonces.length >= 4, "四份内联脚本都应该带 nonce");
    assert.ok(new Set(nonces).size === 1, "nonce 应该是同一个");
});

test("脚本内容里的 </script> 会被转义，不再提前收掉标签", () => {
    const html = getChatHtml(fakeFiles({ chatJs: 'var a = "</script>"; /*CHAT_JS*/' }));
    assert.ok(html.includes("<\\/script>"), "应该替换成 <\\/script");
    assert.ok(!html.includes('"</script>"'), "原文的 </script> 不该原样出现");
});

test("内容里有 <!-- 后跟 <script 时拒绝内联（HTML 双转义坑）", () => {
    // 中间没有 -->：解析器会进双转义状态，真正的 </script> 收不掉标签
    assert.throws(() => getChatHtml(fakeFiles({ chatJs: "var s = \"<!--\"; var t = \"<script\";" })));
    // 注释成对出现、或 <script 在 <!-- 前面：都安全
    assert.doesNotThrow(() => getChatHtml(fakeFiles({ chatJs: 'var s = "<!-- -->"; var t = "<script";' })));
    assert.doesNotThrow(() => getChatHtml(fakeFiles({ chatJs: 'var t = "<script"; var s = "<!--";' })));
});

// @ts-nocheck
/**
 * harness —— 调试脚手架：把真插件代码跑在纯 Node 里，起一个网页服务让你在浏览器里看界面。
 *
 * 做法只有两步：
 *   1. 在 require 里把 "vscode" 这个模块换成 dev/fakeVscode.js（插件代码毫无察觉）；
 *   2. 按插件的正常用法创建 ChatViewProvider 与 PiChatWebServer：
 *      真会话编排、真会话进程（真的拉起 pi）、真网页服务、真界面文件（media/）。
 *
 * 所以浏览器里看到的就是**真插件**的界面与真会话，只是少了 VS Code 那一圈外壳。
 * 验不到的东西（diff 编辑器、符号跳转、系统通知、侧边栏网页视图本身）见 fakeVscode.js 顶部说明。
 *
 * 用法见 dev/browserHost.js（常驻）与 dev/visit.js（自动开浏览器、点几下、截图）。
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const OUT_ENTRY = path.join(repoRoot, "out", "src", "chatViewProvider.js");
const MEDIA_DIR = path.join(repoRoot, "media");
/** 调试会话的工作目录：pi 进程在这里跑。单独一个空目录，免得调试时动到插件仓库本身。 */
const SCRATCH_DIR = path.join(__dirname, ".scratch");

let installed = false;

/** 把 require("vscode") 换成假的 vscode 模块（整个进程只装一次）。 */
function installFakeVscode(options) {
    const fake = require("./fakeVscode.js");
    fake.__configure(options);
    if (installed) { return fake; }
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === "vscode") { return fake; }
        return originalLoad.apply(this, arguments);
    };
    installed = true;
    return fake;
}

/** 调试会话的工作目录：没有就建一个，顺便放两个小文件，好在界面上试"读文件 / 改文件"这类工具卡片。 */
function ensureScratchDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const welcome = path.join(dir, "说明.txt");
    if (!fs.existsSync(welcome)) {
        fs.writeFileSync(welcome,
            "这是 Pi Chat 插件的调试用工作目录（dev/.scratch）。\n" +
            "调试时起的会话就跑在这里，随便改，它不进版本库，也不会碰到插件自己的代码。\n", "utf8");
    }
    const sample = path.join(dir, "示例.js");
    if (!fs.existsSync(sample)) {
        fs.writeFileSync(sample,
            "// 给调试用的小文件：让会话有东西可读、可改\n" +
            "function greet(name) {\n    return `你好，${name}`;\n}\n\n" +
            "module.exports = { greet };\n", "utf8");
    }
    // 一张示例图片：试"读图片"这类功能（图按对话宽度等比例显示、点开看原图）时用得上
    const picture = path.join(dir, "示例图片.png");
    if (!fs.existsSync(picture)) {
        try { require("./makePng.js").writeSamplePng(picture); } catch { /* 生成不了就算了，不影响别的 */ }
    }
    return dir;
}

/**
 * 起一个调试用的会话工作区 + 网页服务。
 *
 * @param {object} [options]
 * @param {string} [options.cwd]      会话的工作目录（默认 dev/.scratch）
 * @param {number} [options.port]     监听端口；0 = 自动挑一个（默认 51999）
 * @param {string} [options.host]     监听地址（默认 127.0.0.1）
 * @param {string} [options.model]    覆盖 piChat.model（默认用你 pi 自己的配置）
 * @param {string} [options.provider] 覆盖 piChat.provider
 * @param {string} [options.piPath]   覆盖 piChat.piPath（默认 "pi"，走 PATH）
 * @param {string} [options.theme]    界面颜色："light" 或 "dark"（默认 light）
 * @param {boolean} [options.toast]   会话跑完要不要发 Windows 通知（默认不要：调试时太吵）
 * @param {(text: string) => void} [options.log] 日志出口（默认打到标准输出）
 * @returns {{ provider: any, server: any, start: () => Promise<string>, stop: () => Promise<void>, url: () => string, cwd: string }}
 */
function createHarness(options = {}) {
    const log = options.log || ((text) => console.log(text));
    const cwd = ensureScratchDir(path.resolve(options.cwd || SCRATCH_DIR));

    if (!fs.existsSync(OUT_ENTRY)) {
        throw new Error(`还没编译：找不到 ${OUT_ENTRY}。先跑 npm run compile（npm run web:dev / web:shot 会自动带上）。`);
    }

    const config = {};
    if (options.model !== undefined) { config.model = options.model; }
    if (options.provider !== undefined) { config.provider = options.provider; }
    if (options.piPath !== undefined) { config.piPath = options.piPath; }

    const fake = installFakeVscode({
        cwd,
        config,
        theme: options.theme === "dark" ? "dark" : "light",
        options: {
            // 会话跑完的提醒（Windows 通知 + 界面提示音）在调试里默认关掉
            "piChat.notifyBeep": options.toast === true,
            "piChat.themeMode": options.theme === "dark" ? "dark" : "light",
        },
        log: (text) => log(text),
    });

    const { ChatViewProvider } = require(OUT_ENTRY);
    const { PiChatWebServer } = require(path.join(repoRoot, "out", "src", "webChatServer.js"));

    const context = {
        subscriptions: [],
        globalState: fake.__store,
        extensionUri: { fsPath: repoRoot, scheme: "file" },
        extension: { packageJSON: { version: "0.0.0-dev" } },
    };

    const provider = new ChatViewProvider(context);
    // 会话跑完的提醒会真的弹 Windows 通知，调试时默认掐掉（见上面的 toast 参数）。
    if (options.toast !== true) { provider.notifyTurnEnd = () => { }; }

    const server = new PiChatWebServer(MEDIA_DIR, provider, {
        log: (text) => log(`[网页服务] ${text}`),
        onUrlChanged: () => { },
    });

    let started = false;
    return {
        provider,
        server,
        cwd,
        url: () => server.url,
        /** 起服务，返回访问地址。 */
        async start() {
            if (started) { return server.url; }
            await server.applySettings({
                enabled: true,
                port: Number.isInteger(options.port) ? options.port : 51999,
                host: options.host || "127.0.0.1",
            });
            started = true;
            if (!server.url) { throw new Error("网页服务没起来（看看上面的日志）。"); }
            return server.url;
        },
        /** 收摊：停网页服务、杀会话进程（不然 Node 进程退不出去）。 */
        async stop() {
            try { await server.stop(); } catch { /* 已经停了 */ }
            for (const item of context.subscriptions.splice(0)) {
                try { item.dispose(); } catch { /* 收摊出错不拦路 */ }
            }
        },
    };
}

module.exports = { createHarness, ensureScratchDir, repoRoot, MEDIA_DIR, SCRATCH_DIR };

// @ts-nocheck
/**
 * harness —— 调试脚手架：把真代码跑在纯 Node 里，起一个网页服务让你在浏览器里看界面。
 *
 * 做法只有三步：
 *   1. 在 require 里把 "vscode" 这个模块换成 dev/fakeVscode.js（插件代码毫无察觉），
 *      按插件的正常用法创建 ChatViewProvider（编辑器这屏，纯客户端）；
 *   2. 用真后端自己的启动函数 startBackend 起一个后端（真会话编排、真会话进程、
 *      真网页服务、真界面文件），浏览器打开的是它给的地址；
 *   3. 后端的设置 / 状态 / 地址文件都指到调试目录（PICHAT_HOME），不动用户真正的
 *      ~/.pi/pichat；插件那侧也靠它找到同一个后端。
 *
 * 所以浏览器里看到的就是**真界面与真会话**，只是少了 VS Code 那一圈外壳。
 * 验不到的东西（diff 编辑器、符号跳转、插件里那块对话面板的网页视图本身）见 fakeVscode.js 顶部说明。
 *
 * 用法见 dev/browserHost.js（常驻）与 dev/visit.js（自动开浏览器、点几下、截图）。
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
// 插件那侧编在 out/extension，后端那侧编在 out/server（见 scripts/compile.mjs）：
// 调试时两边都要真货——插件侧那屏 + 后端那个进程。
const OUT_ENTRY = path.join(repoRoot, "out", "extension", "chatViewProvider.js");
const OUT_SERVER = path.join(repoRoot, "out", "server", "serverMain.js");
const OUT_CONFIG = path.join(repoRoot, "out", "server", "serverConfig.js");
const OUT_BRIDGES = path.join(repoRoot, "out", "server", "bridgeAssets.js");
const MEDIA_DIR = path.join(repoRoot, "media");
/** 调试会话的工作目录：pi 进程在这里跑。单独一个空目录，免得调试时动到插件仓库本身。 */
const SCRATCH_DIR = path.join(__dirname, ".scratch");
/** 调试后端的文件（设置 / 状态 / 地址）放这里；PICHAT_HOME 指过来就不碰用户真配置。 */
const SCRATCH_PICHAT_DIR = path.join(SCRATCH_DIR, "pichat");

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

/** 本仓库的版本号（写进后端的地址文件、派子会话要用的文件目录名）。 */
function packageVersion() {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
        return typeof parsed.version === "string" ? parsed.version : "0";
    } catch {
        return "0";
    }
}

/**
 * 起一个调试用的会话工作区 + 网页服务。
 *
 * @param {object} [options]
 * @param {string} [options.cwd]      会话的工作目录（默认 dev/.scratch）
 * @param {number} [options.port]     监听端口；0 = 自动挑一个（默认 51999）
 * @param {string} [options.host]     监听地址（默认 127.0.0.1）
 * @param {string} [options.model]    覆盖设置里的 model（默认用你 pi 自己的配置）
 * @param {string} [options.provider] 覆盖设置里的 provider
 * @param {boolean} [options.fakePi]  用假模型（dev/fakePi.js）：不调真模型，按剧本秒回（界面调试用）
 * @param {string} [options.piPath]   覆盖用哪个 pi（默认走 PATH；调试时由 PICHAT_PI 传下去）
 * @param {string} [options.theme]    界面颜色："light" 或 "dark"（默认 light）
 * @param {string[]} [options.trustedOrigins] 设置文件里的 webServer.trustedOrigins（服务前面挂 https 反代时用）
 * @param {(text: string) => void} [options.log] 日志出口（默认打到标准输出）
 * @returns {{ provider: any, start: () => Promise<string>, stop: () => Promise<void>, url: () => string|undefined, cwd: string }}
 */
function createHarness(options = {}) {
    const log = options.log || ((text) => console.log(text));
    const cwd = ensureScratchDir(path.resolve(options.cwd || SCRATCH_DIR));

    if (!fs.existsSync(OUT_ENTRY) || !fs.existsSync(OUT_SERVER)) {
        throw new Error(`还没编译：找不到 out/extension 或 out/server 里的文件。先跑 npm run compile（npm run web:dev / web:shot 会自动带上）。`);
    }

    // 后端与插件两侧都靠这个环境变量找同一份地址文件（客户端照它连后端）；
    // 指到调试目录，调试时写的设置、状态、地址都不会碰到用户真正的 ~/.pi/pichat。
    process.env.PICHAT_HOME = SCRATCH_PICHAT_DIR;

    const fake = installFakeVscode({
        cwd,
        theme: options.theme === "dark" ? "dark" : "light",
        log: (text) => log(text),
    });

    const { ChatViewProvider } = require(OUT_ENTRY);
    const { startBackend } = require(OUT_SERVER);
    const { updateServerConfig, readServerConfig, seedPrompts } = require(OUT_CONFIG);
    const { ensureTabaAssets, ensureAskAssets, ensureImageAssets, ensureBashAssets, ensureEnvAssets } = require(OUT_BRIDGES);
    const version = packageVersion();

    // 调试用的设置写进后端那份 config.json：模型跟真后端一样从文件读，界面颜色也在那里定。
    const patch = {
        themeMode: options.theme === "dark" ? "dark" : "light",
    };
    if (options.model !== undefined) { patch.model = options.model; }
    if (options.provider !== undefined) { patch.provider = options.provider; }
    // 假模型 / 指定的 pi：pi 路径不再进设置文件了（永远走 PATH），调试时用这个环境变量盖过
    // （Windows 上 cmd 那个 .cmd 才能被 shell 起来，所以包了一层）
    if (options.fakePi) {
        process.env.PICHAT_PI = path.join(__dirname, process.platform === "win32" ? "fake-pi.cmd" : "fake-pi.sh");
    }
    if (options.piPath !== undefined) { process.env.PICHAT_PI = options.piPath; }
    // 上一跑留下的显示选项（state.json）会盖掉设置文件里的预设：界面点过的优先（见 ChatHost.readOption）。
    // 调试目录本来就是一次性的，直接重写这份存档，让每次调试都从这下面这几项开始。
    // “有事弹不弹提醒”现在只在存档里（面板里那一行），调试时默认关掉：自动化跑一遍会一直弹，太吵。
    try {
        fs.writeFileSync(path.join(SCRATCH_PICHAT_DIR, "state.json"), JSON.stringify({
            "piChat.notifyTurnEnd": options.notifyTurnEnd === true,
        }, null, 2));
    } catch { /* 写不进去就按默认跑 */ }
    // 子会话清单也一样：假 pi 给每个会话报的 .jsonl 是同一个文件（见 fakePi.js），
    // 留着上一跑记下的那份，下一跑里那个文件就整个被当成子会话藏起来（历史列表、自动开最近会话都受影响）。
    try { fs.rmSync(path.join(SCRATCH_PICHAT_DIR, "child-sessions.json"), { force: true }); } catch { /* 同上 */ }
    updateServerConfig(patch, SCRATCH_PICHAT_DIR);
    // 提示词：调试目录也要走真后端那条路（第一次把内置原文写进 config.json），
    // 不然调试会话里的提示词跟真跑起来的不一样。
    seedPrompts(SCRATCH_PICHAT_DIR);
    const prompts = readServerConfig(SCRATCH_PICHAT_DIR).config.prompts;

    // 派子会话要用的文件：真后端启动器会写，这里也得写一份（不然调试时派子会话是坏的）
    ensureTabaAssets(version, prompts);
    // 问话（ask_choice）那个工具要用的扩展：同理
    ensureAskAssets(version, prompts);
    // 会话里的截图挪出会话文件那个扩展：同理（每个会话都加载它）
    ensureImageAssets(version);
    // 接管 bash（后台命令、放后台）：同理（每个会话都加载它）
    ensureBashAssets(version, prompts);
    // 报「加载了什么」（工具 / 技能 / MCP）：同理（每个会话都加载它）
    ensureEnvAssets(version);

    const context = {
        subscriptions: [],
        globalState: fake.__store,
        extensionUri: { fsPath: repoRoot, scheme: "file" },
        extension: { packageJSON: { version: "0.0.0-dev" } },
    };

    // 编辑器这屏：真插件代码，消息转给后端（后端起来前它自己会一直重试）
    const output = fake.window.createOutputChannel("Pi Chat");
    const provider = new ChatViewProvider(context, output);

    let started = null;
    return {
        provider,
        cwd,
        url: () => started && started.url,
        /** 起好的后端宿主（调试用：直接调它验后端那套逻辑，比如“每块屏各看各的会话”）。 */
        host: () => (started ? started.host : undefined),
        /** 起后端，返回访问地址。 */
        async start() {
            if (started) { return started.url; }
            started = await startBackend({
                cwd,
                port: Number.isInteger(options.port) ? options.port : 51999,
                host: options.host || "127.0.0.1",
                trustedOrigins: options.trustedOrigins,
                log,
            });
            return started.url;
        },
        /** 收摊：停后端（连带杀掉会话进程）、放掉插件那侧注册的东西。 */
        async stop() {
            const running = started;
            started = null;
            if (running) { try { await running.stop(); } catch { /* 收摊出错不拦路 */ } }
            for (const item of context.subscriptions.splice(0)) {
                try { item.dispose(); } catch { /* 收摊出错不拦路 */ }
            }
            try { output.dispose(); } catch { /* 已经收了 */ }
            // 给托盘那个子进程一拍：它连着两根管道，收摊时刚关掉，紧跟着 process.exit 的调试脚本
            // 会撞进一个 libuv 断言（Node 在 Windows 上的老毛病，真后端那边见 serverMain 的 exitSoon）
            await new Promise((resolve) => setTimeout(resolve, 150));
        },
    };
}

module.exports = { createHarness, ensureScratchDir, repoRoot, MEDIA_DIR, SCRATCH_DIR, SCRATCH_PICHAT_DIR };

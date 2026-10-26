// @ts-nocheck
/**
 * cdp —— 浏览器驱动：开一个 Chrome（默认无头）、打开页面、点一点、截个图。
 *
 * 不装任何第三方包：用 Node 自带的 fetch 与 WebSocket 直接跟 Chrome 的调试接口说话
 * （Node 22 起才有内置 WebSocket；本文件开头会检查一下）。
 *
 * 只做调试用得上的几件事：
 *   - 开浏览器（Chrome / Edge 自动找，也可以用 --chrome 指定；无头还是显示窗口由调用方定）；
 *   - 打开地址、执行页面脚本、读页面文字、等某段文字出现、点某个元素、发消息、截图；
 *   - 关浏览器。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

/** 常见浏览器可执行文件的位置（找不到时调用方可以用 --chrome 指定）。 */
function findBrowser() {
    const fromEnv = process.env.PICHAT_CHROME;
    const candidates = [
        fromEnv,
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
    ].filter(Boolean);
    for (const item of candidates) {
        try { if (fs.existsSync(item)) { return item; } } catch { /* 换下一个 */ }
    }
    throw new Error("没找到 Chrome / Edge。用 --chrome <可执行文件路径> 指定，或设环境变量 PICHAT_CHROME。");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 极简的调试接口客户端：发命令、等结果、把事件转给订阅者。 */
class Cdp {
    constructor(url) {
        this.url = url;
        this.nextId = 0;
        this.pending = new Map();
        this.handlers = new Map();   // 事件名 -> [处理函数]（message)里没 id 的那些）
        this.sessionId = undefined;
    }

    async open() {
        if (typeof WebSocket === "undefined") {
            throw new Error("这个 Node 版本没有内置 WebSocket（需要 Node 22 以上）。");
        }
        this.ws = new WebSocket(this.url);
        await new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = () => reject(new Error(`连不上浏览器调试接口：${this.url}`));
        });
        this.ws.onmessage = (event) => {
            const message = JSON.parse(String(event.data));
            if (!message.id) {
                for (const fn of this.handlers.get(message.method) || []) { fn(message.params); }
                return;
            }
            const waiting = this.pending.get(message.id);
            if (!waiting) { return; }
            this.pending.delete(message.id);
            if (message.error) { waiting.reject(new Error(`${waiting.method}: ${JSON.stringify(message.error)}`)); }
            else { waiting.resolve(message.result); }
        };
    }

    /** 订阅浏览器事件（如 Runtime.exceptionThrown）；页面报错就靠它收。 */
    on(method, handler) {
        const list = this.handlers.get(method) || [];
        list.push(handler);
        this.handlers.set(method, list);
    }

    send(method, params = {}) {
        const id = ++this.nextId;
        const payload = { id, method, params };
        if (this.sessionId) { payload.sessionId = this.sessionId; }
        this.ws.send(JSON.stringify(payload));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
    }

    close() {
        try { this.ws.close(); } catch { /* 已经关了 */ }
    }
}

/**
 * 启动浏览器并打开一个页面，返回能操作它的把手。
 *
 * @param {object} options
 * @param {string} options.url      要打开的地址
 * @param {boolean} [options.headed] true = 显示窗口（默认无头）
 * @param {string} [options.chrome] 浏览器可执行文件路径
 * @param {number} [options.width]  视口宽（默认 420，手机大小）
 * @param {number} [options.height] 视口高（默认 900）
 * @param {boolean} [options.keep]  true = 跑完不关浏览器窗口
 * @param {boolean} [options.scrollbars] true = 用浏览器本来的滚动条（默认藏起来，截图里不会有滚动条）
 * @param {string} [options.profileDir] 浏览器数据目录（默认临时目录，跑完删掉）
 */
async function openPage(options) {
    const browser = options.chrome || findBrowser();
    const profileDir = options.profileDir || fs.mkdtempSync(path.join(os.tmpdir(), "pichat-dev-chrome-"));
    const args = [
        "--remote-debugging-port=0",          // 端口由系统挑，实际端口写在 DevToolsActivePort 文件里
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-gpu",
        "--window-size=" + (options.width || 420) + "," + (options.height || 900),
    ];
    // 默认藏掉滚动条（截图干净）；想看“浏览器里真正的样子”就给 scrollbars: true。
    // 注意这是有代价的：藏起来时滚动条不占宽度，页面里能塞下的字比真实浏览器多一行半行。
    if (!options.scrollbars) { args.push("--hide-scrollbars"); }
    if (!options.headed) { args.push("--headless=new"); }
    // 调用方额外的启动参数（比如可信来源那条路要 --ignore-certificate-errors 与 --host-resolver-rules）
    args.push(...(options.extraArgs || []), "about:blank");

    const child = spawn(browser, args, { stdio: "ignore" });
    let exitNote;
    child.on("exit", (code) => { exitNote = `浏览器退出了（退出码 ${code}）`; });

    // 等调试端口就绪
    const portFile = path.join(profileDir, "DevToolsActivePort");
    let port = 0;
    for (let i = 0; i < 100; i++) {
        if (exitNote) { throw new Error(exitNote); }
        try {
            const text = fs.readFileSync(portFile, "utf8").split("\n");
            port = Number(text[0]);
            if (port > 0) { break; }
        } catch { /* 还没写出来 */ }
        await sleep(100);
    }
    if (!port) { child.kill(); throw new Error("浏览器调试端口没起来（DevToolsActivePort 一直是空的）。"); }

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.open();
    // 先开一个空白页：视口尺寸要在进真页面之前定好。
    // 反过来做（先加载页面、再改尺寸）的话，浏览器会把改动前那一版画面留在图层里，
    // 截图上会看到两个重叠的界面（一个窄的鬼影 + 一个真的）。
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    cdp.sessionId = attached.sessionId;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // 页面报错 / console.error 都收下来：界面出问题时能直接看到原因（不用手工开 devtools）
    const pageErrors = [];
    cdp.on("Runtime.exceptionThrown", (params) => {
        const d = (params && params.exceptionDetails) || {};
        const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || "未知错误";
        pageErrors.push(String(text).split("\n")[0]);
    });
    cdp.on("Runtime.consoleAPICalled", (params) => {
        if (!params || params.type !== "error") { return; }
        const text = (params.args || []).map((a) => (a && (a.value ?? a.description)) || "").join(" ");
        pageErrors.push("[console.error] " + text);
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: options.width || 420,
        height: options.height || 900,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await cdp.send("Page.navigate", { url: options.url });

    const page = new Page(cdp, options);
    page.pageErrors = pageErrors;   // 页面报错（Runtime.exceptionThrown / console.error）
    const close = async () => {
        cdp.close();
        child.kill();
        if (!options.keep) {
            try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* Windows 上偶尔删不掉，算了 */ }
        }
    };
    return { page, cdp, browser, profileDir, close };
}

/** 一个页面上的常用动作。 */
class Page {
    constructor(cdp, options) {
        this.cdp = cdp;
        this.options = options || {};
        this.shotDir = this.options.shotDir || path.resolve(__dirname, "shots");
        this.shotSeq = 0;
    }

    /** 在页面里跑一段脚本，返回结果。 */
    async eval(expression) {
        const result = await this.cdp.send("Runtime.evaluate", {
            expression: `(() => { ${expression} })()`,
            returnByValue: true,
            awaitPromise: true,
        });
        if (result.exceptionDetails) {
            throw new Error(`页面脚本出错：${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ""}`);
        }
        return result.result.value;
    }

    /** 页面上的可见文字。 */
    async text() {
        return (await this.eval("return document.body.innerText")) || "";
    }

    /** 等页面文字里出现某段文字（给 /正则/ 就按正则匹配）。超时抛错。 */
    async waitText(wanted, timeoutMs) {
        const limit = timeoutMs || this.options.timeoutMs || 60000;
        const started = Date.now();
        let last = "";
        while (Date.now() - started < limit) {
            last = await this.text();
            if (matches(last, wanted)) { return last; }
            await sleep(500);
        }
        throw new Error(`等了 ${Math.round((Date.now() - started) / 1000)} 秒，页面文字里一直没出现：${wanted}\n当前页面文字：${last.slice(0, 400)}`);
    }

    /** 等界面上"可以发消息"：输入框出来了，而且输入框底下那颗圆环已经显示模型了。
     *
     * 为什么不能只看输入框：刚打开的那一两秒里界面已经能打字，但 pi 进程还没有把模型列表
     * 送过来（圆环的提示里写着"未配置模型"）。这时候发出去的消息会碰到还没起来的会话进程，
     * 消息就丢了（连你自己的那条话都不会出现）。等圆环报出模型再发就稳了。
     * 圆环的状态挂在 data-st 上（见 chat.js 的 ctxState）：loading / wait / nomodel / idle / streaming。 */
    async waitReady(timeoutMs) {
        const limit = timeoutMs || 60000;
        const started = Date.now();
        while (Date.now() - started < limit) {
            const ready = await this.eval(`
                const el = document.getElementById('ctxIcon');
                if (!el) { return false; }
                return el.dataset.st === 'idle' || el.dataset.st === 'streaming';
            `);
            if (ready) { await sleep(500); return true; }
            await sleep(300);
        }
        throw new Error('等了 ' + Math.round((Date.now() - started) / 1000) + ' 秒，会话一直没就绪（输入框底下那颗圆环还停在"选模型"）。');
    }

    /** 等模型那边的回复（只看助手的气泡，不会把"自己发出去的那句话"当成回复）。
     *  @param wanted 回复里要出现的文字（可以不给，也不填就是"随便有一句回复"） */
    async waitAnswer(wanted, timeoutMs) {
        const limit = timeoutMs || this.options.timeoutMs || 120000;
        const started = Date.now();
        let last = "";
        while (Date.now() - started < limit) {
            last = await this.answerText();
            if (last.trim() && (!wanted || matches(last, wanted))) { return last; }
            await sleep(500);
        }
        throw new Error(`等了 ${Math.round((Date.now() - started) / 1000)} 秒，模型的回复一直没出现` +
            (wanted ? `（要找的是：${wanted}）` : "") + `\n目前收到的回复：${JSON.stringify(last.slice(0, 300))}`);
    }

    /** 助手的回复文字（把页面上所有助手气泡的文字接起来）。 */
    async answerText() {
        return (await this.eval("return Array.from(document.querySelectorAll('.msg.assistant')).map(function (e) { return e.innerText; }).join('\\n')")) || "";
    }

    /** 在输入框里输入文字（走浏览器原生输入，界面当成真人敲的）。 */
    async type(text) {
        await this.eval(`document.getElementById('input').focus(); return true;`);
        // 逐段插入：换行用回车键，其余用 insertText（这样输入法、粘贴也不会被跳过）
        const lines = String(text).split("\n");
        for (let i = 0; i < lines.length; i++) {
            if (i > 0) { await this.press("Enter", true); }
            if (lines[i]) { await this.cdp.send("Input.insertText", { text: lines[i] }); }
        }
        return true;
    }

    /** 按一下键。@param shift 是否按住 Shift */
    async press(key, shift) {
        const code = key === "Enter" ? "Enter" : key;
        const vk = key === "Enter" ? 13 : 0;
        const modifiers = shift ? 8 : 0;
        await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
        await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    }

    /** 在输入框里输入一段话并回车发送。 */
    async send(text) {
        await this.type(text);
        await this.press("Enter");
        return true;
    }

    /** 点一个元素（用选择器）。 */
    async click(selector) {
        const done = await this.eval(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) { return false; } el.click(); return true;`);
        if (!done) { throw new Error(`页面上没有这个元素：${selector}`); }
        return true;
    }

    /**
     * 按目标条上的按钮：act 给 "play"（开始 / 暂停同一颗）或 "stop"（停止）。
     * 目标条收着的时候按钮也在（只是看不见），所以不用先点开。
     */
    async goalPress(act) {
        return this.click(`#goalBar .gb-act.gb-${act}`);
    }

    /** 截图，存到 dev/shots/。不给名字就按顺序编号。 */
    async shot(name) {
        fs.mkdirSync(this.shotDir, { recursive: true });
        const file = path.join(this.shotDir, name || `${String(++this.shotSeq).padStart(2, "0")}-shot.png`);
        // 给一个显式的裁剪区域：不给的话，无头浏览器有时候会把"上一屏"的老像素留在图上
        // （页面滚动过之后尤其常见：DOM 已经变了，截出来的图还是旧样子）。
        const size = await this.cdp.send("Page.getLayoutMetrics");
        const view = size.cssLayoutViewport || size.layoutViewport;
        const image = await this.cdp.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
            clip: { x: 0, y: 0, width: Math.round(view.clientWidth), height: Math.round(view.clientHeight), scale: 1 },
        });
        fs.writeFileSync(file, Buffer.from(image.data, "base64"));
        return file;
    }

    async sleep(ms) { await sleep(ms); }
}

/** 页面文字里有没有这段话：/斜杠包起来/ 当正则，其余当普通文字。 */
function matches(text, wanted) {
    const pattern = String(wanted);
    if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
        return new RegExp(pattern.slice(1, -1)).test(text);
    }
    return text.includes(pattern);
}

module.exports = { openPage, findBrowser, sleep };

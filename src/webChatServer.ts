import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { getBrowserChatHtml } from "./browserHtml";
import { BrowserChatController, type BrowserChatOwner } from "./browserChatController";
import { contentTypeOf, isAllowedMediaFile, isLoopbackHostHeader, isLoopbackName, isSameOrigin, isWildcardHost, localHostnames } from "./webTransport";

/**
 * PiChatWebServer —— 插件自带的网页服务：让你在浏览器里也能对话。
 *
 * 做的事：
 *   - 用 Node 自带的 http 模块起一个服务（不引入任何第三方依赖），只送四类东西：
 *     对话页面（`/`）、界面资源（`/media/…`）、插件推给页面的消息流（`/events`）、
 *     页面发给插件的消息（`/api`）；
 *   - 插件 → 页面用"服务器推送"（浏览器的 EventSource，长连接，服务器随时能写）；
 *     页面 → 插件用普通请求（POST），按到达顺序交给会话控制器；
 *   - 一个页面占一条推送连接。再开一个页面时，前一个被顶掉（避免两个页面同时改一份会话）。
 *
 * 界面复用现有那一份：HTML 骨架、chat.js、chat.css 与 VSCode 里的网页视图完全同源，
 * 只有通道不同（由 media/browserBridge.js 把"VSCode 网页视图消息通道"接到这里）。
 *
 * 会话是独立的一份：浏览器里开的对话自己一个 pi 进程，与侧边栏、编辑器区互不干扰；
 * VSCode 窗口关掉时服务随之关闭（pi 进程一起关）。
 */

/** 页面发来的单个请求允许的最大字节数（粘贴图片会是好几 MB）。 */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
/** 推送连接的保活间隔：每隔这么久写一条注释行，防止中间设备掐掉空闲连接。 */
const HEARTBEAT_MS = 25_000;

/** 网页服务的设置（来自 piChat.webServer.* 配置项）。 */
export interface WebServerSettings {
    /** 是否开启网页服务（关闭时不监听端口，界面上也不显示入口）。 */
    enabled: boolean;
    /** 监听端口；0 表示自动挑一个空闲端口。 */
    port: number;
    /** 监听地址；默认 127.0.0.1（只有本机能访问）。 */
    host: string;
}

export interface WebServerHooks {
    /** 地址变化（启动、停止、换端口）时回调，用于刷新状态栏提示。 */
    onUrlChanged?(url: string | undefined): void;
    /** 写一行日志（输出面板）。 */
    log(text: string): void;
}

export class PiChatWebServer {
    private server?: http.Server;
    private controller?: BrowserChatController;
    private boundHost = "";
    private boundPort = 0;
    /** 这台机器合法的地址写法（对照请求里的 Origin，挡别的网站偷偷发来的请求）。 */
    private ownHostnames: string[] = [];
    /** 当前占着推送流的那个页面标识（页面自己生成的随机串）。 */
    private activePageId = "";
    private activeRes?: http.ServerResponse;
    /** 刚取过页面、但推送连接还没建好的那个页面标识。
     *  页面加载时 chat.js 发的 ready 可能比推送连接先到，这时不能把它当过期页面拒掉。 */
    private issuedPageId = "";
    private heartbeat?: ReturnType<typeof setInterval>;
    private settings: WebServerSettings = { enabled: false, port: 0, host: "127.0.0.1" };

    constructor(
        private readonly mediaDir: string,
        private readonly owner: BrowserChatOwner,
        private readonly hooks: WebServerHooks,
    ) {}

    // ========================================================================
    //  启动 / 停止
    // ========================================================================

    /** 当前访问地址；服务没开时为 undefined。 */
    public get url(): string | undefined {
        if (!this.server || this.boundPort === 0) { return undefined; }
        return `http://${this.displayHost()}:${this.boundPort}/`;
    }

    /**
     * 显示用的地址。
     * 绑定到具体地址时就用那个地址；绑定“所有网卡”时优先给这台机器在网内的地址
     * （手机要用它访问），一个都没有时退回本机地址。
     */
    private displayHost(): string {
        if (!isWildcardHost(this.boundHost)) {
            return this.boundHost.includes(":") ? `[${this.boundHost}]` : this.boundHost;
        }
        const lan = lanIpv4Addresses();
        return lan.length > 0 ? lan[0] : "127.0.0.1";
    }

    /** 按设置启动或停止；地址变了会通知外部刷新提示。 */
    public async applySettings(settings: WebServerSettings): Promise<void> {
        const changed = (a: WebServerSettings, b: WebServerSettings) =>
            a.port !== b.port || a.host !== b.host;
        const running = this.server !== undefined;
        if (settings.enabled) {
            if (running && !changed(this.settings, settings)) { return; }
            await this.stop();
            await this.start(settings);
            return;
        }
        if (running) { await this.stop(); }
        this.settings = settings;
    }

    private async start(settings: WebServerSettings): Promise<void> {
        this.settings = settings;
        const host = settings.host.trim() || "127.0.0.1";
        const server = http.createServer((req, res) => this.route(req, res));
        // 大图片粘贴成 base64 时请求体会比较大；不限时长，长度有 MAX_REQUEST_BYTES 兜底
        server.requestTimeout = 0;
        this.server = server;

        const wanted = Number.isInteger(settings.port) && settings.port > 0 ? settings.port : 0;
        try {
            await this.listen(server, host, wanted);
        } catch (err: any) {
            if (err?.code === "EADDRINUSE" && wanted !== 0) {
                this.hooks.log(`端口 ${wanted} 已被占用，改用系统自动分配的端口。`);
                try {
                    await this.listen(server, host, 0);
                } catch (err2: any) {
                    this.server = undefined;
                    this.hooks.log(`启动网页服务失败：${err2?.message ?? String(err2)}`);
                    return;
                }
            } else {
                this.server = undefined;
                this.hooks.log(`启动网页服务失败：${err?.message ?? String(err)}`);
                return;
            }
        }

        const address = server.address();
        if (address && typeof address === "object") {
            this.boundHost = address.address;
            this.boundPort = address.port;
        }
        this.ownHostnames = localHostnames(this.boundHost);
        if (this.boundPort === 0) {
            // 理论上不会走到这里：监听成了却读不到端口
            this.hooks.log("监听已就绪，但读不到端口（地址未知），网页服务不开了。");
            this.server = undefined;
            server.close();
            return;
        }
        this.heartbeat = setInterval(() => this.writeHeartbeat(), HEARTBEAT_MS);
        this.hooks.log(`网页服务已启动：${this.url ?? "(地址未知)"}`);
        this.logLanAddresses();
        this.hooks.onUrlChanged?.(this.url);
    }

    /** 监听并等到就绪；失败时把异常抛给调用方。 */
    private listen(server: http.Server, host: string, port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const onError = (err: Error) => {
                server.removeListener("error", onError);
                reject(err);
            };
            server.once("error", onError);
            server.listen(port, host, () => {
                server.removeListener("error", onError);
                resolve();
            });
        });
    }

    /** 绑定到所有网卡或网内地址时，把手机等设备能用的地址写进日志，并提醒一句风险。 */
    private logLanAddresses(): void {
        if (isLoopbackName(this.boundHost)) { return; }
        const found = lanIpv4Addresses();
        this.hooks.log("注意：网页服务现在不只本机可用。同一网络里的任何设备打开下面这个地址，");
        this.hooks.log("      就能读写这台机器上的文件、运行命令（背后是 pi）。不想这样就把 piChat.webServer.host 改回 127.0.0.1。");
        if (found.length > 0) {
            this.hooks.log("手机等设备可用：" + found.map((ip) => `http://${ip}:${this.boundPort}/`).join("  "));
        }
    }

    /** 同步收摊：断推送连接、结束会话工作区（其中的 pi 进程一起结束）、清心跳。 */
    private teardown(): void {
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
        this.closeActiveChannel("网页服务已停止。");
        this.activePageId = "";
        this.issuedPageId = "";
        if (this.controller) {
            this.controller.dispose();
            this.controller = undefined;
        }
        this.boundHost = "";
        this.boundPort = 0;
        this.ownHostnames = [];
    }

    /** 停服务并等监听真的关掉（改配置重启时用）。 */
    public async stop(): Promise<void> {
        const server = this.server;
        const wasRunning = server !== undefined;
        this.server = undefined;
        this.teardown();
        if (server) {
            closeSockets(server);
            await Promise.race([
                new Promise<void>((resolve) => server.close(() => resolve())),
                new Promise<void>((resolve) => setTimeout(resolve, 2000)),
            ]);
        }
        // 本来就什么都没开，不必报“地址没了”（免得状态栏白闪一下）
        if (wasRunning) { this.hooks.onUrlChanged?.(undefined); }
    }

    /** 插件卸载 / 窗口关闭时调用：全同步，不等回调（卸载路径上不能阻塞）。 */
    public dispose(): void {
        const server = this.server;
        this.server = undefined;
        this.teardown();
        this.settings = { ...this.settings, enabled: false };
        if (server) {
            closeSockets(server);
            server.close();
            // 只在真的开过的时候报：卸载时状态栏项可能已经被 VSCode 收掉了
            this.hooks.onUrlChanged?.(undefined);
        }
    }

    // ========================================================================
    //  路由
    // ========================================================================

    private route(req: http.IncomingMessage, res: http.ServerResponse): void {
        try {
            const url = parseRequestUrl(req.url);
            if (!url) {
                this.sendText(res, 400, "请求地址不合法。");
                return;
            }
            if (!this.originAllowed(req)) {
                this.sendText(res, 403, "请求来源不被接受。请直接在浏览器里打开服务给的地址。");
                return;
            }
            const pathname = safeDecode(url.pathname);
            if (pathname === undefined) {
                this.sendText(res, 400, "请求地址不合法。");
                return;
            }
            if (pathname === "/" || pathname === "/index.html") {
                this.sendPage(res, url.searchParams.get("pageId") ?? "");
                return;
            }
            if (pathname.startsWith("/media/")) {
                this.sendMedia(res, pathname.slice("/media/".length));
                return;
            }
            if (pathname === "/events") {
                if (req.method !== "GET") { this.sendText(res, 405, "只接受 GET。"); return; }
                this.openChannel(req, res, url.searchParams.get("pageId") ?? "");
                return;
            }
            if (pathname === "/api") {
                if (req.method !== "POST") { this.sendText(res, 405, "只接受 POST。"); return; }
                void this.handleApi(req, res, url.searchParams.get("pageId") ?? "");
                return;
            }
            this.sendText(res, 404, "没有这个地址。");
        } catch (err: any) {
            this.hooks.log(`处理请求出错：${err?.message ?? String(err)}`);
            try { this.sendText(res, 500, "服务内部错误。"); } catch { /* 连接可能已断 */ }
        }
    }

    /**
     * 请求来源是否可接受。
     * 两道检查：
     *   Host：只监听本机地址时严查，挡“域名重绑定”（别的域名解析到 127.0.0.1 来试探）；
     *   Origin：不管监听在哪里都查，挡“你浏览的某个网站里的脚本偷偷发请求给本服务”
     *           （这种请求即使服务只听本机地址也能发到）。
     */
    private originAllowed(req: http.IncomingMessage): boolean {
        if (isLoopbackName(this.boundHost) && !isLoopbackHostHeader(req.headers.host, this.boundPort)) {
            return false;
        }
        return isSameOrigin(req.headers.origin as string | undefined, this.boundPort, this.ownHostnames);
    }

    private sendPage(res: http.ServerResponse, pageId: string): void {
        // 页面标识由服务生成并写进页面：页面加载时它还没运行任何脚本，
        // 不可能自己报标识；而 chat.js 一跑完就发消息，服务得认得它。
        const id = pageId || `p-${crypto.randomUUID()}`;
        let html: string;
        try {
            html = getBrowserChatHtml(this.mediaDir, id);
        } catch (err: any) {
            this.sendText(res, 500, `生成页面失败：${err?.message ?? String(err)}`);
            return;
        }
        this.ensureController();
        this.issuedPageId = id;
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Length": Buffer.byteLength(html, "utf8"),
        });
        res.end(html);
    }

    private sendMedia(res: http.ServerResponse, name: string): void {
        if (!isAllowedMediaFile(name)) {
            this.sendText(res, 404, "没有这个资源。");
            return;
        }
        fs.readFile(path.join(this.mediaDir, name), (err, data) => {
            if (err) { this.sendText(res, 404, "没有这个资源。"); return; }
            res.writeHead(200, {
                "Content-Type": contentTypeOf(name),
                "Cache-Control": "no-store",
                "Content-Length": data.length,
            });
            res.end(data);
        });
    }

    private sendText(res: http.ServerResponse, status: number, text: string): void {
        const body = Buffer.from(text, "utf8");
        if (res.headersSent) { res.end(); return; }
        res.writeHead(status, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Length": body.length,
        });
        res.end(body);
    }

    // ========================================================================
    //  推送连接（插件 → 页面）
    // ========================================================================

    private openChannel(req: http.IncomingMessage, res: http.ServerResponse, pageId: string): void {
        this.ensureController();
        // 同一时间只让一个页面收消息：新页面来了就顶掉旧的
        if (this.activeRes && this.activeRes !== res) {
            this.closeActiveChannel("此页面已被新打开的 Pi Chat 页面接管。可点下面的按钮接管回来。");
        }
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        res.socket?.setNoDelay(true);
        this.activeRes = res;
        this.activePageId = pageId;
        this.issuedPageId = pageId;
        const controller = this.controller;
        if (controller) {
            controller.attachChannel({ send: (msg) => this.pushToPage(res, msg) });
        }
        const onClose = () => {
            if (this.activeRes !== res) { return; } // 已被新页面顶掉，不必清理
            this.activeRes = undefined;
            this.activePageId = "";
            if (this.issuedPageId === pageId) { this.issuedPageId = ""; }
            this.controller?.detachChannel();
        };
        req.on("close", onClose);
        req.on("error", onClose);
        res.on("error", onClose);
    }

    /** 把一条消息写成推送事件（JSON 一行，符合推送格式）。 */
    private pushToPage(res: http.ServerResponse, msg: Record<string, unknown>): void {
        if (res.writableEnded) { return; }
        try {
            res.write(`event: msg\ndata: ${JSON.stringify(msg)}\n\n`);
        } catch { /* 连接已断：交给 onClose 处理 */ }
    }

    private writeHeartbeat(): void {
        const res = this.activeRes;
        if (!res || res.writableEnded) { return; }
        try { res.write(": keep-alive\n\n"); } catch { /* 连接已断 */ }
    }

    private closeActiveChannel(note: string): void {
        const res = this.activeRes;
        this.activeRes = undefined;
        this.activePageId = "";
        this.issuedPageId = "";
        this.controller?.detachChannel();
        if (!res || res.writableEnded) { return; }
        try {
            res.write(`event: end\ndata: ${JSON.stringify({ note })}\n\n`);
            res.end();
        } catch { /* 连接已断 */ }
    }

    // ========================================================================
    //  页面发来的消息（页面 → 插件）
    // ========================================================================

    private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, pageId: string): Promise<void> {
        // 谁的页面在说话：
        //   - 正在收推送的那个页面：正常放行；
        //   - 刚取过页面、推送连接还没建好的那个页面：也放行（回的消息先攒着，连上再补发）；
        //   - 其余一律当作已经被顶掉的旧页面，拒绝并让它提示用户。
        const accepted = pageId !== "" && (pageId === this.activePageId || (this.activePageId === "" && pageId === this.issuedPageId));
        if (!accepted) {
            this.sendText(res, 409, "此页面已被新打开的 Pi Chat 页面接管。");
            return;
        }
        const text = await readBody(req, MAX_REQUEST_BYTES);
        if (text === undefined) {
            this.sendText(res, 413, "请求内容过大。");
            return;
        }
        let msg: any;
        try {
            msg = JSON.parse(text);
        } catch {
            this.sendText(res, 400, "请求内容不是合法的 JSON。");
            return;
        }
        const controller = this.ensureController();
        try {
            controller.processMessage(msg);
        } catch (err: any) {
            this.hooks.log(`处理页面消息出错：${err?.message ?? String(err)}`);
        }
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
    }

    /** 会话工作区：第一次有页面进来时创建，之后一直复用（页面刷新不丢会话）。 */
    private ensureController(): BrowserChatController {
        if (this.controller && !this.controller.isDisposed()) { return this.controller; }
        this.controller = new BrowserChatController(this.owner);
        // 页面可能先发了消息、推送连接后到：这种情况由控制器内部的消息缓冲兜住
        if (this.activeRes) {
            const res = this.activeRes;
            this.controller.attachChannel({ send: (msg) => this.pushToPage(res, msg) });
        }
        return this.controller;
    }
}

/**
 * 解析请求地址。
 *
 * 不用请求头里的 Host 作基准：请求地址写成 "//xxx" 时会被当成“用基准的协议 + 自己的主机名”，
 * 拼出来就不是一个合法地址，抛出去就成了 500。这里把开头的多余斜杠归一，再用一个固定的假主机名作基准。
 * 解析不了返回 undefined（调用方回 400）。
 */
function parseRequestUrl(raw: string | undefined): URL | undefined {
    const normalized = (raw ?? "/").replace(/^[\/\\]+/, "/");
    try {
        return new URL(normalized, "http://pi-chat.local");
    } catch {
        return undefined;
    }
}

/** 把地址里的百分号转义解开；解不开（例如 %zz）返回 undefined。 */
function safeDecode(pathname: string): string | undefined {
    try {
        return decodeURIComponent(pathname);
    } catch {
        return undefined;
    }
}

/** 这台机器在网内的 IPv4 地址（手机等设备用这些地址访问）。 */
function lanIpv4Addresses(): string[] {
    const found: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const item of list ?? []) {
            if (item.family === "IPv4" && !item.internal) { found.push(item.address); }
        }
    }
    return found;
}

/** 把服务上现有的连接全部断开（长连接不断，close 就不会结束）。 */
function closeSockets(server: http.Server): void {
    const closeAll = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
    if (typeof closeAll === "function") { closeAll.call(server); }
}

/** 读请求体（带上限）；超出上限返回 undefined。 */
function readBody(req: http.IncomingMessage, limit: number): Promise<string | undefined> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = (value: string | undefined) => {
            if (done) { return; }
            done = true;
            resolve(value);
        };
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                chunks.length = 0;
                req.destroy();
                finish(undefined);
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
        req.on("error", () => finish(undefined));
    });
}

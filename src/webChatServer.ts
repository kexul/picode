import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { getBrowserChatHtml } from "./browserHtml";
import { BrowserChatController, type BrowserChatOwner } from "./browserChatController";
import {
    contentTypeOf,
    isAllowedMediaFile,
    isLoopbackHostHeader,
    isLoopbackName,
    isSameOrigin,
    isWildcardHost,
    localHostnames,
    PAGE_TRANSIENT_MESSAGE_TYPES,
    PageChannels,
    type PageChannel,
} from "./webTransport";

/**
 * PiChatWebServer —— 插件自带的网页服务：让你在浏览器里也能对话。
 *
 * 做的事：
 *   - 用 Node 自带的 http 模块起一个服务（不引入任何第三方依赖），只送四类东西：
 *     对话页面（`/`）、界面资源（`/media/…`）、插件推给页面的消息流（`/events`）、
 *     页面发给插件的消息（`/api`）；
 *   - 插件 → 页面用"服务器推送"（浏览器的 EventSource，长连接，服务器随时能写）；
 *     页面 → 插件用普通请求（POST），按到达顺序交给会话控制器；
 *   - 一个页面占一条推送连接，几个页面（手机 + 电脑）可以同时连着，插件推的消息发给每一个；
 *     确认框、选项浮层只发给"人最近在里面动过"的那个页面。
 *
 * 界面复用现有那一份：HTML 骨架、chat.js、chat.css 与 VSCode 里的网页视图完全同源，
 * 只有通道不同（由 media/browserBridge.js 把"VSCode 网页视图消息通道"接到这里）。
 *
 * 会话是独立的一份：浏览器里开的对话自己一个 pi 进程，与侧边栏、编辑器区互不干扰；
 * VSCode 窗口关掉时服务随之关闭（pi 进程一起关）。
 */

/** 页面发来的单个请求允许的最大字节数（粘贴图片会是好几 MB）。 */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
/** 心跳间隔：每隔这么久给每条推送连接写一个页面收得到的 tick，同时巡检一遍死连接。
 *  一来防止中间设备掐掉空闲连接，二来页面靠"多久没收到 tick"自己判断连接是不是已经死了。 */
const HEARTBEAT_MS = 25_000;
/** 页面超过这么久没有任何动静（报活或发消息）就把它那条连接收掉。
 *  手机退到后台后定时器被冻住，报活自然停了：那条连接多半已经死了，占着只会白攒消息。
 *  页面回到前台会自己重连，报上自己处理到第几条消息，插件把漏掉的补发给它；
 *  补不上的才整屏重画（见 browserChatController 的 browserResync）。 */
const PAGE_STALE_MS = 90_000;
/** 一条推送连接最多积压多少字节：页面不读了（屏黑了 / 网络卡住）就别再往里塞，
 *  掐掉让它重连重画。不掐的话这些字节全堆在插件进程里，回来时也不会被 GC 回收。 */
const STREAM_BACKLOG_BYTES = 8 * 1024 * 1024;

/** 重连补发用的消息暂存默认条数：超过先丢最老的（丢了就补不上，只能整屏重画）。 */
const CATCHUP_LOG_ENTRIES = 2000;
/** 重连补发用的消息暂存默认字节数（消息里可能带大图，光按条数不可靠）。 */
const CATCHUP_LOG_BYTES = 8 * 1024 * 1024;

/** 时间与上限的可调部分（测试里传小值，不用真的等一分钟）。 */
export interface WebServerTimings {
    /** 心跳与死连接巡检的间隔（毫秒）。 */
    heartbeatMs?: number;
    /** 页面静默多久算死（毫秒）。 */
    pageStaleMs?: number;
    /** 一条连接的积压上限（字节）。 */
    backlogBytes?: number;
    /** 补发暂存的条数上限。 */
    catchupLogEntries?: number;
    /** 补发暂存的字节上限。 */
    catchupLogBytes?: number;
}

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
    /** 连着的页面（一个页面一条推送连接）；也记着服务发出过哪些页面标识。 */
    private readonly pages = new PageChannels();
    /** 页面标识 → 它那条连接的响应对象（心跳要往里写 tick）。 */
    private readonly streams = new Map<string, http.ServerResponse>();
    /** 推给页面的消息序号：每广播一条加一。页面靠它报「我处理到第几条」。 */
    private seqCounter = 0;
    /** 最近广播的消息（重连补发用）。序号连续；一次性消息只占位不补发（msg 为 null）。 */
    private readonly catchupLog: Array<{ seq: number; bytes: number; msg: Record<string, unknown> | null }> = [];
    private catchupLogBytes = 0;
    private readonly catchupLogEntries: number;
    private readonly catchupLogBytesLimit: number;
    /** 页面当前这条推送连接建立时的序号：比它大的都是这条连接的实时消息（见 openChannel 的 hello）。 */
    private readonly openSeqByPage = new Map<string, number>();
    private heartbeat?: ReturnType<typeof setInterval>;
    private readonly heartbeatMs: number;
    private readonly pageStaleMs: number;
    private readonly backlogBytes: number;
    private settings: WebServerSettings = { enabled: false, port: 0, host: "127.0.0.1" };

    constructor(
        private readonly mediaDir: string,
        private readonly owner: BrowserChatOwner,
        private readonly hooks: WebServerHooks,
        timings?: WebServerTimings,
    ) {
        this.heartbeatMs = timings?.heartbeatMs ?? HEARTBEAT_MS;
        this.pageStaleMs = timings?.pageStaleMs ?? PAGE_STALE_MS;
        this.backlogBytes = timings?.backlogBytes ?? STREAM_BACKLOG_BYTES;
        this.catchupLogEntries = timings?.catchupLogEntries ?? CATCHUP_LOG_ENTRIES;
        this.catchupLogBytesLimit = timings?.catchupLogBytes ?? CATCHUP_LOG_BYTES;
    }

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
        this.heartbeat = setInterval(() => this.writeHeartbeat(), this.heartbeatMs);
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

    /** 同步收摊：断掉每条推送连接、结束会话工作区（其中的 pi 进程一起结束）、清心跳。 */
    private teardown(): void {
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
        for (const channel of this.pages.removeAll()) {
            // 告别话要给：页面收到 end 就不再重连（服务真的停了，重连也没用）
            channel.close("网页服务已停止。");
        }
        this.streams.clear();
        this.openSeqByPage.clear();
        this.catchupLog.length = 0;
        this.catchupLogBytes = 0;
        if (this.controller) {
            this.controller.setHub(undefined);
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
        // 记下"这个标识是本服务发出的"：页面里 chat.js 发的 ready 可能比推送连接先到，
        // 那时也得收下它的消息（否则会被当成过期页面拒掉）
        this.pages.markIssued(id);
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

    /**
     * 一个页面来开推送连接。
     *
     * 几个页面可以同时连着（手机一个、电脑一个），谁都不是"唯一的"：插件推的消息发给每一个。
     * 同一个页面又连了一次（手机退到后台再回来、网络断了又通），把它那条旧连接安静收掉就行，
     * 不发"你被别的页面顶掉了"那种话——那只是它自己重连。
     */
    private openChannel(req: http.IncomingMessage, res: http.ServerResponse, pageId: string): void {
        const controller = this.ensureController();
        // 页面标识正常都是服务发出页面时写进去的那个；万一没有就自己编一个，别把好几个页面混成一条
        const id = pageId || `p-anon-${crypto.randomUUID()}`;
        const { channel, replaced } = this.pages.add(
            id,
            (msg) => { this.writeChunk(channel, res, `event: msg\ndata: ${JSON.stringify(msg)}\n\n`); },
            (note) => { this.endStream(res, note); },
        );
        this.streams.set(id, res);
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });
        // retry 是给浏览器看的：万一由浏览器自己重连，隔 1 秒就来一次（页面那头也会自己管重连）
        res.write("retry: 1000\n\n");
        res.write(": connected\n\n");
        // 这条连接建立时的序号。比它大的消息都会写给这条连接（实时消息）；
        // 页面手里更老的序号对应的是断线期间漏掉的，重连后由它报数、插件补发。
        // hello 必须走在一切带序号的消息前面：页面靠它分清实时和补发（见 browserBridge.js）。
        const openSeq = this.seqCounter;
        this.openSeqByPage.set(id, openSeq);
        this.writeChunk(channel, res, `event: msg\ndata: ${JSON.stringify({ type: "hello", seq: openSeq })}\n\n`);
        res.socket?.setNoDelay(true);
        if (replaced) { replaced.close(""); }   // 同一个页面的旧连接：安静断掉，页面那头不会弹提示
        const onClose = () => { this.dropChannel(channel); };
        req.on("close", onClose);
        req.on("error", onClose);
        res.on("error", onClose);
        // 断线这段时间插件攒下的消息补给这个页面（页面自己还会再要求整屏重画，两边都对得上）
        controller.onPageConnected(id);
    }

    /**
     * 往一条推送连接写一段内容。
     *
     * 写不动了就把它注销掉：页面那头（手机屏黑了、退到后台、网络断了）多半已经收不到，
     * 继续往里塞只是把这些字节堆在插件进程里。积压超过上限直接掐掉连接，页面回来会自己重连，
     * 重连后插件给它整屏重画一遍，内容不会少。
     */
    private writeChunk(channel: PageChannel, res: http.ServerResponse, chunk: string): void {
        if (res.writableEnded || res.destroyed) { this.dropChannel(channel); return; }
        try {
            const flushed = res.write(chunk);
            if (!flushed && res.writableLength > this.backlogBytes) {
                this.hooks.log(`页面 ${channel.id} 有一阵子没在读推送流（积压 ${Math.round(res.writableLength / 1024)} KB），` +
                    "掐掉这条连接。页面回到前台会自己重连，重连后整屏重画一遍。");
                channel.close("");
                this.dropChannel(channel);
            }
        } catch {
            this.dropChannel(channel);
        }
    }

    /** 断开一条推送连接（页面走了 / 死连接被巡检掐掉 / 积压太多）。 */
    private dropChannel(channel: PageChannel): void {
        // 同一个页面标识的新连接已经顶上来了：那是它重连后的新连接，不能跟着一起注销
        if (this.pages.get(channel.id) !== channel) { return; }
        this.pages.remove(channel.id);
        if (this.streams.get(channel.id) !== undefined) { this.streams.delete(channel.id); }
        this.openSeqByPage.delete(channel.id);
        this.controller?.onPageDisconnected(channel.id);
    }

    /** 结束一条推送连接。@param note 告别话：给了就先写给页面（页面收到就不再重连），空串表示安静地断。 */
    private endStream(res: http.ServerResponse, note: string): void {
        if (res.writableEnded || res.destroyed) { return; }
        try {
            if (note) {
                res.write(`event: end\ndata: ${JSON.stringify({ note })}\n\n`);
                res.end();
            } else {
                res.destroy();
            }
        } catch { /* 连接已经断了 */ }
    }

    /** 每隔一个心跳周期：先收掉半天没动静的连接，再给每条连接写一个页面收得到的 tick。 */
    private writeHeartbeat(): void {
        const now = Date.now();
        for (const id of this.pages.staleIds(this.pageStaleMs)) {
            const stale = this.pages.get(id);
            if (!stale) { continue; }
            this.hooks.log(`页面 ${id} 已经 ${Math.round(this.pageStaleMs / 1000)} 秒没有任何动静（多半是退到后台了），` +
                "先把它的推送连接收掉。页面回来会自己重连并补拉漏掉的消息。");
            this.pages.remove(id);
            this.streams.delete(id);
            this.openSeqByPage.delete(id);
            stale.close("");
            this.controller?.onPageDisconnected(id);
        }
        this.pages.forEach((channel) => {
            const res = this.streams.get(channel.id);
            if (!res) { return; }
            this.writeChunk(channel, res, `event: tick\ndata: ${JSON.stringify({ t: now })}\n\n`);
        });
    }

    // ---- 会话工作区往外发消息用的出口（PageChannelHub） ----

    /**
     * 发给所有连着的页面，并给消息记上一个递增的序号（哪怕当时一个页面都没连着）。
     * 一个页面都没连着返回 false（工作区会先把消息攒着）；
     * 但序号和补发暂存都照记：页面重连后就是靠这些序号补拉漏掉的消息的。
     */
    public broadcast(msg: Record<string, unknown>): boolean {
        const seq = ++this.seqCounter;
        msg.seq = seq;
        this.rememberForCatchup(seq, msg);
        let any = false;
        this.pages.forEach((channel) => { any = true; channel.send(msg); });
        return any;
    }

    /** 只发给一个页面（给它整屏重画 / 补发时用）。这类消息不带序号、不进补发暂存。 */
    public sendTo(pageId: string, msg: Record<string, unknown>): boolean {
        const channel = this.pages.get(pageId);
        if (!channel) { return false; }
        channel.send(msg);
        return true;
    }

    /** 有没有这个页面连着（整屏重画送得出去吗；送不出去就先记着，等它连上再画）。 */
    public hasPage(pageId: string): boolean {
        return this.pages.has(pageId);
    }

    /** 当前的消息序号（整屏重画完让页面对齐到这个位置，下次重连它报的数才是准的）。 */
    public currentSeq(): number {
        return this.seqCounter;
    }

    /**
     * 页面重连后补发它错过的消息。
     *
     * @param lastSeq 页面报上来的「我处理到的最后一个序号」。
                断线期间广播出去的消息序号都记在暂存里，把 (lastSeq, 这条连接建立时的序号]
                这一段补给它，再发一条 syncPoint 告诉它「补齐到第几条了」。
     * @returns true 表示已经办好（补了该补的，或本来就一条不缺）；
     *          false 表示补不了（页面不在了，或缺得太多暂存里已经没有）——调用方退回整屏重画。
     */
    public catchUp(pageId: string, lastSeq: number): boolean {
        if (!Number.isFinite(lastSeq) || lastSeq < 0) { return false; }
        const channel = this.pages.get(pageId);
        const openSeq = this.openSeqByPage.get(pageId);
        if (!channel || openSeq === undefined) { return false; }
        if (lastSeq >= openSeq) { return true; }   // 一条不缺，什么都不用补
        const oldest = this.catchupLog.length > 0 ? this.catchupLog[0].seq : undefined;
        // 暂存里的序号是连续的；最老的那条比页面报的还新，说明中间缺的已经丢了，补不全
        if (oldest === undefined || oldest > lastSeq + 1) { return false; }
        for (const entry of this.catchupLog) {
            if (entry.seq <= lastSeq) { continue; }
            if (entry.seq > openSeq) { break; }
            if (entry.msg) { channel.send(entry.msg); }
        }
        channel.send({ type: "syncPoint", seq: openSeq });
        return true;
    }

    /**
     * 把刚广播的一条消息记进补发暂存。
     * 「一次性消息」（确认框、浮层这类）只占个序号位不存内容：它们不补发（见 webTransport 的名单）。
     * 超过条数或字节上限就从最老的开始丢；丢了的那段补不上，页面只能整屏重画。
     */
    private rememberForCatchup(seq: number, msg: Record<string, unknown>): void {
        const transient = typeof msg.type === "string" && PAGE_TRANSIENT_MESSAGE_TYPES.has(msg.type);
        let bytes = 0;
        if (!transient) {
            try { bytes = Buffer.byteLength(JSON.stringify(msg), "utf8"); } catch { bytes = 0; }
        }
        this.catchupLog.push({ seq, bytes, msg: transient ? null : msg });
        this.catchupLogBytes += bytes;
        while (
            this.catchupLog.length > this.catchupLogEntries
            || (this.catchupLogBytes > this.catchupLogBytesLimit && this.catchupLog.length > 1)
        ) {
            const dropped = this.catchupLog.shift();
            if (!dropped) { break; }
            this.catchupLogBytes -= dropped.bytes;
        }
    }

    /** 人最近在里面动过的那个页面（确认框、选项浮层发给它）。 */
    public recentPageId(): string | undefined {
        return this.pages.recent()?.id;
    }

    /** 有没有页面连着。 */
    public anyPage(): boolean {
        return this.pages.size > 0;
    }

    // ========================================================================
    //  页面发来的消息（页面 → 插件）
    // ========================================================================

    /**
     * 页面发来一条消息。
     *
     * 不再挑"哪一个页面才算数"：几个页面可以同时用（手机 + 电脑）。只有本服务从没见过的
     * 页面标识才拒掉——那多半是服务重启前留下的旧页面，让它刷新一下比默默收下更清楚。
     * 页面断开、正在重连的那段时间发来的消息也照收（标识还在"发出过"那份名单里），
     * 回的东西先攒着，等它连上补发；这正是手机退到后台再回来时最容易踩的那一瞬间。
     */
    /**
     * 页面发来一条消息。
     *
     * 不再挑"哪一个页面才算数"：手机、电脑可以同时开着，谁发消息都收。
     * 只有一件事要挡：本服务从来没见过的页面标识（多半是服务重启前留下的旧页面），
     * 那种收下也没有出口，明确让它刷新比默默吃掉好。
     * 页面暂时断开（手机退到后台再回来）时发来的消息照常收下：那时它多半正在重连，
     * 回的东西由会话工作区攒着，连接回来一次补齐，再整屏重画一遍。
     */
    private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, pageId: string): Promise<void> {
        if (!this.pages.isKnown(pageId)) {
            this.sendText(res, 409, "此页面不是当前这个网页服务发出的（服务可能重启过）。刷新页面就好。");
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
        if (msg && msg.type === "channelPing") {
            // 页面报活：只说明它还活着，不算"人在里面动过"
            this.pages.beat(pageId);
        } else {
            this.pages.touch(pageId, true);
            const controller = this.ensureController();
            try {
                controller.processMessage(msg, pageId);
            } catch (err: any) {
                this.hooks.log(`处理页面消息出错：${err?.message ?? String(err)}`);
            }
        }
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
    }

    /** 会话工作区：第一次有页面进来时创建，之后一直复用（页面刷新不丢会话）。 */
    private ensureController(): BrowserChatController {
        if (this.controller && !this.controller.isDisposed()) { return this.controller; }
        const controller = new BrowserChatController(this.owner);
        // 往外发消息的出口就是本服务自己（推给所有连着的页面）
        controller.setHub(this);
        this.controller = controller;
        return controller;
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

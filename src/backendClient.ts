import * as http from "http";
import { readServerAddress, probeServer } from "./serverState";

/**
 * BackendClient —— 插件连独立后端的那条线（不引用 vscode）。
 *
 * 插件这边有两条流，都连在同一个后端上：
 *   - **页面流**（`/events` + `/api`）：网页视图那一屏的收发。插件只是转手——
 *     网页视图发来的消息原样转给后端，后端推来的消息原样转给网页视图，
 *     所以界面代码一个字都不用改（它以为自己还在跟插件进程说话）；
 *   - **屏流**（`/screen` + `/screenapi`）：这个窗口在后端登记"我打开着这些文件夹"，
 *     后端把"用编辑器打开这个文件"这类活派过来，干完回一句。
 *
 * 断线自己重连（后端重启、网断了、VsCode 窗口睡了都算）：页面标识是后端现发的，
 * 所以重连时要重新领一个，再按老规矩报一次"我处理到第几条"，漏掉的消息后端补发，
 * 补不上就整屏重画。
 */

/** 页面报活的间隔：比后端判"死了"的 90 秒短得多，正常情况绝不会被误判。 */
const PING_MS = 25_000;
/** 多久检查一次"推送连接是不是其实已经死了"（后端每 25 秒写一个 tick）。 */
const WATCHDOG_MS = 5_000;
/** 这么久没收到 tick 就认为连接死了（手机 / 笔记本睡过去再醒来时常见）。 */
const TICK_TIMEOUT_MS = 60_000;
/** 重连等待阶梯（毫秒）：头几次快，之后固定在 8 秒。一直试下去，不认输。 */
const RETRY_DELAYS_MS = [400, 800, 1500, 3000, 8000];

/** 连接状态：offline = 后端没在跑（或连不上）。 */
export type BackendState = "offline" | "connecting" | "online";

export interface BackendClientOptions {
    /** 这个窗口打开着的文件夹（后端按它决定活派给谁）。 */
    folders(): string[];
    /** 后端推给页面的消息：原样转给网页视图。 */
    onPageEvent(msg: Record<string, unknown>): void;
    /** 后端派来的、只有编辑器才干得了的活。 */
    onScreenRequest(msg: any): void;
    /** 后端报"这个工作区改动过这些文件"（窗口拿它算符号表）。 */
    onSessionFiles(files: string[]): void;
    /** 连接状态变了（界面据此显示"后端没在跑"或者正常工作）。 */
    onStatus(state: BackendState, note?: string): void;
    log?(text: string): void;
    /** 后端地址；不给就从 `~/.pi/pichat/server.json` 读 + 探活。 */
    url?: string;
    /** 屏标识：同一个窗口重连时不变（后端认得它，不会越连越多）。 */
    screenId?: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 拼一条流地址（保留基础地址里的路径前缀，将来挂到子路径下也不用改）。 */
function streamUrl(base: URL, pathname: string, query: Record<string, string>): URL {
    const url = new URL(base.toString());
    url.pathname = (url.pathname.replace(/\/+$/, "") + pathname) || pathname;
    url.search = "";
    for (const [k, v] of Object.entries(query)) { url.searchParams.set(k, v); }
    return url;
}

/** POST 一段 JSON，收集回应（超时 / 连不上就当失败）。 */
function postJson(target: URL, body: unknown, timeoutMs = 5000): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body ?? null), "utf8");
        const req = http.request({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname + target.search,
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": payload.length },
        }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => { text += chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        });
        req.setTimeout(timeoutMs, () => { req.destroy(new Error("请求超时")); });
        req.on("error", reject);
        req.end(payload);
    });
}

/**
 * 读一条服务器推送流（EventSource 那套格式：`event:` + `data:`，空行分隔一条）。
 * 自己用 http 模块读，不引第三方库。
 */
function openSse(
    target: URL,
    onOpen: () => void,
    onEvent: (event: string, data: string) => void,
    onEnd: (note: string) => void,
): http.ClientRequest {
    let ended = false;
    const end = (note: string) => {
        if (ended) { return; }
        ended = true;
        onEnd(note);
    };
    const req = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "GET",
        headers: { Accept: "text/event-stream" },
    }, (res) => {
        if (res.statusCode !== 200) {
            res.resume();
            end(`HTTP ${res.statusCode}`);
            return;
        }
        onOpen();
        let buffer = "";
        let event = "";
        let data = "";
        const flush = () => {
            if (event === "" && data === "") { return; }
            const payload = data.endsWith("\n") ? data.slice(0, -1) : data;
            const name = event === "" ? "message" : event;
            event = "";
            data = "";
            onEvent(name, payload);
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
            buffer += chunk;
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
                let line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (line.endsWith("\r")) { line = line.slice(0, -1); }
                if (line === "") { flush(); continue; }
                if (line.startsWith(":")) { continue; }
                const colon = line.indexOf(":");
                const field = colon < 0 ? line : line.slice(0, colon);
                const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
                if (field === "event") { event = value; }
                else if (field === "data") { data += value + "\n"; }
                // 其余字段（id/retry）用不上：重连由这边自己管
            }
        });
        res.on("end", () => end("连接被后端收回"));
        res.on("close", () => end("连接断开"));
        res.on("error", (err) => end(err.message));
    });
    req.on("error", (err) => end(err.message));
    req.end();
    return req;
}

/** 一次连接（屏流 + 页面流）的有效期。 */
interface Session {
    seq: number;
    dead: boolean;
    reason: string;
    /** 把这次连接了结掉（断流 / 心跳超时时调）。 */
    die?: (reason: string) => void;
}

export class BackendClient {
    private readonly options: BackendClientOptions;
    private readonly screenId: string;
    private readonly pingMs = PING_MS;
    private readonly watchdogMs = WATCHDOG_MS;
    private readonly tickTimeoutMs = TICK_TIMEOUT_MS;
    private readonly retryDelaysMs = RETRY_DELAYS_MS;

    private running = false;
    private currentState: BackendState = "offline";
    private lastNote = "";
    /** 现在这条连接（断开重连时把它了结掉）。 */
    private current?: Session;
    private base?: URL;
    private pageId = "";
    /** 每次连接尝试加一：迟到的回调靠它判断自己是不是已经过期。 */
    private sessionSeq = 0;
    private pageReq?: http.ClientRequest;
    private screenReq?: http.ClientRequest;
    private pingTimer?: ReturnType<typeof setInterval>;
    private watchdogTimer?: ReturnType<typeof setInterval>;
    private lastTickAt = 0;
    /** 页面的推送进度（跟浏览器那套一样：实时消息与补发各记一本账）。 */
    private liveFromSeq = 0;
    private catchUpThrough = 0;
    private lastSeq = 0;
    /** 屏流连上了没有（HTTP 200 就算连上，后端一接受就读得到）。 */
    private screenUp = false;

    constructor(options: BackendClientOptions) {
        this.options = options;
        this.screenId = options.screenId ?? `s-${Math.random().toString(36).slice(2, 10)}`;
    }

    /** 后端现在的地址（状态栏、"在浏览器里打开"用）。 */
    public get url(): string | undefined { return this.base?.toString(); }

    /** 开始连（连不上就自己一直重试，不用调用方管）。 */
    public start(): void {
        if (this.running) { return; }
        this.running = true;
        void this.loop();
    }

    /** 收摊：断开两条流、停掉定时器（窗口关闭 / 插件卸载）。 */
    public stop(): void {
        this.running = false;
        this.forceReconnect(undefined);
        this.setStatus("offline");
    }

    // ========================================================================
    //  连与断
    // ========================================================================

    private async loop(): Promise<void> {
        let attempt = 0;
        while (this.running) {
            const base = await this.resolveBase();
            if (base) {
                this.setStatus("connecting");
                const lasted = await this.connectOnce(base);
                attempt = lasted ? 0 : attempt + 1;
            } else {
                this.setStatus("offline", "没找到在跑的后端（先在终端里敲 pichat 起来）");
                attempt += 1;
            }
            if (!this.running) { return; }
            const delay = this.retryDelaysMs[Math.min(Math.max(attempt - 1, 0), this.retryDelaysMs.length - 1)];
            await sleep(delay);
        }
    }

    /** 后端在哪：调用方给的地址优先；否则读地址文件再探活（探活确认那端口上确实是 pichat）。 */
    private async resolveBase(): Promise<URL | undefined> {
        let target = this.options.url;
        if (!target) {
            const addr = readServerAddress();
            if (!addr || !addr.url) { return undefined; }
            target = addr.url;
        }
        try { new URL(target); } catch { return undefined; }   // 地址写坏了就当下线
        // 都要探一下：探活确认那个端口上确实是活着的 pichat（否则可能连到别人的服务上）
        const probe = await probeServer(target);
        if (!probe || !probe.url) { return undefined; }
        return new URL(probe.url);
    }

    /**
     * 连一次，直到某一条流断掉。
     * @returns 这次连上过没有（决定下次重连等多久）。
     */
    private async connectOnce(base: URL): Promise<boolean> {
        const session: Session = { seq: ++this.sessionSeq, dead: false, reason: "" };
        this.base = base;
        let resolveEnd: (() => void) | undefined;
        const endPromise = new Promise<void>((resolve) => { resolveEnd = resolve; });
        const die = (reason: string) => {
            if (session.dead || session.seq !== this.sessionSeq) { return; }
            session.dead = true;
            session.reason = reason;
            this.closeStreams();
            resolveEnd?.();
        };
        session.die = die;
        this.current = session;

        // 1) 屏流：先连上，后端才认得这个窗口（要页面标识也得先登记）
        const folders = this.options.folders();
        this.screenReq = openSse(
            streamUrl(base, "/screen", { screenId: this.screenId, folders: JSON.stringify(folders) }),
            () => { this.screenUp = true; },
            (event, data) => { this.onScreenEvent(event, data, session); },
            (note) => die(note),
        );
        const screenReady = await this.waitScreenUp(session);
        if (!screenReady) {
            die(session.reason || "屏连接没建立起来");
            return false;
        }

        // 2) 领一个页面标识（后端认识它之后，页面流才收消息）
        const answer = await this.postScreen({ type: "newPage" }, session);
        const pageId = answer && typeof (answer as any).pageId === "string" ? (answer as any).pageId as string : "";
        if (!pageId) {
            die("后端没给页面标识");
            return false;
        }
        this.pageId = pageId;

        // 3) 页面流：网页视图那一屏的推送
        this.lastTickAt = Date.now();
        this.pageReq = openSse(
            streamUrl(base, "/events", { pageId: this.pageId }),
            () => { this.lastTickAt = Date.now(); },
            (event, data) => { this.onPageEvent(event, data, session); },
            (note) => die(note),
        );

        this.setStatus("online");
        this.startTimers(session);
        // 替网页视图报一次账，让后端把该给它的东西给全：刚领的页面标识是一条新连接，
        // 后端按 lastSeq=0 把能补的补上，补不上（页面刚开、一次性消息缺了）就整屏重画。
        // 网页视图自己发的 ready 同样会走这条路，两边都对得上。
        this.sendPage({ type: "browserResync", lastSeq: this.lastSeq }, true);

        await endPromise;
        if (this.current === session) { this.current = undefined; }
        return true;
    }

    /** 屏流连上了没有（收到后端第一段内容就算连上：那条 `: connected` 注释行就会触发）。 */
    private waitScreenUp(session: Session, timeoutMs = 4000): Promise<boolean> {
        return new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const tick = () => {
                if (session.dead) { resolve(false); return; }
                if (this.screenUp) { resolve(true); return; }
                if (Date.now() > deadline) { resolve(false); return; }
                setTimeout(tick, 20);
            };
            tick();
        });
    }

    /** 主动断开重连（心跳超时、后端重启过、收摊）。传 undefined = 不再重连。 */
    private forceReconnect(note: string | undefined): void {
        const session = this.current;
        if (session && !session.dead) {
            // 让连着的这次了结：连接循环会接着判断要不要重连（收摊时 running 已经是 false）
            session.die?.(note ?? "断开重连");
            return;
        }
        this.sessionSeq += 1;
        this.closeStreams();
        if (note) { this.setStatus("offline", note); }
    }

    private closeStreams(): void {
        this.screenUp = false;
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
        if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = undefined; }
        for (const req of [this.pageReq, this.screenReq]) {
            if (!req) { continue; }
            try { req.destroy(); } catch { /* 已经断了 */ }
        }
        this.pageReq = undefined;
        this.screenReq = undefined;
    }

    private startTimers(session: Session): void {
        this.pingTimer = setInterval(() => {
            // 替网页视图报活：网页视图那边没有"连接"这个概念，它只会 postMessage
            this.sendPage({ type: "channelPing" }, true);
            // 屏也按同样的节奏报活：后端按"多久没收到窗口的消息"掐死连接（那规矩本意是兜
            // 浏览器退到后台），而屏只有"有事才说话"（切前台、符号表、派活回话），窗口开着
            // 没人动就没有流量，会被误掐——还连坐页面流，网页视图被迫整条重连。
            void this.postScreen({ type: "screenPing" });
        }, this.pingMs);
        this.watchdogTimer = setInterval(() => {
            if (session.dead) { return; }
            if (Date.now() - this.lastTickAt <= this.tickTimeoutMs) { return; }
            // 半天没 tick：这条连接其实已经死了（笔记本睡过、网换过），重连一遍
            this.options.log?.("推送连接半天没有心跳，重新连接后端。");
            session.die?.("连接断了，正在重连");
        }, this.watchdogMs);
    }

    private setStatus(state: BackendState, note?: string): void {
        const text = note ?? "";
        // 同一句话只说一遍：重试循环每几秒就会转到这儿一次，界面不该被同一个提示反复重画
        if (this.currentState === state && this.lastNote === text) { return; }
        this.currentState = state;
        this.lastNote = text;
        if (state === "offline") { this.pageId = ""; }
        this.options.onStatus(state, note);
    }

    // ========================================================================
    //  屏流：后端派活
    // ========================================================================

    private onScreenEvent(event: string, data: string, session: Session): void {
        if (session.dead) { return; }
        this.screenUp = true;
        if (event === "tick") { return; }
        if (event !== "msg") { return; }
        let msg: any;
        try { msg = JSON.parse(data); } catch { return; }
        switch (msg?.kind) {
            case "sessionFiles":
                this.options.onSessionFiles(Array.isArray(msg.files) ? msg.files.filter((f: unknown): f is string => typeof f === "string") : []);
                return;
            case "openFile":
            case "openFileAt":
            case "openSymbol":
            case "listFiles":
                this.options.onScreenRequest(msg);
                return;
            default:
                this.options.log?.(`后端派来一件不认识的事：${JSON.stringify(msg).slice(0, 200)}`);
        }
    }

    /** 屏给后端的话（执行结果、符号表、切到前台……）。要回话的会把回应给回来。 */
    public async postScreen(msg: unknown, session?: Session): Promise<unknown> {
        const base = this.base;
        if (!base || (session && session.dead)) { return undefined; }
        try {
            const res = await postJson(streamUrl(base, "/screenapi", { screenId: this.screenId }), msg);
            if (res.status === 409) {
                // 后端重启过了：这个窗口不在它的登记簿里了，重连一次（会重新登记）
                this.options.log?.("后端不认识这个窗口了（后端可能重启过），重新连接。");
                this.forceReconnect("后端重启过，正在重新连接");
                return undefined;
            }
            if (res.status !== 200 || !res.text) { return undefined; }
            try { return JSON.parse(res.text); } catch { return undefined; }
        } catch {
            return undefined;
        }
    }

    /** 这个窗口有人在用（切到前台）：同一个目录开着好几个窗口时，活该派给谁看它。 */
    public markActive(): void {
        void this.postScreen({ type: "active" });
    }

    /** 窗口算出来的符号集合：后端合并所有窗口的，再转给界面画可点的链接。 */
    public reportSymbols(names: string[]): void {
        void this.postScreen({ type: "symbolSet", names });
    }

    // ========================================================================
    //  页面流：网页视图那一屏的收发
    // ========================================================================

    /** 网页视图发来一条消息：原样转给后端。 */
    public sendPage(msg: unknown, silent = false): void {
        const base = this.base;
        const pageId = this.pageId;
        if (!base || !pageId) {
            if (!silent) { this.options.log?.("后端没连着，这条消息没发出去（界面会看到「连不上」）。"); }
            return;
        }
        void postJson(streamUrl(base, "/api", { pageId }), msg).then((res) => {
            if (res.status === 409) {
                // 后端重启过：这个页面标识它不认了，重连一遍（重连会领新的标识 + 整屏重画）
                this.options.log?.("后端不认识这块界面了（后端可能重启过），重新连接。");
                this.forceReconnect("后端重启过，正在重新连接");
            }
        }).catch(() => {
            if (!silent) { this.options.log?.("消息没送到后端（连接可能刚断），正在重连。"); }
        });
    }

    private onPageEvent(event: string, data: string, session: Session): void {
        if (session.dead) { return; }
        if (event === "tick") { this.lastTickAt = Date.now(); return; }
        if (event === "end") {
            this.forceReconnect("后端停了");
            session.dead = true;
            return;
        }
        if (event !== "msg") { return; }
        let msg: any;
        try { msg = JSON.parse(data); } catch { return; }
        const type = msg?.type;
        if (type === "hello") {
            // 连接建立：先于一切带序号的消息到达（后端保证顺序）
            this.liveFromSeq = typeof msg.seq === "number" ? msg.seq : 0;
            this.catchUpThrough = this.lastSeq;
            return;
        }
        if (type === "syncPoint") {
            // 后端说"到这里为止你都有全的"（补发完 / 整屏重画完）：账本对齐到这个位置
            if (typeof msg.seq === "number") {
                if (msg.seq > this.lastSeq) { this.lastSeq = msg.seq; }
                if (msg.seq > this.catchUpThrough) { this.catchUpThrough = msg.seq; }
            }
            return;
        }
        if (typeof msg?.seq === "number") {
            if (msg.seq > this.liveFromSeq) {
                if (msg.seq > this.lastSeq) { this.lastSeq = msg.seq; }
            } else if (msg.seq <= this.catchUpThrough) {
                return;   // 补发里跟已经收到过的重叠：丢掉
            } else {
                this.catchUpThrough = msg.seq;
                if (msg.seq > this.lastSeq) { this.lastSeq = msg.seq; }
            }
        }
        this.options.onPageEvent(msg);
    }
}

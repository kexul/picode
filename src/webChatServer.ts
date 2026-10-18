import * as crypto from "crypto";
import * as fs from "fs";
import * as zlib from "zlib";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { getBrowserChatHtml, getPanelChatHtml } from "./pageHtml";
import { mediaStamp, mediaVersion } from "./mediaVersion";
import { HEARTBEAT_MS, PAGE_STALE_MS, PING_MS, TICK_TIMEOUT_MS } from "./chatProtocol";
import type { ChatBroadcaster } from "./chatBroadcaster";
import type { ScreenRegistry } from "./screenRegistry";
import {
    contentTypeOf,
    isAllowedMediaFile,
    isLoopbackHostHeader,
    isLoopbackName,
    isSameOrigin,
    isWildcardHost,
    localHostnames,
    originHostnames,
    splitHostHeader,
    type PageChannel,
} from "./webTransport";
import { insideFolder, relativeTo } from "./pathRules";

/**
 * PiChatWebServer —— 独立后端的网页服务：一个地址，手机和电脑都看这一份会话。
 *
 * 两条线：
 *   - **页面线**（浏览器 / 手机，以及 VS Code 里的那块网页视图）：对话页面（`/`）、
 *     插件里那块对话面板的整页（`/panel`）、界面资源（`/media/…`）、
 *     后端推给页面的消息流（`/events`）、页面发给后端的消息（`/api`）、
 *     页面要看的文件与目录（`/file`、`/dir`，只读、只看得到当前会话目录里的）。
 *     VS Code 里的网页视图走同样的 `/events` + `/api`（只是中间隔着插件进程转发）、
 *     跑同一样一份界面代码，只有整页交给它时是内联版（`/panel`，见 pageHtml.ts）；
 *   - **屏线**（VS Code 窗口，`/screen` + `/screenapi`）：窗口在后端登记自己是打开着哪些
 *     文件夹的，好让"用编辑器打开这个文件"这类活得有人干。
 *   另外有一个 `/health`，给单实例判断探活用。
 *
 * 方向：后端 → 页面/屏用"服务器推送"（长连接，随时能写）；页面/屏 → 后端用普通请求（POST）。
 * 一个页面占一条推送连接，几个页面（手机 + 电脑 + 几个 VS Code 窗口）可以同时连着，
 * 推的消息发给每一个；确认框、选项浮层只发给"人最近在里面动过"的那个页面。
 *
 * 会话只有一份：全在独立后端里。服务停了会话照常活着（后端进程退出时才停）。
 */

/** 页面发来的单个请求允许的最大字节数（粘贴图片会是好几 MB）。 */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
// 心跳间隔与"多久没动静算死"这两个数在 chatProtocol.ts：两个客户端也要按它们办事。
/** 一条推送连接最多积压多少字节：页面不读了（屏黑了 / 网络卡住）就别再往里塞，
 *  掐掉让它重连重画。不掐的话这些字节全堆在插件进程里，回来时也不会被 GC 回收。 */
const STREAM_BACKLOG_BYTES = 8 * 1024 * 1024;
/** 小于这么多字节就不费劲压了（压完省不了几个字节，还白搭一次 CPU）。 */
const GZIP_MIN_BYTES = 1024;
/** 压缩结果最多缓存多少份（界面文件就那几个，纯粹防着缓存无限长大）。 */
const GZIP_CACHE_MAX = 64;

/**
 * 请求方能不能收 gzip（按 Accept-Encoding 一个字一个字看，q=0 表示"别给我这个"）。
 * 浏览器都会发 `gzip, deflate, br`；手工 curl 不带这个头时照旧发原文。
 */
function wantsGzip(accept: string | string[] | undefined): boolean {
    const value = Array.isArray(accept) ? accept.join(",") : accept;
    if (!value) { return false; }
    for (const part of value.split(",")) {
        const [name, ...params] = part.trim().split(";");
        if (name.trim().toLowerCase() !== "gzip") { continue; }
        const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
        return !(q && Number(q.slice(2)) === 0);
    }
    return false;
}

/** 取文件名的扩展名（带点、小写；没有就是空串）。 */
function extensionOf(filePath: string): string {
    const dot = filePath.lastIndexOf(".");
    const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    return dot > slash ? filePath.slice(dot).toLowerCase() : "";
}

/** 能当图片显示的扩展名 → Content-Type（浏览器直接拿它渲染）。 */
const IMAGE_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
    [".png", "image/png"], [".apng", "image/apng"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
    [".jpe", "image/jpeg"], [".jfif", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"],
    [".bmp", "image/bmp"], [".ico", "image/x-icon"], [".cur", "image/x-icon"], [".tif", "image/tiff"],
    [".tiff", "image/tiff"], [".avif", "image/avif"], [".heic", "image/heic"], [".heif", "image/heif"],
    [".svg", "image/svg+xml"],
]);

/** 当正文显示的文本扩展名。 */
const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
    ".txt", ".text", ".log", ".md", ".markdown", ".mdx", ".rst", ".adoc", ".tex",
    ".csv", ".tsv", ".diff", ".patch",
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".vue", ".svelte", ".astro",
    ".json", ".json5", ".jsonc", ".jsonl", ".ndjson",
    ".css", ".scss", ".sass", ".less", ".styl", ".html", ".htm", ".xhtml", ".xml", ".xsl", ".xslt",
    ".plist", ".resx",
    ".py", ".pyi", ".pyw", ".rb", ".rake", ".gemspec", ".go", ".rs", ".java", ".kt", ".kts",
    ".scala", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".cs", ".php", ".swift", ".m", ".mm",
    ".r", ".jl", ".lua", ".pl", ".pm", ".tcl", ".awk", ".sh", ".bash", ".zsh", ".fish", ".bat",
    ".cmd", ".ps1", ".psm1", ".vim", ".el", ".lisp", ".clj", ".cljs", ".cljc", ".edn", ".hs", ".lhs",
    ".ml", ".mli", ".fs", ".fsx", ".fsi", ".elm", ".ex", ".exs", ".erl", ".gleam", ".dart", ".asm", ".s",
    ".sql", ".graphql", ".gql", ".proto", ".thrift", ".capnp",
    ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".config", ".properties", ".env", ".editorconfig",
    ".gitignore", ".gitattributes", ".gitmodules", ".npmrc", ".nvmrc", ".dockerignore", ".eslintignore",
    ".prettierignore", ".babelrc", ".browserslistrc", ".gradle", ".sbt", ".cmake", ".ninja", ".mk",
]);

/**
 * 一个文件该当什么给页面：文本（当正文读）、图片（按图片给）、二进制（给一句说明加下载）。
 * 不认识的扩展名一律算二进制：按路径取文件这条路上，宁可不展示也不硬读成乱码。
 */
function fileFormatOf(filePath: string): "text" | "image" | "binary" {
    const ext = extensionOf(filePath);
    if (IMAGE_CONTENT_TYPES.has(ext)) { return "image"; }
    return TEXT_FILE_EXTENSIONS.has(ext) ? "text" : "binary";
}

/** 目录清单里的一项（`/dir` 的回应）。 */
interface DirEntryInfo {
    /** 条目名（最后一段） */
    name: string;
    /** 相对会话目录的写法（页面拿它当标签的键，也原样贴回下一次请求） */
    path: string;
    /** 是不是目录（软链接跟着指向判：指到目录的算目录） */
    dir: boolean;
}

interface DirListing {
    /** 子目录在前、文件在后，各自按名字排（大小写不敏感） */
    entries: DirEntryInfo[];
    /** 条目太多，只列了前 MAX_DIR_ENTRIES 个 */
    truncated?: boolean;
}

/**
 * 下载时告诉浏览器的文件名（`Content-Disposition`）。
 * 文件名里可能有中文：`filename` 那一份只放 ASCII（老浏览器认得），同时按 RFC 5987 给一份
 * `filename*=UTF-8''…`（现代浏览器用它，中文名字才不会变成下划线）。
 */
function contentDisposition(filePath: string): string {
    const name = path.basename(filePath).replace(/["\\\r\n]/g, "_");
    const ascii = name.replace(/[^\x20-\x7e]/g, "_");
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 网页服务的设置（来自 ~/.pi/pichat/config.json 的 webServer 一节）。 */
export interface WebServerSettings {
    /** 是否开启网页服务（关闭时不监听端口，界面上也不显示入口）。 */
    enabled: boolean;
    /** 监听端口；0 表示自动挑一个空闲端口。 */
    port: number;
    /** 监听地址；默认 0.0.0.0（同一网络里的设备都能访问）。 */
    host: string;
    /**
     * 人另外指定的来源（服务前面挂了一层 https 反代时，页面就是从那个地址打开的）。
     * 不在里面的一律当成别人网站偷偷发来的请求顶回去，所以只有人亲手写下的才进来。
     */
    trustedOrigins: string[];
}

/**
 * 网页服务对会话工作区（插件那边负责对话面板的 ChatViewProvider）的依赖。
 * 服务不拥有会话：页面只是接在工作区上的"额外的屏"。
 */
export interface WebServerHost {
    /** 页面连接的登记簿 + 推送序号（所有页面共用一份）。 */
    getBroadcaster(): ChatBroadcaster;
    /** 屏（VS Code 窗口）的登记簿：网页服务拿它做死连接巡检、写心跳。 */
    getScreens(): ScreenRegistry;
    /**
     * 一个 VS Code 窗口连上来了。
     * @param folders 这个窗口打开着的文件夹（能力活该不该它干，就看这个）。
     * @param send 往后端推话的出口。
     */
    attachScreen(screenId: string, folders: string[], send: (msg: Record<string, unknown>) => void): void;
    /** 一条屏连接断了（窗口关了 / 网断了）。 */
    detachScreen(screenId: string): void;
    /**
     * 屏发来一条消息（`/screenapi`）。
     * @returns 需要回话时返回一个值，服务把它当 JSON 回给这个窗口（比如"给我一个页面标识"）；
     *          不用回话就不返回。
     */
    processScreenMessage(msg: any, screenId: string): unknown;
    /** 页面发来一条消息（/api POST）。 */
    processPageMessage(msg: any, pageId: string): void;
    /**
     * 一个会话跑在哪个目录（只读的文件地址按它解路径）。
     * 跑着的会话、以及刚关掉还记着的会话都认；两条都对不上返回 undefined（页面拿不到内容）。
     */
    resolveSessionDir(sessionId: string): string | undefined;
    /**
     * 这个会话的工具碰过哪些文件（read / edit / write 那几个，绝对路径）。
     * 只读的文件地址拿它当第二档：链接里只有光名字、或者路径写岔了时按文件名匹配。
     * 认不出这个会话就给空数组（只丢第二档，第一档照旧）。
     */
    knownSessionFiles(sessionId: string): string[];
    /** 一条推送连接建立（页面连上 / 重连）。 */
    onPageConnected(pageId: string): void;
    /** 一条推送连接断了（页面关掉 / 死连接被掐掉）。 */
    onPageDisconnected(pageId: string): void;
    /** 服务起来了（缓冲可以开始攒：页面可能马上要来）。 */
    onServerStarted(): void;
    /** 服务停了：页面的告别话发完、缓冲清掉，会话工作区本身不受影响。 */
    onServerStopped(): void;
    /** 当前界面颜色（写进页面的初始主题）。 */
    getThemeMode(): "light" | "dark";
}

export interface WebServerHooks {
    /** 地址变化（启动、停止、换端口）时回调，用于刷新状态栏提示。 */
    onUrlChanged?(url: string | undefined): void;
    /** 写一行日志（输出面板）。 */
    log(text: string): void;
    /**
     * `/health` 里附加的信息（独立后端启动器会用它塞版本号之类）。
     * 本服务自己的身份字段（ok/app/pid/startedAt）由服务填写，不受这里影响；没给就不加。
     */
    info?(): Record<string, unknown>;
}

export class PiChatWebServer {
    private server?: http.Server;
    private boundHost = "";
    private boundPort = 0;
    /** 这台机器合法的地址写法（对照请求里的 Origin，挡别的网站偷偷发来的请求）。 */
    private ownHostnames: string[] = [];
    /** 人另外指定的来源（设置里的 webServer.trustedOrigins）：反代那一层的地址，照旧放行。 */
    private trustedOrigins: string[] = [];
    /** 上面那些来源里的主机名（对照 Host 头用：反代转来的 Host 可能还是原来那个域名）。 */
    private trustedHostnames: string[] = [];
    /** 页面标识 → 它那条连接的响应对象（心跳要往里写 tick）。 */
    private readonly streams = new Map<string, http.ServerResponse>();
    /** 屏标识 → 它那条连接的响应对象。 */
    private readonly screenStreams = new Map<string, http.ServerResponse>();
    private heartbeat?: ReturnType<typeof setInterval>;
    private readonly heartbeatMs = HEARTBEAT_MS;
    private readonly pageStaleMs = PAGE_STALE_MS;
    private readonly backlogBytes = STREAM_BACKLOG_BYTES;
    /** 压缩结果缓存：界面文件的内容没变时不用重压（键是"文件名@修改标记"，见 sendMedia）。 */
    private readonly gzipCache = new Map<string, Buffer>();
    /** 本次监听开始服务的时刻（`/health` 报出去；重启会更新）。 */
    private startedAt = 0;
    private settings: WebServerSettings = { enabled: false, port: 0, host: "0.0.0.0", trustedOrigins: [] };

    constructor(
        private readonly mediaDir: string,
        private readonly host: WebServerHost,
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
            a.port !== b.port || a.host !== b.host || a.trustedOrigins.join(" ") !== b.trustedOrigins.join(" ");
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
        const host = settings.host.trim() || "0.0.0.0";
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
        this.trustedOrigins = settings.trustedOrigins ?? [];
        this.trustedHostnames = originHostnames(this.trustedOrigins);
        if (this.boundPort === 0) {
            // 理论上不会走到这里：监听成了却读不到端口
            this.hooks.log("监听已就绪，但读不到端口（地址未知），网页服务不开了。");
            this.server = undefined;
            server.close();
            return;
        }
        this.startedAt = Date.now();
        this.heartbeat = setInterval(() => this.writeHeartbeat(), this.heartbeatMs);
        this.host.onServerStarted();
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
        this.hooks.log("      就能读写这台机器上的文件、运行命令（背后是 pi）。只想自己用就把 ~/.pi/pichat/config.json 里的 webServer.host 改成 127.0.0.1。");
        if (found.length > 0) {
            this.hooks.log("手机等设备可用：" + found.map((ip) => `http://${ip}:${this.boundPort}/`).join("  "));
        }
    }

    /** 同步收摊：断掉每条推送连接、清心跳。会话不动（后端进程自己退不退是启动器的事）。 */
    private teardown(): void {
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
        const broadcaster = this.host.getBroadcaster();
        for (const channel of broadcaster.removeAllChannels()) {
            // 告别话要给：页面收到 end 就不再重连（服务真的停了，重连也没用）
            channel.close("网页服务已停止。");
        }
        this.streams.clear();
        for (const [id, res] of this.screenStreams) {
            this.host.detachScreen(id);
            this.endStream(res, "服务已停止。");
        }
        this.screenStreams.clear();
        this.host.onServerStopped();
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

    // ========================================================================
    //  路由
    // ========================================================================

    private route(req: http.IncomingMessage, res: http.ServerResponse): void {
        try {
            const url = parseRequestUrl(req.url);
            if (!url) {
                this.sendText(req, res, 400, "请求地址不合法。");
                return;
            }
            if (!this.originAllowed(req)) {
                this.sendText(req, res, 403, "请求来源不被接受。请直接在浏览器里打开服务给的地址。");
                return;
            }
            const pathname = safeDecode(url.pathname);
            if (pathname === undefined) {
                this.sendText(req, res, 400, "请求地址不合法。");
                return;
            }
            if (pathname === "/health") {
                this.sendHealth(req, res);
                return;
            }
            if (pathname === "/" || pathname === "/index.html") {
                this.sendPage(req, res, url.searchParams.get("pageId") ?? "");
                return;
            }
            if (pathname === "/panel") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.sendPanel(req, res, url.searchParams.get("theme") ?? "", url.searchParams.get("csp") ?? "");
                return;
            }
            if (pathname.startsWith("/media/")) {
                this.sendMedia(req, res, pathname.slice("/media/".length), url.searchParams.get("v") ?? "");
                return;
            }
            if (pathname === "/file") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.sendFile(req, res, url.searchParams.get("session") ?? "", url.searchParams.get("path") ?? "",
                    url.searchParams.get("mtime") ?? "", url.searchParams.get("download") === "1");
                return;
            }
            if (pathname === "/dir") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.sendDir(req, res, url.searchParams.get("session") ?? "", url.searchParams.get("path") ?? "");
                return;
            }
            if (pathname === "/events") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.openChannel(req, res, url.searchParams.get("pageId") ?? "", url.searchParams.get("role") === "watch");
                return;
            }
            if (pathname === "/api") {
                if (req.method !== "POST") { this.sendText(req, res, 405, "只接受 POST。"); return; }
                void this.handleApi(req, res, url.searchParams.get("pageId") ?? "");
                return;
            }
            if (pathname === "/screen") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.openScreen(res, url.searchParams.get("screenId") ?? "", url.searchParams.get("folders") ?? "");
                return;
            }
            if (pathname === "/screenapi") {
                if (req.method !== "POST") { this.sendText(req, res, 405, "只接受 POST。"); return; }
                void this.handleScreenApi(req, res, url.searchParams.get("screenId") ?? "");
                return;
            }
            this.sendText(req, res, 404, "没有这个地址。");
        } catch (err: any) {
            this.hooks.log(`处理请求出错：${err?.message ?? String(err)}`);
            try { this.sendText(req, res, 500, "服务内部错误。"); } catch { /* 连接可能已断 */ }
        }
    }

    /**
     * 请求来源是否可接受。
     * 两道检查：
     *   Host：只监听本机地址时严查，挡“域名重绑定”（别的域名解析到 127.0.0.1 来试探）；
     *   Origin：不管监听在哪里都查，挡“你浏览的某个网站里的脚本偷偷发请求给本服务”
     *           （这种请求即使服务只听本机地址也能发到）。
     * 设置里写了 trustedOrigins（页面是从 https 反代那个地址打开的）的，那两个检查都把它当自己人：
     * 它本来就不是本机地址、也不是本服务的端口，不带这一份名单就会被顶回去。
     */
    private originAllowed(req: http.IncomingMessage): boolean {
        if (isLoopbackName(this.boundHost) && !this.hostHeaderAllowed(req)) {
            return false;
        }
        return isSameOrigin(req.headers.origin as string | undefined, this.boundPort, this.ownHostnames, this.trustedOrigins);
    }

    /** Host 头可不可接受：监听在本机地址上时，要么是本机写法，要么是人写下的来源里的域名。 */
    private hostHeaderAllowed(req: http.IncomingMessage): boolean {
        if (isLoopbackHostHeader(req.headers.host, this.boundPort)) { return true; }
        const split = splitHostHeader(req.headers.host);
        return !!split && this.trustedHostnames.includes(split.name);
    }

    private sendPage(req: http.IncomingMessage, res: http.ServerResponse, pageId: string): void {
        // 页面标识由服务生成并写进页面：页面加载时它还没运行任何脚本，
        // 不可能自己报标识；而 chat.js 一跑完就发消息，服务得认得它。
        const id = pageId || `p-${crypto.randomUUID()}`;
        let html: string;
        try {
            html = getBrowserChatHtml(this.mediaDir, id, this.host.getThemeMode());
        } catch (err: any) {
            this.sendText(req, res, 500, `生成页面失败：${err?.message ?? String(err)}`);
            return;
        }
        this.host.getBroadcaster().markIssued(id);
        this.writeBody(req, res, 200, Buffer.from(html, "utf8"), {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
        });
    }

    /**
     * 发插件里那块对话面板的整页 HTML（骨架 + 内联样式与脚本）。
     *
     * 为什么由后端拼：面板的骨架以前编在插件包里、脚本从 /media/ 现取，两边版本一错开
     * 就是“页面起得来、行为不对”而且毫无提示。整页都由后端给，骨架与脚本必然同源。
     * 面板那边抓回来后整份塞进网页视图，所以这里也带 no-store：永远拿当前这一份。
     *
     * @param theme 初始界面颜色（面板传编辑器当前主题，之后显示选项会覆盖）
     * @param cspSource 网页视图的 cspSource（安全策略里图片那一条用）
     */
    private sendPanel(req: http.IncomingMessage, res: http.ServerResponse, theme: string, cspSource: string): void {
        const themeMode = theme === "dark" ? "dark" : "light";
        let html: string;
        try {
            html = getPanelChatHtml(this.mediaDir, { themeMode, imgCspSource: cspSource });
        } catch (err: any) {
            // 内联不安全的序列这类问题重试也没用：把这句原样交给面板去显示
            this.sendText(req, res, 500, `生成面板页面失败：${err?.message ?? String(err)}`);
            return;
        }
        this.writeBody(req, res, 200, Buffer.from(html, "utf8"), {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
        });
    }

    /**
     * 发一个界面文件（/media/…）。
     *
     * 地址上带着内容指纹时才允许浏览器长期缓存（页面 HTML 里就是这么引的，见 pageHtml.ts）：
     * 文件改了指纹就变、地址跟着变，所以“长期缓存”不会让谁看到旧界面。
     * 指纹对不上（老页面、手敲的地址）或没带 → 照旧 no-store，保证看到的是当前这一份。
     */
    private sendMedia(req: http.IncomingMessage, res: http.ServerResponse, name: string, version: string): void {
        if (!isAllowedMediaFile(name)) {
            this.sendText(req, res, 404, "没有这个资源。");
            return;
        }
        const fresh = mediaVersion(this.mediaDir, name);
        const cacheable = !!fresh && version === fresh;
        const stamp = mediaStamp(this.mediaDir, name);
        fs.readFile(path.join(this.mediaDir, name), (err, data) => {
            if (err) { this.sendText(req, res, 404, "没有这个资源。"); return; }
            this.writeBody(req, res, 200, data, {
                "Content-Type": contentTypeOf(name),
                "Cache-Control": cacheable ? "public, max-age=31536000, immutable" : "no-store",
            }, stamp ? `${name}@${stamp}` : undefined);
        });
    }

    /**
     * 健康检查：先探一眼这个地址上是不是活着的 pichat 后端（别的实例在跑就不重复启动）。
     * 只报身份，不放路径、配置这些不该外露的东西。
     * 不带 Origin 头也放行：本机探活就是这么发的（见 originAllowed 对无 Origin 请求的处理）。
     */
    /** 页面能直接看的文件大小上限：再大的不读出来（页面给一句「太大」；要下载那是另一条路）。 */
    private static readonly MAX_FILE_BYTES = 2 * 1024 * 1024;

    /** 一份目录清单最多列这么多项：目录里有几万个东西时全塞给页面会卡死，人也翻不到后面去。 */
    private static readonly MAX_DIR_ENTRIES = 500;

    /**
     * 把「哪个会话 + 哪个路径」解成一个真实路径，并保证它落在会话目录以内。
     *
     * 相对路径按那个会话的目录解；`..` 绕出去的、软链接指到外面的都在这里挡掉：判的是真实路径
     * （fs.realpath，软链接一起解析掉），不是字符串前缀。这是有意的边界：能打开这个页面的人本来
     * 就能让 pi 读写这台机器，但「按路径直接取文件」这条路不该跟着变成整台机器的读接口。
     * 文件与目录两条地址共用这一套。
     *
     * 找文件分两档（跟编辑器打开文件时一样多，但不去全工程扫）。
     *
     * 第一档按会话目录拼。拼得到（路径真在）就用它，哪怕它指向目录外面——边界该报 403 就报 403，
     * 不拿第二档把话岔开（`outside/package.json` 这种写法该说「在会话目录外」）。
     *
     * 第二档只在第一档拼不到（路径不存在）时走，而且只有文件有（目录没有这份清单）：
     * 在这个会话碰过的文件（read / edit / write 过的，见 knownSessionFiles）里按名字匹配——
     * 链接里只有 `chat.js` 这种光名字、或者路径写岔了（`src/chat.js` 写成 `lib/chat.js`）时还能找到。
     * 匹配到的路径同样要过那道边界：清单里那个文件真身在会话目录外（读的是外面的软链接）时
     * 也不给看。
     *
     * 看不了时返回状态码与一句人话，调用方直接照它回；kind 只把话里的「文件 / 目录」说对。
     */
    private resolveSessionPath(sessionId: string, wantPath: string, kind: "文件" | "目录"):
        { ok: true; real: string; realCwd: string } | { ok: false; status: number; text: string } {
        if (!sessionId || !wantPath || wantPath.includes("\0")) {
            return { ok: false, status: 400, text: `请求里要说明是哪个会话、哪个${kind}。` };
        }
        const cwd = this.host.resolveSessionDir(sessionId);
        if (!cwd) {
            return { ok: false, status: 404, text: "这个会话不在了（页面可能开得太久），刷新页面再试。" };
        }
        // 目录边界拿真实路径判：`..` 与软链接走的都是这一条
        const realCwd = realPathOr(cwd);
        if (!realCwd) {
            return { ok: false, status: 404, text: `没有这个${kind}。` };
        }
        // 第一档：按会话目录拼（写成绝对路径也先解出来，再按下面那道边界判）
        const realTarget = realPathOr(path.resolve(cwd, wantPath));
        if (realTarget) {
            return this.checkInsideSession(realTarget, realCwd, kind);
        }
        // 第二档：光名字 / 路径写岔了——在这个会话碰过的文件里按名字找（只有文件有这一档）
        if (kind === "文件") {
            const hit = matchKnownFile(this.host.knownSessionFiles(sessionId), wantPath, cwd);
            const realHit = hit ? realPathOr(hit) : undefined;
            if (realHit) {
                return this.checkInsideSession(realHit, realCwd, kind);
            }
        }
        return { ok: false, status: 404, text: `没有这个${kind}。` };
    }

    /** 目录边界：真实路径必须落在会话目录里（相等也算；`..` 与软链接都已解析过）。 */
    private checkInsideSession(real: string, realCwd: string, kind: "文件" | "目录"):
        { ok: true; real: string; realCwd: string } | { ok: false; status: number; text: string } {
        if (!insideFolder(real, realCwd)) {
            return { ok: false, status: 403, text: `这个${kind}在会话目录外，看不了。` };
        }
        return { ok: true, real, realCwd };
    }

    /**
     * 发一个文件给页面（`/file?session=…&path=…&mtime=…&download=1`）。
     *
     * 只读，而且只看得到当前会话目录里的文件：目录边界与那条目录地址同一套
     * （见 resolveSessionPath：`..` 绕出去的、软链接指到外面的都不给）。
     *
     * 怎么给，看文件是哪种（按扩展名，见 fileFormatOf）：
     *   - 看（用来显示）超过 2 MB 的一律 413，正文里带着字节数，页面据此说「太大」；
     *   - 文本（UTF-8）当正文递出去，页面画成带行号的一行一格；
     *   - 图片按图片类型流出去，页面拿它当图片显示；
     *   - 其余的（二进制）当正文看没有意义：415 加一句「这是个二进制文件」，页面拿它写说明与下载。
     * 页面上的下载链接就是同一条地址带 `download=1`：这条不设大小上限，按附件流式给出去
     * （几 MB 的文件也下得下来，内容不经过推送通道、也不进页面）。
     *
     * 条件请求：页面把上次拿到的那份内容的修改时间当 `mtime` 带上来，文件还是那一次改动就回
     * 204 空响应——面板盯着一个文件看得久了，靠它省下每轮重传整份正文。给正文的 200 里用
     * `X-File-Mtime` 给出这次的修改时间（毫秒），页面下次带它回来。
     *
     * @param sinceMtime 页面手上那份内容的修改时间（毫秒）；空 = 没得比，给正文
     * @param download   true = 这个请求是要把文件存下来（不设大小上限、按附件给）
     */
    private sendFile(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string, wantPath: string,
        sinceMtime = "", download = false): void {
        const found = this.resolveSessionPath(sessionId, wantPath, "文件");
        if (!found.ok) { this.sendText(req, res, found.status, found.text); return; }
        const realTarget = found.real;
        let stat: fs.Stats;
        try {
            stat = fs.statSync(realTarget);
        } catch {
            this.sendText(req, res, 404, "没有这个文件。");
            return;
        }
        if (!stat.isFile()) {
            this.sendText(req, res, 404, "没有这个文件（这是个目录）。");
            return;
        }
        const mtime = String(Math.floor(stat.mtimeMs));
        // 下载（页面那颗下载链接）：不设大小上限，按附件流式给出去
        if (download) {
            this.streamFile(res, realTarget, 200, stat.size, {
                "Content-Type": "application/octet-stream",
                "Content-Disposition": contentDisposition(realTarget),
                "Cache-Control": "no-store",
                "X-File-Mtime": mtime,
            });
            return;
        }
        // 文件还是页面手上那一次改动：正文一个字节都不用给（跟着刷新那轮省下的就是它）
        if (sinceMtime && sinceMtime === mtime) {
            res.writeHead(204, { "Cache-Control": "no-store", "X-File-Mtime": mtime });
            res.end();
            return;
        }
        const format = fileFormatOf(realTarget);
        // 「太大」比「是二进制」先说：超 2 MB 的一律不往页面里塞，给句话加一个下载
        if (stat.size > PiChatWebServer.MAX_FILE_BYTES) {
            this.sendFileNote(req, res, 413,
                `文件太大（${stat.size} 字节），这里只显示小于 2 MB 的文件。`, mtime, stat.size);
            return;
        }
        if (format === "binary") {
            // 当文字读出来是一堆乱码，不如直说：页面拿这句话加一个下载
            this.sendFileNote(req, res, 415, "这是个二进制文件，没法当文字显示。", mtime, stat.size);
            return;
        }
        if (format === "image") {
            // 图片按图片类型流出去：页面拿它当图片地址显示
            this.streamFile(res, realTarget, 200, stat.size, {
                "Content-Type": IMAGE_CONTENT_TYPES.get(extensionOf(realTarget))!,
                "Cache-Control": "no-store",
                "X-File-Mtime": mtime,
            });
            return;
        }
        fs.readFile(realTarget, (err, data) => {
            if (err) { this.sendText(req, res, 404, "没有这个文件。"); return; }
            this.writeBody(req, res, 200, data, {
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "no-store",
                "X-File-Mtime": mtime,
            });
        });
    }

    /**
     * 列一个目录给页面（`/dir?session=…&path=…`）：点消息流里的目录链接、以及面板里再点进去的
     * 子目录都走它。目录边界与 `/file` 同一套（见 resolveSessionPath）。
     *
     * 回一份 JSON：`{ entries: [{ name, path, dir }], truncated? }`。
     *   - `path` 是相对会话目录的写法（页面拿它当标签的键，也原样贴回下一次请求），不写绝对路径；
     *   - 顺序：子目录在前、文件在后，各自按名字排（大小写不敏感）；
     *   - 软链接不跟着解析：指到会话目录外面的条目照样列出来（名字是里面这一层的事实），
     *     点它的那一下由 resolveSessionPath 挡回去（403）——「列出来的东西一样受目录边界限制」。
     *
     * 为什么另开一条地址、而不是让 `/file` 认目录：清单是另一种东西（一份列表，不是文件内容），
     * 它没有大小上限、没有修改时间、也没有下载与二进制那几档；两条地址各管一件事，各自的规矩
     * 都短。`/file` 那边「这是个目录」的 404 留着兜底（手敲地址时会碰到）。
     */
    private sendDir(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string, wantPath: string): void {
        const found = this.resolveSessionPath(sessionId, wantPath, "目录");
        if (!found.ok) { this.sendText(req, res, found.status, found.text); return; }
        void this.listDirAsync(found.real, found.realCwd).then((listing) => {
            this.sendJson(req, res, 200, listing);
        }, () => {
            // 路径真在、但读不动（拿文件当目录列 / 没权限 / 中途没了）：都按「没这个目录」回
            this.sendText(req, res, 404, "没有这个目录。");
        });
    }

    /**
     * 读一个目录：子目录在前、文件在后，各按名字排；坏链接、没权限的条目跳过
     * （一条坏的别把整张清单搞挂）；条目太多只列前 MAX_DIR_ENTRIES 个。
     */
    private async listDirAsync(dir: string, realCwd: string): Promise<DirListing> {
        const names = await fs.promises.readdir(dir);
        names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        const dirs: DirEntryInfo[] = [];
        const files: DirEntryInfo[] = [];
        let truncated = false;
        for (const name of names) {
            if (dirs.length + files.length >= PiChatWebServer.MAX_DIR_ENTRIES) { truncated = true; break; }
            const full = path.join(dir, name);
            let stat: fs.Stats;
            // 用 stat 不用 lstat：软链接指到目录的也算目录（点不点得进去由那道边界管）
            try { stat = await fs.promises.stat(full); } catch { continue; }
            const entry: DirEntryInfo = { name, path: relativeTo(realCwd, full), dir: stat.isDirectory() };
            (entry.dir ? dirs : files).push(entry);
        }
        const listing: DirListing = { entries: [...dirs, ...files] };
        if (truncated) { listing.truncated = true; }
        return listing;
    }

    /**
     * 看不了时的一句人话（二进制 / 太大）：正文给人看，另外把文件大小与修改时间报给页面。
     * 页面靠它们写「太大（几 MB），点这里下载」那颗链接，也靠修改时间接着问「变了没」。
     */
    private sendFileNote(req: http.IncomingMessage, res: http.ServerResponse, status: number, text: string,
        mtime: string, size: number): void {
        const body = Buffer.from(text, "utf8");
        this.writeBody(req, res, status, body, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-File-Mtime": mtime,
            "X-File-Size": String(size),
        });
    }

    /**
     * 把一个文件整份流出去（图片显示、下载都走它）。
     *
     * 为什么不先读进内存：这是几 MB 到几十 MB 的二进制文件。流式给出去，后端不为一个请求
     * 攒一大块内存，浏览器那边也能边收边写盘（页面一个字节都不经手）。
     */
    private streamFile(res: http.ServerResponse, filePath: string, status: number, size: number,
        headers: Record<string, string>): void {
        res.writeHead(status, { ...headers, "Content-Length": size });
        const stream = fs.createReadStream(filePath);
        // 读不动了 / 对方中途不要了（取消下载、关掉页面）：把这个响应收掉、把读的这份放掉，
        // 别把异常抛给整个服务，也别让一个没人要的流继续占着文件。
        stream.on("error", () => { try { res.end(); } catch { /* 已经断了 */ } });
        res.on("error", () => stream.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
    }

    private sendHealth(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
        // info 先铺、本服务的身份后压：即使 info 里凑巧带了同名键，
        // 也不能把探活判断依据（app/pid/startedAt）盖掉。
        const payload: Record<string, unknown> = {
            ...(this.hooks.info?.() ?? {}),
            ok: true,
            app: "pichat",
            pid: process.pid,
            startedAt: this.startedAt,
        };
        this.sendJson(req, res, 200, payload);
    }

    private sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, value: unknown): void {
        const body = Buffer.from(JSON.stringify(value), "utf8");
        this.writeBody(req, res, status, body, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
        });
    }

    private sendText(req: http.IncomingMessage, res: http.ServerResponse, status: number, text: string): void {
        const body = Buffer.from(text, "utf8");
        this.writeBody(req, res, status, body, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
        });
    }

    /**
     * 写一个响应体（页面 / 界面文件 / JSON / 纯文本）。
     *
     * 请求头说能收 gzip、内容又够大时就压了再发：浏览器页面的 HTML 里内联着 72KB 样式、
     * 界面脚本 350KB，压完只剩三成左右（手机网速下这是好几百毫秒的差别）。
     * 压不了 / 对方不收就发原文；够大的响应都带上 Vary，让中间的缓存别把两种混起来。
     *
     * @param cacheKey 给了就按它缓存压缩结果（界面文件那种“内容不变、每台设备各下一次”的最划算）；
     *                 不给就每次现压（页面 HTML 每个页面标识都不同，缓存没意义）。
     */
    private writeBody(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        status: number,
        body: Buffer,
        headers: Record<string, string>,
        cacheKey?: string,
    ): void {
        if (res.headersSent) { res.end(); return; }
        const gzipped = this.gzipFor(req, body, cacheKey);
        const out: Record<string, string | number> = { ...headers };
        if (body.length >= GZIP_MIN_BYTES) { out["Vary"] = "Accept-Encoding"; }
        if (gzipped) {
            out["Content-Encoding"] = "gzip";
            out["Content-Length"] = gzipped.length;
        } else {
            out["Content-Length"] = body.length;
        }
        res.writeHead(status, out);
        res.end(gzipped ?? body);
    }

    /** 该不该压、压出来的字节；不值得压（对方不收 / 内容太小）时给 undefined。 */
    private gzipFor(req: http.IncomingMessage, body: Buffer, cacheKey?: string): Buffer | undefined {
        if (body.length < GZIP_MIN_BYTES || !wantsGzip(req.headers["accept-encoding"])) {
            return undefined;
        }
        if (cacheKey) {
            const hit = this.gzipCache.get(cacheKey);
            if (hit) { return hit; }
        }
        let out: Buffer;
        try {
            out = zlib.gzipSync(body);
        } catch {
            return undefined;   // 压不了就发原文，别把响应弄坏
        }
        if (cacheKey) {
            // 只留最近这些份：界面文件就那几个，够用了
            if (this.gzipCache.size >= GZIP_CACHE_MAX) { this.gzipCache.clear(); }
            this.gzipCache.set(cacheKey, out);
        }
        return out;
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
     *
     * `role=watch` 是手机 App 那条：它只要知道"哪个会话跑完了 / 在等你答"，好弹通知，
     * 不画界面。所以不补发旧消息（see 末尾），也不被当成"人最近在里面动过的页面"（见 PageChannels.add）。
     */
    private openChannel(req: http.IncomingMessage, res: http.ServerResponse, pageId: string, watch = false): void {
        // 页面标识正常都是服务发出页面时写进去的那个；万一没有就自己编一个，别把好几个页面混成一条
        const id = pageId || `p-anon-${crypto.randomUUID()}`;
        const broadcaster = this.host.getBroadcaster();
        const { channel, replaced, openSeq } = broadcaster.addChannel(
            id,
            (msg) => { this.writeChunk(channel, res, `event: msg\ndata: ${JSON.stringify(msg)}\n\n`); },
            (note) => { this.endStream(res, note); },
            watch,
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
        // 握手把三个时间一起报给页面：网页那一份是纯 JS（browserBridge.js），读不了
        // chatProtocol.ts，报给它在那边就不留规则 —— 免得两边各写死一套、改一边就白重连。
        this.writeChunk(channel, res, `event: msg\ndata: ${JSON.stringify({
            type: "hello",
            seq: openSeq,
            heartbeatMs: HEARTBEAT_MS,
            tickTimeoutMs: TICK_TIMEOUT_MS,
            pingMs: PING_MS,
        })}\n\n`);
        res.socket?.setNoDelay(true);
        if (replaced) { replaced.close(""); }   // 同一个页面的旧连接：安静断掉，页面那头不会弹提示
        const onClose = () => { this.dropChannel(channel); };
        req.on("close", onClose);
        req.on("error", onClose);
        res.on("error", onClose);
        // 断线这段时间插件攒下的消息补给这个页面（页面自己还会再要求整屏重画，两边都对得上）
        // 只听通知的那条（手机 App 在后台挂的）不要补：它不画界面，补的全是些大块内容
        if (!watch) { this.host.onPageConnected(id); }
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
        this.host.getBroadcaster().removeChannel(channel);
        if (this.streams.get(channel.id) !== undefined) { this.streams.delete(channel.id); }
        this.host.onPageDisconnected(channel.id);
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
        const broadcaster = this.host.getBroadcaster();
        for (const id of broadcaster.staleIds(this.pageStaleMs)) {
            const stale = broadcaster.getChannel(id);
            if (!stale) { continue; }
            this.hooks.log(`页面 ${id} 已经 ${Math.round(this.pageStaleMs / 1000)} 秒没有任何动静（多半是退到后台了），` +
                "先把它的推送连接收掉。页面回来会自己重连并补拉漏掉的消息。");
            broadcaster.removeChannel(stale);
            this.streams.delete(id);
            stale.close("");
            this.host.onPageDisconnected(id);
        }
        broadcaster.forEachChannel((channel) => {
            const res = this.streams.get(channel.id);
            if (!res) { return; }
            this.writeChunk(channel, res, `event: tick\ndata: ${JSON.stringify({ t: now })}\n\n`);
        });
        // 屏那边同样收一遍：VS Code 窗口半天没动静（死机、网断了没通知到）就别留在登记簿里，
        // 否则点文件会被派给一个已经不在的窗口。
        const screens = this.host.getScreens();
        for (const id of screens.staleIds(this.pageStaleMs)) {
            this.hooks.log(`屏 ${id} 已经 ${Math.round(this.pageStaleMs / 1000)} 秒没有任何动静，` +
                "把它从登记簿里拿掉（插件会自己重连）。");
            const res = this.screenStreams.get(id);
            this.dropScreen(id);
            if (res) { this.endStream(res, ""); }
        }
        for (const screen of screens.list()) {
            const res = this.screenStreams.get(screen.id);
            if (!res) { continue; }
            this.writeScreenChunk(screen.id, res, `event: tick\ndata: ${JSON.stringify({ t: now })}\n\n`);
        }
    }

    // ========================================================================
    //  页面发来的消息（页面 → 插件）
    // ========================================================================

    /**
     * 页面发来一条消息。
     *
     * 不挑"哪一个页面才算数"：手机、电脑可以同时开着，谁发消息都收。
     * 只有一件事要挡：本服务从来没见过的页面标识（多半是服务重启前留下的旧页面），
     * 那种收下也没有出口，明确让它刷新比默默吃掉好。
     * 页面暂时断开（手机退到后台再回来）时发来的消息照常收下：那时它多半正在重连，
     * 回的东西由会话工作区攒着，连接回来一次补齐，再整屏重画一遍。
     */
    private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, pageId: string): Promise<void> {
        const broadcaster = this.host.getBroadcaster();
        if (!broadcaster.isKnown(pageId)) {
            this.sendText(req, res, 409, "此页面不是当前这个网页服务发出的（服务可能重启过）。刷新页面就好。");
            return;
        }
        const text = await readBody(req, MAX_REQUEST_BYTES);
        if (text === undefined) {
            this.sendText(req, res, 413, "请求内容过大。");
            return;
        }
        let msg: any;
        try {
            msg = JSON.parse(text);
        } catch {
            this.sendText(req, res, 400, "请求内容不是合法的 JSON。");
            return;
        }
        if (msg && msg.type === "channelPing") {
            // 页面报活：只说明它还活着，不算"人在里面动过"
            broadcaster.beat(pageId);
        } else {
            broadcaster.touch(pageId, true);
            try {
                this.host.processPageMessage(msg, pageId);
            } catch (err: any) {
                this.hooks.log(`处理页面消息出错：${err?.message ?? String(err)}`);
            }
        }
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
    }

    // ========================================================================
    //  屏的连接（VS Code 窗口 ↔ 后端）
    // ========================================================================

    /**
     * 一个 VS Code 窗口来开屏连接。
     *
     * 同一个窗口又连了一次（插件重载、网断了又通）：把旧连接安静收掉就行。
     * 打开着的文件夹写在查询参数里（连上的那一刻就要用：这个窗口到了该干活的目录时
     * 得立刻能派活，不必等它再发一条消息）。
     */
    private openScreen(res: http.ServerResponse, screenId: string, foldersJson: string): void {
        const id = screenId || `s-${crypto.randomUUID()}`;
        let folders: string[] = [];
        try {
            const parsed = JSON.parse(foldersJson || "[]");
            if (Array.isArray(parsed)) { folders = parsed.filter((f): f is string => typeof f === "string" && f !== ""); }
        } catch { /* 参数写坏了就当空窗口：什么都不认，比乱认强 */ }
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.write("retry: 1000\n\n");
        res.write(": connected\n\n");
        res.socket?.setNoDelay(true);
        // 同一个窗口重连：旧的那条安静收掉（它多半已经断了，只是没通知到）
        const old = this.screenStreams.get(id);
        this.screenStreams.set(id, res);
        if (old && old !== res) { try { old.destroy(); } catch { /* 已经断了 */ } }
        const onClose = () => { this.dropScreen(id); };
        res.on("close", onClose);
        res.on("error", onClose);
        this.host.attachScreen(id, folders, (msg) => {
            this.writeScreenChunk(id, res, `event: msg\ndata: ${JSON.stringify(msg)}\n\n`);
        });
    }

    /** 往一条屏连接写一段内容；写不动了就把它注销掉（插件那边会自己重连）。 */
    private writeScreenChunk(id: string, res: http.ServerResponse, chunk: string): void {
        if (res.writableEnded || res.destroyed) { this.dropScreen(id); return; }
        try {
            const flushed = res.write(chunk);
            if (!flushed && res.writableLength > this.backlogBytes) {
                this.hooks.log(`屏 ${id} 有一阵子没在读推送流（积压 ${Math.round(res.writableLength / 1024)} KB），" +
                    "掐掉这条连接，插件会自己重连。`);
                this.dropScreen(id);
            }
        } catch {
            this.dropScreen(id);
        }
    }

    /** 断开一条屏连接（窗口关了 / 网断了 / 积压太多）。 */
    private dropScreen(id: string): void {
        if (!this.screenStreams.has(id)) { return; }
        this.screenStreams.delete(id);
        this.host.detachScreen(id);
    }

    /** 屏发来一条消息（能力执行结果、符号集合、要个页面标识……）。 */
    private async handleScreenApi(req: http.IncomingMessage, res: http.ServerResponse, screenId: string): Promise<void> {
        if (!this.host.getScreens().get(screenId)) {
            this.sendText(req, res, 409, "这个窗口不在后端登记簿里（后端可能重启过）。插件会自己重连。");
            return;
        }
        this.host.getScreens().markSeen(screenId);
        const text = await readBody(req, MAX_REQUEST_BYTES);
        if (text === undefined) {
            this.sendText(req, res, 413, "请求内容过大。");
            return;
        }
        let msg: any;
        try {
            msg = JSON.parse(text);
        } catch {
            this.sendText(req, res, 400, "请求内容不是合法的 JSON。");
            return;
        }
        let answer: unknown;
        try {
            answer = this.host.processScreenMessage(msg, screenId);
        } catch (err: any) {
            this.hooks.log(`处理屏消息出错：${err?.message ?? String(err)}`);
        }
        if (answer === undefined) {
            res.writeHead(204, { "Cache-Control": "no-store" });
            res.end();
            return;
        }
        this.sendJson(req, res, 200, answer);
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

/** 解析真实路径（软链接一起解开）；解不开（文件不在）返回 undefined。 */
function realPathOr(p: string): string | undefined {
    try { return fs.realpathSync(p); } catch { return undefined; }
}

/**
 * 在「这个会话碰过的文件」里按名字找那个链接说的文件（找不到返回 undefined）。
 *
 * 找法与编辑器打开文件时那一档一样：
 *   1. 先看有没有一条相对写法正好就是它（链接里写了跟清单里一样的相对路径），或者清单里那个绝对路径就是它；
 *   2. 再按最后一段（文件名）对：清单里相对写法等于这个文件名、或者以 `/文件名` 结尾的都算；
 *    同名的有好几个时，先挑相对写法里带着整条问法的那个（`src/a.ts` 优先于 `lib/a.ts`）。
 *
 * 比大小写两边都转小写（跟编辑器那边一致）：Windows 上文件名本来就不分大小写。
 */
function matchKnownFile(known: readonly string[], query: string, cwd: string): string | undefined {
    const norm = (s: string): string => s.replace(/\\/g, "/").toLowerCase();
    const q = norm(query);
    const relOf = (f: string): string => norm(relativeTo(cwd, f));
    const exact = known.find((f) => relOf(f) === q || norm(f) === q);
    if (exact) { return exact; }
    const base = q.split("/").pop() || q;
    if (!base) { return undefined; }
    const cands = known.filter((f) => {
        const rel = relOf(f);
        return rel === base || rel.endsWith("/" + base);
    });
    return cands.find((f) => relOf(f).includes(q)) || cands[0];
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
        let done = false;
        let received = 0;
        const finish = (value: string | undefined) => {
            if (done) { return; }
            done = true;
            resolve(value);
        };
        req.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > limit) {
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

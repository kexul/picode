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
import { insideFolder, pathCaseKey, relativeTo } from "./pathRules";
import type { SessionChangeInfo } from "./editTracker";
import type { BashTaskInfo } from "./bashProtocol";
import { readRemoteNotice, type RemoteNotice } from "./remoteNotice";

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

/**
 * 站内页面（`/site/…`）按扩展名给的 Content-Type：会话目录里的一张网页连同它的样式、脚本、
 * 图片、字体，浏览器拿这些类型直接当网页用。不认识的按二进制给。
 */
const SITE_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
    [".html", "text/html; charset=utf-8"], [".htm", "text/html; charset=utf-8"],
    [".xhtml", "text/html; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
    [".cjs", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"], [".map", "application/json; charset=utf-8"],
    [".xml", "application/xml; charset=utf-8"], [".txt", "text/plain; charset=utf-8"],
    [".md", "text/plain; charset=utf-8"], [".csv", "text/csv; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"], [".otf", "font/otf"],
    [".wasm", "application/wasm"],
    [".mp4", "video/mp4"], [".webm", "video/webm"], [".mp3", "audio/mpeg"], [".wav", "audio/wav"],
    [".pdf", "application/pdf"],
]);

/** 一张网页（`/site/…`）里那个文件该按什么类型给（不认识的按二进制给，别让浏览器猜）。 */
function siteContentType(filePath: string): string {
    const ext = extensionOf(filePath);
    return SITE_CONTENT_TYPES.get(ext) ?? IMAGE_CONTENT_TYPES.get(ext) ?? "application/octet-stream";
}

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
    /** 文件有多大（字节；目录没有） */
    size?: number;
    /** 是不是一张图（是的话页面可以拿它的小图当缩略图；目录没有） */
    image?: boolean;
}

interface DirListing {
    /** 子目录在前、文件在后，各自按名字排（大小写不敏感） */
    entries: DirEntryInfo[];
    /** 条目太多，只列了前 MAX_DIR_ENTRIES 个 */
    truncated?: boolean;
}

/**
 * 在会话目录里按文件名找一圈（见 findFileByName）的两道定额：扫到这么多条目、或者花到这么多
 * 毫秒就收手。链接里只有光名字（`chat.js`）时才走那一条，是点一下换来的“最多等这么久”。
 *（在插件仓库上量过：整棵源码树跳过 node_modules 后约 800 个条目、4 毫秒。）
 */
const NAME_SEARCH_MAX_ENTRIES = 4000;
const NAME_SEARCH_BUDGET_MS = 80;
/**
 * 按名字找时不进去的目录：大工程里这些才是大头（依赖、版本库、构建产物、虚拟环境）。
 * 跟编辑器那条「在工作区里按文件名搜」的排除名单一个意思。
 */
const NAME_SEARCH_SKIP_DIRS: ReadonlySet<string> = new Set([
    "node_modules", ".git", ".hg", ".svn", "out", "dist", "build", ".next", ".nuxt",
    ".venv", "venv", "env", "__pycache__", ".pytest_cache", ".mypy_cache", "target",
    ".cache", ".gradle", ".idea", ".vs", "coverage", ".tox",
]);

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
    /**
     * 这个会话改过哪些文件（相对写法 + 增删行数），文件侧边栏那一格「改动」的清单就是它。
     * 认不出这个会话就给空数组。
     */
    sessionChanges(sessionId: string): SessionChangeInfo[];
    /**
     * 这个会话的后台命令（文件侧边栏那一格「脚本」的清单），认不出这个会话就给空数组。
     */
    sessionBashTasks(sessionId: string): BashTaskInfo[];
    /** 一条后台命令的输出（界面点开那一行要看的那段）；不属于这个会话就是 undefined。 */
    sessionBashLog(sessionId: string, no: number): string | undefined;
    /**
     * 一个文件的合计 diff（本会话第一次改之前 → 现在磁盘上的）；没改出差别返回 undefined。
     * @param relPath 相对会话目录的写法（跟 sessionChanges 里那一行一模一样）
     */
    sessionChangeDiff(sessionId: string, relPath: string): string | undefined;
    /**
     * 一条推送连接建立（页面连上 / 重连）。
     * @param since 页面报上来的「我处理到第几条」（连接地址上的 since），没报就是 undefined。
     */
    onPageConnected(pageId: string, since?: number): void;
    /** 一条推送连接断了（页面关掉 / 死连接被掐掉）。 */
    onPageDisconnected(pageId: string): void;
    /** 服务起来了（缓冲可以开始攒：页面可能马上要来）。 */
    onServerStarted(): void;
    /** 服务停了：页面的告别话发完、缓冲清掉，会话工作区本身不受影响。 */
    onServerStopped(): void;
    /** 当前界面颜色（写进页面的初始主题）。 */
    getThemeMode(): "light" | "dark";
    /** 别处推来一条“有事”（`POST /notify`，口令已经核对过）：塞进托盘清单。 */
    acceptRemoteNotice(notice: RemoteNotice): void;
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

    /**
     * 同步收摊：断掉每条推送连接、清心跳。会话不动（后端进程自己退不退是启动器的事）。
     * @param quiet 不跟页面道别（直接断掉连接）：页面上收到道别会把“服务真的停了”当真、不再自己重连；
     *              「编译并重启」那颗按钮走这条——这个服务过几十秒还会在同一个地址上回来。
     */
    private teardown(quiet = false): void {
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
        const broadcaster = this.host.getBroadcaster();
        for (const channel of broadcaster.removeAllChannels()) {
            // 告别话要给：页面收到 end 就不再重连（服务真的停了，重连也没用）
            channel.close(quiet ? "" : "网页服务已停止。");
        }
        this.streams.clear();
        for (const [id, res] of this.screenStreams) {
            this.host.detachScreen(id);
            this.endStream(res, quiet ? "" : "服务已停止。");
        }
        this.screenStreams.clear();
        this.host.onServerStopped();
        this.boundHost = "";
        this.boundPort = 0;
        this.ownHostnames = [];
    }

    /**
     * 停服务并等监听真的关掉（改配置重启时用）。
     * @param quiet 不跟页面道别（见 {@link teardown}）：重启后端时用。
     */
    public async stop(quiet = false): Promise<void> {
        const server = this.server;
        const wasRunning = server !== undefined;
        this.server = undefined;
        this.teardown(quiet);
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
            // 别的 pichat 后端推来的“有事”（机器对机器，见 src/remoteNotice.ts）
            if (pathname === "/notify") {
                void this.handleRemoteNotice(req, res);
                return;
            }
            if (pathname === "/" || pathname === "/index.html") {
                this.sendPage(req, res, url.searchParams.get("pageId") ?? "");
                return;
            }
            if (pathname === "/panel") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.sendPanel(req, res, url.searchParams.get("theme") ?? "");
                return;
            }
            if (pathname.startsWith("/media/")) {
                this.sendMedia(req, res, pathname.slice("/media/".length), url.searchParams.get("v") ?? "");
                return;
            }
            // 站内页面（文件侧边栏里当网页打开的那个 html）：地址里带着路径本身，见 sendSite。
            // 这条按**没解码**的地址切段（路径里的 `%2F` 不能把会话号切坏），所以拿 url.pathname。
            if (url.pathname.startsWith("/site/")) {
                if (req.method !== "GET" && req.method !== "HEAD") {
                    this.sendText(req, res, 405, "只接受 GET。");
                    return;
                }
                this.sendSite(req, res, url.pathname.slice("/site/".length));
                return;
            }
            if (pathname === "/file") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.sendFile(req, res, url.searchParams.get("session") ?? "", url.searchParams.get("path") ?? "",
                    url.searchParams.get("mtime") ?? "", url.searchParams.get("download") === "1",
                    url.searchParams.get("anywhere") === "1");
                return;
            }
            if (pathname === "/dir") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.sendDir(req, res, url.searchParams.get("session") ?? "", url.searchParams.get("path") ?? "");
                return;
            }
            // 「改动」那一格：这个会话改过哪些文件（清单），以及其中一个文件的合计 diff
            if (pathname === "/changes") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.sendChanges(req, res, url.searchParams.get("session") ?? "");
                return;
            }
            if (pathname === "/changes/diff") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.sendChangeDiff(req, res, url.searchParams.get("session") ?? "",
                    url.searchParams.get("path") ?? "");
                return;
            }
            // 「脚本」那一格：这个会话的后台命令清单
            if (pathname === "/bash") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.sendBashTasks(req, res, url.searchParams.get("session") ?? "");
                return;
            }
            // 「脚本」那一格里点开一行：这条后台命令的输出（尾部一段，纯文本）
            if (pathname === "/bash/log") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.sendBashLog(req, res, url.searchParams.get("session") ?? "",
                    Number(url.searchParams.get("no") ?? "0"));
                return;
            }
            if (pathname === "/events") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.openChannel(req, res, url.searchParams.get("pageId") ?? "", url.searchParams.get("since") ?? "");
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
     */
    private sendPanel(req: http.IncomingMessage, res: http.ServerResponse, theme: string): void {
        const themeMode = theme === "dark" ? "dark" : "light";
        let html: string;
        try {
            html = getPanelChatHtml(this.mediaDir, { themeMode });
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
    /** 文本文件能直接看的字节上限：再大的不读出来（页面给一句「太大」；要下载那是另一条路）。 */
    private static readonly MAX_FILE_BYTES = 2 * 1024 * 1024;

    /**
     * 图片能直接看的字节上限。比文本宽得多：手机照片、截图常见几 MB，而图片是流式发出去的
     * （后端不整份读进内存），挡在这里只会让人看不到图。再大的仍然只给下载。
     */
    private static readonly MAX_IMAGE_BYTES = 20 * 1024 * 1024;

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
     * 找文件分三档。
     *
     * 第一档按会话目录拼。拼得到（路径真在）就用它，哪怕它指向目录外面——边界该报 403 就报 403，
     * 不拿后两档把话岔开（`outside/package.json` 这种写法该说「在会话目录外」）。
     *
     * 第二档只在第一档拼不到（路径不存在）时走，而且只有文件有（目录没有这份清单）：
     * 在这个会话碰过的文件（read / edit / write 过的，见 knownSessionFiles）里按名字匹配——
     * 链接里只有 `chat.js` 这种光名字、或者路径写岔了（`src/chat.js` 写成 `lib/chat.js`）时还能找到。
     * 匹配到的路径同样要过那道边界：清单里那个文件真身在会话目录外（读的是外面的软链接）时
     * 也不给看。
     *
     * 第三档（同样只有文件有）在前两档都没中时走：在会话目录里按文件名找一圈，见 findFileByName。
     * 它管的是「这个文件会话里没人碰过，但光名字本来就是想点它」——正文里写 `chat.js` 而不写
     * `media/chat.js` 时（模型自己写的链接、人贴的路径）不至于点不动。代价是这一档要读几个目录，
     * 所以只在前面都没中时才走，而且有定额（大工程里扫不完就当没有）。
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
        // 第三档：会话里没人碰过这个名字——在会话目录里按文件名找一圈（有定额，扫不完就当没有）
        if (kind === "文件") {
            const hit = this.findFileByName(cwd, wantPath);
            const realHit = hit ? realPathOr(hit) : undefined;
            if (realHit) {
                return this.checkInsideSession(realHit, realCwd, kind);
            }
            return { ok: false, status: 404, text: "没有这个文件（会话目录里按文件名也只找了有限的一圈）。" };
        }
        return { ok: false, status: 404, text: `没有这个${kind}。` };
    }

    /**
     * 第三档：在会话目录里按文件名找一遍（链接里只有光名字、或者路径写岔了的时候）。
     *
     * 三条规矩：
     *   - **广度优先**：浅的先中（`a/chat.js` 赢过 `a/b/c/chat.js`）；路径尾巴对上那个写法（`media/chat.js`）
     *     赢过只对上名字的，所以一边找一边记着第一个只对上名字的，找到尾巴对上的立刻返回；
     *   - **不进的目录**：见 NAME_SEARCH_SKIP_DIRS（大工程里 node_modules、.git、构建产物才是大头）；
     *   - **有定额**：扫够 NAME_SEARCH_MAX_ENTRIES 个条目或花掉 NAME_SEARCH_BUDGET_MS 就收手，
     *     拿手头那个只对上名字的（没有就当没找到）。这一档只在前面两档都没中时才走，是点一下链接
     *     换来的，所以这个定额就是“最多让它等多久”。
     *
     * 只读目录名字，不读文件内容；找到的路径照样要过会话目录那道边界（调用方判）。
     */
    private findFileByName(cwd: string, wantPath: string): string | undefined {
        const want = wantPath.replace(/\\/g, "/");
        const base = want.split("/").pop() || "";
        if (!base) { return undefined; }
        const endedAt = Date.now() + NAME_SEARCH_BUDGET_MS;
        let seen = 0;
        let fallback: string | undefined;
        const pending = [cwd];
        while (pending.length > 0) {
            const dir = pending.shift()!;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const entry of entries) {
                if (++seen > NAME_SEARCH_MAX_ENTRIES || Date.now() > endedAt) { return fallback; }
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!NAME_SEARCH_SKIP_DIRS.has(entry.name)) { pending.push(full); }
                    continue;
                }
                if (!entry.isFile() || entry.name !== base) { continue; }
                const rel = relativeTo(cwd, full).replace(/\\/g, "/");
                if (rel === want || rel.endsWith("/" + want)) { return full; }
                if (!fallback) { fallback = full; }
            }
        }
        return fallback;
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
     * 放宽版取文件：`/file` 带上 `anywhere=1` 时走这条，只认图片。
     *
     * 会话目录那道边界不判了：正文里写的 `C:\…\x.png`、`/home/…/x.png`、`file:///…`、
     * `../x.png` 都能显示（整机上的图片按路径取）。仍然守住的两条：
     *   - **只认图片**：扩展名不是图片的一律 403——这不是「整台机器的读接口」，只多放开了图片那一种；
     *   - **大小照旧**：图片上限还是 MAX_IMAGE_BYTES（见 sendFile 的图片那一支）。
     * 相对路径照样按会话目录解（页面只能拼出相对写法，绝对路径原样用）；`..`、软链接不再拦。
     */
    private resolveAnywhereImage(sessionId: string, wantPath: string):
        { ok: true; real: string } | { ok: false; status: number; text: string } {
        if (!wantPath || wantPath.includes("\0")) {
            return { ok: false, status: 400, text: "请求里要说明是哪个图片。" };
        }
        const cwd = this.host.resolveSessionDir(sessionId);
        if (!cwd) {
            return { ok: false, status: 404, text: "这个会话不在了（页面可能开得太久），刷新页面再试。" };
        }
        const real = realPathOr(path.resolve(cwd, wantPath));
        if (!real) {
            return { ok: false, status: 404, text: "没有这个图片。" };
        }
        if (fileFormatOf(real) !== "image") {
            return { ok: false, status: 403, text: "这样只能取图片，别的文件只认会话目录里的。" };
        }
        return { ok: true, real };
    }

    /**
     * 发一个文件给页面（`/file?session=…&path=…&mtime=…&download=1`）。
     *
     * 只读，而且只看得到当前会话目录里的文件：目录边界与那条目录地址同一套
     * （见 resolveSessionPath：`..` 绕出去的、软链接指到外面的都不给）。
     *
     * 唯一的例外是图片：带上 `anywhere=1` 时那道边界不判了，整机上的图片按路径都能看
     * （正文里写 `C:\…\x.png`、`/home/…/x.png`、`../x.png` 这类——见 resolveAnywhereImage）。
     * 别的文件、以及下载，都不认这个开关。
     *
     * 怎么给，看文件是哪种（按扩展名，见 fileFormatOf）：
     *   - 文本（UTF-8）当正文递出去，页面画成带行号的一行一格；超过 2 MB 的 413，
     *     正文里带着字节数，页面据此说「太大」；
     *   - 图片按图片类型流出去，页面拿它当图片显示；上限比文本宽（见 MAX_IMAGE_BYTES），
     *     超过的同样 413；
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
     * @param anywhere   true = 整机上的图片也认（只有图片这条路放得开，见 resolveAnywhereImage）
     */
    private sendFile(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string, wantPath: string,
        sinceMtime = "", download = false, anywhere = false): void {
        let realTarget: string;
        if (anywhere) {
            // 放宽只放给图片这一种取法：下载（能存到磁盘上）与别的文件都不走这条
            if (download) {
                this.sendText(req, res, 403, "这条只有图片能看，不给下载。");
                return;
            }
            const loose = this.resolveAnywhereImage(sessionId, wantPath);
            if (!loose.ok) { this.sendText(req, res, loose.status, loose.text); return; }
            realTarget = loose.real;
        } else {
            const found = this.resolveSessionPath(sessionId, wantPath, "文件");
            if (!found.ok) { this.sendText(req, res, found.status, found.text); return; }
            realTarget = found.real;
        }
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
        if (format === "image") {
            // 图片按图片类型流出去：页面拿它当图片地址显示（图片自己的上限比文本宽）
            if (stat.size > PiChatWebServer.MAX_IMAGE_BYTES) {
                this.sendFileNote(req, res, 413,
                    `图片太大（${stat.size} 字节），这里只显示小于 20 MB 的图片。`, mtime, stat.size);
                return;
            }
            this.streamFile(res, realTarget, 200, stat.size, {
                "Content-Type": IMAGE_CONTENT_TYPES.get(extensionOf(realTarget))!,
                "Cache-Control": "no-store",
                "X-File-Mtime": mtime,
            });
            return;
        }
        // 「太大」比「是二进制」先说：超 2 MB 的文本一律不往页面里塞，给句话加一个下载
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
     * 把会话目录里的一个文件按它自己的类型发给页面（`/site/<会话>/<相对路径>`）。
     *
     * 跟 `/file` 那条只差一处：**路径就在地址里**。为的是在左边文件侧边栏里把 html 当网页打开——
     * 页面里的相对引用（`./a.css`、`img/x.png`、`<script src="app.js">`）由浏览器按这条地址
     * 自己解析，落在 `/site/<会话>/…` 下面，那些子请求也走这条地址。
     *（`/file?session=…&path=…` 那条做不到：相对引用会解析成 `/a.css`，全是 404。）
     *
     * 只读、只看会话目录里的东西（边界与 `/file` 同一套，见 resolveSessionPath）；不设大小上限
     * （页面、图片、字体都可能不小，流式给出去）。HEAD 只给头：页面拿它比修改时间，
     * 看要不要把那个 iframe 重载一遍。
     *
     * @param rest 地址里 `/site/` 后面那一段（**没解码**：会话号那一段自己解，见下）
     */
    private sendSite(req: http.IncomingMessage, res: http.ServerResponse, rest: string): void {
        const cut = rest.indexOf("/");
        const sessionId = cut > 0 ? decodeSegment(rest.slice(0, cut)) : undefined;
        const segments = cut > 0 ? rest.slice(cut + 1).split("/").map(decodeSegment) : [];
        if (sessionId === undefined || segments.length === 0 || segments.some((s) => s === undefined)) {
            this.sendText(req, res, 400, "请求地址不合法。");
            return;
        }
        const wantPath = segments.join("/");
        if (!wantPath || wantPath.endsWith("/")) {
            this.sendText(req, res, 404, "没有这个文件（这是个目录）。");
            return;
        }
        const found = this.resolveSessionPath(sessionId, wantPath, "文件");
        if (!found.ok) { this.sendText(req, res, found.status, found.text); return; }
        let stat: fs.Stats;
        try {
            stat = fs.statSync(found.real);
        } catch {
            this.sendText(req, res, 404, "没有这个文件。");
            return;
        }
        if (!stat.isFile()) {
            this.sendText(req, res, 404, "没有这个文件（这是个目录）。");
            return;
        }
        const headers = {
            "Content-Type": siteContentType(found.real),
            "Cache-Control": "no-store",
            "X-File-Mtime": String(Math.floor(stat.mtimeMs)),
        };
        if (req.method === "HEAD") {
            res.writeHead(200, { ...headers, "Content-Length": stat.size });
            res.end();
            return;
        }
        this.streamFile(res, found.real, 200, stat.size, headers);
    }

    /**
     * 列一个目录给页面（`/dir?session=…&path=…`）：点消息流里的目录链接、以及面板里再点进去的
     * 子目录都走它。目录边界与 `/file` 同一套（见 resolveSessionPath）。
     *
     * 回一份 JSON：`{ entries: [{ name, path, dir, size?, image? }], truncated? }`。
     *   - `path` 是相对会话目录的写法（页面拿它当标签的键，也原样贴回下一次请求），不写绝对路径；
     *   - 文件带着 `size`（字节），图片还带 `image: true`——清单里那一行据此决定挂不挂缩略图；
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
     * 这个会话改过哪些文件（`/changes?session=…`）：文件侧边栏那一格「改动」的清单。
     *
     * 回一份 JSON：`{ changes: [{ path, added, removed, deleted, tooBig }] }`。
     * `path` 是相对会话目录的写法（页面拿它当这一行的键，也原样贴回下面那条地址）；
     * 只算真出了差别的（改了又改回去的、失败的编辑不列），按路径排。
     *
     * 数据全在会话的内存里（见 EditTracker 的 fileBaselines）：页面刷新重拿一次就是这个结果，
     * 插件重启 / 会话关掉就没了。
     */
    private sendChanges(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
        if (!sessionId) { this.sendText(req, res, 400, "请求里要说明是哪个会话。"); return; }
        if (!this.host.resolveSessionDir(sessionId)) {
            this.sendText(req, res, 404, "这个会话不在了（页面可能开得太久），刷新页面再试。");
            return;
        }
        this.sendJson(req, res, 200, { changes: this.host.sessionChanges(sessionId) });
    }

    /**
     * 这个会话的「脚本」清单（`/bash?session=…`）：放到后台跑的命令、跑到哪一步了。
     *
     * 回一份 JSON：`{ tasks: [{ no, toolCallId, cmd, log, pid, startedAt, background, status, exitCode, elapsedMs }] }`。
     * 数据在会话的内存里（见 SessionRuntime 的 bashTasks）：页面刷新重拿一次就是这个结果，
     * 插件重启 / 会话关掉就没了（日志文件还在磁盘上）。
     */
    private sendBashTasks(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
        if (!sessionId) { this.sendText(req, res, 400, "请求里要说明是哪个会话。"); return; }
        if (!this.host.resolveSessionDir(sessionId)) {
            this.sendText(req, res, 404, "这个会话不在了（页面可能开得太久），刷新页面再试。");
            return;
        }
        this.sendJson(req, res, 200, { tasks: this.host.sessionBashTasks(sessionId) });
    }

    /**
     * 一条后台命令的输出（`/bash/log?session=…&no=…`），纯文本。
     * 只有这个会话里真有的那几条给看（对不上就是 404），不按路径去拼文件系统。
     */
    private sendBashLog(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string, no: number): void {
        if (!sessionId || !no) { this.sendText(req, res, 400, "请求里要说明是哪个会话、哪条命令。"); return; }
        const text = this.host.sessionBashLog(sessionId, no);
        if (text === undefined) {
            this.sendText(req, res, 404, "没有这条后台命令（可能已经跟着会话没了）。");
            return;
        }
        this.writeBody(req, res, 200, Buffer.from(text, "utf8"), {
            "Content-Type": "text/plain; charset=utf-8",
        });
    }

    /**
     * 一个文件的合计 diff（`/changes/diff?session=…&path=…`），纯文本。
     *
     * 这里不走 resolveSessionPath 那道目录边界：路径不拿去拼文件系统，只拿去跟
     * 「这个会话改过的那几个文件」对名字（见 EditTracker.changeDiff），对不上就给 404。
     * 所以能看到的只能是会话里真改过的文件（包括已经删掉的：删掉的也有改之前那一份）。
     */
    private sendChangeDiff(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string,
        wantPath: string): void {
        if (!sessionId || !wantPath) {
            this.sendText(req, res, 400, "请求里要说明是哪个会话、哪个文件。");
            return;
        }
        const diff = this.host.sessionChangeDiff(sessionId, wantPath);
        if (diff === undefined) {
            this.sendText(req, res, 404, "这个文件不在这次的改动里（可能已经改回去了）。");
            return;
        }
        this.writeBody(req, res, 200, Buffer.from(diff, "utf8"), {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
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
            const isDir = stat.isDirectory();
            const entry: DirEntryInfo = { name, path: relativeTo(realCwd, full), dir: isDir };
            if (!isDir) {
                entry.size = stat.size;
                // 清单里图片那一行要挂缩略图：认哪种扩展名是图这件事只在后端这一处（见 fileFormatOf）
                if (fileFormatOf(full) === "image") { entry.image = true; }
            }
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
     * 重连时页面会在地址上多带一个 `since`（它处理到第几条）。断线期间漏掉的那几条由
     * 宿主按这个数接着往下发（见 ChatBroadcaster.resume），页面不用再发一条消息来对账。
     */
    private openChannel(req: http.IncomingMessage, res: http.ServerResponse, pageId: string, sinceText: string): void {
        // 页面标识正常都是服务发出页面时写进去的那个；万一没有就自己编一个，别把好几个页面混成一条
        const id = pageId || `p-anon-${crypto.randomUUID()}`;
        const broadcaster = this.host.getBroadcaster();
        const { channel, replaced, openSeq } = broadcaster.addChannel(
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
        // 断线这段时间广播出去的消息按页面报的序号补给这个页面（补不上、或者序号对不上时，
        // 宿主那头会整屏重画一次）。
        this.host.onPageConnected(id, parseSince(sinceText));
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
        const broadcaster = this.host.getBroadcaster();
        const current = broadcaster.getChannel(channel.id);
        broadcaster.removeChannel(channel);
        // 这条是早先被同标识的新连接顶掉的旧连接（它迟到才报关闭）：新连接的东西一点别动——
        // 删了它那条流，新连接就收不到心跳（页面 75 秒后又自己重连）；按标识通知“页面断了”
        // 还会把新连接刚重发回去的卡片名单摘掉、把它正在跑的整屏重画记成“待重画”。
        if (current !== channel) { return; }
        this.streams.delete(channel.id);
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
    /**
     * 别的 pichat 后端推来一条“有事”。
     *
     * 这条是机器对机器发的：没有 Origin 头（浏览器的脚本发的有，过不了 originAllowed 那道关，
     * 到不了这里），也没有口令——这个后端本来就没有登录，只在信得过的网络里用。
     */
    private async handleRemoteNotice(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (req.method !== "POST") {
            this.sendText(req, res, 405, "只接受 POST。");
            return;
        }
        const text = await readBody(req, MAX_REQUEST_BYTES);
        if (text === undefined) {
            this.sendText(req, res, 413, "请求内容过大。");
            return;
        }
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            this.sendText(req, res, 400, "请求内容不是合法的 JSON。");
            return;
        }
        // 推送方没写名字时用它的地址（Host 头）当“哪台机器”
        const notice = readRemoteNotice(raw, splitHostHeader(req.headers.host)?.name ?? "");
        if (!notice) {
            this.sendText(req, res, 400, "这条通知缺东西（要 sessionId 与 page，page 得是 http / https 地址）。");
            return;
        }
        this.host.acceptRemoteNotice(notice);
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
    }

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
        if (msg && msg.type === "pageLog") {
            // 页面自己捎来的一句话（未捕获异常 / 重连那几次）：写在日志里，手机上那头的
            // console 看不到，出问题时这里是唯一线索。不算“人在里面动过”。
            this.hooks.log(`[页面 ${pageId}] ${String(msg.text ?? "").slice(0, 2000)}`);
        } else if (msg && msg.type === "channelPing") {
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
/** 地址上的 `since`（页面报的「我处理到第几条」）：不是非负整数就当没报。 */
function parseSince(text: string): number | undefined {
    if (!/^\d+$/.test(text)) { return undefined; }
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : undefined;
}

function parseRequestUrl(raw: string | undefined): URL | undefined {
    const normalized = (raw ?? "/").replace(/^[\/\\]+/, "/");
    try {
        return new URL(normalized, "http://pi-chat.local");
    } catch {
        return undefined;
    }
}

/** 把地址里的百分号转义解开；解不开（例如 %zz）返回 undefined。 */
/** 解一段地址（不合法给 undefined，别让一个坏百分号把整个请求搞崩）。 */
function decodeSegment(text: string): string | undefined {
    try {
        return decodeURIComponent(text);
    } catch {
        return undefined;
    }
}

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
 * 大小写照平台来（跟编辑器那边一致）：Windows 上文件名不分大小写，别的系统上 /a/B.ts 与 /a/b.ts 是两个文件。
 */
function matchKnownFile(known: readonly string[], query: string, cwd: string): string | undefined {
    const norm = pathCaseKey;
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

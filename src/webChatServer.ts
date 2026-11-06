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
    PAGE_DROPPABLE_MESSAGE_TYPES,
    splitHostHeader,
    type PageChannel,
} from "./webTransport";
import { insideFolder, pathCaseKey, relativeTo } from "./pathRules";
import { captureDesktopScreenshot } from "./desktopScreenshot";
import { findListedFile } from "./fileSearch";
import type { SessionChanges } from "./gitChanges";
import { readRemoteNotice, readSessionReply, type RemoteNotice } from "./remoteNotice";
import { PhoneInbox, type PhoneAsk, type PhoneNoteKind, type PhoneNoteRecord } from "./phoneInbox";
import { parseMarkdown } from "./markdownBlocks";
import { changedCharRanges, diffRows, type LineRanges } from "./wordDiff";

/**
 * PiChatWebServer —— 独立后端的网页服务：一个地址，手机和电脑都看这一份会话。
 *
 * 两条线：
 *   - **页面线**（浏览器 / 手机，以及 VS Code 里的那块网页视图）：对话页面（`/`）、
 *     插件里那块对话面板的整页（`/panel`）、界面资源（`/media/…`）、
 *     后端推给页面的消息流（`/events`）、页面发给后端的消息（`/api`）、
 *     页面要看的文件与目录（`/file`、`/dir`，只读、只看得到当前会话目录里的）、
 *     桌面实时画面（`/live`，一帧一段往后写，给浏览器页面那张图自己取）。
 *     VS Code 里的网页视图走同样的 `/events` + `/api`（只是中间隔着插件进程转发）、
 *     跑同一样一份界面代码，只有整页交给它时是内联版（`/panel`，见 pageHtml.ts）；
 *   - **屏线**（VS Code 窗口，`/screen` + `/screenapi`）：窗口在后端登记自己是打开着哪些
 *     文件夹的，好让"用编辑器打开这个文件"这类活得有人干。
 *   另外有一条 `/phone`（手机 app 里那个前台服务连的），以及一个 `/health`，给单实例判断探活用。
 *
 * 方向：后端 → 页面/屏用"服务器推送"（长连接，随时能写）；页面/屏 → 后端用普通请求（POST）。
 * 桌面实时画面是唯一一条例外：页面自己开一条长连接把帧拉下去（一帧一段，
 * 不需要把每帧转成 base64 再套进一条消息；只有插件面板走不了这条路，见 chatHost.ts）。
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
/** 一条推送连接排着这么多字节时，「过时了就没用」的那类消息（实时画面的帧）就别再往里塞了：
 *  画面本来就有下一帧，塞进去只会让它更落后，顺手把真正的消息挤在后面。
 *  直连那条（`/live`）也是按这个数丢帧，两边一条规矩。 */
const STREAM_STALE_BYTES = 128 * 1024;
/** 小于这么多字节就不费劲压了（压完省不了几个字节，还白搭一次 CPU）。 */
const COMPRESS_MIN_BYTES = 1024;
/** 压缩结果最多缓存多少份（界面文件就那几个，纯粹防着缓存无限长大）。 */
const COMPRESS_CACHE_MAX = 64;
/**
 * brotli 用哪一档：9 是量出来的折中。chat.js（667 KB）用 11 档能压到 162 KB、但一次要 630 ms
 * —— 每个文件编译后第一次被请求就要堵住服务端半秒；9 档是 175 KB、27 ms；gzip 是 213 KB。
 */
const BROTLI_QUALITY = 9;

/**
 * 请求方说它收哪些压缩方式（名字 → q 值；没提就是没有，q=0 当作不收）。
 * 浏览器都会发 `gzip, deflate, br`；手工 curl 不带这个头时什么都不收，照旧发原文。
 */
function acceptedEncodings(accept: string | string[] | undefined): Map<string, number> {
    const value = Array.isArray(accept) ? accept.join(",") : accept ?? "";
    const out = new Map<string, number>();
    for (const part of value.split(",")) {
        const [rawName, ...params] = part.trim().split(";");
        const name = rawName.trim().toLowerCase();
        if (!name) { continue; }
        const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
        const q = qParam ? Number(qParam.slice(2)) : 1;
        out.set(name, Number.isFinite(q) ? q : 1);
    }
    return out;
}

/**
 * 正文压不压、用哪种：brotli 比 gzip 再省一成多（chat.js 175 KB 对 213 KB），所以它排在前面。
 * 两种都不收（老代理、手敲的 curl）就发原文。
 */
function pickBodyEncoding(accept: string | string[] | undefined): "br" | "gzip" | undefined {
    const accepted = acceptedEncodings(accept);
    if ((accepted.get("br") ?? 0) > 0) { return "br"; }
    if ((accepted.get("gzip") ?? 0) > 0) { return "gzip"; }
    return undefined;
}

/**
 * 一条推送连接（服务端写给页面的那一串事件）。
 *
 * 请求方说能收 gzip 时就压着发：会话消息大半是文字（整屏重画一次能有几百 KB），压完只剩
 * 三成上下 —— 手机走流量时这是最实在的一笔。插件里那块对话面板是自己用 Node 连的、不带
 * Accept-Encoding，照旧发原文，两边都不用改。
 *
 * 事件得一条一条立刻送到，所以每写一段就刷一次（zlib 的 Z_SYNC_FLUSH）：不刷就攒在压缩器的
 * 缓冲区里，页面要等攒够一大块才看得见，等于把「边跑边出字」变成一顿一顿。代价是每次刷都多
 * 十几字节的块头 —— 心跳那种几十字节的小事件等于涨了一截，但一屏文字只剩三成，加起来划算。
 */
class PageStream {
    /** 压缩器；请求方不收 gzip 时没有这一层，直接往响应里写。 */
    private readonly packer?: zlib.Gzip;
    /** 积压超过这么多字节就当作页面没在读（见 write）。 */
    private readonly limit: number;

    constructor(private readonly res: http.ServerResponse, pack: boolean, limit: number) {
        this.limit = limit;
        if (!pack) { return; }
        this.packer = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH });
        this.packer.on("data", (chunk: Buffer) => {
            if (this.res.writableEnded || this.res.destroyed) { return; }
            this.res.write(chunk);
        });
        this.packer.on("error", () => { /* 压不下去基本不会：下面按积压/断开那两条路兜着 */ });
    }

    /** 还没送出去的字节（压缩器里的加上响应缓冲里的）。 */
    get backlog(): number {
        return (this.packer?.writableLength ?? 0) + this.res.writableLength;
    }

    /**
     * 写一段事件文本。
     * @returns "gone" 这条连接已经断了；"backlogged" 页面没在读、积压过线了；"ok" 写进去了
     */
    write(text: string): "ok" | "gone" | "backlogged" {
        if (this.res.writableEnded || this.res.destroyed) { return "gone"; }
        try {
            if (this.packer) { this.packer.write(text); } else { this.res.write(text); }
        } catch {
            return "gone";
        }
        return this.backlog > this.limit ? "backlogged" : "ok";
    }

    /** 收尾：note 给了就先写一句告别话（页面收到就不再重连），然后断开；空串表示直接断。 */
    end(note: string): void {
        if (this.res.writableEnded || this.res.destroyed) { return; }
        const farewell = note ? `event: end\ndata: ${JSON.stringify({ note })}\n\n` : "";
        try {
            if (this.packer) {
                // 告别话也得从压缩器走：直接 res.end() 会让页面收到半截 gzip 流
                this.packer.once("end", () => { try { this.res.end(); } catch { /* 已经断了 */ } });
                this.packer.end(farewell);
                return;
            }
            if (farewell) { this.res.write(farewell); this.res.end(); } else { this.res.destroy(); }
        } catch { /* 连接已经断了 */ }
    }
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
     * 一块屏要看这台电脑的桌面实时画面（浏览器页面按住「截图」按钮那一下）。
     * 来一帧叫一次 onFrame；这一路起不来 / 断了照旧给这块屏发一条 desktopLiveResult。
     * @returns 不看了（页面关掉那一层 / 连接断了）
     */
    watchDesktopLive(pageId: string, onFrame: (jpeg: Buffer) => void): () => void;
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
     * 这个会话目录相对它最后一次提交改过哪些文件（相对写法 + 增删行数），
     * 文件侧边栏那一格「改动」的清单就是它。会话目录不在 git 仓库里时 vcs=false（那一格整格收起来）；
     * 认不出这个会话也一样。
     */
    sessionChanges(sessionId: string): Promise<SessionChanges>;
    /**
     * 一个文件的合计 diff（最近一次提交 → 现在磁盘上的）；没改出差别返回 undefined。
     * @param relPath 相对会话目录的写法（跟 sessionChanges 里那一行一模一样）
     */
    sessionChangeDiff(sessionId: string, relPath: string): Promise<string | undefined>;
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
    /** 别处推来一条“有事”（`POST /notify`，口令已经核对过）：在本机右下角弹一条。 */
    acceptRemoteNotice(notice: RemoteNotice, fromAddress?: string): void;
    /** 别台请这台配对（`POST /pair/request`）：记下来等人去设置面板点头（拒过的直接回绝）。 */
    receivePairRequest(address: string, name: string): { ok: boolean; reason?: string };
    /** 别台回了这台那下配对请求（`POST /pair/reply`）：接受了就配上，拒绝了就把这条拿掉。 */
    receivePairReply(address: string, accepted: boolean): void;
    /**
     * 别的后端说「把你开着的页面切到这个会话」（`POST /switch`：那台机器有人点了
     * 右下角的弹窗，跳的是这边开着的页面）：广播给所有连着的页面。
     */
    acceptSwitchRequest(sessionId: string): void;
    /**
     * 别的机器把一句话转了过来（`POST /reply`）：当成这个会话里用户说的一句话接进去。
     * 手机 / 桌面那个小窗口里回别处的会话，就走这条。
     * @returns 接上了没有；没接上时带一句人话（会原样回给发来的那台）
     */
    acceptSessionReply(sessionId: string, text: string, opts: { sessionFile?: string; name?: string }): { ok: boolean; reason?: string };
    /** 现在开着哪些会话（手机 / 桌上那个小窗口的列表就是它）。 */
    phoneSessions(): PhoneSessionInfo[];
    /**
     * 某个会话「这一轮 / 上一轮」的原话（点开会话时先看一眼它说到哪儿了）。
     * 取不到（没开始跑过、pi 没答上来）就返回空串。
     */
    phoneLastReply(sessionId: string): Promise<string>;
    /** 手机那头说了一句话：送进那个会话（跟自己在输入框里敲一句一样）。 */
    phoneSend(sessionId: string, text: string): Promise<{ ok: boolean; reason?: string }>;
    /** 手机那头答了一道选择题（`/phone/answer`）：把还挂着的那张卡片按这个答案收掉。 */
    phoneAnswer(cardId: string, picks: string[], text: string): { ok: boolean; reason?: string };
    /**
     * 桌面那个小窗口的托盘菜单里点了「退出」（`POST /shutdown`）：
     * 跟终端里按 Ctrl+C 一样把这个后端收摊（停网页服务、收会话、清地址文件）。
     */
    requestQuit(): void;
}

/**
 * 手机上要看到的那条“有事”（`/phone` 那条长连接上写的就是它）。
 *
 * 只有该看见的那点东西：哪个会话、哪一类、说了什么。手机那边照这个弹一条通知，
 * 点通知就拿 sessionId 让页面切到那个会话（跟顶条上点一下那格一样）。
 */
export interface PhoneNote {
    /** 哪个会话（界面上那一格的名字）。 */
    name: string;
    /** 会话标识：手机点通知时拿它切过去。 */
    sessionId: string;
    /** 跑完一轮、在等你答一句，还是你自己刚说的一句话。 */
    kind: PhoneNoteKind;
    /** 一句话摘要（跑完一轮是回复开头，等你答是题干）。 */
    summary: string;
    /** 这条是什么时候的事（毫秒）。 */
    at: number;
    /** 别的机器推来的：那台叫什么（有它手机那边多显示一句“哪台”）。 */
    from?: string;
    /** 在等你答一句时那道题本身（选项、能不能多选）：手机那头直接摆成能点的按钮。 */
    ask?: PhoneAsk;
}

/**
 * 手机 / 桌上那个小窗口列表里的一个会话。
 *
 * 就是现在开着的那些（一个会话一个标签页），跟网页顶条上那一排是同一批。
 */
export interface PhoneSessionInfo {
    id: string;
    name: string;
    /**
     * 哪台机器上的会话：列表按它分组（同一台排一块，组头写它）。
     * 本机的写「本机」，别的机器推来的写那台的名字（它就是名字开头那个「家里 · 」）。
     */
    machine: string;
    /** 这一轮正在跑。 */
    running: boolean;
    /** 正在干什么（网页顶条上那颗点旁边那句也是这个：thinking / 工具名 / idle）。 */
    activity?: string;
    /** 更具体一点：正在改哪个文件、在跑什么命令。 */
    activityDetail?: string;
    /** 别的机器上的会话（这台已经没有那个会话了，只剩推过来的通知）。 */
    remote?: boolean;
    /**
     * 列表上那一行要的最后一条（本机的由 phoneInbox 补；从别台拉回来的直接带对方的）。
     * 见 chatHost 的 remoteSessions。
     */
    last?: PhoneNoteRecord;
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
    /** 页面标识 → 它那条连接（心跳要往里写 tick）。 */
    private readonly streams = new Map<string, PageStream>();
    /** 屏标识 → 它那条连接的响应对象。 */
    private readonly screenStreams = new Map<string, http.ServerResponse>();
    /** 手机标识 → 它那条连接的响应对象（见 /phone）。 */
    private readonly phoneStreams = new Map<string, http.ServerResponse>();
    /** 手机上留着的那一串「有事」（每个会话最近若干条，见 src/phoneInbox.ts）。 */
    private readonly phoneInbox = new PhoneInbox();
    private heartbeat?: ReturnType<typeof setInterval>;
    private readonly heartbeatMs = HEARTBEAT_MS;
    private readonly pageStaleMs = PAGE_STALE_MS;
    private readonly backlogBytes = STREAM_BACKLOG_BYTES;
    /** 压缩结果缓存：界面文件的内容没变时不用重压（键是"压缩方式@文件名@修改标记"，见 sendMedia）。 */
    private readonly compressCache = new Map<string, Buffer>();
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
        for (const res of this.phoneStreams.values()) {
            try {
                this.writePhone(res, "end", { note: quiet ? "" : "网页服务已停止。" });
                res.end();
            } catch { /* 已经断了 */ }
        }
        this.phoneStreams.clear();
        // 服务停了（包括换端口重启）：留着的那些也丢掉（后端重启就没了，见 src/phoneInbox.ts）
        this.phoneInbox.clear();
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
            // 那台机器有人点了右下角的弹窗、要跳到这边开着的页面：广播切会话（机器对机器，同上）
            if (pathname === "/switch") {
                void this.handleSwitchRequest(req, res);
                return;
            }
            // 别的机器把一句话转回来（机器对机器，同上）
            if (pathname === "/reply") {
                void this.handleSessionReply(req, res);
                return;
            }
            // 跨机器配对（机器对机器，同一个规矩）：这台请那台点头、那台回了这台一句
            if (pathname === "/pair/request") {
                void this.handlePairRequest(req, res);
                return;
            }
            if (pathname === "/pair/reply") {
                void this.handlePairReply(req, res);
                return;
            }
            // 手机 app 里那个前台服务连的（机器对机器，同上）
            if (pathname === "/phone") {
                this.openPhone(req, res, url.searchParams.get("client") ?? "");
                return;
            }
            // 手机 / 桌上那个小窗口要的那份列表与某个会话留着的几条（机器对机器，同上）
            if (pathname === "/phone/sessions") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.sendJson(req, res, 200, { sessions: this.phoneSessionsPayload() });
                return;
            }
            if (pathname === "/phone/session") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                void this.sendPhoneSession(req, res, url.searchParams.get("id") ?? "");
                return;
            }
            if (pathname === "/phone/send") {
                void this.handlePhoneSend(req, res);
                return;
            }
            if (pathname === "/phone/answer") {
                void this.handlePhoneAnswer(req, res);
                return;
            }
            // 桌面那个小窗口的托盘菜单里点了「退出」（机器对机器，同一个规矩）
            if (pathname === "/shutdown") {
                if (req.method !== "POST") { this.sendText(req, res, 405, "只接受 POST。"); return; }
                res.writeHead(204, { "Cache-Control": "no-store" });
                res.end();
                this.host.requestQuit();
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
                void this.withFailNote(req, res, this.sendSite(req, res, url.pathname.slice("/site/".length)));
                return;
            }
            if (pathname === "/file") {
                if (req.method === "POST") {
                    void this.withFailNote(req, res, this.writeFile(req, res, url.searchParams.get("session") ?? "",
                        url.searchParams.get("path") ?? ""));
                    return;
                }
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                void this.withFailNote(req, res, this.sendFile(req, res, url.searchParams.get("session") ?? "", url.searchParams.get("path") ?? "",
                    url.searchParams.get("mtime") ?? "", url.searchParams.get("download") === "1",
                    url.searchParams.get("anywhere") === "1"));
                return;
            }
            if (pathname === "/dir") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                void this.withFailNote(req, res, this.sendDir(req, res, url.searchParams.get("session") ?? "", url.searchParams.get("path") ?? ""));
                return;
            }
            // 「改动」那一格：会话目录跟最后一次提交差了什么（清单），以及其中一个文件的合计 diff
            if (pathname === "/changes") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                void this.withFailNote(req, res, this.sendChanges(req, res, url.searchParams.get("session") ?? ""));
                return;
            }
            if (pathname === "/changes/diff") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                void this.withFailNote(req, res, this.sendChangeDiff(req, res, url.searchParams.get("session") ?? "",
                    url.searchParams.get("path") ?? ""));
                return;
            }
            if (pathname === "/diff/highlight") {
                if (req.method !== "POST") { this.sendText(req, res, 405, "只接受 POST。"); return; }
                void this.withFailNote(req, res, this.sendDiffHighlight(req, res));
                return;
            }
            if (pathname === "/shot") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                void this.withFailNote(req, res, this.sendDesktopShot(req, res, url.searchParams.get("pageId") ?? ""));
                return;
            }
            if (pathname === "/live") {
                if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
                this.openDesktopLive(req, res, url.searchParams.get("pageId") ?? "");
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
     * 等一条异步的取文件路子跑完；意料之外的错就给一句 500（route 那个 try/catch 管不到异步这边），
     * 不让一个请求悬在那儿。回应的正文已经发出去了时 sendText 会报错，吞掉即可。
     */
    private async withFailNote(req: http.IncomingMessage, res: http.ServerResponse, work: Promise<void>): Promise<void> {
        try {
            await work;
        } catch (err: any) {
            this.hooks.log(`取文件出错：${err?.message ?? String(err)}`);
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
     * 第三档（同样只有文件有）在前两档都没中时走：在会话目录的文件清单里挑最像的那一个
     * （见 fileSearch.ts 的 findListedFile）。它管的是「这个文件会话里没人碰过，但光名字本来就是
     * 想点它」——正文里写 `chat.js` 而不写 `media/chat.js` 时（模型自己写的链接、人贴的路径）
     * 不至于点不动。清单跟文件搜索共用一份、带缓存，所以点一下不用重新扫盘。
     *
     * 看不了时返回状态码与一句人话，调用方直接照它回；kind 只把话里的「文件 / 目录」说对。
     */
    private async resolveSessionPath(sessionId: string, wantPath: string, kind: "文件" | "目录"):
        Promise<{ ok: true; real: string; realCwd: string } | { ok: false; status: number; text: string }> {
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
        // 第三档：会话里没人碰过这个名字——在会话目录的文件清单里挑最像的那一个
        if (kind === "文件") {
            const hit = await findListedFile(cwd, wantPath);
            const realHit = hit ? realPathOr(path.resolve(cwd, hit)) : undefined;
            if (realHit) {
                return this.checkInsideSession(realHit, realCwd, kind);
            }
            return { ok: false, status: 404, text: "没有这个文件（会话目录里按文件名也只找了有限的一圈）。" };
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
    private async sendFile(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string, wantPath: string,
        sinceMtime = "", download = false, anywhere = false): Promise<void> {
        let realTarget: string;
        /** 这个文件真正落在会话目录的哪儿（页面要照它把内容写回去，见下面那个头）。 */
        let realCwd = "";
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
            const found = await this.resolveSessionPath(sessionId, wantPath, "文件");
            if (!found.ok) { this.sendText(req, res, found.status, found.text); return; }
            realTarget = found.real;
            realCwd = found.realCwd;
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
        // 这个文件相对会话目录到底在哪儿：链接里只有光名字、或者路径写豁了时，后端会落到另一个
        // 路径上（见 resolveSessionPath 后两档），页面要照这个写回去，不能照链接里那个写法写。
        // 头字段只能放 latin-1，中文路径得百分号编码（页面自己解，见 resolvedFilePath）。
        const relPath = realCwd ? relativeTo(realCwd, realTarget) : "";
        const pathHeader: Record<string, string> = relPath ? { "X-File-Path": encodeURIComponent(relPath) } : {};
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
            res.writeHead(204, { "Cache-Control": "no-store", "X-File-Mtime": mtime, ...pathHeader });
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
                ...pathHeader,
            });
        });
    }

    /**
     * 把页面里改好的正文写回磁盘（`POST /file?session=…&path=…`，请求体是 JSON）。
     *
     * 只有浏览器页面里那个「看文件的弹窗」会走这条（插件里的对话面板是交给编辑器打开的，不经过这儿）。
     * 写的是**同一个文件**：只认会话目录里已经存在的那个文件，不按名字去猜（这里不是 resolveSessionPath
     * 后两档那种“链接写豁了也帮你找到”的场合：猜错了就是覆盖到别的文件上）。边界与 `/file` 同一套。
     *
     * 请求体：`{ text, mtime, force }`
     *   - text：整份新正文（页面交回来的换行一律是 `\n`）；
     *   - mtime：页面开始改之前从 `/file` 拿到的那个修改时间。盘上已经不是它时回 409，
     *     页面弹一句「盘上已经变了」让人选（模型或者别的程序刚改过这个文件，不能默默拿旧的盖上去）；
     *   - force：true = 不管上面那条，直接按页面这份盖上去（人在那句提示里选的「覆盖」）。
     *
     * 两件替人看着的小事：
     *   - **行尾**：页面是一个文本框，交给我们的换行一定是 `\n`。原文件要是 CRLF（Windows 上很常见），
     *     写回去就整份换了行尾，白白多出一份“整份重写”的改动（`/changes` 那边也按行尾不看差别，见
     *     gitChanges.ts，但人在编辑器里看这一份 diff 时还是得干净）。所以按原文件
     *     的行尾写回去；
     *   - **BOM**：浏览器的 `resp.text()` 会把开头的 BOM 吃掉，写回去就少了那三个字节；原来有就补回来。
     *
     * 回应 200 给 `{ mtime }`（这次写入后的修改时间），页面存完拿它接着盯着变没变。
     */
    private async writeFile(req: http.IncomingMessage, res: http.ServerResponse,
        sessionId: string, wantPath: string): Promise<void> {
        const body = await readBody(req, MAX_REQUEST_BYTES);
        if (body === undefined) {
            this.sendText(req, res, 413, "请求内容过大。");
            return;
        }
        let raw: any;
        try {
            raw = JSON.parse(body);
        } catch {
            this.sendText(req, res, 400, "请求内容不是合法的 JSON。");
            return;
        }
        const text = raw && typeof raw.text === "string" ? raw.text : undefined;
        if (text === undefined) {
            this.sendText(req, res, 400, "要写什么（text）没给。");
            return;
        }
        if (Buffer.byteLength(text, "utf8") > PiChatWebServer.MAX_FILE_BYTES) {
            this.sendText(req, res, 413, `太大了（超过 ${PiChatWebServer.MAX_FILE_BYTES} 字节），这里改不了。`);
            return;
        }
        const found = this.resolveExistingFile(sessionId, wantPath);
        if (!found.ok) {
            this.sendText(req, res, found.status, found.text);
            return;
        }
        const realTarget = found.real;
        if (fileFormatOf(realTarget) !== "text") {
            this.sendText(req, res, 415, "这个文件不是文本，改不了。");
            return;
        }
        let old: Buffer;
        let stat: fs.Stats;
        try {
            stat = fs.statSync(realTarget);
            if (!stat.isFile()) {
                this.sendText(req, res, 404, "没有这个文件（这是个目录）。");
                return;
            }
            if (stat.size > PiChatWebServer.MAX_FILE_BYTES) {
                this.sendText(req, res, 413, `文件太大了（${stat.size} 字节），这里改不了。`);
                return;
            }
            old = fs.readFileSync(realTarget);
        } catch {
            this.sendText(req, res, 404, "没有这个文件（可能刚被删掉了）。");
            return;
        }
        const mtime = String(Math.floor(stat!.mtimeMs));
        const sinceMtime = typeof raw.mtime === "string" ? raw.mtime : "";
        if (!raw.force && sinceMtime && sinceMtime !== mtime) {
            this.sendText(req, res, 409, "盘上已经变了（模型或者别的程序刚改过这个文件）。");
            return;
        }
        const crlf = countCrlf(old) > 0 && countLoneLf(old) === 0;
        let out = crlf ? text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") : text;
        if (old.length >= 3 && old[0] === 0xef && old[1] === 0xbb && old[2] === 0xbf && !out.startsWith("\uFEFF")) {
            out = "\uFEFF" + out;
        }
        try {
            fs.writeFileSync(realTarget, Buffer.from(out, "utf8"));
        } catch (err: any) {
            this.sendText(req, res, 500, `写不进去：${err?.message ?? String(err)}`);
            return;
        }
        let next = mtime;
        try { next = String(Math.floor(fs.statSync(realTarget).mtimeMs)); } catch { /* 刚写完就没了：回原来的 */ }
        this.writeBody(req, res, 200, Buffer.from(JSON.stringify({ mtime: next }), "utf8"), {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
        });
    }

    /**
     * 把一个路径解成「会话目录里已经存在的那个真实文件」（写回磁盘用）。
     *
     * 跟 resolveSessionPath 只差一处：**不猜**。后两档（在会话碰过的文件里按名字找、在会话目录的
     * 文件清单里挑最像的）在“看”的时候很好用，落到“写”上就是拿错了文件去覆盖，所以这里只按
     * 会话目录拼一次，拼不到就说没有。
     */
    private resolveExistingFile(sessionId: string, wantPath: string):
        { ok: true; real: string } | { ok: false; status: number; text: string } {
        if (!sessionId || !wantPath || wantPath.includes("\0")) {
            return { ok: false, status: 400, text: "请求里要说明是哪个会话、哪个文件。" };
        }
        const cwd = this.host.resolveSessionDir(sessionId);
        if (!cwd) {
            return { ok: false, status: 404, text: "这个会话不在了（页面可能开得太久），刷新页面再试。" };
        }
        const realCwd = realPathOr(cwd);
        if (!realCwd) {
            return { ok: false, status: 404, text: "没有这个文件。" };
        }
        const real = realPathOr(path.resolve(cwd, wantPath));
        if (!real) {
            return { ok: false, status: 404, text: "没有这个文件（可能刚被删掉了）。" };
        }
        const checked = this.checkInsideSession(real, realCwd, "文件");
        return checked.ok ? { ok: true, real: checked.real } : checked;
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
    private async sendSite(req: http.IncomingMessage, res: http.ServerResponse, rest: string): Promise<void> {
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
        const found = await this.resolveSessionPath(sessionId, wantPath, "文件");
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
    private async sendDir(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string, wantPath: string): Promise<void> {
        const found = await this.resolveSessionPath(sessionId, wantPath, "目录");
        if (!found.ok) { this.sendText(req, res, found.status, found.text); return; }
        try {
            const listing = await this.listDirAsync(found.real, found.realCwd);
            this.sendJson(req, res, 200, listing);
        } catch {
            // 路径真在、但读不动（拿文件当目录列 / 没权限 / 中途没了）：都按「没这个目录」回
            this.sendText(req, res, 404, "没有这个目录。");
        }
    }

    /**
     * 会话目录跟最后一次提交差了什么（`/changes?session=…`）：文件侧边栏那一格「改动」的清单。
     *
     * 回一份 JSON：`{ vcs: true, changes: [{ path, added, removed, deleted, tooBig }] }`。
     * `path` 是相对会话目录的写法（页面拿它当这一行的键，也原样贴回下面那条地址）；
     * 只算真出了差别的（改了又改回去的不列），按路径排。
     *
     * 数从会话目录所在的 git 仓库现拿（见 gitChanges.ts）：「最近一次提交 → 现在磁盘上的样子」，
     * bash 里跑的脚本、命令改的文件也在里面。会话目录不在 git 仓库里时回 `{ vcs: false }`，
     * 页面把那一格整格收起来。
     */
    private async sendChanges(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): Promise<void> {
        if (!sessionId) { this.sendText(req, res, 400, "请求里要说明是哪个会话。"); return; }
        if (!this.host.resolveSessionDir(sessionId)) {
            this.sendText(req, res, 404, "这个会话不在了（页面可能开得太久），刷新页面再试。");
            return;
        }
        const got = await this.host.sessionChanges(sessionId);
        this.sendJson(req, res, 200, got);
    }

    /**
     * 一个文件的合计 diff（`/changes/diff?session=…&path=…`），纯文本。
     *
     * 这里不走 resolveSessionPath 那道目录边界：路径不拿去拼文件系统，只交给 git 算
     * （见 gitChanges.ts 的 changeDiff：越界的写法、不归这个会话目录管的路径都不给），
     * 算不出差别就给 404（已经改回去了、太大了、不在仓库里）。
     */
    /**
     * 一个文件的合计 diff（`/changes/diff?session=…&path=…`）：拆好的一行行，给页面摆两栏。
     *
     * 这里不走 resolveSessionPath 那道目录边界：路径不拿去拼文件系统，只交给 git 算
     * （见 gitChanges.ts 的 changeDiff：越界的写法、不归这个会话目录管的路径都不给），
     * 算不出差别就给 404（已经改回去了、太大了、不在仓库里）。
     *
     * 回 `{ lines: [{ kind, before, after, text, hl }] }`（见 wordDiff.ts 的 DiffRowLine）：
     * 两边各自的真实行号、去掉前缀的原文、变了的字在原文里的区间。
     */
    private async sendChangeDiff(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string,
        wantPath: string): Promise<void> {
        if (!sessionId || !wantPath) {
            this.sendText(req, res, 400, "请求里要说明是哪个会话、哪个文件。");
            return;
        }
        const diff = await this.host.sessionChangeDiff(sessionId, wantPath);
        if (diff === undefined) {
            this.sendText(req, res, 404, "这个文件不在这次的改动里（可能已经改回去了）。");
            return;
        }
        this.sendJson(req, res, 200, { lines: diffRows(diff) });
    }

    /**
     * 一段 diff 里「到底是哪几个字变了」（`POST /diff/highlight`，内容是 `{ diff }`）。
     *
     * 页面照旧自己排行、自己上色，只拿它把变了的几个字再涂深一点（见 wordDiff.ts）。
     * 没什么可涂的就回 `{ lines: null }`：页面照旧整行上色，这不是错。
     */
    private async sendDiffHighlight(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const text = await readBody(req, MAX_REQUEST_BYTES);
        if (text === undefined) { this.sendText(req, res, 413, "请求内容过大。"); return; }
        let body: any;
        try {
            body = JSON.parse(text);
        } catch {
            this.sendText(req, res, 400, "请求内容不是合法的 JSON。");
            return;
        }
        const diff = typeof body?.diff === "string" ? body.diff : "";
        const lines: LineRanges[] | undefined = changedCharRanges(diff);
        this.sendJson(req, res, 200, { lines: lines ?? null });
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
     * 请求头说能收压缩、内容又够大时就压了再发：浏览器页面的 HTML 里内联着 154 KB 样式、
     * 界面脚本 318 KB，压完只剩三成左右（手机网速下这是好几百毫秒的差别）。
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
        const encoding = pickBodyEncoding(req.headers["accept-encoding"]);
        const packed = this.compressFor(encoding, body, cacheKey);
        const out: Record<string, string | number> = { ...headers };
        if (body.length >= COMPRESS_MIN_BYTES) { out["Vary"] = "Accept-Encoding"; }
        if (packed && encoding) {
            out["Content-Encoding"] = encoding;
            out["Content-Length"] = packed.length;
        } else {
            out["Content-Length"] = body.length;
        }
        res.writeHead(status, out);
        res.end(packed ?? body);
    }

    /** 该不该压、压出来的字节；不值得压（对方不收 / 内容太小 / 压不了）时给 undefined。 */
    private compressFor(encoding: "br" | "gzip" | undefined, body: Buffer, cacheKey?: string): Buffer | undefined {
        if (!encoding || body.length < COMPRESS_MIN_BYTES) { return undefined; }
        const key = cacheKey ? `${encoding}@${cacheKey}` : "";
        if (key) {
            const hit = this.compressCache.get(key);
            if (hit) { return hit; }
        }
        let out: Buffer;
        try {
            out = encoding === "br"
                ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
                : zlib.gzipSync(body);
        } catch {
            return undefined;   // 压不了就发原文，别把响应弄坏
        }
        if (key) {
            // 只留最近这些份：界面文件就那几个，够用了
            if (this.compressCache.size >= COMPRESS_CACHE_MAX) { this.compressCache.clear(); }
            this.compressCache.set(key, out);
        }
        return out;
    }

    // ========================================================================
    //  推送连接（插件 → 页面）
    // ========================================================================

    /**
     * 截一张桌面：`GET /shot?pageId=…`，正文就是那张 JPEG 原样（浏览器页面点一下「截图」）。
     *
     * 为什么不像面板那样包成一条 base64 消息：一张长边 1024 的图约 120 KB，转成 base64 是
     * 160 KB，手机上要拼这么长的字符串、再解回字节、再从 `data:` 地址解码一次 —— 那道
     * base64 全是白做的。直接给字节，浏览器自己解，还不用排在聊天那条推送流后面。
     *
     * 失败时正文就是一句原因（页面拿它弹提示），状态码 4xx/5xx 跟内容对得上。
     */
    private async sendDesktopShot(req: http.IncomingMessage, res: http.ServerResponse, pageId: string): Promise<void> {
        // 只认本服务发出过的页面标识：别的网站里放一张 <img> 猜不到这个串
        if (!this.host.getBroadcaster().isKnown(pageId)) {
            this.sendText(req, res, 409, "此页面不是当前这个网页服务发出的（服务可能重启过）。刷新页面就好。");
            return;
        }
        const result = await captureDesktopScreenshot();
        if (!result.ok) {
            this.sendText(req, res, 503, result.error ?? "桌面截图失败。");
            return;
        }
        const jpeg = Buffer.from(result.data, "base64");
        res.writeHead(200, {
            "Content-Type": result.mimeType || "image/jpeg",
            "Content-Length": jpeg.length,
            "Cache-Control": "no-store",
        });
        res.end(jpeg);
    }

    /**
     * 一条桌面实时画面的直连：`GET /live?pageId=…`（浏览器页面按住「截图」按钮那一下）。
     *
     * 页面那边就是一张 `<img>`：这份响应按 multipart/x-mixed-replace 一帧一段往后写，
     * 浏览器拿到一帧就换一张图。不用转 base64、不用套 JSON、不用 gzip —— 那些都是为了
     * 把帧塞进聊天消息那条推送流才要的（插件里那块面板只能用那条，它连不出去，
     * 见 chatHost.startDesktopLive）。
     *
     * 页面关掉那一层 = 浏览器把这边的地址摘掉、这条请求跟着断，这儿就不看了；
     * 拍画面的小程序什么时候起停由 DesktopLive 管（还有人看就接着拍）。
     */
    private openDesktopLive(req: http.IncomingMessage, res: http.ServerResponse, pageId: string): void {
        // 只认本服务发出过的页面标识：别的网站里放一张 <img> 猜不到这个串，也就拉不起这一路
        if (!this.host.getBroadcaster().isKnown(pageId)) {
            this.sendText(req, res, 409, "此页面不是当前这个网页服务发出的（服务可能重启过）。刷新页面就好。");
            return;
        }
        const boundary = "pichatframe";
        res.writeHead(200, {
            "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
            "Cache-Control": "no-store, no-transform",
            "Connection": "keep-alive",
            // 前面要是挂了反代：别把这一段攒成一整块再往外给，攒了就不是“实时”了
            "X-Accel-Buffering": "no",
        });
        res.socket?.setNoDelay(true);
        const stop = this.host.watchDesktopLive(pageId, (jpeg) => {
            // 这块屏读得慢（网卡、退到后台）：这一帧不写了。画面本来就有下一帧，
            // 塞进去只会让它越落越远（跟推送流那边丢帧是同一条规矩，见 STREAM_STALE_BYTES）
            if (res.writableLength > STREAM_STALE_BYTES) { return; }
            res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
            res.write(jpeg);
            res.write("\r\n");
        });
        // 页面走了 / 关掉那一层 / 服务停了：不看了（还有别人看就接着拍，DesktopLive 自己算）
        const done = () => { stop(); };
        req.on("close", done);
        res.on("close", done);
        res.on("error", done);
    }

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
        // 先定下这条连接压不压、把头写完：之后往这条连接写的每一段都得跟这个头对得上
        const stream = this.openStream(res, req.headers["accept-encoding"]);
        const { channel, replaced, openSeq } = broadcaster.addChannel(
            id,
            (msg) => {
                // 过时了就没用的那类（实时画面的帧）在页面读得慢时可以整条丢掉，别的照旧
                const droppable = typeof msg.type === "string" && PAGE_DROPPABLE_MESSAGE_TYPES.has(msg.type);
                this.writeChunk(channel, stream, `event: msg\ndata: ${JSON.stringify(msg)}\n\n`, droppable);
            },
            (note) => { stream.end(note); },
        );
        this.streams.set(id, stream);
        // retry 是给浏览器看的：万一由浏览器自己重连，隔 1 秒就来一次（页面那头也会自己管重连）
        this.writeChunk(channel, stream, "retry: 1000\n\n");
        this.writeChunk(channel, stream, ": connected\n\n");
        // 握手把三个时间一起报给页面：网页那一份是纯 JS（browserBridge.js），读不了
        // chatProtocol.ts，报给它在那边就不留规则 —— 免得两边各写死一套、改一边就白重连。
        this.writeChunk(channel, stream, `event: msg\ndata: ${JSON.stringify({
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
     *
     * @param droppable 这条消息"过时了就没用"（实时画面的帧）：这段连接已经排着不少字节时
     *                  干脆不发，不占它的队伍。别的消息不发就真少了一块内容，不能这么干。
     */
    private writeChunk(channel: PageChannel, stream: PageStream, chunk: string, droppable = false): void {
        // 「过时了就没用」的那类：这条连接已经排着不少字节了，这一条干脆不发
        if (droppable && stream.backlog > STREAM_STALE_BYTES) { return; }
        const verdict = stream.write(chunk);
        if (verdict === "ok") { return; }
        if (verdict === "backlogged") {
            this.hooks.log(`页面 ${channel.id} 有一阵子没在读推送流（积压 ${Math.round(stream.backlog / 1024)} KB），` +
                "掐掉这条连接。页面回到前台会自己重连，重连后整屏重画一遍。");
            channel.close("");
        }
        this.dropChannel(channel);
    }

    /**
     * 开一条推送连接：头先写好（收不收压缩在这里定），再把这个连接对象交出去。
     *
     * 压缩是按请求方的 Accept-Encoding 定的，所以响应头得先说清楚（压了就是 Content-Encoding:
     * gzip，没压就什么都不带）；定了之后这条连接上写的每一段都得照这个来。
     *
     * 这一条只认 gzip：brotli 的思路是“一次把所有东西压到最小”，边写边刷不是它的强项。
     */
    private openStream(res: http.ServerResponse, accept: string | string[] | undefined): PageStream {
        const pack = (acceptedEncodings(accept).get("gzip") ?? 0) > 0;
        const stream = new PageStream(res, pack, this.backlogBytes);
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            ...(pack ? { "Content-Encoding": "gzip", "Vary": "Accept-Encoding" } : {}),
        });
        return stream;
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
            const stream = this.streams.get(channel.id);
            if (!stream) { return; }
            this.writeChunk(channel, stream, `event: tick\ndata: ${JSON.stringify({ t: now })}\n\n`);
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
        // 手机那条连接只往它写心跳：写不动就说明那头没了（手机睡了 / 网断了），
        // 丢掉等它回来（app 自己会重连），漏掉的通知就漏掉了。
        this.dropDeadPhones((res) => this.writePhone(res, "tick", { t: now }));
    }

    // ========================================================================
    //  手机 app 的连接（前台服务 → /phone）
    // ========================================================================

    /**
     * 一台手机连上来：`GET /phone?client=…`。
     *
     * 除了「有事」就往这儿写一行，连上时还先给一份现在是什么样（开着哪些会话、每个会话留着的那几条）：
     * 手机那边要把它当成一串话看，不能像以前那样“没赶上就算了”。之后有新的一条推一条。
     *
     * 不参与“人正坐在输入框前”那类判断、也不进页面登记簿：它不是一块屏。
     *
     * 谁都能连：跟 `/notify` 一个规矩（机器对机器、不带 Origin，只在信得过的网络里用）。
     */
    private openPhone(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): void {
        if (req.method !== "GET") { this.sendText(req, res, 405, "只接受 GET。"); return; }
        const id = clientId || `ph-${crypto.randomUUID()}`;
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.write("retry: 2000\n\n");
        this.writePhone(res, "hello", { app: "pichat", now: Date.now() });
        res.socket?.setNoDelay(true);
        // 同一台手机又连了一次（断线重连、app 重开）：旧的那条安静收掉
        const old = this.phoneStreams.get(id);
        this.phoneStreams.set(id, res);
        if (old && old !== res) { try { old.destroy(); } catch { /* 已经断了 */ } }
        // 先给现状：开着哪些会话、每个会话留着的那几条
        const sessions = this.phoneSessionsPayload();
        this.writePhone(res, "snapshot", {
            sessions: sessions.map((item) => ({ ...item, notes: this.phoneInbox.list(item.id) })),
            now: Date.now(),
        });
        const onClose = () => {
            if (this.phoneStreams.get(id) !== res) { return; }
            this.phoneStreams.delete(id);
        };
        res.on("close", onClose);
        res.on("error", onClose);
        this.hooks.log(`手机连上了（${id}）：现在连着 ${this.phoneStreams.size} 台。`);
    }

    /**
     * 列表要显示的那些会话：现在开着的那些，外加「这台已经没有、只剩推过来的通知」的那几个
     * （别的机器推来的，见 chatHost 的 trayNote）。每一项带上最后一条，列表上那一行靠它。
     */
    private phoneSessionsPayload(): Array<PhoneSessionInfo & { last?: PhoneNoteRecord }> {
        const items: Array<PhoneSessionInfo & { last?: PhoneNoteRecord }> = this.host.phoneSessions().map((item) => {
            const last = this.phoneInbox.last(item.id) ?? item.last;
            return last ? { ...item, last } : { ...item };
        });
        const known = new Set(items.map((item) => item.id));
        // 只剩通知的那几个：别的机器推来的会话（本机关掉过、重启过的会话就直接丢掉，不往回列）
        for (const sessionId of this.phoneInbox.sessionIds()) {
            if (known.has(sessionId) || !sessionId.startsWith("remote:")) { continue; }
            const last = this.phoneInbox.last(sessionId);
            if (!last) { continue; }
            // 那台的名字就写在 last.from 里（旧记录没带就从标识里取：`remote:哪台:会话`）
            const machine = last.from || sessionId.split(":")[1] || "另一台";
            items.push({ id: sessionId, name: last.name, machine, running: false, remote: true, last });
            known.add(sessionId);
        }
        // 不在了的那些会话，留着的那几条也没人看得见了
        this.phoneInbox.prune(known);
        return items;
    }

    /** 会话列表变了（新建 / 关掉 / 开始跑 / 跑完了）：推一份新的给连着的手机。 */
    public notifyPhoneSessions(): void {
        if (this.phoneStreams.size === 0) { return; }
        const payload = { sessions: this.phoneSessionsPayload() };
        this.dropDeadPhones((res) => this.writePhone(res, "sessions", payload));
    }

    /**
     * 一张卡片收尾了（不论是在网页上答的、在手机上答的，还是到点没人答）：
     * 告诉连着的那几台，让它们把那几个选项置灰（不然另一台还可以点，点了才被告知“已经答过了”）。
     */
    public notifyPhoneAskDone(cardId: string): void {
        this.phoneInbox.markAskDone(cardId);
        if (this.phoneStreams.size === 0) { return; }
        this.dropDeadPhones((res) => this.writePhone(res, "askdone", { cardId }));
    }

    /** 某个会话留着的那几条（`GET /phone/session?id=…`）：进去时拉一次，之后靠长连接推。 */
    private async sendPhoneSession(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): Promise<void> {
        const session = this.phoneSessionsPayload().find((item) => item.id === sessionId);
        if (!session) {
            this.sendJson(req, res, 404, { ok: false, reason: "这个会话不在了（关掉过、或者后端重启过）" });
            return;
        }
        // 最近一条回复的原话：点开会话时先看一眼它说到哪儿了（跑着的时候这个会跟着变）
        let lastReply = "";
        try { lastReply = session.remote ? (session.last?.text ?? "") : await this.host.phoneLastReply(sessionId); } catch { /* 取不到就算了 */ }
        // 把它也解析成「怎么画」：这一轮的原话在两端都按 markdown 画，跟「有事」里的那些一个待遇
        const replyDoc = parseMarkdown(lastReply);
        this.sendJson(req, res, 200, {
            session,
            notes: this.phoneInbox.list(sessionId),
            lastReply: { text: lastReply, blocks: replyDoc.blocks },
        });
    }

    /** 手机那头说了一句话（`POST /phone/send`）：送进那个会话。 */
    private async handlePhoneSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const body = await this.readPhoneBody(req, res);
        if (!body) { return; }
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        const text = typeof body.text === "string" ? body.text : "";
        if (!sessionId || !text.trim()) {
            this.sendJson(req, res, 400, { ok: false, reason: "要 sessionId 与 text" });
            return;
        }
        this.sendJson(req, res, 200, await this.host.phoneSend(sessionId, text));
    }

    /** 手机那头答了一道题（`POST /phone/answer`）：把还挂着的那张卡片按这个答案收掉。 */
    private async handlePhoneAnswer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const body = await this.readPhoneBody(req, res);
        if (!body) { return; }
        const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
        const picks = Array.isArray(body.picks) ? body.picks.filter((x): x is string => typeof x === "string") : [];
        const text = typeof body.text === "string" ? body.text : "";
        if (!cardId) {
            this.sendJson(req, res, 400, { ok: false, reason: "要 cardId" });
            return;
        }
        this.sendJson(req, res, 200, this.host.phoneAnswer(cardId, picks, text));
    }

    /** 读一个 POST 请求的 JSON 体（读不出来就自己回一个 400，返 undefined 让调用方收工）。 */
    private async readPhoneBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | undefined> {
        if (req.method !== "POST") {
            this.sendText(req, res, 405, "只接受 POST。");
            return undefined;
        }
        const text = await readBody(req, MAX_REQUEST_BYTES);
        if (text === undefined) {
            this.sendText(req, res, 413, "请求内容过大。");
            return undefined;
        }
        try {
            const raw: unknown = JSON.parse(text);
            if (raw && typeof raw === "object") { return raw as Record<string, unknown>; }
        } catch { /* 落到下面那个 400 */ }
        this.sendText(req, res, 400, "请求内容不是合法的 JSON。");
        return undefined;
    }

    /** 往一台手机写一段；写不动了返回 false。 */
    private writePhone(res: http.ServerResponse, event: string, data: unknown): boolean {
        if (res.writableEnded || res.destroyed) { return false; }
        try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            return true;
        } catch {
            return false;
        }
    }

    /** 挨个往连着的手机写一段，写不动的（已经走的）当场丢掉。 */
    private dropDeadPhones(write: (res: http.ServerResponse) => boolean): void {
        for (const [id, res] of Array.from(this.phoneStreams)) {
            if (write(res)) { continue; }
            this.phoneStreams.delete(id);
            try { res.destroy(); } catch { /* 已经断了 */ }
        }
    }

    /**
     * 会话有事了：记一条下来，再往每台连着的手机推一条（手机上弹一条通知 + 放进那个会话）。
     * 一台都没连着也照记：下一台连上来时那份现状里就有它（这是以前“漏掉的不补发”的另一种做法）。
     */
    public notifyPhones(note: PhoneNote): void {
        // 解析一次就够：正文怎么画、列表上那一行写什么，都在这儿定下来（见 src/markdownBlocks.ts）
        const doc = parseMarkdown(note.summary);
        const record = this.phoneInbox.add({
            sessionId: note.sessionId,
            name: note.name,
            kind: note.kind,
            text: note.summary,
            blocks: doc.blocks,
            plain: doc.plain,
            at: note.at,
            ...(note.from ? { from: note.from } : {}),
            ...(note.ask ? { ask: note.ask } : {}),
        });
        if (this.phoneStreams.size === 0) { return; }
        const sessions = { sessions: this.phoneSessionsPayload() };
        this.dropDeadPhones((res) => {
            if (!this.writePhone(res, "note", record)) { return false; }
            // 列表上那一行（最后一句、时间）也跟着变
            return this.writePhone(res, "sessions", sessions);
        });
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
            this.sendText(req, res, 400, "这条通知缺东西（要 sessionId）。");
            return;
        }
        // 这条是谁发来的：那台自己报的地址不一定是我们到得了的（多网卡时它可能挑了别的网段），
        // 回话时连不上就拿这个地址换个端口再试（见 chatHost 的 phoneSend）
        this.host.acceptRemoteNotice(notice, (req.socket.remoteAddress ?? "").replace(/^::ffff:/, ""));
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
    }

    /**
     * 别的后端说「把你开着的页面切到这个会话」。
     *
     * 这条是机器对机器发的（那台有人点了弹窗）：没有 Origin 头，也没有口令 ——
     * 跟 `/notify` 一个道理（见上面那条的注释）。
     */
    private async handleSwitchRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
        const sessionId = raw && typeof raw === "object"
            && typeof (raw as Record<string, unknown>).sessionId === "string"
            ? ((raw as Record<string, unknown>).sessionId as string).trim() : "";
        if (!sessionId) {
            this.sendText(req, res, 400, "这条请求缺东西（要 sessionId）。");
            return;
        }
        this.host.acceptSwitchRequest(sessionId);
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
    }

    /**
     * 别的机器把一句话转了过来：交给宿主接进那个会话。
     * 成不成都要回一句（那边要把"没送到"的原因说给人听）。
     */
    /** 别台请这台配对（`POST /pair/request`）：记下来等人去设置面板点头；拒过的直接回 403。 */
    private async handlePairRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
        const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const address = typeof body.address === "string" ? body.address.trim() : "";
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
        if (!address) {
            this.sendJson(req, res, 400, { ok: false, reason: "要 address（你这台的地址）" });
            return;
        }
        const result = this.host.receivePairRequest(address, name);
        if (!result.ok) {
            this.sendJson(req, res, 403, { ok: false, reason: result.reason ?? "不接受。" });
            return;
        }
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
    }

    /** 那台回了这台那下配对请求（`POST /pair/reply`）：接受 / 不接受 / 解除都走这条。 */
    private async handlePairReply(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
        const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const address = typeof body.address === "string" ? body.address.trim() : "";
        if (!address) {
            this.sendJson(req, res, 400, { ok: false, reason: "要 address（你这台的地址）" });
            return;
        }
        this.host.receivePairReply(address, body.accepted === true);
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
    }

    private async handleSessionReply(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
        const reply = readSessionReply(raw);
        if (!reply) {
            this.sendText(req, res, 400, "这句话缺东西（要 sessionId 和 text）。");
            return;
        }
        const result = this.host.acceptSessionReply(reply.sessionId, reply.text, {
            sessionFile: reply.sessionFile,
            name: reply.name,
        });
        if (!result.ok) {
            this.sendText(req, res, 409, result.reason ?? "接不上。");
            return;
        }
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

/** 这段字节里有多少个 `\r\n`（判原文件是不是 CRLF 行尾用，见 writeFile）。 */
function countCrlf(bytes: Buffer): number {
    let n = 0;
    for (let i = 1; i < bytes.length; i += 1) {
        if (bytes[i] === 0x0a && bytes[i - 1] === 0x0d) { n += 1; }
    }
    return n;
}

/** 这段字节里有多少个没有 `\r` 打头的 `\n`（跟 countCrlf 合起来看是哪种行尾）。 */
function countLoneLf(bytes: Buffer): number {
    let n = 0;
    for (let i = 0; i < bytes.length; i += 1) {
        if (bytes[i] !== 0x0a) { continue; }
        if (i > 0 && bytes[i - 1] === 0x0d) { continue; }
        n += 1;
    }
    return n;
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

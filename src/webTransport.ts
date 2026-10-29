import * as os from "os";
import { CHAT_UI_FILE_NAMES } from "./chatUiFiles";

/**
 * webTransport —— 网页服务的传输层零件（不引用 vscode）。
 *
 * 放在这里的都是"判断能不能放行"这类无副作用的东西：
 * 静态资源的类型与白名单、请求来源是否是本机、页面连接的登记簿、页面没连上时的消息缓冲。
 * 网页服务本身（http 服务、推送流、路由）在 webChatServer.ts。
 */

/** 浏览器页面允许加载的 media/ 文件名白名单（其余一律 404，防目录穿越）。
 *  名单就是界面清单（chatUiFiles.ts）里的那些文件：加一个界面文件只改那份清单。
 *  注：browserTheme.css 在网页端页面里是直接写进 HTML 的（不走静态文件这条路），
 *  但插件里的对话面板要从这儿取它，所以也在名单里。 */
export const ALLOWED_MEDIA_FILES: ReadonlySet<string> = new Set(CHAT_UI_FILE_NAMES);

/** 扩展名 → Content-Type（只列白名单里会出现的几种）。 */
const MEDIA_CONTENT_TYPES: Record<string, string> = {
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".woff2": "font/woff2",
};

/** 取静态资源的 Content-Type；未知扩展名按纯文本。 */
export function contentTypeOf(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
    return MEDIA_CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8";
}

/** 文件名是否在白名单里，且不含任何路径成分。 */
export function isAllowedMediaFile(name: string): boolean {
    if (name.includes("/") || name.includes("\\") || name.includes("\0")) { return false; }
    if (name === "." || name === ".." || name.startsWith(".")) { return false; }
    return ALLOWED_MEDIA_FILES.has(name);
}

/** 回环地址写法（浏览器可能用其中任意一个访问本机）。 */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/** 一个地址字符串是否表示"本机"。 */
export function isLoopbackName(name: string): boolean {
    return LOOPBACK_NAMES.has(name.toLowerCase());
}

/**
 * 拆开 Host 头：主机名（一律小写；IPv6 写作 `[::1]`）与端口（没写就是 undefined）。
 * 看不懂的头（空、括号不成对、端口不是数）返回 undefined。
 */
export function splitHostHeader(hostHeader: string | undefined): { name: string; port?: number } | undefined {
    if (!hostHeader) { return undefined; }
    const text = hostHeader.trim();
    if (text === "") { return undefined; }
    // IPv6 写法带方括号：[::1]:51833
    if (text.startsWith("[")) {
        const close = text.indexOf("]");
        if (close < 0) { return undefined; }
        const rest = text.slice(close + 1);
        if (rest === "") { return { name: text.slice(0, close + 1).toLowerCase() }; }
        const port = parsePort(rest);
        return port === -1 ? undefined : { name: text.slice(0, close + 1).toLowerCase(), port };
    }
    const sep = text.indexOf(":");
    const name = (sep < 0 ? text : text.slice(0, sep)).toLowerCase();
    if (name === "") { return undefined; }
    if (sep < 0) { return { name }; }
    const port = parsePort(text.slice(sep + 1));
    return port === -1 ? undefined : { name, port };
}

/**
 * Host 头是否指向本机且端口正确。
 *
 * 服务只监听本机时用它挡掉"域名重绑定"：别的网站让浏览器把请求发到
 * evil.example.com（解析到 127.0.0.1），Host 头就对不上，直接拒绝。
 * @param hostHeader 请求的 Host 头（可能缺省）
 * @param port 服务实际监听的端口
 */
export function isLoopbackHostHeader(hostHeader: string | undefined, port: number): boolean {
    const split = splitHostHeader(hostHeader);
    if (!split) { return false; }
    if (split.port !== undefined && split.port !== port) { return false; }
    return isLoopbackName(split.name);
}

/**
 * 人指定的那几个来源里的主机名（对照 Host 头用）。
 *
 * 服务前面挂了一层反代时，反代转给本服务的请求可能带的是原来那个 https 地址的 Host
 * （tailscale serve 就是这样），本机那几个写法都对不上；那些域名得由人写下来才认。
 */
export function originHostnames(origins: readonly string[]): string[] {
    const names: string[] = [];
    for (const item of origins) {
        const origin = normalizeOrigin(item);
        if (!origin) { continue; }
        const host = new URL(origin).hostname.toLowerCase();
        if (host !== "" && !names.includes(host)) { names.push(host); }
    }
    return names;
}

/** 解析 ":51833" 或 "51833"；不是数字返回 -1。 */
function parsePort(text: string): number {
    const value = Number(text.startsWith(":") ? text.slice(1) : text);
    return Number.isInteger(value) && value > 0 ? value : -1;
}

/**
 * 这台机器上浏览器可能用到的地址写法。
 *
 * 用来对照请求里的 Origin：手机或电脑上打开本服务页面后，页面里发出的请求
 * 带的 Origin 就是这些地址之一；别的网站里偷偷发来的请求，Origin 是它自己的域名。
 * @param boundHost 服务实际监听的地址（"0.0.0.0" 这种通配写法表示所有网卡）
 */
export function localHostnames(boundHost: string): string[] {
    const names: string[] = ["localhost", "127.0.0.1", "::1", "[::1]"];
    if (boundHost && !isWildcardHost(boundHost)) {
        names.push(boundHost);
    }
    for (const list of Object.values(os.networkInterfaces())) {
        for (const item of list ?? []) {
            names.push(item.address);
            if (!item.internal) { names.push(`[${item.address}]`); }
        }
    }
    return names;
}

/** 监听地址是否为“所有网卡”的通配写法。 */
export function isWildcardHost(host: string): boolean {
    return host === "0.0.0.0" || host === "::" || host === "";
}

/**
 * 一个地址规范化成“来源”的写法（协议 + 主机 + 端口，比如 `https://metalbone.tail766f2b.ts.net`）。
 *
 * 设置文件里是人手写的，写法五花八门：末尾带斜杠、带路径、大小写不一。统一成浏览器在
 * Origin 头里发的那种写法，好直接比对。不是 http / https 的地址返回 undefined。
 */
export function normalizeOrigin(text: string): string | undefined {
    let url: URL;
    try {
        url = new URL(String(text).trim());
    } catch {
        return undefined;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") { return undefined; }
    return url.origin;
}

/**
 * Origin 头里的地址是否就是服务自己。
 *
 * 浏览器发请求时会带上发请求那个页面的地址。别的网站里的脚本想用 JS 偷偷发请求
 * 给本服务（哪怕本服务只听本机地址），它带的 Origin 是自己网站的域名，
 * 不在下面这两份名单里，直接拒绝。不带 Origin 的请求（本服务自己的页面之外的命令行工具、
 * curl 等）放行，那些请求没有浏览器参与，也不存在被别人偿偿发来的问题。
 * @param originHeader 请求的 Origin 头（可能缺省）
 * @param port 服务实际监听的端口
 * @param ownHostnames 这台机器上合法的地址写法（由 localHostnames 算）
 * @param trustedOrigins 人另外指定的来源（设置文件里的 webServer.trustedOrigins）。
 *        服务前面挂了一层反向代理（比如 Tailscale 的 https）时，页面是从那个地址打开的，
 *        Origin 也就是它；那些地址看不出来是本机，只能由人明确写下来才认。
 */
export function isSameOrigin(originHeader: string | undefined, port: number, ownHostnames: readonly string[], trustedOrigins: readonly string[] = []): boolean {
    if (!originHeader) { return true; }
    let url: URL;
    try {
        url = new URL(originHeader);
    } catch {
        return false;
    }
    // 人另外指定的来源先放行：它一般不是本机地址，也不是本服务的端口
    if (trustedOrigins.some((item) => normalizeOrigin(item) === url.origin)) { return true; }
    const originPort = url.port !== "" ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
    if (originPort !== port) { return false; }
    // 本服务自己不认 https：走反代的 https 地址得先在 trustedOrigins 里写上
    if (url.protocol !== "http:") { return false; }
    return ownHostnames.some((name) => name.toLowerCase() === url.hostname.toLowerCase());
}

/**
 * 一个连着推送流的页面。
 *
 * 每个页面各占一条推送连接（浏览器打开页面就开一条，手机上退到后台再回来会重开一条）。
 * 插件推的消息发给每一条；确认框、选项浮层只发给"人最近在里面动过"的那一条（见 recent）。
 *
 * 这个登记簿自己不碰网络：往连接里写、把连接关掉，都是网页服务传进来的函数。
 */
export interface PageChannel {
    /** 页面标识：服务送出页面时生成并写在页面里。 */
    readonly id: string;
    /** 往这条连接写一条消息。写不了（页面走远了）由实现方自行注销本条。 */
    send(msg: Record<string, unknown>): void;
    /** 关掉这条连接（页面没了、积压太多、服务停了）。@param note 写给页面的告别话；不写就传空串。 */
    close(note: string): void;
    /** 这个页面最后一次有动静的时刻（毫秒时间戳）。用于掐掉"半天没声音"的死连接。 */
    lastSeenAt: number;
}

/** 登记簿 add 的结果：新登记的连接，以及同标识被顶下来的那条（如果有）。 */
export interface PageChannelAddResult {
    channel: PageChannel;
    /** 同一个页面标识又连了一次（页面重连）：之前那条，调用方自己安静地关掉它。 */
    replaced?: PageChannel;
}

/**
 * 页面连接的登记簿：谁连着、谁的标识是本服务发出的、谁最近有人在动。
 *
 * 这里不做任何网络操作（不碰 http），只管记录。
 *
 * 没有"哪一个页面才算数"这一说：几个页面（手机 + 电脑）可以同时连着，都收得到消息。
 * 以前那套是"同时只认一个页面"，手机上退到后台再回来会被误判成"被别的页面顶掉"。
 */
export class PageChannels {
    /** 最多记住多少个页面标识（防止长时间运行攒太多）。 */
    private static readonly LIMIT_ISSUED = 32;

    private readonly channels = new Map<string, PageChannel>();
    /** 本服务发出过页面、或连过推送流的标识（含已断开的），旧的先挤掉。 */
    private readonly issued: string[] = [];
    /** 最近"人在里面动过"的那个页面标识。 */
    private recentId = "";

    /** 记下"这个标识是本服务发出的"：页面刚取走、推送流还没连上时，它的消息也要收下。 */
    public markIssued(id: string): void {
        if (!id) { return; }
        const at = this.issued.indexOf(id);
        if (at >= 0) { this.issued.splice(at, 1); }
        this.issued.push(id);
        if (this.issued.length > PageChannels.LIMIT_ISSUED) { this.issued.splice(0, this.issued.length - PageChannels.LIMIT_ISSUED); }
    }

    public get(id: string): PageChannel | undefined {
        return this.channels.get(id);
    }

    public has(id: string): boolean {
        return this.channels.has(id);
    }

    /**
     * 这个页面标识能不能收发消息：连着推送流，或者是本服务发出过的（页面刚取走还没连上、
     * 以及连着的时候断了正在重连，都算）。从没见过的标识（例如服务重启前的旧页面）不算。
     */
    public isKnown(id: string): boolean {
        return id !== "" && (this.channels.has(id) || this.issued.includes(id));
    }

    /**
     * 登记一条推送连接。同一个标识连了第二次（页面重连）时，把前一条顶下来交给调用方，
     * 由它安静地关掉——那只是同一个页面自己重连，不能当成"被别的页面顶掉"告诉用户。
     */
    public add(
        id: string,
        send: (msg: Record<string, unknown>) => void,
        close: (note: string) => void,
    ): PageChannelAddResult {
        const replaced = this.channels.get(id);
        const channel: PageChannel = { id, send, close, lastSeenAt: Date.now() };
        this.channels.set(id, channel);
        this.markIssued(id);
        this.recentId = id;
        return { channel, replaced };
    }

    /** 注销一条连接（页面关了 / 连接断了 / 被超时掐掉）。标识仍然算"发出过"。 */
    public remove(id: string): void {
        this.channels.delete(id);
        if (this.recentId === id) {
            // 最近动过的那个页面走了：把"最近"交给还连着的最后一条（没有就是空）
            this.recentId = this.lastConnectedId();
        }
    }

    /** 注销全部（停服务时用）。返回被注销的那些，调用方去关连接。 */
    public removeAll(): PageChannel[] {
        const all = Array.from(this.channels.values());
        this.channels.clear();
        this.recentId = "";
        return all;
    }

    /** 最后登记的那条连接（一个都没有时是 undefined）。 */
    private lastConnected(): PageChannel | undefined {
        const all = Array.from(this.channels.values());
        return all.length > 0 ? all[all.length - 1] : undefined;
    }

    private lastConnectedId(): string {
        return this.lastConnected()?.id ?? "";
    }

    /** 当前连着的页面数。 */
    public get size(): number {
        return this.channels.size;
    }

    /** 遍历当前连着的每一个页面（先快照一份再走，避免回调里增删把迭代搞乱）。 */
    public forEach(fn: (channel: PageChannel) => void): void {
        for (const channel of Array.from(this.channels.values())) {
            fn(channel);
        }
    }

    /**
     * 记一笔"这个页面有动静"。
     * @param userAction 是不是人做出来的动作（发消息、点按钮）。
     *   报活（keepalive）只算"还活着"，不算动作：不然一个退到后台还在报活的页面
     *   会一直抢着当"最近在动的那个"，确认框就弹到没人看的页面上去了。
     */
    public touch(id: string, userAction: boolean): void {
        const channel = this.channels.get(id);
        if (channel) { channel.lastSeenAt = Date.now(); }
        if (userAction) { this.recentId = id; }
    }

    /** 只更新"还活着"的时刻（页面报活）。 */
    public beat(id: string): void {
        this.touch(id, false);
    }

    /** 最近有人在动过的那个页面（确认框、选项浮层发给它）；一个都没连着时 undefined。 */
    public recent(): PageChannel | undefined {
        return this.channels.get(this.recentId) ?? this.lastConnected();
    }

    /**
     * 超过 maxAgeMs 没有任何动静的页面标识（连接多半已经死了，浏览器还没告诉我们）。
     * @param maxAgeMs 允许的静默时长
     */
    public staleIds(maxAgeMs: number): string[] {
        const at = Date.now();
        const found: string[] = [];
        for (const channel of this.channels.values()) {
            if (at - channel.lastSeenAt >= maxAgeMs) { found.push(channel.id); }
        }
        return found;
    }
}

/**
 * 推给页面的消息里属于「当时的一次性动作」的那些类型。
 *
 * 页面断线重连后，插件把断线期间漏掉的消息补发给它（见 ChatBroadcaster 的 resume）。
 * 补发只面向「状态与流内容」——错过一条就少一块内容的那类。下面这些不补：
 * 页面断开时插件那头已经把它们按取消处理了（确认框、浮层选择器），
 * 补发只会让回来的页面重复弹一次窗，或者莫名其妙替人做一次动作。
 */
export const PAGE_TRANSIENT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
    "askCard",                   // 问话卡片（问答题 / 扩展问的确认、输入、选一个）
    "askCardDone",               // 卡片收尾（答了 / 到点了）：重画后由插件重发还没收尾的那些
    "picker",                    // 浮层选择器
    "pickerCancel",              // 浮层超时取消
    "openSettings",              // 打开设置面板
    "turnEnd",                   // 某个会话跑完了一轮（名字旁边那颗点变绿）
    "changesChanged",            // 「改动」那一格该重问一遍清单了（纯提醒，重连后会自己去取）
    "bashTask",                  // 某条后台命令有动静（纯提醒，重连后由 /bash 重新取一份清单）
    "envInfo",                   // 「加载了什么」那份清单（纯提醒，弹窗一开就重新要一份）
    "restartStatus",             // 「编译并重启」那颗按钮的回话：走 sendTo 定向发给点它的那块屏，后端马上要退了
    "details",                   // 点开提示框时要回来的那一批内容（思考全文 / 工具输出 / 调用参数）：
                                 // 只有正在点的那块屏用得上，一条就几十 KB，不能占补发暂存的额度
    // 下面两条走 sendTo 定向发给请求它的那个页面，本来就不进补发暂存；列在这里是
    // 防以后改走广播时，把好几百 KB 的截图塞进补发暂存，把真正的历史消息挤掉。
    "desktopScreenshot",         // 桌面截图（网页端“桌面截图”按钮）
    "desktopScreenshotResult",   // 桌面截图的失败提示
]);

/**
 * 一个都没有页面连着时的消息缓冲。
 *
 * 浏览器页面的加载顺序是：先发起推送连接，再由 chat.js 发出 ready。
 * 两者是并行的，ready 可能先到，此时插件回的消息还没有出口，先攒在这里，
 * 页面一连上就按原顺序冲出去。缓冲有上限，满了丢最老的（页面重连后会整屏重画，
 * 丢掉的那部分不会永久丢失）。
 */
export class MessageBuffer {
    /** @param limit 最多攒多少条消息 */
    constructor(private readonly limit = 500) {}

    private items: Array<Record<string, unknown>> = [];

    public push(msg: Record<string, unknown>): void {
        this.items.push(msg);
        if (this.items.length > this.limit) {
            this.items.splice(0, this.items.length - this.limit);
        }
    }

    /** 取走全部缓冲消息（清空）。 */
    public drain(): Array<Record<string, unknown>> {
        const out = this.items;
        this.items = [];
        return out;
    }

    public clear(): void {
        this.items = [];
    }

    public get size(): number {
        return this.items.length;
    }
}

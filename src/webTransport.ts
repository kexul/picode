import * as os from "os";

/**
 * webTransport —— 网页服务的传输层零件（不引用 vscode，便于单测）。
 *
 * 放在这里的都是"判断能不能放行"这类无副作用的东西：
 * 静态资源的类型与白名单、请求来源是否是本机、访问口令比较、页面没连上时的消息缓冲。
 * 网页服务本身（http 服务、推送流、路由）在 webChatServer.ts。
 */

/** 浏览器页面允许加载的 media/ 文件名白名单（其余一律 404，防目录穿越）。
 *  注：browserTheme.css 不在里——它的内容是直接写进页面 HTML 的（导出会话时要靠它），
 *  不走静态文件这条路。 */
export const ALLOWED_MEDIA_FILES: ReadonlySet<string> = new Set([
    "chat.js",
    "chat.css",
    "marked.js",
    "highlight.js",
    "settings.js",
    "browserBridge.js",
]);

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
 * Host 头是否指向本机且端口正确。
 *
 * 服务只监听本机时用它挡掉"域名重绑定"：别的网站让浏览器把请求发到
 * evil.example.com（解析到 127.0.0.1），Host 头就对不上，直接拒绝。
 * @param hostHeader 请求的 Host 头（可能缺省）
 * @param port 服务实际监听的端口
 */
export function isLoopbackHostHeader(hostHeader: string | undefined, port: number): boolean {
    if (!hostHeader) { return false; }
    let name = hostHeader.trim();
    // IPv6 写法带方括号：[::1]:51833
    if (name.startsWith("[")) {
        const close = name.indexOf("]");
        if (close < 0) { return false; }
        const rest = name.slice(close + 1);
        if (rest !== "" && parsePort(rest) !== port) { return false; }
        return isLoopbackName(name.slice(0, close + 1));
    }
    const sep = name.indexOf(":");
    if (sep < 0) { return isLoopbackName(name); }
    if (parsePort(name.slice(sep + 1)) !== port) { return false; }
    return isLoopbackName(name.slice(0, sep));
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
 * Origin 头里的地址是否就是服务自己。
 *
 * 浏览器发请求时会带上发请求那个页面的地址。别的网站里的脚本想用 JS 偷偷发请求
 * 给本服务（哪怕本服务只听本机地址），它带的 Origin 是自己网站的域名，
 * 不在下面这份名单里，直接拒绝。不带 Origin 的请求（本服务自己的页面之外的命令行工具、
 * curl 等）放行，那些请求没有浏览器参与，也不存在被别人偿偿发来的问题。
 * @param originHeader 请求的 Origin 头（可能缺省）
 * @param port 服务实际监听的端口
 * @param ownHostnames 这台机器上合法的地址写法（由 localHostnames 算）
 */
export function isSameOrigin(originHeader: string | undefined, port: number, ownHostnames: readonly string[]): boolean {
    if (!originHeader) { return true; }
    let url: URL;
    try {
        url = new URL(originHeader);
    } catch {
        return false;
    }
    const originPort = url.port !== "" ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
    if (originPort !== port) { return false; }
    // 本服务只有 http：https 那个地址不可能是本服务的页面
    if (url.protocol !== "http:") { return false; }
    return ownHostnames.some((name) => name.toLowerCase() === url.hostname.toLowerCase());
}

/**
 * 页面还没连上（或正在重连）时的消息缓冲。
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

/**
 * remoteNotice —— 别的 pichat 后端“有事”时推到这边的那么一条（跨机器）。
 *
 * 干什么：一台机器上的后端跑完一轮、或者模型在那儿问你一道选择题时，除了本机那颗托盘图标
 * 闪一下，还能把这条“有事”推给另外几台机器（设置文件里 notify.pushTo 写了地址的那些）。
 * 收到的那台把它当成自己的事塞进托盘清单，点那一行就用浏览器打开推送方那个会话
 * （地址里带 ?session=<标识>，见 media/chat.js 里读这个参数的那段）。
 *
 * 为什么不反过来（收到的那台去连推送方）：那样要常年维持连接、断了要重连、还得处理断线
 * 期间漏掉的事件。一次 POST 失败就当没发生，简单得多。
 *
 * 不管口令：这个后端本来就没有登录，只在信得过的网络里用（见 README）。浏览器的网页脚本
 * 塞不进东西来（带 Origin 的请求过不了那道关），机器对机器发的请求没有 Origin，照收。
 */
export interface RemoteNotice {
    /** 哪台机器推来的：它设置里写的 notify.pushLabel；没写就用它地址里的主机名。 */
    label: string;
    /** 推送方那边的会话标识。 */
    sessionId: string;
    /** 那个会话叫什么。 */
    name: string;
    /** 点了之后用浏览器打开哪个地址：推送方的页面 + 那个会话。 */
    page: string;
}

/** 推一次最多等这么久：对方没回应就当这条丢了（不攒着、不重试）。 */
const PUSH_TIMEOUT_MS = 5000;

/**
 * 从推过来的内容里读出一条通知。
 * @param raw 请求体解出来的东西（不知道对方发了什么，一律当未知处理）
 * @param fallbackLabel 对方没写名字时用什么（一般是它请求里的地址）
 * @returns 字段不齐、或者地址不像话（不是 http / https）就给 undefined：这条不认
 */
export function readRemoteNotice(raw: unknown, fallbackLabel: string): RemoteNotice | undefined {
    if (!raw || typeof raw !== "object") { return undefined; }
    const body = raw as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const page = typeof body.page === "string" ? body.page.trim() : "";
    if (!sessionId || !page) { return undefined; }
    // 只认 http / https：不能让推来的东西指到 file:// 这种地方去
    if (!/^https?:\/\//i.test(page)) { return undefined; }
    const label = (typeof body.label === "string" ? body.label.trim() : "") || fallbackLabel || "另一台";
    const name = (typeof body.name === "string" ? body.name.trim() : "") || "会话";
    return { label, sessionId, name, page };
}

/**
 * 把一条“有事”推给一台机器。
 * @param target 它网页服务的地址（比如 `http://10.0.0.2:51883`，后面带不带斜杠都行）
 * @returns 对方收下了没有（收下 = 2xx）；推不过去只返回 false，不抛
 */
export async function pushRemoteNotice(target: string, notice: RemoteNotice): Promise<boolean> {
    const url = target.replace(/\/+$/, "") + "/notify";
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(notice),
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** 把地址规范化成 `http://主机:端口`（跟设置文件那边同一个写法）；不像话就是 undefined。 */
function normalizeOrigin(url: string): string | undefined {
    try {
        const parsed = new URL(url.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { return undefined; }
        return parsed.origin;
    } catch {
        return undefined;
    }
}

/** 一个地址里的主机名（拼“这是哪台机器”用）；地址不像话就给空串。 */
export function hostOfUrl(url: string): string {
    try { return new URL(url).hostname || ""; } catch { return ""; }
}

/**
 * 把一个页面地址拼成“打开就到某个会话”：`<页面地址>?session=<会话标识>`。
 * 页面那边读这个参数（见 media/chat.js），会话壳到了就切过去。
 */
export function withSession(page: string, sessionId: string): string {
    try {
        const url = new URL(page);
        url.searchParams.set("session", sessionId);
        return url.toString();
    } catch {
        return page;
    }
}

/**
 * 这条推送目标是不是就是本机自己（照本机网页服务的地址比）。
 *
 * 为什么要认这个：设置里「消息推送」默认就显示这台机器自己的地址，人把它留着等于
 * “提醒还在这台”；只有填了别处的地址才算把提醒挪走（见 ChatControllerBase.trayNote）。
 * 比的时候主机名与端口都要对得上；本机那几个回环写法（127.0.0.1 / localhost）只要端口一样就认。
 */
export function isOwnPage(target: string, ownUrl: string | undefined): boolean {
    const mine = ownUrl ? normalizeOrigin(ownUrl) : undefined;
    const theirs = normalizeOrigin(target);
    if (!mine || !theirs) { return false; }
    if (mine === theirs) { return true; }
    try {
        const a = new URL(theirs);
        const b = new URL(mine);
        if (a.port !== b.port) { return false; }
        return isLoopbackHost(a.hostname) && isLoopbackHost(b.hostname);
    } catch {
        return false;
    }
}

function isLoopbackHost(name: string): boolean {
    const host = name.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * remoteNotice —— 别的 pichat 后端“有事”时推到这边的那么一条（跨机器）。
 *
 * 干什么：一台机器上的后端跑完一轮、或者模型在那儿问你一道选择题时，除了在本机右下角
 * 弹一张提醒卡片，还能把这条“有事”推给另外几台机器（设置文件里 notify.pushTo 里填的那些，见 chatHost 的 pushRemoteNote）。
 * 收到的那台也弹一张卡片（哪台、哪个会话、说了什么）；点它只是把这张卡片收掉
 * （那是别的机器上的会话，本机只管弹，不去开那台网页）。
 *
 * 那边已经有人说话了（或者会话被关掉、那道题答完了）时，推方再推一条“收掉过来”
 * （close：见 chatHost 的 closeNotice）：收到的那台手上那张记的是推方的钥匙，
 * 本机这些动作碰不到它，不推这一条就只能用手点掉。
 *
 * 为什么不反过来（收到的那台去连推送方）：那样要常年维持连接、断了要重连、还得处理断线
 * 期间漏掉的事件。一次 POST 失败就当没发生，简单得多。
 *
 * 不管口令：这个后端本来就没有登录，只在信得过的网络里用（见 README）。浏览器的网页脚本
 * 塞不进东西来（带 Origin 的请求过不了那道关），机器对机器发的请求没有 Origin，照收。
 */
export interface RemoteNotice {
    /** 哪台机器推来的：它那台的名字（设置里那行「标签」，见 pageHtml 的 displayName）。 */
    label: string;
    /** 推送方那边的会话标识。 */
    sessionId: string;
    /** 那个会话叫什么。 */
    name: string;
    /**
     * 面板上显示的那段话（推送方已经截好长度）。
     * 是 markdown 原文，不压成纯文本：收到的那台解析一遍再画（见 webChatServer.ts 的 notifyPhones），
     * 跟本机自己那条同一个画法。旧版本推来的没这个字段。
     */
    text?: string;
    /** 哪种事：跑完一轮 / 等你答一句。 */
    kind?: "done" | "ask";
    /**
     * 这条是“把那张收掉”（那边已经有人答过了 / 会话关掉了 / 那道题答完了）：
     * 收到的那台只收卡片，不弹新的。不带这个字段的照旧是有事（旧版本推来的都没有）。
     */
    close?: boolean;
    /**
     * 推送方那个后端的网页地址（`http://10.0.0.2:51883`）：那台的地址，拼上 `?session=`
     * 就是那个会话的页面（留着当回话地址，见 dev/weixinGateway.js；提醒卡片不打开它）。
     * 旧版本推来的没这个字段。
     */
    pageUrl?: string;
}

/** 推一次最多等这么久：对方没回应就当这条丢了（不攒着、不重试）。 */
const PUSH_TIMEOUT_MS = 5000;

/**
 * 推进去的那段正文最多留多少字。
 *
 * 收的那台拿它干三件事：右下角弹一张面板（那边还会再截到一两行，见 chatControllerBase.ts 的
 * chatHost 的 acceptRemoteNotice）上那条正文。
 * 所以留得跟本机那条一样长：手机上要看的就是这一轮的回复原文（见 chatHost.ts 的 PHONE_TEXT_CHARS），
 * 只留开头几句的话，跟本机那个会话在手机上看到的差得远。
 *
 * 留的是 markdown 原文（粗体、列表、代码块都在）：收到的那台自己解析一遍再画，
 * 不在这里压成纯文本。
 */
export const REMOTE_TEXT_CHARS = 1200;

/**
 * 从推过来的内容里读出一条通知。
 * @param raw 请求体解出来的东西（不知道对方发了什么，一律当未知处理）
 * @param fallbackLabel 对方没写名字时用什么（一般是它请求里的地址）
 * @returns 字段不齐就给 undefined：这条不认
 */
export function readRemoteNotice(raw: unknown, fallbackLabel: string): RemoteNotice | undefined {
    if (!raw || typeof raw !== "object") { return undefined; }
    const body = raw as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) { return undefined; }
    const label = (typeof body.label === "string" ? body.label.trim() : "") || fallbackLabel || "另一台";
    const name = (typeof body.name === "string" ? body.name.trim() : "") || "会话";
    // 摘要是可选的（旧版本不带）：带了也只是拿来显示，最长截一下
    // （多留一个字：推方那边的上限是不含末尾那个“…”的，切在这一格上别把“…”也切掉）
    const text = typeof body.text === "string" ? body.text.trim().slice(0, REMOTE_TEXT_CHARS + 1) : "";
    const kind = body.kind === "ask" ? "ask" : "done";
    // 回话地址也是可选的（旧版本不带）：带了才能把一句话送回原来那台
    const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.trim().slice(0, 200) : "";
    const close = body.close === true;
    return { label, sessionId, name, text, kind, ...(pageUrl ? { pageUrl } : {}), ...(close ? { close: true } : {}) };
}

/**
 * 把一条“有事”推给一台机器。
 * @param target 它网页服务的地址（比如 `http://10.0.0.2:51883`，后面带不带斜杠都行）
 * @returns 对方收下了没有（收下 = 2xx）；推不过去只返回 false，不抛
 */
export async function pushRemoteNotice(target: string, notice: RemoteNotice): Promise<boolean> {
    return postNotice(target, notice);
}

/**
 * 推一条“把那张收掉”过去：那边已经有人说话了 / 会话关掉了 / 那道题答完了
 * （见 chatHost 的 closeNotice）。收不到就算了，那张卡片人自己点一下也能收。
 * @param label 推方那台的「标签」（跟当初推“有事”那条一模一样，收到的那台照它认钥匙）
 * @param sessionId 推方那边的会话标识（同上）
 */
export async function pushRemoteClose(target: string, label: string, sessionId: string): Promise<boolean> {
    return postNotice(target, { label, sessionId, close: true });
}

/** 往那台的 /notify 丢一条过去；对方没回应就当这条丢了（不重试、不攒着）。 */
async function postNotice(target: string, body: unknown): Promise<boolean> {
    const url = target.replace(/\/+$/, "") + "/notify";
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
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
 * 这条推送目标是不是就是本机自己（照本机网页服务的地址比）。
 *
 * 为什么要认这个：设置里的推送地址可能写的是这台自己的地址（默认就显示它），那等于
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

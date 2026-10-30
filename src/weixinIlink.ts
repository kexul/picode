/**
 * weixinIlink —— 跟微信 ClawBot 那头（腾讯的 iLink 协议）说话的几个请求。
 *
 * 干什么：扫码登录要用的两步 —— ① 取一张登录二维码，② 长轮询那张码扫到哪一步了。
 * 这一层只管"发请求、把回话认出来"：登录流程在 weixinLogin.ts，账号存哪儿在 serverPaths.ts。
 *
 * 协议照腾讯开源的 openclaw-weixin（Tencent/openclaw-weixin，MIT）：JSON over HTTPS，
 * 头里带 iLink-App-Id 与 iLink-App-ClientVersion；POST 再多带 AuthorizationType 和一枚随机的
 * X-WECHAT-UIN。登录这两步还不需要口令 —— 有了 bot_token 之后的请求才带 Bearer（那是下一步的事，
 * 现在还没写）。
 *
 * 为什么要跟官方报同一个版本号（CHANNEL_VERSION）：那是"我按哪一版协议说话"的标识，
 * 不是"我是哪个程序"——后者由 bot_agent 说（写的是 pichat/版本号）。
 * 报自己的 0.1.0 上去等于自称一个古老客户端，服务器按旧行为伺候就说不清了。
 */

import * as crypto from "crypto";
import { appVersion } from "./appAssets";

/** 上报给微信的协议版本：跟官方 openclaw-weixin 那版一致。换协议行为时再动它。 */
const CHANNEL_VERSION = "2.4.10";

/** iLink 应用标识：官方那个渠道包在 package.json 里写的也是这个。 */
const APP_ID = "bot";

/** 扫码绑的是哪一类机器人（官方 DEFAULT_ILINK_BOT_TYPE）。 */
const BOT_TYPE = "3";

/** 正常请求等多久；二维码状态是长轮询，服务器可能压着不回，得等更久。 */
const API_TIMEOUT_MS = 15_000;
const QR_POLL_TIMEOUT_MS = 35_000;

/** 登录二维码的接口地址（固定这一个域名，跟官方一样；扫到一半可能被指到别的主机去）。 */
const FIXED_API_BASE = "https://ilinkai.weixin.qq.com";

/**
 * 现在该往哪个地址发请求。
 * 调试时用 PICHAT_WEIXIN_API 指到本地一个假服务上（`npm run web:shot -- --script dev/weixinLogin.js`
 * 就是这么验的）；不设就是真微信。
 */
export function apiBase(): string {
    const override = (process.env.PICHAT_WEIXIN_API ?? "").trim();
    return (override || FIXED_API_BASE).replace(/\/+$/, "");
}

/** "2.4.10" → 0x0002040A：官方把版本号塞进一个整数里报（major<<16 | minor<<8 | patch）。 */
function buildClientVersion(version: string): number {
    const parts = version.split(".").map((part) => parseInt(part, 10));
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    const patch = parts[2] ?? 0;
    return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);

/** X-WECHAT-UIN：随机 uint32 → 十进制字符串 → base64。官方的写法，照抄。 */
function randomWechatUin(): string {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function commonHeaders(): Record<string, string> {
    return {
        "iLink-App-Id": APP_ID,
        "iLink-App-ClientVersion": String(CLIENT_VERSION),
    };
}

function postHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": randomWechatUin(),
        ...commonHeaders(),
    };
    if (token?.trim()) { headers.Authorization = `Bearer ${token.trim()}`; }
    return headers;
}

/**
 * 把微信回话里那几个"大整数编号"先改成字符串再 JSON.parse。
 *
 * 为什么：message_id / msg_id / svr_id 是无符号 64 位整数，写回话里是裸数字。
 * JS 的 number 只有 53 位精度，`7521950497986457864` 一进 JSON.parse 就变成
 * `7521950497986458000` —— 拿这样的号去跟"引用回复里带的那个号"比，永远比不上。
 * 这个扫描只改"真当对象键用"的那几种，字符串里的同名字样不动（照抄官方那套做法）。
 */
const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

export function parseWeixinJson<T>(rawText: string): T {
    let output = "";
    let index = 0;
    while (index < rawText.length) {
        if (rawText[index] !== '"') {
            output += rawText[index++];
            continue;
        }
        const stringStart = index;
        index++;
        let escaped = false;
        while (index < rawText.length) {
            const char = rawText[index++];
            if (escaped) { escaped = false; }
            else if (char === "\\") { escaped = true; }
            else if (char === '"') { break; }
        }
        const stringToken = rawText.slice(stringStart, index);
        output += stringToken;

        let cursor = index;
        while (/\s/.test(rawText[cursor] ?? "")) { cursor++; }
        if (rawText[cursor] !== ":") { continue; }

        let key: unknown;
        try { key = JSON.parse(stringToken); } catch { continue; }
        if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) { continue; }

        output += rawText.slice(index, cursor + 1);
        cursor++;
        while (/\s/.test(rawText[cursor] ?? "")) { output += rawText[cursor++]; }
        const numberStart = cursor;
        if (rawText[cursor] === "-") { cursor++; }
        while (/\d/.test(rawText[cursor] ?? "")) { cursor++; }
        if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === "-")) {
            output += `"${rawText.slice(numberStart, cursor)}"`;
            index = cursor;
        } else {
            index = numberStart;
        }
    }
    return JSON.parse(output) as T;
}

/** 请求没成时抛这个：带一句人话（界面会把 message 直接显示出来）。 */
export class WeixinRequestError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = "WeixinRequestError";
    }
}

async function request(
    endpoint: string,
    init: {
        method: "GET" | "POST";
        body?: unknown;
        timeoutMs: number;
        baseUrl?: string;
        signal?: AbortSignal;
        /** 有了令牌之后的请求要带它（登录那两步没有）。 */
        token?: string;
    },
): Promise<string> {
    const base = (init.baseUrl ?? apiBase()).replace(/\/+$/, "");
    const url = `${base}/${endpoint}`;
    // 超时和"人点了取消"都能把这个请求掐掉：两种都让 fetch 抛 AbortError，由调用方分清
    const timeout = AbortSignal.timeout(init.timeoutMs);
    const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
    let res: Response;
    let text: string;
    try {
        res = await fetch(url, {
            method: init.method,
            headers: init.method === "POST"
                ? postHeaders(init.token)
                : { ...commonHeaders(), ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            signal,
        });
        text = await res.text();
    } catch (err) {
        const name = (err as Error)?.name;
        if (name === "AbortError" || name === "TimeoutError") {
            throw new WeixinRequestError(init.signal?.aborted ? "已取消" : "微信那头没应答（等超时了）");
        }
        throw new WeixinRequestError(`连不上微信那头：${(err as Error)?.message ?? String(err)}`);
    }
    if (!res.ok) {
        throw new WeixinRequestError(
            `微信那头回了一句 ${res.status}：${text.slice(0, 200)}`,
            res.status,
        );
    }
    return text;
}

/** 取一张登录二维码：qrcode 是那张码的编号（问状态用它），qrUrl 是要画成二维码的那串字。 */
export interface LoginQr {
    qrcode: string;
    /** 画成二维码给手机扫的内容（也是扫不出来时能直接点的那条链接）。 */
    qrUrl: string;
}

/**
 * 要一张新的登录二维码。
 * @param localTokens 本机已经绑过的令牌（最多十条）：服务器据此认出"这台已经绑过了"，
 *                    回 binded_redirect 而不是再发一份新凭据。
 */
export async function fetchLoginQr(localTokens: string[] = []): Promise<LoginQr> {
    const text = await request(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, {
        method: "POST",
        body: { local_token_list: localTokens.slice(0, 10) },
        timeoutMs: API_TIMEOUT_MS,
    });
    let raw: { qrcode?: unknown; qrcode_img_content?: unknown };
    try {
        raw = JSON.parse(text) as typeof raw;
    } catch {
        throw new WeixinRequestError(`微信那头给的不是 JSON：${text.slice(0, 200)}`);
    }
    const qrcode = typeof raw.qrcode === "string" ? raw.qrcode : "";
    const qrUrl = typeof raw.qrcode_img_content === "string" ? raw.qrcode_img_content : "";
    if (!qrcode || !qrUrl) {
        // 把原话带上：最常见的原因是本地存着一枚早就作废的令牌（它会以 local_token_list 报上去，
        // 那边就不发新码了，而是回一句别的）—— 光说“没给二维码”看不出是这个。
        throw new WeixinRequestError(`微信那头没给二维码，回的是：${text.slice(0, 200)}`);
    }
    return { qrcode, qrUrl };
}

/**
 * 扫码这一步走到哪儿了。
 *
 * 各状态的意思（官方那套叫法）：
 *   wait                还没人扫
 *   scaned              手机上扫了，等人在手机上点确认
 *   need_verifycode     手机微信上出了个数字，要在客户端这边输进去
 *   verify_code_blocked 数字输错太多次
 *   scaned_but_redirect 扫了，但服务器让换一台主机接着问（照它给的换）
 *   expired             这张码过期了（得换一张）
 *   binded_redirect     这台已经绑过了（不用再发凭据）
 *   confirmed           成了：bot_token / ilink_bot_id 都在回话里
 */
export type LoginStatus =
    | { status: "wait" }
    | { status: "scaned" }
    | { status: "need_verifycode" }
    | { status: "verify_code_blocked" }
    | { status: "scaned_but_redirect"; redirectHost?: string }
    | { status: "expired" }
    | { status: "binded_redirect" }
    | { status: "confirmed"; botToken?: string; accountId?: string; baseUrl?: string; userId?: string };

/** 发出去的一条消息：回话里的服务端 message_id 以后有用（“引用回复认会话”靠它）。 */
export interface SentMessage {
    messageId?: string;
}

/** 发消息用到的登录态：令牌 + 往哪个地址发。 */
export interface WeixinSender {
    botToken: string;
    baseUrl?: string;
}

/** 发一条文本消息。 */
export interface SendTextOptions {
    /** 发给谁（扫登录码那位，登录回话里的 ilink_user_id）。 */
    to: string;
    text: string;
    /**
     * 这条消息属于哪一段对话：对方的每条来信里都会带一个，回信要原样带回。
     * 手上一点都没有时可以先不填试试 —— 服务器多半会拒（那就得先收到对方一句话）。
     */
    contextToken?: string;
}

/**
 * 以那个机器人的身份发一条文本。
 * @returns 服务端给的 message_id（以后认“引用的哪一条”靠它）
 */
export async function sendText(sender: WeixinSender, opts: SendTextOptions): Promise<SentMessage> {
    const body = {
        msg: {
            from_user_id: "",
            to_user_id: opts.to,
            client_id: `pichat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
            message_type: 2,        // 2 = 机器人发的
            message_state: 2,       // 2 = 这条已完成（不是“正在生成”）
            item_list: [{ type: 1, text_item: { text: opts.text } }],
            context_token: opts.contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: `pichat/${appVersion()}` },
    };
    const text = await request("ilink/bot/sendmessage", {
        method: "POST",
        body,
        timeoutMs: API_TIMEOUT_MS,
        baseUrl: sender.baseUrl,
        token: sender.botToken,
    });
    let raw: { ret?: number; errmsg?: string; message_id?: string };
    try {
        raw = parseWeixinJson<typeof raw>(text);
    } catch {
        throw new WeixinRequestError(`微信那头回的不是 JSON：${text.slice(0, 200)}`);
    }
    if (typeof raw.ret === "number" && raw.ret !== 0) {
        throw new WeixinRequestError(raw.ret === -14
            ? "微信那头说这个登录已经过期了（errcode -14）：重新扫一次码。"
            : `微信那头没收：ret=${raw.ret} ${raw.errmsg ?? ""}`.trim());
    }
    return { messageId: typeof raw.message_id === "string" ? raw.message_id : undefined };
}

/**
 * 长轮询一次扫码状态。
 *
 * 等超时、网络那头抽风都当"还没扫"处理：这一步本来就是一直问下去，问不到不是错。
 * 只有"人点了取消"（外部 signal 掐断）才抛，让上层当场收摊。
 */
export async function pollLoginStatus(
    qrcode: string,
    opts: { verifyCode?: string; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<LoginStatus> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (opts.verifyCode) { endpoint += `&verify_code=${encodeURIComponent(opts.verifyCode)}`; }
    let text: string;
    try {
        text = await request(endpoint, {
            method: "GET",
            timeoutMs: QR_POLL_TIMEOUT_MS,
            baseUrl: opts.baseUrl,
            signal: opts.signal,
        });
    } catch (err) {
        if (opts.signal?.aborted) { throw err; }
        return { status: "wait" };
    }
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return { status: "wait" };
    }
    const status = typeof raw.status === "string" ? raw.status : "";
    const str = (key: string): string | undefined => {
        const value = raw[key];
        return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    switch (status) {
        case "scaned": return { status: "scaned" };
        case "need_verifycode": return { status: "need_verifycode" };
        case "verify_code_blocked": return { status: "verify_code_blocked" };
        case "scaned_but_redirect": return { status: "scaned_but_redirect", redirectHost: str("redirect_host") };
        case "expired": return { status: "expired" };
        case "binded_redirect": return { status: "binded_redirect" };
        case "confirmed":
            return {
                status: "confirmed",
                botToken: str("bot_token"),
                accountId: str("ilink_bot_id"),
                baseUrl: str("baseurl"),
                userId: str("ilink_user_id"),
            };
        default:
            return { status: "wait" };
    }
}

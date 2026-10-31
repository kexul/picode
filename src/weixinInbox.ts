/**
 * weixinInbox —— 一直盯着微信那头：有人给这个机器人发消息，就交给宿主去办事（chatHost.ts）。
 *
 * 干什么：长轮询 `getUpdates`（服务器压着请求，有新消息立刻回，没有就压到超时），
 * 把收到的消息一条条交出去，顺手把"读到哪儿了"记下来（weixin/cursor.json）：
 * 后端重启以后从那一格接着读，不会把老消息再办一遍。
 *
 * 什么时候开始收：后端一起来就收（见 serverMain.ts）—— 这个功能本来就是给"人不在电脑前"用的，
 * 不能等人打开页面才开始。没登录就等着（一秒问一次有没有登录上），登录上线自动开始。
 *
 * 出岔子（网断了、令牌过期 -14）：只记日志、隔一会儿再试，不把后端弄挂。
 * 令牌过期那条要人去重新扫码 —— 日志里会写明。
 */
import * as fs from "fs";
import * as path from "path";
import { getUpdates, type WeixinInbound, WeixinRequestError } from "./weixinIlink";
import { readWeixinAccount } from "./weixinLogin";
import { weixinContextFile, weixinCursorFile } from "./serverPaths";

/** 没登录上时多久看一次"登录上了没有"。 */
const NOT_LOGGED_IN_POLL_MS = 1000;
/** 出岔子之后多久再试（令牌过期那条要等人扫码，等久一点）。 */
const RETRY_MS = 5000;
const EXPIRED_RETRY_MS = 60_000;

/** 读到的位置：换过账号（令牌）就得从头来。 */
interface Cursor {
    accountId: string;
    cursor: string;
}

/** 回信要带的凭据（按键是发信人）：换过账号就整份作废。 */
interface TokenStore {
    accountId: string;
    tokens: Record<string, string>;
}

/** 最多留几个人的：这个机器人只绑给一个人，留几个是免得别人发来的越积越多。 */
const CONTEXT_KEEP = 10;

/**
 * 记下最近一条来信里带的那份回信凭据。
 *
 * 为什么要记到盘上：推送离人上一句话可能已经过了很久、后端也可能重启过，
 * 而微信只认最近那份（不带、或带了旧的都回 `ret=-2 prepare failed`）。
 */
export function rememberContextToken(
    accountId: string,
    userId: string,
    token: string,
    file: string = weixinContextFile(),
): void {
    if (!userId || !token) { return; }
    const store: TokenStore = { accountId, tokens: {} };
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as TokenStore;
        if (raw && raw.accountId === accountId && raw.tokens && typeof raw.tokens === "object") {
            store.tokens = { ...raw.tokens };
        }
    } catch { /* 没有 / 读不动 / 换过账号：从空的开始 */ }
    delete store.tokens[userId];            // 挪到末尾，裁的时候从最老的裁
    store.tokens[userId] = token;
    const keys = Object.keys(store.tokens);
    for (const key of keys.slice(0, Math.max(0, keys.length - CONTEXT_KEEP))) { delete store.tokens[key]; }
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        // 这也算一份凭据：别人拿到就能拿这个号发消息，只给自己读；先写别处再换上，免得到别处读的时候撞上半个文件
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, file);
    } catch { /* 记不下来：这一次照旧能回，只是下次推送可能又发不出去 */ }
}

/** 手上留着的那个人那份回信凭据；没有 / 换过账号就是 undefined。 */
export function readContextToken(
    accountId: string,
    userId: string,
    file: string = weixinContextFile(),
): string | undefined {
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as TokenStore;
        if (!raw || raw.accountId !== accountId || !raw.tokens) { return undefined; }
        const token = raw.tokens[userId];
        return typeof token === "string" && token.trim() ? token.trim() : undefined;
    } catch {
        return undefined;
    }
}

export class WeixinInbox {
    private running = false;
    private abort: AbortController | undefined;

    /**
     * @param onMessage 收到一条（已经挑出正文和被引用的编号，见 weixinIlink.ts 的 readInbound）
     * @param log 给人看的一行话
     */
    constructor(
        private readonly onMessage: (msg: WeixinInbound) => void,
        private readonly log: (text: string) => void,
        private readonly cursorFile: string = weixinCursorFile(),
    ) {}

    /** 开始收（重复调没有副作用）。 */
    public start(): void {
        if (this.running) { return; }
        this.running = true;
        this.abort = new AbortController();
        void this.run(this.abort.signal);
    }

    /** 收摊（后端退出时调）。 */
    public stop(): void {
        this.abort?.abort();
        this.abort = undefined;
        this.running = false;
    }

    private async run(signal: AbortSignal): Promise<void> {
        let timeoutMs: number | undefined;
        while (!signal.aborted) {
            const account = readWeixinAccount();
            if (!account) {
                await sleep(NOT_LOGGED_IN_POLL_MS, signal);
                continue;
            }
            const saved = this.readCursor(account.accountId);
            try {
                const result = await getUpdates(
                    { botToken: account.botToken, baseUrl: account.baseUrl },
                    saved,
                    { timeoutMs, signal },
                );
                if (signal.aborted) { return; }
                if (result.timeoutMs) { timeoutMs = result.timeoutMs; }
                if (result.cursor !== saved) { this.writeCursor(account.accountId, result.cursor); }
                for (const msg of result.messages) {
                    if (signal.aborted) { return; }
                    // 先把回信凭据记下来：这一条哪怕是别人发的也得记（按发信人各存一份），
                    // 免得等会儿要回话时手上没有最新的那份
                    if (msg.contextToken) {
                        rememberContextToken(account.accountId, msg.fromUserId, msg.contextToken);
                    }
                    try {
                        this.onMessage(msg);
                    } catch (err) {
                        this.log(`[微信] 处理一条收到的消息出岔子：${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            } catch (err) {
                if (signal.aborted) { return; }
                const text = err instanceof Error ? err.message : String(err);
                this.log(`[微信] 收消息断了：${text}`);
                const expired = err instanceof WeixinRequestError && text.includes("-14");
                await sleep(expired ? EXPIRED_RETRY_MS : RETRY_MS, signal);
            }
        }
    }

    /** 上次读到哪儿（这个账号的）；换过账号就当没读过。 */
    private readCursor(accountId: string): string {
        try {
            const raw = JSON.parse(fs.readFileSync(this.cursorFile, "utf8")) as Cursor;
            if (raw && raw.accountId === accountId && typeof raw.cursor === "string") { return raw.cursor; }
        } catch { /* 没有 / 读不动：从头读 */ }
        return "";
    }

    private writeCursor(accountId: string, cursor: string): void {
        try {
            fs.mkdirSync(path.dirname(this.cursorFile), { recursive: true });
            fs.writeFileSync(this.cursorFile, JSON.stringify({ accountId, cursor }), "utf8");
        } catch { /* 记不下来只是重启后会重读一遍老消息，不至于不能用 */ }
    }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) { resolve(); return; }
        const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

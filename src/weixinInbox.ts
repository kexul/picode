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
import { weixinCursorFile } from "./serverPaths";

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

/**
 * weixinLogin —— 用手机微信扫一下，把这台后端绑到你的微信 ClawBot 上。
 *
 * 干什么：管"扫码登录"这一件事 —— 要一张二维码、盯着它扫到哪一步、要数字就让界面问你要数字、
 * 成了就把令牌存下来（存哪儿见 serverPaths.ts 的 weixinAccountFile）。
 * 界面那一头是设置浮层里那块「微信」（media/chat.js），中间靠 chatHost.ts 转发几条消息，见下面的注释。
 *
 * 为什么在浏览器界面里扫（而不是像 pi-weixin-bridge 那样在终端里印一张）：后端很多时候是那个
 * 托盘小程序拉起来的，根本没有终端可以看；手机上的浏览器页面也能开着，走到哪儿扫到哪儿。
 *
 * 存下来的只有"绑的是哪个机器人 + 令牌 + 发给谁"。推送消息、收了消息回哪个会话，
 * 是后面的事，这一层不碰。
 */
import * as fs from "fs";
import * as path from "path";
import { fetchLoginQr, pollLoginStatus, WeixinRequestError, type LoginQr } from "./weixinIlink";
import { weixinAccountFile } from "./serverPaths";

/** 屏幕上那块「微信」现在该显示成什么样。 */
export type WeixinLoginPhase =
    /** 没在登录（还没点，或者上一次收摊了）。 */
    | "idle"
    /** 二维码摆着等人扫。 */
    | "wait"
    /** 扫了，等手机上点确认。 */
    | "scaned"
    /** 手机微信上出了个数字，得在这边输进去。 */
    | "needcode"
    /** 已经登录（这次刚成，或者本来就有令牌）。 */
    | "done"
    /** 出岔子了：message 里那句就是原因。 */
    | "error";

export interface WeixinLoginState {
    phase: WeixinLoginPhase;
    /** 要画成二维码的那串字（wait / scaned / needcode 时有）。 */
    qr?: string;
    /** 已经登录时：绑的是哪个机器人（回话里的 ilink_bot_id）。 */
    account?: string;
    /** 界面上那一句说明（人话，直接显示）。 */
    message?: string;
}

/** 存下来的登录态。凭据在这儿，别打印它。 */
export interface WeixinAccount {
    botToken: string;
    accountId: string;
    /** 以后发消息往哪儿发（服务器给的那个；没给就按固定域名）。 */
    baseUrl?: string;
    /** 扫这张码的人（以后要认"是谁在跟我说话"就看它）。 */
    userId?: string;
    savedAt: number;
}

/** 一张二维码能等多久：过了就整个收摊，让人重新点一次（比一直挂着强）。 */
const LOGIN_DEADLINE_MS = 8 * 60 * 1000;
/** 二维码过期最多换几张：连着过期三张多半是网络或客户端有问题，再换也没用。 */
const MAX_QR_REFRESH = 3;
/** 两问之间歇一下（服务器那头也可能压着不回，那是长轮询自己的事）。 */
const POLL_GAP_MS = 1000;

/** 读存下来的登录态；没有、读不出来、认不出来，一律当没登录。 */
export function readWeixinAccount(file: string = weixinAccountFile()): WeixinAccount | undefined {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
    try {
        const raw = JSON.parse(text) as Record<string, unknown>;
        const botToken = typeof raw.botToken === "string" ? raw.botToken.trim() : "";
        const accountId = typeof raw.accountId === "string" ? raw.accountId.trim() : "";
        if (!botToken || !accountId) { return undefined; }
        return {
            botToken,
            accountId,
            baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : undefined,
            userId: typeof raw.userId === "string" && raw.userId.trim() ? raw.userId.trim() : undefined,
            savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
        };
    } catch {
        return undefined;
    }
}

/**
 * 把登录态写下来。
 * 先写旁边的临时文件再改名：写到一半断电/被杀，原来那份还能用，不会被截断成半截 JSON。
 * POSIX 上令牌文件只给自己读（目录 700、文件 600）；Windows 那边的权限不这么算，跳过。
 */
function saveWeixinAccount(account: WeixinAccount, file: string = weixinAccountFile()): void {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.account-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(account, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    if (process.platform !== "win32") {
        try { fs.chmodSync(file, 0o600); } catch { /* 收不紧就算了，别为这个登不上 */ }
    }
}

/**
 * 扫码登录这一件事的全部状态。
 *
 * 用法：constructor 一次（顺手读一遍已有的登录态），之后 start / submitCode / cancel，
 * 每变一次都会调 onChange —— 宿主把它转发给界面（见 chatHost.ts）。
 */
export class WeixinLogin {
    private state: WeixinLoginState;
    private account: WeixinAccount | undefined;
    /** 正在登录（要从取二维码一直走到成不成为止）。 */
    private running = false;
    /** 这一轮登录的取消开关：掐断长轮询、也让循环当场收摊。 */
    private abort: AbortController | undefined;
    /** 等着人输数字的那一格：submitCode 一调就交出去。 */
    private codeWaiter: ((code: string) => void) | undefined;

    constructor(private readonly onChange: (state: WeixinLoginState) => void, private readonly file: string = weixinAccountFile()) {
        this.account = readWeixinAccount(this.file);
        this.state = this.account
            ? { phase: "done", account: this.account.accountId }
            : { phase: "idle" };
    }

    /** 现在界面上该显示的那一份（刚连上来的页面问它要）。 */
    public current(): WeixinLoginState {
        return this.state;
    }

    /** 点「扫码登录」：要一张码摆出去，然后一直盯着它。 */
    public start(): void {
        if (this.running) { return; }
        this.running = true;
        this.abort = new AbortController();
        void this.run(this.abort.signal);
    }

    /** 界面上输了手机微信显示的那个数字。 */
    public submitCode(code: string): void {
        const waiter = this.codeWaiter;
        this.codeWaiter = undefined;
        waiter?.(code.trim());
    }

    /** 点「取消」：这一轮就到这儿（已经登录着的那份不动）。 */
    public cancel(): void {
        this.abort?.abort();
        this.abort = undefined;
        this.running = false;
        this.codeWaiter = undefined;
        this.set(this.account
            ? { phase: "done", account: this.account.accountId }
            : { phase: "idle" });
    }

    private set(state: WeixinLoginState): void {
        this.state = state;
        this.onChange(state);
    }

    /** 一轮登录：取码 → 等扫 → （问数字）→ 成了就存下来。 */
    private async run(signal: AbortSignal): Promise<void> {
        const deadline = Date.now() + LOGIN_DEADLINE_MS;
        let refresh = 0;
        let verifyCode: string | undefined;
        /** 问扫码状态往哪个地址问：扫到一半服务器可能让换一台主机。 */
        let pollBase: string | undefined;
        try {
            let qr = await this.requestQr();
            this.set({ phase: "wait", qr: qr.qrUrl, message: "用手机微信扫上面这张码" });
            while (!signal.aborted && Date.now() < deadline) {
                const status = await pollLoginStatus(qr.qrcode, { verifyCode, baseUrl: pollBase, signal });
                if (signal.aborted) { break; }
                if (status.status === "scaned") {
                    verifyCode = undefined;
                    if (this.state.phase !== "scaned") {
                        this.set({ phase: "scaned", qr: qr.qrUrl, message: "扫到了，在手机上点一下确认" });
                    }
                } else if (status.status === "need_verifycode") {
                    // 手机微信上出了个数字：问界面要，等它给（期间这一轮就停在这儿）
                    this.set({ phase: "needcode", qr: qr.qrUrl, message: "把手机微信上显示的数字填进来" });
                    const code = await this.takeCode();
                    if (signal.aborted) { break; }
                    if (!code) {
                        this.set({ phase: "error", message: "没输数字，这一轮就到这儿了" });
                        break;
                    }
                    verifyCode = code;
                    this.set({ phase: "wait", qr: qr.qrUrl, message: "正在核对那个数字…" });
                    continue;
                } else if (status.status === "verify_code_blocked") {
                    verifyCode = undefined;
                    refresh++;
                    if (refresh > MAX_QR_REFRESH) {
                        this.set({ phase: "error", message: "数字输错太多次，微信那头把这次连接关掉了。稍后再试。" });
                        break;
                    }
                    qr = await fetchLoginQr();
                    this.set({ phase: "wait", qr: qr.qrUrl, message: "数字输错太多次，换了一张新码，请重新扫" });
                } else if (status.status === "expired") {
                    refresh++;
                    if (refresh > MAX_QR_REFRESH) {
                        this.set({ phase: "error", message: "二维码连着过期，这一轮就到这儿了。再点一次试试。" });
                        break;
                    }
                    qr = await fetchLoginQr();
                    this.set({ phase: "wait", qr: qr.qrUrl, message: "上一张码过期了，换了一张新的，请重新扫" });
                } else if (status.status === "scaned_but_redirect") {
                    // 服务器让换一台主机接着问（它按机房分流）；没给主机名就还问原来的
                    if (status.redirectHost) { pollBase = `https://${status.redirectHost}`; }
                } else if (status.status === "binded_redirect") {
                    // 这个机器人已经绑在这台上了：令牌还是原来那份，不用再发新的
                    if (this.account) {
                        this.set({ phase: "done", account: this.account.accountId, message: "这个微信已经绑过这台了，令牌还是原来那份" });
                    } else {
                        this.set({ phase: "error", message: "这个微信已经绑到别处了（那边的那份令牌才算数）。" });
                    }
                    break;
                } else if (status.status === "confirmed") {
                    if (!status.accountId || !status.botToken) {
                        this.set({ phase: "error", message: "微信那头说成了，却没给令牌（少了 ilink_bot_id / bot_token）。" });
                        break;
                    }
                    this.account = {
                        botToken: status.botToken,
                        accountId: status.accountId,
                        baseUrl: status.baseUrl,
                        userId: status.userId,
                        savedAt: Date.now(),
                    };
                    saveWeixinAccount(this.account, this.file);
                    this.set({ phase: "done", account: this.account.accountId });
                    break;
                }
                await sleep(POLL_GAP_MS);
            }
            if (!signal.aborted && this.state.phase !== "done" && this.state.phase !== "error") {
                this.set({ phase: "error", message: "等了 8 分钟也没扫上，再点一次试试。" });
            }
        } catch (err) {
            if (signal.aborted) { return; }
            this.set({ phase: "error", message: describeError(err) });
        } finally {
            if (this.abort?.signal === signal) {
                this.running = false;
                this.abort = undefined;
            }
        }
    }

    /**
     * 要一张登录二维码。
     *
     * 先把本地那枚令牌报上去：服务器据此认出"这台已经绑过了"，回 binded_redirect 而不是再发一份。
     * 但那枚令牌要是早作废了，服务器会整张码都不给（`batch verify bot token fail`）——
     * 这时候就当没有令牌，再要一张（人点「重新扫码」本来也是这个意思）。
     */
    private async requestQr(): Promise<LoginQr> {
        if (!this.account) { return fetchLoginQr(); }
        try {
            return await fetchLoginQr([this.account.botToken]);
        } catch {
            return fetchLoginQr();
        }
    }

    /** 等界面把数字交上来（这一轮就停在这个 Promise 上）。取消时给空串。 */
    private takeCode(): Promise<string> {
        return new Promise<string>((resolve) => {
            this.codeWaiter = resolve;
            this.abort?.signal.addEventListener("abort", () => { resolve(""); }, { once: true });
        });
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 出岔子时给界面看的那句话：网络/协议那几种自己带话，别的补一句通用的。 */
function describeError(err: unknown): string {
    if (err instanceof WeixinRequestError) { return err.message; }
    const text = err instanceof Error ? err.message : String(err);
    return `登录没成：${text || "原因不明"}`;
}

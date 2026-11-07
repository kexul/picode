/**
 * 后端这一侧的「中转」连接（架构图里后端 → 中转那条本机 HTTP/连接）。
 *
 * 谁在用：PiClient（每只 pi 一根线）与 serverMain（起停中转、收摊、认回会话）。
 *
 * 两件事：
 *   1. ensureRelay()：找一个正在跑的中转，连上；没有就起一支（detached，后端退了它还活着）。
 *   2. RelayLink：这条连接上说的话（见 relayProtocol.ts）。
 *
 * 起不来就返回 undefined：后端照样能用，只是退回"自己 spawn pi"那条老路
 * （那样后端一重启 pi 就跟着没了 —— 跟今天一样，不会比今天更糟）。
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import type { PiSpawnSpec } from "./piSpawn";
import { makeLineSplitter } from "./piSpawn";
import type { RelayAddress, RelayEvent, RelayPiInfo, RelayRequest } from "./relayProtocol";
import { relayAddressFile, relayLogFile } from "./serverPaths";

/** 连一条已经跑着的中转最多等多久。 */
const CONNECT_TIMEOUT_MS = 2500;
/** 起一支新的中转最多等多久（等它写地址文件、能连上）。 */
const START_TIMEOUT_MS = 10000;
/** 一条带回复的请求最多等多久。 */
const REPLY_TIMEOUT_MS = 15000;

export interface RelayFrame {
    seq: number;
    ch: "out" | "err";
    line: string;
}

type FrameListener = (frame: RelayFrame) => void;
type ExitListener = (code: number | null) => void;

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/** 现在连着的那一支中转（后端一整个进程共用一条）。 */
let current: RelayLink | undefined;
let starting: Promise<RelayLink | undefined> | undefined;

/** 这个后端正在用的中转；没有（说明走的是自己 spawn pi 的老路）。 */
export function relayLink(): RelayLink | undefined {
    return current && !current.closed ? current : undefined;
}

/** 后端收摊时清掉这一份引用（全局共享，别让下一个后端误以为还连着）。 */
export function forgetRelay(): void {
    current = undefined;
}

/** 读地址文件；不在 / 坏 JSON 都当没有。 */
function readAddress(): RelayAddress | undefined {
    let text: string;
    try {
        text = fs.readFileSync(relayAddressFile(), "utf8");
    } catch {
        return undefined;
    }
    try {
        const v = JSON.parse(text) as RelayAddress;
        if (!v || v.app !== "pichat-relay" || typeof v.port !== "number" || typeof v.token !== "string" || v.port <= 0) {
            return undefined;
        }
        return v;
    } catch {
        return undefined;
    }
}

function clearAddress(): void {
    try { fs.unlinkSync(relayAddressFile()); } catch { /* 本来就不在 */ }
}

/**
 * 找中转：已经有一支在跑就连上去，没有就起一支。
 *
 * @param log 跟人说一句的时候调它（起不来时唯一线索就是这句）
 * @returns 连上了的那个；起不来就是 undefined（调用方退回老路）
 */
export async function ensureRelay(log: (text: string) => void = () => { /* 默认不说话 */ }): Promise<RelayLink | undefined> {
    if ((process.env.PICHAT_NO_RELAY ?? "").trim() === "1") { return undefined; }
    if (current && !current.closed) { return current; }
    if (starting) { return starting; }
    starting = (async () => {
        const existing = readAddress();
        if (existing) {
            const link = await RelayLink.connect(existing);
            if (link) { current = link; return link; }
            // 连不上：可能它正在收摊。过一会儿再试一次，还不行就当这份地址是过期的。
            await sleep(300);
            const again = await RelayLink.connect(existing);
            if (again) { current = again; return again; }
            log(`地址文件里的中转连不上（127.0.0.1:${existing.port}，进程 ${existing.pid}），换一支新的。`);
            clearAddress();
        }

        const entry = path.join(__dirname, "relayMain.js");
        if (!fs.existsSync(entry)) {
            log(`找不到中转的程序：${entry}（退回自己起 pi 那条路）。`);
            return undefined;
        }
        let logFd: number | undefined;
        try {
            fs.mkdirSync(path.dirname(relayLogFile()), { recursive: true });
            logFd = fs.openSync(relayLogFile(), "a");
        } catch { /* 打不了日志也照样能跑 */ }
        let child: cp.ChildProcess;
        try {
            child = cp.spawn(process.execPath, [entry], {
                detached: true,                       // 后端退了它还活着（这是整件事的前提）
                stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
                windowsHide: true,
                env: process.env,
            });
            child.unref();
        } catch (err: any) {
            log(`起不了中转：${err?.message ?? String(err)}（退回自己起 pi 那条路）。`);
            return undefined;
        }

        const deadline = Date.now() + START_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await sleep(100);
            const addr = readAddress();
            if (!addr) { continue; }
            const link = await RelayLink.connect(addr);
            if (link) {
                log(`中转起来了：127.0.0.1:${addr.port}（进程 ${addr.pid}，日志 ${relayLogFile()}）`);
                current = link;
                return link;
            }
        }
        log(`中转十秒内没起来（日志见 ${relayLogFile()}，退回自己起 pi 那条路）。`);
        return undefined;
    })().finally(() => { starting = undefined; });
    return starting;
}

/** 一条连到中转的连接；断开以后里面那些 pi 就当"进程没了"处理。 */
export class RelayLink {
    readonly version: string;
    readonly pi: RelayPiInfo[];
    closed = false;

    private readonly socket: net.Socket;
    private readonly split = makeLineSplitter();
    private nextN = 1;
    private readonly pending = new Map<number, (ev: RelayEvent | undefined) => void>();
    private readonly frameListeners = new Map<string, Set<FrameListener>>();
    private readonly exitListeners = new Map<string, Set<ExitListener>>();

    private constructor(socket: net.Socket, version: string, pi: RelayPiInfo[]) {
        this.socket = socket;
        this.version = version;
        this.pi = pi;
        socket.on("data", (chunk: Buffer) => {
            this.split(chunk.toString("utf8"), (line) => this.onLine(line));
        });
        socket.on("error", () => { /* close 会跟着来 */ });
        socket.on("close", () => this.onClosed());
    }

    /** 连一条并握手；口令不对 / 端口上不是我们 / 超时，都回 undefined。 */
    static connect(addr: RelayAddress, timeoutMs = CONNECT_TIMEOUT_MS): Promise<RelayLink | undefined> {
        return new Promise((resolve) => {
            const socket = net.createConnection({ host: "127.0.0.1", port: addr.port });
            let done = false;
            const finish = (link: RelayLink | undefined) => {
                if (done) { return; }
                done = true;
                clearTimeout(timer);
                if (!link) { try { socket.destroy(); } catch { /* 已经断了 */ } }
                resolve(link);
            };
            const timer = setTimeout(() => finish(undefined), timeoutMs);
            let split = makeLineSplitter();
            socket.on("connect", () => {
                socket.write(JSON.stringify({ op: "hello", token: addr.token }) + "\n");
            });
            socket.on("data", (chunk: Buffer) => {
                split(chunk.toString("utf8"), (line) => {
                    if (done) { return; }
                    let ev: RelayEvent;
                    try { ev = JSON.parse(line) as RelayEvent; } catch { return; }
                    if (ev && ev.ev === "hello") {
                        if (!ev.ok) { finish(undefined); return; }
                        // 握手成功：这条 socket 从此交给 RelayLink 管
                        socket.removeAllListeners("data");
                        finish(new RelayLink(socket, ev.version, ev.pi));
                    }
                });
            });
            socket.on("error", () => finish(undefined));
            socket.on("close", () => finish(undefined));
        });
    }

    private onLine(line: string): void {
        if (!line.trim()) { return; }
        let ev: RelayEvent;
        try { ev = JSON.parse(line) as RelayEvent; } catch {
            console.error("[中转] 收到一条读不懂的话，丢掉");
            return;
        }
        if (ev.ev === "reply") {
            const cb = this.pending.get(ev.n);
            if (cb) { this.pending.delete(ev.n); cb(ev); }
            return;
        }
        if (ev.ev === "frame") {
            const set = this.frameListeners.get(ev.key);
            if (set) {
                for (const fn of set) { fn({ seq: ev.seq, ch: ev.ch, line: ev.line }); }
            }
            return;
        }
        if (ev.ev === "exit") {
            const set = this.exitListeners.get(ev.key);
            if (set) {
                for (const fn of set) { fn(ev.code); }
            }
            return;
        }
    }

    private onClosed(): void {
        if (this.closed) { return; }
        this.closed = true;
        if (current === this) { current = undefined; }
        for (const cb of Array.from(this.pending.values())) { cb(undefined); }
        this.pending.clear();
        // 连接没了：手上的 pi 一个也问不着了，按"进程退出"告诉他们（界面会显示 pi 已退出，
        // 下一条消息会自动重启一个）。中转还会活着，等下一轮连上。
        for (const set of Array.from(this.exitListeners.values())) {
            for (const fn of Array.from(set)) { fn(null); }
        }
    }

    private ask(req: RelayRequest, timeoutMs = REPLY_TIMEOUT_MS): Promise<RelayEvent | undefined> {
        if (this.closed) { return Promise.resolve(undefined); }
        const n = this.nextN++;
        const msg = { ...req, n } as RelayRequest;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(n);
                resolve(undefined);
            }, timeoutMs);
            this.pending.set(n, (ev) => {
                clearTimeout(timer);
                resolve(ev);
            });
            try {
                this.socket.write(JSON.stringify(msg) + "\n");
            } catch {
                this.pending.delete(n);
                clearTimeout(timer);
                resolve(undefined);
            }
        });
    }

    private tell(req: RelayRequest): void {
        if (this.closed) { return; }
        try { this.socket.write(JSON.stringify(req) + "\n"); } catch { /* 断了就算了 */ }
    }

    /** 现在中转手里有哪些 pi（起手认回会话用）。 */
    async list(): Promise<RelayPiInfo[]> {
        const ev = await this.ask({ op: "list", n: 0 });
        return ev && ev.ev === "reply" && ev.ok && Array.isArray(ev.keys) ? ev.keys : [];
    }

    /** 请中转起一只 pi。 */
    async spawn(key: string, spec: PiSpawnSpec): Promise<{ ok: boolean; reason?: string }> {
        const ev = await this.ask({ op: "spawn", n: 0, key, spec });
        if (!ev || ev.ev !== "reply") { return { ok: false, reason: "中转没有回应" }; }
        return ev.ok ? { ok: true } : { ok: false, reason: ev.reason ?? "起不了 pi" };
    }

    /** 接管一只正在跑的 pi（后端换人以后）。 */
    async attach(key: string, opts?: { replay?: boolean; since?: number }): Promise<{ ok: boolean; reason?: string; maxReq?: number }> {
        const ev = await this.ask({ op: "attach", n: 0, key, replay: opts?.replay, since: opts?.since });
        if (!ev || ev.ev !== "reply") { return { ok: false, reason: "中转没有回应" }; }
        if (!ev.ok) { return { ok: false, reason: ev.reason ?? "那只 pi 已经不在了" }; }
        return { ok: true, ...(typeof ev.maxReq === "number" ? { maxReq: ev.maxReq } : {}) };
    }

    /** 往 pi 的 stdin 写一行。 */
    sendLine(key: string, line: string): void {
        this.tell({ op: "send", key, line });
    }

    /** 告诉中转这只是哪个会话（重启后照它认回来）。 */
    label(key: string, info: { panelId?: string; sessionFile?: string; cwd?: string }): void {
        this.tell({
            op: "label",
            key,
            ...(info.panelId !== undefined ? { panelId: info.panelId } : {}),
            ...(info.sessionFile !== undefined ? { sessionFile: info.sessionFile } : {}),
            ...(info.cwd !== undefined ? { cwd: info.cwd } : {}),
        });
    }

    /** 让中转把这只 pi 收掉（关会话、宿主收摊时用）。 */
    kill(key: string): void {
        this.tell({ op: "kill", key });
    }

    /** 不再管这只 pi：断开这边的听筒，pi 留着（后端重启的路上用）。 */
    detach(key: string): void {
        this.frameListeners.delete(key);
        this.exitListeners.delete(key);
    }

    /** 中转这边听 pi 说了什么。返回一个"不听了"的函数。 */
    onFrame(key: string, fn: FrameListener): () => void {
        let set = this.frameListeners.get(key);
        if (!set) { set = new Set(); this.frameListeners.set(key, set); }
        set.add(fn);
        return () => { set.delete(fn); };
    }

    /** pi 退出了（或者连接断了）。返回一个"不听了"的函数。 */
    onExit(key: string, fn: ExitListener): () => void {
        let set = this.exitListeners.get(key);
        if (!set) { set = new Set(); this.exitListeners.set(key, set); }
        set.add(fn);
        return () => { set.delete(fn); };
    }

    /** 全收：让中转把 pi 都杀掉、自己也退（Ctrl+C、正常收摊走这条）。 */
    shutdown(): void {
        this.tell({ op: "shutdown" });
        try { this.socket.end(); } catch { /* 已经断了 */ }
        this.closed = true;
        if (current === this) { current = undefined; }
    }

    /** 只断这条连接（「编译并重启」走这条：pi 留着，新后端接着用）。 */
    close(): void {
        try { this.socket.end(); } catch { /* 已经断了 */ }
    }
}

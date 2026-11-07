/**
 * 中转 —— 拿着 pi 管道的那个常驻进程（架构图中间那一层）。
 *
 * 它只干一件事：pi 是它的子进程，三根管子（stdin / stdout / stderr）捏在它手里，
 * 一直读；后端通过一条本机连接连上来，请它代转。后端自己去编译、重启、换人，pi 都不动，
 * 新的后端连上来接着跟同一只 pi 说话。
 *
 * 为什么非得有这么一层：pi 只会用 stdin / stdout 说话，管道是"创建那一刻"交给谁的，
 * 之后没法转手（Windows 上尤其），而且 stdin 一断 pi 就自己退（正在跑的那一轮一并中止）。
 * 所以必须有一个进程一直拿着它们 —— 那就是这里。
 *
 * 生命周期：
 *   - 由后端按需起（detached，所以后端退了它还活着），端口与口令写进 relay.json；
 *   - 后端正常收摊（Ctrl+C）时会发 shutdown：杀掉所有 pi，删掉地址文件，自己退；
 *   - 后端只是重启（「编译并重启」）：它不杀 pi、也不退，等新后端连回来；
 *   - 十分钟没人连、手里也没活着的 pi：自己收摊退出（别留野进程）。
 *
 * 用法（只由后端内部起）：node out/server/relayMain.js
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { appVersion } from "./appAssets";
import { makeLineSplitter, spawnPi } from "./piSpawn";
import type { RelayAddress, RelayEvent, RelayPiInfo, RelayRequest } from "./relayProtocol";
import { relayAddressFile } from "./serverPaths";

const VERSION = appVersion();

/** 缓存 pi 说过的话的上限（字节）：补发用，超了从老的开始丢。 */
const FRAME_BUDGET = 8 * 1024 * 1024;

/** 没人连了，再等多久就自己收摊（重启一般几十秒，留足余量）。 */
const IDLE_EXIT_MS = 10 * 60 * 1000;
/** 多久看一次"还没人连吗"。 */
const IDLE_CHECK_MS = 30 * 1000;

/** 中转手里的一只 pi。 */
interface PiEntry {
    key: string;
    pid: number;
    child: ReturnType<typeof spawnPi>;
    cwd: string;
    startedAt: number;
    panelId?: string;
    sessionFile?: string;
    /** 这个进程已经用掉的请求编号（看到的 `req-N` 里最大的那个） */
    maxReq: number;
    alive: boolean;
    exitCode: number | null;
}

/** 缓存里的一行 pi 输出。 */
interface CachedFrame {
    seq: number;
    key: string;
    ch: "out" | "err";
    line: string;
    /** 占多少缓存（行本身 + 一点固定开销） */
    bytes: number;
}

const entries = new Map<string, PiEntry>();
const frames: CachedFrame[] = [];
let frameBytes = 0;
let seqCounter = 0;
let token = "";

/** 现在连着的中转使用方（后端）有几个。 */
const clients = new Set<net.Socket>();
let lastClientGoneAt = Date.now();

function log(text: string): void {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    console.log(`[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${text}`);
}

// ========================================================================
//  缓存：pi 说过的话（按序号存一段，新后端要补发时照着念）
// ========================================================================

function remember(key: string, ch: "out" | "err", line: string): number {
    const seq = ++seqCounter;
    const bytes = line.length + 64;
    frames.push({ seq, key, ch, line, bytes });
    frameBytes += bytes;
    while (frameBytes > FRAME_BUDGET && frames.length > 0) {
        const old = frames.shift()!;
        frameBytes -= old.bytes;
    }
    return seq;
}

// ========================================================================
//  跟 pi 说话
// ========================================================================

/** 记下这个进程发出去的命令用到了第几号请求（换后端时新后端要接着往下数）。 */
function noteRequestId(key: string, line: string): void {
    // 只要不是 extension_ui_response 就行：那是 pi 自己的编号，跟请求应答不是一套
    if (line.indexOf("\"id\"") === -1) { return; }
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== "object" || msg.type === "extension_ui_response") { return; }
    const id = typeof msg.id === "string" ? msg.id : "";
    const m = /^req-(\d+)$/.exec(id);
    if (!m) { return; }
    const entry = entries.get(key);
    const n = Number(m[1]);
    if (entry && Number.isFinite(n) && n > entry.maxReq) { entry.maxReq = n; }
}

function info(entry: PiEntry): RelayPiInfo {
    return {
        key: entry.key,
        pid: entry.pid,
        cwd: entry.cwd,
        ...(entry.panelId ? { panelId: entry.panelId } : {}),
        ...(entry.sessionFile ? { sessionFile: entry.sessionFile } : {}),
        startedAt: entry.startedAt,
        maxReq: entry.maxReq,
    };
}

function broadcast(ev: RelayEvent): void {
    const line = JSON.stringify(ev) + "\n";
    for (const socket of clients) {
        try { socket.write(line); } catch { /* 这条断了，它自己会走 close */ }
    }
}

function spawnOne(key: string, spec: Parameters<typeof spawnPi>[0]): PiEntry {
    const child = spawnPi(spec);
    const entry: PiEntry = {
        key,
        pid: child.pid ?? 0,
        child,
        cwd: spec.cwd,
        startedAt: Date.now(),
        maxReq: 0,
        alive: true,
        exitCode: null,
    };
    entries.set(key, entry);

    // stdout：一行一条 JSONL。一直读（不读会堵住 pi 的输出；关掉读端 pi 会崩）。
    const splitOut = makeLineSplitter();
    child.stdout.on("data", (chunk: Buffer) => {
        splitOut(chunk.toString("utf8"), (line) => {
            if (!line.trim()) { return; }
            const seq = remember(key, "out", line);
            broadcast({ ev: "frame", seq, key, ch: "out", line });
        });
    });
    // stderr：pi 自己的日志 + 我们那几个桥接扩展的一次性暗号（第三笔会搬走，这一笔照旧转给后端）
    const splitErr = makeLineSplitter();
    child.stderr.on("data", (chunk: Buffer) => {
        splitErr(chunk.toString("utf8"), (line) => {
            const seq = remember(key, "err", line);
            broadcast({ ev: "frame", seq, key, ch: "err", line });
        });
    });
    child.stdin.on("error", () => { /* 写不进去就算了：exit 那边会收尾 */ });
    child.on("error", (err) => {
        log(`pi 起不来（${key}）：${err && err.message ? err.message : err}`);
        noteExit(entry, -1);
    });
    child.on("exit", (code) => noteExit(entry, code));
    log(`起了 pi（${key}，进程 ${entry.pid}，目录 ${spec.cwd}）`);
    return entry;
}

function noteExit(entry: PiEntry, code: number | null): void {
    if (!entry.alive) { return; }
    entry.alive = false;
    entry.exitCode = code;
    log(`pi 退了（${entry.key}，进程 ${entry.pid}，code=${code}）`);
    broadcast({ ev: "exit", key: entry.key, code });
    // 进程没了就没法再接管它：登记表里删掉（它说过的话还留在缓存里，别的会话不受影响）
    entries.delete(entry.key);
}

/** 让 pi 自己收摊：先关 stdin（pi 会干净退出），再兜底杀掉（它不理就硬来）。 */
function killOne(entry: PiEntry): void {
    try { entry.child.stdin.end(); } catch { /* 已经没了 */ }
    try { entry.child.kill(); } catch { /* 已经没了 */ }
}

function killAll(): void {
    for (const entry of Array.from(entries.values())) { killOne(entry); }
}

// ========================================================================
//  地址文件
// ========================================================================

function writeAddress(port: number): void {
    const file = relayAddressFile();
    const addr: RelayAddress = {
        app: "pichat-relay",
        version: VERSION,
        pid: process.pid,
        port,
        token,
        startedAt: Date.now(),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(addr, null, 2) + "\n", "utf8");
}

function clearAddress(): void {
    try { fs.unlinkSync(relayAddressFile()); } catch { /* 本来就不在 */ }
}

// ========================================================================
//  收摊
// ========================================================================

let stopping = false;
function shutdown(reason: string): void {
    if (stopping) { return; }
    stopping = true;
    log(`收摊（${reason}）`);
    killAll();
    clearAddress();
    for (const socket of clients) { try { socket.destroy(); } catch { /* 已经断了 */ } }
    // 给 pi 一点时间自己退（stdin 关了它们会走干净的退出），然后走人
    setTimeout(() => process.exit(0), 300);
}

// ========================================================================
//  一条连接：后端连上来（可能同时有两条：换人的那一刻旧的还没断）
// ========================================================================

function serve(socket: net.Socket): void {
    let authed = false;
    const split = makeLineSplitter();

    const answer = (ev: RelayEvent) => {
        try { socket.write(JSON.stringify(ev) + "\n"); } catch { /* 断了 */ }
    };

    socket.on("data", (chunk: Buffer) => {
        split(chunk.toString("utf8"), (line) => {
            if (!line.trim()) { return; }
            let msg: RelayRequest;
            try { msg = JSON.parse(line) as RelayRequest; } catch {
                log("收到一条读不懂的话，丢掉");
                return;
            }
            if (!authed) {
                if (msg.op !== "hello" || msg.token !== token) {
                    answer({ ev: "hello", ok: false, reason: "口令不对" });
                    socket.destroy();
                    return;
                }
                authed = true;
                clients.add(socket);
                log("后端连上了");
                answer({ ev: "hello", ok: true, version: VERSION, pi: Array.from(entries.values()).map(info) });
                return;
            }
            handle(socket, msg, answer);
        });
    });

    socket.on("error", () => { /* 断就断了 */ });
    socket.on("close", () => {
        if (clients.delete(socket)) {
            lastClientGoneAt = Date.now();
            log("后端断了（pi 照旧留着）");
        }
    });
}

function handle(
    socket: net.Socket,
    msg: RelayRequest,
    answer: (ev: RelayEvent) => void,
): void {
    switch (msg.op) {
        case "hello":
            // 已经握过手了：再说一次也就是"我还活着"
            answer({ ev: "hello", ok: true, version: VERSION, pi: Array.from(entries.values()).map(info) });
            return;
        case "list":
            answer({ ev: "reply", n: msg.n, ok: true, keys: Array.from(entries.values()).map(info) });
            return;
        case "spawn": {
            try {
                const entry = spawnOne(msg.key, msg.spec);
                answer({ ev: "reply", n: msg.n, ok: true, pi: info(entry) });
            } catch (err: any) {
                answer({ ev: "reply", n: msg.n, ok: false, reason: `起不了 pi：${err?.message ?? String(err)}` });
            }
            return;
        }
        case "attach": {
            const entry = entries.get(msg.key);
            if (!entry || !entry.alive) {
                answer({ ev: "reply", n: msg.n, ok: false, reason: "这只 pi 已经不在了" });
                return;
            }
            if (msg.replay !== false) {
                const since = typeof msg.since === "number" ? msg.since : 0;
                for (const frame of frames) {
                    if (frame.key === msg.key && frame.seq > since) {
                        answer({ ev: "frame", seq: frame.seq, key: frame.key, ch: frame.ch, line: frame.line });
                    }
                }
            }
            answer({ ev: "reply", n: msg.n, ok: true, pi: info(entry), maxReq: entry.maxReq });
            return;
        }
        case "send": {
            const entry = entries.get(msg.key);
            if (!entry || !entry.alive) { return; }
            noteRequestId(msg.key, msg.line);
            try { entry.child.stdin.write(msg.line + "\n"); } catch { /* 写不进去就算了 */ }
            return;
        }
        case "label": {
            const entry = entries.get(msg.key);
            if (!entry) { return; }
            if (msg.panelId !== undefined) { entry.panelId = msg.panelId; }
            if (msg.sessionFile !== undefined) { entry.sessionFile = msg.sessionFile; }
            if (msg.cwd !== undefined) { entry.cwd = msg.cwd; }
            return;
        }
        case "kill": {
            const entry = entries.get(msg.key);
            if (entry) { killOne(entry); }
            return;
        }
        case "shutdown":
            shutdown("后端要求全收");
            return;
        default:
            answer({ ev: "reply", n: (msg as any).n ?? 0, ok: false, reason: `不认识的命令：${(msg as any).op}` });
    }
}

// ========================================================================
//  起服务
// ========================================================================

function main(): void {
    token = crypto.randomBytes(24).toString("hex");
    const server = net.createServer(serve);
    server.on("error", (err) => {
        log(`监听失败：${err && err.message ? err.message : err}`);
        process.exitCode = 1;
        process.exit();
    });
    // 只听本机：这一层只跟后端说话，别让局域网里的东西能凑上来
    server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = addr && typeof addr === "object" ? addr.port : 0;
        if (!port) {
            log("没拿到端口，退出");
            process.exit(1);
            return;
        }
        writeAddress(port);
        log(`中转在这儿：127.0.0.1:${port}（进程 ${process.pid}）`);
    });

    // 没人连、也没活着的 pi：自己收摊，别留野进程
    setInterval(() => {
        if (stopping) { return; }
        if (clients.size > 0) { return; }
        if (entries.size > 0) { return; }
        if (Date.now() - lastClientGoneAt < IDLE_EXIT_MS) { return; }
        shutdown("十分钟没人连");
    }, IDLE_CHECK_MS).unref();

    process.on("SIGINT", () => shutdown("收到 SIGINT"));
    process.on("SIGTERM", () => shutdown("收到 SIGTERM"));
}

main();

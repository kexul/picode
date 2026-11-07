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
import * as http from "http";
import * as net from "net";
import * as path from "path";
import { appVersion } from "./appAssets";
import { makeLineSplitter, spawnPi } from "./piSpawn";
import type { RelayAddress, RelayEvent, RelayPiInfo, RelayRequest } from "./relayProtocol";
import { RELAY_REPLY_KINDS } from "./relayProtocol";
import { relayAddressFile } from "./serverPaths";

const VERSION = appVersion();

/** 缓存 pi 说过的话的上限（字节）：补发用，超了从老的开始丢。 */
const FRAME_BUDGET = 8 * 1024 * 1024;

/**
 * 没人连了，再等多久就自己收摊（重启一般几十秒，留足余量）。
 * 到点连 pi 一起收：后端没回来（编译挂了、人把终端关了）还留着 pi 就是野进程了。
 */
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
    /** 最后一条已经交给过某个后端的输出序号（换后端时从这里往后补） */
    lastSeen: number;
    /** 正在长的那条助手消息从第几条开始（没提交的消息没有历史可重画，得从这儿补回去） */
    messageStartSeq?: number;
    /** 它那条消息的编号（收尾时认一下是不是同一条） */
    messageId?: string;
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

/** 桥接扩展上报的一件事（派子活 / 提问 / 后台命令 / 加载了什么）。 */
interface BridgeEvent {
    seq: number;
    key: string;
    kind: string;
    /** 桥自己起的幂等键（同一条重发只算一次） */
    id: string;
    payload: Record<string, unknown>;
    /** 要回执的那种（ask / taba）才有 */
    replyId?: string;
    /** 回执已经有了（answer 里是答案） */
    answered: boolean;
    value?: unknown;
    at: number;
}

/** 最近这些事件记着（换后端时，还没答的那些要重推）。 */
const bridgeEvents = new Map<string, BridgeEvent>();
/** 事件最多记这么多条（老的单条就丢；还没答的不丢）。 */
const EVENT_LIMIT = 500;

/** 正在等某个回执的那些 HTTP 长轮询。 */
const replyWaiters = new Map<string, Set<(ev: BridgeEvent) => void>>();

/** 事件 → 后端：连着的后端都收一份。 */
function broadcastEvent(ev: BridgeEvent): void {
    const line = JSON.stringify({
        ev: "bevent",
        seq: ev.seq,
        key: ev.key,
        kind: ev.kind,
        id: ev.id,
        payload: ev.payload,
        ...(ev.replyId ? { replyId: ev.replyId } : {}),
    }) + "\n";
    for (const socket of clients) {
        try { socket.write(line); } catch { /* 这条断了 */ }
    }
}

/** 收下一条事件：同一个桥的同一个编号只算一次。 */
function rememberEvent(key: string, kind: string, id: string, payload: Record<string, unknown>): BridgeEvent {
    const mapKey = key + "|" + id;
    const old = bridgeEvents.get(mapKey);
    if (old) { return old; }
    const ev: BridgeEvent = {
        seq: ++seqCounter,
        key,
        kind,
        id,
        payload,
        answered: false,
        at: Date.now(),
        ...(RELAY_REPLY_KINDS.has(kind) ? { replyId: "r-" + (seqCounter) } : {}),
    };
    bridgeEvents.set(mapKey, ev);
    // 老的单条就丢；还没答的一条都不丢（重发）—— 后端换人以后还得靠它把题再问一遍
    if (bridgeEvents.size > EVENT_LIMIT) {
        const drop = Array.from(bridgeEvents.entries())
            .filter(([, item]) => item.answered)
            .sort((a, b) => a[1].seq - b[1].seq);
        for (const [k] of drop.slice(0, bridgeEvents.size - EVENT_LIMIT)) {
            bridgeEvents.delete(k);
        }
    }
    return ev;
}

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

/**
 * 盯一下这条输出是不是"消息开始 / 结束"：正在长的那条助手消息还没落盘，
 * 历史里没有它 —— 换后端时只能从它开始的那一条补回去（见 attach）。
 */
function noteMessageWindow(entry: PiEntry, line: string, seq: number): void {
    if (line.indexOf('"message_start"') >= 0) {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        const m = msg && msg.message;
        if (m && m.role === "assistant") {
            entry.messageStartSeq = seq;
            entry.messageId = typeof m.id === "string" ? m.id : undefined;
        }
        return;
    }
    if (line.indexOf('"message_end"') >= 0) {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        const m = msg && msg.message;
        if (m && typeof m.id === "string" && m.id === entry.messageId) {
            entry.messageStartSeq = undefined;
            entry.messageId = undefined;
        }
    }
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
    // 桥接扩展（派子活 / 提问 / 后台命令 / 加载了什么）照这几个变量把事件报过来：
    // 报给中转，再由它转给后端（后端换人以后，还没答的那些会重推一遍）。
    const child = spawnPi({
        ...spec,
        env: {
            ...spec.env,
            PICHAT_RELAY_URL: eventUrl(),
            PICHAT_RELAY_TOKEN: token,
            PICHAT_PI_KEY: key,
        },
    });
    const entry: PiEntry = {
        key,
        pid: child.pid ?? 0,
        child,
        cwd: spec.cwd,
        startedAt: Date.now(),
        maxReq: 0,
        lastSeen: 0,
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
            noteMessageWindow(entry, line, seq);
            if (clients.size > 0) { entry.lastSeen = seq; }
            broadcast({ ev: "frame", seq, key, ch: "out", line });
        });
    });
    // stderr：pi 自己的日志 + 我们那几个桥接扩展的一次性暗号（第三笔会搬走，这一笔照旧转给后端）
    const splitErr = makeLineSplitter();
    child.stderr.on("data", (chunk: Buffer) => {
        splitErr(chunk.toString("utf8"), (line) => {
            const seq = remember(key, "err", line);
            if (clients.size > 0) { entry.lastSeen = seq; }
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

/** 事件口的地址（起 pi 时告诉桥接扩展）。 */
let eventPort = 0;
function eventUrl(): string {
    return eventPort > 0 ? "http://127.0.0.1:" + eventPort + "/" : "";
}

function writeAddress(port: number): void {
    const file = relayAddressFile();
    const addr: RelayAddress = {
        app: "pichat-relay",
        version: VERSION,
        pid: process.pid,
        port,
        eventPort,
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
//  事件口：pi 里的桥接扩展往这儿报事（本机 HTTP）
// ========================================================================

/** 一条请求的正文最多收多少（事件都是小 JSON）。 */
const MAX_EVENT_BYTES = 256 * 1024;

function readBody(req: http.IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve) => {
        let text = "";
        let tooBig = false;
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
            text += chunk;
            if (text.length > MAX_EVENT_BYTES) { tooBig = true; req.destroy(); }
        });
        req.on("end", () => resolve(tooBig ? undefined : text));
        req.on("error", () => resolve(undefined));
    });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    try {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(text);
    } catch { /* 对方已经断了 */ }
}

function serveEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const given = String(req.headers["x-pichat-token"] ?? url.searchParams.get("token") ?? "");
    if (given !== token) {
        sendJson(res, 403, { ok: false, reason: "口令不对" });
        return;
    }

    // 桥接扩展上报一件事
    if (req.method === "POST" && url.pathname === "/event") {
        void readBody(req).then((text) => {
            if (text === undefined) { sendJson(res, 413, { ok: false, reason: "内容太大" }); return; }
            let msg: any;
            try { msg = JSON.parse(text); } catch { sendJson(res, 400, { ok: false, reason: "不是 JSON" }); return; }
            const key = typeof msg?.key === "string" ? msg.key : "";
            const kind = typeof msg?.kind === "string" ? msg.kind : "";
            const id = typeof msg?.id === "string" ? msg.id : "";
            const payload = msg?.payload && typeof msg.payload === "object" ? msg.payload : {};
            if (!key || !kind || !id) { sendJson(res, 400, { ok: false, reason: "少了 key / kind / id" }); return; }

            // 桥不等了（超时 / 这一轮被停）：那道题从"还等着的"里摘掉，别再推给下一个后端
            if (kind === "ask-cancel") {
                const pending = bridgeEvents.get(key + "|" + id);
                if (pending) { pending.answered = true; }
                sendJson(res, 200, { ok: true });
                return;
            }

            const ev = rememberEvent(key, kind, id, payload);
            log(`收到桥上报的事件：${kind}（${key}），转给 ${clients.size} 个后端`);
            broadcastEvent(ev);
            sendJson(res, 200, { ok: true, ...(ev.replyId ? { replyId: ev.replyId } : {}) });
        });
        return;
    }

    // 桥等回执（长轮询）：答了就给答案，没答就等一会儿再问
    if (req.method === "GET" && url.pathname === "/reply") {
        const replyId = url.searchParams.get("replyId") ?? "";
        const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 20000) || 20000, 0), 60000);
        const ev = Array.from(bridgeEvents.values()).find((item) => item.replyId === replyId);
        if (!ev) { sendJson(res, 404, { state: "unknown" }); return; }
        if (ev.answered) { sendJson(res, 200, { state: "answered", value: ev.value ?? null }); return; }
        let done = false;
        const finish = (hit: BridgeEvent) => {
            if (done) { return; }
            done = true;
            sendJson(res, 200, { state: "answered", value: hit.value ?? null });
        };
        const timer = setTimeout(() => {
            if (done) { return; }
            done = true;
            sendJson(res, 200, { state: "pending" });
        }, wait);
        let set = replyWaiters.get(replyId);
        if (!set) { set = new Set(); replyWaiters.set(replyId, set); }
        set.add((hit) => { clearTimeout(timer); finish(hit); });
        req.on("close", () => {
            clearTimeout(timer);
            const waiters = replyWaiters.get(replyId);
            if (waiters) { waiters.clear(); replyWaiters.delete(replyId); }
        });
        return;
    }

    sendJson(res, 404, { ok: false, reason: "没有这个地址" });
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
                // 从哪儿补：
                //   - 正在长的那条助手消息还没提交（历史里没有它）：从它的开头补，整段正文才接得上；
                //   - 没在长什么：从"上一个后端最后听到的那条"往后补，别把历史里已经画过的东西再来一遍。
                const from = typeof msg.since === "number"
                    ? msg.since
                    : (entry.messageStartSeq !== undefined ? entry.messageStartSeq - 1 : entry.lastSeen);
                for (const frame of frames) {
                    if (frame.key === msg.key && frame.seq > from) {
                        answer({ ev: "frame", seq: frame.seq, key: frame.key, ch: frame.ch, line: frame.line });
                    }
                }
            }
            // 这个进程还有没答的题（/ 还没受理的派活）：再推一遍，新后端把卡片照原样画出来
            for (const ev of bridgeEvents.values()) {
                if (ev.key !== msg.key || ev.answered) { continue; }
                if (!ev.replyId) { continue; }
                answer({
                    ev: "bevent",
                    seq: ev.seq,
                    key: ev.key,
                    kind: ev.kind,
                    id: ev.id,
                    payload: ev.payload,
                    replyId: ev.replyId,
                });
            }
            // 这些它都有了：下一次换后端从这儿往后补
            entry.lastSeen = seqCounter;
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
        case "reply": {
            const ev = Array.from(bridgeEvents.values()).find((item) => item.replyId === msg.replyId);
            if (!ev) { return; }
            ev.answered = true;
            ev.value = msg.value;
            const waiters = replyWaiters.get(msg.replyId);
            if (waiters) {
                replyWaiters.delete(msg.replyId);
                for (const fn of Array.from(waiters)) { fn(ev); }
            }
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
        // 事件口（pi 里的桥接扩展连它）：另开一个本机 HTTP 端口
        const eventServer = http.createServer(serveEvents);
        eventServer.on("error", (err) => log(`事件口没起来：${err && err.message ? err.message : err}`));
        eventServer.listen(0, "127.0.0.1", () => {
            const eaddr = eventServer.address();
            eventPort = eaddr && typeof eaddr === "object" ? eaddr.port : 0;
            writeAddress(port);
            log(`中转在这儿：127.0.0.1:${port}（事件口 ${eventPort}，进程 ${process.pid}）`);
        });
    });

    // 没人连、也没活着的 pi：自己收摊，别留野进程
    setInterval(() => {
        if (stopping) { return; }
        if (clients.size > 0) { return; }
        if (Date.now() - lastClientGoneAt < IDLE_EXIT_MS) { return; }
        shutdown("十分钟没人连（连 pi 一起收）");
    }, IDLE_CHECK_MS).unref();

    process.on("SIGINT", () => shutdown("收到 SIGINT"));
    process.on("SIGTERM", () => shutdown("收到 SIGTERM"));
}

main();

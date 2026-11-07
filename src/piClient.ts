/**
 * 封装一只 `pi --mode rpc` 进程：JSONL 协议的读写 + 在途请求。
 *
 * 走哪条路起 pi，看后端起手时有没有拿到「中转」（见 relayClient.ts）：
 *   - 有中转：把起 pi 的活交给它，这里只跟它说话。后端自己重启、换人，pi 都不动，
 *     新的后端连上中转就能接着跟同一只 pi 说话（这是「编译并重启不掐 pi」的全部机关）。
 *   - 没有中转（中转起不来、或者调试时显式关掉）：自己 spawn，跟以前一样。
 * 两条路对外一模一样：start / send / request / stop 与那几种事件都不变。
 *
 * 事件：
 *   - "event"    (evt)   pi 发出的 agent 事件
 *   - "response" (resp)  未被 request() 认领的命令响应（如无 id 的错误）
 *   - "ui"       (req)   extension_ui_request
 *   - "stderr"   (text)  pi 的 stderr（一行一次；暗号行也在这上面，由上层切帧）
 *   - "error"    (err)   起不来 / 解析失败
 *   - "exit"     (code)  进程退出（或中转那头断了）
 *
 * 带 id 的请求统一走 request()：pending 回调只活在本类，避免与 SessionRuntime 双份状态。
 */
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { quoteArgForWindowsShell, spawnPi, type PiSpawnSpec } from "./piSpawn";
import { relayLink, type RelayLink } from "./relayClient";
import type { RpcCommand, RpcResponse } from "./piRpc";

export { quoteArgForWindowsShell };

export interface PiClientOptions {
    piPath: string;
    cwd: string;
    provider?: string;
    model?: string;
    extraArgs?: string[];
    env?: NodeJS.ProcessEnv;
    /**
     * 接管一只正在跑的 pi（中转那边认的名字）：中转里已经有这只进程了，
     * 不再起新的。（重起后端以后把会话认回来时用，见 chatHost.restoreLiveSessions。）
     */
    adoptKey?: string;
}

/** 还没能写进 pi 的命令（中转那头还没接手 / 直连的进程还没起来）。 */
interface QueuedCall {
    cmd: Record<string, unknown>;
    /** request 才有：等回复的那个回调；没有就是 send */
    resolve?: (resp: RpcResponse | undefined) => void;
    /** 到点作废（跟调用时起算，跟以前一样） */
    timer?: ReturnType<typeof setTimeout>;
    expired?: boolean;
    /** 分到的请求编号（request 才有） */
    id?: string;
}

export class PiClient extends EventEmitter {
    private readonly opts: PiClientOptions;
    /** 中转那边认这个名字；接管别人的时候就是别人那个名字。 */
    private key: string;
    private state: "idle" | "starting" | "running" | "stopped" = "idle";
    private readonly pending = new Map<string, (resp: RpcResponse | undefined) => void>();
    private seq = 0;
    /** 还没写出去的命令，按调用顺序排着（见 deliver） */
    private queue: QueuedCall[] = [];
    /** 直连那条路的 pi 进程；走中转时是 undefined */
    private proc: ChildProcessWithoutNullStreams | null = null;
    private link?: RelayLink;
    private offFrame?: () => void;
    private offExit?: () => void;
    /**
     * 接管一只正在跑的 pi 时，先把它补发过来的那些行攒着（见 releaseReplay）。
     * 为什么要攒：新后端得先把历史画完（replayHistory），再接着画"正在长的这一条"，
     * 不然先到的字会被随后的整屏重画清掉。
     */
    private buffering = false;
    private bufferedFrames: Array<{ ch: "out" | "err"; line: string }> = [];

    constructor(opts: PiClientOptions) {
        super();
        this.opts = opts;
        this.key = opts.adoptKey ?? `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    // ---- 生命周期 ----

    start(): void {
        if (this.state === "starting" || this.state === "running") {
            return;
        }
        this.state = "starting";
        const link = relayLink();
        if (link) {
            this.link = link;
            this.startViaRelay(link);
            return;
        }
        this.startDirect();
    }

    /** 走中转：先挂好听筒，再请它起一只 / 接管一只。 */
    private startViaRelay(link: RelayLink): void {
        // 接管：中转会把它没听到的那些行补过来，先攒着，等上层把历史画完再放（见 releaseReplay）
        if (this.opts.adoptKey) { this.buffering = true; }
        this.offFrame = link.onFrame(this.key, (frame) => {
            if (frame.ch === "out") {
                this.handleLine(frame.line);
            } else {
                this.emit("stderr", frame.line + "\n");
            }
        });
        this.offExit = link.onExit(this.key, (code) => this.onGone(code));

        const ready: Promise<{ ok: boolean; reason?: string; maxReq?: number }> = this.opts.adoptKey
            ? link.attach(this.opts.adoptKey, { replay: true })
            : link.spawn(this.key, this.spawnSpec());
        void ready.then((result) => {
            if (this.state === "stopped") {
                // 等的这会儿上层已经把它关了（关会话、收摊）：别把它又当成活的
                return;
            }
            if (!result.ok) {
                this.onGone(null, result.reason ?? "pi 起不来");
                return;
            }
            // 接管别人的进程：请求编号要接着人家用过的往下数，别跟旧答复撞号
            if (typeof result.maxReq === "number") {
                this.seq = Math.max(this.seq, result.maxReq);
            }
            this.state = "running";
            this.flushQueue();
        });
    }

    /** 没有中转时自己起（跟以前一样）。 */
    private startDirect(): void {
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawnPi(this.spawnSpec());
        } catch (err: any) {
            this.onGone(null, err && err.message ? err.message : String(err));
            return;
        }
        this.proc = child;
        this.state = "running";
        this.attachJsonlReader(child.stdout, (line) => this.handleLine(line));
        // 子进程先没了、我们还在往它 stdin 里写：报出来的是 EPIPE。
        // 这个不用当回事（exit 回调会把在途请求和状态收尾），更不该让它变成未捕获异常。
        child.stdin.on("error", () => { /* 写不进去就算了 */ });
        child.stderr.on("data", (chunk: Buffer) => {
            this.emit("stderr", chunk.toString("utf8"));
        });
        child.on("error", (err) => { this.emit("error", err); });
        child.on("exit", (code) => {
            this.proc = null;
            this.onGone(code);
        });
        this.flushQueue();
    }

    /** 把起 pi 要的东西整理成一份（中转与直连都用它）。 */
    private spawnSpec(): PiSpawnSpec {
        const args = ["--mode", "rpc"];
        if (this.opts.provider) { args.push("--provider", this.opts.provider); }
        if (this.opts.model) { args.push("--model", this.opts.model); }
        if (this.opts.extraArgs && this.opts.extraArgs.length > 0) { args.push(...this.opts.extraArgs); }
        return {
            piPath: this.opts.piPath,
            args,
            cwd: this.opts.cwd,
            ...(this.opts.env ? { env: this.opts.env } : {}),
        };
    }

    /** 进程没了（自己退的 / 中转说它没了 / 连接断了）：收尾并告诉大家。 */
    private onGone(code: number | null, reason?: string): void {
        if (this.state === "stopped") { return; }
        this.state = "stopped";
        this.proc = null;
        if (reason) {
            this.emit("error", new Error(reason));
        }
        // 进程退出时立刻释放在途请求，避免挂到超时
        this.rejectAllPending();
        this.emit("exit", code);
    }

    isRunning(): boolean {
        return this.state === "running" || this.state === "starting";
    }

    /** 告诉中转这只是哪个会话（后端重启以后照它把会话认回来） */
    label(info: { panelId?: string; sessionFile?: string; cwd?: string }): void {
        this.link?.label(this.key, info);
    }

    // ---- 说话 ----

    /** 发送一条 JSONL 命令到 pi（fire-and-forget，如 prompt/abort）。 */
    send(cmd: Record<string, unknown>): void {
        if (this.state === "idle" || this.state === "stopped") {
            throw new Error("pi 进程未运行");
        }
        const call: QueuedCall = { cmd };
        this.queue.push(call);
        this.flushQueue();
    }

    /**
     * 带 id 的请求-响应。超时 / 进程不在 / 发送失败时返回 undefined。
     * 所有会话与 spare 池共用这一条路径。
     */
    request<T = unknown>(
        cmd: RpcCommand | Record<string, unknown>,
        timeoutMs = 15000
    ): Promise<RpcResponse<T> | undefined> {
        return new Promise((resolve) => {
            if (this.state === "idle" || this.state === "stopped") {
                resolve(undefined);
                return;
            }
            const call: QueuedCall = {
                cmd: cmd as Record<string, unknown>,
                resolve: (resp) => { resolve(resp as RpcResponse<T> | undefined); },
            };
            call.timer = setTimeout(() => {
                call.expired = true;
                if (call.id) {
                    this.pending.delete(call.id);
                }
                resolve(undefined);
            }, timeoutMs);
            this.queue.push(call);
            this.flushQueue();
        });
    }

    /** 把攒着的命令按顺序送出去（还没接手时一条都不送，等接手了再一起走）。 */
    private flushQueue(): void {
        if (this.state !== "running") { return; }
        const queued = this.queue;
        this.queue = [];
        for (const call of queued) {
            if (call.expired) { continue; }
            this.deliver(call);
        }
    }

    /** 真正写一行出去：请求在这一刻分编号，免得跟旧后端用过的撞上。 */
    private deliver(call: QueuedCall): void {
        const frame: Record<string, unknown> = call.resolve
            ? { ...call.cmd, id: `req-${++this.seq}` }
            : { ...call.cmd };
        if (call.resolve) {
            call.id = frame.id as string;
            this.pending.set(call.id, call.resolve);
        }
        const line = JSON.stringify(frame);
        try {
            if (this.link) {
                this.link.sendLine(this.key, line);
            } else if (this.proc) {
                this.proc.stdin.write(line + "\n");
            }
        } catch {
            if (call.id) { this.pending.delete(call.id); }
            if (call.timer) { clearTimeout(call.timer); }
            call.resolve?.(undefined);
        }
    }

    /** 等待进程真正就绪（首个 RPC 能成功响应）。进程退出/未启动时返回 false。 */
    async waitReady(timeoutMs = 30000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!this.isRunning()) {
                return false;
            }
            const resp = await this.request({ type: "get_state" }, 2000);
            if (resp && resp.success !== false) {
                return true;
            }
            await new Promise((r) => setTimeout(r, 300));
        }
        return false;
    }

    /**
     * 停掉这只 pi。
     * @param opts.keep 不要杀它，只是这边不听了（「编译并重启」时用：pi 留着，新后端接着用）
     */
    stop(opts?: { keep?: boolean }): void {
        const wasRunning = this.isRunning();
        this.state = "stopped";
        if (this.link) {
            if (!opts?.keep) { this.link.kill(this.key); }
            this.link.detach(this.key);
            this.link = undefined;
        }
        this.offFrame?.();
        this.offExit?.();
        this.offFrame = undefined;
        this.offExit = undefined;
        if (this.proc) {
            try { this.proc.stdin.end(); } catch { /* ignore */ }
            try { this.proc.kill(); } catch { /* ignore */ }
            this.proc = null;
        }
        this.buffering = false;
        this.bufferedFrames = [];
        this.rejectAllPending();
        if (wasRunning && !opts?.keep) { /* 进程退出的事件由 onGone / child.on("exit") 给 */ }
    }

    /**
     * 接管完成：把补发攒着的那些行按顺序放出去（上层这会儿已经把历史画完了）。
     * 放完就恢复"实时"：后面的行一到就交给上层。
     */
    releaseReplay(): void {
        if (!this.buffering) { return; }
        this.buffering = false;
        const frames = this.bufferedFrames;
        this.bufferedFrames = [];
        for (const frame of frames) {
            if (frame.ch === "err") {
                this.emit("stderr", frame.line);
                continue;
            }
            let msg: any;
            try {
                msg = JSON.parse(frame.line);
            } catch {
                continue;
            }
            this.dispatch(msg);
        }
    }

    /** 让所有在途 request 立刻以 undefined 结束。 */
    private rejectAllPending(): void {
        if (this.pending.size === 0) {
            return;
        }
        const cbs = Array.from(this.pending.values());
        this.pending.clear();
        for (const cb of cbs) {
            cb(undefined);
        }
    }

    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        let msg: any;
        try {
            msg = JSON.parse(trimmed);
        } catch {
            this.emit("error", new Error("无法解析 pi 输出: " + trimmed));
            return;
        }
        // 补发来的那些里面，只有"应答"必须当场交给等它的人（比如 waitReady 的 get_state）；
        // 其余（agent 事件、弹窗请求）攒到 releaseReplay 再按顺放出去。
        if (this.buffering && msg.type !== "response") {
            this.bufferedFrames.push({ ch: "out", line: trimmed });
            return;
        }
        this.dispatch(msg);
    }

    /** 把一行已经解析好的 pi 输出交出去。 */
    private dispatch(msg: any): void {
        switch (msg.type) {
            case "response": {
                const id = typeof msg.id === "string" ? msg.id : undefined;
                if (id && this.pending.has(id)) {
                    const cb = this.pending.get(id)!;
                    this.pending.delete(id);
                    cb(msg as RpcResponse);
                } else {
                    // 无匹配 pending：交给上层（例如无 id 的错误提示）
                    this.emit("response", msg);
                }
                break;
            }
            case "extension_ui_request":
                this.emit("ui", msg);
                break;
            default:
                this.emit("event", msg);
                break;
        }
    }

    /** 严格按 LF 切分 JSONL（不使用 readline，避免 U+2028/U+2029 问题）。 */
    private attachJsonlReader(
        stream: NodeJS.ReadableStream,
        onLine: (line: string) => void
    ): void {
        const decoder = new StringDecoder("utf8");
        let buffer = "";

        stream.on("data", (chunk: Buffer | string) => {
            buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
            while (true) {
                const idx = buffer.indexOf("\n");
                if (idx === -1) {
                    break;
                }
                let l = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (l.endsWith("\r")) {
                    l = l.slice(0, -1);
                }
                onLine(l);
            }
        });

        stream.on("end", () => {
            buffer += decoder.end();
            if (buffer.length > 0) {
                onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
            }
        });
    }
}

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";
import type { RpcCommand, RpcResponse } from "./piRpc";

export interface PiClientOptions {
    piPath: string;
    cwd: string;
    provider?: string;
    model?: string;
    extraArgs?: string[];
    env?: NodeJS.ProcessEnv;
}

/**
 * 封装 `pi --mode rpc` 子进程，处理 JSONL 协议的读写。
 *
 * 事件：
 *   - "event"    (evt)   pi 发出的 agent 事件
 *   - "response" (resp)  未被 request() 认领的命令响应（如无 id 的错误）
 *   - "ui"       (req)   extension_ui_request
 *   - "error"    (err)   进程/解析错误
 *   - "exit"     (code)  进程退出
 *
 * 带 id 的请求统一走 request()：pending 回调只活在本类，避免与 SessionRuntime 双份状态。
 */
export class PiClient extends EventEmitter {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private opts: PiClientOptions;
    private pending = new Map<string, (resp: RpcResponse | undefined) => void>();
    private seq = 0;

    constructor(opts: PiClientOptions) {
        super();
        this.opts = opts;
    }

    start(): void {
        if (this.proc) {
            return;
        }
        const args = ["--mode", "rpc"];
        if (this.opts.provider) {
            args.push("--provider", this.opts.provider);
        }
        if (this.opts.model) {
            args.push("--model", this.opts.model);
        }
        if (this.opts.extraArgs && this.opts.extraArgs.length > 0) {
            args.push(...this.opts.extraArgs);
        }

        // Windows 下 pi 通常是 .cmd 脚本，需要 shell 才能正确解析
        const isWindows = process.platform === "win32";
        this.proc = spawn(this.opts.piPath, args, {
            cwd: this.opts.cwd,
            env: { ...process.env, ...this.opts.env },
            shell: isWindows,
        }) as ChildProcessWithoutNullStreams;

        this.attachJsonlReader(this.proc.stdout, (line) => this.handleLine(line));

        this.proc.stderr.on("data", (chunk: Buffer) => {
            this.emit("stderr", chunk.toString("utf8"));
        });

        this.proc.on("error", (err) => {
            this.emit("error", err);
        });

        this.proc.on("exit", (code) => {
            this.proc = null;
            // 进程退出时立刻释放在途请求，避免挂到超时
            this.rejectAllPending();
            this.emit("exit", code);
        });
    }

    isRunning(): boolean {
        return this.proc !== null;
    }

    /** 发送一条 JSONL 命令到 pi（fire-and-forget，如 prompt/abort）。 */
    send(cmd: Record<string, unknown>): void {
        if (!this.proc) {
            throw new Error("pi 进程未运行");
        }
        this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    }

    /**
     * 带 id 的请求-响应。超时 / 进程不在 / 发送失败时返回 undefined。
     * 所有 tab 与 spare 池共用这一条路径。
     */
    request<T = unknown>(
        cmd: RpcCommand | Record<string, unknown>,
        timeoutMs = 15000
    ): Promise<RpcResponse<T> | undefined> {
        return new Promise((resolve) => {
            if (!this.proc) {
                resolve(undefined);
                return;
            }
            const id = `req-${++this.seq}`;
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    resolve(undefined);
                }
            }, timeoutMs);
            const cb = (resp: RpcResponse | undefined) => {
                clearTimeout(timer);
                this.pending.delete(id);
                resolve(resp as RpcResponse<T> | undefined);
            };
            this.pending.set(id, cb);
            try {
                this.proc.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
            } catch {
                this.pending.delete(id);
                clearTimeout(timer);
                resolve(undefined);
            }
        });
    }

    /** 等待进程真正就绪（首个 RPC 能成功响应）。进程退出/未启动时返回 false。 */
    async waitReady(timeoutMs = 30000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!this.proc) {
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

    stop(): void {
        if (this.proc) {
            try {
                this.proc.stdin.end();
            } catch {
                /* ignore */
            }
            this.proc.kill();
            this.proc = null;
        }
        this.rejectAllPending();
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

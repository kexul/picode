import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";

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
 *   - "response" (resp)  命令响应
 *   - "ui"       (req)   extension_ui_request
 *   - "error"    (err)   进程/解析错误
 *   - "exit"     (code)  进程退出
 */
export class PiClient extends EventEmitter {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private opts: PiClientOptions;
    /** 备用池探测用：id → 回调（池子里的进程没有 SessionRuntime，需要自己的 request 机制）。 */
    private pending = new Map<string, (resp: any) => void>();
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

        // stderr 用于诊断
        this.proc.stderr.on("data", (chunk: Buffer) => {
            this.emit("stderr", chunk.toString("utf8"));
        });

        this.proc.on("error", (err) => {
            this.emit("error", err);
        });

        this.proc.on("exit", (code) => {
            this.proc = null;
            this.emit("exit", code);
        });
    }

    isRunning(): boolean {
        return this.proc !== null;
    }

    /** 发送一条 JSONL 命令到 pi。 */
    send(cmd: Record<string, unknown>): void {
        if (!this.proc) {
            throw new Error("pi 进程未运行");
        }
        this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    }

    /** 带 id 的请求（供备用池探测就绪用；普通 tab 的请求走 SessionRuntime.request）。 */
    request(cmd: Record<string, unknown>, timeoutMs = 15000): Promise<any> {
        return new Promise((resolve) => {
            if (!this.proc) {
                resolve(undefined);
                return;
            }
            const id = `spare-${++this.seq}`;
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    resolve(undefined);
                }
            }, timeoutMs);
            const cb = (resp: any) => {
                clearTimeout(timer);
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                }
                resolve(resp);
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
    }

    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        let msg: any;
        try {
            msg = JSON.parse(trimmed);
        } catch (e) {
            this.emit("error", new Error("无法解析 pi 输出: " + trimmed));
            return;
        }
        switch (msg.type) {
            case "response":
                // 备用池探测的响应直接回调；其余交给上层（SessionRuntime）处理
                if (msg.id && this.pending.has(msg.id)) {
                    const cb = this.pending.get(msg.id)!;
                    this.pending.delete(msg.id);
                    cb(msg);
                } else {
                    this.emit("response", msg);
                }
                break;
            case "extension_ui_request":
                this.emit("ui", msg);
                break;
            default:
                // 其余均视为 agent 事件
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

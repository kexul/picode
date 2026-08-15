import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";

export interface OneShotReviewOptions {
    /** pi 可执行文件路径。 */
    piPath: string;
    /** 子进程工作目录。 */
    cwd: string;
    /** 显式模型串（形如 "provider/model" 或 "provider/model:thinking"），走单个 --model。 */
    modelPattern?: string;
    /** 回落模型（无 modelPattern 时用）：与 tab 一致的 provider / modelId 分参传法。 */
    provider?: string;
    modelId?: string;
    /** 是否附加 --approve（跟随 trustProject 设置）。 */
    approve?: boolean;
}

/**
 * One-shot 评审进程：spawn `pi --mode json`，prompt 走 stdin，
 * 解析 JSONL 事件流回传增量与进度。
 *
 * 事件：
 *   - "delta"    (text: string)   正文增量（评审文本，打字机效果）
 *   - "thinking" ()               思考增量（用于“思考中…Ns”进度提示）
 *   - "stderr"   (text: string)   stderr 增量
 *   - "error"    (err: Error)     spawn / 管道错误
 *   - "exit"     (code: number | null, fullText: string)  进程退出
 *
 * 打印式一次性调用：无 session 文件、无上下文累积，跑完即退。
 */
export class OneShotReview extends EventEmitter {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private textBuf = "";

    constructor(private readonly opts: OneShotReviewOptions) {
        super();
    }

    /** 发起评审：spawn pi --mode json 并把组合好的 prompt 喂入 stdin。 */
    start(prompt: string): void {
        if (this.proc) { return; }
        const args = ["--mode", "json"];
        if (this.opts.modelPattern) {
            args.push("--model", this.opts.modelPattern);
        } else if (this.opts.modelId) {
            if (this.opts.provider) { args.push("--provider", this.opts.provider); }
            args.push("--model", this.opts.modelId);
        }
        if (this.opts.approve) { args.push("--approve"); }

        // Windows 下 pi 通常是 .cmd 脚本，需要 shell 才能解析（与 PiClient 一致）
        const isWindows = process.platform === "win32";
        const proc = spawn(this.opts.piPath, args, {
            cwd: this.opts.cwd,
            env: process.env,
            shell: isWindows,
        }) as ChildProcessWithoutNullStreams;
        this.proc = proc;

        try {
            proc.stdin.write(prompt);
            proc.stdin.end();
        } catch { /* ignore: 管道异常由 error 事件处理 */ }

        this.attachJsonlReader(proc.stdout, (line) => this.handleLine(line));

        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk: string) => {
            this.emit("stderr", chunk);
        });
        proc.on("error", (err) => {
            this.emit("error", err);
        });
        proc.on("exit", (code) => {
            this.proc = null;
            this.emit("exit", code, this.textBuf);
        });
    }

    isRunning(): boolean {
        return this.proc !== null;
    }

    /** 中止评审（杀进程）。 */
    abort(): void {
        if (!this.proc) { return; }
        try { this.proc.kill(); } catch { /* ignore */ }
        this.proc = null;
    }

    // ------------------------------------------------------------------

    /** 解析单行 JSONL 事件：只取正文/思考增量，其余忽略。 */
    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) { return; }
        let evt: any;
        try { evt = JSON.parse(trimmed); } catch { return; }
        if (evt.type !== "message_update" || !evt.assistantMessageEvent) { return; }
        const ame = evt.assistantMessageEvent;
        if (ame.type === "text_delta" && typeof ame.delta === "string" && ame.delta) {
            this.textBuf += ame.delta;
            this.emit("delta", ame.delta);
        } else if (ame.type === "thinking_delta") {
            this.emit("thinking");
        }
    }

    /** 严格按 LF 切分 JSONL（与 PiClient 同款，避免 U+2028/U+2029 问题）。 */
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
                if (idx === -1) { break; }
                let l = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (l.endsWith("\r")) { l = l.slice(0, -1); }
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

/**
 * pi 进程 stderr 上的"暗号行"：切行、按前缀认领、剩下的当普通输出打日志。
 *
 * 现在有两种暗号走这条路（一行的形状见 tabaProtocol.ts / askProtocol.ts 的说明）：
 *   taba   派子会话 / 停子会话（插件读到就去开 tab）
 *   ask    问用户一个选择题 / "不等了"的通知（插件读到就弹浮层、写回话文件）
 *
 * 为什么要共用这一个切割器：两种暗号混在同一条 stderr 上。各切各的话，对方那种暗号行
 * 会被当成"普通输出"打出来 —— 那是一大串 base64（问题/任务全文都在里面），日志会被刷没。
 *
 * 本文件不依赖 vscode。
 */

/** 一种暗号：名字 + 前缀 + 解码函数（解不出来就返回 undefined，那一行按普通输出处理）。 */
export interface FrameDecoder<K extends string, T> {
    kind: K;
    prefix: string;
    decode(line: string): T | undefined;
}

/** 认领下来的一帧：是哪种暗号、内容是什么。 */
export interface DecodedFrame<K extends string = string, T = unknown> {
    kind: K;
    value: T;
}

/** 积攒的半行最多留这么长，超了就丢掉（防止某个东西狂写 stderr 把内存吃光）。 */
const MAX_PENDING = 256 * 1024;
/** 普通输出行最多留这么多行（没人来取也不能无限攒）。 */
const MAX_OTHER_LINES = 200;

export class StderrFrameSplitter {
    private buffer = "";
    private otherLines: string[] = [];

    constructor(private readonly decoders: Array<FrameDecoder<string, unknown>>) {}

    /**
     * 喂一块 stderr，吐出这块里凑齐的那些暗号。
     * @param decoders 传进来的那一批解码器（一般不用传，构造时给过了）
     */
    public feed(chunk: string, decoders: Array<FrameDecoder<string, unknown>> = this.decoders): DecodedFrame[] {
        if (!chunk) { return []; }
        this.buffer += chunk;
        const out: DecodedFrame[] = [];
        while (true) {
            const idx = this.buffer.indexOf("\n");
            if (idx < 0) { break; }
            let line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            if (line.endsWith("\r")) { line = line.slice(0, -1); }
            let claimed = false;
            for (const decoder of decoders) {
                if (!line.includes(decoder.prefix)) { continue; }
                const value = decoder.decode(line);
                if (value !== undefined) {
                    out.push({ kind: decoder.kind, value });
                    claimed = true;
                    break;
                }
            }
            if (!claimed && line.trim()) {
                this.otherLines.push(line);
                if (this.otherLines.length > MAX_OTHER_LINES) { this.otherLines.shift(); }
            }
        }
        if (this.buffer.length > MAX_PENDING) {
            this.buffer = this.buffer.slice(this.buffer.length - MAX_PENDING);
        }
        return out;
    }

    /** 取走攒下的普通输出行（取完清空）。 */
    public takeOtherLines(): string[] {
        const lines = this.otherLines;
        this.otherLines = [];
        return lines;
    }
}

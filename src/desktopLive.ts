import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import { appBin } from "./appAssets";

/**
 * desktopLive —— 一直拍桌面的那一路（Windows）。
 *
 * 给网页端的「截图」按钮用：点一下是截一张（见 desktopScreenshot.ts），按住不放就是
 * 这一路——一直看着运行插件这台电脑的桌面，画面推到页面上铺满一层。
 *
 * 干活的是构建时编好的小程序（bin/live.exe，源码与来历见 bin/live.cs）：它一直待着，
 * 每隔一段时间拍一张、缩小、压成 JPEG，一帧一帧从标准输出吐出来。这儿只负责
 *   · 有人要看就把它起起来，没人看了就收掉（页面关掉弹窗 / 那块屏断了）；
 *   · 把那些帧拆出来，交给每一个要看的那块屏（几个人同时看也只拍一份）。帧是 JPEG 原样，
 *     转 base64 还是直接写字节由收的那一方自己定（面板那条包成消息，浏览器页面那条
 *     直接写进一条响应里，见 webChatServer.ts 的 /live）。
 *
 * 三个数是量出来的折中（512 长边 / 500 毫秒一张 / 质量 60）：一帧约 23 KB，
 * 一秒两张就是几十 KB，手机上看得起；512 边长足够看清窗口在哪、菜单开着没、进度条走到哪儿。
 * 画面没变的那一帧小程序不发（桌面大半时间是静的），所以真正在动的才吃流量。
 *
 * 其它系统上这一路没有（跟截图一样）：报一句「只在 Windows 上可用」，按钮该收的收。
 */

/** 缩小到长边这么多像素以内。 */
const LIVE_MAX_EDGE = 512;
/** 最快多久一张：一秒两张。 */
const LIVE_INTERVAL_MS = 500;
/** JPEG 质量（对 512 边长来说 60 已经看不清压缩痕迹）。 */
const LIVE_QUALITY = 60;
/** 停的时候等它自己退这么久，过了就杀掉。 */
const STOP_GRACE_MS = 1000;

/** 实时画面某一支的完整路径。 */
const LIVE_EXE = (): string => appBin("live.exe");

/** 推给页面的一帧：一张完整的 JPEG（原样，不转 base64——怎么送到页面由收帧的那一方决定）。 */
export interface DesktopLiveFrame {
    jpeg: Buffer;
}

/**
 * 把“4 字节大端长度 + JPEG 原文”接着来的那一路，拆成一帧一帧。
 *
 * 两支东西吐这种格式：本机这支小程序（bin/live.exe），以及别台后端那条 `/desk/live`
 * （它把同一支小程序吐的东西原样转出来）。所以拆帧只写这一份，两边各 new 一个用。
 */
export class JpegFrameSplitter {
    private pending: Buffer = Buffer.alloc(0);
    /** 读到的长度不对劲（流对不齐了）：调用方该把这一路整条重来。 */
    public broken = false;

    /** 喂一段数据，把里面收齐的那几帧交出去（JPEG 原文）。 */
    public push(chunk: Buffer, onFrame: (jpeg: Buffer) => void): void {
        if (this.broken) { return; }
        this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
        while (this.pending.length >= 4) {
            const length = this.pending.readUInt32BE(0);
            if (length <= 0 || length > 8 * 1024 * 1024) { this.broken = true; return; }
            if (this.pending.length < 4 + length) { return; }
            const jpeg = this.pending.subarray(4, 4 + length);
            this.pending = this.pending.subarray(4 + length);
            // JPEG 头是 FF D8（base64 里写成 /9j/）：不是的话这一帧不要
            if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) { continue; }
            onFrame(jpeg);
        }
    }
}

/** 一块要看实时画面的屏。 */
export interface DesktopLiveViewer {
    /** 来了一帧（一张完整的 JPEG）。 */
    onFrame: (frame: DesktopLiveFrame) => void;
    /** 这一路断了，没法再拍（原因原文）：那块屏该把这层收掉、说一句。 */
    onFail: (note: string) => void;
}

/** 这台机器能不能看桌面实时画面：只有 Windows 那支小程序。 */
export function desktopLiveSupported(): boolean {
    return process.platform === "win32" && fs.existsSync(LIVE_EXE());
}

/** 一直拍桌面：一块屏 addViewer 就开拍，最后一块 removeViewer 就停。 */
export class DesktopLive {
    private readonly viewers = new Map<string, DesktopLiveViewer>();
    private child?: ChildProcess;
    /** 标准输出是一段一段到的：拆帧那一份（跟别台转来的那条流共用）。 */
    private frames = new JpegFrameSplitter();
    /** 小程序自己说的失败原因（它退出时拿来报给页面）。 */
    private stderr = "";

    /** 现在有没有在拍。 */
    public get running(): boolean {
        return this.child !== undefined;
    }

    /** 这块屏要看实时画面。已经在拍的话直接跟着看，不用再起一支。 */
    public addViewer(pageId: string, viewer: DesktopLiveViewer): void {
        this.viewers.set(pageId, viewer);
        if (!this.child) { this.start(); }
    }

    /** 这块屏不看了（收了弹窗 / 连接断了）。一块都不剩就把小程序收掉。 */
    public removeViewer(pageId: string): void {
        this.viewers.delete(pageId);
        if (this.viewers.size === 0) { this.stop(); }
    }

    /** 全部停下来（后端要退了）。 */
    public stop(): void {
        this.viewers.clear();
        const child = this.child;
        this.child = undefined;
        this.frames = new JpegFrameSplitter();
        if (!child) { return; }
        // 把标准输入关掉它会自己退（见 bin/live.cs）；退不掉就掐掉，别留一支在后台一直拍
        try { child.stdin?.end(); } catch { /* 已经没了 */ }
        const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经没了 */ } }, STOP_GRACE_MS);
        timer.unref?.();
        child.once("exit", () => clearTimeout(timer));
    }

    /** 起一支小程序，把它的帧接过来。 */
    private start(): void {
        if (!desktopLiveSupported()) {
            this.fail("桌面实时画面目前只在 Windows 上可用。");
            return;
        }
        this.frames = new JpegFrameSplitter();
        this.stderr = "";
        const child = spawn(
            LIVE_EXE(),
            [String(LIVE_MAX_EDGE), String(LIVE_INTERVAL_MS), String(LIVE_QUALITY)],
            { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
        this.child = child;
        child.stdout?.on("data", (chunk: Buffer) => { this.readFrames(chunk); });
        child.stderr?.on("data", (chunk: Buffer) => {
            // 攒着：它是在退出前才写这一句的，报错的时候要用
            this.stderr = (this.stderr + chunk.toString("utf8")).slice(-2000);
        });
        child.on("error", (err) => {
            // 起不来（没这支小程序、被杀软拦下、没权限）
            this.forget(child);
            this.fail(`桌面实时画面起不来：${err.message}`);
        });
        child.on("exit", (code) => {
            // 被我们收掉的（this.child 已经不是它了）不算失败：那是关弹窗关掉的
            if (this.child !== child) { return; }
            this.forget(child);
            const note = this.stderr.trim() || `桌面实时画面断了（退出码 ${code ?? "?"}）。`;
            this.fail(note);
        });
    }

    /** 这一支已经不作数了：清掉，别再往它上面挂东西。 */
    private forget(child: ChildProcess): void {
        if (this.child !== child) { return; }
        this.child = undefined;
        this.frames = new JpegFrameSplitter();
        try { child.stdout?.removeAllListeners(); } catch { /* 已经没了 */ }
    }

    /** 收一帧算一帧（拆帧的规矩见 JpegFrameSplitter）：帧原样交给看着的那几方。 */
    private readFrames(chunk: Buffer): void {
        this.frames.push(chunk, (jpeg) => {
            const frame: DesktopLiveFrame = { jpeg };
            for (const viewer of this.viewers.values()) { viewer.onFrame(frame); }
        });
        if (!this.frames.broken) { return; }
        // 对上不齐（不该发生）：整支重来，别把后面的帧越读越歪
        this.stderr = "读到的帧长度不对劲。";
        try { this.child?.kill(); } catch { /* 已经没了 */ }
    }

    /** 这一路没法再拍了：告诉每一块看着的屏，然后把这一支收掉。 */
    private fail(note: string): void {
        const viewers = Array.from(this.viewers.values());
        this.stop();
        for (const viewer of viewers) { viewer.onFail(note); }
    }
}

/**
 * desktopNotice —— 右下角那张「有事」的提醒卡片（Windows）。
 *
 * 干什么：哪个会话跑完了一轮、或者模型在那儿等你答一句时，在这台机器右下角弹一张小卡片
 * （见 bin/notice.cs，一支只用系统自带 WinForms 的小程序）。没有通知区域图标、没有主界面：
 * 有事才起它，后端一走它跟着走。
 *
 * 卡片什么时候没：人点掉它、点右上角那颗 ×、那个会话里有人说上话了（见 ChatHost 的
 * onUserMessage）、那个会话被关掉了、那道选择题答完了。它自己不会到点消失。
 *
 * 点卡片做什么：把这件事交回宿主（onClick），由宿主打开那个会话的页面。
 *
 * 这台机器上弹不出来（不是 Windows、那支小程序没编出来、被杀软拦了）就一路静悄悄地不发，
 * 浏览器页面里照样看得到，不该为这个拦路。
 */
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import { appBin } from "./appAssets";

/** 画卡片那支小程序。 */
const NOTICE_EXE = (): string => appBin("notice.exe");

/** 这台机器能不能弹这张卡片：只有 Windows 上那支小程序。 */
export function desktopNoticeSupported(): boolean {
    return process.platform === "win32" && fs.existsSync(NOTICE_EXE());
}

/** 用系统默认浏览器打开地址（打不开也不影响什么）。 */
export function openInBrowser(url: string): void {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        spawn(command, cmdArgs, { detached: true, stdio: "ignore" }).unref();
    } catch { /* 打不开算了 */ }
}

export interface DesktopNoticeOptions {
    /** 日志出口。 */
    log: (text: string) => void;
    /** 人点了某一张（key 就是 show 时给的那个）。 */
    onClick: (key: string) => void;
}

/**
 * 那支小程序的一个把手。
 *
 * 第一条提醒来的时候才起它（平时没什么可画的，不必留一支在后台）。起来以后一直待着：
 * 不弹卡片的时候它就是个看不见的空壳，没有托盘图标、不进 Alt+Tab。
 * 后端收摊时把标准输入关掉，它自己退（后端意外被杀也一样：管道一断它就退）。
 */
export class DesktopNotice {
    private child?: ChildProcess;
    /** 起不来过（不是 Windows、exe 不在、被杀软拦下）：不再试，也不刷日志。 */
    private dead = false;
    /** 标准输出攒到这儿，一行一行拆（一段数据里可能是半行、也可能好几行）。 */
    private rest = "";

    constructor(private readonly options: DesktopNoticeOptions) {}

    /**
     * 弹一张。同一个标识的卡片只换不堆（后来那条顶掉旧的）。
     * @param tag 卡片左上角那颗小标签写的字（这台叫什么，空着就不挂标签）
     */
    public show(key: string, title: string, body: string, ask: boolean, tag = ""): void {
        this.write(["show", key, ask ? "1" : "0", base64(title), base64(body), base64(tag)].join("\t"));
    }

    /** 收走某一标识的那一张（没有就什么也不做）。 */
    public close(key: string): void {
        this.write("close\t" + key);
    }

    /** 后端要走了：把它也收掉（关了标准输入它自己退）。 */
    public dispose(): void {
        const child = this.child;
        this.child = undefined;
        if (!child) { return; }
        try { child.stdin?.end(); } catch { /* 已经没了 */ }
    }

    /** 写一行过去；还没起来就先把它起起来。 */
    private write(line: string): void {
        const child = this.ensure();
        if (!child) { return; }
        try {
            child.stdin?.write(line + "\n");
        } catch (err: any) {
            this.options.log(`[提醒] 那张卡片没写进去：${err?.message ?? String(err)}`);
        }
    }

    /** 起它（已经起来了就用手里这支）。起不来就认下来，以后不再试。 */
    private ensure(): ChildProcess | undefined {
        if (this.child) { return this.child; }
        if (this.dead) { return undefined; }
        if (!desktopNoticeSupported()) {
            this.dead = true;
            return undefined;
        }
        let child: ChildProcess;
        try {
            child = spawn(NOTICE_EXE(), [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        } catch (err: any) {
            this.dead = true;
            this.options.log(`[提醒] 那张卡片起不来（${NOTICE_EXE()}）：${err?.message ?? String(err)}`);
            return undefined;
        }
        this.child = child;
        this.rest = "";
        child.stdout?.on("data", (chunk: Buffer) => { this.read(chunk); });
        child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8").trim();
            if (text) { this.options.log(`[提醒] ${text}`); }
        });
        child.on("error", (err) => {
            // 起不来（exe 被删了、被杀软拦下、没权限）：这一台就别再试了
            if (this.child !== child) { return; }
            this.dead = true;
            this.forget(child);
            this.options.log(`[提醒] 那张卡片起不来：${err.message}`);
        });
        child.on("exit", (code) => {
            if (this.child !== child) { return; }
            this.forget(child);
            // 不是我们要它退的（那就当这支坏了，下一条提醒再起一支新的）
            if (code) { this.options.log(`[提醒] 那张卡片自己退了（退出码 ${code}），下一条再起。`); }
        });
        return child;
    }

    /** 这一支已经不作数了：清掉，别再往它上面挂东西。 */
    private forget(child: ChildProcess): void {
        if (this.child !== child) { return; }
        this.child = undefined;
        try { child.stdout?.removeAllListeners(); } catch { /* 已经没了 */ }
        try { child.stdin?.end(); } catch { /* 已经没了 */ }
    }

    /**
     * 收它说的话：一行一条 `click\t<标识>`（人点了卡片）。
     */
    private read(chunk: Buffer): void {
        this.rest += chunk.toString("utf8");
        let index = this.rest.indexOf("\n");
        while (index >= 0) {
            const line = this.rest.slice(0, index).replace(/\r$/, "");
            this.rest = this.rest.slice(index + 1);
            index = this.rest.indexOf("\n");
            const parts = line.split("\t");
            if (parts[0] === "click" && parts[1]) { this.options.onClick(parts[1]); }
        }
    }
}

/** 一段文字换成 base64（省得跟制表符、换行打架）。 */
function base64(text: string): string {
    return Buffer.from(text ?? "", "utf8").toString("base64");
}

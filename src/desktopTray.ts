/**
 * desktopTray —— 通知区域里那颗图标（Windows，见 bin/tray.cs）。
 *
 * 后端起来时把它放上去：右键菜单两项——「打开」（用浏览器打开这个页面）和「退出」
 * （后端按 Ctrl+C 那套收摊）；双击图标也是打开。终端里起的 pichat、双击 exe 起的后端都有它。
 *
 * 它不是右下角那张提醒卡片（那是 bin/notice.cs，有事才起、只管弹卡片）。
 *
 * 这支小程序没编出来（非 Windows、或者机器上没有 .NET Framework）就一路静悄悄地不发：
 * 后端照常跑，只是托盘里没有那颗图标。
 */
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import { appBin } from "./appAssets";

/** 托盘那支小程序（构建时编好，见 bin/tray.cs 与 scripts/compile.mjs）。 */
const TRAY_EXE = (): string => appBin("tray.exe");

/** 这台机器上能用托盘吗：Windows、而且小程序在。 */
export function desktopTraySupported(): boolean {
    if (process.platform !== "win32") { return false; }
    try { return fs.existsSync(TRAY_EXE()); } catch { return false; }
}

export interface DesktopTrayOptions {
    log: (text: string) => void;
    /** 人在托盘菜单里点了「打开」（或者双击了图标）。 */
    onOpen?: () => void;
    /** 人在托盘菜单里点了「退出」：后端该跟着收摊。 */
    onExit?: () => void;
}

/**
 * 那支小程序的一个把手。第一条消息来时才起它；起来以后一直待着。
 * 后端收摊时把标准输入关掉，它自己退（后端意外被杀也一样：管道一断它就退）。
 */
export class DesktopTray {
    private child?: ChildProcess;
    /** 起不来了（不是 Windows、exe 不在、被杀软拦下）：不再试，也不刷日志。 */
    private broken = false;
    /** 标准输出攒到这儿，一行一行拆（一段数据里可能是半行、也可能好几行）。 */
    private rest = "";
    /** 已经告诉过它的地址（一样的就不再发）。 */
    private lastUrl = "";

    constructor(private readonly options: DesktopTrayOptions) {}

    /** 把图标放上去，并告诉它页面在哪个地址（菜单里那颗「打开」用它决定能不能点）。 */
    public show(url: string | undefined): void {
        this.setUrl(url);
    }

    /** 网页服务的地址变了：告诉它一声（一样的就什么也不做）。 */
    public setUrl(url: string | undefined): void {
        const text = (url ?? "").trim();
        if (this.lastUrl === text) { return; }
        this.lastUrl = text;
        if (text.length === 0 || !this.start()) { return; }
        this.write(["url", flat(text)].join("\t"));
    }

    /**
     * 收摊：把 stdin 关掉（小程序读到结尾就自己退，图标跟着没），再把进程从“要等的活”里摘出去。
     * 不直接杀：它自己收图标更干净，退出路径上杀子进程也容易在关句柄时撞车。
     */
    public dispose(): void {
        const child = this.child;
        this.child = undefined;
        if (!child) { return; }
        try { child.stdin?.end(); } catch { /* 已经断了 */ }
        try { child.unref(); } catch { /* 已经没了 */ }
        const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经没了 */ } }, 2000);
        timer.unref?.();
    }

    /** 还没起就起一个；起不来（或已经收摊了）返回 false。 */
    private start(): boolean {
        if (this.child) { return true; }
        if (this.broken || !desktopTraySupported()) {
            this.broken = true;
            return false;
        }
        let child: ChildProcess;
        try {
            // stdout 要读：菜单里点「打开」「退出」时它往这儿写（见下面那段读）
            child = spawn(TRAY_EXE(), [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
        } catch (err: any) {
            this.broken = true;
            this.options.log(`[托盘] 起不来：${err?.message ?? String(err)}`);
            return false;
        }
        this.child = child;
        // 小程序是刚起的：上一次发过的地址对它来说还是新的，重发一遍
        if (this.lastUrl.length > 0) { this.write(["url", flat(this.lastUrl)].join("\t")); }
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            this.rest += chunk;
            let at = this.rest.indexOf("\n");
            while (at >= 0) {
                const line = this.rest.slice(0, at).trim();
                this.rest = this.rest.slice(at + 1);
                if (line === "open") {
                    try { this.options.onOpen?.(); } catch { /* 开页面出错不拦路 */ }
                } else if (line === "exit") {
                    try { this.options.onExit?.(); } catch { /* 收摊出错不拦路 */ }
                }
                at = this.rest.indexOf("\n");
            }
        });
        // 小程序自己没了（被结束、出错）：下一次要放图标时再起一个
        child.once("exit", () => {
            if (this.child === child) { this.child = undefined; }
        });
        child.stdin?.on("error", () => { /* 管道断了对写没有影响，下面 write 会吞掉 */ });
        return true;
    }

    private write(line: string): void {
        try { this.child?.stdin?.write(line + "\n"); } catch { /* 小程序没了就算了 */ }
    }
}

/** 一行协议里的一个字段：换行 / 制表符 / 回车都压成空格。 */
function flat(text: string): string {
    return text.replace(/[\t\r\n]+/g, " ").trim();
}

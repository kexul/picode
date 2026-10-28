/**
 * trayIcon —— 通知区域里那颗图标（Windows）。
 *
 * 后端起一个常驻的小程序（bin/tray.exe，源码与来历见 bin/tray.cs），由它把托盘图标端着：
 * 有事的时候闪，点它弹一份清单，点其中的一行切到那个会话。
 *
 * 为什么不在页面上发：以前靠浏览器通知，浏览器和 Windows 都会因为“发太多”把横幅收掉，
 * 而且只认 https 或本机地址（手机用局域网地址打开就发不出来），插件里的对话面板更是发不了。
 * 托盘图标是后端自己进程里的东西，不经过浏览器，也不受影响。
 *
 * 这不是 Windows 就什么都不做：`available()` 为假，调用方照常干活（只是没有托盘）。
 * 小程序没编出来（非 Windows 上构建的包、机器上没有 .NET Framework）也一样。
 */
import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import { appBin } from "./appAssets";

/** 托盘清单里的一行：哪个会话有事、它叫什么。 */
export interface TrayPendingItem {
    /** 会话标识；别的机器推来的那条是 `remote:<来源>:<会话标识>`。 */
    id: string;
    name: string;
    /** 别的机器推来的那条才有：点了要打开它那边的页面（本机的会话没有这个）。 */
    page?: string;
}

/** 人在托盘菜单里点的东西（都直接来自那颗小程序，见 bin/tray.cs 里的协议）。 */
export interface TrayHooks {
    /** 清单里点了一项：把界面切到那个会话。 */
    onPick?(id: string): void;
    /** 点了「打开页面」。 */
    onOpen?(): void;
    /** 点了「退出这颗图标」：这次后端活着期间不再冒出来。 */
    onQuit?(): void;
}

/** 托盘小程序（构建时编好，见 bin/tray.cs 与 scripts/compile.mjs）；打成单个 exe 时它内嵌在 exe 里。 */
const TRAY_EXE = (): string => appBin("tray.exe");

export class TrayIcon {
    /** 这台机器上能用托盘吗：Windows、而且小程序在。 */
    public static available(): boolean {
        if (process.platform !== "win32") { return false; }
        try { return fs.existsSync(TRAY_EXE()); } catch { return false; }
    }

    private child: ChildProcess | undefined;
    /** 小程序写回来的半行（管道不保证一次一行到位）。 */
    private buffer = "";
    /** 起不来了（被杀软拦下之类）：别再反复试。 */
    private broken = false;

    constructor(private readonly hooks: TrayHooks = {}) {}

    /**
     * 把整份清单重发一遍：小程序照这份清单画菜单，非空就闪、空就停。
     * 清单变了就调它，后端不用管小程序现在是什么状态。
     */
    public setPending(items: TrayPendingItem[]): void {
        if (this.broken) { return; }
        if (!this.start()) { return; }
        // 协议是一行、字段用制表符分开：名字里带换行 / 制表符会把这一行切坏，先压平
        const fields = ["list"];
        for (const item of items) {
            fields.push(flat(item.id), flat(item.name || "会话"));
        }
        this.write(fields.join("\t"));
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
        // 它要是赖着不走（读不到结尾那种），过一会儿再杀掉
        const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经没了 */ } }, 2000);
        timer.unref?.();
    }

    /** 还没起就起一个；起不来（或已经退出了）返回 false。 */
    private start(): boolean {
        if (this.child) { return true; }
        if (this.broken || !TrayIcon.available()) { return false; }
        let child: ChildProcess;
        try {
            child = spawn(TRAY_EXE(), [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
        } catch {
            this.broken = true;
            return false;
        }
        this.child = child;
        this.buffer = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => { this.onData(chunk); });
        // 小程序自己没了（被结束、出错）：下一次要发清单时再起一个
        child.once("exit", () => {
            if (this.child === child) { this.child = undefined; }
        });
        child.stdin?.on("error", () => { /* 管道断了对写没有影响，下面 write 会吞掉 */ });
        return true;
    }

    private write(line: string): void {
        try { this.child?.stdin?.write(line + "\n"); } catch { /* 小程序没了就算了 */ }
    }

    /** 小程序写回来的行：`pick\t会话标识` / `open` / `quit`。 */
    private onData(chunk: string): void {
        this.buffer += chunk;
        let at = this.buffer.indexOf("\n");
        while (at >= 0) {
            const line = this.buffer.slice(0, at).replace(/\r$/, "");
            this.buffer = this.buffer.slice(at + 1);
            this.onLine(line);
            at = this.buffer.indexOf("\n");
        }
    }

    private onLine(line: string): void {
        const parts = line.split("\t");
        switch (parts[0]) {
            case "pick":
                if (parts[1]) { this.hooks.onPick?.(parts[1]); }
                return;
            case "open":
                this.hooks.onOpen?.();
                return;
            case "quit":
                this.hooks.onQuit?.();
                return;
        }
    }
}

/** 一行协议里的一个字段：换行 / 制表符 / 回车都压成空格。 */
function flat(text: string): string {
    return text.replace(/[\t\r\n]+/g, " ").trim();
}

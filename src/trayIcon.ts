/**
 * trayIcon —— 通知区域里那颗图标和右下角那块提醒面板（Windows）。
 *
 * 后端起一个常驻的小程序（bin/tray.exe，源码与来历见 bin/tray.cs），由它把这两样端着：
 * 图标只是“它在跑”的招牌（那根竖线一直红着，点它什么也不弹）；有事就在右下角弹一张卡片，
 * 写着哪个会话、说了什么 —— 只是给人看一眼，点了也没反应。
 *
 * 为什么不在页面上发：以前靠浏览器通知，浏览器和 Windows 都会因为“发太多”把横幅收掉，
 * 而且只认 https 或本机地址（手机用局域网地址打开就发不出来），插件里的对话面板更是发不了。
 * 托盘和面板是后端自己进程里的东西，不经过浏览器，也不受影响。
 *
 * 这不是 Windows 就什么都不做：`available()` 为假，调用方照常干活（只是没有提醒）。
 * 小程序没编出来（非 Windows 上构建的包、机器上没有 .NET Framework）也一样。
 */
import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import { appBin } from "./appAssets";

/** 面板上弹的一条：哪个会话有事、它叫什么、说了什么。 */
export interface TrayNote {
    /** 会话标识；别的机器推来的那条是 `remote:<来源>:<会话标识>`。 */
    id: string;
    name: string;
    /** 面板上显示的摘要（一两行，后端已经截好）；没有就只显示名字。 */
    summary?: string;
    /** 面板上这一条算哪种事：跑完一轮 / 等你答一句。 */
    kind?: "done" | "ask";
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
    /** 起不来了（被杀软拦下之类）：别再反复试。 */
    private broken = false;

    /** 把图标放上去（后端起来时调一次；叫人弹之前也会自己起）。 */
    public show(): void {
        this.start();
    }

    /** 右下角那块面板上弹一条。 */
    public pop(item: TrayNote): void {
        if (!this.start()) { return; }
        const fields = [
            "pop",
            flat(item.id),
            flat(item.name || "会话"),
            flat(item.summary ?? ""),
            item.kind === "ask" ? "ask" : "done",
        ];
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
            child = spawn(TRAY_EXE(), [], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        } catch {
            this.broken = true;
            return false;
        }
        this.child = child;
        // 小程序自己没了（被结束、出错）：下一次要弹提醒时再起一个
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

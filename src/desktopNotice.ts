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
 * 点卡片做什么：把这件事交回宿主（onClick），由宿主叫连着的网页切到那个会话，又叫这边
 * 把开着那个页面的窗口提到前面（{@link DesktopNotice.raise}；两件事都见 ChatHost.openNotice）。
 * 提窗口只在真找得到那个窗口时发生：找不到就把这张收掉完事，不去新开浏览器。
 * （下面那个 openInBrowser 是另一回事：后端带 --open 起来时，给这台开一下页面。）
 *
 * 这台机器上弹不出来（不是 Windows、那支小程序没编出来、被杀软拦了）就一路静悄悄地不发，
 * 浏览器页面里照样看得到，不该为这个拦路。
 */
import { execFileSync, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { appBin } from "./appAssets";

/** 画卡片那支小程序。 */
const NOTICE_EXE = (): string => appBin("notice.exe");

/** 这台机器能不能弹这张卡片：只有 Windows 上那支小程序。 */
export function desktopNoticeSupported(): boolean {
    return process.platform === "win32" && fs.existsSync(NOTICE_EXE());
}

/**
 * 开这个网页：默认浏览器是 Chromium 系的话，开成「应用窗口」（没有标签条、没有地址栏，
 * 窗口里只有这一页）；其余情况交给系统默认浏览器开标签页。打不开也不影响什么。
 */
export function openInBrowser(url: string): void {
    const browser = findAppWindowBrowser();
    try {
        if (browser) {
            spawn(browser, ["--app=" + url], { detached: true, stdio: "ignore" }).unref();
            return;
        }
    } catch { /* 起不来就退回下面那条老路 */ }
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        spawn(command, cmdArgs, { detached: true, stdio: "ignore" }).unref();
    } catch { /* 打不开算了 */ }
}

/**
 * 吃 `--app=<地址>` 的那些浏览器：照 exe 的名字认。套壳的一般也叫 chrome.exe（比如 Helium），
 * 所以认名字就够了，不用一支支去试。
 */
const APP_WINDOW_EXES = new Set(["chrome.exe", "msedge.exe", "chromium.exe", "brave.exe", "vivaldi.exe", "thorium.exe"]);

/** 问过没有：undefined = 还没问过，null = 没有能开应用窗口的。 */
let appWindowBrowser: string | null | undefined;

/** 默认浏览器那支能不能开应用窗口：能就给出它的路径，不能就是 null。 */
function findAppWindowBrowser(): string | null {
    if (appWindowBrowser !== undefined) { return appWindowBrowser; }
    appWindowBrowser = null;
    // 只管 Windows（提醒卡片本身也只在 Windows 上有）；别的系统上退回开标签页那条路
    if (process.platform === "win32") {
        const exe = defaultBrowserExe();
        if (exe && APP_WINDOW_EXES.has(path.basename(exe).toLowerCase()) && fs.existsSync(exe)) {
            appWindowBrowser = exe;
        }
    }
    return appWindowBrowser;
}

/** 系统默认浏览器那支的路径（问注册表；问不出来给空串）。 */
function defaultBrowserExe(): string {
    const progId = regValue("HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice", "ProgId");
    if (!progId) { return ""; }
    const command = regValue("HKCR\\" + progId + "\\shell\\open\\command", "");
    if (!command) { return ""; }
    // 形如 `"C:\…\chrome.exe" --single-argument %1`
    const quoted = /^"([^"]+)"/.exec(command);
    return quoted ? quoted[1] : (command.split(/\s+/)[0] || "");
}

/** 读一个注册表值（读不到给空串）。 */
function regValue(key: string, value: string): string {
    try {
        const args = ["query", key, ...(value ? ["/v", value] : ["/ve"])];
        const text = execFileSync("reg", args, { encoding: "utf8", windowsHide: true, timeout: 4000 });
        const line = text.split(/\r?\n/).find((one) => /\s+REG_SZ\s+/.test(one));
        if (!line) { return ""; }
        const match = /\s+REG_SZ\s+/.exec(line);
        return line.slice((match ? match.index + match[0].length : 0)).trim();
    } catch {
        return "";
    }
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
    /**
     * 屏幕上现在有哪几张：真事实在那支小程序里（它自己会因点叉、三张挤掉最老而收卡），
     * 这里存一份镜像 —— 好让后端知道该不该写 close（没有那张还去写，会把已经退了的
     * 小程序又拉起来），也好把屏幕上这几张一下全收掉。
     * 键与顺序都跟那边一致：同一个标识再来一条是“换掉旧的”（删了再插到末尾），
     * 超过三张时挤掉最老的那张。
     */
    private readonly shown = new Map<string, { ask: boolean; title: string }>();
    /** 跟 bin/notice.cs 的 Hub.MaxCards 一个数：屏幕上最多同时几张。 */
    private static readonly MAX_CARDS = 3;

    constructor(private readonly options: DesktopNoticeOptions = { log: () => { /* 默认不记 */ }, onClick: () => { /* 默认不管 */ } }) {}

    /**
     * 弹一张。同一个标识的卡片只换不堆（后来那条顶掉旧的）。
     * @param tag 卡片左上角那颗小标签写的字（设置里那行「标签」，空着就不挂标签）
     */
    public show(key: string, title: string, body: string, ask: boolean, tag = ""): void {
        // 镜像先更新：同一个标识是“换掉旧的”（跟那边一样），超过三张挤掉最老的
        this.shown.delete(key);
        this.shown.set(key, { ask, title });
        while (this.shown.size > DesktopNotice.MAX_CARDS) {
            const oldest = this.shown.keys().next();
            if (oldest.done) { break; }
            this.shown.delete(oldest.value);
        }
        this.write(["show", key, ask ? "1" : "0", base64(title), base64(body), base64(tag)].join("\t"), true);
    }

    /**
     * 收走某一标识的那一张（屏幕上本来就没有就什么也不做）。
     *
     * “本来就没有”这一条是故意的：没有那张还写过去的话，write 会把已经退了的小程序
     * 又拉起来一支（它平时不在后台待着）。
     */
    public close(key: string): void {
        if (!this.shown.delete(key)) { return; }
        this.write("close\t" + key, false);
    }

    /** 把屏幕上还开着的全收掉（设置里关掉「弹窗通知」时用）。 */
    public closeAll(): void {
        if (this.shown.size === 0) { return; }
        this.shown.clear();
        this.write("closeall", false);
    }

    /**
     * 把一个窗口提到前面（在 Windows 上按窗口标题找）。人点了提醒卡片时用：
     * 那边叫网页切到那个会话，这边把开着那个页面的窗口提上来（见 ChatHost.openNotice）。
     *
     * 给的就是页面标题那一份（见 pageHtml 的 pageTitle）。找窗口的事在那支小程序里做
     * （Node 这边没有调 Windows 接口的路子），它的找法与提法见 bin/notice.cs 的 Raiser：
     * 标题正好相等（`--app=` 开的、「安装成应用」装出来的那种窗口），
     * 或者以「标题 + ` - `」开头（普通浏览器窗口，而那张贴在前面的就是它），
     * 先还原再提前面；多个都对得上时提 Z 序最上面那个。
     *
     * **找不到就什么也不做**（也不新开浏览器），这几种都找不到：页面没开着、
     * 页面只停在普通浏览器窗口的背景 tab 里（那种窗口的标题跟着活动的那张贴走，提不起来也认不出来）、
     * 页面只在插件的对话面板里开着。别台机器推来的那张卡片也一样：本机没有那个页面。
     *
     * 没弹过卡片就不起小程序（那会儿屏幕上本来也没东西要看）。
     */
    public raise(title: string): void {
        if (!title) { return; }
        this.write(["raise", base64(title)].join("\t"), false);
    }

    /** 屏幕上现在有哪几张（调试与验证用；键就是 show 时的那个）。 */
    public shownKeys(): string[] { return Array.from(this.shown.keys()); }

    /** 后端要走了：把它也收掉（关了标准输入它自己退）。 */
    public dispose(): void {
        this.shown.clear();
        const child = this.child;
        this.child = undefined;
        if (!child) { return; }
        try { child.stdin?.end(); } catch { /* 已经没了 */ }
    }

    /** 写一行过去。@param spawn 没起来时要不要现在把它起起来（只有 show 要）。 */
    private write(line: string, spawn: boolean): void {
        const child = spawn ? this.ensure() : this.child;
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
     * 收它说的话：一行一条。
     *   click\t<标识>    人点了那张卡片（后端据此叫开着的网页切过去）
     *   closed\t<标识>   那张自己没了（点了右上角那颗叉、或者三张挤掉最老）—— 后端那份镜像跟着删
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
            if (parts[0] === "closed" && parts[1]) { this.shown.delete(parts[1]); }
        }
    }
}

/** 一段文字换成 base64（省得跟制表符、换行打架）。 */
function base64(text: string): string {
    return Buffer.from(text ?? "", "utf8").toString("base64");
}

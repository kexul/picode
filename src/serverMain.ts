/**
 * pichat —— 独立后端的启动器。
 *
 * 跟 VSCode 一点关系都没有：在任意目录敲 `pichat`，它就在这里起一个网页服务，
 * 手机 / 电脑浏览器连上去就能对话；关掉所有 VSCode 窗口它也照样活着。
 *
 * 一个后端只跑一个（单实例）：地址记在 `~/.pi/pichat/server.json`，启动前先看有没有
 * 已经在跑的，有就打印它的地址然后退出；文件是上一个没收拾干净留下的（探不通）就接管。
 *
 * 参数：--cwd 会话目录、--port / --host 监听、--open 起完打开浏览器、--help / --version。
 * 设置文件的路径会打在屏幕上；配置项的默认值见 serverConfig.ts。
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { appVersion, isPackaged, mediaDir } from "./appAssets";
import { PiChatWebServer, type WebServerSettings } from "./webChatServer";
import { ChatHost } from "./chatHost";
import { readServerConfig, updateServerConfig } from "./serverConfig";
import { clearServerAddress, findRunningServer, writeServerAddress } from "./serverState";
import { startRestart } from "./serverRestart";
import { ensureAskAssets, ensureGoalAssets, ensureImageAssets, ensureTabaAssets, ensureTitleAssets, ensureBashAssets } from "./bridgeAssets";
import { serverConfigFile } from "./serverPaths";

/** 界面资源目录（chat.js / chat.css 这些）：正常跑在仓库根下，单文件 exe 时是解出来的缓存目录。 */
const MEDIA_DIR = mediaDir();
/** 本后端（也是本插件）的版本号。 */
const VERSION = appVersion();

export interface ServerArgs {
    cwd?: string;
    port?: number;
    host?: string;
    open?: boolean;
    help?: boolean;
    version?: boolean;
    /** 参数写错时的说明（打印出来，不启动）。 */
    error?: string;
}

/** 解析命令行参数。认 `--key value` 和 `--key=value` 两种写法。 */
export function parseServerArgs(argv: string[]): ServerArgs {
    const args: ServerArgs = {};
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i];
        const eq = raw.indexOf("=");
        const key = eq >= 0 ? raw.slice(0, eq) : raw;
        const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
        const takeValue = (): string | undefined => {
            if (inlineValue !== undefined) { return inlineValue; }
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("--")) { return undefined; }
            i++;
            return next;
        };
        switch (key) {
            case "--cwd": {
                const v = takeValue();
                if (!v) { return { error: "--cwd 后面要跟一个目录" }; }
                args.cwd = v;
                break;
            }
            case "--port": {
                const v = takeValue();
                const n = Number(v);
                if (!v || !Number.isInteger(n) || n < 0 || n > 65535) { return { error: "--port 后面要跟 0-65535 的整数（0 = 自动挑一个空闲端口）" }; }
                args.port = n;
                break;
            }
            case "--host": {
                const v = takeValue();
                if (!v) { return { error: "--host 后面要跟一个监听地址（例如 127.0.0.1 或 0.0.0.0）" }; }
                args.host = v;
                break;
            }
            case "--open": args.open = true; break;
            case "--help": case "-h": args.help = true; break;
            case "--version": case "-v": args.version = true; break;
            default:
                return { error: `不认识的参数：${raw}` };
        }
    }
    return args;
}

export function usageText(): string {
    return [
        "pichat —— 起一个 Pi Chat 后端（浏览器 / 手机上对话，关掉 VSCode 也还活着）",
        "",
        "用法：",
        "  pichat [--cwd 目录] [--port 端口] [--host 地址] [--open]",
        "",
        "参数：",
        "  --cwd 目录    会话默认跑在哪个目录（默认：你敲命令时所在的目录）",
        "  --port 端口   监听端口（默认取设置文件里的值，出厂 51883；写 0 = 自动挑空闲端口）",
        "  --host 地址   监听地址（默认 0.0.0.0：同一网络里的设备都能访问；只给自己用就写 127.0.0.1）",
        "  --open        起完用系统默认浏览器打开界面",
        "  --help        看这段说明",
        "  --version     看版本号",
        "",
        `设置文件：${serverConfigFile()}（第一次启动会写一份默认的出来，改完重启生效）`,
        "停止：回到这个终端按 Ctrl+C",
    ].join("\n");
}

/**
 * 收摊完了才退，而且隔一拍再退。
 *
 * 为什么不在 stop 完了当场 process.exit：通知区域那颗图标是个子进程，收摊时刚把它关掉，
 * 它那两根管道的收尾还没走完；这时候硬退，Windows 上会撞进一个 libuv 断言
 * （`!(handle->flags & UV_HANDLE_CLOSING)`，Node 的老毛病）。隔一拍就没事，也不耽误什么。
 */
function exitSoon(): void {
    setTimeout(() => process.exit(0), 150);
}

/** 用系统默认浏览器打开地址（打不开也不影响：地址已经打在屏幕上了）。 */
function openInDefaultBrowser(url: string): void {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try { cp.spawn(command, cmdArgs, { detached: true, stdio: "ignore" }).unref(); } catch { /* 打不开算了 */ }
}

function stamp(): string {
    return new Date().toLocaleTimeString();
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    // 被单文件 exe（壳）起来的：日志由壳写进文件，双击时的默认参数（家目录 + 开浏览器）
    // 也由壳给，这里只管一件事 —— 撞上“已经有一个在跑”时把界面打开，别报错了事。
    const packaged = isPackaged();

    const args = parseServerArgs(argv);
    if (args.help) { console.log(usageText()); return; }
    if (args.version) { console.log(VERSION); return; }
    if (args.error) { console.error(`${args.error}\n\n${usageText()}`); process.exitCode = 1; return; }

    const log = (text: string) => console.log(`[${stamp()}] ${text}`);

    // 单实例：已经在跑就报出它的地址，不再起第二个（两个后端会让手机分不清连哪个）。
    // 双击 exe 撞上这种情况是常态（人以为没开）：那就只把那个界面打开，不再报错退出。
    const running = await findRunningServer();
    if (running) {
        if (packaged) {
            log(`已经有一个 Pi Chat 在跑了：${running.url}（这次只把界面打开）`);
            openInDefaultBrowser(running.url);
            return;
        }
        console.error(`已经有一个 Pi Chat 后端在跑了：${running.url}`);
        console.error("（想再起一个就先停掉它；一个后端就能同时接手机、电脑浏览器。）");
        process.exitCode = 1;
        return;
    }

    // 第一次启动顺手写一份默认设置出来：不然人不知道有哪些项可改。
    const cfgRead = readServerConfig();
    if (!cfgRead.existed) {
        updateServerConfig({});
        console.log(`[${stamp()}] 已写出默认设置：${cfgRead.file}`);
    }
    for (const warning of cfgRead.warnings) { log(`设置文件有问题：${warning}`); }
    const cfg = cfgRead.config;

    if (!cfg.webServer.enabled) {
        log("设置文件里 webServer.enabled 是 false；独立后端就是那个网页服务，这里照常开。");
    }

    // 派子会话要用的文件（那个 pi 扩展 + 自带角色文件）：跟插件启动时一样，先写好。
    const tabaAssets = ensureTabaAssets(VERSION);
    if (!tabaAssets.ok) {
        log(`派子会话的功能没开（文件没写成：${tabaAssets.error}）`);
    }

    // 问话（ask_choice）要用的那个 pi 扩展：同样先写好（它不依赖上面那个开关）
    const askAssets = ensureAskAssets(VERSION);
    if (!askAssets.ok) {
        log(`问话（ask_choice）这个工具没开（文件没写成：${askAssets.error}）`);
    }

    // 目标（/goal）判官会话里那个 update_goal：同样先写好（它只在判官会话里加载）
    const goalAssets = ensureGoalAssets(VERSION);
    if (!goalAssets.ok) {
        log(`目标的验收（/goal 的判官）没开（文件没写成：${goalAssets.error}）`);
    }

    // 自动起标题：同样先写好（它只在主会话里加载）
    const titleAssets = ensureTitleAssets(VERSION);
    if (!titleAssets.ok) {
        log(`自动起标题没开（文件没写成：${titleAssets.error}）`);
    }

    // 会话里的截图挪出会话文件：同样先写好（每个会话都加载）
    const imageAssets = ensureImageAssets(VERSION);
    if (!imageAssets.ok) {
        log(`截图挪出会话文件没开（文件没写成：${imageAssets.error}）`);
    }

    // 接管 bash（后台命令、把正在跑的命令切后台）：同样先写好（每个会话都加载）
    const bashAssets = ensureBashAssets(VERSION);
    if (!bashAssets.ok) {
        log(`后台命令没开（文件没写成：${bashAssets.error}）`);
    }

    let started: StartedBackend;
    try {
        started = await startBackend({
            cwd: path.resolve(args.cwd ?? process.cwd()),
            port: args.port ?? cfg.webServer.port,
            host: args.host ?? cfg.webServer.host,
            trustedOrigins: cfg.webServer.trustedOrigins,
            log,
        });
    } catch (err: any) {
        console.error(`起服务失败：${err?.message || err}`);
        process.exitCode = 1;
        return;
    }

    console.log("");
    console.log(`  Pi Chat 后端已启动：${started.url}`);
    console.log(`  手机 / 浏览器打开上面这个地址就能对话`);
    console.log(`  会话默认目录：${started.cwd}`);
    console.log(`  设置文件：${serverConfigFile()}（改完重启生效）`);
    console.log(`  停止：Ctrl+C`);
    console.log("");
    if (started.host0 === "0.0.0.0" || started.host0 === "::") {
        console.log("  提醒：监听在 0.0.0.0 = 同一网络里的所有设备都能访问，服务不要口令。");
        console.log("       只在信得过的网络里这么用；手机连的就是上面那个地址。");
        console.log("       只想自己用就加 --host 127.0.0.1，或把设置文件里的 webServer.host 改成 127.0.0.1。");
        console.log("");
    }
    if (args.open) { openInDefaultBrowser(started.url); }

    let stopping = false;
    const onSignal = (signal: string): void => {
        if (stopping) { return; }
        stopping = true;
        console.log(`\n[${stamp()}] 收到 ${signal}，正在收摊（停网页服务、杀掉所有 pi 进程）…`);
        void started.stop().then(() => exitSoon());
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
}

/** 起后端时用的东西（调试工具直接用它，不用碰信号与打印那套）。 */
export interface StartBackendOptions {
    /** 会话默认跑在哪个目录。 */
    cwd: string;
    /** 监听端口；不填或 0 = 自动挑一个空闲端口。 */
    port?: number;
    /** 监听地址；不填 = 0.0.0.0（同一网络里的设备都能访问）。 */
    host?: string;
    /** 日志出口。 */
    log?: (text: string) => void;
    /**
     * 另外信得过的来源（设置文件里的 webServer.trustedOrigins）：服务前面挂了一层 https 反代时，
     * 页面就从那个地址打开，页里发的请求带的 Origin 也是它。
     */
    trustedOrigins?: string[];
}

/** 起好的后端。 */
export interface StartedBackend {
    url: string;
    /** 实际用的会话目录（绝对路径）。 */
    cwd: string;
    /** 实际监听的地址（打印提醒要用）。 */
    host0: string;
    host: ChatHost;
    server: PiChatWebServer;
    /** 收摊：停网页服务、清地址文件、杀掉所有 pi 进程。quiet = 不跟页面道别（重启后端时用）。 */
    stop: (quiet?: boolean) => Promise<void>;
}

/**
 * 起一个后端：建宿主、开网页服务、把地址写进地址文件。
 * 失败（端口 / 地址不对之类）直接抛错，由调用方决定怎么报。
 */
export async function startBackend(options: StartBackendOptions): Promise<StartedBackend> {
    const log = options.log ?? ((text: string) => console.log(text));
    const cwd = path.resolve(options.cwd);
    const bindHost = options.host ?? "0.0.0.0";

    // 设置浮层里那颗「编译并重启」：按钮点下去要的是「怎么起的、起在哪儿」，所以由这一层接；
    // 收摊（停网页服务、杀掉 pi 进程）也在这一层，见下面给 restartBackend 赋值那块。
    let restartBackend = (): { ok: boolean; reason?: string } => ({ ok: false, reason: "后端还没起来，不能重启。" });
    // 托盘菜单里的「打开页面」要用地址，可地址要等服务起来才知道：先留个口子，起来后插进去
    let pageUrl: string | undefined;
    const host = new ChatHost({
        cwd, log,
        restartBackend: () => restartBackend(),
        // 托盘里点「打开页面」：默认开本机这个地址；别的机器推来的那一行给的是它那边的地址
        openPage: (page) => { const target = page || pageUrl; if (target) { openInDefaultBrowser(target); } },
        // 推给别的后端时要拼“点了打开哪个页面”，用自己的地址
        selfPageUrl: () => pageUrl,
    });
    const server = new PiChatWebServer(MEDIA_DIR, host, {
        log: (text) => log(`[网页服务] ${text}`),
        onUrlChanged: () => { /* 启动器自己会打印地址，这里不用管 */ },
        info: () => ({ version: VERSION }),
    });

    const settings: WebServerSettings = {
        enabled: true,
        port: options.port ?? 0,
        host: bindHost,
        trustedOrigins: options.trustedOrigins ?? [],
    };
    await server.applySettings(settings);

    const url = server.url;
    if (!url) {
        // 服务没起来就没啥可收的，把会话进程收干净再抛。
        try { host.dispose(); } catch { /* 收摊出错不拦路 */ }
        throw new Error("网页服务没起来（端口 / 监听地址可能不对）");
    }
    pageUrl = url;

    // 地址文件：单实例判断与"插件找后端"（第二步）都靠它。
    const parsed = new URL(url);
    writeServerAddress({
        app: "pichat",
        version: VERSION,
        pid: process.pid,
        port: Number(parsed.port),
        host: bindHost,
        url,
        startedAt: Date.now(),
    });

    let stopped = false;
    const stop = async (quiet = false): Promise<void> => {
        if (stopped) { return; }
        stopped = true;
        try { await server.stop(quiet); } catch { /* 已经停了 */ }
        try { host.dispose(); } catch { /* 收摊出错不拦路 */ }
        try { clearServerAddress(); } catch { /* 清不掉也只是留个过期文件，下次启动会接管 */ }
    };

    restartBackend = () => {
        const result = startRestart({
            pid: process.pid,
            url,
            execPath: process.execPath,
            argv: process.argv.slice(1),
            cwd: process.cwd(),
            dir: cwd,
            port: Number(parsed.port),
            host: bindHost,
        });
        if (result.ok) {
            // 先把回话送出去（界面上那句「正在编译并重启」），再按 Ctrl+C 那套收摊退出。
            // 小进程正等着这个进程号消失，看到它没了才动手编译。
            // 收摊时不跟页面道别：页面收到道别就不自己重连了，可这个服务几十秒后还会在同一个地址上回来。
            setTimeout(() => { void stop(true).finally(() => exitSoon()); }, 500);
        }
        return result;
    };

    return { url, cwd, host0: bindHost, host, server, stop };
}

// 直接 `node out/server/serverMain.js` 跑时进这里；通过 bin/pichat.js 进来的由它调 main()。
if (require.main === module) {
    void main().catch((err) => {
        console.error(err?.stack || err?.message || String(err));
        process.exit(1);
    });
}

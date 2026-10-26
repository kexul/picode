/**
 * 「编译并重启」这颗按钮的后端一半（在设置浮层里）。
 *
 * 后端没法自己重启自己：发起重启的那个进程一退，就没人去编译、也没人把后端起回来了。
 * 所以这里只做两件事：
 *   1. 看清能不能干（代码旁边得有仓库里的 build.bat / build.sh —— 编译要仓库里那份源码）；
 *   2. 把要做的事写进一份 JSON（重启计划），再起一个独立的小进程（bin/pichat-restart.js）
 *      去办：等这个后端退干净 → 在仓库里 npm run build、npm i -g . → 照当初的命令行把
 *      后端起回来（同一个端口、同一个会话目录，页面才能在原地连回来）。
 *
 * 收摊是调用方自己做的（见 serverMain 的 startBackend）：这里只负责起小进程，不杀自己。
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pichatDir } from "./serverPaths";

/** 仓库根目录（这个文件编译后在 out/server 里）。 */
const ROOT_DIR = path.join(__dirname, "..", "..");

/** 编译要先有仓库里的脚本来认路：两个平台各一份。 */
const BUILD_SCRIPTS = ["build.bat", "build.sh"];

/** 还能不能从这里重启、日志写哪儿。 */
export interface RestartAvailability {
    ok: boolean;
    /** 仓库目录（ok 时才有）。 */
    repoDir?: string;
    /** 编译输出与新后端日志都追加到这里。 */
    logFile: string;
    /** 不能重启时的一句话（写给设置浮层里那颗按钮看）。 */
    reason?: string;
}

/** 编译输出与新后端的日志（每次重启都往后追加）。 */
export function restartLogFile(): string {
    return path.join(pichatDir(), "restart.log");
}

/**
 * 现在这个后端能不能从这里编译并重启。
 *
 * 只认「从仓库里跑的」：代码旁边有 build.bat / build.sh 才算。全局装出来的 pichat
 * （npm i -g . 之后那份拷贝）旁边没有这些脚本，也就没有源码可编，只能由人在仓库里敲
 * 一次构建、再重启。
 */
export function describeRestart(): RestartAvailability {
    const logFile = restartLogFile();
    const found = BUILD_SCRIPTS.find((name) => fs.existsSync(path.join(ROOT_DIR, name)));
    if (!found) {
        return {
            ok: false,
            logFile,
            reason: `这个后端不是从仓库里跑的（${ROOT_DIR} 里没有 build.bat / build.sh），没有源码可编。`
                + "要用这颗按钮，得用仓库里的代码起后端（在仓库里跑 npm run server，或仓库里的 pichat）。",
        };
    }
    return { ok: true, repoDir: ROOT_DIR, logFile };
}

/** 重启时要照原样接着用的东西：怎么起的、起在哪儿。 */
export interface RestartLaunch {
    /** 现在这个后端的进程号（小进程要等它退干净）。 */
    pid: number;
    /** 它给的地址（写进日志，人好对）。 */
    url: string;
    /** 起它的那条命令行：node 可执行文件 + 脚本 + 参数。 */
    execPath: string;
    argv: string[];
    /** 起它时所在的目录（脚本可能是相对路径，照这个解）。 */
    cwd: string;
    /** 会话默认目录。 */
    dir: string;
    /** 实际监听的端口与地址。 */
    port: number;
    host: string;
}

/** 重启计划的文件名（写在上一次上面；小进程起来就把它读走）。 */
function planFile(): string {
    return path.join(pichatDir(), "restart.json");
}

/**
 * 把命令行里「会话目录 / 端口 / 监听地址」这几项摘掉：重启时按这次实际的值重新写一遍。
 * （老后端可能是 --port 0 自己挑的，照抄会换一个端口，页面连的那个地址就成死地址了。）
 */
function withoutAddressArgs(argv: string[]): string[] {
    const kept: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.indexOf("=");
        const key = eq >= 0 ? arg.slice(0, eq) : arg;
        if (key !== "--cwd" && key !== "--port" && key !== "--host") { kept.push(arg); continue; }
        if (eq < 0) { i++; }   // 连它的值一起摘掉
    }
    return kept;
}

/** 这一次重启是不是已经交出去了（连点两下不重复派活；这个进程一会儿就退了，不用复位）。 */
let handedOff = false;

/**
 * 把重启交给小进程去办。
 *
 * @returns ok = 小进程起来了（调用方随后自己收摊退出）；不成的话 reason 是一句人话。
 */
export function startRestart(launch: RestartLaunch): { ok: boolean; reason?: string } {
    const able = describeRestart();
    if (!able.ok || !able.repoDir) { return { ok: false, reason: able.reason ?? "不知道仓库在哪，编译不了。" }; }
    if (handedOff) { return { ok: false, reason: "已经在重启了。" }; }
    const helper = path.join(able.repoDir, "bin", "pichat-restart.js");
    if (!fs.existsSync(helper)) { return { ok: false, reason: `找不到重启用的小脚本：${helper}` }; }

    // 新后端的命令行：照老样子，再把「会话目录 / 端口 / 监听地址」按这次实际的值钉住。
    // 老后端可能是 --port 0 自动挑的端口，照抄会换一个端口，页面连的那个地址就成死地址了。
    const argv = [
        path.resolve(launch.cwd, launch.argv[0] ?? ""),
        ...withoutAddressArgs(launch.argv.slice(1)),
        "--cwd", launch.dir,
        "--port", String(launch.port),
        "--host", launch.host,
    ];
    const plan = {
        pid: launch.pid,
        url: launch.url,
        repoDir: able.repoDir,
        logFile: able.logFile,
        execPath: launch.execPath,
        argv,
        startCwd: launch.cwd,
    };
    const file = planFile();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n", "utf8");
    } catch (err: any) {
        return { ok: false, reason: `写不进重启计划（${file}）：${err?.message ?? String(err)}` };
    }
    try {
        // detached：这个后端一会儿就退了，小进程得自己活着把活干完
        cp.spawn(launch.execPath, [helper, file], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        }).unref();
    } catch (err: any) {
        return { ok: false, reason: `起不了重启用的小进程：${err?.message ?? String(err)}` };
    }
    handedOff = true;
    return { ok: true };
}

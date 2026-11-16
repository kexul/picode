/**
 * apkBuild —— 让手机上的 app 叫这台电脑打一次安卓包（设置画面里那颗「打包并安装新版」）。
 *
 * 为什么在电脑上打：安卓包的界面文件是打包那一刻从 media/ 拷进去的（见 android/app/build.gradle），
 * 而 media/ 只在这台电脑上；手机自己没有源码、也没装 Android SDK。
 *
 * 一次打包就是一次 `gradle assembleDebug`，跟在仓库根目录敲 `build.bat` 里那一步同一条命令、
 * 同一套找 gradle 的规矩（PATH 里没有就去 ~/.gradle/wrapper/dists 里捞），
 * GRADLE_USER_HOME 也照样指 android/.gradle-home（免得被全局 ~/.gradle 里的代理配置拖住）。
 *
 * 打包的活只经手一处：手机那头 POST 一下、隔一会儿 GET 一下问进度，打完再 GET /apk 把包下走
 * （见 src/webChatServer.ts 里那三条口）。正在打的时候再 POST 不会起第二份 —— gradle 两个
 * 进程同时写同一个 build 目录会互相踩。
 *
 * 只有「从仓库源码起的后端」才编得出来：装的是插件包（vsix / npm 全局）或者那个单文件 exe 时，
 * 手边根本没有 android/ 源码，status().canBuild 就是 false、附一句人话。
 */
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appRoot } from "./appAssets";

/** 打包这件事这会儿处在哪一步。 */
export type ApkBuildState =
    /** 这一轮没开始过（但可能有上一次打好的包） */
    | "idle"
    | "running"
    | "ok"
    | "failed";

export interface ApkBuildStatus {
    state: ApkBuildState;
    /** 这台机器能不能打包（源码树里才有 android/）。 */
    canBuild: boolean;
    /** 不能打包时的那一句人话。 */
    reason?: string;
    /** 这一轮开始的时刻（毫秒时间戳）。 */
    startedAt?: number;
    /** 这一轮跑了多久（还在跑就是到这会儿的秒数）。 */
    seconds?: number;
    /** 失败时那一句。 */
    error?: string;
    /** 最后几行 gradle 输出（卡住了能看出卡在哪）。 */
    log: string;
    /** 手边那个包（有的话；上一轮打出来的也算）。 */
    apk?: { size: number; mtime: number };
}

/** 留最后几行输出：手机上那一行字只放得下一两句，多了也是自己看日志。 */
const LOG_LINES = 30;

/** gradle 的输出一行一行攒着（只留最后几行）。 */
class LogTail {
    private readonly lines: string[] = [];
    push(chunk: string): void {
        for (const line of chunk.split(/\r?\n/)) {
            const text = line.trimEnd();
            if (!text) { continue; }
            this.lines.push(text);
            if (this.lines.length > LOG_LINES) { this.lines.shift(); }
        }
    }
    text(): string {
        return this.lines.join("\n");
    }
    clear(): void {
        this.lines.length = 0;
    }
}

/**
 * 从 PATH 里找一个可执行文件。
 * @param names 依次试的几个文件名（Windows 上 gradle 是 gradle.bat）
 */
function fromPath(names: string[]): string | undefined {
    const dirs = (process.env.PATH || process.env.Path || "").split(path.delimiter);
    for (const name of names) {
        for (const dir of dirs) {
            if (!dir) { continue; }
            const full = path.join(dir, name);
            try {
                if (fs.statSync(full).isFile()) { return full; }
            } catch { /* 这一格没有，接着看下一格 */ }
        }
    }
    return undefined;
}

/**
 * 找 gradle：先看 PATH，再看 gradle 自己下载到 ~/.gradle/wrapper/dists 里的那几份
 * （跟 build.bat 里那套一样：<dists>/gradle-<版本>-<变体>/<哈希>/gradle-<版本>/bin/gradle）。
 */
export function findGradle(): string | undefined {
    const names = process.platform === "win32" ? ["gradle.bat", "gradle.cmd"] : ["gradle"];
    const inPath = fromPath(names);
    if (inPath) { return inPath; }
    const home = process.env.GRADLE_USER_HOME && process.env.GRADLE_USER_HOME.trim()
        ? process.env.GRADLE_USER_HOME.trim()
        : path.join(os.homedir(), ".gradle");
    const dists = path.join(home, "wrapper", "dists");
    const subdirs = (dir: string): string[] => {
        try {
            return fs.readdirSync(dir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => path.join(dir, entry.name));
        } catch {
            return [];
        }
    };
    for (const dist of subdirs(dists)) {
        for (const hash of subdirs(dist)) {
            for (const version of subdirs(hash)) {
                for (const name of names) {
                    const full = path.join(version, "bin", name);
                    if (fs.existsSync(full)) { return full; }
                }
            }
        }
    }
    return undefined;
}

/** 一个打包器的样子（网页服务只认这几个方法）。 */
export interface ApkBuilder {
    /** 这会儿的状态（不改变什么）。 */
    status(): ApkBuildStatus;
    /** 起一次打包；已经在打就直接回报当前状态，不起第二份。 */
    start(): ApkBuildStatus;
    /** 手边那个包的路径（还没打过就是 undefined）。 */
    apkFile(): string | undefined;
    /** 收摊：正在打的进程掐掉（别留着它锁住 build 目录）。 */
    stop(): void;
}

/**
 * 造一个打包器。
 * @param root 仓库根目录（它下面有 android/）；默认就是后端自己所在的那一层
 */
export function createApkBuilder(root = appRoot()): ApkBuilder {
    const androidDir = path.join(root, "android");
    const apkPath = path.join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
    const log = new LogTail();
    let child: ChildProcess | undefined;
    let state: ApkBuildState = "idle";
    let startedAt = 0;
    let finishedAt = 0;
    let error = "";

    /** 编不了的原因（能编就给 undefined）。 */
    function blockReason(): string | undefined {
        if (!fs.existsSync(path.join(androidDir, "app", "build.gradle"))) {
            return "这台电脑上没有 android/ 源码（后端不是从仓库起的），编不了";
        }
        if (!findGradle()) {
            return "没找到 gradle（PATH 里没有，~/.gradle/wrapper/dists 里也没有）";
        }
        return undefined;
    }

    function apkInfo(): ApkBuildStatus["apk"] {
        try {
            const st = fs.statSync(apkPath);
            return { size: st.size, mtime: st.mtimeMs };
        } catch {
            return undefined;
        }
    }

    function status(): ApkBuildStatus {
        const reason = blockReason();
        const info = apkInfo();
        const running = state === "running";
        return {
            state,
            canBuild: !reason,
            ...(reason ? { reason } : {}),
            ...(startedAt ? { startedAt } : {}),
            ...(startedAt ? { seconds: Math.round(((running ? Date.now() : finishedAt) - startedAt) / 100) / 10 } : {}),
            ...(error ? { error } : {}),
            log: log.text(),
            ...(info ? { apk: info } : {}),
        };
    }

    function finish(next: ApkBuildState, failure = ""): void {
        state = next;
        error = failure;
        finishedAt = Date.now();
        child = undefined;
    }

    function start(): ApkBuildStatus {
        const reason = blockReason();
        if (reason || state === "running") { return status(); }
        const gradle = findGradle();
        if (!gradle) { return status(); }
        log.clear();
        // 版本号由 build.gradle 拿打包那一刻的时间算（见那边的 defaultConfig）：
        // 系统安装器只肯往上装，所以每次打出来的都得比上一次大。
        const args = ["assembleDebug", "--console=plain"];
        state = "running";
        startedAt = Date.now();
        finishedAt = 0;
        error = "";
        log.push("· 正在打包…");
        const env = {
            ...process.env,
            // 跟 build.bat 一样：别让全局 ~/.gradle 里那份代理配置把它们拖住
            GRADLE_USER_HOME: path.join(androidDir, ".gradle-home"),
        };
        try {
            // Windows 上 gradle 是个 .bat：交给 cmd 去跑（路径带空格也认得，参数里没有空格）
            child = process.platform === "win32"
                ? spawn(`"${gradle}" ${args.join(" ")}`, { cwd: androidDir, env, shell: true, windowsHide: true })
                : spawn(gradle, args, { cwd: androidDir, env });
        } catch (err: any) {
            finish("failed", `起不来 gradle：${err?.message ?? String(err)}`);
            return status();
        }
        const proc = child;
        proc.stdout?.on("data", (data: Buffer) => log.push(data.toString("utf8")));
        proc.stderr?.on("data", (data: Buffer) => log.push(data.toString("utf8")));
        proc.on("error", (err: Error) => {
            log.push(`· ${err.message}`);
            finish("failed", `起不来 gradle：${err.message}`);
        });
        proc.on("close", (code: number | null) => {
            if (state !== "running") { return; }
            if (code === 0 && fs.existsSync(apkPath)) {
                log.push("· 打好了。");
                finish("ok");
            } else {
                log.push(`· 没打成（gradle 退出码 ${code ?? "未知"}）。`);
                finish("failed", "打包失败，看日志最后几行");
            }
        });
        return status();
    }

    function apkFile(): string | undefined {
        return fs.existsSync(apkPath) ? apkPath : undefined;
    }

    function stop(): void {
        if (!child) { return; }
        const proc = child;
        try { proc.kill(); } catch { /* 已经没了 */ }
        finish("failed", "后端停了，这次打包被打断");
    }

    return { status, start, apkFile, stop };
}

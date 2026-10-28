/**
 * appAssets —— 界面文件（media/）与两支小程序（bin/tray.exe、bin/shot.exe）在哪儿，
 * 以及“打成单个 exe 之后的那些不方便”一起收在这里。
 *
 * 两种跑法：
 *   1. 正常跑（仓库里 `npm run server`、或者全局装的那份包）：它们就在仓库根目录下面的
 *      media/ 与 bin/，跟以前一样按路径读。此时本文件基本是个透明包装。
 *   2. 单文件 exe（scripts/build-exe.mjs 打出来的那个）：代码和这两样东西都内嵌在 exe 里，
 *      第一次跑要解到本机缓存目录（按版本分目录，换一版就重新解一份）。exe 没有控制台，
 *      所以日志也得改成写文件（见 startSingleExe）。
 *
 * 为什么要单独一层：以前那两个常量是 `path.join(__dirname, "..", "..", "bin", ...)`，
 * 内嵌之后 __dirname 指向一个不存在的路径，得有人替它们回答“到底在哪”。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 单文件 exe 模式下由构建脚本塞进打包结果里的东西（正常跑时是 undefined）。 */
interface SingleExeBits {
    version?: string;
    /** 内嵌了哪些文件：相对 media/ 与 bin/ 的写法，比如 `media/chat.js`、`bin/tray.exe`。 */
    assets?: string[];
}

declare global {
    // eslint-disable-next-line no-var
    var __PICHAT_SINGLE_EXE__: SingleExeBits | undefined;
}

/** 版本号：单文件 exe 用构建时写进去的那份；正常跑读仓库根下的 package.json。 */
export function appVersion(): string {
    if (isSingleExe()) { return globalThis.__PICHAT_SINGLE_EXE__?.version || "0"; }
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(appRoot(), "package.json"), "utf8"));
        return typeof parsed.version === "string" ? parsed.version : "0";
    } catch {
        return "0";
    }
}

/** 这个进程是不是那个单文件 exe 起来的。 */
export function isSingleExe(): boolean {
    try {
        const sea = require("node:sea") as { isSea?: () => boolean };
        return typeof sea.isSea === "function" && sea.isSea() === true;
    } catch {
        return false;   // 不是 Node 20+ 的单文件，或者根本没有这个模块
    }
}

let cachedRoot: string | undefined;

/** 界面文件与小程序所在的那个目录（它下面有 media/ 与 bin/）。 */
export function appRoot(): string {
    if (cachedRoot) { return cachedRoot; }
    cachedRoot = isSingleExe() ? unpackSingleExe() : path.join(__dirname, "..", "..");
    return cachedRoot;
}

/** 界面文件目录（网页服务按路径读这里的文件）。 */
export function mediaDir(): string {
    return path.join(appRoot(), "media");
}

/** 两支小程序里某一支的完整路径（`shot.exe` / `tray.exe`）。 */
export function appBin(name: string): string {
    return path.join(appRoot(), "bin", name);
}

/**
 * 单文件 exe 的开场白：没有控制台，日志改成写文件；双击（没带参数）也算有个像样的默认。
 * 正常跑时什么也不做。
 * @returns 日志文件（写进去了才有），给“出错时告诉用户去哪儿看”用
 */
export function startSingleExe(): string | undefined {
    if (!isSingleExe()) { return undefined; }
    // 先把资源解出来：后面的日志、界面、托盘都指望它
    unpackSingleExe();
    const file = singleExeDataDir() + path.sep + "pichat.log";
    redirectConsole(file);
    return file;
}

/** 单文件 exe 的数据目录（资源与日志都落在这儿）。 */
function singleExeDataDir(): string {
    return process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "PiChat")
        : path.join(os.homedir(), ".cache", "pichat");
}

/**
 * 把内嵌的界面文件与小程序解到缓存目录（按版本分，已经解过就直接用）。
 * 只解一次：目录里留一个 .ready 当标记。
 */
function unpackSingleExe(): string {
    const bits = globalThis.__PICHAT_SINGLE_EXE__ ?? {};
    const stamp = bits.version || "dev";
    const dir = path.join(singleExeDataDir(), "app-" + stamp);
    const ready = path.join(dir, ".ready");
    if (fs.existsSync(ready)) { return dir; }
    const sea = require("node:sea") as { getAsset(key: string): ArrayBuffer };
    for (const key of bits.assets ?? []) {
        const target = path.join(dir, key);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(sea.getAsset(key)));
    }
    fs.writeFileSync(ready, `${stamp} ${new Date().toISOString()}`);
    return dir;
}

/**
 * 把 console 那几个出口改成写文件。
 * 为什么要改：GUI 子系统的 exe 没有标准输出，`console.log` 写出去就丢了 ——
 * 后端最要紧的几件事（地址、出错原因）都在这儿打，丢了就只能靠猜。
 */
function redirectConsole(file: string): void {
    let fd: number;
    try {
        // 太长就先清一次：这是给人翻问题用的，不是账本
        try { if (fs.statSync(file).size > 4 * 1024 * 1024) { fs.rmSync(file, { force: true }); } } catch { /* 还没有这个文件 */ }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fd = fs.openSync(file, "a");
    } catch {
        return;   // 连日志都写不了就算了，别把启动拦下来
    }
    const line = (level: string, args: unknown[]) => {
        const text = args.map((value) => (typeof value === "string" ? value : inspect(value))).join(" ");
        try { fs.writeSync(fd, `${new Date().toLocaleTimeString()} [${level}] ${text}\n`); } catch { /* 磁盘满了之类 */ }
    };
    console.log = (...args: unknown[]) => line("log", args);
    console.info = (...args: unknown[]) => line("log", args);
    console.warn = (...args: unknown[]) => line("warn", args);
    console.error = (...args: unknown[]) => line("error", args);
}

/** 把不是字符串的东西写成一行字（够看就行，不去追 console 的原样）。 */
function inspect(value: unknown): string {
    if (value instanceof Error) { return value.stack || value.message; }
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

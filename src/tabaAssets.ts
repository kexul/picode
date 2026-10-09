/**
 * 派子会话（taba）：要写进 ~/.pi/pichat/ 的东西，以及"写好了没有"。
 *
 *   taba-bridge-<插件版本>.ts   塞进 pi 进程的那个扩展（源码见 tabaBridgeSource.ts）
 *
 * 为什么写到家目录而不是直接用插件安装目录里的文件：
 *   1. 插件安装目录里可能带空格，Windows 下拼命令行容易出问题（这里也顺手把版本号写进文件名）；
 *   2. 打包时 .ts 文件不会进 vsix（.vscodeignore 把 **\/*.ts 排掉了），所以源码是字符串，运行时才落盘。
 * 注意绝不能写进 ~/.pi/agent/extensions/：那个目录 pi 会自动发现，
 * 你在终端里手跑的 pi 也会被塞上这几个工具。
 *
 * 这个目录同时是子会话名录的根：taba-runs/<子会话编号>.json 在里面（见 tabaRunFiles），
 * 启动 pi 时用 PICHAT_TABA_DIR 告诉扩展。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TABA_BRIDGE_SOURCE } from "./tabaBridgeSource";
import { cleanStaleRunFiles, tabaRunsDir } from "./tabaRunFiles";

/** 写好了以后长什么样。 */
export interface TabaAssets {
    /** 都写好了才为 true；false 时插件就不给 pi 加载这个扩展（工具也就不会出现）。 */
    ok: boolean;
    /** 桥扩展文件路径；不可用时为空串。 */
    extensionPath: string;
    /** 名录文件的根目录（taba-runs 在里面）；启动 pi 时用 PICHAT_TABA_DIR 告诉扩展。 */
    resourceDir: string;
    /** 出错原因（写给输出面板看）。 */
    error?: string;
}

/** 家目录里我们放东西的位置。 */
export function tabaHomeDir(): string {
    return path.join(os.homedir(), ".pi", "pichat");
}

/** 版本号里能进文件名的那些字符。 */
export function safeVersionForFile(version: string): string {
    const cleaned = (version || "").replace(/[^A-Za-z0-9._-]/g, "-");
    return cleaned || "0";
}

const BRIDGE_FILE_RE = /^taba-bridge-.*\.ts$/;

/** 老版本插件留下的东西：角色相关的目录（角色已经不支持了）。删不掉不影响用。 */
const LEGACY_DIRS = ["taba-roles", "taba-prompts"];

/**
 * 把桥扩展写进 rootDir。
 * @param rootDir 一般是 ~/.pi/pichat；单测里传临时目录
 * @param version 插件版本（写进扩展文件名，好让旧版本的文件能认出来并删掉）
 */
export function writeTabaAssets(rootDir: string, version: string): TabaAssets {
    const safe = safeVersionForFile(version);
    const extensionPath = path.join(rootDir, `taba-bridge-${safe}.ts`);
    const resourceDir = rootDir;
    try {
        fs.mkdirSync(rootDir, { recursive: true });
        // 扩展文件：内容变了就重写（插件升级后的新行为要能生效）
        let current = "";
        try { current = fs.readFileSync(extensionPath, "utf8"); } catch { current = ""; }
        if (current !== TABA_BRIDGE_SOURCE) {
            fs.writeFileSync(extensionPath, TABA_BRIDGE_SOURCE, "utf8");
        }
        // 清掉旧版本的扩展文件，免得越攒越多
        for (const name of fs.readdirSync(rootDir)) {
            if (!BRIDGE_FILE_RE.test(name)) { continue; }
            const full = path.join(rootDir, name);
            if (full === extensionPath) { continue; }
            try { fs.rmSync(full, { force: true }); } catch { /* 删不掉不影响用 */ }
        }
        // 老版本插件留下的角色目录：角色已经不支持了，顺手清掉
        for (const name of LEGACY_DIRS) {
            const full = path.join(rootDir, name);
            try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
        }
        // 顺手清掉太老的子会话名录（子会话的 .jsonl 本身不动，那是 pi 的会话文件）
        cleanStaleRunFiles(tabaRunsDir(rootDir));
        return { ok: true, extensionPath, resourceDir };
    } catch (e: any) {
        return { ok: false, extensionPath: "", resourceDir: "", error: String(e?.message ?? e) };
    }
}

let cached: TabaAssets | undefined;

/** 插件激活时调一次：写好桥扩展并记住路径。 */
export function ensureTabaAssets(version: string): TabaAssets {
    if (cached) { return cached; }
    cached = writeTabaAssets(tabaHomeDir(), version);
    return cached;
}

/** 拿记住的路径（还没写过就是 undefined）。 */
export function getTabaAssets(): TabaAssets | undefined {
    return cached;
}

/** 清掉记住的路径（改配置或单测里用）。 */
export function resetTabaAssetsCache(): void {
    cached = undefined;
}

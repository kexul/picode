/**
 * 问话（ask_choice）：要写进资源目录的东西，以及"写好了没有"。
 *
 *   ask-bridge-<插件版本>.ts   塞进 pi 进程的那个扩展（源码见 askBridgeSource.ts）
 *   ask-answers/               回话文件（插件写、扩展读）
 *
 * 目录走 pichatDir()：跟后端的设置/状态文件一个地方，设了 PICHAT_HOME 就跟着走
 * （调试时不碰用户真目录）。为什么写文件而不是直接用安装目录里那份：
 *   1. 插件安装目录里可能带空格，Windows 下拼命令行容易出问题；
 *   2. 打包时 .ts 不进 vsix（.vscodeignore 排掉了），所以扩展是字符串，运行时才落盘。
 * 绝不能写进 ~/.pi/agent/extensions/：那个目录 pi 会自动发现，用户在终端里手跑的 pi
 * 也会被塞上这个工具 —— 这个工具只有插件的会话里才有意义。
 */
import * as fs from "fs";
import * as path from "path";
import { ASK_BRIDGE_SOURCE } from "./askBridgeSource";
import { askAnswersDir, cleanStaleAskAnswers } from "./askProtocol";
import { pichatDir } from "./serverPaths";

/** 写好了以后长什么样。 */
export interface AskAssets {
    /** 都写好了才为 true；false 时插件就不给 pi 加载这个扩展（工具也就不会出现）。 */
    ok: boolean;
    /** 桥扩展文件路径；不可用时为空串。 */
    extensionPath: string;
    /** 资源目录（回话文件在它的 ask-answers/ 下面）；启动 pi 时用 PICHAT_ASK_DIR 告诉扩展。 */
    resourceDir: string;
    /** 出错原因（写给输出面板看）。 */
    error?: string;
}

/** 版本号里能进文件名的那些字符。 */
function safeVersionForFile(version: string): string {
    const cleaned = (version || "").replace(/[^A-Za-z0-9._-]/g, "-");
    return cleaned || "0";
}

const BRIDGE_FILE_RE = /^ask-bridge-.*\.ts$/;

/**
 * 把桥扩展写进 rootDir。
 * @param rootDir 一般是 pichatDir()
 * @param version 插件版本（写进扩展文件名，好让旧版本的文件能认出来并删掉）
 */
function writeAskAssets(rootDir: string, version: string): AskAssets {
    const extensionPath = path.join(rootDir, `ask-bridge-${safeVersionForFile(version)}.ts`);
    try {
        fs.mkdirSync(rootDir, { recursive: true });
        // 扩展文件：内容变了就重写（插件升级后的新行为要能生效）
        let current = "";
        try { current = fs.readFileSync(extensionPath, "utf8"); } catch { current = ""; }
        if (current !== ASK_BRIDGE_SOURCE) {
            fs.writeFileSync(extensionPath, ASK_BRIDGE_SOURCE, "utf8");
        }
        // 清掉旧版本的扩展文件，免得越攒越多
        for (const name of fs.readdirSync(rootDir)) {
            if (!BRIDGE_FILE_RE.test(name)) { continue; }
            const full = path.join(rootDir, name);
            if (full === extensionPath) { continue; }
            try { fs.rmSync(full, { force: true }); } catch { /* 删不掉不影响用 */ }
        }
        // 回话目录顺手建出来，并清掉没人来读的残留（插件或会话死了留下的）
        fs.mkdirSync(askAnswersDir(rootDir), { recursive: true });
        cleanStaleAskAnswers(rootDir);
        return { ok: true, extensionPath, resourceDir: rootDir };
    } catch (e: any) {
        return { ok: false, extensionPath: "", resourceDir: "", error: String(e?.message ?? e) };
    }
}

let cached: AskAssets | undefined;

/** 后端启动时调一次：写好桥扩展并记住路径。 */
export function ensureAskAssets(version: string): AskAssets {
    if (cached) { return cached; }
    cached = writeAskAssets(pichatDir(), version);
    return cached;
}

/** 拿记住的路径（还没写过就是 undefined）。 */
export function getAskAssets(): AskAssets | undefined {
    return cached;
}

/**
 * 两套 pi 扩展（"桥"）要落盘的东西，以及"写好了没有"。
 *
 *   taba-bridge-<插件版本>.ts   派子会话（taba）那个扩展（源码见 tabaBridgeSource.ts）
 *   ask-bridge-<插件版本>.ts    问话（ask_choice）那个扩展（源码见 askBridgeSource.ts）
 *   goal-bridge-<插件版本>.ts   目标（/goal）那个扩展：判官会话里的 update_goal（源码见 goalBridgeSource.ts）
 *
 * 两套是同一个套路：文件名、源码、落盘后顺带干的活不一样，其余（内容变了才重写、
 * 清掉旧版本留下的文件、记一份结果）都一样，所以合成一处，差别放在下面的 BRIDGES 里。
 *
 * 目录走 pichatDir()：跟后端的设置 / 状态文件一个地方，设了 PICHAT_HOME 就跟着走
 * （调试时不碰用户真目录）。为什么写文件而不是直接用插件安装目录里那份：
 *   1. 安装目录里可能带空格，Windows 下拼命令行容易出问题；文件名里也顺手带上版本号；
 *   2. 打包时 .ts 不进 vsix（.vscodeignore 排掉了），所以扩展是字符串，运行时才落盘。
 * 绝不能写进 ~/.pi/agent/extensions/：那个目录 pi 会自动发现，用户在终端里手跑的 pi
 * 也会被塞上这些工具 —— 它们只有插件的会话里才有意义。
 *
 * 两套桥各自还要一个自己的目录（都在同一个资源目录下面）：
 *   taba-runs/<子会话编号>.json   子会话名录（启动 pi 时用 PICHAT_TABA_DIR 告诉扩展）
 *   ask-answers/<问话编号>.json   回话文件（启动 pi 时用 PICHAT_ASK_DIR 告诉扩展）
 */
import * as fs from "fs";
import * as path from "path";
import { TABA_BRIDGE_SOURCE } from "./tabaBridgeSource";
import { ASK_BRIDGE_SOURCE } from "./askBridgeSource";
import { GOAL_BRIDGE_SOURCE } from "./goalBridgeSource";
import { cleanStaleRunFiles, tabaRunsDir } from "./tabaRunFiles";
import { askAnswersDir, cleanStaleAskAnswers } from "./askProtocol";
import { pichatDir } from "./serverPaths";

/** 写好了以后长什么样（两套桥一样）。 */
export interface BridgeAssets {
    /** 都写好了才为 true；false 时就不给 pi 加载这个扩展（工具也就不会出现）。 */
    ok: boolean;
    /** 桥扩展文件路径；不可用时为空串。 */
    extensionPath: string;
    /** 资源目录（自己那份子目录在里面，见文件头）；启动 pi 时用环境变量告诉扩展。 */
    resourceDir: string;
    /** 出错原因（写给输出面板看）。 */
    error?: string;
}

/** 一套桥：够写出它、并认出旧版本留下的文件。 */
interface BridgeKind {
    /** 扩展文件名前缀，也是认旧文件的依据（两套的前缀不一样，互不动对方的文件）。 */
    prefix: string;
    /** 落盘的那份源码。 */
    source: string;
    /** 落盘之后顺带干的活：建自己那份目录、清太老的残留。 */
    afterWrite(rootDir: string): void;
}

const BRIDGES: Record<"taba" | "ask" | "goal", BridgeKind> = {
    taba: {
        prefix: "taba-bridge",
        source: TABA_BRIDGE_SOURCE,
        afterWrite(rootDir: string): void {
            // 老版本插件留下的角色目录：角色已经不支持了，顺手清掉。
            for (const name of ["taba-roles", "taba-prompts"]) {
                try { fs.rmSync(path.join(rootDir, name), { recursive: true, force: true }); } catch { /* 删不掉不影响用 */ }
            }
            // 顺手清掉太老的子会话名录（子会话的 .jsonl 本身不动，那是 pi 的会话文件）。
            cleanStaleRunFiles(tabaRunsDir(rootDir));
        },
    },
    ask: {
        prefix: "ask-bridge",
        source: ASK_BRIDGE_SOURCE,
        afterWrite(rootDir: string): void {
            // 回话目录顺手建出来，并清掉没人来读的残留（插件或会话死了留下的）。
            fs.mkdirSync(askAnswersDir(rootDir), { recursive: true });
            cleanStaleAskAnswers(rootDir);
        },
    },
    goal: {
        prefix: "goal-bridge",
        source: GOAL_BRIDGE_SOURCE,
        // 判官只报个结论，外面不留文件：不用建目录、不用清残留
        afterWrite(): void { /* 没别的活 */ },
    },
};

/** 版本号里能进文件名的那些字符。 */
function safeVersionForFile(version: string): string {
    const cleaned = (version || "").replace(/[^A-Za-z0-9._-]/g, "-");
    return cleaned || "0";
}

/** 把一套桥的扩展写进 rootDir。 */
function writeBridge(kind: BridgeKind, rootDir: string, version: string): BridgeAssets {
    const extensionPath = path.join(rootDir, `${kind.prefix}-${safeVersionForFile(version)}.ts`);
    try {
        fs.mkdirSync(rootDir, { recursive: true });
        // 扩展文件：内容变了才重写（插件升级后的新行为要能生效）
        let current = "";
        try { current = fs.readFileSync(extensionPath, "utf8"); } catch { current = ""; }
        if (current !== kind.source) {
            fs.writeFileSync(extensionPath, kind.source, "utf8");
        }
        // 清掉旧版本留下的扩展文件，免得越攒越多（只认自己这个前缀，不动另一套桥的）
        const staleRe = new RegExp(`^${kind.prefix}-.*\\.ts$`);
        for (const name of fs.readdirSync(rootDir)) {
            if (!staleRe.test(name)) { continue; }
            const full = path.join(rootDir, name);
            if (full === extensionPath) { continue; }
            try { fs.rmSync(full, { force: true }); } catch { /* 删不掉不影响用 */ }
        }
        kind.afterWrite(rootDir);
        return { ok: true, extensionPath, resourceDir: rootDir };
    } catch (e: any) {
        return { ok: false, extensionPath: "", resourceDir: "", error: String(e?.message ?? e) };
    }
}

/** 已经写过的那几套（哪一套 → 结果）。 */
const cached = new Map<BridgeKind, BridgeAssets>();

function ensureBridge(kind: BridgeKind, version: string): BridgeAssets {
    const hit = cached.get(kind);
    if (hit) { return hit; }
    const result = writeBridge(kind, pichatDir(), version);
    cached.set(kind, result);
    return result;
}

/** 后端启动时调一次：写好派子会话那套桥，并记住结果。 */
export function ensureTabaAssets(version: string): BridgeAssets {
    return ensureBridge(BRIDGES.taba, version);
}

/** 同上，问话（ask_choice）那套。 */
export function ensureAskAssets(version: string): BridgeAssets {
    return ensureBridge(BRIDGES.ask, version);
}

/** 同上，目标（/goal）那套：只有判官会话加载它（update_goal）。 */
export function ensureGoalAssets(version: string): BridgeAssets {
    return ensureBridge(BRIDGES.goal, version);
}

/** 拿记住的结果（还没写过就是 undefined）。 */
export function getTabaAssets(): BridgeAssets | undefined {
    return cached.get(BRIDGES.taba);
}

export function getAskAssets(): BridgeAssets | undefined {
    return cached.get(BRIDGES.ask);
}

export function getGoalAssets(): BridgeAssets | undefined {
    return cached.get(BRIDGES.goal);
}

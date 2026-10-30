/**
 * 几套 pi 扩展（"桥"）要落盘的东西，以及"写好了没有"。
 *
 *   taba-bridge-<插件版本>.ts   派子会话（taba）那个扩展（源码见 tabaBridgeSource.ts）
 *   ask-bridge-<插件版本>.ts    问话（ask_choice）那个扩展（源码见 askBridgeSource.ts）
 *   goal-bridge-<插件版本>.ts   目标（/goal）那个扩展：判官会话里的 update_goal（源码见 goalBridgeSource.ts）
 *   title-bridge-<插件版本>.ts  自动起标题那个扩展（源码见 titleBridgeSource.ts）
 *   image-bridge-<插件版本>.ts  会话里的截图挪出会话文件（源码见 imageOffloadBridgeSource.ts）
 *   bash-bridge-<插件版本>.ts  把 bash 换成能「脱手到后台」的版本（源码见 bashBridgeSource.ts）
 *   env-bridge-<插件版本>.ts   把「加载了什么」（工具 / 技能 / MCP）报给插件（源码见 envBridgeSource.ts）
 *
 * 几套是同一个套路：文件名、源码、落盘后顺带干的活不一样，其余（内容变了才重写、
 * 清掉旧版本留下的文件、记一份结果）都一样，所以合成一处，差别放在下面的 BRIDGES 里。
 *
 * 目录走 pichatDir()：跟后端的设置 / 状态文件一个地方，设了 PICHAT_HOME 就跟着走
 * （调试时不碰用户真目录）。为什么写文件而不是直接用插件安装目录里那份：
 *   1. 安装目录里可能带空格，Windows 下拼命令行容易出问题；文件名里也顺手带上版本号；
 *   2. 打包时 .ts 不进 vsix（.vscodeignore 排掉了），所以扩展是字符串，运行时才落盘。
 * 绝不能写进 ~/.pi/agent/extensions/：那个目录 pi 会自动发现，用户在终端里手跑的 pi
 * 也会被塞上这些工具 —— 它们只有插件的会话里才有意义。
 *
 * 其中两套桥各自还要一个自己的目录（都在同一个资源目录下面）：
 *   taba-runs/<子会话编号>.json   子会话名录（启动 pi 时用 PICHAT_TABA_DIR 告诉扩展）
 *   ask-answers/<问话编号>.json   回话文件（启动 pi 时用 PICHAT_ASK_DIR 告诉扩展）
 *   bash/tasks/<任务编号>.log     后台命令的输出（启动 pi 时用 PICHAT_BASH_DIR 告诉扩展）
 *   bash/detach/<调用编号>        “把这条正在跑的命令切到后台”的指令（扩展跑命令时看着它）
 */
import * as fs from "fs";
import * as path from "path";
import { tabaBridgeSource } from "./tabaBridgeSource";
import { askBridgeSource } from "./askBridgeSource";
import { goalBridgeSource } from "./goalBridgeSource";
import { titleBridgeSource } from "./titleBridgeSource";
import { IMAGE_BRIDGE_SOURCE } from "./imageOffloadBridgeSource";
import { bashBridgeSource } from "./bashBridgeSource";
import { ENV_BRIDGE_SOURCE } from "./envBridgeSource";
import { type PromptOverrides } from "./promptText";
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
    /**
     * 落盘的那份源码。
     *
     * 是函数不是常量：工具说明那几句人能改（config.json 的 prompts 一节），写文件的时候把
     * 当前那一份拼进去。所以改完要重启后端（下次启动重写扩展文件，新开的会话才拿得到新话）。
     */
    source(over?: PromptOverrides): string;
    /** 落盘之后顺带干的活：建自己那份目录、清太老的残留。 */
    afterWrite(rootDir: string): void;
}

const BRIDGES: Record<"taba" | "ask" | "goal" | "title" | "image" | "bash" | "env", BridgeKind> = {
    taba: {
        prefix: "taba-bridge",
        source: tabaBridgeSource,
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
        source: askBridgeSource,
        afterWrite(rootDir: string): void {
            // 回话目录顺手建出来，并清掉没人来读的残留（插件或会话死了留下的）。
            fs.mkdirSync(askAnswersDir(rootDir), { recursive: true });
            cleanStaleAskAnswers(rootDir);
        },
    },
    goal: {
        prefix: "goal-bridge",
        source: goalBridgeSource,
        // 判官只报个结论，外面不留文件：不用建目录、不用清残留
        afterWrite(): void { /* 没别的活 */ },
    },
    title: {
        prefix: "title-bridge",
        source: titleBridgeSource,
        // 标题走 pi 自己的会话名，不要插件配合：不用建目录、不用清残留
        afterWrite(): void { /* 没别的活 */ },
    },
    image: {
        prefix: "image-bridge",
        source: () => IMAGE_BRIDGE_SOURCE,
        // 图落在 ~/.pi/agent/images/<会话 id>/（扩展自己建目录），不归这儿管：别去清它，那是用户的图
        afterWrite(): void { /* 没别的活 */ },
    },
    env: {
        prefix: "env-bridge",
        source: () => ENV_BRIDGE_SOURCE,
        // 只往 stderr 报清单，外面不留文件：不用建目录、不用清残留
        afterWrite(): void { /* 没别的活 */ },
    },
    bash: {
        prefix: "bash-bridge",
        source: bashBridgeSource,
        afterWrite(rootDir: string): void {
            // 两个目录先建出来：后台命令的输出、以及“放后台”的指令文件都在里面
            const base = path.join(rootDir, "bash");
            fs.mkdirSync(path.join(base, "tasks"), { recursive: true });
            fs.mkdirSync(path.join(base, "detach"), { recursive: true });
            // 上次插件留下的指令：会话早就没了，留着只会让下次那条同名调用莫名转后台
            for (const name of safeList(path.join(base, "detach"))) {
                try { fs.rmSync(path.join(base, "detach", name), { force: true }); } catch { /* 删不掉不影响用 */ }
            }
            // 后台命令的日志：太老的清掉（清单只活在本会话期间，老日志没人再看了）
            const cutoff = Date.now() - BASH_LOG_KEEP_MS;
            for (const name of safeList(path.join(base, "tasks"))) {
                const full = path.join(base, "tasks", name);
                try {
                    if (fs.statSync(full).mtimeMs < cutoff) { fs.rmSync(full, { force: true }); }
                } catch { /* 删不掉不影响用 */ }
            }
        },
    },
};

/** 后台命令的日志留多久（毫秒）：清单本来只活在本会话期间，更老的没人再看了。 */
const BASH_LOG_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

/** 列目录；列不出来就当空。 */
function safeList(dir: string): string[] {
    try { return fs.readdirSync(dir); } catch { return []; }
}

/** 版本号里能进文件名的那些字符。 */
function safeVersionForFile(version: string): string {
    const cleaned = (version || "").replace(/[^A-Za-z0-9._-]/g, "-");
    return cleaned || "0";
}

/** 把一套桥的扩展写进 rootDir。 */
function writeBridge(kind: BridgeKind, rootDir: string, version: string, over?: PromptOverrides): BridgeAssets {
    const extensionPath = path.join(rootDir, `${kind.prefix}-${safeVersionForFile(version)}.ts`);
    const source = kind.source(over);
    try {
        fs.mkdirSync(rootDir, { recursive: true });
        // 扩展文件：内容变了才重写（插件升级后的新行为要能生效）
        let current = "";
        try { current = fs.readFileSync(extensionPath, "utf8"); } catch { current = ""; }
        if (current !== source) {
            fs.writeFileSync(extensionPath, source, "utf8");
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

function ensureBridge(kind: BridgeKind, version: string, over?: PromptOverrides): BridgeAssets {
    const hit = cached.get(kind);
    if (hit) { return hit; }
    const result = writeBridge(kind, pichatDir(), version, over);
    cached.set(kind, result);
    return result;
}

/** 后端启动时调一次：写好派子会话那套桥，并记住结果。 */
export function ensureTabaAssets(version: string, over?: PromptOverrides): BridgeAssets {
    return ensureBridge(BRIDGES.taba, version, over);
}

/** 同上，问话（ask_choice）那套。 */
export function ensureAskAssets(version: string, over?: PromptOverrides): BridgeAssets {
    return ensureBridge(BRIDGES.ask, version, over);
}

/** 同上，目标（/goal）那套：只有判官会话加载它（update_goal）。 */
export function ensureGoalAssets(version: string, over?: PromptOverrides): BridgeAssets {
    return ensureBridge(BRIDGES.goal, version, over);
}

/** 同上，自动起标题那套：只有主会话加载它（子会话、判官不带）。 */
export function ensureTitleAssets(version: string, over?: PromptOverrides): BridgeAssets {
    return ensureBridge(BRIDGES.title, version, over);
}

/** 同上，把会话里的截图挪出去那一套：每个会话都带（子会话读图一样要挪）。 */
export function ensureImageAssets(version: string): BridgeAssets {
    return ensureBridge(BRIDGES.image, version);
}

/** 同上，接管 bash 那一套：每个会话都带（子会话、判官也跑命令）。 */
export function ensureBashAssets(version: string, over?: PromptOverrides): BridgeAssets {
    return ensureBridge(BRIDGES.bash, version, over);
}

/** 同上，报「加载了什么」那一套：每个会话都带（子会话的清单也可能要看）。 */
export function ensureEnvAssets(version: string): BridgeAssets {
    return ensureBridge(BRIDGES.env, version);
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

export function getTitleAssets(): BridgeAssets | undefined {
    return cached.get(BRIDGES.title);
}

export function getImageAssets(): BridgeAssets | undefined {
    return cached.get(BRIDGES.image);
}

export function getBashAssets(): BridgeAssets | undefined {
    return cached.get(BRIDGES.bash);
}

export function getEnvAssets(): BridgeAssets | undefined {
    return cached.get(BRIDGES.env);
}

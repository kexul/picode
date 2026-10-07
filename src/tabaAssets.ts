/**
 * 派子会话（taba）：要写进 ~/.pi/pichat/ 的两样东西，以及"写好了没有"。
 *
 *   taba-bridge-<插件版本>.ts   塞进 pi 进程的那个扩展（源码见 tabaBridgeSource.ts）
 *   taba-roles/*.md            插件自带的默认角色文件
 *
 * 为什么写到家目录而不是直接用插件安装目录里的文件：
 *   1. 插件安装目录里可能带空格，Windows 下拼命令行容易出问题（这里也顺手把版本号写进文件名）；
 *   2. 打包时 .ts 文件不会进 vsix（.vscodeignore 把 **\/*.ts 排掉了），所以源码是字符串，运行时才落盘。
 * 注意绝不能写进 ~/.pi/agent/extensions/：那个目录 pi 会自动发现，
 * 你在终端里手跑的 pi 也会被塞上这几个工具。
 *
 * 自带的角色文件只在**不存在时**才写：你可以自己改，改完不会被插件改回去。
 * 想让插件重写一遍，把 ~/.pi/pichat/taba-roles/ 整个删掉再重载窗口。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TABA_BRIDGE_SOURCE } from "./tabaBridgeSource";
import { cleanStaleRunFiles, tabaRunsDir } from "./tabaRunFiles";

/** 插件自带的默认角色文件（文件名 + 内容）。 */
export const DEFAULT_TABA_ROLES: Array<{ file: string; text: string }> = [
    {
        file: "scout.md",
        text: [
            "---",
            "name: scout",
            "description: 只读摸底：把某块代码看清了再回报，不改任何东西",
            "tools: read, bash",
            "session-mode: standalone",
            "---",
            "",
            "# 侦察角色",
            "",
            "你是摸底角色，只读不写：绝对不要改文件、不要跑会改东西的命令。",
            "",
            "怎么做：",
            "",
            "- 先看目录结构和入口文件，再顺着调用关系往下读，读到能回答问题为止。",
            "- 说结论要带证据：文件路径加行号，必要时贴关键几行原文。没读到就说没读到，不要猜。",
            "- 顺手记下容易踩的坑：命名习惯、边界情况、已有的测试怎么跑。",
            "- 快比全更重要：够对方做决定就行，不要顺手把整个项目通读一遍。",
            "",
        ].join("\n"),
    },
    {
        file: "worker.md",
        text: [
            "---",
            "name: worker",
            "description: 施工：照着说明改代码、跑验证、把改动交代清楚",
            "tools: read, bash, edit, write",
            "session-mode: standalone",
            "---",
            "",
            "# 施工角色",
            "",
            "你是施工角色，任务已经想清楚了，你的活是把它做出来。",
            "",
            "怎么做：",
            "",
            "- 先读相关文件，弄清现有写法，再动手；跟着这个项目的既有风格写，不要顺手重构成你喜欢的样子。",
            "- 一次只做任务说明里的事。看到别的问题就记下来，写在最后的交代里，不要自己扩大范围。",
            "- 有测试就跑测试，有编译就编译一遍，把实际结果写进交代（跑不通就如实说，不要假装通过）。",
            "- 最后一条回复要能让人不翻对话就明白：改了哪些文件、为什么这么改、验证到什么程度、还剩什么没做。",
            "",
        ].join("\n"),
    },
    {
        file: "reviewer.md",
        text: [
            "---",
            "name: reviewer",
            "description: 评审：只挑毛病，不动代码",
            "tools: read, bash",
            "session-mode: standalone",
            "---",
            "",
            "# 评审角色",
            "",
            "你是评审角色，只挑毛病，不改代码：绝对不要动文件。",
            "",
            "怎么做：",
            "",
            "- 先弄清这次改动的意图，再读实际改动（可以用 git diff 之类的命令看）。",
            "- 按严重程度分开说：会出错的、可能出错的、只是不好看的。每条都带文件路径加行号。",
            "- 只报你能指出证据的问题，不要凭印象推测，也不要为了凑数写无关痛痒的意见。",
            "- 没问题就直说没问题，不要硬找。",
            "",
        ].join("\n"),
    },
    {
        file: "planner.md",
        text: [
            "---",
            "name: planner",
            "description: 计划：把要做的事想清楚、拆成步骤，需要来回聊",
            "tools: read, bash",
            "session-mode: fork",
            "---",
            "",
            "# 计划角色",
            "",
            "你是做计划的角色，只读不写：绝对不要改文件。",
            "",
            "怎么做：",
            "",
            "- 先把不清楚的地方问出来，或者给出你的理解和几个可选方案，等对方挑。",
            "- 需要看代码就去读，读完再说；计划要落到具体的文件和步骤上，不要停在原则层面。",
            "- 计划写成有顺序的清单，每条写清做什么、动哪些文件、怎么验证做对了。",
            "- 有风险或有几种做法的地方单独列出来，说明各自的代价和你的建议。",
            "- 用户可能在这个会话里跟你来回聊好几轮，那就按聊的继续；不用急着收尾。",
            "",
        ].join("\n"),
    },
];

/** 写好了以后长什么样。 */
export interface TabaAssets {
    /** 都写好了才为 true；false 时插件就不给 pi 加载这个扩展（工具也就不会出现）。 */
    ok: boolean;
    /** 桥扩展文件路径；不可用时为空串。 */
    extensionPath: string;
    /** 插件自带资源的目录（角色文件在里面）；启动 pi 时用 PICHAT_TABA_DIR 告诉扩展。 */
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

/**
 * 把两样东西写进 rootDir。
 * @param rootDir 一般是 ~/.pi/pichat；单测里传临时目录
 * @param version 插件版本（写进扩展文件名，好让旧版本的文件能认出来并删掉）
 */
export function writeTabaAssets(rootDir: string, version: string): TabaAssets {
    const safe = safeVersionForFile(version);
    const extensionPath = path.join(rootDir, `taba-bridge-${safe}.ts`);
    const resourceDir = rootDir;
    const rolesDir = path.join(rootDir, "taba-roles");
    try {
        fs.mkdirSync(rolesDir, { recursive: true });
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
        // 自带角色：只在文件不存在时写，用户改过的不动
        for (const role of DEFAULT_TABA_ROLES) {
            const full = path.join(rolesDir, role.file);
            if (fs.existsSync(full)) { continue; }
            fs.writeFileSync(full, role.text, "utf8");
        }
        // 顺手清掉太老的子会话名录（子会话的 .jsonl 本身不动，那是 pi 的会话文件）
        cleanStaleRunFiles(tabaRunsDir(rootDir));
        return { ok: true, extensionPath, resourceDir };
    } catch (e: any) {
        return { ok: false, extensionPath: "", resourceDir: "", error: String(e?.message ?? e) };
    }
}

/** 插件自带角色文件所在目录（readRoles / 桥扩展都按这个约定找）。 */
export function tabaRolesDir(resourceDir: string): string {
    return path.join(resourceDir, "taba-roles");
}

/** 写给子会话的临时文件（例如角色说明要当系统提示词时）放这里。 */
export function tabaPromptsDir(resourceDir: string): string {
    return path.join(resourceDir, "taba-prompts");
}

let cached: TabaAssets | undefined;

/** 插件激活时调一次：写好两样东西并记住路径。 */
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

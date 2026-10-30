/**
 * 独立后端（pichat 服务）的设置文件读写。
 *
 * 后端所有设置（pi 路径、默认模型、网页服务、界面选项）都存在这一份 JSON 里，
 * VSCode 插件、网页页面、独立后端共用同一份；旧版曾把一部分放在 VSCode 的
 * settings.json 里，现已全部收拢到这份文件（~/.pi/pichat/config.json）。
 *
 * 读的时候不管文件里是什么都不抛异常：后端在启动早期就要这份配置，抛出去只会让人连界面
 * 都打不开。坏 JSON、类型不对的项一律回落默认值，把原因收集进 warnings 交上去给人看。
 */
import * as fs from "fs";
import * as path from "path";
import { serverConfigFile } from "./serverPaths";
import { normalizeOrigin } from "./webTransport";
import { isPromptKey, builtinPrompts } from "./promptText";
import {
    DEFAULT_AUTO_LOAD_LAST,
    DEFAULT_CLOSE_SESSION_KEY,
    DEFAULT_FOCUS_INPUT_KEY,
    DEFAULT_FONT_SIZE,
    DEFAULT_NEW_SESSION_KEY,
    DEFAULT_SEND_KEY,
    DEFAULT_TAB_SWITCH_KEY,
    DEFAULT_THEME_MODE,
    CLOSE_SESSION_KEYS,
    FOCUS_INPUT_KEYS,
    NEW_SESSION_KEYS,
    SEND_KEYS,
    TAB_SWITCH_KEYS,
    inList,
} from "./viewOptions";

export interface ServerWebSettings {
    port: number;
    host: string;
    /**
     * 人另外指定的来源（服务前面挂了一层 https 反代时用）：写成
     * `"https://metalbone.tail766f2b.ts.net"` 这样，页面就是这个地址打开的。
     * 不写就只能用本机地址、或同一网络里的 http 地址打开。
     */
    trustedOrigins: string[];
}

/**
 * 跨机器的“有事”提醒（另一台机器上的后端跑完一轮，往这台推一条）。
 *
 * 只改推送方那一台：notify.pushTo（推到哪儿去）+ notify.pushLabel（自己是哪台）。
 * 接收方什么都不用写（收到了就收）。不写 pushTo 就谁也不推。详见 src/remoteNotice.ts。
 *
 * 没有口令：这个后端本来就没有登录（README 里写着“只在信得过的网络里用”），
 * 再加一道通知口令只是多一处要人对着抄的东西。浏览器那边仍然过 Origin 那道关
 * （网页脚本没法替你往 /notify 里塞东西），机器对机器发的请求没有 Origin，照收。
 */
export interface ServerNotifySettings {
    /** 推到这些地址（对方网页服务的地址，比如 `http://10.0.0.2:51883`）；一个都没有 = 不推。 */
    pushTo: string[];
    /** 推到对方那边时显示的名字（空 = 用这台机器地址里的主机名）。 */
    pushLabel: string;
}

export interface ServerConfig {
    provider: string;
    model: string;
    autoLoadLast: boolean;
    sendKey: string;
    newSessionKey: string;
    closeSessionKey: string;
    tabSwitchKey: string;
    focusInputKey: string;
    fontSize: string;
    themeMode: "light" | "dark";
    /**
     * 人改过的提示词：键见 promptText.ts 的 PromptKey，值就是整段话。
     * 哪一项空着、或者根本不存在，就用内置原文（第一次启动会把内置原文写进来当起点）。
     */
    prompts: Record<string, string>;
    notify: ServerNotifySettings;
    webServer: ServerWebSettings;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** 默认值只此一份。深冻是为了防止调用方顺手改它，把后面所有读取也带偏。 */
export const DEFAULT_SERVER_CONFIG: ServerConfig = deepFreeze({
    provider: "",
    model: "",
    autoLoadLast: DEFAULT_AUTO_LOAD_LAST,
    sendKey: DEFAULT_SEND_KEY,
    newSessionKey: DEFAULT_NEW_SESSION_KEY,
    closeSessionKey: DEFAULT_CLOSE_SESSION_KEY,
    tabSwitchKey: DEFAULT_TAB_SWITCH_KEY,
    focusInputKey: DEFAULT_FOCUS_INPUT_KEY,
    fontSize: DEFAULT_FONT_SIZE,
    themeMode: DEFAULT_THEME_MODE,
    // 提示词默认全部空着（空 = 用内置原文）：具体文字在 promptText.ts，
    // 第一次启动后端会把内置原文填进来，人照着改就行
    prompts: {},
    // 跨机器的“有事”提醒默认不推（收到就收，不用写什么）
    notify: { pushTo: [], pushLabel: "" },
    // 默认对所有网卡开放（手机等设备打开地址就能用）；只给自己用就改 127.0.0.1，或启动时加 --host 127.0.0.1
    webServer: { port: 51883, host: "0.0.0.0", trustedOrigins: [] },
});

/** 让默认值对象（连着里面的数组、子对象）只读；不改调用方传进来的东西。 */
function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
        for (const key of Object.keys(value)) {
            deepFreeze((value as Record<string, unknown>)[key]);
        }
        Object.freeze(value);
    }
    return value;
}

/** 每次读都发一份新的默认值：界面会就地改拿到的配置，别让他们碰到共享的那个对象。 */
function defaults(): ServerConfig {
    return {
        ...DEFAULT_SERVER_CONFIG,
        prompts: {},
        notify: { ...DEFAULT_SERVER_CONFIG.notify, pushTo: [] },
        webServer: { ...DEFAULT_SERVER_CONFIG.webServer, trustedOrigins: [] },
    };
}

/** 已经去掉或改名的功能留下的键：老设置文件里可能还写着，读到时安静丢掉，不刷“不认识的项”。 */
const RETIRED_KEYS = new Set([
    "turnTitleWaitSeconds", "notifyBeep",
    // 不再让人配的几项：pi 走 PATH、永远信任项目、没有额外启动参数、子会话总是开
    "piPath", "extraArgs", "trustProject", "tabaEnabled",
    // 现在在设置面板里（存 state.json），不再从这儿读
    "notifyTurnEnd",
]);
/** 同上，webServer 那层里去掉的键。 */
const RETIRED_WEB_KEYS = new Set(["enabled"]);

/** JSON 里的对象（数组和 null 都不算）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把默认值写进提示里：空字符串直说"空"，省得提示里看不见那对引号。 */
function showDefault(value: unknown): string {
    if (value === "") return "（空字符串）";
    if (Array.isArray(value)) return value.length === 0 ? "（空列表）" : ` ${value.join(" ")}`;
    return ` ${String(value)}`;
}

/** 错误消息统一成一行；JSON.parse 的 message 里已经带了出错位置，够用来找问题。 */
function describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** 键没写就用默认值（不算错，第一次跑的文件里可能就缺项）；写了但类型不对才报一声。 */
function pickBoolean(value: unknown, fallback: boolean, label: string, warnings: string[]): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
        warnings.push(`${label} 不是 true/false，已用默认值${showDefault(fallback)}`);
        return fallback;
    }
    return value;
}

function pickString(value: unknown, fallback: string, label: string, warnings: string[]): string {
    if (value === undefined) return fallback;
    if (typeof value !== "string") {
        warnings.push(`${label} 不是字符串，已用默认值${showDefault(fallback)}`);
        return fallback;
    }
    return value;
}

/** 路径、监听地址这类：前后多粘一个空格多半是手误，去掉；去完是空的就当没填。 */
function pickNonEmptyString(value: unknown, fallback: string, label: string, warnings: string[]): string {
    if (value === undefined) return fallback;
    if (typeof value !== "string") {
        warnings.push(`${label} 不是字符串，已用默认值${showDefault(fallback)}`);
        return fallback;
    }
    const text = value.trim();
    if (text === "") {
        warnings.push(`${label} 是空的，已用默认值${showDefault(fallback)}`);
        return fallback;
    }
    return text;
}

/** 候选列表里的值（几个快捷键、字号这类）：不在列表里就用该列表的默认值。 */
function pickFromList(value: unknown, list: readonly string[], fallback: string, label: string, warnings: string[]): string {
    if (value === undefined) return fallback;
    if (!inList(list, value)) {
        warnings.push(`${label} 不在可选值里，已用默认值${showDefault(fallback)}`);
        return fallback;
    }
    return value;
}

/** 整数加范围检查；不是数、带小数、超出范围都算不合规。 */
function pickInt(value: unknown, min: number, max: number, fallback: number, label: string, warnings: string[], hint: string = ""): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        warnings.push(`${label} 得是 ${min} 到 ${max} 之间的整数${hint}，已用默认值${showDefault(fallback)}`);
        return fallback;
    }
    return value;
}

/**
 * 另外信得过的来源（反代那一层的地址）：一串字符串，每一项都规范化成“来源”的写法。
 * 写错的那几项只丢它自己（告一声），不把整份设置回落成默认值：别的项还好好的。
 */
function pickOrigins(value: unknown, warnings: string[]): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        warnings.push("webServer.trustedOrigins 不是数组，已当成空列表");
        return [];
    }
    const kept: string[] = [];
    let bad = 0;
    for (const item of value) {
        const origin = typeof item === "string" ? normalizeOrigin(item) : undefined;
        if (!origin) { bad += 1; continue; }
        if (!kept.includes(origin)) { kept.push(origin); }
    }
    if (bad > 0) {
        warnings.push(`webServer.trustedOrigins 里有 ${bad} 项不是 http / https 地址，已丢掉`);
    }
    return kept;
}

/**
 * 一组地址（比如 notify.pushTo）：只收 http / https 的，规范化成 `http://主机:端口`
 * （去掉末尾斜杠与路径），重复的并掉。
 */
function pickUrlList(value: unknown, label: string, warnings: string[]): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        warnings.push(`${label} 不是数组，已当成空列表`);
        return [];
    }
    const kept: string[] = [];
    let bad = 0;
    for (const item of value) {
        const base = typeof item === "string" ? normalizeOrigin(item) : undefined;
        if (!base) { bad += 1; continue; }
        if (!kept.includes(base)) { kept.push(base); }
    }
    if (bad > 0) {
        warnings.push(`${label} 里有 ${bad} 项不是 http / https 地址，已丢掉`);
    }
    return kept;
}

/** 一段文字（口令、名字这类）：不是字符串就当没写，空串照旧是空串（空 = 不启用）。 */
function pickText(value: unknown, label: string, warnings: string[]): string {
    if (value === undefined) return "";
    if (typeof value !== "string") {
        warnings.push(`${label} 不是字符串，已当成空的`);
        return "";
    }
    return value.trim();
}

/**
 * 一项提示词：字符串原样收；字符串列表按行拼起来（写长文本时比满屏 \n 好改）。
 * 类型不对就当没写（用内置原文）。
 */
function pickPromptValue(value: unknown, label: string, warnings: string[]): string | undefined {
    if (typeof value === "string") { return value; }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        return (value as string[]).join("\n");
    }
    warnings.push(`${label} 得是字符串，或者一行一项的字符串列表，已用内置原文`);
    return undefined;
}

/**
 * 提示词写回文件时的样子：一段一个字符串列表，一行一项。
 *
 * 为什么不照内存里那样整段写成一句：JSON 里换行只能写成 `\n`，一段话就成了一行，
 * 人改的时候既看不清、也插不进新的一行（改一句得在长线上找半天）。拆成一行一项以后，
 * 加一行就是加一行。读的时候两种写法都认（见 pickPromptValue），所以老文件不用人管。
 */
function promptsForFile(prompts: Record<string, string>): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, text] of Object.entries(prompts)) {
        // 只留一行、或者干脆是空的，原样写着就好（空 = 用内置原文）
        out[name] = text.includes("\n") ? text.split("\n") : text;
    }
    return out;
}

/** 文件里的提示词还是老写法：整段藏在一行里（换行是 `\n`），改起来费劲，启动时顺手重写一遍。 */
function promptsWrittenAsOneLine(raw: unknown): boolean {
    if (!isPlainObject(raw)) { return false; }
    const prompts = raw.prompts;
    if (!isPlainObject(prompts)) { return false; }
    return Object.values(prompts).some((value) => typeof value === "string" && value.includes("\n"));
}

/** 把任意来源的对象规范化成 ServerConfig。这层全是纯函数。 */
/**
 * 文件里还摆着、但现在已经不用的键（改名的、删掉的、搬到设置面板去的）：
 * 调用方拿它可以顺手把文件重写一遍，别让人对着一堆没用的项猜。
 */
function retiredKeysIn(raw: unknown): string[] {
    if (!isPlainObject(raw)) { return []; }
    const found = Object.keys(raw).filter((key) => RETIRED_KEYS.has(key));
    const web = raw.webServer;
    if (isPlainObject(web)) {
        for (const key of Object.keys(web)) {
            if (RETIRED_WEB_KEYS.has(key)) { found.push(`webServer.${key}`); }
        }
    }
    return found;
}

/**
 * promptsEmpty：文件里没有 prompts 那一节，或者有但是一项都没填。
 * 启动时靠它把内置原文补进去当起点。注意不能只看「有没有这一节」：
 * 只要人改过任何一项设置，写回文件时 prompts: {} 就会被写出来（那是空壳，不是一个选择）。
 * 已经填了几项的就不动（缺哪一项就用哪一项的内置）。
 */
export function normalizeServerConfig(raw: unknown): { config: ServerConfig; warnings: string[]; promptsEmpty: boolean } {
    const warnings: string[] = [];
    const config = defaults();
    if (!isPlainObject(raw)) {
        // 文件里可能就是个数组或字符串；照样给默认值，只提示一声
        warnings.push("配置内容不是一个对象，已全部用默认值");
        return { config, warnings, promptsEmpty: true };
    }

    const knownKeys = new Set(Object.keys(DEFAULT_SERVER_CONFIG));
    const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.has(key) && !RETIRED_KEYS.has(key));
    if (unknownKeys.length > 0) {
        // 多半是名字拼错了；留着也没用，说一声就丢
        warnings.push(`配置里有不认识的项：${unknownKeys.join("、")}`);
    }

    // ---- 启动 pi 用的参数（config.json 顶层：provider / model）----
    config.provider = pickString(raw.provider, DEFAULT_SERVER_CONFIG.provider, "provider", warnings);
    config.model = pickString(raw.model, DEFAULT_SERVER_CONFIG.model, "model", warnings);

    // ---- 显示选项（默认值都从 viewOptions 取，那边改这里跟着改）----
    config.autoLoadLast = pickBoolean(raw.autoLoadLast, DEFAULT_SERVER_CONFIG.autoLoadLast, "autoLoadLast", warnings);
    config.sendKey = pickFromList(raw.sendKey, SEND_KEYS, DEFAULT_SEND_KEY, "sendKey", warnings);
    config.newSessionKey = pickFromList(raw.newSessionKey, NEW_SESSION_KEYS, DEFAULT_NEW_SESSION_KEY, "newSessionKey", warnings);
    config.closeSessionKey = pickFromList(raw.closeSessionKey, CLOSE_SESSION_KEYS, DEFAULT_CLOSE_SESSION_KEY, "closeSessionKey", warnings);
    config.tabSwitchKey = pickFromList(raw.tabSwitchKey, TAB_SWITCH_KEYS, DEFAULT_TAB_SWITCH_KEY, "tabSwitchKey", warnings);
    config.focusInputKey = pickFromList(raw.focusInputKey, FOCUS_INPUT_KEYS, DEFAULT_FOCUS_INPUT_KEY, "focusInputKey", warnings);
    if (raw.fontSize !== undefined) {
        // 只收"14"这样的整数字符串：它最后要写进 CSS，别的写法容易出意想不到的结果
        if (typeof raw.fontSize === "string" && /^\d+$/.test(raw.fontSize)) {
            config.fontSize = raw.fontSize;
        } else {
            warnings.push(`fontSize 得是数字字符串（比如 "14"），已用默认值${showDefault(DEFAULT_FONT_SIZE)}`);
        }
    }
    if (raw.themeMode !== undefined) {
        if (raw.themeMode === "light" || raw.themeMode === "dark") {
            config.themeMode = raw.themeMode;
        } else {
            warnings.push(`themeMode 只能是 light 或 dark，已用默认值${showDefault(DEFAULT_THEME_MODE)}`);
        }
    }

    // ---- 提示词（config.json 的 prompts 一节）----
    // 空字符串 = 用内置原文（跟删掉这一项一个意思）
    let promptsEmpty = false;
    const promptsRaw = raw.prompts;
    if (promptsRaw === undefined) {
        promptsEmpty = true;
    } else if (!isPlainObject(promptsRaw)) {
        warnings.push("prompts 不是一个对象，已全部用内置原文");
    } else {
        if (Object.keys(promptsRaw).length === 0) { promptsEmpty = true; }
        for (const [name, value] of Object.entries(promptsRaw)) {
            if (!isPromptKey(name)) {
                warnings.push(`配置里有不认识的项：prompts.${name}`);
                continue;
            }
            const text = pickPromptValue(value, `prompts.${name}`, warnings);
            if (text !== undefined) { config.prompts[name] = text; }
        }
    }

    // ---- 跨机器的“有事”提醒（config.json 的 notify 一节）----
    const notify = raw.notify;
    if (notify !== undefined) {
        if (!isPlainObject(notify)) {
            warnings.push("notify 不是一个对象，已全部用默认值");
        } else {
            config.notify.pushTo = pickUrlList(notify.pushTo, "notify.pushTo", warnings);
            config.notify.pushLabel = pickText(notify.pushLabel, "notify.pushLabel", warnings);
            const knownNotifyKeys = new Set(Object.keys(DEFAULT_SERVER_CONFIG.notify));
            const unknownNotifyKeys = Object.keys(notify).filter((key) => !knownNotifyKeys.has(key));
            if (unknownNotifyKeys.length > 0) {
                warnings.push(`配置里有不认识的项：notify.${unknownNotifyKeys.join("、notify.")}`);
            }
        }
    }

    // ---- 网页服务（config.json 的 webServer 一节）----
    const web = raw.webServer;
    if (web !== undefined) {
        if (!isPlainObject(web)) {
            warnings.push("webServer 不是一个对象，已全部用默认值");
        } else {
            // 0 是合法值（让系统自动挑一个空闲端口），别当成没填
            config.webServer.port = pickInt(
                web.port, 0, 65535, DEFAULT_SERVER_CONFIG.webServer.port, "webServer.port", warnings, "（0 表示自动挑端口）",
            );
            config.webServer.host = pickNonEmptyString(web.host, DEFAULT_SERVER_CONFIG.webServer.host, "webServer.host", warnings);
            config.webServer.trustedOrigins = pickOrigins(web.trustedOrigins, warnings);
            const knownWebKeys = new Set(Object.keys(DEFAULT_SERVER_CONFIG.webServer));
            const unknownWebKeys = Object.keys(web).filter((key) => !knownWebKeys.has(key) && !RETIRED_WEB_KEYS.has(key));
            if (unknownWebKeys.length > 0) {
                warnings.push(`配置里有不认识的项：webServer.${unknownWebKeys.join("、webServer.")}`);
            }
        }
    }

    return { config, warnings, promptsEmpty };
}

/**
 * 提示词第一次能被改：把内置原文写进设置文件当起点，人照着字句改就行。
 * 已经填过就不动（那一节是空的才写）；删掉某一项 = 那一项回内置。
 * 放在这儿而不是启动器里：插件、独立后端、调试那一套都要它。
 */
export function seedPrompts(dir?: string): { seeded: boolean; file: string } {
    const read = readServerConfig(dir);
    if (!read.promptsEmpty) { return { seeded: false, file: read.file }; }
    const wrote = updateServerConfig({ prompts: builtinPrompts() }, dir);
    return { seeded: true, file: wrote.file };
}

/**
 * 读设置文件。
 *
 * existed 表示"盘上确实有这份文件"（读得到内容就算有，哪怕内容是坏 JSON）。
 * 为什么不是"这份文件当配置用得了"：启动器靠它决定要不要写一份默认文件出来，
 * 而人手工改坏的那份文件不能被默认值默默盖掉——那是他的设置，提示一行让他自己去修就好。
 * 内容能不能用看 warnings：有 warning 就是有项回落到默认值了（坏 JSON 也是全回默认值）。
 */
export function readServerConfig(dir?: string): {
    config: ServerConfig;
    file: string;
    existed: boolean;
    warnings: string[];
    retired: string[];
    /** 文件里没有 prompts 那一节、或者一项都没填（启动时据此把内置提示词补进去）。 */
    promptsEmpty: boolean;
    /** 提示词还是老写法：一段写成一行（内容一样，只是断行藏在 `\n` 里）。 */
    promptsOneLine: boolean;
} {
    const file = serverConfigFile(dir);
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (err) {
        // 第一次跑时文件还没建，这是正常情况，不该报警
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return {
                config: defaults(), file, existed: false, warnings: [], retired: [],
                promptsEmpty: true, promptsOneLine: false,
            };
        }
        return {
            config: defaults(), file, existed: false, retired: [], promptsEmpty: false, promptsOneLine: false,
            warnings: [`读设置文件失败：${file}（${describeError(err)}）`],
        };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        // 坏 JSON 不让整个后端起不来：不抛，全用默认值，把路径和原因带出去给人修
        // （也不补提示词：那份文件是人手改坏的，不要再往上盖东西）
        return {
            config: defaults(),
            file,
            existed: true,
            retired: [],
            promptsEmpty: false,
            promptsOneLine: false,
            warnings: [`设置文件不是合法的 JSON：${file}（${describeError(err)}）`],
        };
    }

    const { config, warnings, promptsEmpty } = normalizeServerConfig(raw);
    return {
        config, file, existed: true, warnings, retired: retiredKeysIn(raw),
        promptsEmpty, promptsOneLine: promptsWrittenAsOneLine(raw),
    };
}

/** 把 patch 合并进现有设置，写回文件，返回写完的结果。 */
export function updateServerConfig(patch: DeepPartial<ServerConfig>, dir?: string): { config: ServerConfig; file: string; warnings: string[] } {
    // 先读再合：文件里可能还有别的项，直接拿 patch 覆盖会把它们冲掉
    const read = readServerConfig(dir);
    const { config, warnings } = normalizeServerConfig(mergeServerConfig(read.config, patch));
    const file = read.file;

    const problems: string[] = [];
    try {
        // 写全量而不是只写 patch：人打开文件能看见所有可改的项，也好照着改
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // 只有提示词换个写法（一行一项）：内存里还是整段一句，拼提示词那边照旧
        fs.writeFileSync(file, `${JSON.stringify({ ...config, prompts: promptsForFile(config.prompts) }, null, 2)}\n`, "utf8");
    } catch (err) {
        // 写不动（目录没权限、盘满）也别抛：设置改不了是小事，别把正在跑的会话带崩
        problems.push(`写设置文件失败：${file}（${describeError(err)}）`);
    }

    return { config, file, warnings: [...read.warnings, ...warnings, ...problems] };
}

/**
 * 把 patch 叠到现有配置上：只覆盖 patch 里出现过的项，其它项保持原值（包括手写的）。
 * webServer 要一层层并，不然只改端口会把同层的 host 冲回默认。
 */
function mergeServerConfig(base: ServerConfig, patch: DeepPartial<ServerConfig>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base };
    if (!isPlainObject(patch)) return merged;
    const baseRecord = base as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        // 一节一节的（webServer、notify）是“改这一项”，不是“整节换掉”：只覆盖给到的键。
        // 不这样的话，改 notify.pushLabel 会把 notify.pushTo 一起打回默认值。
        const old = baseRecord[key];
        if (isPlainObject(value) && isPlainObject(old)) {
            merged[key] = { ...(old as Record<string, unknown>), ...(value as Record<string, unknown>) };
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

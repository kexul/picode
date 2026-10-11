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
import {
    DEFAULT_AUTO_LOAD_LAST,
    DEFAULT_FOCUS_INPUT_KEY,
    DEFAULT_FONT_SIZE,
    DEFAULT_NEW_SESSION_KEY,
    DEFAULT_NOTIFY_BEEP,
    DEFAULT_SEND_KEY,
    DEFAULT_TAB_SWITCH_KEY,
    DEFAULT_THEME_MODE,
    DEFAULT_TURN_TITLE_WAIT_SECONDS,
    FOCUS_INPUT_KEYS,
    NEW_SESSION_KEYS,
    SEND_KEYS,
    TAB_SWITCH_KEYS,
    inList,
} from "./viewOptions";

export interface ServerWebSettings {
    enabled: boolean;
    port: number;
    host: string;
}

export interface ServerConfig {
    piPath: string;
    provider: string;
    model: string;
    extraArgs: string[];
    trustProject: boolean;
    tabaEnabled: boolean;
    autoLoadLast: boolean;
    sendKey: string;
    newSessionKey: string;
    tabSwitchKey: string;
    focusInputKey: string;
    fontSize: string;
    notifyBeep: boolean;
    themeMode: "light" | "dark";
    turnTitleWaitSeconds: number;
    webServer: ServerWebSettings;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** 默认值只此一份。深冻是为了防止调用方顺手改它，把后面所有读取也带偏。 */
export const DEFAULT_SERVER_CONFIG: ServerConfig = deepFreeze({
    piPath: "pi",
    provider: "",
    model: "",
    extraArgs: [],
    trustProject: true,
    tabaEnabled: true,
    autoLoadLast: DEFAULT_AUTO_LOAD_LAST,
    sendKey: DEFAULT_SEND_KEY,
    newSessionKey: DEFAULT_NEW_SESSION_KEY,
    tabSwitchKey: DEFAULT_TAB_SWITCH_KEY,
    focusInputKey: DEFAULT_FOCUS_INPUT_KEY,
    fontSize: DEFAULT_FONT_SIZE,
    notifyBeep: DEFAULT_NOTIFY_BEEP,
    themeMode: DEFAULT_THEME_MODE,
    turnTitleWaitSeconds: DEFAULT_TURN_TITLE_WAIT_SECONDS,
    // 默认对所有网卡开放（手机等设备打开地址就能用）；只给自己用就改 127.0.0.1，或启动时加 --host 127.0.0.1
    webServer: { enabled: true, port: 51883, host: "0.0.0.0" },
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
        extraArgs: [],
        webServer: { ...DEFAULT_SERVER_CONFIG.webServer },
    };
}

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

/** 把任意来源的对象规范化成 ServerConfig。这层全是纯函数，测试重点在这里。 */
export function normalizeServerConfig(raw: unknown): { config: ServerConfig; warnings: string[] } {
    const warnings: string[] = [];
    const config = defaults();
    if (!isPlainObject(raw)) {
        // 文件里可能就是个数组或字符串；照样给默认值，只提示一声
        warnings.push("配置内容不是一个对象，已全部用默认值");
        return { config, warnings };
    }

    const knownKeys = new Set(Object.keys(DEFAULT_SERVER_CONFIG));
    const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.has(key));
    if (unknownKeys.length > 0) {
        // 多半是名字拼错了；留着也没用，说一声就丢
        warnings.push(`配置里有不认识的项：${unknownKeys.join("、")}`);
    }

    // ---- 启动 pi 用的参数（config.json 顶层：piPath / provider / model / extraArgs / trustProject）----
    config.piPath = pickNonEmptyString(raw.piPath, DEFAULT_SERVER_CONFIG.piPath, "piPath", warnings);
    config.provider = pickString(raw.provider, DEFAULT_SERVER_CONFIG.provider, "provider", warnings);
    config.model = pickString(raw.model, DEFAULT_SERVER_CONFIG.model, "model", warnings);
    if (raw.extraArgs !== undefined) {
        if (!Array.isArray(raw.extraArgs)) {
            warnings.push(`extraArgs 不是数组，已用默认值${showDefault([])}`);
        } else {
            // 混进来的非字符串没法当命令行参数用，挑出去丢掉，剩下的照原顺序留着
            const kept = raw.extraArgs.filter((item): item is string => typeof item === "string");
            const dropped = raw.extraArgs.length - kept.length;
            if (dropped > 0) {
                warnings.push(`extraArgs 里有 ${dropped} 项不是字符串，已丢掉`);
            }
            config.extraArgs = kept;
        }
    }
    config.trustProject = pickBoolean(raw.trustProject, DEFAULT_SERVER_CONFIG.trustProject, "trustProject", warnings);
    config.tabaEnabled = pickBoolean(raw.tabaEnabled, DEFAULT_SERVER_CONFIG.tabaEnabled, "tabaEnabled", warnings);

    // ---- 显示选项（默认值都从 viewOptions 取，那边改这里跟着改）----
    config.autoLoadLast = pickBoolean(raw.autoLoadLast, DEFAULT_SERVER_CONFIG.autoLoadLast, "autoLoadLast", warnings);
    config.sendKey = pickFromList(raw.sendKey, SEND_KEYS, DEFAULT_SEND_KEY, "sendKey", warnings);
    config.newSessionKey = pickFromList(raw.newSessionKey, NEW_SESSION_KEYS, DEFAULT_NEW_SESSION_KEY, "newSessionKey", warnings);
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
    config.notifyBeep = pickBoolean(raw.notifyBeep, DEFAULT_SERVER_CONFIG.notifyBeep, "notifyBeep", warnings);
    if (raw.themeMode !== undefined) {
        if (raw.themeMode === "light" || raw.themeMode === "dark") {
            config.themeMode = raw.themeMode;
        } else {
            warnings.push(`themeMode 只能是 light 或 dark，已用默认值${showDefault(DEFAULT_THEME_MODE)}`);
        }
    }
    config.turnTitleWaitSeconds = pickInt(
        raw.turnTitleWaitSeconds, 0, 60, DEFAULT_TURN_TITLE_WAIT_SECONDS, "turnTitleWaitSeconds", warnings,
    );

    // ---- 网页服务（config.json 的 webServer 一节）----
    const web = raw.webServer;
    if (web !== undefined) {
        if (!isPlainObject(web)) {
            warnings.push("webServer 不是一个对象，已全部用默认值");
        } else {
            config.webServer.enabled = pickBoolean(web.enabled, DEFAULT_SERVER_CONFIG.webServer.enabled, "webServer.enabled", warnings);
            // 0 是合法值（让系统自动挑一个空闲端口），别当成没填
            config.webServer.port = pickInt(
                web.port, 0, 65535, DEFAULT_SERVER_CONFIG.webServer.port, "webServer.port", warnings, "（0 表示自动挑端口）",
            );
            config.webServer.host = pickNonEmptyString(web.host, DEFAULT_SERVER_CONFIG.webServer.host, "webServer.host", warnings);
            const knownWebKeys = new Set(Object.keys(DEFAULT_SERVER_CONFIG.webServer));
            const unknownWebKeys = Object.keys(web).filter((key) => !knownWebKeys.has(key));
            if (unknownWebKeys.length > 0) {
                warnings.push(`配置里有不认识的项：webServer.${unknownWebKeys.join("、webServer.")}`);
            }
        }
    }

    return { config, warnings };
}

/**
 * 读设置文件。
 *
 * existed 表示"盘上确实有这份文件"（读得到内容就算有，哪怕内容是坏 JSON）。
 * 为什么不是"这份文件当配置用得了"：启动器靠它决定要不要写一份默认文件出来，
 * 而人手工改坏的那份文件不能被默认值默默盖掉——那是他的设置，提示一行让他自己去修就好。
 * 内容能不能用看 warnings：有 warning 就是有项回落到默认值了（坏 JSON 也是全回默认值）。
 */
export function readServerConfig(dir?: string): { config: ServerConfig; file: string; existed: boolean; warnings: string[] } {
    const file = serverConfigFile(dir);
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (err) {
        // 第一次跑时文件还没建，这是正常情况，不该报警
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return { config: defaults(), file, existed: false, warnings: [] };
        }
        return { config: defaults(), file, existed: false, warnings: [`读设置文件失败：${file}（${describeError(err)}）`] };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        // 坏 JSON 不让整个后端起不来：不抛，全用默认值，把路径和原因带出去给人修
        return {
            config: defaults(),
            file,
            existed: true,
            warnings: [`设置文件不是合法的 JSON：${file}（${describeError(err)}）`],
        };
    }

    const { config, warnings } = normalizeServerConfig(raw);
    return { config, file, existed: true, warnings };
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
        fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (key === "webServer" && isPlainObject(value)) {
            merged.webServer = { ...base.webServer, ...value };
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

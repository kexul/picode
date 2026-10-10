import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import { POWERSHELL_APP_USER_MODEL_ID, encodePowerShell, quote } from "./toastScript";

/**
 * 在注册表里登记一个属于本插件的“应用标识”（AppUserModelId）。
 *
 * Windows 用它决定通知卡片上显示的来源名与图标。系统自带的 PowerShell 标识虽然
 * 不用登记就能弹通知（已实测），但来源会显示成 “Windows PowerShell”，和 Pi Chat 无关。
 * 登记自己的标识后，通知来源就是 “Pi Chat”，图标借用 VS Code 的可执行文件图标。
 *
 * 只写当前用户的注册表项 HKCU\SOFTWARE\Classes\AppUserModelId\<标识>，
 * 不需要管理员权限，不影响系统其它程序；写失败（比如被安全策略拦下）时
 * 会回落到 PowerShell 标识，保证通知一定还能发出去。
 *
 * 登记要跑一次 PowerShell，有的机器上这一下要好几秒，所以放在后台异步做：
 * 插件激活不等它，第一次要弹通知时才等结果（见 turnNotifier.ts）。
 * 登记成功一次就记住（存在 VSCode 的 globalState 里），插件版本或图标路径没变
 * 就不再重复写注册表，之后每次重载窗口这一步零开销。
 */

/** 本插件的通知标识。 */
export const PICHAT_APP_USER_MODEL_ID = "PiChat.VSCodeExtension";

/** 记住登记结果用的存储：平时传 vscode 的 context.globalState，测试里可以传假对象。 */
export interface ToastAppIdStore {
    get(key: string): unknown;
    update(key: string, value: unknown): PromiseLike<void>;
}

/** 记住“哪个版本、哪个图标路径时登记成功过”。 */
const REGISTERED_CACHE_KEY = "toastAppId.registered";

interface RegisteredCache {
    version: string;
    iconPath: string;
}

/** 从 globalState 里读上次登记成功的记录；读不出来就当没登记过。 */
function readRegisteredCache(store: ToastAppIdStore): RegisteredCache | undefined {
    try {
        const raw = store.get(REGISTERED_CACHE_KEY) as Partial<RegisteredCache> | undefined;
        if (raw && typeof raw === "object" && typeof raw.version === "string") {
            return { version: raw.version, iconPath: typeof raw.iconPath === "string" ? raw.iconPath : "" };
        }
    } catch { /* 读不出来就当没登记过，重新登记一次也无妨 */ }
    return undefined;
}

/**
 * 在后台登记本插件的通知标识；立刻返回，登记结果从返回的承诺里拿。
 * 承诺一定会变成一个能用的标识：登记成功是本插件标识，失败是系统 PowerShell 回落标识。
 *
 * @param store 存“登记成功过”的记录（context.globalState）
 * @param version 插件版本（变了才重写注册表）
 * @param displayName 通知来源显示的名字
 * @param iconPath 通知图标用的文件路径（变了也重写）
 */
export function ensureToastAppIdAsync(
    store: ToastAppIdStore,
    version: string,
    displayName: string,
    iconPath?: string,
): Promise<string> {
    try {
        if (process.platform !== "win32") { return Promise.resolve(POWERSHELL_APP_USER_MODEL_ID); }
        // 同一版本、图标路径也没变，说明上次写进注册表的内容还在，直接用。
        const cached = readRegisteredCache(store);
        if (cached && cached.version === version && cached.iconPath === (iconPath ?? "")) {
            return Promise.resolve(PICHAT_APP_USER_MODEL_ID);
        }
    } catch {
        return Promise.resolve(POWERSHELL_APP_USER_MODEL_ID);
    }
    return registerWithRetry(displayName, iconPath).then((ok) => {
        if (!ok) { return POWERSHELL_APP_USER_MODEL_ID; }
        // 记下“这个版本登记过了”，以后重载窗口不再跑 PowerShell。记不住也只是每次重写一遍。
        try { void store.update(REGISTERED_CACHE_KEY, { version, iconPath: iconPath ?? "" }); } catch { /* 忽略 */ }
        return PICHAT_APP_USER_MODEL_ID;
    });
}

const MAX_RETRY = 3;

/** 试着把注册表写好；成功返回 true，重试用完或被拒绝访问就放弃（调用方回落系统标识）。 */
async function registerWithRetry(displayName: string, iconPath?: string): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        try {
            await registerAppId(displayName, iconPath);
            return true;
        } catch (err) {
            const text = String((err as Error)?.message ?? err);
            // “拒绝访问”一般是别的安全软件占着注册表或权限被收紧，重试通常没用。
            if (/access is denied|拒绝访问/i.test(text)) { break; }
        }
    }
    return false;
}

/** 写 HKCU 下的应用标识项。 */
function registerAppId(displayName: string, iconPath?: string): Promise<void> {
    const lines: string[] = [
        "$ErrorActionPreference = 'Stop'",
        "$key = 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\" + PICHAT_APP_USER_MODEL_ID + "'",
        "New-Item -Path $key -Force | Out-Null",
        "Set-ItemProperty -Path $key -Name DisplayName -Value " + quote(displayName),
        "Set-ItemProperty -Path $key -Name ShowInActionCenter -Value 1 -Type DWord",
    ];
    if (iconPath) {
        // 图标路径可能有空格；先确认文件真的存在才写（quote 已保证路径只当数据用）。
        lines.push("if (Test-Path -LiteralPath " + quote(iconPath) + ") {");
        lines.push("    Set-ItemProperty -Path $key -Name IconUri -Value " + quote(iconPath));
        lines.push("}");
    }
    return runPowerShellAsync(lines.join("\r\n"));
}

/** 后台跑一小段 PowerShell 写注册表；出错时把能看懂的原因（stderr 第一行）抛出来。 */
function runPowerShellAsync(script: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const exe = (process.env.PICHAT_POWERSHELL ?? "").trim() || "powershell.exe";
        const encoded = encodePowerShell(script);
        cp.execFile(
            exe,
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            { windowsHide: true, encoding: "utf8", timeout: 15000 },
            (err, stdout, stderr) => {
                if (!err) { resolve(); return; }
                const detail = (String(stderr ?? "") || String(stdout ?? "")).trim().split("\n")[0] ?? "";
                reject(new Error(detail || err.message || `PowerShell 退出码 ${String(err.code ?? "?")}`));
            },
        );
    });
}

/** VS Code 的可执行文件路径（拿它的图标当通知图标）；找不到返回 undefined。 */
export function vsCodeIconPath(): string | undefined {
    try {
        const candidates = [
            vscode.Uri.joinPath(vscode.Uri.file(vscode.env.appRoot), "..", "Code.exe").fsPath,
            vscode.Uri.joinPath(vscode.Uri.file(vscode.env.appRoot), "..", "Code - Insiders.exe").fsPath,
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) { return c; }
        }
    } catch { /* 忽略 */ }
    return undefined;
}

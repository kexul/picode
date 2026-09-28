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
 */

/** 本插件的通知标识。 */
export const PICHAT_APP_USER_MODEL_ID = "PiChat.VSCodeExtension";



const MAX_RETRY = 3;

/** 登记本插件的通知标识；返回实际要用的标识（失败则回落）。 */
export function ensureToastAppId(displayName: string, iconPath?: string): string {
    if (process.platform !== "win32") { return POWERSHELL_APP_USER_MODEL_ID; }
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        try {
            registerAppId(displayName, iconPath);
            return PICHAT_APP_USER_MODEL_ID;
        } catch (err) {
            const text = String((err as Error)?.message ?? err);
            // “拒绝访问”一般是别的安全软件占着注册表或权限被收紧，重试通常没用。
            if (/access is denied|拒绝访问/i.test(text)) { break; }
        }
    }
    return POWERSHELL_APP_USER_MODEL_ID;
}

/** 写 HKCU 下的应用标识项。 */
function registerAppId(displayName: string, iconPath?: string): void {
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
    runPowerShell(lines.join("\r\n"));
}

/** 同步跑一小段 PowerShell（写注册表只发生一次，阻塞几毫秒可以接受）。 */
function runPowerShell(script: string): void {
    const exe = (process.env.PICHAT_POWERSHELL ?? "").trim() || "powershell.exe";
    const encoded = encodePowerShell(script);
    const result = cp.spawnSync(
        exe,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { windowsHide: true, encoding: "utf8", timeout: 15000 },
    );
    if (result.error) { throw result.error; }
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || "").trim().split("\n")[0] ?? "";
        throw new Error(detail || `PowerShell 退出码 ${result.status}`);
    }
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

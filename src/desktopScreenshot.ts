import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * desktopScreenshot —— 截一张当前桌面（Windows）。
 *
 * 给网页端的“桌面截图”按钮用：浏览器页面可能开在手机上，截的是运行 VSCode 插件
 * 这台电脑的桌面。不加 npm 依赖，直接调 Windows 自带的 PowerShell + .NET
 * （System.Drawing）：把所有显示器拼成的那块“虚拟桌面”（VirtualScreen）整块
 * 拍下来，存成一个临时 PNG 再读回来。
 * 其它系统目前不支持，返回 ok: false 的结果，页面上弹一句提示。
 */

export type DesktopScreenshotResult =
    | { ok: true; data: string; mimeType: string }
    | { ok: false; error: string };

/** PowerShell 的超时。正常一两秒就该完事，留足余量；到点进程会被杀掉。 */
const POWERSHELL_TIMEOUT_MS = 20000;

/** 截一张桌面。永远不 reject：失败也以 ok: false 的结果返回。 */
export async function captureDesktopScreenshot(): Promise<DesktopScreenshotResult> {
    if (process.platform !== "win32") {
        return { ok: false, error: "桌面截图目前只在 Windows 上可用。" };
    }
    const file = path.join(os.tmpdir(), `pi-chat-screen-${process.pid}-${Date.now()}.png`);
    try {
        await runScreenshotPowerShell(file);
        const png = await fs.promises.readFile(file);
        // PNG 文件头以 89 50 ("‌\x89P") 开头。太短或头不对，说明截出来的是坏文件。
        if (png.length < 100 || png[0] !== 0x89 || png[1] !== 0x50) {
            return { ok: false, error: "截屏没有产出有效的图片（屏幕锁定或远程会话断开时可能这样）。" };
        }
        return { ok: true, data: png.toString("base64"), mimeType: "image/png" };
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `桌面截图失败：${detail}` };
    } finally {
        // 临时文件用完就删；删不掉（被占用之类）也不影响结果
        fs.promises.unlink(file).catch(() => { /* 忽略 */ });
    }
}

/** 起一个 PowerShell 把整块虚拟桌面存成 PNG。执行失败（非零退出 / 超时）时 reject。 */
function runScreenshotPowerShell(file: string): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", screenshotPowerShellScript(file)],
            { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
            (err, stdout) => {
                if (err) {
                    const note = stdout && String(stdout).trim() ? `（${String(stdout).trim()}）` : "";
                    reject(new Error(`PowerShell 执行失败：${err.message}${note}`));
                    return;
                }
                resolve();
            },
        );
    });
}

/**
 * 拼出截屏用的 PowerShell 脚本全文（单测里检查它）。
 * @param file 截图存到的 PNG 路径；路径里的单引号按 PowerShell 的规矩写成两个
 */
export function screenshotPowerShellScript(file: string): string {
    const psFile = file.replace(/'/g, "''");
    return [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
        "Add-Type -AssemblyName System.Drawing | Out-Null",
        // 声明进程 DPI 感知：不声明的话，高分屏（缩放 125% / 150% 那些）上截出来
        // 是被系统缩小过的模糊图。必须在真正取屏幕尺寸之前调用。
        `Add-Type -TypeDefinition 'namespace PiChatScreen { using System.Runtime.InteropServices; public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); } }'`,
        "[PiChatScreen.Dpi]::SetProcessDPIAware() | Out-Null",
        // VirtualScreen 是所有显示器拼起来的那一整块（含负坐标，比如显示器在主屏左边时）
        "$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen",
        "$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height",
        "$g = [System.Drawing.Graphics]::FromImage($bmp)",
        "$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)",
        "$g.Dispose()",
        `$bmp.Save('${psFile}', [System.Drawing.Imaging.ImageFormat]::Png)`,
        "$bmp.Dispose()",
        "Write-Output done",
    ].join("\n");
}

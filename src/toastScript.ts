/**
 * 生成“弹 Windows 通知”的那段 PowerShell 脚本。
 *
 * 单独成一个文件、且不引用 vscode：这样这段纯文本拼接可以离开扩展宿主直接跑测试
 * （见 toastNotification.test.ts）。
 */

/** 回落用的系统自带标识（无需登记，一定能弹，但来源显示 Windows PowerShell）。 */
export const POWERSHELL_APP_USER_MODEL_ID = "Microsoft.Windows.PowerShell_8wekyb3d8bbwe";

/** 通知在 Windows 通知中心里最多留多久；到点连记录一起消失，不让你自己去清。
 *  卡片本身在屏幕右下角停多久不由我们写：脚本不写 duration 属性，走系统默认的约 7 秒
 *  （写 duration="long" 会变成约 25 秒）。 */
export const TOAST_EXPIRE_SECONDS = 60;

/** 通知的“应用标识”（AppUserModelId）：系统用它决定通知卡片显示的来源名与图标。 */
export interface ToastScriptInput {
    /** 通知文字的 JSON 临时文件；脚本会派生同名的 .done 标记文件。 */
    dataFile: string;
    appUserModelId: string;
    /** 通知上的来源标签，如 "Pi Chat"。 */
    appLabel: string;
    /** 多少秒后这条通知彻底消失（含通知中心里的记录）；0 表示一直留着。 */
    expireAfterSeconds: number;
    /**
     * 发完通知后脚本还留着多久（毫秒）。
     * 系统要靠这个进程去执行“到点失效”，所以这个值要大于上面那个失效秒数，
     * 否则进程先退出，通知就会一直留在通知中心里。
     */
    keepAliveMs: number;
}

/**
 * 拼出脚本正文。
 *
 * 注意这段是 TypeScript 的模板字符串，所以 PowerShell 自己的变量都写成两个 $，
 * 末尾再用 replace 折回一个 $，免得被 TypeScript 当成插值。
 */
export function buildToastScript(input: ToastScriptInput): string {
    const script = `
$$ErrorActionPreference = 'Stop'
$$ProgressPreference = 'SilentlyContinue'
function Attr([string]$$s) {
    if ($$null -eq $$s) { return '' }
    return $$s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')
}
$$batch = ${quote(input.dataFile)}
$$done = $$batch + '.done'
$$aumid = ${quote(input.appUserModelId)}
$$expireAfter = ${Math.max(0, Math.round(input.expireAfterSeconds))}
$$items = @()
try {
    $$raw = Get-Content -Path $$batch -Raw -Encoding UTF8
    $$items = @($$raw | ConvertFrom-Json)
} catch { $$items = @() }
Remove-Item -Path $$batch -Force -ErrorAction SilentlyContinue
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($$aumid)
foreach ($$item in $$items) {
    $$template = '<toast>' +
        '<visual><binding template="ToastGeneric">' +
        '<text>' + (Attr([string]$$item.title)) + '</text>' +
        '<text>' + (Attr([string]$$item.body)) + '</text>' +
        '<text placement="attribution">' + (Attr([string]$$item.attribution)) + '</text>' +
        '</binding></visual>' +
        '<audio src="ms-winsoundevent:Notification.Default" />' +
        '</toast>'
    $$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $$xml.LoadXml($$template)
    $$toast = New-Object Windows.UI.Notifications.ToastNotification $$xml
    if ($$expireAfter -gt 0) {
        try { $$toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds($$expireAfter) } catch { }
    }
    $$notifier.Show($$toast)
}
if ($$items.Count -gt 0) { Set-Content -Path $$done -Value 'ok' -Encoding UTF8 }
Start-Sleep -Milliseconds ${Math.max(0, Math.round(input.keepAliveMs))}
Remove-Item -Path $$done -Force -ErrorAction SilentlyContinue
`.replace(/\$\$/g, "$");
    return script;
}

/** 去掉 PowerShell 单引号字符串里的“活字符”，保证文字只当数据用（防命令注入）。 */
export function escapePs(text: string): string {
    return String(text ?? "").replace(/[`$]/g, "").replace(/'/g, "''");
}

/** 把文字包成 PowerShell 单引号字符串。 */
export function quote(text: string): string {
    return `'${escapePs(text)}'`;
}

/** 把脚本转成 -EncodedCommand 需要的 base64（UTF-16LE）。 */
export function encodePowerShell(script: string): string {
    return Buffer.from(script, "utf16le").toString("base64");
}

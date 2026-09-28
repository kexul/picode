import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { TurnEndInfo } from "./runtimeTypes";
import { POWERSHELL_APP_USER_MODEL_ID, TOAST_EXPIRE_SECONDS, buildToastScript, encodePowerShell } from "./toastScript";

/**
 * turnNotifier —— 一轮对话结束时提醒用户。
 *
 * 为什么放在扩展宿主、不再只靠网页视图（webview）里的提示音：
 * 网页视图被隐藏或窗口切到后台时，它的音频与定时器会被降速甚至挂起，
 * 结果就是“会话跑完了却一点动静都没有”。扩展宿主进程一直在跑，不受窗口可见性影响。
 *
 * 提醒分两条腿：
 *   1. Windows 系统通知（屏幕右下角卡片，同时进通知中心）—— 走 PowerShell 调系统的
 *      通知接口，插件本身零第三方依赖。窗口在前台也会发（用户要求“只要任务完成就弹”）。
 *   2. VS Code 界面里的一条提示 —— 用 window.withProgress(Location.Window)。
 *      窗口不在前台时，它还会让 Windows 闪烁任务栏图标，最小化也能被看到；
 *      系统通知已经发成功、且窗口在前台时就不重复发（卡片本身已经带声音和提醒）。
 *
 * toast 的实现细节：
 *   - 本批通知的文字先写成一个 UTF-8 JSON 临时文件，PowerShell 读它；
 *   - PowerShell 脚本本身用 base64（UTF-16LE）经 -EncodedCommand 传入，
 *     这样脚本正文和通知文字都不用担心引号、反引号、$ 符、中文编码问题；
 *   - 卡片在右下角停约 7 秒（系统默认）后收进通知中心，60 秒后连记录一起消失；
 *   - 脚本每发完一批通知会写一个 .done 标记文件；扩展看到它就知道“发出去了”，
 *     等不到就认定这台机器发不出来，改在 VS Code 界面里提示，不会静默失败。
 */

/** 一条通知里的文字条目。 */
export interface TurnToastItem {
    /** 通知第一行（粗体标题） */
    title: string;
    /** 通知第二行（说明） */
    body: string;
    /** 通知左下角的来源标签 */
    attribution: string;
}

/** 同一段时间内收尾的多个会话合并成一条通知，避免并行会话刷屏。 */
const BATCH_WINDOW_MS = 800;

/** toast 最多显示几行会话，超出的并进“还有 N 个”。 */
const MAX_ITEMS_PER_TOAST = 4;

/** 通知上的来源标签。 */
const APP_LABEL = "Pi Chat";

/**
 * 通知的“应用标识”（AppUserModelId）：Windows 用它决定通知卡片显示的来源名与图标。
 * 正常由插件激活时登记自己的标识（见 toastAppId.ts，来源显示“Pi Chat”）；
 * 没传进来时借用 PowerShell 自带的标识（系统自带，一定能弹，但来源显示 Windows PowerShell）。
 * 也可以用环境变量 PICHAT_TOAST_APPID 手动指定。
 */
const DEFAULT_APP_USER_MODEL_ID = POWERSHELL_APP_USER_MODEL_ID;

/** 发完通知后 PowerShell 还留着多久：系统要靠这个进程执行“到点失效”，
 *  所以要大于通知的失效秒数（多留 10 秒当余量），否则通知会一直留在通知中心里。 */
const TOAST_KEEPALIVE_MS = (TOAST_EXPIRE_SECONDS + 10) * 1000;

/** VS Code 界面内提示挂多久。 */
const IN_APP_NOTICE_MS = 20000;

/** 生成一个不会被撞上的临时文件名。 */
function tempName(prefix: string): string {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return path.join(os.tmpdir(), `${prefix}-${stamp}`);
}

/** PowerShell 可执行文件路径；优先读环境变量，其次走 PATH。 */
function powershellPath(): string {
    const override = process.env.PICHAT_POWERSHELL;
    return override && override.trim() ? override.trim() : "powershell.exe";
}

/**
 * 真正去弹这一批通知。
 *
 * @param onFailed 发不出去时把原因交给调用方，由它在 VS Code 界面里提示。
 *        成功时也会在 .done 出现后顺手清理临时文件。
 */
function spawnToast(items: TurnToastItem[], appUserModelId: string, onFailed: (reason: string) => void): void {
    const dataFile = tempName("pi-chat-toast");
    try {
        fs.writeFileSync(dataFile, JSON.stringify(items), { encoding: "utf8" });
    } catch (err) {
        onFailed(`通知内容写入临时文件失败: ${(err as Error).message}`);
        return;
    }

    const script = buildToastScript({
        dataFile,
        appUserModelId,
        appLabel: APP_LABEL,
        expireAfterSeconds: TOAST_EXPIRE_SECONDS,
        keepAliveMs: TOAST_KEEPALIVE_MS,
    });
    const child = cp.spawn(
        powershellPath(),
        [
            "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-EncodedCommand", encodePowerShell(script),
        ],
        { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
    );

    let settled = false;
    const finish = (reason?: string): void => {
        if (settled) { return; }
        settled = true;
        fs.rmSync(dataFile, { force: true });
        if (reason) { onFailed(reason); }
    };

    child.on("error", (err: Error) => finish(`PowerShell 启动失败: ${err.message}`));

    // 等 PowerShell 报告“通知已交给系统”（最长 6 秒）。
    const deadline = Date.now() + 6000;
    const watch = (): void => {
        if (settled) { return; }
        if (fs.existsSync(`${dataFile}.done`)) { finish(); return; }
        if (Date.now() > deadline) { finish("PowerShell 超时未返回（可能被安全策略拦下）"); return; }
        setTimeout(watch, 100);
    };
    setTimeout(watch, 100);
}

/**
 * 会话收尾通知中心：侧边栏与各个编辑器工作区共用一个实例。
 *
 * 用法：会话跑完时调 {@link handleTurnEnd}；窗口切到后台或侧边栏被切走时调 {@link hide}，
 * 让攒着的这批立刻发出去，不等合并窗口。
 */
export class TurnNotifier {
    private pending: TurnEndInfo[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    private readonly appUserModelId: string;
    /** 系统通知发送失败的解释只说一次，免得每次都弹一条警告。 */
    private warnedAboutToastFailure = false;

    constructor(options?: {
        /** 覆盖通知的应用标识（一般由插件激活时登记后传入）。 */
        appUserModelId?: string;
    }) {
        this.appUserModelId = options?.appUserModelId
            || (process.env.PICHAT_TOAST_APPID ?? "").trim()
            || DEFAULT_APP_USER_MODEL_ID;
    }

    public handleTurnEnd(info: TurnEndInfo): void {
        this.pending.push(info);
        if (this.timer) { clearTimeout(this.timer); }
        this.timer = setTimeout(() => this.flush(), BATCH_WINDOW_MS);
    }

    /** 窗口切后台 / 侧边栏被切走：立刻把攒着的通知发出去。 */
    public hide(): void {
        this.flush();
    }

    public dispose(): void {
        if (this.timer) { clearTimeout(this.timer); }
        this.timer = undefined;
        this.pending = [];
    }

    private flush(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        const batch = this.pending;
        this.pending = [];
        if (batch.length === 0) { return; }

        const kept = batch.slice(0, MAX_ITEMS_PER_TOAST);
        const rest = batch.length - kept.length;
        const items: TurnToastItem[] = kept.map((info) => ({
            title: this.titleOf(info),
            body: this.bodyOf(info),
            attribution: APP_LABEL,
        }));
        if (rest > 0) {
            items.push({ title: "还有其它会话", body: `…另有 ${rest} 个也跑完了`, attribution: APP_LABEL });
        }

        // 系统通知先发；发不出去时 onFailed 会在界面里补一条（带失败原因）。
        spawnToast(items, this.appUserModelId, (reason) => this.showInApp(batch, reason));
        // 窗口不在前台时，界面内提示顺带让 Windows 闪烁任务栏图标。
        if (!vscode.window.state.focused) { this.showInApp(batch, undefined); }
    }

    /** 通知第一行：会话名 + 跑完了没有。 */
    private titleOf(info: TurnEndInfo): string {
        const name = info.panelName || info.tabName || "会话";
        switch (info.status) {
            case "error": return `${name}：本轮出错结束`;
            case "cancelled": return `${name}：已中止`;
            default: return `${name}：任务完成`;
        }
    }

    /** 通知第二行：本轮概况（改了哪个文件 / 累计花费 / 错误摘要）。 */
    private bodyOf(info: TurnEndInfo): string {
        const parts: string[] = [];
        if (info.status === "cancelled") { parts.push("用户中止"); }
        else if (typeof info.changedFileCount === "number" && info.changedFileCount > 0) {
            parts.push(`改动 ${info.changedFileCount} 个文件`);
        }
        if (typeof info.costUsd === "number" && info.costUsd > 0) {
            parts.push(`累计 $${info.costUsd < 0.01 ? info.costUsd.toFixed(4) : info.costUsd.toFixed(2)}`);
        }
        if (info.status === "error" && info.errorText) { parts.push(shorten(info.errorText, 60)); }
        return parts.join(" · ");
    }

    /** 界面内提示的摘要：一行说完这批会话。 */
    private summarize(batch: TurnEndInfo[]): string {
        const names = batch.map((info) => info.panelName || info.tabName || "会话");
        const shown = names.slice(0, 3).join("、");
        const more = names.length > 3 ? ` 等 ${names.length} 个会话` : "";
        const result = batch.some((info) => info.status === "error")
            ? "有会话出错结束"
            : batch.some((info) => info.status === "cancelled")
                ? "有会话被中止"
                : "任务完成";
        return `${shown}${more} ${result}`;
    }

    /**
     * VS Code 界面里的一条提示。
     *
     * 用 withProgress(Location.Window) 而不是 showInformationMessage：前者在 VS Code
     * 不在前台时会让 Windows 闪烁任务栏图标，窗口最小化时也能被看到。
     * @param reason 系统通知发送失败的原因（成功时为 undefined）。
     */
    private showInApp(batch: TurnEndInfo[], reason?: string): void {
        if (reason && !this.warnedAboutToastFailure) {
            this.warnedAboutToastFailure = true;
            void vscode.window.showWarningMessage(
                `Pi Chat：Windows 系统通知发送失败（${reason}），已改用编辑器内提示。本次 VS Code 会话不再重复解释。`
            );
        }
        void vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Pi Chat：${this.summarize(batch)}` },
            async () => { await new Promise<void>((resolve) => setTimeout(resolve, IN_APP_NOTICE_MS)); },
        );
    }
}

/** 截断长文本（错误消息可能很长）。 */
function shorten(text: string, max: number): string {
    const oneLine = String(text).replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

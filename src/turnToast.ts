import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { TurnEndInfo } from "./runtimeTypes";
import { POWERSHELL_APP_USER_MODEL_ID, TOAST_EXPIRE_SECONDS, buildToastScript, encodePowerShell } from "./toastScript";
// 提醒里显示什么字（会话名取哪个 / 标题与摘要怎么拼）在 turnNotifyText.ts，那边不依赖 vscode、可单测。
import { notifyBody, notifyTitle, type TurnToastItem } from "./turnNotifyText";

/**
 * turnToast —— 一轮对话结束时发 Windows 系统通知。
 *
 * 这个文件不引用 vscode：独立后端（pichat，纯 Node）也要弹同一套通知，
 * 所以“发通知”本身和它的合并逻辑都放在这里；在编辑器界面里补提示是宿主自己的事
 * （第二步后 VSCode 插件不再自己跑会话，通知都在后端这边发。）
 *
 * 为什么不能只靠网页视图（webview）里的提示音：
 * 网页视图被隐藏或窗口切到后台时，它的音频与定时器会被降速甚至挂起，
 * 结果就是“会话跑完了却一点动静都没有”。而独立后端 / 扩展宿主进程一直在跑，不受窗口可见性影响。
 *
 * toast 的实现细节：
 *   - 本批通知的文字先写成一个 UTF-8 JSON 临时文件，PowerShell 读它；
 *   - PowerShell 脚本本身用 base64（UTF-16LE）经 -EncodedCommand 传入，
 *     这样脚本正文和通知文字都不用担心引号、反引号、$ 符、中文编码问题；
 *   - 卡片在右下角停约 7 秒（系统默认）后收进通知中心，60 秒后连记录一起消失；
 *   - 脚本每发完一批通知会写一个 .done 标记文件；看到它就知道“发出去了”，
 *     等不到就认定这台机器发不出来，把原因交给 onBatch，宿主可以据此补一条提示，不会静默失败。
 */

/** 同一段时间内收尾的多个会话合并成一条通知，避免并行会话刷屏。 */
const BATCH_WINDOW_MS = 800;

/** toast 最多显示几行会话，超出的并进“还有 N 个”。 */
const MAX_ITEMS_PER_TOAST = 4;

/** 通知上的来源标签。 */
const APP_LABEL = "Pi Chat";

/**
 * 通知的“应用标识”（AppUserModelId）：Windows 用它决定通知卡片显示的来源名与图标。
 * 正常由宿主激活后在后台登记自己的标识（见 toastAppId.ts，来源显示“Pi Chat”），
 * 传进来时可能还没登记完（那是个承诺，发通知前会等它出结果，结果一定能用）；
 * 没传进来时借用 PowerShell 自带的标识（系统自带，一定能弹，但来源显示 Windows PowerShell）。
 * 也可以用环境变量 PICHAT_TOAST_APPID 手动指定。
 */
const DEFAULT_APP_USER_MODEL_ID = POWERSHELL_APP_USER_MODEL_ID;

/** 发完通知后 PowerShell 还留着多久：系统要靠这个进程执行“到点失效”，
 *  所以要大于通知的失效秒数（多留 10 秒当余量），否则通知会一直留在通知中心里。 */
const TOAST_KEEPALIVE_MS = (TOAST_EXPIRE_SECONDS + 10) * 1000;

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
 * @param onFailed 发不出去时调一次，把原因交出来让宿主解释一句；
 *        发成功时不调（“这批发出去了”那一声由 TurnToast 在派活的时候立刻报，不等这里）。
 *        无论成败都会顺手清理临时文件。
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
    /** 收工：清掉临时文件；有 reason 就是没发出去，把原因交出去。 */
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
 * 会话收尾通知中心：侧边栏与各个编辑器工作区共用一个实例，独立后端也用一个实例。
 *
 * 用法：会话跑完时调 {@link handleTurnEnd}；窗口切到后台或侧边栏被切走时调 {@link hide}，
 * 让攒着的这批立刻发出去，不等合并窗口。
 *
 * 两个回调分得很清楚（为什么不在一个回调里用“有没有原因”区分：那样“这批去发了”
 * 就只能等到 PowerShell 回话才通知宿主，窗口不在前台时闪任务栏会晚好几秒）：
 *   - {@link onBatch}：这批去发了，立刻回调；宿主拿它做“窗口不在前台就补一条编辑器内提示”。
 *   - {@link onBatchFailed}：这批没能发出去，晚些回调，带上原因；宿主拿它解释一句。
 */
export class TurnToast {
    private pending: TurnEndInfo[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    private readonly appUserModelId?: string | Promise<string>;
    /** 定下来的标识（只算一次）：发通知前等它，登记还在后台跑时第一次发通知会稍等一下。 */
    private appUserModelIdResolved?: Promise<string>;
    /** 已经不用了：不再发任何通知。 */
    private disposed = false;
    private readonly onBatch?: (batch: TurnEndInfo[]) => void;
    private readonly onBatchFailed?: (batch: TurnEndInfo[], reason: string) => void;

    constructor(options?: {
        /** 覆盖通知的应用标识（一般由宿主激活后在后台登记，传进来的可能是还没登记完的承诺）。 */
        appUserModelId?: string | Promise<string>;
        /** 一批通知去发了（立刻回调，不通知成败）。 */
        onBatch?: (batch: TurnEndInfo[]) => void;
        /** 一批通知没发出去（带原因）。 */
        onBatchFailed?: (batch: TurnEndInfo[], reason: string) => void;
    }) {
        this.appUserModelId = options?.appUserModelId;
        this.onBatch = options?.onBatch;
        this.onBatchFailed = options?.onBatchFailed;
    }

    /** 把标识定下来：传了的等它出结果，没传就看环境变量，再不然用系统回落标识。 */
    private resolveAppUserModelId(): Promise<string> {
        if (!this.appUserModelIdResolved) {
            const direct = this.appUserModelId;
            this.appUserModelIdResolved = (direct
                ? Promise.resolve(direct)
                : Promise.resolve((process.env.PICHAT_TOAST_APPID ?? "").trim() || DEFAULT_APP_USER_MODEL_ID)
            ).catch(() => DEFAULT_APP_USER_MODEL_ID);
        }
        return this.appUserModelIdResolved;
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
        this.disposed = true;
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
            title: notifyTitle(info),
            body: notifyBody(info),
            attribution: APP_LABEL,
        }));
        if (rest > 0) {
            items.push({ title: "还有其它会话", body: `…另有 ${rest} 个也跑完了`, attribution: APP_LABEL });
        }

        // “这批去发了”立刻报给宿主（窗口不在前台时，闪任务栏的提示要马上出现，
        // 不能等 PowerShell 那边回话——那一等最长 6 秒）；
        // 发不出去时再补一次回调，把原因带上，宿主好解释一句。
        this.onBatch?.(batch);
        void this.resolveAppUserModelId().then((appUserModelId) => {
            if (this.disposed) { return; }
            spawnToast(items, appUserModelId, (reason) => this.onBatchFailed?.(batch, reason));
        });
    }
}

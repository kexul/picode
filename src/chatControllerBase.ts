/**
 * ChatControllerBase —— VSCode 插件的会话编排层。
 *
 * 一级模型：一个会话（panel）= 一个 SessionRuntime = 一个独立 pi 进程。
 * 界面上同时只看得到一个会话（当前会话），其余会话在后台跑着，
 * 从会话列表里切过去；不落盘，宿主一退全部关闭。
 *
 * 本类收敛“与平台无关”的逻辑：
 *   - 会话管理（newSession / setActiveSession / closeSession）
 *   - 拾取器浮层（showPicker / resolvePicker）
 *   - 模型选择器（pickModelInteractive）+ 模型内思考强度
 *   - 路径工具（relativeTo / resolvePath / resolveExecutable / checkPiAvailable）
 *   - 显示选项（sendViewOptions / buildViewOptionItems / showOptionsPicker + 标签常量）
 *   - 会话加载 / 历史（loadHistorySession / maybeAutoLoadLastSession / showHistoryPicker）
 *   - webview 消息分发（processMessage 的公共部分）
 *
 * 子类只需实现“平台钩子”：消息如何送到 webview、配置/视图选项存储、
 * 对话框 / diff / 文件打开的实现，以及各自独有的消息类型。
 *
 * 本类不引用 `vscode`：平台相关的事都从 RuntimeHost 走。
 */
import * as fs from "fs";
import * as path from "path";
import { SessionRuntime, RuntimeHost, ModelInfo, ModelChoice, TurnEndInfo } from "./sessionRuntime";
import { PiConfig } from "./sessionRuntime";
import { PiClient } from "./piClient";
import {
    isChildSessionFile,
    listSessionFiles,
    scanSessionInfo,
    type HistoryPickerItem,
    type SessionListItem,
} from "./sessionStore";
import { randomNameParts, composeName } from "./names";
import { pathCaseKey, relativeTo as pathRelativeTo, sameDir } from "./pathRules";
import { desktopScreenshotSupported } from "./desktopScreenshot";
import { desktopLiveSupported } from "./desktopLive";
import type { PanelLaunch, TurnEndStatus } from "./runtimeTypes";
import type { TabaRequest, TabaSpawnRequest, TabaStopRequest } from "./tabaProtocol";
import { TABA_DECODER } from "./tabaProtocol";
import { ASK_DECODER } from "./askProtocol";
import type { AskRequest } from "./askProtocol";
import { StderrFrameSplitter } from "./piFrames";
import { BASH_DECODER } from "./bashProtocol";
import { ENV_DECODER } from "./envProtocol";
import {
    TabaRegistry,
    buildChildClosedNotice,
    buildDeliveryText,
    buildSpawnFailure,
    shouldCloseAfterFirstTurn,
    type TabaChild,
} from "./tabaRegistry";
import { buildTaskText } from "./tabaTask";
import {
    buildTabaLaunch,
    resolveTabaSpawn,
} from "./tabaLaunch";
import { buildRunRecord, closedRunState, tabaRunsDir, writeRunRecord, type TabaRunState } from "./tabaRunFiles";
import { noteChildSession } from "./childSessions";
import {
    AUTO_CHILDREN_RUNNING_TEXT,
    AUTO_CONTINUE_TEXT,
    autoAskPicks,
    type AutoCommand,
    type AutoState,
} from "./auto";
import { promptText } from "./promptText";
import { isBusyPhase, type SessionAttention } from "./sessionPhase";
import { dropAuto, readAuto, writeAuto } from "./autoFiles";
import type { RpcSessionState } from "./piRpc";
import { clipText } from "./messageUtils";
import { REMOTE_TEXT_CHARS, type RemoteNotice } from "./remoteNotice";
import type { ProjectDirEntry } from "./sessionStore";

/** # 引用菜单里的一行：一个会话（或其某个子会话）。 */
export interface ChatReferenceItem {
    id: string;
    label: string;
    sub: string;
}

/**
 * 显示选项浮层里的一行（界面按 kind 画）：
 *   不写 kind  = 勾选框 / 开关（check 有值就是勾上了）
 *   按钮组（options 有值） = 直接点选某个选项
 *   "number"   = 数值输入框（min / max / step / unit）
 *   "button"   = 一颗按钮（button 是按钮上的字，disabled 时点不动）
 */
export interface ViewOptionItem {
    label: string;
    /** 名字底下那行灰字说明；不写就没有。 */
    desc?: string;
    check: boolean | null;
    action: string;
    value?: string;
    options?: Array<{ value: string; label: string }>;
    kind?: string;
    /**
     * 填字那行（kind: "text"）里那句灰字提示。
     */
    placeholder?: string;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    button?: string;
    disabled?: boolean;
    /** 归到设置面板的哪一页（不写就是「基础」）；页面按选项里第一次出现的顺序摆标签。 */
    tab?: string;
    /** 那一页里归到哪一小节（不写就不画小节标题）；页面按第一次出现的顺序摆小节。 */
    section?: string;
}

/**
 * 一块屏开着的浮层那一摊（历史列表 / 项目与会话 / 文件夹 / 模型）。
 * 按屏分开存：两个窗口各自开着自己的列表，“加载更多”、选完以后用哪份数据，各算各的。
 */
export interface PickerState {
    /** 浮层类型（history / workspace / folders / model 这类）；空串 = 这块屏上没开浮层。 */
    kind: string;
    /** 等用户选择那个 Promise 的放行函数；没人等就是 null。 */
    resolve: ((v: any | undefined) => void) | null;
    /** 没人答就收掉，这个定时器在挂着。 */
    timer?: ReturnType<typeof setTimeout>;
    /** 这个浮层列的是哪些会话文件（历史列表 / 项目面板上半段）；开列表时重建。
     *  顺序 = 最近聊过的在前（按文件改动时间倒序，见 sessionStore.listSessionFiles）。 */
    historyFiles: string[];
    /** 已经扫到第几个文件（「加载更多」接着往后扫）。 */
    historyOffset: number;
    /** 这个面板是不是常驻在右边那一列（常驻的不等人选、收起是界面自己说了算）。 */
    workspaceDock: boolean;
    /** 「项目与会话」面板在这块屏上开着（常驻那一列或滑出来的抽屉都算）。
     *  常驻那一列收起时宙主不知道（界面自己说了算），所以它可能留着 true：推过去会被丢掉。 */
    workspaceOpen: boolean;
    /** 项目面板下半段那几行的来源：目录清单（按最近活动倒序）+ 拿了几行 + 已经列过的目录。
     *  每拿一页就换一份新的（见 chatHost.ts 的 buildWorkspacePanel）：新建 / 关掉会话时会连着
     *  推好几份，大家抢同一份游标的话某一页就会少几行、顺序也乱。「加载更多」才接着上一份往后拿。 */
    workspacePage: WorkspacePage | null;
}

/** 项目面板下半段那一页的游标（一份页面自己一份，见 PickerState.workspacePage）。 */
export interface WorkspacePage {
    /** 还没拿出来的项目目录（按最近活动倒序）。 */
    dirs: ProjectDirEntry[];
    /** 拿到第几个了。 */
    offset: number;
    /** 已经列过的目录（按真实路径归一，见 dirKey）：同一个项目只占一行。 */
    seen: Set<string>;
}

export abstract class ChatControllerBase implements RuntimeHost {
    protected constructor(public readonly workspaceId: string) {}
    // ---- 会话（一个 SessionRuntime = 一个 pi 进程）----
    protected panels = new Map<string, SessionRuntime>();
    protected panelSeq = 0;
    /**
     * 每块屏各自在看哪个会话（屏标识 → 会话标识）。
     * 一块屏 = 一个 VSCode 窗口的网页视图，或一个浏览器页面：各看各的，互不打扰
     * （同一个后端里可以同时开着好几个项目聊）。
     */
    private readonly clientSessions = new Map<string, string>();
    /** 最近有人切过去的那个会话：某块屏还没挑过时先给它看这个（它还没开口，只能这么猜）。 */
    private lastFocusedPanelId: string | undefined;
    /** 每个会话最近一次“成了某块屏正在看的那个”的时刻（一个目录里开着好几个时挑最近用过的）。 */
    private readonly panelUsedAt = new Map<string, number>();
    /** 正在说话的那块屏（页面标识）：处理某块屏发来的消息期间才有值，平时是空串。 */
    protected currentPageId: string = "";
    /** 已经试过“启动时自动打开最近会话”的屏（每块屏只管自己头一次）。 */
    private readonly autoLoadTried = new Set<string>();
    /**
     * 刚被关掉的会话（会话标识 → 目录 / 会话文件）。
     * 有屏还看着它（画面留着）的时候，人接着往里发消息，就靠这份记录把它重新打开。
     * 只留最近一小批：更早的会话重开也没人认得出。
     */
    private readonly closedSessions = new Map<string, { cwd: string; file?: string }>();
    private static readonly CLOSED_REMEMBER_MAX = 20;

    /** sessionList 节流：流式 activity 变更很频繁，合并到下一帧附近推送。 */
    private sessionListTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly SESSION_LIST_THROTTLE_MS = 48;
    /** 浮层没人答就收掉：等这么久（毫秒）。 */
    private static readonly PICKER_TIMEOUT_MS = 120000;

    // ---- 浮层（拾取器）状态：按屏分，各开各的 ----
    /** 每块屏自己开着的浮层那一摊（历史列表 / 项目与会话 / 模型 / 文件夹）。 */
    private readonly pickers = new Map<string, PickerState>();

    /** 某块屏的浮层状态（还没开过就建一份空的）。 */
    protected pickerStateOf(clientId: string = this.currentPageId): PickerState {
        let st = this.pickers.get(clientId);
        if (!st) {
            st = {
                kind: "", resolve: null,
                historyFiles: [], historyOffset: 0, workspaceDock: false, workspaceOpen: false,
                workspacePage: null,
            };
            this.pickers.set(clientId, st);
        }
        return st;
    }

    /**
     * 现在「项目与会话」面板开着的屏（会话被新建、被关掉之后，宿主要给这些屏重推一份）。
     * dock = 那一块屏上这一份是不是常驻在右边那一列（推回去时要照原样给）。
     */
    protected workspacePanelClients(): Array<{ clientId: string; dock: boolean }> {
        const out: Array<{ clientId: string; dock: boolean }> = [];
        this.pickers.forEach((st, id) => {
            if (st.workspaceOpen) { out.push({ clientId: id, dock: st.workspaceDock }); }
        });
        return out;
    }

    // ---- 备用 pi 进程池（热备，免冷启动）----
    /** 已就绪的备用 pi 进程（不绑定任何 panel）。 */
    protected spare: PiClient | null = null;
    /** 正在后台预热、尚未就绪的备用进程（防止并发 spawn 多个）。 */
    protected preparingSpare: PiClient | null = null;
    /** 备用进程启动时使用的模型（领取时随进程一起返回，供继承比对）。 */
    protected spareMeta?: { provider?: string; modelId?: string };
    /** 备用进程延迟预热定时器（disposeSpare 清理）。 */
    protected spareTimer?: ReturnType<typeof setTimeout>;
    /** 备用进程连续失败次数（成功就归零）。 */
    protected spareFailures = 0;
    /** 上一次放弃补货的时刻（0 = 没放弃）。冷却结束后才重新给机会。 */
    protected spareGaveUpAt = 0;
    /** 启动路径预热备用进程的延迟：错开首个会话的 pi 冷启动，避免两个 pi 同时加载抢占 VSCode 窗口恢复期的资源。 */
    protected static readonly SPARE_PREWARM_DELAY_MS = 5000;
    /** 备用进程连着失败这么多次就不再自动补：机器资源不够时硬补只会把它压得更死。 */
    protected static readonly SPARE_MAX_FAILURES = 5;
    /** 补货失败后第一次的等待时间；之后每次翻倍（1 秒 → 2 秒 → 4 秒……）。 */
    protected static readonly SPARE_RETRY_BASE_MS = 1000;
    /** 补货等待时间的上限。 */
    protected static readonly SPARE_RETRY_MAX_MS = 30000;
    /** 放弃补货后的冷却时间：过了这段时间再把失败次数清零、重新给一次机会。
     *  有这个冷却，最坏情况也只是每 5 分钟拉 5 次进程，不会像以前那样一秒拉好几个。 */
    protected static readonly SPARE_GIVEUP_COOLDOWN_MS = 5 * 60 * 1000;

    // ---- 快捷键标签 ----
    protected static readonly SEND_KEY_LABELS: Record<string, string> = {
        "enter": "Enter",
        "shift+enter": "Shift + Enter",
        "alt+enter": "Alt + Enter",
        "ctrl+enter": "Ctrl + Enter",
    };
    protected static readonly NEW_SESSION_KEY_LABELS: Record<string, string> = {
        "ctrl+alt+n": "Ctrl+Alt+N", "ctrl+shift+n": "Ctrl+Shift+N", "ctrl+t": "Ctrl+T", "alt+n": "Alt+N",
    };
    protected static readonly CLOSE_SESSION_KEY_LABELS: Record<string, string> = {
        "ctrl+alt+w": "Ctrl+Alt+W", "ctrl+shift+w": "Ctrl+Shift+W", "ctrl+alt+x": "Ctrl+Alt+X", "alt+w": "Alt+W",
    };
    protected static readonly TAB_SWITCH_KEY_LABELS: Record<string, string> = {
        "ctrl+alt+arrows": "Ctrl+Alt+← / Ctrl+Alt+→",
        "ctrl+alt+pgupdown": "Ctrl+Alt+PageUp / PageDown",
        "alt+brackets": "Alt+[ / Alt+]",
        "ctrl+alt+brackets": "Ctrl+Alt+[ / Ctrl+Alt+]",
    };
    protected static readonly FOCUS_INPUT_KEY_LABELS: Record<string, string> = {
        "ctrlAltI": "Ctrl+Alt+I", "ctrlShiftI": "Ctrl+Shift+I",
        "altI": "Alt+I", "ctrlAltSpace": "Ctrl+Alt+Space",
    };

    /** 快捷键那几行单独一页（设置面板里的「快捷键」标签）。 */
    protected static readonly KEY_TAB = "快捷键";

    /** 把标签映射转成按钮组选项列表。 */
    protected static keyOptions(labels: Record<string, string>): Array<{ value: string; label: string }> {
        return Object.entries(labels).map(([value, label]) => ({ value, label }));
    }

    // ========================================================================
    //  平台钩子（子类实现）
    // ========================================================================

    /** 把一条全局（不带 sessionId）消息送到 webview。 */
    protected abstract postToWebview(msg: Record<string, unknown>): void;

    /** 只发一块屏（宿主自己实现：独立后端就发给那一块，屏只有一块的宿主可以当成广播）。 */
    protected postToOneClient(_clientId: string, msg: Record<string, unknown>): void {
        this.postToWebview(msg);
    }

    /**
     * 把一份消息分别发给每一块“现在连着的屏”（会话列表要各带各的“当前是哪一个”，只能一块一块发）。
     * 默认实现：这个宿主只有一块屏。
     */
    protected forEachClient(fn: (clientId: string, send: (msg: Record<string, unknown>) => void) => void): void {
        fn(this.currentPageId, (msg) => this.postToWebview(msg));
    }

    /**
     * 这块屏该用哪个目录（VSCode 窗口 = 它打开着的第一个文件夹；别的宿主 / 浏览器页面 = 空串）。
     * 一块屏头一次连上时，后端按它决定去哪个目录里找 / 开它要看的那个会话。
     */
    protected preferredDirForClient(_clientId: string): string { return ""; }

    /** 某块屏看的会话变了（宿主可以记下来：VSCode 窗口重连领了新的页面标识时，接着看原来那个）。 */
    protected onClientSessionChanged(_clientId: string, _panelId: string): void { /* 默认不用做 */ }

    /** 把“谁在看哪个会话”的账本清空（宿主收摊 / 会话全部没了）。 */
    protected forgetAllClients(): void {
        this.clientSessions.clear();
        this.autoLoadTried.clear();
        this.panelUsedAt.clear();
        this.closedSessions.clear();
        this.lastFocusedPanelId = undefined;
    }

    // ---- RuntimeHost：配置 / cwd ----
    public abstract getConfig(): PiConfig;
    public abstract getCwd(): string;

    // ---- RuntimeHost：UI 弹窗 / diff / 文件 / 持久化 ----
    public abstract confirmDialog(title: string, message: string, sessionId?: string): Promise<boolean>;
    public abstract selectDialog(title: string, options: string[], sessionId?: string): Promise<string | undefined>;
    public abstract inputDialog(title: string, placeholder: string, prefill: string, sessionId?: string): Promise<string | undefined>;
    public abstract persistModel(provider: string, modelId: string): void;
    public abstract openFileLocation(p: string, line: number, anchor?: string): void;
    public abstract confirmRevert(label: string, sessionId?: string): Promise<boolean>;

    // ---- 显示选项：存储读写（子类）----
    protected abstract getAutoLoadLast(): boolean;
    protected abstract getSendKey(): string;
    protected abstract getNewSessionKey(): string;
    protected abstract getCloseSessionKey(): string;
    protected abstract getTabSwitchKey(): string;
    protected abstract getFocusInputKey(): string;
    /** 字号（px 字符串，如 "13"；空串表示跟随 VSCode 设置）。 */
    protected abstract getFontSize(): string;
    /** 变更显示选项的存储（仅改存储，UI 推送由基类统一完成）。value 为按钮组点选的明确值。 */
    protected abstract mutateViewOption(action: string, value?: string): void;
    /** 有事（跑完一轮 / 模型在等你答题）时要不要弹提醒（各平台的子类去读自己的存储）。 */
    protected abstract notifyTurnEndEnabled(): boolean;
    /** 设置面板里「消息推送」那一行现在填着什么（没有就是空表）。 */
    protected notifyPushTargets(): string[] { return []; }
    /**
     * 设置面板里「消息推送」那一行空着时显示的例子：一般就是这台机器自己的地址，
     * 人一看就知道“留着它”是什么意思（提醒还在这台）。
     */
    protected notifyPushExample(): string { return "http://10.0.0.2:51883"; }
    /** 设置里「标签」现在填着什么（空 = 用机器名）。 */
    protected machineLabel(): string { return ""; }
    /** 「标签」空着时那句灰字提示：就是机器名，人一眼知道空着会用哪个。 */
    protected machineLabelExample(): string { return ""; }
    // ---- 文件列表 / 文件打开（来自 webview 的 listFiles / openFile）----
    protected abstract sendFileList(): void;
    protected abstract openFileFromWebview(p: string, line?: number, col?: number): void;

    /** webview 首次就绪时调用（默认空，平台子类可覆盖以推送初始化数据）。 */
    protected onWebviewReady(): void {}

    /**
     * 这块屏连上时，后端是不是已经把首屏送过了（见 chatHost 的 bootPageNow）。
     * 只有浏览器页面那条路会返回 true：插件里那块面板照旧等它自己的 ready。
     */
    protected pageBootedByConnect(_clientId: string): boolean { return false; }

    /** 处理平台独有的 webview 消息；已在公共分发中匹配的不会进来。返回是否已处理。 */
    protected abstract handlePlatformMessage(msg: any): boolean;

    // ---- 可选平台钩子 ----
    /** pi 不存在时追加的平台行为（基类已向 panel 推送 systemError）。 */
    protected onPiMissing(_piPath: string): void { /* 默认无操作 */ }
    /** pi 缺失提示文案（基类默认；独立后端覆盖为按实际目录算的路径）。 */
    protected piMissingMessage(piPath: string): string {
        return `未找到 pi 可执行文件（当前配置："${piPath}"）。请确认已安装 pi 并加入系统 PATH。`;
    }
    // ========================================================================
    //  路径工具（RuntimeHost）
    // ========================================================================
    /** RuntimeHost.relativeTo：这套规矩只有一份，实现在 pathRules.ts。 */
    public relativeTo(cwd: string, full: string): string {
        return pathRelativeTo(cwd, full);
    }

    public resolvePath(p: string, cwd?: string): string {
        if (path.isAbsolute(p)) { return p; }
        return path.resolve(cwd ?? this.getCwd(), p);
    }

    public resolveExecutable(cmd: string): string | undefined {
        if (!cmd) { return undefined; }
        const isWindows = process.platform === "win32";
        const exts = isWindows
            ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
            : [""];
        const existsAsFile = (p: string): boolean => {
            try { return fs.statSync(p).isFile(); } catch { return false; }
        };
        const tryWithExts = (base: string): string | undefined => {
            if (existsAsFile(base)) { return base; }
            if (isWindows) {
                for (const ext of exts) {
                    const lo = base + ext.toLowerCase(); if (existsAsFile(lo)) { return lo; }
                    const up = base + ext; if (existsAsFile(up)) { return up; }
                }
            }
            return undefined;
        };
        if (cmd.includes("/") || cmd.includes("\\")) {
            const abs = path.isAbsolute(cmd) ? cmd : path.resolve(this.getCwd(), cmd);
            return tryWithExts(abs);
        }
        const pathEnv = process.env.PATH || process.env.Path || "";
        const sep = isWindows ? ";" : ":";
        for (const dir of pathEnv.split(sep).filter(Boolean)) {
            const found = tryWithExts(path.join(dir, cmd));
            if (found) { return found; }
        }
        return undefined;
    }

    public checkPiAvailable(piPath: string, panelId: string): boolean {
        if (this.resolveExecutable(piPath)) { return true; }
        this.postToSession(panelId, { type: "systemError", text: this.piMissingMessage(piPath) });
        this.onPiMissing(piPath);
        return false;
    }

    // ========================================================================
    //  显示选项
    // ========================================================================
    protected sendViewOptions(): void {
        this.postToWebview(this.viewOptionsMessage());
    }

    /**
     * 显示选项那条消息本身（见 sendViewOptions）。单独一份是给“页面刚连上”那条路用的：
     * 网页那边 ready 可能比推送连接登记得还早，ready 时广播出去的这一条会发到旧连接上、
     * 新页面什么都没收到（刷新之后字号 / 界面颜色就回到默认值了）。见 chatHost 的 onPageConnected。
     */
    protected viewOptionsMessage(): Record<string, unknown> {
        return {
            type: "viewOptions",
            autoLoadLastSession: this.getAutoLoadLast(),
            sendKey: this.getSendKey(),
            newSessionKey: this.getNewSessionKey(),
            closeSessionKey: this.getCloseSessionKey(),
            tabSwitchKey: this.getTabSwitchKey(),
            focusInputKey: this.getFocusInputKey(),
            fontSize: this.getFontSize(),
            // 这台机器的路径分不分大小写（Linux / macOS 上 /a/B 与 /a/b 是两个目录）：
            // 界面拿它当键比较目录与会话文件（见 media/chat.js 的 pathCaseKey）
            caseSensitivePaths: process.platform !== "win32",
            // 截不了桌面的机器（Linux）上界面把那颗按钮藏起来，省得点下去只弹一句“只在 Windows 上可用”
            desktopScreenshot: desktopScreenshotSupported(),
            // 能不能长按它看桌面实时画面（要那支“一直拍”的小程序在）：不在的话长按什么也不做
            desktopLive: desktopLiveSupported(),
            ...this.viewOptionsExtra(),
        };
    }

    /** 把显示选项单发一块屏（页面刚连上时用，见 viewOptionsMessage）。 */
    protected sendViewOptionsTo(clientId: string): void {
        this.postToOneClient(clientId, this.viewOptionsMessage());
    }

    /** 子类往 viewOptions 消息里附带的额外字段（缺省无）。 */
    protected viewOptionsExtra(): Record<string, unknown> | undefined { return undefined; }
    /** 子类往显示选项浮层里追加的条目（缺省无）。 */
    protected viewOptionItemsExtra(): ViewOptionItem[] { return []; }

    /** 构建显示选项浮层条目（toggle / 按钮组模式）。 */
    protected buildViewOptionItems(): ViewOptionItem[] {
        return [
            {
                action: "autoLoadLastSession",
                label: "启动时自动打开最近会话",
                desc: "",
                section: "启动",
                check: this.getAutoLoadLast(),
            },
            {
                action: "sendKey",
                label: "发送键",
                desc: "",
                check: null,
                tab: ChatControllerBase.KEY_TAB,
                value: this.getSendKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.SEND_KEY_LABELS),
            },
            {
                action: "newSessionKey",
                label: "新建会话",
                desc: "",
                check: null,
                tab: ChatControllerBase.KEY_TAB,
                value: this.getNewSessionKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.NEW_SESSION_KEY_LABELS),
            },
            {
                action: "closeSessionKey",
                label: "关闭会话",
                desc: "",
                check: null,
                tab: ChatControllerBase.KEY_TAB,
                value: this.getCloseSessionKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.CLOSE_SESSION_KEY_LABELS),
            },
            {
                action: "tabSwitchKey",
                label: "切换会话",
                desc: "",
                check: null,
                tab: ChatControllerBase.KEY_TAB,
                value: this.getTabSwitchKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.TAB_SWITCH_KEY_LABELS),
            },
            {
                action: "focusInputKey", label: "聚焦输入框", desc: "", check: null,
                tab: ChatControllerBase.KEY_TAB,
                value: this.getFocusInputKey(), options: ChatControllerBase.keyOptions(ChatControllerBase.FOCUS_INPUT_KEY_LABELS),
            },
            {
                action: "fontSize",
                label: "字号",
                desc: "",
                section: "外观",
                check: null,
                kind: "number",
                value: this.getFontSize(),
                min: 11, max: 22, step: 1, unit: "px",
            },
            {
                action: "machineLabel",
                label: "标签",
                desc: "",
                section: "通知",
                check: null,
                kind: "text",
                placeholder: this.machineLabelExample(),
                value: this.machineLabel(),
            },
            {
                action: "notifyPushTo",
                label: "消息推送",
                desc: "",
                section: "通知",
                check: null,
                kind: "text",
                placeholder: this.notifyPushExample(),
                // 没填过就显示这台机器自己的地址：留着它 = 提醒还在这台，改成别的机器 = 挪过去
                value: (this.notifyPushTargets().length > 0 ? this.notifyPushTargets() : [this.notifyPushExample()]).join(", "),
            },
        ];
    }

    /** 推送显示选项浮层（toggle 模式，不等待结果）。 */
    protected showOptionsPicker(): void {
        // 推送显示选项条目（数据）：由前端渲染进统一设置面板的「显示选项」页。
        this.postToWebview({
            type: "viewOptionItems",
            items: [...this.buildViewOptionItems(), ...this.viewOptionItemsExtra()],
        });
    }

    /** 浮层中切换某项后刷新：改存储 → 重推视图选项 → 刷新浮层。 */
    protected doViewOptionToggle(action: string, value?: string): void {
        this.mutateViewOption(action, value);
        this.sendViewOptions();
        this.showOptionsPicker();
    }

    // ========================================================================
    //  Tab（容器）/ Panel（会话）管理
    // ========================================================================

    // ---- 备用 pi 进程池 ----
    /** 确保池中常备一个已就绪的备用进程；领取后由 claimSpareClient 触发补充。
     *  @param delayMs 延迟多少毫秒后再启动（启动路径用：错开首个会话的 pi 冷启动）；0 表示立即启动。 */
    protected ensureSpare(delayMs = 0): void {
        if (this.spare || this.preparingSpare) {
            return;
        }
        if (this.spareFailures >= ChatControllerBase.SPARE_MAX_FAILURES) {
            // 连着失败太多次：多半是机器资源不够或 pi 起不来。硬补会把机器压得更死
            // （2026-10-15 那次整机卡死就是“起进程 → 起不来 → 立刻再起”转出来的）。
            if (!this.spareGaveUpAt) {
                this.spareGaveUpAt = Date.now();
            }
            if (Date.now() - this.spareGaveUpAt < ChatControllerBase.SPARE_GIVEUP_COOLDOWN_MS) {
                return;
            }
            // 冷却结束：把账清零，重新给一次机会
            this.spareFailures = 0;
            this.spareGaveUpAt = 0;
        }
        if (this.spareTimer) {
            if (delayMs > 0) { return; } // 已有延迟任务在排队；立即启动的请求则取消排队直接走下面流程
            clearTimeout(this.spareTimer);
            this.spareTimer = undefined;
        }
        if (delayMs > 0) {
            this.spareTimer = setTimeout(() => {
                this.spareTimer = undefined;
                this.ensureSpare();
            }, delayMs);
            return;
        }
        const cfg = this.getConfig();
        if (!this.resolveExecutable(cfg.piPath)) {
            return;
        }
        const extraArgs = cfg.trustProject
            ? [...cfg.extraArgs, "--approve"]
            : [...cfg.extraArgs];
        // 备用进程也要带上那几个扩展：它会被下一个新 panel 领走，那个 panel 一样得能派活、能问用户、
        // 跑完第一轮能起标题（扩展只在进程启动时加载，领走以后没法补）
        if (cfg.tabaExtension) { extraArgs.push("-e", cfg.tabaExtension); }
        if (cfg.askExtension) { extraArgs.push("-e", cfg.askExtension); }
        if (cfg.titleExtension) { extraArgs.push("-e", cfg.titleExtension); }
        if (cfg.imageExtension) { extraArgs.push("-e", cfg.imageExtension); }
        // 接管 bash（后台命令）：每个会话都带，领走备用进程的那个 panel 也一样
        if (cfg.bashExtension) { extraArgs.push("-e", cfg.bashExtension); }
        // 报「加载了什么」（工具 / 技能 / MCP）：同上，每个会话都带
        if (cfg.envExtension) { extraArgs.push("-e", cfg.envExtension); }
        const client = new PiClient({
            piPath: cfg.piPath,
            cwd: this.getCwd(),
            provider: cfg.provider || undefined,
            model: cfg.model || undefined,
            extraArgs,
            env: {
                ...(cfg.tabaDir ? { PICHAT_TABA_DIR: cfg.tabaDir } : {}),
                ...(cfg.askDir ? { PICHAT_ASK_DIR: cfg.askDir } : {}),
                ...(cfg.bashDir ? { PICHAT_BASH_DIR: cfg.bashDir } : {}),
            },
        });
        // 记住备用进程的启动模型：新 panel 领取时按继承目标比对，不符则补发 set_model
        this.spareMeta = {
            provider: cfg.provider || undefined,
            modelId: cfg.model || undefined,
        };
        this.preparingSpare = client;
        // 备用进程的 stderr 只记“不是暗号行”的那些（暗号是一大串 base64，整行打出来把日志刷没）。
        // 请求由领走它的那个会话解析（这里只切割、不处理，不然同一行会被处理两次）。
        // 「加载了什么」那份清单也认掉：它是一次性报告、不是请求，领走它的会话会收到 pi 的
        // session_start，那份清单会重报一遍，所以这里看过就丢、别落成日志。
        const spareStderr = new StderrFrameSplitter([TABA_DECODER, ASK_DECODER, BASH_DECODER, ENV_DECODER]);
        client.on("stderr", (text: string) => {
            spareStderr.feed(text);
            for (const line of spareStderr.takeOtherLines()) { console.error("[pi spare stderr]", line); }
        });
        client.on("error", (err: Error) => console.error("[pi spare error]", err.message));
        client.on("exit", () => {
            // 备用进程意外退出（尚未被领取时）：清掉并补一个新的
            if (this.spare === client) {
                this.spare = null;
                this.failSpare("它自己退出了");
            }
        });
        client.start();
        void client.waitReady().then((ok) => {
            if (this.preparingSpare !== client) {
                // 已被 dispose 清理，丢弃
                return;
            }
            this.preparingSpare = null;
            if (ok && client.isRunning()) {
                this.spare = client;
                this.spareFailures = 0;
                this.spareGaveUpAt = 0;
            } else {
                client.stop();
                this.failSpare("等不到它就绪");
            }
        });
    }

    /** 备用进程没起来：记一笔，等一会儿再补；连着失败到上限就停手，并把原因说清楚。
     *  停手不影响用：没有热备的会话照常能开，只是要等 pi 冷启动。 */
    protected failSpare(reason: string): void {
        this.spareFailures += 1;
        if (this.spareFailures >= ChatControllerBase.SPARE_MAX_FAILURES) {
            this.spareGaveUpAt = Date.now();
            console.error(
                `[pi spare] 备用进程连续 ${this.spareFailures} 次没起来（最近一次：${reason}），暂停自动补货。`
                + `新会话仍然可用，只是要冷启动 pi。`
                + `${Math.round(ChatControllerBase.SPARE_GIVEUP_COOLDOWN_MS / 1000)} 秒后自动重试一次；`
                + `想立刻恢复就重新加载窗口。`
            );
            return;
        }
        const wait = Math.min(
            ChatControllerBase.SPARE_RETRY_BASE_MS * Math.pow(2, this.spareFailures - 1),
            ChatControllerBase.SPARE_RETRY_MAX_MS
        );
        console.error(`[pi spare] 备用进程没起来（${reason}），第 ${this.spareFailures} 次失败，${wait} 毫秒后再试。`);
        this.ensureSpare(wait);
    }

    /** RuntimeHost.claimSpareClient：领取就绪的备用进程（附带其启动模型）；领取后立即后台补新。 */
    public claimSpareClient(): { client: PiClient; provider?: string; modelId?: string } | undefined {
        const c = this.spare ?? undefined;
        const meta = this.spareMeta;
        this.spare = null;
        this.spareMeta = undefined;
        if (c) {
            this.ensureSpare();
            return { client: c, provider: meta?.provider, modelId: meta?.modelId };
        }
        return undefined;
    }

    /** 停止并清空所有备用进程（宿主销毁时调用，如 VSCode webview dispose）。 */
    protected disposeSpare(): void {
        if (this.spareTimer) {
            clearTimeout(this.spareTimer);
            this.spareTimer = undefined;
        }
        if (this.spare) {
            this.spare.stop();
            this.spare = null;
        }
        if (this.preparingSpare) {
            const p = this.preparingSpare;
            this.preparingSpare = null;
            p.stop();
        }
    }

    public postToSession(panelId: string, msg: Record<string, unknown>): void {
        this.postToWebview({ ...msg, sessionId: panelId });
    }

    /** RuntimeHost.wantsTrimmedHistory：VSCode 这两家整屏重画照旧全量；网页端那份覆写成 true。 */
    public wantsTrimmedHistory(): boolean { return false; }

    /** 这块屏首屏的图片预算：undefined = 用运行时默认那一份（见 ChatHost 的同名方法）。
     *  VSCode 这两家（面板、编辑器那边）都是宽屏，照旧全发。 */
    public inlineImageBudget(_clientId: string): number | undefined { return undefined; }

    // ---- 查找 ----
    /** 这块屏现在显示的会话（不传 = 正在说话的那块屏）。 */
    public getActive(clientId: string = this.currentPageId): SessionRuntime | undefined {
        const own = this.clientSessions.get(clientId);
        if (own && this.panels.has(own)) { return this.panels.get(own); }
        // 它还没挑过、或者它看的那个刚被关掉：先按“最近有人切过去的那个”顶一下（不记档）
        return this.lastFocusedPanelId ? this.panels.get(this.lastFocusedPanelId) : undefined;
    }

    /** 这块屏自己挑的是哪个会话（没挑过、或挑的那个已经被关掉就是 undefined）。 */
    public focusedIdFor(clientId: string): string | undefined {
        const id = this.clientSessions.get(clientId);
        return id && this.panels.has(id) ? id : undefined;
    }

    /**
     * 直接把某块屏记成在看某个会话（不发消息、不广播）。
     * 用在“这块屏换了个新标识、但它原来就是在看这个会话”的场合（VSCode 窗口重连）。
     */
    public adoptClientSession(clientId: string, panelId: string): void {
        if (!this.panels.has(panelId)) { return; }
        this.clientSessions.set(clientId, panelId);
        // 换了个新标识但还看原来那个会话（窗口重连）：跟“切过去”一样走一遍通知
        this.onClientSessionChanged(clientId, panelId);
    }

    /**
     * 这块屏现在还连着吗。
     *
     * 默认“连着”。宿主覆写它（见 chatHost 的 broadcaster：通道还在才算）。
     * 为什么要问这一句：下面的“谁在看”只登记不销号 —— 关掉的标签页、拔掉网的手机
     * 永远留在表里，于是“有人看着这个会话”永远成立，需要人回答的弹窗
     *（确认框 / 输入框 / 问答题）会白等到超时，而不是当场走“没人看着”的兜底。
     */
    protected isClientLive(_clientId: string): boolean { return true; }

    /** 有没有屏在看这个会话（状态上报这类“只跟人正在看的会话走”的事看它）。 */
    protected isFocusedPanel(panelId: string): boolean {
        for (const [clientId, id] of this.clientSessions) {
            if (id === panelId && this.isClientLive(clientId)) { return true; }
        }
        return false;
    }

    /** 现在正看着这个会话的屏（一个都没在看就是空表；已断开的屏不算）。 */
    public clientsViewing(panelId: string): string[] {
        const out: string[] = [];
        for (const [clientId, id] of this.clientSessions) {
            if (id === panelId && this.isClientLive(clientId)) { out.push(clientId); }
        }
        return out;
    }

    /** 当前会话还没承载任何对话内容时，才算可以顶掉它（打开历史会话时复用）。 */
    protected isActiveSessionEmpty(clientId: string = this.currentPageId): boolean {
        return this.getActive(clientId)?.isConversationEmpty() === true;
    }

    /** 子类可接入跨工作区的全局唯一名字池。 */
    protected allocatePanelName() { return randomNameParts(); }
    protected releasePanelName(_parts: { adjective: string; noun: string }): void { /* default: local names */ }

    // ---- 创建 ----
    /** 新建一个会话运行时（随机命名，启动 pi 进程）；不设为当前会话，由调用方决定。 */
    protected createPanelRuntime(inherited?: { provider?: string; modelId?: string }, launch?: PanelLaunch): SessionRuntime {
        const id = `${this.workspaceId}:panel-${++this.panelSeq}`;
        const rt = new SessionRuntime(id, this.allocatePanelName(), this);
        this.panels.set(id, rt);
        rt.startClient(inherited, launch);
        return rt;
    }

    /** 新建一个会话并切过去（成为这块屏现在看的会话）。只建新的，不动旧的那个
     *  （顶条那颗加号那条路会顺手把没在忙的旧的关掉，见 processMessage 的 newSession）。
     *  跑在哪个目录：跟这块屏现在看的会话走（顶条上那个会话在别的项目里，新会话也开在那个项目里）。
     *  一个会话都没有时（刚启动、刚把最后几个会话关完）用宿主自己的默认目录。
     *  @param spareDelayMs 备用进程预热的延迟毫秒数（启动路径传 SPARE_PREWARM_DELAY_MS）。
     *  @param clientId 给哪块屏新建（默认 = 正在说话的那块）。 */
    public newSession(spareDelayMs = 0, clientId: string = this.currentPageId): SessionRuntime {
        const active = this.getActive(clientId);
        // 模型跟会话走：继承当前会话的模型（startClient 内部回落全局配置）
        const inherited = active?.currentModel();
        // 目录也跟会话走；没有会话时回落宿主默认目录
        const dir = active?.cwd ?? this.getCwd();
        // 不是默认目录就别领备用进程：它是按默认目录起的，领过来就跑错地方了
        const launch: PanelLaunch = sameDir(dir, this.getCwd()) ? {} : { cwd: dir, skipSpare: true };
        const rt = this.createPanelRuntime(inherited, launch);
        this.activateSession(rt, clientId);
        // 后台预热一个备用进程，供下一个新会话直接领取（启动路径延迟执行，避免双冷启动）
        this.ensureSpare(spareDelayMs);
        return rt;
    }

    /**
     * 新建一个会话，pi 进程按 launch 起：指定工作目录、带额外启动参数这些。
     * 为什么另开一个口子：newSession 只能在（这块屏看的）那个会话的目录里新开，而面板里要能在
     * 别的工作区开（见 newSessionInDir）、历史里点开别的项目的会话也要按那个项目的目录起进程。
     */
    protected newSessionWithLaunch(
        launch: PanelLaunch,
        spareDelayMs = 0,
        clientId: string = this.currentPageId,
    ): SessionRuntime | undefined {
        const cfg = this.getConfig();
        if (!this.resolveExecutable(cfg.piPath)) { return undefined; }
        const rt = this.createPanelRuntime(this.getActive(clientId)?.currentModel(), launch);
        this.activateSession(rt, clientId);
        this.ensureSpare(spareDelayMs);
        return rt;
    }

    /**
     * 在指定目录新开一个会话（面板里“在某个项目里开新会话”、VSCode 窗口认自己的工作区都用它）。
     * 目录跟宿主默认目录不一样时不领备用进程：备用进程是按默认目录起的，领过来就跑错地方了。
     */
    public newSessionInDir(
        dir: string,
        opts?: { clientId?: string; spareDelayMs?: number },
    ): SessionRuntime | undefined {
        const target = path.resolve(dir);
        const launch: PanelLaunch = sameDir(target, this.getCwd()) ? {} : { cwd: target, skipSpare: true };
        return this.newSessionWithLaunch(launch, opts?.spareDelayMs ?? 0, opts?.clientId ?? this.currentPageId);
    }

    /** 把一个会话设为某块屏（默认正在说话的那块）现在看的会话。 */
    private activateSession(rt: SessionRuntime, clientId: string = this.currentPageId): void {
        this.setActiveSession(rt.id, clientId);
    }

    // ---- 切换 ----
    /**
     * 把某块屏（默认正在说话的那块）切到某个会话：不新开、不重载，那个会话的进程一直跑着。
     *
     * switchId：界面那头开口要切的那一下排第几（见 media/chat.js 的 requestSwitch），
     * 原样带回给那块屏。回话比手慢的时候，界面上按得快的几条确认会挤在一起，
     * 界面靠这个号认出“这条说的是我上一下要的，已经过时了”。
     */
    public setActiveSession(panelId: string, clientId: string = this.currentPageId, switchId?: unknown): void {
        if (!this.panels.has(panelId)) { return; }
        if (this.clientSessions.get(clientId) === panelId) { return; }
        this.clientSessions.set(clientId, panelId);
        this.lastFocusedPanelId = panelId;
        this.panelUsedAt.set(panelId, Date.now());
        this.onClientSessionChanged(clientId, panelId);
        // 先发列表，再说“你看的是哪一个”：界面上要先生出这个会话的壳，才认得这个标识
        this.broadcastSessionList(true);
        // 只告诉动手的这块屏：别的屏各看各的，不跟着切
        this.postToOneClient(clientId, typeof switchId === "number"
            ? { type: "sessionActivated", sessionId: panelId, switchId }
            : { type: "sessionActivated", sessionId: panelId });
    }

    // ---- 某块屏该看哪个会话（它刚连上时挑 / 开一个）----
    /**
     * 保证某块屏有一个会话可看（它刚连上、后端还没记过它看哪个时调）。
     *
     * 挑法：知道它该用哪个目录（VSCode 窗口的工作区，见 preferredDirForClient）就先在那个目录里
     * 找已经开着的会话（同一个目录开着好几个就挑最近用过的那个），没有才在那个目录新开一个；
     * 不知道该用哪个目录（浏览器页面）就看“最近有人切过去的那个”。
     *
     * 浏览器页面进来时一个会话都没有（后端刚起、或者刚把最后几个关完）：不替人开空会话，
     * 让它空着 —— 界面那边会把「项目与会话」摊开，等人在某个工作区里开新会话、或挑一条历史会话。
     *
     * @returns 是不是刚刚为它新建了一个会话（新建的才要走“启动时自动打开最近会话”那条路）
     */
    public ensureClientSession(clientId: string): boolean {
        if (this.focusedIdFor(clientId)) { return false; }
        const dir = this.preferredDirForClient(clientId);
        if (dir) {
            const existing = this.sessionInDir(dir);
            if (existing) { this.setActiveSession(existing.id, clientId); return false; }
            const created = this.newSessionInDir(dir, {
                clientId,
                // 错开这块屏首个会话的 pi 冷启动（跟启动路径同一个理由：别让两个 pi 一起加载）
                spareDelayMs: ChatControllerBase.SPARE_PREWARM_DELAY_MS,
            });
            // pi 不在（没装 / 路径不对）就没有会话可看：界面那边自己会报“找不到 pi”
            return !!created;
        }
        const last = this.lastFocusedPanelId ? this.panels.get(this.lastFocusedPanelId) : undefined;
        const pick = last ?? this.panels.values().next().value;
        if (pick) { this.setActiveSession(pick.id, clientId); }
        return false;
    }

    /** 某个目录里已经开着的会话：同一个目录开着好几个时，挑最近用过的那个（子会话排在后面）。 */
    public sessionInDir(dir: string): SessionRuntime | undefined {
        const target = path.resolve(dir);
        const cands: SessionRuntime[] = [];
        for (const rt of this.panels.values()) {
            if (sameDir(rt.cwd, target)) { cands.push(rt); }
        }
        if (cands.length === 0) { return undefined; }
        const notChild = cands.filter((rt) => !this.taba.byChildPanel(rt.id));
        const pool = notChild.length > 0 ? notChild : cands;
        return pool.reduce((best, rt) =>
            (this.panelUsedAt.get(rt.id) ?? 0) > (this.panelUsedAt.get(best.id) ?? 0) ? rt : best);
    }

    // ---- 关闭 ----
    /**
     * 关闭一个会话：杀进程、释放名字。
     *
     * 动手关它的那块屏自己换到别的会话去；别的还在看它的屏留在原地不动
     * （画面还留着，界面那边会显示“这个会话已被关闭”和一颗重新打开的按钮）。
     * 一个都不剩就空着（不再自动补一个空的）：界面那边会把「项目与会话」摊开，等人挑一个工作区。
     */
    public closeSession(panelId: string): void {
        if (!this.panels.has(panelId)) { return; }
        const requester = this.currentPageId;
        this.noteClosedSession(panelId);
        this.disposePanelRuntime(panelId);
        if (this.clientSessions.get(requester) === panelId) {
            const next = this.panels.keys().next().value;
            if (next) { this.setActiveSession(next, requester); }
            else { this.clientSessions.delete(requester); }
        }
        if (this.lastFocusedPanelId === panelId) { this.lastFocusedPanelId = this.panels.keys().next().value; }
        this.broadcastSessionList(true);
    }

    // ---- Fork（原生克隆会话到新 panel）----
    // ========================================================================
    //  自动接着干：每轮跑完直接再发一句「继续」
    // ========================================================================
    //
    //  开关就是输入框右下角那颗小开关：点一下拨开，再点一下停；开了不往对话里发话。
    //  开着的时候，每一轮正常跑完就发一句「继续」（有子会话在跑时换成那句「别闲着」）。
    //
    //  插件这边不设轮数上限：只有人再点一下那颗按钮才停。
    //
    //  后台还有命令在跑的时候先不发（也不往对话里写话）：那些结果本来就会当一条新消息
    //  交回这个会话，等它们进来、那一轮跑完再发（见 autoLoopOnTurnEnd）。
    //
    //  派出去的子会话还在跑的时候发「现在有子任务在跑着，你这边也别闲着」：主会话别停着等。
    //  每次跑完、子会话还在跑就再发一句（人定的）。

    /** 每个会话的开关（panel id → 开关）。内存里这份是热的，盘上那份按会话文件存。 */
    protected readonly autos = new Map<string, AutoState>();
    /** 已经问过存档的会话：问过一次没有就是没有，不必每推一次会话列表就去读盘。 */
    private readonly autoChecked = new Set<string>();

    /** RuntimeHost.onAutoCommand：输入框右下角那颗小开关按下去时，以及有人打了 `/auto` 这几个字时。 */
    public onAutoCommand(panelId: string, cmd: AutoCommand): void {
        const rt = this.panels.get(panelId);
        if (!rt) { return; }
        switch (cmd.kind) {
            case "on": this.autoOn(rt); return;
            case "show": this.autoBroadcast(rt.id); return;
            case "off": this.autoOff(rt); return;
            // 打了 `/auto` 这几个字：吞掉就算了（开关在那颗按钮上），不回话
            case "silent": return;
        }
    }

    /**
     * 打开开关（那颗按钮按下去）。不往对话里发任何东西 —— 下一句活还是你自己说，
     * 它管的是之后每一轮跑完要不要接着催。
     */
    protected autoOn(rt: SessionRuntime): void {
        // 子会话跑完一轮就把结果交回父会话了，没有"之后每一轮"可管
        if (this.taba.byChildPanel(rt.id)) {
            this.postToSession(rt.id, {
                type: "system",
                text: "子会话里不开自动接着干（它跑完一轮就交回父会话了）。",
            });
            return;
        }
        const running = this.autoGet(rt);
        if (running) {
            this.autoBroadcast(rt.id);
            this.postToSession(rt.id, {
                type: "system",
                text: "自动模式已经开着。要停就再点一下那颗按钮。",
            });
            return;
        }
        this.autos.set(rt.id, { updatedAt: Date.now() });
        this.autoChecked.add(rt.id);
        this.autoSave(rt);
        this.autoBroadcast(rt.id);
        this.postToSession(rt.id, {
            type: "system",
            text: "自动模式开了：之后每一轮跑完都直接发一句「继续」。要停就再点一下那颗按钮。",
        });
    }

    /** 关掉开关（再点一下那颗按钮）。盘上那一份也一并抹掉。 */
    protected autoOff(rt: SessionRuntime): void {
        this.autos.delete(rt.id);
        this.autoChecked.add(rt.id);   // 刚删掉的那份别再读回来
        const file = rt.currentSessionPath;
        if (file) { dropAuto(file); }
        this.autoBroadcast(rt.id);
    }

    /** 这个会话的开关：内存里没有就问存档要（会话重开、插件重启后接回来）。 */
    protected autoGet(rt: SessionRuntime): AutoState | undefined {
        const cached = this.autos.get(rt.id);
        if (cached) { return cached; }
        if (this.autoChecked.has(rt.id)) { return undefined; }
        // 全新会话还没落盘：先不记“问过了”，等有文件了那次再问（会话文件才是存档的键）
        const file = rt.currentSessionPath;
        if (!file) { return undefined; }
        this.autoChecked.add(rt.id);
        const found = readAuto(file);
        if (found) { this.autos.set(rt.id, found); }
        return found;
    }

    /** 写盘：键是会话文件（全新会话还没落盘就先只放在内存里，落盘后第一次改动会补存）。 */
    protected autoSave(rt: SessionRuntime): void {
        const auto = this.autos.get(rt.id);
        if (!auto) { return; }
        auto.updatedAt = Date.now();
        const file = rt.currentSessionPath;
        if (file) { writeAuto(auto, file); }
    }

    /** 把这个会话的开关推给所有屏（null = 关了）。内存里没有的先从存档接回来。 */
    protected autoBroadcast(panelId: string): void {
        const rt = this.panels.get(panelId);
        const auto = (rt ? this.autoGet(rt) : this.autos.get(panelId)) ?? null;
        this.postToSession(panelId, { type: "auto", auto });
    }

    /** 一轮跑完了：该催就催（有子会话在跑就催它别闲着，后台命令在跑就等结果交回）。 */
    protected autoLoopOnTurnEnd(info: TurnEndInfo): void {
        if (info.status !== "done") { return; }   // 被打断 / 出错的一轮：不算，等下一轮
        const rt = this.panels.get(info.panelId);
        if (!rt || !this.autoGet(rt)) { return; }
        // 这个收尾是异步送出的（要等最后一条回复的原文），等它到时人可能已经又发了一句、
        // 下一轮已经开跑：那时候再催就成了“两轮撞在一处”。
        if (rt.streaming) { return; }
        // 派出去的子会话还在跑：催主会话别停着。这一条排在后台命令前头：两边都在跑时也照样催。
        if (this.taba.hasRunningChildren(info.panelId)) {
            this.autoNudgeWhileChildrenRun(info.panelId);
            return;
        }
        // 后台还有命令在跑：先不发。它们的结果本来就会当一条新消息交回这个会话，
        // 等它们进来、那一轮跑完再催 —— 两边一起催，同一个会话就撞在一处了。
        if (rt.hasRunningBashTasks()) { return; }
        this.autoContinue(info.panelId);
    }

    /** 给主会话发一句「继续」。中途开关关掉了就不催了。 */
    protected autoContinue(workerPanelId: string): void {
        const rt = this.panels.get(workerPanelId);
        if (!rt) { return; }
        if (!this.autoGet(rt)) { return; }
        rt.handleSend(AUTO_CONTINUE_TEXT, undefined, { followUp: true });
    }

    /**
     * 子会话还在跑、主会话这一轮先跑完了：叫它去干别的，别停着等。
     *
     * 每次跑完、子会话还在跑就再发一句；中途开关关掉了就不发。
     */
    protected autoNudgeWhileChildrenRun(workerPanelId: string): void {
        const rt = this.panels.get(workerPanelId);
        if (!rt) { return; }
        if (!this.autoGet(rt)) { return; }
        rt.handleSend(AUTO_CHILDREN_RUNNING_TEXT, undefined, { followUp: true });
    }

    /**
     * 自动模式开着时，模型问的选择题替人答：给它推荐的那几项（没推荐就第一项）。
     * 没开自动模式、或者没选项就返回 undefined —— 那还是走正常的问话卡片。
     */
    protected autoAnswerAsk(req: AskRequest, sessionId?: string): string[] | undefined {
        const rt = sessionId ? this.panels.get(sessionId) : undefined;
        if (!rt || !this.autoGet(rt)) { return undefined; }
        const picks = autoAskPicks(req);
        return picks.length > 0 ? picks : undefined;
    }

    // ========================================================================
    //  派子会话（taba）：一个会话把活派给另一个会话，子会话开在新 tab 里
    // ========================================================================

    /** 子会话登记表。 */
    protected readonly taba = new TabaRegistry();
    /** 正在派活中的编号：同一个请求重复送过来时不要开出两个 tab。 */
    private readonly tabaInFlight = new Set<string>();
    /** 等子会话的 pi 起来最多等多久（冷启动要加载扩展，比领备用进程慢）。 */
    protected static readonly TABA_CHILD_READY_TIMEOUT_MS = 40000;
    /** 会话名里子会话名字最多占多长。 */
    private static readonly TABA_TAB_NAME_MAX = 28;


    /** RuntimeHost.onTabaRequest：某个会话里的 pi 扩展要派子会话 / 停子会话。 */
    public onTabaRequest(panelId: string, request: TabaRequest): void {
        if (request.kind === "spawn") {
            void this.tabaSpawn(panelId, request);
            return;
        }
        this.tabaStopByRef(panelId, request);
    }

    /** 派活没成：界面上打一行，同时把原因交给模型（它那边的工具已经回了“已派出”）。 */
    protected tabaFailSpawn(parentRt: SessionRuntime, name: string, reason: string): void {
        this.postToSession(parentRt.id, { type: "system", text: buildSpawnFailure({ name, reason }) });
        parentRt.handleSend(`【派子会话没成】「${name}」：${reason}`, undefined, { followUp: true });
    }

    /**
     * 派一个子会话：新开一个会话（不抢当前显示的那一个），把任务发过去。
     * 它跑完第一轮后，最后一条回复会自动交回这个会话（见 tabaOnTurnEnd）。
     */
    protected async tabaSpawn(parentPanelId: string, req: TabaSpawnRequest): Promise<void> {
        const parentRt = this.panels.get(parentPanelId);
        if (!parentRt) { return; }
        // 子会话不能再往下派：它那个会话本来就不加载这个扩展，这里再挡一道
        if (this.taba.byChildPanel(parentPanelId)) {
            this.postToSession(parentPanelId, { type: "system", text: "子会话不能再派子会话。" });
            return;
        }
        if (this.taba.has(req.id) || this.tabaInFlight.has(req.id)) { return; }
        this.tabaInFlight.add(req.id);
        try {
            // 子会话怎么起：工作目录 / 模型 都在这里面算（子会话一律全新会话，pi 自己建会话文件）
            const plan = resolveTabaSpawn({
                req,
                // 子会话默认跑在"派活那个会话自己的目录"里：那个会话可能是在别的项目里开的
                // （手机上开的），不能拿宿主默认目录当它的目录。
                parentCwd: parentRt.cwd,
                parentModelId: parentRt.modelId,
                parentProvider: parentRt.provider,
                resolvePath: (p) => this.resolvePath(p, parentRt.cwd),
            });
            const { cwd } = plan;

            // 工具不另传：不带 --tools 起，子会话就跟配置里的 defaultTools 一样（codemode / powershell / MCP 都在）
            const created = this.createBackgroundSession(buildTabaLaunch(cwd), plan.modelOverride);
            if (!created) {
                this.tabaFailSpawn(parentRt, req.name, "子会话开不出来（pi 可执行文件没找到？）");
                return;
            }
            const rt = created;
            const child: TabaChild = {
                id: req.id,
                name: req.name,
                task: req.task,
                parentPanelId,
                parentSessionFile: req.parentSessionFile || "",
                childPanelId: rt.id,
                state: "starting",
                startedAt: Date.now(),
                deliveries: 0,
            };
            if (!this.taba.add(child)) {
                // 同一个编号又来了一次（理论上不会）：把刚开的会话收回去
                this.closeSession(rt.id);
                return;
            }
            this.tabaWriteRun(child);
            this.broadcastSessionList(true);

            // 子会话开起来以后把「任务 + 收尾要求」发过去；派活那个会话的记录文件也带上当背景
            const taskText = buildTaskText({
                task: req.task,
                parentSessionFile: this.tabaParentSessionFile(parentRt, req),
                parentSessionName: this.sessionDisplayName(parentRt),
            }, this.getConfig().prompts);
            const ready = await rt.waitReady(ChatControllerBase.TABA_CHILD_READY_TIMEOUT_MS);
            // 等待期间会话被关掉了：登记在关会话时已经清掉了，这里什么都不用做
            if (!this.panels.has(rt.id)) { return; }
            if (!ready) {
                this.taba.noteTurnEnd(req.id, "error", Date.now());
                this.postToSession(rt.id, { type: "systemError", text: "子会话的 pi 没起来（等超时了）。" });
                this.tabaDeliver(child, { resultText: "", status: "error" });
                return;
            }
            rt.handleSend(taskText, undefined, { followUp: true });
            this.taba.noteTaskSent(req.id);
            this.broadcastSessionList();
            this.tabaWriteRun(this.taba.get(req.id));
            // 问出子会话与父会话的 .jsonl 路径写到名录里（全新会话要等 pi 落盘才有）
            void this.tabaResolveSessionFiles(req.id, rt, parentRt);
        } finally {
            this.tabaInFlight.delete(req.id);
        }
    }

    /** 把某个子会话的情况写到名录文件里（模型那边 task_peek 读的就是它）。 */
    protected tabaWriteRun(child: TabaChild | undefined, state?: TabaRunState): void {
        if (!child) { return; }
        const cfg = this.getConfig();
        if (!cfg.tabaDir) { return; }
        writeRunRecord(tabaRunsDir(cfg.tabaDir), buildRunRecord({ child, state }));
    }

    /**
     * 派活那个会话的记录文件（绝对路径、正斜杠），交给子会话当背景用（见 tabaTask.buildParentContextText）。
     * 扩展报上来的准（它就在那个 pi 进程里）> 会话自己记着的；文件还没落盘就当没有，那一段就不写了。
     */
    protected tabaParentSessionFile(parentRt: SessionRuntime, req: TabaSpawnRequest): string {
        const raw = req.parentSessionFile || parentRt.currentSessionPath || "";
        if (!raw) { return ""; }
        const abs = this.resolvePath(raw, parentRt.cwd);
        try {
            if (fs.statSync(abs).size <= 0) { return ""; }
        } catch {
            return "";
        }
        return abs.replace(/\\/g, "/");
    }

    /**
     * 问出子会话（必要时也问父会话）的 .jsonl 路径，写到名录里。
     * 全新会话的文件要等 pi 把第一条消息落盘才会出现，所以短轮询最多等 15 秒；
     * 中途会话被关掉、或者两边路径都拿到了就停。
     */
    protected async tabaResolveSessionFiles(id: string, childRt: SessionRuntime, parentRt: SessionRuntime): Promise<void> {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const child = this.taba.get(id);
            if (!child) { return; }
            // pi 进程不在了（被关掉 / 启动失败）：再问也问不出来，不白等
            if (!childRt.isRunning()) { return; }
            let changed = false;
            if (!child.sessionFile && this.panels.has(childRt.id)) {
                const resp = await childRt.request<RpcSessionState>({ type: "get_state" }, 3000);
                const file = resp?.data?.sessionFile;
                if (typeof file === "string" && file) {
                    child.sessionFile = file;
                    childRt.currentSessionPath = file;
                    changed = true;
                }
            }
            if (!child.parentSessionFile && this.panels.has(parentRt.id)) {
                let file = parentRt.currentSessionPath;
                if (!file) {
                    const resp = await parentRt.request<RpcSessionState>({ type: "get_state" }, 3000);
                    file = resp?.data?.sessionFile;
                }
                if (typeof file === "string" && file) {
                    child.parentSessionFile = file;
                    changed = true;
                }
            }
            if (changed) { this.tabaWriteRun(child); }
            if (child.sessionFile && child.parentSessionFile) { return; }
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    /** 新开一个后台会话：不抢当前显示的那个会话（一次派好几个时不该把正在看的会话顶走）。 */
    protected createBackgroundSession(
        launch: PanelLaunch,
        modelOverride?: { provider?: string; modelId?: string }
    ): SessionRuntime | undefined {
        const cfg = this.getConfig();
        if (!this.resolveExecutable(cfg.piPath)) { return undefined; }
        const rt = this.createPanelRuntime(modelOverride, launch);
        this.broadcastSessionList(true);
        return rt;
    }

    /** 模型指名停某个子会话当前这一轮（会话都留着）。 */
    protected tabaStopByRef(parentPanelId: string, req: TabaStopRequest): void {
        const parentRt = this.panels.get(parentPanelId);
        const child = this.taba.findByRef(parentPanelId, { id: req.id, name: req.name });
        if (!child) {
            parentRt?.handleSend(
                `【停子会话没成】找不到「${req.name || req.id || "那个子会话"}」：不是这个会话派出去的，或者它已经被关掉了。`,
                undefined,
                { followUp: true }
            );
            return;
        }
        const rt = child.childPanelId ? this.panels.get(child.childPanelId) : undefined;
        if (!rt) { return; }
        rt.abortActiveRun();
        this.postToSession(rt.id, { type: "system", text: "派活给你的那个会话让你停下当前这一轮。" });
        this.postToSession(parentPanelId, {
            type: "system",
            text: `已让子会话「${child.name}」停下当前这一轮（它这个会话还留着）。`,
        });
    }

    /**
     * 子会话跑完一轮：第一轮的结果自动交回派活的会话（只交一次）。
     * 交回之后，一般就把这个子会话的 tab 关掉（关的条件见 shouldCloseAfterFirstTurn）。
     */
    protected tabaOnTurnEnd(info: TurnEndInfo): void {
        const child = this.taba.byChildPanel(info.panelId);
        if (!child) { return; }
        // 第一轮：记下结束时间，把结果交回去（tabaDeliver 里会重写名录）
        if (child.endedAt === undefined && child.deliveries === 0) {
            this.taba.noteTurnEnd(child.id, info.status, Date.now());
            const childPanelId = child.childPanelId;
            const closeAfter = shouldCloseAfterFirstTurn({
                status: info.status,
                hasParent: !!child.parentPanelId && this.panels.has(child.parentPanelId),
                isBeingWatched: !!childPanelId && this.isFocusedPanel(childPanelId),
            });
            // 先把结果交回（交回的文字里要说清楚那个 tab 会被关掉），再关，顺序不能反
            this.tabaDeliver(child, {
                resultText: info.lastReplyText ?? "",
                status: info.status,
                tabWillClose: closeAfter,
            });
            if (closeAfter && childPanelId && this.panels.has(childPanelId)) {
                this.closeSession(childPanelId);
            }
            return;
        }
        // 后面的轮次（一般是用户在子会话里接管了）：不再自动交回，
        // 但名录要跟上，否则主对话那边 task_peek 看到的“最后一条回复的开头”一直停在旧的
        if (info.lastReplyText) { child.result = info.lastReplyText; }
        this.tabaWriteRun(child);
    }

    /** 把子会话的结果交到派活那个会话里（当成一条新消息发过去）。 */
    protected tabaDeliver(
        child: TabaChild,
        opts: { resultText?: string; status?: TurnEndStatus; tabWillClose?: boolean }
    ): boolean {
        const parentRt = child.parentPanelId ? this.panels.get(child.parentPanelId) : undefined;
        const result = (opts.resultText ?? child.result ?? "").trim();
        child.result = result;
        if (!parentRt) {
            if (child.childPanelId) {
                this.postToSession(child.childPanelId, {
                    type: "system",
                    text: "派你来干这个活的会话已经关掉了，结果交不回去；你现在是独立会话。",
                });
            }
            this.tabaWriteRun(child);
            return false;
        }
        const childRt = child.childPanelId ? this.panels.get(child.childPanelId) : undefined;
        const text = buildDeliveryText({
            child,
            result,
            elapsedMs: Math.max(0, (child.endedAt ?? Date.now()) - child.startedAt),
            status: opts.status ?? child.lastStatus ?? "done",
            childSessionName: childRt ? this.sessionDisplayName(childRt) : undefined,
            tabClosed: opts.tabWillClose,
        }, this.getConfig().prompts);
        // 交回一律按 followUp 排队：父会话在跑就不从半路插进去，跑完再作为新的一轮处理。
        parentRt.handleSend(text, undefined, { followUp: true });
        this.taba.markDelivered(child.id, result);
        this.broadcastSessionList(true);
        this.tabaWriteRun(child);
        return true;
    }

    /** 子会话在列表里显示的名字（比随机名字好认）。 */
    protected tabaTabNameOf(name: string): string {
        const t = name.trim() || "子会话";
        return t.length > ChatControllerBase.TABA_TAB_NAME_MAX
            ? t.slice(0, ChatControllerBase.TABA_TAB_NAME_MAX) + "…"
            : t;
    }

    /** 会话被关掉（或搬去另一个工作区）时收尾：它派的子会话变独立；它自己是子会话就抹掉登记并告知父会话。
     *  @param quiet 搬到另一个工作区时传 true：会话并没有被关掉，不发那些“关掉了”的提示
     *  （两边的会话编号会变，登记本来就对不上了，清掉就行）。 */
    protected notePanelGoneForTaba(panelId: string, opts?: { quiet?: boolean }): void {
        const detached = this.taba.detachChildrenOf(panelId);
        for (const c of detached) {
            if (!opts?.quiet && c.childPanelId && this.panels.has(c.childPanelId)) {
                this.postToSession(c.childPanelId, {
                    type: "system",
                    text: "派你来干这个活的会话已经关掉了：你现在是独立会话，结果不会再自动交回。",
                });
            }
            this.tabaWriteRun(c);
        }
        const child = this.taba.byChildPanel(panelId);
        if (child) {
            const parentRt = child.parentPanelId ? this.panels.get(child.parentPanelId) : undefined;
            const undelivered = child.deliveries === 0 && child.endedAt === undefined;
            // 名录里留下最后一条（写成已关闭）：事后模型还能读到那个 .jsonl。
            // 跑完了才关的说“跑完了”，跟“没跑完就被关掉”分开。
            this.tabaWriteRun(child, closedRunState(child));
            this.taba.forgetChildPanel(panelId);
            if (parentRt && undelivered && !opts?.quiet) {
                parentRt.handleSend(buildChildClosedNotice({ child }), undefined, { followUp: true });
            }
        }
        if (detached.length > 0) { this.broadcastSessionList(true); }
    }

    /**
     * 某个会话的子会话信息（交给会话列表画标记）。
     * 只有“它自己是子会话”这一种：父子关系另由 serializeSession 的 parentId 带下去。
     */
    protected tabaPanelInfo(panelId: string): Record<string, unknown> | undefined {
        const asChild = this.taba.byChildPanel(panelId);
        if (!asChild) { return undefined; }
        return { role: "child", id: asChild.id, name: asChild.name, state: asChild.state };
    }

    /** 会话被删掉时释放运行时（杀进程、放名字；登记关系由 notePanelGoneForTaba 处理）。 */
    protected disposePanelRuntime(panelId: string): void {
        const rt = this.panels.get(panelId);
        if (!rt) { return; }
        this.notePanelGoneForTaba(panelId);
        rt.stopClient();
        this.releasePanelName(rt.nameParts);
        this.autos.delete(panelId);   // 盘上那份留着：重新打开这份会话，开关还在
        this.autoChecked.delete(panelId);
        this.panels.delete(panelId);
        this.panelUsedAt.delete(panelId);
    }

    /** 合并所有 panel 中 pi 工具调用触及过的文件绝对路径（供宿主收集符号等）。 */
    public getAllKnownFiles(): string[] {
        const set = new Set<string>();
        for (const rt of this.panels.values()) {
            for (const p of rt.getKnownFiles()) { set.add(p); }
        }
        return Array.from(set);
    }

    // ---- sessionList 广播 ----
    /**
     * 推送会话列表（所有开着的会话 + 当前是哪一个）。默认节流（合并短时间内多次 activity 更新）；
     * 结构变更（新建/关闭/切换）传 immediate=true 立刻推送。
     */
    public broadcastSessionList(immediate = false): void {
        this.noteChildSessionFiles();
        if (immediate) {
            if (this.sessionListTimer) {
                clearTimeout(this.sessionListTimer);
                this.sessionListTimer = null;
            }
            this.emitSessionList();
            return;
        }
        if (this.sessionListTimer) {
            return;
        }
        this.sessionListTimer = setTimeout(() => {
            this.sessionListTimer = null;
            this.emitSessionList();
        }, ChatControllerBase.SESSION_LIST_THROTTLE_MS);
    }

    /**
     * 把派出去的子会话的 .jsonl 路径记进子会话清单（见 childSessions）。
     *
     * 挂在这里是因为它是“会话状态一变就走一遍”的唯一出口：子会话文件是 pi 落盘以后才知道的，
     * 而那时这边一定广播过列表。已经在清单里的会直接返回，所以反复调不要紧。
     */
    private noteChildSessionFiles(): void {
        for (const rt of this.panels.values()) {
            if (!this.taba.byChildPanel(rt.id)) { continue; }
            const file = rt.currentSessionPath;
            if (file) { noteChildSession(file); }
        }
    }

    /**
     * 这个会话要不要人管（见 sessionPhase.ts 的 attention）。
     *
     * 默认“不要”。知道“有一道题在等你答”的只有宿主那一层（问话卡片在它手里），
     * 子类覆写它（见 chatHost 的 openCards；插件里那块对话面板跟浏览器页面走同一个后端，
     * 所以那边也一并有了）。
     */
    protected sessionAttention(_panelId: string): SessionAttention { return ""; }

    /**
     * 告诉所有屏：这个会话的 phase / attention 变了。
     *
     * 只给“宿主独知”的那点事用（比如问话卡片弹出来 / 答完了）：阶段本身的变化由
     * SessionRuntime 自己推（见 postPhase），不必走这里。
     */
    protected broadcastSessionPhase(panelId: string): void {
        const rt = this.panels.get(panelId);
        if (!rt) { return; }
        const phase = rt.phase();
        const msg = {
            type: "phaseChanged",
            sessionId: panelId,
            phase,
            busy: isBusyPhase(phase),
            attention: this.sessionAttention(panelId),
        };
        this.forEachClient((_clientId, send) => send(msg));
    }

    /** 一个会话 → webview 可渲染结构（附带显示状态与父子关系）。 */
    private serializeSession(rt: SessionRuntime): Record<string, unknown> {
        const child = this.taba.byChildPanel(rt.id);
        const cwd = rt.cwd;
        const name = this.sessionDisplayName(rt);
        const auto = this.autoGet(rt);
        return {
            id: rt.id,
            // 这个会话跑在哪个目录：界面拿它把会话归到「项目与会话」面板的对应工作区里
            // （切了工作区之后，上半只列那个目录里开着的会话）。
            cwd,
            // 名字不带目录后缀：顶条那一格的会话名底下已经写着工作区的名字（完整的路径在悬停提示里），
            // 「项目与会话」面板也按工作区分了组，后缀只会重复。（# 引用菜单仍用附注行标目录，见 getChatReferenceItems。）
            name,
            // pi 那边给会话起的标题（自动命名扩展 / /name 写的）；还没起就是空串，
            // 界面拿它当会话名，空的时候回落 name。
            title: rt.sessionTitle || "",
            // 当前用的会话文件（列表里用它把“已打开”那些历史行标出来；新会话可能还没落盘）
            file: rt.currentSessionPath || "",
            // 子会话挂在哪个会话下面（前端据此缩进）；不是子会话就是 null
            parentId: child?.parentPanelId ?? null,
            streaming: !!rt.streaming,
            // 这个会话此刻处在哪个阶段（见 sessionPhase.ts）：界面只读这一个值，
            // 不再各挑几个字段自己拼（压缩中、等你答这两档以前界面根本看不见）
            phase: rt.phase(),
            busy: isBusyPhase(rt.phase()),
            compacting: !!rt.compacting,
            // 要不要人管："" / "answer"（有题挂着等你答）/ "done"（跑完你还没看）
            attention: this.sessionAttention(rt.id),
            // 后台还有命令在跑：这一轮答完了也算没干完（会话格、列表行首那颗点照旧蓝点呼吸）。
            bashRunning: rt.hasRunningBashTasks(),
            activity: rt.activity || "idle",
            activityDetail: rt.activityDetail || "",
            piReady: rt.piReady,
            loading: !!rt.loading,
            // 输入框底下那颗胶囊恢复：webview 重建（视图隐藏重开/窗口重载）后 sessionList 是唯一信源，
            // 仅靠一次性 modelChanged 推送会导致模型名丢失
            modelId: rt.modelId,
            provider: rt.provider,
            thinkingLevel: rt.thinkingLevel,
            percent: rt.contextPercent,
            // 生成速度（t/s）：也是只在跑的时候推、跑完就定住，列表每次带一份，页面刷新后还在
            tps: rt.tokensPerSecond ?? null,
            // 派子会话：这个会话是子会话、或者它派过子会话（前端据此画标记）
            taba: this.tabaPanelInfo(rt.id) ?? null,
            // 自动接着干（/auto）：跟 modelChanged 一样是一次性推送，所以每次列表都带一份 ——
            // 页面刷新 / 重连后界面重建，那颗按钮亮不亮就靠它补回来。
            auto: auto ?? null,
        };
    }

    /** 随机名部分（不带 pi 标题）：子会话用任务名，其余用“形容词的noun”。 */
    private randomSessionName(rt: SessionRuntime): string {
        const child = this.taba.byChildPanel(rt.id);
        if (child) { return this.tabaTabNameOf(child.name); }
        return composeName(rt.nameParts);
    }

    /** pi 自己给的标题优先（有才是人眼认得出的名字，如“上传插件到 GitHub”）；
     *  还没起标题时：子会话用任务名，其余用随机名。
     *  注意：这个名字会出现在界面上 / 提醒里 / 给模型的文案里。 */
    protected baseSessionDisplayName(rt: SessionRuntime): string {
        return rt.sessionTitle || this.randomSessionName(rt);
    }

    /** 子类可将原始名映射到全局唯一名字。 */
    protected sessionDisplayName(rt: SessionRuntime): string {
        return this.baseSessionDisplayName(rt);
    }

    /** 当前工作区可供 # 引用的会话列表（子会话排在派它的会话后面，缩进在后端由 sub 说明）。 */
    public getChatReferenceItems(excludePanelId?: string): ChatReferenceItem[] {
        const items: ChatReferenceItem[] = [];
        const kidsByParent = new Map<string, TabaChild[]>();
        for (const child of this.taba.all()) {
            if (!child.parentPanelId) { continue; }
            const list = kidsByParent.get(child.parentPanelId);
            if (list) { list.push(child); } else { kidsByParent.set(child.parentPanelId, [child]); }
        }
        const push = (rt: SessionRuntime, sub: string): void => {
            if (rt.id === excludePanelId) { return; }
            // 名字用界面上那一份（pi 标题优先）：菜单里看到的跟顶条 / 列表一致
            items.push({ id: rt.id, label: this.sessionDisplayName(rt), sub });
            for (const child of kidsByParent.get(rt.id) || []) {
                const kidRt = child.childPanelId ? this.panels.get(child.childPanelId) : undefined;
                if (kidRt && kidRt.id !== excludePanelId) {
                    items.push({ id: kidRt.id, label: this.sessionDisplayName(kidRt), sub: "子会话 · " + this.sessionDisplayName(rt) });
                }
            }
        };
        for (const rt of this.panels.values()) {
            // 子会话已在它父会话下面列过了，这里跳过
            if (this.taba.byChildPanel(rt.id)) { continue; }
            push(rt, sameDir(rt.cwd, this.getCwd()) ? "" : (path.basename(rt.cwd) || rt.cwd));
        }
        return items;
    }

    /** 宿主下发全局引用目录。 */
    public updateChatReferences(items: ChatReferenceItem[]): void {
        this.postToWebview({ type: "chatReferences", items });
    }

    /** 会话结构或当前会话发生变化后，让子类刷新跨工作区引用目录。 */
    protected onChatStructureChanged(): void { /* default: no global registry */ }

    /**
     * 会话列表长什么样：列表内容所有屏一样，“当前是哪一个”各是各的。
     * 所以每块屏各发一份（带它自己那个 activeId）。
     */
    private sessionListMessage(clientId: string): Record<string, unknown> {
        return {
            type: "sessionList",
            sessions: Array.from(this.panels.values())
                .map((rt) => this.serializeSession(rt)),
            // 这块屏自己看的是哪一个（它还没挑过就是 null）。界面以本地那一份为准，
            // 别的屏切会话不会牵动它（后端也不再广播“大家切到哪一个”这件事）。
            activeId: this.focusedIdFor(clientId) ?? null,
        };
    }

    /** 推送会话列表：新建 / 关闭这类结构变更所有屏都要知道，所以一块一块各发一份。 */
    private emitSessionList(): void {
        this.forEachClient((clientId, send) => { send(this.sessionListMessage(clientId)); });
        this.onChatStructureChanged();
    }

    /** 单独给一块屏发一份最新的会话列表（它刚连上 / 刚重连 / 网页视图重建时用）。 */
    public sendSessionListTo(clientId: string): void {
        this.postToOneClient(clientId, this.sessionListMessage(clientId));
    }


    /** RuntimeHost.onKnownFilesChanged：某 panel 的工具触及文件集合变化，转发给宿主。 */
    public onKnownFilesChanged(_panelId: string): void {
        this.onKnownFilesChangedByHost();
    }

    // ========================================================================
    //  “有事”往哪儿送
    // ========================================================================

    /**
     * 某个会话有事了（跑完一轮、模型在等你答一道选择题）。
     *
     * 这一层只办“推给别处”那一半：设置里「消息推送」填了别处的地址就推过去；
     * “在这台弹”那一半由子类接着办（见 ChatHost.trayNote），所以这里要把推没推出去交回去。
     *
     * @param summary 一句话摘要（跑完一轮是回复开头，选择题是题干）
     * @param kind 这一条算跑完一轮，还是模型在等你答一句
     * @returns 是不是推给别处了（推了这台就不弹）
     */
    protected trayNote(sessionId: string, name: string, summary = "", kind: "done" | "ask" = "done"): boolean {
        if (!sessionId || !this.notifyTurnEndEnabled()) { return false; }
        const label = (name || "").trim() || "会话";
        // 推给别处的那份留长一点（见 remoteNotice.ts 的 REMOTE_TEXT_CHARS），
        // 但不压成纯文本：markdown 原样过去，收到的那台自己画那张卡片
        return this.pushRemoteNote(sessionId, label, clipText(summary, REMOTE_TEXT_CHARS), kind);
    }

    /**
     * 把这条“有事”推给别的后端（设置里「消息推送」填了别处的地址才有这回事）。
     * 默认不推：只有知道自己地址的宿主才推得出去（见 ChatHost）。
     * @returns 是不是推给“别处”了（推了的话，这台就不再自己弹）
     */
    protected pushRemoteNote(_sessionId: string, _name: string, _summary = "", _kind: "done" | "ask" = "done"): boolean { return false; }

    /**
     * RuntimeHost.onTurnEnd：一个会话跑完了一轮。
     *
     * 基类做三件事：
     *   1. 子会话跑完第一轮时，把结果交回派活的那个会话（不等会话标题）；
     *   2. 告诉每块屏「这个会话跑完了一轮」—— 界面据此把那个名字旁边的点标成绿的
     *      （跑完了，不管当时有没有在看它）；这条不管开关都发，关了提醒那颗绿点还得看得见；
     *      带上 status：被中止的一轮不算跑完、也不会绿；
     *   3. 让 Windows 那边弹一条提醒（见 trayNote）：被中止的一轮，
     *      别人派的子会话也不弹 —— 它的结果会交回派它的会话，那边跑完再提醒；
     *      自动模式开着的时候也不弹（它自己会接着跑）。
     */
    public onTurnEnd(info: TurnEndInfo): void {
        // 自动接着干开着：这一轮跑完就再发一句「继续」
        this.autoLoopOnTurnEnd(info);
        // 先记下这个会话是不是「别人派的、结果还要交回去」的子会话：tabaOnTurnEnd 可能紧接着
        // 就把它关掉、名录也摘了，要赶在它前面看。
        const child = this.taba.byChildPanel(info.panelId);
        const handedBack = !!child && !!child.parentPanelId && this.panels.has(child.parentPanelId);
        // 子会话跑完第一轮：结果先交回派活的那个会话（不等会话标题）
        this.tabaOnTurnEnd(info);
        // 每条屏都收到：界面据此把那个会话名字旁边那颗点变绿（不看这块屏当时看着的是哪一个）。
        // 弹提醒不走这条路，走右下角那张卡片（见 trayNote）。
        const rt = this.panels.get(info.panelId);
        const name = rt ? this.sessionDisplayName(rt) : "";
        const msg = {
            type: "turnEnd",
            sessionId: info.panelId,
            status: info.status,
            child: handedBack,
        };
        this.forEachClient((_clientId, send) => { send({ ...msg }); });
        // 弹一条提醒：被中止的那一轮不算跑完；子会话的结果会交回派它的会话，那边跑完再提醒；
        // 自动模式开着的时候每一轮都不弹（它自己会接着跑）
        const auto = rt ? this.autoGet(rt) : undefined;
        if (!auto && info.status !== "cancelled" && !handedBack) {
            this.trayNote(info.panelId, name, info.lastReplyText ?? "");
        }
    }

    protected onKnownFilesChangedByHost(): void { /* 默认无操作 */ }

    /**
     * 用户在某个会话里说上话了（见 {@link RuntimeHost.onUserMessage}）。
     * 默认什么也不做；独立后端那层拿它把右下角那张提醒卡片收掉（见 ChatHost.onUserMessage）。
     */
    public onUserMessage(_panelId: string): void { /* 默认不管 */ }

    // ========================================================================
    //  发送 / 中止（一个会话一个目标）
    // ========================================================================

    protected panelIdsOf(panelId: string): string[] {
        return this.panels.has(panelId) ? [panelId] : [];
    }

    /** 向指定会话发送（对照实验/旧入口都走这里）。 */
    protected broadcastSendToTab(panelId: string, text: string, images?: Array<{ data: string; mimeType: string }>): void {
        for (const pid of this.panelIdsOf(panelId)) {
            this.panels.get(pid)?.handleSend(text, images);
        }
    }

    /** 中止指定会话正在跑的那一轮。 */
    protected broadcastAbortToTab(panelId: string): void {
        for (const pid of this.panelIdsOf(panelId)) { this.panels.get(pid)?.abortActiveRun(); }
    }

    /** 「卡住了」那条路：终止这一轮，等它停稳再由运行时把这句发出去
     *  （为什么不当下就发，见 SessionRuntime.abortThenSend）。 */
    protected broadcastAbortThenSendToTab(panelId: string, text: string): void {
        for (const pid of this.panelIdsOf(panelId)) { this.panels.get(pid)?.abortThenSend(text); }
    }

    /** webview / 命令菜单取数：问焦点 panel 的 pi 进程要命令列表
     *  （技能 / 提示模板 / 扩展命令），返回可直接渲染的菜单条目。 */
    protected async handleListCommands(): Promise<void> {
        const clientId = this.currentPageId;
        const rt = this.getActive(clientId);
        if (!rt) { return; }
        const items = await rt.getSlashCommandItems();
        // 命令列表是这个会话自己的（技能 / 提示模板），只回给问它的那块屏
        this.postToOneClient(clientId, { type: "commandList", items });
    }

    // ========================================================================
    //  上下文获取（# 引用：给模型其他会话记录文件的路径，需要时自己读）
    // ========================================================================

    /** 体积可读化（字节数 → 980B / 120.3KB / 1.2MB）。 */
    private formatSize(bytes: number): string {
        if (bytes >= 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(1) + "MB"; }
        if (bytes >= 1024) { return (bytes / 1024).toFixed(1) + "KB"; }
        return bytes + "B";
    }

    /**
     * 为一个会话生成 # 引用内容。
     * 不再导出会话全文（会话越长越肥，且模型未必需要）：只给一段指向该会话
     * 记录文件（.jsonl）的指引，要细节时模型自己按需读。
     * 路径向来源会话的 pi 进程问（get_state）；来源可以仍在流式生成，
     * pi 对这份文件即时追加，模型读到的是它读取那一刻的内容。
     */
    public async buildChatReference(msg: any): Promise<{ title: string; text: string } | undefined> {
        const collect = async (pid: string) => {
            const rt = this.panels.get(pid);
            if (!rt) { return undefined; }
            let sessionFile = rt.currentSessionPath;
            if (!sessionFile) {
                const state = await rt.request<RpcSessionState>({ type: "get_state" });
                sessionFile = state?.data?.sessionFile;
                if (sessionFile) { rt.currentSessionPath = sessionFile; }
            }
            if (!sessionFile) { return undefined; }
            const abs = this.resolvePath(sessionFile);
            let size = 0;
            try { size = fs.statSync(abs).size; } catch { return undefined; }   // 尚未落盘 / 已被清理
            if (size <= 0) { return undefined; }
            return { title: this.sessionDisplayName(rt), file: abs.replace(/\\/g, "/"), size, streaming: rt.streaming };
        };

        const sourceId = typeof msg.sessionId === "string" ? msg.sessionId
            : (typeof msg.panelId === "string" ? msg.panelId
                : (typeof msg.tabId === "string" ? msg.tabId : ""));
        if (!sourceId) { return undefined; }
        const rt = this.panels.get(sourceId);
        if (!rt) { return undefined; }
        const one = await collect(rt.id);
        if (!one) { return undefined; }
        const sections = [one];
        const cardTitle = `💬 ${this.sessionDisplayName(rt)}`;

        const lines = sections.map((s) =>
            `- 会话「${s.title}」：${s.file}（约 ${this.formatSize(s.size)}${s.streaming ? "，仍在持续追加" : ""}）`);
        const body = promptText(this.getConfig().prompts, "chatReference", { 会话: lines.join("\n") });
        const totalSize = sections.reduce((n, s) => n + s.size, 0);
        return { title: `${cardTitle} · ${this.formatSize(totalSize)}`, text: body };
    }

    /** 将来源生成的快照回传给发起 # 引用的 webview。 */
    public receiveChatReference(
        requestId: number,
        reference: { title: string; text: string } | undefined,
        clientId: string = this.currentPageId,
    ): void {
        if (reference) {
            // 这是“谁问的给谁”：几块屏同时用 # 引用时，各自的请求编号可能撞上
            this.postToOneClient(clientId, { type: "fetchChatResult", requestId, ...reference });
        } else {
            const target = this.getActive(clientId)?.id;
            if (target) { this.postToSession(target, { type: "system", text: "所选会话暂无可引用的消息。" }); }
        }
    }

    /** 本地引用的兼容入口；跨工作区宿主会改由 buildChatReference 调度。 */
    protected async handleFetchChat(msg: any): Promise<void> {
        // 取快照是异步的（要问 pi 要会话文件），跑回来时得还给问的那块屏
        const clientId = this.currentPageId;
        const requestId = typeof msg.requestId === "number" ? msg.requestId : 0;
        this.receiveChatReference(requestId, await this.buildChatReference(msg), clientId);
    }

    // ========================================================================
    //  拾取器 + 模型选择（RuntimeHost.pickModelInteractive）
    // ========================================================================
    /**
     * 浮层该发给哪个界面：多界面宿主（插件里的对话面板 + 浏览器页面）在这里挑
     * “人最近在动的那一个”。
     */
    protected abstract pickOverlayTarget(): string;

    /**
     * 把浮层消息发给挑好的那个界面：只发给那一块屏，别的屏不受影响。
     * @returns 发没发出去；发不出去时调用方按取消处理（别让等的人干等）。
     */
    protected abstract sendOverlayTo(target: string, msg: Record<string, unknown>): boolean;

    /** 界面上答了一张开在消息流里的问话卡片（见 ChatHost.askOnScreens）。 */
    protected handleAskCardAnswer(_msg: any): void { /* 默认不收这种消息：只有带问话卡片的宿主用得上 */ }
    /** 界面上把一张问话卡片“不答了”。 */
    protected handleAskCardCancel(_msg: any): void { /* 同上 */ }

    /** 向界面推送拾取器浮层并等待用户选择（取消返回 undefined）。
     *  @param target 弹给哪块屏（界面标识）；不填就现挑“人最近在动的那一块”。 */
    protected showPicker(
        kind: string,
        items: any[],
        current?: string | null,
        echo?: Record<string, unknown>,
        target?: string,
        timeoutMs?: number,
    ): Promise<any | undefined> {
        return this.openPicker(kind, { items, current: current ?? null, ...(echo || {}) }, target, timeoutMs);
    }

    /**
     * 推送一个浮层并等回复。
     * @param target 指定发给哪个界面；不填就现挑“人最近在动的那一个”。
     */
    protected openPicker(kind: string, body: Record<string, unknown>, target?: string, timeoutMs?: number): Promise<any | undefined> {
        const to = target ?? this.pickOverlayTarget();
        // 这块屏上还开着的上一个浮层：先让它收起来（同一块屏连开两个就走这一道）；
        // 别的屏开着什么不管：各开各的（两个窗口同时开着会话列表互不影响）。
        this.dropPicker(to, true);
        if (!to || !this.sendOverlayTo(to, { type: "picker", kind, ...body })) {
            return Promise.resolve(undefined);
        }
        const st = this.pickerStateOf(to);
        st.kind = kind;
        // 面板滑出来的那一套（窄窗）：它也归这份状态管（常驻那一列另算，见 workspaceDock。）
        if (kind === "workspace") { st.workspaceOpen = true; st.workspaceDock = false; }
        return new Promise<any | undefined>((resolve) => {
            st.resolve = resolve;
            st.timer = setTimeout(() => { this.dropPicker(to, true); }, timeoutMs ?? ChatControllerBase.PICKER_TIMEOUT_MS);
        });
    }

    /** 收掉某块屏上开着的浮层：按需让它收起来，再把等的人按取消放行。 */
    private dropPicker(clientId: string, notify: boolean): void {
        const st = clientId ? this.pickers.get(clientId) : undefined;
        if (!st) { return; }
        const resolve = st.resolve;
        const kind = st.kind;
        st.resolve = null;
        st.kind = "";
        // 滑出来的那份「项目与会话」被顶掉 / 收掉了：以后不用再给它重推（常驻那一列不算，
        // 它开着的时候上面还能再开别的浮层，收起也只有界面自己知道）。
        if (kind === "workspace" && !st.workspaceDock) { st.workspaceOpen = false; }
        if (st.timer) { clearTimeout(st.timer); st.timer = undefined; }
        if (!resolve) { return; }
        if (notify && kind) { this.sendOverlayTo(clientId, { type: "pickerCancel", kind }); }
        resolve(undefined);
    }

    /**
     * 收摊：所有屏上还开着的浮层都按取消收掉。
     * 主要是把等它的那根定时器（2 分钟）放掉：宿主已经没了，谁也不会再来答，
     * 留着它进程就还要空转两分钟才退（调试脚手架里特别明显：脚本跑完，node 不退出）。
     */
    protected disposeAllPickers(): void {
        for (const clientId of Array.from(this.pickers.keys())) { this.dropPicker(clientId, false); }
        this.pickers.clear();
    }

    /**
     * 浮层挂着的那个界面没了（页面关掉 / 手机退到后台被收掉）：按取消收掉。
     * 那边已经不在了，不用发消息；等的人也不用干等 120 秒。
     */
    protected dropPickerForClient(target: string): void {
        if (!target) { return; }
        this.dropPicker(target, false);
    }

    /**
     * 界面那头回了一条（选了 / 取消了）：把正在等的那一块屏放行。
     *
     * @param fromKind 界面说它回的是哪一个浮层。对不上就不理：窄窗里收一份“项目与会话”的
     *        推送时会顺手回一句 `pickerCancel kind:"workspace"`（见 media/chat.js 的
     *        closePickerAnyway / renderPicker），以前这一句能把这块屏上正开着的别的浮层
     *        （选模型、选文件夹）一并放掉 —— 模型选择器还摆在屏幕上，点下去却没人接。
     */
    protected resolvePicker(payload: any | undefined, fromKind?: string): void {
        const st = this.pickers.get(this.currentPageId);
        if (!st || !st.resolve) { return; }
        if (fromKind !== undefined && fromKind !== st.kind) { return; }
        const r = st.resolve;
        const kind = st.kind;
        st.resolve = null;
        if (st.timer) { clearTimeout(st.timer); st.timer = undefined; }
        // 界面那头自己已经把浮层收了（取消 / 选中都会先关），这里只清状态、把结果交给等的人。
        st.kind = "";
        // 滑出来的那份「项目与会话」选完就走（常驻那一列不算：它不等人选，也不关）
        if (kind === "workspace" && !st.workspaceDock) { st.workspaceOpen = false; }
        r(payload);
    }

    public async pickModelInteractive(
        models: ModelInfo[],
        currentThinking: string,
        currentProvider: string,
        currentModelId: string,
        echo?: Record<string, unknown>,
        clientId?: string,
    ): Promise<ModelChoice | undefined> {
        const currentKey = `${currentProvider || ""}\u0000${currentModelId || ""}`;
        const isCurrent = (m: ModelInfo) =>
            `${m.provider || ""}\u0000${m.id || ""}` === currentKey
            || (m.id === currentModelId && (!currentProvider || !m.provider || m.provider === currentProvider));
        const items: any[] = models.map((m) => ({
            id: m.id,
            provider: m.provider,
            name: m.name,
            contextWindow: m.contextWindow,
            reasoning: m.reasoning === true,
            thinkingLevels: Array.isArray(m.thinkingLevels) ? m.thinkingLevels : [],
            cost: m.cost,
            current: isCurrent(m),
            currentThinking: isCurrent(m) ? currentThinking : "",
        }));
        // 展示序：当前模型所在 provider 分组整组置顶（组内当前模型排第一位），
        // 其余分组保持 models.json 原序，无 provider 的排最后（webview 渲染为“其他”）。
        const provOf = (it: any) => (typeof it.provider === "string" ? it.provider : "");
        const current = items.find((it) => it.current);
        const groupKeys: string[] = [];
        for (const it of items) {
            const k = provOf(it);
            if (!groupKeys.includes(k)) { groupKeys.push(k); }
        }
        const curKey = current ? provOf(current) : null;
        const order: string[] = [
            ...(curKey !== null ? [curKey] : []),
            ...groupKeys.filter((k) => k !== curKey && k !== ""),
            // 空 provider 兜底“其他”排最后；若它本身就是当前组则已在队首，不重复
            ...(curKey !== "" && groupKeys.includes("") ? [""] : []),
        ];
        const grouped = order.flatMap((k) => items.filter((it) => provOf(it) === k));
        const ordered = current ? [current, ...grouped.filter((it) => it !== current)] : grouped;
        const choice = await this.showPicker("model", ordered, currentKey, echo, clientId);
        if (!choice) { return undefined; }
        return {
            provider: choice.provider || "",
            modelId: choice.modelId,
            thinkingLevel: choice.thinkingLevel,
        };
    }

    // ========================================================================
    //  会话加载 / 历史
    // ========================================================================

    /** 哪个开着的会话正在用这份会话文件（没人在用就返回 undefined）。 */
    protected sessionRunningFile(file: string): SessionRuntime | undefined {
        for (const rt of this.panels.values()) {
            if (this.samePath(rt.currentSessionPath, file)) { return rt; }
        }
        return undefined;
    }

    /**
     * 打开一个历史会话。
     * 已经开着的那个会话直接切过去（不再开第二个）；没开着才新建一个会话，
     * 在它自己的目录里启动 pi（pi 的 switch_session 只换会话文件，不换进程工作目录）。
     * @param folder 会话所在的目录；不填 = 当前会话自己的目录。
     */
    public async loadHistorySession(file: string, folder?: string, clientId: string = this.currentPageId): Promise<void> {
        const already = this.sessionRunningFile(file);
        if (already) { this.setActiveSession(already.id, clientId); return; }
        const cwd = folder ? path.resolve(folder) : (this.getActive(clientId)?.cwd ?? this.getCwd());
        const active = this.getActive(clientId);
        // 优先复用当前空会话（目录也得对）；已有对话时新建一个会话，避免历史选择覆盖正在进行的对话。
        let rt = active && this.isActiveSessionEmpty(clientId) && sameDir(active.cwd, cwd) ? active : undefined;
        if (!rt) {
            rt = this.newSessionWithLaunch(sameDir(cwd, this.getCwd()) ? {} : { cwd, skipSpare: true }, 0, clientId);
        }
        if (!rt) { return; }
        this.setActiveSession(rt.id, clientId);
        await rt.loadSession(file);
    }

    /** 路径归一化比较（盘符 / 分隔符；Windows 上还不分大小写，别的系统照原样比）。 */
    protected samePath(a: string | undefined, b: string | undefined): boolean {
        if (!a || !b) { return false; }
        // 别的系统上 /a/B 和 /a/b 是两个不同的文件：只有 Windows 才转小写、去盘符
        const isWindows = process.platform === "win32";
        const norm = (p: string) => {
            const s = pathCaseKey(p);
            return isWindows ? s.replace(/^[a-z]:/, "") : s;
        };
        return norm(a) === norm(b);
    }

    // ========================================================================
    //  历史会话列表（pi /resume 风格：标题 + 相对时间，每批 10 条）
    // ========================================================================
    /** 每批展示/扫描的文件数。 */
    private static readonly HISTORY_BATCH_SIZE = 10;

    /** 「启动时自动打开最近会话」最多往后试几个文件（都是子会话就算了，留给用户自己挑）。 */
    private static readonly AUTO_LOAD_SKIP_MAX = 10;

    /**
     * 弹出历史会话列表并加载选中项。
     * @param target 列表弹给哪个界面（界面标识）；不填就用正在说话的那一块。
     * @param opts.folder 列哪个目录的会话；不填 = 这块屏当前会话自己的目录（可能是别的项目）。
     */
    public async showHistoryPicker(
        target?: string,
        opts?: { folder?: string },
    ): Promise<void> {
        const clientId = target || this.currentPageId;
        const cwd = opts?.folder ? path.resolve(opts.folder) : (this.getActive(clientId)?.cwd ?? this.getCwd());
        const state = this.pickerStateOf(clientId);
        state.historyFiles = (await listSessionFiles(cwd)).map((e) => e.file);
        state.historyOffset = 0;
        if (state.historyFiles.length === 0) { return; }
        const items = await this.scanHistoryBatch(clientId);
        if (items.length === 0) { return; }
        const choice = await this.promptHistoryPicker(items, state.historyOffset < state.historyFiles.length, clientId);
        if (!choice || typeof choice.file !== "string") { return; }
        await this.loadHistorySession(choice.file, cwd, clientId);
    }

    /** 「加载更多」：扫描下一批文件，把新条目追加进开着的列表（只发给开列表的那一块屏）。 */
    public async loadMoreHistory(): Promise<void> {
        const clientId = this.currentPageId;
        const state = this.pickerStateOf(clientId);
        try {
            const before = state.historyOffset;
            const items = await this.scanHistoryBatch(clientId);
            if (items.length === 0 && state.historyOffset === before) {
                this.sendOverlayTo(clientId, { type: "historyPageEnd" });
                return;
            }
            this.sendOverlayTo(clientId, { type: "historyPageAppend", items, hasMore: state.historyOffset < state.historyFiles.length });
        } catch {
            // 扫出错也得回一句：界面那颗按钮正等着它把“加载中”放掉
            this.sendOverlayTo(clientId, { type: "historyPageEnd" });
        }
    }

    /**
     * 从一份会话文件清单（按改动时间倒序）里往下扫，凑一批要显示的会话。
     *
     * 子会话（第一条用户消息是派活那套文字，见 sessionStore）不显示：碰上一个就跳过接着扫，
     * 所以这一批可能要多扫几个文件才凑得满。这里不设「最多往下扫多少个文件」的上限：
     * 派活多的目录里子会话常常连成几十上百个，一设上限，正撞上那一串的这一批就是 0 条 ——
     * 点了「加载更多」什么都不出来，看着像按钮坏了。扫到凑满这一批或者文件到头为止。
     * 扫完在这一批里按“最后说话时间”再排一遍：屏幕上这一屏看上去是最近聊过的在前面。
     *
     * @param offset 从清单里第几个文件接着扫（不是“第几条会话”：跳过的子会话也占游标）。
     * @returns 这一批条目、扫到第几个文件了、后面还有没有文件
     */
    protected async scanSessionPage(
        files: string[],
        offset: number,
        size: number,
    ): Promise<{ items: SessionListItem[]; nextOffset: number; hasMore: boolean }> {
        const items: SessionListItem[] = [];
        let at = offset;
        while (items.length < size && at < files.length) {
            const batch = files.slice(at, at + (size - items.length));
            if (batch.length === 0) { break; }
            at += batch.length;
            const scannedItems = await Promise.all(batch.map((f) => scanSessionInfo(f)));
            for (const s of scannedItems) {
                if (s && !s.child) { items.push(s); }
            }
        }
        items.sort((a, b) => b.lastActivity - a.lastActivity);
        return { items, nextOffset: at, hasMore: at < files.length };
    }

    /** 扫下一批（历史会话浮层那一份）：游标记在这块屏的浮层状态里。 */
    protected async scanHistoryBatch(clientId: string = this.currentPageId): Promise<HistoryPickerItem[]> {
        const state = this.pickerStateOf(clientId);
        const page = await this.scanSessionPage(state.historyFiles, state.historyOffset, ChatControllerBase.HISTORY_BATCH_SIZE);
        state.historyOffset = page.nextOffset;
        const current = this.getActive(clientId)?.currentSessionPath;
        return page.items.map((s) => ({ ...s, current: this.samePath(s.file, current) }));
    }

    /** 推送历史列表浮层并等待选择（取消返回 undefined）。@param target 指定弹给哪个界面。 */
    protected promptHistoryPicker(items: HistoryPickerItem[], hasMore: boolean, target?: string): Promise<any | undefined> {
        return this.openPicker("history", { items, current: null, hasMore, searchable: false }, target);
    }

    /**
     * 启动时自动打开最近会话（显示选项可关）：只管某一块屏刚建出来的那个空会话，
     * 目录用那个会话自己的（VSCode 窗口里就是它工作区那个项目）。
     */
    protected async maybeAutoLoadLastSession(clientId: string = this.currentPageId): Promise<void> {
        if (this.autoLoadTried.has(clientId)) { return; }
        this.autoLoadTried.add(clientId);
        if (!this.getAutoLoadLast()) { return; }
        const rt = this.getActive(clientId);
        if (!rt || !rt.isConversationEmpty()) { return; }
        const files = await listSessionFiles(rt.cwd);
        if (files.length === 0) { return; }
        // 子会话不自动打开：它是别人派出去干活的一轮，不该占着界面。
        // 文件开头几行就分得出来（见 isChildSessionFile），最多往后试这么多个。
        let pick: string | undefined;
        for (const f of files.slice(0, ChatControllerBase.AUTO_LOAD_SKIP_MAX)) {
            if (!(await isChildSessionFile(f.file))) { pick = f.file; break; }
        }
        if (!pick) { return; }
        // 等文件的功夫里这块屏可能又切走了（或那个会话被关了）：别把历史塞进别的会话
        if (this.getActive(clientId)?.id !== rt.id) { return; }
        await rt.loadSession(pick);
    }

    // ========================================================================
    //  webview 消息分发（公共部分）
    // ========================================================================
    /** 记下“这个会话刚被关掉”：还看着它的屏接着往里发消息时，靠这份记录重新打开它。 */
    private noteClosedSession(panelId: string): void {
        const rt = this.panels.get(panelId);
        if (!rt) { return; }
        this.closedSessions.set(panelId, { cwd: rt.cwd, file: rt.currentSessionPath });
        while (this.closedSessions.size > ChatControllerBase.CLOSED_REMEMBER_MAX) {
            const oldest = this.closedSessions.keys().next().value;
            if (oldest === undefined) { break; }
            this.closedSessions.delete(oldest);
        }
    }

    /** 刚被关掉的会话里，这个标识记着哪个目录。没记着就是 undefined（网页服务的文件地址按它解路径）。 */
    protected rememberedSessionDir(panelId: string): string | undefined {
        return this.closedSessions.get(panelId)?.cwd;
    }

    /**
     * 往一个已经关掉的会话里发消息：按它原来的目录与会话文件重新打开一个
     * （跟从历史里打开一个会话是同一条路），再把这句话送过去。
     * @returns 认不认得这个刚关掉的会话；不认得就当没这回事（界面上什么都不会发生）。
     */
    protected reopenClosedSession(panelId: string, clientId: string, text: unknown, images: unknown): boolean {
        const closed = this.closedSessions.get(panelId);
        if (!closed) { return false; }
        if (typeof text !== "string" || !text.trim()) { return true; }
        void (async () => {
            if (closed.file) {
                await this.loadHistorySession(closed.file, closed.cwd, clientId);
            } else {
                // 从没往盘上写过东西的会话：没有可以接着聊的记录，只能在同一目录开一个空会话顶上
                this.newSessionInDir(closed.cwd, { clientId });
            }
            const rt = this.getActive(clientId);
            if (!rt) { return; }
            rt.handleSend(text, Array.isArray(images) ? images as Array<{ data: string; mimeType: string }> : undefined);
        })();
        return true;
    }

    /**
     * 处理来自 webview 的消息。先处理两宿主公共的全局消息，再交由
     * {@link handlePlatformMessage} 处理平台独有消息，最后处理 panel 级消息。
     */
    public processMessage(msg: any): void {
        // ---- 公共全局消息 ----
        switch (msg.type) {
            case "ready": {
                const clientId = this.currentPageId;
                this.sendViewOptions();
                // 这块屏连上的那一刻，后端已经把首屏（会话 / 状态 / 历史）直接送过去了
                //（见 chatHost 的 bootPageNow）：这里不必再把同一批东西重发一遍 ——
                // 手机上那是一个几百毫秒到两秒的来回，白等。
                if (this.pageBootedByConnect(clientId)) { return; }
                // 这块屏本来就看着的那个（网页视图重建时靠它把画面接回去）
                const had = this.focusedIdFor(clientId);
                // 这块屏还没挑过会话（刚连上 / 它看的那个被关过）：按它自己的规矩挑一个或开一个
                const fresh = this.ensureClientSession(clientId);
                // 列表先给（界面上那些会话壳靠它建起来），再说“你看的是哪一个”
                this.sendSessionListTo(clientId);
                // 各会话的 piReady 同步给这块屏
                for (const rt of this.panels.values()) {
                    this.postToSession(rt.id, { type: "piReady", ready: rt.piReady });
                }
                // 刚刚挑 / 开过的，上面那两步已经说过一次了；本来就在看的这里再说一遍
                // （网页视图重建后它本地什么都没有，得靠这一条把画面接回去）。
                // 带 replay：这是“再说一遍我记得的”，不是刚刚谁按下的 —— 界面自己那边要是有
                // 更后的选择（网络慢，刚按下的切换还在路上），以界面为准（见 media/chat.js 那段）。
                if (had) { this.postToOneClient(clientId, { type: "sessionActivated", sessionId: had, replay: true }); }
                this.onWebviewReady();
                if (fresh) { void this.maybeAutoLoadLastSession(clientId); }
                // webview 就绪后后台预热备用进程，后续新会话免冷启动。
                // 启动路径延迟执行：首个会话的 pi 正在冷启动，同时再拉起备用进程会在
                // VSCode 窗口恢复期叠加出明显的 CPU/IO 峰值（两个 pi 各需 ~3s 加载）。
                this.ensureSpare(ChatControllerBase.SPARE_PREWARM_DELAY_MS);
                return;
            }
            case "newSession": {
                // 跟 pi 的 /new 一样：随手换一个干净的会话接着干，顶条上就留一格 ——
                // 旧的那个关掉（它已经在盘上了，去「项目与会话」里的历史会话点得回来）。
                // 例外：旧的那个还有活没干完，那就留着，不把没跑完的活掐掉。三种都算没干完：
                // 这一轮正在生成 / 跑工具、后台还有命令在跑（那些命令跟着会话走，会话关掉就跑不下去了）、
                // 派出去的子会话还在跑（关掉它，那些子会话就跟它断了，跑完的结果也交不回来）。
                // 先建新的、再关旧的：新会话要继承旧会话的目录与模型，关早了就只剩宿主自己的默认目录了。
                const old = this.getActive();
                const rt = this.newSession();
                if (old && old.id !== rt.id && !old.streaming && !old.hasRunningBashTasks()
                    && !this.taba.hasRunningChildren(old.id)) {
                    this.closeSession(old.id);
                }
                return;
            }
            case "switchSession":
                if (typeof msg.sessionId === "string") { this.setActiveSession(msg.sessionId, this.currentPageId, msg.switchId); }
                return;
            case "closeSession":
                if (typeof msg.sessionId === "string") { this.closeSession(msg.sessionId); }
                return;
            case "listFiles":
                this.sendFileList();
                return;
            case "listCommands":
                void this.handleListCommands();
                return;
            case "fetchChat":
                void this.handleFetchChat(msg);
                return;
            case "openFile":
                if (typeof msg.path === "string") {
                    this.openFileFromWebview(
                        msg.path,
                        typeof msg.line === "number" ? msg.line : undefined,
                        typeof msg.col === "number" ? msg.col : undefined
                    );
                }
                return;
            case "pickerChoice":
                this.resolvePicker(msg.payload, typeof msg.kind === "string" ? msg.kind : undefined);
                return;
            case "pickerCancel":
                this.resolvePicker(undefined, typeof msg.kind === "string" ? msg.kind : undefined);
                return;
            case "askCardAnswer":
                // 界面上答了一张开在消息流里的问话卡片（见 ChatHost.askOnScreens）
                this.handleAskCardAnswer(msg);
                return;
            case "askCardCancel":
                // 界面上把一张问话卡片"不答了"
                this.handleAskCardCancel(msg);
                return;
            case "historyLoadMore":
                void this.loadMoreHistory();
                return;
            case "requestViewOptionItems":
                this.showOptionsPicker();
                return;
            case "requestEnvInfo":
                // 界面上点开了那颗「工具」：把后端存着的最近一份清单给它（还没报过来就是 null）
                if (typeof msg.sessionId === "string" && this.panels.has(msg.sessionId)) {
                    this.postToSession(msg.sessionId, {
                        type: "envInfo",
                        env: this.panels.get(msg.sessionId)?.envInfo() ?? null,
                    });
                }
                return;
            case "bashTasks": {
                // 界面要一份后台命令清单：消息流末尾那一块（「后台任务」）照它画哪几条还在跑。
                // 只回问的那块屏；清单跟着会话的内存走，会话关了就没了。
                const id = typeof msg.sessionId === "string" && this.panels.has(msg.sessionId)
                    ? msg.sessionId
                    : this.getActive()?.id;
                const tasks = id ? (this.panels.get(id)?.listBashTasks() ?? []) : [];
                this.postToOneClient(this.currentPageId, { type: "bashTasks", sessionId: id ?? "", tasks });
                return;
            }
            case "pickerToggle":
                if (typeof msg.action === "string" && msg.kind !== "model") {
                    this.doViewOptionToggle(msg.action, typeof msg.value === "string" ? msg.value : undefined);
                }
                return;
        }

        // ---- 平台独有全局消息 ----
        if (this.handlePlatformMessage(msg)) { return; }

        // ---- 公共会话级消息 ----
        const panelId: string | undefined = typeof msg.sessionId === "string" ? msg.sessionId : msg.tabId;
        const rt = panelId ? this.panels.get(panelId) : undefined;
        // 会话已经被关掉了，但界面那头还留着它的画面（别的窗口关的）：往它里头发消息，
        // 就把那个会话重新打开，再把这句话送过去（跟“进程退出、发消息会自动重启”一个路子）。
        if (!rt && panelId && msg.type === "send") {
            if (this.reopenClosedSession(panelId, this.currentPageId, msg.text, msg.images)) { return; }
        }
        // 命令型消息（pickModel 等）回退到当前会话
        const target = rt ?? (msg.type === "pickModel" ? this.getActive() : undefined);
        if (!target) { return; }

        switch (msg.type) {
            case "send": {
                this.broadcastSendToTab(target.id, msg.text, msg.images);
                break;
            }
            case "autoAct": {
                // 输入框右下角那颗小开关：开着就停，没开就开始
                if (msg.act === "stop") { this.onAutoCommand(target.id, { kind: "off" }); }
                else if (msg.act === "start") { this.onAutoCommand(target.id, { kind: "on" }); }
                break;
            }
            case "abort": {
                this.broadcastAbortToTab(target.id);
                break;
            }
            case "abortThenSend": {
                // 消息流末尾那颗「卡住了」：先终止这一轮，停稳之后把这句发出去
                if (typeof msg.text === "string" && msg.text.trim()) {
                    this.broadcastAbortThenSendToTab(target.id, msg.text);
                }
                break;
            }
            case "pickModel":
                // 模型选择器弹在点它的那块屏上（不是“人最近在动的那一块”：两个窗口时容易弹错地方）
                void target.pickModel(typeof msg.t0 === "number" ? msg.t0 : undefined, this.currentPageId);
                break;
            case "openEditLocation":
                if (typeof msg.path === "string" && typeof msg.anchor === "string" && msg.anchor) {
                    void target.openEditLocationWithAnchor(
                        msg.path,
                        typeof msg.line === "number" ? msg.line : 1,
                        msg.anchor
                    );
                } else if (typeof msg.path === "string") {
                    void target.openEditLocation(msg.path, typeof msg.line === "number" ? msg.line : 1);
                }
                break;
            case "bashDetach":
                // 「正在跑的那一条」上那颗「放后台」：留一个指令文件给 pi 里的扩展，它跑命令时看着
                if (typeof msg.toolCallId === "string") { target.detachBashTool(msg.toolCallId); }
                break;
            case "bashStop":
                // 后台命令那一格里的「停」：把进程连它派出来的子树一起收掉
                if (typeof msg.no === "number") { target.stopBashTask(msg.no); }
                break;
            case "revertEdit":
                if (typeof msg.toolCallId === "string") { void target.revertEdit(msg.toolCallId); }
                break;
            case "revertChange":
                // 「改动」里那份 diff 横条上的「回滚」：把这个文件撤到它最近一次提交的样子
                if (typeof msg.path === "string" && msg.path) { void target.revertChange(msg.path); }
                break;
            case "rename": {
                // 界面双击名字改的：只改点它的那一格那个会话。找不到、或者它是子会话
                //（名字是派活时给的任务名），都当没说。这里也不用上面那个 target 回落：
                //改名字改错人比没改成更麻烦。
                const named = typeof msg.sessionId === "string" ? this.panels.get(msg.sessionId) : undefined;
                if (named && !this.taba.byChildPanel(named.id) && typeof msg.name === "string") {
                    void named.renameSession(msg.name);
                }
                break;
            }
            case "loadOlderHistory":
                // 网页端顶部的「加载更早的消息」按钮：把当前窗口之前的一段补发过来。
                // 只在开过历史窗口的会话上有意义；没开过窗口时运行时自己会忽略。
                // 图片预算按点这颗按钮的那块屏算（手机上仍旧只发占位）。
                void target.loadOlderHistory(this.inlineImageBudget(this.currentPageId));
                break;
            case "loadResultImage":
                // 界面上点开一张"首屏没带过来"的图（见 sessionRuntime 的图片预算）：把那张单发回去。
                if (typeof msg.toolCallId === "string") {
                    void target.loadResultImage(msg.toolCallId, typeof msg.index === "number" ? msg.index : 0);
                }
                break;
            case "loadDetails":
                // 界面上点开提示框了：把这一批没带过来的内容（思考全文 / 工具输出 / 调用参数）
                // 一次发回去（见 sessionRuntime 的 clipDetail / loadDetails）。
                if (Array.isArray(msg.keys)) { target.loadDetails(msg.keys); }
                break;
        }
    }
}

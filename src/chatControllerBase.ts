/**
 * ChatControllerBase —— VSCode 插件的会话编排层。
 *
 * 一级模型：一个会话（panel）= 一个 SessionRuntime = 一个独立 pi 进程。
 * 界面上同时只看得到一个会话（当前会话），其余会话在后台跑着，
 * 从会话列表里切过去；不落盘，宿主一退全部关闭。
 *
 * 本类收敛“与平台无关”的逻辑：
 *   - 会话管理（newSession / setActiveSession / switchSessionByDirection / closeSession）
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
 * 本类不引用 `vscode`，便于单测时 mock RuntimeHost。
 */
import * as fs from "fs";
import * as path from "path";
import { SessionRuntime, RuntimeHost, ModelInfo, ModelChoice, StatusInfo, TurnEndInfo } from "./sessionRuntime";
import { PiConfig } from "./sessionRuntime";
import { PiClient } from "./piClient";
import {
    listSessionFiles,
    scanSessionInfo,
    type HistoryPickerItem,
    type SessionFileEntry,
    type SessionListItem,
} from "./sessionStore";
import { randomNameParts, composeName } from "./names";
import type { PanelLaunch, TurnEndStatus } from "./runtimeTypes";
import type { TabaRequest, TabaSpawnRequest, TabaStopRequest } from "./tabaProtocol";
import { TabaFrameParser } from "./tabaProtocol";
import {
    TabaRegistry,
    buildChildClosedNotice,
    buildChildIntro,
    buildDeliveryText,
    buildSpawnFailure,
    buildSpawnNotice,
    shouldCloseAfterFirstTurn,
    type TabaChild,
} from "./tabaRegistry";
import { buildTaskText } from "./tabaTask";
import {
    buildTabaExtraArgs,
    buildTabaLaunch,
    resolveTabaSpawn,
} from "./tabaLaunch";
import { buildRunRecord, closedRunState, tabaRunsDir, writeRunRecord, type TabaRunState } from "./tabaRunFiles";
import type { RpcSessionState } from "./piRpc";

/** # 引用菜单里的一行：一个会话（或其某个子会话）。 */
export interface ChatReferenceItem {
    id: string;
    label: string;
    sub: string;
}

export abstract class ChatControllerBase implements RuntimeHost {
    protected constructor(public readonly workspaceId: string) {}
    // ---- 会话（一个 SessionRuntime = 一个 pi 进程）----
    protected panels = new Map<string, SessionRuntime>();
    protected panelSeq = 0;
    /** 当前正在界面上显示的会话 id（前端一次只看一个会话）。 */
    protected activePanelId: string | undefined;
    protected autoLoadDone = false;

    /** sessionList 节流：流式 activity 变更很频繁，合并到下一帧附近推送。 */
    private sessionListTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly SESSION_LIST_THROTTLE_MS = 48;

    // ---- 拾取器状态 ----
    protected pickerResolve: ((v: any | undefined) => void) | null = null;
    protected pickerTimer: ReturnType<typeof setTimeout> | null = null;
    /** 当前浮层开在哪个界面（子类挑的目标标识）；空串 = 没开浮层。 */
    protected pickerTarget = "";
    /** 当前浮层的类型：超时 / 被新浮层顶掉时，回给界面的 pickerCancel 要带上它。 */
    protected pickerKind = "";

    // ---- 备用 pi 进程池（热备，免冷启动）----
    /** 已就绪的备用 pi 进程（不绑定任何 panel）。 */
    protected spare: PiClient | null = null;
    /** 正在后台预热、尚未就绪的备用进程（防止并发 spawn 多个）。 */
    protected preparingSpare: PiClient | null = null;
    /** 备用进程启动时使用的模型（领取时随进程一起返回，供继承比对）。 */
    protected spareMeta?: { provider?: string; modelId?: string };
    /** 备用进程延迟预热定时器（disposeSpare 清理）。 */
    protected spareTimer?: ReturnType<typeof setTimeout>;
    /** 启动路径预热备用进程的延迟：错开首个会话的 pi 冷启动，避免两个 pi 同时加载抢占 VSCode 窗口恢复期的资源。 */
    protected static readonly SPARE_PREWARM_DELAY_MS = 5000;

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

    /** 把标签映射转成按钮组选项列表。 */
    protected static keyOptions(labels: Record<string, string>): Array<{ value: string; label: string }> {
        return Object.entries(labels).map(([value, label]) => ({ value, label }));
    }

    // ========================================================================
    //  平台钩子（子类实现）
    // ========================================================================

    /** 把一条全局（不带 sessionId）消息送到 webview。 */
    protected abstract postToWebview(msg: Record<string, unknown>): void;

    // ---- RuntimeHost：配置 / cwd ----
    public abstract getConfig(): PiConfig;
    public abstract getCwd(): string;

    // ---- RuntimeHost：UI 弹窗 / diff / 文件 / 持久化 ----
    public abstract confirmDialog(title: string, message: string): Promise<boolean>;
    public abstract selectDialog(title: string, options: string[]): Promise<string | undefined>;
    public abstract inputDialog(title: string, placeholder: string, prefill: string): Promise<string | undefined>;
    public abstract persistModel(provider: string, modelId: string): void;
    public abstract openFileLocation(p: string, line: number, anchor?: string): void;
    public abstract confirmRevert(label: string): Promise<boolean>;

    // ---- 显示选项：存储读写（子类）----
    protected abstract getAutoLoadLast(): boolean;
    protected abstract getSendKey(): string;
    protected abstract getNewSessionKey(): string;
    protected abstract getTabSwitchKey(): string;
    protected abstract getFocusInputKey(): string;
    /** 字号（px 字符串，如 "13"；空串表示跟随 VSCode 设置）。 */
    protected abstract getFontSize(): string;
    /** 变更显示选项的存储（仅改存储，UI 推送由基类统一完成）。value 为按钮组点选的明确值。 */
    protected abstract mutateViewOption(action: string, value?: string): void;
    /** 会话结束提示音是否开启。 */
    protected abstract notifyBeepEnabled(): boolean;

    // ---- 文件列表 / 文件打开（来自 webview 的 listFiles / openFile）----
    protected abstract sendFileList(): void;
    protected abstract openFileFromWebview(p: string, line?: number, col?: number): void;

    /** webview 首次就绪时调用（默认空，平台子类可覆盖以推送初始化数据）。 */
    protected onWebviewReady(): void {}

    /** 处理平台独有的 webview 消息；已在公共分发中匹配的不会进来。返回是否已处理。 */
    protected abstract handlePlatformMessage(msg: any): boolean;

    // ---- 可选平台钩子 ----
    /** pi 不存在时追加的平台行为（基类已向 panel 推送 systemError）。 */
    protected onPiMissing(_piPath: string): void { /* 默认无操作 */ }
    /** pi 缺失提示文案（基类默认；独立后端覆盖为按实际目录算的路径）。 */
    protected piMissingMessage(piPath: string): string {
        return `未找到 pi 可执行文件（当前配置："${piPath}"）。请确认已安装 pi 并加入系统 PATH，`
            + `或改 ~/.pi/pichat/config.json 里的 piPath。`;
    }
    /** 加载 / 切换会话后聚焦聊天视图（vscode 覆盖为聚焦侧栏）。 */
    protected async onFocusChat(): Promise<void> { /* 默认无操作 */ }
    /** 在弹出历史会话拾取器前做准备（vscode 需 ensureViewVisible）。 */
    protected async beforeHistoryPicker(): Promise<void> { /* 默认无操作 */ }
    /** 历史会话列表为空时的提示（vscode 覆盖为信息条）。 */
    protected onNoSessions(): void { /* 默认无操作 */ }

    // ========================================================================
    //  路径工具（RuntimeHost）
    // ========================================================================
    public relativeTo(cwd: string, full: string): string {
        const norm = (s: string) => s.replace(/\\/g, "/");
        const c = norm(cwd).replace(/\/$/, "") + "/";
        const f = norm(full);
        if (f.toLowerCase().startsWith(c.toLowerCase())) { return f.slice(c.length); }
        return full;
    }

    public resolvePath(p: string, cwd?: string): string {
        if (path.isAbsolute(p)) { return p; }
        return path.resolve(cwd ?? this.getCwd(), p);
    }

    /** 两个目录是不是同一个（Windows 上不分大小写；只比字符串，不解析软链接）。 */
    protected sameDir(a: string, b: string): boolean {
        if (!a || !b) { return false; }
        const na = path.resolve(a);
        const nb = path.resolve(b);
        return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
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
        this.postToWebview({
            type: "viewOptions",
            autoLoadLastSession: this.getAutoLoadLast(),
            sendKey: this.getSendKey(),
            newSessionKey: this.getNewSessionKey(),
            tabSwitchKey: this.getTabSwitchKey(),
            focusInputKey: this.getFocusInputKey(),
            fontSize: this.getFontSize(),
            notifyBeep: this.notifyBeepEnabled(),
            ...this.viewOptionsExtra(),
        });
    }

    /** 子类往 viewOptions 消息里附带的额外字段（缺省无）。 */
    protected viewOptionsExtra(): Record<string, unknown> | undefined { return undefined; }
    /** 子类往显示选项浮层里追加的条目（缺省无）。 */
    protected viewOptionItemsExtra(): Array<{ label: string; desc: string; check: boolean | null; action: string; value?: string; options?: Array<{ value: string; label: string }> }> { return []; }

    /** 构建显示选项浮层条目（toggle / 按钮组模式）。 */
    protected buildViewOptionItems(): Array<{
        label: string; desc: string; check: boolean | null; action: string;
        value?: string; options?: Array<{ value: string; label: string }>;
        kind?: string; min?: number; max?: number; step?: number; unit?: string;
    }> {
        return [
            {
                action: "autoLoadLastSession",
                label: "启动时自动打开最近会话",
                desc: "进入界面时自动加载当前项目最近一次会话",
                check: this.getAutoLoadLast(),
            },
            {
                action: "sendKey",
                label: "发送键",
                desc: "发送消息的快捷键",
                check: null,
                value: this.getSendKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.SEND_KEY_LABELS),
            },
            {
                action: "newSessionKey",
                label: "新建会话",
                desc: "新建会话的快捷键",
                check: null,
                value: this.getNewSessionKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.NEW_SESSION_KEY_LABELS),
            },
            {
                action: "tabSwitchKey",
                label: "切换会话",
                desc: "在多个会话间切换上一个 / 下一个（选项存储键名仍是 tabSwitchKey，改名会让已有设置丢失）",
                check: null,
                value: this.getTabSwitchKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.TAB_SWITCH_KEY_LABELS),
            },
            {
                action: "focusInputKey", label: "聚焦输入框", desc: "在任意 VS Code 焦点位置打开 Pi Chat 并聚焦输入框", check: null,
                value: this.getFocusInputKey(), options: ChatControllerBase.keyOptions(ChatControllerBase.FOCUS_INPUT_KEY_LABELS),
            },
            {
                action: "fontSize",
                label: "字号",
                desc: "拖动调整对话内容字号（默认跟随 VSCode 设置）",
                check: null,
                kind: "slider",
                value: this.getFontSize(),
                min: 11, max: 22, step: 1, unit: "px",
            },
            {
                action: "notifyBeep",
                label: "会话结束提示音",
                desc: "任何 session 跑完都响一声（不再只对焦点 session）；界面被隐藏时不出声",
                check: this.notifyBeepEnabled(),
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
        // 备用进程也要带上“派子会话”那个扩展：它会被下一个新 panel 领走，那个 panel 一样得能派活
        if (cfg.tabaExtension) { extraArgs.push("-e", cfg.tabaExtension); }
        const client = new PiClient({
            piPath: cfg.piPath,
            cwd: this.getCwd(),
            provider: cfg.provider || undefined,
            model: cfg.model || undefined,
            extraArgs,
            env: cfg.tabaDir ? { PICHAT_TABA_DIR: cfg.tabaDir } : undefined,
        });
        // 记住备用进程的启动模型：新 panel 领取时按继承目标比对，不符则补发 set_model
        this.spareMeta = {
            provider: cfg.provider || undefined,
            modelId: cfg.model || undefined,
        };
        this.preparingSpare = client;
        // 备用进程的 stderr 只记“不是暗号行”的那些（暗号是一大串 base64，整行打出来把日志刷没）。
        // 派活请求由领走它的那个会话解析（这里不解析，不然同一行会被处理两次）。
        const spareStderr = new TabaFrameParser();
        client.on("stderr", (text: string) => {
            spareStderr.feed(text);
            for (const line of spareStderr.takeOtherLines()) { console.error("[pi spare stderr]", line); }
        });
        client.on("error", (err: Error) => console.error("[pi spare error]", err.message));
        client.on("exit", () => {
            // 备用进程意外退出（尚未被领取时）：清掉并补一个新的
            if (this.spare === client) {
                this.spare = null;
                this.ensureSpare();
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
            } else {
                client.stop();
                this.ensureSpare();
            }
        });
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

    // ---- 查找 ----
    /** 当前显示的会话（界面上那一个）。 */
    public getActive(): SessionRuntime | undefined {
        return this.activePanelId ? this.panels.get(this.activePanelId) : undefined;
    }

    /** 某会话是不是当前显示的会话（状态栏上报过滤用）。 */
    protected isFocusedPanel(panelId: string): boolean {
        return this.getActive()?.id === panelId;
    }

    /** 当前会话还没承载任何对话内容时，才算可以顶掉它（打开历史会话时复用）。 */
    protected isActiveSessionEmpty(): boolean {
        return this.getActive()?.isConversationEmpty() === true;
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

    /** 新建一个会话并切过去。
     *  跑在哪个目录：跟当前这个会话走（顶条上那个会话在别的项目里，新会话也开在那个项目里）。
     *  一个会话都没有时（刚启动、刚把最后几个会话关完）用宿主自己的默认目录。
     *  @param spareDelayMs 备用进程预热的延迟毫秒数（启动路径传 SPARE_PREWARM_DELAY_MS）。 */
    public newSession(spareDelayMs = 0): SessionRuntime {
        const active = this.getActive();
        // 模型跟会话走：继承当前会话的模型（startClient 内部回落全局配置）
        const inherited = active?.currentModel();
        // 目录也跟会话走；没有会话时回落宿主默认目录
        const dir = active?.cwd ?? this.getCwd();
        // 不是默认目录就别领备用进程：它是按默认目录起的，领过来就跑错地方了
        const launch: PanelLaunch = this.sameDir(dir, this.getCwd()) ? {} : { cwd: dir, skipSpare: true };
        const rt = this.createPanelRuntime(inherited, launch);
        this.activateSession(rt);
        // 后台预热一个备用进程，供下一个新会话直接领取（启动路径延迟执行，避免双冷启动）
        this.ensureSpare(spareDelayMs);
        return rt;
    }

    /**
     * 新建一个会话（成为当前会话），pi 进程按 launch 起：指定工作目录、带额外启动参数这些。
     * 为什么另开一个口子：newSession 只能在当前会话那个目录里新开，而面板里要能在别的工作区开
     * （见 newSessionInDir）、历史里点开别的项目的会话也要按那个项目的目录起进程。
     */
    protected newSessionWithLaunch(launch: PanelLaunch, spareDelayMs = 0): SessionRuntime | undefined {
        const cfg = this.getConfig();
        if (!this.resolveExecutable(cfg.piPath)) { return undefined; }
        const rt = this.createPanelRuntime(this.getActive()?.currentModel(), launch);
        this.activateSession(rt);
        this.ensureSpare(spareDelayMs);
        return rt;
    }

    /**
     * 在指定目录新开一个会话（手机上“在某个项目里开新会话”用）。
     * 目录跟宿主默认目录不一样时不领备用进程：备用进程是按默认目录起的，领过来就跑错地方了。
     */
    public newSessionInDir(dir: string): SessionRuntime | undefined {
        const target = path.resolve(dir);
        const launch: PanelLaunch = this.sameDir(target, this.getCwd()) ? {} : { cwd: target, skipSpare: true };
        return this.newSessionWithLaunch(launch);
    }

    /** 把一个会话设为当前会话并广播。 */
    private activateSession(rt: SessionRuntime): void {
        this.activePanelId = rt.id;
        this.broadcastSessionList(true);
        this.postToWebview({ type: "sessionActivated", sessionId: rt.id });
    }

    // ---- 切换 ----
    /** 切到某个会话（不新开、不重载：那个会话的进程一直跑着）。 */
    public setActiveSession(panelId: string): void {
        if (!this.panels.has(panelId) || this.activePanelId === panelId) { return; }
        this.activePanelId = panelId;
        this.postToWebview({ type: "sessionActivated", sessionId: panelId });
        this.broadcastSessionList(true);
        this.getActive()?.emitStatus();
    }

    /** 按方向切到上一个 / 下一个会话（按会话的建立顺序）。 */
    public switchSessionByDirection(direction: "prev" | "next"): void {
        const ids = Array.from(this.panels.keys());
        if (ids.length < 2) { return; }
        const curIdx = this.activePanelId ? ids.indexOf(this.activePanelId) : 0;
        const delta = direction === "next" ? 1 : -1;
        const nextIdx = (curIdx + delta + ids.length) % ids.length;
        this.setActiveSession(ids[nextIdx]);
    }

    // ---- 关闭 ----
    /** 关闭一个会话：杀进程、释放名字；它要是当前会话就换到剩下的一个；一个都不剩就补一个空的。 */
    public closeSession(panelId: string): void {
        const rt = this.panels.get(panelId);
        if (!rt) { return; }
        this.disposePanelRuntime(panelId);
        if (!this.activePanelId || !this.panels.has(this.activePanelId)) {
            this.activePanelId = this.panels.keys().next().value;
            if (this.activePanelId) { this.postToWebview({ type: "sessionActivated", sessionId: this.activePanelId }); }
        }
        this.broadcastSessionList(true);
        // 全部关完自动新建一个空会话，保持界面可用
        if (this.panels.size === 0) { this.newSession(); }
    }

    // ---- Fork（原生克隆会话到新 panel）----
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
            // 子会话怎么起：工作目录 / 模型 / 工具白名单 都在这里面算（子会话一律全新会话，pi 自己建会话文件）
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

            const extraArgs = buildTabaExtraArgs({ tools: plan.tools });

            const created = this.createBackgroundSession(buildTabaLaunch(extraArgs, cwd), plan.modelOverride);
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

            this.postToSession(parentPanelId, {
                type: "system",
                text: buildSpawnNotice({ child, sessionName: this.sessionDisplayName(rt) }),
            });
            this.postToSession(rt.id, {
                type: "system",
                text: buildChildIntro({
                    child,
                    parentName: this.sessionDisplayName(parentRt),
                }),
            });
            this.broadcastSessionList(true);

            const taskText = buildTaskText({ task: req.task });
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
            this.tabaWriteRun(this.taba.get(req.id));
            this.broadcastSessionList();
            // 问出子会话与父会话的 .jsonl 路径写到名录里（全新会话要等 pi 落盘才有）
            void this.tabaResolveSessionFiles(req.id, rt, parentRt);
        } finally {
            this.tabaInFlight.delete(req.id);
        }
    }

    /** 把某个子会话的情况写到名录文件里（模型那边 taba_peek 读的就是它）。 */
    protected tabaWriteRun(child: TabaChild | undefined, state?: TabaRunState): void {
        if (!child) { return; }
        const cfg = this.getConfig();
        if (!cfg.tabaDir) { return; }
        writeRunRecord(tabaRunsDir(cfg.tabaDir), buildRunRecord({ child, state }));
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
                isBeingWatched: !!childPanelId && this.activePanelId === childPanelId,
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
        // 但名录要跟上，否则主对话那边 taba_peek 看到的“最后一条回复的开头”一直停在旧的
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
        });
        // 交回一律按 followUp 排队：父会话在跑就不从半路插进去，跑完再作为新的一轮处理。
        parentRt.handleSend(text, undefined, { followUp: true });
        this.taba.markDelivered(child.id, result);
        this.postToSession(parentRt.id, { type: "system", text: `已把子会话「${child.name}」的结果交回本会话。` });
        if (child.childPanelId && !opts.tabWillClose) {
            this.postToSession(child.childPanelId, {
                type: "system",
                text: `结果已交回「${this.sessionDisplayName(parentRt)}」。你这个会话还留着，可以接着问。`,
            });
        }
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
                this.postToSession(parentRt.id, {
                    type: "system",
                    text: `子会话「${child.name}」被关掉了，已把这件事交回本会话。`,
                });
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
        this.panels.delete(panelId);
    }

    /** 保证至少有一个会话（全部关掉后自动补一个空的路径用）。 */
    public ensureSomeSession(): void {
        if (this.panels.size === 0) { this.newSession(); }
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

    /** 一个会话 → webview 可渲染结构（附带显示状态与父子关系）。 */
    private serializeSession(rt: SessionRuntime): Record<string, unknown> {
        const child = this.taba.byChildPanel(rt.id);
        const cwd = rt.cwd;
        const name = this.sessionDisplayName(rt);
        return {
            id: rt.id,
            // 这个会话跑在哪个目录：界面拿它把会话归到「项目与会话」面板的对应工作区里
            // （切了工作区之后，上半只列那个目录里开着的会话）。
            cwd,
            // 跑在别的目录上的会话，名字后面挂上目录名（默认目录的不挂，免得满屏后缀）。
            name: this.sameDir(cwd, this.getCwd()) ? name : `${name} · ${path.basename(cwd) || cwd}`,
            // pi 那边给会话起的标题（自动命名扩展 / /name 写的）；还没起就是空串，
            // 界面拿它当会话名，空的时候回落 name。
            title: rt.sessionTitle || "",
            // 当前用的会话文件（列表里用它把“已打开”那些历史行标出来；新会话可能还没落盘）
            file: rt.currentSessionPath || "",
            // 子会话挂在哪个会话下面（前端据此缩进）；不是子会话就是 null
            parentId: child?.parentPanelId ?? null,
            streaming: !!rt.streaming,
            activity: rt.activity || "idle",
            activityDetail: rt.activityDetail || "",
            piReady: rt.piReady,
            loading: !!rt.loading,
            // 状态栏恢复：webview 重建（视图隐藏重开/窗口重载）后 sessionList 是唯一信源，
            // 仅靠一次性 modelChanged 推送会导致模型名丢失
            modelId: rt.modelId,
            provider: rt.provider,
            thinkingLevel: rt.thinkingLevel,
            percent: rt.contextPercent,
            // 派子会话：这个会话是子会话、或者它派过子会话（前端据此画标记）
            taba: this.tabaPanelInfo(rt.id) ?? null,
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

    /** 供全局命名器计算冲突序号（只看随机名，跟 pi 标题无关）。 */
    public getSessionNameBases(): Array<{ id: string; base: string }> {
        return Array.from(this.panels.values()).map((rt) => ({ id: rt.id, base: this.randomSessionName(rt) }));
    }

    /** 指定的全局会话 id 是否属于当前工作区。 */
    public hasChatReference(id: string): boolean {
        return this.panels.has(id);
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
            push(rt, this.sameDir(rt.cwd, this.getCwd()) ? "" : (path.basename(rt.cwd) || rt.cwd));
        }
        return items;
    }

    /** 宿主下发全局引用目录。 */
    public updateChatReferences(items: ChatReferenceItem[]): void {
        this.postToWebview({ type: "chatReferences", items });
    }

    /** 会话结构或当前会话发生变化后，让子类刷新跨工作区引用目录。 */
    protected onChatStructureChanged(): void { /* default: no global registry */ }

    private emitSessionList(): void {
        this.postToWebview({
            type: "sessionList",
            sessions: Array.from(this.panels.values()).map((rt) => this.serializeSession(rt)),
            activeId: this.activePanelId ?? null,
        });
        this.onChatStructureChanged();
    }


    /** RuntimeHost.onStatusUpdate：仅当前焦点 panel 的状态才转发给宿主展示。 */
    public onStatusUpdate(panelId: string, info: StatusInfo): void {
        if (this.isFocusedPanel(panelId)) { this.onActiveStatusUpdate(info); }
    }

    /** RuntimeHost.onKnownFilesChanged：某 panel 的工具触及文件集合变化，转发给宿主。 */
    public onKnownFilesChanged(_panelId: string): void {
        this.onKnownFilesChangedByHost();
    }

    /**
     * RuntimeHost.onTurnEnd：一个会话跑完了一轮。
     *
     * 基类只做两件事：
     *   1. 子会话跑完第一轮时，把结果交回派活的那个会话（不等会话标题）；
     *   2. 告诉界面「这个会话跑完了一轮」—— 界面据此做两件事：你没在看这个会话就把它的名字
     *      标成“有新消息”（顶条、清单三处画小蓝点），以及按显示选项响一声提示音。
     *      这条消息不管提示音开关都发：关了声音，新消息还得看得见（响不响由界面自己判断）。
     */
    public onTurnEnd(info: TurnEndInfo): void {
        // 子会话跑完第一轮：结果先交回派活的那个会话（不等会话标题）
        this.tabaOnTurnEnd(info);
        // 只发给这一个会话：界面那边自己判断看不看得见（切到别的会话就不标、窗口隐藏就不响）。
        for (const id of this.panelIdsOf(info.panelId)) { this.postToSession(id, { type: "turnEnd" }); }
    }

    protected onKnownFilesChangedByHost(): void { /* 默认无操作 */ }

    /** 焦点 panel 的状态发生变化时平台钩子（默认无操作；VSCode 重写为状态栏更新）。 */
    protected onActiveStatusUpdate(_info: StatusInfo): void { /* 默认无操作 */ }

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

    /** 向当前显示的会话发送一条消息（命令入口用）。 */
    public sendActiveTabText(text: string): void {
        const rt = this.getActive();
        if (!rt) { return; }
        rt.handleSend(text);
    }

    /** webview / 命令菜单取数：问焦点 panel 的 pi 进程要命令列表
     *  （技能 / 提示模板 / 扩展命令），返回可直接渲染的菜单条目。 */
    protected async handleListCommands(): Promise<void> {
        const rt = this.getActive();
        if (!rt) { return; }
        const items = await rt.getSlashCommandItems();
        this.postToWebview({ type: "commandList", items });
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
        const body = [
            "以下是其他会话的记录文件，需要了解其内容时再读取，不必现在读：",
            ...lines,
            "pi 会话文件是 JSON Lines 格式，每行一个 JSON 对象，对话内容在 type 为",
            "\"message\" 的行里（助手消息里还有 thinking 块，按需忽略）。文件可能很大，",
            "不要整读：可以先用 grep -n 定位感兴趣的行，再用 read 按行号分段读，",
            "或用 node / python 写几行脚本只抽取需要的字段。",
        ].join("\n");
        const totalSize = sections.reduce((n, s) => n + s.size, 0);
        return { title: `${cardTitle} · ${this.formatSize(totalSize)}`, text: body };
    }

    /** 将来源生成的快照回传给发起 # 引用的 webview。 */
    public receiveChatReference(requestId: number, reference: { title: string; text: string } | undefined): void {
        if (reference) {
            this.postToWebview({ type: "fetchChatResult", requestId, ...reference });
        } else {
            const target = this.getActive()?.id;
            if (target) { this.postToSession(target, { type: "system", text: "所选会话暂无可引用的消息。" }); }
        }
    }

    /** 本地引用的兼容入口；跨工作区宿主会改由 buildChatReference 调度。 */
    protected async handleFetchChat(msg: any): Promise<void> {
        const requestId = typeof msg.requestId === "number" ? msg.requestId : 0;
        this.receiveChatReference(requestId, await this.buildChatReference(msg));
    }

    // ========================================================================
    //  拾取器 + 模型选择（RuntimeHost.pickModelInteractive）
    // ========================================================================
    /**
     * 浮层该发给哪个界面。
     *
     * 多界面宿主（侧边栏 + 网页页面）在这里挑“人最近在动的那一个”；单界面宿主
     * （编辑器面板 / 测试）不需要挑，返回空串，{@link sendOverlayTo} 的默认实现只有一个出口。
     */
    protected pickOverlayTarget(): string { return ""; }

    /**
     * 把浮层消息发给挑好的那个界面。
     *
     * 默认走 postToWebview——单界面宿主只有这一个出口。多界面宿主覆写成“只发给那一个”，
     * 让浮层只出现在人正在看的那块屏上，别的屏不受影响。
     * @returns 发没发出去；发不出去时调用方按取消处理（别让等的人干等）。
     */
    protected sendOverlayTo(_target: string, msg: Record<string, unknown>): boolean {
        this.postToWebview(msg);
        return true;
    }

    /** 向界面推送拾取器浮层并等待用户选择（取消返回 undefined）。 */
    protected showPicker(kind: string, items: any[], current?: string | null, echo?: Record<string, unknown>): Promise<any | undefined> {
        return this.openPicker(kind, { items, current: current ?? null, ...(echo || {}) });
    }

    /**
     * 推送一个浮层并等回复。
     * @param target 指定发给哪个界面；不填就现挑“人最近在动的那一个”。
     */
    protected openPicker(kind: string, body: Record<string, unknown>, target?: string): Promise<any | undefined> {
        // 上一个还没关的浮层：先让它的界面收起来（同一个界面连开两个、或换界面都走这里）
        this.dropPicker(true);
        const to = target ?? this.pickOverlayTarget();
        if (!to || !this.sendOverlayTo(to, { type: "picker", kind, ...body })) {
            return Promise.resolve(undefined);
        }
        this.pickerTarget = to;
        this.pickerKind = kind;
        return new Promise<any | undefined>((resolve) => {
            this.pickerResolve = resolve;
            this.pickerTimer = setTimeout(() => { this.dropPicker(true); }, 120000);
        });
    }

    /** 收掉正在等的浮层：按需让它的界面收起来，再把等的人按取消放行。 */
    private dropPicker(notify: boolean): void {
        const resolve = this.pickerResolve;
        const timer = this.pickerTimer;
        const target = this.pickerTarget;
        const kind = this.pickerKind;
        this.pickerResolve = null;
        this.pickerTimer = null;
        this.pickerTarget = "";
        this.pickerKind = "";
        if (timer) { clearTimeout(timer); }
        if (!resolve) { return; }
        if (notify && kind) { this.sendOverlayTo(target, { type: "pickerCancel", kind }); }
        resolve(undefined);
    }

    /**
     * 浮层挂着的那个界面没了（页面关掉 / 手机退到后台被收掉）：按取消收掉。
     * 那边已经不在了，不用发消息；等的人也不用干等 120 秒。
     */
    protected dropPickerForClient(target: string): void {
        if (!target || target !== this.pickerTarget || !this.pickerResolve) { return; }
        this.dropPicker(false);
    }

    protected resolvePicker(payload: any | undefined): void {
        if (!this.pickerResolve) { return; }
        const r = this.pickerResolve;
        this.pickerResolve = null;
        if (this.pickerTimer) { clearTimeout(this.pickerTimer); this.pickerTimer = null; }
        // 界面那头自己已经把浮层收了（取消 / 选中都会先关），这里只清状态、把结果交给等的人。
        this.pickerTarget = "";
        this.pickerKind = "";
        r(payload);
    }

    public async pickModelInteractive(
        models: ModelInfo[],
        currentThinking: string,
        currentProvider: string,
        currentModelId: string,
        echo?: Record<string, unknown>
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
        const choice = await this.showPicker("model", ordered, currentKey, echo);
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

    public getCurrentSessionPath(): string | undefined {
        return this.getActive()?.currentSessionPath;
    }

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
    public async loadHistorySession(file: string, folder?: string): Promise<void> {
        // 先揭示并等待聊天界面就绪。否则首次从历史画布打开时，loadSession
        // 在界面尚未建立监听器前发出的 clear/消息会丢失，最终只剩一个空会话。
        await this.onFocusChat();
        const already = this.sessionRunningFile(file);
        if (already) { this.setActiveSession(already.id); return; }
        const cwd = folder ? path.resolve(folder) : (this.getActive()?.cwd ?? this.getCwd());
        const active = this.getActive();
        // 优先复用当前空会话（目录也得对）；已有对话时新建一个会话，避免历史选择覆盖正在进行的对话。
        let rt = active && this.isActiveSessionEmpty() && this.sameDir(active.cwd, cwd) ? active : undefined;
        if (!rt) {
            rt = this.newSessionWithLaunch(this.sameDir(cwd, this.getCwd()) ? {} : { cwd, skipSpare: true });
        }
        if (!rt) { return; }
        this.setActiveSession(rt.id);
        await rt.loadSession(file);
    }

    /** 路径归一化比较（盘符 / 分隔符）。 */
    protected samePath(a: string | undefined, b: string | undefined): boolean {
        if (!a || !b) { return false; }
        const norm = (p: string) => {
            let s = p.replace(/\\/g, "/").toLowerCase();
            s = s.replace(/^[a-z]:/, "");
            return s;
        };
        return norm(a) === norm(b);
    }

    // ========================================================================
    //  历史会话列表（pi /resume 风格：标题 + 条数 + 相对时间，每批 10 条）
    // ========================================================================
    /** 本次列表的文件清单（按修改时间倒序）；每次打开列表时重建。 */
    protected historyFiles: SessionFileEntry[] = [];
    /** 已展示到第几个文件（「加载更多」接着往后扫）。 */
    protected historyOffset = 0;
    /** 每批展示/扫描的文件数。 */
    private static readonly HISTORY_BATCH_SIZE = 10;

    /**
     * 弹出历史会话列表并加载选中项。
     * @param fromPage 来源是网页页面：不用把侧边栏拽出来。
     * @param target 列表弹给哪个界面（界面标识）；不填就现挑“人最近在动的那一个”。
     * @param opts.folder 列哪个目录的会话；不填 = 当前焦点会话自己的目录（可能是别的项目）。
     */
    public async showHistoryPicker(
        fromPage = false,
        target?: string,
        opts?: { folder?: string },
    ): Promise<void> {
        if (!fromPage) { await this.beforeHistoryPicker(); }
        const cwd = opts?.folder ? path.resolve(opts.folder) : (this.getActive()?.cwd ?? this.getCwd());
        this.historyFiles = await listSessionFiles(cwd);
        this.historyOffset = 0;
        if (this.historyFiles.length === 0) { this.onNoSessions(); return; }
        const items = await this.scanHistoryBatch();
        if (items.length === 0) { this.onNoSessions(); return; }
        const choice = await this.promptHistoryPicker(items, this.historyOffset < this.historyFiles.length, target);
        if (!choice || typeof choice.file !== "string") { return; }
        await this.loadHistorySession(choice.file, cwd);
    }

    /** 「加载更多」：扫描下一批文件，把新条目追加进开着的列表（只发给开列表的那个界面）。 */
    public async loadMoreHistory(): Promise<void> {
        const batch = this.historyFiles.slice(this.historyOffset, this.historyOffset + ChatControllerBase.HISTORY_BATCH_SIZE);
        if (batch.length === 0) { this.sendOverlayTo(this.pickerTarget, { type: "historyPageEnd" }); return; }
        const items = await this.scanHistoryBatch();
        this.sendOverlayTo(this.pickerTarget, { type: "historyPageAppend", items, hasMore: this.historyOffset < this.historyFiles.length });
    }

    /** 扫描下一批文件，返回展示条目（带“是不是当前焦点会话”）。 */
    protected async scanHistoryBatch(): Promise<HistoryPickerItem[]> {
        const batch = this.historyFiles.slice(this.historyOffset, this.historyOffset + ChatControllerBase.HISTORY_BATCH_SIZE);
        this.historyOffset += batch.length;
        const current = this.getActive()?.currentSessionPath;
        const scanned = await Promise.all(batch.map((f) => scanSessionInfo(f.file)));
        return scanned
            .filter((s): s is SessionListItem => s !== null)
            .map((s) => ({ ...s, current: this.samePath(s.file, current) }));
    }

    /** 推送历史列表浮层并等待选择（取消返回 undefined）。@param target 指定弹给哪个界面。 */
    protected promptHistoryPicker(items: HistoryPickerItem[], hasMore: boolean, target?: string): Promise<any | undefined> {
        return this.openPicker("history", { items, current: null, hasMore, searchable: false }, target);
    }

    /** 启动时自动打开最近会话（显示选项可关）：只取修改时间最新的一个会话文件。 */
    protected async maybeAutoLoadLastSession(): Promise<void> {
        if (this.autoLoadDone) { return; }
        const cwd = this.getCwd();
        if (!cwd) { return; }
        this.autoLoadDone = true;
        if (!this.getAutoLoadLast()) { return; }
        const files = await listSessionFiles(cwd);
        if (files.length === 0) { return; }
        const rt = this.getActive();
        if (rt) { await rt.loadSession(files[0].file); }
    }

    // ========================================================================
    //  webview 消息分发（公共部分）
    // ========================================================================
    /**
     * 处理来自 webview 的消息。先处理两宿主公共的全局消息，再交由
     * {@link handlePlatformMessage} 处理平台独有消息，最后处理 panel 级消息。
     */
    public processMessage(msg: any): void {
        // ---- 公共全局消息 ----
        switch (msg.type) {
            case "ready": {
                this.sendViewOptions();
                this.broadcastSessionList();
                if (this.panels.size === 0) {
                    this.newSession(ChatControllerBase.SPARE_PREWARM_DELAY_MS);
                    void this.maybeAutoLoadLastSession();
                } else {
                    // 已有会话：同步各会话的 piReady
                    for (const rt of this.panels.values()) {
                        this.postToSession(rt.id, { type: "piReady", ready: rt.piReady });
                    }
                }
                if (this.activePanelId) {
                    this.postToWebview({ type: "sessionActivated", sessionId: this.activePanelId });
                }
                this.onWebviewReady();
                // webview 就绪后后台预热备用进程，后续新会话免冷启动。
                // 启动路径延迟执行：首个会话的 pi 正在冷启动，同时再拉起备用进程会在
                // VSCode 窗口恢复期叠加出明显的 CPU/IO 峰值（两个 pi 各需 ~3s 加载）。
                this.ensureSpare(ChatControllerBase.SPARE_PREWARM_DELAY_MS);
                return;
            }
            case "newSession":
                this.newSession();
                return;
            case "switchSession":
                if (typeof msg.sessionId === "string") { this.setActiveSession(msg.sessionId); }
                return;
            case "switchSessionByDirection":
                if (msg.direction === "prev" || msg.direction === "next") { this.switchSessionByDirection(msg.direction); }
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
                this.resolvePicker(msg.payload);
                return;
            case "pickerCancel":
                this.resolvePicker(undefined);
                return;
            case "historyLoadMore":
                void this.loadMoreHistory();
                return;
            case "requestViewOptionItems":
                this.showOptionsPicker();
                return;
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
        // 命令型消息（pickModel 等）回退到当前会话
        const target = rt ?? (msg.type === "pickModel" ? this.getActive() : undefined);
        if (!target) { return; }

        switch (msg.type) {
            case "send": {
                this.broadcastSendToTab(target.id, msg.text, msg.images);
                break;
            }
            case "abort": {
                this.broadcastAbortToTab(target.id);
                break;
            }
            case "pickModel":
                void target.pickModel(typeof msg.t0 === "number" ? msg.t0 : undefined);
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
            case "revertEdit":
                if (typeof msg.toolCallId === "string") { void target.revertEdit(msg.toolCallId); }
                break;
            case "loadOlderHistory":
                // 网页端顶部的「加载更早的消息」按钮：把当前窗口之前的一段补发过来。
                // 只在开过历史窗口的会话上有意义；没开过窗口时运行时自己会忽略。
                void target.loadOlderHistory();
                break;
        }
    }
}

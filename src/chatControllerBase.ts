/**
 * ChatControllerBase —— VSCode 插件的会话编排层。
 *
 * 把“与平台无关”的逻辑收敛到此：
 *   - 标签管理（newTab / setActive / switchTabByDirection / closeTab / broadcastTabList）
 *   - 拾取器浮层（showPicker / resolvePicker）
 *   - 模型选择器（pickModelInteractive）+ 模型内思考强度
 *   - 路径工具（relativeTo / resolvePath / resolveExecutable / checkPiAvailable）
 *   - 显示选项（sendViewOptions / buildViewOptionItems / showOptionsPicker + 标签常量）
 *   - 会话加载 / 分叉（loadHistorySession / forkAtEntryInNewTab / maybeAutoLoadLastSession / showHistoryPicker）
 *   - webview 消息分发（processMessage 的公共部分）
 *
 * 子类只需实现“平台钩子”：消息如何送到 webview、配置/视图选项存储、
 * 对话框 / diff / 文件打开的实现，以及各自独有的消息类型。
 *
 * 本类不引用 `vscode`，便于单测时 mock RuntimeHost。
 */
import * as fs from "fs";
import * as path from "path";
import { SessionRuntime, RuntimeHost, FileChange, ModelInfo, ModelChoice, StatusInfo, } from "./sessionRuntime";
import { PiConfig } from "./sessionRuntime";
import { PiClient } from "./piClient";
import {
    buildSessionTree,
    flattenTreeByFamilies,
    readSessionPreview,
    SESSION_FAMILY_PAGE_SIZE,
    SessionTreeNode,
    SessionItem,
} from "./sessionStore";
import type { RpcSessionState } from "./piRpc";

export abstract class ChatControllerBase implements RuntimeHost {
    // ---- 标签状态 ----
    protected tabs = new Map<string, SessionRuntime>();
    protected activeId: string | undefined;
    protected tabSeq = 0;
    protected autoLoadDone = false;

    // ---- 分屏状态（纯临时视图状态，不落盘）----
    protected splitState?: { leftId: string; rightId: string; linked: boolean; focus: "left" | "right" };
    /** tabList 节流：流式 activity 变更很频繁，合并到下一帧附近推送。 */
    private tabListTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly TAB_LIST_THROTTLE_MS = 48;

    // ---- 拾取器状态 ----
    protected pickerResolve: ((v: any | undefined) => void) | null = null;
    protected pickerTimer: ReturnType<typeof setTimeout> | null = null;

    // ---- 历史拾取器分页状态 ----
    /** 全量会话家族树（buildSessionTree 一次构建，加载更多时复用）。 */
    protected historyTree: SessionTreeNode[] = [];
    /** 已加载到第几个家族（加载更多时累加）。 */
    protected historyFamilyOffset = 0;

    // ---- 备用 pi 进程池（热备，免冷启动）----
    /** 已就绪的备用 pi 进程（不绑定任何 tab）。 */
    protected spare: PiClient | null = null;
    /** 正在后台预热、尚未就绪的备用进程（防止并发 spawn 多个）。 */
    protected preparingSpare: PiClient | null = null;
    /** 备用进程启动时使用的模型（领取时随进程一起返回，供继承比对）。 */
    protected spareMeta?: { provider?: string; modelId?: string };

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
    protected static readonly SPLIT_KEY_LABELS: Record<string, string> = {
        "ctrl+alt+s": "Ctrl+Alt+S",
        "ctrl+shift+s": "Ctrl+Shift+S",
    };

    /** 把标签映射转成按钮组选项列表。 */
    protected static keyOptions(labels: Record<string, string>): Array<{ value: string; label: string }> {
        return Object.entries(labels).map(([value, label]) => ({ value, label }));
    }

    // ========================================================================
    //  平台钩子（子类实现）
    // ========================================================================

    /** 把一条全局（不带 tabId）消息送到 webview。 */
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
    public abstract openDiff(change: FileChange): void;
    public abstract confirmRevert(label: string): Promise<boolean>;

    // ---- 显示选项：存储读写（子类）----
    protected abstract getAutoLoadLast(): boolean;
    protected abstract getSendKey(): string;
    protected abstract getNewSessionKey(): string;
    protected abstract getTabSwitchKey(): string;
    /** 分屏快捷键（如 "ctrl+alt+s"）。 */
    protected abstract getSplitKey(): string;
    /** 转发注入前缀模板（{model}/{模型名称} 替换为模型名；空串为裸转发）。 */
    protected abstract getRelayPrefix(): string;
    /** 工具调用显示："compact"（简洁标签）| "full"（TUI 风格卡片）。 */
    protected abstract getToolDisplay(): string;
    /** 字号（px 字符串，如 "13"；空串表示跟随 VSCode 设置）。 */
    protected abstract getFontSize(): string;
    /** 变更显示选项的存储（仅改存储，UI 推送由基类统一完成）。value 为按钮组点选的明确值。 */
    protected abstract mutateViewOption(action: string, value?: string): void;

    // ---- 文件列表 / 文件打开（来自 webview 的 listFiles / openFile）----
    protected abstract sendFileList(): void;
    protected abstract openFileFromWebview(p: string, line?: number, col?: number): void;

    /** webview 首次就绪时调用（默认空，平台子类可覆盖以推送初始化数据）。 */
    protected onWebviewReady(): void {}

    /** 处理平台独有的 webview 消息；已在公共分发中匹配的不会进来。返回是否已处理。 */
    protected abstract handlePlatformMessage(msg: any): boolean;

    // ---- 可选平台钩子 ----
    /** pi 不存在时追加的平台行为（基类已向 tab 推送 systemError）。 */
    protected onPiMissing(_piPath: string): void { /* 默认无操作 */ }
    /** pi 缺失提示文案（基类默认；vscode 覆盖为更长文案并弹设置入口）。 */
    protected piMissingMessage(piPath: string): string {
        return `未找到 pi 可执行文件（当前配置："${piPath}"）。请确认已安装 pi 并加入 PATH，或在设置中指定 piPath。`;
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

    public resolvePath(p: string): string {
        if (path.isAbsolute(p)) { return p; }
        return path.resolve(this.getCwd(), p);
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

    public checkPiAvailable(piPath: string, tabId: string): boolean {
        if (this.resolveExecutable(piPath)) { return true; }
        this.postToTab(tabId, { type: "systemError", text: this.piMissingMessage(piPath) });
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
            toolDisplay: this.getToolDisplay(),
            fontSize: this.getFontSize(),
            splitKey: this.getSplitKey(),
        });
    }

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
                desc: "在多个会话 tab 间切换上一个 / 下一个",
                check: null,
                value: this.getTabSwitchKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.TAB_SWITCH_KEY_LABELS),
            },
            {
                action: "splitKey",
                label: "分屏快捷键",
                desc: "clone 当前会话到右侧 pane 并排对话（一次发送两边）",
                check: null,
                value: this.getSplitKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.SPLIT_KEY_LABELS),
            },
            {
                action: "relayPrefix",
                kind: "text",
                label: "转发注入前缀",
                desc: "🔁 转发回复到另一侧时自动加的前缀；{模型名称} / {model} 替换为源侧模型名。留空则裸转发",
                check: null,
                value: this.getRelayPrefix(),
            },
            {
                action: "toolDisplay",
                label: "工具调用显示",
                desc: "简洁：仅工具名标签 · 摘要：标签含调用摘要与耗时 · 完整：TUI 风格卡片（调用行、实时输出、结果、耗时）",
                check: null,
                value: this.getToolDisplay(),
                options: [
                    { value: "compact", label: "简洁" },
                    { value: "medium", label: "摘要" },
                    { value: "full", label: "完整" },
                ],
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
        ];
    }

    /** 推送显示选项浮层（toggle 模式，不等待结果）。 */
    protected showOptionsPicker(): void {
        // 推送显示选项条目（数据）：由前端渲染进统一设置面板的「显示选项」tab。
        this.postToWebview({
            type: "viewOptionItems",
            items: this.buildViewOptionItems(),
        });
    }

    /** 浮层中切换某项后刷新：改存储 → 重推视图选项 → 刷新浮层。 */
    protected doViewOptionToggle(action: string, value?: string): void {
        this.mutateViewOption(action, value);
        this.sendViewOptions();
        this.showOptionsPicker();
    }

    // ========================================================================
    //  标签管理（RuntimeHost）
    // ========================================================================

    // ---- 备用 pi 进程池 ----
    /** 确保池中常备一个已就绪的备用进程；领取后由 claimSpareClient 触发补充。 */
    protected ensureSpare(): void {
        if (this.spare || this.preparingSpare) {
            return;
        }
        const cfg = this.getConfig();
        if (!this.resolveExecutable(cfg.piPath)) {
            return;
        }
        const extraArgs = cfg.trustProject
            ? [...cfg.extraArgs, "--approve"]
            : cfg.extraArgs;
        const client = new PiClient({
            piPath: cfg.piPath,
            cwd: this.getCwd(),
            provider: cfg.provider || undefined,
            model: cfg.model || undefined,
            extraArgs,
        });
        // 记住备用进程的启动模型：新 tab 领取时按继承目标比对，不符则补发 set_model
        this.spareMeta = {
            provider: cfg.provider || undefined,
            modelId: cfg.model || undefined,
        };
        this.preparingSpare = client;
        client.on("stderr", (text: string) => console.error("[pi spare stderr]", text));
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

    public postToTab(tabId: string, msg: Record<string, unknown>): void {
        this.postToWebview({ ...msg, tabId });
    }

    /**
     * 推送 tab 列表。默认节流（合并短时间内多次 activity/title 更新）；
     * 结构变更（新建/关闭/切换）传 immediate=true 立刻推送。
     */
    public broadcastTabList(immediate = false): void {
        if (immediate) {
            if (this.tabListTimer) {
                clearTimeout(this.tabListTimer);
                this.tabListTimer = null;
            }
            this.emitTabList();
            return;
        }
        if (this.tabListTimer) {
            return;
        }
        this.tabListTimer = setTimeout(() => {
            this.tabListTimer = null;
            this.emitTabList();
        }, ChatControllerBase.TAB_LIST_THROTTLE_MS);
    }

    private emitTabList(): void {
        this.postToWebview({
            type: "tabList",
            tabs: Array.from(this.tabs.values()).map((rt) => ({
                id: rt.id,
                title: rt.title,
                streaming: rt.streaming,
                activity: rt.activity,
                activityDetail: rt.activityDetail,
                piReady: rt.piReady,
                loading: rt.loading,
            })),
            activeId: this.activeId ?? null,
        });
    }

    public onSessionChanged(_tabId: string, _sessionPath: string | undefined): void { /* 默认无操作 */ }

    /** RuntimeHost.onStatusUpdate：仅活跃 tab 的状态才转发给宿主展示。 */
    public onStatusUpdate(tabId: string, info: StatusInfo): void {
        if (this.activeId === tabId) { this.onActiveStatusUpdate(info); }
    }

    /** RuntimeHost.onKnownFilesChanged：某 tab 的工具触及文件集合变化，转发给宿主。 */
    public onKnownFilesChanged(_tabId: string): void {
        this.onKnownFilesChangedByHost();
    }

    protected onKnownFilesChangedByHost(): void { /* 默认无操作 */ }

    /** 活跃 tab 的状态发生变化时平台钩子（默认无操作；VSCode 重写为状态栏更新）。 */
    protected onActiveStatusUpdate(_info: StatusInfo): void { /* 默认无操作 */ }

    public newTab(): SessionRuntime {
        // 分屏中新建 tab：先退出分屏（新 tab 在分屏视图里不可见）
        if (this.splitState) { this.exitSplit(); }
        // 模型跟 tab 关联：新 tab 继承当前活跃 tab 的模型；无 tab 时回落全局配置（startClient 内部处理）
        const inherited = this.getActive()?.currentModel();
        const id = `tab-${++this.tabSeq}`;
        const title = `会话 ${this.tabSeq}`;
        const rt = new SessionRuntime(id, title, this);
        this.tabs.set(id, rt);
        this.activeId = id;
        this.broadcastTabList(true);
        this.postToWebview({ type: "tabActivated", id });
        rt.startClient(inherited);
        // 后台预热一个备用进程，供下一个新 tab / 切分支直接领取
        this.ensureSpare();
        return rt;
    }

    public setActive(id: string): void {
        if (!this.tabs.has(id) || this.activeId === id) { return; }
        this.activeId = id;
        this.postToWebview({ type: "tabActivated", id });
        this.broadcastTabList(true);
        const rt = this.tabs.get(id);
        if (rt) {
            this.onSessionChanged(id, rt.currentSessionPath);
            rt.emitStatus();
        }
    }

    /** 按方向切换到上一个/下一个 tab。 */
    public switchTabByDirection(direction: "prev" | "next"): void {
        const ids = Array.from(this.tabs.keys());
        if (ids.length < 2) { return; }
        const cur = this.activeId ? ids.indexOf(this.activeId) : 0;
        const idx = cur < 0 ? 0 : cur;
        const nextIdx = direction === "next" ? (idx + 1) % ids.length : (idx - 1 + ids.length) % ids.length;
        this.setActive(ids[nextIdx]);
    }

    public closeTab(id: string): void {
        const rt = this.tabs.get(id);
        if (!rt) { return; }
        // 关闭分屏任一 pane：退出分屏并解散链接组
        if (this.isSplitMember(id)) {
            this.splitState = undefined;
            this.broadcastSplitState();
        }
        rt.stopClient();
        this.tabs.delete(id);
        this.postToWebview({ type: "tabClosed", id });
        if (this.activeId === id) {
            this.activeId = this.tabs.size > 0 ? this.tabs.keys().next().value : undefined;
            if (this.activeId) {
                this.postToWebview({ type: "tabActivated", id: this.activeId });
                const next = this.tabs.get(this.activeId);
                if (next) {
                    this.onSessionChanged(this.activeId, next.currentSessionPath);
                    next.emitStatus();
                }
            }
        }
        this.broadcastTabList(true);
        // 全部关闭后自动新建一个空 tab，保持界面可用
        if (this.tabs.size === 0) { this.newTab(); }
    }

    public getActive(): SessionRuntime | undefined {
        return this.activeId ? this.tabs.get(this.activeId) : undefined;
    }

    /** 合并所有 tab 中 pi 工具调用触及过的文件绝对路径（供宿主收集符号等）。 */
    public getAllKnownFiles(): string[] {
        const set = new Set<string>();
        for (const rt of this.tabs.values()) {
            for (const p of rt.getKnownFiles()) { set.add(p); }
        }
        return Array.from(set);
    }

    // ========================================================================
    //  分屏（两个 pane 并排，链接组广播输入）
    // ========================================================================

    protected broadcastSplitState(): void {
        const s = this.splitState;
        this.postToWebview({
            type: "splitState",
            state: s ? { leftId: s.leftId, rightId: s.rightId, linked: s.linked, focus: s.focus } : null,
        });
    }

    public isSplitMember(tabId: string): boolean {
        return !!this.splitState && (this.splitState.leftId === tabId || this.splitState.rightId === tabId);
    }

    /** 链接中且 tab 在分屏组内 → 返回两个 pane；否则仅该 tab（发送 / abort 共用）。 */
    protected linkedGroupOf(tabId: string): SessionRuntime[] {
        const rt = this.tabs.get(tabId);
        if (!rt) { return []; }
        const s = this.splitState;
        if (s && s.linked && this.isSplitMember(tabId) && s.leftId !== s.rightId) {
            const l = this.tabs.get(s.leftId);
            const r = this.tabs.get(s.rightId);
            if (l && r) { return [l, r]; }
        }
        return [rt];
    }

    /**
     * 分屏：clone 当前活跃会话到新 pane（上下文对齐），自动建立链接。
     * 立即进入分屏视图（右 pane 先显示加载态），clone 异步完成；
     * 源会话迟迟未落盘时降级为“右侧新建空会话 + 链接”。
     */
    public async splitActiveTab(): Promise<void> {
        const src = this.getActive();
        if (!src || this.splitState) { return; }
        // 1. 立即建右 pane 并进分屏，用户马上看到分屏布局 + 加载指示
        const newRt = this.newTab();
        newRt.loading = true;
        this.splitState = { leftId: src.id, rightId: newRt.id, linked: true, focus: "right" };
        this.broadcastTabList(true);
        this.broadcastSplitState();

        // 2. 取源会话状态（sessionFile + 消息数）：0 条消息的全新会话无可复制，立即跳过 clone
        const tStart = Date.now();
        const state = await src.request<RpcSessionState>({ type: "get_state" });
        let sourcePath = src.currentSessionPath || state?.data?.sessionFile;
        if (sourcePath && !src.currentSessionPath) { src.currentSessionPath = sourcePath; }
        const messageCount = typeof state?.data?.messageCount === "number" ? state.data.messageCount : -1;
        let cloned = false;
        if (sourcePath && messageCount !== 0) {
            const abs = this.resolvePath(sourcePath);
            const deadline = Date.now() + 8000;
            while (!fs.existsSync(abs) && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 250));
            }
            if (fs.existsSync(abs)) {
                await newRt.loadSessionAndClone(abs);
                cloned = true;
            }
        } else {
            console.log(`[split] 跳过 clone（messageCount=${messageCount}）`);
        }
        if (!cloned) {
            newRt.loading = false;
            // 有内容但克隆未果才提示；全新空会话无需提示
            if (messageCount !== 0) {
                this.postToTab(newRt.id, {
                    type: "system",
                    text: "源会话尚未保存到磁盘，右侧为全新会话（可直接开始对话）。",
                });
            }
        }
        console.log(`[split] 分屏完成，共 ${Date.now() - tStart}ms`);
        this.broadcastTabList(true);
    }

    /** 退出分屏（保留两个 tab），返回 tab 栏视图。 */
    public exitSplit(): void {
        if (!this.splitState) { return; }
        const focusId = this.splitState.focus === "left" ? this.splitState.leftId : this.splitState.rightId;
        this.splitState = undefined;
        this.broadcastSplitState();
        if (this.tabs.has(focusId)) { this.setActive(focusId); }
        this.broadcastTabList(true);
    }

    /** 点击 pane 聚焦：更新分屏焦点并同步 activeId（状态栏 / 拾取器跟随）。 */
    public setSplitFocus(tabId: string): void {
        const s = this.splitState;
        if (!s) { return; }
        if (tabId === s.leftId) { s.focus = "left"; }
        else if (tabId === s.rightId) { s.focus = "right"; }
        else { return; }
        this.setActive(tabId);
        this.broadcastSplitState();
    }

    protected setSplitLinked(linked: boolean): void {
        const s = this.splitState;
        if (!s || s.linked === linked) { return; }
        s.linked = linked;
        this.broadcastSplitState();
    }

    public toggleSplitLink(): void {
        const s = this.splitState;
        if (!s) { return; }
        this.setSplitLinked(!s.linked);
    }

    // ========================================================================
    //  手动转发（把一方回复注入另一侧，一次性）
    // ========================================================================

    /** 转发注入前缀包装：{model} / {模型名称} 替换为源 pane 的模型名；空模板则裸转发。 */
    protected wrapRelayText(source: SessionRuntime, text: string): string {
        const tpl = this.getRelayPrefix();
        if (!tpl || !tpl.trim()) { return text; }
        const m = source.currentModel();
        const model = m?.modelId || "对端会话";
        const prefix = tpl
            .replace(/\{model\}/g, model)
            .replace(/\{模型名称\}/g, model);
        return prefix + text;
    }

    /** 转发一次：把 fromTab（缺省聚焦 pane）的最新回复加前缀注入另一侧；可指定历史消息文本。 */
    public async relayOnce(fromTabId?: string, text?: string): Promise<void> {
        const s = this.splitState;
        if (!s) { return; }
        const srcId = fromTabId && this.isSplitMember(fromTabId)
            ? fromTabId
            : (s.focus === "left" ? s.leftId : s.rightId);
        const dstId = srcId === s.leftId ? s.rightId : s.leftId;
        const src = this.tabs.get(srcId);
        const dst = this.tabs.get(dstId);
        if (!src || !dst) { return; }
        let payload = typeof text === "string" ? text.trim() : "";
        if (!payload) {
            payload = await src.getLastAssistantText();
        }
        if (!payload) { return; }
        dst.handleSend(this.wrapRelayText(src, payload));
    }

    // ========================================================================
    //  拾取器 + 模型选择（RuntimeHost.pickModelInteractive）
    // ========================================================================
    /** 向 webview 推送拾取器浮层并等待用户选择（取消返回 undefined）。 */
    protected showPicker(kind: string, items: any[], current?: string): Promise<any | undefined> {
        this.postToWebview({ type: "picker", kind, items, current: current ?? null });
        if (this.pickerTimer) { clearTimeout(this.pickerTimer); }
        return new Promise<any | undefined>((resolve) => {
            this.pickerResolve = resolve;
            this.pickerTimer = setTimeout(() => {
                if (this.pickerResolve) {
                    this.pickerResolve = null;
                    this.pickerTimer = null;
                    this.postToWebview({ type: "pickerCancel", kind });
                    resolve(undefined);
                }
            }, 120000);
        });
    }

    protected resolvePicker(payload: any | undefined): void {
        if (!this.pickerResolve) { return; }
        const r = this.pickerResolve;
        this.pickerResolve = null;
        if (this.pickerTimer) { clearTimeout(this.pickerTimer); this.pickerTimer = null; }
        r(payload);
    }

    public async pickModelInteractive(
        models: ModelInfo[],
        currentThinking: string,
        currentProvider: string,
        currentModelId: string
    ): Promise<ModelChoice | undefined> {
        const currentKey = `${currentProvider || ""}\u0000${currentModelId || ""}`;
        const items: any[] = models.map((m) => ({
            id: m.id,
            provider: m.provider,
            name: m.name,
            contextWindow: m.contextWindow,
            reasoning: m.reasoning === true,
            thinkingLevels: Array.isArray(m.thinkingLevels) ? m.thinkingLevels : [],
            current: `${m.provider || ""}\u0000${m.id || ""}` === currentKey
                || (m.id === currentModelId && (!currentProvider || !m.provider || m.provider === currentProvider)),
            currentThinking: `${m.provider || ""}\u0000${m.id || ""}` === currentKey
                || (m.id === currentModelId && (!currentProvider || !m.provider || m.provider === currentProvider))
                ? currentThinking : "",
        }));
        const choice = await this.showPicker("model", items, currentKey);
        if (!choice) { return undefined; }
        return {
            provider: choice.provider || "",
            modelId: choice.modelId,
            thinkingLevel: choice.thinkingLevel,
        };
    }

    // ========================================================================
    //  会话加载 / 分叉 / 历史
    // ========================================================================
    public newSession(): void { this.newTab(); }

    public getCurrentSessionPath(): string | undefined {
        return this.getActive()?.currentSessionPath;
    }

    public async loadHistorySession(file: string): Promise<void> {
        // 分屏中加载历史：作用于聚焦 pane，上下文不同步了，自动解除链接
        this.setSplitLinked(false);
        // 在活跃 tab 加载；若无 tab 则新建（loadSession 内部会等待 pi 就绪）
        let rt = this.getActive();
        if (!rt) {
            rt = this.newTab();
        }
        this.setActive(rt.id);
        await rt.loadSession(file);
        await this.onFocusChat();
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

    /** 查找已打开该会话文件的 tab。 */
    protected findTabBySessionFile(file: string): SessionRuntime | undefined {
        for (const rt of this.tabs.values()) {
            if (this.samePath(rt.currentSessionPath, file)) {
                return rt;
            }
        }
        return undefined;
    }

    /**
     * 画布双击消息：复用已有 tab 或新建 tab 加载会话，并尝试滚到对应 entry。
     */
    public async openSessionAtEntry(file: string, entryId: string): Promise<void> {
        this.setSplitLinked(false);
        let rt = this.findTabBySessionFile(file);
        if (rt) {
            // 命中的是分屏之外的隐藏 tab：先退出分屏，避免 active 指向不可见 pane
            if (this.splitState && !this.isSplitMember(rt.id)) { this.exitSplit(); }
            this.setActive(rt.id);
        } else {
            // 未打开则新 tab，避免覆盖正在进行的对话
            rt = this.newTab();
            await rt.loadSession(file);
        }
        // 稍等 DOM 渲染后再滚（load 会 clear + 重绘）
        this.postToTab(rt.id, { type: "scrollToEntry", entryId });
        setTimeout(() => {
            this.postToTab(rt.id, { type: "scrollToEntry", entryId });
        }, 200);
        await this.onFocusChat();
    }

    /**
     * 画布「在此分支」：新 tab 加载会话文件并在 entry 处 fork。
     */
    public async forkAtEntryFromPath(file: string, entryId: string): Promise<void> {
        this.setSplitLinked(false);
        const abs = this.resolvePath(file);
        if (!fs.existsSync(abs)) {
            return;
        }
        const newRt = this.newTab();
        await newRt.loadSessionAndFork(abs, entryId);
        await this.onFocusChat();
    }

    /**
     * 在新 tab 中打开从某条 user 消息处分叉出的新分支，源 tab 保持不动。
     * 新建一个独立 pi 进程的 tab，先加载源会话文件，再在该 entry 处 fork ——
     * fork 会创建新的分支会话文件并切换到它，源 tab 完全不受影响。
     * 源会话尚未落盘时回退到原地分叉。
     */
    public async forkAtEntryInNewTab(source: SessionRuntime, entryId: string): Promise<void> {
        // 会新建 tab：分屏视图中新 tab 不可见，先退出分屏
        if (this.splitState) { this.exitSplit(); }
        // 取源会话文件路径。currentSessionPath 只在加载历史 / 分叉成功后赋值，
        // 全新 tab 普通对话后从未同步 —— 直接向源 pi 查询真实 sessionFile，
        // 避免误判“未落盘”而在当前 tab 原地分叉。
        let sourcePath = source.currentSessionPath;
        if (!sourcePath) {
            const state = await source.request<RpcSessionState>({ type: "get_state" });
            sourcePath = state?.data?.sessionFile;
            if (sourcePath) {
                source.currentSessionPath = sourcePath;
            }
        }
        // pi 在首条 assistant 回复到达前不把会话写入磁盘：文件可能已创建路径
        // 但尚未落盘，短轮询等它出现；仍不存在才回退原地分叉（会中止源 tab 生成）。
        if (sourcePath) {
            const abs = this.resolvePath(sourcePath);
            const deadline = Date.now() + 8000;
            while (!fs.existsSync(abs) && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 250));
            }
            if (fs.existsSync(abs)) {
                const newRt = this.newTab();
                // 不等固定 sleep：loadSessionAndFork 内部会等待新 tab 的 pi 进程就绪
                await newRt.loadSessionAndFork(abs, entryId);
                await this.onFocusChat();
                return;
            }
        }
        await source.forkFromEntry(entryId);
    }

    protected async maybeAutoLoadLastSession(): Promise<void> {
        if (this.autoLoadDone) { return; }
        const cwd = this.getCwd();
        if (!cwd) { return; }
        this.autoLoadDone = true;
        if (!this.getAutoLoadLast()) { return; }
        // 仅需最近一个根会话：buildSessionTree 后取首个根。
        const tree = await buildSessionTree(cwd);
        if (tree.length === 0) { return; }
        const rt = this.getActive();
        if (rt) { await rt.loadSession(tree[0].header.file); }
    }

    /** 弹出历史会话拾取器并加载选中项。 */
    public async showHistoryPicker(): Promise<void> {
        // 先确保视图可见（VSCode 下会打开侧栏面板）。否则在工作区从未跑过 pi、
        // 会话列表为空时会直接 return，面板根本不打开，表现为“点击无反应”。
        await this.beforeHistoryPicker();
        // 全量读 header 建家族树（~80ms），首屏只解析前 N 个家族的尾读预览；
        // 其余点“加载更多”时按需解析，避免会话文件多时首屏卡顿。
        const tree = await buildSessionTree(this.getCwd());
        this.historyTree = tree;
        this.historyFamilyOffset = 0;
        if (tree.length === 0) {
            this.onNoSessions();
            return;
        }
        const first = await this.loadHistoryFamilyPage(0, SESSION_FAMILY_PAGE_SIZE);
        if (first.items.length === 0) {
            this.onNoSessions();
            return;
        }
        const current = this.getActive()?.currentSessionPath;
        const choice = await this.showHistoryPickerPaged(
            first.items,
            tree.length,
            this.historyFamilyOffset,
            current
        );
        if (!choice || typeof choice.file !== "string") { return; }
        await this.loadHistorySession(choice.file);
    }

    /**
     * 加载家族树指定区间的尾读预览，过滤空预览会话（不显示）。
     * 返回解析后的条目和实际加载到的家族数。
     */
    protected async loadHistoryFamilyPage(
        offset: number,
        limit: number
    ): Promise<{ items: SessionItem[]; loadedFamilies: number }> {
        const flat = flattenTreeByFamilies(this.historyTree, offset, limit);
        const items = await Promise.all(
            flat.map(async (e) => {
                const p = await readSessionPreview(e.file, !!e.parentSession, e.timestamp);
                return {
                    file: e.file,
                    id: e.id,
                    timestamp: e.timestamp,
                    depth: e.depth,
                    userPreview: p.user,
                    assistantPreview: p.assistant,
                } as SessionItem;
            })
        );
        // 空 pair 会话不显示。
        const nonEmpty = items.filter(
            (it) => it.userPreview.length > 0 || it.assistantPreview.length > 0
        );
        const loadedFamilies = Math.min(offset + limit, this.historyTree.length) - offset;
        return { items: nonEmpty, loadedFamilies };
    }

    /**
     * 推送带分页信息的历史拾取器浮层并等待用户选择。
     * 多带 totalFamilies / loadedFamilies 供前端渲染“加载更多”。
     */
    protected showHistoryPickerPaged(
        items: SessionItem[],
        totalFamilies: number,
        loadedFamilies: number,
        current?: string
    ): Promise<any | undefined> {
        this.postToWebview({
            type: "picker",
            kind: "history",
            items,
            current: current ?? null,
            totalFamilies,
            loadedFamilies,
        });
        if (this.pickerTimer) { clearTimeout(this.pickerTimer); }
        return new Promise<any | undefined>((resolve) => {
            this.pickerResolve = resolve;
            this.pickerTimer = setTimeout(() => {
                if (this.pickerResolve) {
                    this.pickerResolve = null;
                    this.pickerTimer = null;
                    this.postToWebview({ type: "pickerCancel", kind: "history" });
                    resolve(undefined);
                }
            }, 120000);
        });
    }

    /** 响应 webview “加载更多历史”：解析下一批并追加分页条目。 */
    public async loadMoreHistory(): Promise<void> {
        if (this.historyTree.length === 0) { return; }
        const offset = this.historyFamilyOffset;
        if (offset >= this.historyTree.length) {
            this.postToWebview({ type: "historyPageEnd", totalFamilies: this.historyTree.length });
            return;
        }
        const result = await this.loadHistoryFamilyPage(offset, SESSION_FAMILY_PAGE_SIZE);
        this.historyFamilyOffset += result.loadedFamilies;
        this.postToWebview({
            type: "historyPageAppend",
            items: result.items,
            totalFamilies: this.historyTree.length,
            loadedFamilies: this.historyFamilyOffset,
        });
    }

    // ========================================================================
    //  webview 消息分发（公共部分）
    // ========================================================================
    /**
     * 处理来自 webview 的消息。先处理两宿主公共的全局消息，再交给
     * {@link handlePlatformMessage} 处理平台独有消息，最后处理 tab 级消息。
     */
    public processMessage(msg: any): void {
        // ---- 公共全局消息 ----
        switch (msg.type) {
            case "ready": {
                this.sendViewOptions();
                this.broadcastTabList();
                this.broadcastSplitState();
                if (this.tabs.size === 0) {
                    this.newTab();
                    void this.maybeAutoLoadLastSession();
                } else {
                    // 已有 tab：同步各 tab 的 piReady
                    for (const rt of this.tabs.values()) {
                        this.postToTab(rt.id, { type: "piReady", ready: rt.piReady });
                    }
                }
                if (this.activeId) {
                    this.postToWebview({ type: "tabActivated", id: this.activeId });
                }
                this.onWebviewReady();
                // webview 就绪后后台预热备用进程，后续新 tab / 切分支免冷启动
                this.ensureSpare();
                return;
            }
            case "newSession":
                this.newTab();
                return;
            case "switchTab":
                if (typeof msg.tabId === "string") { this.setActive(msg.tabId); }
                return;
            case "switchTabByDirection":
                if (msg.direction === "prev" || msg.direction === "next") { this.switchTabByDirection(msg.direction); }
                return;
            case "closeTab":
                if (typeof msg.tabId === "string") { this.closeTab(msg.tabId); }
                return;
            case "listFiles":
                this.sendFileList();
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
            case "splitTab":
                void this.splitActiveTab();
                return;
            case "exitSplit":
                this.exitSplit();
                return;
            case "splitFocus":
                if (typeof msg.tabId === "string") { this.setSplitFocus(msg.tabId); }
                return;
            case "toggleSplitLink":
                this.toggleSplitLink();
                return;
            case "relayOnce":
                void this.relayOnce(
                    typeof msg.fromTabId === "string" ? msg.fromTabId : undefined,
                    typeof msg.text === "string" ? msg.text : undefined
                );
                return;
        }

        // ---- 平台独有全局消息 ----
        if (this.handlePlatformMessage(msg)) { return; }

        // ---- 公共 tab 级消息 ----
        const tabId: string | undefined = msg.tabId;
        const rt = tabId ? this.tabs.get(tabId) : undefined;
        // 命令型消息（pickModel 等）回退到活跃 tab
        const target = rt ?? (msg.type === "pickModel" ? this.getActive() : undefined);
        if (!target) { return; }

        switch (msg.type) {
            case "send": {
                // 分屏链接中：一次发送同时进两个 pane；否则只进目标 tab
                for (const t of this.linkedGroupOf(target.id)) { t.handleSend(msg.text, msg.images); }
                break;
            }
            case "abort": {
                // 分屏链接中：停止同时中断两侧
                for (const t of this.linkedGroupOf(target.id)) { t.abortActiveRun(); }
                break;
            }
            case "showTree":
                void target.showTree();
                break;
            case "forkAtEntry":
                if (typeof msg.entryId === "string") { void this.forkAtEntryInNewTab(target, msg.entryId); }
                break;
            case "pickModel":
                void target.pickModel();
                break;
            case "openDiff":
                if (typeof msg.path === "string") { void target.openDiff(msg.path); }
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
        }
    }
}

/**
 * ChatControllerBase —— VSCode 插件的会话编排层。
 *
 * 把“与平台无关”的逻辑收敛到此：
 *   - 标签管理（newTab / setActive / switchTabByDirection / closeTab / broadcastTabList）
 *   - 拾取器浮层（showPicker / resolvePicker / handleThinkingToggle + pickerRefresher）
 *   - 模型选择器（pickModelInteractive）+ 思考强度标签
 *   - 路径工具（relativeTo / resolvePath / resolveExecutable / checkPiAvailable）
 *   - 显示选项（sendViewOptions / buildViewOptionItems / showOptionsPicker + 标签常量）
 *   - 会话加载 / 分叉（loadHistorySession / forkAtEntryInNewTab / maybeAutoLoadLastSession / showHistoryPicker）
 *   - webview 消息分发（processMessage 的公共部分）
 *
 * 子类只需实现“平台钩子”：消息如何送到 webview、配置/视图选项存储、
 * 对话框 / diff / 文件打开的实现，以及各自独有的消息类型。
 *
 * 本类不引用 `vscode`，便于独立测试/复用。
 */
import * as fs from "fs";
import * as path from "path";
import { SessionRuntime, RuntimeHost, FileChange, ModelInfo, ModelChoice, StatusInfo, } from "./sessionRuntime";
import { PiConfig } from "./sessionRuntime";
import { PiClient } from "./piClient";
import { listSessions } from "./sessionStore";

export abstract class ChatControllerBase implements RuntimeHost {
    // ---- 标签状态 ----
    protected tabs = new Map<string, SessionRuntime>();
    protected activeId: string | undefined;
    protected tabSeq = 0;
    protected autoLoadDone = false;

    // ---- 拾取器状态 ----
    protected pickerResolve: ((v: any | undefined) => void) | null = null;
    protected pickerTimer: ReturnType<typeof setTimeout> | null = null;
    protected pickerRefresher: ((nextThinking: string) => void) | null = null;

    // ---- 备用 pi 进程池（热备，免冷启动）----
    /** 已就绪的备用 pi 进程（不绑定任何 tab）。 */
    protected spare: PiClient | null = null;
    /** 正在后台预热、尚未就绪的备用进程（防止并发 spawn 多个）。 */
    protected preparingSpare: PiClient | null = null;

    // ---- 思考强度标签 ----
    protected static readonly THINKING_LABELS: Record<string, string> = {
        off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大",
    };
    protected thinkingLevelLabel(lv: string): string {
        return ChatControllerBase.THINKING_LABELS[lv] || lv;
    }

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
        });
    }

    /** 构建显示选项浮层条目（toggle / 按钮组模式）。 */
    protected buildViewOptionItems(): Array<{
        label: string; desc: string; check: boolean | null; action: string;
        value?: string; options?: Array<{ value: string; label: string }>;
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

    /** RuntimeHost.claimSpareClient：领取就绪的备用进程；领取后立即后台补新。 */
    public claimSpareClient(): PiClient | undefined {
        const c = this.spare ?? undefined;
        this.spare = null;
        if (c) {
            this.ensureSpare();
        }
        return c;
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

    public broadcastTabList(): void {
        this.postToWebview({
            type: "tabList",
            tabs: Array.from(this.tabs.values()).map((rt) => ({
                id: rt.id,
                title: rt.title,
                streaming: rt.streaming,
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
        const id = `tab-${++this.tabSeq}`;
        const title = `会话 ${this.tabSeq}`;
        const rt = new SessionRuntime(id, title, this);
        this.tabs.set(id, rt);
        this.activeId = id;
        this.broadcastTabList();
        this.postToWebview({ type: "tabActivated", id });
        rt.startClient();
        // 后台预热一个备用进程，供下一个新 tab / 切分支直接领取
        this.ensureSpare();
        return rt;
    }

    public setActive(id: string): void {
        if (!this.tabs.has(id) || this.activeId === id) { return; }
        this.activeId = id;
        this.postToWebview({ type: "tabActivated", id });
        this.broadcastTabList();
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
        this.broadcastTabList();
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

    /** 模型浮层中切换思考强度：发 RPC + 刷新浮层。 */
    protected async handleThinkingToggle(value: any): Promise<void> {
        const rt = this.getActive();
        if (!rt || typeof value !== "string") { return; }
        const ok = await rt.setThinkingLevel(value);
        if (ok && this.pickerRefresher) { this.pickerRefresher(value); }
    }

    public async pickModelInteractive(
        models: ModelInfo[],
        thinkingLevels: string[],
        currentThinking: string,
        currentModelId: string
    ): Promise<ModelChoice | undefined> {
        const items: any[] = models.map((m) => ({
            id: m.id, provider: m.provider, name: m.name, contextWindow: m.contextWindow,
            current: m.id === currentModelId,
        }));
        if (thinkingLevels.length > 0) {
            thinkingLevels.forEach((lv) => {
                items.push({
                    section: "思考强度", behavior: "toggle", action: "thinkingLevel", value: lv,
                    label: this.thinkingLevelLabel(lv), check: lv === currentThinking,
                });
            });
        }
        this.pickerRefresher = (nextThinking: string) => {
            const refreshed = items.map((it) =>
                it.action === "thinkingLevel" ? { ...it, check: it.value === nextThinking } : it
            );
            this.postToWebview({ type: "picker", kind: "model", items: refreshed });
        };
        const choice = await this.showPicker("model", items, undefined);
        this.pickerRefresher = null;
        if (!choice) { return undefined; }
        return { provider: choice.provider || "", modelId: choice.modelId, thinkingLevel: choice.thinkingLevel };
    }

    // ========================================================================
    //  会话加载 / 分叉 / 历史
    // ========================================================================
    public newSession(): void { this.newTab(); }

    public getCurrentSessionPath(): string | undefined {
        return this.getActive()?.currentSessionPath;
    }

    public async loadHistorySession(file: string): Promise<void> {
        // 在活跃 tab 加载；若无 tab 则新建（loadSession 内部会等待 pi 就绪）
        let rt = this.getActive();
        if (!rt) {
            rt = this.newTab();
        }
        this.setActive(rt.id);
        await rt.loadSession(file);
        await this.onFocusChat();
    }

    /**
     * 在新 tab 中打开从某条 user 消息处分叉出的新分支，源 tab 保持不动。
     * 新建一个独立 pi 进程的 tab，先加载源会话文件，再在该 entry 处 fork ——
     * fork 会创建新的分支会话文件并切换到它，源 tab 完全不受影响。
     * 源会话尚未落盘时回退到原地分叉。
     */
    public async forkAtEntryInNewTab(source: SessionRuntime, entryId: string): Promise<void> {
        // 取源会话文件路径。currentSessionPath 只在加载历史 / 分叉成功后赋值，
        // 全新 tab 普通对话后从未同步 —— 直接向源 pi 查询真实 sessionFile，
        // 避免误判“未落盘”而在当前 tab 原地分叉。
        let sourcePath = source.currentSessionPath;
        if (!sourcePath) {
            const state = await source.request({ type: "get_state" });
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
        const sessions = await listSessions(cwd);
        if (sessions.length === 0) { return; }
        const rt = this.getActive();
        if (rt) { await rt.loadSession(sessions[0].file); }
    }

    /** 弹出历史会话拾取器并加载选中项。 */
    public async showHistoryPicker(): Promise<void> {
        const sessions = await listSessions(this.getCwd());
        if (sessions.length === 0) {
            this.onNoSessions();
            return;
        }
        await this.beforeHistoryPicker();
        const current = this.getActive()?.currentSessionPath;
        const choice = await this.showPicker("history", sessions, current);
        if (!choice || typeof choice.file !== "string") { return; }
        await this.loadHistorySession(choice.file);
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
            case "requestViewOptionItems":
                this.showOptionsPicker();
                return;
            case "pickerToggle":
                if (typeof msg.action === "string") {
                    if (msg.kind === "model" && msg.action === "thinkingLevel") {
                        void this.handleThinkingToggle(msg.value);
                    } else {
                        this.doViewOptionToggle(msg.action, typeof msg.value === "string" ? msg.value : undefined);
                    }
                }
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
            case "send":
                target.handleSend(msg.text, msg.images);
                break;
            case "abort":
                target.abortActiveRun();
                break;
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

import {
    ChatControllerBase,
    type TabContainer,
} from "./chatControllerBase";
import type { NameParts } from "./names";
import { readModelsJson, writeModelsJson } from "./modelsConfig";
import { probeProviderModels } from "./probeModels";
import { MessageBuffer } from "./webTransport";
import type { FileChange, PiConfig, TurnEndInfo } from "./runtimeTypes";

/**
 * BrowserChatController —— "在浏览器里对话"这个工作区。
 *
 * 它和侧边栏（ChatViewProvider）、编辑器区工作区（EditorChatPanel）是平级的第三个宿主：
 * 界面是同一份 chat.js，会话编排是同一个 ChatControllerBase，pi 进程各自独立。
 * 唯一的差别是消息通道：VSCode 那两家走网页视图的 postMessage，这家走网页服务
 * （推给页面用推送流，页面发回来用普通请求），由 webChatServer.ts 提供的
 * {@link BrowserChannel} 承担。
 *
 * 需要 VSCode 才能做的事（打开文件、看改动对比、回滚确认、弹提示、写设置）全都
 * 交给 {@link BrowserChatOwner}（由侧边栏那个 ChatViewProvider 实现），也就是
 * 浏览器里点这些按钮，动作发生在 VSCode 窗口里。
 */

/** 页面连上后插件推消息给它的通道（由网页服务实现）。 */
export interface BrowserChannel {
    /** 推一条消息给页面；页面已断开时不会调用。 */
    send(msg: Record<string, unknown>): void;
}

/** 侧边栏与编辑器工作区之外的工作区（现在只有“浏览器里对话”那一份）。 */
export type ExternalChatWorkspace = ChatControllerBase & { discardSpare(): void };

/** 浏览器工作区需要的宿主能力（与 EditorChatPanelOwner 平行的一份）。 */
export interface BrowserChatOwner {
    getConfig(): PiConfig;
    getCwd(): string;
    /** pi 弹窗要用户确认时使用（页面连着时改用浏览器原生对话框，见 confirmDialog）。 */
    confirmDialog(title: string, message: string): Promise<boolean>;
    selectDialog(title: string, options: string[]): Promise<string | undefined>;
    inputDialog(title: string, placeholder: string, prefill: string): Promise<string | undefined>;
    /** 给用户一条普通提示（浏览器工作区没有自己的提示条，交给 VSCode 弹）。 */
    showInfo(text: string): void;
    persistModel(provider: string, modelId: string): void;
    /** 点文件名 / 编辑位置：在 VSCode 里打开。 */
    openFileLocation(p: string, line: number, anchor?: string): Promise<void>;
    openFile(p: string, line?: number, col?: number): Promise<void>;
    openSymbol(name: string): Promise<void>;
    openDiff(change: FileChange): Promise<void>;
    confirmRevert(label: string): Promise<boolean>;
    /** 导出会话时把内容存成文件（VSCode 的另存为对话框）。 */
    saveExportedConversation(tabId: string, html: string, markdown: string, fallbackTitle: string): Promise<void>;
    getSendKey(): string;
    getNewSessionKey(): string;
    getTabSwitchKey(): string;
    getFocusInputKey(): string;
    getRelayPrefix(): string;
    getToolDisplay(): string;
    getFontSize(): string;
    getNotifyBeep(): boolean;
    getTurnTitleWaitSeconds(): number;
    notifyTurnEndFor(info: TurnEndInfo): void;
    mutateViewOption(action: string, value?: string): void;
    getOpenFiles(): Array<{ label: string; path: string }>;
    showPiMissing(piPath: string): void;
    modelsChanged(): void;
    /** 会话显示名：与侧边栏、编辑器工作区共用一个名字池，避免撞名。 */
    allocateChatName(): NameParts;
    releaseChatName(parts: NameParts): void;
    uniqueTabName(base: string, tabId: string): string;
    broadcastChatReferences(): void;
    fetchGlobalChatReference(requester: ChatControllerBase, msg: any): Promise<void>;
    /** 注册 / 注销本工作区：让 # 对话引用与 tab 名去重把浏览器这份也算进去。 */
    registerExternalWorkspace(controller: ExternalChatWorkspace): void;
    unregisterExternalWorkspace(controller: ExternalChatWorkspace): void;
}

export class BrowserChatController extends ChatControllerBase {
    /** 插件界面上显示的工作区名（收尾提醒里会带）。 */
    public static readonly WORKSPACE_ID = "browser";

    private disposed = false;
    private channel: BrowserChannel | undefined;
    /** 页面没连上时的消息缓冲：一连上就按原顺序冲出去。 */
    private readonly outbox = new MessageBuffer();
    /** 正在等浏览器原生对话框回复的请求。 */
    private readonly pendingDialogs = new Map<number, (value: unknown) => void>();
    private dialogSeq = 0;

    constructor(private readonly owner: BrowserChatOwner, workspaceId = BrowserChatController.WORKSPACE_ID) {
        super(workspaceId);
        this.owner.registerExternalWorkspace(this);
    }

    // ========================================================================
    //  通道（页面连上 / 断开）
    // ========================================================================

    /** 页面连上了：之后推的消息直接发过去，先把攒着的补上。 */
    public attachChannel(channel: BrowserChannel): void {
        if (this.disposed) { return; }
        this.channel = channel;
        for (const msg of this.outbox.drain()) {
            channel.send(msg);
        }
    }

    /** 页面断开了（关掉 / 被新页面接管）：停止推送，把在等的对话框按取消处理。 */
    public detachChannel(): void {
        this.channel = undefined;
        this.outbox.clear();
        for (const resolve of this.pendingDialogs.values()) {
            resolve(undefined);
        }
        this.pendingDialogs.clear();
    }

    /** 是否有页面连着（决定弹窗走浏览器还是走 VSCode）。 */
    public hasChannel(): boolean {
        return this.channel !== undefined && !this.disposed;
    }

    protected postToWebview(msg: Record<string, unknown>): void {
        if (this.disposed) { return; }
        if (this.channel) {
            this.channel.send(msg);
            return;
        }
        // 页面还没连上（正在加载）或已关掉：先攒着，重放机制会在页面回来时补齐画面
        this.outbox.push(msg);
    }

    // ========================================================================
    //  生命周期
    // ========================================================================

    public override isDisposed(): boolean { return this.disposed; }

    /** 丢弃预热好的备用进程（models.json 改了之后由宿主统一调用）。 */
    public discardSpare(): void { this.disposeSpare(); }

    /** 关掉这个工作区：杀 pi 进程、释放名字、注销注册。 */
    public dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.detachChannel();
        for (const rt of this.panels.values()) {
            rt.stopClient();
            this.releasePanelName(rt.nameParts);
        }
        this.panels.clear();
        this.tabContainers.clear();
        this.activeTabId = undefined;
        this.disposeSpare();
        this.owner.unregisterExternalWorkspace(this);
    }

    // ========================================================================
    //  配置 / 显示选项（与侧边栏共用同一份设置）
    // ========================================================================

    public getConfig(): PiConfig { return this.owner.getConfig(); }
    public getCwd(): string { return this.owner.getCwd(); }

    protected getAutoLoadLast(): boolean { return false; }  // 浏览器这份总是空白开始，不自动接上次会话
    protected getSendKey(): string { return this.owner.getSendKey(); }
    protected getNewSessionKey(): string { return this.owner.getNewSessionKey(); }
    protected getTabSwitchKey(): string { return this.owner.getTabSwitchKey(); }
    protected getFocusInputKey(): string { return this.owner.getFocusInputKey(); }
    protected getRelayPrefix(): string { return this.owner.getRelayPrefix(); }
    protected getToolDisplay(): string { return this.owner.getToolDisplay(); }
    protected getFontSize(): string { return this.owner.getFontSize(); }
    protected mutateViewOption(action: string, value?: string): void {
        this.owner.mutateViewOption(action, value);
    }

    /** 浏览器工作区不预热备用 pi 进程：省一个常驻进程；新建会话时冷启动即可（约 3 秒）。 */
    protected override ensureSpare(_delayMs = 0): void { /* 不预热 */ }

    // ========================================================================
    //  弹窗：页面连着时在浏览器里问，否则回落到 VSCode 弹窗
    // ========================================================================

    public async confirmDialog(title: string, message: string): Promise<boolean> {
        const answer = await this.askPage("confirm", { title, message });
        if (answer === undefined) { return this.owner.confirmDialog(title, message); }
        return answer === true;
    }

    public async inputDialog(title: string, placeholder: string, prefill: string): Promise<string | undefined> {
        const answer = await this.askPage("prompt", { title, placeholder, prefill });
        if (answer === undefined) { return this.owner.inputDialog(title, placeholder, prefill); }
        if (answer === null) { return undefined; }  // 用户按了取消
        return String(answer);
    }

    /** 选项列表用界面自带的浮层选择器（不是浏览器原生弹窗，样式与模型选择器一致）。 */
    public async selectDialog(title: string, options: string[]): Promise<string | undefined> {
        if (!this.hasChannel()) { return this.owner.selectDialog(title, options); }
        const items = options.map((option, index) => ({ label: option, file: String(index) }));
        const choice = await this.showPicker("browserSelect", items, null, { title });
        const index = Number(choice && typeof choice.file === "string" ? choice.file : NaN);
        return Number.isInteger(index) && index >= 0 && index < options.length ? options[index] : undefined;
    }

    /**
     * 让浏览器页面弹一个原生对话框并等回复。
     * 返回 undefined 表示没等着（页面已断开），调用方改用 VSCode 弹窗兜底。
     */
    private askPage(kind: "confirm" | "prompt", fields: Record<string, string>): Promise<unknown> {
        if (!this.channel) { return Promise.resolve(undefined); }
        const id = ++this.dialogSeq;
        return new Promise<unknown>((resolve) => {
            this.pendingDialogs.set(id, resolve);
            this.postToWebview({ type: "browserDialog", id, kind, ...fields });
        });
    }

    /** 页面回了对话框结果 / 超时：结束对应的等待。 */
    private resolveDialog(id: unknown, value: unknown): void {
        const key = typeof id === "number" ? id : undefined;
        if (key === undefined || !this.pendingDialogs.has(key)) { return; }
        const resolve = this.pendingDialogs.get(key)!;
        this.pendingDialogs.delete(key);
        resolve(value);
    }

    /** 没有页面连着时不弹浮层（浮层在页面上，弹了也没人看得见），直接当取消。 */
    protected override async showPicker(
        kind: string,
        items: any[],
        current?: string | null,
        echo?: Record<string, unknown>,
    ): Promise<any | undefined> {
        if (!this.hasChannel()) { return undefined; }
        return super.showPicker(kind, items, current, echo);
    }

    // ========================================================================
    //  VSCode 侧能力（点了在 VSCode 窗口里发生）
    // ========================================================================

    public persistModel(provider: string, modelId: string): void { this.owner.persistModel(provider, modelId); }
    public openFileLocation(p: string, line: number, anchor?: string): void {
        void this.owner.openFileLocation(p, line, anchor);
    }
    public openDiff(change: FileChange): void { void this.owner.openDiff(change); }
    public async confirmRevert(label: string): Promise<boolean> {
        return this.owner.confirmRevert(label);
    }
    protected notifyBeepEnabled(): boolean { return this.owner.getNotifyBeep(); }
    public override getTurnTitleWaitSeconds(): number { return this.owner.getTurnTitleWaitSeconds(); }
    protected notifyTurnEnd(info: TurnEndInfo): void { this.owner.notifyTurnEndFor(info); }
    protected onPiMissing(piPath: string): void { this.owner.showPiMissing(piPath); }
    protected onNoSessions(): void { this.owner.showInfo("当前工作区没有找到 pi 历史会话。"); }

    protected sendFileList(): void {
        this.postToWebview({ type: "openFiles", files: this.owner.getOpenFiles() });
    }
    protected openFileFromWebview(p: string, line?: number, col?: number): void {
        void this.owner.openFile(p, line, col);
    }

    // ========================================================================
    //  命名 / tab 标题 / # 对话引用（与另外两个工作区共用一套）
    // ========================================================================

    protected allocatePanelName(): NameParts { return this.owner.allocateChatName(); }
    protected releasePanelName(parts: NameParts): void { this.owner.releaseChatName(parts); }
    protected containerDisplayName(c: TabContainer): string {
        return this.owner.uniqueTabName(this.baseContainerDisplayName(c), c.id);
    }
    protected onChatStructureChanged(): void { this.owner.broadcastChatReferences(); }

    /** # 引用由侧边栏那个共享宿主在全部工作区里解析（含 VSCode 里的会话）。 */
    public override processMessage(msg: any): void {
        if (!msg || typeof msg.type !== "string") { return; }
        if (msg.type === "fetchChat") {
            void this.owner.fetchGlobalChatReference(this, msg);
            return;
        }
        super.processMessage(msg);
    }

    /** 不支持活体移交（会话搬到 VSCode 面板那套），界面右上角也就不显示那个菜单项。 */
    protected override transferDestination(): string | undefined { return undefined; }

    /** 页面加载完成：刷新 # 引用，并把已有的对话重画一遍（页面刷新不丢内容）。 */
    protected override onWebviewReady(): void {
        this.owner.broadcastChatReferences();
        for (const rt of this.panels.values()) {
            // 刚建的空会话不用重画：newTab 已经把它需要的东西发过去了
            if (rt.isConversationEmpty()) { continue; }
            void rt.replayHistory({ note: "页面已重新连接（{count} 条消息，pi 进程与上下文原样保留）。" });
        }
    }

    /**
     * 网页端顶部那颗“⋯”按钮的菜单：分支 / 模型 / 历史会话 / 导出 / 设置。
     * 用界面自带的浮层选择器（与模型选择器同一套，带筛选与键盘操作），
     * 选中后在本工作区内直接执行对应动作。
     */
    private async openBrowserMenu(): Promise<void> {
        const items = [
            { label: "⑂ 分支与分屏…", file: "tree" },
            { label: "🤖 切换模型…", file: "model" },
            { label: "🕘 历史会话…", file: "history" },
            { label: "📤 导出当前会话…", file: "export" },
            { label: "⚙ 设置…", file: "settings" },
        ];
        const choice = await this.showPicker("browserMenu", items, null, { title: "更多操作" });
        const action = choice && typeof choice.file === "string" ? choice.file : "";
        switch (action) {
            case "tree": {
                const rt = this.getActive();
                if (rt) { void rt.showTree(); }
                return;
            }
            case "model": {
                const rt = this.getActive();
                if (rt) { void rt.pickModel(); }
                return;
            }
            case "history":
                void this.showHistoryPicker();
                return;
            case "export":
                this.exportActiveConversation();
                return;
            case "settings":
                this.postToWebview({ type: "openSettings" });
                return;
        }
    }

    /** 让页面把当前焦点会话导出成 HTML / Markdown（内容存盘在 VSCode 里选位置）。 */
    private exportActiveConversation(): void {
        const rt = this.getActive();
        if (!rt) {
            this.owner.showInfo("当前没有可导出的会话。");
            return;
        }
        this.postToWebview({
            type: "exportConversationRequest",
            tabId: rt.id,
            requestId: `browser-export-${rt.id}`,
        });
    }

    // ========================================================================
    //  浏览器这份工作区独有的消息
    // ========================================================================
    protected handlePlatformMessage(msg: any): boolean {
        switch (msg.type) {
            case "hostFocus":
                return true;  // 浏览器页面获得焦点：这里没有"最后活动的工作区"概念，忽略
            case "browserDialogResult":
                this.resolveDialog(msg.id, msg.value);
                return true;
            case "openHistory":
                void this.showHistoryPicker();
                return true;
            case "openBrowserMenu":
                void this.openBrowserMenu();
                return true;
            case "openSettingsPanel":
                this.postToWebview({ type: "openSettings", tab: typeof msg.tab === "string" ? msg.tab : undefined });
                return true;
            case "exportConversation":
                this.exportActiveConversation();
                return true;
            case "exportConversationResult":
                if (typeof msg.tabId === "string" && typeof msg.html === "string") {
                    void this.owner.saveExportedConversation(
                        msg.tabId,
                        msg.html,
                        typeof msg.markdown === "string" ? msg.markdown : "",
                        this.panels.get(msg.tabId)?.title || "pi-会话",
                    );
                }
                return true;
            case "openSymbol":
                if (typeof msg.name === "string") { void this.owner.openSymbol(msg.name); }
                return true;
            case "app:requestSettings": {
                const r = readModelsJson();
                this.postToWebview({ type: "app:settings", content: r.content, existed: r.existed, path: r.path });
                return true;
            }
            case "app:saveSettings": {
                if (typeof msg.content === "string") {
                    const result = writeModelsJson(msg.content);
                    if (result.ok) {
                        this.postToWebview({ type: "app:settingsResult", ok: true });
                        this.owner.showInfo("已保存 models.json");
                        this.owner.modelsChanged();
                    } else {
                        this.postToWebview({ type: "app:settingsResult", ok: false, error: result.error });
                    }
                }
                return true;
            }
            case "app:probeModels":
                void probeProviderModels(
                    typeof msg.baseUrl === "string" ? msg.baseUrl : "",
                    typeof msg.apiKey === "string" ? msg.apiKey : "",
                    typeof msg.api === "string" ? msg.api : undefined,
                ).then((result) => this.postToWebview({ type: "app:probeModelsResult", ...result }));
                return true;
        }
        return false;
    }
}

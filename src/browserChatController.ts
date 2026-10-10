import {
    ChatControllerBase,
    type TabContainer,
} from "./chatControllerBase";
import type { NameParts } from "./names";
import { readModelsJson, writeModelsJson } from "./modelsConfig";
import { probeProviderModels } from "./probeModels";
import { captureDesktopScreenshot } from "./desktopScreenshot";
import { MessageBuffer } from "./webTransport";
import type { FileChange, MessageSink, PiConfig, TurnEndInfo } from "./runtimeTypes";

/**
 * BrowserChatController —— "在浏览器里对话"这个工作区。
 *
 * 它和侧边栏（ChatViewProvider）、编辑器区工作区（EditorChatPanel）是平级的第三个宿主：
 * 界面是同一份 chat.js，会话编排是同一个 ChatControllerBase，pi 进程各自独立。
 * 唯一的差别是消息通道：VSCode 那两家走网页视图的 postMessage，这家走网页服务
 * （推给页面用推送流，页面发回来用普通请求），由 webChatServer.ts 提供的
 * {@link PageChannelHub} 承担。
 *
 * 需要 VSCode 才能做的事（打开文件、看改动对比、回滚确认、弹提示、写设置）全都
 * 交给 {@link BrowserChatOwner}（由侧边栏那个 ChatViewProvider 实现），也就是
 * 浏览器里点这些按钮，动作发生在 VSCode 窗口里。
 */

/** 页面连接的出口（由网页服务实现）：插件推给页面的消息都从这里出去。 */
export interface PageChannelHub {
    /** 把一条消息发给所有连着的页面（消息会被记上序号）。一个页面都没连着时返回 false（消息由工作区自己攒着）。 */
    broadcast(msg: Record<string, unknown>): boolean;
    /** 只发给某一个页面（刚连上 / 重连的页面要整屏重画时用）。那个页面已经不在了返回 false。 */
    sendTo(pageId: string, msg: Record<string, unknown>): boolean;
    /** 有没有这个页面连着（整屏重画送不出去就先记着，等它连上再画）。 */
    hasPage(pageId: string): boolean;
    /**
     * 页面重连后补发它错过的消息（页面随 browserResync 报上自己处理到第几条）。
     * 返回 false 表示补不了（页面不在了，或缺得太多暂存里没有）——调用方退回整屏重画。
     */
    catchUp(pageId: string, lastSeq: number): boolean;
    /** 当前的消息序号（整屏重画完让页面对齐到这个位置）。 */
    currentSeq(): number;
    /** 最近有人在里面动过的那个页面标识（确认框、选项浮层发给它）；一个都没连着时 undefined。 */
    recentPageId(): string | undefined;
    /** 有没有页面连着。 */
    anyPage(): boolean;
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
    /** 页面连接的出口（网页服务）。插件推的消息都从这里出去。 */
    private hub: PageChannelHub | undefined;
    /** 一个页面都没连着时的消息缓冲：页面一连上就按原顺序冲出去。 */
    private readonly outbox = new MessageBuffer();
    /**
     * 等着整屏重画的页面（页面标识 → 重画后给的那行提示）。
     * 页面的 ready / 重连请求可能比它的推送连接先到，那时重画送不出去，先记下，等它一连上就画。
     */
    private readonly pendingResyncPages = new Map<string, string>();
    /** 正在整屏重画的页面：重画没画完。这种页面中途断了的话，得等它回来重新整画一遍（见 onPageDisconnected）。 */
    private readonly resyncingPages = new Set<string>();
    /** 正在等浏览器原生对话框回复的请求（记着是问哪个页面的，那个页面走了就改成取消）。 */
    private readonly pendingDialogs = new Map<number, { resolve: (value: unknown) => void; pageId: string }>();
    private dialogSeq = 0;
    /** 正在处理哪一个页面发来的消息（把重画只发给它时用）。 */
    private messageFromPage = "";

    constructor(
        private readonly owner: BrowserChatOwner,
        workspaceId = BrowserChatController.WORKSPACE_ID,
    ) {
        super(workspaceId);
        this.owner.registerExternalWorkspace(this);
    }

    // ========================================================================
    //  页面（一个页面一条推送连接；可以同时有多个页面）
    // ========================================================================

    /** 接上页面连接的出口（网页服务启动、或重启后重新接）。 */
    public setHub(hub: PageChannelHub | undefined): void {
        this.hub = hub;
        if (!hub) {
            // 服务停了：在等的确认框不能再干等（回落到 VSCode 里问），攒着的消息也没用了
            this.cancelPendingDialogs();
            this.outbox.clear();
            this.pendingResyncPages.clear();
            this.resyncingPages.clear();
        }
    }

    /** 一个页面刚连上：把等着的整屏重画补上（如果它早先要求过），再把攒着的消息补给它
     *  （其他页面早就拿到过了，不重复发）。 */
    public onPageConnected(pageId: string): void {
        if (this.disposed) { return; }
        const note = this.pendingResyncPages.get(pageId);
        if (note !== undefined) {
            this.pendingResyncPages.delete(pageId);
            void this.resyncPage(pageId, note);
        }
        const hub = this.hub;
        if (!hub || this.outbox.size === 0) { return; }
        for (const msg of this.outbox.drain()) {
            if (!hub.sendTo(pageId, msg)) { return; }
        }
    }

    /** 一个页面的连接没了（关掉 / 死连接被掐掉）：它那个没人答的确认框改成取消。 */
    public onPageDisconnected(pageId: string): void {
        this.cancelPendingDialogs(pageId);
        // 整屏重画画到一半页面走了：重画的内容不进补发暂存，它回来对账时会“看似不缺”，
        // 内容却缺一截。记下来，它一连上就重新整画一遍。
        if (this.resyncingPages.delete(pageId)) {
            this.pendingResyncPages.set(pageId, "");
        }
    }

    /**
     * 把在等的确认框按取消处理（pi 那边会改到 VSCode 里问，不会干等）。
     * @param pageId 只取消问这个页面的；缺省取消全部（服务停了那种情况）
     */
    private cancelPendingDialogs(pageId?: string): void {
        for (const [id, pending] of Array.from(this.pendingDialogs.entries())) {
            if (pageId !== undefined && pending.pageId !== pageId) { continue; }
            this.pendingDialogs.delete(id);
            pending.resolve(undefined);
        }
    }

    /** 是否有页面连着（决定弹窗走浏览器还是走 VSCode）。 */
    public hasChannel(): boolean {
        return !this.disposed && this.hub !== undefined && this.hub.anyPage();
    }

    protected postToWebview(msg: Record<string, unknown>): void {
        if (this.disposed) { return; }
        if (this.hub?.broadcast(msg)) { return; }
        // 一个页面都没连着：先攒着。页面回来后除了补发这些，还会整屏重画（见 resyncPage）
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
        this.setHub(undefined);
        this.pendingResyncPages.clear();
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

    /** 浏览器那份也开“派子会话”：子会话的 tab 开在浏览器页面的标签栏里，
     *  编排、自动交回、名录都与侧边栏同一套。总开关是设置里的 piChat.taba.enabled
     *  （在 ChatViewProvider.getConfig 里判断，三份会话共用）。 */
    public getConfig(): PiConfig { return this.owner.getConfig(); }
    public getCwd(): string { return this.owner.getCwd(); }

    /** 网页端整屏重画 / 加载会话只发最近一段历史：长会话全量发下来太慢，
     *  更早的由页面顶部的「加载更早的消息」按钮再取（见 SessionRuntime）。 */
    public override wantsTrimmedHistory(): boolean { return true; }

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
     * 返回 undefined 表示没等着（一个页面都没连着，或问的那个页面走了），
     * 调用方改用 VSCode 弹窗兜底。
     * 只问"人最近在里面动过"的那个页面：手机和电脑同时开着时，不该把确认框弹到没人看的那个上。
     */
    private askPage(kind: "confirm" | "prompt", fields: Record<string, string>): Promise<unknown> {
        const pageId = this.hub?.recentPageId();
        if (!pageId) { return Promise.resolve(undefined); }
        const id = ++this.dialogSeq;
        return new Promise<unknown>((resolve) => {
            this.pendingDialogs.set(id, { resolve, pageId });
            this.postToWebview({ type: "browserDialog", id, kind, ...fields });
        });
    }

    /** 页面回了对话框结果 / 超时：结束对应的等待。 */
    private resolveDialog(id: unknown, value: unknown): void {
        const key = typeof id === "number" ? id : undefined;
        if (key === undefined || !this.pendingDialogs.has(key)) { return; }
        const pending = this.pendingDialogs.get(key)!;
        this.pendingDialogs.delete(key);
        pending.resolve(value);
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

    /**
     * 收到页面发来的消息。
     * # 引用由侧边栏那个共享宿主在全部工作区里解析（含 VSCode 里的会话）。
     * @param pageId 是哪个页面发来的（网页服务转发时带上）：重画只发给它，不打扰别的页面
     */
    public override processMessage(msg: any, pageId?: string): void {
        if (!msg || typeof msg.type !== "string") { return; }
        const previous = this.messageFromPage;
        this.messageFromPage = typeof pageId === "string" ? pageId : "";
        try {
            if (msg.type === "fetchChat") {
                void this.owner.fetchGlobalChatReference(this, msg);
                return;
            }
            super.processMessage(msg);
        } finally {
            this.messageFromPage = previous;
        }
    }

    /** 不支持活体移交（会话搬到 VSCode 面板那套），界面右上角也就不显示那个菜单项。 */
    protected override transferDestination(): string | undefined { return undefined; }

    /** 页面加载完成：刷新 # 引用，并把已有的对话重画一遍给这个页面（页面刷新不丢内容）。 */
    protected override onWebviewReady(): void {
        this.owner.broadcastChatReferences();
        void this.resyncPage(this.messageFromPage, "页面已重新连接（{count} 条消息，pi 进程与上下文原样保留）。");
    }

    /**
     * 把已有的对话整屏重画一遍：页面刚加载、或重连后补发补不上（缺得太多）时用它。
     *
     * 页面刚加载的那种情况（ready 里的）：对话重画；重连补不上时（browserResync 里 note 为空串）：
     * 补发失败说明漏得太多，重画是补回来的唯一办法。
     *
     * 只画给发消息来的那个页面——手机回到前台重连时，电脑那边开着的页面不该跟着白闪一下，
     * 更不该把正在生成的半句话清掉。
     * @param pageId 要重画给哪个页面；空串表示不知道是哪个（理论上不会），退回广播。
     * @param note 重画后给这个页面的一行提示；空串表示不给（重连时不给，不然一回到前台就多一行）。
     * @returns 重画（含最后的对齐）完成；页面的重画请求比它的推送连接先到时，等连上才真的画，
     *          那时这个 Promise 早就结束了。
     */
    private resyncPage(pageId: string, note: string): Promise<void> {
        const hub = this.hub;
        if (pageId && hub && !hub.hasPage(pageId)) {
            // 页面的重画请求到得比它的推送连接还早（刚刷新的那一瞬间）：现在送也是白送，
            // 先记下来，它一连上就画（见 onPageConnected）。
            this.pendingResyncPages.set(pageId, note);
            return Promise.resolve();
        }
        // 拿不到是哪个页面（理论上不会）就退回广播：宁可多画一次，也不能让页面缺内容
        const sink: MessageSink | undefined = pageId && hub
            ? ((msg) => { hub.sendTo(pageId, msg); })
            : undefined;
        const replays: Array<Promise<void>> = [];
        if (pageId) { this.resyncingPages.add(pageId); }
        for (const rt of this.panels.values()) {
            // 刚建的空会话不用重画：newTab 已经把它需要的东西发过去了
            if (rt.isConversationEmpty()) { continue; }
            replays.push(rt.replayHistory({ note, sink }));
        }
        return Promise.all(replays).then(() => {
            // 重画的消息不带序号（它们只发给这一个页面）。这里把页面对齐到当前序号：
            // 重画的内容已经包含到这里为止的一切，下次重连它报上来的数才是准的。
            if (pageId && hub) { hub.sendTo(pageId, { type: "syncPoint", seq: hub.currentSeq() }); }
        }).finally(() => {
            if (pageId) { this.resyncingPages.delete(pageId); }
        });
    }

    /**
     * 网页端顶部那颗“⋯”按钮的菜单：历史会话 / 设置。
     * 用界面自带的浮层选择器（带键盘操作），
     * 只有两项、不用筛选，所以不给筛选框。
     * 选中后在本工作区内直接执行对应动作。
     */
    private async openBrowserMenu(): Promise<void> {
        const items = [
            { label: "🕘 历史会话…", file: "history" },
            { label: "⚙ 设置…", file: "settings" },
        ];
        const choice = await this.showPicker("browserMenu", items, null, { title: "更多操作", searchable: false });
        const action = choice && typeof choice.file === "string" ? choice.file : "";
        switch (action) {
            case "history":
                void this.showHistoryPicker();
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

    /**
     * 网页端标签栏那颗“桌面截图”按钮：截一张这台电脑的桌面，只发回请求它的那个页面
     * （别的页面不跟着弹图）。截屏要一两秒，异步做；截完时页面已经断开的话就白截
     * （sendTo 送不出去，直接丢）。成功发 desktopScreenshot（图片 base64），
     * 失败发 desktopScreenshotResult（错误文本，页面上弹一句）。
     */
    private sendDesktopScreenshot(): void {
        const pageId = this.messageFromPage;
        const hub = this.hub;
        if (!pageId || !hub) { return; }
        void captureDesktopScreenshot().then((result) => {
            if (result.ok) {
                hub.sendTo(pageId, { type: "desktopScreenshot", data: result.data, mimeType: result.mimeType });
            } else {
                hub.sendTo(pageId, { type: "desktopScreenshotResult", ok: false, error: result.error });
            }
        });
    }

    // ========================================================================
    //  浏览器这份工作区独有的消息
    // ========================================================================
    protected handlePlatformMessage(msg: any): boolean {
        switch (msg.type) {
            case "browserResync": {
                // 页面的推送连接重连上了（手机回到前台、网络断开又通）：它报上自己处理到第几条，
                // 把断线期间漏掉的消息补发过去——一条不缺就什么都不用动，页面保持原样；
                // 缺的都在补发暂存里就只补缺的那几条，页面上消息接着往下长。
                // 补不上（没报序号——旧版页面脚本，或缺得太多）才整屏重画兜底。
                // 序号是 0 也照报：那说明从没广播过东西，对账本身就是“一条不缺”。
                const pageId = this.messageFromPage;
                const hub = this.hub;
                const lastSeq = typeof msg.lastSeq === "number" && Number.isFinite(msg.lastSeq)
                    ? msg.lastSeq : -1;
                if (pageId && hub && lastSeq >= 0 && hub.catchUp(pageId, lastSeq)) {
                    return true;
                }
                void this.resyncPage(pageId, "");
                return true;
            }
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
            case "requestDesktopScreenshot":
                this.sendDesktopScreenshot();
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

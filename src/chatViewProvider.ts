import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getChatHtml } from "./chatHtml";
import { writeModelsJson, readModelsJson } from "./modelsConfig";
import { probeProviderModels } from "./probeModels";
import {
    SessionRuntime,
    type MessageSink,
} from "./sessionRuntime";
import { ChatControllerBase } from "./chatControllerBase";
import { captureDesktopScreenshot } from "./desktopScreenshot";
import { ChatBroadcaster } from "./chatBroadcaster";
import { MessageBuffer } from "./webTransport";
import { pickOverlayClient } from "./overlayTarget";
import type { WebServerHost } from "./webChatServer";
import { uniqueNameParts, composeName, type NameParts } from "./names";
import { getTabaAssets } from "./tabaAssets";
import { TurnNotifier } from "./turnNotifier";
import { DEFAULT_TURN_TITLE_WAIT_MS, type TurnEndInfo } from "./runtimeTypes";

/**
 * VSCode 插件的聊天视图提供者。
 *
 * 平台相关部分（webview 装载、globalState 存储读写、vscode API 弹窗 / diff /
 * 文件打开、选中文本发送、符号跳转、models.json 编辑）在此实现；其余会话编排
 * 逻辑（标签管理、拾取器、模型选择、消息分发等）继承自 {@link ChatControllerBase}。
 *
 * 这里是**唯一一份会话工作区**：侧边栏的 webview 与网页服务送出去的浏览器页面
 * （手机 / 电脑，可以同时开着好几个）都接在这一份会话上，看到的标签、消息完全同步。
 * 浏览器页面的连接由网页服务登记进 {@link ChatBroadcaster}，推给页面的消息走推送流，
 * 侧边栏自己走 postMessage；服务停了页面没了，会话本体不受影响。
 */
export class ChatViewProvider extends ChatControllerBase implements vscode.WebviewViewProvider, WebServerHost {
    public static readonly viewType = "piChat.chatView";

    private view?: vscode.WebviewView;
    /** webview 的 JS 是否已加载完成并建立消息监听（收到 ready 后为 true）。 */
    private webviewReady = false;

    // ---- 浏览器页面（接在本工作区上的“额外的屏”，可以有多个）----
    /** 侧边栏这个来源在消息分发里的固定页面标识。 */
    private static readonly SIDEBAR_PAGE_ID = "sidebar";
    /** 页面连接登记簿 + 推送序号：侧边栏与所有浏览器页面共用同一份会话的出口。 */
    private readonly broadcaster = new ChatBroadcaster();
    /** 网页服务在跑时才往页面推（服务没跑时永远不会有页面，也不必攒）。 */
    private pageDeliveryOn = false;
    /** 一个页面都没连着时的消息缓冲：页面一连上就按原顺序冲出去。 */
    private readonly outbox = new MessageBuffer();
    /** 等着整屏重画的页面（页面标识 → 重画后给的那行提示）。
     *  页面的 ready / 重连请求可能比它的推送连接先到，那时重画送不出去，先记下，等它一连上就画。 */
    private readonly pendingResyncPages = new Map<string, string>();
    /** 正在整屏重画的页面：重画没画完页面就断了的话，得等它回来重新整画一遍。 */
    private readonly resyncingPages = new Set<string>();
    /** 正在等浏览器对话框回复的请求（记着是问哪个页面的，那个页面走了就改成取消）。 */
    private readonly pendingDialogs = new Map<number, { resolve: (value: unknown) => void; pageId: string }>();
    private dialogSeq = 0;
    /** 正在处理哪一个来源发来的消息（侧边栏固定标识；页面是它自己的标识）。 */
    private currentPageId = ChatViewProvider.SIDEBAR_PAGE_ID;
    /** 人最近在侧边栏里动过的时刻：确认框弹到侧边栏还是弹到某个页面，靠两边的时间比。 */
    private sidebarActiveAt = 0;

    // LSP 符号树缓存：已打开文档 → {version, DocumentSymbol[]}
    private symbolTreeCache = new Map<string, { version: number; symbols: vscode.DocumentSymbol[] }>();
    private symbolSetTimer?: ReturnType<typeof setTimeout>;
    private workspaceSubs: vscode.Disposable[] = [];
    private static readonly KEY_AUTO_LOAD_LAST = "piChat.autoLoadLastSession";
    private static readonly KEY_SEND_KEY = "piChat.sendKey";
    private static readonly KEY_NEW_SESSION_KEY = "piChat.newSessionKey";
    private static readonly KEY_TAB_SWITCH_KEY = "piChat.tabSwitchKey";
    private static readonly KEY_FOCUS_INPUT_KEY = "piChat.focusInputKey";
    private static readonly KEY_FONT_SIZE = "piChat.fontSize";
    private static readonly KEY_NOTIFY_BEEP = "piChat.notifyBeep";
    private static readonly KEY_THEME = "piChat.themeMode";
    private static readonly KEY_TURN_TITLE_WAIT = "piChat.turnTitleWaitSeconds";
    /** 收尾提醒等 pi 会话标题的可选秒数（显示选项里的按钮组）。 */
    private static readonly TURN_TITLE_WAIT_CHOICES = [0, 1, 3, 5, 10];
    private static readonly SEND_KEYS = ["enter", "shift+enter", "alt+enter", "ctrl+enter"] as const;
    private static readonly NEW_SESSION_KEYS = ["ctrl+alt+n", "ctrl+shift+n", "ctrl+t", "alt+n"] as const;
    private static readonly TAB_SWITCH_KEYS = ["ctrl+alt+arrows", "ctrl+alt+pgupdown", "alt+brackets", "ctrl+alt+brackets"] as const;
    private static readonly FOCUS_INPUT_KEYS = ["ctrlAltI", "ctrlShiftI", "altI", "ctrlAltSpace"] as const;

    /** 会话显示名用的名字池：panel 关闭后会释放对应名字。 */
    private readonly usedChatNames = new Set<string>();

    /** @param toastAppId 插件登记的 Windows 通知应用标识（后台登记中，是个承诺）；缺省用系统自带的回落标识。 */
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly toastAppId?: string | Promise<string>,
    ) {
        super("sidebar");
        this.syncFocusInputKeyContext();
        // Windows 系统通知：窗口切到后台或侧边栏被切走时，立刻把攒着的一批发出去，
        // 免得用户回到桌面前还多等一会儿。（窗口在前台时走正常合并窗口）
        context.subscriptions.push(
            vscode.window.onDidChangeWindowState((e) => { if (!e.focused) { this.turnNotifier?.hide(); } }),
        );
        // 插件卸载 / 窗口重载时的收摊：所有 pi 进程、通知中心。
        // 注意侧边栏 webview 自己 dispose（视图重建等）不走这里：网页页面可能还连着，
        // 会话要继续活着，webview 回来时整屏重画一遍就好。
        context.subscriptions.push({ dispose: () => {
            this.disposeAllConversations();
            this.turnNotifierInstance?.dispose();
            this.turnNotifierInstance = undefined;
        }});
    }

    /** 停掉本工作区的所有 pi 进程（插件卸载 / 窗口重载时；页面与 webview 的生死与此无关）。 */
    private disposeAllConversations(): void {
        for (const rt of this.panels.values()) {
            rt.stopClient();
            this.releasePanelName(rt.nameParts);
        }
        this.panels.clear();
        this.tabContainers.clear();
        this.activeTabId = undefined;
        this.disposeSpare();
    }

    // ---- 会话收尾的系统通知（Windows toast）----
    /** 通知中心：侧边栏与所有编辑器工作区共用一个（插件激活时建好）。 */
    private turnNotifierInstance?: TurnNotifier;
    private get turnNotifier(): TurnNotifier {
        if (!this.turnNotifierInstance) {
            this.turnNotifierInstance = new TurnNotifier({ appUserModelId: this.toastAppId });
        }
        return this.turnNotifierInstance;
    }

    protected override notifyTurnEnd(info: TurnEndInfo): void {
        this.turnNotifier.handleTurnEnd(info);
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };
        webviewView.webview.html = getChatHtml(webviewView.webview, this.context.extensionUri, {
            withBridge: true,
            themeMode: this.getThemeMode(),
        });

        webviewView.webview.onDidReceiveMessage((msg) => {
            this.sidebarActiveAt = Date.now();
            this.processMessage(msg, ChatViewProvider.SIDEBAR_PAGE_ID);
        });

        // 工作区文件变化：失效/刷新符号树缓存
        if (this.workspaceSubs.length === 0) {
            this.workspaceSubs.push(
                vscode.workspace.onDidOpenTextDocument(() => this.schedulePushSymbolSet()),
                vscode.workspace.onDidCloseTextDocument((d) => {
                    this.symbolTreeCache.delete(d.uri.fsPath);
                    this.schedulePushSymbolSet();
                }),
                vscode.workspace.onDidSaveTextDocument((d) => {
                    this.symbolTreeCache.delete(d.uri.fsPath);
                    this.schedulePushSymbolSet();
                }),
            );
        }

        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) { this.turnNotifier?.hide(); }
        });

        webviewView.onDidDispose(() => {
            // 只标记 webview 没了：会话（pi 进程）不动——浏览器页面可能还连着接着用，
            // webview 下次就绪时整屏重画一遍就能接上。插件卸载 / 窗口重载的收摊
            // 在构造函数里登记的 dispose 里做。
            this.view = undefined;
            this.webviewReady = false;
        });
    }

    /** 全局引用调度：# 选择项携带的 ID 已带工作区前缀，故不会碰撞。 */
    public override processMessage(msg: any, pageId?: string): void {
        if (!msg || typeof msg.type !== "string") { return; }
        const previous = this.currentPageId;
        this.currentPageId = typeof pageId === "string" && pageId ? pageId : ChatViewProvider.SIDEBAR_PAGE_ID;
        try {
            super.processMessage(msg);
        } finally {
            this.currentPageId = previous;
        }
    }

    // ---- transport ----
    /** 把一条消息送到所有界面：侧边栏 webview + 所有连着的浏览器页面。 */
    protected postToWebview(msg: Record<string, unknown>): void {
        // 浅拷贝给侧边栏：下面广播会给消息记上序号（改动同一个对象），
        // postMessage 若是迟到才序列化，侧边栏那份不该带上页面的序号。
        this.postToSidebarOnly({ ...msg });
        this.postToPagesOnly(msg);
    }

    /** 只发给侧边栏 webview（webview 不在就丢掉；它回来时整屏重画补上）。 */
    private postToSidebarOnly(msg: Record<string, unknown>): void {
        if (this.view) { void this.view.webview.postMessage(msg); }
    }

    /** 只发给浏览器页面（一个都没连着时先攒着，等第一条连接进来补发）。 */
    private postToPagesOnly(msg: Record<string, unknown>): void {
        if (!this.pageDeliveryOn) { return; }
        if (this.broadcaster.broadcast(msg)) { return; }
        this.outbox.push(msg);
    }

    /**
     * 浮层（历史会话列表、模型选择、确认框这类“当时的一次性界面”）该发给谁：
     * 人最近在动的那一个界面（侧边栏也算一个）。“最近”只看人做的动作，报活不算。
     */
    protected override pickOverlayTarget(): string {
        return pickOverlayClient(
            ChatViewProvider.SIDEBAR_PAGE_ID,
            this.sidebarActiveAt,
            !!this.view,
            this.broadcaster.recentActionPage(),
            this.broadcaster.recentPage()?.id,
        );
    }

    /** 浮层消息的出口：只发给挑好的那一个界面，别的界面收不到。 */
    protected override sendOverlayTo(target: string, msg: Record<string, unknown>): boolean {
        return this.sendToOneClient(target, msg);
    }

    /** 只发给某一个界面（侧边栏或某个页面）；那个界面不在就返回 false。 */
    private sendToOneClient(target: string, msg: Record<string, unknown>): boolean {
        if (target === ChatViewProvider.SIDEBAR_PAGE_ID) {
            if (!this.view) { return false; }
            this.postToSidebarOnly(msg);
            return true;
        }
        if (!target) { return false; }
        return this.broadcaster.sendTo(target, msg);
    }

    /**
     * 浮层（拾取器）只发给挑好的那一个界面：在哪个屏上点开就弹在哪个屏，别的屏不受影响。
     * 挑中的是侧边栏时，等它的 JS 就绪再推（否则消息会被静默丢弃，表现为点击无反应）；
     * 挑不出界面（侧边栏没开、也没有页面）直接按取消。
     */
    protected override async showPicker(kind: string, items: any[], current?: string | null, echo?: Record<string, unknown>): Promise<any | undefined> {
        const target = this.pickOverlayTarget();
        if (!target) { return Promise.resolve(undefined); }
        if (target === ChatViewProvider.SIDEBAR_PAGE_ID) {
            await this.waitWebviewReady();
        }
        return this.openPicker(kind, { items, current: current ?? null, ...(echo || {}) }, target);
    }

    public allocateChatName(): NameParts {
        const parts = uniqueNameParts(this.usedChatNames);
        this.usedChatNames.add(composeName(parts));
        return parts;
    }

    public releaseChatName(parts: NameParts): void {
        this.usedChatNames.delete(composeName(parts));
    }

    /** # 对话引用目录刷新：只有这一份会话工作区（侧边栏 + 接在它上面的网页页面）。 */
    public broadcastChatReferences(): void {
        this.updateChatReferences(this.getChatReferenceItems(this.getActive()?.id));
    }

    protected override allocatePanelName(): NameParts { return this.allocateChatName(); }
    protected override releasePanelName(parts: NameParts): void { this.releaseChatName(parts); }
    protected override onChatStructureChanged(): void { this.broadcastChatReferences(); }

    // ---- RuntimeHost：配置 / cwd ----
    public getConfig() {
        const cfg = vscode.workspace.getConfiguration("piChat");
        // 派子会话的总开关：侧边栏（含接在它上面的网页页面）、编辑器区都按这个来（关掉后要新建会话才生效）
        const taba = cfg.get<boolean>("taba.enabled", true) ? getTabaAssets() : undefined;
        return {
            piPath: cfg.get<string>("piPath", "pi"),
            provider: cfg.get<string>("provider", ""),
            model: cfg.get<string>("model", ""),
            extraArgs: cfg.get<string[]>("extraArgs", []),
            trustProject: cfg.get<boolean>("trustProject", true),
            tabaExtension: taba?.ok ? taba.extensionPath : "",
            tabaDir: taba?.ok ? taba.resourceDir : "",
        };
    }

    public getCwd(): string {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders[0].uri.fsPath;
        }
        return process.cwd();
    }

    // ---- RuntimeHost：pi 校验（vscode 追加错误提示 + 打开设置）----
    protected piMissingMessage(piPath: string): string {
        return `未找到 pi 可执行文件（当前配置："${piPath}"）。请确认已安装 pi 并加入系统 PATH，或在设置中指定 piChat.piPath 为完整路径。`;
    }

    protected onPiMissing(piPath: string): void {
        vscode.window
            .showErrorMessage(this.piMissingMessage(piPath), "打开设置")
            .then((choice) => {
                if (choice === "打开设置") {
                    vscode.commands.executeCommand("workbench.action.openSettings", "piChat.piPath");
                }
            });
    }

    // ---- RuntimeHost：UI 弹窗 / diff / 文件跳转 / 持久化 ----
    // 三个弹窗入口都带路由：人最近在浏览器页面里动过（比如手机上发的消息在等确认）
    // 就弹到页面上（页面用原生对话框答）；否则用 VSCode 自己的弹窗。
    public async confirmDialog(title: string, message: string): Promise<boolean> {
        const answer = await this.askPage("confirm", { title, message });
        if (answer === undefined) {
            const choice = await vscode.window
                .showInformationMessage(`${title}\n${message}`, { modal: true }, "是", "否");
            return choice === "是";
        }
        return answer === true;
    }

    public async selectDialog(title: string, options: string[]): Promise<string | undefined> {
        if (!this.recentPageIdForDialogs()) {
            const v = await vscode.window.showQuickPick(options, { title });
            return v ?? undefined;
        }
        // 选项列表用界面自带的浮层选择器（样式与模型选择器一致）；页面不在时 showPicker 自己会取消
        const items = options.map((option, index) => ({ label: option, file: String(index) }));
        const choice = await this.showPicker("browserSelect", items, null, { title });
        const index = Number(choice && typeof choice.file === "string" ? choice.file : NaN);
        return Number.isInteger(index) && index >= 0 && index < options.length ? options[index] : undefined;
    }

    public async inputDialog(title: string, placeholder: string, prefill: string): Promise<string | undefined> {
        const answer = await this.askPage("prompt", { title, placeholder, prefill });
        if (answer === undefined) {
            const v = await vscode.window.showInputBox({ title, placeHolder: placeholder, value: prefill });
            return v ?? undefined;
        }
        if (answer === null) { return undefined; }  // 用户按了取消
        return String(answer);
    }

    public persistModel(provider: string, modelId: string): void {
        const cfg = vscode.workspace.getConfiguration("piChat");
        cfg.update("provider", provider, vscode.ConfigurationTarget.Global);
        cfg.update("model", modelId, vscode.ConfigurationTarget.Global);
    }

    public async openFileLocation(p: string, line: number, _anchor?: string): Promise<void> {
        try {
            const uri = vscode.Uri.file(p);
            const line0 = Math.max(0, Math.floor(line) - 1);
            await vscode.window.showTextDocument(uri, {
                selection: new vscode.Range(line0, 0, line0, 0),
            });
        } catch (e: any) {
            vscode.window.showErrorMessage(`无法打开文件: ${e.message}`);
        }
    }

    public async confirmRevert(label: string): Promise<boolean> {
        const choice = await vscode.window.showWarningMessage(
            `${label} 在此次修改后又被变更过，回滚将丢弃那些后续变更。确定继续？`,
            { modal: true },
            "回滚"
        );
        return choice === "回滚";
    }

    // ---- 显示选项存储（globalState）----
    protected getAutoLoadLast(): boolean {
        return this.context.globalState.get<boolean>(ChatViewProvider.KEY_AUTO_LOAD_LAST, false);
    }
    public getSendKey(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_SEND_KEY, "enter");
        return (ChatViewProvider.SEND_KEYS as readonly string[]).includes(v) ? v : "enter";
    }
    public getNewSessionKey(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_NEW_SESSION_KEY, "ctrl+alt+n");
        return (ChatViewProvider.NEW_SESSION_KEYS as readonly string[]).includes(v) ? v : "ctrl+alt+n";
    }
    public getTabSwitchKey(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_TAB_SWITCH_KEY, "ctrl+alt+arrows");
        return (ChatViewProvider.TAB_SWITCH_KEYS as readonly string[]).includes(v) ? v : "ctrl+alt+arrows";
    }
    public getFocusInputKey(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_FOCUS_INPUT_KEY, "ctrlAltI");
        return (ChatViewProvider.FOCUS_INPUT_KEYS as readonly string[]).includes(v) ? v : "ctrlAltI";
    }
    private syncFocusInputKeyContext(value = this.getFocusInputKey()): void {
        void vscode.commands.executeCommand("setContext", "piChat.focusInputKey", value);
    }
    public getFontSize(): string {
        const v = this.context.globalState.get<string>(ChatViewProvider.KEY_FONT_SIZE, "14");
        return /^\d+$/.test(v) ? v : "14";
    }
    /** 会话结束提示音（所有 session 都响）；与 Windows 系统通知互不影响。 */
    public getNotifyBeep(): boolean {
        return this.context.globalState.get<boolean>(ChatViewProvider.KEY_NOTIFY_BEEP, true);
    }
    protected notifyBeepEnabled(): boolean { return this.getNotifyBeep(); }

    /**
     * 对话界面的深浅配色（侧边栏与网页页面都用这一份）。
     * 默认浅色（就是网页端现在的白底那套取值）；深色按 VSCode 深色主题的取值写死，
     * 不随 VSCode 当前主题变——否则同一个配置在两边会长得不一样。
     */
    public getThemeMode(): "light" | "dark" {
        return this.context.globalState.get<string>(ChatViewProvider.KEY_THEME, "light") === "dark" ? "dark" : "light";
    }

    /** 共享工作区整屏重画只发最近一段历史：更早的由界面顶部的「加载更早的消息」再取。 */
    public override wantsTrimmedHistory(): boolean { return true; }

    /** viewOptions 消息附带界面颜色：桥接脚本收到后立刻换色。 */
    protected override viewOptionsExtra(): Record<string, unknown> {
        return { themeMode: this.getThemeMode() };
    }

    /** 显示选项浮层里追加的「界面颜色」按钮组。 */
    protected override viewOptionItemsExtra(): Array<{ label: string; desc: string; check: boolean | null; action: string; value?: string; options?: Array<{ value: string; label: string }> }> {
        return [
            {
                action: "theme",
                label: "界面颜色",
                desc: "对话界面的深浅配色，侧边栏与网页端共用这一份（浅色即网页端的白底那套，深色按 VSCode 深色主题的取值）",
                check: null,
                value: this.getThemeMode(),
                options: [
                    { value: "light", label: "浅色" },
                    { value: "dark", label: "深色" },
                ],
            },
        ];
    }

    /**
     * 收尾提醒最多等 pi 的会话标题几秒；0 = 不等（直接用会话显示名）。
     */
    public override getTurnTitleWaitSeconds(): number {
        const stored = this.context.globalState.get<number>(
            ChatViewProvider.KEY_TURN_TITLE_WAIT,
            DEFAULT_TURN_TITLE_WAIT_MS / 1000,
        );
        const seconds = typeof stored === "number" && Number.isFinite(stored) ? Math.round(stored) : NaN;
        return seconds >= 0 && seconds <= 60 ? seconds : DEFAULT_TURN_TITLE_WAIT_MS / 1000;
    }

    public mutateViewOption(action: string, value?: string): void {
        if (action === "sendKey") {
            const order = ChatViewProvider.SEND_KEYS;
            const next =
                value && (order as readonly string[]).includes(value)
                    ? value
                    : order[(order.indexOf(this.getSendKey() as (typeof order)[number]) + 1) % order.length];
            this.context.globalState.update(ChatViewProvider.KEY_SEND_KEY, next);
        } else if (action === "newSessionKey") {
            const order = ChatViewProvider.NEW_SESSION_KEYS;
            const next =
                value && (order as readonly string[]).includes(value)
                    ? value
                    : order[(order.indexOf(this.getNewSessionKey() as (typeof order)[number]) + 1) % order.length];
            this.context.globalState.update(ChatViewProvider.KEY_NEW_SESSION_KEY, next);
        } else if (action === "tabSwitchKey") {
            const order = ChatViewProvider.TAB_SWITCH_KEYS;
            const next =
                value && (order as readonly string[]).includes(value)
                    ? value
                    : order[(order.indexOf(this.getTabSwitchKey() as (typeof order)[number]) + 1) % order.length];
            this.context.globalState.update(ChatViewProvider.KEY_TAB_SWITCH_KEY, next);
        } else if (action === "focusInputKey") {
            const next = value && (ChatViewProvider.FOCUS_INPUT_KEYS as readonly string[]).includes(value) ? value : this.getFocusInputKey();
            void this.context.globalState.update(ChatViewProvider.KEY_FOCUS_INPUT_KEY, next);
            this.syncFocusInputKeyContext(next);
        } else if (action === "fontSize") {
            const next = typeof value === "string" && /^\d+$/.test(value) ? value : "";
            this.context.globalState.update(ChatViewProvider.KEY_FONT_SIZE, next);
        } else if (action === "notifyBeep") {
            this.context.globalState.update(ChatViewProvider.KEY_NOTIFY_BEEP, !this.getNotifyBeep());
        } else if (action === "turnTitleWait") {
            const n = Number.parseInt(typeof value === "string" ? value : "", 10);
            const next = ChatViewProvider.TURN_TITLE_WAIT_CHOICES.includes(n) ? n : DEFAULT_TURN_TITLE_WAIT_MS / 1000;
            this.context.globalState.update(ChatViewProvider.KEY_TURN_TITLE_WAIT, next);
        } else if (action === "theme") {
            const next = value === "dark" || value === "light"
                ? value
                : (this.getThemeMode() === "dark" ? "light" : "dark");
            this.context.globalState.update(ChatViewProvider.KEY_THEME, next);
        } else {
            this.context.globalState.update(ChatViewProvider.KEY_AUTO_LOAD_LAST, !this.getAutoLoadLast());
        }
    }

    // ---- 平台独有消息 ----
    protected handlePlatformMessage(msg: any): boolean {
        switch (msg.type) {
            case "hostFocus":
                // hostFocus 只用于确认框弹到哪边的时间比较（登记簿那边记动作时刻），
                // 这里不用做任何事，收下即可。
                return true;
            case "browserResync": {
                // 页面的推送连接重连上了（手机回到前台、网络断开又通）：它报上自己处理到第几条，
                // 把断线期间漏掉的消息补发过去——一条不缺就什么都不用动，页面保持原样；
                // 缺的都在补发暂存里就只补缺的那几条，页面上消息接着往下长。
                // 补不上（没报序号——旧版页面脚本，或缺得太多）才整屏重画兜底。
                // 序号是 0 也照报：那说明从没广播过东西，对账本身就是“一条不缺”。
                const pageId = this.currentPageId;
                const lastSeq = typeof msg.lastSeq === "number" && Number.isFinite(msg.lastSeq)
                    ? msg.lastSeq : -1;
                if (pageId && pageId !== ChatViewProvider.SIDEBAR_PAGE_ID
                    && lastSeq >= 0 && this.broadcaster.catchUp(pageId, lastSeq)) {
                    return true;
                }
                void this.resyncPage(pageId, "");
                return true;
            }
            case "browserDialogResult":
                this.resolveDialog(msg.id, msg.value);
                return true;
            case "openHistory":
                // 顶部标签栏那颗“⋯”按钮（以及命令面板的历史入口）：列表从右侧滑入，
                // 只弹在点它的那块屏上（另一个浏览器 / 侧边栏不跟着弹）。
                void this.showHistoryPicker(
                    this.currentPageId !== ChatViewProvider.SIDEBAR_PAGE_ID,
                    this.currentPageId,
                );
                return true;
            case "requestDesktopScreenshot":
                this.sendDesktopScreenshot();
                return true;
            case "openSettingsPanel":
                // 弹设置界面的请求：只回给请求它的那个界面。
                this.sendToOneClient(this.currentPageId, { type: "openSettings", tab: typeof msg.tab === "string" ? msg.tab : undefined });
                return true;
            case "openSymbol":
                if (typeof msg.name === "string") { void this.openSymbol(msg.name); }
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
                        vscode.window.showInformationMessage("已保存 models.json");
                        // 丢弃预热的 pi 进程：其 models.json 是启动时读入的旧副本，
                        // 丢弃后下一个新会话会按新配置启动（现有会话不受影响，重启后生效）。
                        this.modelsChanged();
                    } else {
                        this.postToWebview({ type: "app:settingsResult", ok: false, error: result.error });
                    }
                }
                return true;
            }
            case "app:probeModels": {
                void probeProviderModels(
                    typeof msg.baseUrl === "string" ? msg.baseUrl : "",
                    typeof msg.apiKey === "string" ? msg.apiKey : "",
                    typeof msg.api === "string" ? msg.api : undefined,
                ).then((result) => {
                    this.postToWebview({ type: "app:probeModelsResult", ...result });
                });
                return true;
            }
        }
        return false;
    }
    /**
     * 标签栏那颗“桌面截图”按钮：截一张这台电脑的桌面，只发回请求它的那个界面
     * （别的页面 / 侧边栏不跟着弹图）。截屏要一两秒，异步做；截完时请求方已经不在
     * 就白截（送不出去，直接丢）。成功发 desktopScreenshot（图片 base64），
     * 失败发 desktopScreenshotResult（错误文本，界面上弹一句）。
     */
    private sendDesktopScreenshot(): void {
        const target = this.currentPageId;
        void captureDesktopScreenshot().then((result) => {
            const msg = result.ok
                ? { type: "desktopScreenshot", data: result.data, mimeType: result.mimeType }
                : { type: "desktopScreenshotResult", ok: false, error: result.error };
            if (target === ChatViewProvider.SIDEBAR_PAGE_ID) {
                this.postToSidebarOnly(msg);
            } else if (target) {
                this.broadcaster.sendTo(target, msg);
            }
        });
    }

    // ---- 文件列表 / 文件打开（listFiles / openFile）----
    /** 编辑器聊天请求时使用同一份已打开文件清单，但发往调用方自己的 webview。 */
    public getOpenFiles(): Array<{ label: string; path: string }> {
        const cwd = this.getCwd();
        const files: Array<{ label: string; path: string }> = [];
        const seen = new Set<string>();
        const add = (uri: vscode.Uri) => {
            if (uri.scheme !== "file" || seen.has(uri.fsPath)) { return; }
            seen.add(uri.fsPath);
            files.push({ label: this.relativeTo(cwd, uri.fsPath), path: uri.fsPath });
        };
        if (vscode.window.activeTextEditor) { add(vscode.window.activeTextEditor.document.uri); }
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input: any = tab.input;
                if (input?.uri instanceof vscode.Uri) { add(input.uri); }
            }
        }
        return files;
    }

    protected sendFileList(): void {
        this.postToWebview({ type: "openFiles", files: this.getOpenFiles() });
    }

    protected openFileFromWebview(p: string, line?: number, col?: number): void {
        void this.openFile(p, line, col);
    }

    /** 打开正文中的文件路径（全局，不依赖 tab）。 */
    public async openFile(p: string, line?: number, col?: number): Promise<void> {
        const selection = (): vscode.TextDocumentShowOptions => {
            if (line == null) { return {}; }
            const line0 = Math.max(0, Math.floor(line) - 1);
            const col0 = col != null ? Math.max(0, Math.floor(col) - 1) : 0;
            return { selection: new vscode.Range(line0, col0, line0, col0) };
        };
        const open = async (uri: vscode.Uri): Promise<void> => {
            try { await vscode.window.showTextDocument(uri, selection()); }
            catch (e: any) { vscode.window.showErrorMessage(`无法打开文件: ${e.message}`); }
        };
        const full = this.resolvePath(p);
        if (fs.existsSync(full) && !fs.statSync(full).isDirectory()) {
            await open(vscode.Uri.file(full));
            return;
        }
        // 优先在 pi 本会话读写过的文件中匹配，避免大仓库全量 findFiles。
        const known = this.getActive()?.getKnownFiles() ?? [];
        if (known.length > 0) {
            const hit = this.matchKnownFile(known, p);
            if (hit) {
                await open(vscode.Uri.file(hit));
                return;
            }
        }
        const base = path.basename(p);
        if (base) {
            const escapeGlob = (s: string) => s.replace(/[?*\\\[\]{}]/g, "?");
            try {
                const found = await vscode.workspace.findFiles(
                    `**/${escapeGlob(base)}`,
                    "{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.next/**,**/__pycache__/**,**/.venv/**,**/venv/**}",
                    20
                );
                const files = found.filter((u) => { try { return !fs.statSync(u.fsPath).isDirectory(); } catch { return false; } });
                if (files.length > 0) {
                    const target = files.find((u) => u.fsPath.replace(/\\/g, "/").includes(p.replace(/\\/g, "/"))) || files[0];
                    await open(target);
                    return;
                }
            } catch { /* fallthrough */ }
        }
        vscode.window.showInformationMessage(`piChat: 未找到文件 ${p}`);
    }

    /** 在 pi 本会话触及的文件中匹配路径（相对/绝对/basename/路径后缀）。 */
    private matchKnownFile(known: string[], query: string): string | undefined {
        const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
        const q = norm(query);
        const cwd = this.getCwd();
        const relOf = (f: string) => norm(this.relativeTo(cwd, f));
        const exact = known.find((f) => relOf(f) === q || norm(f) === q);
        if (exact) { return exact; }
        const base = q.split("/").pop() || q;
        const cands = known.filter((f) => {
            const r = relOf(f);
            return r === base || r.endsWith("/" + base);
        });
        if (cands.length > 0) {
            return cands.find((f) => relOf(f).includes(q)) || cands[0];
        }
        return undefined;
    }

    /**
     * 界面就绪（侧边栏 webview 或某个浏览器页面发来 ready）：
     * 侧边栏标记就绪、推送符号集合；两边都把已有的对话整屏重画一遍——
     * 工作区里可能已经有别的屏聊出来的内容（比如手机上先开的对话）。
     */
    protected override onWebviewReady(): void {
        const isSidebar = this.currentPageId === ChatViewProvider.SIDEBAR_PAGE_ID;
        if (isSidebar) {
            this.webviewReady = true;
            void this.pushSymbolSet();
        }
        this.broadcastChatReferences();
        void this.resyncPage(
            this.currentPageId,
            isSidebar ? "" : "页面已重新连接（{count} 条消息，pi 进程与上下文原样保留）。",
        );
    }

    // ========================================================================
    //  浏览器页面（WebServerHost）：网页服务接进来的那些“额外的屏”
    // ========================================================================

    /** 页面连接的登记簿 + 推送序号（网页服务开连接 / 收发消息时用）。 */
    public getBroadcaster(): ChatBroadcaster { return this.broadcaster; }

    /** 页面发来一条消息（网页服务的 /api POST 转交）。 */
    public processPageMessage(msg: any, pageId: string): void {
        this.processMessage(msg, pageId);
    }

    /** 一条推送连接建立（页面连上 / 重连）：把等着的重画补上，再把攒着的消息冲出去。 */
    public onPageConnected(pageId: string): void {
        const note = this.pendingResyncPages.get(pageId);
        if (note !== undefined) {
            this.pendingResyncPages.delete(pageId);
            void this.resyncPage(pageId, note);
        }
        if (!this.pageDeliveryOn || this.outbox.size === 0) { return; }
        for (const msg of this.outbox.drain()) {
            if (!this.broadcaster.sendTo(pageId, msg)) { return; }
        }
    }

    /** 一条推送连接断了（页面关掉 / 死连接被据掉）：它那个没人答的确认框改成取消，
     *  它上面开着的浮层也按取消收掉（等的人不用干等）。 */
    public onPageDisconnected(pageId: string): void {
        this.cancelPendingDialogs(pageId);
        this.dropPickerForClient(pageId);
        // 整屏重画画到一半页面走了：重画的内容不进补发暂存，它回来对账时会“看似不缺”，
        // 内容却缺一截。记下来，它一连上就重新整画一遍。
        if (this.resyncingPages.delete(pageId)) {
            this.pendingResyncPages.set(pageId, "");
        }
    }

    /** 网页服务起来了：可以开始往页面推了（没连上的先攒着）。 */
    public onServerStarted(): void {
        this.pageDeliveryOn = true;
    }

    /** 网页服务停了：页面都收到告别话了，缓冲与等着的重画清掉。会话本体不动。 */
    public onServerStopped(): void {
        this.pageDeliveryOn = false;
        this.cancelPendingDialogs();
        this.outbox.clear();
        this.pendingResyncPages.clear();
        this.resyncingPages.clear();
    }

    /** 把在等的确认框按取消处理（pi 那边会改到 VSCode 里问，不会干等）。 */
    private cancelPendingDialogs(pageId?: string): void {
        for (const [id, pending] of Array.from(this.pendingDialogs.entries())) {
            if (pageId !== undefined && pending.pageId !== pageId) { continue; }
            this.pendingDialogs.delete(id);
            pending.resolve(undefined);
        }
    }

    /**
     * 人最近在里面动过的那个页面（确认框、输入框弹到它上面）。
     * 拿页面最后一次“人做的动作”与侧边栏最近一次动静比：谁新鲜算谁。
     * 报活不算动作，不然退到后台的页面也会一直抢着当“最近在动的那个”。
     */
    private recentPageIdForDialogs(): string | undefined {
        const page = this.broadcaster.recentActionPage();
        if (!page) { return undefined; }
        return page.at >= this.sidebarActiveAt ? page.id : undefined;
    }

    /**
     * 让浏览器页面弹一个对话框并等回复。
     * 返回 undefined 表示没等着（没有“人在动”的页面），调用方改用 VSCode 弹窗兜底。
     */
    private askPage(kind: "confirm" | "prompt", fields: Record<string, string>): Promise<unknown> {
        const pageId = this.recentPageIdForDialogs();
        if (!pageId) { return Promise.resolve(undefined); }
        const id = ++this.dialogSeq;
        return new Promise<unknown>((resolve) => {
            this.pendingDialogs.set(id, { resolve, pageId });
            // 只发给那一个页面：别的页面不跟着弹同一个框（弹了也没人答，还会把等的人拖住）。
            if (!this.broadcaster.sendTo(pageId, { type: "browserDialog", id, kind, ...fields })) {
                this.pendingDialogs.delete(id);
                resolve(undefined);
            }
        });
    }

    /** 页面回了对话框结果 / 页面走了：结束对应的等待。 */
    private resolveDialog(id: unknown, value: unknown): void {
        const key = typeof id === "number" ? id : undefined;
        if (key === undefined || !this.pendingDialogs.has(key)) { return; }
        const pending = this.pendingDialogs.get(key)!;
        this.pendingDialogs.delete(key);
        pending.resolve(value);
    }

    /**
     * 把已有的对话整屏重画一遍：界面刚就绪、或页面重连后补发补不上（缺得太多）时用它。
     *
     * 只画给发消息来的那一个来源——手机重连时，电脑那边的页面不该跟着白闪一下，
     * 更不该把正在生成的半句话清掉；侧边栏就绪时也只重画侧边栏。
     * @param pageId 要重画给哪个来源；侧边栏传它的固定标识，页面传它自己的标识。
     * @param note 重画后给的一行提示；空串表示不给（侧边栏就绪时不给，不然一打开就多一行）。
     */
    private resyncPage(pageId: string, note: string): Promise<void> {
        const isSidebar = pageId === ChatViewProvider.SIDEBAR_PAGE_ID;
        if (!isSidebar && pageId && !this.broadcaster.hasPage(pageId)) {
            // 页面的重画请求到得比它的推送连接还早（刚刷新的那一瞬间）：现在送也是白送，
            // 先记下来，它一连上就画（见 onPageConnected）。
            this.pendingResyncPages.set(pageId, note);
            return Promise.resolve();
        }
        // 只发给这一个来源；拿不到出口（理论上不会）就退回广播：宁可多画一次，也不能让界面缺内容
        const sink: MessageSink | undefined = isSidebar
            ? (msg) => this.postToSidebarOnly(msg)
            : pageId
                ? ((msg) => { this.broadcaster.sendTo(pageId, msg); })
                : undefined;
        if (!isSidebar && pageId) { this.resyncingPages.add(pageId); }
        const replays: Array<Promise<void>> = [];
        for (const rt of this.panels.values()) {
            // 刚建的空会话不用重画：newTab 已经把它需要的东西发过去了
            if (rt.isConversationEmpty()) { continue; }
            replays.push(rt.replayHistory({ note, sink }));
        }
        return Promise.all(replays).then(() => {
            // 重画的消息不带序号（它们只发给这一个来源）。页面重画完把对齐到当前序号：
            // 重画的内容已经包含到这里为止的一切，下次重连它报上来的数才是准的。
            if (!isSidebar && pageId) { this.broadcaster.sendTo(pageId, { type: "syncPoint", seq: this.broadcaster.currentSeq() }); }
        }).finally(() => {
            if (!isSidebar && pageId) { this.resyncingPages.delete(pageId); }
        });
    }

    /** 合并 open/close/save 事件，防抖推送符号集合。 */
    private schedulePushSymbolSet(): void {
        if (this.symbolSetTimer) { return; }
        this.symbolSetTimer = setTimeout(() => {
            this.symbolSetTimer = undefined;
            void this.pushSymbolSet();
        }, 200);
    }

    /** 取某文件的符号树（带版本缓存：打开文档用 vscode 版本，否则用 mtime，未变复用）。 */
    private async loadSymbolTree(p: string): Promise<vscode.DocumentSymbol[]> {
        const cached = this.symbolTreeCache.get(p);
        const version = this.fileSymbolVersion(p);
        if (cached && cached.version === version) { return cached.symbols; }
        let symbols: vscode.DocumentSymbol[] = [];
        try {
            const r = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                "vscode.executeDocumentSymbolProvider", vscode.Uri.file(p));
            if (Array.isArray(r)) { symbols = r; }
        } catch { /* 该文件无 LS 或解析失败 */ }
        this.symbolTreeCache.set(p, { version, symbols });
        return symbols;
    }

    /** 缓存失效依据：编辑器已打开用文档版本，否则用文件 mtime（毫秒）。 */
    private fileSymbolVersion(p: string): number {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === p);
        if (open) { return open.version; }
        try { return fs.statSync(p).mtimeMs; } catch { return 0; }
    }

    /** 扁平化符号树，为每个符号产出裸名 + 祖先链全限定名（Parent.child）。 */
    private collectSymbols(syms: vscode.DocumentSymbol[], parents: string[], out: Set<string>): void {
        for (const s of syms) {
            out.add(s.name);
            if (parents.length > 0) { out.add(parents.join(".") + "." + s.name); }
            if (s.children && s.children.length > 0) {
                this.collectSymbols(s.children, [...parents, s.name], out);
            }
        }
    }

    /** 合并所有 session 中 pi 工具触及过的文件符号树 → 推送 symbolSet 给 webview。 */
    private async pushSymbolSet(): Promise<void> {
        if (!this.view) { return; }
        const paths = this.getAllKnownFiles();
        const names = new Set<string>();
        await Promise.all(paths.map(async (p) => {
            const syms = await this.loadSymbolTree(p);
            this.collectSymbols(syms, [], names);
        }));
        this.postToWebview({ type: "symbolSet", names: Array.from(names) });
    }

    public async openSymbol(name: string): Promise<void> {
        const parts = name.split(".");
        const tail = parts.pop()!;
        // 优先在 pi 工具触及过的文件中检索
        for (const p of this.getAllKnownFiles()) {
            const hit = await this.findSymbolIn(p, parts, tail);
            if (hit) {
                await this.openFileLocation(p, hit.selectionRange.start.line + 1);
                return;
            }
        }
        // 兜底：所有打开的文档
        for (const d of vscode.workspace.textDocuments) {
            if (d.uri.scheme !== "file") { continue; }
            const hit = await this.findSymbolIn(d.uri.fsPath, parts, tail);
            if (hit) {
                await this.openFileLocation(d.uri.fsPath, hit.selectionRange.start.line + 1);
                return;
            }
        }
        vscode.window.showInformationMessage(`piChat: 未找到符号 ${name}`);
    }

    /** 在某文件的符号树上按限定名逐级查找（Foo.method → 找 Foo 再在其 children 里找 method）。
     * 裸名（无点）时递归搜整棵树：TS 的 DocumentSymbol 顶层是 class，方法/属性嵌套在类 children 里。 */
    private async findSymbolIn(
        p: string, parts: string[], tail: string
    ): Promise<vscode.DocumentSymbol | undefined> {
        const syms = await this.loadSymbolTree(p);
        if (parts.length === 0) {
            return this.dfsFindSymbol(syms, tail);
        }
        let level: vscode.DocumentSymbol[] | undefined = syms;
        for (const part of parts) {
            const next: vscode.DocumentSymbol | undefined = level?.find((s) => s.name === part);
            level = next?.children;
            if (!next) { level = undefined; break; }
        }
        return level?.find((s) => s.name === tail);
    }

    /** DFS 递归找第一个名字匹配的符号（裸名可能嵌套在类/命名空间内）。 */
    private dfsFindSymbol(syms: vscode.DocumentSymbol[], name: string): vscode.DocumentSymbol | undefined {
        for (const s of syms) {
            if (s.name === name) { return s; }
            if (s.children && s.children.length > 0) {
                const hit = this.dfsFindSymbol(s.children, name);
                if (hit) { return hit; }
            }
        }
        return undefined;
    }

    /** models.json 修改后丢弃按旧配置预热的备用进程。 */
    public modelsChanged(): void {
        this.disposeSpare();
    }

    private async focusSidebarInput(): Promise<void> {
        await this.ensureViewVisible();
        this.postToWebview({ type: "focusInput" });
    }

    private async sendToSidebar(text: string): Promise<void> {
        await this.focusSidebarInput();
        if (!this.getActive()) { this.newSession(); }
        this.sendActiveTabText(text);
    }

    /** 全局“新建会话”：打开侧边栏并新建一个 tab。 */
    public async newSessionAtLastActive(): Promise<void> {
        await this.ensureViewVisible();
        this.newSession();
    }

    // ---- 命令入口 ----
    public async pickViewOptions(): Promise<void> {
        await this.ensureViewVisible();
        // VSCode 这边的命令入口：设置在侧边栏打开，不跟着弹到各个浏览器页面。
        this.postToSidebarOnly({ type: "openSettings", tab: "options" });
    }

    public async openSettings(): Promise<void> {
        await this.ensureViewVisible();
        this.postToSidebarOnly({ type: "openSettings" });
    }

    public async focusInput(): Promise<void> {
        await this.focusSidebarInput();
    }

    public async pickSession(): Promise<void> {
        // 命令面板 / 快捷键入口：打开侧边栏并弹出历史会话列表（与 ⋯ 按钮同一份）。
        await this.showHistoryPicker(false, ChatViewProvider.SIDEBAR_PAGE_ID);
    }

    /** 点击状态栏模型项触发：弹出模型选择器。 */
    public async pickModel(): Promise<void> {
        await this.ensureViewVisible();
        // 命令面板入口：人正看着 VSCode，把“最近在动”算到侧边栏头上，
        // 模型选择器就弹在侧边栏（否则可能跑到刚动过的浏览器页面上去）。
        this.sidebarActiveAt = Date.now();
        const rt = this.getActive();
        if (rt) { await rt.pickModel(); }
    }

    /** 任一 tab 的工具触及文件集合变化：刷新符号集合（200ms 防抖）。 */
    protected onKnownFilesChangedByHost(): void {
        this.schedulePushSymbolSet();
    }

    public async askSelectionAndSend(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Pi Chat: 没有活动的编辑器。");
            return;
        }
        const document = editor.document;
        const selection = editor.selection;
        const selectedText = document.getText(selection);
        const hasSelection = !selection.isEmpty && selectedText.trim() !== "";
        const codeText = hasSelection
            ? selectedText
            : document.lineAt(selection.active.line).text;
        const fileRef = this.relativeTo(this.getCwd(), document.uri.fsPath);
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const range =
            startLine === endLine
                ? `第 ${startLine} 行`
                : `第 ${startLine}-${endLine} 行`;

        const userText = await vscode.window.showInputBox({
            title: "向 Pi Chat 发送选中文本",
            prompt: "你的消息将连同选中的代码一起发送到 Pi Chat 对话框。",
            placeHolder: "例如：解释这段代码、修复 bug、补充测试…（可留空直接发送选中文本）",
            ignoreFocusOut: true,
        });
        if (userText === undefined) { return; }
        if (userText.trim() === "" && !hasSelection) {
            vscode.window.showWarningMessage("Pi Chat: 没有选中文本且消息为空。");
            return;
        }

        const prefix = userText.trim() ? `${userText.trim()}\n\n` : "";
        const prompt = `${prefix}上下文: ${fileRef} (${range})\n\n\`\`\`${document.languageId}\n${codeText}\n\`\`\`\n`;

        await this.sendToSidebar(prompt);
        vscode.window.showInformationMessage("已发送到 Pi Chat 对话框。");
    }

    protected async onFocusChat(): Promise<void> {
        await vscode.commands.executeCommand("workbench.view.extension.piChatContainer");
        await vscode.commands.executeCommand("piChat.chatView.focus");
    }

    protected async beforeHistoryPicker(): Promise<void> {
        // 只有侧边栏/命令面板发来的历史会话请求会走到这里（页面发来的不会，见基类的 fromPage 参数）：
        // 先把侧边栏打开，列表才看得见。
        await this.ensureViewVisible();
    }

    protected onNoSessions(): void {
        vscode.window.showInformationMessage("当前工作区没有找到 pi 历史会话。");
    }

    /** 等待 webview JS 就绪（消息监听已建立）。超时后继续，避免死锁。 */
    private async waitWebviewReady(timeoutMs = 10000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!this.webviewReady) {
            if (Date.now() > deadline) { return; }
            await new Promise((r) => setTimeout(r, 50));
        }
    }

    private async ensureViewVisible(): Promise<void> {
        await vscode.commands.executeCommand("piChat.openChat");
        // 视图已可见但 webview JS 可能尚未加载完：此时 postMessage 会被丢弃
        // （ready 之前 webview 尚未建立消息监听）。等 JS 就绪后再发送。
        await this.waitWebviewReady();
    }
}


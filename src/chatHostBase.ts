/**
 * 聊天宿主的公共部分（跟 VSCode 无关的那一半）。
 *
 * 一份会话工作区（{@link ChatControllerBase} 那套：标签、会话进程、消息分发）可以挂在
 * 不同的宿主上，本类装的是两家都要做的事：
 *   - "好几块屏"的出口：网页服务接进来的浏览器页面（手机 / 电脑浏览器，可以同时开着好几个），
 *     以及宿主自己可能带的一块本机界面（VSCode 那边是插件里那块对话面板，独立后端没有）；
 *   - 页面连接的登记、推送序号、断线补发、整屏重画；
 *   - 浮层（历史列表、模型选择、确认框）该弹在哪块屏上，以及对话框的收发；
 *   - 显示选项（界面颜色、字号、快捷键、提醒开关）的读写入口：候选值与默认值在
 *     viewOptions.ts，存储由子类给（VSCode 存 globalState，独立后端存 state.json）；
 *   - 名字池、# 引用目录、桌面截图这类跟平台无关的杂事。
 *
 * 本类不引用 `vscode`，可以单测；平台相关的东西（设置从哪读、弹窗用谁家的、文件怎么打开、
 * 会话跑完怎么提醒）留在子类里。
 */
import * as crypto from "crypto";
import * as path from "path";
import type { MessageSink } from "./sessionRuntime";
import { ChatControllerBase } from "./chatControllerBase";
import { listProjects, listSessionFiles, type ProjectEntry } from "./sessionStore";
import { listDirectories, type DirListing } from "./dirBrowse";
import { ChatBroadcaster } from "./chatBroadcaster";
import { MessageBuffer } from "./webTransport";
import { pickOverlayClient } from "./overlayTarget";
import { dirInsideFolders, ScreenRegistry } from "./screenRegistry";
import type { WebServerHost } from "./webChatServer";
import { uniqueNameParts, composeName, type NameParts } from "./names";
import { captureDesktopScreenshot } from "./desktopScreenshot";
import {
    DEFAULT_AUTO_LOAD_LAST,
    DEFAULT_FOCUS_INPUT_KEY,
    DEFAULT_FONT_SIZE,
    DEFAULT_NEW_SESSION_KEY,
    DEFAULT_NOTIFY_BEEP,
    DEFAULT_SEND_KEY,
    DEFAULT_TAB_SWITCH_KEY,
    DEFAULT_THEME_MODE,
    FOCUS_INPUT_KEYS,
    NEW_SESSION_KEYS,
    SEND_KEYS,
    TAB_SWITCH_KEYS,
    inList,
    nextInList,
} from "./viewOptions";

export abstract class ChatHostBase extends ChatControllerBase implements WebServerHost {
    /** 本机那块界面的固定标识：VSCode 那边就是插件里那块对话面板；独立后端没有这块屏，用不上。 */
    protected static readonly LOCAL_CLIENT_ID = ChatControllerBase.LOCAL_CLIENT_ID;

    /** 项目列表里“浏览文件夹”那一行的标识（会话文件、目录都是绝对路径，撞不上这种带 \0 的）。 */
    private static readonly BROWSE_ROW = "\u0000pichat:browse";
    /** 文件夹列表里“就用这个目录”那一行的标识。 */
    private static readonly USE_DIR_ROW = "\u0000pichat:use-dir";
    /** 文件夹列表里“换一个盘 / 回到最上层”那一行的标识。 */
    private static readonly ROOTS_ROW = "\u0000pichat:roots";

    // ---- 浏览器页面（接在本工作区上的“额外的屏”，可以有多个）----
    /** 页面连接登记簿 + 推送序号：本机界面与所有浏览器页面共用同一份会话的出口。 */
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
    // 正在处理哪一个来源发来的消息，以及“每块屏各自在看哪个会话”，都在基类里管
    // （见 ChatControllerBase.currentPageId / clientSessions）：本类只管“屏”这一层。
    /** 人最近在本机界面里动过的时刻：浮层弹到哪块屏上，靠它和页面的动作时刻比。 */
    protected localActiveAt = 0;

    // ---- 显示选项的键（存储由子类给：VSCode 的 globalState / 独立后端的 state.json）----
    protected static readonly KEY_AUTO_LOAD_LAST = "piChat.autoLoadLastSession";
    protected static readonly KEY_SEND_KEY = "piChat.sendKey";
    protected static readonly KEY_NEW_SESSION_KEY = "piChat.newSessionKey";
    protected static readonly KEY_TAB_SWITCH_KEY = "piChat.tabSwitchKey";
    protected static readonly KEY_FOCUS_INPUT_KEY = "piChat.focusInputKey";
    protected static readonly KEY_FONT_SIZE = "piChat.fontSize";
    protected static readonly KEY_NOTIFY_BEEP = "piChat.notifyBeep";
    protected static readonly KEY_THEME = "piChat.themeMode";

    /** 会话显示名用的名字池：panel 关闭后会释放对应名字。 */
    private readonly usedChatNames = new Set<string>();

    // ========================================================================
    //  子类要填的口子
    // ========================================================================

    /** 读一个显示选项。 */
    protected abstract readOption<T>(key: string, fallback: T): T;
    /** 写一个显示选项。 */
    protected abstract writeOption(key: string, value: unknown): void;

    /** 往本机界面（VSCode 里就是插件里那块对话面板）发一条消息；没有本机界面的宿主不用实现。 */
    protected postToLocalClient(_msg: Record<string, unknown>): void { /* 默认没有本机界面 */ }
    /** 本机界面现在能不能收消息（VSCode 那边是 webview 在不在）。 */
    protected hasLocalClient(): boolean { return false; }
    /** 等本机界面就绪（VSCode 的 webview JS 加载完才能收消息）。 */
    protected waitLocalReady(): Promise<void> { return Promise.resolve(); }
    /** 显示选项改动之后的平台动作（VSCode 要同步快捷键的 when 条件）。 */
    protected onViewOptionChanged(_action: string): void { /* 默认不用做 */ }
    /** 给用户一条普通提示（VSCode 用信息条，独立后端写日志）。 */
    protected onNotice(_text: string): void { /* 默认丢掉 */ }

    /**
     * 人最近动过的那块屏挑不出来时的兜底（独立后端用：没有 VSCode 弹窗可用，
     * 就随便挑一块连着的屏来问，总比没人答好）。默认 undefined = 用宿主自己的弹窗。
     */
    protected pageForDialogFallback(): string | undefined { return undefined; }

    // ========================================================================
    //  出口：一条消息送去哪几块屏
    // ========================================================================

    /** 把一条消息送到所有界面：本机界面 + 所有连着的浏览器页面。 */
    protected postToWebview(msg: Record<string, unknown>): void {
        // 浅拷贝给本机界面：下面广播会给消息记上序号（改动同一个对象），
        // postMessage 若是迟到才序列化，本机界面那份不该带上页面的序号。
        this.postToLocalClient({ ...msg });
        this.postToPagesOnly(msg);
    }

    /** 只发给浏览器页面（一个都没连着时先攒着，等第一条连接进来补发）。 */
    private postToPagesOnly(msg: Record<string, unknown>): void {
        if (!this.pageDeliveryOn) { return; }
        if (this.broadcaster.broadcast(msg)) { return; }
        this.outbox.push(msg);
    }

    /**
     * 浮层（历史会话列表、模型选择、确认框这类“当时的一次性界面”）该发给谁：
     * 人最近在动的那一块屏（本机界面也算一块）。“最近”只看人做的动作，报活不算。
     */
    protected override pickOverlayTarget(): string {
        return pickOverlayClient(
            ChatHostBase.LOCAL_CLIENT_ID,
            this.localActiveAt,
            this.hasLocalClient(),
            this.broadcaster.recentActionPage(),
            this.broadcaster.recentPage()?.id,
        );
    }

    /** 浮层消息的出口：只发给挑好的那一块屏，别的屏收不到。 */
    protected override sendOverlayTo(target: string, msg: Record<string, unknown>): boolean {
        return this.sendToOneClient(target, msg);
    }

    /** 只发给某一块屏（本机界面或某个页面）；那块屏不在就返回 false。 */
    protected sendToOneClient(target: string, msg: Record<string, unknown>): boolean {
        if (target === ChatHostBase.LOCAL_CLIENT_ID) {
            if (!this.hasLocalClient()) { return false; }
            this.postToLocalClient(msg);
            return true;
        }
        if (!target) { return false; }
        return this.broadcaster.sendTo(target, msg);
    }

    /**
     * 浮层（拾取器）只发给挑好的那一块屏：在哪个屏上点开就弹在哪个屏，别的屏不受影响。
     * 挑中的是本机界面时，等它的 JS 就绪再推（否则消息会被静默丢弃，表现为点击无反应）；
     * 挑不出屏（本机界面没开、也没有页面）直接按取消。
     */
    protected override async showPicker(
        kind: string,
        items: any[],
        current?: string | null,
        echo?: Record<string, unknown>,
        target?: string,
    ): Promise<any | undefined> {
        // 调用方指定了弹给哪块屏就用它（模型选择器这种“点它的人自己要看”）；不然现挑“人最近在动的那一块”
        const to = target ?? this.pickOverlayTarget();
        if (!to) { return Promise.resolve(undefined); }
        if (to === ChatHostBase.LOCAL_CLIENT_ID) {
            await this.waitLocalReady();
        }
        return this.openPicker(kind, { items, current: current ?? null, ...(echo || {}) }, to);
    }

    // ========================================================================
    //  项目 / 文件夹拾取器（手机上“在另一个项目里开新会话”走这条路）
    // ========================================================================

    /** 目录名（最后一段）；盘根这类取不出名字的就用整个路径。 */
    private dirName(p: string): string {
        const base = path.basename(p);
        return base && base !== path.sep ? base : p;
    }

    /**
     * 项目清单（做成可覆写的方法：单测里换成固定的几条数据，不去扫真实目录。
     * 真实实现在 sessionStore.listProjects）。
     */
    protected async listProjectsForPicker(): Promise<ProjectEntry[]> {
        return listProjects();
    }

    /** 目录清单（同上，单测可覆写；真实实现在 dirBrowse.listDirectories）。 */
    protected async listDirsForPicker(dir: string): Promise<DirListing> {
        return listDirectories(dir);
    }

    /** 工作区一次给几个（当前工作区固定占一行，其余再取四行，总数五个）。 */
    private static readonly WORKSPACE_BATCH = 4;

    /**
     * “项目与会话”面板：上半是当前工作区的会话列表，下半是工作区（用 pi 跑过会话的目录）。
     * 点下面的工作区**只换上半那份列表**（面板不关，见 switchWorkspacePanel），
     * 点会话才关掉面板切过去；下半最上面那行是“浏览文件夹…”，走原来的逛文件夹那条路。
     * 面板那一摊数据按屏存（见 pickerStateOf）：两个窗口各自开着互不影响。
     */
    public async showWorkspacePicker(target?: string): Promise<void> {
        const clientId = target || this.currentPageId;
        const folder = this.getActive(clientId)?.cwd ?? this.getCwd();
        const choice = await this.openWorkspacePanel(folder, clientId);
        if (!choice || typeof choice.file !== "string") { return; }
        const folderNow = this.pickerStateOf(clientId).workspaceFolder || folder;
        if (choice.file === ChatHostBase.BROWSE_ROW) {
            await this.showFolderPicker(folderNow, clientId);
            return;
        }
        await this.loadHistorySession(choice.file, folderNow, clientId);
    }

    /** 打开面板（画出来并等选择）。 */
    private async openWorkspacePanel(folder: string, clientId: string): Promise<any | undefined> {
        const payload = await this.buildWorkspacePanel(folder, clientId);
        return this.openPicker("workspace", payload, clientId);
    }

    /**
     * 点了下面某个工作区：只把上半那份会话列表换成那个目录的，面板留着不关。
     * 面板已经被关掉（人在别处点了）就什么都不做——免得画到一个已经没了的面板上。
     */
    public async switchWorkspacePanel(folder: string, target?: string): Promise<void> {
        const clientId = target || this.currentPageId;
        if (this.pickerStateOf(clientId).kind !== "workspace") { return; }
        const payload = await this.buildWorkspacePanel(folder, clientId);
        if (this.pickerStateOf(clientId).kind !== "workspace") { return; }   // 画之前又被关了
        this.sendOverlayTo(clientId, { type: "picker", kind: "workspace", ...payload });
    }

    /**
     * 面板的内容：上半会话（当前目录的历史会话）、下半工作区。
     * 会话那份复用历史列表那套机器（pickerState 里的 historyFiles / historyOffset / scanHistoryBatch），
     * 工作区那份自己分页：当前目录固定显示，另外一次取 4 个，总共显示 5 个工作区；下面留一颗“加载更多”。
     */
    private async buildWorkspacePanel(folder: string, clientId: string): Promise<Record<string, unknown>> {
        const cwd = path.resolve(folder);
        const state = this.pickerStateOf(clientId);
        state.workspaceFolder = cwd;
        state.historyFiles = await listSessionFiles(cwd);
        state.historyOffset = 0;
        const sessions = await this.scanHistoryBatch(clientId);
        const projects = await this.listProjectsForPicker();
        const current = projects.find((p) => this.sameDir(p.cwd, cwd));
        // 分页的那串：去掉当前目录那条（它固定在第一），剩下的按最后活动时间排（清单本来就是倒序的）。
        state.workspaceRest = projects.filter((p) => !this.sameDir(p.cwd, cwd));
        state.workspaceOffset = 0;
        const head: any[] = [
            { label: "打开文件夹…", file: ChatHostBase.BROWSE_ROW, action: "browse", folderPath: "挑一个文件夹当工作区" },
            {
                label: this.dirName(cwd),
                file: cwd,
                folderPath: cwd,
                count: current?.sessionCount ?? 0,
                lastActivity: current?.lastActivity ?? 0,
                current: true,
            },
        ];
        return {
            title: "项目与会话",
            sessions: {
                items: sessions,
                hasMore: state.historyOffset < state.historyFiles.length,
                folder: cwd,
                name: this.dirName(cwd),
            },
            spaces: {
                items: head.concat(this.takeWorkspacePage(clientId)),
                current: cwd,
                hasMore: state.workspaceOffset < state.workspaceRest.length,
            },
        };
    }

    /** 取下一批工作区行（一次 WORKSPACE_BATCH 个）。 */
    private takeWorkspacePage(clientId: string): any[] {
        const state = this.pickerStateOf(clientId);
        const batch = state.workspaceRest.slice(state.workspaceOffset, state.workspaceOffset + ChatHostBase.WORKSPACE_BATCH);
        state.workspaceOffset += batch.length;
        return batch.map((p) => ({
            label: p.name,
            file: p.cwd,
            folderPath: p.cwd,
            count: p.sessionCount,
            lastActivity: p.lastActivity,
        }));
    }

    /** 面板里点工作区那块的「加载更多」：再送一批过去。 */
    public async loadMoreWorkspaces(): Promise<void> {
        const clientId = this.currentPageId;
        const state = this.pickerStateOf(clientId);
        if (state.kind !== "workspace") { return; }
        const items = this.takeWorkspacePage(clientId);
        this.sendOverlayTo(clientId, {
            type: "workspacePageAppend",
            items,
            hasMore: state.workspaceOffset < state.workspaceRest.length,
        });
    }

    /**
     * 一层一层追文件夹：点子目录进去、点“上一层”退回去，最后点“就用这个目录”在那里开新会话。
     * 起点给空串就是列盘符（Windows）/ 根目录。
     *
     * 每一项都带一个图标名（icon），界面照名字在行首画一颗（见 media/chat.js 的 FOLDER_ROW_ICONS）：
     * "folder" 子目录、"up" 上一层（换一个盘也一样是往上走）、"check" 用这个目录。
     * 图标写在数据里、不在文字前面拼符号：符号在有的字体下对不齐，也没法按名字换。
     *
     * @param clientId 这个浮层是哪块屏开的（它自己收自己的回复）。
     */
    public async showFolderPicker(dir: string, clientId: string = this.currentPageId): Promise<void> {
        const listing = await this.listDirsForPicker(dir);
        // 判"这是盘符列表"只认空路径：dirBrowse 把盘根（D:\）也标成 roots，
        // 但那是个真目录（可以选它当项目目录，也是上一层能到的地方），不能跟盘符列表混为一谈。
        const driveList = !listing.path;
        const items: any[] = [];
        // 这个目录列不出来（没了 / 没权限）时不给"就用这个目录"：pi 在那里也跑不起来，
        // 只留一条退回去的路，人自己往上走。
        if (!driveList && !listing.error) {
            items.push({
                label: "就用这个目录（在这里新建会话）",
                file: ChatHostBase.USE_DIR_ROW,
                folderPath: listing.path,
                icon: "check",
            });
        }
        if (listing.parent) {
            items.push({ label: "上一层", file: listing.parent, icon: "up" });
        } else if (!driveList) {
            // 到了盘根就没法再往上：给一条回到盘符列表的路，否则换不了盘。
            items.push({ label: "回到最上层（换一个盘）", file: ChatHostBase.ROOTS_ROW, icon: "up" });
        }
        for (const d of listing.dirs) { items.push({ label: d.name, file: d.path, icon: "folder" }); }
        if (items.length === 0) { items.push({ label: "（这里没有子文件夹）", file: "" }); }
        // 列不出来的原因（没权限、目录没了）写进标题里，人一眼知道为什么是空的。
        // 正在看的目录写在标题下面那行小字（subtitle）里：标题只报“在干啥”，
        // 路径再长也不会把标题顶成两行。
        const title = driveList
            ? "选择盘"
            : (listing.error ? `选择文件夹（${listing.error}）` : "选择文件夹");
        // 盘符列表没有路径可报，写一句“此电脑”——跟 Windows 资源管理器里那一层的叫法一致。
        const subtitle = driveList ? "此电脑" : listing.path;
        // 不给筛选框：一层目录就几行，用上下键挑名字比打字快，框还占一截地方。
        const choice = await this.openPicker("folders", { items, searchable: false, title, subtitle }, clientId);
        if (!choice || typeof choice.file !== "string" || !choice.file) { return; }
        if (choice.file === ChatHostBase.USE_DIR_ROW) {
            this.newSessionInDir(listing.path, { clientId });
            return;
        }
        if (choice.file === ChatHostBase.ROOTS_ROW) {
            await this.showFolderPicker("", clientId);
            return;
        }
        await this.showFolderPicker(choice.file, clientId);
    }

    // ========================================================================
    //  消息分发（页面发来的与 ready 统一走这里）
    // ========================================================================

    /** 带来源的消息分发：处理期间记下是哪个来源发来的，浮层才知道该回给谁。 */
    public override processMessage(msg: any, pageId?: string): void {
        if (!msg || typeof msg.type !== "string") { return; }
        const previous = this.currentPageId;
        this.currentPageId = typeof pageId === "string" && pageId ? pageId : ChatHostBase.LOCAL_CLIENT_ID;
        try {
            super.processMessage(msg);
        } finally {
            this.currentPageId = previous;
        }
    }

    /**
     * 界面就绪（本机界面或某个浏览器页面发来 ready）：两边都把已有的对话整屏重画一遍——
     * 工作区里可能已经有别的屏聊出来的内容（比如手机上先开的对话）。
     */
    protected override onWebviewReady(): void {
        this.broadcastChatReferences();
        void this.resyncPage(
            this.currentPageId,
            this.currentPageId === ChatHostBase.LOCAL_CLIENT_ID
                ? ""
                : "页面已重新连接（{count} 条消息，pi 进程与上下文原样保留）。",
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
        if (this.pageDeliveryOn && this.outbox.size > 0) {
            for (const msg of this.outbox.drain()) {
                if (!this.broadcaster.sendTo(pageId, msg)) { break; }
            }
        }
        // 这块屏（重新）连上：把“你在看哪个会话”和一份最新的会话列表单发给它。
        // 断线期间漏掉的变化（会话关了、新开了）靠它补齐——会话列表不再进补发暂存了
        // （里面带着“每块屏在看哪一个”，补发给别的屏会把人家的画面带偏）。
        const mine = this.focusedIdFor(pageId);
        if (mine) { this.postToOneClient(pageId, { type: "sessionActivated", sessionId: mine }); }
        this.sendSessionListTo(pageId);
    }

    /** 一条推送连接断了（页面关掉 / 死连接被掐掉）：它那个没人答的确认框改成取消，
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

    /** 把在等的确认框按取消处理（pi 那边会改用宿主自己的弹窗问，不会干等）。 */
    private cancelPendingDialogs(pageId?: string): void {
        for (const [id, pending] of Array.from(this.pendingDialogs.entries())) {
            if (pageId !== undefined && pending.pageId !== pageId) { continue; }
            this.pendingDialogs.delete(id);
            pending.resolve(undefined);
        }
    }

    /**
     * 要弹对话框时问哪一块屏。
     *
     * 先看“谁正在看着这个会话”（调用方把会话标识给进来时）：一个会话的提问弹到没在看它的
     * 窗口去，容易被当成莫名其妙的东西。没人看着它（或调用方没说会话）才退到老规矩：
     * 问“人最近在里面动过的那个”。报活不算动作，不然退到后台的页面会一直抢着当“最近在动的那个”。
     */
    protected pickDialogClient(sessionId?: string): string | undefined {
        if (sessionId) {
            const viewing = this.clientsViewing(sessionId);
            if (viewing.length > 0) {
                // 几块屏都在看：挑最近有人在里面动过的那个（都在看就是同一件事，弹哪边都对）
                const recent = this.broadcaster.recentActionPage();
                if (recent && viewing.includes(recent.id)) { return recent.id; }
                return viewing[0];
            }
        }
        const page = this.broadcaster.recentActionPage();
        if (!page) { return undefined; }
        return page.at >= this.localActiveAt ? page.id : undefined;
    }

    /**
     * 让一块屏弹一个对话框并等回复。
     * @param sessionId 哪个会话问的：优先问正在看它的那块屏（见 pickDialogClient）。
     * 返回 undefined 表示没等着（没有“人在动”的屏，也没有兜底可挑），调用方换自己的办法。
     */
    protected askPage(kind: "confirm" | "prompt", fields: Record<string, string>, sessionId?: string): Promise<unknown> {
        const pageId = this.pickDialogClient(sessionId) ?? this.pickDialogClient() ?? this.pageForDialogFallback();
        if (!pageId) { return Promise.resolve(undefined); }
        const id = ++this.dialogSeq;
        return new Promise<unknown>((resolve) => {
            this.pendingDialogs.set(id, { resolve, pageId });
            // 只发给那一块屏：别的屏不跟着弹同一个框（弹了也没人答，还会把等的人拖住）。
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
     * 只画给发消息来的那一块屏——手机重连时，电脑那边的页面不该跟着白闪一下，
     * 更不该把正在生成的半句话清掉；本机界面就绪时也只重画本机界面。
     * @param pageId 要重画给哪一块屏；本机界面传它的固定标识，页面传它自己的标识。
     * @param note 重画后给的一行提示；空串表示不给。
     */
    private resyncPage(pageId: string, note: string): Promise<void> {
        const isLocal = pageId === ChatHostBase.LOCAL_CLIENT_ID;
        if (!isLocal && pageId && !this.broadcaster.hasPage(pageId)) {
            // 页面的重画请求到得比它的推送连接还早（刚刷新的那一瞬间）：现在送也是白送，
            // 先记下来，它一连上就画（见 onPageConnected）。
            this.pendingResyncPages.set(pageId, note);
            return Promise.resolve();
        }
        // 只发给这一块屏；拿不到出口（理论上不会）就退回广播：宁可多画一次，也不能让界面缺内容
        const sink: MessageSink | undefined = isLocal
            ? (msg) => this.postToLocalClient(msg)
            : pageId
                ? ((msg) => { this.broadcaster.sendTo(pageId, msg); })
                : undefined;
        if (!isLocal && pageId) { this.resyncingPages.add(pageId); }
        const replays: Array<Promise<void>> = [];
        for (const rt of this.panels.values()) {
            // 刚建的空会话不用重画：newSession 已经把它需要的东西发过去了
            if (rt.isConversationEmpty()) { continue; }
            replays.push(rt.replayHistory({ note, sink }));
        }
        return Promise.all(replays).then(() => {
            // 重画的消息不带序号（它们只发给这一块屏）。页面重画完把对齐到当前序号：
            // 重画的内容已经包含到这里为止的一切，下次重连它报上来的数才是准的。
            if (!isLocal && pageId) { this.broadcaster.sendTo(pageId, { type: "syncPoint", seq: this.broadcaster.currentSeq() }); }
        }).finally(() => {
            if (!isLocal && pageId) { this.resyncingPages.delete(pageId); }
        });
    }

    // ========================================================================
    //  名字池 / # 引用目录
    // ========================================================================

    public allocateChatName(): NameParts {
        const parts = uniqueNameParts(this.usedChatNames);
        this.usedChatNames.add(composeName(parts));
        return parts;
    }

    public releaseChatName(parts: NameParts): void {
        this.usedChatNames.delete(composeName(parts));
    }

    /** # 对话引用目录刷新：每一块屏都会拿到全部会话，自己那一个由界面按本地当前会话滤掉。 */
    public broadcastChatReferences(): void {
        this.updateChatReferences(this.getChatReferenceItems());
    }

    protected override allocatePanelName(): NameParts { return this.allocateChatName(); }
    protected override releasePanelName(parts: NameParts): void { this.releaseChatName(parts); }
    protected override onChatStructureChanged(): void { this.broadcastChatReferences(); }

    // ========================================================================
    //  显示选项（候选与默认值在 viewOptions.ts，存储交给子类）
    // ========================================================================

    protected getAutoLoadLast(): boolean {
        return this.readOption<boolean>(ChatHostBase.KEY_AUTO_LOAD_LAST, DEFAULT_AUTO_LOAD_LAST);
    }
    public getSendKey(): string {
        const v = this.readOption<string>(ChatHostBase.KEY_SEND_KEY, DEFAULT_SEND_KEY);
        return inList(SEND_KEYS, v) ? v : DEFAULT_SEND_KEY;
    }
    public getNewSessionKey(): string {
        const v = this.readOption<string>(ChatHostBase.KEY_NEW_SESSION_KEY, DEFAULT_NEW_SESSION_KEY);
        return inList(NEW_SESSION_KEYS, v) ? v : DEFAULT_NEW_SESSION_KEY;
    }
    public getTabSwitchKey(): string {
        const v = this.readOption<string>(ChatHostBase.KEY_TAB_SWITCH_KEY, DEFAULT_TAB_SWITCH_KEY);
        return inList(TAB_SWITCH_KEYS, v) ? v : DEFAULT_TAB_SWITCH_KEY;
    }
    public getFocusInputKey(): string {
        const v = this.readOption<string>(ChatHostBase.KEY_FOCUS_INPUT_KEY, DEFAULT_FOCUS_INPUT_KEY);
        return inList(FOCUS_INPUT_KEYS, v) ? v : DEFAULT_FOCUS_INPUT_KEY;
    }
    public getFontSize(): string {
        const v = this.readOption<string>(ChatHostBase.KEY_FONT_SIZE, DEFAULT_FONT_SIZE);
        return typeof v === "string" && /^\d+$/.test(v) ? v : DEFAULT_FONT_SIZE;
    }
    /** 会话结束提示音（所有 session 都响）。 */
    public getNotifyBeep(): boolean {
        return this.readOption<boolean>(ChatHostBase.KEY_NOTIFY_BEEP, DEFAULT_NOTIFY_BEEP) === true;
    }
    protected notifyBeepEnabled(): boolean { return this.getNotifyBeep(); }

    /**
     * 对话界面的深浅配色（本机界面与网页页面都用这一份）。
     * 默认浅色（就是网页端现在的白底那套取值）；深色按 VSCode 深色主题的取值写死，
     * 不随 VSCode 当前主题变——否则同一个配置在两边会长得不一样。
     */
    public getThemeMode(): "light" | "dark" {
        return this.readOption<string>(ChatHostBase.KEY_THEME, DEFAULT_THEME_MODE) === "dark" ? "dark" : "light";
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
                desc: "对话界面的深浅配色，插件里的对话面板与浏览器页面共用这一份（浅色即网页端的白底那套，深色按 VSCode 深色主题的取值）",
                check: null,
                value: this.getThemeMode(),
                options: [
                    { value: "light", label: "浅色" },
                    { value: "dark", label: "深色" },
                ],
            },
        ];
    }

    public mutateViewOption(action: string, value?: string): void {
        if (action === "sendKey") {
            const next = inList(SEND_KEYS, value) ? value : nextInList(SEND_KEYS, this.getSendKey());
            this.writeOption(ChatHostBase.KEY_SEND_KEY, next);
        } else if (action === "newSessionKey") {
            const next = inList(NEW_SESSION_KEYS, value) ? value : nextInList(NEW_SESSION_KEYS, this.getNewSessionKey());
            this.writeOption(ChatHostBase.KEY_NEW_SESSION_KEY, next);
        } else if (action === "tabSwitchKey") {
            const next = inList(TAB_SWITCH_KEYS, value) ? value : nextInList(TAB_SWITCH_KEYS, this.getTabSwitchKey());
            this.writeOption(ChatHostBase.KEY_TAB_SWITCH_KEY, next);
        } else if (action === "focusInputKey") {
            const next = inList(FOCUS_INPUT_KEYS, value) ? value : this.getFocusInputKey();
            this.writeOption(ChatHostBase.KEY_FOCUS_INPUT_KEY, next);
        } else if (action === "fontSize") {
            const next = typeof value === "string" && /^\d+$/.test(value) ? value : "";
            this.writeOption(ChatHostBase.KEY_FONT_SIZE, next);
        } else if (action === "notifyBeep") {
            this.writeOption(ChatHostBase.KEY_NOTIFY_BEEP, !this.getNotifyBeep());
        } else if (action === "theme") {
            const next = value === "dark" || value === "light"
                ? value
                : (this.getThemeMode() === "dark" ? "light" : "dark");
            this.writeOption(ChatHostBase.KEY_THEME, next);
        } else {
            this.writeOption(ChatHostBase.KEY_AUTO_LOAD_LAST, !this.getAutoLoadLast());
        }
        this.onViewOptionChanged(action);
    }

    // ========================================================================
    //  屏（VS Code 窗口）：编辑器才干得了的活派给谁
    // ========================================================================

    /** 连着后端、自称打开着哪些文件夹的 VS Code 窗口。 */
    private readonly screens = new ScreenRegistry();
    /** 每个窗口算出来的符号名字（窗口标识 → 名字）：界面以认到这些名字就画成可点的链接。 */
    private readonly symbolNamesByScreen = new Map<string, string[]>();
    /** 页面标识 → 它是哪个窗口领的（插件的网页视图由插件用自己的屏连接去领页面标识）。 */
    private readonly pageScreen = new Map<string, string>();
    /** 窗口标识 → 它最近领的页面标识（窗口重连换新标识时靠它扫干净旧的）。 */
    private readonly screenPage = new Map<string, string>();
    /**
     * 窗口标识 → 它上次在看哪个会话。
     * 插件重连会领一个新的页面标识，基类那本“哪块屏在看哪个会话”的账就断了；
     * 窗口这一层记一份，新页面接上时接着看原来那个（不然窗口会被拨回它工作区的会话）。
     */
    private readonly screenSession = new Map<string, string>();
    /** 最近一次问某个窗口“编辑器里开着哪些文件”的是哪块屏（回话要回给问的那块）。 */
    private readonly fileListAsker = new Map<string, string>();

    /** 屏的登记簿（网页服务拿它做死连接巡检、写心跳）。 */
    public getScreens(): ScreenRegistry { return this.screens; }

    public attachScreen(screenId: string, folders: string[], send: (msg: Record<string, unknown>) => void): void {
        this.screens.add(screenId, folders, send);
        // 新窗口（或重连）先把它工作区那摊"会话改动过哪些文件"告诉它：符号表靠这份清单算。
        this.pushSessionFiles(screenId);
    }

    /**
     * 只发一块屏（本机界面或某个页面）：控制器那边"只给动手的那块屏"的消息走这里。
     * 那块屏现在没连着（断线间隙）就丢掉：它连回来时后端会单发一份状态给它。
     */
    protected override postToOneClient(clientId: string, msg: Record<string, unknown>): void {
        if (!clientId) { this.postToWebview(msg); return; }
        this.sendToOneClient(clientId, msg);
    }

    /** 现在连着的每一块屏（本机界面 + 所有页面）：会话列表要一块一块各发一份，走这里。 */
    protected override forEachClient(
        fn: (clientId: string, send: (msg: Record<string, unknown>) => void) => void,
    ): void {
        if (this.hasLocalClient()) { fn(ChatHostBase.LOCAL_CLIENT_ID, (msg) => this.postToLocalClient(msg)); }
        this.broadcaster.forEachChannel((channel) => {
            fn(channel.id, (msg) => { this.broadcaster.sendTo(channel.id, msg); });
        });
    }

    /** 这块屏该用哪个目录：插件的网页视图是它那个窗口打开着的第一个文件夹（浏览器页面没有）。 */
    protected override preferredDirForClient(clientId: string): string {
        const screenId = this.pageScreen.get(clientId);
        if (!screenId) { return ""; }
        return this.screens.get(screenId)?.folders[0] ?? "";
    }

    /** 某块屏看的会话变了：在窗口那一层也记一份（窗口重连换了页面标识后接着看原来那个）。 */
    protected override onClientSessionChanged(clientId: string, panelId: string): void {
        const screenId = this.pageScreen.get(clientId);
        if (screenId) { this.screenSession.set(screenId, panelId); }
    }

    public detachScreen(screenId: string): void {
        this.screens.remove(screenId);
        this.symbolNamesByScreen.delete(screenId);
        // 页面与窗口的对应表清掉（screenSession 留着：窗口重连的间隙里还得靠它接上原来那个会话）
        const pageId = this.screenPage.get(screenId);
        if (pageId) { this.pageScreen.delete(pageId); this.screenPage.delete(screenId); }
        this.pushSymbolNames();
    }

    public processScreenMessage(msg: any, screenId: string): unknown {
        if (!this.screens.get(screenId)) { return undefined; }
        switch (msg?.type) {
            case "active":
                // 窗口切到前台：同一个目录开着好几个窗口时，活归最近在用的那个。
                this.screens.markActive(screenId);
                return undefined;
            case "symbolSet": {
                const names = Array.isArray(msg.names)
                    ? msg.names.filter((n: unknown): n is string => typeof n === "string") : [];
                this.symbolNamesByScreen.set(screenId, names);
                this.pushSymbolNames();
                return undefined;
            }
            case "files": {
                // 窗口报“编辑器里开着这些文件”：回给问的那块屏（# 引用列表用）。
                const files = Array.isArray(msg.files) ? msg.files : [];
                const asker = this.fileListAsker.get(screenId);
                if (asker) { this.postToOneClient(asker, { type: "openFiles", files }); }
                else { this.postToWebview({ type: "openFiles", files }); }
                return undefined;
            }
            case "newPage": {
                // 插件也要一块"页面"（它的网页视图要走 /api + /events）：后端发它一个标识。
                const id = `p-${crypto.randomUUID()}`;
                this.broadcaster.markIssued(id);
                // 记下这个页面是哪个窗口的：窗口里的网页视图头一次连上要按窗口的工作区挑会话，
                // 窗口重连换了新标识时也要接着看原来那个会话。
                this.pageScreen.set(id, screenId);
                this.screenPage.set(screenId, id);
                const remembered = this.screenSession.get(screenId);
                if (remembered) { this.adoptClientSession(id, remembered); }
                return { pageId: id };
            }
            case "failed":
                // 窗口没干成（文件找不到之类）：VS Code 那边自己弹过提示了，这里留一行日志。
                this.onNotice(typeof msg.note === "string" ? msg.note : "VS Code 窗口没能完成这件事。");
                return undefined;
            default:
                return undefined;
        }
    }

    /** 现在这个会话在哪个目录（解相对路径、挑窗口都按它）。 */
    protected activeCwd(): string { return this.getActive()?.cwd ?? this.getCwd(); }

    /**
     * 把一件"只有编辑器干得了"的活派给打开着这个目录的窗口。
     * 一个都没开着就什么都不做（用户定的规矩：不把文件开在别的工程里，也不到处弹窗），
     * 只记一行日志：不然"点了没反应"没人查得出来。
     */
    protected routeToScreen(kind: string, payload: Record<string, unknown>, what: string): boolean {
        const cwd = this.activeCwd();
        const screen = this.screens.pick(cwd);
        if (!screen) {
            this.onNotice(`这台机器上没有打开 ${cwd} 的 VS Code 窗口，这件事（${what}）没人做。`);
            return false;
        }
        screen.send({ kind, cwd, ...payload });
        return true;
    }

    /** 目录落在这些文件夹里的会话读写过哪些文件（一个窗口只该管它自己工作区那摊）。 */
    private sessionFilesForFolders(folders: readonly string[]): string[] {
        const set = new Set<string>();
        for (const rt of this.panels.values()) {
            if (!dirInsideFolders(rt.cwd, folders)) { continue; }
            for (const f of rt.getKnownFiles()) { set.add(f); }
        }
        return Array.from(set);
    }

    /** 把当前会话触及的文件清单推给某个窗口（它拿这份清单去算符号表）。 */
    private pushSessionFiles(screenId: string): void {
        const screen = this.screens.get(screenId);
        if (!screen) { return; }
        screen.send({ kind: "sessionFiles", files: this.sessionFilesForFolders(screen.folders) });
    }

    /** 所有窗口算出的符号名字并集推给界面（名字变过就重推一遍）。 */
    private pushSymbolNames(): void {
        const set = new Set<string>();
        for (const names of this.symbolNamesByScreen.values()) {
            for (const name of names) { set.add(name); }
        }
        this.postToWebview({ type: "symbolSet", names: Array.from(set) });
    }

    // ---- 编辑器才有的那几样：都派给窗口（子类可以覆写成"就在本地干"）----
    public openFileLocation(p: string, line: number, _anchor?: string): void {
        this.routeToScreen("openFileAt", { path: p, line }, `打开 ${p}`);
    }

    protected openFileFromWebview(p: string, line?: number, col?: number): void {
        this.routeToScreen("openFile", {
            path: p,
            line,
            col,
            knownFiles: this.getActive()?.getKnownFiles() ?? [],
        }, `打开 ${p}`);
    }

    protected sendFileList(): void {
        const asker = this.currentPageId;
        const cwd = this.activeCwd();
        const screen = this.screens.pick(cwd);
        // 没人开着这个工作区就回个空的：界面上的 # 引用列表宁可空着，也别一直等。
        if (!screen) {
            this.onNotice(`这台机器上没有打开 ${cwd} 的 VS Code 窗口，这件事（列编辑器里打开着的文件）没人做。`);
            this.postToOneClient(asker, { type: "openFiles", files: [] });
            return;
        }
        // 这块屏问的：窗口把文件清单报回来时只回给它（同一个后端可能好几块屏各问各的）
        this.fileListAsker.set(screen.id, asker);
        screen.send({ kind: "listFiles", cwd });
    }

    /** 会话触及的文件变了：重新推给各个窗口（它们的符号表要跟着更新）。 */
    protected override onKnownFilesChangedByHost(): void {
        for (const screen of this.screens.list()) { this.pushSessionFiles(screen.id); }
    }

    // ========================================================================
    //  平台消息：两家都要的那部分（子类要接别的类型，覆写 handleHostMessage）
    // ========================================================================

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
                if (pageId && pageId !== ChatHostBase.LOCAL_CLIENT_ID
                    && lastSeq >= 0 && this.broadcaster.catchUp(pageId, lastSeq)) {
                    // 补发的是断线前的老消息（里面可能有那个会话被关掉之前的内容）：
                    // 补完再给它一份最新的会话列表，“已经不存在的会话”就不会在它上面留在那儿。
                    this.sendSessionListTo(pageId);
                    return true;
                }
                // 会话列表先给它（界面上那些会话壳先建起来），再整屏重画。
                this.sendSessionListTo(pageId);
                void this.resyncPage(pageId, "");
                return true;
            }
            case "browserDialogResult":
                this.resolveDialog(msg.id, msg.value);
                return true;
            case "openHistory":
                // 顶条最右边那颗“<<<”按钮（以及命令面板的历史入口）：列表从右侧滑入，
                // 只弹在点它的那块屏上（另一个浏览器 / 本机界面不跟着弹）。
                void this.showHistoryPicker(
                    this.currentPageId !== ChatHostBase.LOCAL_CLIENT_ID,
                    this.currentPageId,
                );
                return true;
            case "openWorkspace":
                // “⋯”菜单里的项目与会话面板：上半是当前工作区的会话，下半是工作区列表。
                void this.showWorkspacePicker(this.currentPageId);
                return true;
            case "workspacePick": {
                // 点了下面某个工作区：只换上半那份会话列表，面板不关。
                if (typeof msg.path === "string") { void this.switchWorkspacePanel(msg.path, this.currentPageId); }
                return true;
            }
            case "workspaceLoadMore":
                // 工作区那块的「加载更多」：再送一批（一次 10 个）。
                void this.loadMoreWorkspaces();
                return true;
            case "newSessionInWorkspace":
                // 面板里「正在对话」那组的「＋ 在 xxx 新建会话」：目录用界面上写着的那一个
                // （面板切过工作区就是那个），而不是顶条上当前会话那个目录（那个是加号用的规则）。
                this.newSessionInDir(
                    typeof msg.path === "string" && msg.path ? msg.path : (this.pickerStateOf(this.currentPageId).workspaceFolder || this.activeCwd()),
                );
                return true;
            case "requestDesktopScreenshot":
                this.sendDesktopScreenshot();
                return true;
            case "openSettingsPanel":
                // 弹设置界面的请求：只回给请求它的那块屏。
                this.sendToOneClient(this.currentPageId, { type: "openSettings" });
                return true;
        }
        return this.handleHostMessage(msg);
    }

    /** 子类接自己的消息类型（VSCode 那边有符号跳转这类只有编辑器才有的）。 */
    protected handleHostMessage(_msg: any): boolean { return false; }

    /**
     * 顶条上那颗“桌面截图”按钮：截一张这台电脑的桌面，只发回请求它的那块屏
     * （别的页面 / 本机界面不跟着弹图）。截屏要一两秒，异步做；截完时请求方已经不在
     * 就白截（送不出去，直接丢）。成功发 desktopScreenshot（图片 base64），
     * 失败发 desktopScreenshotResult（错误文本，界面上弹一句）。
     */
    private sendDesktopScreenshot(): void {
        const target = this.currentPageId;
        void captureDesktopScreenshot().then((result) => {
            const msg = result.ok
                ? { type: "desktopScreenshot", data: result.data, mimeType: result.mimeType }
                : { type: "desktopScreenshotResult", ok: false, error: result.error };
            this.sendToOneClient(target, msg);
        });
    }

    // ========================================================================
    //  弹窗 / 会话收尾
    // ========================================================================
    /** 确认框：先问正在看这个会话的那块屏，再问“人最近在动”的那块屏；挑不出来时交给子类兜底。 */
    public async confirmDialog(title: string, message: string, sessionId?: string): Promise<boolean> {
        const answer = await this.askPage("confirm", { title, message }, sessionId);
        return answer === undefined ? this.confirmDialogFallback(title, message) : answer === true;
    }

    /** 输入框：同上（先问看着这个会话的屏）；问不着时交给子类兜底。 */
    public async inputDialog(title: string, placeholder: string, prefill: string, sessionId?: string): Promise<string | undefined> {
        const answer = await this.askPage("prompt", { title, placeholder, prefill }, sessionId);
        if (answer === undefined) { return this.inputDialogFallback(title, placeholder, prefill); }
        if (answer === null) { return undefined; }  // 用户按了取消
        return String(answer);
    }

    /** 选项列表：先问页面（样式与模型选择器一致）；问不着时交给子类兜底。 */
    public async selectDialog(title: string, options: string[], sessionId?: string): Promise<string | undefined> {
        const target = this.pickDialogClient(sessionId) ?? this.pickDialogClient() ?? this.pageForDialogFallback();
        if (target) {
            const items = options.map((option, index) => ({ label: option, file: String(index) }));
            const choice = await this.showPicker("browserSelect", items, null, { title }, target);
            const index = Number(choice && typeof choice.file === "string" ? choice.file : NaN);
            if (Number.isInteger(index) && index >= 0 && index < options.length) { return options[index]; }
            // 浮层开在页面上的时候，页面那头就是全部答案来源（用户点了取消也在这里）；
            // 没挑着屏时才落到子类的兜底上。
            return undefined;
        }
        return this.selectDialogFallback(title, options);
    }

    /** 确认框问不着页面时的兜底（VSCode 弹原生框；独立后端没屏可问就按“否”）。 */
    protected async confirmDialogFallback(_title: string, _message: string): Promise<boolean> { return false; }
    /** 输入框问不着页面时的兜底。 */
    protected async inputDialogFallback(_title: string, _placeholder: string, _prefill: string): Promise<string | undefined> { return undefined; }
    /** 选项列表问不着页面时的兜底。 */
    protected async selectDialogFallback(_title: string, _options: string[]): Promise<string | undefined> { return undefined; }

    /** 回滚确认：危险动作，默认走确认框那条路（VSCode 那边覆写成原生警告框）。 */
    public async confirmRevert(label: string, sessionId?: string): Promise<boolean> {
        return this.confirmDialog(
            "回滚修改",
            `${label} 在此次修改后又被变更过，回滚将丢弃那些后续变更。确定继续？`,
            sessionId,
        );
    }

    /** 停掉本工作区的所有 pi 进程（宿主收摊时用；页面与界面的生死与此无关）。 */
    protected disposeAllConversations(): void {
        for (const rt of this.panels.values()) {
            rt.stopClient();
            this.releasePanelName(rt.nameParts);
        }
        this.panels.clear();
        this.forgetAllClients();
        this.disposeSpare();
    }
}

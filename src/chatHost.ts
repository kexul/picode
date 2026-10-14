/**
 * 独立后端的宿主：一份会话工作区（{@link ChatControllerBase} 那套：标签、会话进程、消息分发）
 * 挂在它上面，接住所有连上来的浏览器页面（手机 / 电脑浏览器，可以同时开着好几个）。
 *
 * 这里装做的事：
 *   - "好几块屏"的出口：网页服务接进来的浏览器页面；
 *   - 页面连接的登记、推送序号、断线补发、整屏重画；
 *   - 浮层（历史列表、模型选择、确认框）该弹在哪块屏上，以及对话框的收发；
 *   - 显示选项（界面颜色、字号、快捷键、提醒开关）的读写：候选值与默认值在 viewOptions.ts，
 *     值存 state.json（界面改的），配置文件里也能预设一份；
 *   - 名字池、# 引用目录、桌面截图这类杂事；
 *   - 跟这台机器有关的那几件：设置从 `~/.pi/pichat/config.json` 读、默认工作目录就是起后端时
 *     指定的那个、弹窗只有页面可问（问不着就按“否 / 取消”，宁可不动也不乱来）、
 *     编辑器才有的活（点开文件、符号跳转）派给连上来的 VS Code 窗口。
 *
 * 本类不引用 `vscode`。插件那一侧是纯客户端（跟浏览器页面一样，走 HTTP 连后端），不继承这份。
 */
import * as crypto from "crypto";
import type { AskRequest } from "./askProtocol";
import { writeAskAnswer } from "./askProtocol";
import type { MessageSink } from "./sessionRuntime";
import { ChatControllerBase } from "./chatControllerBase";
import { ServerStateStore } from "./serverState";
import { readServerConfig, updateServerConfig, type ServerConfig } from "./serverConfig";
import { getAskAssets, getTabaAssets } from "./bridgeAssets";
import { serverConfigFile, serverStateFile } from "./serverPaths";
import {
    listProjectDirs,
    listSessionFiles,
    readProjectEntry,
} from "./sessionStore";
import { listDirectories } from "./dirBrowse";
import { ChatBroadcaster } from "./chatBroadcaster";
import { MessageBuffer } from "./webTransport";
import { pickOverlayClient } from "./overlayTarget";
import { ScreenRegistry } from "./screenRegistry";
import { dirInsideAny, dirKey } from "./pathRules";
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

/**
 * 一张还等着的问话卡片：模型问的选择题（ask_choice）、扩展问的确认 / 输入 / 选一个。
 * 卡片画在那个会话的消息流里（不再弹浮层），这里记的是发给了哪些屏、答案交给谁。
 */
interface OpenCard {
    /** 哪个会话在问：卡片画在那个会话的消息流里；哪块屏切到这个会话，卡片就补发给它。 */
    sessionId?: string;
    /** 卡片内容（界面上怎么画，见 media/chat.js 的 renderAskCard）。 */
    card: Record<string, unknown>;
    /** 提问方的编号（ask_choice 那次提问的编号）：扩展不等了时靠它认领这张卡片。 */
    srcId: string;
    /** 现在还挂着这张卡片的屏（答了 / 断开了就摘掉）。 */
    screens: Set<string>;
    /** 一块屏都不剩（都断开了）时还等不等：问答题等（切回来还能答），扩展问的那些不等。 */
    hangOn: boolean;
    /** 答案已经定了（有人答了 / 到点了 / 没人能答了）。 */
    settled: boolean;
    /** 到点就按没作答收掉。 */
    timer?: ReturnType<typeof setTimeout>;
    /** 把答案交出去（undefined = 没作答）。 */
    settle: (answer: any | undefined) => void;
}

export interface ChatHostOptions {
    /** 默认工作目录（会话默认跑在这里）。 */
    cwd: string;
    /** 日志出口（默认打标准输出）。 */
    log?: (text: string) => void;
}

export class ChatHost extends ChatControllerBase implements WebServerHost {
    /** 文件夹列表里“就用这个目录”那一行的标识（会话文件、目录都是绝对路径，撞不上这种带 \0 的）。 */
    private static readonly USE_DIR_ROW = "\u0000pichat:use-dir";
    /** 文件夹列表里“换一个盘 / 回到最上层”那一行的标识。 */
    private static readonly ROOTS_ROW = "\u0000pichat:roots";

    // ---- 浏览器页面（接在本工作区上的“额外的屏”，可以有多个）----
    /** 页面连接登记簿 + 推送序号：所有浏览器页面共用同一份会话的出口。 */
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
    /** 还等着的问话卡片：卡片编号（宿主自己发）→ 这一摊。 */
    private readonly openCards = new Map<string, OpenCard>();
    /** 卡片编号发到几了（界面上只拿它认领"哪张卡"、并把答案送回来）。 */
    private cardSeq = 0;
    // 正在处理哪一个来源发来的消息，以及“每块屏各自在看哪个会话”，都在基类里管
    // （见 ChatControllerBase.currentPageId / clientSessions）：本类只管“屏”这一层。
    // ---- 显示选项的键（值存在 state.json；配置文件里也能预设，见 configPreset）----
    private static readonly KEY_AUTO_LOAD_LAST = "piChat.autoLoadLastSession";
    private static readonly KEY_SEND_KEY = "piChat.sendKey";
    private static readonly KEY_NEW_SESSION_KEY = "piChat.newSessionKey";
    private static readonly KEY_TAB_SWITCH_KEY = "piChat.tabSwitchKey";
    private static readonly KEY_FOCUS_INPUT_KEY = "piChat.focusInputKey";
    private static readonly KEY_FONT_SIZE = "piChat.fontSize";
    private static readonly KEY_NOTIFY_BEEP = "piChat.notifyBeep";
    private static readonly KEY_THEME = "piChat.themeMode";

    /** 会话显示名用的名字池：panel 关闭后会释放对应名字。 */
    private readonly usedChatNames = new Set<string>();

    /** 「项目与会话」面板那份列表的指纹（开着的会话 + 各自的会话文件）：变了就重推一次，见 broadcastSessionList。 */
    private workspacePanelKey = "";

    // ---- 后端进程这一层：设置与显示选项存哪、日志出口、收没收摊 ----
    private readonly state: ServerStateStore;
    private readonly log: (text: string) => void;
    private disposed = false;

    constructor(private readonly options: ChatHostOptions) {
        super("server");
        this.log = options.log ?? ((text) => console.log(text));
        this.state = new ServerStateStore(serverStateFile());
    }

    // ========================================================================
    //  这一个宿主自己的那几件：读写存哪、提示写哪、弹窗问谁、编辑器那点活派给谁
    // ========================================================================

    /** 读一个显示选项：先看 state.json（界面改的），再看配置文件里预设的，最后才用内置默认值。 */
    protected readOption<T>(key: string, fallback: T): T {
        // 这里取原始值，不传 fallback 给底层做类型校验：类型不对要“回落到配置文件预设”，
        // 而底层只会在类型不符时还给 fallback。取值合不合法由各自的读取器（inList / 正则）盯。
        const stored = this.state.all()[key];
        if (stored !== undefined) { return stored as T; }
        const preset = this.configPreset(key);
        return (preset === undefined ? fallback : preset) as T;
    }

    /** 写一个显示选项（立即写盘）。 */
    protected writeOption(key: string, value: unknown): void {
        this.state.update(key, value);
    }

    /** 显示选项在配置文件里的对应项（人不进界面就能改默认值）。 */
    private configPreset(key: string): unknown {
        const cfg: ServerConfig = readServerConfig().config;
        switch (key) {
            case ChatHost.KEY_THEME: return cfg.themeMode;
            case ChatHost.KEY_FONT_SIZE: return cfg.fontSize;
            case ChatHost.KEY_SEND_KEY: return cfg.sendKey;
            case ChatHost.KEY_NEW_SESSION_KEY: return cfg.newSessionKey;
            case ChatHost.KEY_TAB_SWITCH_KEY: return cfg.tabSwitchKey;
            case ChatHost.KEY_FOCUS_INPUT_KEY: return cfg.focusInputKey;
            case ChatHost.KEY_NOTIFY_BEEP: return cfg.notifyBeep;
            case ChatHost.KEY_AUTO_LOAD_LAST: return cfg.autoLoadLast;
            default: return undefined;
        }
    }

    /** 给用户一条普通提示：后端这边写日志。 */
    protected onNotice(text: string): void {
        this.log(`[提示] ${text}`);
    }

    /**
     * 人最近动过的那块屏挑不出来时的兜底：随便挑一块连着的屏。
     * 手机上刚打开页面、还没做过任何动作时，也需要有人来答“要不要执行这条命令”。
     */
    protected pageForDialogFallback(): string | undefined {
        return this.getBroadcaster().recentPage()?.id;
    }

    // ---- RuntimeHost：配置 / 默认目录 / 模型 ----
    public getConfig() {
        const cfg = readServerConfig().config;
        const taba = cfg.tabaEnabled ? getTabaAssets() : undefined;
        const ask = getAskAssets();
        return {
            piPath: cfg.piPath,
            provider: cfg.provider,
            model: cfg.model,
            extraArgs: cfg.extraArgs,
            trustProject: cfg.trustProject,
            tabaExtension: taba?.ok ? taba.extensionPath : "",
            tabaDir: taba?.ok ? taba.resourceDir : "",
            askExtension: ask?.ok ? ask.extensionPath : "",
            askDir: ask?.ok ? ask.resourceDir : "",
        };
    }

    public getCwd(): string {
        return this.options.cwd;
    }

    public persistModel(provider: string, modelId: string): void {
        updateServerConfig({ provider, model: modelId });
    }

    protected piMissingMessage(piPath: string): string {
        return `未找到 pi 可执行文件（当前配置："${piPath}"）。请确认已安装 pi 并加入系统 PATH，`
            + `或改 ${serverConfigFile()} 里的 piPath。`;
    }

    protected onPiMissing(piPath: string): void {
        this.log(`[错误] ${this.piMissingMessage(piPath)}`);
    }

    // ========================================================================
    //  出口：一条消息送去哪几块屏
    // ========================================================================

    /** 把一条消息送到所有界面：所有连着的浏览器页面。 */
    protected postToWebview(msg: Record<string, unknown>): void {
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
     * 人最近在动的那一块屏。“最近”只看人做的动作，报活不算。
     */
    protected override pickOverlayTarget(): string {
        return pickOverlayClient(this.broadcaster.recentActionPage(), this.broadcaster.recentPage()?.id);
    }

    /** 浮层消息的出口：只发给挑好的那一块屏，别的屏收不到。 */
    protected override sendOverlayTo(target: string, msg: Record<string, unknown>): boolean {
        return this.sendToOneClient(target, msg);
    }

    /** 只发给某一块屏；那块屏不在就返回 false。 */
    protected sendToOneClient(target: string, msg: Record<string, unknown>): boolean {
        if (!target) { return false; }
        return this.broadcaster.sendTo(target, msg);
    }

    /**
     * 浮层（拾取器）只发给挑好的那一块屏：在哪个屏上点开就弹在哪个屏，别的屏不受影响。
     * 挑不出屏（一个页面都没有）直接按取消。
     */
    protected override async showPicker(
        kind: string,
        items: any[],
        current?: string | null,
        echo?: Record<string, unknown>,
        target?: string,
        timeoutMs?: number,
    ): Promise<any | undefined> {
        // 调用方指定了弹给哪块屏就用它（模型选择器这种“点它的人自己要看”）；不然现挑“人最近在动的那一块”
        const to = target ?? this.pickOverlayTarget();
        if (!to) { return Promise.resolve(undefined); }
        return this.openPicker(kind, { items, current: current ?? null, ...(echo || {}) }, to, timeoutMs);
    }

    // ========================================================================
    //  项目 / 文件夹拾取器（手机上“在另一个项目里开新会话”走这条路）
    // ========================================================================

    /** 工作区一次给几个（当前工作区固定占一行，其余再取四行，总数五个）。 */
    private static readonly WORKSPACE_BATCH = 4;

    /** 「项目与会话」面板里一个工作区展开后一次给几条会话（末尾一颗「加载更多」接着加）。 */
    private static readonly GROUP_PAGE_SIZE = 5;

    /**
     * “项目与会话”面板：上半是所有工作区的会话（混一份，最近聊过的在最前面），
     * 下半是工作区（用 pi 跑过会话的目录）。
     * 点会话才关掉面板切过去；工作区那两行只是说明哪个目录里有多少会话，
     * 行尾那颗加号在那个目录里开新会话，标题右边那颗加号走原来的逛文件夹那条路。
     * 面板那一摊数据按屏存（见 pickerStateOf）：两个窗口各自开着互不影响。
     */
    public async showWorkspacePicker(target?: string): Promise<void> {
        const clientId = target || this.currentPageId;
        const payload = await this.buildWorkspacePanel(clientId);
        const choice = await this.openPicker("workspace", payload, clientId);
        if (!choice || typeof choice.file !== "string") { return; }
        // 目录是那一行自己带过来的（列表里混着好几个目录的会话）
        await this.openWorkspaceSession(choice.file, typeof choice.cwd === "string" ? choice.cwd : undefined, clientId);
    }

    /**
     * 常驻那一列（宽窗下的「项目与会话」，见 README）：面板一直开着、不当浮层，
     * 所以推过去就完事、不等谁选（界面那边收到就画在自己那一列里，收起也是它自己说了算）。
     * 行点击各走各的消息（workspaceOpenSession / workspaceBrowse / newSessionInWorkspace）。
     *
     * 别的浮层（选模型、逛文件夹）正开着也照样推：这一列与浮层各画各的，谁也不顶谁。
     */
    private async showDockedWorkspacePanel(clientId: string): Promise<void> {
        const st = this.pickerStateOf(clientId);
        const payload = await this.buildWorkspacePanel(clientId);
        // 这一份是“推过去就不管了”的：它画在界面右边那一列里，不是浮层拾取器，
        // 所以没有等谁选、也没有超时（行点击各走各的消息，见上面那几个消息）。
        // 宿主这份状态照旧记着：“加载更多”、会话增减后重推都要用它。
        // 这里不动 st.kind：常驻那一列开着的时候，上面还能再开别的浮层（各归各的）。
        st.workspaceOpen = true;
        st.workspaceDock = true;
        this.sendOverlayTo(clientId, { type: "picker", kind: "workspace", dock: true, ...payload });
    }

    /**
     * 会话被新建 / 被关掉后，给还开着面板的屏重推一份（面板是“打开那一刻算一次”的快照：
     * 点了加号新建出来的会话会立刻出现在上半「正在对话」里，下半「历史会话」得重算才对得上）。
     * 收起过的常驻那一列也在名单里：推过去时界面自己知道没开，会丢掉（见 media/chat.js）。
     */
    private async refreshWorkspacePanels(): Promise<void> {
        for (const { clientId, dock } of this.workspacePanelClients()) {
            const payload = await this.buildWorkspacePanel(clientId);
            const st = this.pickerStateOf(clientId);
            if (!st.workspaceOpen) { continue; }   // 画的功夫里面板又被收了
            this.sendOverlayTo(clientId, { type: "picker", kind: "workspace", dock, ...payload });
        }
    }

    /**
     * 会话列表推送（新建 / 关掉 / 改名 / 模型变化都会走这里）：顺手看看「项目与会话」
     * 面板开着的话要不要重算。
     *
     * 只在“开着的会话 + 各自落在哪个会话文件上”这份指纹变了的时候才重算
     * （新建出来的会话第一次落盘、会话被关掉）；改名、切会话、跑起来这些推送不动它。
     */
    public override broadcastSessionList(immediate = false): void {
        super.broadcastSessionList(immediate);
        const key = Array.from(this.panels.values())
            .map((rt) => `${rt.id}:${rt.currentSessionPath || ""}`)
            .sort()
            .join("|");
        const changed = this.workspacePanelKey !== "" && key !== this.workspacePanelKey;
        this.workspacePanelKey = key;
        if (changed) { void this.refreshWorkspacePanels(); }
    }

    /** 面板里点了一行会话：切过去（要不要关面板是界面的事：常驻那一列不关）。
     *  目录用那一行自己带过来的（列表里混着好几个目录的会话）。 */
    private async openWorkspaceSession(file: string, folder: string | undefined, clientId: string): Promise<void> {
        const cwd = folder || this.getActive(clientId)?.cwd || this.getCwd();
        await this.loadHistorySession(file, cwd, clientId);
    }

    /** 面板里点了“打开文件夹…”（工作区标题右边那颗加号）：走原来逛文件夹那条路（挑一个目录、就在那里新建会话）。 */
    private async browseFromWorkspacePanel(clientId: string): Promise<void> {
        await this.showFolderPicker(this.getActive(clientId)?.cwd ?? this.getCwd(), clientId);
    }

    /**
     * 面板的内容：上半是所有目录混一份的会话（最近聊过的在前），下半是工作区。
     * 会话那份复用历史列表那套机器（pickerState 里的 historyFiles / historyOffset / scanHistoryBatch），
     * 工作区那份自己分页：当前工作区固定显示，另外一次取 4 个，总共显示 5 个工作区；下面留一颗“加载更多”。
     *
     * 两半都只碰最前面那几个（要显示的那些）：会话那份只扫要画的十个文件，
     * 工作区那份先只拿“目录清单”（每个目录 stat 一下），进目录里翻文件留到真要画它那一行（见 takeWorkspacePage）。
     */
    private async buildWorkspacePanel(clientId: string): Promise<Record<string, unknown>> {
        const state = this.pickerStateOf(clientId);
        // 每个目录 readdir 一下 + stat 最新那一个会话文件（见 sessionStore.listProjectDirs）
        state.workspaceDirs = await listProjectDirs();
        state.workspaceOffset = 0;
        state.workspaceSeen = new Set();
        return {
            title: "项目与会话",
            spaces: {
                items: await this.takeWorkspacePage(clientId),
                hasMore: state.workspaceOffset < state.workspaceDirs.length,
            },
        };
    }

    /**
     * 面板里展开某个工作区（或那一组点「加载更多」）：读那个目录，从 offset 接着扫一批会话发回去。
     *
     * offset 是“第几个文件”，由界面带着来回（跳过子会话之后，屏幕上看到的条数不等于扫过的文件数）：
     * 宿主这边不留状态，面板重推一份时自然就从每组的第一条重新开始。
     */
    private async sendWorkspaceSessions(dir: string, offset: number): Promise<void> {
        const clientId = this.currentPageId;
        if (!dir) { return; }
        const files = (await listSessionFiles(dir)).map((e) => e.file);
        const page = await this.scanSessionPage(files, offset, ChatHost.GROUP_PAGE_SIZE);
        const current = this.getActive(clientId)?.currentSessionPath;
        this.sendOverlayTo(clientId, {
            type: "workspaceSessionsPage",
            path: dir,
            offset,
            items: page.items.map((s) => ({ ...s, current: this.samePath(s.file, current) })),
            nextOffset: page.nextOffset,
            hasMore: page.hasMore,
        });
    }

    /**
     * 取下一批工作区行（一次 WORKSPACE_BATCH 个）。
     * 到这里才真进目录（readdir + 读一个会话文件的开头）—— 只对真要显示的那几行做。
     */
    private async takeWorkspacePage(clientId: string): Promise<any[]> {
        const state = this.pickerStateOf(clientId);
        const rows: any[] = [];
        while (rows.length < ChatHost.WORKSPACE_BATCH && state.workspaceOffset < state.workspaceDirs.length) {
            const entry = state.workspaceDirs[state.workspaceOffset++];
            const p = await readProjectEntry(entry);
            if (!p) { continue; }                                // 空目录 / 坏文件：跳过，不占一行
            const key = dirKey(p.cwd);
            if (state.workspaceSeen.has(key)) { continue; }       // 当前工作区另有上面那一行；同一个目录只占一行
            state.workspaceSeen.add(key);
            rows.push({
                label: p.name,
                file: p.cwd,
                folderPath: p.cwd,
                count: p.sessionCount,
                lastActivity: p.lastActivity,
            });
        }
        return rows;
    }

    /** 面板里点工作区那块的「加载更多」：再送一批过去。 */
    public async loadMoreWorkspaces(): Promise<void> {
        const clientId = this.currentPageId;
        const state = this.pickerStateOf(clientId);
        if (!state.workspaceOpen) { return; }
        const items = await this.takeWorkspacePage(clientId);
        this.sendOverlayTo(clientId, {
            type: "workspacePageAppend",
            items,
            hasMore: state.workspaceOffset < state.workspaceDirs.length,
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
        const listing = await listDirectories(dir);
        // 判"这是盘符列表"只认空路径：dirBrowse 把盘根（D:\）也标成 roots，
        // 但那是个真目录（可以选它当项目目录，也是上一层能到的地方），不能跟盘符列表混为一谈。
        const driveList = !listing.path;
        const items: any[] = [];
        // 这个目录列不出来（没了 / 没权限）时不给"就用这个目录"：pi 在那里也跑不起来，
        // 只留一条退回去的路，人自己往上走。
        if (!driveList && !listing.error) {
            items.push({
                label: "就用这个目录（在这里新建会话）",
                file: ChatHost.USE_DIR_ROW,
                folderPath: listing.path,
                icon: "check",
            });
        }
        if (listing.parent) {
            items.push({ label: "上一层", file: listing.parent, icon: "up" });
        } else if (!driveList) {
            // 到了盘根就没法再往上：给一条回到盘符列表的路，否则换不了盘。
            items.push({ label: "回到最上层（换一个盘）", file: ChatHost.ROOTS_ROW, icon: "up" });
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
        if (choice.file === ChatHost.USE_DIR_ROW) {
            this.newSessionInDir(listing.path, { clientId });
            return;
        }
        if (choice.file === ChatHost.ROOTS_ROW) {
            await this.showFolderPicker("", clientId);
            return;
        }
        await this.showFolderPicker(choice.file, clientId);
    }

    // ========================================================================
    //  消息分发（页面发来的与 ready 统一走这里）
    // ========================================================================

    /**
     * 界面就绪（某个浏览器页面发来 ready）：把已有的对话整屏重画一遍——
     * 工作区里可能已经有别的屏聊出来的内容（比如手机上先开的对话）。
     */
    protected override onWebviewReady(): void {
        this.broadcastChatReferences();
        void this.resyncPage(this.currentPageId, "页面已重新连接（{count} 条消息，pi 进程与上下文原样保留）。");
    }

    // ========================================================================
    //  浏览器页面（WebServerHost）：网页服务接进来的那些“额外的屏”
    // ========================================================================

    /** 页面连接的登记簿 + 推送序号（网页服务开连接 / 收发消息时用）。 */
    public getBroadcaster(): ChatBroadcaster { return this.broadcaster; }

    /**
     * 页面发来一条消息（网页服务的 /api POST 转交）。
     * 处理期间记下是哪块屏发来的，浮层才知道该回给谁。
     */
    public processPageMessage(msg: any, pageId: string): void {
        // 不是对象、没有 type 的，一律不当消息处理（脏请求挡在这一层，别丢给分发逻辑去 switch）
        if (!msg || typeof msg.type !== "string") { return; }
        const previous = this.currentPageId;
        this.currentPageId = pageId;
        try {
            this.processMessage(msg);
        } finally {
            this.currentPageId = previous;
        }
    }

    /** 一条推送连接建立（页面连上 / 重连）：把等着的重画补上，再把攒着的消息冲出去。 */
    public onPageConnected(pageId: string): void {
        // 这条连接是新的，旧那条上"卡片已送到"的记录不再作数：手机锁屏之后旧连接常常是
        // 悄悄死的（网络那头把会话收了，浏览器不报错），卡片写进去看着成功、对方其实没收到；
        // 页面重开一条连接回来时，这边也没法知道它手里到底有哪几张卡片。
        // 先把它从还等着的卡片上摘掉，对账时按"它还没有"重发一遍（见 browserResync 与 resyncPage）——
        // 页面上真画着的那张收到同一张会原地不动（见 media/chat.js 的 renderAskCard）。
        this.forgetCardDelivery(pageId);
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

    /** 一条推送连接断了（页面关掉 / 死连接被掐掉）：它上面等着的问话卡片摘掉，
     *  它上面开着的浮层也按取消收掉（等的人不用干等）。 */
    public onPageDisconnected(pageId: string): void {
        this.dropCardsForClient(pageId);
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
        this.outbox.clear();
        this.pendingResyncPages.clear();
        this.resyncingPages.clear();
    }

    /** 这块屏换了新连接：它原来那条连接上"卡片已送到"的记录清掉（见 onPageConnected）。 */
    private forgetCardDelivery(target: string): void {
        if (!target) { return; }
        for (const state of this.openCards.values()) { state.screens.delete(target); }
    }

    /** 这块屏没了：它上面等着的问话卡片都摘掉（问答题留着等它回来，扩展问的那些算没作答）。 */
    private dropCardsForClient(target: string): void {
        if (!target) { return; }
        for (const [id, state] of Array.from(this.openCards.entries())) {
            if (!state.screens.delete(target)) { continue; }
            if (state.screens.size === 0 && !state.hangOn) { this.settleCard(id, undefined); }
        }
    }

    /** 有没有正在看这个会话、能把卡片画给它的屏（没人的话调用方换自己的兜底办法）。 */
    private hasCardViewer(sessionId?: string): boolean {
        return !!sessionId && this.clientsViewing(sessionId).length > 0;
    }

    /**
     * 把已有的对话整屏重画一遍：界面刚就绪、或页面重连后补发补不上（缺得太多）时用它。
     *
     * 只画给发消息来的那一块屏——手机重连时，电脑那边的页面不该跟着白闪一下，
     * 更不该把正在生成的半句话清掉。
     * @param pageId 要重画给哪一块屏（页面标识）。
     * @param note 重画后给的一行提示；空串表示不给。
     */
    private resyncPage(pageId: string, note: string): Promise<void> {
        if (pageId && !this.broadcaster.hasPage(pageId)) {
            // 页面的重画请求到得比它的推送连接还早（刚刷新的那一瞬间）：现在送也是白送，
            // 先记下来，它一连上就画（见 onPageConnected）。
            this.pendingResyncPages.set(pageId, note);
            return Promise.resolve();
        }
        // 只发给这一块屏；拿不到出口（理论上不会）就退回广播：宁可多画一次，也不能让界面缺内容
        const sink: MessageSink | undefined = pageId
            ? ((msg) => { this.broadcaster.sendTo(pageId, msg); })
            : undefined;
        if (pageId) { this.resyncingPages.add(pageId); }
        const replays: Array<Promise<void>> = [];
        for (const rt of this.panels.values()) {
            // 刚建的空会话不用重画：newSession 已经把它需要的东西发过去了
            if (rt.isConversationEmpty()) { continue; }
            replays.push(rt.replayHistory({ note, sink }));
        }
        return Promise.all(replays).then(() => {
            // 重画把还等着的问话卡片也抹掉了：重发给这块屏（见 resendCardsTo）
            this.resendCardsTo(pageId, true);
            // 重画的消息不带序号（它们只发给这一块屏）。页面重画完把对齐到当前序号：
            // 重画的内容已经包含到这里为止的一切，下次重连它报上来的数才是准的。
            if (pageId) { this.broadcaster.sendTo(pageId, { type: "syncPoint", seq: this.broadcaster.currentSeq() }); }
        }).finally(() => {
            if (pageId) { this.resyncingPages.delete(pageId); }
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
    //  显示选项（候选与默认值在 viewOptions.ts，值存在 state.json）
    // ========================================================================

    protected getAutoLoadLast(): boolean {
        return this.readOption<boolean>(ChatHost.KEY_AUTO_LOAD_LAST, DEFAULT_AUTO_LOAD_LAST);
    }
    public getSendKey(): string {
        const v = this.readOption<string>(ChatHost.KEY_SEND_KEY, DEFAULT_SEND_KEY);
        return inList(SEND_KEYS, v) ? v : DEFAULT_SEND_KEY;
    }
    public getNewSessionKey(): string {
        const v = this.readOption<string>(ChatHost.KEY_NEW_SESSION_KEY, DEFAULT_NEW_SESSION_KEY);
        return inList(NEW_SESSION_KEYS, v) ? v : DEFAULT_NEW_SESSION_KEY;
    }
    public getTabSwitchKey(): string {
        const v = this.readOption<string>(ChatHost.KEY_TAB_SWITCH_KEY, DEFAULT_TAB_SWITCH_KEY);
        return inList(TAB_SWITCH_KEYS, v) ? v : DEFAULT_TAB_SWITCH_KEY;
    }
    public getFocusInputKey(): string {
        const v = this.readOption<string>(ChatHost.KEY_FOCUS_INPUT_KEY, DEFAULT_FOCUS_INPUT_KEY);
        return inList(FOCUS_INPUT_KEYS, v) ? v : DEFAULT_FOCUS_INPUT_KEY;
    }
    public getFontSize(): string {
        const v = this.readOption<string>(ChatHost.KEY_FONT_SIZE, DEFAULT_FONT_SIZE);
        return typeof v === "string" && /^\d+$/.test(v) ? v : DEFAULT_FONT_SIZE;
    }
    /** 会话结束提示音（所有 session 都响）。 */
    public getNotifyBeep(): boolean {
        return this.readOption<boolean>(ChatHost.KEY_NOTIFY_BEEP, DEFAULT_NOTIFY_BEEP) === true;
    }
    protected notifyBeepEnabled(): boolean { return this.getNotifyBeep(); }

    /**
     * 对话界面的深浅配色。
     * 默认浅色（就是网页端现在的白底那套取值）；深色按 VSCode 深色主题的取值写死，
     * 不随 VSCode 当前主题变——否则同一个配置在两边会长得不一样。
     */
    public getThemeMode(): "light" | "dark" {
        return this.readOption<string>(ChatHost.KEY_THEME, DEFAULT_THEME_MODE) === "dark" ? "dark" : "light";
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
            this.writeOption(ChatHost.KEY_SEND_KEY, next);
        } else if (action === "newSessionKey") {
            const next = inList(NEW_SESSION_KEYS, value) ? value : nextInList(NEW_SESSION_KEYS, this.getNewSessionKey());
            this.writeOption(ChatHost.KEY_NEW_SESSION_KEY, next);
        } else if (action === "tabSwitchKey") {
            const next = inList(TAB_SWITCH_KEYS, value) ? value : nextInList(TAB_SWITCH_KEYS, this.getTabSwitchKey());
            this.writeOption(ChatHost.KEY_TAB_SWITCH_KEY, next);
        } else if (action === "focusInputKey") {
            const next = inList(FOCUS_INPUT_KEYS, value) ? value : this.getFocusInputKey();
            this.writeOption(ChatHost.KEY_FOCUS_INPUT_KEY, next);
        } else if (action === "fontSize") {
            const next = typeof value === "string" && /^\d+$/.test(value) ? value : "";
            this.writeOption(ChatHost.KEY_FONT_SIZE, next);
        } else if (action === "notifyBeep") {
            this.writeOption(ChatHost.KEY_NOTIFY_BEEP, !this.getNotifyBeep());
        } else if (action === "theme") {
            const next = value === "dark" || value === "light"
                ? value
                : (this.getThemeMode() === "dark" ? "light" : "dark");
            this.writeOption(ChatHost.KEY_THEME, next);
        } else {
            this.writeOption(ChatHost.KEY_AUTO_LOAD_LAST, !this.getAutoLoadLast());
        }
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
     * 只发一块屏：控制器那边"只给动手的那块屏"的消息走这里。
     * 那块屏现在没连着（断线间隙）就丢掉：它连回来时后端会单发一份状态给它。
     */
    protected override postToOneClient(clientId: string, msg: Record<string, unknown>): void {
        if (!clientId) { this.postToWebview(msg); return; }
        this.sendToOneClient(clientId, msg);
    }

    /** 现在连着的每一块屏：会话列表要一块一块各发一份，走这里。 */
    protected override forEachClient(
        fn: (clientId: string, send: (msg: Record<string, unknown>) => void) => void,
    ): void {
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
        // 这个会话正有问话在等：卡片也发给这块屏（新开的页面、切过去的窗口都走这里）
        for (const [id, state] of this.openCards) {
            if (state.sessionId === panelId) { this.sendCardToScreen(id, state, clientId); }
        }
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
            if (!dirInsideAny(rt.cwd, folders)) { continue; }
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

    // ---- 编辑器才有的那几样：都派给连着的窗口 ----
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
    //  平台消息：一块屏发来的那些（会话级的消息在基类里）
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
                if (pageId && lastSeq >= 0 && this.broadcaster.catchUp(pageId, lastSeq)) {
                    // 补发的是断线前的老消息（里面可能有那个会话被关掉之前的内容）：
                    // 补完再给它一份最新的会话列表，“已经不存在的会话”就不会在它上面留在那儿。
                    this.sendSessionListTo(pageId);
                    // 还等着的问话卡片不在补发的账里（它们是定向发、不带序号）：断线那段里
                    // 可能正好漏掉了一张（连接悄悄死掉时写进去看着成功，见 onPageConnected），
                    // 这里随对账一起补发，缺的补上、页面上本来就有的原地不动。
                    this.resendCardsTo(pageId);
                    return true;
                }
                // 会话列表先给它（界面上那些会话壳先建起来），再整屏重画。
                this.sendSessionListTo(pageId);
                void this.resyncPage(pageId, "");
                return true;
            }
            case "openHistory":
                // 顶条最右边那颗“<<<”按钮（以及命令面板的历史入口）：列表从右侧滑入，
                // 只弹在点它的那块屏上（别的浏览器页面不跟着弹）。
                void this.showHistoryPicker(this.currentPageId);
                return true;
            case "openWorkspace":
                // 顶条那颗 <<< / 命令入口的项目与会话面板：上半是所有工作区的会话，下半是工作区列表。
                // 带 dock = 宽窗下那一列常驻（推过去就不管了，不等人选）：见 showDockedWorkspacePanel。
                if (msg.dock === true) { void this.showDockedWorkspacePanel(this.currentPageId); return true; }
                void this.showWorkspacePicker(this.currentPageId);
                return true;
            case "workspaceOpenSession":
                // 常驻那一列里点了一行会话（那一列不关，所以不走 pickerChoice）；
                // cwd = 那一行自己的目录（列表里混着好几个目录的会话）。
                if (typeof msg.path === "string") {
                    void this.openWorkspaceSession(
                        msg.path,
                        typeof msg.cwd === "string" && msg.cwd ? msg.cwd : undefined,
                        this.currentPageId,
                    );
                }
                return true;
            case "workspaceBrowse":
                // 工作区标题右边那颗加号（“打开文件夹…”，现在不占一行了）
                void this.browseFromWorkspacePanel(this.currentPageId);
                return true;
            case "workspaceSessions":
                // 界面展开某个工作区 / 点那一组的「加载更多」：读那个目录，接着往下扫几条会话。
                void this.sendWorkspaceSessions(
                    typeof msg.path === "string" ? msg.path : "",
                    typeof msg.offset === "number" && msg.offset > 0 ? msg.offset : 0,
                );
                return true;
            case "workspaceLoadMore":
                // 工作区那块的「加载更多」：再送一批（一次 10 个）。
                void this.loadMoreWorkspaces();
                return true;
            case "newSessionInWorkspace":
                // 工作区那一行行尾的加号：就在那一行的目录里开新会话。
                // 目录明写在消息里：面板可能同时在几块屏上开着，那一行写的是哪个目录就是哪个。
                this.newSessionInDir(
                    typeof msg.path === "string" && msg.path ? msg.path : this.activeCwd(),
                );
                return true;
            case "requestDesktopScreenshot":
                this.sendDesktopScreenshot();
                return true;
            case "openSettingsPanel":
                // 弹设置界面的请求：只回给请求它的那块屏。
                this.sendToOneClient(this.currentPageId, { type: "openSettings" });
                return true;
            case "openSymbol":
                // 正文里的符号链接：只有编辑器有语言服务，派给打开着这个目录的窗口去它读写过的文件里找。
                if (typeof msg.name === "string") {
                    this.routeToScreen("openSymbol", {
                        name: msg.name,
                        knownFiles: this.getAllKnownFiles(),
                    }, `找符号 ${msg.name}`);
                }
                return true;
        }
        return false;
    }

    /**
     * 顶条上那颗“桌面截图”按钮：截一张这台电脑的桌面，只发回请求它的那块屏
     * （别的页面不跟着弹图）。截屏要一两秒，异步做；截完时请求方已经不在
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
    /** 确认框：正在看这个会话的屏上出一张卡片（是 / 否）；没人看着它时走兜底（当“否”）。 */
    public async confirmDialog(title: string, message: string, sessionId?: string): Promise<boolean> {
        if (!this.hasCardViewer(sessionId)) { return this.confirmDialogFallback(title, message); }
        const answer = await this.askOnScreens(sessionId, { kind: "confirm", title, message }, ChatHost.DIALOG_WAIT_MS);
        return answer?.yes === true;
    }

    /** 输入框：同上（在看着这个会话的屏上出一张卡片）；没人看着它时走兜底（当没填）。 */
    public async inputDialog(title: string, placeholder: string, prefill: string, sessionId?: string): Promise<string | undefined> {
        if (!this.hasCardViewer(sessionId)) { return this.inputDialogFallback(title, placeholder, prefill); }
        const answer = await this.askOnScreens(sessionId, { kind: "prompt", title, placeholder, prefill }, ChatHost.DIALOG_WAIT_MS);
        if (!answer || answer.cancelled === true) { return undefined; }   // 按了取消 / 到点没人答
        return String(answer.text ?? "");
    }

    /** 选项列表：在看着这个会话的屏上出一张卡片（单选）；没人看着它时走兜底（当没选）。 */
    public async selectDialog(title: string, options: string[], sessionId?: string): Promise<string | undefined> {
        if (!this.hasCardViewer(sessionId)) { return this.selectDialogFallback(title, options); }
        const answer = await this.askOnScreens(sessionId, {
            kind: "choice",
            question: title || "选一个",
            options,
            multi: false,
            recommended: [],
            allowText: false,
        }, ChatHost.DIALOG_WAIT_MS);
        const picked: string[] = Array.isArray(answer?.picks) ? answer.picks : [];
        return options.find((option) => picked.indexOf(option) >= 0);
    }

    // ========================================================================
    //  问话卡片：要用户答一句（模型问的选择题、扩展问的确认 / 输入 / 选一个）
    // ========================================================================
    /** 问答题（ask_choice）卡片等多久：用户可能要想一会儿。扩展那边等 30 分钟，这里稍短：让它先拿到“没作答”。 */
    private static readonly ASK_WAIT_MS = 25 * 60 * 1000;
    /** 扩展问的那几种（确认 / 输入 / 选一个）等多久：跟以前浮层的等待时间一致。 */
    private static readonly DIALOG_WAIT_MS = 2 * 60 * 1000;

    /**
     * 把一张问话卡片发到"正在看这个会话"的每一块屏上，等第一个作答（谁先答算谁的）。
     * 卡片画在那个会话的消息流里（见 media/chat.js 的 renderAskCard），不弹浮层、不挡别的会话。
     * 一块屏都没在看这个会话就先不发：哪块屏切过去时补发（见 onClientSessionChanged），
     * 整屏重画后也补发（见 resendCardsTo）。等到 waitMs 还是没人答就按没作答收掉。
     * @param sessionId 哪个会话在问；没给（理论上不会）就没人看得到。
     * @param card 卡片内容：{ kind: "choice" | "confirm" | "prompt", … }。
     * @param waitMs 最多等多久（毫秒）。
     * @param srcId 提问方的编号（ask_choice 那次提问的编号）：扩展不等了时靠它认领这张卡片。
     * @param hangOn 一块屏都不剩（都断开了）时还等不等：问答题等（切回来还能答），扩展问的那些不等。
     * @returns 用户答的那几样（picks / text / yes / cancelled）；没作答或到点是 undefined。
     */
    protected askOnScreens(
        sessionId: string | undefined,
        card: Record<string, unknown>,
        waitMs: number,
        srcId = "",
        hangOn = false,
    ): Promise<any | undefined> {
        const id = `card-${++this.cardSeq}`;
        return new Promise<any | undefined>((resolve) => {
            const state: OpenCard = {
                sessionId,
                card,
                srcId,
                screens: new Set<string>(),
                hangOn,
                settled: false,
                timer: undefined,
                settle: resolve,
            };
            this.openCards.set(id, state);
            if (waitMs > 0) { state.timer = setTimeout(() => { this.settleCard(id, undefined); }, waitMs); }
            if (sessionId) {
                for (const target of this.clientsViewing(sessionId)) { this.sendCardToScreen(id, state, target); }
            }
        });
    }

    /**
     * 把卡片发给某一块屏（这块屏已经有了就不重发）。发不出去就当它没收到。
     * @param force 不管“发过没发过”，硬发一遍。用在“这块屏刚整屏重画过”的场合：重画画的是
     *              消息流那几条，卡片不在里头，这块屏上已经什么都没有了。
     */
    private sendCardToScreen(id: string, state: OpenCard, target: string, force = false): void {
        if (state.settled || !target) { return; }
        if (!force && state.screens.has(target)) { return; }
        if (!this.sendOverlayTo(target, { type: "askCard", id, sessionId: state.sessionId, card: state.card })) { return; }
        state.screens.add(target);
    }

    /**
     * 这张卡片收尾：把还挂着它的屏都改成"已答 / 没作答"，再把答案交给等的人。
     * 谁先答算谁的：答了以后别的屏上那张卡片跟着定住（自己答过的那块屏再收一次也没关系）。
     */
    private settleCard(id: string, answer: any | undefined): void {
        const state = this.openCards.get(id);
        if (!state || state.settled) { return; }
        state.settled = true;
        if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
        this.openCards.delete(id);
        for (const target of Array.from(state.screens)) {
            this.sendOverlayTo(target, { type: "askCardDone", id, answer: answer ?? null });
        }
        state.screens.clear();
        state.settle(answer ?? undefined);
    }

    /** 界面上答了一张卡片（见 media/chat.js）。 */
    protected override handleAskCardAnswer(msg: any): void {
        const id = typeof msg?.id === "string" ? msg.id : "";
        const state = id ? this.openCards.get(id) : undefined;
        if (!state || state.settled) { return; }
        this.settleCard(id, {
            picks: Array.isArray(msg.picks) ? msg.picks.filter((x: unknown) => typeof x === "string") : [],
            text: typeof msg.text === "string" ? msg.text : "",
            yes: msg.yes === true,
            cancelled: msg.cancelled === true,
        });
    }

    /**
     * 这块屏上这张卡片不答了（界面上现在没有这颗按钮 —— 想不答就直接把这一轮停掉；
     * 这条消息留着是因为"某块屏声明自己不答了"是协议里正式的一步，页面 / 脚本都能发）：
     * 摘掉它，谁也不剩就算没作答（还有别的屏看着就接着等）。
     */
    protected override handleAskCardCancel(msg: any): void {
        const id = typeof msg?.id === "string" ? msg.id : "";
        const state = id ? this.openCards.get(id) : undefined;
        if (!state || state.settled) { return; }
        if (!state.screens.delete(this.currentPageId)) { return; }
        // 明说“不答了”（不是掉线）：没人能答了就当场收掉，别让模型白等 25 分钟
        if (state.screens.size === 0) { this.settleCard(id, undefined); }
    }

    /**
     * pi 扩展要问用户一个选择题：把卡片发到正在看这个会话的每一块屏上（后切过去的也算），
     * 谁先答算谁的。用户答完写一份回话文件（扩展在轮询那个文件）；一直没人答就写一份“没作答”。
     */
    public async askQuestion(req: AskRequest, sessionId?: string): Promise<void> {
        const answerDir = this.getConfig().askDir ?? "";
        const answer = await this.askOnScreens(sessionId, {
            kind: "choice",
            question: req.question,
            options: req.options,
            multi: req.multi,
            recommended: req.recommended,
            allowText: req.allowText,
            // 界面靠它把这行卡片挂到那条工具行下面
            ...(req.toolCallId ? { toolCallId: req.toolCallId } : {}),
        }, ChatHost.ASK_WAIT_MS, req.id, true);
        const picked: string[] = Array.isArray(answer?.picks)
            ? answer.picks.filter((x: unknown) => typeof x === "string")
            : [];
        const text = typeof answer?.text === "string" ? answer.text.trim() : "";
        writeAskAnswer(answerDir, { id: req.id, cancelled: !answer || (picked.length === 0 && !text), picked, text });
    }

    /** 扩展不等这次提问了（超时 / 这一轮被停）：把还开着的那张卡片收掉（按没作答交回去）。 */
    public cancelAsk(id: string): void {
        for (const [cardId, state] of Array.from(this.openCards.entries())) {
            if (state.srcId === id) { this.settleCard(cardId, undefined); }
        }
    }

    /**
     * 这块屏上该有、而现在可能没有的卡片重发一遍：整屏重画之后（卡片随重画没了），
     * 以及重连对账之后（连接悄悄死掉那段漏掉的卡片，见 onPageConnected）。
     *
     * 拿“这块屏正在看哪个会话”当依据，不看原来那张“发过了”的名单：刷新页面 / 重连换来的是
     * 一个新的页面标识，名单里记的是老标识，拿名单当依据就一张也发不出去（页面重画完一片空白，
     * 而这边还以为“早就发过了”）—— 正是那个“刷新之后问话卡片消失”的由来。
     * 重发是安全的：页面上同一张卡片再收到一次，内容没变、或者人已经答过，它就原地不动
     * （见 chat.js 的 renderAskCard）。
     *
     * @param force 不管"发过没发过"，硬发一遍。整屏重画后用：页面被清空了，而这边可能还记得
     *              “发给过它”。重连对账那条路不用 force：连接刚换新，旧记录已经在
     *              onPageConnected 里摘掉了。
     */
    private resendCardsTo(pageId: string, force = false): void {
        if (!pageId) { return; }
        for (const [id, state] of Array.from(this.openCards.entries())) {
            if (state.settled || !state.sessionId) { continue; }
            // 这块屏没在看这个会话：卡片不往它那儿送（问话卡片只长在人正在看的那个会话的消息流里）
            if (this.clientsViewing(state.sessionId).indexOf(pageId) < 0) { continue; }
            this.sendCardToScreen(id, state, pageId, force);
        }
    }

    /** 确认框问不着页面时的兜底：没人可问就当“否”（宁可不动也不乱来）。 */
    protected async confirmDialogFallback(_title: string, _message: string): Promise<boolean> { return false; }
    /** 输入框问不着页面时的兜底：没人可问就当没填。 */
    protected async inputDialogFallback(_title: string, _placeholder: string, _prefill: string): Promise<string | undefined> { return undefined; }
    /** 选项列表问不着页面时的兜底：没人可问就当没选。 */
    protected async selectDialogFallback(_title: string, _options: string[]): Promise<string | undefined> { return undefined; }

    /** 回滚确认：危险动作，走确认框那条路（没人可问就按“否”）。 */
    public async confirmRevert(label: string, sessionId?: string): Promise<boolean> {
        return this.confirmDialog(
            "回滚修改",
            `${label} 在此次修改后又被变更过，回滚将丢弃那些后续变更。确定继续？`,
            sessionId,
        );
    }

    /** 停掉本工作区的所有 pi 进程（页面与界面的生死与此无关）。 */
    protected disposeAllConversations(): void {
        for (const rt of this.panels.values()) {
            rt.stopClient();
            this.releasePanelName(rt.nameParts);
        }
        this.panels.clear();
        this.forgetAllClients();
        this.disposeSpare();
    }

    /** 收摊：停掉所有 pi 进程（网页服务的收摊由启动器负责）。 */
    public dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.disposeAllConversations();
    }
}

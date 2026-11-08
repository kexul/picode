/**
 * machineHub —— 这台后端替页面去跟别的机器（设置里「远程机器」那几台）打交道。
 *
 * 为什么要这一层：页面（手机 / 浏览器 / 插件面板）只该跟一台后端说话。从前“多台 pichat 互联”
 * 是页面自己凑出来的：页面问本机要机器地址，再对每台另开一条推送流、自己翻译会话号、
 * 自己认领新会话、自己列目录……于是每加一个功能都要想两遍“别台那一路怎么走”，
 * 而有些东西（浮层、新建工作区）根本过不来。
 *
 * 现在这些事都在这里做：
 *   - 每台机器一条推送流（那边把这块当成一块屏，叫 `hub-<n>`），断了自己重连；
 *   - 那边的会话号翻成这台的书写法 `remote:<那台的地址>:<它那边的号>`，消息往前推的时候用这个号；
 *   - 页面发来的东西，凡是号属于别台的，都由这里转过去（会话号的转换也只在这里）；
 *   - 那台的文件 / 目录 / 改动这些口子，也由这里原样转（页面看到的还是自己的地址）；
 *   - 那台有哪些项目、每个项目最近有哪些会话：拿它的 `/sessions`，给「项目与会话」那一栏用；
 *   - 在那台上开新会话 / 新工作区的目录浏览，也在这里（`newSession` / `listDirs`）。
 *
 * 这一层不碰会话编排（谁在跑、跑完了吗、历史重画那一套都在那边自己的后端里），只当搬运工：
 * 收到的那台的消息里，凡是带着会话号的，翻译成这台的写法后原样往外推（`broadcast`），
 * 剩下的活儿交给界面——界面因此不必知道“这台会话跑在谁身上”。
 */
import * as http from "http";
import * as https from "https";
import { listDirectories } from "./dirBrowse";
import { PING_MS, TICK_TIMEOUT_MS } from "./chatProtocol";
import type { RemoteSessionRef } from "./runtimeTypes";
import type { SessionListItem } from "./sessionStore";

/** 会话号的写法：`remote:<那台的地址>:<它那边的号>`（跟从前页面用的写法一致）。 */
const REMOTE_PREFIX = "remote:";

/** 那台报来的一个会话（字段照它推来的 `sessionList` 那一条，用到的才抄下来）。 */
export interface MachineSession {
    id: string;
    title?: string;
    name?: string;
    cwd?: string;
    file?: string;
    lastActivity?: number;
    streaming?: boolean;
    bashRunning?: boolean;
    piReady?: boolean;
    loading?: boolean;
    modelId?: string;
    provider?: string;
    thinkingLevel?: string;
    percent?: number;
    tps?: number;
    activity?: string;
    activityDetail?: string;
    /** 子会话挂在哪个会话下面（那台那边的写法） */
    parentId?: string | null;
    /** 这条会话自己是派活的子会话时那一条（见 chatControllerBase 的 tabaPanelInfo） */
    taba?: unknown;
    /** 自动接着干开着没有（那台的开关，这边只是显示） */
    auto?: unknown;
    autoTitle?: string | null;
}

/**
 * 别台上的一个会话，编排层当它是一条普通会话看（见 runtimeTypes 的 SessionRef）。
 *
 * 它自己不跑东西：要什么数据都现从那台推来的会话清单里读（那台每次报清单都会换一份，
 * 这里就不必跟着更新）。要“动”它的（发话、停、读文件）照旧经 machineHub 转发。
 */
export class RemoteSession implements RemoteSessionRef {
    constructor(private readonly hub: MachineHub, public readonly id: string) {}

    /** 那台现在还报着这条会话吗（报过才有内容可看；后端刚起来、还没问回清单时是 false）。 */
    public get known(): boolean { return !!this.data; }

    public get cwd(): string { return this.data?.cwd ?? ""; }
    public get streaming(): boolean { return this.data?.streaming === true; }
    public get sessionTitle(): string { return this.data?.title ?? ""; }
    public get currentSessionPath(): string | undefined { return this.data?.file || undefined; }
    public get modelId(): string | undefined { return this.data?.modelId; }
    public get provider(): string | undefined { return this.data?.provider; }
    public get thinkingLevel(): string | undefined { return this.data?.thinkingLevel; }

    /** 那台那边一条对话有没有内容这边看不见：一律当“有”，不拿它去顶掉一条历史会话。 */
    public isConversationEmpty(): boolean { return false; }

    public currentModel(): { provider?: string; modelId?: string } | undefined {
        const one = this.data;
        if (!one || (!one.provider && !one.modelId)) { return undefined; }
        return { provider: one.provider, modelId: one.modelId };
    }

    public hasRunningBashTasks(): boolean { return this.data?.bashRunning === true; }

    private get data(): MachineSession | undefined { return this.hub.sessionOf(this.id); }
}

/** 那台上一个项目（`/sessions` 回报的那一份）。 */
export interface MachineProject {
    name: string;
    cwd: string;
    lastActivity: number;
    sessions: MachineSession[];
}

/** 界面上要的一台机器的一份快照。 */
export interface MachineInfo {
    url: string;
    /** 那台自己报的名字（设置里那行「标签」）；没连上时就是地址。 */
    name: string;
    online: boolean;
    /** 连不上的原因（连上了就没有）。 */
    error?: string;
    projects: MachineProject[];
    hasMore: boolean;
    /** 正在问那台（界面上那颗「加载更多工作区」用）。 */
    loadingMore?: boolean;
    /** 这台会话说到底是哪台上的哪一条。 */
    sessions: Map<string, MachineSession>;
}

export interface MachineHubOptions {
    /** 写一行日志（输出面板）。 */
    log(text: string): void;
    /** 设置里「远程机器」那几台的地址（每次都现读：人可能刚改过）。 */
    machines(): string[];
    /** 把一条消息推给这台连着的所有页面（自带序号与补发，见 ChatBroadcaster）。 */
    broadcast(msg: Record<string, unknown>): void;
    /** 那台报来了新的会话清单（或者掉线 / 回来了）：宿主重推合并后的那份。 */
    onSessionsChanged(): void;
    /**
     * 一个远程会话换了号（那台刚把它开出来、或者那台重启过）：
     * 宿主把“哪块屏在看它”那本账跟着改过去。
     */
    onSessionAdopted?(oldId: string, newId: string): void;
}

/** 一条推送流多久没动静就当它死了（跟页面那边一个规矩，见 chatProtocol.ts）。 */
const WATCHDOG_MS = 5000;
/** 重连等待阶梯（毫秒）：头几次快，之后固定 8 秒，一直试。 */
const RETRY_DELAYS_MS = [400, 800, 1500, 3000, 8000];
/** 问那台要东西（/health /sessions /dirs /api）最多等多久：手机那边只等这一截，别一直挂着。 */
const REQUEST_TIMEOUT_MS = 8000;
/** 那台的项目清单多久重问一次（界面那边要的时候顺手刷）。 */
const PROJECTS_FRESH_MS = 15000;

interface MachineState {
    url: string;
    name: string;
    online: boolean;
    error?: string;
    pageId: string;
    source?: http.ClientRequest;
    retryTimer?: NodeJS.Timeout;
    retryIndex: number;
    openedOnce: boolean;
    /** 那台推来消息的序号（重连时带上去，让它只补漏掉的）。 */
    lastSeq: number;
    lastTickAt: number;
    pingTimer?: NodeJS.Timeout;
    sessions: Map<string, MachineSession>;
    projects: MachineProject[];
    hasMore: boolean;
    projectsAt: number;
    busy: boolean;
}

export class MachineHub {
    private readonly states = new Map<string, MachineState>();
    /** 这台后端认下的远程会话（页面要看到的那几格）：`remote:<地址>:<号>`。 */
    private readonly opened = new Set<string>();
    /** 认下的那些各自的会话文件（那台重启过、号变了的时候按它接上）。 */
    private readonly openedFiles = new Map<string, string>();
    /**
     * 刚点开的那些还没见着正文（那台复用了它自己一个空会话时会这样：只回 clear/historyWindow/
     * syncPoint，一条消息都没有）。见到正文就划掉；一直没见着，就在它说“画完了”之后补请一次。
     */
    private readonly needContent = new Map<string, boolean>();
    /** 这些会话的正文已经往这台推过了（切来切去不用再要一遍；页面重连后作废，见 forgetSentContent）。 */
    private readonly contentSent = new Set<string>();
    /**
     * 从项目清单里点开、那台还没报出它那边的号（面板号）的那些：先按会话文件记着，
     * 等它报了会话清单再认领、换成它那边的号（见 adoptOpen）。
     */
    private readonly pendingOpen = new Map<string, { machine: string; file: string; localId: string; before: string[] }>();
    /** 定时看门狗（连接是不是其实已经死了）。 */
    private watchdog?: NodeJS.Timeout;
    /** 上一次按哪份地址连的（设置里改了就整份重来，见 sync）。 */
    private machinesKey = "";
    private disposed = false;

    constructor(private readonly opts: MachineHubOptions) {}

    // ========================================================================
    //  生命周期
    // ========================================================================

    /** 按当前设置连上那几台（设置改了就整个重来，见 `reload`）。 */
    public start(): void {
        if (this.disposed) { return; }
        this.reload();
        if (this.watchdog) { return; }
        this.watchdog = setInterval(() => this.checkAlive(), WATCHDOG_MS);
        // 定时器不该拖着进程不让退（后端 Ctrl+C 时干净收摊）
        this.watchdog.unref?.();
    }

    /** 设置里那几台变了：断掉不在名单里的，连上新加的。 */
    public reload(): void {
        if (this.disposed) { return; }
        const want = this.opts.machines().map((one) => String(one || "").replace(/\/+$/, "")).filter(Boolean);
        this.machinesKey = want.join("\u0000");
        for (const [url, st] of Array.from(this.states)) {
            if (want.indexOf(url) >= 0) { continue; }
            this.dropState(st);
        }
        want.forEach((url, index) => {
            if (this.states.has(url)) { return; }
            this.states.set(url, {
                url,
                name: url,
                online: false,
                pageId: "hub-" + index + "-" + Math.random().toString(36).slice(2, 8),
                retryIndex: 0,
                openedOnce: false,
                lastSeq: 0,
                lastTickAt: 0,
                sessions: new Map(),
                projects: [],
                hasMore: false,
                projectsAt: 0,
                busy: false,
            });
        });
        for (const url of want) {
            const st = this.states.get(url);
            if (st && !st.source) { this.connect(st); }
        }
        // 机器清单变了：宿主得重推会话清单与工作区那一栏
        this.opts.onSessionsChanged();
    }

    public dispose(): void {
        this.disposed = true;
        if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = undefined; }
        for (const st of Array.from(this.states.values())) { this.dropState(st); }
        this.opened.clear();
    }

    /**
     * 设置里「远程机器」那几台改了：整份重来（连上新加的、断掉拿掉的）。
     *
     * 每次用到这份清单之前都顺手看一眼（比字符串，很便宜）：设置面板里改完地址不用重启后端，
     * 下一次开侧边栏就跟上了。
     */
    private sync(): void {
        if (this.disposed) { return; }
        const key = this.opts.machines().map((one) => String(one || "").replace(/\/+$/, "")).filter(Boolean).join("\u0000");
        if (key === this.machinesKey) { return; }
        this.reload();
    }

    private dropState(st: MachineState): void {
        if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = undefined; }
        if (st.pingTimer) { clearInterval(st.pingTimer); st.pingTimer = undefined; }
        if (st.source) {
            const mine = st.source;
            st.source = undefined;
            try { mine.destroy(); } catch { /* 已经断了 */ }
        }
        this.states.delete(st.url);
        for (const id of Array.from(this.opened)) {
            if (this.ownerOf(id) !== st.url) { continue; }
            this.opened.delete(id);
            this.openedFiles.delete(id);
        }
        for (const [key, wait] of Array.from(this.pendingOpen)) {
            if (wait.machine === st.url) { this.pendingOpen.delete(key); }
        }
    }

    // ========================================================================
    //  会话号（这台的写法 ↔ 那台的写法）
    // ========================================================================

    /** 一条别台的会话号：`remote:<那台的地址>:<它那边的号>`。不是这种写法就是 undefined。 */
    public parseId(id: unknown): { machine: string; remoteId: string } | undefined {
        if (typeof id !== "string" || id.indexOf(REMOTE_PREFIX) !== 0) { return undefined; }
        this.sync();
        const rest = id.slice(REMOTE_PREFIX.length);
        // 地址里本身带冒号（http://host:port），所以拿名单里那一台去对前缀，不按冒号切
        for (const url of this.states.keys()) {
            const head = url + ":";
            if (rest.indexOf(head) === 0) {
                const remoteId = rest.slice(head.length);
                if (remoteId) { return { machine: url, remoteId }; }
            }
        }
        return undefined;
    }

    /** 这个名字属于哪台（不是别台的会话就给 undefined）。 */
    public ownerOf(id: unknown): string | undefined {
        const one = this.parseId(id);
        return one ? one.machine : undefined;
    }

    /** 一个别台的会话当成一条会话看（本机的号、设置里没有的地址都给 undefined）。 */
    public sessionRef(id: string): RemoteSession | undefined {
        return this.parseId(id) ? new RemoteSession(this, id) : undefined;
    }

    /** 这台后端认下的远程会话（页面要看到的那几格）。 */
    public openedIds(): string[] { return Array.from(this.opened); }

    /** 认下它（要看到的那几格里加一条；那台的东西从此开始往这台推）。 */
    public markOpened(id: string, file = ""): void {
        if (!this.parseId(id) || this.opened.has(id)) { return; }
        this.opened.add(id);
        if (file) { this.openedFiles.set(id, file); }
    }

    /** 那台的会话号 → 这台界面上的写法。 */
    public toLocalId(machineUrl: string, remoteId: string): string {
        return REMOTE_PREFIX + machineUrl + ":" + remoteId;
    }

    /** 那台现在开着哪些会话（人家那边的号）。 */
    public sessionIdsOf(machineUrl: string): string[] {
        const st = this.states.get(machineUrl);
        return st ? Array.from(st.sessions.keys()) : [];
    }

    /** 那台新多出来、又刚好在那个目录里的那个会话（刚请它开的新会话就是它）。 */
    public findNewSession(machineUrl: string, before: Iterable<string>, cwd: string): MachineSession | undefined {
        const st = this.states.get(machineUrl);
        if (!st) { return undefined; }
        const seen = new Set(before);
        for (const [id, one] of st.sessions) {
            if (seen.has(id)) { continue; }
            if (sameDirText(one.cwd, cwd)) { return one; }
        }
        return undefined;
    }

    /**
     * 这个远程会话现在的情况。
     *
     * 先看那台开着的那一份（推来的会话清单里有最新的状态），没有再到它的项目清单里翻
     * （页面从列表里点开一条还没开着的历史会话时就是这种：那台此时还没把它报成“开着的”）。
     */
    public sessionOf(id: string): MachineSession | undefined {
        const one = this.parseId(id);
        if (!one) { return undefined; }
        const st = this.states.get(one.machine);
        if (!st) { return undefined; }
        const open = st.sessions.get(one.remoteId);
        if (open) { return open; }
        for (const project of st.projects) {
            for (const session of project.sessions) {
                if (session.id === one.remoteId) { return session; }
            }
        }
        return undefined;
    }

    /** 那台还在不在（界面上的灰点、那句“连不上”都看它）。 */
    public isOnline(machineUrl: string): boolean {
        return !!this.states.get(machineUrl)?.online;
    }

    /**
     * 那个远程会话这会儿是不是还在跑（正在生成 / 后台命令没跑完）。
     * 在那台新开一个会话时，旧的要还在跑就留着，不把没跑完的活掐掉（跟本机一个规矩）。
     */
    public isBusy(id: string): boolean {
        const one = this.sessionOf(id);
        return !!one && (one.streaming === true || one.bashRunning === true);
    }

    // ========================================================================
    //  清单（界面「项目与会话」那一栏要的）
    // ========================================================================

    /** 现在认识的机器（按设置里的顺序），带上它们报来的项目与会话。 */
    public list(): MachineInfo[] {
        this.sync();
        const out: MachineInfo[] = [];
        for (const url of this.opts.machines().map((one) => String(one || "").replace(/\/+$/, "")).filter(Boolean)) {
            const st = this.states.get(url);
            if (!st) { continue; }
            out.push({
                url: st.url,
                name: st.name || st.url,
                online: st.online,
                ...(st.error ? { error: st.error } : {}),
                projects: st.projects,
                hasMore: st.hasMore,
                ...(st.busy ? { loadingMore: true } : {}),
                sessions: st.sessions,
            });
        }
        return out;
    }

    /** 那一台在哪（界面上要写节名：「工作区-公司」）。 */
    public nameOf(machineUrl: string): string {
        const st = this.states.get(machineUrl);
        if (!st) { return machineUrl; }
        return st.name && st.name !== st.url ? st.name : hostOf(st.url);
    }

    /** 问那台叫什么（`/health` 里的 name：设置里那行「标签」，界面上那一节就叫「工作区-<它>」）。 */
    private async loadHealth(st: MachineState): Promise<void> {
        try {
            const body = await this.getJson(st.url + "/health");
            const name = typeof body?.name === "string" ? body.name.trim() : "";
            if (!name || st.name === name) { return; }
            st.name = name;
            this.opts.onSessionsChanged();
        } catch { /* 名字问不到就用地址，不挡路 */ }
    }

    /** 问那台要一页项目（`/sessions`；界面那颗「加载更多工作区」接着往后要）。 */
    public async loadProjects(machineUrl: string, offset = 0): Promise<void> {
        const st = this.states.get(machineUrl);
        if (!st || st.busy) { return; }
        st.busy = true;
        try {
            const body = await this.getJson(st.url + "/sessions" + (offset > 0 ? "?offset=" + offset : ""), st);
            const projects = Array.isArray(body?.projects) ? body.projects : [];
            st.projects = offset > 0 ? st.projects.concat(projects) : projects;
            st.hasMore = body?.hasMore === true;
            st.projectsAt = Date.now();
            st.online = true;
            st.error = undefined;
        } catch (err: any) {
            st.online = false;
            st.error = String(err?.message || err || "连不上");
        } finally {
            st.busy = false;
            this.opts.onSessionsChanged();
        }
    }

    /** 顺手把每台的项目清单刷新一遍（界面打开那一栏时叫一下；太勤就不问）。 */
    public async refreshProjects(force = false): Promise<void> {
        this.sync();
        const jobs: Promise<void>[] = [];
        for (const st of this.states.values()) {
            if (!force && Date.now() - st.projectsAt < PROJECTS_FRESH_MS) { continue; }
            jobs.push(this.loadProjects(st.url, 0));
        }
        await Promise.all(jobs);
    }

    // ========================================================================
    //  页面那边的请求
    // ========================================================================

    /**
     * 这个远程会话认下来（页面点开了它）：请那台打开 + 把这台历史重画一遍。
     *
     * 从项目清单里点开一条**还没开着**的会话时，手里的号是那边会话文件里的号，
     * 跟那台真正用的面板号（`server:panel-3` 这种）不是一回事：这种先按会话文件挂着，
     * 等它把会话清单报上来再认领、换成它那边的号（见 adoptOpen）。
     */
    public openSession(id: string, hint?: { file?: string; cwd?: string }): void {
        const one = this.parseId(id);
        if (!one) { return; }
        const st = this.states.get(one.machine);
        if (!st) { return; }
        const live = st.sessions.get(one.remoteId);
        const info = live ?? this.sessionOf(id);
        // 会话文件：清单里查得到就用清单里那份；查不到（那边的项目清单还没问回来）就用调用方
        // 手里那份——界面点一行会话时行上是带着路径的（见 media/chat.js 的 workspaceOpenSession）
        const file = info?.file || hint?.file || "";
        const cwd = info?.cwd || hint?.cwd || "";
        if (live) {
            this.opened.add(id);
            if (file) { this.openedFiles.set(id, file); }
            this.post(id, { type: "workspaceOpenSession", path: file, cwd });
            // 正文要过一次就够了：这台手上已经有这一格的内容时，切来切去不必再让它整段重发
            //（重画一遍 = 几百条消息重新摆一次：画面抖一下、滚动位置被推来推去，
            //  工具行那种“按批次并起来”的东西也容易摆错地方）。
            // 只有“这块屏还没拿到过它的正文”（刚点开、页面刚刷新）才要一遍。
            // 也不在这儿挂“等正文”那笔账（needContent）：那笔账是给还没认下的会话用的，
            // 挂在开着的老会话上，上一趟重放晚到的 syncPoint 会被当成“一条正文都没有”，
            // 于是每切一次就多请一遍整段重放（一叠两遍、对账到超时才收，视野停在半空）。
            if (!this.contentSent.has(id)) {
                this.post(id, { type: "repaintSession", sessionId: one.remoteId, full: true });
            }
        } else if (file) {
            // 还没开着：请它打开（它一开就会把这个会话报进会话清单里）
            this.pendingOpen.set(fileKey(file), { machine: one.machine, file, localId: id, before: this.sessionIdsOf(one.machine) });
            this.postTo(st, { type: "workspaceOpenSession", path: file, cwd });
        }
        this.opts.onSessionsChanged();
    }

    /** 不用了（页面把这一格关了）：从“认下的”里划掉。 */
    public forget(id: string): void {
        this.openedFiles.delete(id);
        if (this.opened.delete(id)) { this.opts.onSessionsChanged(); }
    }

    /** 那台把这块“虚拟屏”切到哪个会话（切会话时叫一下：那边据此决定重画哪一份历史）。 */
    public activate(id: string): void {
        const one = this.parseId(id);
        if (!one) { return; }
        this.post(id, { type: "switchToSession", sessionId: one.remoteId });
    }

    /** 在那台的一个目录里开新会话（模型跟过去就跟本机新会话一个规矩：继承现在看的这条）。 */
    public newSession(machineUrl: string, cwd: string, inherited?: { provider?: string; modelId?: string }): void {
        const st = this.states.get(machineUrl);
        if (!st) { return; }
        const model: Record<string, string> = {};
        if (inherited?.provider) { model.provider = inherited.provider; }
        if (inherited?.modelId) { model.modelId = inherited.modelId; }
        this.postTo(st, { type: "newSessionInWorkspace", path: cwd, ...model });
    }

    /** 那台的会话关掉（这台界面上点 × 关了一格别台的会话）。 */
    public closeSession(id: string): void {
        const one = this.parseId(id);
        if (!one) { return; }
        this.post(id, { type: "closeSession", sessionId: one.remoteId });
        this.forget(id);
    }

    /** 发一条消息给那台（会话号换回它那边的写法）。 */
    public post(id: string, msg: Record<string, unknown>): boolean {
        const one = this.parseId(id);
        if (!one) { return false; }
        const st = this.states.get(one.machine);
        if (!st) { return false; }
        const copy: Record<string, unknown> = { ...msg, sessionId: one.remoteId };
        this.postTo(st, copy);
        return true;
    }

    /** 列那台的一个目录（挑新工作区时一层层点）。 */
    public async listDirs(machineUrl: string, path: string): Promise<unknown> {
        const st = this.states.get(machineUrl);
        if (!st) { throw new Error("设置里没有这台机器"); }
        return this.getJson(st.url + "/dirs?path=" + encodeURIComponent(path || ""), st);
    }

    /**
     * 那台上一条会话的历史清单里点开了一条：把它当成“这台界面上的一个号”交回来。
     *
     * 手里只有会话文件与目录（那台这时候还没把它开出来，它那边的面板号也就还不认识）：
     * 先按号记下这一笔，等那台报上清单时按会话文件认领、换成它那边的号（见 adoptPending）。
     * @returns 这台界面上的写法（先拿它切过去，认领了会自动改成新号）
     */
    public openFileSession(machineUrl: string, file: string, cwd: string, remoteId: string): string {
        const id = this.toLocalId(machineUrl, remoteId || fileKey(file) || "file");
        this.openSession(id, { file, cwd });
        return id;
    }

    /**
     * 那台上某个目录的历史会话，一页一批（本机历史浮窗问的那一份）。
     * 那台没起 / 没回话就抛（调用方按“列不出来”处理，跟本机读盘出错一个待遇）。
     */
    public async history(
        machineUrl: string,
        dir: string,
        offset: number,
        size: number,
    ): Promise<{ items: SessionListItem[]; nextOffset: number; hasMore: boolean }> {
        const st = this.states.get(machineUrl);
        if (!st) { throw new Error("设置里没有这台机器"); }
        const query = "/history?dir=" + encodeURIComponent(dir) + "&offset=" + offset + "&size=" + size;
        const body = (await this.getJson(st.url + query, st)) as any;
        return {
            items: Array.isArray(body?.items) ? body.items : [],
            nextOffset: typeof body?.nextOffset === "number" ? body.nextOffset : offset,
            hasMore: body?.hasMore === true,
        };
    }

    /**
     * 把一个请求原样转给那台（`/file`、`/dir`、`/changes`、`/site/…` 这些）。
     *
     * 地址里的会话号是这台的写法（`remote:<那台>:<号>`）：转过去时换回它那边的 —— 查询里的
     * `session=` 与 `/site/<会话号>/…` 那一段两处都换。其余原样，正文一段一段往回接。
     */
    public proxy(machineUrl: string, localSessionId: string, req: http.IncomingMessage, res: http.ServerResponse): void {
        const st = this.states.get(machineUrl);
        const one = this.parseId(localSessionId);
        if (!st || !one) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("没有这台机器（设置里改过？）");
            return;
        }
        const raw = req.url ?? "/";
        const q = raw.indexOf("?");
        const search = q >= 0 ? raw.slice(q) : "";
        const pathname = q >= 0 ? raw.slice(0, q) : raw;
        // /site/<会话号>/<里面那一层路径>：会话号也在路径里，一起换回那边的写法
        let tail = pathname;
        const sitePrefix = "/site/";
        if (tail.indexOf(sitePrefix) === 0) {
            const rest = tail.slice(sitePrefix.length);
            const cut = rest.indexOf("/");
            tail = sitePrefix + encodeURIComponent(one.remoteId) + (cut < 0 ? "" : rest.slice(cut));
        }
        let target: URL;
        try {
            target = new URL(st.url + tail + search);
        } catch {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("地址不合法");
            return;
        }
        const session = target.searchParams.get("session");
        if (session) { target.searchParams.set("session", one.remoteId); }
        this.forward(target, req, res);
    }

    /** 真的把请求发出去（自己用完就收；页面那头断了就把上游也断掉）。 */
    private forward(target: URL, req: http.IncomingMessage, res: http.ServerResponse): void {
        const secure = target.protocol === "https:";
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(req.headers)) {
            if (value === undefined) { continue; }
            // 逐跳的那些、还有来源（那边不认这台页面的地址）、以及压缩（两边自己算）
            if (HOP_BY_HOP.has(name) || name === "host" || name === "origin" || name === "referer" || name === "accept-encoding") { continue; }
            headers[name] = value;
        }
        const upstream = (secure ? https : http).request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (secure ? 443 : 80),
            method: req.method,
            path: target.pathname + target.search,
            headers,
        });
        let answered = false;
        const timer = setTimeout(() => {
            if (answered) { return; }
            answered = true;
            upstream.destroy();
            if (!res.headersSent) {
                res.writeHead(504, { "Content-Type": "text/plain; charset=utf-8" });
                res.end(`连不上那台（${REQUEST_TIMEOUT_MS / 1000} 秒没回应）。`);
            }
        }, REQUEST_TIMEOUT_MS);
        upstream.on("response", (up) => {
            if (answered) { up.resume(); return; }
            answered = true;
            clearTimeout(timer);
            const out: http.OutgoingHttpHeaders = {};
            for (const [name, value] of Object.entries(up.headers)) {
                if (value === undefined || HOP_BY_HOP.has(name)) { continue; }
                out[name] = value;
            }
            res.writeHead(up.statusCode ?? 502, out);
            res.flushHeaders();
            up.pipe(res);
            up.on("error", () => { try { res.end(); } catch { /* 已经断了 */ } });
        });
        upstream.on("error", (err: any) => {
            clearTimeout(timer);
            if (answered) { try { res.end(); } catch { /* 同上 */ } return; }
            answered = true;
            const why = err?.code === "ECONNREFUSED" ? "那台的端口没开着"
                : err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN" ? "那个地址解析不了"
                : err?.code === "EHOSTUNREACH" || err?.code === "ENETUNREACH" ? "这台到不了那个地址"
                : (err?.message || "请求没发出去");
            if (!res.headersSent) {
                res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
                res.end(`连不上那台（${why}）。`);
            }
        });
        res.on("close", () => { clearTimeout(timer); try { upstream.destroy(); } catch { /* 已经断了 */ } });
        req.pipe(upstream);
    }

    // ========================================================================
    //  那台的推送流
    // ========================================================================

    private connect(st: MachineState): void {
        if (this.disposed) { return; }
        if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = undefined; }
        const url = st.url + "/events?pageId=" + encodeURIComponent(st.pageId)
            + (st.openedOnce ? "&since=" + st.lastSeq : "");
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return;
        }
        const secure = parsed.protocol === "https:";
        const req = (secure ? https : http).get({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (secure ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers: { accept: "text/event-stream", "cache-control": "no-store" },
        }, (res) => {
            if (st.source !== req) { res.resume(); return; }
            if ((res.statusCode ?? 0) !== 200) {
                res.resume();
                this.markOffline(st, `那台回了 HTTP ${res.statusCode}（推送流没连上）`);
                this.scheduleReconnect(st);
                return;
            }
            st.openedOnce = true;
            st.retryIndex = 0;
            st.lastTickAt = Date.now();
            // 跟浏览器页面一样先报一句 ready：那边才把会话清单推过来
            this.postTo(st, { type: "ready" });
            this.startPing(st);
            if (!st.online) {
                st.online = true;
                st.error = undefined;
                this.opts.log(`[别台] ${this.nameOf(st.url)} 连上了`);
                void this.loadHealth(st);
                void this.loadProjects(st.url, 0);
            }
            this.readStream(st, res);
        });
        st.source = req;
        req.on("error", () => {
            if (st.source !== req) { return; }
            st.source = undefined;
            this.markOffline(st, "连接断了");
            this.scheduleReconnect(st);
        });
    }

    /**
     * 定期报活：那边（跟这台一样）会把长时间不吭声的页面当成死连接掐掉，
     * 断了它就不往这条流里写东西了（界面看着就是“那台一直没动静”）。
     */
    private startPing(st: MachineState): void {
        if (st.pingTimer) { return; }
        st.pingTimer = setInterval(() => {
            if (!st.source || !st.online) { return; }
            this.postTo(st, { type: "channelPing" });
        }, PING_MS);
        st.pingTimer.unref?.();
    }

    /** 读那台一段一段推来的事件（`event: msg` + `data: {…}`，跟浏览器那条一个格式）。 */
    private readStream(st: MachineState, res: http.IncomingMessage): void {
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
            st.lastTickAt = Date.now();
            buffer += chunk;
            let cut: number;
            while ((cut = buffer.indexOf("\n\n")) >= 0) {
                const block = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                this.onEventBlock(st, block);
            }
        });
        const done = () => {
            if (st.source === undefined) { return; }
            // res 结束了但 req 还挂着：当成断线处理（同一条连接不会再有了）
            st.lastTickAt = Date.now();
            this.markOffline(st, "那台把推送流关了");
        };
        res.on("end", done);
        res.on("close", done);
    }

    private onEventBlock(st: MachineState, block: string): void {
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
            if (line.indexOf("event:") === 0) { event = line.slice(6).trim(); }
            else if (line.indexOf("data:") === 0) { data.push(line.slice(5).trimStart()); }
        }
        if (event === "tick") { return; }
        if (event !== "msg" || data.length === 0) { return; }
        let msg: any;
        try {
            msg = JSON.parse(data.join("\n"));
        } catch {
            return;
        }
        if (!msg || typeof msg.type !== "string") { return; }
        if (typeof msg.seq === "number") {
            // 那台重启过：序号从头算，手里这个进度不适用了
            if (msg.type === "hello") {
                if (typeof msg.seq === "number" && msg.seq < st.lastSeq) { st.lastSeq = 0; }
                return;
            }
            if (msg.seq > st.lastSeq) { st.lastSeq = msg.seq; }
        }
        this.onRemoteMessage(st, msg);
    }

    /**
     * 那台推来的一条：会话号换成这台的写法，再往外推。
     *
     * 只推“这台认下的那几个会话”的东西（其余的会话在那台自己开着，跟这块屏无关）；
     * 不带会话号的那些（选项、模型清单、命令清单……）一律不推：那些这台自己有自己的一份，
     * 把别台的并进来只会让人对着两个清单发懵（要切模型、要开设置，都是这台的事）。
     */
    private onRemoteMessage(st: MachineState, msg: any): void {
        if (msg.type === "sessionList") {
            const list = Array.isArray(msg.sessions) ? msg.sessions : [];
            st.sessions = new Map();
            for (const one of list) {
                if (!one || typeof one.id !== "string" || !one.id) { continue; }
                st.sessions.set(one.id, one);
            }
            if (!st.online) { st.online = true; st.error = undefined; }
            // 刚点开的那些：那台已经把它报上来了，换成它那边的号
            this.adoptPending(st, list);
            // 认下的那些如果换了号（那台重启过），按会话文件接上
            this.renumber(st, list);
            this.opts.onSessionsChanged();
            return;
        }
        if (msg.type === "sessionActivated") { return; }
        if (msg.type === "syncPoint" && (typeof msg.sessionId !== "string" || !msg.sessionId)) {
            // 那台说“这一屏画完了”。这一条是按屏发的、没有会话号，但它管的正是我们刚才
            // 请它重画的那一遍（见 openSession）：不转过去的话，这边“重放还没收尾”那笔账
            // 要等 8 秒的兜底才收，那段时间画面不跟着滚，人切回来就停在半空。
            // 带上那台的地址：界面只拿它收这一台的会话，本机那几格的重画不受影响。
            this.opts.broadcast({ type: "syncPoint", machine: st.url });
            return;
        }
        if (typeof msg.sessionId !== "string" || !msg.sessionId) { return; }
        const id = REMOTE_PREFIX + st.url + ":" + msg.sessionId;
        if (!this.opened.has(id) && !this.adoptByMessage(st, msg.sessionId)) {
            // 没认下的会话（那台上别的东西在跑）：不往这台推
            return;
        }
        if (this.needContent.has(id)) {
            if (CONTENTLESS_TYPES.has(msg.type)) {
                // 这一条只是账面上的（清屏、就绪、算完了……）：正文还没来
                if (msg.type === "syncPoint" || msg.type === "historyWindow") {
                    // 它说画完了，可一条正文都没有（那台复用了自己一个空会话）：
                    // 再请它按整段重放一次；还不行就算了，总比一直空着好
                    this.needContent.delete(id);
                    this.post(id, { type: "repaintSession", full: true });
                }
            } else {
                this.needContent.delete(id);
            }
        }
        if (!CONTENTLESS_TYPES.has(msg.type)) { this.contentSent.add(id); }
        const copy: Record<string, unknown> = { ...msg, sessionId: id };
        delete copy.seq;
        this.opts.broadcast(copy);
    }

    /**
     * 这块屏刚（重新）连上：之前“正文已经发过”的那笔账作废 —— 新连上来的这块屏手里
     * 不一定还有那些消息（刷新过就是空的）。它正看着的那个由 chatHost 当场补一份整段重画。
     */
    public forgetSentContent(): void {
        this.contentSent.clear();
    }

    /** 请那台把这条会话整段重画一遍（页面刚连上、手上还没有它的正文时用）。 */
    public repaint(id: string): void {
        const one = this.parseId(id);
        if (!one) { return; }
        const st = this.states.get(one.machine);
        if (!st) { return; }
        this.contentSent.delete(id);
        this.post(id, { type: "repaintSession", sessionId: one.remoteId, full: true });
    }

    /**
     * 刚点开的那条会话冒出来第一条消息：它就是它（那台一开出来就在往外推了，比会话清单还早）。
     *
     * 为什么按“点之前那台没有的号”认：从项目清单里点开时手里的号是会话文件里的号，
     * 跟那台真正用的面板号不是一回事；而第一条消息到的时候，那台可能还没把会话文件写进清单里
     * （文件是读完才有的），所以“文件对得上”这条不一定等得到。
     *
     * @returns 认下了没有（认下了这条就该往下推）
     */
    private adoptByMessage(st: MachineState, remoteId: string): boolean {
        if (this.pendingOpen.size === 0) { return false; }
        for (const [key, wait] of Array.from(this.pendingOpen)) {
            if (wait.machine !== st.url || wait.before.indexOf(remoteId) >= 0) { continue; }
            const live = st.sessions.get(remoteId);
            // 能拿到会话文件就核一下（那台上同时开了别的会话时不至于认错）
            if (live && live.file && wait.file && !sameDirText(live.file, wait.file)) { continue; }
            this.pendingOpen.delete(key);
            const id = this.toLocalId(st.url, remoteId);
            this.opened.add(id);
            this.openedFiles.set(id, wait.file);
            this.opts.onSessionAdopted?.(wait.localId, id);
            this.opts.onSessionsChanged();
            this.post(id, { type: "repaintSession", full: true });
            return true;
        }
        return false;
    }

    /** 刚点开、还挂着文件号的那些：那台报来会话清单了，按文件认出它那边的号。 */
    private adoptPending(st: MachineState, list: any[]): void {
        if (this.pendingOpen.size === 0) { return; }
        for (const [key, wait] of Array.from(this.pendingOpen)) {
            if (wait.machine !== st.url) { continue; }
            const hit = list.find((one) => one && sameDirText(one.file, wait.file));
            if (!hit || typeof hit.id !== "string" || !hit.id) { continue; }
            this.pendingOpen.delete(key);
            this.opened.delete(wait.localId);
            const id = this.toLocalId(st.url, hit.id);
            this.opened.add(id);
            this.openedFiles.set(id, wait.file);
            this.needContent.set(id, true);
            this.opts.onSessionAdopted?.(wait.localId, id);
        }
    }

    /** 认下的那些在这份清单里没有它那个号了（那台重启过）：按会话文件接上新的号。 */
    private renumber(st: MachineState, list: any[]): void {
        for (const id of Array.from(this.opened)) {
            const one = this.parseId(id);
            if (!one || one.machine !== st.url) { continue; }
            if (list.some((s) => s && s.id === one.remoteId)) { continue; }
            const file = this.openedFiles.get(id) || "";
            if (!file) { continue; }
            const hit = list.find((s) => s && sameDirText(s.file, file) && typeof s.id === "string" && s.id);
            if (!hit) { continue; }
            const next = this.toLocalId(st.url, hit.id);
            this.opened.delete(id);
            this.opened.add(next);
            this.openedFiles.delete(id);
            this.openedFiles.set(next, file);
            this.post(next, { type: "repaintSession" });
            this.opts.onSessionAdopted?.(id, next);
        }
    }

    private markOffline(st: MachineState, why: string): void {
        if (!st.online) { return; }
        st.online = false;
        st.error = why;
        this.opts.log(`[别台] ${this.nameOf(st.url)} 断了：${why}`);
        // 那台开着的会话这台上正看着的：说一句（跟从前页面上那句一个意思）
        for (const id of this.opened) {
            if (this.ownerOf(id) !== st.url) { continue; }
            this.opts.broadcast({
                type: "systemError", sessionId: id,
                text: "连不上那台了，正在自动重连；这一段先看不了，也发不出去。",
            });
        }
        this.opts.onSessionsChanged();
    }

    private scheduleReconnect(st: MachineState): void {
        if (this.disposed || st.retryTimer) { return; }
        const delay = RETRY_DELAYS_MS[Math.min(st.retryIndex, RETRY_DELAYS_MS.length - 1)];
        st.retryIndex += 1;
        st.retryTimer = setTimeout(() => {
            st.retryTimer = undefined;
            if (this.states.get(st.url) !== st) { return; }
            this.connect(st);
        }, delay);
        st.retryTimer.unref?.();
    }

    /** 连接看着还在、其实早就收不到东西了（那边掉电、路由没了）：自己重开一条。 */
    private checkAlive(): void {
        // 顺手看一眼设置里那几台有没有改（设置面板里改完地址不用重启后端）
        this.sync();
        const now = Date.now();
        for (const st of this.states.values()) {
            if (!st.source || !st.online) { continue; }
            if (now - st.lastTickAt < TICK_TIMEOUT_MS) { continue; }
            this.opts.log(`[别台] ${this.nameOf(st.url)} ${Math.round((now - st.lastTickAt) / 1000)} 秒没动静，重连`);
            const mine = st.source;
            st.source = undefined;
            try { mine.destroy(); } catch { /* 已经断了 */ }
            this.markOffline(st, "那边没动静了（心跳断了）");
            this.scheduleReconnect(st);
        }
    }

    // ========================================================================
    //  小工具
    // ========================================================================

    /** 往那台发一条消息（用这块“虚拟屏”的标识）。发不出去只记一笔，不抛。 */
    private postTo(st: MachineState, msg: Record<string, unknown>): void {
        if (!st.source) { this.connect(st); }
        const url = st.url + "/api?pageId=" + encodeURIComponent(st.pageId);
        const body = Buffer.from(JSON.stringify(msg), "utf8");
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return;
        }
        const secure = parsed.protocol === "https:";
        const req = (secure ? https : http).request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (secure ? 443 : 80),
            method: "POST",
            path: parsed.pathname + parsed.search,
            headers: { "content-type": "application/json", "content-length": body.length },
        }, (res) => {
            res.resume();
            if ((res.statusCode ?? 0) >= 400) {
                this.opts.log(`[别台] 发给 ${this.nameOf(st.url)} 的消息没被收下（HTTP ${res.statusCode}）`);
            }
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, () => { try { req.destroy(); } catch { /* 已经断了 */ } });
        req.on("error", (err: any) => {
            this.opts.log(`[别台] 发给 ${this.nameOf(st.url)} 的消息没发出去：${err?.message || err}`);
        });
        req.end(body);
    }

    /** 问那台要一份 JSON（超时就当连不上）。 */
    private getJson(url: string, st?: MachineState): Promise<any> {
        return new Promise((resolve, reject) => {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                reject(new Error("地址不合法"));
                return;
            }
            const secure = parsed.protocol === "https:";
            const req = (secure ? https : http).get({
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (secure ? 443 : 80),
                path: parsed.pathname + parsed.search,
                headers: { accept: "application/json" },
            }, (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (chunk: string) => { text += chunk; });
                res.on("end", () => {
                    if ((res.statusCode ?? 0) !== 200) {
                        reject(new Error(`那台回了 HTTP ${res.statusCode}${text ? "（" + text.trim().slice(0, 60) + "）" : ""}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(text));
                    } catch {
                        reject(new Error("那台回的不是 JSON"));
                    }
                });
            });
            req.setTimeout(REQUEST_TIMEOUT_MS, () => { try { req.destroy(); } catch { /* 已经断了 */ } });
            req.on("error", (err: any) => {
                const why = err?.code === "ECONNREFUSED" ? "那台的端口没开着"
                    : err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN" ? "那个地址解析不了"
                    : err?.code === "EHOSTUNREACH" || err?.code === "ENETUNREACH" ? "这台到不了那个地址"
                    : (err?.message || "请求没发出去");
                const text = err?.code === "ETIMEDOUT" ? `${REQUEST_TIMEOUT_MS / 1000} 秒没回应` : why;
                if (st) { st.error = text; }
                reject(new Error(text));
            });
        });
    }
}

/**
 * 这些消息不带着对话正文（清屏、就绪、状态、账目那几样）：
 * 判断“这条会话打开以后见没见到内容”时不算数（见 onRemoteMessage）。
 */
const CONTENTLESS_TYPES = new Set([
    "clear", "piReady", "syncPoint", "queueUpdate", "stats", "percent", "modelChanged", "thinkingChanged",
    "commandList", "chatReferences", "historyWindow", "bashTasks", "viewOptionItems", "sessionList",
]);

/** 逐跳的响应头 / 请求头：转发时两边都不该带。 */
const HOP_BY_HOP = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
    "access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-headers",
    "access-control-allow-methods", "access-control-expose-headers", "access-control-max-age",
]);


/** 会话文件当钥匙用（那台上同一个文件只会有一条会话）。 */
function fileKey(file: string): string {
    return String(file || "").replace(/\\/g, "/").toLowerCase();
}

/** 两个目录写法算不算同一个（Windows 上不分大小写、斜杠两种写法都收）。 */
function sameDirText(a: unknown, b: unknown): boolean {
    // 两种分隔符都收（"/" 拿去 split 时两个都要切），末尾的斜杠不算，Windows 上不分大小写
    const norm = (one: unknown) => String(one || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const left = norm(a);
    return !!left && left === norm(b);
}

/** 地址里的主机:端口（界面上拿它当名字用）。 */
function hostOf(url: string): string {
    try {
        return new URL(url).host || url;
    } catch {
        return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    }
}

/** 列目录这件事在 dirBrowse 里（这里只是把它再导出一遍，给宿主那边的目录浏览用）。 */
export { listDirectories };

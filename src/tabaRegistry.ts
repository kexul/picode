/**
 * 派子会话（taba）：子会话的登记表与状态。
 *
 * 一个子会话就是一条记录：谁派的、派去干什么、开在哪个 tab、跑到哪一步、结果交回去几次。
 * 界面（tab 上的标记、右键菜单）和"结果自动交回"都读这张表。
 *
 * 本文件不碰文件、不碰 vscode，全是内存里的东西，方便单测。
 */
import type { TurnEndStatus } from "./runtimeTypes";
import type { TabaSessionMode } from "./tabaRoles";

/**
 * 子会话现在处于哪一步：
 *   starting  —— tab 建好了，任务还没发出去
 *   running   —— 正在跑第一轮
 *   waiting   —— 第一轮跑完（结果已交回），tab 留着等用户
 *   error     —— 第一轮出错了（结果也照样交回，好让派活那边知道）
 *   detached  —— 派它的那个会话已经关掉了，它现在是独立会话
 */
export type TabaChildState = "starting" | "running" | "waiting" | "error" | "detached";

export interface TabaChild {
    /** 子会话编号（pi 那边的扩展生成，模型也用它来指名停止）。 */
    id: string;
    name: string;
    task: string;
    /** 派活时指的角色名。 */
    agent?: string;
    /** 派活的那个 panel；那个会话关掉后为 undefined。 */
    parentPanelId?: string;
    /** 子会话自己的 panel / tab。 */
    childPanelId?: string;
    childTabId?: string;
    state: TabaChildState;
    startedAt: number;
    /** 第一轮跑完的时间。 */
    endedAt?: number;
    /** 第一轮跑完的收尾状态。 */
    lastStatus?: TurnEndStatus;
    /** 结果交回去几次（自动一次，之后用户可以手动再交）。 */
    deliveries: number;
    /** 子会话最后一轮的回复（交回去用）。 */
    result?: string;
    /** 子会话的会话文件路径（带上下文那两档一开始就有；全新会话要等 pi 落盘后才能问到）。 */
    sessionFile?: string;
    /** 派活那个会话的会话文件路径（名录文件里用：按名字找子会话时靠它确认是不是本会话派的）。 */
    parentSessionFile?: string;
    sessionMode: TabaSessionMode;
    /** 给界面看的一句话：用什么模型跑的。 */
    modelLabel?: string;
}

export class TabaRegistry {
    private byId = new Map<string, TabaChild>();
    /** panel id → 子会话编号（子会话那边反查用）。 */
    private byPanel = new Map<string, string>();

    public add(child: TabaChild): boolean {
        if (this.byId.has(child.id)) { return false; }
        this.byId.set(child.id, child);
        if (child.childPanelId) { this.byPanel.set(child.childPanelId, child.id); }
        return true;
    }

    public has(id: string): boolean { return this.byId.has(id); }
    public get(id: string): TabaChild | undefined { return this.byId.get(id); }
    public all(): TabaChild[] { return Array.from(this.byId.values()); }

    public byChildPanel(panelId: string): TabaChild | undefined {
        const id = this.byPanel.get(panelId);
        return id ? this.byId.get(id) : undefined;
    }

    /** 某个会话派出去的全部子会话（按派出顺序）。 */
    public childrenOf(panelId: string): TabaChild[] {
        return this.all().filter((c) => c.parentPanelId === panelId);
    }

    /** 还在跑或还留在界面上的（已经变成独立会话的不算）。 */
    public liveChildrenOf(panelId: string): TabaChild[] {
        return this.childrenOf(panelId).filter((c) => c.state !== "detached");
    }

    public attachPanel(id: string, panelId: string, tabId: string): void {
        const child = this.byId.get(id);
        if (!child) { return; }
        if (child.childPanelId) { this.byPanel.delete(child.childPanelId); }
        child.childPanelId = panelId;
        child.childTabId = tabId;
        this.byPanel.set(panelId, id);
    }

    public noteTaskSent(id: string): void {
        const child = this.byId.get(id);
        if (child && child.state === "starting") { child.state = "running"; }
    }

    /** 记录第一轮跑完之后的状态。 */
    public noteTurnEnd(id: string, status: TurnEndStatus, at: number): void {
        const child = this.byId.get(id);
        if (!child || child.endedAt !== undefined) { return; }
        child.endedAt = at;
        child.lastStatus = status;
        child.state = stateAfterTurnEnd(status);
    }

    public markDelivered(id: string, result?: string): void {
        const child = this.byId.get(id);
        if (!child) { return; }
        child.deliveries++;
        if (result !== undefined) { child.result = result; }
    }

    /** 父会话没了：它的子会话变成独立会话。返回受影响的子会话。 */
    public detachChildrenOf(panelId: string): TabaChild[] {
        const hit = this.childrenOf(panelId).filter((c) => c.state !== "detached");
        for (const c of hit) {
            c.parentPanelId = undefined;
            c.state = "detached";
        }
        return hit;
    }

    /** 某个 panel 被关掉时的清理：它是子会话就把记录摘掉（父会话那边由 detachChildrenOf 处理）。 */
    public forgetChildPanel(panelId: string): TabaChild | undefined {
        const id = this.byPanel.get(panelId);
        if (!id) { return undefined; }
        const child = this.byId.get(id);
        this.byPanel.delete(panelId);
        if (child) { this.byId.delete(id); }
        return child;
    }

    /** 按编号或名字在本会话派出去的子会话里找（模型指名停止时用）。 */
    public findByRef(parentPanelId: string, ref: { id?: string; name?: string }): TabaChild | undefined {
        const kids = this.childrenOf(parentPanelId);
        if (ref.id) {
            const exact = kids.find((c) => c.id === ref.id);
            if (exact) { return exact; }
        }
        if (ref.name) {
            const want = ref.name.trim().toLowerCase();
            const byName = kids.find((c) => c.name.trim().toLowerCase() === want)
                ?? kids.find((c) => c.name.toLowerCase().includes(want));
            if (byName) { return byName; }
        }
        return undefined;
    }
}

/** 第一轮跑完后的状态（纯函数，便于单测）。 */
export function stateAfterTurnEnd(status: TurnEndStatus): TabaChildState {
    return status === "done" ? "waiting" : "error";
}

/** 收尾状态的人话说法。 */
export function describeTurnStatus(status?: TurnEndStatus): string {
    switch (status) {
        case "cancelled": return "被中止了";
        case "error": return "这一轮报错了";
        case "done": return "跑完了";
        default: return "还没有结果";
    }
}

/** 子会话状态的人话说法（界面提示用）。 */
export function describeChildState(state: TabaChildState): string {
    switch (state) {
        case "starting": return "正在开";
        case "running": return "运行中";
        case "waiting": return "已完成，tab 留着";
        case "error": return "出错了";
        case "detached": return "已变成独立会话";
        default: return state;
    }
}

/** 把毫秒说成"1 小时 3 分"这种。 */
export function formatElapsedMs(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) { return "0 秒"; }
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) { return `${h} 小时 ${m} 分`; }
    if (m > 0) { return `${m} 分 ${s} 秒`; }
    return `${s} 秒`;
}

/**
 * 交回给父会话的那段文字（会当成一条用户消息发过去，模型据此接着干）。
 * @param result 子会话最后一条回复；空表示没拿到
 */
export function buildDeliveryText(p: {
    child: TabaChild;
    result: string;
    elapsedMs: number;
    status: TurnEndStatus;
    childTabName?: string;
    manual?: boolean;
}): string {
    const head = p.status === "done"
        ? `【子会话「${p.child.name}」跑完了，用时 ${formatElapsedMs(p.elapsedMs)}】`
        : `【子会话「${p.child.name}」没有正常跑完（${describeTurnStatus(p.status)}），已用 ${formatElapsedMs(p.elapsedMs)}】`;
    const body = p.result.trim() || "（没有拿到任何回复）";
    const tail = p.childTabName
        ? `（这个子会话还开在 tab「${p.childTabName}」里，用户可以在那边继续问；要补做点什么可以再派一个。）`
        : "（要补做点什么可以再派一个子会话。）";
    const parts = [head, "", body];
    if (p.manual) { parts.push("", "（这条是用户手动交的。）"); }
    parts.push("", tail);
    return parts.join("\n");
}

/** 派活成功时在父会话界面上打的一行提示。 */
export function buildSpawnNotice(p: { child: TabaChild; tabName: string; mode: TabaSessionMode }): string {
    const modeText = p.mode === "fork"
        ? "带上了本会话之前的对话"
        : p.mode === "lineage-only" ? "全新会话（只记着是本会话派的）" : "全新会话";
    return `已派出子会话「${p.child.name}」→ 新 tab「${p.tabName}」（${modeText}）。`
        + `它跑完第一轮后，结果会自动交回本会话。`;
}

/** 子会话 tab 里打的一行开场提示（只给用户看，不进对话记录）。 */
export function buildChildIntro(p: { child: TabaChild; parentTabName?: string }): string {
    const from = p.child.parentPanelId && p.parentTabName ? `由「${p.parentTabName}」派来` : "独立会话";
    return `子会话「${p.child.name}」（${from}）：${p.child.task.trim().split("\n")[0].slice(0, 80)}`;
}

/** 子会话的 tab 被关掉、结果还没交回时，给派活那个会话补一句。 */
export function buildChildClosedNotice(p: { child: TabaChild }): string {
    const ran = p.child.endedAt !== undefined;
    return `【子会话「${p.child.name}」的 tab 被关掉了，没有交回结果】`
        + (ran
            ? `它跑完了第一轮（用时 ${formatElapsedMs((p.child.endedAt ?? 0) - p.child.startedAt)}），但结果没来得及交回。`
            : "它第一轮还没跑完。")
        + "需要的话可以重新派一个。";
}

/** 派活失败时在父会话界面上打的一行提示。 */
export function buildSpawnFailure(p: { name: string; reason: string }): string {
    return `子会话「${p.name}」没派出去：${p.reason}`;
}

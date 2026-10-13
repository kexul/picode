/**
 * 派子会话（taba）：子会话的登记表与状态。
 *
 * 一个子会话就是一条记录：谁派的、派去干什么、开在哪个 tab、跑到哪一步、结果交回去几次。
 * 界面（会话列表里「正在对话」那段的标记）和"结果自动交回"都读这张表。
 *
 * 本文件不碰文件、不碰 vscode，全是内存里的东西。
 */
import type { TurnEndStatus } from "./runtimeTypes";

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
    /** 派活的那个 panel；那个会话关掉后为 undefined。 */
    parentPanelId?: string;
    /** 子会话自己的会话（跑在哪个 panel 上）。 */
    childPanelId?: string;
    state: TabaChildState;
    startedAt: number;
    /** 第一轮跑完的时间。 */
    endedAt?: number;
    /** 第一轮跑完的收尾状态。 */
    lastStatus?: TurnEndStatus;
    /** 结果交回去几次（现在只有第一轮跑完那一次会自动交）。 */
    deliveries: number;
    /** 子会话最后一轮的回复（交回去用）。 */
    result?: string;
    /** 子会话的会话文件路径（全新会话要等 pi 落盘后才能问到）。 */
    sessionFile?: string;
    /** 派活那个会话的会话文件路径（名录文件里用：按名字找子会话时靠它确认是不是本会话派的）。 */
    parentSessionFile?: string;
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

/** 第一轮跑完后的状态（纯函数）。 */
export function stateAfterTurnEnd(status: TurnEndStatus): TabaChildState {
    return status === "done" ? "waiting" : "error";
}

/**
 * 第一轮跑完、结果交回之后，要不要把这个子会话的 tab 关掉（纯函数）。
 * 不关的三种情况：没正常跑完（出错、被停）、父会话已经没了（没人接结果）、用户当时正看着它。
 */
export function shouldCloseAfterFirstTurn(p: {
    status: TurnEndStatus;
    /** 派它的那个会话还在不在（在，结果才交得回去）。 */
    hasParent: boolean;
    /** 用户当时是不是正在看这个子会话。 */
    isBeingWatched: boolean;
}): boolean {
    if (p.status !== "done") { return false; }
    if (!p.hasParent) { return false; }
    return !p.isBeingWatched;
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
    childSessionName?: string;
    /** 交回之后是不是立刻把这个子会话的 tab 关掉（见 shouldCloseAfterFirstTurn）。 */
    tabClosed?: boolean;
}): string {
    const head = p.status === "done"
        ? `【子会话「${p.child.name}」跑完了，用时 ${formatElapsedMs(p.elapsedMs)}】`
        : `【子会话「${p.child.name}」没有正常跑完（${describeTurnStatus(p.status)}），已用 ${formatElapsedMs(p.elapsedMs)}】`;
    const body = p.result.trim() || "（没有拿到任何回复）";
    const tail = p.tabClosed
        ? "（tab 已经自动关掉，要接着做就再派一个。）"
        : p.childSessionName
            ? `（tab 还开着（「${p.childSessionName}」），可以到那边接着问。）`
            : "（要补做点什么就再派一个。）";
    return [head, "", body, "", tail].join("\n");
}

/** 派活成功时在父会话界面上打的一行提示。 */
export function buildSpawnNotice(p: { child: TabaChild }): string {
    return `已派出子会话「${p.child.name}」。`;
}

/** 子会话里打的一行开场提示（只给用户看，不进对话记录）。 */
export function buildChildIntro(p: { child: TabaChild; parentName?: string }): string {
    const from = p.child.parentPanelId && p.parentName ? `（由「${p.parentName}」派来）` : "";
    return `子会话「${p.child.name}」${from}：${p.child.task.trim().split("\n")[0].slice(0, 80)}`;
}

/** 子会话被关掉、结果还没交回时，给派活那个会话补一句。 */
export function buildChildClosedNotice(p: { child: TabaChild }): string {
    const howFar = p.child.endedAt !== undefined
        ? `第一轮跑完了，用时 ${formatElapsedMs((p.child.endedAt ?? 0) - p.child.startedAt)}`
        : "第一轮还没跑完";
    return `【子会话「${p.child.name}」被关掉了（${howFar}），没交回结果，要接着做就重新派一个】`;
}

/** 派活失败时在父会话界面上打的一行提示。 */
export function buildSpawnFailure(p: { name: string; reason: string }): string {
    return `子会话「${p.name}」没派出去：${p.reason}`;
}

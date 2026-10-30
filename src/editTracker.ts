import * as fs from "fs";
import {
    diffCounts,
    extractErrorText,
    extractResultImages,
    extractResultText,
    extractTruncation,
    historyEditInfo,
    makeUnifiedDiff,
    toolFilePath,
} from "./messageUtils";
/** EditTracker 对外依赖（由 SessionRuntime 注入，避免环依赖）。 */
export interface EditTrackerHost {
    getCwd(): string;
    relativeTo(cwd: string, full: string): string;
    resolvePath(p: string): string;
    post(msg: Record<string, unknown>): void;
    onKnownFilesChanged(): void;
    /** 回滚前的二次确认：message 是整句话（不同回滚的说法不一样），返回是否继续。 */
    confirmRevert(message: string): Promise<boolean>;
    /** 工具输出一个字都不发（全文留在内存里，界面上点开再取），见 SessionRuntime.clipDetail。 */
    clipToolText(detailKey: string, text: string): { text: string; omitted?: number; detailKey?: string };
    /** 工具参数只带“一行字那么多”的摘要（整份点开提示框再取），见 SessionRuntime.summaryArgs。 */
    summaryToolArgs(toolCallId: string, args: unknown):
        { args?: Record<string, unknown>; argsOmitted?: number; detailKey?: string };
}

/** 「改动」那一格里的一行：这个会话把一个文件改成了什么样。 */
export interface SessionChangeInfo {
    /** 相对会话目录的写法（跟文件链接里的写法一样）。 */
    path: string;
    added: number;
    removed: number;
    /** 文件已经不在了（删掉了）。 */
    deleted: boolean;
    /** 太大，没法在这一格里比（不给增删行数，也看不到 diff）。 */
    tooBig: boolean;
}

/** 这一格愿意比的文本上限（跟文件侧边栏看文本那道线一样）：再大的不比，也不给整份拖去页面。 */
const MAX_CHANGE_BYTES = 2 * 1024 * 1024;

/**
 * 单个会话内的工具卡片推送 + edit/write 快照 / 回滚 / knownFiles。
 * 从 SessionRuntime 拆出，降低编排类体积。
 */
export class EditTracker {
    private pendingEdits = new Map<string, { path: string; before: string }>();
    private editSnapshots = new Map<string, { path: string; before: string; after: string }>();
    /** 每个文件「这个会话第一次改它之前」的内容（绝对路径 → 内容）：文件侧边栏那一格
     *  「改动」按它算合计 diff，也按它回滚。会话重开就没了（这一格本来也只在会话活着时看）。 */
    private fileBaselines = new Map<string, string>();
    /** 算过的 diff 攒着（绝对路径 → 它当时对应的磁盘状态与结果）：跟着改一次不用把
     *  整个文件重比一遍，「改动」那一格每来一条改动都会重问一次清单。 */
    private changeCache = new Map<string, { key: string; diff: string; added: number; removed: number; deleted: boolean }>();
    /** 工具调用的开始时间戳（toolCallId → ms）：结果回来时算这次跑了多久，
     *  随结果一起发给界面，汇总进统计弹窗（见 media/chat.js 的 noteToolDuration）。 */
    private toolStartedAt = new Map<string, number>();
    /** pi 本会话工具调用触及过的文件绝对路径。 */
    private knownFiles = new Set<string>();

    constructor(private readonly host: EditTrackerHost) {}

    public getKnownFiles(): string[] {
        return Array.from(this.knownFiles);
    }

    /** 这条工具的调用这会儿还在跑吗。重放历史时用：历史里没有结果的调用，到底是
     *  「还在跑」还是「那一轮被中断、结果永远不会来」，只能靠这张表分开。 */
    public isToolRunning(toolCallId: string): boolean {
        return this.toolStartedAt.has(toolCallId);
    }

    public reset(): void {
        this.pendingEdits.clear();
        this.editSnapshots.clear();
        this.fileBaselines.clear();
        this.changeCache.clear();
        this.toolStartedAt.clear();
        const hadKnown = this.knownFiles.size > 0;
        this.knownFiles.clear();
        if (hadKnown) {
            this.host.onKnownFilesChanged();
        }
    }

    /** 忘掉“哪些工具还在跑”。这一轮停稳了 / pi 进程没了的时候叫它：这时候不可能还有在跑的，
     *  留下的都是等不到结果的（它们要是还在表里，重放历史时会被当成还在跑，又转不完的圈）。 */
    public forgetRunningTools(): void {
        this.toolStartedAt.clear();
    }

    public onToolStart(evt: any): void {
        const toolName: string = evt.toolName;
        const isEditLike = toolName === "edit" || toolName === "write";
        const p = isEditLike ? this.editToolPath(toolName, evt.args) : null;
        if (evt.toolCallId) {
            this.toolStartedAt.set(evt.toolCallId, Date.now());
        }
        this.collectKnownFile(toolName, evt.args);
        if (p && evt.toolCallId) {
            this.host.post({
                type: "editCardStart",
                toolCallId: evt.toolCallId,
                toolName,
                path: p,
                label: this.host.relativeTo(this.host.getCwd(), p),
                ...this.summaryArgs(evt.toolCallId, evt.args),
            });
        } else {
            this.host.post({
                type: "tool",
                toolCallId: evt.toolCallId,
                toolName,
                ...this.summaryArgs(evt.toolCallId, evt.args),
            });
        }
    }

    /** 工具参数只带“一行字那么多”的摘要（命令、路径这些），整份点开提示框再取。 */
    private summaryArgs(toolCallId: string, args: unknown):
        { args?: Record<string, unknown>; argsOmitted?: number; detailKey?: string } {
        if (!toolCallId || args === undefined) { return {}; }
        return this.host.summaryToolArgs(toolCallId, args);
    }

    /** 工具输出一个字都不发；消息里只留“一共多少字 + 编号”（全文在会话那边留着，界面点开再取）。 */
    private clippedResult(toolCallId: string, text: string):
        { resultText: string; resultOmitted?: number; detailKey?: string } {
        const key = `result:${toolCallId}`;
        const clipped = this.host.clipToolText(key, text);
        if (clipped.omitted === undefined) { return { resultText: clipped.text }; }
        return { resultText: clipped.text, resultOmitted: clipped.omitted, detailKey: key };
    }

    public onToolUpdate(evt: any): void {
        const toolName: string = evt.toolName;
        if (toolName === "edit" || toolName === "write") {
            return;
        }
        const id: string = evt.toolCallId;
        if (!id) {
            return;
        }
        const started = this.toolStartedAt.get(id);
        this.host.post({
            type: "toolResultUpdate",
            toolCallId: id,
            ...this.clippedResult(id, extractResultText(evt.partialResult) ?? ""),
            durationMs: typeof started === "number" ? Date.now() - started : undefined,
        });
    }

    public onToolEnd(evt: any): void {
        const toolName: string = evt.toolName;
        if (toolName !== "edit" && toolName !== "write") {
            if (evt.toolCallId) {
                const started = this.toolStartedAt.get(evt.toolCallId);
                this.toolStartedAt.delete(evt.toolCallId);
                const truncation = extractTruncation(evt.result);
                this.host.post({
                    type: "toolResult",
                    toolCallId: evt.toolCallId,
                    isError: !!evt.isError,
                    ...this.clippedResult(evt.toolCallId, extractResultText(evt.result) ?? ""),
                    durationMs: typeof started === "number" ? Date.now() - started : undefined,
                    truncation,
                    images: extractResultImages(evt.result),
                });
            }
            return;
        }
        if (!evt.toolCallId) {
            return;
        }
        const started = this.toolStartedAt.get(evt.toolCallId);
        this.toolStartedAt.delete(evt.toolCallId);
        const details = !evt.isError ? evt.result?.details : undefined;
        const errorText = evt.isError ? extractErrorText(evt.result) : undefined;
        this.host.post({
            type: "editCardResult",
            toolCallId: evt.toolCallId,
            diff: typeof details?.diff === "string" ? details.diff : undefined,
            isError: !!evt.isError,
            errorText,
            canRevert: !evt.isError && this.editSnapshots.has(evt.toolCallId),
            durationMs: typeof started === "number" ? Date.now() - started : undefined,
        });
    }

    public trackEditStart(evt: any): void {
        const p = this.editToolPath(evt.toolName, evt.args);
        if (!p || !evt.toolCallId) {
            return;
        }
        let before = "";
        try {
            before = fs.readFileSync(p, "utf8");
        } catch {
            before = "";
        }
        this.pendingEdits.set(evt.toolCallId, { path: p, before });
        // 这个会话第一次改它：把「改之前」留一份（后面再改几次都还按这一份算合计）
        if (!this.fileBaselines.has(p)) {
            this.fileBaselines.set(p, before);
        }
    }

    public trackEditEnd(evt: any): void {
        const id = evt.toolCallId;
        if (!id) {
            return;
        }
        const pend = this.pendingEdits.get(id);
        this.pendingEdits.delete(id);
        if (!pend || evt.isError) {
            return;
        }
        let after = "";
        try {
            after = fs.readFileSync(pend.path, "utf8");
        } catch {
            return;
        }
        if (after === pend.before) {
            return;
        }
        this.editSnapshots.set(id, { path: pend.path, before: pend.before, after });
        // 清单变了：让界面把「改动」那一格重问一遍（没开着这一格的话它自己不画）
        this.host.post({ type: "changesChanged" });
    }

    public async revertEdit(toolCallId: string): Promise<void> {
        const snap = this.editSnapshots.get(toolCallId);
        if (!snap) {
            this.host.post({ type: "systemError", text: "无法回滚：缺失修改前的快照。" });
            return;
        }
        const label = this.host.relativeTo(this.host.getCwd(), snap.path);

        let current = "";
        try {
            current = fs.readFileSync(snap.path, "utf8");
        } catch {
            current = "";
        }
        if (current === snap.before) {
            this.host.post({ type: "system", text: `无需回滚：${label} 已是修改前的内容。` });
            this.host.post({ type: "editReverted", toolCallId });
            return;
        }
        if (current !== snap.after) {
            const ok = await this.host.confirmRevert(
                `${label} 在此次修改后又被变更过，回滚将丢弃那些后续变更。确定继续？`
            );
            if (!ok) {
                return;
            }
        }

        try {
            fs.writeFileSync(snap.path, snap.before, "utf8");
        } catch (e: any) {
            this.host.post({ type: "systemError", text: `回滚失败: ${e.message}` });
            return;
        }

        this.editSnapshots.delete(toolCallId);
        this.host.post({ type: "editReverted", toolCallId });
        this.host.post({ type: "system", text: `已回滚: ${label}` });
    }

    /**
     * 这个会话改过的文件清单（按路径排），给文件侧边栏那一格「改动」用。
     * 只算真出了差别的：改了又改回去的、失败的编辑都不列。
     */
    public changes(): SessionChangeInfo[] {
        const out: SessionChangeInfo[] = [];
        for (const abs of this.fileBaselines.keys()) {
            const info = this.changeOf(abs);
            if (!info) { continue; }
            if (!info.diff && !info.tooBig) { continue; }
            out.push({
                path: info.path,
                added: info.added,
                removed: info.removed,
                deleted: info.deleted,
                tooBig: info.tooBig,
            });
        }
        out.sort((a, b) => a.path.localeCompare(b.path));
        return out;
    }

    /** 一个文件的合计 diff（本会话第一次改它之前 → 现在磁盘上的）；没改出差别就不给。 */
    public changeDiff(relPath: string): string | undefined {
        const abs = this.changeAbsOf(relPath);
        const info = abs ? this.changeOf(abs) : undefined;
        return info && info.diff ? info.diff : undefined;
    }

    /**
     * 把一个文件整份写回这个会话第一次改它之前的样子。
     * 界面那边已经问过一遍了（「改动」那一格里的「回滚」要连点两下才走到这儿，见 chat.js 的
     * askRevertChange），所以这里不再往消息流里塞确认卡片。
     */
    public async revertFileChanges(relPath: string): Promise<void> {
        const abs = this.changeAbsOf(relPath);
        const before = abs === undefined ? undefined : this.fileBaselines.get(abs);
        if (abs === undefined || before === undefined) {
            this.host.post({ type: "systemError", text: "无法回滚：缺失修改前的快照。" });
            return;
        }
        const label = this.host.relativeTo(this.host.getCwd(), abs);
        let current: string | undefined;
        try {
            current = fs.readFileSync(abs, "utf8");
        } catch {
            current = undefined;   // 文件被删了：写回去就是恢复它
        }
        if (current === before) {
            this.host.post({ type: "system", text: `无需回滚：${label} 已是修改前的内容。` });
            this.host.post({ type: "changesChanged" });
            return;
        }
        try {
            fs.writeFileSync(abs, before, "utf8");
        } catch (e: any) {
            this.host.post({ type: "systemError", text: `回滚失败: ${e.message}` });
            return;
        }
        this.changeCache.delete(abs);
        this.host.post({ type: "system", text: `已回滚: ${label}` });
        this.host.post({ type: "changesChanged" });
    }

    /** 界面报的是相对写法（跟清单里那一行一样）：按它找回这个文件的绝对路径。 */
    private changeAbsOf(relPath: string): string | undefined {
        for (const abs of this.fileBaselines.keys()) {
            if (this.host.relativeTo(this.host.getCwd(), abs) === relPath) { return abs; }
        }
        return undefined;
    }

    /**
     * 一个文件现在的合计 diff 与增删行数（本会话第一次改之前 → 现在磁盘上的）。
     * 磁盘状态（修改时间 + 大小）没变就用上次算的，改一下不必把整个文件重新比一遍。
     */
    private changeOf(abs: string): { path: string; added: number; removed: number;
        deleted: boolean; tooBig: boolean; diff: string } | undefined {
        const before = this.fileBaselines.get(abs);
        if (before === undefined) { return undefined; }
        const relPath = this.host.relativeTo(this.host.getCwd(), abs);
        let current = "";
        let deleted = false;
        let key = "deleted";
        let tooBig = before.length > MAX_CHANGE_BYTES;
        try {
            const st = fs.statSync(abs);
            key = `${st.mtimeMs}:${st.size}`;
            if (st.size > MAX_CHANGE_BYTES) { tooBig = true; } else { current = fs.readFileSync(abs, "utf8"); }
        } catch {
            deleted = true;   // 文件没了：整份都算删掉
        }
        if (tooBig) {
            return { path: relPath, added: 0, removed: 0, deleted, tooBig: true, diff: "" };
        }
        const cached = this.changeCache.get(abs);
        if (cached && cached.key === key) {
            return { path: relPath, ...cached, tooBig: false };
        }
        const diff = makeUnifiedDiff(before, current);
        const counts = diffCounts(diff);
        this.changeCache.set(abs, { key, diff, ...counts, deleted });
        return { path: relPath, diff, ...counts, deleted, tooBig: false };
    }

    /** 收集 pi 工具调用涉及的具体文件路径（read/edit/write）。 */
    public collectKnownFile(toolName: string, args: unknown): void {
        if (toolName !== "read" && toolName !== "edit" && toolName !== "write") {
            return;
        }
        const raw = toolFilePath(args);
        if (!raw) {
            return;
        }
        const resolved = this.host.resolvePath(raw);
        if (this.knownFiles.has(resolved)) {
            return;
        }
        this.knownFiles.add(resolved);
        this.host.onKnownFilesChanged();
    }

    public editToolPath(toolName: string, args: unknown): string | null {
        if (toolName !== "edit" && toolName !== "write") {
            return null;
        }
        const raw = toolFilePath(args);
        if (!raw) {
            return null;
        }
        return this.host.resolvePath(raw);
    }

    /** 历史消息回放时的 edit/write diff 文本。 */
    public historyDiff(call: any, result: any): string | undefined {
        return historyEditInfo(call, result);
    }

    /** 是否存在该次修改的“修改前”快照（活体迁移后重放用：快照还在就能回滚）。 */
    public hasSnapshot(toolCallId: string): boolean {
        return this.editSnapshots.has(toolCallId);
    }

}

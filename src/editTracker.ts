import * as fs from "fs";
import {
    extractErrorText,
    extractResultImages,
    extractResultText,
    extractTruncation,
    historyEditInfo,
    toolFilePath,
} from "./messageUtils";
import { fitResultImages } from "./imageFit";
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

/**
 * 单个会话内的工具卡片推送 + edit/write 快照 / 回滚 / knownFiles。
 * 从 SessionRuntime 拆出，降低编排类体积。
 */
export class EditTracker {
    /** 跑完的调用最多记着多少次用时（重放历史时用；再多就不记了，老的那些干脆不算）。 */
    private static readonly MAX_REMEMBERED_DURATIONS = 400;
    private pendingEdits = new Map<string, { path: string; before: string }>();
    private editSnapshots = new Map<string, { path: string; before: string; after: string }>();
    /** 工具调用的开始时间戳（toolCallId → ms）：结果回来时算这次跑了多久，
     *  随结果一起发给界面，汇总进统计弹窗（见 media/chat.js 的 noteToolDuration）。 */
    private toolStartedAt = new Map<string, number>();
    /** 已经跑完的那些各花了多久（toolCallId → ms）。重放历史时结果里也带上它，
     *  这样刷新页面 / 重连之后统计弹窗里的数还是真的、不是从零算（定个上限，老的不再留）。 */
    private toolDurations = new Map<string, number>();
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

    /** 这条工具是什么时候开始跑的（毫秒；表里没有就是没在跑，返回 0）。
     *  重放历史时发给页面：那条「正在跑」后面的耗时得从真开始那一刻数，
     *  不能按页面打开 / 重连的那一刻。 */
    public toolStartedAtOf(toolCallId: string): number {
        return this.toolStartedAt.get(toolCallId) ?? 0;
    }

    /** 这条跑完的调用当时用了多久（毫秒；没记着就是 undefined）。重放历史时带上它
     *  （见下面的 rememberDuration）。 */
    public toolDurationMsOf(toolCallId: string): number | undefined {
        return this.toolDurations.get(toolCallId);
    }

    /** 记下这次跑完的用时（只留最近的一批：老的那些重放时算不出来就不算，不编数字）。 */
    private rememberDuration(toolCallId: string, ms: number | undefined): void {
        if (!toolCallId || typeof ms !== "number" || !isFinite(ms) || ms < 0) { return; }
        this.toolDurations.delete(toolCallId);
        this.toolDurations.set(toolCallId, ms);
        if (this.toolDurations.size > EditTracker.MAX_REMEMBERED_DURATIONS) {
            const oldest = this.toolDurations.keys().next();
            if (!oldest.done) { this.toolDurations.delete(oldest.value); }
        }
    }

    public reset(): void {
        this.pendingEdits.clear();
        this.editSnapshots.clear();
        this.toolStartedAt.clear();
        this.toolDurations.clear();
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
        // 开始时刻随消息一起发给页面：「正在跑」那一行后面的耗时按它算（见 media/chat.js 的 toolStartedAt）
        const startedAt = evt.toolCallId ? this.toolStartedAt.get(evt.toolCallId) : 0;
        this.collectKnownFile(toolName, evt.args);
        if (p && evt.toolCallId) {
            this.host.post({
                type: "editCardStart",
                toolCallId: evt.toolCallId,
                toolName,
                path: p,
                label: this.host.relativeTo(this.host.getCwd(), p),
                startedAt,
                ...this.summaryArgs(evt.toolCallId, evt.args),
            });
        } else {
            this.host.post({
                type: "tool",
                toolCallId: evt.toolCallId,
                toolName,
                startedAt,
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
                const durationMs = typeof started === "number" ? Date.now() - started : undefined;
                this.rememberDuration(evt.toolCallId, durationMs);
                const truncation = extractTruncation(evt.result);
                this.host.post({
                    type: "toolResult",
                    toolCallId: evt.toolCallId,
                    isError: !!evt.isError,
                    ...this.clippedResult(evt.toolCallId, extractResultText(evt.result) ?? ""),
                    durationMs,
                    truncation,
                    // 当场推给页面的图也先缩一缩（截图两三 MB 一张，手机上边跑边下很难受；
                    // 只在 Windows 上生效，别的系统上照原样发，见 src/imageFit.ts）
                    images: fitResultImages(extractResultImages(evt.result)),
                });
            }
            return;
        }
        if (!evt.toolCallId) {
            return;
        }
        const started = this.toolStartedAt.get(evt.toolCallId);
        this.toolStartedAt.delete(evt.toolCallId);
        const durationMs = typeof started === "number" ? Date.now() - started : undefined;
        this.rememberDuration(evt.toolCallId, durationMs);
        const details = !evt.isError ? evt.result?.details : undefined;
        const errorText = evt.isError ? extractErrorText(evt.result) : undefined;
        this.host.post({
            type: "editCardResult",
            toolCallId: evt.toolCallId,
            diff: typeof details?.diff === "string" ? details.diff : undefined,
            isError: !!evt.isError,
            errorText,
            canRevert: !evt.isError && this.editSnapshots.has(evt.toolCallId),
            durationMs,
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
     * 一个文件被整个撤回去了（「改动」里那份 diff 的「回滚」）：各次调用的快照跟着作废，
     * 提示框里那些卡片不再给「回滚」（它们要的是中间那个样子，跟现在对不上了）。
     * @returns 作废掉的那几次调用（界面按「已回滚」把它们划掉）
     */
    public forgetSnapshotsOf(relPath: string): string[] {
        const abs = this.host.resolvePath(relPath);
        const gone: string[] = [];
        for (const [id, snap] of Array.from(this.editSnapshots.entries())) {
            if (snap.path !== abs) { continue; }
            this.editSnapshots.delete(id);
            gone.push(id);
        }
        return gone;
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

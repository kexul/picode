import * as fs from "fs";
import {
    extractErrorText,
    extractResultText,
    extractTruncation,
    historyEditInfo,
    toolFilePath,
} from "./messageUtils";
import type { FileChange } from "./runtimeTypes";

/** EditTracker 对外依赖（由 SessionRuntime 注入，避免环依赖）。 */
export interface EditTrackerHost {
    getCwd(): string;
    relativeTo(cwd: string, full: string): string;
    resolvePath(p: string): string;
    post(msg: Record<string, unknown>): void;
    onKnownFilesChanged(): void;
    confirmRevert(label: string): Promise<boolean>;
}

/**
 * 单个 tab 内的工具卡片推送 + edit/write 快照 / 回滚 / knownFiles。
 * 从 SessionRuntime 拆出，降低编排类体积。
 */
export class EditTracker {
    private fileChanges = new Map<string, FileChange>();
    private pendingEdits = new Map<string, { path: string; before: string }>();
    private editSnapshots = new Map<string, { path: string; before: string; after: string }>();
    /** 非 edit 工具的开始时间戳（toolCallId → ms），用于卡片耗时显示。 */
    private toolStartedAt = new Map<string, number>();
    /** pi 本会话工具调用触及过的文件绝对路径。 */
    private knownFiles = new Set<string>();

    constructor(private readonly host: EditTrackerHost) {}

    public getFileChange(path: string): FileChange | undefined {
        return this.fileChanges.get(path);
    }

    public getKnownFiles(): string[] {
        return Array.from(this.knownFiles);
    }

    public reset(): void {
        this.fileChanges.clear();
        this.pendingEdits.clear();
        this.editSnapshots.clear();
        this.toolStartedAt.clear();
        const hadKnown = this.knownFiles.size > 0;
        this.knownFiles.clear();
        this.postFileChanges();
        if (hadKnown) {
            this.host.onKnownFilesChanged();
        }
    }

    public onToolStart(evt: any): void {
        const toolName: string = evt.toolName;
        const isEditLike = toolName === "edit" || toolName === "write";
        const p = isEditLike ? this.editToolPath(toolName, evt.args) : null;
        if (evt.toolCallId && !isEditLike) {
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
                args: evt.args,
            });
        } else {
            this.host.post({
                type: "tool",
                toolCallId: evt.toolCallId,
                toolName,
                args: evt.args,
            });
        }
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
            resultText: extractResultText(evt.partialResult),
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
                    resultText: extractResultText(evt.result),
                    durationMs: typeof started === "number" ? Date.now() - started : undefined,
                    truncation,
                });
            }
            return;
        }
        if (!evt.toolCallId) {
            return;
        }
        const details = !evt.isError ? evt.result?.details : undefined;
        const errorText = evt.isError ? extractErrorText(evt.result) : undefined;
        this.host.post({
            type: "editCardResult",
            toolCallId: evt.toolCallId,
            diff: typeof details?.diff === "string" ? details.diff : undefined,
            isError: !!evt.isError,
            errorText,
            canRevert: !evt.isError && this.editSnapshots.has(evt.toolCallId),
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
        const existing = this.fileChanges.get(pend.path);
        if (!existing) {
            this.fileChanges.set(pend.path, {
                path: pend.path,
                label: this.host.relativeTo(this.host.getCwd(), pend.path),
                before: pend.before,
            });
        }
        this.postFileChanges();
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

        const existing = this.fileChanges.get(snap.path);
        if (existing) {
            let latest = "";
            try {
                latest = fs.readFileSync(snap.path, "utf8");
            } catch {
                latest = "";
            }
            if (latest === existing.before) {
                this.fileChanges.delete(snap.path);
            }
            this.postFileChanges();
        }

        this.editSnapshots.delete(toolCallId);
        this.host.post({ type: "editReverted", toolCallId });
        this.host.post({ type: "system", text: `已回滚: ${label}` });
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

    private postFileChanges(): void {
        const files = Array.from(this.fileChanges.values()).map((c) => ({
            path: c.path,
            label: c.label,
        }));
        this.host.post({ type: "fileChanges", files });
    }
}

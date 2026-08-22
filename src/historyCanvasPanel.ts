import * as vscode from "vscode";
import {
    CANVAS_FAMILY_PAGE_SIZE,
    buildCanvasFamilies,
    findFamilyBySessionFile,
    pathIdsToRoot,
    sameSessionFile,
    type CanvasFamily,
} from "./canvasData";
import { buildSessionTree, type SessionTreeNode } from "./sessionStore";
import { getHistoryCanvasHtml } from "./historyCanvasHtml";

export interface HistoryCanvasHost {
    getCwd(): string;
    getActiveSessionPath(): string | undefined;
    openSessionAtEntry(file: string, entryId: string): Promise<void>;
}

/**
 * 历史会话 WebviewPanel：邮件客户端式列表与阅读预览。
 * 快照加载：打开 / 刷新 / 加载更多时读盘；不订阅实时消息。
 */
export class HistoryCanvasPanel {
    public static readonly viewType = "piChat.historyCanvas";

    private panel: vscode.WebviewPanel | undefined;
    private tree: SessionTreeNode[] = [];
    private familyOffset = 0;
    private loadedFamilies: CanvasFamily[] = [];
    private focusSessionPath: string | undefined;
    private webviewReady = false;
    /** webview 未 ready 时暂存要推送的 init/append。 */
    private pendingPost: Record<string, unknown> | undefined;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly host: HistoryCanvasHost
    ) {}

    /** 打开或揭示历史会话。focusCurrent=true 时选中当前 tab 所在的会话线程。 */
    public async show(opts?: { focusCurrent?: boolean }): Promise<void> {
        const focusCurrent = !!opts?.focusCurrent;
        this.focusSessionPath = focusCurrent ? this.host.getActiveSessionPath() : undefined;

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One, true);
        } else {
            this.webviewReady = false;
            this.pendingPost = undefined;
            this.panel = vscode.window.createWebviewPanel(
                HistoryCanvasPanel.viewType,
                "Pi Chat 历史会话",
                { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [this.context.extensionUri],
                }
            );
            this.panel.webview.html = getHistoryCanvasHtml(
                this.panel.webview,
                this.context.extensionUri
            );
            this.panel.webview.onDidReceiveMessage(
                (msg) => { void this.onMessage(msg); },
                undefined,
                this.disposables
            );
            this.panel.onDidDispose(
                () => {
                    this.panel = undefined;
                    this.webviewReady = false;
                    this.pendingPost = undefined;
                    this.disposeSubs();
                },
                undefined,
                this.disposables
            );
        }

        await this.reload(true);
    }

    private disposeSubs(): void {
        for (const d of this.disposables) {
            try { d.dispose(); } catch { /* ignore */ }
        }
        this.disposables = [];
    }

    private post(msg: Record<string, unknown>): void {
        if (!this.panel) {
            return;
        }
        if (!this.webviewReady) {
            // 只缓存最新快照类消息；loadMore 的 append 在 ready 前几乎不会发生
            if (msg.type === "init" || msg.type === "append" || msg.type === "error") {
                this.pendingPost = msg;
            }
            return;
        }
        void this.panel.webview.postMessage(msg);
    }

    private async reload(resetFocus: boolean): Promise<void> {
        const cwd = this.host.getCwd();
        try {
            this.tree = await buildSessionTree(cwd);
        } catch (e: any) {
            this.post({ type: "error", text: `读取会话失败: ${e?.message || e}` });
            return;
        }
        this.familyOffset = 0;
        this.loadedFamilies = [];

        if (this.tree.length === 0) {
            this.post({
                type: "init",
                families: [],
                totalFamilies: 0,
                loadedFamilies: 0,
                focus: null,
            });
            return;
        }

        const page = await buildCanvasFamilies(this.tree, 0, CANVAS_FAMILY_PAGE_SIZE);
        this.familyOffset = page.loadedFamilies;
        this.loadedFamilies = page.families;

        // 若聚焦会话不在首屏，继续加载直到找到或耗尽
        if (this.focusSessionPath) {
            while (
                !findFamilyBySessionFile(this.loadedFamilies, this.focusSessionPath) &&
                this.familyOffset < this.tree.length
            ) {
                const more = await buildCanvasFamilies(
                    this.tree,
                    this.familyOffset,
                    CANVAS_FAMILY_PAGE_SIZE
                );
                if (more.loadedFamilies === 0) {
                    break;
                }
                this.familyOffset += more.loadedFamilies;
                this.loadedFamilies.push(...more.families);
            }
        }

        const focus = resetFocus ? this.buildFocus() : null;
        this.post({
            type: "init",
            families: this.loadedFamilies,
            totalFamilies: this.tree.length,
            loadedFamilies: this.familyOffset,
            focus,
        });
    }

    private buildFocus(): {
        sessionFile?: string;
        familyId?: string;
        pathIds?: string[];
    } | null {
        if (!this.focusSessionPath) {
            return null;
        }
        const fam = findFamilyBySessionFile(this.loadedFamilies, this.focusSessionPath);
        if (!fam) {
            return { sessionFile: this.focusSessionPath };
        }
        const sess = fam.sessions.find((s) => sameSessionFile(s.file, this.focusSessionPath));
        const pathIds = pathIdsToRoot(fam.messages, sess?.leafId);
        return {
            sessionFile: sess?.file || this.focusSessionPath,
            familyId: fam.id,
            pathIds,
        };
    }

    private async loadMore(): Promise<void> {
        if (this.familyOffset >= this.tree.length) {
            this.post({
                type: "append",
                families: [],
                totalFamilies: this.tree.length,
                loadedFamilies: this.familyOffset,
            });
            return;
        }
        try {
            const page = await buildCanvasFamilies(
                this.tree,
                this.familyOffset,
                CANVAS_FAMILY_PAGE_SIZE
            );
            this.familyOffset += page.loadedFamilies;
            this.loadedFamilies.push(...page.families);
            this.post({
                type: "append",
                families: page.families,
                totalFamilies: this.tree.length,
                loadedFamilies: this.familyOffset,
            });
        } catch (e: any) {
            this.post({ type: "error", text: `加载更多失败: ${e?.message || e}` });
        }
    }

    private async onMessage(msg: any): Promise<void> {
        if (!msg || typeof msg !== "object") {
            return;
        }
        switch (msg.type) {
            case "ready":
                this.webviewReady = true;
                if (this.pendingPost) {
                    const pending = this.pendingPost;
                    this.pendingPost = undefined;
                    void this.panel?.webview.postMessage(pending);
                }
                return;
            case "refresh":
                // 刷新保持当前浏览状态：不自动跟随当前 tab（避免路径黄圈高亮 + 视角跳回）
                await this.reload(true);
                return;
            case "loadMore":
                await this.loadMore();
                return;
            case "openEntry":
                if (typeof msg.file === "string" && typeof msg.entryId === "string") {
                    await this.host.openSessionAtEntry(msg.file, msg.entryId);
                }
                return;
            default:
                return;
        }
    }

    public dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
        this.disposeSubs();
    }
}

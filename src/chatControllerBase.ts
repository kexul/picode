/**
 * ChatControllerBase —— VSCode 插件的会话编排层。
 *
 * 两级模型：
 *   - Tab（容器）：tab 栏上的一个条目。每个 tab 持有自己的**布局树**
 *     （递归二叉树：panel 叶子 | 横/竖分叉节点），tab 间互不影响。
 *   - Panel（会话）：一个 SessionRuntime = 一个独立 pi 进程。
 *     Panel 通过拖拽在布局内移动、跨 tab 搬家、拖到空白处新建 tab。
 *
 * 本类收敛“与平台无关”的逻辑：
 *   - Tab / panel 管理（newTab / setActive / switchTabByDirection / closeTab /
 *     closePanel / addPanel / forkPanel / movePanel / focusPanel）
 *   - 拾取器浮层（showPicker / resolvePicker）
 *   - 模型选择器（pickModelInteractive）+ 模型内思考强度
 *   - 路径工具（relativeTo / resolvePath / resolveExecutable / checkPiAvailable）
 *   - 显示选项（sendViewOptions / buildViewOptionItems / showOptionsPicker + 标签常量）
 *   - 会话加载 / 分叉（loadHistorySession / forkAtEntryInNewTab / maybeAutoLoadLastSession / showHistoryPicker）
 *   - webview 消息分发（processMessage 的公共部分）
 *
 * 子类只需实现“平台钩子”：消息如何送到 webview、配置/视图选项存储、
 * 对话框 / diff / 文件打开的实现，以及各自独有的消息类型。
 *
 * 本类不引用 `vscode`，便于单测时 mock RuntimeHost。
 */
import * as fs from "fs";
import * as path from "path";
import { SessionRuntime, RuntimeHost, FileChange, ModelInfo, ModelChoice, StatusInfo, } from "./sessionRuntime";
import { PiConfig } from "./sessionRuntime";
import { PiClient } from "./piClient";
import {
    buildSessionTree,
    flattenTreeByFamilies,
    readSessionPreview,
    SESSION_FAMILY_PAGE_SIZE,
    SessionTreeNode,
    SessionItem,
} from "./sessionStore";
import { randomNameParts, composeName } from "./names";
import type { RpcSessionState } from "./piRpc";

// ============================================================================
//  布局树（tab 内的 panel 排布）
// ============================================================================

export type SplitOrientation = "h" | "v";

/** 布局节点：panel 叶子，或横/竖分叉（children 同层等分）。 */
export type LayoutNode =
    | { kind: "panel"; panelId: string }
    | { kind: "split"; orientation: SplitOrientation; children: LayoutNode[] };

/** 一个 tab（容器）：tab 栏条目 + 布局树 + 焦点 panel。 */
export interface TabContainer {
    id: string;
    root: LayoutNode;
    /** 最后点击的 panel；驱动输入框发送、状态栏、fork 等操作目标。 */
    focusPanelId?: string;
}

/** 拖动落点方位（相对目标 panel）。center = 替换目标。 */
export type DropZone = "left" | "right" | "top" | "bottom" | "center";

/** 收集布局树中的全部 panel id（深度优先序）。 */
export function layoutLeaves(node: LayoutNode): string[] {
    if (node.kind === "panel") { return [node.panelId]; }
    const out: string[] = [];
    for (const c of node.children) { out.push(...layoutLeaves(c)); }
    return out;
}

/** 从布局树中摘除某 panel；父分叉只剩一子时坍缩为那一子。整树空返回 null。 */
export function layoutRemove(node: LayoutNode, panelId: string): LayoutNode | null {
    if (node.kind === "panel") { return node.panelId === panelId ? null : node; }
    const kids: LayoutNode[] = [];
    for (const c of node.children) {
        const r = layoutRemove(c, panelId);
        if (r) { kids.push(r); }
    }
    if (kids.length === 0) { return null; }
    if (kids.length === 1) { return kids[0]; }
    return { kind: "split", orientation: node.orientation, children: kids };
}

/** 把 anchor 叶子原地替换成 repl（anchor 不存在时原样返回）。 */
export function layoutReplaceLeaf(node: LayoutNode, anchorId: string, repl: LayoutNode): LayoutNode {
    if (node.kind === "panel") { return node.panelId === anchorId ? repl : node; }
    return { kind: "split", orientation: node.orientation, children: node.children.map((c) => layoutReplaceLeaf(c, anchorId, repl)) };
}

/** zone → 相对 anchor 的分叉方向与插入位置。 */
function zoneToInsert(zone: DropZone): { orientation: SplitOrientation; before: boolean } {
    switch (zone) {
        case "left": return { orientation: "h", before: true };
        case "top": return { orientation: "v", before: true };
        case "bottom": return { orientation: "v", before: false };
        case "right":
        default: return { orientation: "h", before: false };
    }
}

/**
 * 把 leaf 插入 anchor 叶子旁边。
 * - anchor 所在父分叉方向一致：直接插进 children（保持扁平）；
 * - 否则把 anchor 包进一个新分叉节点。
 */
export function layoutInsertAdjacent(
    node: LayoutNode, anchorId: string, leaf: LayoutNode,
    orientation: SplitOrientation, before: boolean
): LayoutNode {
    if (node.kind === "panel") {
        if (node.panelId !== anchorId) { return node; }
        return { kind: "split", orientation, children: before ? [leaf, node] : [node, leaf] };
    }
    const idx = node.children.findIndex((c) => c.kind === "panel" && c.panelId === anchorId);
    if (idx >= 0) {
        const kids = node.children.slice();
        if (node.orientation === orientation) {
            kids.splice(before ? idx : idx + 1, 0, leaf);
        } else {
            kids[idx] = { kind: "split", orientation, children: before ? [leaf, kids[idx]] : [kids[idx], leaf] };
        }
        return { kind: "split", orientation: node.orientation, children: kids };
    }
    return {
        kind: "split",
        orientation: node.orientation,
        children: node.children.map((c) => layoutInsertAdjacent(c, anchorId, leaf, orientation, before)),
    };
}

export interface ChatReferenceItem {
    kind: "tab" | "panel";
    id: string;
    label: string;
    sub: string;
    tabId: string;
}

export abstract class ChatControllerBase implements RuntimeHost {
    protected constructor(public readonly workspaceId: string) {}
    // ---- panel（会话运行时）----
    protected panels = new Map<string, SessionRuntime>();
    protected panelSeq = 0;

    // ---- tab（容器）----
    protected tabContainers = new Map<string, TabContainer>();
    protected activeTabId: string | undefined; // 活跃 tab（容器）id（前端同名变量是焦点 panel id，注意区分）
    protected tabSeq = 0;
    protected autoLoadDone = false;

    /** tabList 节流：流式 activity 变更很频繁，合并到下一帧附近推送。 */
    private tabListTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly TAB_LIST_THROTTLE_MS = 48;

    // ---- 拾取器状态 ----
    protected pickerResolve: ((v: any | undefined) => void) | null = null;
    protected pickerTimer: ReturnType<typeof setTimeout> | null = null;

    // ---- 历史拾取器分页状态 ----
    /** 全量会话家族树（buildSessionTree 一次构建，加载更多时复用）。 */
    protected historyTree: SessionTreeNode[] = [];
    /** 已加载到第几个家族（加载更多时累加）。 */
    protected historyFamilyOffset = 0;

    // ---- 备用 pi 进程池（热备，免冷启动）----
    /** 已就绪的备用 pi 进程（不绑定任何 panel）。 */
    protected spare: PiClient | null = null;
    /** 正在后台预热、尚未就绪的备用进程（防止并发 spawn 多个）。 */
    protected preparingSpare: PiClient | null = null;
    /** 备用进程启动时使用的模型（领取时随进程一起返回，供继承比对）。 */
    protected spareMeta?: { provider?: string; modelId?: string };
    /** 备用进程延迟预热定时器（disposeSpare 清理）。 */
    protected spareTimer?: ReturnType<typeof setTimeout>;
    /** 启动路径预热备用进程的延迟：错开首个 tab 的 pi 冷启动，避免两个 pi 同时加载抢占 VSCode 窗口恢复期的资源。 */
    protected static readonly SPARE_PREWARM_DELAY_MS = 5000;

    // ---- 快捷键标签 ----
    protected static readonly SEND_KEY_LABELS: Record<string, string> = {
        "enter": "Enter",
        "shift+enter": "Shift + Enter",
        "alt+enter": "Alt + Enter",
        "ctrl+enter": "Ctrl + Enter",
    };
    protected static readonly NEW_SESSION_KEY_LABELS: Record<string, string> = {
        "ctrl+alt+n": "Ctrl+Alt+N", "ctrl+shift+n": "Ctrl+Shift+N", "ctrl+t": "Ctrl+T", "alt+n": "Alt+N",
    };
    protected static readonly TAB_SWITCH_KEY_LABELS: Record<string, string> = {
        "ctrl+alt+arrows": "Ctrl+Alt+← / Ctrl+Alt+→",
        "ctrl+alt+pgupdown": "Ctrl+Alt+PageUp / PageDown",
        "alt+brackets": "Alt+[ / Alt+]",
        "ctrl+alt+brackets": "Ctrl+Alt+[ / Ctrl+Alt+]",
    };
    protected static readonly FOCUS_INPUT_KEY_LABELS: Record<string, string> = {
        "ctrlAltI": "Ctrl+Alt+I", "ctrlShiftI": "Ctrl+Shift+I",
        "altI": "Alt+I", "ctrlAltSpace": "Ctrl+Alt+Space",
    };

    /** 把标签映射转成按钮组选项列表。 */
    protected static keyOptions(labels: Record<string, string>): Array<{ value: string; label: string }> {
        return Object.entries(labels).map(([value, label]) => ({ value, label }));
    }

    // ========================================================================
    //  平台钩子（子类实现）
    // ========================================================================

    /** 把一条全局（不带 tabId）消息送到 webview。 */
    protected abstract postToWebview(msg: Record<string, unknown>): void;

    // ---- RuntimeHost：配置 / cwd ----
    public abstract getConfig(): PiConfig;
    public abstract getCwd(): string;

    // ---- RuntimeHost：UI 弹窗 / diff / 文件 / 持久化 ----
    public abstract confirmDialog(title: string, message: string): Promise<boolean>;
    public abstract selectDialog(title: string, options: string[]): Promise<string | undefined>;
    public abstract inputDialog(title: string, placeholder: string, prefill: string): Promise<string | undefined>;
    public abstract persistModel(provider: string, modelId: string): void;
    public abstract openFileLocation(p: string, line: number, anchor?: string): void;
    public abstract openDiff(change: FileChange): void;
    public abstract confirmRevert(label: string): Promise<boolean>;

    // ---- 显示选项：存储读写（子类）----
    protected abstract getAutoLoadLast(): boolean;
    protected abstract getSendKey(): string;
    protected abstract getNewSessionKey(): string;
    protected abstract getTabSwitchKey(): string;
    protected abstract getFocusInputKey(): string;
    /** 转发注入前缀模板（{model}/{模型名称} 替换为模型名；空串为裸转发）。 */
    protected abstract getRelayPrefix(): string;
    /** 工具调用显示："compact"（简洁标签）| "full"（TUI 风格卡片）。 */
    protected abstract getToolDisplay(): string;
    /** 字号（px 字符串，如 "13"；空串表示跟随 VSCode 设置）。 */
    protected abstract getFontSize(): string;
    /** 变更显示选项的存储（仅改存储，UI 推送由基类统一完成）。value 为按钮组点选的明确值。 */
    protected abstract mutateViewOption(action: string, value?: string): void;

    // ---- 文件列表 / 文件打开（来自 webview 的 listFiles / openFile）----
    protected abstract sendFileList(): void;
    protected abstract openFileFromWebview(p: string, line?: number, col?: number): void;

    /** webview 首次就绪时调用（默认空，平台子类可覆盖以推送初始化数据）。 */
    protected onWebviewReady(): void {}

    /** 处理平台独有的 webview 消息；已在公共分发中匹配的不会进来。返回是否已处理。 */
    protected abstract handlePlatformMessage(msg: any): boolean;

    // ---- 可选平台钩子 ----
    /** pi 不存在时追加的平台行为（基类已向 panel 推送 systemError）。 */
    protected onPiMissing(_piPath: string): void { /* 默认无操作 */ }
    /** pi 缺失提示文案（基类默认；vscode 覆盖为更长文案并弹设置入口）。 */
    protected piMissingMessage(piPath: string): string {
        return `未找到 pi 可执行文件（当前配置："${piPath}"）。请确认已安装 pi 并加入 PATH，或在设置中指定 piPath。`;
    }
    /** 加载 / 切换会话后聚焦聊天视图（vscode 覆盖为聚焦侧栏）。 */
    protected async onFocusChat(): Promise<void> { /* 默认无操作 */ }
    /** 在弹出历史会话拾取器前做准备（vscode 需 ensureViewVisible）。 */
    protected async beforeHistoryPicker(): Promise<void> { /* 默认无操作 */ }
    /** 历史会话列表为空时的提示（vscode 覆盖为信息条）。 */
    protected onNoSessions(): void { /* 默认无操作 */ }

    // ========================================================================
    //  路径工具（RuntimeHost）
    // ========================================================================
    public relativeTo(cwd: string, full: string): string {
        const norm = (s: string) => s.replace(/\\/g, "/");
        const c = norm(cwd).replace(/\/$/, "") + "/";
        const f = norm(full);
        if (f.toLowerCase().startsWith(c.toLowerCase())) { return f.slice(c.length); }
        return full;
    }

    public resolvePath(p: string): string {
        if (path.isAbsolute(p)) { return p; }
        return path.resolve(this.getCwd(), p);
    }

    public resolveExecutable(cmd: string): string | undefined {
        if (!cmd) { return undefined; }
        const isWindows = process.platform === "win32";
        const exts = isWindows
            ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
            : [""];
        const existsAsFile = (p: string): boolean => {
            try { return fs.statSync(p).isFile(); } catch { return false; }
        };
        const tryWithExts = (base: string): string | undefined => {
            if (existsAsFile(base)) { return base; }
            if (isWindows) {
                for (const ext of exts) {
                    const lo = base + ext.toLowerCase(); if (existsAsFile(lo)) { return lo; }
                    const up = base + ext; if (existsAsFile(up)) { return up; }
                }
            }
            return undefined;
        };
        if (cmd.includes("/") || cmd.includes("\\")) {
            const abs = path.isAbsolute(cmd) ? cmd : path.resolve(this.getCwd(), cmd);
            return tryWithExts(abs);
        }
        const pathEnv = process.env.PATH || process.env.Path || "";
        const sep = isWindows ? ";" : ":";
        for (const dir of pathEnv.split(sep).filter(Boolean)) {
            const found = tryWithExts(path.join(dir, cmd));
            if (found) { return found; }
        }
        return undefined;
    }

    public checkPiAvailable(piPath: string, panelId: string): boolean {
        if (this.resolveExecutable(piPath)) { return true; }
        this.postToTab(panelId, { type: "systemError", text: this.piMissingMessage(piPath) });
        this.onPiMissing(piPath);
        return false;
    }

    // ========================================================================
    //  显示选项
    // ========================================================================
    protected sendViewOptions(): void {
        this.postToWebview({
            type: "viewOptions",
            autoLoadLastSession: this.getAutoLoadLast(),
            sendKey: this.getSendKey(),
            newSessionKey: this.getNewSessionKey(),
            tabSwitchKey: this.getTabSwitchKey(),
            focusInputKey: this.getFocusInputKey(),
            toolDisplay: this.getToolDisplay(),
            fontSize: this.getFontSize(),
        });
    }

    /** 构建显示选项浮层条目（toggle / 按钮组模式）。 */
    protected buildViewOptionItems(): Array<{
        label: string; desc: string; check: boolean | null; action: string;
        value?: string; options?: Array<{ value: string; label: string }>;
        kind?: string; min?: number; max?: number; step?: number; unit?: string;
    }> {
        return [
            {
                action: "autoLoadLastSession",
                label: "启动时自动打开最近会话",
                desc: "进入界面时自动加载当前项目最近一次会话",
                check: this.getAutoLoadLast(),
            },
            {
                action: "sendKey",
                label: "发送键",
                desc: "发送消息的快捷键",
                check: null,
                value: this.getSendKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.SEND_KEY_LABELS),
            },
            {
                action: "newSessionKey",
                label: "新建会话",
                desc: "新建会话的快捷键",
                check: null,
                value: this.getNewSessionKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.NEW_SESSION_KEY_LABELS),
            },
            {
                action: "tabSwitchKey",
                label: "切换 tab",
                desc: "在多个 tab 间切换上一个 / 下一个",
                check: null,
                value: this.getTabSwitchKey(),
                options: ChatControllerBase.keyOptions(ChatControllerBase.TAB_SWITCH_KEY_LABELS),
            },
            {
                action: "focusInputKey", label: "聚焦输入框", desc: "在任意 VS Code 焦点位置打开 Pi Chat 并聚焦输入框", check: null,
                value: this.getFocusInputKey(), options: ChatControllerBase.keyOptions(ChatControllerBase.FOCUS_INPUT_KEY_LABELS),
            },
            {
                action: "relayPrefix",
                kind: "text",
                label: "转发注入前缀",
                desc: "🔁 转发回复到别的 panel 时自动加的前缀；{panel_name} 替换为源 panel 名，{模型名称} / {model} 替换为源侧模型名。留空则裸转发",
                check: null,
                value: this.getRelayPrefix(),
            },
            {
                action: "toolDisplay",
                label: "工具调用显示",
                desc: "简洁：仅工具名标签 · 摘要：标签含调用摘要与耗时 · 完整：TUI 风格卡片（调用行、实时输出、结果、耗时）",
                check: null,
                value: this.getToolDisplay(),
                options: [
                    { value: "compact", label: "简洁" },
                    { value: "medium", label: "摘要" },
                    { value: "full", label: "完整" },
                ],
            },
            {
                action: "fontSize",
                label: "字号",
                desc: "拖动调整对话内容字号（默认跟随 VSCode 设置）",
                check: null,
                kind: "slider",
                value: this.getFontSize(),
                min: 11, max: 22, step: 1, unit: "px",
            },
        ];
    }

    /** 推送显示选项浮层（toggle 模式，不等待结果）。 */
    protected showOptionsPicker(): void {
        // 推送显示选项条目（数据）：由前端渲染进统一设置面板的「显示选项」tab。
        this.postToWebview({
            type: "viewOptionItems",
            items: this.buildViewOptionItems(),
        });
    }

    /** 浮层中切换某项后刷新：改存储 → 重推视图选项 → 刷新浮层。 */
    protected doViewOptionToggle(action: string, value?: string): void {
        this.mutateViewOption(action, value);
        this.sendViewOptions();
        this.showOptionsPicker();
    }

    // ========================================================================
    //  Tab（容器）/ Panel（会话）管理
    // ========================================================================

    // ---- 备用 pi 进程池 ----
    /** 确保池中常备一个已就绪的备用进程；领取后由 claimSpareClient 触发补充。
     *  @param delayMs 延迟多少毫秒后再启动（启动路径用：错开首个 tab 的 pi 冷启动）；0 表示立即启动。 */
    protected ensureSpare(delayMs = 0): void {
        if (this.spare || this.preparingSpare) {
            return;
        }
        if (this.spareTimer) {
            if (delayMs > 0) { return; } // 已有延迟任务在排队；立即启动的请求则取消排队直接走下面流程
            clearTimeout(this.spareTimer);
            this.spareTimer = undefined;
        }
        if (delayMs > 0) {
            this.spareTimer = setTimeout(() => {
                this.spareTimer = undefined;
                this.ensureSpare();
            }, delayMs);
            return;
        }
        const cfg = this.getConfig();
        if (!this.resolveExecutable(cfg.piPath)) {
            return;
        }
        const extraArgs = cfg.trustProject
            ? [...cfg.extraArgs, "--approve"]
            : cfg.extraArgs;
        const client = new PiClient({
            piPath: cfg.piPath,
            cwd: this.getCwd(),
            provider: cfg.provider || undefined,
            model: cfg.model || undefined,
            extraArgs,
        });
        // 记住备用进程的启动模型：新 panel 领取时按继承目标比对，不符则补发 set_model
        this.spareMeta = {
            provider: cfg.provider || undefined,
            modelId: cfg.model || undefined,
        };
        this.preparingSpare = client;
        client.on("stderr", (text: string) => console.error("[pi spare stderr]", text));
        client.on("error", (err: Error) => console.error("[pi spare error]", err.message));
        client.on("exit", () => {
            // 备用进程意外退出（尚未被领取时）：清掉并补一个新的
            if (this.spare === client) {
                this.spare = null;
                this.ensureSpare();
            }
        });
        client.start();
        void client.waitReady().then((ok) => {
            if (this.preparingSpare !== client) {
                // 已被 dispose 清理，丢弃
                return;
            }
            this.preparingSpare = null;
            if (ok && client.isRunning()) {
                this.spare = client;
            } else {
                client.stop();
                this.ensureSpare();
            }
        });
    }

    /** RuntimeHost.claimSpareClient：领取就绪的备用进程（附带其启动模型）；领取后立即后台补新。 */
    public claimSpareClient(): { client: PiClient; provider?: string; modelId?: string } | undefined {
        const c = this.spare ?? undefined;
        const meta = this.spareMeta;
        this.spare = null;
        this.spareMeta = undefined;
        if (c) {
            this.ensureSpare();
            return { client: c, provider: meta?.provider, modelId: meta?.modelId };
        }
        return undefined;
    }

    /** 停止并清空所有备用进程（宿主销毁时调用，如 VSCode webview dispose）。 */
    protected disposeSpare(): void {
        if (this.spareTimer) {
            clearTimeout(this.spareTimer);
            this.spareTimer = undefined;
        }
        if (this.spare) {
            this.spare.stop();
            this.spare = null;
        }
        if (this.preparingSpare) {
            const p = this.preparingSpare;
            this.preparingSpare = null;
            p.stop();
        }
    }

    public postToTab(panelId: string, msg: Record<string, unknown>): void {
        this.postToWebview({ ...msg, tabId: panelId });
    }

    // ---- 查找 ----
    /** panel 所在的 tab（容器）。 */
    public containerOfPanel(panelId: string): TabContainer | undefined {
        for (const c of this.tabContainers.values()) {
            if (layoutLeaves(c.root).includes(panelId)) { return c; }
        }
        return undefined;
    }

    /** 当前焦点 panel：活跃 tab 的 focusPanelId（缺省取布局第一个叶子）。 */
    public getActive(): SessionRuntime | undefined {
        const c = this.activeTabId ? this.tabContainers.get(this.activeTabId) : undefined;
        if (!c) { return undefined; }
        const leaves = layoutLeaves(c.root);
        const pid = c.focusPanelId && this.panels.has(c.focusPanelId) && leaves.includes(c.focusPanelId)
            ? c.focusPanelId
            : leaves[0];
        return pid ? this.panels.get(pid) : undefined;
    }

    /** 某 panel 是否为当前焦点 panel（状态栏上报过滤用）。 */
    protected isFocusedPanel(panelId: string): boolean {
        return this.getActive()?.id === panelId;
    }

    /** 活跃 tab 的所有 panel 都未承载会话内容时，才视为可复用的空 tab。 */
    protected isActiveTabEmpty(): boolean {
        const c = this.activeTabId ? this.tabContainers.get(this.activeTabId) : undefined;
        if (!c) { return false; }
        const panelIds = layoutLeaves(c.root);
        return panelIds.length > 0 && panelIds.every((id) =>
            this.panels.get(id)?.isConversationEmpty() === true
        );
    }

    /** 子类可接入跨工作区的全局唯一名字池。 */
    protected allocatePanelName() { return randomNameParts(); }
    protected releasePanelName(_parts: { adjective: string; noun: string }): void { /* default: local names */ }

    // ---- 创建 ----
    /** 新建一个 panel 运行时（随机命名，启动 pi 进程；不挂入任何布局）。 */
    protected createPanelRuntime(inherited?: { provider?: string; modelId?: string }): SessionRuntime {
        const id = `${this.workspaceId}:panel-${++this.panelSeq}`;
        const rt = new SessionRuntime(id, this.allocatePanelName(), this);
        this.panels.set(id, rt);
        rt.startClient(inherited);
        return rt;
    }

    /** 新建 tab（容器）：内含一个空 panel，成为活跃 tab。
     *  @param spareDelayMs 备用进程预热的延迟毫秒数（启动路径传 SPARE_PREWARM_DELAY_MS）。 */
    public newTab(spareDelayMs = 0): TabContainer {
        // 模型跟 panel 关联：继承当前焦点 panel 的模型（startClient 内部回落全局配置）
        const inherited = this.getActive()?.currentModel();
        const rt = this.createPanelRuntime(inherited);
        const c: TabContainer = {
            id: `${this.workspaceId}:tab-${++this.tabSeq}`,
            root: { kind: "panel", panelId: rt.id },
            focusPanelId: rt.id,
        };
        this.tabContainers.set(c.id, c);
        this.activeTabId = c.id;
        this.broadcastTabList(true);
        this.postToWebview({ type: "tabActivated", id: c.id });
        // 后台预热一个备用进程，供下一个新 panel / 切分支直接领取（启动路径延迟执行，避免双冷启动）
        this.ensureSpare(spareDelayMs);
        return c;
    }

    /** tab 内新增一个空 panel：插入到 anchor（缺省焦点 panel）右侧。 */
    public addPanel(anchorPanelId?: string): SessionRuntime | undefined {
        const anchorId = anchorPanelId || this.getActive()?.id;
        const c = anchorId ? this.containerOfPanel(anchorId) : undefined;
        if (!anchorId || !c || !layoutLeaves(c.root).includes(anchorId)) { return undefined; }
        const inherited = this.panels.get(anchorId)?.currentModel();
        const rt = this.createPanelRuntime(inherited);
        c.root = layoutInsertAdjacent(
            c.root, anchorId, { kind: "panel", panelId: rt.id }, "h", false
        );
        c.focusPanelId = rt.id;
        this.broadcastTabList(true);
        return rt;
    }

    // ---- 切换 / 焦点 ----
    public setActive(id: string): void {
        if (!this.tabContainers.has(id) || this.activeTabId === id) { return; }
        this.activeTabId = id;
        this.postToWebview({ type: "tabActivated", id });
        this.broadcastTabList(true);
        this.getActive()?.emitStatus();
    }

    /** 按方向切换到上一个/下一个 tab。 */
    public switchTabByDirection(direction: "prev" | "next"): void {
        const ids = Array.from(this.tabContainers.keys());
        if (ids.length < 2) { return; }
        const curIdx = this.activeTabId ? ids.indexOf(this.activeTabId) : 0;
        const delta = direction === "next" ? 1 : -1;
        const nextIdx = (curIdx + delta + ids.length) % ids.length;
        this.setActive(ids[nextIdx]);
    }

    /** 点击 pane 聚焦 panel：决定输入框发送、状态栏、fork 等目标。 */
    public focusPanel(panelId: string): void {
        const c = this.containerOfPanel(panelId);
        if (!c || c.focusPanelId === panelId) { return; }
        c.focusPanelId = panelId;
        const rt = this.panels.get(panelId);
        if (rt && this.isFocusedPanel(panelId)) { rt.emitStatus(); }
        this.broadcastTabList();
    }

    // ---- 关闭 ----
    /** 关闭 panel：杀进程、摘叶坍缩；tab 内 0 panel 时连 tab 一起关。 */
    public closePanel(panelId: string): void {
        const rt = this.panels.get(panelId);
        if (!rt) { return; }
        const c = this.containerOfPanel(panelId);
        rt.stopClient();
        this.releasePanelName(rt.nameParts);
        this.panels.delete(panelId);
        if (c) {
            const next = layoutRemove(c.root, panelId);
            if (!next || layoutLeaves(next).length === 0) {
                this.tabContainers.delete(c.id);
                this.postToWebview({ type: "tabClosed", id: c.id });
                if (this.activeTabId === c.id) {
                    this.activeTabId = this.tabContainers.size > 0 ? this.tabContainers.keys().next().value : undefined;
                    if (this.activeTabId) { this.postToWebview({ type: "tabActivated", id: this.activeTabId }); }
                }
            } else {
                c.root = next;
                if (c.focusPanelId === panelId || !layoutLeaves(next).includes(c.focusPanelId || "")) {
                    c.focusPanelId = layoutLeaves(next)[0];
                    this.getActive()?.emitStatus();
                }
            }
        }
        this.broadcastTabList(true);
        // 全部关闭后自动新建一个空 tab，保持界面可用
        if (this.tabContainers.size === 0) { this.newTab(); }
    }

    /** 关闭 tab：内部全部 panel 杀进程。 */
    public closeTab(id: string): void {
        const c = this.tabContainers.get(id);
        if (!c) { return; }
        for (const pid of layoutLeaves(c.root)) {
            const rt = this.panels.get(pid);
            if (rt) { rt.stopClient(); this.releasePanelName(rt.nameParts); this.panels.delete(pid); }
        }
        this.tabContainers.delete(id);
        this.postToWebview({ type: "tabClosed", id });
        if (this.activeTabId === id) {
            this.activeTabId = this.tabContainers.size > 0 ? this.tabContainers.keys().next().value : undefined;
            if (this.activeTabId) { this.postToWebview({ type: "tabActivated", id: this.activeTabId }); }
        }
        this.broadcastTabList(true);
        // 全部关闭后自动新建一个空 tab，保持界面可用
        if (this.tabContainers.size === 0) { this.newTab(); }
    }

    // ---- Fork（原生克隆会话到新 panel）----
    /**
     * Fork 某 panel：克隆其会话到同 tab 内新 panel（右侧并排）。
     * 源会话尚未落盘时短轮询等待；拿不到则放弃（提示走源 panel）。
     */
    public async forkPanel(panelId: string): Promise<void> {
        const src = this.panels.get(panelId);
        const c = this.containerOfPanel(panelId);
        if (!src || !c) { return; }
        const cfg = this.getConfig();
        if (!this.checkPiAvailable(cfg.piPath, panelId)) { return; }

        const newRt = this.createPanelRuntime(src.currentModel());
        newRt.loading = true;
        c.root = layoutInsertAdjacent(
            c.root, panelId, { kind: "panel", panelId: newRt.id }, "h", false
        );
        c.focusPanelId = newRt.id;
        this.broadcastTabList(true);

        // 取源会话状态（sessionFile + 消息数）：0 条消息的全新会话无可复制
        // （pi 请求失败时 state 为 undefined，messageCount 保持 -1：区分“没落盘”与“pi 不可用”）
        const state = await src.request<RpcSessionState>({ type: "get_state" });
        // 异步窗口防护：等待期间新 panel / 源 panel 被关掉或 pi 异常 → 放弃克隆
        if (!this.panels.has(newRt.id) || !this.panels.has(panelId)) {
            if (this.panels.has(newRt.id)) {
                this.panels.get(newRt.id)!.loading = false;
                this.broadcastTabList(true);
            }
            return;
        }
        let sourcePath = src.currentSessionPath || state?.data?.sessionFile;
        if (sourcePath && !src.currentSessionPath) { src.currentSessionPath = sourcePath; }
        const messageCount = typeof state?.data?.messageCount === "number" ? state.data.messageCount : -1;
        let cloned = false;
        if (!state && !sourcePath) {
            // 源 pi 无响应（不可用）：不误报“未落盘”
            newRt.loading = false;
            this.postToTab(newRt.id, { type: "system", text: "源会话状态不可用（pi 无响应），无法克隆。" });
        } else if (sourcePath && messageCount !== 0) {
            const abs = this.resolvePath(sourcePath);
            const deadline = Date.now() + 8000;
            while (!fs.existsSync(abs) && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 250));
            }
            if (fs.existsSync(abs)) {
                await newRt.loadSessionAndClone(abs);
                cloned = true;
            }
        }
        if (!cloned) {
            newRt.loading = false;
            if (messageCount > 0) {
                this.postToTab(newRt.id, {
                    type: "system",
                    text: "源会话尚未保存到磁盘，无法克隆上下文（可先发送任意消息让会话落盘后再 fork）。",
                });
            }
        }
        this.broadcastTabList(true);
    }

    // ---- 拖拽：panel 移动（同 tab 重排 / 跨 tab 搬家 / 拖出新建 tab）----
    /**
     * panel 拖放落定。
     * - targetTabId：搬到该 tab（插入其焦点 panel 旁），当前视图跟过去；
     * - targetPanelId + zone：插到目标 panel 的指定方位（center = 替换）；
     *   目标与本 panel 同 tab 时为纯重排，否则跨 tab 搬家；
     * - 都没给：新建一个 tab 带走该 panel。
     */
    public movePanel(opts: { panelId: string; targetTabId?: string; targetPanelId?: string; zone?: DropZone }): void {
        const rt = this.panels.get(opts.panelId);
        if (!rt) { return; }
        const src = this.containerOfPanel(opts.panelId);
        if (!src) { return; }
        const leaf: LayoutNode = { kind: "panel", panelId: opts.panelId };

        // 目标 panel 就是自己：无操作
        if (opts.targetPanelId === opts.panelId) { return; }

        if (opts.targetTabId) {
            const dst = this.tabContainers.get(opts.targetTabId);
            if (!dst || dst === src) { return; }
            this.detachPanelFromContainer(src, opts.panelId);
            const anchor = layoutLeaves(dst.root).includes(dst.focusPanelId || "")
                ? dst.focusPanelId!
                : layoutLeaves(dst.root)[0];
            dst.root = layoutInsertAdjacent(dst.root, anchor, leaf, "h", false);
            dst.focusPanelId = opts.panelId;
            this.activeTabId = dst.id;
            this.postToWebview({ type: "tabActivated", id: dst.id });
            this.broadcastTabList(true);
            return;
        }

        if (opts.targetPanelId) {
            const dst = this.containerOfPanel(opts.targetPanelId);
            if (!dst) { return; }
            const zone = opts.zone || "right";
            if (dst === src) {
                // 同 tab 重排：先摘除再插入（目标仍在树中，layoutRemove 不会返 null）
                const shrunk = layoutRemove(src.root, opts.panelId);
                if (!shrunk) { return; }
                src.root = zone === "center"
                    ? layoutReplaceLeaf(shrunk, opts.targetPanelId, leaf)
                    : (() => {
                        const z = zoneToInsert(zone as DropZone);
                        return layoutInsertAdjacent(shrunk, opts.targetPanelId, leaf, z.orientation, z.before);
                    })();
                if (zone === "center") { this.disposePanelRuntime(opts.targetPanelId); }
            } else {
                // 跨 tab 搬家
                this.detachPanelFromContainer(src, opts.panelId);
                if (zone === "center") {
                    dst.root = layoutReplaceLeaf(dst.root, opts.targetPanelId, leaf);
                    this.disposePanelRuntime(opts.targetPanelId);
                } else {
                    const z = zoneToInsert(zone as DropZone);
                    dst.root = layoutInsertAdjacent(dst.root, opts.targetPanelId, leaf, z.orientation, z.before);
                }
                this.activeTabId = dst.id;
                this.postToWebview({ type: "tabActivated", id: dst.id });
            }
            dst.focusPanelId = opts.panelId;
            this.broadcastTabList(true);
            return;
        }

        // 拖到空白：新 tab 带走（源 tab 若是唯一 panel 则整个消失）
        this.detachPanelFromContainer(src, opts.panelId);
        const c: TabContainer = {
            id: `${this.workspaceId}:tab-${++this.tabSeq}`,
            root: leaf,
            focusPanelId: opts.panelId,
        };
        this.tabContainers.set(c.id, c);
        this.activeTabId = c.id;
        this.postToWebview({ type: "tabActivated", id: c.id });
        this.broadcastTabList(true);
    }

    /** 从容器中摘除 panel（不杀进程）。容器变空则删除容器。 */
    protected detachPanelFromContainer(c: TabContainer, panelId: string): void {
        const next = layoutRemove(c.root, panelId);
        if (!next || layoutLeaves(next).length === 0) {
            this.tabContainers.delete(c.id);
            this.postToWebview({ type: "tabClosed", id: c.id });
            if (this.activeTabId === c.id) { this.activeTabId = undefined; }
            return;
        }
        c.root = next;
        if (!layoutLeaves(next).includes(c.focusPanelId || "")) {
            c.focusPanelId = layoutLeaves(next)[0];
        }
    }

    /** 销毁 panel 运行时（center 落点替换：被顶掉的 panel 杀进程）。 */
    protected disposePanelRuntime(panelId: string): void {
        const rt = this.panels.get(panelId);
        if (!rt) { return; }
        rt.stopClient();
        this.releasePanelName(rt.nameParts);
        this.panels.delete(panelId);
    }

    /** 合并所有 panel 中 pi 工具调用触及过的文件绝对路径（供宿主收集符号等）。 */
    public getAllKnownFiles(): string[] {
        const set = new Set<string>();
        for (const rt of this.panels.values()) {
            for (const p of rt.getKnownFiles()) { set.add(p); }
        }
        return Array.from(set);
    }

    // ---- tabList 广播 ----
    /**
     * 推送 tab 列表（含布局树）。默认节流（合并短时间内多次 activity 更新）；
     * 结构变更（新建/关闭/移动）传 immediate=true 立刻推送。
     */
    public broadcastTabList(immediate = false): void {
        if (immediate) {
            if (this.tabListTimer) {
                clearTimeout(this.tabListTimer);
                this.tabListTimer = null;
            }
            this.emitTabList();
            return;
        }
        if (this.tabListTimer) {
            return;
        }
        this.tabListTimer = setTimeout(() => {
            this.tabListTimer = null;
            this.emitTabList();
        }, ChatControllerBase.TAB_LIST_THROTTLE_MS);
    }

    /** 布局树 → webview 可渲染结构（panel 叶子附带显示状态）。 */
    private serializeLayout(node: LayoutNode): unknown {
        if (node.kind === "panel") {
            const rt = this.panels.get(node.panelId);
            return {
                kind: "panel",
                panelId: node.panelId,
                name: rt?.title || node.panelId,
                streaming: !!rt?.streaming,
                activity: rt?.activity || "idle",
                activityDetail: rt?.activityDetail || "",
                piReady: rt ? rt.piReady : true,
                loading: !!rt?.loading,
                // 状态栏恢复：webview 重建（视图隐藏重开/窗口重载）后 tabList 是唯一信源，
                // 仅靠一次性 modelChanged 推送会导致模型名丢失
                modelId: rt?.modelId,
                provider: rt?.provider,
                thinkingLevel: rt?.thinkingLevel,
                percent: rt?.contextPercent,
            };
        }
        return {
            kind: "split",
            orientation: node.orientation,
            children: node.children.map((c) => this.serializeLayout(c)),
        };
    }

    /** 原始 tab 显示名：单 panel 完整名，多 panel 为布局序名词拼接。 */
    protected baseContainerDisplayName(c: TabContainer): string {
        const leaves = layoutLeaves(c.root);
        const rts = leaves.map((pid) => this.panels.get(pid)).filter((rt) => !!rt);
        if (rts.length === 0) { return "新对话"; }
        if (rts.length === 1) { return composeName(rts[0]!.nameParts); }
        return rts.map((rt) => rt!.noun).join("·");
    }

    /** 子类可将原始名映射到全局唯一 tab 标签。 */
    protected containerDisplayName(c: TabContainer): string {
        return this.baseContainerDisplayName(c);
    }

    /** 供全局命名器计算冲突序号。 */
    public getTabNameBases(): Array<{ id: string; base: string }> {
        return Array.from(this.tabContainers.values()).map((c) => ({ id: c.id, base: this.baseContainerDisplayName(c) }));
    }

    /** 指定的全局 tab / panel id 是否属于当前工作区。 */
    public hasChatReference(id: string): boolean {
        return this.panels.has(id) || this.tabContainers.has(id);
    }

    /** 当前工作区可供 # 引用的 tab / panel 列表。 */
    public getChatReferenceItems(excludePanelId?: string): ChatReferenceItem[] {
        const items: ChatReferenceItem[] = [];
        for (const c of this.tabContainers.values()) {
            const kids = layoutLeaves(c.root).filter((pid) => pid !== excludePanelId);
            if (!kids.length) { continue; }
            const label = this.containerDisplayName(c);
            items.push({ kind: "tab", id: c.id, label, sub: `${kids.length} 个会话`, tabId: c.id });
            for (const pid of kids) {
                const rt = this.panels.get(pid);
                if (rt) { items.push({ kind: "panel", id: pid, label: rt.title, sub: label, tabId: c.id }); }
            }
        }
        return items;
    }

    /** 宿主下发全局引用目录。 */
    public updateChatReferences(items: ChatReferenceItem[]): void {
        this.postToWebview({ type: "chatReferences", items });
    }

    /** tab / panel 结构或焦点发生变化后，让子类刷新跨工作区引用目录。 */
    protected onChatStructureChanged(): void { /* default: no global registry */ }

    private emitTabList(): void {
        this.postToWebview({
            type: "tabList",
            tabs: Array.from(this.tabContainers.values()).map((c) => {
                const leaves = layoutLeaves(c.root);
                return {
                    id: c.id,
                    name: this.containerDisplayName(c),
                    focusPanelId: c.focusPanelId ?? null,
                    streaming: leaves.some((pid) => !!this.panels.get(pid)?.streaming),
                    loading: leaves.some((pid) => !!this.panels.get(pid)?.loading),
                    root: this.serializeLayout(c.root),
                };
            }),
            activeId: this.activeTabId ?? null,
        });
        this.onChatStructureChanged();
    }


    /** RuntimeHost.onStatusUpdate：仅当前焦点 panel 的状态才转发给宿主展示。 */
    public onStatusUpdate(panelId: string, info: StatusInfo): void {
        if (this.isFocusedPanel(panelId)) { this.onActiveStatusUpdate(info); }
    }

    /** RuntimeHost.onKnownFilesChanged：某 panel 的工具触及文件集合变化，转发给宿主。 */
    public onKnownFilesChanged(_panelId: string): void {
        this.onKnownFilesChangedByHost();
    }

    protected onKnownFilesChangedByHost(): void { /* 默认无操作 */ }

    /** 焦点 panel 的状态发生变化时平台钩子（默认无操作；VSCode 重写为状态栏更新）。 */
    protected onActiveStatusUpdate(_info: StatusInfo): void { /* 默认无操作 */ }

    // ========================================================================
    //  发送 / 中止（tab 级广播：当前 tab 内所有 panel）
    // ========================================================================

    protected panelIdsOf(panelId: string): string[] {
        const c = this.containerOfPanel(panelId);
        return c ? layoutLeaves(c.root) : [panelId];
    }

    /** tab 级发送：消息进该 tab 内所有 panel（对照实验语义）。 */
    protected broadcastSendToTab(panelId: string, text: string, images?: Array<{ data: string; mimeType: string }>): void {
        for (const pid of this.panelIdsOf(panelId)) {
            this.panels.get(pid)?.handleSend(text, images);
        }
    }

    /** tab 级中止：停掉该 tab 内所有正在生成的 panel。 */
    protected broadcastAbortToTab(panelId: string): void {
        const c = this.containerOfPanel(panelId);
        const ids = c ? layoutLeaves(c.root) : [panelId];
        for (const pid of ids) { this.panels.get(pid)?.abortActiveRun(); }
    }

    /** 向当前活跃 tab 的所有 panel 发送一条消息（命令入口用）。 */
    public sendActiveTabText(text: string): void {
        const c = this.activeTabId ? this.tabContainers.get(this.activeTabId) : undefined;
        if (!c) { return; }
        for (const pid of layoutLeaves(c.root)) { this.panels.get(pid)?.handleSend(text); }
    }

    /** webview / 命令菜单取数：问焦点 panel 的 pi 进程要命令列表
     *  （技能 / 提示模板 / 扩展命令），返回可直接渲染的菜单条目。 */
    protected async handleListCommands(): Promise<void> {
        const rt = this.getActive();
        if (!rt) { return; }
        const items = await rt.getSlashCommandItems();
        this.postToWebview({ type: "commandList", items });
    }

    // ========================================================================
    //  上下文获取（# 引用：把会话文本流注入输入框草稿）
    // ========================================================================

    /** 体积可读化（UTF-8 字节数）。 */
    private formatByteSize(text: string): string {
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes >= 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(1) + "MB"; }
        if (bytes >= 1024) { return (bytes / 1024).toFixed(1) + "KB"; }
        return bytes + "B";
    }

    /**
     * 为本工作区中的一个 tab / panel 生成 # 引用快照。
     * 来源可以仍在流式生成；pi 的 get_messages 返回选择时已有内容，结果不再跟踪更新。
     */
    public async buildChatReference(msg: any): Promise<{ title: string; text: string } | undefined> {
        const collect = async (pid: string) => {
            const rt = this.panels.get(pid);
            if (!rt) { return undefined; }
            const out = await rt.exportChatText();
            if (!out || out.messageCount === 0) { return undefined; }
            return { title: rt.title, text: out.text, count: out.messageCount };
        };

        let cardTitle = "";
        let sections: Array<{ title: string; text: string; count: number }>;
        if (typeof msg.panelId === "string") {
            const rt = this.panels.get(msg.panelId);
            if (!rt) { return undefined; }
            const one = await collect(rt.id);
            if (!one) { return undefined; }
            sections = [one];
            cardTitle = `💬 ${rt.title}`;
        } else if (typeof msg.tabId === "string") {
            const c = this.tabContainers.get(msg.tabId);
            if (!c) { return undefined; }
            const results = await Promise.all(layoutLeaves(c.root).map((pid) => collect(pid)));
            sections = results.filter((s): s is { title: string; text: string; count: number } => !!s);
            if (!sections.length) { return undefined; }
            cardTitle = `💬 ${this.containerDisplayName(c)}（${sections.length} 个会话）`;
        } else {
            return undefined;
        }

        const body = sections.map((s) => `会话: ${s.title}\n${s.text}`).join("\n\n");
        const totalCount = sections.reduce((n, s) => n + s.count, 0);
        return { title: `${cardTitle} · ${totalCount} 条消息 · ${this.formatByteSize(body)}`, text: body };
    }

    /** 将来源生成的快照回传给发起 # 引用的 webview。 */
    public receiveChatReference(requestId: number, reference: { title: string; text: string } | undefined): void {
        if (reference) {
            this.postToWebview({ type: "fetchChatResult", requestId, ...reference });
        } else {
            const target = this.getActive()?.id;
            if (target) { this.postToTab(target, { type: "system", text: "所选会话暂无可引用的消息。" }); }
        }
    }

    /** 本地引用的兼容入口；跨工作区宿主会改由 buildChatReference 调度。 */
    protected async handleFetchChat(msg: any): Promise<void> {
        const requestId = typeof msg.requestId === "number" ? msg.requestId : 0;
        this.receiveChatReference(requestId, await this.buildChatReference(msg));
    }

    // ========================================================================
    //  转发（把某 panel 的回复注入任意指定 panel）
    // ========================================================================

    /** 转发注入前缀包装：{panel_name} / {panel} 替换为源 panel 名；
     *  {model} / {模型名称} 替换为源 panel 的模型名；空模板则裸转发。 */
    protected wrapRelayText(source: SessionRuntime, text: string): string {
        const tpl = this.getRelayPrefix();
        if (!tpl || !tpl.trim()) { return text; }
        const m = source.currentModel();
        const model = m?.modelId || "对端会话";
        const name = source.title || "对端会话";
        const prefix = tpl
            .replace(/\{panel_name\}/g, name)
            .replace(/\{panel\}/g, name)
            .replace(/\{model\}/g, model)
            .replace(/\{模型名称\}/g, model);
        return prefix + text;
    }

    /** 转发：源 panel 的指定（或最新）回复，选择目标（tab 广播 / 单个 panel）注入。 */
    public async relayToPanel(fromPanelId: string, text?: string): Promise<void> {
        const src = this.panels.get(fromPanelId);
        if (!src) { return; }
        let payload = typeof text === "string" ? text.trim() : "";
        if (!payload) {
            payload = await src.getLastAssistantText();
        }
        if (!payload) { return; }
        // 候选：树形 —— tab 分组头（广播）+ panel 子项（点对点）；源 panel 不出现，
        // 只剩源一个 panel 的 tab 整组隐藏。
        const items: Array<Record<string, unknown>> = [];
        for (const c of this.tabContainers.values()) {
            const siblings = layoutLeaves(c.root).filter((pid) => pid !== fromPanelId);
            if (siblings.length === 0) { continue; }
            const tabLabel = this.containerDisplayName(c);
            items.push({ kind: "tab", id: c.id, label: tabLabel, count: siblings.length });
            for (const pid of siblings) {
                const rt = this.panels.get(pid);
                if (!rt) { continue; }
                items.push({ kind: "panel", id: pid, label: rt.title || pid, tabName: tabLabel });
            }
        }
        if (items.length === 0) {
            this.postToTab(fromPanelId, { type: "system", text: "没有其他 panel 可转发。" });
            return;
        }
        const choice = await this.showPicker("relay", items, null);
        if (!choice) { return; }
        const wrapped = this.wrapRelayText(src, payload);
        if (typeof choice.tabId === "string") {
            // 广播：发给该 tab 内除源以外的所有 panel
            const c = this.tabContainers.get(choice.tabId);
            if (!c) { return; }
            for (const pid of layoutLeaves(c.root)) {
                if (pid === fromPanelId) { continue; }
                this.panels.get(pid)?.handleSend(wrapped);
            }
            return;
        }
        if (typeof choice.id === "string") {
            this.panels.get(choice.id)?.handleSend(wrapped);
        }
    }

    // ========================================================================
    //  拾取器 + 模型选择（RuntimeHost.pickModelInteractive）
    // ========================================================================
    /** 向 webview 推送拾取器浮层并等待用户选择（取消返回 undefined）。 */
    protected showPicker(kind: string, items: any[], current?: string | null, echo?: Record<string, unknown>): Promise<any | undefined> {
        this.postToWebview({ type: "picker", kind, items, current: current ?? null, ...(echo || {}) });
        if (this.pickerTimer) { clearTimeout(this.pickerTimer); }
        return new Promise<any | undefined>((resolve) => {
            this.pickerResolve = resolve;
            this.pickerTimer = setTimeout(() => {
                if (this.pickerResolve) {
                    this.pickerResolve = null;
                    this.pickerTimer = null;
                    this.postToWebview({ type: "pickerCancel", kind });
                    resolve(undefined);
                }
            }, 120000);
        });
    }

    protected resolvePicker(payload: any | undefined): void {
        if (!this.pickerResolve) { return; }
        const r = this.pickerResolve;
        this.pickerResolve = null;
        if (this.pickerTimer) { clearTimeout(this.pickerTimer); this.pickerTimer = null; }
        r(payload);
    }

    public async pickModelInteractive(
        models: ModelInfo[],
        currentThinking: string,
        currentProvider: string,
        currentModelId: string,
        echo?: Record<string, unknown>
    ): Promise<ModelChoice | undefined> {
        const currentKey = `${currentProvider || ""}\u0000${currentModelId || ""}`;
        const isCurrent = (m: ModelInfo) =>
            `${m.provider || ""}\u0000${m.id || ""}` === currentKey
            || (m.id === currentModelId && (!currentProvider || !m.provider || m.provider === currentProvider));
        const items: any[] = models.map((m) => ({
            id: m.id,
            provider: m.provider,
            name: m.name,
            contextWindow: m.contextWindow,
            reasoning: m.reasoning === true,
            thinkingLevels: Array.isArray(m.thinkingLevels) ? m.thinkingLevels : [],
            cost: m.cost,
            current: isCurrent(m),
            currentThinking: isCurrent(m) ? currentThinking : "",
        }));
        // 展示序：当前模型所在 provider 分组整组置顶（组内当前模型排第一位），
        // 其余分组保持 models.json 原序，无 provider 的排最后（webview 渲染为“其他”）。
        const provOf = (it: any) => (typeof it.provider === "string" ? it.provider : "");
        const current = items.find((it) => it.current);
        const groupKeys: string[] = [];
        for (const it of items) {
            const k = provOf(it);
            if (!groupKeys.includes(k)) { groupKeys.push(k); }
        }
        const curKey = current ? provOf(current) : null;
        const order: string[] = [
            ...(curKey !== null ? [curKey] : []),
            ...groupKeys.filter((k) => k !== curKey && k !== ""),
            // 空 provider 兜底“其他”排最后；若它本身就是当前组则已在队首，不重复
            ...(curKey !== "" && groupKeys.includes("") ? [""] : []),
        ];
        const grouped = order.flatMap((k) => items.filter((it) => provOf(it) === k));
        const ordered = current ? [current, ...grouped.filter((it) => it !== current)] : grouped;
        const choice = await this.showPicker("model", ordered, currentKey, echo);
        if (!choice) { return undefined; }
        return {
            provider: choice.provider || "",
            modelId: choice.modelId,
            thinkingLevel: choice.thinkingLevel,
        };
    }

    // ========================================================================
    //  会话加载 / 分叉 / 历史
    // ========================================================================
    public newSession(): void { this.newTab(); }

    public getCurrentSessionPath(): string | undefined {
        return this.getActive()?.currentSessionPath;
    }

    public async loadHistorySession(file: string): Promise<void> {
        // 先揭示并等待聊天 Webview 就绪。否则首次从历史画布打开时，loadSession
        // 在 Webview 尚未建立监听器前发出的 clear/消息会丢失，最终只剩空 tab。
        await this.onFocusChat();
        // 优先复用当前空 tab；已有会话时新建 tab，避免历史选择覆盖正在进行的对话。
        let rt = this.isActiveTabEmpty() ? this.getActive() : undefined;
        if (!rt) {
            const c = this.newTab();
            rt = this.panels.get(layoutLeaves(c.root)[0]);
        }
        if (!rt) { return; }
        const c = this.containerOfPanel(rt.id);
        if (c) { this.setActive(c.id); }
        await rt.loadSession(file);
    }

    /** 路径归一化比较（盘符 / 分隔符）。 */
    protected samePath(a: string | undefined, b: string | undefined): boolean {
        if (!a || !b) { return false; }
        const norm = (p: string) => {
            let s = p.replace(/\\/g, "/").toLowerCase();
            s = s.replace(/^[a-z]:/, "");
            return s;
        };
        return norm(a) === norm(b);
    }

    /** 查找已打开该会话文件的 panel。 */
    protected findPanelBySessionFile(file: string): SessionRuntime | undefined {
        for (const rt of this.panels.values()) {
            if (this.samePath(rt.currentSessionPath, file)) {
                return rt;
            }
        }
        return undefined;
    }

    /**
     * 画布双击消息：复用已有 panel；否则优先复用当前空 tab，再新建 tab 加载会话，并尝试滚到对应 entry。
     */
    public async openSessionAtEntry(file: string, entryId: string): Promise<void> {
        // 与普通历史加载相同：先让聊天 Webview 就绪，随后才开始加载，既不会
        // 丢失首批渲染消息，也能立刻展示 loading 状态。
        await this.onFocusChat();
        const found = this.findPanelBySessionFile(file);
        let rt: SessionRuntime;
        if (found) {
            rt = found;
            const c = this.containerOfPanel(rt.id);
            if (c) { this.setActive(c.id); this.focusPanel(rt.id); }
        } else {
            // 空 tab 可直接承载历史会话；已有对话（或正在加载）的 tab 一律新建，避免覆盖内容。
            const reusable = this.isActiveTabEmpty() ? this.getActive() : undefined;
            if (reusable) {
                rt = reusable;
            } else {
                const c = this.newTab();
                rt = this.panels.get(layoutLeaves(c.root)[0])!;
            }
            await rt.loadSession(file);
        }
        // 稍等 DOM 渲染后再滚（load 会 clear + 重绘）
        this.postToTab(rt.id, { type: "scrollToEntry", entryId });
        setTimeout(() => {
            this.postToTab(rt.id, { type: "scrollToEntry", entryId });
        }, 200);
    }

    /**
     * 在新 tab 中打开从某条 user 消息处分叉出的新分支，源 panel 保持不动。
     * 新建一个独立 pi 进程的 panel，先加载源会话文件，再在该 entry 处 fork ——
     * fork 会创建新的分支会话文件并切换到它，源 panel 完全不受影响。
     * 源会话尚未落盘时回退到原地分叉。
     */
    public async forkAtEntryInNewTab(source: SessionRuntime, entryId: string): Promise<void> {
        // 取源会话文件路径。currentSessionPath 只在加载历史 / 分叉成功后赋值，
        // 全新 panel 普通对话后从未同步 —— 直接向源 pi 查询真实 sessionFile，
        // 避免误判“未落盘”而在当前 panel 原地分叉。
        let sourcePath = source.currentSessionPath;
        if (!sourcePath) {
            const state = await source.request<RpcSessionState>({ type: "get_state" });
            sourcePath = state?.data?.sessionFile;
            if (sourcePath) {
                source.currentSessionPath = sourcePath;
            }
        }
        // pi 在首条 assistant 回复到达前不把会话写入磁盘：文件可能已创建路径
        // 但尚未落盘，短轮询等它出现；仍不存在才回退原地分叉（会中止源面板生成）。
        if (sourcePath) {
            const abs = this.resolvePath(sourcePath);
            const deadline = Date.now() + 8000;
            while (!fs.existsSync(abs) && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 250));
            }
            if (fs.existsSync(abs)) {
                const c = this.newTab();
                const rt = this.panels.get(layoutLeaves(c.root)[0]);
                if (!rt) { return; }
                // 不等固定 sleep：loadSessionAndFork 内部会等待新 panel 的 pi 进程就绪
                await rt.loadSessionAndFork(abs, entryId);
                await this.onFocusChat();
                return;
            }
        }
        await source.forkFromEntry(entryId);
    }

    protected async maybeAutoLoadLastSession(): Promise<void> {
        if (this.autoLoadDone) { return; }
        const cwd = this.getCwd();
        if (!cwd) { return; }
        this.autoLoadDone = true;
        if (!this.getAutoLoadLast()) { return; }
        // 仅需最近一个根会话：buildSessionTree 后取首个根。
        const tree = await buildSessionTree(cwd);
        if (tree.length === 0) { return; }
        const rt = this.getActive();
        if (rt) { await rt.loadSession(tree[0].header.file); }
    }

    /** 弹出历史会话拾取器并加载选中项。 */
    public async showHistoryPicker(): Promise<void> {
        // 先确保视图可见（VSCode 下会打开侧栏面板）。否则在工作区从未跑过 pi、
        // 会话列表为空时会直接 return，面板根本不打开，表现为“点击无反应”。
        await this.beforeHistoryPicker();
        // 全量读 header 建家族树（~80ms），首屏只解析前 N 个家族的尾读预览；
        // 其余点“加载更多”时按需解析，避免会话文件多时首屏卡顿。
        const tree = await buildSessionTree(this.getCwd());
        this.historyTree = tree;
        this.historyFamilyOffset = 0;
        if (tree.length === 0) {
            this.onNoSessions();
            return;
        }
        const first = await this.loadHistoryFamilyPage(0, SESSION_FAMILY_PAGE_SIZE);
        if (first.items.length === 0) {
            this.onNoSessions();
            return;
        }
        const current = this.getActive()?.currentSessionPath;
        const choice = await this.showHistoryPickerPaged(
            first.items,
            tree.length,
            this.historyFamilyOffset,
            current
        );
        if (!choice || typeof choice.file !== "string") { return; }
        await this.loadHistorySession(choice.file);
    }

    /**
     * 加载家族树指定区间的尾读预览，过滤空预览会话（不显示）。
     * 返回解析后的条目和实际加载到的家族数。
     */
    protected async loadHistoryFamilyPage(
        offset: number,
        limit: number
    ): Promise<{ items: SessionItem[]; loadedFamilies: number }> {
        const flat = flattenTreeByFamilies(this.historyTree, offset, limit);
        const items = await Promise.all(
            flat.map(async (e) => {
                const p = await readSessionPreview(e.file, !!e.parentSession, e.timestamp);
                return {
                    file: e.file,
                    id: e.id,
                    timestamp: e.timestamp,
                    depth: e.depth,
                    userPreview: p.user,
                    assistantPreview: p.assistant,
                } as SessionItem;
            })
        );
        // 空 pair 会话不显示。
        const nonEmpty = items.filter(
            (it) => it.userPreview.length > 0 || it.assistantPreview.length > 0
        );
        const loadedFamilies = Math.min(offset + limit, this.historyTree.length) - offset;
        return { items: nonEmpty, loadedFamilies };
    }

    /**
     * 推送带分页信息的历史拾取器浮层并等待用户选择。
     * 多带 totalFamilies / loadedFamilies 供前端渲染“加载更多”。
     */
    protected showHistoryPickerPaged(
        items: SessionItem[],
        totalFamilies: number,
        loadedFamilies: number,
        current?: string
    ): Promise<any | undefined> {
        this.postToWebview({
            type: "picker",
            kind: "history",
            items,
            current: current ?? null,
            totalFamilies,
            loadedFamilies,
        });
        if (this.pickerTimer) { clearTimeout(this.pickerTimer); }
        return new Promise<any | undefined>((resolve) => {
            this.pickerResolve = resolve;
            this.pickerTimer = setTimeout(() => {
                if (this.pickerResolve) {
                    this.pickerResolve = null;
                    this.pickerTimer = null;
                    this.postToWebview({ type: "pickerCancel", kind: "history" });
                    resolve(undefined);
                }
            }, 120000);
        });
    }

    /** 响应 webview “加载更多历史”：解析下一批并追加分页条目。 */
    public async loadMoreHistory(): Promise<void> {
        if (this.historyTree.length === 0) { return; }
        const offset = this.historyFamilyOffset;
        if (offset >= this.historyTree.length) {
            this.postToWebview({ type: "historyPageEnd", totalFamilies: this.historyTree.length });
            return;
        }
        const result = await this.loadHistoryFamilyPage(offset, SESSION_FAMILY_PAGE_SIZE);
        this.historyFamilyOffset += result.loadedFamilies;
        this.postToWebview({
            type: "historyPageAppend",
            items: result.items,
            totalFamilies: this.historyTree.length,
            loadedFamilies: this.historyFamilyOffset,
        });
    }

    // ========================================================================
    //  webview 消息分发（公共部分）
    // ========================================================================
    /**
     * 处理来自 webview 的消息。先处理两宿主公共的全局消息，再交由
     * {@link handlePlatformMessage} 处理平台独有消息，最后处理 panel 级消息。
     */
    public processMessage(msg: any): void {
        // ---- 公共全局消息 ----
        switch (msg.type) {
            case "ready": {
                this.sendViewOptions();
                this.broadcastTabList();
                if (this.tabContainers.size === 0) {
                    this.newTab(ChatControllerBase.SPARE_PREWARM_DELAY_MS);
                    void this.maybeAutoLoadLastSession();
                } else {
                    // 已有 panel：同步各 panel 的 piReady
                    for (const rt of this.panels.values()) {
                        this.postToTab(rt.id, { type: "piReady", ready: rt.piReady });
                    }
                }
                if (this.activeTabId) {
                    this.postToWebview({ type: "tabActivated", id: this.activeTabId });
                }
                this.onWebviewReady();
                // webview 就绪后后台预热备用进程，后续新 panel / 切分支免冷启动。
                // 启动路径延迟执行：首个 tab 的 pi 正在冷启动，同时再拉起备用进程会在
                // VSCode 窗口恢复期叠加出明显的 CPU/IO 峰值（两个 pi 各需 ~3s 加载）。
                this.ensureSpare(ChatControllerBase.SPARE_PREWARM_DELAY_MS);
                return;
            }
            case "newSession":
                this.newTab();
                return;
            case "switchTab":
                if (typeof msg.tabId === "string") { this.setActive(msg.tabId); }
                return;
            case "switchTabByDirection":
                if (msg.direction === "prev" || msg.direction === "next") { this.switchTabByDirection(msg.direction); }
                return;
            case "closeTab":
                if (typeof msg.tabId === "string") { this.closeTab(msg.tabId); }
                return;
            case "closePanel":
                if (typeof msg.panelId === "string") { this.closePanel(msg.panelId); }
                return;
            case "focusPanel":
                if (typeof msg.panelId === "string") { this.focusPanel(msg.panelId); }
                return;
            case "addPanel":
                this.addPanel(typeof msg.panelId === "string" ? msg.panelId : undefined);
                return;
            case "forkPanel":
                if (typeof msg.panelId === "string") { void this.forkPanel(msg.panelId); }
                return;
            case "movePanel":
                if (typeof msg.panelId === "string") {
                    this.movePanel({
                        panelId: msg.panelId,
                        targetTabId: typeof msg.targetTabId === "string" ? msg.targetTabId : undefined,
                        targetPanelId: typeof msg.targetPanelId === "string" ? msg.targetPanelId : undefined,
                        zone: typeof msg.zone === "string" ? msg.zone : undefined,
                    });
                }
                return;
            case "listFiles":
                this.sendFileList();
                return;
            case "listCommands":
                void this.handleListCommands();
                return;
            case "fetchChat":
                void this.handleFetchChat(msg);
                return;
            case "openFile":
                if (typeof msg.path === "string") {
                    this.openFileFromWebview(
                        msg.path,
                        typeof msg.line === "number" ? msg.line : undefined,
                        typeof msg.col === "number" ? msg.col : undefined
                    );
                }
                return;
            case "pickerChoice":
                this.resolvePicker(msg.payload);
                return;
            case "pickerCancel":
                this.resolvePicker(undefined);
                return;
            case "historyLoadMore":
                void this.loadMoreHistory();
                return;
            case "requestViewOptionItems":
                this.showOptionsPicker();
                return;
            case "pickerToggle":
                if (typeof msg.action === "string" && msg.kind !== "model") {
                    this.doViewOptionToggle(msg.action, typeof msg.value === "string" ? msg.value : undefined);
                }
                return;
            case "relayOnce":
                void this.relayToPanel(
                    typeof msg.fromTabId === "string" ? msg.fromTabId : "",
                    typeof msg.text === "string" ? msg.text : undefined
                );
                return;
        }

        // ---- 平台独有全局消息 ----
        if (this.handlePlatformMessage(msg)) { return; }

        // ---- 公共 panel 级消息 ----
        const panelId: string | undefined = msg.tabId;
        const rt = panelId ? this.panels.get(panelId) : undefined;
        // 命令型消息（pickModel 等）回退到焦点 panel
        const target = rt ?? (msg.type === "pickModel" ? this.getActive() : undefined);
        if (!target) { return; }

        switch (msg.type) {
            case "send": {
                // tab 级广播：消息同时进该 tab 内所有 panel
                this.broadcastSendToTab(target.id, msg.text, msg.images);
                break;
            }
            case "abort": {
                // tab 级中止：一停全停
                this.broadcastAbortToTab(target.id);
                break;
            }
            case "showTree":
                void target.showTree();
                break;
            case "forkAtEntry":
                if (typeof msg.entryId === "string") { void this.forkAtEntryInNewTab(target, msg.entryId); }
                break;
            case "pickModel":
                void target.pickModel(typeof msg.t0 === "number" ? msg.t0 : undefined);
                break;
            case "openDiff":
                if (typeof msg.path === "string") { void target.openDiff(msg.path); }
                break;
            case "openEditLocation":
                if (typeof msg.path === "string" && typeof msg.anchor === "string" && msg.anchor) {
                    void target.openEditLocationWithAnchor(
                        msg.path,
                        typeof msg.line === "number" ? msg.line : 1,
                        msg.anchor
                    );
                } else if (typeof msg.path === "string") {
                    void target.openEditLocation(msg.path, typeof msg.line === "number" ? msg.line : 1);
                }
                break;
            case "revertEdit":
                if (typeof msg.toolCallId === "string") { void target.revertEdit(msg.toolCallId); }
                break;
        }
    }
}

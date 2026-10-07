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
import { randomUUID } from "crypto";
import { SessionRuntime, RuntimeHost, FileChange, ModelInfo, ModelChoice, StatusInfo, TurnEndInfo, } from "./sessionRuntime";
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
import { DEFAULT_TURN_TITLE_WAIT_MS } from "./runtimeTypes";
import type { PanelLaunch, TurnEndStatus } from "./runtimeTypes";
import type { TabaRequest, TabaSpawnRequest, TabaStopRequest } from "./tabaProtocol";
import {
    TabaRegistry,
    buildChildClosedNotice,
    buildChildIntro,
    buildDeliveryText,
    buildSpawnFailure,
    buildSpawnNotice,
    describeChildState,
    formatElapsedMs,
    type TabaChild,
} from "./tabaRegistry";
import { loadRoles, piAgentDir, pickRoleByName, type TabaRole, type TabaSessionMode } from "./tabaRoles";
import { buildChildSessionLines, childSessionFileName, piSessionDirFor } from "./tabaTask";
import {
    buildTabaExtraArgs,
    buildTabaLaunch,
    buildTabaTaskText,
    resolveTabaSpawn,
} from "./tabaLaunch";
import { tabaPromptsDir, tabaRolesDir } from "./tabaAssets";
import { buildRunRecord, tabaRunsDir, writeRunRecord, type TabaRunState } from "./tabaRunFiles";
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

/** 活体移交载荷：一批 panel 运行时（含 pi 进程）+ 它们在源工作区的相对布局。 */
export interface TransferPayload {
    runtimes: SessionRuntime[];
    root: LayoutNode;
    focusPanelId?: string;
}

/** 按 old → new 映射重写布局树里的 panelId（迁入时归入新工作区命名空间）。 */
function remapLayout(node: LayoutNode, map: Map<string, string>): LayoutNode {
    if (node.kind === "panel") {
        return { kind: "panel", panelId: map.get(node.panelId) ?? node.panelId };
    }
    return {
        kind: "split",
        orientation: node.orientation,
        children: node.children.map((c) => remapLayout(c, map)),
    };
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
    /** 会话结束提示音是否开启（系统通知不受它影响，由平台层固定发）。 */
    protected abstract notifyBeepEnabled(): boolean;
    /** 收尾提醒最多等 pi 的会话标题几秒（0 = 不等，直接用会话显示名）；平台层改用存储值。 */
    protected getTurnTitleWaitSeconds(): number { return DEFAULT_TURN_TITLE_WAIT_MS / 1000; }
    /** 收尾提醒最多等 pi 的会话标题多少毫秒。 */
    protected turnTitleWaitMs(): number { return Math.max(0, this.getTurnTitleWaitSeconds()) * 1000; }
    /** 把一轮对话收尾事件交给平台层（Windows toast 等）。 */
    protected abstract notifyTurnEnd(info: TurnEndInfo): void;

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
    /** 活体移交菜单的目标工作区名（"编辑器" / "侧边栏"）；undefined 则 webview 不显示该菜单项。 */
    protected transferDestination(): string | undefined { return undefined; }
    /** webview 首次就绪且一个 tab 也没有时，是否自动建空 tab；
     *  子类在“即将接管迁入会话”时可返回 false，免得白起一个会被丢掉的 pi 进程。 */
    protected shouldCreateInitialTab(): boolean { return true; }

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
            notifyBeep: this.notifyBeepEnabled(),
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
            {
                action: "notifyBeep",
                label: "会话结束提示音",
                desc: "任何 session 跑完都响一声（不再只对焦点 session）；界面被隐藏时不出声，改由 Windows 通知提醒。系统通知不受本开关影响，始终发送",
                check: this.notifyBeepEnabled(),
            },
            {
                action: "turnTitleWait",
                label: "收尾提醒等会话标题",
                desc: "pi 的会话标题（自动命名扩展生成）还没到时，最多等这么久再发提醒；"
                    + "等不到就用会话显示名（tab 栏上那个随机名）兜底。提示音不受影响，照常立刻响",
                check: null,
                value: String(this.getTurnTitleWaitSeconds()),
                options: [
                    { value: "0", label: "不等" },
                    { value: "1", label: "1 秒" },
                    { value: "3", label: "3 秒" },
                    { value: "5", label: "5 秒" },
                    { value: "10", label: "10 秒" },
                ],
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
            : [...cfg.extraArgs];
        // 备用进程也要带上“派子会话”那个扩展：它会被下一个新 panel 领走，那个 panel 一样得能派活
        if (cfg.tabaExtension) { extraArgs.push("-e", cfg.tabaExtension); }
        const client = new PiClient({
            piPath: cfg.piPath,
            cwd: this.getCwd(),
            provider: cfg.provider || undefined,
            model: cfg.model || undefined,
            extraArgs,
            env: cfg.tabaDir ? { PICHAT_TABA_DIR: cfg.tabaDir } : undefined,
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
    protected createPanelRuntime(inherited?: { provider?: string; modelId?: string }, launch?: PanelLaunch): SessionRuntime {
        const id = `${this.workspaceId}:panel-${++this.panelSeq}`;
        const rt = new SessionRuntime(id, this.allocatePanelName(), this);
        this.panels.set(id, rt);
        rt.startClient(inherited, launch);
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
        this.notePanelGoneForTaba(panelId);
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
            if (rt) { this.notePanelGoneForTaba(pid); rt.stopClient(); this.releasePanelName(rt.nameParts); this.panels.delete(pid); }
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

    // ========================================================================
    //  派子会话（taba）：一个会话把活派给另一个会话，子会话开在新 tab 里
    // ========================================================================

    /** 子会话登记表。 */
    protected readonly taba = new TabaRegistry();
    /** 正在派活中的编号：同一个请求重复送过来时不要开出两个 tab。 */
    private readonly tabaInFlight = new Set<string>();
    /** 子会话用的临时提示词文件（角色说明当系统提示词时用），panel 关掉时删。 */
    private readonly tabaPromptFiles = new Map<string, string>();
    /** 等子会话的 pi 起来最多等多久（冷启动要加载扩展，比领备用进程慢）。 */
    protected static readonly TABA_CHILD_READY_TIMEOUT_MS = 40000;
    /** tab 名里子会话名字最多占多长。 */
    private static readonly TABA_TAB_NAME_MAX = 28;

    /** RuntimeHost.onTabaRequest：某个会话里的 pi 扩展要派子会话 / 停子会话。 */
    public onTabaRequest(panelId: string, request: TabaRequest): void {
        if (request.kind === "spawn") {
            void this.tabaSpawn(panelId, request);
            return;
        }
        this.tabaStopByRef(panelId, request);
    }

    /** 派活没成：界面上打一行，同时把原因交给模型（它那边的工具已经回了“已派出”）。 */
    protected tabaFailSpawn(parentRt: SessionRuntime, name: string, reason: string): void {
        this.postToTab(parentRt.id, { type: "system", text: buildSpawnFailure({ name, reason }) });
        parentRt.handleSend(`【派子会话没成】「${name}」：${reason}`);
    }

    /**
     * 派一个子会话：新开一个 tab（不抢当前焦点），把任务发过去。
     * 它跑完第一轮后，最后一条回复会自动交回这个会话（见 tabaOnTurnEnd）。
     */
    protected async tabaSpawn(parentPanelId: string, req: TabaSpawnRequest): Promise<void> {
        const parentRt = this.panels.get(parentPanelId);
        if (!parentRt) { return; }
        // 子会话不能再往下派：它那个 tab 本来就不加载这个扩展，这里再挡一道
        if (this.taba.byChildPanel(parentPanelId)) {
            this.postToTab(parentPanelId, { type: "system", text: "子会话不能再派子会话。" });
            return;
        }
        if (this.taba.has(req.id) || this.tabaInFlight.has(req.id)) { return; }
        this.tabaInFlight.add(req.id);
        try {
            const cfg = this.getConfig();

            // 角色（可选）：找不到、或者这个角色我们的 tab 跑不了，都要如实回话
            let roles: TabaRole[] = [];
            try {
                roles = loadRoles(this.getCwd(), cfg.tabaDir ? tabaRolesDir(cfg.tabaDir) : undefined);
            } catch (e: any) {
                console.error("[taba] 读角色文件失败:", e?.message ?? e);
            }
            const role = req.agent ? pickRoleByName(roles, req.agent) : undefined;
            if (req.agent && !role) {
                this.tabaFailSpawn(parentRt, req.name, `没有叫「${req.agent}」这个角色`);
                return;
            }
            if (role?.unusable) {
                this.tabaFailSpawn(parentRt, req.name, `角色「${role.name}」跑不了：${role.unusable}`);
                return;
            }

            // 子会话怎么起：工作目录 / 会话内容从哪来 / 模型 / 工具白名单 都在这里面算
            const plan = resolveTabaSpawn({
                req,
                role,
                parentCwd: this.getCwd(),
                parentModelId: parentRt.modelId,
                parentProvider: parentRt.provider,
                resolvePath: (p) => this.resolvePath(p),
            });
            const { cwd, mode } = plan;

            // 带上下文那两档：先把子会话文件写出来，pi 用 --session 打开它
            let sessionFile: string | undefined;
            let note = "";
            if (mode !== "standalone") {
                const parentSession = req.parentSessionFile || parentRt.currentSessionPath || "";
                const seeded = await this.tabaSeedChildSession(parentSession, mode, cwd);
                if (seeded) { sessionFile = seeded; }
                else { note = "（没能带上这个会话之前的对话：它还没写到磁盘上，这次按全新会话派的）"; }
            }

            // 角色说明放哪：角色文件里写了 system-prompt 就当系统提示词，否则跟任务一起发
            let promptFile: string | undefined;
            if (role && role.body && role.systemPromptMode && cfg.tabaDir) {
                promptFile = await this.tabaWritePromptFile(cfg.tabaDir, role.name, req.id, role.body);
                if (promptFile) { this.tabaPromptFiles.set(`pending:${req.id}`, promptFile); }
            }
            // 写不出去（没有资源目录之类）就退回跟任务一起发，说明总得让子会话看到
            const bodyInTask = !promptFile;
            const extraArgs = buildTabaExtraArgs({
                sessionFile,
                promptFile,
                systemPromptMode: role?.systemPromptMode,
                tools: plan.tools,
            });

            const created = this.createBackgroundTab(buildTabaLaunch(extraArgs, cwd), plan.modelOverride);
            if (!created) {
                this.tabaFailSpawn(parentRt, req.name, "新 tab 开不出来（pi 可执行文件没找到？）");
                return;
            }
            const { container, rt } = created;
            const pendingPrompt = this.tabaPromptFiles.get(`pending:${req.id}`);
            this.tabaPromptFiles.delete(`pending:${req.id}`);
            if (pendingPrompt) { this.tabaPromptFiles.set(rt.id, pendingPrompt); }

            const child: TabaChild = {
                id: req.id,
                name: req.name,
                task: req.task,
                agent: req.agent ?? role?.name,
                parentPanelId,
                parentSessionFile: req.parentSessionFile || "",
                childPanelId: rt.id,
                childTabId: container.id,
                state: "starting",
                startedAt: Date.now(),
                deliveries: 0,
                sessionMode: mode,
                sessionFile,
                modelLabel: plan.modelSpec || undefined,
            };
            if (!this.taba.add(child)) {
                // 同一个编号又来了一次（理论上不会）：把刚开的 tab 收回去
                this.closeTab(container.id);
                return;
            }
            this.tabaWriteRun(child);

            const parentTab = this.containerOfPanel(parentPanelId);
            this.postToTab(parentPanelId, {
                type: "system",
                text: buildSpawnNotice({ child, tabName: this.containerDisplayName(container), mode }) + note,
            });
            this.postToTab(rt.id, {
                type: "system",
                text: buildChildIntro({
                    child,
                    parentTabName: parentTab ? this.containerDisplayName(parentTab) : undefined,
                }),
            });
            this.broadcastTabList(true);

            const taskText = buildTabaTaskText({ role, bodyInTask, task: req.task });
            const ready = await rt.waitReady(ChatControllerBase.TABA_CHILD_READY_TIMEOUT_MS);
            // 等待期间 tab 被关掉了：登记在关 tab 时已经清掉了，这里什么都不用做
            if (!this.panels.has(rt.id)) { return; }
            if (!ready) {
                this.taba.noteTurnEnd(req.id, "error", Date.now());
                this.postToTab(rt.id, { type: "systemError", text: "子会话的 pi 没起来（等超时了）。" });
                this.tabaDeliver(child, { resultText: "", status: "error", manual: false });
                return;
            }
            rt.handleSend(taskText);
            this.taba.noteTaskSent(req.id);
            this.tabaWriteRun(this.taba.get(req.id));
            this.broadcastTabList();
            // 问出子会话与父会话的 .jsonl 路径写到名录里（全新会话要等 pi 落盘才有）
            void this.tabaResolveSessionFiles(req.id, rt, parentRt);
        } finally {
            this.tabaInFlight.delete(req.id);
        }
    }

    /** 把某个子会话的情况写到名录文件里（模型那边 taba_peek 读的就是它）。 */
    protected tabaWriteRun(child: TabaChild | undefined, state?: TabaRunState): void {
        if (!child) { return; }
        const cfg = this.getConfig();
        if (!cfg.tabaDir) { return; }
        writeRunRecord(tabaRunsDir(cfg.tabaDir), buildRunRecord({ child, state }));
    }

    /**
     * 问出子会话（必要时也问父会话）的 .jsonl 路径，写到名录里。
     * 全新会话的文件要等 pi 把第一条消息落盘才会出现，所以短轮询最多等 15 秒；
     * 中途 tab 被关掉、或者两边路径都拿到了就停。
     */
    protected async tabaResolveSessionFiles(id: string, childRt: SessionRuntime, parentRt: SessionRuntime): Promise<void> {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const child = this.taba.get(id);
            if (!child) { return; }
            // pi 进程不在了（被关掉 / 启动失败）：再问也问不出来，不白等
            if (!childRt.isRunning()) { return; }
            let changed = false;
            if (!child.sessionFile && this.panels.has(childRt.id)) {
                const resp = await childRt.request<RpcSessionState>({ type: "get_state" }, 3000);
                const file = resp?.data?.sessionFile;
                if (typeof file === "string" && file) {
                    child.sessionFile = file;
                    childRt.currentSessionPath = file;
                    changed = true;
                }
            }
            if (!child.parentSessionFile && this.panels.has(parentRt.id)) {
                let file = parentRt.currentSessionPath;
                if (!file) {
                    const resp = await parentRt.request<RpcSessionState>({ type: "get_state" }, 3000);
                    file = resp?.data?.sessionFile;
                }
                if (typeof file === "string" && file) {
                    child.parentSessionFile = file;
                    changed = true;
                }
            }
            if (changed) { this.tabaWriteRun(child); }
            if (child.sessionFile && child.parentSessionFile) { return; }
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    /** 写一个“带上下文”的子会话文件，返回路径；写不了返回 undefined。 */
    protected async tabaSeedChildSession(
        parentSessionFile: string,
        mode: TabaSessionMode,
        cwd: string
    ): Promise<string | undefined> {
        if (!parentSessionFile) { return undefined; }
        const parentAbs = this.resolvePath(parentSessionFile);
        if (!parentAbs || !fs.existsSync(parentAbs)) { return undefined; }
        let parentLines: string[];
        try {
            parentLines = (await fs.promises.readFile(parentAbs, "utf8")).split("\n");
        } catch (e: any) {
            console.error("[taba] 读父会话文件失败:", e?.message ?? e);
            return undefined;
        }
        const sessionId = randomUUID();
        const timestamp = new Date().toISOString();
        const dir = piSessionDirFor(cwd, piAgentDir());
        const file = path.join(dir, childSessionFileName(timestamp, sessionId));
        const lines = buildChildSessionLines({
            mode: mode === "fork" ? "fork" : "lineage-only",
            sessionId,
            cwd,
            timestamp,
            parentSessionFile: parentAbs,
            parentLines,
        });
        try {
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(file, lines.join("\n") + "\n", "utf8");
        } catch (e: any) {
            console.error("[taba] 写子会话文件失败:", e?.message ?? e);
            return undefined;
        }
        return file;
    }

    /** 角色说明当系统提示词时写成文件（pi 的 --append-system-prompt 收文件路径）。 */
    protected async tabaWritePromptFile(
        resourceDir: string,
        roleName: string,
        id: string,
        body: string
    ): Promise<string | undefined> {
        try {
            const dir = tabaPromptsDir(resourceDir);
            await fs.promises.mkdir(dir, { recursive: true });
            const safe = roleName.replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, "-").slice(0, 40) || "role";
            const file = path.join(dir, `${safe}-${id}.md`);
            await fs.promises.writeFile(file, body, "utf8");
            return file;
        } catch (e: any) {
            console.error("[taba] 写角色说明文件失败:", e?.message ?? e);
            return undefined;
        }
    }

    /** 新开一个后台 tab：不抢当前焦点（一次派好几个时不该把正在看的会话顶走）。 */
    protected createBackgroundTab(
        launch: PanelLaunch,
        modelOverride?: { provider?: string; modelId?: string }
    ): { container: TabContainer; rt: SessionRuntime } | undefined {
        const cfg = this.getConfig();
        if (!this.resolveExecutable(cfg.piPath)) { return undefined; }
        const rt = this.createPanelRuntime(modelOverride, launch);
        const c: TabContainer = {
            id: `${this.workspaceId}:tab-${++this.tabSeq}`,
            root: { kind: "panel", panelId: rt.id },
            focusPanelId: rt.id,
        };
        this.tabContainers.set(c.id, c);
        this.broadcastTabList(true);
        return { container: c, rt };
    }

    /** 模型指名停某个子会话当前这一轮（tab 和会话都留着）。 */
    protected tabaStopByRef(parentPanelId: string, req: TabaStopRequest): void {
        const parentRt = this.panels.get(parentPanelId);
        const child = this.taba.findByRef(parentPanelId, { id: req.id, name: req.name });
        if (!child) {
            parentRt?.handleSend(
                `【停子会话没成】找不到「${req.name || req.id || "那个子会话"}」：不是这个会话派出去的，或者它的 tab 已经关掉了。`
            );
            return;
        }
        const rt = child.childPanelId ? this.panels.get(child.childPanelId) : undefined;
        if (!rt) { return; }
        rt.abortActiveRun();
        this.postToTab(rt.id, { type: "system", text: "派活给你的那个会话让你停下当前这一轮。" });
        this.postToTab(parentPanelId, {
            type: "system",
            text: `已让子会话「${child.name}」停下当前这一轮（它的 tab 还留着）。`,
        });
    }

    /** 子会话跑完一轮：第一轮的结果自动交回派活的会话（只交一次），之后用户接管就不再自动交。 */
    protected tabaOnTurnEnd(info: TurnEndInfo): void {
        const child = this.taba.byChildPanel(info.panelId);
        if (!child) { return; }
        // 第一轮：记下结束时间，把结果交回去（tabaDeliver 里会重写名录）
        if (child.endedAt === undefined && child.deliveries === 0) {
            this.taba.noteTurnEnd(child.id, info.status, Date.now());
            this.tabaDeliver(child, { resultText: info.lastReplyText ?? "", status: info.status, manual: false });
            return;
        }
        // 后面的轮次（一般是用户在子 tab 里接管了）：不再自动交回，
        // 但名录要跟上，否则主对话那边 taba_peek 看到的“最后一条回复的开头”一直停在旧的
        if (info.lastReplyText) { child.result = info.lastReplyText; }
        this.tabaWriteRun(child);
    }

    /** 把子会话的结果交到派活那个会话里（当成一条新消息发过去）。 */
    protected tabaDeliver(
        child: TabaChild,
        opts: { resultText?: string; status?: TurnEndStatus; manual?: boolean }
    ): boolean {
        const parentRt = child.parentPanelId ? this.panels.get(child.parentPanelId) : undefined;
        const parentTab = parentRt ? this.containerOfPanel(parentRt.id) : undefined;
        const result = (opts.resultText ?? child.result ?? "").trim();
        child.result = result;
        if (!parentRt || !parentTab) {
            if (child.childPanelId) {
                this.postToTab(child.childPanelId, {
                    type: "system",
                    text: "派你来干这个活的会话已经关掉了，结果交不回去；你现在是独立会话。",
                });
            }
            this.tabaWriteRun(child);
            return false;
        }
        const childTab = child.childTabId ? this.tabContainers.get(child.childTabId) : undefined;
        const text = buildDeliveryText({
            child,
            result,
            elapsedMs: Math.max(0, (child.endedAt ?? Date.now()) - child.startedAt),
            status: opts.status ?? child.lastStatus ?? "done",
            childTabName: childTab ? this.containerDisplayName(childTab) : undefined,
            manual: opts.manual,
        });
        parentRt.handleSend(text);
        this.taba.markDelivered(child.id, result);
        this.postToTab(parentRt.id, { type: "system", text: `已把子会话「${child.name}」的结果交回本会话。` });
        if (child.childPanelId) {
            this.postToTab(child.childPanelId, {
                type: "system",
                text: `结果已交回「${this.containerDisplayName(parentTab)}」。这个 tab 还留着，你可以接着问。`,
            });
        }
        this.broadcastTabList(true);
        this.tabaWriteRun(child);
        return true;
    }

    /** 界面上的“交回结果”：拿当前最后一条回复交回去（第一轮还没跑完也能交）。 */
    public async tabaDeliverManual(panelId: string): Promise<void> {
        const child = this.taba.byChildPanel(panelId);
        if (!child) { return; }
        const rt = this.panels.get(panelId);
        let text = "";
        if (rt) {
            try { text = (await rt.getLastAssistantText()) || ""; } catch { text = ""; }
        }
        if (child.endedAt === undefined) { child.lastStatus = "done"; }
        this.tabaDeliver(child, { resultText: text, manual: true });
    }

    /** 界面上的“变成独立会话”：断掉跟派活那边的关系，不再自动交回。 */
    public tabaDetachChild(panelId: string): void {
        const child = this.taba.byChildPanel(panelId);
        if (!child) { return; }
        const parentPanelId = child.parentPanelId;
        child.parentPanelId = undefined;
        child.state = "detached";
        this.postToTab(panelId, { type: "system", text: "已变成独立会话：结果不会再自动交回原来那个会话。" });
        if (parentPanelId && this.panels.has(parentPanelId)) {
            this.postToTab(parentPanelId, {
                type: "system",
                text: `子会话「${child.name}」被用户改成了独立会话，结果不会再交回。`,
            });
        }
        this.broadcastTabList(true);
        this.tabaWriteRun(child);
    }

    /** 界面上的“打开派活的那个会话”。 */
    public tabaGoParent(panelId: string): void {
        const parentPanelId = this.taba.byChildPanel(panelId)?.parentPanelId;
        if (!parentPanelId) { return; }
        const c = this.containerOfPanel(parentPanelId);
        if (!c) { return; }
        this.setActive(c.id);
        this.focusPanel(parentPanelId);
    }

    /** 切到某个 tab（可选：同时聚焦其中某个 panel）。 */
    public tabaOpenTab(tabId: string, panelId?: string): void {
        if (!this.tabContainers.has(tabId)) { return; }
        this.setActive(tabId);
        if (panelId && this.panels.has(panelId)) { this.focusPanel(panelId); }
    }

    /** 某个 tab 的显示名（不在就返回空串）。 */
    protected tabNameOf(tabId: string): string {
        const c = this.tabContainers.get(tabId);
        return c ? this.containerDisplayName(c) : "";
    }

    /** 子会话 tab 在 tab 栗上显示的名字（比随机名字好认）。 */
    protected tabaTabNameOf(name: string): string {
        const t = name.trim() || "子会话";
        return t.length > ChatControllerBase.TABA_TAB_NAME_MAX
            ? t.slice(0, ChatControllerBase.TABA_TAB_NAME_MAX) + "…"
            : t;
    }

    /** panel 被关掉（或搬去另一个工作区）时收尾：它派的子会话变独立；它自己是子会话就摸掉登记并告知父会话。
     *  @param quiet 搬到另一个工作区时传 true：panel 并没有被关掉，不发那些“关掉了”的提示
     *  （两边的 panel 编号会变，登记本来就对不上了，清掉就行）。 */
    protected notePanelGoneForTaba(panelId: string, opts?: { quiet?: boolean }): void {
        const detached = this.taba.detachChildrenOf(panelId);
        for (const c of detached) {
            if (!opts?.quiet && c.childPanelId && this.panels.has(c.childPanelId)) {
                this.postToTab(c.childPanelId, {
                    type: "system",
                    text: "派你来干这个活的会话已经关掉了：你现在是独立会话，结果不会再自动交回。",
                });
            }
            this.tabaWriteRun(c);
        }
        const promptFile = this.tabaPromptFiles.get(panelId);
        if (promptFile) {
            this.tabaPromptFiles.delete(panelId);
            try { fs.rmSync(promptFile, { force: true }); } catch { /* 删不掉就算了 */ }
        }
        const child = this.taba.byChildPanel(panelId);
        if (child) {
            const parentRt = child.parentPanelId ? this.panels.get(child.parentPanelId) : undefined;
            const undelivered = child.deliveries === 0 && child.endedAt === undefined;
            // 名录里留下最后一条（写成 tab 已关闭）：事后模型还能读到那个 .jsonl
            this.tabaWriteRun(child, "closed");
            this.taba.forgetChildPanel(panelId);
            if (parentRt && undelivered && !opts?.quiet) {
                parentRt.handleSend(buildChildClosedNotice({ child }));
                this.postToTab(parentRt.id, {
                    type: "system",
                    text: `子会话「${child.name}」的 tab 关掉了，已把这件事交回本会话。`,
                });
            }
        }
        if (detached.length > 0) { this.broadcastTabList(true); }
    }

    /** 某个 panel 的子会话信息（交给前端画标记与右键菜单）。 */
    protected tabaPanelInfo(panelId: string): Record<string, unknown> | undefined {
        const asChild = this.taba.byChildPanel(panelId);
        if (asChild) {
            const parentTab = asChild.parentPanelId ? this.containerOfPanel(asChild.parentPanelId) : undefined;
            return {
                role: "child",
                id: asChild.id,
                name: asChild.name,
                state: asChild.state,
                stateText: describeChildState(asChild.state),
                deliveries: asChild.deliveries,
                sessionMode: asChild.sessionMode,
                modelLabel: asChild.modelLabel ?? "",
                elapsedMs: Math.max(0, (asChild.endedAt ?? Date.now()) - asChild.startedAt),
                elapsedText: formatElapsedMs(Math.max(0, (asChild.endedAt ?? Date.now()) - asChild.startedAt)),
                parentTabId: parentTab?.id ?? "",
                parentName: parentTab ? this.containerDisplayName(parentTab) : "",
            };
        }
        const kids = this.taba.liveChildrenOf(panelId);
        if (kids.length === 0) { return undefined; }
        return {
            role: "parent",
            children: kids.map((k) => ({
                id: k.id,
                name: k.name,
                state: k.state,
                stateText: describeChildState(k.state),
                panelId: k.childPanelId ?? "",
                tabId: k.childTabId ?? "",
                tabName: k.childTabId ? this.tabNameOf(k.childTabId) : "",
            })),
        };
    }

    /** 某个 tab（容器）的子会话信息：先看它是不是个子会话 tab，再看它派过子会话没有。 */
    protected tabaTabInfo(c: TabContainer): Record<string, unknown> | undefined {
        for (const pid of layoutLeaves(c.root)) {
            const info = this.tabaPanelInfo(pid);
            if (info) { return info; }
        }
        return undefined;
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
        this.notePanelGoneForTaba(panelId);
        rt.stopClient();
        this.releasePanelName(rt.nameParts);
        this.panels.delete(panelId);
    }

    /** 某 tab（容器）内的全部 panel id（布局深度优先序）。 */
    public panelsOfContainer(containerId: string): string[] {
        const c = this.tabContainers.get(containerId);
        return c ? layoutLeaves(c.root) : [];
    }

    /** 保证至少有一个 tab（移交失败等路径的兜底）。 */
    public ensureSomeTab(): void {
        if (this.tabContainers.size === 0) { this.newTab(); }
    }

    /** 宿主是否已销毁（跨工作区移交编排用于放弃已关闭的目标）。 */
    public isDisposed(): boolean { return false; }

    /** 向本工作区 webview 推送消息（跨工作区编排用的公开入口）。 */
    public postToWebviewPublic(msg: Record<string, unknown>): void { this.postToWebview(msg); }

    // ========================================================================
    //  活体移交（跨工作区：侧边栏 ↔ 编辑器面板）
    // ========================================================================
    /**
     * 移交源：把一批 panel 连同布局子树摘出本工作区——**不杀 pi 进程、不释放名字**，
     * 运行时状态由 {@link adoptPanels} 在新宿主里接管。
     * 只支持两种粒度：单个 panel，或某个 tab 的全部 panel（布局树整棵带走）。
     * 返回 undefined 表示请求已过时（panel 已关闭 / 粒度不支持），调用方放弃即可。
     */
    public detachPanelsForTransfer(panelIds: string[]): TransferPayload | undefined {
        if (panelIds.length === 0) { return undefined; }
        const runtimes: SessionRuntime[] = [];
        for (const id of panelIds) {
            const rt = this.panels.get(id);
            // 有一个已失效就整体放弃：不留“搬了一半”的状态
            if (!rt) { return undefined; }
            runtimes.push(rt);
        }
        const container = this.containerOfPanel(panelIds[0]);
        if (!container) { return undefined; }
        const leaves = layoutLeaves(container.root);
        const wholeTab = panelIds.length === leaves.length;
        if (!wholeTab && panelIds.length > 1) { return undefined; }

        const root: LayoutNode = wholeTab ? container.root : { kind: "panel", panelId: panelIds[0] };
        const focusPanelId = wholeTab ? container.focusPanelId : panelIds[0];

        if (wholeTab) {
            this.tabContainers.delete(container.id);
            this.postToWebview({ type: "tabClosed", id: container.id });
            if (this.activeTabId === container.id) {
                this.activeTabId = this.tabContainers.size > 0 ? this.tabContainers.keys().next().value : undefined;
                if (this.activeTabId) { this.postToWebview({ type: "tabActivated", id: this.activeTabId }); }
            }
        } else {
            this.detachPanelFromContainer(container, panelIds[0]);
        }
        for (const id of panelIds) { this.notePanelGoneForTaba(id, { quiet: true }); this.panels.delete(id); }
        this.broadcastTabList(true);
        // 源工作区被搬空：补一个空 tab，界面保持可用（与 closeTab 一致）
        if (this.tabContainers.size === 0) { this.newTab(); }
        return { runtimes, root, focusPanelId };
    }

    /**
     * 移交目标：接管一批 panel 运行时，在本工作区新建（或复用空的活跃）tab 承载，
     * 换绑宿主后把已有对话重放进本 webview。调用前必须确保本 webview 已就绪，
     * 否则重放消息会被静默丢弃。
     */
    public async adoptPanels(payload: TransferPayload): Promise<void> {
        const { runtimes, root } = payload;
        if (runtimes.length === 0) { return; }
        // panel id 归入本工作区命名空间（源 id 前缀是别的工作区，留着易混淆）
        const idMap = new Map<string, string>();
        for (const rt of runtimes) {
            idMap.set(rt.id, `${this.workspaceId}:panel-${++this.panelSeq}`);
        }
        for (const rt of runtimes) {
            const nextId = idMap.get(rt.id)!;
            rt.rebindHost(this);
            rt.id = nextId;
            this.panels.set(nextId, rt);
        }
        const newRoot = remapLayout(root, idMap);
        const leaves = layoutLeaves(newRoot);
        const focus = idMap.get(payload.focusPanelId ?? "") ?? leaves[0];

        // 空的活跃 tab 直接承载迁入会话：新建工作区时不会留下多余的空 tab / pi 进程
        const reusable = this.activeTabId ? this.tabContainers.get(this.activeTabId) : undefined;
        let c: TabContainer;
        if (reusable && this.isActiveTabEmpty()) {
            for (const pid of layoutLeaves(reusable.root)) { this.disposePanelRuntime(pid); }
            reusable.root = newRoot;
            reusable.focusPanelId = focus;
            c = reusable;
        } else {
            c = { id: `${this.workspaceId}:tab-${++this.tabSeq}`, root: newRoot, focusPanelId: focus };
            this.tabContainers.set(c.id, c);
        }
        this.activeTabId = c.id;
        this.postToWebview({ type: "tabActivated", id: c.id });
        // 先推结构（webview 据此建好各 pane），再重放消息
        this.broadcastTabList(true);
        await Promise.all(runtimes.map((rt) => rt.replayHistory()));
        this.broadcastTabList(true);
        // 迁入会话的 knownFiles 也要能在新宿主变成可点击符号
        this.onKnownFilesChangedByHost();
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
                // 派子会话：这个 panel 是子会话、或者它派过子会话（前端据此画标记与菜单）
                taba: this.tabaPanelInfo(node.panelId) ?? null,
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
        if (rts.length === 1) {
            // 子会话 tab：用它自己的活名（比“沉静的雪豹”好认）
            const child = this.taba.byChildPanel(rts[0]!.id);
            if (child) { return this.tabaTabNameOf(child.name); }
            return composeName(rts[0]!.nameParts);
        }
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
                    taba: this.tabaTabInfo(c) ?? null,
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

    /**
     * RuntimeHost.onTurnEnd：一个会话跑完了一轮。
     *
     * 基类只做“与平台无关”的两件事：
     *   1. 提示音立刻响 —— 当前 tab 里所有 session 跑完都响一声。
     *      隐藏 tab / 隐藏工作区的 session 界面看不见，就不响。
     *      它不等会话标题：声音是用来告诉你“跑完了”，晚响几秒反而像没响。
     *   2. 系统提醒等一等 pi 的会话标题再发，标题到手（或等超时）才交给平台层。
     */
    public onTurnEnd(info: TurnEndInfo): void {
        // 子会话跑完第一轮：结果先交回派活的那个会话（不等会话标题）
        this.tabaOnTurnEnd(info);
        if (this.notifyBeepEnabled()) {
            // 发给当前 tab 里的所有 panel：界面可见就响（网页那边会自己拦下隐藏情况）；
            // panel 在隐藏的 tab 里时只发给它自己，界面看不见，不会响。
            for (const id of this.panelIdsOf(info.panelId)) { this.postToTab(id, { type: "beep" }); }
        }
        void this.notifyTurnEndWithTitle(info);
    }

    /**
     * 补齐会话标题与 tab 显示名后，把这一轮收尾交给平台层（Windows 通知 + 界面提醒）。
     *
     * 会话标题由 pi 那边的自动命名扩展在第一轮跑完后才生成（要额外问一次模型，慢一两秒），
     * 所以这里最多等 turnTitleWaitMs() 毫秒；等不到就用会话显示名兜底，提醒一定发出去。
     */
    private async notifyTurnEndWithTitle(info: TurnEndInfo): Promise<void> {
        let sessionTitle = info.sessionTitle ?? "";
        if (!sessionTitle) {
            const rt = this.panels.get(info.panelId);
            const wait = this.turnTitleWaitMs();
            if (rt && wait > 0) {
                sessionTitle = await rt.waitForSessionTitle(wait);
            }
        }
        // 等待期间 tab 结构可能变了（换 tab / 关 panel），tab 显示名重算一次
        const c = this.containerOfPanel(info.panelId);
        this.notifyTurnEnd({
            ...info,
            sessionTitle,
            tabName: c ? this.containerDisplayName(c) : info.tabName,
            workspaceId: this.workspaceId,
        });
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
                this.postToWebview({ type: "transferCaps", dest: this.transferDestination() ?? null });
                this.broadcastTabList();
                if (this.tabContainers.size === 0) {
                    if (this.shouldCreateInitialTab()) {
                        this.newTab(ChatControllerBase.SPARE_PREWARM_DELAY_MS);
                        void this.maybeAutoLoadLastSession();
                    }
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
            case "tabaDeliver":
            case "tabaDetach":
            case "tabaGoParent": {
                // 这三条认 panelId（前端从 panel 右键菜单发）；兼容只带 tabId 的写法
                const pid = typeof msg.panelId === "string" ? msg.panelId
                    : (typeof msg.tabId === "string" ? msg.tabId : "");
                if (!pid) { return; }
                if (msg.type === "tabaDeliver") { void this.tabaDeliverManual(pid); }
                else if (msg.type === "tabaDetach") { this.tabaDetachChild(pid); }
                else { this.tabaGoParent(pid); }
                return;
            }
            case "tabaOpenTab":
                if (typeof msg.tabId === "string" && msg.tabId) {
                    this.tabaOpenTab(msg.tabId, typeof msg.panelId === "string" ? msg.panelId : undefined);
                }
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

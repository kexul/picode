import { setExtensionRoot } from "../../../src/shared/modelsConfig";
import { FileChange } from "../../../src/shared/sessionRuntime";
import { ChatControllerBase } from "../../../src/shared/chatControllerBase";
import { AppConfig } from "./config";
import * as fs from "fs";
import * as path from "path";


export interface ControllerHost {
    post: (msg: Record<string, unknown>) => void;
    getConfig: () => AppConfig;
    saveConfig: () => void;
    openFileViewer: (filePath: string, line: number, anchor?: string) => void;
    onSessionChanged?: (sessionPath: string | undefined) => void;
}

/**
 * Electron 客户端的会话控制器。
 *
 * 平台相关部分（渲染进程通信、配置文件存储、modal 弹窗、文件查看器、
 * 项目切换 / 扫描）在此实现；其余与 VSCode 共享的会话编排逻辑继承自
 * {@link ChatControllerBase}。
 */
export class ChatController extends ChatControllerBase {
    private cwd = "";
    private initialLoadDone = false;
    private fileCache: { cwd: string; ts: number; files: { label: string; path: string }[] } = { cwd: "", ts: 0, files: [] };
    private modalCallbacks = new Map<string, (payload: any) => void>();
    private modalSeq = 0;

    private static readonly NEW_SESSION_KEYS = ["ctrl+alt+n", "ctrl+shift+n", "ctrl+t", "alt+n"] as const;
    private static readonly TAB_SWITCH_KEYS = ["ctrl+alt+arrows", "ctrl+alt+pgupdown", "alt+brackets", "ctrl+alt+brackets"] as const;

    constructor(public readonly host: ControllerHost) {
        super();
    }

    // ---- transport ----
    protected postToWebview(msg: Record<string, unknown>): void {
        this.host.post(msg);
    }

    // ---- RuntimeHost：配置 / cwd ----
    public getCwd(): string { return this.cwd; }

    public getConfig() {
        const cfg = this.host.getConfig();
        return { piPath: cfg.piPath, provider: cfg.provider, model: cfg.model, extraArgs: cfg.extraArgs, trustProject: cfg.trustProject };
    }

    // ---- RuntimeHost：UI 弹窗（modal 经 IPC 走渲染进程）----
    /** modal 弹窗（全局单例），resolve 后由发起的 runtime 闭包处理。 */
    prompt(kind: string, data: any): Promise<any> {
        return new Promise((resolve) => {
            const id = `modal-${++this.modalSeq}`;
            this.modalCallbacks.set(id, resolve);
            this.host.post({ type: "modal", id, kind, data });
            setTimeout(() => { if (this.modalCallbacks.has(id)) { this.modalCallbacks.delete(id); resolve(undefined); } }, 300000);
        });
    }

    handleModalReply(msg: any): void {
        const cb = this.modalCallbacks.get(msg.id);
        if (cb) { this.modalCallbacks.delete(msg.id); cb(msg.payload ?? {}); }
    }

    async confirmDialog(title: string, message: string): Promise<boolean> {
        const r: any = await this.prompt("confirm", { title, message });
        return !!(r && r.confirmed);
    }

    async selectDialog(title: string, options: string[]): Promise<string | undefined> {
        const r: any = await this.prompt("select", { title, options });
        if (!r || r.cancelled) { return undefined; }
        return r.value;
    }

    async inputDialog(title: string, placeholder: string, prefill: string): Promise<string | undefined> {
        const r: any = await this.prompt("input", { title, placeholder, prefill });
        if (!r || r.cancelled) { return undefined; }
        return r.value;
    }

    async confirmRevert(label: string): Promise<boolean> {
        const r: any = await this.prompt("confirm", { title: "确认回滚", message: label });
        return !!(r && r.confirmed);
    }

    persistModel(provider: string, modelId: string): void {
        const cfg = this.host.getConfig();
        cfg.provider = provider;
        cfg.model = modelId;
        this.host.saveConfig();
    }

    // ---- RuntimeHost：文件跳转 / diff ----
    openFileLocation(p: string, line: number, anchor?: string): void {
        this.host.openFileViewer(p, line, anchor);
    }

    openDiff(change: FileChange): void {
        this.host.openFileViewer(change.path, 1);
    }

    // ---- 显示选项存储（config.json 的 view 子对象）----
    protected getShowStatsBar(): boolean { return this.host.getConfig().view.showStatsBar; }
    protected getAutoLoadLast(): boolean { return this.host.getConfig().view.autoLoadLastSession; }
    protected getSendKey(): string { return this.host.getConfig().view.sendKey; }
    protected getNewSessionKey(): string { return this.host.getConfig().view.newSessionKey || "ctrl+alt+n"; }
    protected getTabSwitchKey(): string { return this.host.getConfig().view.tabSwitchKey || "ctrl+alt+arrows"; }

    /** 变更显示选项存储（仅改 config + 落盘，UI 推送由调用方/基类统一）。 */
    protected mutateViewOption(action: string): void {
        const v = this.host.getConfig().view;
        if (action === "sendKey") {
            const order = ["enter", "shift+enter", "alt+enter", "ctrl+enter"] as const;
            const idx = order.indexOf(v.sendKey as (typeof order)[number]);
            v.sendKey = order[(idx + 1) % order.length];
        } else if (action === "newSessionKey") {
            const order = ChatController.NEW_SESSION_KEYS;
            const idx = order.indexOf((v.newSessionKey || "ctrl+alt+n") as (typeof order)[number]);
            v.newSessionKey = order[(idx + 1) % order.length];
        } else if (action === "tabSwitchKey") {
            const order = ChatController.TAB_SWITCH_KEYS;
            const idx = order.indexOf((v.tabSwitchKey || "ctrl+alt+arrows") as (typeof order)[number]);
            v.tabSwitchKey = order[(idx + 1) % order.length];
        } else if (action === "showStatsBar" || action === "autoLoadLastSession") {
            (v as any)[action] = !(v as any)[action];
        } else {
            return;
        }
        this.host.saveConfig();
    }

    // ---- main.ts 仍以旧名调用，保留公共入口 ----
    public toggleViewOption(key: "showStatsBar" | "autoLoadLastSession"): void {
        this.mutateViewOption(key);
        this.sendViewOptions();
    }

    public cycleSendKey(): void {
        this.mutateViewOption("sendKey");
        this.sendViewOptions();
    }

    /** 供 main.ts 的 app:requestViewOptions 主动推送当前显示选项。 */
    public pushViewOptions(): void {
        this.sendViewOptions();
    }

    public showHistory(): Promise<void> {
        return this.showHistoryPicker();
    }

    /** 兼容 main.ts 的旧分发入口。 */
    public onMsg(msg: any): void {
        this.processMessage(msg);
    }

    // ---- 平台独有消息 ----
    protected handlePlatformMessage(msg: any): boolean {
        if (msg.type === "modalReply") {
            this.handleModalReply(msg);
            return true;
        }
        return false;
    }

    // ---- 活跃会话 / 空历史提示 ----
    protected onActiveSessionChanged(sessionPath: string | undefined): void {
        this.host.onSessionChanged?.(sessionPath);
    }

    protected onNoSessions(): void {
        this.host.post({ type: "system", text: "当前项目没有 pi 历史会话。" });
    }

    // ---- 文件列表 / 文件打开（listFiles / openFile）----
    protected sendFileList(): void {
        this.host.post({ type: "openFiles", files: this.projectFiles() });
    }

    protected openFileFromWebview(p: string, line?: number, _col?: number): void {
        this.openFile(p, typeof line === "number" ? line : 1);
    }

    // ---- 项目切换 ----
    setProject(dir: string): void {
        const norm = path.resolve(dir);
        this.cwd = norm;
        this.autoLoadDone = false;
        // 停掉所有 tab，清空
        for (const rt of this.tabs.values()) { rt.stopClient(); }
        this.tabs.clear();
        this.activeId = undefined;
        this.host.post({ type: "clear" });
        this.host.post({ type: "system", text: `已切换到项目: ${norm}` });
        // 新建首个 tab 并启动 pi
        this.newTab();
        if (!this.initialLoadDone) {
            this.initialLoadDone = true;
            void this.maybeAutoLoadLastSession();
        }
    }

    dispose(): void { for (const rt of this.tabs.values()) { rt.stopClient(); } }

    // ---- 项目文件列表（带缓存，全局共享）----
    private projectFiles(): { label: string; path: string }[] {
        const now = Date.now();
        if (this.fileCache.cwd !== this.cwd || now - this.fileCache.ts > 30000) {
            this.fileCache = { cwd: this.cwd, ts: now, files: this.scanProject(this.cwd) };
        }
        return this.fileCache.files;
    }

    private scanProject(root: string): { label: string; path: string }[] {
        const SKIP = new Set(["node_modules",".git",".svn",".hg","out","dist","build",".next",".nuxt","target",".cache",".vscode",".idea","__pycache__",".venv","venv","vendor",".gradle"]);
        const MAX = 8000;
        const out: { label: string; path: string }[] = [];
        let stopped = false;
        const normRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
        const walk = (dir: string) => {
            if (stopped || out.length >= MAX) { stopped = true; return; }
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (out.length >= MAX) { stopped = true; return; }
                if (e.isDirectory()) { if (SKIP.has(e.name) || e.name.startsWith(".")) { continue; } walk(path.join(dir, e.name)); }
                else if (e.isFile()) {
                    const full = path.join(dir, e.name);
                    let rel = full.replace(/\\/g, "/");
                    if (rel.toLowerCase().startsWith(normRoot.toLowerCase() + "/")) { rel = rel.slice(normRoot.length + 1); }
                    out.push({ label: rel, path: full });
                }
            }
        };
        walk(root);
        return out;
    }

    /** 正文文件路径链接打开（全局，不依赖 tab）。 */
    public openFile(p: string, line: number): void {
        const full = this.resolvePath(p);
        try {
            if (fs.existsSync(full) && !fs.statSync(full).isDirectory()) {
                this.host.openFileViewer(full, line);
                return;
            }
        } catch { /* 忽略，走下面模糊匹配 */ }
        const base = path.basename(p).toLowerCase();
        const plain = p.toLowerCase().replace(/\\/g, "/");
        const files = this.projectFiles();
        const matches = files.filter((f) => {
            const segs = f.label.toLowerCase().split("/").filter(Boolean);
            return segs.length > 0 && segs[segs.length - 1] === base;
        });
        if (matches.length > 0) {
            const target = matches.find((f) => f.label.toLowerCase().replace(/\\/g, "/").endsWith(plain)) || matches[0];
            this.host.openFileViewer(target.path, line);
            return;
        }
        this.host.post({ type: "system", text: `未找到文件 ${p}` });
    }
}

export function initSharedRoot(rendererDir: string): void {
    setExtensionRoot(rendererDir);
}

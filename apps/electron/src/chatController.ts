import { PiClient } from "../../../src/shared/piClient";
import { listSessions } from "../../../src/shared/sessionStore";
import { setExtensionRoot } from "../../../src/shared/modelsConfig";
import { AppConfig } from "./config";
import * as fs from "fs";
import * as path from "path";

interface FileChange {
    path: string;
    label: string;
    before: string;
}

export interface ControllerHost {
    post: (msg: Record<string, unknown>) => void;
    getConfig: () => AppConfig;
    saveConfig: () => void;
    openFileViewer: (filePath: string, line: number, anchor?: string) => void;
    onSessionChanged?: (sessionPath: string | undefined) => void;
}

export class ChatController {
    private client?: PiClient;
    private streaming = false;
    private piReady = false;
    private reqId = 0;
    private pending = new Map<string, (resp: any) => void>();
    private fileChanges = new Map<string, FileChange>();
    private pendingEdits = new Map<string, { path: string; before: string }>();
    private editSnapshots = new Map<string, { path: string; before: string; after: string }>();
    private forkEntries: { entryId: string; text: string }[] = [];
    private autoLoadDone = false;
    private initialLoadDone = false;
    private currentSessionPath: string | undefined;
    private cwd = "";
    private fileCache: { cwd: string; ts: number; files: { label: string; path: string }[] } = {
        cwd: "", ts: 0, files: [],
    };
    private modalCallbacks = new Map<string, (payload: any) => void>();
    private modalSeq = 0;

    constructor(private host: ControllerHost) {}

    setCwd(cwd: string): void { this.cwd = cwd; }
    getCwd(): string { return this.cwd; }
    getCurrentSessionPath(): string | undefined { return this.currentSessionPath; }

    setProject(dir: string): void {
        const norm = path.resolve(dir);
        this.cwd = norm;
        this.autoLoadDone = false;
        this.resetFileChanges();
        this.currentSessionPath = undefined;
        this.host.onSessionChanged?.(undefined);
        this.abortActiveRun();
        this.stopClient();
        this.post({ type: "clear" });
        this.post({ type: "system", text: `已切换到项目: ${norm}` });
        this.startClient();
        if (!this.initialLoadDone) {
            this.initialLoadDone = true;
            void this.maybeAutoLoadLastSession();
        }
    }

    dispose(): void { this.stopClient(); }

    private getShowStatsBar(): boolean { return this.host.getConfig().view.showStatsBar; }
    private getAutoLoadLast(): boolean { return this.host.getConfig().view.autoLoadLastSession; }
    private getSendKey(): string { return this.host.getConfig().view.sendKey; }

    sendViewOptions(): void {
        this.post({
            type: "viewOptions",
            showStatsBar: this.getShowStatsBar(),
            autoLoadLastSession: this.getAutoLoadLast(),
            sendKey: this.getSendKey(),
        });
    }

    toggleViewOption(key: "showStatsBar" | "autoLoadLastSession"): void {
        const v = this.host.getConfig().view;
        (v as any)[key] = !(v as any)[key];
        this.host.saveConfig();
        this.sendViewOptions();
    }

    cycleSendKey(): void {
        const order = ["enter", "shift+enter", "alt+enter", "ctrl+enter"] as const;
        const v = this.host.getConfig().view;
        const idx = order.indexOf(v.sendKey as (typeof order)[number]);
        v.sendKey = order[(idx + 1) % order.length];
        this.host.saveConfig();
        this.sendViewOptions();
    }

    private getConfig() {
        const cfg = this.host.getConfig();
        return {
            piPath: cfg.piPath,
            provider: cfg.provider,
            model: cfg.model,
            extraArgs: cfg.extraArgs,
            trustProject: cfg.trustProject,
        };
    }

    private checkPiAvailable(piPath: string): boolean {
        if (this.resolveExecutable(piPath)) return true;
        this.post({ type: "systemError", text: `未找到 pi 可执行文件（当前配置："${piPath}"）。请确认已安装 pi 并加入 PATH，或在设置中指定 piPath。` });
        return false;
    }

    private resolveExecutable(cmd: string): string | undefined {
        if (!cmd) return undefined;
        const isWindows = process.platform === "win32";
        const exts = isWindows ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
        const existsAsFile = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
        const tryWithExts = (base: string): string | undefined => {
            if (existsAsFile(base)) return base;
            if (isWindows) {
                for (const ext of exts) {
                    const lo = base + ext.toLowerCase(); if (existsAsFile(lo)) return lo;
                    const up = base + ext; if (existsAsFile(up)) return up;
                }
            }
            return undefined;
        };
        if (cmd.includes("/") || cmd.includes("\\")) {
            const abs = path.isAbsolute(cmd) ? cmd : path.resolve(this.cwd, cmd);
            return tryWithExts(abs);
        }
        const pathEnv = process.env.PATH || process.env.Path || "";
        const sep = isWindows ? ";" : ":";
        for (const dir of pathEnv.split(sep).filter(Boolean)) {
            const found = tryWithExts(path.join(dir, cmd));
            if (found) return found;
        }
        return undefined;
    }

    startClient(): void {
        if (this.client && this.client.isRunning()) return;
        if (!this.cwd) { this.post({ type: "system", text: "请先选择一个项目文件夹。" }); return; }
        this.setPiReady(false);
        const cfg = this.getConfig();
        if (!this.checkPiAvailable(cfg.piPath)) return;
        const extraArgs = cfg.trustProject ? [...cfg.extraArgs, "--approve"] : cfg.extraArgs;

        this.client = new PiClient({
            piPath: cfg.piPath,
            cwd: this.cwd,
            provider: cfg.provider || undefined,
            model: cfg.model || undefined,
            extraArgs,
        });

        this.client.on("event", (evt) => this.onPiEvent(evt));
        this.client.on("response", (resp) => this.onPiResponse(resp));
        this.client.on("ui", (req) => this.onPiUiRequest(req));
        this.client.on("stderr", (text: string) => console.error("[pi stderr]", text));
        this.client.on("error", (err: Error) => this.post({ type: "systemError", text: `pi 错误: ${err.message}` }));
        this.client.on("exit", (code: number | null) => {
            this.streaming = false;
            this.post({ type: "streamEnd" });
            this.setPiReady(true);
            this.post({ type: "system", text: `pi 进程已退出（code=${code}）。发送消息会自动重启。` });
        });

        try {
            this.client.start();
            this.setPiReady(true);
            this.post({ type: "system", text: "pi 已启动，可以开始对话。" });
        } catch (e: any) {
            this.post({ type: "systemError", text: `无法启动 pi: ${e.message}` });
        }
    }

    private setPiReady(ready: boolean): void { this.piReady = ready; this.post({ type: "piReady", ready }); }
    private stopClient(): void { if (this.client) { this.client.stop(); this.client = undefined; } }

    newSession(): void {
        this.abortActiveRun();
        this.resetFileChanges();
        this.currentSessionPath = undefined;
        this.host.onSessionChanged?.(undefined);
        this.post({ type: "clear" });
        this.post({ type: "system", text: "已开始新会话。" });
        if (this.client && this.client.isRunning()) this.client.send({ type: "new_session" });
        else this.startClient();
    }

    private abortActiveRun(): void {
        if (this.client && this.client.isRunning() && this.streaming) {
            this.client.send({ type: "abort_bash" });
            this.client.send({ type: "abort" });
        }
    }

    async loadHistorySession(file: string): Promise<void> { await this.loadSession(file); }

    private async loadSession(file: string): Promise<void> {
        if (!this.client || !this.client.isRunning()) this.startClient();
        this.resetFileChanges();
        this.post({ type: "clear" });
        this.post({ type: "system", text: "正在加载会话…" });
        const switchResp = await this.request({ type: "switch_session", sessionPath: file });
        if (!switchResp || switchResp.success === false) {
            this.post({ type: "systemError", text: `加载会话失败: ${switchResp?.error ?? "未知错误"}` });
            return;
        }
        const [msgResp, forkResp] = await Promise.all([
            this.request({ type: "get_messages" }),
            this.request({ type: "get_fork_messages" }),
        ]);
        const messages: any[] = msgResp?.data?.messages ?? [];
        this.forkEntries = forkResp?.data?.messages ?? [];
        this.renderMessages(messages);
        this.currentSessionPath = file;
        this.host.onSessionChanged?.(file);
        this.post({ type: "system", text: `已加载会话（${messages.length} 条消息）。` });
        this.refreshStats();
    }

    private async maybeAutoLoadLastSession(): Promise<void> {
        if (this.autoLoadDone) return;
        if (!this.cwd) return;
        this.autoLoadDone = true;
        if (!this.getAutoLoadLast()) return;
        const sessions = await listSessions(this.cwd);
        if (sessions.length === 0) return;
        await this.loadSession(sessions[0].file);
    }

    async showHistory(): Promise<void> {
        const sessions = await listSessions(this.cwd);
        this.post({ type: "app:history", sessions, current: this.currentSessionPath });
    }

    private async showTree(): Promise<void> {
        const resp = await this.request({ type: "get_tree" });
        if (!resp || resp.success === false) {
            this.post({ type: "systemError", text: `获取对话树失败: ${resp?.error ?? "未知错误"}` });
            return;
        }
        this.post({ type: "treeView", tree: resp.data?.tree ?? [], leafId: resp.data?.leafId ?? null });
    }

    private async forkFromEntry(entryId: string): Promise<void> {
        this.abortActiveRun();
        this.post({ type: "system", text: "正在从该消息处分叉…" });
        const resp = await this.request({ type: "fork", entryId });
        if (!resp || resp.success === false) {
            this.post({ type: "systemError", text: `分叉失败: ${resp?.error ?? "未知错误"}` });
            return;
        }
        if (resp.data?.cancelled) { this.post({ type: "system", text: "分叉已取消。" }); return; }
        this.resetFileChanges();
        const [msgResp, forkResp] = await Promise.all([
            this.request({ type: "get_messages" }),
            this.request({ type: "get_fork_messages" }),
        ]);
        const messages: any[] = msgResp?.data?.messages ?? [];
        this.forkEntries = forkResp?.data?.messages ?? [];
        this.post({ type: "clear" });
        this.renderMessages(messages);
        this.post({ type: "system", text: `已分叉到新分支（${messages.length} 条消息）。` });
        this.refreshStats();
    }

    private renderMessages(messages: any[]): void {
        const toolResults = new Map<string, any>();
        for (const m of messages) {
            if (m && m.role === "toolResult" && typeof m.toolCallId === "string") toolResults.set(m.toolCallId, m);
        }
        let userIndex = 0;
        for (const m of messages) {
            switch (m.role) {
                case "user":
                    this.post({ type: "userMessage", text: this.textOf(m.content), entryId: this.forkEntries[userIndex]?.entryId });
                    userIndex++;
                    break;
                case "assistant": {
                    const parts = Array.isArray(m.content) ? m.content : [];
                    let text = "";
                    for (const c of parts) {
                        if (c.type === "text") { text += c.text; }
                        else if (c.type === "toolCall") {
                            if (text.trim()) { this.post({ type: "assistantFull", text }); text = ""; }
                            if (c.name === "edit" || c.name === "write") {
                                const p = this.editToolPath(c.name, c.arguments);
                                const id = c.id || `hist-${Math.random()}`;
                                this.post({ type: "editCardStart", toolCallId: id, toolName: c.name, path: p || "", label: p ? this.relativeTo(this.cwd, p) : "" });
                                this.post({ type: "editCardResult", toolCallId: id, diff: this.historyEditInfo(c, toolResults.get(id)), canRevert: false });
                            } else {
                                this.post({ type: "tool", toolName: c.name, args: c.arguments });
                            }
                        }
                    }
                    if (text.trim()) this.post({ type: "assistantFull", text });
                    break;
                }
            }
        }
    }

    private textOf(content: unknown): string {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) return content.map((c: any) => (c.type === "text" ? c.text : "")).join("");
        return "";
    }

    private request(cmd: Record<string, unknown>): Promise<any> {
        return new Promise((resolve) => {
            if (!this.client || !this.client.isRunning()) { resolve(undefined); return; }
            const id = `req-${++this.reqId}`;
            const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve(undefined); } }, 15000);
            const wrapped = (resp: any) => { clearTimeout(timer); resolve(resp); };
            this.pending.set(id, wrapped);
            try { this.client!.send({ ...cmd, id }); }
            catch { this.pending.delete(id); clearTimeout(timer); resolve(undefined); }
        });
    }

    onMsg(msg: any): void {
        switch (msg.type) {
            case "send": this.handleSend(msg.text, msg.images); break;
            case "newSession": this.newSession(); break;
            case "abort": this.abortActiveRun(); break;
            case "showTree": void this.showTree(); break;
            case "forkAtEntry": if (typeof msg.entryId === "string") this.forkFromEntry(msg.entryId); break;
            case "pickModel": void this.pickModel(); break;
            case "listFiles": this.sendProjectFiles(); break;
            case "openDiff":
                if (typeof msg.path === "string") this.host.openFileViewer(msg.path, 1);
                break;
            case "openEditLocation":
                if (typeof msg.path === "string" && typeof msg.anchor === "string" && msg.anchor) {
                    this.openEditLocationWithAnchor(msg.path, typeof msg.line === "number" ? msg.line : 1, msg.anchor);
                } else if (typeof msg.path === "string") {
                    this.host.openFileViewer(msg.path, typeof msg.line === "number" ? msg.line : 1);
                }
                break;
            case "revertEdit": if (typeof msg.toolCallId === "string") void this.revertEdit(msg.toolCallId); break;
            case "ready":
                this.sendViewOptions();
                this.post({ type: "piReady", ready: this.piReady });
                void Promise.all([this.sendCurrentModel(), this.refreshStats()]);
                this.maybeAutoLoadLastSession();
                break;
            case "modalReply": this.handleModalReply(msg); break;
        }
    }

    private handleSend(text: string, images?: Array<{ data: string; mimeType: string }>): void {
        const hasImages = Array.isArray(images) && images.length > 0;
        if ((!text || !text.trim()) && !hasImages) return;
        if (!this.client || !this.client.isRunning()) this.startClient();
        this.post({ type: "userMessage", text, imageCount: hasImages ? images!.length : 0 });
        const cmd: Record<string, unknown> = { type: "prompt", message: text || "" };
        if (hasImages) cmd.images = images!.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType }));
        if (this.streaming) cmd.streamingBehavior = "steer";
        try { this.client!.send(cmd); }
        catch (e: any) { this.post({ type: "systemError", text: `发送失败: ${e.message}` }); }
    }

    private async pickModel(): Promise<void> {
        if (!this.client || !this.client.isRunning()) this.startClient();
        const resp = await this.request({ type: "get_available_models" });
        const models: any[] = resp?.data?.models ?? [];
        if (models.length === 0) { this.post({ type: "system", text: "没有可用模型（请确认 pi 已鉴权、models.json 已配置）。" }); return; }
        const choice = await this.prompt("pickModel", { models });
        if (!choice || choice.cancelled) return;
        const setResp = await this.request({ type: "set_model", provider: choice.provider, modelId: choice.modelId });
        if (setResp?.success === false) {
            this.post({ type: "systemError", text: `切换模型失败: ${setResp.error}` });
        } else {
            const m = setResp?.data ?? { id: choice.modelId, provider: choice.provider };
            this.post({ type: "modelChanged", modelId: m.id, provider: m.provider });
            this.post({ type: "system", text: `已切换模型: ${m.id}` });
            const cfg = this.host.getConfig();
            cfg.provider = m.provider || "";
            cfg.model = m.id || "";
            this.host.saveConfig();
        }
    }

    private async sendCurrentModel(): Promise<void> {
        const resp = await this.request({ type: "get_state" });
        const model = resp?.data?.model;
        if (model && model.id) this.post({ type: "modelChanged", modelId: model.id, provider: model.provider });
    }

    private sendProjectFiles(): void {
        const now = Date.now();
        if (this.fileCache.cwd !== this.cwd || now - this.fileCache.ts > 30000) {
            this.fileCache = { cwd: this.cwd, ts: now, files: this.scanProject(this.cwd) };
        }
        this.post({ type: "openFiles", files: this.fileCache.files });
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
                if (e.isDirectory()) { if (SKIP.has(e.name) || e.name.startsWith(".")) continue; walk(path.join(dir, e.name)); }
                else if (e.isFile()) {
                    const full = path.join(dir, e.name);
                    let rel = full.replace(/\\/g, "/");
                    if (rel.toLowerCase().startsWith(normRoot.toLowerCase() + "/")) rel = rel.slice(normRoot.length + 1);
                    out.push({ label: rel, path: full });
                }
            }
        };
        walk(root);
        return out;
    }

    private onPiEvent(evt: any): void {
        switch (evt.type) {
            case "agent_start": this.streaming = true; this.post({ type: "streamStart" }); break;
            case "message_update": {
                const a = evt.assistantMessageEvent;
                if (!a) break;
                if (a.type === "text_delta") this.post({ type: "assistantDelta", delta: a.delta });
                else if (a.type === "thinking_delta") this.post({ type: "thinkingDelta", delta: a.delta });
                break;
            }
            case "tool_execution_start": this.trackEditStart(evt); this.onToolStart(evt); break;
            case "tool_execution_end": this.trackEditEnd(evt); this.onToolEnd(evt); break;
            case "agent_settled":
            case "agent_end": this.streaming = false; this.post({ type: "streamEnd" }); this.refreshStats(); break;
        }
    }

    private onToolStart(evt: any): void {
        const toolName: string = evt.toolName;
        const isEditLike = toolName === "edit" || toolName === "write";
        const p = isEditLike ? this.editToolPath(toolName, evt.args) : null;
        if (p && evt.toolCallId) {
            this.post({ type: "editCardStart", toolCallId: evt.toolCallId, toolName, path: p, label: this.relativeTo(this.cwd, p) });
        } else {
            this.post({ type: "tool", toolCallId: evt.toolCallId, toolName, args: evt.args });
        }
    }

    private onToolEnd(evt: any): void {
        const toolName: string = evt.toolName;
        if (toolName !== "edit" && toolName !== "write") {
            if (evt.toolCallId) this.post({ type: "toolResult", toolCallId: evt.toolCallId, isError: !!evt.isError });
            return;
        }
        if (!evt.toolCallId) return;
        const details = !evt.isError ? evt.result?.details : undefined;
        const errorText = evt.isError ? this.extractErrorText(evt.result) : undefined;
        this.post({ type: "editCardResult", toolCallId: evt.toolCallId, diff: typeof details?.diff === "string" ? details.diff : undefined, isError: !!evt.isError, errorText, canRevert: !evt.isError && this.editSnapshots.has(evt.toolCallId) });
    }

    private extractErrorText(result: any): string | undefined {
        if (!result) return undefined;
        const content = result.content;
        if (Array.isArray(content)) { for (const c of content) { if (c && c.type === "text" && typeof c.text === "string") return c.text; } }
        try { return JSON.stringify(result); } catch { return undefined; }
    }

    private resetFileChanges(): void { this.fileChanges.clear(); this.pendingEdits.clear(); this.editSnapshots.clear(); this.postFileChanges(); }
    private postFileChanges(): void {
        const files = Array.from(this.fileChanges.values()).map((c) => ({ path: c.path, label: c.label }));
        this.post({ type: "fileChanges", files });
    }

    private async revertEdit(toolCallId: string): Promise<void> {
        const snap = this.editSnapshots.get(toolCallId);
        if (!snap) { this.post({ type: "systemError", text: "无法回滚：缺失修改前的快照。" }); return; }
        const label = this.relativeTo(this.cwd, snap.path);
        let current = "";
        try { current = fs.readFileSync(snap.path, "utf8"); } catch { current = ""; }
        if (current === snap.before) {
            this.post({ type: "system", text: `无需回滚：${label} 已是修改前的内容。` });
            this.post({ type: "editReverted", toolCallId });
            return;
        }
        if (current !== snap.after) {
            const ok = await this.prompt("confirm", { title: "确认回滚", message: `${label} 在此次修改后又被变更过，回滚将丢弃那些后续变更。确定继续？` });
            if (!ok || !ok.confirmed) return;
        }
        try { fs.writeFileSync(snap.path, snap.before, "utf8"); }
        catch (e: any) { this.post({ type: "systemError", text: `回滚失败: ${e.message}` }); return; }
        const existing = this.fileChanges.get(snap.path);
        if (existing) {
            let latest = "";
            try { latest = fs.readFileSync(snap.path, "utf8"); } catch { latest = ""; }
            if (latest === existing.before) this.fileChanges.delete(snap.path);
            this.postFileChanges();
        }
        this.editSnapshots.delete(toolCallId);
        this.post({ type: "editReverted", toolCallId });
        this.post({ type: "system", text: `已回滚: ${label}` });
    }

    private historyEditInfo(call: any, result: any): string | undefined {
        const details = result?.details;
        let diff: string | undefined = typeof details?.diff === "string" ? details.diff : undefined;
        if (!diff) {
            const args = call?.arguments ?? {};
            if (call?.name === "edit") {
                const oldText = typeof args.old_text === "string" ? args.old_text : typeof args.oldText === "string" ? args.oldText : "";
                const newText = typeof args.new_text === "string" ? args.new_text : typeof args.newText === "string" ? args.newText : "";
                if (oldText || newText) {
                    const del = oldText ? oldText.split("\n").map((l: string) => "-" + l) : [];
                    const add = newText ? newText.split("\n").map((l: string) => "+" + l) : [];
                    diff = del.concat(add).join("\n");
                }
            } else if (call?.name === "write") {
                const content = typeof args.content === "string" ? args.content : typeof args.text === "string" ? args.text : "";
                if (content) diff = content.split("\n").map((l: string) => "+" + l).join("\n");
            }
        }
        return diff;
    }

    private editToolPath(toolName: string, args: any): string | null {
        if (toolName !== "edit" && toolName !== "write") return null;
        const raw = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : null;
        if (!raw) return null;
        return this.resolvePath(raw);
    }

    private resolvePath(p: string): string { return path.isAbsolute(p) ? p : path.resolve(this.cwd, p); }

    private trackEditStart(evt: any): void {
        const p = this.editToolPath(evt.toolName, evt.args);
        if (!p || !evt.toolCallId) return;
        let before = "";
        try { before = fs.readFileSync(p, "utf8"); } catch { before = ""; }
        this.pendingEdits.set(evt.toolCallId, { path: p, before });
    }

    private trackEditEnd(evt: any): void {
        const id = evt.toolCallId;
        if (!id) return;
        const pend = this.pendingEdits.get(id);
        this.pendingEdits.delete(id);
        if (!pend || evt.isError) return;
        let after = "";
        try { after = fs.readFileSync(pend.path, "utf8"); } catch { return; }
        if (after === pend.before) return;
        this.editSnapshots.set(id, { path: pend.path, before: pend.before, after });
        const existing = this.fileChanges.get(pend.path);
        if (!existing) this.fileChanges.set(pend.path, { path: pend.path, label: this.relativeTo(this.cwd, pend.path), before: pend.before });
        this.postFileChanges();
    }

    private resolveAnchorLine(currentText: string, anchor: string, fallbackLine: number): number {
        if (!anchor) return fallbackLine;
        const lines = currentText.split("\n");
        const fb0 = Math.max(0, fallbackLine - 1);
        if (lines[fb0] === anchor) return fallbackLine;
        const WINDOW = 200;
        for (let d = 1; d <= WINDOW; d++) {
            const up = fb0 - d, down = fb0 + d;
            if (down < lines.length && lines[down] === anchor) return down + 1;
            if (up >= 0 && lines[up] === anchor) return up + 1;
        }
        for (let k = 0; k < lines.length; k++) if (lines[k] === anchor) return k + 1;
        return Math.min(fallbackLine, Math.max(lines.length, 1));
    }

    private async openEditLocationWithAnchor(filePath: string, line: number, anchor: string): Promise<void> {
        let current = "";
        try { current = fs.readFileSync(filePath, "utf8"); }
        catch { this.host.openFileViewer(filePath, line); return; }
        this.host.openFileViewer(filePath, this.resolveAnchorLine(current, anchor, line), anchor);
    }

    private async refreshStats(): Promise<void> {
        const resp = await this.request({ type: "get_session_stats" });
        const d = resp?.data;
        if (!d) return;
        this.post({ type: "stats", tokens: d.tokens || null, cost: typeof d.cost === "number" ? d.cost : null, contextUsage: d.contextUsage || null });
    }

    private onPiResponse(resp: any): void {
        if (resp.id && this.pending.has(resp.id)) {
            const cb = this.pending.get(resp.id)!;
            this.pending.delete(resp.id);
            cb(resp);
            return;
        }
        if (resp.success === false && resp.error) this.post({ type: "systemError", text: `pi: ${resp.error}` });
    }

    private onPiUiRequest(req: any): void {
        const respond = (payload: Record<string, unknown>) => {
            if (this.client && this.client.isRunning()) this.client.send({ type: "extension_ui_response", id: req.id, ...payload });
        };
        switch (req.method) {
            case "confirm":
                this.prompt("confirm", { title: req.title ?? "确认", message: req.message ?? "" })
                    .then((r) => respond({ confirmed: r?.confirmed === true }));
                break;
            case "select":
                this.prompt("select", { title: req.title, options: req.options ?? [] })
                    .then((r) => (r?.cancelled ? respond({ cancelled: true }) : respond({ value: r.value })));
                break;
            case "input":
            case "editor":
                this.prompt("input", { title: req.title, placeholder: req.placeholder, prefill: req.prefill })
                    .then((r) => (r?.cancelled ? respond({ cancelled: true }) : respond({ value: r.value })));
                break;
            case "notify":
                this.post({ type: "system", text: String(req.message ?? "") });
                break;
        }
    }

    private prompt(kind: string, data: any): Promise<any> {
        return new Promise((resolve) => {
            const id = `modal-${++this.modalSeq}`;
            this.modalCallbacks.set(id, resolve);
            this.post({ type: "modal", id, kind, data });
            setTimeout(() => { if (this.modalCallbacks.has(id)) { this.modalCallbacks.delete(id); resolve(undefined); } }, 300000);
        });
    }

    private handleModalReply(msg: any): void {
        const cb = this.modalCallbacks.get(msg.id);
        if (cb) { this.modalCallbacks.delete(msg.id); cb(msg.payload ?? {}); }
    }

    private relativeTo(cwd: string, full: string): string {
        const norm = (s: string) => s.replace(/\\/g, "/");
        const c = norm(cwd).replace(/\/$/, "") + "/";
        const f = norm(full);
        if (f.toLowerCase().startsWith(c.toLowerCase())) return f.slice(c.length);
        return full;
    }

    private post(msg: Record<string, unknown>): void { this.host.post(msg); }
}

export function initSharedRoot(rendererDir: string): void {
    setExtensionRoot(rendererDir);
}

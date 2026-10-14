import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { dirInsideAny, relativeTo } from "./pathRules";

/**
 * VscodeScreen —— 这个 VS Code 窗口替独立后端干的那几样活。
 *
 * 会话跑在后端里，只有编辑器才干得了的事（把文件开在编辑器里、在语言服务里找符号、
 * 报"编辑器里开着哪些文件"）得由某个窗口来干。窗口连上后端时登记自己打开着哪些文件夹，
 * 后端按"这个会话在哪个目录"挑一个窗口派活（挑法见 screenRegistry）。
 *
 * 这里只管干活和算东西，不管连不连得上（那是 backendClient 的事）：
 *   - 打开文件：会话目录 + 它读写过的文件清单，都是从后端那条消息里带来的；
 *   - 符号表：后端把"这个工作区改动过哪些文件"报过来，这里问语言服务要符号名再报回去，
 *     界面拿这份名字把正文里的符号画成可点的链接；点符号时——插件里的对话面板点在编辑器里开，
 *     浏览器页面那边只把算出来的文件与行报回去（页面自己开进文件侧边栏，那边没有编辑器可开）；
 *   - 列编辑器里打开着的文件：给界面上的 # 引用列表用。
 */
export interface ScreenHooks {
    log(text: string): void;
    /** 把算出来的符号名报给后端（后端汇总所有窗口的，再转给界面）。 */
    reportSymbols(names: string[]): void;
    /** 往界面发消息（现在只有"未找到文件"这类提示之外的少量场景用得上）。 */
    post(msg: Record<string, unknown>): void;
}

/** 只有编辑器干得了的活（后端派来的那几种 kind）。 */
export interface ScreenRequest {
    kind: "openFile" | "openFileAt" | "openSymbol" | "findSymbol" | "listFiles";
    cwd?: string;
    path?: string;
    line?: number;
    col?: number;
    name?: string;
    knownFiles?: string[];
}

export class VscodeScreen {
    /** 后端报来的"这个工作区改动过哪些文件"（算符号表用）。 */
    private sessionFiles: string[] = [];
    private symbolTreeCache = new Map<string, { version: number; symbols: vscode.DocumentSymbol[] }>();
    private symbolTimer?: ReturnType<typeof setTimeout>;
    private lastReported = "";

    constructor(private readonly hooks: ScreenHooks) {
        // 编辑器里打开 / 关闭 / 保存文件都可能让符号表变样：合并成一次重算
        vscode.workspace.onDidOpenTextDocument(() => this.scheduleSymbols());
        vscode.workspace.onDidCloseTextDocument((d) => {
            this.symbolTreeCache.delete(d.uri.fsPath);
            this.scheduleSymbols();
        });
        vscode.workspace.onDidSaveTextDocument((d) => {
            this.symbolTreeCache.delete(d.uri.fsPath);
            this.scheduleSymbols();
        });
    }

    /** 这个窗口打开着的文件夹（空数组 = 空窗口：什么活都不接）。 */
    public folders(): string[] {
        const folders = vscode.workspace.workspaceFolders;
        return folders ? folders.map((f) => f.uri.fsPath) : [];
    }

    /** 默认目录（空窗口时给一个能解相对路径的东西）。 */
    public defaultCwd(): string {
        return this.folders()[0] ?? process.cwd();
    }

    /**
     * 这个窗口管不管这个目录。
     * 用户定的规矩：只有打开着这个目录（或它的上级）的窗口才去开文件，
     * 免得把文件开在别的工程里。后端挑人时已经按这条挑过，这里再挡一道。
     */
    public handles(dir: string): boolean {
        return dirInsideAny(dir, this.folders());
    }

    /** 后端报来的文件清单变了：重算符号表（它按文件内容算，本地再判断有没有变）。 */
    public setSessionFiles(files: string[]): void {
        this.sessionFiles = files;
        this.scheduleSymbols();
    }

    /** 后端派来的活：干完（要回话的）把话回给后端。 */
    public handle(req: ScreenRequest, reply: (msg: unknown) => void): void {
        switch (req.kind) {
            case "openFile":
                void this.openFile(req.path ?? "", req.line, req.col, req.cwd, req.knownFiles ?? []);
                return;
            case "openFileAt":
                void this.openFileAtLine(req.path ?? "", req.line ?? 1);
                return;
            case "openSymbol":
                void this.openSymbol(req.name ?? "", req.cwd, req.knownFiles ?? []);
                return;
            case "findSymbol":
                // 浏览器页面点的符号链接：只把文件与行报回去（那边开进文件侧边栏），不在编辑器里开。
                void this.findSymbol(req.name ?? "", req.knownFiles ?? [], reply);
                return;
            case "listFiles":
                reply({ type: "files", files: this.getOpenFiles(req.cwd) });
                return;
            default:
                this.hooks.log(`后端派来一件不认识的活：${JSON.stringify(req)}`);
        }
    }

    // ========================================================================
    //  打开文件
    // ========================================================================

    /** 在编辑器里打开一个绝对路径（带行号）。 */
    public async openFileAtLine(p: string, line: number): Promise<void> {
        try {
            const line0 = Math.max(0, Math.floor(line) - 1);
            await vscode.window.showTextDocument(vscode.Uri.file(p), {
                selection: new vscode.Range(line0, 0, line0, 0),
            });
        } catch (e: any) {
            vscode.window.showErrorMessage(`无法打开文件: ${e.message}`);
        }
    }

    /**
     * 打开正文里点的那个文件路径。
     * 路径可能是相对的（相对会话目录），还可能只写了一部分（"src/a.ts"、"a.ts"）：
     * 按 会话目录 → 会话读写过的文件 → 工作区里按文件名找 三档试。
     */
    public async openFile(p: string, line?: number, col?: number, cwd?: string, knownFiles?: string[]): Promise<void> {
        const dir = cwd || this.defaultCwd();
        if (!this.handles(dir)) {
            this.hooks.log(`这个窗口没打开 ${dir}，${p} 不开（免得开在别的工程里）。`);
            return;
        }
        const selection = (): vscode.TextDocumentShowOptions => {
            if (line == null) { return {}; }
            const line0 = Math.max(0, Math.floor(line) - 1);
            const col0 = col != null ? Math.max(0, Math.floor(col) - 1) : 0;
            return { selection: new vscode.Range(line0, col0, line0, col0) };
        };
        const open = async (uri: vscode.Uri): Promise<void> => {
            try { await vscode.window.showTextDocument(uri, selection()); }
            catch (e: any) { vscode.window.showErrorMessage(`无法打开文件: ${e.message}`); }
        };
        const full = path.isAbsolute(p) ? p : path.resolve(dir, p);
        if (fs.existsSync(full) && !fs.statSync(full).isDirectory()) {
            await open(vscode.Uri.file(full));
            return;
        }
        // 优先在会话读写过的文件里匹配（大仓库里全量按文件名找太贵）
        const known = knownFiles ?? [];
        if (known.length > 0) {
            const hit = this.matchKnownFile(known, p, dir);
            if (hit) {
                await open(vscode.Uri.file(hit));
                return;
            }
        }
        const base = path.basename(p);
        if (base) {
            const escapeGlob = (s: string) => s.replace(/[?*\\\[\]{}]/g, "?");
            try {
                const found = await vscode.workspace.findFiles(
                    `**/${escapeGlob(base)}`,
                    "{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.next/**,**/__pycache__/**,**/.venv/**,**/venv/**}",
                    20
                );
                const files = found.filter((u) => { try { return !fs.statSync(u.fsPath).isDirectory(); } catch { return false; } });
                if (files.length > 0) {
                    const target = files.find((u) => u.fsPath.replace(/\\/g, "/").includes(p.replace(/\\/g, "/"))) || files[0];
                    await open(target);
                    return;
                }
            } catch { /* 找不了就算了，下面统一提示 */ }
        }
        vscode.window.showInformationMessage(`piChat: 未找到文件 ${p}`);
        this.hooks.log(`没找到 ${p}（会话目录 ${dir}）`);
    }

    /** 在会话读写过的文件里匹配路径（相对 / 绝对 / 只写文件名 / 路径后缀）。 */
    private matchKnownFile(known: string[], query: string, cwd: string): string | undefined {
        const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
        const q = norm(query);
        const relOf = (f: string) => relativeTo(cwd, f);
        const exact = known.find((f) => relOf(f) === q || norm(f) === q);
        if (exact) { return exact; }
        const base = q.split("/").pop() || q;
        const cands = known.filter((f) => {
            const r = relOf(f);
            return r === base || r.endsWith("/" + base);
        });
        if (cands.length > 0) {
            return cands.find((f) => relOf(f).includes(q)) || cands[0];
        }
        return undefined;
    }

    // ========================================================================
    //  符号：编辑器有语言服务，后端那一屏没有
    // ========================================================================

    /** 合并 open/close/save 事件，防抖重算。 */
    private scheduleSymbols(): void {
        if (this.symbolTimer) { return; }
        this.symbolTimer = setTimeout(() => {
            this.symbolTimer = undefined;
            void this.reportSymbols();
        }, 200);
    }

    /** 取某文件的符号树（带版本缓存：打开着的文档用编辑器版本，否则用文件修改时间）。 */
    private async loadSymbolTree(p: string): Promise<vscode.DocumentSymbol[]> {
        const cached = this.symbolTreeCache.get(p);
        const version = this.fileSymbolVersion(p);
        if (cached && cached.version === version) { return cached.symbols; }
        let symbols: vscode.DocumentSymbol[] = [];
        try {
            const r = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                "vscode.executeDocumentSymbolProvider", vscode.Uri.file(p));
            if (Array.isArray(r)) { symbols = r; }
        } catch { /* 该文件没语言服务或解析失败 */ }
        this.symbolTreeCache.set(p, { version, symbols });
        return symbols;
    }

    private fileSymbolVersion(p: string): number {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === p);
        if (open) { return open.version; }
        try { return fs.statSync(p).mtimeMs; } catch { return 0; }
    }

    private collectSymbols(syms: vscode.DocumentSymbol[], parents: string[], out: Set<string>): void {
        for (const s of syms) {
            out.add(s.name);
            if (parents.length > 0) { out.add(parents.join(".") + "." + s.name); }
            if (s.children && s.children.length > 0) {
                this.collectSymbols(s.children, [...parents, s.name], out);
            }
        }
    }

    /** 算一遍符号名（这个窗口读写过的文件全算上）并报给后端；跟上次一样就不报。 */
    private async reportSymbols(): Promise<void> {
        const names = new Set<string>();
        await Promise.all(this.sessionFiles.map(async (p) => {
            const syms = await this.loadSymbolTree(p);
            this.collectSymbols(syms, [], names);
        }));
        const list = Array.from(names);
        const key = list.join("\u0000");
        if (key === this.lastReported) { return; }
        this.lastReported = key;
        this.hooks.reportSymbols(list);
    }

    /** 点正文里的符号（插件里的对话面板）：找到就在编辑器里打开那一行。 */
    public async openSymbol(name: string, _cwd?: string, knownFiles?: string[]): Promise<void> {
        const hit = await this.locateSymbol(name, knownFiles);
        if (hit) {
            await this.openFileAtLine(hit.path, hit.line);
            return;
        }
        vscode.window.showInformationMessage(`piChat: 未找到符号 ${name}`);
    }

    /**
     * 浏览器页面点的符号（那边没有编辑器）：把算出来的文件与行报回去，由页面开进文件侧边栏；
     * 这个窗口不开编辑器。找不到也回一声（后端记一行日志），不往编辑器里弹框（人可能不在那儿）。
     */
    public async findSymbol(name: string, knownFiles: string[], report: (msg: unknown) => void): Promise<void> {
        const hit = await this.locateSymbol(name, knownFiles);
        if (!hit) { report({ type: "failed", note: `没找到符号 ${name}。` }); return; }
        report({ type: "symbolLocation", path: hit.path, line: hit.line });
    }

    /**
     * 一个符号在哪个文件的哪一行（行号 1 起）：先在会话读写过的文件里找，再在所有打开着的文档里找。
     * @returns 绝对路径 + 行号；哪儿都没有就是 undefined
     */
    private async locateSymbol(name: string, knownFiles?: string[]): Promise<{ path: string; line: number } | undefined> {
        const parts = name.split(".");
        const tail = parts.pop()!;
        for (const p of knownFiles && knownFiles.length > 0 ? knownFiles : this.sessionFiles) {
            const hit = await this.findSymbolIn(p, parts, tail);
            if (hit) { return { path: p, line: hit.selectionRange.start.line + 1 }; }
        }
        for (const d of vscode.workspace.textDocuments) {
            if (d.uri.scheme !== "file") { continue; }
            const hit = await this.findSymbolIn(d.uri.fsPath, parts, tail);
            if (hit) { return { path: d.uri.fsPath, line: hit.selectionRange.start.line + 1 }; }
        }
        return undefined;
    }

    /** 在某文件的符号树上按限定名逐级查找（Foo.method → 找 Foo，再在它的 children 里找 method）。 */
    private async findSymbolIn(
        p: string, parts: string[], tail: string
    ): Promise<vscode.DocumentSymbol | undefined> {
        const syms = await this.loadSymbolTree(p);
        if (parts.length === 0) {
            return this.dfsFindSymbol(syms, tail);
        }
        let level: vscode.DocumentSymbol[] | undefined = syms;
        for (const part of parts) {
            const next: vscode.DocumentSymbol | undefined = level?.find((s) => s.name === part);
            level = next?.children;
            if (!next) { level = undefined; break; }
        }
        return level?.find((s) => s.name === tail);
    }

    /** 裸名（无点）时递归搜整棵树：顶层是类，方法 / 属性嵌在类的 children 里。 */
    private dfsFindSymbol(syms: vscode.DocumentSymbol[], name: string): vscode.DocumentSymbol | undefined {
        for (const s of syms) {
            if (s.name === name) { return s; }
            if (s.children && s.children.length > 0) {
                const hit = this.dfsFindSymbol(s.children, name);
                if (hit) { return hit; }
            }
        }
        return undefined;
    }

    // ========================================================================
    //  编辑器里打开着的文件（界面上的 # 引用列表）
    // ========================================================================

    /** 当前编辑器里打开着的文件清单（标签页 + 活动编辑器），按会话目录写相对路径。 */
    public getOpenFiles(cwd?: string): Array<{ label: string; path: string }> {
        const dir = cwd || this.defaultCwd();
        const files: Array<{ label: string; path: string }> = [];
        const seen = new Set<string>();
        const add = (uri: vscode.Uri) => {
            if (uri.scheme !== "file" || seen.has(uri.fsPath)) { return; }
            seen.add(uri.fsPath);
            files.push({ label: relativeTo(dir, uri.fsPath), path: uri.fsPath });
        };
        if (vscode.window.activeTextEditor) { add(vscode.window.activeTextEditor.document.uri); }
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input: any = tab.input;
                if (input?.uri instanceof vscode.Uri) { add(input.uri); }
            }
        }
        return files;
    }
}

import * as vscode from "vscode";
import { fetchChatUiFiles, getChatHtml } from "./chatHtml";
import { relativeTo } from "./pathRules";
import { BackendClient, type BackendState } from "./backendClient";
import { VscodeScreen } from "./vscodeScreen";

/**
 * VSCode 插件在编辑器里的那份"屏"。
 *
 * 第二步之后会话不再跑在插件进程里：会话、网页服务、项目 / 会话面板都在独立后端（pichat）里，
 * 插件这边只剩两件事：
 *   1. **一屏界面**：插件里那块对话面板装的是同一份界面代码，消息由 {@link BackendClient} 转给后端，
 *      后端推的消息再转回来。界面代码完全不用改（它以为还在跟插件进程说话）；
 *   2. **一双能打开文件的手**：后端派来的"打开这个文件 / 找这个符号 / 报编辑器里开了哪些文件"
 *      由 {@link VscodeScreen} 这个窗口干（只干它自己打开着的那个目录的活）。
 *
 * 后端没在跑的时候：这块屏显示一句提示（连上后自己会换成对话界面）。
 * 后端在跑但中途断了：界面原样冻着，状态栏会说一句，后端回来自己接上（整屏重画）。
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "piChat.chatView";

    private view?: vscode.WebviewView;
    /** 网页视图的 JS 是否已加载完成并建立消息监听（收到 ready 后为 true）。 */
    private webviewReady = false;
    /** 网页视图里现在装的是对话界面（false = 装的是"后端没在跑"那块屏）。 */
    private showingChat = false;
    private state: BackendState = "offline";
    private note = "";
    /** 装界面的代数：异步抓界面文件期间面板被换掉 / 后端状态又变了时，旧结果直接丢掉。 */
    private renderSeq = 0;
    /** 界面文件没抓到时的重试定时器（后端在跑但文件一时取不到，隔一会儿再试）。 */
    private chatRetryTimer?: ReturnType<typeof setTimeout>;
    /** 面板此刻装着的那块失败提示（同一句就不重装，免得提示屏隔几秒闪一下）。 */
    private lastFailNote = "";
    private readonly screen: VscodeScreen;
    private readonly client: BackendClient;
    private readonly log: (text: string) => void;

    constructor(
        private readonly context: vscode.ExtensionContext,
        output: vscode.OutputChannel,
        hooks?: { onStatus?: (state: BackendState, note: string, url?: string) => void },
    ) {
        this.log = (text) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${text}`);
        this.screen = new VscodeScreen({
            log: this.log,
            reportSymbols: (names) => this.client.reportSymbols(names),
            post: (msg) => this.postToWebview(msg),
        });
        this.client = new BackendClient({
            folders: () => this.screen.folders(),
            onPageEvent: (msg) => this.postToWebview(msg),
            onScreenRequest: (req) => this.screen.handle(req, (msg) => { void this.client.postScreen(msg); }),
            onSessionFiles: (files) => this.screen.setSessionFiles(files),
            onStatus: (state, note) => this.onBackendStatus(state, note, hooks?.onStatus),
            log: this.log,
        });
        context.subscriptions.push(
            // 窗口切到前台：同一个目录开着好几个窗口时，活派给最近在用的那个
            vscode.window.onDidChangeWindowState((e) => { if (e.focused) { this.client.markActive(); } }),
            { dispose: () => this.client.stop() },
            { dispose: () => this.clearChatRetry() },
        );
        this.client.start();
    }

    /** 后端现在的地址（状态栏 / "在浏览器里打开"用）。 */
    public get backendUrl(): string | undefined {
        return this.client.url;
    }

    // ========================================================================
    //  网页视图（本机这屏界面）
    // ========================================================================

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        // 界面文件不再从本地装（从后端现取，见 chatHtml.ts），
        // 所以不用 localResourceRoots，只开脚本。
        webviewView.webview.options = { enableScripts: true };
        this.webviewReady = false;
        this.showingChat = false;
        this.renderScreen();

        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === "ready") { this.webviewReady = true; }
            // 界面发来的一切消息都原样转给后端（它才是管会话的那个）
            this.client.sendPage(msg);
        });

        webviewView.onDidDispose(() => {
            // 只是这块屏没了：会话在后端跑着，不受影响；网页视图回来时整屏重画一遍
            this.view = undefined;
            this.webviewReady = false;
            this.showingChat = false;
            this.renderSeq += 1;
            this.clearChatRetry();
        });
    }

    /** 网页视图该装哪一屏：后端连着装对话界面（界面文件从后端现取），没连着装提示屏。 */
    private renderScreen(): void {
        const view = this.view;
        if (!view) { return; }
        if (this.state === "online") {
            if (this.showingChat) { return; }
            void this.renderChatScreen(view);
            return;
        }
        // 没连上（或正在连）：提示屏。正在跑的抓取作废，重试也停掉
        const showingFail = this.lastFailNote !== "";
        this.renderSeq += 1;
        this.clearChatRetry();
        this.lastFailNote = "";
        // 已经装着提示屏（不管是哪句）就不重装，免得状态反反复复时提示屏闪个不停
        if (!this.showingChat && !showingFail) { return; }
        view.webview.html = offlineHtml(this.note);
        this.showingChat = false;
        this.webviewReady = false;
    }

    /** 从后端抓界面文件、拼成 HTML 装进网页视图。抓取是异步的：过期结果直接丢掉。 */
    private async renderChatScreen(view: vscode.WebviewView): Promise<void> {
        this.clearChatRetry();
        const seq = ++this.renderSeq;
        const baseUrl = this.client.url;
        const files = baseUrl ? await fetchChatUiFiles(baseUrl) : undefined;
        if (seq !== this.renderSeq || this.view !== view) { return; }
        if (!files) {
            // 后端在跑但文件没取到（多半正在重启）：退回提示屏，隔几秒自动再试
            const note = "后端连上了，但界面文件没取到（可能正在重启）。会自动再试。";
            this.log(note);
            if (this.lastFailNote !== note) {
                this.lastFailNote = note;
                view.webview.html = offlineHtml(note);
                this.webviewReady = false;
            }
            this.showingChat = false;
            this.chatRetryTimer = setTimeout(() => {
                this.chatRetryTimer = undefined;
                if (this.state === "online" && this.view === view && !this.showingChat) {
                    void this.renderChatScreen(view);
                }
            }, CHAT_RETRY_MS);
            return;
        }
        try {
            view.webview.html = getChatHtml(files, {
                themeMode: this.vsCodeTheme(),
                imgCspSource: view.webview.cspSource,
            });
        } catch (err: any) {
            // 界面文件里有内联不安全的序列（chatHtml.ts 的检查报出来的）：
            // 重试也没用，把话撂在提示屏上，等后端换个版本（状态变化会再触发）。
            const note = err?.message ?? String(err);
            this.log(`装界面失败：${note}`);
            this.lastFailNote = note;
            view.webview.html = offlineHtml(note);
            this.showingChat = false;
            this.webviewReady = false;
            return;
        }
        this.lastFailNote = "";
        this.showingChat = true;
        this.webviewReady = false;
    }

    private clearChatRetry(): void {
        if (this.chatRetryTimer) { clearTimeout(this.chatRetryTimer); this.chatRetryTimer = undefined; }
    }

    /** 装"后端没在跑"那块屏时要个初始颜色：跟着 VSCode 自己的主题走。 */
    private vsCodeTheme(): "light" | "dark" {
        return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? "light" : "dark";
    }

    private postToWebview(msg: Record<string, unknown>): void {
        if (this.view) { void this.view.webview.postMessage(msg); }
    }

    /** 等网页视图就绪（消息监听已建立）。超时后继续，避免卡住命令。 */
    private async waitLocalReady(timeoutMs = 10000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!this.webviewReady) {
            if (Date.now() > deadline) { return; }
            await new Promise((r) => setTimeout(r, 50));
        }
    }

    /** 后端连接状态变了：换屏或提示（连上 / 掉了）。 */
    private onBackendStatus(state: BackendState, note: string | undefined, onStatus?: (state: BackendState, note: string, url?: string) => void): void {
        const wasOffline = this.state !== "online";
        const text = note ?? "";
        this.state = state;
        this.note = text;
        this.renderScreen();
        if (state === "online" && wasOffline) {
            this.log(`后端连上了：${this.client.url ?? ""}`);
        } else if (state === "offline" && !wasOffline) {
            this.log(`后端断了：${text || "（原因不明）"}`);
        }
        onStatus?.(state, text, this.client.url);
    }

    // ========================================================================
    //  命令入口（命令面板 / 快捷键 / 状态栏）
    // ========================================================================

    /** 打开插件里的对话面板、等界面就绪（消息发早了界面还没建立监听）。 */
    private async reveal(): Promise<void> {
        await vscode.commands.executeCommand("piChat.openChat");
        await this.waitLocalReady();
    }

    /** 全局"新建会话"：打开插件里的对话面板并新建一个会话。 */
    public async newSessionAtLastActive(): Promise<void> {
        await this.reveal();
        this.client.sendPage({ type: "newSession" });
    }

    /** 命令面板 / 快捷键入口：打开插件里的对话面板并弹出历史会话列表（与顶栏那颗按钮同一份）。 */
    public async pickSession(): Promise<void> {
        await this.reveal();
        this.client.sendPage({ type: "openHistory" });
    }

    /** 点击状态栏模型项触发：弹出模型选择器（弹在当前这块屏上）。 */
    public async pickModel(): Promise<void> {
        await this.reveal();
        this.client.sendPage({ type: "pickModel" });
    }

    public async focusInput(): Promise<void> {
        await this.reveal();
        this.postToWebview({ type: "focusInput" });
    }

    public async openSettings(): Promise<void> {
        await this.reveal();
        this.postToWebview({ type: "openSettings" });
    }

    public async pickViewOptions(): Promise<void> {
        await this.reveal();
        this.postToWebview({ type: "openSettings" });
    }

    /** 选中代码发送：把编辑器里的选区拼成一段话，交给界面发出去。 */
    public async askSelectionAndSend(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Pi Chat: 没有活动的编辑器。");
            return;
        }
        const document = editor.document;
        const selection = editor.selection;
        const selectedText = document.getText(selection);
        const hasSelection = !selection.isEmpty && selectedText.trim() !== "";
        const codeText = hasSelection
            ? selectedText
            : document.lineAt(selection.active.line).text;
        const fileRef = relativeTo(this.screen.defaultCwd(), document.uri.fsPath);
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const range = startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}-${endLine} 行`;

        const userText = await vscode.window.showInputBox({
            title: "向 Pi Chat 发送选中文本",
            prompt: "你的消息将连同选中的代码一起发送到 Pi Chat 对话框。",
            placeHolder: "例如：解释这段代码、修复 bug、补充测试…（可留空直接发送选中文本）",
            ignoreFocusOut: true,
        });
        if (userText === undefined) { return; }
        if (userText.trim() === "" && !hasSelection) {
            vscode.window.showWarningMessage("Pi Chat: 没有选中文本且消息为空。");
            return;
        }

        const prefix = userText.trim() ? `${userText.trim()}\n\n` : "";
        const prompt = `${prefix}上下文: ${fileRef} (${range})\n\n\`\`\`${document.languageId}\n${codeText}\n\`\`\`\n`;

        await this.reveal();
        // 让界面按它自己那套发（会话没就绪就先留在输入框、就绪了自动补发）
        this.postToWebview({ type: "sendFromHost", text: prompt });
        vscode.window.showInformationMessage("已发送到 Pi Chat 对话框。");
    }
}

/** 界面文件没抓到时隔多久再试一次（后端重启的间隙一般就几秒）。 */
const CHAT_RETRY_MS = 3000;

/** "后端没在跑"那块屏：一句话 + 该敲的命令；后端一连上自己会换成对话界面，所以不用按钮。 */
function offlineHtml(note: string): string {
    const nonce = String(Math.random()).slice(2);
    const text = note || "没找到在跑的后端。";
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 18px; font-size: 13px; line-height: 1.7; }
  h2 { font-size: 14px; margin: 0 0 10px; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
  .hint { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h2>Pi Chat 后端没在跑</h2>
  <p>${escapeHtml(text)}</p>
  <p>在终端里敲一次 <code>pichat</code> 起来（它要一直开着）：会话、网页服务、手机那边看到的界面都在它里面。</p>
  <p class="hint">它一起来，这块屏自己会变成对话界面，不用重开 VSCode。</p>
</body>
</html>`;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

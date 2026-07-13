import * as vscode from "vscode";
import {
    listHooks,
    readHook,
    writeHook,
    deleteHook,
    confirmDeleteHookTemplate,
    loadRulesHookTemplate,
    extensionsDir,
} from "./hooksManager";

/** 管理 pi hook（扩展）的 Webview 面板（单例）。 */
export class HooksPanel {
    private static current: HooksPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    public static show(extensionUri: vscode.Uri): void {
        const column = vscode.ViewColumn.Active;
        if (HooksPanel.current) {
            HooksPanel.current.panel.reveal(column);
            HooksPanel.current.sendList();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "piChatHooks",
            "Pi Hooks 管理",
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );
        HooksPanel.current = new HooksPanel(panel, extensionUri);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri
    ) {
        this.panel = panel;
        this.panel.webview.html = this.getHtml();
        this.panel.webview.onDidReceiveMessage(
            (msg) => this.onMessage(msg),
            null,
            this.disposables
        );
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private async onMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case "ready":
            case "refresh":
                this.sendList();
                break;
            case "open": {
                const hook = readHook(msg.name);
                if (hook) {
                    this.panel.webview.postMessage({
                        type: "openHook",
                        name: hook.name,
                        content: hook.content,
                    });
                }
                break;
            }
            case "save": {
                const result = writeHook(msg.name, msg.content);
                if (result.ok) {
                    this.panel.webview.postMessage({ type: "saved", name: msg.name });
                    vscode.window.showInformationMessage(
                        `已保存 hook: ${msg.name}（可在 pi 中 /reload 生效）`
                    );
                    this.sendList();
                } else {
                    this.panel.webview.postMessage({ type: "opError", error: result.error });
                }
                break;
            }
            case "delete": {
                const confirmed = await vscode.window.showWarningMessage(
                    `确定删除 hook「${msg.name}」吗？`,
                    { modal: true },
                    "删除"
                );
                if (confirmed !== "删除") {
                    return;
                }
                const result = deleteHook(msg.name);
                if (result.ok) {
                    vscode.window.showInformationMessage(`已删除 hook: ${msg.name}`);
                    this.sendList();
                } else {
                    this.panel.webview.postMessage({ type: "opError", error: result.error });
                }
                break;
            }
            case "newBlank":
                this.panel.webview.postMessage({
                    type: "openHook",
                    name: "",
                    content: blankTemplate(),
                });
                break;
            case "newConfirmDelete":
                this.panel.webview.postMessage({
                    type: "openHook",
                    name: "confirm-delete",
                    content: confirmDeleteHookTemplate(),
                });
                break;
            case "newLoadRules":
                this.panel.webview.postMessage({
                    type: "openHook",
                    name: "load-rules",
                    content: loadRulesHookTemplate(),
                });
                break;
        }
    }

    private sendList(): void {
        const hooks = listHooks().map((h) => ({
            name: h.name,
            description: h.description,
            managed: h.managed,
        }));
        this.panel.webview.postMessage({
            type: "list",
            hooks,
            dir: extensionsDir(),
        });
    }

    private getHtml(): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "media", "hooks.js")
        );
        const n = nonce();
        const csp =
            `default-src 'none'; ` +
            `style-src 'unsafe-inline'; ` +
            `script-src 'nonce-${n}';`;
        return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column; height: 100vh;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  #toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); }
  #dir { font-size: 0.75em; opacity: 0.6; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 0.9em;
  }
  button.secondary { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2)); color: var(--vscode-button-secondaryForeground, inherit); }
  button.danger { background: var(--vscode-inputValidation-errorBorder, #be1100); color: #fff; }
  button:hover { opacity: 0.9; }
  button:disabled { opacity: 0.5; cursor: default; }
  #body { flex: 1; display: flex; min-height: 0; }
  /* 左侧列表 */
  #listPane { width: 260px; min-width: 200px; overflow-y: auto; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); }
  .hook-item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15)); }
  .hook-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
  .hook-item.active { background: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,0.3)); color: var(--vscode-list-activeSelectionForeground, inherit); }
  .hook-item .name { font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .hook-item .badge { font-size: 0.65em; padding: 1px 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .hook-item .desc { font-size: 0.78em; opacity: 0.7; margin-top: 2px; }
  #empty { padding: 16px 12px; opacity: 0.6; font-size: 0.85em; }
  /* 右侧编辑 */
  #editPane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #editHeader { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); }
  #hookName {
    flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 4px 8px;
    font-family: inherit; font-size: 0.9em;
  }
  #hookName:disabled { opacity: 0.6; }
  #editor {
    flex: 1; width: 100%; box-sizing: border-box; resize: none; border: none; outline: none;
    padding: 12px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
    tab-size: 2;
  }
  #editPane.hidden { display: none; }
  #placeholder { flex: 1; display: flex; align-items: center; justify-content: center; opacity: 0.5; }
  #placeholder.hidden { display: none; }
  #status { padding: 6px 12px; font-size: 0.85em; min-height: 1.2em; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); }
  #status.ok { color: var(--vscode-testing-iconPassed, #4caf50); }
  #status.err { color: var(--vscode-errorForeground); }
  #status.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
</style>
</head>
<body>
  <div id="toolbar">
    <button id="newConfirmDeleteBtn">+ 删除确认 Hook</button>
    <button id="newLoadRulesBtn">+ 加载 Rules Hook</button>
    <button id="newBlankBtn" class="secondary">+ 空白 Hook</button>
    <button id="refreshBtn" class="secondary">刷新</button>
    <span id="dir"></span>
  </div>
  <div id="body">
    <div id="listPane"></div>
    <div id="editPane" class="hidden">
      <div id="editHeader">
        <input id="hookName" placeholder="hook 名称（字母/数字/-/_）" />
        <button id="saveBtn">保存</button>
        <button id="deleteBtn" class="danger">删除</button>
      </div>
      <textarea id="editor" spellcheck="false"></textarea>
    </div>
    <div id="placeholder">从左侧选择一个 hook，或新建一个。</div>
  </div>
  <div id="status"></div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    public dispose(): void {
        HooksPanel.current = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}

function blankTemplate(): string {
    return `// @pi-chat-hook
// desc: 我的自定义 hook
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // event.toolName, event.input
    // return { block: true, reason: "..." } 可阻止工具执行
  });
}
`;
}

function nonce(): string {
    let text = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

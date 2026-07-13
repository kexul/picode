import * as vscode from "vscode";
import { readModelsJson, writeModelsJson, defaultModelsJson } from "./modelsConfig";

/** 管理编辑 pi models.json 的 Webview 面板（单例）。 */
export class SettingsPanel {
    private static current: SettingsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    public static show(extensionUri: vscode.Uri): void {
        const column = vscode.ViewColumn.Active;
        if (SettingsPanel.current) {
            SettingsPanel.current.panel.reveal(column);
            SettingsPanel.current.load();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "piChatSettings",
            "Pi 设置 - models.json",
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );
        SettingsPanel.current = new SettingsPanel(panel, extensionUri);
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

    private onMessage(msg: any): void {
        switch (msg.type) {
            case "ready":
            case "reload":
                this.load();
                break;
            case "getDefault":
                this.panel.webview.postMessage({
                    type: "default",
                    content: defaultModelsJson(),
                });
                break;
            case "save": {
                const result = writeModelsJson(msg.content);
                if (result.ok) {
                    this.panel.webview.postMessage({ type: "saved" });
                    vscode.window.showInformationMessage("已保存 models.json");
                } else {
                    this.panel.webview.postMessage({
                        type: "saveError",
                        error: result.error,
                    });
                }
                break;
            }
        }
    }

    private load(): void {
        const { content, existed, path } = readModelsJson();
        this.panel.webview.postMessage({ type: "load", content, existed, path });
    }

    private getHtml(): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "media", "settings.js")
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
  #toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); }
  #path { font-size: 0.8em; opacity: 0.7; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer;
  }
  button.secondary { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2)); color: var(--vscode-button-secondaryForeground, inherit); }
  button:hover { opacity: 0.9; }
  button:disabled { opacity: 0.5; cursor: default; }
  #editor {
    flex: 1; width: 100%; box-sizing: border-box; resize: none; border: none; outline: none;
    padding: 12px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
    tab-size: 2;
  }
  #status { padding: 6px 12px; font-size: 0.85em; min-height: 1.2em; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); }
  #status.ok { color: var(--vscode-testing-iconPassed, #4caf50); }
  #status.err { color: var(--vscode-errorForeground); }
  #status.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
</style>
</head>
<body>
  <div id="toolbar">
    <button id="saveBtn">保存</button>
    <button id="formatBtn" class="secondary">格式化</button>
    <button id="resetBtn" class="secondary">恢复默认</button>
    <button id="reloadBtn" class="secondary">重新加载</button>
    <span id="path"></span>
  </div>
  <textarea id="editor" spellcheck="false" placeholder="加载中…"></textarea>
  <div id="status"></div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    public dispose(): void {
        SettingsPanel.current = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}

function nonce(): string {
    let text = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

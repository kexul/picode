import * as vscode from "vscode";
import { listSessions, SessionInfo } from "../../../src/shared/sessionStore";

/** 历史面板需要宿主（ChatViewProvider）提供的回调。 */
export interface HistoryHost {
    /** 当前已在 chat 面板加载的会话文件绝对路径（用于高亮当前项）。 */
    getCurrentSessionPath(): string | undefined;
    /** 加载指定会话到 chat 面板并聚焦。 */
    loadHistorySession(file: string): Promise<void>;
}

/**
 * 会话历史浏览面板：单栏卡片列表，WebviewPanel 形式。
 * 单例——已存在则 reveal 并刷新，避免重复打开与陈旧数据。
 */
export class HistoryPanel {
    private static current: HistoryPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private loading = false;

    public static async show(
        extensionUri: vscode.Uri,
        host: HistoryHost
    ): Promise<void> {
        if (HistoryPanel.current) {
            HistoryPanel.current.panel.reveal(vscode.ViewColumn.Active);
            await HistoryPanel.current.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "piChatHistory",
            "Pi Chat - 会话历史",
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );
        HistoryPanel.current = new HistoryPanel(panel, extensionUri, host);
        await HistoryPanel.current.refresh();
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly host: HistoryHost
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
                this.refresh();
                break;
            case "open": {
                const file = msg.file as string;
                if (!file) {
                    return;
                }
                this.host.loadHistorySession(file).then(() => {
                    // 加载完成后刷新高亮（当前会话已变化）
                    this.refresh();
                });
                break;
            }
        }
    }

    /** 重新读取当前工作区的会话列表并推送给 webview。 */
    private async refresh(): Promise<void> {
        if (this.loading) {
            return;
        }
        this.loading = true;
        const cwd = this.getCwd();
        const sessions = await listSessions(cwd);
        const current = this.host.getCurrentSessionPath();
        this.panel.webview.postMessage({
            type: "sessions",
            sessions,
            current,
        });
        this.loading = false;
    }

    private getCwd(): string {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders[0].uri.fsPath;
        }
        return process.cwd();
    }

    private dispose(): void {
        HistoryPanel.current = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }

    private getHtml(): string {
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
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  #wrap {
    max-width: 720px;
    margin: 0 auto;
    padding: 16px 20px 40px;
  }
  #head {
    font-size: 1.3em;
    font-weight: 600;
    margin: 4px 0 4px;
  }
  #sub {
    font-size: 0.8em;
    opacity: 0.6;
    margin-bottom: 16px;
  }
  .card {
    position: relative;
    padding: 12px 16px 12px 18px;
    margin-bottom: 10px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .card:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .card.current {
    border-color: var(--vscode-focusBorder, #007acc);
  }
  .card.current::before {
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: var(--vscode-focusBorder, #007acc);
    border-radius: 8px 0 0 8px;
  }
  .row1 { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
  .title {
    flex: 1;
    font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .time {
    font-size: 0.78em;
    opacity: 0.6;
    flex-shrink: 0;
  }
  .badge {
    font-size: 0.72em;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.3));
    color: var(--vscode-badge-foreground, inherit);
    flex-shrink: 0;
  }
  .msg {
    font-size: 0.9em;
    line-height: 1.45;
    margin: 3px 0;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .msg .tag {
    display: inline-block;
    font-size: 0.78em;
    opacity: 0.45;
    margin-right: 6px;
    flex-shrink: 0;
  }
  .msg .body {
    display: inline;
  }
  .msg.gap {
    opacity: 0.4;
    font-size: 0.8em;
    -webkit-line-clamp: 1;
    margin: 2px 0;
    text-align: center;
  }
  .empty {
    text-align: center;
    opacity: 0.5;
    padding: 60px 0;
  }
</style>
</head>
<body>
  <div id="wrap">
    <div id="head">会话历史</div>
    <div id="sub">点击卡片在对话窗口中打开该会话</div>
    <div id="list"><div class="empty">加载中…</div></div>
  </div>
  <script nonce="${n}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById("list");

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function relTime(mtime) {
      if (!mtime) { return ""; }
      const diff = Math.max(0, Date.now() - mtime);
      const sec = Math.floor(diff / 1000);
      if (sec < 60) { return "刚刚"; }
      const min = Math.floor(sec / 60);
      if (min < 60) { return min + " 分钟前"; }
      const hr = Math.floor(min / 60);
      if (hr < 24) { return hr + " 小时前"; }
      const day = Math.floor(hr / 24);
      if (day < 30) { return day + " 天前"; }
      return new Date(mtime).toLocaleDateString();
    }

    function render(payload) {
      const sessions = payload.sessions || [];
      const current = payload.current || "";
      if (sessions.length === 0) {
        list.innerHTML = '<div class="empty">当前工作区没有 pi 历史会话。</div>';
        return;
      }
      list.innerHTML = sessions.map(function (s) {
        const isCur = s.file && s.file === current;
        const all = s.userTexts || [];
        // 取前 3 + 后 3，中间用省略标记连接
        const head = all.slice(0, 3);
        const tailStart = Math.max(3, all.length - 3);
        const tail = all.length > 3 ? all.slice(tailStart) : [];
        const omitted = all.length - head.length - tail.length;
        const headHtml = head.map(function (t) {
          return '<div class="msg"><span class="tag">我</span><span class="body">' + esc(t || "(无内容)") + '</span></div>';
        }).join("");
        const tailHtml = tail.map(function (t) {
          return '<div class="msg"><span class="tag">我</span><span class="body">' + esc(t || "(无内容)") + '</span></div>';
        }).join("");
        const gapHtml = omitted > 0 ? '<div class="msg gap">…（' + omitted + ' 条省略）</div>' : "";
        const body = headHtml + gapHtml + tailHtml;
        return '<div class="card' + (isCur ? " current" : "") + '" data-file="' + esc(s.file) + '"' +
          (isCur ? ' title="当前已加载的会话"' : "") + '>' +
          '<div class="row1">' +
            '<span class="title">' + esc(s.title) + '</span>' +
            (isCur ? '<span class="badge">当前</span>' : '') +
            '<span class="time">' + esc(relTime(s.mtime)) + '</span>' +
          '</div>' +
          (body || '<div class="msg gap">(无用户消息)</div>') +
        '</div>';
      }).join("");
      list.querySelectorAll(".card").forEach(function (el) {
        el.addEventListener("click", function () {
          vscode.postMessage({ type: "open", file: el.getAttribute("data-file") });
        });
      });
    }

    window.addEventListener("message", function (e) {
      const msg = e.data;
      if (msg.type === "sessions") {
        render(msg);
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
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

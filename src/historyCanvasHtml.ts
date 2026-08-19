import * as vscode from "vscode";
import * as fs from "fs";

function nonce(): string {
    let text = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

/** 生成历史会话 WebviewPanel HTML。 */
export function getHistoryCanvasHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const n = nonce();
    const uri = (name: string) =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", name)).toString();
    const cssPath = vscode.Uri.joinPath(extensionUri, "media", "historyCanvas.css").fsPath;
    let css = "";
    try {
        css = fs.readFileSync(cssPath, "utf8");
    } catch {
        /* ignore */
    }
    const csp =
        `default-src 'none'; ` +
        `img-src ${webview.cspSource} data:; ` +
        `style-src 'unsafe-inline'; ` +
        `script-src 'nonce-${n}';`;

    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
${css}
</style>
</head>
<body>
  <div id="toolbar">
    <span class="tb-title">历史会话</span>
    <span id="tbMeta" class="tb-meta"></span>
    <span class="tb-spacer"></span>
    <button type="button" id="btnRefresh" title="重新加载会话">刷新</button>
    <button type="button" id="btnLoadMore" class="hidden" title="加载更早的会话">加载更多</button>
  </div>
  <main id="mail">
    <aside id="listPane" aria-label="会话列表">
      <div id="searchWrap">
        <input id="search" type="search" autocomplete="off" placeholder="搜索已加载会话" aria-label="搜索会话" />
      </div>
      <div id="threadList" role="list"></div>
      <div id="noResults" class="hidden">没有匹配的会话。</div>
    </aside>
    <section id="readingPane" aria-label="会话预览">
      <div id="emptyReading">从左侧选择一个会话以预览内容。</div>
      <article id="threadDetail" class="hidden">
        <header class="detail-top">
          <div class="detail-title-row">
            <h1 id="detailTitle"></h1>
            <div class="detail-actions">
              <button id="btnOpenThread" class="detail-action" type="button">打开会话</button>
            </div>
          </div>
          <div id="detailMeta"></div>
          <div id="branchBar" aria-label="会话分支"></div>
        </header>
        <div id="messages"></div>
      </article>
    </section>
  </main>
  <script nonce="${n}" src="${uri("historyCanvas.js")}"></script>
</body>
</html>`;
}

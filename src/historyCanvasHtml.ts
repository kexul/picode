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

/** 生成历史画布 WebviewPanel HTML。 */
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
    <div class="tb-left">
      <span class="tb-title">会话画布</span>
      <span id="tbMeta" class="tb-meta"></span>
    </div>
    <div class="tb-right">
      <button type="button" id="btnFit" title="适应画布">适应</button>
      <button type="button" id="btnRefresh" title="重新加载">刷新</button>
      <button type="button" id="btnLoadMore" class="hidden" title="加载更早的家族">加载更多</button>
    </div>
  </div>
  <div id="viewport">
    <div id="empty" class="hidden">当前工作区没有会话记录。</div>
    <div id="world">
      <svg id="edges" xmlns="http://www.w3.org/2000/svg"></svg>
      <div id="nodes"></div>
    </div>
  </div>
  <script nonce="${n}" src="${uri("marked.js")}"></script>
  <script nonce="${n}" src="${uri("highlight.js")}"></script>
  <script nonce="${n}" src="${uri("historyCanvas.js")}"></script>
</body>
</html>`;
}

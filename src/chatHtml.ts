import * as vscode from "vscode";

function nonce(): string {
    let text = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

export function getChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const n = nonce();
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, "media", "main.js")
    );
    // 图片来源允许 webview 资源与内联 data: URI（用于图片预览）
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
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  #messages { flex: 1; overflow-y: auto; padding: 8px; }
  .msg { margin: 6px 0; padding: 8px 10px; border-radius: 6px; word-wrap: break-word; }
  .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); white-space: pre-wrap; }
  .assistant { background: var(--vscode-editorWidget-background, rgba(128,128,128,0.1)); }
  .system { font-style: italic; opacity: 0.75; font-size: 0.9em; white-space: pre-wrap; }
  .error { color: var(--vscode-errorForeground); }
  .thinking { opacity: 0.75; font-size: 0.9em; border-left: 2px solid var(--vscode-descriptionForeground); padding: 0; overflow: hidden; }
  .thinking .thinking-header {
    display: flex; align-items: center; gap: 6px; cursor: pointer;
    padding: 4px 10px; font-size: 0.95em; user-select: none;
  }
  .thinking .thinking-header:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12)); }
  .thinking .thinking-caret { font-size: 0.7em; opacity: 0.7; }
  .thinking .thinking-label { font-weight: bold; opacity: 0.7; }
  .thinking .thinking-body { padding: 4px 10px 8px; white-space: pre-wrap; }
  .thinking.collapsed .thinking-body { display: none; }
  /* 思考中的动画指示器 */
  .typing { display: inline-flex; align-items: center; gap: 3px; vertical-align: middle; }
  .typing span {
    width: 4px; height: 4px; border-radius: 50%;
    background: var(--vscode-foreground); opacity: 0.5;
    animation: typing-blink 1.2s infinite ease-in-out;
  }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes typing-blink { 0%, 60%, 100% { opacity: 0.2; } 30% { opacity: 0.9; } }
  .tool { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; opacity: 0.8; white-space: pre-wrap; }
  .role { font-weight: bold; font-size: 0.8em; opacity: 0.7; margin-bottom: 2px; }
  /* markdown */
  .md p { margin: 0.4em 0; }
  .md h1, .md h2, .md h3 { margin: 0.5em 0 0.3em; line-height: 1.2; }
  .md h1 { font-size: 1.4em; } .md h2 { font-size: 1.2em; } .md h3 { font-size: 1.05em; }
  .md ul, .md ol { margin: 0.3em 0; padding-left: 1.4em; }
  .md li { margin: 0.15em 0; }
  .md pre { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 8px 10px; border-radius: 4px; overflow-x: auto; margin: 0.4em 0; }
  .md code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
  .md :not(pre) > code { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.2)); padding: 1px 4px; border-radius: 3px; }
  .md pre code { background: none; padding: 0; }
  .md blockquote { margin: 0.4em 0; padding-left: 10px; border-left: 3px solid var(--vscode-descriptionForeground); opacity: 0.85; }
  .md a { color: var(--vscode-textLink-foreground); }
  .md hr { border: none; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4)); margin: 0.6em 0; }
  /* 语法高亮 token 颜色 */
  .tok-kw { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
  .tok-str { color: var(--vscode-debugTokenExpression-string, #ce9178); }
  .tok-num { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  .tok-com { color: var(--vscode-descriptionForeground, #6a9955); font-style: italic; }
  .tok-fn { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
  .code-lang { display: block; font-size: 0.75em; opacity: 0.6; margin-bottom: 4px; text-transform: uppercase; }
  #inputArea { display: flex; flex-direction: column; padding: 8px; gap: 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); }
  #imgPreview { display: flex; flex-wrap: wrap; gap: 6px; }
  #imgPreview:empty { display: none; }
  .img-thumb { position: relative; }
  .img-thumb img { height: 48px; border-radius: 4px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4)); display: block; }
  .img-thumb .rm { position: absolute; top: -6px; right: -6px; width: 16px; height: 16px; line-height: 14px; text-align: center; border-radius: 50%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font-size: 11px; }
  #inputRow { display: flex; gap: 6px; position: relative; }
  #input {
    flex: 1; resize: none; min-height: 144px; max-height: 640px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px 8px;
    font-family: inherit; font-size: inherit;
  }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 0 12px; cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  #status { padding: 2px 8px; font-size: 0.8em; opacity: 0.7; min-height: 1em; }
  /* 底部工具栏 */
  #bottomBar { display: flex; align-items: center; gap: 8px; padding-top: 2px; }
  #modelBtn {
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: none; border-radius: 4px; padding: 2px 10px; cursor: pointer;
    font-size: 0.8em; display: inline-flex; align-items: center; gap: 4px;
  }
  #modelBtn:hover { opacity: 0.85; }
  #bottomHint { font-size: 0.75em; opacity: 0.55; }
  /* @ 文件引用下拉 */
  #fileMenu {
    position: absolute; bottom: 100%; left: 0; margin-bottom: 4px; z-index: 10;
    max-height: 200px; overflow-y: auto; min-width: 240px; max-width: 90%;
    background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
    border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  }
  #fileMenu.hidden { display: none; }
  .file-item { padding: 4px 10px; cursor: pointer; font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .file-item.active, .file-item:hover { background: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,0.3)); color: var(--vscode-list-activeSelectionForeground, inherit); }
  .file-item .dir { opacity: 0.55; font-size: 0.9em; }
  /* 上下文/token 状态栏 */
  #statsBar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    padding: 3px 10px; font-size: var(--vscode-font-size); opacity: 0.75;
    font-family: var(--vscode-editor-font-family, monospace);
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
  }
  #statsBar:empty { display: none; }
  .bar-hidden { display: none !important; }
  #statsBar .stat { white-space: nowrap; }
  #statsBar .ctx-hi { color: var(--vscode-editorWarning-foreground, #cca700); }
  #statsBar .ctx-crit { color: var(--vscode-errorForeground); }
  /* 本次对话修改的文件列表 */
  #changedFiles {
    display: flex; flex-direction: column;
    max-height: 140px; overflow-y: auto;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
  }
  #changedFiles:empty { display: none; }
  #changedFiles .cf-header {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 10px; font-size: var(--vscode-font-size); opacity: 0.7;
    text-transform: uppercase; letter-spacing: 0.03em;
  }
  .cf-item {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 10px; cursor: pointer; font-size: var(--vscode-font-size);
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .cf-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
  .cf-item .cf-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cf-item .cf-dir { opacity: 0.55; }
  .cf-item .cf-add { color: var(--vscode-gitDecoration-addedResourceForeground, #587c0c); }
  .cf-item .cf-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #ad0707); }
  .cf-item .cf-stat { white-space: nowrap; }
  /* edit/write 工具调用卡片 */
  .edit-card {
    margin: 6px 0; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    border-radius: 4px; overflow: hidden; font-size: 0.85em;
  }
  .edit-card.error { border-color: var(--vscode-errorForeground, rgba(255,0,0,0.5)); }
  .edit-title {
    display: flex; align-items: center; gap: 6px; padding: 4px 10px; cursor: pointer;
    background: var(--vscode-editorWidget-background, rgba(128,128,128,0.1));
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .edit-title:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.2)); }
  .edit-card.error .edit-title { cursor: default; }
  .edit-card.error .edit-title:hover { background: var(--vscode-editorWidget-background, rgba(128,128,128,0.1)); }
  .edit-title .et-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .edit-title .et-loading { opacity: 0.6; }
  .edit-title .et-err { color: var(--vscode-errorForeground); }
  .edit-diff {
    max-height: 200px; overflow-y: auto; padding: 4px 0;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .diff-line { padding: 0 10px; white-space: pre; }
  .diff-line.del { background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.1)); color: var(--vscode-gitDecoration-deletedResourceForeground, #ad0707); }
  .diff-line.add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,0.1)); color: var(--vscode-gitDecoration-addedResourceForeground, #587c0c); }
  .diff-line.ctx { opacity: 0.6; }
  /* 工单（ticket）栏 */
  #ticketBar {
    display: flex; flex-direction: column; gap: 4px;
    padding: 5px 10px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
  }
  #ticketBar .tk-header {
    display: flex; align-items: center; gap: 6px;
    font-size: var(--vscode-font-size); opacity: 0.7;
    text-transform: uppercase; letter-spacing: 0.03em;
  }
  #ticketBar .tk-active { text-transform: none; opacity: 1; margin-left: auto; font-size: 0.85em; }
  #ticketBar .tk-active.on { color: var(--vscode-gitDecoration-addedResourceForeground, #587c0c); }
  #ticketBar .tk-row { display: flex; gap: 6px; align-items: center; }
  #ticketInput {
    flex: 1; min-width: 0;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
    padding: 3px 8px; font-family: inherit; font-size: 0.85em;
  }
  #ticketHistory {
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
    border-radius: 4px; padding: 3px 4px; font-size: 0.85em; max-width: 45%;
  }
  #ticketBar button {
    font-size: 0.8em; padding: 2px 10px;
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  #ticketBar button.tk-clear { padding: 2px 8px; }
</style>
</head>
<body>
  <div id="messages"></div>
  <div id="status"></div>
  <div id="statsBar"></div>
  <div id="changedFiles"></div>
  <div id="ticketBar">
    <div class="tk-header">
      工单
      <span id="ticketActive" class="tk-active">未选择工单</span>
    </div>
    <div class="tk-row">
      <input id="ticketInput" placeholder="#12031 新增hook" title="工单号以 #+数字 开头，回车应用" />
      <select id="ticketHistory" title="选择历史工单">
        <option value="">历史工单…</option>
      </select>
      <button id="ticketApply">应用</button>
      <button id="ticketClear" class="tk-clear" title="取消工单（停止记录）">✕</button>
    </div>
  </div>
  <div id="inputArea">
    <div id="imgPreview"></div>
    <div id="inputRow">
      <div id="fileMenu" class="hidden"></div>
      <textarea id="input" placeholder="与 pi 对话… (Enter 发送, Shift+Enter 换行, 可粘贴图片, @ 引用文件)"></textarea>
      <button id="sendBtn">发送</button>
    </div>
    <div id="bottomBar">
      <button id="modelBtn" title="切换模型">⚡ <span id="modelName">模型</span></button>
      <span id="bottomHint">输入 @ 引用打开的文件</span>
    </div>
  </div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}

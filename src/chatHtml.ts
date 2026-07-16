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
  #messages { flex: 1; overflow-y: auto; padding: 8px 8px 16px; }
  #messages::-webkit-scrollbar { width: 6px; }
  #messages::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.4)); border-radius: 3px; }
  #messages::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.6)); }
  .msg { margin: 10px 0; padding: 10px 14px; word-wrap: break-word; }
  .msg-enter { animation: msg-enter 250ms ease-out backwards; }
  @keyframes msg-enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  .user { max-width: 75%; margin-left: auto; border-radius: 12px; white-space: pre-wrap; background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent); color: var(--vscode-foreground); }
  .assistant { background: none; padding: 0; }
  .system { font-style: italic; opacity: 0.6; font-size: 0.85em; white-space: pre-wrap; text-align: center; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-radius: 0; margin: 12px 0; }
  .error { color: var(--vscode-errorForeground); }
  .thinking { opacity: 0.75; font-size: 0.9em; border-left: 2px solid var(--vscode-descriptionForeground); padding: 0; overflow: hidden; }
  .thinking .thinking-header {
    display: flex; align-items: center; gap: 6px; cursor: pointer;
    padding: 4px 10px; font-size: 0.95em; user-select: none;
  }
  .thinking .thinking-header:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12)); }
  .thinking .thinking-caret { font-size: 0.7em; opacity: 0.7; transition: transform 200ms ease; }
  .thinking:not(.collapsed) .thinking-caret { transform: rotate(90deg); }
  .thinking .thinking-label { font-weight: bold; opacity: 0.7; }
  .thinking .thinking-body { padding: 4px 10px 8px; white-space: pre-wrap; max-height: 1000px; overflow: hidden; transition: max-height 300ms ease, opacity 300ms ease, padding 300ms ease; opacity: 1; }
  .thinking.collapsed .thinking-body { max-height: 0; opacity: 0; padding-top: 0; padding-bottom: 0; }
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
  .tool-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0; padding: 0 14px; }
  .tool { display: inline-block; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.8em; opacity: 0.7; white-space: nowrap; background: var(--vscode-editorWidget-background, rgba(128,128,128,0.1)); border-radius: 4px; padding: 2px 8px; cursor: pointer; transition: background 150ms, opacity 150ms; }
  .tool:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.2)); opacity: 1; }
  .tool .tool-args { display: none; margin-left: 6px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  .tool.expanded { white-space: normal; flex: 1 1 100%; min-width: 0; }
  .tool.expanded .tool-args { display: inline; }
  .role { font-weight: bold; font-size: 0.8em; opacity: 0.7; margin-bottom: 2px; }
  /* markdown */
  .md p { margin: 13px 0; line-height: 1.6; text-wrap: pretty; }
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 18px 0 12px; line-height: 1.25; letter-spacing: -0.01em; scroll-margin-top: 12px; }
  .md h1 { font-size: 1.5em; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); padding-bottom: 0.3em; }
  .md h2 { font-size: 1.3em; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); padding-bottom: 0.3em; }
  .md h3 { font-size: 1.15em; font-weight: 600; }
  .md h4 { font-size: 1em; font-weight: 600; }
  .md h5 { font-size: 0.9em; font-weight: 600; }
  .md h6 { font-size: 0.85em; font-weight: 600; opacity: 0.8; }
  .md ul, .md ol { margin: 7px 0; padding-left: 20px; }
  .md li { margin: 2px 0; }
  .md ol { list-style-type: decimal; }
  .md ol ol { list-style-type: lower-roman; }
  .md ol ol ol { list-style-type: lower-alpha; }
  .md pre { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 13px; border-radius: 6px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); overflow-x: auto; margin: 13px 0; line-height: 1.45; white-space: pre-wrap; word-break: break-all; }
  .md code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; }
  .md :not(pre) > code { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.25)); color: var(--vscode-textPreformat-foreground, var(--vscode-foreground)); padding: 1px 0; margin: 0 2px; border-radius: 3px; box-shadow: 0.25em 0 0 var(--vscode-textCodeBlock-background, rgba(128,128,128,0.25)), -0.25em 0 0 var(--vscode-textCodeBlock-background, rgba(128,128,128,0.25)); }
  .md pre code { background: none; padding: 0; }
  .md blockquote { margin: 13px 0; padding: 1px 13px; background: var(--vscode-editorWidget-background, rgba(128,128,128,0.08)); border-left: 4px solid var(--vscode-descriptionForeground); border-radius: 0 4px 4px 0; }
  .md blockquote > :first-child { margin-top: 0; }
  .md blockquote > :last-child { margin-bottom: 0; }
  .md a { color: var(--vscode-textLink-foreground); transition: opacity 200ms; }
  .md a:hover { text-decoration: underline; opacity: 0.85; }
  .md hr { border: none; height: 3px; background-color: var(--vscode-panel-border, rgba(128,128,128,0.4)); margin: 24px 0; }
  .md-table-wrap { overflow-x: auto; margin: 13px 0; }
  .md table { border-collapse: collapse; display: block; overflow-x: auto; width: fit-content; max-width: 100%; margin: 0 auto; font-size: 0.9em; }
  .md th, .md td { padding: 5px 10px; border: none; }
  .md th { border-top: 2px solid var(--vscode-panel-border, rgba(128,128,128,0.4)); border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4)); background: var(--vscode-editorWidget-background, rgba(128,128,128,0.1)); font-weight: 600; }
  .md td { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
  .md tr:last-child td { border-bottom: 2px solid var(--vscode-panel-border, rgba(128,128,128,0.4)); }
  .md tbody tr { transition: background 150ms; }
  .md tbody tr:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
  /* 语法高亮 token 颜色 */
  .tok-kw { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
  .tok-str { color: var(--vscode-debugTokenExpression-string, #ce9178); }
  .tok-num { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  .tok-com { color: var(--vscode-descriptionForeground, #6a9955); font-style: italic; }
  .tok-fn { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
  .code-lang { display: block; font-size: 0.75em; font-weight: 600; letter-spacing: 0.05em; opacity: 0.6; margin-bottom: 4px; text-transform: uppercase; }
  #inputArea { display: flex; flex-direction: column; padding: 8px; gap: 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); }
  #imgPreview { display: flex; flex-wrap: wrap; gap: 6px; }
  #imgPreview:empty { display: none; }
  .img-thumb { position: relative; }
  .img-thumb img { height: 48px; border-radius: 4px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4)); display: block; transition: transform 200ms; }
  .img-thumb:hover img { transform: scale(1.05); }
  .img-thumb .rm { position: absolute; top: -6px; right: -6px; width: 16px; height: 16px; line-height: 14px; text-align: center; border-radius: 50%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font-size: 11px; }
  #inputRow { display: flex; gap: 6px; position: relative; }
  #sendCol { display: flex; flex-direction: column; gap: 4px; width: 64px; }
  #newBtn { height: 33.3%; min-height: 28px; font-size: 0.8em; padding: 0; background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
  #newBtn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }
  #sendBtn { flex: 2; font-size: 0.9em; padding: 0; }
  #input {
    flex: 1; resize: none; min-height: 144px; max-height: 640px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 8px; padding: 6px 8px;
    font-family: inherit; font-size: inherit;
    transition: border-color 200ms;
  }
  #input:focus { border-color: var(--vscode-focusBorder); outline: none; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 0 12px; cursor: pointer;
    transition: background 200ms, transform 100ms, opacity 200ms;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
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
  #modelBtn { transition: opacity 200ms; }
  /* @ 文件引用下拉 */
  #fileMenu {
    position: absolute; bottom: 100%; left: 0; margin-bottom: 4px; z-index: 10;
    max-height: 200px; overflow-y: auto; min-width: 240px; max-width: 90%;
    background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
    border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    opacity: 1; transform: translateY(0); transition: opacity 200ms ease, transform 200ms ease;
  }
  #fileMenu.hidden { display: block; opacity: 0; transform: translateY(4px); pointer-events: none; visibility: hidden; }
  .file-item { padding: 4px 10px; cursor: pointer; font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background 150ms; }
  .file-item.active, .file-item:hover { background: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,0.3)); color: var(--vscode-list-activeSelectionForeground, inherit); }
  .file-item .dir { opacity: 0.55; font-size: 0.9em; }
  /* 上下文/token 状态栏 */
  #statsBar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    font-size: 0.78em; opacity: 0.6;
    font-family: var(--vscode-editor-font-family, monospace);
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
    padding: 6px 10px; font-size: 0.75em; opacity: 0.7;
    text-transform: uppercase; letter-spacing: 0.03em;
  }
  .cf-item {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 10px; cursor: pointer; font-size: var(--vscode-font-size);
    font-family: var(--vscode-editor-font-family, monospace);
    transition: background 150ms;
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
    transition: background 150ms;
  }
  .edit-title .et-caret { font-size: 0.7em; opacity: 0.6; transition: transform 200ms ease; }
  .edit-card.collapsed .et-caret { transform: rotate(-90deg); }
  .edit-card:not(.collapsed) .et-caret { transform: rotate(90deg); }
  .edit-title:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.2)); }
  .edit-card.error .edit-title { cursor: default; }
  .edit-card.error .edit-title:hover { background: var(--vscode-editorWidget-background, rgba(128,128,128,0.1)); }
  .edit-title .et-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .edit-title .et-loading { opacity: 0.6; }
  .edit-title .et-err { color: var(--vscode-errorForeground); }
  .edit-title .et-revert {
    flex: 0 0 auto; font-size: 0.9em; padding: 1px 8px; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.25));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  }
  .edit-title .et-revert:hover { background: var(--vscode-button-hoverBackground, rgba(128,128,128,0.4)); }
  .edit-card.reverted { opacity: 0.6; }
  .edit-card.reverted .et-reverted { flex: 0 0 auto; font-size: 0.85em; opacity: 0.8; font-style: italic; }
  .edit-diff {
    max-height: 200px; overflow-y: auto; padding: 4px 0;
    font-family: var(--vscode-editor-font-family, monospace);
    transition: max-height 300ms ease, opacity 300ms ease;
    opacity: 1;
  }
  .edit-card.collapsed .edit-diff { max-height: 0; opacity: 0; overflow: hidden; padding: 0; }
  .diff-line { padding: 0 10px; white-space: pre; }
  .diff-line.del { background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.1)); color: var(--vscode-gitDecoration-deletedResourceForeground, #ad0707); }
  .diff-line.add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,0.1)); color: var(--vscode-gitDecoration-addedResourceForeground, #587c0c); }
  .diff-line.ctx { opacity: 0.6; }
  .empty-hint { text-align: center; opacity: 0.35; font-size: 0.9em; padding: 40px 0; user-select: none; }
</style>
</head>
<body>
  <div id="messages">
    <div id="emptyHint" class="empty-hint">输入消息开始对话…</div>
  </div>
  <div id="status"></div>
  <div id="changedFiles"></div>
  <div id="inputArea">
    <div id="imgPreview"></div>
    <div id="inputRow">
      <div id="fileMenu" class="hidden"></div>
      <textarea id="input" placeholder="与 pi 对话… (Enter 发送, Shift+Enter 换行, 可粘贴图片, @ 引用文件)"></textarea>
      <div id="sendCol">
        <button id="newBtn" title="新建会话">新建</button>
        <button id="sendBtn">发送</button>
      </div>
    </div>
    <div id="bottomBar">
      <button id="modelBtn" title="切换模型">⚡ <span id="modelName">模型</span></button>
      <div id="statsBar"></div>
    </div>
  </div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}

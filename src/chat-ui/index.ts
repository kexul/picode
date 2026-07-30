/**
 * chat-ui —— 对话前端共用模块。
 *
 * 导出 renderHTML(opts)：生成聊天界面 HTML。
 * 聊天 DOM 结构 + CSS + chat.js 三边共用一份；各宿主通过 opts 注入 URI 解析、
 * CSP、CSS 文本、额外 head/body。
 *
 * 前端资源（chat.js / marked.js / highlight.js 等）的单一真源是 apps/vscode/media
 * （vscode 插件打包根内，无需拷贝即可被 vsce 纳入）；Electron 在 build 时从
 * 该目录拷到 out/.../renderer/。chat.css 由调用方读取文本后通过 opts.chatCss
 * 传入（避免本模块运行时读文件）。
 */

export interface RenderHTMLOpts {
    /** 把资源文件名解析为可放入 HTML 的 URI 字符串。 */
    resolveUri: (name: string) => string;
    /** CSP 字符串（各宿主自行构造，含各自 nonce/cspSource）。 */
    csp: string;
    /** chat.css 的文本内容（由调用方读取后传入）。 */
    chatCss: string;
    /** 注入 <head> 末尾的额外内容。 */
    extraHead?: string;
    /** 注入 <body> 开头的额外 DOM。 */
    extraBodyTop?: string;
    /** 注入 <body> 结尾、<script> 之前的额外 DOM。 */
    extraBodyBottom?: string;
    /** 给 <script> 标签加的 nonce 值（VSCode CSP 需要）；Electron 留空。 */
    scriptNonce?: string;
    /** 额外 <script src> 的 URI 列表（如 Electron 的 app.js），放在 chat.js 之后。 */
    extraScripts?: string[];
}

export function renderHTML(opts: RenderHTMLOpts): string {
    const chatJs = opts.resolveUri("chat.js");
    const markedJs = opts.resolveUri("marked.js");
    const highlightJs = opts.resolveUri("highlight.js");
    const nonceAttr = opts.scriptNonce ? ` nonce="${opts.scriptNonce}"` : "";

    const head = opts.extraHead ? `  ${opts.extraHead}\n` : "";
    const tabbar =
    `  <div id="tabBar" class="hidden">\n` +
    `    <div id="tabBarInner"></div>\n` +
    `  </div>\n`;
    const bodyTop = opts.extraBodyTop ? `  ${opts.extraBodyTop}\n` : "";
    const bodyBottom = opts.extraBodyBottom ? `  ${opts.extraBodyBottom}\n` : "";
    const extraScripts = (opts.extraScripts || [])
        .map((s) => `\n  <script${nonceAttr} src="${s}"></script>`)
        .join("");

    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${opts.csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
${opts.chatCss}
</style>
${head}</head>
<body>
${bodyTop}${tabbar}  <div id="messages"></div>
  <div id="status"></div>
  <div id="changedFiles"></div>
  <div id="inputArea">
    <div id="imgPreview"></div>
    <div id="inputRow">
      <div id="fileMenu" class="hidden"></div>
      <textarea id="input" placeholder="与 pi 对话… (Enter 发送, Shift+Enter 换行, 可粘贴图片, @ 引用文件)"></textarea>
      <div id="sendCol">
        <button id="newBtn" title="新建会话 (Ctrl+Alt+N)">新建</button>
        <button id="sendBtn">发送</button>
      </div>
    </div>
    <div id="bottomBar">
      <button id="treeBtn" title="查看对话树 / 切换分支">⑂ 分支</button>
      <button id="modelBtn" title="切换模型">⚡ <span id="modelName">模型</span></button>
      <div id="statsBar"></div>
    </div>
  </div>
  <div id="treeOverlay" class="hidden">
    <div id="treePanel">
      <div id="treeHeader"><span>对话树</span><span class="tree-hint">点击 user 消息新建分支 · Esc 关闭</span></div>
      <div id="treeBody"></div>
    </div>
  </div>
  <div id="pickerOverlay" class="hidden">
    <div id="pickerPanel">
      <div id="pickerHeader"><span id="pickerTitle">选择</span><span class="picker-hint">↑↓ 选择 · Enter 确认 · Esc 关闭</span></div>
      <div id="pickerSearchWrap"><input id="pickerSearch" type="text" placeholder="筛选…" autocomplete="off" spellcheck="false" /></div>
      <div id="pickerBody"></div>
      <div id="pickerFooter" class="hidden"></div>
    </div>
  </div>
  <div id="settingsOverlay" class="hidden">
    <div id="settingsPanel">
      <div id="settingsRoot"></div>
    </div>
  </div>
${bodyBottom}  <script${nonceAttr} src="${markedJs}"></script>
  <script${nonceAttr} src="${highlightJs}"></script>
  <script${nonceAttr} src="${chatJs}"></script>${extraScripts}
</body>
</html>`;
}

/**
 * renderHtml —— 生成聊天界面 HTML 骨架。
 *
 * 导出 renderHTML(opts)：生成聊天界面 HTML。
 * 聊天 DOM 结构 + CSS + chat.js 在此定义；调用方通过 opts 注入 URI 解析、
 * CSP、CSS 文本、额外 head/body。
 *
 * 前端资源（chat.js / marked.js / highlight.js 等）位于 media/
 * （vscode 插件打包根内，无需拷贝即可被 vsce 纳入）。chat.css 由调用方读取文本后
 * 通过 opts.chatCss 传入（避免本模块运行时读文件）。
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
    /** 给 <script> 标签加的 nonce 值（VSCode CSP 需要）。 */
    scriptNonce?: string;
    /** 额外 <script src> 的 URI 列表，放在 chat.js 之后。 */
    extraScripts?: string[];
}

/**
 * 骨架里那几颗图标按钮的 SVG：取自 VSCode 官方 codicon（@vscode/codicons 包），
 * fill=currentColor 跟随文字色；尺寸由 chat.css 里对应按钮的规则控制。
 */
const ICON_ADD = '<svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M8 1.5C8 1.22386 7.77614 1 7.5 1C7.22386 1 7 1.22386 7 1.5V7H1.5C1.22386 7 1 7.22386 1 7.5C1 7.77614 1.22386 8 1.5 8H7V13.5C7 13.7761 7.22386 14 7.5 14C7.77614 14 8 13.7761 8 13.5V8H13.5C13.7761 8 14 7.77614 14 7.5C14 7.22386 13.7761 7 13.5 7H8V1.5Z"/></svg>';
const ICON_ARROW_DOWN = '<svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M13.854 8.146C13.659 7.951 13.342 7.951 13.147 8.146L9.00096 12.292V2.5C9.00096 2.224 8.77696 2 8.50096 2C8.22496 2 8.00096 2.224 8.00096 2.5V12.293L3.85496 8.147C3.65996 7.952 3.34296 7.952 3.14796 8.147C2.95296 8.342 2.95296 8.659 3.14796 8.854L8.14796 13.854C8.24596 13.952 8.37396 14 8.50196 14C8.62996 14 8.75796 13.951 8.85596 13.854L13.856 8.854C14.051 8.659 14.051 8.342 13.856 8.147L13.854 8.146Z"/></svg>';
const ICON_CLOSE = '<svg width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M8.70701 8.00001L12.353 4.35401C12.548 4.15901 12.548 3.84201 12.353 3.64701C12.158 3.45201 11.841 3.45201 11.646 3.64701L8.00001 7.29301L4.35401 3.64701C4.15901 3.45201 3.84201 3.45201 3.64701 3.64701C3.45201 3.84201 3.45201 4.15901 3.64701 4.35401L7.29301 8.00001L3.64701 11.646C3.45201 11.841 3.45201 12.158 3.64701 12.353C3.74501 12.451 3.87301 12.499 4.00101 12.499C4.12901 12.499 4.25701 12.45 4.35501 12.353L8.00101 8.70701L11.647 12.353C11.745 12.451 11.873 12.499 12.001 12.499C12.129 12.499 12.257 12.45 12.355 12.353C12.55 12.158 12.55 11.841 12.355 11.646L8.70901 8.00001H8.70701Z"/></svg>';

export function renderHTML(opts: RenderHTMLOpts): string {
    const chatJs = opts.resolveUri("chat.js");
    const markedJs = opts.resolveUri("marked.js");
    const highlightJs = opts.resolveUri("highlight.js");
    const nonceAttr = opts.scriptNonce ? ` nonce="${opts.scriptNonce}"` : "";

    const head = opts.extraHead ? `  ${opts.extraHead}\n` : "";
    const tabbar =
    `  <div id="tabBar" class="hidden">\n` +
    `    <div id="tabBarInner"></div><button id="newTabBtn" class="tab-bar-btn" title="新建 tab (Ctrl+Alt+N)" aria-label="新建 tab">${ICON_ADD}</button>\n` +
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
${bodyTop}${tabbar}  <div id="messages">
    <button id="jumpBottom" class="hidden" title="跳到最新" aria-label="跳到最新">${ICON_ARROW_DOWN}</button>
  </div>
  <div id="inputArea">
    <div id="queueBar" class="hidden"></div>
    <div id="imgPreview"></div>
    <div id="inputRow">
      <div id="fileMenu" class="hidden"></div>
      <textarea id="input"></textarea>
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
      <div id="settingsTabs">
        <button class="settings-tab active" data-tab="models" type="button">模型配置</button>
        <button class="settings-tab" data-tab="options" type="button">插件选项</button>
        <span class="settings-tabs-spacer"></span>
        <button id="settingsClose" type="button" title="关闭 (Esc)" aria-label="关闭">${ICON_CLOSE}</button>
      </div>
      <div id="settingsRoot"></div>
      <div id="viewOptsRoot" class="hidden"></div>
    </div>
  </div>
${bodyBottom}  <script${nonceAttr} src="${markedJs}"></script>
  <script${nonceAttr} src="${highlightJs}"></script>
  <script${nonceAttr} src="${chatJs}"></script>${extraScripts}
</body>
</html>`;
}

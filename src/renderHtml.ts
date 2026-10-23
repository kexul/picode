/**
 * renderHtml —— 生成聊天界面 HTML 骨架。
 *
 * 导出 renderHTML(opts)：生成聊天界面 HTML。
 * 聊天 DOM 结构 + CSS + 脚本位次在此定义；调用方通过 opts 注入 CSP、
 * chat.css 文本、脚本清单（外链或内联）、额外 head/body。
 *
 * chat.css 由调用方读取文本后通过 opts.chatCss 传入（本模块运行时不读文件）。
 */

/** 脚本清单里的一项：要么给外链地址，要么给内联内容，二选一。 */
export interface RenderScript {
    /** 外链脚本的地址（浏览器页面用：/media/xxx）。 */
    src?: string;
    /** 内联的脚本内容（VSCode 面板用）；调用方要先做 </script> 转义。 */
    content?: string;
}

export interface RenderHTMLOpts {
    /** CSP 字符串（各宿主自行构造，含各自 nonce）。 */
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
    /** 要加载的脚本，按顺序排在 body 末尾（marked → highlight → chat → 各页面自己的）。 */
    scripts: RenderScript[];
}

/**
 * 骨架里那几颗图标按钮的 SVG：取自 VSCode 官方 codicon（@vscode/codicons 包），
 * fill=currentColor 跟随文字色；尺寸由 chat.css 里对应按钮的规则控制。
 * ICON_CLOSE 是例外：不是 codicon，而是自画的一颗粗叉——跟会话行尾那颗关闭叉长得一样，
 * 面板头部的「关闭」要用同一颗。
 */
const ICON_ADD = '<svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M8 1.5C8 1.22386 7.77614 1 7.5 1C7.22386 1 7 1.22386 7 1.5V7H1.5C1.22386 7 1 7.22386 1 7.5C1 7.77614 1.22386 8 1.5 8H7V13.5C7 13.7761 7.22386 14 7.5 14C7.77614 14 8 13.7761 8 13.5V8H13.5C13.7761 8 14 7.77614 14 7.5C14 7.22386 13.7761 7 13.5 7H8V1.5Z"/></svg>';
const ICON_ARROW_DOWN = '<svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M13.854 8.146C13.659 7.951 13.342 7.951 13.147 8.146L9.00096 12.292V2.5C9.00096 2.224 8.77696 2 8.50096 2C8.22496 2 8.00096 2.224 8.00096 2.5V12.293L3.85496 8.147C3.65996 7.952 3.34296 7.952 3.14796 8.147C2.95296 8.342 2.95296 8.659 3.14796 8.854L8.14796 13.854C8.24596 13.952 8.37396 14 8.50196 14C8.62996 14 8.75796 13.951 8.85596 13.854L13.856 8.854C14.051 8.659 14.051 8.342 13.856 8.147L13.854 8.146Z"/></svg>';
const ICON_CLOSE = '<svg width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2.5 2.5 L13.5 13.5 M13.5 2.5 L2.5 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';

export function renderHTML(opts: RenderHTMLOpts): string {
    const nonceAttr = opts.scriptNonce ? ` nonce="${opts.scriptNonce}"` : "";
    const scriptTags = opts.scripts
        .map((s) => s.src !== undefined
            ? `\n  <script${nonceAttr} src="${s.src}"></script>`
            : `\n  <script${nonceAttr}>${s.content ?? ""}</script>`)
        .join("");

    const head = opts.extraHead ? `  ${opts.extraHead}\n` : "";
    // 顶条：左边加号，中间一列（上头会话名、底下当前目录），右边两颗网页端按钮。
    // 中间那一列包成 #sessionCenter（一块可点区域）：里头那颗按钮装着两行——会话名在上、
    // 路径在下。那颗小点与箭头也是这颗按钮里的两头，跟两行整体居中（不是只对着会话名那一行）。
    // 路径行用 span 不用 div：按钮里只允许放行内内容。
    const sessionBar =
    `  <div id="sessionBar">\n` +
    `    <button id="newSessionBtn" title="新建会话 (Ctrl+Alt+N)" aria-label="新建会话">${ICON_ADD}</button>\n` +
    `    <div id="sessionCenter">\n` +
    `      <button id="sessionName" title="当前会话 · 点这里换会话" aria-label="当前会话">\n` +
    `        <span class="sn-mark"><span class="sn-dot"></span><span class="sn-count"></span></span>\n` +
    `        <span class="sn-lines"><span class="sn-title"><span class="sn-text"></span></span><span id="sessionPath" class="hidden"><span class="sp-text"></span></span></span>\n` +
    `      </button>\n` +
    `    </div>\n` +
    `    <div id="sessionBarTail"></div>\n` +
    `  </div>\n`;

    const bodyTop = opts.extraBodyTop ? `  ${opts.extraBodyTop}\n` : "";
    const bodyBottom = opts.extraBodyBottom ? `  ${opts.extraBodyBottom}\n` : "";

    // 对话那一列（顶条 + 消息 + 输入框）包在 #chatColumn 里：宽窗下「项目与会话」
    // 常驻右侧时，body 变成横排，让出右边那一列（见 chat.css 末尾那段）。
    // 窄窗（手机、VSCode 面板）里它只是 body 唯一的孩子，铺满整屏，跟以前一样。
    // 常驻那一列是它自己的容器（#sidebarDock），跟浮层里的抽屉共用一套类名，
    // 版式只写一份（见 chat.css 末尾那段）。
    const chatColumnOpen = `  <div id="chatColumn">\n`;
    const chatColumnClose = `  </div>\n`;

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
${bodyTop}${chatColumnOpen}${sessionBar}  <div id="messages">
    <button id="jumpBottom" class="hidden" title="跳到最新" aria-label="跳到最新">${ICON_ARROW_DOWN}</button>
  </div>
  <div id="inputArea">
    <div id="goalBar" class="hidden"></div>
    <div id="queueBar" class="hidden"></div>
    <div id="imgPreview"></div>
    <div id="inputRow">
      <div id="fileMenu" class="hidden"></div>
      <!-- rows=1：autoResize 把 height 设回 auto 时，textarea 的高度由 rows 决定
           （不写默认两行），网页端输入框起步只有一行，会被它顶高、清空后也回不去 -->
      <textarea id="input" rows="1"></textarea>
    </div>
  </div>
${chatColumnClose}  <div id="sidebarDock" class="pk-host pk-drawer pk-workspace">
    <div id="dockPanel" class="pk-panel">
      <div id="dockHeader" class="pk-header"><span id="dockTitle" class="pk-header-title">项目与会话</span></div>
      <div id="dockBody" class="pk-body"></div>
      <div id="dockFooter" class="pk-footer hidden"></div>
    </div>
  </div>
  <div id="pickerOverlay" class="pk-host hidden">
    <div id="pickerPanel" class="pk-panel">
      <div id="pickerHeader" class="pk-header"><span id="pickerTitle" class="pk-header-title">选择</span></div>
      <div id="pickerSubtitle" class="pk-subtitle hidden"></div>
      <div id="pickerSearchWrap" class="pk-search-wrap"><input id="pickerSearch" class="pk-search" type="text" placeholder="筛选…" autocomplete="off" spellcheck="false" /></div>
      <div id="pickerBody" class="pk-body"></div>
      <div id="pickerFooter" class="pk-footer hidden"></div>
    </div>
  </div>
  <div id="settingsOverlay" class="hidden">
    <div id="settingsPanel">
      <div id="settingsTabs">
        <span id="settingsTitle">设置</span>
        <span class="settings-tabs-spacer"></span>
        <button id="settingsClose" type="button" title="关闭" aria-label="关闭">${ICON_CLOSE}</button>
      </div>
      <div id="viewOptsRoot"></div>
    </div>
  </div>
  <div id="toolStatsOverlay" class="hidden">
    <div id="toolStatsPanel">
      <div id="toolStatsHead">
        <span id="toolStatsTitle">工具调用耗时</span>
        <span class="ts-spacer"></span>
        <button id="toolStatsClose" type="button" title="关闭" aria-label="关闭">${ICON_CLOSE}</button>
      </div>
      <div id="toolStatsBody"></div>
    </div>
  </div>
${bodyBottom}${scriptTags}
</body>
</html>`;
}

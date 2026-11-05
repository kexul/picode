/**
 * renderHtml —— 生成聊天界面 HTML 骨架。
 *
 * 导出 renderHTML(opts)：生成聊天界面 HTML。
 * 聊天 DOM 结构 + CSS + 脚本位次在此定义；调用方通过 opts 注入 CSP、
 * chat.css（文本或地址，面板内联、浏览器页面外链）、脚本清单（外链或内联）、额外 head/body。
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
    /** chat.css 的文本内容（供内联用；给了 chatCssHref 时不用它）。 */
    chatCss?: string;
    /** chat.css 的地址（浏览器页面走外链：地址带内容指纹，浏览器能单独把它存一年）。 */
    chatCssHref?: string;
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

/**
 * 输入框顶边上那条：左边跑着时的状态图（等 / 写 / 想 / 工具，单独一格，不跑时收掉），
 * 中间一条用量横杠（填到哪儿就是用了多少），右端切出一个口子写这一轮的生成速度（不跑时这格收掉，
 * 横杠就铺到右头）。整条就画在盒子的顶边框上：不跑、没速度的时候看着就是一条普通边框。
 * 颜色（正常 / 黄 / 红）、提示文字都在 chat.js 里管。
 */
function ctxTopMarkup(): string {
    return `      <div id="ctxTop" aria-hidden="true">` +
        `<span class="ct-cell"><span id="ctxAct" class="ct-act"></span></span>` +
        `<span id="ctxBar"><span class="ct-fill"></span></span>` +
        `<span id="ctxTps"></span>` +
        `</div>\n`;
}

/**
 * 输入框底下那颗胶囊：当前模型名（点它弹模型选择器）。
 * 用量横杠与生成速度现在在盒子顶边上（见上面的 ctxTopMarkup），这里只管名字。
 * 长相（颜色、略、提示文字、点击切模型）都在 chat.css / chat.js 里管。
 */
function modelChipMarkup(): string {
    return `        <button id="ctxIcon" type="button" data-st="loading" title="加载中…" aria-label="当前模型（点击切换）">` +
        `<span class="ci-name"></span>` +
        `</button>\n`;
}

export function renderHTML(opts: RenderHTMLOpts): string {
    const nonceAttr = opts.scriptNonce ? ` nonce="${opts.scriptNonce}"` : "";
    const scriptTags = opts.scripts
        .map((s) => s.src !== undefined
            ? `\n  <script${nonceAttr} src="${s.src}"></script>`
            : `\n  <script${nonceAttr}>${s.content ?? ""}</script>`)
        .join("");

    const head = opts.extraHead ? `  ${opts.extraHead}\n` : "";
    // 主样式：浏览器页面给地址（<link>，地址带内容指纹、浏览器能长期存下这份 154 KB），
    // 面板没有可引的资源地址，只能整份内联。它必须排在 extraHead 里那份主题样式前面
    //（主题只补颜色，页面那些规则得先到位）。
    const styleTag = opts.chatCssHref
        ? `<link rel="stylesheet" href="${opts.chatCssHref}" />\n`
        : `<style>\n${opts.chatCss ?? ""}\n</style>\n`;
    // 顶条：中间一排会话格（一格一个主会话，点一下就切过去；挤了就收窄、叠起来，见 chat.js 的 layoutSessionTabs），
    // 右边几颗网页端按钮（左边那颗文件侧边栏开关只有浏览器页面里有，由 browserBridge.js 插在最前头）。
    // 「新建会话」那颗加号在输入框底下那条小横排里，见下面的 #composer。
    // 骨架里先摆当前这一格，其余由 chat.js 按会话列表补上（见 renderSessionTabs）。
    // 会话跑在哪个目录不放顶条上（太挤）：在每格的悬停提示里。
    // 这一格先藏着（hidden）：一个会话都没有时它会孤零零挂在顶条中间、底下那条“当前”的
    // 下划线看着像一条莫名其妙的白/蓝线（骨架里没名字，谁都指不出它是什么）。
    // 真开了会话，chat.js 把它拿去做第一格时会把 hidden 摘掉（见 sessionTabEl）。
    const sessionBar =
    `  <div id="sessionBar">\n` +
    `    <div id="sessionCenter">\n` +
    `      <div id="sessionTabs">\n` +
    `        <button id="sessionName" class="sn-tab current hidden" title="当前会话" aria-label="当前会话">\n` +
    `          <span class="sn-mark"><span class="sn-dot"></span><span class="sn-count"></span></span>\n` +
    `          <span class="sn-text"></span>\n` +
    `        </button>\n` +
    `      </div>\n` +
    `    </div>\n` +
    `    <div id="sessionBarTail">\n` +
    `    </div>\n` +
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
${styleTag}${head}</head>
<body>
${bodyTop}${chatColumnOpen}${sessionBar}  <div id="messages">
    <button id="jumpBottom" class="hidden" title="跳到最新" aria-label="跳到最新">${ICON_ARROW_DOWN}</button>
    <!-- 一个会话都没有时（刚打开页面、或者刚把最后几个关掉）摆在消息流中间的那块提示：
         告诉人去「项目与会话」里挑一个工作区开新会话、或者点开一条历史会话。
         有会话看着时藏起来（见 chat.js 的 syncNoSessionHint）。 -->
    <div id="noSessionHint" class="hidden">
      <div class="nsh-title">还没有会话</div>
      <div class="nsh-text">在右边的「项目与会话」里挑一个工作区开新会话，或者点开一条历史会话。</div>
    </div>
  </div>
  <div id="inputArea">
    <div id="queueBar" class="hidden"></div>
    <div id="imgPreview"></div>
    <!-- 输入那个圆角大盒子（#composer）：上半是打字的地方，下半一条小横排（#inputRow）。
         横排里从左到右：新建会话那颗加号、当前模型那颗胶囊（只有模型名，点它切模型）、
         「你说过的话」（最后那颗由 chat.js 挂进来）。
         上下文用量那条跑到盒子的顶边上了（见 modelChipMarkup），不再占横排。 -->
    <div id="composer">
      <div id="fileMenu" class="hidden"></div>
      <!-- rows=1：autoResize 把 height 设回 auto 时，textarea 的高度由 rows 决定
           （不写默认两行），网页端那个起步高度是靠 --pichat-input-min-height 顶出来的，
           真被 rows 定成两行的话清空以后也回不下去 -->
      <textarea id="input" rows="1"></textarea>
${ctxTopMarkup()}      <div id="inputRow">
        <button id="newSessionBtn" title="新建会话 (Ctrl+Alt+N)" aria-label="新建会话">${ICON_ADD}</button>
${modelChipMarkup()}      </div>
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
    <div id="pickerPanel" class="pk-panel" tabindex="-1">
      <div id="pickerHeader" class="pk-header"><span id="pickerTitle" class="pk-header-title">选择</span></div>
      <div id="pickerSubtitle" class="pk-subtitle hidden"></div>
      <div id="pickerSearchWrap" class="pk-search-wrap hidden"><input id="pickerSearch" class="pk-search" type="text" placeholder="筛选…" autocomplete="off" spellcheck="false" /></div>
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
      <div id="settingsTabBar" class="hidden"></div>
      <div id="viewOptsRoot"></div>
    </div>
  </div>
  <div id="toolStatsOverlay" class="hidden">
    <div id="toolStatsPanel">
      <div id="toolStatsHead">
        <span id="toolStatsTitle" title="只算这次打开页面之后跑过的调用（刷新页面从头再算）；同一时刻并行跑的几条各算各的，合计会比实际过去的时间多。">工具调用耗时</span>
        <span class="ts-spacer"></span>
        <button id="toolStatsClose" type="button" title="关闭" aria-label="关闭">${ICON_CLOSE}</button>
      </div>
      <div id="toolStatsBody"></div>
    </div>
  </div>
  <div id="envOverlay" class="hidden">
    <div id="envPanel">
      <div id="envHead">
        <span id="envTitle" title="清单由会话里的 pi 报上来，几秒更新一次；MCP 只认得出连上了几个工具。">工具</span>
        <span class="ts-spacer"></span>
        <button id="envClose" type="button" title="关闭" aria-label="关闭">${ICON_CLOSE}</button>
      </div>
      <div id="envBody"></div>
    </div>
  </div>
${bodyBottom}${scriptTags}
</body>
</html>`;
}

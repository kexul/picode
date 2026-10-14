// @ts-nocheck
/**
 * browserBridge —— 界面桥：补上"chat.js 认的 VSCode 网页视图通道"，并带上网页端那套界面件。
 * 一份代码跑在两种页面里：
 *  1. 网页服务的页面（手机 / 电脑浏览器，有 meta[name="pichat-page"]）：
 *     通道整个换成网页服务——出去的消息按顺序 POST /api，进来的消息从 /events
 *     （浏览器原生的推送流）收；重连、心跳、断线补发都归它管。
 *  2. 插件里的对话面板（与浏览器页面同源的那份界面，由 chatHtml.ts 加载）：
 *     通道保持网页视图的 postMessage 不变（chat.js 感觉不到），只取三样：
 *     网页端的界面件（桌面截图 / <<< / 输入框角上的「停止生成」）、
 *     一行起步的输入框、按配置上色（显示选项里的「界面颜色」，浅 / 深两套调色板见下面）。
 *
 * chat.js 认的是 VSCode 网页视图那套通道：往外发用 acquireVsCodeApi().postMessage，
 * 往里收靠 window 上的 message 事件。本文件必须比 chat.js 先加载（chat.js 一开头
 * 就调用 acquireVsCodeApi）。
 *
 * ---- 手机上的情况（网页模式里一半的代码都是为它写的）----
 * 页面退到后台，系统会把这条挂着不动的连接掐掉，页面里的定时器也一起冻住；回到前台时
 * 冻住的定时器全醒过来，几条消息挤着往外发。所以：
 *   - 重连自己管（不信浏览器自己那次重连：它要等一会儿，手机回到前台后还常常一直卡在
 *     “正在连接”不动）。出错就关掉重开，回到前台 / 网络恢复 / 从冻结里醒来时立刻重开。
 *   - 回到前台（页面从后台回来）时，只要在外头待过几秒，就把连接重开一次，不管它看着
 *     死没死：锁屏期间连接常常是悄悄断的（运营商把会话收掉），浏览器却还当成“已连接”，
 *     最后那几下心跳也早在手里——看着一切正常，这期间的消息其实全丢了。页面只在重连
 *     时跟插件对账（补发漏掉的消息 + 一份最新的会话列表），不重开就会一直卡在旧状态上
 *     （比如会话早跑完了，界面上还显示着“正在输出”）。
 *   - 靠插件每 25 秒发来的心跳判断连接是不是“看着还在、其实已经死了”（手机换过网络之后
 *     常见）。浏览器对这种连接是不报错的，只能自己数着心跳。心跳断到 75 秒就重开兜底。
 *   - 插件推来的每条实时消息都带一个递增的序号（seq），页面记着自己处理到第几条。
 *     每次重新连上都把这个数报给插件（消息类型 browserResync），插件把断线这段时间
 *     漏掉的消息按序号补发过来：一条不缺就什么都不动（界面、输入框草稿都保持原样），
 *     缺几条就补几条，页面上消息接着往下长；缺得太多补不上时插件才整屏重画一遍。
 *     刚加载的那一次不用报：chat.js 跑完自己会报一声 ready，插件那边照样整屏画一遍。
 *   - 每 25 秒报一次活（channelPing），回到前台立刻再报一次。插件那头超过 90 秒收不到
 *     报活就把这条连接收掉，免得往一个没人读的连接里白攒消息。
 *
 * 几个页面（手机 + 电脑）可以同时连着，谁都不会把谁顶掉：插件推的消息发给每个页面，
 * 只有确认框、选项浮层发给"人最近在里面动过"的那一个。
 */
(function () {
  "use strict";

  // VSCode 网页视图里本来就有 acquireVsCodeApi（而且只能取一次）；网页里没有，由本文件补一份。
  var IN_WEBVIEW = typeof window.acquireVsCodeApi === "function";

  // 顶条最右边那两颗按钮的图标：相机那个是 VSCode 官方 codicon（@vscode/codicons 包），
  // fill=currentColor 跟随文字色，尺寸由 browserTheme.css 控制。
  var ICON_CAMERA = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M11 8C11 9.65685 9.65685 11 8 11C6.34315 11 5 9.65685 5 8C5 6.34315 6.34315 5 8 5C9.65685 5 11 6.34315 11 8ZM10 8C10 6.89543 9.10457 6 8 6C6.89543 6 6 6.89543 6 8C6 9.10457 6.89543 10 8 10C9.10457 10 10 9.10457 10 8ZM6.61803 2C6.04988 2 5.53048 2.321 5.27639 2.82918L4.69098 4H4C2.89543 4 2 4.89543 2 6V11C2 12.1046 2.89543 13 4 13H12C13.1046 13 14 12.1046 14 11V6C14 4.89543 13.1046 4 12 4H11.309L10.7236 2.82918C10.4695 2.321 9.95012 2 9.38197 2H6.61803ZM6.17082 3.27639C6.25552 3.107 6.42865 3 6.61803 3H9.38197C9.57135 3 9.74448 3.107 9.82918 3.27639L10.5528 4.72361C10.6375 4.893 10.8106 5 11 5H12C12.5523 5 13 5.44772 13 6V11C13 11.5523 12.5523 12 12 12H4C3.44772 12 3 11.5523 3 11V6C3 5.44772 3.67157 5 4 5H5C5.18939 5 5.36252 4.893 5.44721 4.72361L6.17082 3.27639Z"/></svg>';
  // 菜单按钮（项目与会话）的图标：三根往左的尖角（面板从右边滑出来，尖角指进去）。
  // 为什么不直接用 codicon：官方那套里没有三层尖括号（只有单个的 chevron-left）。
  // 自己画三根，笔画风格跟 codicon 的箭头一致（细笔画 + 圆头）。
  var ICON_MENU_LEFT = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.7 3.6 3.2 8l3.5 4.4"/><path d="M10.1 3.6 6.6 8l3.5 4.4"/><path d="M13.5 3.6 10 8l3.5 4.4"/></svg>';

  // ==================== 界面颜色（显示选项里的「界面颜色」） ====================
  // 网页里没有 VSCode 注入主题变量，这里自己补两套调色板：浅色照 VSCode 浅色主题
  //（Light Modern）的取值，深色照深色主题（Dark Modern）的取值。写死不跟随主题，
  // 两边（插件里 / 浏览器里）看到的颜色才一致。插件面板里 VSCode 注入的变量会被
  // body 上的行内变量盖过（仅限调色板里有的那些键，其余仍跟随主题）。
  // 代码高亮：浅色给 One Light 的取值；深色不覆盖——chat.css 默认那套就是深底用的 One Dark。
  var FONT_STACK = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';
  var CODE_FONT_STACK = 'Consolas, "Cascadia Code", "JetBrains Mono", Menlo, monospace';
  var LIGHT_VARS = {
    "--vscode-font-family": FONT_STACK,
    "--vscode-editor-font-family": CODE_FONT_STACK,
    "--vscode-font-size": "13px",
    "--vscode-foreground": "#1f1f1f",
    "--vscode-editor-foreground": "#1f1f1f",
    "--vscode-editor-background": "#ffffff",
    "--vscode-descriptionForeground": "#5f5f5f",
    "--vscode-errorForeground": "#e51400",
    "--vscode-focusBorder": "#0090f1",
    "--vscode-panel-border": "#e5e5e5",
    "--vscode-widget-border": "#d4d4d4",
    "--vscode-menu-border": "#d4d4d4",
    "--vscode-button-background": "#007acc",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#026ec1",
    "--vscode-button-border": "transparent",
    "--vscode-button-secondaryBackground": "#e8e8e8",
    "--vscode-button-secondaryForeground": "#1f1f1f",
    "--vscode-button-secondaryHoverBackground": "#d6d6d6",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#1f1f1f",
    "--vscode-input-border": "#cecece",
    "--vscode-dropdown-background": "#ffffff",
    "--vscode-dropdown-border": "#cecece",
    "--vscode-checkbox-background": "#ffffff",
    "--vscode-checkbox-foreground": "#1f1f1f",
    "--vscode-checkbox-border": "#cecece",
    "--vscode-list-hoverBackground": "#e8e8e8",
    "--vscode-list-activeSelectionBackground": "#0060c0",
    "--vscode-list-activeSelectionForeground": "#ffffff",
    "--vscode-menu-background": "#f8f8f8",
    "--vscode-menu-foreground": "#1f1f1f",
    "--vscode-menu-selectionBackground": "#0060c0",
    "--vscode-editorWidget-background": "#f8f8f8",
    "--vscode-editorInfo-background": "#f8f8f8",
    "--vscode-editorWarning-foreground": "#bf8803",
    "--vscode-toolbar-hoverBackground": "#e8e8e8",
    "--vscode-badge-background": "#c4c4c4",
    "--vscode-badge-foreground": "#333333",
    "--vscode-textCodeBlock-background": "#f4f4f4",
    "--vscode-textLink-foreground": "#006ab1",
    "--vscode-textPreformat-foreground": "#a31515",
    "--vscode-scrollbarSlider-background": "rgba(100, 100, 100, 0.4)",
    "--vscode-scrollbarSlider-hoverBackground": "rgba(75, 75, 75, 0.7)",
    "--vscode-diffEditor-insertedLineBackground": "rgba(155, 185, 85, 0.28)",
    "--vscode-diffEditor-removedLineBackground": "rgba(255, 0, 0, 0.16)",
    "--vscode-charts-blue": "#2b7cd3",
    "--vscode-charts-green": "#4b9c4b",
    "--vscode-charts-purple": "#9762b5",
    "--vscode-charts-yellow": "#bf8803",
    "--vscode-gitDecoration-addedResourceForeground": "#587c0c",
    "--vscode-gitDecoration-deletedResourceForeground": "#ad0707",
    "--hl-keyword": "#a626a4",
    "--hl-func": "#4078f2",
    "--hl-num": "#986801",
    "--hl-str": "#50a14f",
    "--hl-built": "#c18401",
    "--hl-comment": "#a0a1a7",
    "--hl-tag": "#e45649",
    "--hl-section": "#4078f2",
    "--hl-bullet": "#986801",
    "--hl-base": "#1f1f1f"
  };
  var DARK_VARS = {
    "--vscode-font-family": FONT_STACK,
    "--vscode-editor-font-family": CODE_FONT_STACK,
    "--vscode-font-size": "13px",
    "--vscode-foreground": "#cccccc",
    "--vscode-editor-foreground": "#cccccc",
    "--vscode-editor-background": "#1f1f1f",
    "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-errorForeground": "#f14c4c",
    "--vscode-focusBorder": "#0078d4",
    "--vscode-panel-border": "#2b2b2b",
    "--vscode-widget-border": "#313131",
    "--vscode-menu-border": "#454545",
    "--vscode-button-background": "#0078d4",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#026ec1",
    "--vscode-button-border": "transparent",
    "--vscode-button-secondaryBackground": "#313131",
    "--vscode-button-secondaryForeground": "#cccccc",
    "--vscode-button-secondaryHoverBackground": "#3c3c3c",
    "--vscode-input-background": "#313131",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-input-border": "#3c3c3c",
    "--vscode-dropdown-background": "#313131",
    "--vscode-dropdown-border": "#3c3c3c",
    "--vscode-checkbox-background": "#313131",
    "--vscode-checkbox-foreground": "#cccccc",
    "--vscode-checkbox-border": "#3c3c3c",
    "--vscode-list-hoverBackground": "#2a2d2e",
    "--vscode-list-activeSelectionBackground": "#04395e",
    "--vscode-list-activeSelectionForeground": "#ffffff",
    "--vscode-menu-background": "#1f1f1f",
    "--vscode-menu-foreground": "#cccccc",
    "--vscode-menu-selectionBackground": "#04395e",
    "--vscode-editorWidget-background": "#1f1f1f",
    "--vscode-editorInfo-background": "#1f1f1f",
    "--vscode-editorWarning-foreground": "#cca700",
    "--vscode-toolbar-hoverBackground": "#2a2d2e",
    "--vscode-badge-background": "#4d4d4d",
    "--vscode-badge-foreground": "#ffffff",
    "--vscode-textCodeBlock-background": "#292929",
    "--vscode-textLink-foreground": "#4daafc",
    "--vscode-textPreformat-foreground": "#ce9178",
    "--vscode-scrollbarSlider-background": "rgba(121, 121, 121, 0.4)",
    "--vscode-scrollbarSlider-hoverBackground": "rgba(100, 100, 100, 0.7)",
    "--vscode-diffEditor-insertedLineBackground": "rgba(21, 130, 87, 0.4)",
    "--vscode-diffEditor-removedLineBackground": "rgba(204, 21, 21, 0.25)",
    "--vscode-charts-blue": "#3b8eea",
    "--vscode-charts-green": "#3d9463",
    "--vscode-charts-purple": "#b180d7",
    "--vscode-charts-yellow": "#cca700",
    "--vscode-gitDecoration-addedResourceForeground": "#81b88b",
    "--vscode-gitDecoration-deletedResourceForeground": "#c74e39"
  };

  var appliedVarKeys = [];
  var themeStyleEl = null;

  /**
   * 按配置上色。
   * 行内写在 body 上（压得过 VSCode 注入的主题变量，两边的颜色才一致）；
   * 同时维护一个 <style id="pichat-theme-vars">：导出会话时 chat.js 只抓 <style> 里的
   * 内容，颜色也要跟着进导出的 HTML。
   */
  function applyTheme(mode) {
    var vars = mode === "dark" ? DARK_VARS : LIGHT_VARS;
    for (var i = 0; i < appliedVarKeys.length; i++) {
      document.body.style.removeProperty(appliedVarKeys[i]);
    }
    appliedVarKeys = [];
    var cssText = "";
    for (var name in vars) {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) { continue; }
      document.body.style.setProperty(name, vars[name]);
      appliedVarKeys.push(name);
      cssText += name + ":" + vars[name] + ";";
    }
    if (!themeStyleEl) {
      themeStyleEl = document.createElement("style");
      themeStyleEl.id = "pichat-theme-vars";
      document.head.appendChild(themeStyleEl);
    }
    themeStyleEl.textContent = ":root{" + cssText + "}";
    document.documentElement.style.colorScheme = mode;
  }

  var metaTheme = document.querySelector('meta[name="pichat-theme"]');
  applyTheme(metaTheme && metaTheme.getAttribute("content") === "dark" ? "dark" : "light");

  // ==================== 出站：往插件发消息 ====================
  var chain = Promise.resolve();
  /** 连续发不出去几次（连上就清零），到 6 次就把提示换成"连不上插件"（网页模式用）。 */
  var sendFailures = 0;

  function enqueue(msg) {
    if (IN_WEBVIEW) {
      // 网页视图的 postMessage 本来就保序可靠，直接发
      realApi.postMessage(msg);
      return;
    }
    chain = chain.then(function () { return post(msg, 1); }).catch(function () { /* 单条失败不影响后续 */ });
  }

  // ==================== 入站：两处页面都要自己拦的消息 ====================

  /** 两处页面都要自己接的消息：界面颜色跟随、桌面截图。 */
  function inspectIncoming(data) {
    var type = data && data.type;
    // 桌面截图：两颗按钮（浏览器页面与插件里的对话面板）都挂，图推回来也只有这里能接。
    // chat.js 不认识这两个类型，转发给它等于什么都不发生（插件面板以前就是这样：
    // 按钮压暗一会儿自己弹回来，图永远不出来）。
    if (type === "desktopScreenshot") { showDesktopScreenshot(data); return true; }
    if (type === "desktopScreenshotResult") { handleDesktopScreenshotResult(data); return true; }
    if (type === "viewOptions" && data.themeMode) {
      applyTheme(data.themeMode === "dark" ? "dark" : "light");
    }
    return false;
  }

  // ==================== chat.js 认的接口 ====================
  var apiState = null;
  var apiInstance = null;
  var realApi = null;

  if (IN_WEBVIEW) {
    // 先把真的接口取过来（每个网页视图只许取一次），之后 chat.js 调到的都是这份包装。
    realApi = window.acquireVsCodeApi();
    window.acquireVsCodeApi = function () {
      if (apiInstance) {
        return apiInstance;
      }
      apiInstance = {
        postMessage: function (msg) { enqueue(msg); },
        getState: function () { return realApi.getState(); },
        setState: function (value) { return realApi.setState(value); },
      };
      return apiInstance;
    };
    // 入站：插件发来的消息本来就是 window 的 message 事件，chat.js 自己会收；
    // 这里只拦需要处理的那几类（界面颜色、对话框），不转发（转发就重复了）。
    window.addEventListener("message", function (ev) {
      var d = ev.data;
      if (d && typeof d === "object") { inspectIncoming(d); }
    });
  } else {
    window.acquireVsCodeApi = function () {
      if (apiInstance) {
        console.warn("[pi-chat] acquireVsCodeApi 被调用了多次，返回同一个对象。");
        return apiInstance;
      }
      apiInstance = {
        postMessage: function (msg) { enqueue(msg); },
        getState: function () { return apiState; },
        setState: function (value) { apiState = value; return value; },
      };
      return apiInstance;
    };
  }

  // ============================================================================
  //  以下只有网页模式的页面用：重连、心跳、断线补发、提示条
  // ============================================================================

  /** 页面标识：服务在送出页面时写进来的。服务靠它认出"这条连接是哪一个页面的"。 */
  var pageId = "";
  var query = "";
  // ==================== 几个时间（与 webChatServer.ts 里的常量对得上） ====================
  /** 插件发心跳（tick）的间隔。 */
  var HEARTBEAT_MS = 25000;
  /** 连着丢三个心跳还没见到，就认定这条连接已经死了（看着还在，其实收不到任何东西）。 */
  var TICK_TIMEOUT_MS = HEARTBEAT_MS * 3;
  /** 页面报活的间隔：比插件判"死了"的那个上限（90 秒）短得多，正常情况绝不会被误判。 */
  var PING_MS = 25000;
  /** 多久检查一次"连接是不是其实已经死了"。 */
  var WATCHDOG_MS = 5000;
  /** 重连等待阶梯（毫秒）：头几次快，之后固定在 8 秒。一直试下去，不认输。 */
  var RETRY_DELAYS_MS = [400, 800, 1500, 3000, 8000];
  /** 连续失败到第几次就把提示换成"连不上插件"（后台仍在照着重试）。 */
  var GIVE_UP_BANNER_AT = 6;

  if (!IN_WEBVIEW) {
    var meta = document.querySelector('meta[name="pichat-page"]');
    pageId = meta ? meta.getAttribute("content") || "" : "";
    if (!pageId) {
      pageId = "p-fallback-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    }
    query = "pageId=" + encodeURIComponent(pageId);
  }

  /**
   * 发一条消息给插件（网页模式：POST /api）。
   * 发不出去就一直重试；只有服务明确回了"不认识这个页面"（409，多半是插件重启过）
   * 或"来源不被接受"（403）才认输。
   */
  function post(msg, attempt) {
    return fetch("/api?" + query, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg === undefined ? null : msg),
    }).then(function (resp) {
      if (resp.status === 409) {
        giveUp("插件不认识这个页面了（插件可能重启过，或这个页面开了太久）。", true);
        return;
      }
      if (resp.status === 403) {
        giveUp("插件不接受这个页面的请求（请求来源被拦），请重新打开页面。", true);
        return;
      }
      if (!resp.ok) { console.warn("[pi-chat] 发给插件失败：HTTP " + resp.status); }
      sendFailures = 0;
      hideBanner();
    }).catch(function () {
      sendFailures += 1;
      if (sendFailures >= GIVE_UP_BANNER_AT) {
        bannerText("连不上插件（服务可能已停止）。还在自动重试，也可以刷新页面。", true);
      } else {
        bannerText("与插件的连接中断，正在重试…", false);
      }
      var delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      return sleep(delay)
        .then(function () { return document.hidden ? waitVisible() : undefined; })
        .then(function () { return post(msg, attempt + 1); });
    });
  }

  /** 页面报活：单独发，不排在消息队列后面（队列被堵住时也要能报上活）。 */
  function ping() {
    if (stopped) { return; }
    fetch("/api?" + query, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"type":"channelPing"}',
    }).then(function (resp) {
      if (resp.status === 409) { giveUp("插件不认识这个页面了（插件可能重启过）。", true); }
    }).catch(function () { /* 报活失败不要紧：重连那条路会发现 */ });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /** 等到页面回到前台（手机退到后台时定时器会被冻住，别在那儿白等）。 */
  function waitVisible() {
    if (!document.hidden) { return Promise.resolve(); }
    return new Promise(function (resolve) {
      var on = function () {
        if (document.visibilityState === "visible") {
          document.removeEventListener("visibilitychange", on);
          resolve();
        }
      };
      document.addEventListener("visibilitychange", on);
    });
  }

  // ==================== 入站：推送流 ====================
  // 消息序号：插件推来的每条实时消息都带一个递增的 seq（一次性消息如确认框也带，但不补发）。
  // 页面记着三本账：
  //   lastSeq        处理过的最大序号；重连时报给插件的就是它（插件从这里往后补）。
  //   liveFromSeq    本条连接的“实时消息从这个序号起”，来自连接建立时插件发来的 hello。
  //                  比它大的是这条连接的实时消息，不大于它的是补回来的漏掉的消息。
  //   catchUpThrough 补发补到第几条了。hello 时从 lastSeq 起步，补一条进一条；
  //                  插件在补完后（或整屏重画后）发 syncPoint 把它和 lastSeq 一起对齐。
  //                  补发和重连重试可能重叠，靠它把补过的丢掉，消息才不会重复两遍。
  var lastSeq = 0;
  var liveFromSeq = 0;
  var catchUpThrough = 0;

  var source = null;
  /** 服务明确说了再见（服务停了）：不再重连，只给用户一条带刷新按钮的提示。 */
  var stopped = false;
  /** 连上过至少一次：之后每次重新连上都要报一次账，请插件把漏掉的消息补发过来。 */
  var openedOnce = false;
  var retryIndex = 0;
  var retryTimer = null;
  var lastTickAt = Date.now();
  var pingTimer = null;
  var watchdogTimer = null;

  function dispatch(data) {
    var type = data && data.type;
    if (inspectIncoming(data)) { return; }
    if (type === "hello") {
      // 连接建立：先于一切带序号的消息到达（插件那头保证顺序）。
      liveFromSeq = typeof data.seq === "number" ? data.seq : 0;
      catchUpThrough = lastSeq;
      return;
    }
    if (type === "syncPoint") {
      // 插件说“到这里为止你都有全的”（补发完 / 整屏重画完）：账本对齐到这个位置。
      if (typeof data.seq === "number") {
        if (data.seq > lastSeq) { lastSeq = data.seq; }
        if (data.seq > catchUpThrough) { catchUpThrough = data.seq; }
      }
      return;
    }
    if (data && typeof data.seq === "number") {
      if (data.seq > liveFromSeq) {
        // 这条连接的实时消息：按序号来，只来一次，记下进度。
        if (data.seq > lastSeq) { lastSeq = data.seq; }
      } else if (data.seq <= catchUpThrough) {
        return;   // 补发里跟已收到过的重叠（重连重试会这样）：丢掉
      } else {
        // 断线期间漏掉、这会儿补回来的：照常往下接。进度记进补发那本账（重连重试的
        // 补发可能重叠，靠它去重）；lastSeq 也跟着走，它是“处理过的最大序号”，
        // 下次重连报的就是它。
        catchUpThrough = data.seq;
        if (data.seq > lastSeq) { lastSeq = data.seq; }
      }
    }
    // 其余消息一律按 VSCode 网页视图的样子投给 window，chat.js 那边照原样处理
    window.dispatchEvent(new MessageEvent("message", { data: data }));
  }

  function connect() {
    if (stopped) { return; }
    clearRetryTimer();
    closeSource();
    lastTickAt = Date.now();
    var mine;
    try {
      mine = new EventSource("/events?" + query);
    } catch (e) {
      console.warn("[pi-chat] 推送连接建不起来：", e);
      scheduleReconnect("与插件的连接中断，正在重连…");
      return;
    }
    source = mine;
    mine.addEventListener("msg", function (ev) {
      if (source !== mine) { return; }
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      dispatch(data);
    });
    mine.addEventListener("tick", function () {
      if (source !== mine) { return; }
      lastTickAt = Date.now();   // 心跳到了：这条连接是活的
    });
    mine.addEventListener("end", function (ev) {
      var note = "";
      try { note = (JSON.parse(ev.data) || {}).note || ""; } catch (e) { note = ev.data || ""; }
      giveUp(note || "与插件的连接已结束。", true);
    });
    mine.onerror = function () {
      if (stopped || source !== mine) { return; }
      // 浏览器自己那次重连不指望：它慢，手机回到前台后还常常一直卡在"正在连接"
      scheduleReconnect("与插件的连接中断，正在重连…");
    };
    mine.onopen = function () {
      if (source !== mine) { return; }
      retryIndex = 0;
      sendFailures = 0;
      lastTickAt = Date.now();
      hideBanner();
      ping();
      // 刚打开的那一次不用报账：chat.js 加载完自己会报一声 ready，插件那边照样整屏画一遍。
      // 之后每次重新连上都报一次“我处理到第几条”，插件把断线期间漏掉的消息补发过来。
      // 这个数在报的瞬间定格：断线期间漏掉的序号比这条连接上后来的实时消息小，
      // 不能被它们推高，否则补发范围就算错了。
      if (openedOnce) { enqueue({ type: "browserResync", lastSeq: lastSeq }); }
      openedOnce = true;
    };
  }

  function closeSource() {
    if (!source) { return; }
    var mine = source;
    source = null;
    try { mine.close(); } catch (e) { /* 已经关了 */ }
  }

  /** 排一次重连。@param text 顺手给用户一条提示（null 表示不动提示条）。 */
  function scheduleReconnect(text) {
    if (stopped || retryTimer) { return; }   // 已经排着了，别排两次
    closeSource();
    if (retryIndex >= GIVE_UP_BANNER_AT) {
      bannerText("连不上插件（服务可能已停止）。还在自动重试，也可以刷新页面。", true);
    } else if (text) {
      bannerText(text, false);
    }
    var delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryIndex += 1;
    retryTimer = setTimeout(function () { retryTimer = null; connect(); }, delay);
  }

  function clearRetryTimer() {
    if (!retryTimer) { return; }
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  /** 立刻重连一次：不等等待阶梯（回到前台、网络恢复、从"往返缓存"里取回来时用）。 */
  function reconnectNow() {
    if (stopped) { return; }
    retryIndex = 0;
    sendFailures = 0;
    clearRetryTimer();
    connect();
  }

  /**
   * 定时检查连接是不是"看着还在、其实已经死了"。
   * 手机换过网络（Wi-Fi 切流量）之后常见这种状态：浏览器不报错，也什么都收不到。
   */
  function watch() {
    if (stopped) { return; }
    if (!source) {
      // 手上没有连接：要么正在等重连，要么压根丢了（比如唤醒时没接上），补一次
      if (!retryTimer && openedOnce) { scheduleReconnect(null); }
      return;
    }
    if (source.readyState === EventSource.CLOSED) {
      // 浏览器自己已经放弃了：自己接上
      scheduleReconnect("与插件的连接已关闭，正在重连…");
      return;
    }
    if (source.readyState !== EventSource.OPEN) { return; }  // 正在连的路上：交给重连那条路管
    if (Date.now() - lastTickAt > TICK_TIMEOUT_MS) {
      console.warn("[pi-chat] 有一阵子没收到插件的心跳，重连一次。");
      scheduleReconnect("与插件的连接中断，正在重连…");
    }
  }

  /**
   * 回前台时，“在外头待过这么久”就干脆把连接重开一次（不管它看着死没死）。
   *
   * 为什么要按“离开了多久”而不是只看连接死没死：手机锁屏期间那条连接往往已经
   * 悄悄断了，浏览器却还当成“已连接”，回来时最后几下心跳也早在手里，看着一切正常。
   * 不重开的话，断线那段时间的消息（包括“这一轮跑完了”）就永远收不到，界面卡在
   * 旧状态上，要等“75 秒没收到心跳”的看门狗才发现。重开一次必然带来一次对账，
   * 界面不闪、草稿不丢。
   * 几秒钟以内来回切（切一下别的标签页）不重开：那点时间连接基本不会断，少折腾。
   */
  var HIDDEN_RESYNC_MS = 3000;
  /** 页面是什么时候躲到后头的（0 = 现在在台上）。锁屏、切后台、被系统冻住时记上。 */
  var hiddenAt = 0;

  /** 记下“从这会儿起不在台上了”。已经记着就不动（重复的事件不改时间点）。 */
  function markHidden() {
    if (!hiddenAt) { hiddenAt = Date.now(); }
  }

  /** 回到前台 / 网络恢复 / 从冻结里醒来：先报到一声，再看这条连接值不值得接着信。 */
  function wake() {
    if (stopped) { return; }
    ping();
    var awayMs = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (awayMs >= HIDDEN_RESYNC_MS
      || !source || source.readyState !== EventSource.OPEN
      || Date.now() - lastTickAt > TICK_TIMEOUT_MS) {
      reconnectNow();
    }
  }

  function stopTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    clearRetryTimer();
  }

  function startTimers() {
    if (!pingTimer) { pingTimer = setInterval(ping, PING_MS); }
    if (!watchdogTimer) { watchdogTimer = setInterval(watch, WATCHDOG_MS); }
  }

  // ==================== 提示条 ====================
  var bannerEl = null;

  function ensureBanner() {
    if (bannerEl) { return bannerEl; }
    bannerEl = document.createElement("div");
    bannerEl.style.cssText =
      "position:fixed;left:0;right:0;top:0;z-index:99999;display:flex;gap:10px;align-items:center;" +
      "justify-content:center;padding:8px 12px;text-align:center;" +
      "font:13px/1.4 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;" +
      "color:#fff;background:#8a2b12;box-shadow:0 1px 6px rgba(0,0,0,.45)";
    document.body.appendChild(bannerEl);
    return bannerEl;
  }

  /**
   * 提示条。
   * @param withReload 带一个"刷新页面"按钮。它只是多给一条出路，不是"就此收手"：
   *                   后台还在自动重试，连上了提示条自己会消失（只有 giveUp 才真的停手）。
   */
  function bannerText(text, withReload) {
    var el = ensureBanner();
    el.textContent = text;
    if (withReload) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "刷新页面";
      btn.style.cssText =
        "padding:2px 10px;border-radius:3px;border:1px solid rgba(255,255,255,.55);" +
        "background:transparent;color:#fff;cursor:pointer;font:inherit";
      btn.addEventListener("click", function () { location.reload(); });
      el.appendChild(btn);
    }
    el.style.display = "flex";
  }

  function hideBanner() {
    if (bannerEl) { bannerEl.style.display = "none"; }
  }

  /** 不再自动重连（服务停了 / 插件不认识这个页面了）：给一条带刷新按钮的提示。 */
  function giveUp(text, withReload) {
    if (stopped) { return; }
    stopped = true;
    stopTimers();
    closeSource();
    bannerText(text, withReload !== false);
  }

  // ==================== 桌面截图 ====================
  // 顶条上的“📷”按钮：请插件截一张这台电脑的桌面（可能就是本机，
  // 也可能是你在手机浏览器里看的这台开发机），截好推回来全屏显示。
  // 消息由插件那头的 ChatViewProvider 接：
  //   requestDesktopScreenshot → desktopScreenshot（图片 base64）/ desktopScreenshotResult（失败）。
  // 推回来的这两条在 inspectIncoming 里接（两种页面都走那儿），别只挂在下面的
  // dispatch 上：那条路只有网页端走。
  var shotBtn = null;
  var shotBusyTimer = null;

  /** 截屏从点击到图推回来要一两秒：期间按钮压暗并暂时点不动。 */
  function setShotBusy(busy) {
    if (shotBusyTimer) { clearTimeout(shotBusyTimer); shotBusyTimer = null; }
    if (!shotBtn) { return; }
    if (busy) { shotBtn.classList.add("busy"); } else { shotBtn.classList.remove("busy"); }
  }

  /** 全屏显示推回来的截图，点任意处关闭（复用 chat.css 里 .lightbox 那套看图样式）。 */
  function showDesktopScreenshot(data) {
    setShotBusy(false);
    var base64 = data && typeof data.data === "string" ? data.data : "";
    if (!base64) { return; }
    var overlay = document.createElement("div");
    overlay.className = "lightbox";
    var img = document.createElement("img");
    img.alt = "桌面截图";
    img.src = "data:" + (data && typeof data.mimeType === "string" && data.mimeType ? data.mimeType : "image/png") + ";base64," + base64;
    overlay.appendChild(img);
    overlay.addEventListener("click", function () {
      if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
    });
    document.body.appendChild(overlay);
  }

  /** 截图失败：按钮还原，弹一句原因。 */
  function handleDesktopScreenshotResult(data) {
    setShotBusy(false);
    var error = data && typeof data.error === "string" && data.error ? data.error : "桌面截图失败。";
    window.alert(error);
  }

  function requestDesktopScreenshot() {
    if (shotBtn && shotBtn.classList.contains("busy")) { return; }   // 上一张还没回来，别连点
    setShotBusy(true);
    // 截屏迟迟没有回音（插件那头卡住了）：过一会儿放开按钮，允许再点一次
    shotBusyTimer = setTimeout(function () { setShotBusy(false); }, 25000);
    enqueue({ type: "requestDesktopScreenshot" });
  }

  // ==================== 顶栏最右边的“📷”与“<<<”两颗按钮 ====================
  // 都挂在 #sessionBarTail 里（顶层会话条的最右边）：
  //  - 📷：把开发机的桌面截一张发回页面看（手机上常用）；
  //  - <<<：点它让“项目与会话”列表从右侧滑进来（消息由后端的 ChatHost 接）：
  //    最上面是“浏览文件夹…”与当前目录，下面是用 pi 跑过会话的其它项目；
  //    点一个项目进去就是那个项目的会话列表。
  (function () {
    var bar = document.getElementById("sessionBarTail");
    if (!bar) { return; }
    shotBtn = document.createElement("button");
    shotBtn.type = "button";
    shotBtn.id = "browserScreenshotBtn";
    shotBtn.innerHTML = ICON_CAMERA;
    shotBtn.title = "查看桌面截图（截的是运行 VSCode 的这台电脑）";
    shotBtn.addEventListener("click", requestDesktopScreenshot);
    bar.appendChild(shotBtn);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "browserMenuBtn";
    btn.innerHTML = ICON_MENU_LEFT;
    btn.title = "项目与会话";
    // 窗口够宽时它是常驻那一列的开 / 关（点一下收起、再点一下展开，记在这台设备里），
    // 窄窗照旧是“弹一次抽屉”。两套都由 chat.js 管（那边知道该走哪套），
    // 这里只在它还没装好时退回老行为（刚打开那一瞬）。
    btn.addEventListener("click", function () {
      var sidebar = window.pichatSidebar;
      if (sidebar && typeof sidebar.toggle === "function") { sidebar.toggle(); return; }
      enqueue({ type: "openWorkspace" });
    });
    bar.appendChild(btn);
  })();

  // ==================== 输入框的小改动 ====================
  // 输入框右下角那颗“停止生成”：生成中露面（显示与隐藏由 chat.js 按当前会话的状态控制，
  // 那边会来找 #stopBtn）。手机没有 Esc，否则中止不了（VSCode 里本来也有 Esc，不冲突）。
  // （会话闲着时那条「继续」不在这里 —— 它长在消息流末尾，由 chat.js 自己建，
  //   见那边 syncContinueHint 的说明。）
  // 插件里的对话面板配上它之后与浏览器页面完全一致。
  (function () {
    var row = document.getElementById("inputRow");
    if (!row) { return; }
    var stop = document.createElement("button");
    stop.type = "button";
    stop.id = "stopBtn";
    stop.className = "hidden";
    // 实心方块直接表达“停止”，不再套一层描边方框。
    stop.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">' +
      '<rect x="2" y="2" width="12" height="12" rx="1.5" />' +
      '</svg>';
    stop.title = "停止生成";
    stop.setAttribute("aria-label", "停止生成");
    row.appendChild(stop);
  })();

  if (!IN_WEBVIEW) {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") { wake(); } else { markHidden(); }
    });
    // 整页被收走（往前翻一页、手机把标签页冻起来）也算离开，回来时照样重开一次
    window.addEventListener("pagehide", markHidden);
    // 页面生命周期事件（安卓那边的浏览器有）：冻住之后醒过来算回前台，
    // 只醒过来没报“回前台”的（冻住时不发 visibilitychange 的那种）也靠它记上
    document.addEventListener("freeze", markHidden);
    document.addEventListener("resume", wake);
    window.addEventListener("online", wake);
    // 从"往返缓存"里整页取回来：连接其实全是死的，直接重连
    window.addEventListener("pageshow", function (ev) {
      if (ev.persisted) { hiddenAt = 0; reconnectNow(); }
    });

    startTimers();
    connect();
  }
})();

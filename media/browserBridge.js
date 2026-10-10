// @ts-nocheck
/**
 * browserBridge —— 浏览器里的消息通道（只在网页服务送出来的那份页面里加载）。
 *
 * chat.js 认的是 VSCode 网页视图那套通道：往外发用 acquireVsCodeApi().postMessage，
 * 往里收靠 window 上的 message 事件。这个文件把两头接到网页服务上，chat.js 因此
 * 一行都不用改：
 *   - 提供 window.acquireVsCodeApi()；
 *   - 出去的消息按顺序用 POST /api 发（排队，不让并行请求打乱顺序）；
 *   - 进来的消息从 /events（浏览器原生的推送流）收，转成 window 的 message 事件；
 *   - 插件要的确认框 / 输入框在这里用浏览器原生对话框实现，结果发回插件；
 *   - 界面底部的按钮条补几个按钮（VSCode 里这些按钮在面板标题栏上，浏览器里没有）。
 *
 * 必须比 chat.js 先加载（chat.js 开头就会调用 acquireVsCodeApi）。
 * 依赖：无，只用浏览器自带的 EventSource 与 fetch。
 *
 * ---- 手机上的情况（这个文件里一半的代码都是为它写的）----
 * 页面退到后台，系统会把这条挂着不动的连接掐掉，页面里的定时器也一起冻住；回到前台时
 * 冻住的定时器全醒过来，几条消息挤着往外发。所以：
 *   - 重连自己管（不信浏览器自己那次重连：它要等一会儿，手机回到前台后还常常一直卡在
 *     “正在连接”不动）。出错就关掉重开，回到前台 / 网络恢复 / 从冻结里醒来时立刻重开。
 *   - 靠插件每 25 秒发来的心跳判断连接是不是“看着还在、其实已经死了”（手机换过网络之后
 *     常见）。浏览器对这种连接是不报错的，只能自己数着心跳。
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

  var meta = document.querySelector('meta[name="pichat-page"]');
  // 页面标识：服务在送出页面时写进来的。服务靠它认出"这条连接是哪一个页面的"；
  // 从没见过的标识（服务重启前的旧页面）会被回绝（409），那时只能刷新页面。
  var pageId = meta ? meta.getAttribute("content") || "" : "";
  if (!pageId) {
    pageId = "p-fallback-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  var query = "pageId=" + encodeURIComponent(pageId);

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

  // ==================== 对外：假装成 VSCode 的网页视图接口 ====================
  // chat.js 用这个标记分辫自己跑在网页里还是 VSCode 网页视图里
  // （必须在 chat.js 加载前就位，chat.js 一开头就读它）。
  window.pichatBrowser = true;
  var apiState;
  var apiInstance;
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

  // ==================== 出站：排队发送，保顺序 ====================
  var chain = Promise.resolve();
  /** 连续发不出去几次（连上就清零），到 GIVE_UP_BANNER_AT 就把提示换成"连不上插件"。 */
  var sendFailures = 0;

  function enqueue(msg) {
    chain = chain.then(function () { return post(msg, 1); }).catch(function () { /* 单条失败不影响后续 */ });
  }

  /**
   * 发一条消息给插件。
   *
   * 发不出去就一直重试（等待阶梯见 RETRY_DELAYS_MS）；页面在后台时不空转，等回到前台再试。
   * 只有服务明确回了"不认识这个页面"（409，多半是插件重启过）或"来源不被接受"（403）才认输。
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
    if (type === "browserDialog") { handleDialog(data); return; }
    if (type === "desktopScreenshot") { showDesktopScreenshot(data); return; }
    if (type === "desktopScreenshotResult") { handleDesktopScreenshotResult(data); return; }
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

  /** 插件要的确认框 / 输入框：用浏览器原生对话框，结果发回去。 */
  function handleDialog(d) {
    var value;
    if (d.kind === "prompt") {
      var label = [d.title || "", d.placeholder || ""].filter(Boolean).join("\n");
      value = window.prompt(label || "请输入", d.prefill || "");
    } else {
      var text = [d.title || "", d.message || ""].filter(Boolean).join("\n\n");
      value = window.confirm(text || "是否继续？");
    }
    enqueue({ type: "browserDialogResult", id: d.id, value: value === undefined ? null : value });
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

  /** 回到前台 / 网络恢复 / 从冻结里醒来：先报到一声，再看连接还活着没有。 */
  function wake() {
    if (stopped) { return; }
    ping();
    if (!source || source.readyState !== EventSource.OPEN || Date.now() - lastTickAt > TICK_TIMEOUT_MS) {
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

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { wake(); }
  });
  window.addEventListener("online", wake);
  // 从"往返缓存"里整页取回来：连接其实全是死的，直接重连
  window.addEventListener("pageshow", function (ev) {
    if (ev.persisted) { reconnectNow(); }
  });
  // 页面生命周期事件（安卓那边的浏览器有）：冻住之后醒过来
  document.addEventListener("resume", wake);

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
  // 标签栏顶部的“📷”按钮：请插件截一张这台电脑的桌面（可能就是本机，
  // 也可能是你在手机浏览器里看的这台开发机），截好推回来全屏显示。
  // 消息由插件那头的 browserChatController.ts 接：
  //   requestDesktopScreenshot → desktopScreenshot（图片 base64）/ desktopScreenshotResult（失败）。
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

  // ==================== 顶部标签栏最右边的“⋯”菜单 ====================
  // 历史会话 / 设置都收进这一颗（VSCode 里这些在面板标题栏上，
  // 网页端没有标题栏；消息由插件侧的浏览器工作区 browserChatController.ts 接，
  // 点开的是界面自带的那个浮层选择器）。
  // 标签栏平时只有一个标签时是藏着的，网页端要常显，否则这颗按钮没地方放。
  // 顺带的好处：新建标签的那颗“+”也一直可见可点。
  (function () {
    var bar = document.getElementById("tabBar");
    if (!bar) { return; }
    bar.classList.remove("hidden");
    shotBtn = document.createElement("button");
    shotBtn.type = "button";
    shotBtn.id = "browserScreenshotBtn";
    shotBtn.textContent = "📷";
    shotBtn.title = "查看桌面截图（截的是运行 VSCode 的这台电脑）";
    shotBtn.addEventListener("click", requestDesktopScreenshot);
    bar.appendChild(shotBtn);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "browserMenuBtn";
    btn.textContent = "⋯";
    btn.title = "更多操作：历史会话 / 设置";
    btn.addEventListener("click", function () { enqueue({ type: "openBrowserMenu" }); });
    bar.appendChild(btn);
  })();

  // ==================== 网页端的输入框小改动 ====================
  // 1) 提示语去掉键盘说明：手机上既没有 Enter / Shift+Enter，也用不上 @ / # / 斜杠那几套。
  // 2) 生成中在输入框右下角露出一颗“停止生成”图标：手机没有 Esc，否则中止不了。
  //    这颗图标什么时候显示由 chat.js 按当前 tab 是否在生成控制（那边会来找 #stopBtn）。
  (function () {
    var input = document.getElementById("input");
    if (input) { input.placeholder = "与 pi 对话…"; }
    var row = document.getElementById("inputRow");
    if (!row) { return; }
    var stop = document.createElement("button");
    stop.type = "button";
    stop.id = "stopBtn";
    stop.className = "hidden";
    stop.textContent = "■";
    stop.title = "停止生成";
    stop.setAttribute("aria-label", "停止生成");
    row.appendChild(stop);
  })();

  startTimers();
  connect();
})();

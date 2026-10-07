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
 */
(function () {
  "use strict";

  var meta = document.querySelector('meta[name="pichat-page"]');
  // 页面标识：服务在送出页面时写进来的。服务靠它认出“当前是哪一个页面”，
  // 被顶掉的页面再发消息会被回绝（409）。
  var pageId = meta ? meta.getAttribute("content") || "" : "";
  if (!pageId) {
    pageId = "p-fallback-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  var query = "pageId=" + encodeURIComponent(pageId);

  // ==================== 对外：假装成 VSCode 的网页视图接口 ====================
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
  function enqueue(msg) {
    chain = chain.then(function () { return post(msg, 1); }).catch(function () { /* 单条失败不影响后续 */ });
  }

  /** 发一条消息给插件。连不上时重发，最多 attempt 次；仍失败就提示用户刷新。 */
  function post(msg, attempt) {
    return fetch("/api?" + query, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg === undefined ? null : msg),
    }).then(function (resp) {
      if (resp.status === 409) { takenOverByNewerPage(); return; }
      if (resp.status === 403) { permanent("插件不接受这个页面的请求（可能插件重启过，或请求来源被拦），请重新打开页面。", true); return; }
      if (!resp.ok) { console.warn("[pi-chat] 发给插件失败：HTTP " + resp.status); }
    }).catch(function () {
      if (attempt >= 5) { permanent("连不上插件（服务可能已停止）。"); return; }
      bannerText("与插件的连接中断，正在重试…", false);
      return new Promise(function (resolve) { setTimeout(resolve, 1000 * attempt); })
        .then(function () { return post(msg, attempt + 1); });
    });
  }

  // ==================== 入站：推送流 ====================
  var source = null;
  var stopped = false;

  function dispatch(data) {
    var type = data && data.type;
    if (type === "browserDialog") { handleDialog(data); return; }
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
    source = new EventSource("/events?" + query);
    source.addEventListener("msg", function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      dispatch(data);
    });
    source.addEventListener("end", function (ev) {
      var note = "";
      try { note = (JSON.parse(ev.data) || {}).note || ""; } catch (e) { note = ev.data || ""; }
      stopped = true;
      closeSource();
      permanent(note || "与插件的连接已结束。", true);
    });
    source.onerror = function () {
      if (stopped || !source) { return; }
      if (source.readyState === EventSource.CONNECTING) { bannerText("与插件的连接中断，正在重连…", false); }
      else { permanent("与插件的连接已关闭，请刷新页面。", true); }
    };
    source.onopen = function () { hideBanner(); };
  }

  function closeSource() {
    if (!source) { return; }
    try { source.close(); } catch (e) { /* 已经关了 */ }
    source = null;
  }

  // ==================== 提示条 ====================
  var bannerEl = null;
  var bannerTimer = null;

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

  /** 临时提示（自动消失）或带"刷新"按钮的常驻提示。 */
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
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
  }

  function hideBanner() {
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    if (bannerEl) { bannerEl.style.display = "none"; }
  }

  function permanent(text, withReload) {
    stopped = true;
    closeSource();
    bannerText(text, withReload !== false);
  }

  function takenOverByNewerPage() {
    permanent("此页面已被新打开的 Pi Chat 页面接管。", true);
  }

  // ==================== 底部按钮条补按钮 ====================
  // VSCode 里"分支 / 历史 / 设置"这些按钮在面板标题栏上；浏览器里没有标题栏，
  // 所以补到底部的按钮条上（那条里原本只有一个"⑂ 分支"按钮）。
  // 这些消息由插件侧的浏览器工作区（browserChatController.ts）接。
  function addBarButton(label, title, onClick) {
    var bar = document.getElementById("bottomBar");
    if (!bar) { return; }
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    if (title) { btn.title = title; }
    btn.addEventListener("click", onClick);
    bar.appendChild(btn);
  }

  addBarButton("🤖 模型", "切换模型（与 VSCode 里同一个选择器）", function () { enqueue({ type: "pickModel" }); });
  addBarButton("🕘 历史会话", "打开这台机器上的 pi 历史会话，选一个接着聊", function () { enqueue({ type: "openHistory" }); });
  addBarButton("📤 导出", "把当前会话存成文件（在 VSCode 里选保存位置）", function () { enqueue({ type: "exportConversation" }); });
  addBarButton("⚙ 设置", "模型配置与显示选项", function () { enqueue({ type: "openSettingsPanel" }); });

  connect();
})();

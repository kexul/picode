// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages"); // 容器，内含各 .tab-pane
  const jumpBottomBtn = document.getElementById("jumpBottom");
  const inputEl = document.getElementById("input");
  const imgPreviewEl = document.getElementById("imgPreview");
  const fileMenuEl = document.getElementById("fileMenu");
  const changedFilesEl = document.getElementById("changedFiles");
  const queueBarEl = document.getElementById("queueBar");
  const tabBarInner = document.getElementById("tabBarInner");
  const tabBarEl = document.getElementById("tabBar");
  const newTabBtn = document.getElementById("newTabBtn");
  newTabBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "newSession" });
  });
  let multiTab = false; // 收到 tabList / 带 tabId 的消息后置 true，显示 tab 栏

  // ---- tab（容器）/ panel 本地状态（后端 tabList 消息驱动）----
  // tabs map = panel（会话）渲染状态；tabViews map = tab（容器）布局与焦点。
  const tabViews = new Map();   // tabId -> { id, name, root, focusPanelId }
  let activeTabId = null;       // 活跃 tab（容器）id
  let layoutSig = "";           // 当前渲染的布局签名（变化时重建布局 DOM）
  const tabDrafts = new Map();  // tabId -> { text, selStart, selEnd, height }（输入草稿按 tab 存）
  const maximized = new Map();  // tabId -> panelId（双击 pane-head 最大化，纯前端临时态）
  let draggingPanelId = null;   // 正在拖拽的 panel id

  function enterMultiTab() {
    if (multiTab) { return; }
    multiTab = true;
    tabBarEl.classList.remove("hidden");
  }
  function ensureDefaultTab() {
    if (tabs.size === 0) {
      const st = createTab("default", "对话");
      activeId = "default";
      reflectTabUI();
    } else if (!activeId) {
      activeId = tabs.keys().next().value;
    }
    return activeTab();
  }

  // ---- 分支树浮层（全局，瞬时）----
  const treeOverlay = document.getElementById("treeOverlay");
  const treeBody = document.getElementById("treeBody");

  // ---- 通用拾取器浮层（模型 / 历史）----
  const pickerOverlay = document.getElementById("pickerOverlay");
  const pickerBody = document.getElementById("pickerBody");
  const pickerTitle = document.getElementById("pickerTitle");
  const pickerSearch = document.getElementById("pickerSearch");
  const pickerSearchWrap = document.getElementById("pickerSearchWrap");
  const pickerFooter = document.getElementById("pickerFooter");
  let pickerState = null; // { kind, items, filtered, sel, current, draftModel, draftThinking, toggle }

  function hideTree() { treeOverlay.classList.add("hidden"); }
  document.getElementById("treeBtn").addEventListener("click", () => {
    const tab = activeTab();
    if (tab) { vscode.postMessage({ type: "showTree", tabId: tab.id }); }
  });

  // ==================== Markdown / 文件链接 / 符号链接（纯函数，与 tab 无关）====================
  let markedReady = false;
  // 当前 highlight.js 是精简 bundle，只内置了 C++ / TypeScript / Python / plaintext。
  // 常见的 javascript/json 标签可安全按 TypeScript（JS 的超集）处理；未知标签则保持
  // 普通文本，但不能因此让整块代码继承一套固定的灰色基色。
  const HIGHLIGHT_LANGUAGE_ALIASES = Object.freeze({
    javascript: "typescript",
    ecmascript: "typescript",
    node: "typescript",
    nodejs: "typescript",
    json: "typescript",
    jsonc: "typescript",
  });
  function resolveHighlightLanguage(hljs, lang) {
    const label = String(lang || "").trim().toLowerCase().split(/\s+/)[0] || "";
    const normalized = label.replace(/^language[-_:]/, "");
    const candidate = HIGHLIGHT_LANGUAGE_ALIASES[normalized] || normalized;
    return candidate && hljs.getLanguage(candidate) ? candidate : "";
  }
  function ensureMarkedHighlight() {
    if (markedReady) { return; }
    markedReady = true;
    const { hljs, markedHighlight } = globalThis.hljsBundle || {};
    if (!hljs || !markedHighlight) { return; }
    marked.use(markedHighlight({
      langPrefix: "hljs language-",
      highlight(code, lang) {
        try {
          const language = resolveHighlightLanguage(hljs, lang);
          if (language) {
            return hljs.highlight(code, { language }).value;
          }
          return hljs.highlight(code, { language: "plaintext" }).value;
        } catch { return code; }
      }
    }));
  }

  const KNOWN_EXT = new Set([
    "js","jsx","mjs","cjs","ts","tsx","mts","cts",
    "json","json5","jsonc","css","scss","sass","less","styl",
    "html","htm","xhtml","md","mdx","markdown","rst","tex",
    "py","pyi","pyw","rb","go","rs","java","c","h","cc","cpp","cxx","hpp","hxx","cs","php","swift","kt","kts","scala","clj","cljs","cljc","edn","hs","lhs","ml","mli","fs","fsx","fsi","elm","ex","exs","erl","gleam","dart","lua","pl","pm","tcl","r","jl",
    "sh","bash","zsh","fish","bat","cmd","ps1","psm1","vim","awk",
    "vue","svelte","astro",
    "yml","yaml","toml","xml","svg","plist","resx",
    "sql","graphql","gql","proto","thrift","capnp",
    "txt","text","diff","patch","csv","tsv",
    "png","jpg","jpeg","gif","webp","ico","bmp","tiff","avif",
    "wasm","vsix","crx","jar","class","war","ear",
    "tar","gz","zip","7z","rar","bz2","xz",
    "gradle","sbt","rake","gemspec",
    "csproj","vbproj","fsproj","vcxproj","sln","props","targets",
    "dockerfile","containerfile","makefile","cmake","ninja",
  ]);
  const FILE_RE = /^((?:[\w@-]+\/)*[\w@-]+(?:\.[A-Za-z][\w-]*)+)(?::(\d+))?(?::(\d+))?$/;
  function lastExt(p) { const i = p.lastIndexOf("."); return i < 0 ? "" : p.slice(i + 1).toLowerCase(); }
  function isFilePathlike(path) { return KNOWN_EXT.has(lastExt(path)); }
  function escHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  // LSP 符号集合（provider 推送）：命中的反引号文本渲染成可点击符号链接。
  let symbolNames = new Set();
  function symbolLinkHTML(name, inner) {
    return `<a class="symbol-link" href="#" data-symbol="${escHtml(name)}">${inner != null ? inner : escHtml(name)}</a>`;
  }
  function fileLinkHTML(path, line, col, inner) {
    const da = escHtml(path);
    const tail = line ? ":" + line + (col ? ":" + col : "") : "";
    const dl = line ? ` data-line="${line}"` : "";
    const dc = col ? ` data-col="${col}"` : "";
    return `<a class="file-link" href="#" data-file="${da}"${dl}${dc}>${inner != null ? inner : escHtml(path) + tail}</a>`;
  }
  let fileLinkReady = false;
  function ensureFileLink() {
    if (fileLinkReady || typeof marked === "undefined") { return; }
    fileLinkReady = true;
    marked.use({
      extensions: [{
        name: "filelink",
        level: "inline",
        start(src) { const m = src.match(/[\w@-]*\/[\w@.-]*|\b[\w@-]*\.[A-Za-z]/); return m ? m.index : -1; },
        tokenizer(src) {
          const m = /^((?:[\w@-]+\/)*[\w@-]+(?:\.[A-Za-z][\w-]*)+)(?::(\d+))?(?::(\d+))?/.exec(src);
          if (!m) { return; }
          const path = m[1];
          if (!isFilePathlike(path)) { return; }
          return { type: "filelink", raw: m[0], path, line: m[2] ? parseInt(m[2], 10) : null, col: m[3] ? parseInt(m[3], 10) : null };
        },
        renderer(t) { return fileLinkHTML(t.path, t.line, t.col); },
      }],
      renderer: {
        codespan({ text }) {
          const m = FILE_RE.exec(text);
          if (m && isFilePathlike(m[1])) {
            const line = m[2] ? parseInt(m[2], 10) : null;
            const col = m[3] ? parseInt(m[3], 10) : null;
            const tail = line ? ":" + line + (col ? ":" + col : "") : "";
            return `<code>${fileLinkHTML(m[1], line, col, escHtml(m[1]) + tail)}</code>`;
          }
          if (symbolNames.has(text)) {
            return `<code>${symbolLinkHTML(text)}</code>`;
          }
          // 函数调用形态 Foo()：剥掉末尾括号后查符号集（显示保留原文，点击跳裸名）
          const callBare = text.replace(/\(\)$/, "");
          if (callBare !== text && symbolNames.has(callBare)) {
            return `<code>${symbolLinkHTML(callBare, escHtml(text))}</code>`;
          }
          return `<code>${escHtml(text)}</code>`;
        },
      },
    });
  }
  function renderInline(text) { ensureMarkedHighlight(); ensureFileLink(); return marked.parseInline(text, { gfm: true }); }
  function renderMarkdown(source) { ensureMarkedHighlight(); ensureFileLink(); return marked.parse(source, { breaks: true, gfm: true }); }

  const GEAR_SVG = '<span class="tool-icon"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M22.83,10.09 A11 11 0 0 1 22.83,13.91 L20.37,13.48 A8.5 8.5 0 0 1 18.96,16.88 A8.5 8.5 0 0 1 21.01,18.31 A11 11 0 0 1 18.31,21.01 L16.88,18.96 A8.5 8.5 0 0 1 13.48,20.37 A8.5 8.5 0 0 1 13.91,22.83 A11 11 0 0 1 10.09,22.83 L10.52,20.37 A8.5 8.5 0 0 1 7.12,18.96 A8.5 8.5 0 0 1 5.69,21.01 A11 11 0 0 1 2.99,18.31 L5.04,16.88 A8.5 8.5 0 0 1 3.63,13.48 A8.5 8.5 0 0 1 1.17,13.91 A11 11 0 0 1 1.17,10.09 L3.63,10.52 A8.5 8.5 0 0 1 5.04,7.12 A8.5 8.5 0 0 1 2.99,5.69 A11 11 0 0 1 5.69,2.99 L7.12,5.04 A8.5 8.5 0 0 1 10.52,3.63 A8.5 8.5 0 0 1 10.09,1.17 A11 11 0 0 1 13.91,1.17 L13.48,3.63 A8.5 8.5 0 0 1 16.88,5.04 A8.5 8.5 0 0 1 18.31,2.99 A11 11 0 0 1 21.01,5.69 L18.96,7.12 A8.5 8.5 0 0 1 20.37,10.52 Z"/><circle cx="12" cy="12" r="3.2"/></svg></span>';
  // 复制按钮图标：VS Code 官方 codicon copy 原始 path（fill 系图标，与 VS Code 界面同款）
  const COPY_SVG = '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M3 5V12.73C2.4 12.38 2 11.74 2 11V5C2 2.79 3.79 1 6 1H9C9.74 1 10.38 1.4 10.73 2H6C4.35 2 3 3.35 3 5ZM11 15H6C4.897 15 4 14.103 4 13V5C4 3.897 4.897 3 6 3H11C12.103 3 13 3.897 13 5V13C13 14.103 12.103 15 11 15ZM12 5C12 4.448 11.552 4 11 4H6C5.448 4 5 4.448 5 5V13C5 13.552 5.448 14 6 14H11C11.552 14 12 13.552 12 13V5Z"/></svg>';
  // 转发按钮图标：VS Code 官方 codicon share 原始 path（fill 系图标，与右上角 $(share) 按钮同款）
  const RELAY_SVG = '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M11.307 1.10533C11.1562 0.988085 10.9519 0.966945 10.7803 1.05085C10.6088 1.13475 10.5 1.30904 10.5 1.5V3.49274C10.4571 3.49456 10.4122 3.49701 10.3654 3.5002C9.96247 3.52766 9.41128 3.61105 8.82119 3.83704C8.11343 4.10809 7.34877 4.58508 6.72601 5.41126C6.10338 6.23727 5.64499 7.38259 5.50206 8.95474C5.48301 9.16438 5.5973 9.36351 5.78793 9.4528C5.97857 9.54209 6.20471 9.50241 6.35356 9.35356C7.54248 8.16464 8.72298 7.57773 9.59562 7.28685C9.9558 7.16679 10.2643 7.09693 10.5 7.0563V9C10.5 9.1969 10.6156 9.37546 10.7952 9.45612C10.9748 9.53678 11.185 9.50452 11.3322 9.37371L15.8322 5.37371C15.9432 5.27502 16.0046 5.13207 15.9997 4.98361C15.9949 4.83514 15.9242 4.69653 15.807 4.60533L11.307 1.10533ZM10.9429 4.49679L10.9457 4.49705C11.0865 4.51223 11.2279 4.46706 11.3335 4.37257C11.4394 4.27772 11.5 4.14223 11.5 4V2.52232L14.7186 5.02564L11.5 7.88658V6.5C11.5 6.22386 11.2762 6 11 6L10.9989 6L10.9976 6.00001L10.9943 6.00003L10.9848 6.00014L10.9552 6.00087C10.9307 6.00166 10.897 6.00316 10.8544 6.00599C10.7695 6.01166 10.6495 6.02268 10.4996 6.04409C10.1999 6.08691 9.77971 6.17139 9.2794 6.33816C8.55493 6.57965 7.66479 6.99299 6.7319 7.69863C6.9264 6.98158 7.2077 6.43355 7.52456 6.01319C8.01593 5.36132 8.61523 4.98675 9.17883 4.7709C9.65371 4.58903 10.1025 4.52044 10.4334 4.49788C10.5981 4.48666 10.7314 4.48699 10.8211 4.48988C10.866 4.49133 10.8997 4.49341 10.9209 4.49498L10.9429 4.49679ZM3.5 2C2.11929 2 1 3.11929 1 4.5V12.5C1 13.8807 2.11929 15 3.5 15H11.5C12.8807 15 14 13.8807 14 12.5V9.5C14 9.22386 13.7761 9 13.5 9C13.2239 9 13 9.22386 13 9.5V12.5C13 13.3284 12.3284 14 11.5 14H3.5C2.67157 14 2 13.3284 2 12.5V4.5C2 3.67157 2.67157 3 3.5 3H7.5C7.77614 3 8 2.77614 8 2.5C8 2.22386 7.77614 2 7.5 2H3.5Z"/></svg>';

  // ==================== 全局视图选项 ====================
  var sendKeyCombo = "enter";
  var newSessionKey = "ctrl+alt+n";
  var tabSwitchKey = "ctrl+alt+pgupdown";
  var notifyOnTurnEnd = true;
  var toolDisplayMode = "compact"; // compact=简洁标签 | medium=摘要标签 | full=TUI 风格卡片
  let openFiles = [];
  function applyFontSize(px) {
    var val = (typeof px === "string" && /^\d+$/.test(px)) ? px + "px" : "";
    [document.documentElement, document.body].forEach(function (el) { el.style[val ? "setProperty" : "removeProperty"]("--vscode-font-size", val); });
  }
  function applyViewOptions(opts) {
    if (typeof opts.fontSize === "string") { applyFontSize(opts.fontSize); }
    if (typeof opts.sendKey === "string") { sendKeyCombo = opts.sendKey; }
    if (typeof opts.newSessionKey === "string") { newSessionKey = opts.newSessionKey; }
    if (typeof opts.tabSwitchKey === "string") { tabSwitchKey = opts.tabSwitchKey; }
    notifyOnTurnEnd = opts.notifyOnTurnEnd !== false;
    if (opts.toolDisplay === "full" || opts.toolDisplay === "medium" || opts.toolDisplay === "compact") { toolDisplayMode = opts.toolDisplay; }
  }

  // ── 会话结束提示音（Web Audio 合成，无外部资源） ──
  var audioCtx = null;
  function playTurnEndBeep() {
    try {
      if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      if (audioCtx.state === "suspended") { audioCtx.resume(); }
      var ctx = audioCtx;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = 880;
      var t0 = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.15, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
      osc.start(t0);
      osc.stop(t0 + 0.26);
    } catch (e) { /* 忽略音频不可用 */ }
  }
  function isSendKey(e) {
    if (e.key !== "Enter") { return false; }
    switch (sendKeyCombo) {
      case "shift+enter": return e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
      case "alt+enter": return e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey;
      case "ctrl+enter": return e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      case "enter":
      default: return !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    }
  }

  function fmtNum(n) { if (n == null) return "0"; if (n >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"; return String(n); }

  // ---- 全局快捷键匹配（新建会话 / 切换会话）----
  function matchCombo(e, combo) {
    // combo 形如 "ctrl+alt+n"
    const mods = combo.split("+");
    const key = mods.pop().toLowerCase();
    const wantCtrl = mods.includes("ctrl");
    const wantAlt = mods.includes("alt");
    const wantShift = mods.includes("shift");
    const wantMeta = mods.includes("meta");
    let eKey = (e.key || "").toLowerCase();
    // 规整键名
    if (eKey === "[" && e.code === "BracketLeft") { /* keep */ }
    if (eKey === "]" && e.code === "BracketRight") { /* keep */ }
    if (e.ctrlKey !== wantCtrl) { return false; }
    if (e.altKey !== wantAlt) { return false; }
    if (e.shiftKey !== wantShift) { return false; }
    if (e.metaKey !== wantMeta) { return false; }
    return eKey === key;
  }
  // tabSwitchKey 方案 -> { prev: combo, next: combo }
  function tabSwitchCombos(scheme) {
    switch (scheme) {
      case "alt+brackets": return { prev: "alt+[", next: "alt+]" };
      case "ctrl+alt+brackets": return { prev: "ctrl+alt+[", next: "ctrl+alt+]" };
      case "ctrl+alt+pgupdown": return { prev: "ctrl+alt+pageup", next: "ctrl+alt+pagedown" };
      case "ctrl+alt+arrows":
      default: return { prev: "ctrl+alt+arrowleft", next: "ctrl+alt+arrowright" };
    }
  }
  document.addEventListener("keydown", (e) => {
    // 不与输入框/搜索框冲突：仅当焦点不在输入元素时处理这些快捷键
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    // 聚焦输入框（与编辑器/终端里的 Ctrl+Alt+I / Cmd+Alt+I 一致；webview 不会把此键冒泡给 VSCode，故在此本地处理）
    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && (e.key || "").toLowerCase() === "i") {
      e.preventDefault();
      inputEl.focus();
      return;
    }
    // 新建会话（含输入框聚焦时，组合键不会误触普通输入）
    if (matchCombo(e, newSessionKey)) {
      e.preventDefault();
      vscode.postMessage({ type: "newSession" });
      return;
    }
    if (tag === "INPUT" || tag === "TEXTAREA") {
      // Alt+ 类组合在输入框里也应允许（不输入字符）
      const combos = tabSwitchCombos(tabSwitchKey);
      if (matchCombo(e, combos.prev) || matchCombo(e, combos.next)) {
        e.preventDefault();
        const dir = matchCombo(e, combos.next) ? "next" : "prev";
        vscode.postMessage({ type: "switchTabByDirection", direction: dir });
      }
      return;
    }
    // 切换 tab
    const combos = tabSwitchCombos(tabSwitchKey);
    if (matchCombo(e, combos.prev)) { e.preventDefault(); vscode.postMessage({ type: "switchTabByDirection", direction: "prev" }); return; }
    if (matchCombo(e, combos.next)) { e.preventDefault(); vscode.postMessage({ type: "switchTabByDirection", direction: "next" }); return; }
  });

  // ==================== Tab 状态 ====================
  const tabs = new Map(); // id -> state
  let activeId = null;

  function activeTab() { return activeId ? tabs.get(activeId) : null; }

  function createTab(id, title) {
    let st = tabs.get(id);
    if (st) { return st; }
    const pane = document.createElement("div");
    pane.className = "tab-pane";
    pane.dataset.tabId = id;
    pane.innerHTML = '<div class="empty-hint">输入消息开始对话…</div>';
    // 不再直接挂到 #messages：由布局树渲染时挂进 layout-leaf
    pane.addEventListener("scroll", () => {
      if (!pane.isConnected) { return; }
      st.lastScrollTop = pane.scrollTop; // 滚动位置缓存：布局重建后恢复用
      if (st.programmaticScroll) { st.programmaticScroll = false; return; }
      const wasBottom = st.stickToBottom;
      st.stickToBottom = isNearBottomPane(st);
      if (wasBottom && !st.stickToBottom && st.lerpRafId) {
        cancelAnimationFrame(st.lerpRafId);
        st.lerpRafId = 0;
      }
      // 用户手动滚到底部：清掉新内容提示
      if (st.stickToBottom && st.hasNewContent) {
        st.hasNewContent = false;
        syncJumpBottom(st);
      }
    });
    st = {
      id,
      title: title || "新会话",
      paneEl: pane,
      currentAssistant: null,
      thinkingText: "",
      // 生成速度统计：本轮累计估算 token 数 / 起点时间；tps 为上一轮最终均值
      tps: undefined,
      tpsStart: 0,
      tpsTokens: 0,
      currentToolRow: null,
      pendingToolCards: new Map(),
      pendingToolTags: new Map(),
      pendingToolCardsFull: new Map(),
      streaming: false,
      activity: "idle",
      activityDetail: "",
      piReady: false,
      textDirty: false,
      rafId: 0,
      lastRenderAt: 0,
      stickToBottom: true,
      lerpRafId: 0,
      programmaticScroll: false,
      hasNewContent: false,
      modelId: "",
      provider: "",
      thinkingLevel: "",
      changedFiles: [],
      changedFilesExpanded: false,
      queuedSteering: [],
      pendingSteerRestore: null,
      // 非活跃时保存的输入状态（草稿已提升为 tab 级 tabDrafts，此处仅保留占位避免旧引用报错）
      inputText: "",
      inputSelectionStart: 0,
      inputSelectionEnd: 0,
      inputHeight: 144,
      autoLoadHinted: false,
    };
    tabs.set(id, st);
    ensurePaneHead(st);
    return st;
  }

  function hideEmptyHint(tab) {
    const hint = tab.paneEl.querySelector(".empty-hint");
    if (hint) { hint.remove(); }
  }

  // ==================== 滚动 ====================
  const BOTTOM_THRESHOLD = 40;
  function isNearBottomPane(tab) {
    return tab.paneEl.scrollHeight - tab.paneEl.scrollTop - tab.paneEl.clientHeight <= BOTTOM_THRESHOLD;
  }
  function lerpScrollStep(tab) {
    if (!tab.stickToBottom) { tab.lerpRafId = 0; return; }
    const target = tab.paneEl.scrollHeight - tab.paneEl.clientHeight;
    const cur = tab.paneEl.scrollTop;
    const diff = target - cur;
    if (Math.abs(diff) < 1) { tab.programmaticScroll = true; tab.paneEl.scrollTop = target; tab.lerpRafId = 0; return; }
    tab.programmaticScroll = true;
    tab.paneEl.scrollTop = cur + diff * 0.3;
    tab.lerpRafId = requestAnimationFrame(() => lerpScrollStep(tab));
  }
  function smoothScrollToBottom(tab) {
    // 只对挂载在 DOM 里的 pane（当前 tab 布局内的）追底
    if (!tab.paneEl.isConnected) { return; }
    if (!tab.stickToBottom) {
      // 用户不在底部，有新内容到来：标记并显示跳转提示
      tab.hasNewContent = true;
      syncJumpBottom(tab);
      return;
    }
    if (!tab.lerpRafId) { tab.lerpRafId = requestAnimationFrame(() => lerpScrollStep(tab)); }
  }
  function scrollToBottom(tab, force) {
    if (force || tab.stickToBottom) {
      if (tab.lerpRafId) { cancelAnimationFrame(tab.lerpRafId); tab.lerpRafId = 0; }
      tab.programmaticScroll = true;
      tab.paneEl.scrollTop = tab.paneEl.scrollHeight;
      tab.stickToBottom = true;
      tab.hasNewContent = false;
      syncJumpBottom(tab);
    }
  }
  // 用户主动接管滚动（滚轮/触屏/键盘向上）：立刻停掉 lerp 追底，交还控制权。
  // 流式中同步亮起“跳到最新”按钮；非流式不打扰（用户只是回看已结束的回复）。
  function userTookOverScroll(tab) {
    if (!tab.stickToBottom) { return; }
    tab.stickToBottom = false;
    if (tab.lerpRafId) { cancelAnimationFrame(tab.lerpRafId); tab.lerpRafId = 0; }
    if (tab.streaming) { tab.hasNewContent = true; syncJumpBottom(tab); }
  }
  // 控制“跳到最新”按钮显隐（仅活跃 tab 生效）
  function syncJumpBottom(tab) {
    if (!jumpBottomBtn) { return; }
    const show = tab.hasNewContent && !tab.stickToBottom && activeId === tab.id;
    jumpBottomBtn.classList.toggle("hidden", !show);
  }

  // ==================== 流式渲染节流 ====================
  function renderInterval(rawLen) {
    if (rawLen < 4000) return 0;
    if (rawLen < 16000) return 60;
    if (rawLen < 64000) return 150;
    return 300;
  }
  function isSelectingIn(el) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { return false; }
    const range = sel.getRangeAt(0);
    return !!(el && el.contains(range.startContainer));
  }
  function scheduleFlush(tab) { if (!tab.rafId) { tab.rafId = requestAnimationFrame(() => flushDeltas(tab)); } }
  function flushDeltas(tab) {
    tab.rafId = 0;
    const now = performance.now();
    if (tab.textDirty && tab.currentAssistant) {
      const raw = tab.currentAssistant.raw || "";
      const interval = renderInterval(raw.length);
      if (interval > 0 && now - tab.lastRenderAt < interval) {
        tab.rafId = requestAnimationFrame(() => flushDeltas(tab));
      } else if (activeId === tab.id && isSelectingIn(tab.currentAssistant.el)) {
        tab.rafId = requestAnimationFrame(() => flushDeltas(tab));
      } else {
        tab.currentAssistant.el.innerHTML = renderMarkdown(raw);
        tab.currentAssistant.el.dataset.raw = raw;
        tab.lastRenderAt = now;
        tab.textDirty = false;
      }
    }
    smoothScrollToBottom(tab);
  }
  function cancelFlush(tab) { if (tab.rafId) { cancelAnimationFrame(tab.rafId); tab.rafId = 0; } tab.textDirty = false; }
  function finalizeCurrentAssistant(tab) {
    cancelFlush(tab);
    if (tab.currentAssistant) {
      tab.currentAssistant.el.innerHTML = renderMarkdown(tab.currentAssistant.raw || "");
      tab.currentAssistant.el.dataset.raw = tab.currentAssistant.raw || "";
      smoothScrollToBottom(tab);
      tab.currentAssistant = null;
    }
  }

  // ==================== 消息 DOM ====================
  function countLines(text) { let n = 0; for (let i = 0; i < text.length; i++) { if (text.charCodeAt(i) === 10) { n++; } } return n + 1; }
  const LONG_MSG_PREVIEW_LINES = 5;
  const BIG_TEXT_LINES = 10;
  const BIG_TEXT_CHARS = 8000;
  function shouldFoldText(text) {
    if (typeof text !== "string" || !text) { return false; }
    if (text.length > BIG_TEXT_CHARS) { return true; }
    return countLines(text) > BIG_TEXT_LINES;
  }
  function makeLongTextBody(text) {
    const body = document.createElement("div");
    body.className = "long-msg";
    const pre = document.createElement("pre");
    const lines = text.split("\n");
    const total = lines.length;
    pre.textContent = lines.slice(0, LONG_MSG_PREVIEW_LINES).join("\n") + (total > LONG_MSG_PREVIEW_LINES ? "\n…" : "");
    body.appendChild(pre);
    if (total > LONG_MSG_PREVIEW_LINES) {
      const toggle = document.createElement("span");
      toggle.className = "lm-toggle";
      toggle.textContent = "展开全部（共 " + total + " 行）";
      let expanded = false;
      toggle.addEventListener("click", () => {
        expanded = !expanded;
        if (expanded) { pre.classList.add("full"); pre.textContent = text; toggle.textContent = "收起（共 " + total + " 行）"; }
        else { pre.classList.remove("full"); pre.textContent = lines.slice(0, LONG_MSG_PREVIEW_LINES).join("\n") + "\n…"; toggle.textContent = "展开全部（共 " + total + " 行）"; }
      });
      body.appendChild(toggle);
    }
    return body;
  }

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }

  function addPlain(tab, cls, role, text, entryId) {
    hideEmptyHint(tab);
    tab.currentToolRow = null;
    const div = document.createElement("div");
    div.className = "msg " + cls + " msg-enter";
    if (entryId) { div.dataset.entryId = entryId; }
    if (cls === "user") { div.dataset.raw = text || ""; }
    const content = text || "";
    if (cls === "user" && shouldFoldText(content)) {
      div.appendChild(makeLongTextBody(content));
    } else {
      const body = document.createElement("div");
      body.textContent = content;
      div.appendChild(body);
    }
    if (cls === "assistant") { attachCopyBtn(div, () => content); attachRelayBtn(div, () => content, tab); }
    tab.paneEl.appendChild(div);
    scrollToBottom(tab);
    return div.firstElementChild;
  }
  /** 给消息气泡右下角挂一个复制按钮（hover 时显示），getText 返回要复制的原文。 */
  function attachCopyBtn(div, getText) {
    const btn = document.createElement("button");
    btn.className = "msg-copy"; btn.type = "button"; btn.title = "复制回复";
    btn.innerHTML = COPY_SVG;
    btn.addEventListener("click", async () => {
      await copyToClipboard(getText() || "");
      btn.classList.add("copied"); btn.title = "已复制";
      setTimeout(() => { btn.classList.remove("copied"); btn.title = "复制回复"; }, 1500);
    });
    div.appendChild(btn);
  }

  /** 消息气泡的转发按钮：可挑任意历史回复转发到任意 panel。 */
  function attachRelayBtn(div, getText, tab) {
    const btn = document.createElement("button");
    btn.className = "msg-relay"; btn.type = "button"; btn.title = "转发到…（选择目标 panel）";
    btn.innerHTML = RELAY_SVG;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "relayOnce", fromTabId: tab.id, text: getText() || "" });
    });
    div.appendChild(btn);
  }

  function addMarkdown(tab, raw, entryId) {
    hideEmptyHint(tab);
    tab.currentToolRow = null;
    const div = document.createElement("div");
    div.className = "msg assistant msg-enter";
    if (entryId) { div.dataset.entryId = entryId; }
    const body = document.createElement("div");
    body.className = "md";
    body.dataset.raw = raw || "";
    body.innerHTML = renderMarkdown(raw || "");
    attachCopyBtn(div, () => body.dataset.raw || "");
    attachRelayBtn(div, () => body.dataset.raw || "", tab);
    div.appendChild(body);
    tab.paneEl.appendChild(div);
    scrollToBottom(tab);
    return body;
  }

  /** 画布跳转：滚到带 data-entry-id 的消息气泡。 */
  function scrollToEntry(tab, entryId) {
    if (!tab || !entryId || !tab.paneEl) { return false; }
    let el = null;
    const nodes = tab.paneEl.querySelectorAll(".msg[data-entry-id]");
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].dataset.entryId === entryId) { el = nodes[i]; break; }
    }
    if (!el) { return false; }
    tab.stickToBottom = false;
    try {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {
      el.scrollIntoView(true);
    }
    el.classList.add("entry-flash");
    setTimeout(() => { el.classList.remove("entry-flash"); }, 1600);
    return true;
  }
  function addTool(tab, toolName, argStr, toolCallId) {
    hideEmptyHint(tab);
    if (toolDisplayMode === "full") {
      addToolCard(tab, toolName, argStr, toolCallId);
      return;
    }
    // medium：每次调用独占一行；compact：同一轮的标签收拢进同一个 .tool-row
    if (toolDisplayMode === "medium" || !tab.currentToolRow) {
      tab.currentToolRow = document.createElement("div");
      tab.currentToolRow.className = "msg tool-row msg-enter";
      tab.paneEl.appendChild(tab.currentToolRow);
    }
    const tag = document.createElement("span");
    tag.className = "tool" + (toolCallId ? " running" : "");
    // medium：标签内嵌 TUI 式调用摘要（单行省略，title 悬浮见全文）；compact：齿轮 + 工具名
    if (toolDisplayMode === "medium") {
      const summary = buildMediumSummary(toolName, argStr);
      tag.classList.add("tool-medium");
      tag.appendChild(summary);
      tag.title = summary.textContent.trim() || toolName;
      tag._medium = true;
    } else {
      tag.insertAdjacentHTML("afterbegin", GEAR_SVG);
      tag.appendChild(document.createTextNode(" " + toolName));
    }
    // 简洁模式：标签默认只显示工具名；点击后展开为完整模式同款卡片（call+参数+结果）
    tag._toolName = toolName;
    tag._argStr = argStr;
    tag._resultText = "";
    tag._resultMeta = {};
    tag._isError = false;
    tag._done = !toolCallId; // 无 id 的静态调用无结果事件，按已完成处理
    tag.addEventListener("click", () => toggleCompactToolCard(tag));
    tab.currentToolRow.appendChild(tag);
    if (toolCallId) { tab.pendingToolTags.set(toolCallId, tag); }
    scrollToBottom(tab);
  }

  // ==================== 完整模式：TUI 风格工具卡片 ====================
  // 有定制调用行摘要的工具（与 pi TUI 一致），其余工具回退为加粗工具名 + pretty JSON 参数。
  const CUSTOM_CALL_TOOLS = new Set(["bash", "grep", "find", "ls", "read"]);
  const TOOL_PREVIEW_LINES = 6; // 结果预览行数（同 TUI BASH_PREVIEW_LINES +1，因底部截断标记更紧凑）

  function prettyJson(argStr) {
    try { return JSON.stringify(JSON.parse(argStr), null, 2); }
    catch { return argStr; }
  }
  function formatDur(ms) {
    const s = ms / 1000;
    if (s < 60) { return s.toFixed(1) + "s"; }
    const m = Math.floor(s / 60);
    const rs = Math.round(s % 60);
    return m + "m" + (rs ? rs + "s" : "");
  }
  /** 生成工具 call 行（对齐 TUI renderCall：加粗工具名 + accent pattern + 灰参数）。 */
  function buildToolCallEl(toolName, argStr) {
    const call = document.createElement("div");
    call.className = "tc-call";
    let a = null;
    try { a = argStr ? JSON.parse(argStr) : {}; } catch { a = null; }
    const span = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; call.appendChild(s); };
    const strArg = (key) => (a && typeof a[key] === "string" ? a[key] : undefined);
    switch (toolName) {
      case "bash":
        span("tc-call-name", "$ " + (strArg("command") || "..."));
        if (a && typeof a.timeout === "number") { span("tc-call-arg", " (timeout " + a.timeout + "s)"); }
        break;
      case "grep":
        span("tc-call-name", "grep");
        span("tc-call-param", " /" + (strArg("pattern") || "") + "/");
        span("tc-call-arg", " in " + (strArg("path") || "."));
        if (a && a.glob) { span("tc-call-arg", " (" + a.glob + ")"); }
        if (a && typeof a.limit === "number") { span("tc-call-arg", " limit " + a.limit); }
        break;
      case "find":
        span("tc-call-name", "find");
        span("tc-call-param", " " + (strArg("pattern") || ""));
        span("tc-call-arg", " in " + (strArg("path") || "."));
        if (a && typeof a.limit === "number") { span("tc-call-arg", " (limit " + a.limit + ")"); }
        break;
      case "ls":
        span("tc-call-name", "ls");
        span("tc-call-arg", " " + (strArg("path") || "."));
        if (a && typeof a.limit === "number") { span("tc-call-arg", " (limit " + a.limit + ")"); }
        break;
      case "read": {
        span("tc-call-name", "read");
        span("tc-call-arg", " " + (strArg("file_path") || strArg("path") || ""));
        const off = a && typeof a.offset === "number" ? a.offset : undefined;
        const lim = a && typeof a.limit === "number" ? a.limit : undefined;
        if (off !== undefined || lim !== undefined) {
          // 行范围：start = offset ?? 1，end = start + limit - 1（同 TUI formatReadLineRange）
          const start = off ?? 1;
          const end = lim !== undefined ? start + lim - 1 : start;
          span("tc-call-warn", " " + start + ":" + end);
        }
        break;
      }
      case "write":
      case "edit":
        span("tc-call-name", toolName);
        span("tc-call-arg", " " + (strArg("file_path") || strArg("path") || ""));
        break;
      default:
        span("tc-call-name", toolName);
    }
    return call;
  }

  /** 摘要模式：生成标签内的单行调用摘要。复用 buildToolCallEl 排版（inline 布局）；
   *  非定制工具兑底为“工具名 + 单行 JSON 参数”，超长交给 CSS 省略号。 */
  function buildMediumSummary(toolName, argStr) {
    const call = buildToolCallEl(toolName, argStr);
    call.className = "tc-inline";
    if (!CUSTOM_CALL_TOOLS.has(toolName) && toolName !== "write" && toolName !== "edit" && argStr) {
      let one = argStr;
      try { one = JSON.stringify(JSON.parse(argStr)); } catch { one = argStr.replace(/\s+/g, " "); }
      const s = document.createElement("span"); s.className = "tc-call-arg"; s.textContent = " " + one;
      call.appendChild(s);
    }
    return call;
  }

  /** write 参数区：内容预览（前 10 行，同 TUI formatWriteCall），超出可点击展开。 */
  function buildWritePreviewEl(argStr) {
    let a = null;
    try { a = argStr ? JSON.parse(argStr) : {}; } catch { a = null; }
    const content = a && typeof a.content === "string" ? a.content : "";
    if (!content) { return null; }
    const lines = content.split("\n");
    const total = lines.length;
    const MAX_LINES = 10;
    const preview = lines.slice(0, MAX_LINES).join("\n");
    const wrap = document.createElement("div");
    wrap.className = "tc-args";
    wrap.textContent = preview;
    if (total > MAX_LINES) {
      const hint = document.createElement("div");
      hint.className = "tc-trunc-hint";
      hint.textContent = "... (" + (total - MAX_LINES) + " 行未显示,共 " + total + " 行 · 点击展开)";
      hint.addEventListener("click", () => {
        if (wrap.textContent === preview) {
          wrap.textContent = content;
          wrap.style.maxHeight = "none";
          hint.textContent = "收起";
        } else {
          wrap.textContent = preview;
          wrap.style.maxHeight = "";
          hint.textContent = "... (" + (total - MAX_LINES) + " 行未显示,共 " + total + " 行 · 点击展开)";
        }
      });
      wrap.appendChild(hint);
    }
    return wrap;
  }

  /** 构建工具卡片 DOM（call + 参数 + 空 result 区），不挂载、不注册计时器。
   *  供 full 模式直接挂载与简洁模式点击展开复用，保证两模式卡片样式完全一致。 */
  function buildToolCardDom(toolName, argStr) {
    const card = document.createElement("div");
    card.className = "tool-card running msg-enter";
    card._toolName = toolName;
    const call = buildToolCallEl(toolName, argStr);
    call.title = argStr || toolName;
    // write 卡片：右侧“打开文件”跳转按钮（复用 openFile 消息，与正文 file-link 一致）
    if (toolName === "write") {
      let a = null;
      try { a = argStr ? JSON.parse(argStr) : {}; } catch { a = null; }
      const wPath = a && (typeof a.file_path === "string" ? a.file_path : (typeof a.path === "string" ? a.path : ""));
      if (wPath) {
        const jump = document.createElement("span");
        jump.className = "tc-jump";
        jump.textContent = "打开文件 ↗";
        jump.title = "在编辑器中打开 " + wPath;
        jump.addEventListener("click", (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: "openFile", path: wPath });
        });
        call.appendChild(jump);
      }
    }
    card.appendChild(call);
    // 参数区：write 显示内容预览（前 10 行，同 TUI），其余回退工具显示 pretty JSON
    if (toolName === "write") {
      const p = buildWritePreviewEl(argStr);
      if (p) { card.appendChild(p); }
    } else if (!CUSTOM_CALL_TOOLS.has(toolName) && argStr) {
      const argsPre = document.createElement("pre"); argsPre.className = "tc-args";
      argsPre.textContent = prettyJson(argStr);
      card.appendChild(argsPre);
    }
    const resultEl = document.createElement("div"); resultEl.className = "tc-output";
    card.appendChild(resultEl);
    card._resultEl = resultEl;
    return card;
  }

  /** 完整模式：每个工具调用一张卡片（对齐 TUI：整块背景，call+结果连续，状态用背景色）。 */
  function addToolCard(tab, toolName, argStr, toolCallId) {
    hideEmptyHint(tab);
    tab.currentToolRow = null;
    const card = buildToolCardDom(toolName, argStr);
    tab.paneEl.appendChild(card);
    scrollToBottom(tab);
    if (!toolCallId) {
      // 历史/静态调用：无结果事件，直接定格为完成态
      card.classList.remove("running"); card.classList.add("done");
      return;
    }
    // 运行中：JS 计时更新 meta 的 Elapsed（read 很快，不显示时间，同 TUI 展开后才有）
    card._elapsedStart = Date.now();
    let timer = null;
    if (toolName !== "read") {
      timer = setInterval(() => {
        if (card._elapsedStart && card.classList.contains("running") && card._elapsedEl) {
          card._elapsedEl.textContent = "Elapsed " + formatDur(Date.now() - card._elapsedStart);
        }
      }, 500);
    }
    tab.pendingToolCardsFull.set(toolCallId, { card, resultEl: card._resultEl, timer });
  }

  /** 简洁模式：点击工具标签，展开为完整模式同款卡片（挂到 .tool-row 之后），再次点击收起。 */
  function toggleCompactToolCard(tag) {
    const row = tag.parentElement;
    if (!row) { return; }
    let card = tag._card;
    if (!card) {
      card = buildToolCardDom(tag._toolName, tag._argStr);
      card.classList.remove("msg-enter"); // 点击展开无需入场动画，避免切换有延迟感
      card.classList.add("tool-card-compact");
      tag._card = card;
      if (tag._done) {
        // 结果已到（含历史回放）：直接定格完成态
        card.classList.remove("running"); card.classList.add("done");
        if (tag._isError) { card.classList.add("error"); }
        setToolResult(card, tag._resultText || "", tag._resultMeta || {});
      } else {
        // 运行中：先渲染已收到的部分结果（若有），再启动耗时计时器（read 不计时，同 full 模式）
        if (tag._resultText) { setToolResult(card, tag._resultText, tag._resultMeta || { isPartial: true }); }
        if (tag._toolName !== "read") {
          const dm = tag._resultMeta && typeof tag._resultMeta.durationMs === "number" ? tag._resultMeta.durationMs : null;
          card._elapsedStart = dm != null ? Date.now() - dm : Date.now();
          tag._timer = setInterval(() => {
            if (card._elapsedStart && card.classList.contains("running") && card._elapsedEl) {
              card._elapsedEl.textContent = "Elapsed " + formatDur(Date.now() - card._elapsedStart);
            }
          }, 500);
        }
      }
      // 插到 .tool-row 之后（跳过已展开的同类卡片，保持多卡按点击顺序排列）
      let anchor = row;
      let next;
      while ((next = anchor.nextElementSibling) && next.classList.contains("tool-card-compact")) { anchor = next; }
      anchor.after(card);
      tag.classList.add("expanded");
    } else if (card.hidden) {
      card.hidden = false;
      tag.classList.add("expanded");
    } else {
      card.hidden = true;
      tag.classList.remove("expanded");
    }
  }

  /** 卡片结果区渲染：预览截断（尾部 N 行，同 TUI）+ 元信息 + 展开/收起。 */
  function setToolResult(card, resultText, meta) {
    card._resultText = resultText || "";
    card._resultMeta = meta || {};
    renderToolResultInner(card);
  }
  function renderToolResultInner(card) {
    const resultEl = card._resultEl;
    if (!resultEl) { return; }
    const meta = card._resultMeta || {};
    const toolName = card._toolName || "";
    const isBash = toolName === "bash";
    const isRead = toolName === "read";
    let text = card._resultText || "";
    resultEl.innerHTML = "";
    // 剥掉 bash 结果里内嵌的截断脚注（元信息里单独渲染，同 TUI 处理）
    if (meta.truncation && meta.truncation.truncated && meta.truncation.fullOutputPath && text.endsWith("]")) {
      const fi = text.lastIndexOf("\n\n[");
      if (fi !== -1 && text.slice(fi).includes(meta.truncation.fullOutputPath)) {
        text = text.slice(0, fi).replace(/\s+$/, "");
      }
    }
    const lines = text ? text.split("\n") : [];
    // 预览行数：bash 尾部 5 行、read 前 5 行、其余前 15 行
    const maxLines = isBash || isRead ? TOOL_PREVIEW_LINES : 15;
    let shown = lines, hidden = 0;
    if (lines.length > maxLines && !card._resultExpanded) {
      hidden = lines.length - maxLines;
      shown = isBash ? lines.slice(-maxLines) : lines.slice(0, maxLines);
    }
    if (text) {
      const pre = document.createElement("pre"); pre.className = "tc-output";
      pre.textContent = shown.join("\n");
      // 展开后取消内部滚动（否则卡片内滚动条 + 主面板滚动条 = 双滚动条）
      if (card._resultExpanded) { pre.style.maxHeight = "none"; }
      resultEl.appendChild(pre);
    }
    // 底部行容器：耗时在左、截断标记在右（左右两个固定容器，不依赖 DOM 顺序）。
    const footer = document.createElement("div"); footer.className = "tc-footer";
    const fLeft = document.createElement("span"); fLeft.className = "tc-footer-left";
    const fRight = document.createElement("span"); fRight.className = "tc-footer-right";
    if (hidden > 0) {
      const mark = document.createElement("span");
      mark.className = "tc-trunc-mark";
      mark.textContent = "…";
      mark.title = (isBash ? hidden + " 行更早内容" : hidden + " 行被截断") + " · 点击展开完整结果";
      mark.addEventListener("click", (e) => { e.stopPropagation(); card._resultExpanded = true; renderToolResultInner(card); });
      fRight.appendChild(mark);
    } else if (card._resultExpanded && lines.length > maxLines) {
      const fold = document.createElement("span");
      fold.className = "tc-trunc-mark"; fold.textContent = "收起";
      fold.addEventListener("click", (e) => { e.stopPropagation(); card._resultExpanded = false; renderToolResultInner(card); });
      fRight.appendChild(fold);
    }
    // 截断警告（对齐 TUI：[Showing lines X-Y of Z. Full output: path] / [Truncated: ...]）
    const tr = meta.truncation;
    const warnings = [];
    if (tr && tr.truncated) {
      if (isBash) {
        if (tr.truncatedBy === "lines" && typeof tr.outputLines === "number" && typeof tr.totalLines === "number") {
          warnings.push("Showing lines " + (tr.totalLines - tr.outputLines + 1) + "-" + tr.totalLines + " of " + tr.totalLines + " lines");
        } else if (typeof tr.outputLines === "number") {
          warnings.push("Showing " + tr.outputLines + " lines");
        }
        if (tr.fullOutputPath) { warnings.push("Full output: " + tr.fullOutputPath); }
      } else if (isRead && tr.truncatedBy === "lines" && typeof tr.totalLines === "number") {
        warnings.push("Truncated: showing " + tr.outputLines + " of " + tr.totalLines + " lines");
      } else if (typeof tr.outputLines === "number") {
        warnings.push("Truncated: " + tr.outputLines + " lines shown");
      }
    }
    if (warnings.length) {
      const w = document.createElement("div"); w.className = "tc-warn";
      w.textContent = "[" + warnings.join(". ") + "]";
      resultEl.appendChild(w);
    }
    // 耗时（read 不显示时间，同 TUI 未展开无耗时）
    const isPartial = meta.isPartial;
    const durationMs = meta.durationMs;
    if (!isRead && isPartial && (typeof durationMs === "number" || card._elapsedStart)) {
      const t = document.createElement("span"); t.className = "tc-meta";
      t.textContent = "Elapsed " + formatDur(typeof durationMs === "number" ? durationMs : Date.now() - card._elapsedStart);
      card._elapsedEl = t;
      fLeft.appendChild(t);
    } else if (!isPartial && typeof durationMs === "number" && !isNaN(durationMs)) {
      const t = document.createElement("span"); t.className = "tc-meta";
      t.textContent = "Took " + formatDur(durationMs);
      fLeft.appendChild(t);
    }
    if (fLeft.childNodes.length || fRight.childNodes.length) {
      footer.appendChild(fLeft); footer.appendChild(fRight); resultEl.appendChild(footer);
    }
    if (meta.isError && !text) {
      const err = document.createElement("div"); err.className = "tc-error"; err.textContent = "工具执行失败";
      resultEl.appendChild(err);
    }
  }
  function renderDiffBlock(tab, diffText, filePath) {
    const wrap = document.createElement("div");
    wrap.className = "edit-diff";
    // 内层收缩包裹：宽度 = max(卡片宽, 最宽行)，让所有行背景一致铺满，横向滚动时短行不断色
    const inner = document.createElement("div");
    inner.className = "edit-diff-inner";
    wrap.appendChild(inner);
    const LINE_RE = /^([+-]?) *(\d+) (.*)$/;
    const lines = String(diffText).split("\n");
    for (const line of lines) {
      const div = document.createElement("div");
      div.className = "diff-line";
      const prefix = line.charAt(0);
      if (prefix === "+") div.classList.add("add");
      else if (prefix === "-") div.classList.add("del");
      else div.classList.add("ctx");
      div.textContent = line;
      const m = filePath && line.match(LINE_RE);
      if (m && (m[1] === "+" || m[1] === "-")) {
        const target = parseInt(m[2], 10);
        const anchor = m[1] === "+" ? m[3] : undefined;
        div.classList.add("jumpable");
        div.title = "跳转到第 " + target + " 行";
        div.addEventListener("click", () => {
          vscode.postMessage({ type: "openEditLocation", tabId: tab.id, path: filePath, line: target, anchor });
        });
      }
      inner.appendChild(div);
    }
    return wrap;
  }

  function buildEditCard(tab, toolName, label, filePath, toolCallId, argStr) {
    hideEmptyHint(tab);
    tab.currentToolRow = null;
    const el = document.createElement("div");
    el.className = "msg edit-card msg-enter";
    const title = document.createElement("div"); title.className = "edit-title";
    const name = document.createElement("span"); name.className = "et-name"; name.textContent = toolName;
    title.appendChild(name);
    const path = document.createElement("span"); path.className = "et-path"; path.textContent = label || "";
    title.appendChild(path);
    const loading = document.createElement("span"); loading.className = "et-loading"; loading.textContent = "…";
    title.appendChild(loading);
    el.appendChild(title);
    // write 卡片：展示写入内容预览（前 10 行，可展开；替代整文件 diff）
    if (toolName === "write") {
      const pv = buildWritePreviewEl(argStr);
      if (pv) { el.appendChild(pv); }
    }
    tab.paneEl.appendChild(el);
    scrollToBottom(tab);
    return {
      el,
      setResult(msg) {
        loading.remove();
        if (msg.isError) {
          el.classList.add("error");
          const err = document.createElement("span"); err.className = "et-err"; err.textContent = msg.errorText || "失败";
          title.appendChild(err);
          return;
        }
        el.classList.add("done");
        // write 用内容预览代替整文件 diff；edit 仍展示 diff
        if (toolName !== "write" && msg.diff) { el.appendChild(renderDiffBlock(tab, msg.diff, filePath)); }
        if (toolName === "write" && filePath) {
          // 右上角：跳转按钮（打开文件）
          const jumpBtn = document.createElement("span"); jumpBtn.className = "et-jump"; jumpBtn.textContent = "跳转 ↗";
          jumpBtn.title = "在编辑器中打开 " + (label || filePath);
          jumpBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "openFile", path: filePath, line: 1 });
          });
          title.appendChild(jumpBtn);
        } else if (msg.canRevert && toolCallId) {
          const revertBtn = document.createElement("span"); revertBtn.className = "et-revert"; revertBtn.textContent = "↩ 回滚";
          revertBtn.title = "将文件恢复到本次修改前的内容";
          revertBtn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "revertEdit", tabId: tab.id, toolCallId }); });
          title.appendChild(revertBtn);
        }
      },
      markReverted() {
        el.classList.add("reverted");
        const btn = title.querySelector(".et-revert"); if (btn) { btn.remove(); }
        if (!title.querySelector(".et-reverted")) { const t = document.createElement("span"); t.className = "et-reverted"; t.textContent = "已回滚"; title.appendChild(t); }
      },
    };
  }

  function fileBaseName(label) {
    const s = String(label || "");
    const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return slash >= 0 ? s.slice(slash + 1) : s;
  }
  function appendChangedFileChip(tab, f, nameOnly) {
    const item = document.createElement("div");
    item.className = "cf-item";
    item.title = "点击查看 diff: " + f.label;
    const name = document.createElement("span");
    name.className = "cf-name";
    if (nameOnly) {
      name.textContent = fileBaseName(f.label);
    } else {
      const slash = f.label.lastIndexOf("/");
      if (slash >= 0) {
        const dir = document.createElement("span");
        dir.className = "cf-dir";
        dir.textContent = f.label.slice(0, slash + 1);
        name.appendChild(dir);
        name.appendChild(document.createTextNode(f.label.slice(slash + 1)));
      } else {
        name.textContent = f.label;
      }
    }
    item.appendChild(name);
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "openDiff", tabId: tab.id, path: f.path });
    });
    changedFilesEl.appendChild(item);
    return item;
  }
  /** 折叠行：按单行可用宽度尽量多放文件 chips，放不下的收敛为 +N。
   *  items: [{ tab, f }]；toggle: 展开回调 */
  function layoutCollapsedChips(items, toggle) {
    const gap = 6;
    const els = items.map((it) => appendChangedFileChip(it.tab, it.f, true));
    const more = document.createElement("span");
    more.className = "cf-more";
    more.textContent = "+" + items.length;
    more.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    changedFilesEl.appendChild(more);
    const cs = getComputedStyle(changedFilesEl);
    const headerW = (changedFilesEl.querySelector(".cf-header")?.offsetWidth || 0) + gap;
    const avail = changedFilesEl.clientWidth
      - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - headerW;
    if (avail <= 0) { return; } // 未渲染出宽度，保持现状（overflow 会裁剪）
    const prefix = [0];
    els.forEach((el, i) => { prefix.push(prefix[i] + el.offsetWidth + (i ? gap : 0)); });
    let keep = els.length;
    for (let iter = 0; iter < 8; iter++) {
      const hiddenN = items.length - keep;
      if (!hiddenN) { break; }
      more.textContent = "+" + hiddenN;
      more.title = "还有 " + hiddenN + " 个文件，点击展开";
      const moreW = more.offsetWidth + gap;
      let k = els.length;
      while (k > 0 && prefix[k] + moreW > avail) { k--; }
      if (k === keep) { break; }
      keep = k;
    }
    els.forEach((el, i) => { el.style.display = i < keep ? "" : "none"; });
    if (keep === items.length) { more.remove(); }
  }

  function renderChangedFilesFor(tab) {
    if (activeId !== tab.id) { return; }
    // tab 级合并：当前 tab 内所有 panel 的修改文件（同路径去重）
    const tv = tabViews.get(activeTabId);
    if (!tv) { changedFilesEl.innerHTML = ""; return; }
    renderMergedChangedFiles(tabChangedEntries(tv));
  }

  /** 当前 tab 所有 panel 的修改文件（按路径去重；同路径保留后见者）。 */
  function tabChangedEntries(tv) {
    const byPath = new Map();
    leavesOf(tv.root).forEach((pid) => {
      const t = tabs.get(pid);
      if (!t) { return; }
      (t.changedFiles || []).forEach((f) => { if (f && f.path) { byPath.set(f.path, { tab: t, f }); } });
    });
    return Array.from(byPath.values());
  }

  /** 合并后的修改文件列表渲染（tab 级）。 */
  function renderMergedChangedFiles(entries) {
    changedFilesEl.innerHTML = "";
    if (!entries.length) {
      changedFilesEl.classList.remove("expanded", "collapsed");
      return;
    }
    const expanded = !!mergedChangedExpanded;
    changedFilesEl.classList.toggle("expanded", expanded);
    changedFilesEl.classList.toggle("collapsed", !expanded);

    const header = document.createElement("div");
    header.className = "cf-header";
    header.title = expanded ? "点击折叠" : "点击展开全部修改文件";
    header.setAttribute("role", "button");
    header.tabIndex = 0;
    const chevron = document.createElement("span");
    chevron.className = "cf-chevron";
    chevron.textContent = expanded ? "▾" : "▸";
    const title = document.createElement("span");
    title.className = "cf-title";
    title.textContent = "本次修改 (" + entries.length + ")";
    header.appendChild(chevron);
    header.appendChild(title);
    const toggle = () => { mergedChangedExpanded = !mergedChangedExpanded; renderMergedChangedFiles(entries); };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
    changedFilesEl.appendChild(header);

    if (!expanded) {
      // 折叠：单行摘要，按行宽自适应显示文件名，放不下用 +N
      layoutCollapsedChips(entries, toggle);
      return;
    }
    entries.forEach((ent) => appendChangedFileChip(ent.tab, ent.f, false));
  }
  let mergedChangedExpanded = false;
  // webview 宽度变化时重新布局折叠的文件行
  let cfResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(cfResizeTimer);
    cfResizeTimer = setTimeout(() => {
      const t = tabs.get(activeId);
      if (t) { renderChangedFilesFor(t); }
    }, 120);
  });
  function renderQueueBar(tab) {
    if (activeId !== tab.id) { return; }
    const items = tab.queuedSteering || [];
    if (!items.length) { queueBarEl.classList.add("hidden"); queueBarEl.innerHTML = ""; return; }
    queueBarEl.classList.remove("hidden");
    queueBarEl.innerHTML = "";
    const title = document.createElement("div");
    title.className = "qb-title";
    title.textContent = "已排队 " + items.length + " 条（工具执行后投递）";
    queueBarEl.appendChild(title);
    items.forEach((text, idx) => {
      const full = typeof text === "string" ? text : "";
      const lines = full.split("\n");
      const lineCount = lines.length;
      const preview = lines.slice(0, 3).join("\n") + (lineCount > 3 ? "\n…" : "");
      const card = document.createElement("div");
      card.className = "qb-block collapsed";
      const head = document.createElement("div");
      head.className = "qb-head";
      const dot = document.createElement("span"); dot.className = "qb-dot";
      const label = document.createElement("span"); label.className = "qb-label";
      label.textContent = "等待投递";
      const previewLine = document.createElement("span"); previewLine.className = "qb-preview";
      previewLine.textContent = (lines[0] || "").trim();
      const toggle = document.createElement("span"); toggle.className = "qb-toggle";
      toggle.textContent = "已排队 · 点击展开（" + lineCount + " 行）";
      head.appendChild(dot); head.appendChild(label); head.appendChild(previewLine); head.appendChild(toggle);
      const body = document.createElement("pre"); body.className = "qb-body";
      body.textContent = preview;
      card.appendChild(head); card.appendChild(body);
      head.addEventListener("click", () => {
        const collapsed = card.classList.toggle("collapsed");
        if (!collapsed) { body.textContent = full; toggle.textContent = "收起（" + lineCount + " 行）"; }
        else { body.textContent = preview; toggle.textContent = "已排队 · 点击展开（" + lineCount + " 行）"; }
      });
      queueBarEl.appendChild(card);
    });
  }

  // ==================== UI 同步（活跃 tab 驱动全局控件）====================
  function updateSendState() {
    // 发送/中止按钮已移除（用 Enter 发送、Esc 中止）；状态文案由 syncStatus 负责
  }
  // 状态栏常显模型：这些纯函数拼出模型名前缀与用量百分比标签。
  function modelPartFor(tab) {
    const id = (tab && tab.modelId) || "";
    const prov = (tab && tab.provider) || "";
    return id ? ((prov ? prov + "/" : "") + id) : "";
  }
  let tpsSyncAt = 0;
  // delta 高频到达，速度刷新做 250ms 节流（当前 tab 内所有可见 pane 都要刷）
  function noteTpsProgress(t) {
    if (!t.paneEl.isConnected) { return; }
    const now = Date.now();
    if (now - tpsSyncAt >= 250) { tpsSyncAt = now; if (activeId === t.id) { syncStatus(); } updatePaneHeads(); }
  }
  function pctTag(tab) {
    if (!tab || typeof tab.percent !== "number") { return ""; }
    const cls = tab.percent >= 90 ? " err" : (tab.percent >= 70 ? " warn" : "");
    return '<span class="st-pct' + cls + '">' + tab.percent.toFixed(1) + '%</span>';
  }
  // 用流式 delta 估算生成速度：CJK 字符按 1 token/字，其余约 4 字符/token
  function estTokens(text) {
    if (!text) { return 0; }
    let cjk = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0x3000 && c <= 0x9fff) { cjk++; }
    }
    return cjk + (text.length - cjk) / 4;
  }
  // 流式中返回实时均值，空闲时返回上一轮的最终均值
  function currentTps(tab) {
    if (!tab) { return undefined; }
    if (tab.streaming && tab.tpsStart > 0 && tab.tpsTokens > 0) {
      const secs = (Date.now() - tab.tpsStart) / 1000;
      return secs > 0.3 ? (tab.tpsTokens / secs) : undefined;
    }
    return tab.tps;
  }
  function statusTags(tab) {
    const parts = [];
    const mp = modelPartFor(tab);
    if (mp) { parts.push('<span class="st-model">' + mp + '</span>'); }
    const pct = pctTag(tab);
    if (pct) { parts.push(pct); }
    const tps = currentTps(tab);
    if (typeof tps === "number") { parts.push('<span class="st-tps">' + tps.toFixed(1) + ' t/s</span>'); }
    return parts;
  }
  // 状态栏已全部下沉到每个 panel 底部（.pane-status）；此别名保留既有调用点。
  function syncStatus() { syncPaneStatuses(); }

  /** 附件预览：随 tab 级草稿（图片 / 折叠文本块与输入文字同层）。 */
  function renderAttachmentsFor() {
    const d = draftOfTab();
    imgPreviewEl.innerHTML = "";
    (d.images || []).forEach((img, idx) => {
      const wrap = document.createElement("div"); wrap.className = "img-thumb";
      const el = document.createElement("img"); el.src = "data:" + img.mimeType + ";base64," + img.data; wrap.appendChild(el);
      const rm = document.createElement("span"); rm.className = "rm"; rm.textContent = "×"; rm.title = "移除";
      rm.addEventListener("click", () => { d.images.splice(idx, 1); renderAttachmentsFor(); });
      wrap.appendChild(rm); imgPreviewEl.appendChild(wrap);
    });
    (d.textBlocks || []).forEach((blk, idx) => {
      const card = document.createElement("div"); card.className = "text-block";
      const head = document.createElement("div"); head.className = "tb-head";
      const caret = document.createElement("span"); caret.className = "tb-caret"; caret.textContent = "▶";
      const title = document.createElement("span"); title.className = "tb-title"; title.title = blk.title || "";
      title.textContent = blk.title || ("📎 粘贴文本 · " + blk.lines + " 行 · " + blk.chars + " 字符");
      head.appendChild(caret); head.appendChild(title);
      const rm = document.createElement("span"); rm.className = "tb-rm"; rm.textContent = "×"; rm.title = "移除";
      rm.addEventListener("click", () => { d.textBlocks.splice(idx, 1); renderAttachmentsFor(); });
      const body = document.createElement("div"); body.className = "tb-body";
      const previewLines = blk.text.split("\n").slice(0, 400);
      body.textContent = previewLines.join("\n") + (blk.lines > 400 ? "\n…（预览截断，完整内容随发送提交）" : "");
      head.addEventListener("click", () => card.classList.toggle("expanded"));
      card.appendChild(head); card.appendChild(body); card.appendChild(rm);
      imgPreviewEl.appendChild(card);
    });
  }

  function draftOfTab() {
    if (!tabDrafts.has(activeTabId)) {
      tabDrafts.set(activeTabId, { text: "", selStart: 0, selEnd: 0, height: 144, images: [], textBlocks: [] });
    }
    const d = tabDrafts.get(activeTabId);
    if (!Array.isArray(d.images)) { d.images = []; }
    if (!Array.isArray(d.textBlocks)) { d.textBlocks = []; }
    return d;
  }
  function saveInputState() {
    const d = draftOfTab();
    d.text = inputEl.value;
    d.selStart = inputEl.selectionStart;
    d.selEnd = inputEl.selectionEnd;
    d.height = parseInt(inputEl.style.height, 10) || 144;
  }
  function restoreInputState() {
    const d = draftOfTab();
    inputEl.value = d.text || "";
    inputEl.style.height = (d.height || 144) + "px";
    try {
      inputEl.setSelectionRange(d.selStart || 0, d.selEnd || 0);
    } catch { /* ignore */ }
    renderAttachmentsFor();
    hideFileMenu();
  }

  /** 把文本写入当前 tab 的输入框（fork 后把 user 消息救回，可编辑后重发）。 */
  function applyInputText(tab, text) {
    if (!tab) { return; }
    const value = typeof text === "string" ? text : "";
    const tv = tabViews.get(activeTabId);
    if (!tv || !leavesOf(tv.root).includes(tab.id)) { return; }
    const d = draftOfTab();
    d.text = value;
    d.selStart = value.length;
    d.selEnd = value.length;
    inputEl.value = value;
    inputEl.style.height = "auto";
    autoResize();
    try { inputEl.setSelectionRange(value.length, value.length); } catch { /* ignore */ }
    updateSendState();
    inputEl.focus();
  }

  function reflectTabUI() {
    const tab = activeTab();
    if (!tab) { return; }
    updateSendState();
    syncStatus();
    renderChangedFilesFor(tab);
    renderQueueBar(tab);
    syncJumpBottom(tab);
  }

  // ==================== tab 切换（容器） ====================
  function activateTabView(id) {
    if (!tabViews.has(id) || activeTabId === id) { return; }
    saveInputState();
    activeTabId = id;
    const tv = tabViews.get(id);
    activeId = (tv.focusPanelId && leavesOf(tv.root).includes(tv.focusPanelId))
      ? tv.focusPanelId
      : (leavesOf(tv.root)[0] || null);
    renderLayout();
    restoreInputState();
    reflectTabUI();
    renderTabBar();
    inputEl.focus();
  }

  // ==================== tab 栏渲染（容器） ====================
  let tabBarSig = "";      // 内容签名：不变则跳过重建（流式期间 tabList 每 48ms 一推）
  let tabBarDirty = false; // 拖拽中跳过重建，dragend 后补一次
  function renderTabBar() {
    if (draggingPanelId) { tabBarDirty = true; return; }
    const sig = Array.from(tabViews.values()).map((tv) =>
      tv.id + ":" + tv.name + ":" + (activeTabId === tv.id ? 1 : 0) + ":" + (tv.streaming ? 1 : 0) + ":" + (tv.loading ? 1 : 0)
    ).join("|");
    if (sig === tabBarSig) { return; }
    tabBarSig = sig;
    tabBarInner.innerHTML = "";
    tabViews.forEach((tv) => {
      const panelIds = leavesOf(tv.root);
      const single = panelIds.length === 1;
      const el = document.createElement("div");
      el.className = "chat-tab" + (activeTabId === tv.id ? " active" : "") + (tv.streaming ? " streaming" : "") + (tv.loading ? " loading" : "");
      const spinner = document.createElement("span"); spinner.className = "ct-spinner"; el.appendChild(spinner);
      const title = document.createElement("span"); title.className = "ct-title"; title.textContent = tv.name; title.title = tv.name; el.appendChild(title);
      const close = document.createElement("span"); close.className = "ct-close"; close.title = "关闭 tab（内部 panel 全部关闭）";
      // 用 SVG 画叉：文本 “×” 在 Segoe UI 等字体下 ink 偏上，flex 居中无法修正；
      // SVG 笔画由 viewBox 几何决定，天然居中（与 VS Code 自带关闭图标同法）。
      close.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 2.5 L13.5 13.5 M13.5 2.5 L2.5 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
      close.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "closeTab", tabId: tv.id }); });
      el.appendChild(close);
      el.addEventListener("click", () => { vscode.postMessage({ type: "switchTab", tabId: tv.id }); });
      // panel 拖到该 tab 上 → 搬进该 tab
      el.addEventListener("dragover", (e) => {
        if (!draggingPanelId) { return; }
        e.preventDefault();
        e.stopPropagation();
        el.classList.add("drop-hint");
      });
      el.addEventListener("dragleave", (e) => {
        if (el.contains(e.relatedTarget)) { return; }
        el.classList.remove("drop-hint");
      });
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove("drop-hint");
        if (!draggingPanelId) { return; }
        vscode.postMessage({ type: "movePanel", panelId: draggingPanelId, targetTabId: tv.id });
      });
      // 单 panel tab：tab 条目就是该 panel 的身份 —— 可直接拖到别的 tab 上合并过去
      if (single) {
        el.draggable = true;
        title.title = tv.name + "（拖到别的 tab 上合并过去）";
        el.addEventListener("dragstart", (e) => {
          draggingPanelId = panelIds[0];
          e.dataTransfer.effectAllowed = "move";
          try { e.dataTransfer.setData("text/plain", panelIds[0]); } catch { /* ignore */ }
          document.body.classList.add("panel-dragging");
        });
        el.addEventListener("dragend", () => {
          draggingPanelId = null;
          document.body.classList.remove("panel-dragging");
          clearAllDropHints();
          if (tabBarDirty) { tabBarDirty = false; tabBarSig = ""; renderTabBar(); }
        });
        // 右键菜单：单 panel 没有 pane-head，菜单挂 tab 条目上
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          showPaneMenu(e.clientX, e.clientY, panelIds[0]);
        });
      }
      tabBarInner.appendChild(el);
    });
  }

  // ==================== 布局树渲染（tab 内的 panel 网格 / 拖拽） ====================
  const PH_CLOSE_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2.5 2.5 L13.5 13.5 M13.5 2.5 L2.5 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';

  /** 布局树叶子（panel id）深度优先序。 */
  function leavesOf(node) {
    if (!node) { return []; }
    if (node.kind === "panel") { return [node.panelId]; }
    return (node.children || []).flatMap(leavesOf);
  }

  /** 查 panel 所属的 tab id（不在任何 tab 中返回 null）。 */
  function panelTabOf(panelId) {
    for (const tv of tabViews.values()) {
      if (leavesOf(tv.root).includes(panelId)) { return tv.id; }
    }
    return null;
  }

  /** pane-head：创建一次常驻（tab 内 ≥2 个 panel 时由 CSS 显示）。 */
  function ensurePaneHead(tab) {
    if (!tab || tab.paneEl.querySelector(".pane-head")) { return; }
    const head = document.createElement("div");
    head.className = "pane-head";
    head.draggable = true;
    head.title = "拖动移动 panel · 双击最大化/还原 · 右键菜单";
    const dot = document.createElement("span"); dot.className = "ph-dot";
    const title = document.createElement("span");
    title.className = "ph-title";
    title.textContent = tab.title || "对话";
    const close = document.createElement("span");
    close.className = "ph-close";
    close.title = "关闭 panel（杀进程）";
    close.innerHTML = PH_CLOSE_SVG;
    close.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "closePanel", panelId: tab.id }); });
    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(close);
    // 同 statusbar：拦 mousedown 冒泡，避免 leaf 抢焦点重建 DOM 导致子元素 click 丢失；
    // 点击头部自身仍完成聚焦（关闭按钮有 stopPropagation 不受影响）。
    head.addEventListener("mousedown", (e) => { e.stopPropagation(); });
    head.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeId !== tab.id) { focusPanelLocal(tab.id); }
    });
    head.addEventListener("dblclick", (e) => { e.stopPropagation(); toggleMaximize(tab.id); });
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      showPaneMenu(e.clientX, e.clientY, tab.id);
    });
    head.addEventListener("dragstart", (e) => {
      draggingPanelId = tab.id;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", tab.id); } catch { /* ignore */ }
      document.body.classList.add("panel-dragging");
    });
    head.addEventListener("dragend", () => {
      draggingPanelId = null;
      document.body.classList.remove("panel-dragging");
      clearAllDropHints();
      if (tabBarDirty) { tabBarDirty = false; tabBarSig = ""; renderTabBar(); }
    });
    tab.paneEl.insertBefore(head, tab.paneEl.firstChild);
  }

  /** 刷新各 pane 头部（标题 / 流式灯）+ 每 panel 底部状态栏。 */
  function updatePaneHeads() {
    tabs.forEach((t) => {
      const head = t.paneEl.querySelector(".pane-head");
      if (!head) { return; }
      head.classList.toggle("ph-streaming", !!(t.streaming || t.loading));
      const titleEl = head.querySelector(".ph-title");
      if (titleEl) { titleEl.textContent = t.title || "对话"; titleEl.title = t.title || ""; }
    });
    syncPaneStatuses();
  }

  /** 单个 panel 底部状态栏的 HTML。 */
  function paneStatusHtml(t) {
    if (!t) { return ""; }
    if (t.loading) { return '<span class="st-text">加载中…</span>'; }
    if (!t.piReady) { return '<span class="st-text">等待 pi 启动…</span>'; }
    const tags = statusTags(t);
    if (t.streaming) {
      const labels = { working: "处理中…", thinking: "思考中…", tool: "执行工具…" };
      const label = labels[t.activity] || labels.working;
      return '<span class="typing"><span></span><span></span><span></span></span> ' +
        (tags.length ? tags.join(" · ") + " · " : "") +
        '<span class="st-label">' + label + ' · Esc 中止</span>';
    }
    if (!tags.length) { return '<span class="st-text">未配置模型（点击选择）</span>'; }
    return tags.join(" · ");
  }

  /** 状态栏结构签名：签名不变时原位更新文字，避免重建 innerHTML 导致 .typing 动画重启。 */
  function statusSig(t) {
    if (t.loading) { return "loading"; }
    if (!t.piReady) { return "wait"; }
    const pctCls = (typeof t.percent === "number")
      ? (t.percent >= 90 ? "err" : (t.percent >= 70 ? "warn" : "ok"))
      : "";
    const hasTps = typeof currentTps(t) === "number" ? "t" : "";
    const act = t.streaming ? (t.activity || "working") : "";
    return [(t.streaming ? "s" : "i"), modelPartFor(t) ? "m" : "", pctCls, hasTps, act].join("|");
  }
  /** 签名相同时只替换数字文本，不动 .typing 等动画节点。 */
  function updateStatusInPlace(el, t) {
    const m = el.querySelector(".st-model");
    if (m) { m.textContent = modelPartFor(t); }
    if (typeof t.percent === "number") {
      const p = el.querySelector(".st-pct");
      if (p) {
        p.textContent = t.percent.toFixed(1) + "%";
        p.className = "st-pct" + (t.percent >= 90 ? " err" : (t.percent >= 70 ? " warn" : ""));
      }
    }
    const tps = currentTps(t);
    if (typeof tps === "number") {
      const s = el.querySelector(".st-tps");
      if (s) { s.textContent = tps.toFixed(1) + " t/s"; }
    }
    if (t.streaming) {
      const labels = { working: "处理中…", thinking: "思考中…", tool: "执行工具…" };
      const l = el.querySelector(".st-label");
      if (l) { l.textContent = (labels[t.activity] || labels.working) + " · Esc 中止"; }
    }
  }

  /** 刷新所有 panel 的底部状态栏内容与焦点高亮。 */
  function syncPaneStatuses() {
    tabs.forEach((t) => {
      const el = t.paneEl.parentElement
        ? t.paneEl.parentElement.querySelector(":scope > .pane-status")
        : null;
      if (!el) { return; }
      const sig = statusSig(t);
      if (el._sig === sig) {
        updateStatusInPlace(el, t);   // 保留 .typing 动画节点，只换变化文字
      } else {
        el._sig = sig;
        el.innerHTML = paneStatusHtml(t);
      }
      el.classList.toggle("ps-focus", activeId === t.id);
      const mp = modelPartFor(t);
      el.title = "当前: " + (mp || "未配置") + (t.thinkingLevel ? (" · 思考 " + t.thinkingLevel) : "") + "（点击切换模型）";
    });
  }

  // ---- pane-head 右键菜单 ----
  let paneMenuEl = null;
  function hidePaneMenu() {
    if (!paneMenuEl) { return; }
    if (paneMenuEl._closer) { document.removeEventListener("mousedown", paneMenuEl._closer, true); }
    paneMenuEl.remove();
    paneMenuEl = null;
  }
  function showPaneMenu(x, y, panelId) {
    hidePaneMenu();
    paneMenuEl = document.createElement("div");
    paneMenuEl.className = "pane-menu";
    const mk = (label, fn) => {
      const it = document.createElement("div");
      it.className = "pm-item";
      it.textContent = label;
      it.addEventListener("click", () => { hidePaneMenu(); fn(); });
      paneMenuEl.appendChild(it);
    };
    mk("＋ 新建空 panel", () => vscode.postMessage({ type: "addPanel", panelId }));
    mk("⑂ Fork 会话（克隆上下文到新 panel）", () => vscode.postMessage({ type: "forkPanel", panelId }));
    const sep = document.createElement("div"); sep.className = "pm-sep"; paneMenuEl.appendChild(sep);
    mk("✕ 关闭 panel", () => vscode.postMessage({ type: "closePanel", panelId }));
    document.body.appendChild(paneMenuEl);
    const r = paneMenuEl.getBoundingClientRect();
    paneMenuEl.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
    paneMenuEl.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
    const closer = (ev) => { if (paneMenuEl && !paneMenuEl.contains(ev.target)) { hidePaneMenu(); } };
    paneMenuEl._closer = closer;
    document.addEventListener("mousedown", closer, true);
  }

  // ---- 布局 DOM ----
  /** 拖拽悬停区判定：边缘 28% 为上下左右，中心为替换。返回 zone 并高亮。 */
  function zoneFromEvent(leaf, e) {
    const r = leaf.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    const edge = 0.28;
    const zone = y < edge ? "top" : (y > 1 - edge ? "bottom" : (x < edge ? "left" : (x > 1 - edge ? "right" : "center")));
    leaf.querySelectorAll(".dz").forEach((d) => d.classList.toggle("on", d.dataset.zone === zone));
    return zone;
  }
  function clearAllDropHints() {
    document.querySelectorAll(".layout-leaf.drop-hover").forEach((el) => el.classList.remove("drop-hover", "drop-merge"));
    document.querySelectorAll(".dz.on").forEach((el) => el.classList.remove("on"));
    document.querySelectorAll(".chat-tab.drop-hint").forEach((el) => el.classList.remove("drop-hint"));
    tabBarEl.classList.remove("drop-hint");
  }

  function buildLeafDom(panelId) {
    const t = tabs.get(panelId);
    const leaf = document.createElement("div");
    leaf.className = "layout-leaf";
    leaf.dataset.panelId = panelId;
    if (t) {
      leaf.appendChild(t.paneEl);
      // 每个 panel 自己的底部状态栏（多 panel 时显示；点击切换该 panel 模型）
      const stBar = document.createElement("div");
      stBar.className = "pane-status";
      // 拦掉 mousedown 冒泡：否则 leaf 的 mousedown 会先切焦点，
      // 焦点切换重建 statusbar DOM（mousedown↟click 之间目标节点被换掉），
      // 导致随后的 click 丢失，模型选择器弹不出来。聚焦改在 click 里自己做。
      stBar.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      stBar.addEventListener("click", (e) => {
        e.stopPropagation();
        if (activeId !== panelId) { focusPanelLocal(panelId); }
        // t0：点击↟弹出的往返计时（宿主随 picker 消息回显，renderPicker 里打日志）
        vscode.postMessage({ type: "pickModel", tabId: panelId, t0: performance.now() });
      });
      leaf.appendChild(stBar);
    }
    // 落点指示层（四个方位 + 中心替换）；跨 tab 拖动时改显示整格“合并”提示
    const ind = document.createElement("div");
    ind.className = "drop-indicator";
    const ZONE_MARKS = { left: "←", right: "→", top: "↑", bottom: "↓", center: "⤫" };
    const ZONE_TITLES = { left: "插到左侧", right: "插到右侧", top: "插到上方", bottom: "插到下方", center: "替换此 panel" };
    ["left", "right", "top", "bottom", "center"].forEach((z) => {
      const d = document.createElement("div");
      d.className = "dz dz-" + z;
      d.dataset.zone = z;
      d.title = ZONE_TITLES[z];
      const mark = document.createElement("span");
      mark.className = "dz-mark";
      mark.textContent = ZONE_MARKS[z];
      d.appendChild(mark);
      ind.appendChild(d);
    });
    const mergeHint = document.createElement("div");
    mergeHint.className = "drop-merge-hint";
    mergeHint.textContent = "⇲ 合并进此 tab";
    ind.appendChild(mergeHint);
    leaf.appendChild(ind);
    leaf.addEventListener("dragover", (e) => {
      if (!draggingPanelId || draggingPanelId === panelId) { return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      leaf.classList.add("drop-hover");
      // 跨 tab 拖动：整格合并提示；同 tab 重排：四分方位热区
      const sameTab = panelTabOf(draggingPanelId) === panelTabOf(panelId);
      leaf.classList.toggle("drop-merge", !sameTab);
      if (sameTab) { zoneFromEvent(leaf, e); }
    });
    leaf.addEventListener("dragleave", (e) => {
      if (leaf.contains(e.relatedTarget)) { return; }
      leaf.classList.remove("drop-hover", "drop-merge");
      leaf.querySelectorAll(".dz.on").forEach((d) => d.classList.remove("on"));
    });
    leaf.addEventListener("drop", (e) => {
      e.preventDefault();
      leaf.classList.remove("drop-hover", "drop-merge");
      leaf.querySelectorAll(".dz.on").forEach((d) => d.classList.remove("on"));
      if (!draggingPanelId || draggingPanelId === panelId) { return; }
      const sameTab = panelTabOf(draggingPanelId) === panelTabOf(panelId);
      if (sameTab) {
        const zone = zoneFromEvent(leaf, e);
        vscode.postMessage({ type: "movePanel", panelId: draggingPanelId, targetPanelId: panelId, zone });
      } else {
        const targetTabId = panelTabOf(panelId);
        if (targetTabId) {
          vscode.postMessage({ type: "movePanel", panelId: draggingPanelId, targetTabId });
        }
      }
    });
    leaf.addEventListener("mousedown", () => {
      if (activeId !== panelId) { focusPanelLocal(panelId); }
    });
    return leaf;
  }

  function buildNodeDom(node) {
    if (node.kind === "panel") { return buildLeafDom(node.panelId); }
    const el = document.createElement("div");
    el.className = "layout-split layout-" + (node.orientation === "v" ? "v" : "h");
    (node.children || []).forEach((c) => el.appendChild(buildNodeDom(c)));
    return el;
  }

  /** 布局结构签名：只看形态（树结构 + 焦点 + 最大化），不含 streaming/activity 等易变字段。 */
  function structSig(node) {
    if (!node) { return ""; }
    if (node.kind === "panel") { return "P(" + node.panelId + ")"; }
    return (node.orientation === "v" ? "V[" : "H[") + (node.children || []).map(structSig).join(",") + "]";
  }
  function layoutSignature() {
    const tv = tabViews.get(activeTabId);
    if (!tv) { return ""; }
    // 注意：焦点（focusPanelId）不入签名 —— 焦点变化只刷 focus 类/状态栏，不该重建布局
    return activeTabId + "|" + structSig(tv.root) + "|" + (maximized.get(activeTabId) || "");
  }

  /** 重建当前 tab 的布局 DOM（挂载到 #messages）。按缓存恢复各 pane 滚动位置。 */
  function renderLayout() {
    document.querySelectorAll("#messages .layout-root").forEach((el) => el.remove());
    const tv = tabViews.get(activeTabId);
    if (!tv) { return; }
    layoutSig = layoutSignature();
    const leaves = leavesOf(tv.root);
    const rootEl = document.createElement("div");
    rootEl.className = "layout-root" + (leaves.length > 1 ? " multi" : "");
    const max = maximized.get(activeTabId);
    if (max && leaves.length > 1 && leaves.includes(max)) {
      rootEl.classList.add("maximized");
    }
    rootEl.appendChild(buildNodeDom(tv.root));
    if (max && leaves.length > 1 && leaves.includes(max)) {
      rootEl.querySelectorAll(".layout-leaf").forEach((lf) => {
        if (lf.dataset.panelId === max) { lf.classList.add("maximized"); }
      });
    }
    messagesEl.appendChild(rootEl);
    // 恢复所有新挂载 pane 的滚动位置（优先 panel 状态缓存；贴底状态直接贴底）
    rootEl.querySelectorAll(".layout-leaf .tab-pane").forEach((p) => {
      const t = tabs.get(p.dataset.tabId);
      if (!t) { return; }
      if (t.stickToBottom) {
        t.programmaticScroll = true;
        p.scrollTop = p.scrollHeight;
        t.lastScrollTop = p.scrollTop;
      } else if (typeof t.lastScrollTop === "number") {
        p.scrollTop = t.lastScrollTop;
      }
    });
    // 重挂载会让 CSS 动画重播：剥掉历史气泡的一次性动画（入场/高亮），避免整窗“抖一下”或高亮重闪
    rootEl.querySelectorAll(".msg-enter, .entry-flash").forEach((el) => {
      el.classList.remove("msg-enter");
      // entry-flash 有自己的定时清理；切走再切回时不再重闪，直接移除
      el.classList.remove("entry-flash");
    });
    applyFocusClasses();
    updatePaneHeads();
  }

  function applyFocusClasses() {
    document.querySelectorAll("#messages .layout-leaf").forEach((lf) => {
      lf.classList.toggle("focus", lf.dataset.panelId === activeId);
    });
    syncPaneStatuses();
  }

  /** 焦点 panel（本地先切 + 后端同步）。输入框草稿按 tab 存，切焦点不动草稿。 */
  function focusPanelLocal(panelId) {
    if (activeId === panelId) { return; }
    const tv = tabViews.get(activeTabId);
    if (!tv || !leavesOf(tv.root).includes(panelId)) { return; }
    activeId = panelId;
    tv.focusPanelId = panelId;
    applyFocusClasses();
    reflectTabUI();
    renderAttachmentsFor();
    vscode.postMessage({ type: "focusPanel", panelId });
  }

  /** 双击 pane-head：最大化 / 还原（纯前端，树保留）。 */
  function toggleMaximize(panelId) {
    if (maximized.get(activeTabId) === panelId) { maximized.delete(activeTabId); }
    else { maximized.set(activeTabId, panelId); }
    renderLayout();
  }

  // ---- tab 栏作为 panel 拖拽落点（拖到某 tab 上 = 搬进去；空白 = 新 tab 带走）----
  tabBarEl.addEventListener("dragover", (e) => {
    if (!draggingPanelId) { return; }
    if (e.target.closest(".chat-tab")) { tabBarEl.classList.remove("drop-hint"); return; }
    e.preventDefault();
    tabBarEl.classList.add("drop-hint");
  });
  tabBarEl.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && tabBarEl.contains(e.relatedTarget)) { return; }
    tabBarEl.classList.remove("drop-hint");
  });
  tabBarEl.addEventListener("drop", (e) => {
    tabBarEl.classList.remove("drop-hint");
    if (!draggingPanelId) { return; }
    if (e.target.closest(".chat-tab")) { return; } // tab chip 自己的 drop 处理
    e.preventDefault();
    vscode.postMessage({ type: "movePanel", panelId: draggingPanelId });
  });

  // ==================== 树视图 ====================
  function entryText(content) { if (typeof content === "string") { return content; } if (Array.isArray(content)) { return content.map((c) => (c && c.type === "text") ? c.text : "").join(""); } return ""; }
  function clip(s) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > 64 ? s.slice(0, 64) + "…" : s; }
  function entrySummary(node) {
    const e = node.entry;
    if (e.type === "message") {
      const m = e.message;
      if (m.role === "user") { return "你：" + clip(entryText(m.content)); }
      if (m.role === "assistant") {
        const t = entryText(m.content);
        if (t) { return "pi：" + clip(t); }
        if (m.stopReason === "aborted") { return "pi：(已中止)"; }
        if (m.errorMessage) { return "pi：" + clip(m.errorMessage); }
        return "pi：(工具调用)";
      }
      if (m.role === "toolResult") { return "› 工具结果"; }
      if (m.role === "bashExecution") { return "› bash：" + clip(m.command || ""); }
      return "› " + m.role;
    }
    if (e.type === "compaction") { return "◌ 压缩摘要"; }
    if (e.type === "branch_summary") { return "↳ 分支摘要：" + clip(e.summary); }
    if (e.type === "session_info") { return "· 标题" + (e.name ? "：" + e.name : ""); }
    if (e.type === "label") { return "· 标签" + (e.label ? "：" + e.label : ""); }
    if (e.type === "custom" || e.type === "custom_message") { return "· " + e.customType; }
    return e.type;
  }
  function isHiddenNode(node) {
    const e = node.entry;
    if (e.type === "model_change" || e.type === "thinking_level_change") { return true; }
    if (e.type === "message") {
      const m = e.message; const r = m && m.role;
      if (r === "toolResult" || r === "bashExecution") { return true; }
      if (r === "assistant" && isToolCallOnlyMsg(m)) { return true; }
    }
    return false;
  }
  function isToolCallOnlyMsg(m) {
    if (!Array.isArray(m.content)) { return false; }
    let hasTool = false;
    for (const c of m.content) {
      if (!c) { continue; }
      if (c.type === "text" && String(c.text || "").trim()) { return false; }
      if (c.type === "toolCall") { hasTool = true; }
    }
    return hasTool;
  }
  function flattenTree(roots) {
    const rows = [];
    function walk(node, indent, gutters, isLast, showConnector, connectorPos) {
      const hidden = isHiddenNode(node);
      if (!hidden) { rows.push({ node, indent, isLast, gutters: gutters.slice(), showConnector, connectorPos }); }
      const kids = node.children || [];
      const multiple = kids.length > 1;
      const childIndent = multiple ? indent + 1 : indent;
      kids.forEach((k, i) => {
        const kIsLast = i === kids.length - 1;
        walk(k, childIndent, multiple ? gutters.concat({ pos: indent, show: !kIsLast }) : gutters, kIsLast, multiple, multiple ? indent : -1);
      });
    }
    roots.forEach((r, i) => walk(r, 0, [], i === roots.length - 1, false, -1));
    return rows;
  }
  function activePathSet(roots, leafId) {
    const byId = new Map();
    function visit(node) { byId.set(node.entry.id, node); (node.children || []).forEach(visit); }
    roots.forEach(visit);
    const set = new Set(); let cur = leafId;
    while (cur) { set.add(cur); const n = byId.get(cur); if (!n) { break; } cur = n.entry.parentId ?? null; }
    return set;
  }
  function renderTree(tree, leafId, tabId) {
    const dt = tabs.get(tabId);
    try {
    treeBody.innerHTML = "";
    // 浮层只展示 user 消息（历史提问列表），点任意一条即可从该处开分支。
    const users = [];
    (function walk(nodes) {
      for (const n of nodes) {
        const e = n && n.entry;
        if (e && e.type === "message" && e.message && e.message.role === "user") {
          users.push(n);
        }
        walk(n.children || []);
      }
    })(tree);
    const active = activePathSet(tree, leafId);
    if (users.length === 0) {
      const empty = document.createElement("div"); empty.className = "tree-empty"; empty.textContent = "没有历史消息。"; treeBody.appendChild(empty);
    } else {
      users.forEach((node) => {
        const e = node.entry;
        const isLeaf = e.id === leafId;
        const onPath = active.has(e.id);
        const line = document.createElement("div");
        line.className = "tree-row" + (isLeaf ? " is-leaf" : "") + (onPath ? " on-path" : "");
        const marker = document.createElement("span"); marker.className = "tree-mark user"; line.appendChild(marker);
        const text = document.createElement("span"); text.className = "tree-text"; text.textContent = entrySummary(node); line.appendChild(text);
        if (!isLeaf) {
          line.classList.add("forkable"); line.title = "点击在此处新建分支（可编辑该消息后重发）";
          line.addEventListener("click", () => {
            hideTree();
            vscode.postMessage({ type: "forkAtEntry", tabId: tabId, entryId: e.id });
          });
        } else { line.title = "当前位置（分支末尾）"; }
        treeBody.appendChild(line);
      });
      const leafEl = treeBody.querySelector(".tree-row.is-leaf");
      if (leafEl) { leafEl.scrollIntoView({ block: "center" }); }
    }
    treeOverlay.classList.remove("hidden");
    } catch (e) {
      if (dt) { addPlain(dt, "system error", null, "对话树渲染失败: " + (e && e.message ? e.message : String(e))); }
    }
  }

  // ==================== 通用拾取器浮层（模型 / 历史）====================
  function hidePicker() {
    pickerOverlay.classList.add("hidden");
    pickerBody.innerHTML = "";
    pickerSearch.value = "";
    pickerFooter.innerHTML = "";
    pickerFooter.classList.add("hidden");
    pickerFooter.classList.remove("pk-model-footer");
    pickerSearchWrap.classList.remove("hidden");
    pickerState = null;
  }
  function pickerRelTime(mtime) {
    if (!mtime) { return ""; }
    const diff = Math.max(0, Date.now() - mtime);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) { return "刚刚"; }
    const min = Math.floor(sec / 60); if (min < 60) { return min + " 分钟前"; }
    const hr = Math.floor(min / 60); if (hr < 24) { return hr + " 小时前"; }
    const day = Math.floor(hr / 24); if (day < 30) { return day + " 天前"; }
    return new Date(mtime).toLocaleDateString();
  }
  /** ISO timestamp -> MM-DD HH:MM，用作历史会话行的行首错点。 */
  function formatSessionTs(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) { return ""; }
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return mm + "-" + dd + " " + hh + ":" + mi;
  }
  function pickerItemMatch(item, kind, q) {
    if (!q) { return true; }
    const hay = [];
    if (kind === "model") {
      hay.push(item.id || "", item.provider || "", item.name || "");
    } else if (kind === "options") {
      hay.push(item.label || "", item.desc || "");
    } else if (kind === "relay") {
      hay.push(item.label || "", item.tabName || "", item.id || "");
    } else {
      hay.push(item.userPreview || "", item.assistantPreview || "", item.timestamp || "");
    }
    return hay.some((s) => s.toLowerCase().includes(q));
  }
  const THINKING_LABELS = {
    off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大",
  };
  const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  function thinkingLabel(level) { return THINKING_LABELS[level] || level || ""; }
  function modelKey(item) { return (item.provider || "") + "\u0000" + (item.id || ""); }
  function modelThinkingLevels(item) { return Array.isArray(item.thinkingLevels) ? item.thinkingLevels : []; }
  /** 模型价格（$/M tokens）：cost 存在且有有效费率时返回 { text, tip }。 */
  function modelCostInfo(item) {
    const c = item && item.cost;
    if (!c || typeof c !== "object") { return null; }
    const nIn = typeof c.input === "number" ? c.input : 0;
    const nOut = typeof c.output === "number" ? c.output : 0;
    if (!(nIn > 0) && !(nOut > 0)) { return null; }
    const text = "入 $" + nIn + " / 出 $" + nOut + "/M";
    const lines = ["输入：$" + nIn, "输出：$" + nOut];
    if (typeof c.cacheRead === "number" && c.cacheRead > 0) { lines.push("缓存读：$" + c.cacheRead); }
    if (typeof c.cacheWrite === "number" && c.cacheWrite > 0) { lines.push("缓存写：$" + c.cacheWrite); }
    return { text: text, tip: "每百万 tokens 价格\n" + lines.join("\n") };
  }
  function isCurrentModel(st, item) {
    return !!item && (modelKey(item) === st.current || item.current === true);
  }
  function currentModelItem(st) {
    return st.items.find((item) => isCurrentModel(st, item)) || null;
  }
  function currentThinkingLevel(st) {
    const item = currentModelItem(st);
    return item && item.reasoning ? (item.currentThinking || "medium") : "";
  }
  function defaultThinkingForModel(st, item) {
    if (!item || !item.reasoning) { return undefined; }
    const levels = modelThinkingLevels(item);
    if (levels.length === 0) { return undefined; }
    // 尽量保留当前档位；不支持时按 pi 的默认 medium 进行就近钳制。
    const current = currentThinkingLevel(st);
    if (current && levels.includes(current)) { return current; }
    const preferredIndex = THINKING_ORDER.indexOf("medium");
    for (let i = preferredIndex; i < THINKING_ORDER.length; i++) {
      if (levels.includes(THINKING_ORDER[i])) { return THINKING_ORDER[i]; }
    }
    for (let i = preferredIndex - 1; i >= 0; i--) {
      if (levels.includes(THINKING_ORDER[i])) { return THINKING_ORDER[i]; }
    }
    return levels[0];
  }
  function modelDraftChanged(st) {
    if (!st.draftModel) { return false; }
    if (!isCurrentModel(st, st.draftModel)) { return true; }
    const draftLevel = st.draftModel.reasoning ? (st.draftThinking || "medium") : "";
    return draftLevel !== currentThinkingLevel(st);
  }
  function selectModelIndex(st, idx, scroll) {
    const item = st.filtered[idx];
    if (!item) { return; }
    st.sel = idx;
    st.draftModel = item;
    st.draftThinking = defaultThinkingForModel(st, item);
    renderPickerItems();
    if (scroll) {
      const active = pickerBody.querySelector(".pk-model-item.active");
      if (active) { active.scrollIntoView({ block: "nearest" }); }
    }
  }
  function moveModelThinking(delta) {
    const st = pickerState;
    if (!st || st.kind !== "model" || !st.draftModel || !st.draftModel.reasoning) { return; }
    const levels = modelThinkingLevels(st.draftModel);
    if (levels.length === 0) { return; }
    let index = levels.indexOf(st.draftThinking);
    if (index < 0) { index = 0; }
    st.draftThinking = levels[(index + delta + levels.length) % levels.length];
    renderPickerItems();
  }
  function renderModelThinking(item, st, right) {
    if (st.draftModel !== item) { return; }
    right.classList.add("has-content");
    const label = document.createElement("div"); label.className = "pk-thinking-label"; label.textContent = "推理强度";
    right.appendChild(label);
    if (!item.reasoning) {
      const unsupported = document.createElement("div"); unsupported.className = "pk-thinking-unsupported"; unsupported.textContent = "不支持推理";
      right.appendChild(unsupported);
      return;
    }
    const levels = modelThinkingLevels(item);
    if (levels.length === 0) {
      const failed = document.createElement("div"); failed.className = "pk-thinking-unsupported"; failed.textContent = "无法获取设置";
      right.appendChild(failed);
      return;
    }
    const options = document.createElement("div"); options.className = "pk-thinking-options";
    levels.forEach((level) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pk-thinking-btn" + (level === st.draftThinking ? " on" : "");
      button.textContent = thinkingLabel(level);
      button.title = level;
      button.setAttribute("aria-pressed", level === st.draftThinking ? "true" : "false");
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        st.draftThinking = level;
        renderPickerItems();
      });
      options.appendChild(button);
    });
    right.appendChild(options);
  }
  function renderModelFooter(st) {
    pickerFooter.innerHTML = "";
    pickerFooter.classList.remove("hidden");
    pickerFooter.classList.add("pk-model-footer");
    const summary = document.createElement("div"); summary.className = "pk-footer-summary";
    if (!st.draftModel) {
      summary.textContent = "选择模型以查看推理设置";
    } else {
      const modelName = st.draftModel.name && st.draftModel.name !== st.draftModel.id
        ? st.draftModel.name + " · " + st.draftModel.id : st.draftModel.id;
      const levelText = st.draftModel.reasoning
        ? (st.draftThinking ? "推理 " + thinkingLabel(st.draftThinking) : "推理未选择")
        : "不支持推理";
      const costInfo = modelCostInfo(st.draftModel);
      summary.textContent = "待应用：" + modelName + " · " + levelText + (costInfo ? " · " + costInfo.text : "");
    }
    pickerFooter.appendChild(summary);
    const actions = document.createElement("div"); actions.className = "pk-footer-actions";
    const cancelBtn = document.createElement("button"); cancelBtn.type = "button"; cancelBtn.className = "secondary"; cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => cancelPicker());
    actions.appendChild(cancelBtn);
    const confirmBtn = document.createElement("button"); confirmBtn.type = "button"; confirmBtn.className = "primary"; confirmBtn.textContent = "确认切换";
    const ready = !!st.draftModel && (!st.draftModel.reasoning || modelThinkingLevels(st.draftModel).length > 0);
    confirmBtn.disabled = !ready || !modelDraftChanged(st);
    confirmBtn.addEventListener("click", () => submitModelPicker());
    actions.appendChild(confirmBtn);
    pickerFooter.appendChild(actions);
  }
  function renderPickerItems() {
    const st = pickerState;
    if (!st) { return; }
    const q = (pickerSearch.value || "").toLowerCase().trim();
    if (st.kind === "relay") {
      // 树形过滤：tab 名命中 → 整组保留；否则仅保留自身命中的 panel 子项，空组剔除
      st.filtered = [];
      let i = 0;
      while (i < st.items.length) {
        const it = st.items[i];
        if (it.kind !== "tab") { i++; continue; }
        const tabMatch = pickerItemMatch(it, "relay", q);
        let j = i + 1;
        const kids = [];
        while (j < st.items.length && st.items[j].kind !== "tab") {
          if (tabMatch || pickerItemMatch(st.items[j], "relay", q)) { kids.push(st.items[j]); }
          j++;
        }
        if (kids.length > 0) {
          st.filtered.push(it, ...kids);
        }
        i = j;
      }
    } else {
      st.filtered = st.items.filter((it) => pickerItemMatch(it, st.kind, q));
    }
    if (st.kind === "model") {
      if (st.draftModel) {
        const draftIndex = st.filtered.indexOf(st.draftModel);
        if (draftIndex >= 0) {
          st.sel = draftIndex;
        } else {
          st.sel = -1;
          st.draftModel = null;
          st.draftThinking = undefined;
        }
      } else if (st.sel >= st.filtered.length) {
        st.sel = -1;
      }
    } else if (st.sel >= st.filtered.length) {
      st.sel = Math.max(0, st.filtered.length - 1);
    }
    pickerBody.innerHTML = "";
    if (st.filtered.length === 0) {
      const empty = document.createElement("div"); empty.className = "pk-empty";
      if (q) {
        // 搜索无结果：history 分页下提示只搜了已加载范围，可加载更多再搜。
        if (st.kind === "history" && st.historyLoadedFamilies !== null && st.historyTotalFamilies !== null && st.historyLoadedFamilies < st.historyTotalFamilies) {
          empty.textContent = "在已加载 " + st.historyLoadedFamilies + " / " + st.historyTotalFamilies + " 个家族中未命中。";
          empty.classList.add("pk-empty-paged");
        } else if (st.kind === "history" && st.historyLoadedFamilies !== null && st.historyTotalFamilies !== null) {
          empty.textContent = "在全部 " + st.historyTotalFamilies + " 个家族中未命中。";
        } else {
          empty.textContent = "没有匹配项。";
        }
      } else {
        empty.textContent = "列表为空。";
      }
      pickerBody.appendChild(empty);
      // 有匹配项为空但仍有更多未加载时，同样给出加载更多入口。
      if (st.kind === "history" && st.historyLoadedFamilies !== null && st.historyTotalFamilies !== null && st.historyLoadedFamilies < st.historyTotalFamilies) {
        pickerBody.appendChild(buildHistoryLoadMoreBtn(st));
      }
      if (st.kind === "model") { renderModelFooter(st); }
      return;
    }
    let lastSection = null;
    let lastModelProv = null;
    st.filtered.forEach((item, idx) => {
      if (st.kind === "model") {
        // provider 分组分隔线：host 已按 provider 排序，同 provider 项连续；
        // 标题带组内数量（随搜索过滤实时重算），无 provider 归入“其他”。
        if ((item.provider || "") !== lastModelProv) {
          lastModelProv = item.provider || "";
          const runCount = st.filtered.filter((x) => (x.provider || "") === lastModelProv).length;
          const sep = document.createElement("div"); sep.className = "pk-section pk-provider";
          sep.textContent = (item.provider || "其他") + " (" + runCount + ")";
          pickerBody.appendChild(sep);
        }
        const el = document.createElement("div");
        const isSelected = st.draftModel === item;
        el.className = "pk-item pk-model-item" + (isSelected ? " active" : "");
        if (item.current) { el.classList.add("current"); }
        if (isSelected && !isCurrentModel(st, item)) { el.classList.add("pending"); }

        const main = document.createElement("div"); main.className = "pk-model-main";
        const title = document.createElement("div"); title.className = "pk-title"; title.textContent = item.id || "(未命名模型)";
        if (item.current) { const badge = document.createElement("span"); badge.className = "pk-badge"; badge.textContent = "当前"; title.appendChild(badge); }
        if (isSelected && !isCurrentModel(st, item)) { const badge = document.createElement("span"); badge.className = "pk-badge pending-badge"; badge.textContent = "待应用"; title.appendChild(badge); }
        main.appendChild(title);
        const desc = (item.provider ? item.provider : "") + (item.name && item.name !== item.id ? (item.provider ? " · " : "") + item.name : "");
        if (desc) { const d = document.createElement("div"); d.className = "pk-desc"; d.textContent = desc; main.appendChild(d); }
        const details = [];
        if (item.contextWindow) { details.push("上下文 " + Math.round(item.contextWindow / 1000) + "K"); }
        const priceInfo = modelCostInfo(item);
        if (priceInfo) { details.push(priceInfo.text); }
        if (details.length) {
          const det = document.createElement("div"); det.className = "pk-detail";
          det.textContent = details.join(" · ");
          if (priceInfo) { det.title = priceInfo.tip; }
          main.appendChild(det);
        }
        const right = document.createElement("div"); right.className = "pk-model-thinking";
        renderModelThinking(item, st, right);
        el.appendChild(main); el.appendChild(right);
        el.addEventListener("click", () => selectModelIndex(st, idx, true));
        pickerBody.appendChild(el);
        return;
      }

      if (item.section && item.section !== lastSection) {
        lastSection = item.section;
        const sep = document.createElement("div"); sep.className = "pk-section"; sep.textContent = item.section;
        pickerBody.appendChild(sep);
      }
      const el = document.createElement("div");
      el.className = "pk-item" + (idx === st.sel ? " active" : "");
      if (st.kind === "history") {
        el.classList.add("pk-history");
        if (st.current && item.file === st.current) { el.classList.add("current"); }
        // 缩进体现父子分支：depth 0 无额外缩进，子会话逐级缩进。
        const depth = typeof item.depth === "number" ? item.depth : 0;
        if (depth > 0) { el.style.paddingLeft = (12 + depth * 20) + "px"; }
        // 元信息行：时间 + 分支标记
        const meta = document.createElement("div"); meta.className = "pk-history-meta";
        const ts = item.timestamp ? formatSessionTs(item.timestamp) : "";
        if (ts) { const t = document.createElement("span"); t.className = "pk-history-ts"; t.textContent = ts; meta.appendChild(t); }
        if (depth > 0) {
          const br = document.createElement("span"); br.className = "pk-history-branch"; br.textContent = "分支";
          meta.appendChild(br);
        }
        el.appendChild(meta);
        // 我：用户提问（主题，最多两行）
        const u = (item.userPreview || "").trim();
        if (u) {
          const ur = document.createElement("div"); ur.className = "pk-history-user";
          const ul = document.createElement("span"); ul.className = "pk-history-role"; ul.textContent = "我";
          const ut = document.createElement("span"); ut.className = "pk-history-text"; ut.textContent = u;
          ur.appendChild(ul); ur.appendChild(ut);
          el.appendChild(ur);
        }
        // AI：摘要（一行）
        const a = (item.assistantPreview || "").trim();
        if (a) {
          const ar = document.createElement("div"); ar.className = "pk-history-ai";
          const al = document.createElement("span"); al.className = "pk-history-role pk-history-role-ai"; al.textContent = "AI";
          const at = document.createElement("span"); at.className = "pk-history-text"; at.textContent = a;
          ar.appendChild(al); ar.appendChild(at);
          el.appendChild(ar);
        }
        if (!u && !a) {
          const em = document.createElement("div"); em.className = "pk-history-empty"; em.textContent = "(空)";
          el.appendChild(em);
        }
      } else if (st.kind === "options") {
        const t = document.createElement("div"); t.className = "pk-title";
        const chk = document.createElement("span"); chk.className = "pk-check" + (item.check === true ? " on" : "");
        chk.textContent = item.check === true ? "✓" : "";
        t.appendChild(chk);
        t.appendChild(document.createTextNode(item.label || ""));
        el.appendChild(t);
        if (item.desc) { const d = document.createElement("div"); d.className = "pk-desc"; d.style.paddingLeft = "20px"; d.textContent = item.desc; el.appendChild(d); }
      } else if (st.kind === "relay") {
        if (item.kind === "tab") {
          // tab 分组头：整行 = 广播动作（行尾 ⟶ 按钮为视觉锚点）
          el.classList.add("pk-relay-tab");
          const name = document.createElement("span"); name.className = "pk-relay-name";
          name.textContent = "「" + (item.label || "") + "」";
          const count = document.createElement("span"); count.className = "pk-relay-count";
          count.textContent = item.count + " 个 panel";
          const bcast = document.createElement("span"); bcast.className = "pk-relay-bcast";
          bcast.textContent = "⟶ 发给全部";
          el.appendChild(name); el.appendChild(count); el.appendChild(bcast);
        } else {
          // panel 行：点对点
          el.classList.add("pk-relay-panel");
          const t = document.createElement("div"); t.className = "pk-title";
          t.textContent = item.label || item.id || "";
          el.appendChild(t);
        }
      }
      el.addEventListener("mouseenter", () => { st.sel = idx; renderPickerActive(); });
      el.addEventListener("click", () => { confirmPicker(idx); });
      pickerBody.appendChild(el);
    });
    // history 分页：列表底部追加“加载更多”按钮。
    if (st.kind === "history" && st.historyLoadedFamilies !== null && st.historyTotalFamilies !== null && st.historyLoadedFamilies < st.historyTotalFamilies) {
      pickerBody.appendChild(buildHistoryLoadMoreBtn(st));
    }
    if (st.kind === "model") { renderModelFooter(st); }
  }
  function buildHistoryLoadMoreBtn(st) {
    const btn = document.createElement("button");
    btn.className = "pk-loadmore secondary";
    const remaining = (st.historyTotalFamilies || 0) - (st.historyLoadedFamilies || 0);
    btn.textContent = st.historyLoading
      ? "加载中…"
      : "加载更多（剩余 " + remaining + " / 共 " + st.historyTotalFamilies + " 个家族）";
    btn.disabled = !!st.historyLoading;
    btn.addEventListener("click", () => {
      if (st.historyLoading) { return; }
      st.historyLoading = true;
      renderPickerItems();
      vscode.postMessage({ type: "historyLoadMore" });
    });
    return btn;
  }
  function renderPickerActive() {
    const st = pickerState; if (!st) { return; }
    const items = pickerBody.querySelectorAll(".pk-item");
    items.forEach((el, i) => el.classList.toggle("active", i === st.sel));
    const cur = items[st.sel];
    if (cur) { cur.scrollIntoView({ block: "nearest" }); }
  }
  function submitModelPicker() {
    const st = pickerState;
    if (!st || st.kind !== "model" || !st.draftModel) { return; }
    const ready = !st.draftModel.reasoning || modelThinkingLevels(st.draftModel).length > 0;
    if (!ready || !modelDraftChanged(st)) { return; }
    const payload = {
      provider: st.draftModel.provider || "",
      modelId: st.draftModel.id,
      thinkingLevel: st.draftThinking,
    };
    hidePicker();
    vscode.postMessage({ type: "pickerChoice", kind: "model", payload });
  }
  function confirmPicker(idx) {
    const st = pickerState; if (!st) { return; }
    if (st.kind === "model") { submitModelPicker(); return; }
    const item = st.filtered[idx];
    if (!item) { return; }
    const kind = st.kind;
    if (st.toggle || item.behavior === "toggle") {
      vscode.postMessage({ type: "pickerToggle", kind, action: item.action, value: item.value });
      return;
    }
    // 转发：tab 行 = 广播（tabId）；panel 行 = 点对点（id）
    const payload = kind === "relay"
      ? (item.kind === "tab" ? { tabId: item.id } : { id: item.id })
      : { file: item.file };
    hidePicker();
    vscode.postMessage({ type: "pickerChoice", kind, payload });
  }
  function cancelPicker() {
    const st = pickerState; if (!st) { return; }
    const kind = st.kind;
    hidePicker();
    vscode.postMessage({ type: "pickerCancel", kind });
  }
  function renderPicker(msg) {
    const kind = msg.kind;
    const toggle = !!msg.toggle;
    const searchable = msg.searchable !== false && !toggle;
    pickerState = {
      kind,
      items: Array.isArray(msg.items) ? msg.items : [],
      filtered: [],
      sel: kind === "model" ? -1 : 0,
      current: msg.current || null,
      draftModel: null,
      draftThinking: undefined,
      toggle,
      // history 分页：已加载家族数 / 总家族数。缺省时按旧逻辑不分页。
      historyTotalFamilies: typeof msg.totalFamilies === "number" ? msg.totalFamilies : null,
      historyLoadedFamilies: typeof msg.loadedFamilies === "number" ? msg.loadedFamilies : null,
      historyLoading: false,
    };
    const titleMap = { model: "切换模型", history: "会话历史", options: "显示选项", relay: "转发到…" };
    pickerTitle.textContent = titleMap[kind] || "选择";
    pickerSearch.value = "";
    pickerSearchWrap.classList.toggle("hidden", !searchable);
    pickerFooter.classList.remove("pk-model-footer");
    pickerFooter.innerHTML = "";
    if (kind === "model") {
      pickerFooter.classList.remove("hidden");
      // 预选当前模型为 draft（host 已把它排到列表第一位）：打开即高亮 +
      // 推理强度/footer 就绪；无改动时 Enter 提交被 no-op 保护拦掉。
      const cur = pickerState.items.find((it) => it.current);
      if (cur) {
        pickerState.draftModel = cur;
        pickerState.draftThinking = defaultThinkingForModel(pickerState, cur);
      }
    } else if (toggle) {
      pickerFooter.classList.remove("hidden");
      const closeBtn = document.createElement("button"); closeBtn.className = "secondary"; closeBtn.textContent = "关闭";
      closeBtn.addEventListener("click", () => cancelPicker());
      pickerFooter.appendChild(closeBtn);
    } else {
      pickerFooter.classList.add("hidden");
    }
    renderPickerItems();
    pickerOverlay.classList.remove("hidden");
    // 计时：若宿主回显了 t0，输出点击 → picker 可见的往返耗时（多 panel 卡顿排查用）
    if (typeof msg.t0 === "number") {
      console.log("[pi] picker(" + kind + ") 点击→弹出: " + Math.round(performance.now() - msg.t0) + "ms");
    }
    if (searchable) { setTimeout(() => pickerSearch.focus(), 0); }
  }
  pickerOverlay.addEventListener("click", (e) => { if (e.target === pickerOverlay) { cancelPicker(); } });
  pickerSearch.addEventListener("input", () => {
    if (!pickerState) { return; }
    pickerState.sel = pickerState.kind === "model" ? -1 : 0;
    renderPickerItems();
  });
  document.addEventListener("keydown", (e) => {
    if (!pickerState || pickerOverlay.classList.contains("hidden")) { return; }
    const st = pickerState;
    if (st.kind === "model") {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (st.filtered.length) {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          let next = st.sel < 0 ? (delta > 0 ? 0 : st.filtered.length - 1) : st.sel + delta;
          next = (next + st.filtered.length) % st.filtered.length;
          selectModelIndex(st, next, true);
        }
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        moveModelThinking(e.key === "ArrowRight" ? 1 : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        submitModelPicker();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelPicker();
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); if (st.filtered.length) { st.sel = (st.sel + 1) % st.filtered.length; renderPickerActive(); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (st.filtered.length) { st.sel = (st.sel - 1 + st.filtered.length) % st.filtered.length; renderPickerActive(); } }
    else if (e.key === "Enter") { e.preventDefault(); confirmPicker(st.sel); }
    else if (e.key === "Escape") { e.preventDefault(); cancelPicker(); }
  });


  // ==================== @ 文件引用 ====================
  let fileMatches = [];
  let fileSel = 0;
  let atStart = -1;
  function hideFileMenu() { fileMenuEl.classList.add("hidden"); atStart = -1; }
  function maybeShowFileMenu() {
    if (inputEl.value.length > BIG_TEXT_CHARS) { hideFileMenu(); return; }
    const pos = inputEl.selectionStart;
    const before = inputEl.value.slice(0, pos);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) { hideFileMenu(); return; }
    // @ 触发时若 # 会话菜单开着：重置其状态（两菜单共用同一个浮层节点）
    hashOpen = false; hashStart = -1;
    atStart = pos - m[2].length - 1;
    vscode.postMessage({ type: "listFiles" });
    filterFiles(m[2]);
  }
  function filterFiles(query) {
    const q = (query || "").toLowerCase();
    fileMatches = openFiles.filter((f) => f.label.toLowerCase().includes(q)).slice(0, 20);
    fileSel = 0;
    renderFileMenu();
  }
  function renderFileMenu() {
    if (fileMatches.length === 0) { fileMenuEl.classList.add("hidden"); return; }
    fileMenuEl.innerHTML = "";
    fileMatches.forEach((f, idx) => {
      const item = document.createElement("div"); item.className = "file-item" + (idx === fileSel ? " active" : "");
      const slash = f.label.lastIndexOf("/");
      if (slash >= 0) { const dir = document.createElement("span"); dir.className = "dir"; dir.textContent = f.label.slice(0, slash + 1); item.appendChild(dir); item.appendChild(document.createTextNode(f.label.slice(slash + 1))); }
      else { item.textContent = f.label; }
      item.addEventListener("mousedown", (e) => { e.preventDefault(); fileSel = idx; chooseFile(); });
      fileMenuEl.appendChild(item);
    });
    fileMenuEl.classList.remove("hidden");
  }
  function moveFileSel(delta) { if (fileMatches.length === 0) return; fileSel = (fileSel + delta + fileMatches.length) % fileMatches.length; renderFileMenu(); }
  function chooseFile() {
    const f = fileMatches[fileSel];
    if (!f || atStart < 0) { hideFileMenu(); return; }
    const pos = inputEl.selectionStart;
    const ref = "@" + f.label + " ";
    inputEl.value = inputEl.value.slice(0, atStart) + ref + inputEl.value.slice(pos);
    const newPos = atStart + ref.length;
    inputEl.selectionStart = inputEl.selectionEnd = newPos;
    hideFileMenu(); autoResize(); inputEl.focus();
  }

  // ==================== # 会话引用（获取其他 panel/tab 的上下文） ====================
  let hashMatches = [];   // [{kind:"tab"|"panel", id, label, sub}]
  let hashSel = 0;
  let hashStart = -1;     // # 触发字符在输入框的位置
  let hashOpen = false;
  let hashReqSeq = 0;
  function hideHashMenu() { fileMenuEl.classList.add("hidden"); hashStart = -1; hashOpen = false; }
  function maybeShowHashMenu() {
    if (inputEl.value.length > BIG_TEXT_CHARS) { hideHashMenu(); return; }
    const pos = inputEl.selectionStart;
    const before = inputEl.value.slice(0, pos);
    const m = before.match(/(^|\s)#([^\s#]*)$/);
    if (!m) { hideHashMenu(); return; }
    hashStart = pos - m[2].length - 1;
    hideFileMenu();
    hashOpen = true;
    filterHashMenu(m[2]);
  }

  /** 候选：tab 组行（获取整个 tab）+ panel 行；排除当前焦点 panel（relay 同款语义）。
   *  数据全在本地（tabViews/tabs），不等宿主往返。 */
  function hashMenuItems() {
    const items = [];
    tabViews.forEach((tv) => {
      const kids = leavesOf(tv.root).filter((pid) => pid !== activeId);
      if (!kids.length) { return; }
      items.push({ kind: "tab", id: tv.id, label: tv.name || "tab", sub: kids.length + " 个会话", tabId: tv.id });
      kids.forEach((pid) => {
        const st = tabs.get(pid);
        if (!st) { return; }
        items.push({ kind: "panel", id: pid, label: st.title || "对话", sub: tv.name || "", tabId: tv.id });
      });
    });
    return items;
  }

  function filterHashMenu(query) {
    const q = (query || "").toLowerCase();
    const all = hashMenuItems();
    if (!q) { hashMatches = all; }
    else {
      // tab 名命中 → 整组保留；否则只留自身命中的 panel 行，空组剔除（同 relay 过滤器语义）
      const keptTabs = new Set();
      all.forEach((it) => {
        if (it.kind === "tab" && it.label.toLowerCase().includes(q)) { keptTabs.add(it.tabId); }
      });
      const kept = [];
      all.forEach((it) => {
        if (it.kind === "tab") {
          if (keptTabs.has(it.id)) { kept.push(it); }
        } else if (keptTabs.has(it.tabId) || it.label.toLowerCase().includes(q)) {
          kept.push(it);
          keptTabs.add(it.tabId);
        }
      });
      hashMatches = kept;
    }
    hashSel = 0;
    renderHashMenu();
  }

  function renderHashMenu() {
    if (!hashMatches.length) { fileMenuEl.classList.add("hidden"); return; }
    fileMenuEl.innerHTML = "";
    hashMatches.forEach((it, idx) => {
      const item = document.createElement("div");
      item.className = "file-item" + (idx === hashSel ? " active" : "") + (it.kind === "tab" ? " hash-tab-row" : "");
      item.appendChild(document.createTextNode((it.kind === "tab" ? "🗂 " : "💬 ") + it.label));
      if (it.sub) {
        const sub = document.createElement("span"); sub.className = "dir"; sub.textContent = "  " + it.sub;
        item.appendChild(sub);
      }
      item.addEventListener("mousedown", (e) => { e.preventDefault(); hashSel = idx; chooseHash(); });
      fileMenuEl.appendChild(item);
    });
    fileMenuEl.classList.remove("hidden");
  }
  function moveHashSel(delta) {
    if (!hashMatches.length) { return; }
    hashSel = (hashSel + delta + hashMatches.length) % hashMatches.length;
    renderHashMenu();
  }
  function chooseHash() {
    const it = hashMatches[hashSel];
    if (!it || hashStart < 0) { hideHashMenu(); return; }
    // 删掉 #查询 token（出处信息由卡片头部承载）
    const pos = inputEl.selectionStart;
    inputEl.value = inputEl.value.slice(0, hashStart) + inputEl.value.slice(pos);
    inputEl.selectionStart = inputEl.selectionEnd = hashStart;
    hideHashMenu(); autoResize(); inputEl.focus();
    hashReqSeq++;
    vscode.postMessage(it.kind === "tab"
      ? { type: "fetchChat", tabId: it.id, requestId: hashReqSeq }
      : { type: "fetchChat", panelId: it.id, requestId: hashReqSeq });
  }

  /** fetchChatResult：会话内容入草稿卡片（标题/体积由宿主算好）。 */
  function applyFetchChatResult(msg) {
    if (msg.requestId !== hashReqSeq) { return; }   // 过期 / 竞态结果丢弃
    if (!activeTab()) { return; }
    const d = draftOfTab();
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!text) { return; }
    const lines = text.split("\n").length;
    d.textBlocks.push({ text, lines, chars: text.length, title: typeof msg.title === "string" ? msg.title : undefined });
    renderAttachmentsFor();
    inputEl.focus();
  }

  // ==================== / 命令菜单（技能 / 提示模板 / 扩展命令） ====================
  /** 宿主 get_commands 结果缓存：[{insert, name, description, source}]；
   *  宿主 pi 进程启动/刷新时会主动推 commandList 覆盖。 */
  let commandListCache = [];
  /** 上次向宿主要列表的时间：空结果时 5s 内不重复请求（避免每次敲 / 都打一次 RPC）。 */
  let commandListReqAt = 0;
  let slashMatches = [];
  let slashSel = 0;
  let slashOpen = false;
  function requestCommandList() {
    if (commandListCache.length > 0) { return; }
    const now = Date.now();
    if (commandListReqAt && now - commandListReqAt < 5000) { return; }
    commandListReqAt = now;
    vscode.postMessage({ type: "listCommands" });
  }
  function closeSlashMenu() { slashOpen = false; slashMatches = []; }
  function maybeShowSlashMenu() {
    if (inputEl.value.length > BIG_TEXT_CHARS) { closeSlashMenu(); return; }
    // 输入整体是单个 / 开头的 token（命令 + 正在输入的名字）才弹菜单；
    // 敲了空格/其它内容就不再弹，交给用户继续写参数。
    const m = inputEl.value.match(/^\/(\S*)$/);
    if (!m) { closeSlashMenu(); return; }
    // 三个菜单共用同一个浮层节点：接管前重置兄弟菜单状态
    atStart = -1; hashOpen = false; hashStart = -1;
    slashOpen = true;
    requestCommandList();
    filterSlashMenu(m[1]);
  }
  function filterSlashMenu(query) {
    const q = (query || "").toLowerCase();
    slashMatches = commandListCache
      .filter((it) => !q || (it.name || "").toLowerCase().includes(q))
      .slice(0, 30);
    slashSel = 0;
    renderSlashMenu();
  }
  function renderSlashMenu() {
    if (!slashMatches.length) { fileMenuEl.classList.add("hidden"); return; }
    fileMenuEl.innerHTML = "";
    slashMatches.forEach((it, idx) => {
      const item = document.createElement("div");
      item.className = "file-item" + (idx === slashSel ? " active" : "");
      const nameSpan = document.createElement("span");
      nameSpan.textContent = it.insert || ("/" + (it.name || ""));
      item.appendChild(nameSpan);
      if (it.source) {
        const badge = document.createElement("span");
        badge.className = "cmd-badge cmd-" + it.source;
        badge.textContent = it.source === "skill" ? "技能" : it.source === "prompt" ? "模板" : it.source === "extension" ? "命令" : "";
        item.appendChild(badge);
      }
      if (it.description) {
        const sub = document.createElement("span");
        sub.className = "dir";
        sub.textContent = "  " + it.description;
        item.appendChild(sub);
      }
      item.addEventListener("mousedown", (e) => { e.preventDefault(); slashSel = idx; chooseSlash(); });
      fileMenuEl.appendChild(item);
    });
    fileMenuEl.classList.remove("hidden");
  }
  function moveSlashSel(delta) {
    if (!slashMatches.length) { return; }
    slashSel = (slashSel + delta + slashMatches.length) % slashMatches.length;
    renderSlashMenu();
  }
  /** 选中候选：替换整个输入框内容为 "/name "（光标在末尾，继续敲参数）。 */
  function chooseSlash() {
    const it = slashMatches[slashSel];
    if (!it) { closeSlashMenu(); return; }
    inputEl.value = (it.insert || ("/" + (it.name || ""))) + " ";
    closeSlashMenu();
    fileMenuEl.classList.add("hidden");
    autoResize();
    inputEl.focus();
    inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
  }

  // ==================== 发送 ====================
  function autoResize() {
    if (inputEl.value.length > BIG_TEXT_CHARS) { inputEl.style.height = "640px"; return; }
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight - 12, 144), 640) + "px";
  }
  function shouldFoldText(text) {
    if (typeof text !== "string" || !text) { return false; }
    if (text.length > BIG_TEXT_CHARS) { return true; }
    return countLines(text) > BIG_TEXT_LINES;
  }
  function send() {
    const tab = activeTab();
    if (!tab) { return; }
    if (!tab.piReady) { return; }
    const d = draftOfTab();
    const typed = inputEl.value.trim();
    const hasImages = (d.images || []).length > 0;
    const hasTextBlocks = (d.textBlocks || []).length > 0;
    if (!typed && !hasImages && !hasTextBlocks) { return; }
    let text = typed;
    if (hasTextBlocks) {
      const parts = d.textBlocks.map((b) => {
        const safeText = b.text.replace(/\u0060{4,}/g, (m) => m.split("").join("\u200b"));
        return "````\n" + safeText + "\n````";
      });
      text = (typed ? typed + "\n\n" : "") + parts.join("\n\n");
    }
    // 发送走 tab 级广播：后端把消息（含同一份附件）投给该 tab 内所有 panel
    vscode.postMessage({ type: "send", tabId: tab.id, text, images: d.images });
    inputEl.value = "";
    inputEl.style.height = "144px";
    d.text = "";
    d.height = 144;
    d.images = [];
    d.textBlocks = [];
    hideFileMenu(); hideHashMenu(); closeSlashMenu(); fileMenuEl.classList.add("hidden");
    renderAttachmentsFor();
  }

  // ==================== 事件绑定 ====================
  if (jumpBottomBtn) {
    jumpBottomBtn.addEventListener("click", () => {
      const tab = activeTab();
      if (tab) { scrollToBottom(tab, true); }
    });
  }
  // 每个 panel 底部都有自己的状态栏（.pane-status）：点击 = 切该 panel 模型

  // 委托：文件/符号链接点击（在 #messages 容器上）
  messagesEl.addEventListener("click", (e) => {
    const a = e.target.closest("a.file-link");
    if (a) { e.preventDefault(); const path = a.getAttribute("data-file"); if (!path) { return; } const line = a.dataset.line ? parseInt(a.dataset.line, 10) : undefined; const col = a.dataset.col ? parseInt(a.dataset.col, 10) : undefined; vscode.postMessage({ type: "openFile", path, line, col }); return; }
    const s = e.target.closest("a.symbol-link");
    if (s) { e.preventDefault(); const name = s.getAttribute("data-symbol"); if (name) { vscode.postMessage({ type: "openSymbol", name }); } return; }
  });
  messagesEl.addEventListener("dblclick", (e) => {
    const code = e.target && e.target.closest ? e.target.closest("code") : null;
    if (!code || code.closest("pre")) { return; }
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { return; }
      let tail = 0; const txt = sel.toString();
      while (tail < txt.length && /\s/.test(txt[txt.length - 1 - tail])) { tail++; }
      if (tail === 0) { return; }
      if (sel.focusNode && sel.focusNode.nodeType === Node.TEXT_NODE && sel.focusOffset >= tail) {
        sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset - tail);
      }
    }, 0);
  });

  // 用户主动接管滚动：滚轮上滑 / 触屏上滑 打断 lerp 追底（按实际滚动到的 pane 判定）
  messagesEl.addEventListener("wheel", (e) => {
    const pane = e.target.closest(".tab-pane");
    if (!pane) { return; }
    const t = tabs.get(pane.dataset.tabId);
    if (!t) { return; }
    if (e.deltaY < 0) { userTookOverScroll(t); }
  }, { passive: true });
  messagesEl.addEventListener("touchstart", (e) => {
    const pane = e.target.closest(".tab-pane");
    if (!pane) { return; }
    const t = tabs.get(pane.dataset.tabId);
    if (t) { userTookOverScroll(t); }
  }, { passive: true });
  document.addEventListener("keydown", (e) => {
    if (activeId === null) { return; }
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") { return; }
    const t = tabs.get(activeId);
    if (!t) { return; }
    const k = (e.key || "");
    if (k === "PageUp" || k === "ArrowUp" || k === "Home" || k === " ") { userTookOverScroll(t); }
  }, { passive: true });

  // 流式生成中中止：当前 tab 内所有生成中的 panel 一停全停
  function abortActiveTab() {
    const tv = tabViews.get(activeTabId);
    if (!tv) { return false; }
    const streamingLeaves = leavesOf(tv.root).filter((pid) => {
      const t = tabs.get(pid);
      return !!t && t.streaming;
    });
    if (streamingLeaves.length === 0) { return false; }
    const focus = tabs.get(activeId);
    if (focus) { focus.pendingSteerRestore = (focus.queuedSteering || []).slice(); }
    vscode.postMessage({ type: "abort", tabId: activeId });
    return true;
  }

  treeOverlay.addEventListener("click", (e) => { if (e.target === treeOverlay) { hideTree(); } });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") { return; }
    // 树面板打开 → 关树；picker 打开 → 交给 picker 监听关闭
    if (!treeOverlay.classList.contains("hidden")) { hideTree(); return; }
    if (pickerState && !pickerOverlay.classList.contains("hidden")) { return; }
    // 输入框聚焦时由 inputEl 的 keydown 处理（含文件菜单关闭 / 中止）
    if (document.activeElement === inputEl) { return; }
    // 消息流或其他区域聚焦 → 中止流式生成
    if (abortActiveTab()) { e.preventDefault(); }
  });

  inputEl.addEventListener("keydown", (e) => {
    if (!fileMenuEl.classList.contains("hidden")) {
      if (slashOpen) {
        if (e.key === "ArrowDown") { e.preventDefault(); moveSlashSel(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); moveSlashSel(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseSlash(); return; }
        if (e.key === "Escape") { e.preventDefault(); closeSlashMenu(); fileMenuEl.classList.add("hidden"); return; }
      }
      if (hashOpen) {
        if (e.key === "ArrowDown") { e.preventDefault(); moveHashSel(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); moveHashSel(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseHash(); return; }
        if (e.key === "Escape") { e.preventDefault(); hideHashMenu(); return; }
      }
      if (e.key === "ArrowDown") { e.preventDefault(); moveFileSel(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveFileSel(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseFile(); return; }
      if (e.key === "Escape") { e.preventDefault(); hideFileMenu(); return; }
    }
    // 复刻 pi TUI：流式生成中按 ESC 中止（文件菜单关闭时生效）
    if (e.key === "Escape") { if (abortActiveTab()) { e.preventDefault(); } return; }
    if (isSendKey(e)) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener("input", () => { autoResize(); maybeShowFileMenu(); maybeShowHashMenu(); maybeShowSlashMenu(); });
  inputEl.addEventListener("blur", () => { setTimeout(() => { hideFileMenu(); hideHashMenu(); closeSlashMenu(); fileMenuEl.classList.add("hidden"); }, 150); });
  inputEl.addEventListener("paste", (e) => {
    if (!activeTab()) { return; }
    const d = draftOfTab();
    const cd = e.clipboardData; const items = (cd && cd.items) || [];
    let folded = false;
    for (const item of items) {
      if (item.kind === "string" && item.type === "text/plain") {
        const text = cd.getData("text/plain");
        if (shouldFoldText(text)) { e.preventDefault(); folded = true; const lines = text.split("\n").length; d.textBlocks.push({ text, lines, chars: text.length }); }
        break;
      }
    }
    let handledImage = false;
    for (const item of items) {
      if (item.type && item.type.indexOf("image/") === 0) {
        const file = item.getAsFile(); if (!file) { continue; }
        e.preventDefault(); handledImage = true;
        const reader = new FileReader();
        reader.onload = () => { const result = String(reader.result || ""); const comma = result.indexOf(","); const data = comma >= 0 ? result.slice(comma + 1) : result; d.images.push({ data, mimeType: file.type || "image/png" }); renderAttachmentsFor(); };
        reader.readAsDataURL(file);
      }
    }
    if (folded || handledImage) { renderAttachmentsFor(); }
  });

  // 初始：等待扩展推送 tabList / tabActivated

  function setStreaming(tab, on) {
    tab.streaming = on;
    // tab chip 流式灯：聚合当前 tab 内所有 panel
    const tv = tabViews.get(activeTabId);
    if (tv && leavesOf(tv.root).includes(tab.id)) {
      tv.streaming = leavesOf(tv.root).some((pid) => {
        const t = tabs.get(pid);
        return !!t && t.streaming;
      });
    }
    if (activeId === tab.id) { updateSendState(); syncStatus(); }
    renderTabBar(); updatePaneHeads();
  }
  function setActivity(tab, activity, detail) {
    tab.activity = activity || (tab.streaming ? "working" : "idle");
    tab.activityDetail = detail || "";
    if (activeId === tab.id) { syncStatus(); }
    renderTabBar();
    updatePaneHeads();
  }
  function setPiReady(tab, on, force) { tab.piReady = on; if (activeId === tab.id) { updateSendState(); syncStatus(); } renderTabBar(); updatePaneHeads(); }

  // ==================== 会话导出 ====================
  function exportActiveConversation(tabId, requestId) {
    const tab = tabs.get(tabId);
    if (!tab) { return; }
    // 复制当前 tab，避免导出操作改变正在进行的流式渲染状态；同时把所有
    // markdown 节点按原始文本重绘，确保导出时不会遗漏最后一小段流式内容。
    const liveIndex = tab.currentAssistant
      ? Array.from(tab.paneEl.querySelectorAll(".md")).indexOf(tab.currentAssistant.el)
      : -1;
    const liveRaw = tab.currentAssistant ? (tab.currentAssistant.raw || "") : "";
    const pane = tab.paneEl.cloneNode(true);
    pane.querySelectorAll(".msg-copy").forEach((el) => el.remove());
    const markdownEls = pane.querySelectorAll(".md[data-raw]");
    markdownEls.forEach((el, index) => {
      const raw = index === liveIndex ? liveRaw : (el.dataset.raw || "");
      el.innerHTML = renderMarkdown(raw);
      el.dataset.raw = raw;
    });
    const style = Array.from(document.querySelectorAll("style"))
      .map((el) => el.textContent || "").join("\n");
    // 独立 HTML 没有 VS Code webview 注入的主题变量；用户气泡的最终颜色
    // 直接写入导出 CSS，避免 color-mix() 因变量缺失而变成透明。
    const vars = [];
    const userSource = tab.paneEl.querySelector(".msg.user");
    const userComputed = userSource ? getComputedStyle(userSource) : null;
    const userBackground = userComputed?.backgroundColor || "rgba(90, 150, 220, 0.18)";
    const userColor = userComputed?.color || "inherit";
    const rootStyle = getComputedStyle(document.documentElement);
    const names = new Set((style.match(/--vscode-[\\w-]+/g) || []));
    names.forEach((name) => {
      const value = rootStyle.getPropertyValue(name).trim();
      if (value) { vars.push(`${name}:${value};`); }
    });
    const title = String(tab.title || "Pi 会话").replace(/[<>&\"']/g, "");
    const exportCss = `${style}\n:root{${vars.join("")}}\n` +
      `html,body{height:auto;min-height:100%;margin:0}` +
      `body{display:block;background:var(--vscode-editor-background,#fff);color:var(--vscode-foreground,#222)}` +
      `#messages{display:block;min-height:0}` +
      `.tab-pane{display:block!important;position:static!important;inset:auto!important;visibility:visible!important;pointer-events:auto!important;overflow:visible!important;padding:16px 8px 24px}` +
      `.msg.user{background:${userBackground}!important;color:${userColor}!important}` +
      `.msg.user,.msg.user>div{white-space:pre-wrap!important;overflow-wrap:anywhere;word-break:break-word}` +
      `.msg.user .long-msg{white-space:normal!important}` +
      `.msg.user .long-msg pre{white-space:pre-wrap!important}` +
      `.msg-enter{animation:none!important}` +
      `#jumpBottom,#status,#changedFiles,#inputArea,#tabBar,#treeOverlay,#pickerOverlay,#settingsOverlay{display:none!important}`;
    const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${exportCss}</style></head><body><main id="messages">${pane.outerHTML}</main></body></html>`;
    const markdown = buildMarkdownExport(tab);
    vscode.postMessage({ type: "exportConversationResult", tabId, requestId, html, markdown });
  }

  // ---------------- Markdown 导出辅助 ----------------
  /** 计算一个比正文中最长反引号串还长的围栏，避免正文内容逃出代码块。 */
  function mdFence(text) {
    let max = 0, cur = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 96) { cur++; if (cur > max) { max = cur; } }
      else { cur = 0; }
    }
    return "`".repeat(Math.max(3, max + 1));
  }
  function truncateLines(text, maxLines) {
    const lines = String(text).split("\n");
    if (lines.length <= maxLines) { return text; }
    return lines.slice(0, maxLines).join("\n") + "\n… (省略 " + (lines.length - maxLines) + " 行)";
  }
  function escapeHtmlInline(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** 单次工具调用的 Markdown：摘要单行；有结果时包进可折叠的 details。 */
  function toolMarkdown(toolName, argStr, resultText) {
    let summary = "";
    try { summary = buildMediumSummary(toolName || "tool", argStr || "").textContent.trim(); } catch (e) { summary = ""; }
    if (!summary) { summary = toolName || "tool"; }
    if (!resultText || !resultText.trim()) { return ["> 🔧 " + summary, ""]; }
    const fence = mdFence(resultText);
    return [
      "<details>",
      "<summary>🔧 " + escapeHtmlInline(summary) + "</summary>",
      "",
      fence + "text",
      truncateLines(String(resultText).trimEnd(), 100),
      fence,
      "",
      "</details>",
      "",
    ];
  }

  /** 按时间顺序遍历当前 tab 的消息 DOM，转成 Markdown 文本（只读，不碰渲染状态）。 */
  function buildMarkdownExport(tab) {
    const parts = [];
    parts.push("# " + String(tab.title || "Pi 会话"), "", "> 导出时间：" + new Date().toLocaleString(), "");
    const children = tab.paneEl.children;
    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (!el.classList) { continue; }
      if (el.classList.contains("user")) {
        parts.push("## 👤 用户", "", String(el.dataset.raw || "").trim() || "(空消息)", "");
      } else if (el.classList.contains("assistant")) {
        const md = el.querySelector(":scope > .md");
        let raw = "";
        if (md) {
          raw = (tab.currentAssistant && tab.currentAssistant.el === md) ? (tab.currentAssistant.raw || "") : (md.dataset.raw || "");
        } else { raw = el.textContent || ""; }
        raw = String(raw).trim();
        if (raw) { parts.push("## 🤖 助手", "", raw, ""); }
      } else if (el.classList.contains("system")) {
        const text = (el.textContent || "").trim();
        if (text) { parts.push("> ℹ️ " + text.split(/\n+/).join(" "), ""); }
      } else if (el.classList.contains("tool-row")) {
        el.querySelectorAll(":scope > .tool").forEach((tag) => {
          parts.push(...toolMarkdown(tag._toolName, tag._argStr, tag._resultText));
        });
      } else if (el.classList.contains("tool-card")) {
        const callEl = el.querySelector(".tc-call");
        const argStr = callEl && typeof callEl.title === "string" && callEl.title !== el._toolName ? callEl.title : "";
        parts.push(...toolMarkdown(el._toolName, argStr, el._resultText));
      }
    }
    return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  // ==================== 来自扩展的消息 ====================
  window.addEventListener("message", (event) => {
    const msg = event.data;
    // VSCode webview 宿主会投递非业务消息（视图聚焦/状态同步等），event.data 可能为 null
    // 或非 {type:string} 结构。直接忽略，避免 msg.type 崩溃导致后续消息（如 treeView）被跳过。
    if (!msg || typeof msg.type !== "string") { return; }
    const type = msg.type;

    if (type === "fetchChatResult") { applyFetchChatResult(msg); return; }

    if (type === "tabList") {
      enterMultiTab();
      const incoming = msg.tabs || [];
      const seenTabs = new Set();
      const seenPanels = new Set();
      incoming.forEach((t) => {
        seenTabs.add(t.id);
        let tv = tabViews.get(t.id);
        if (!tv) {
          tv = { id: t.id, name: t.name || "tab", root: t.root, focusPanelId: t.focusPanelId || null };
          tabViews.set(t.id, tv);
        } else {
          tv.name = t.name || tv.name;
          tv.root = t.root || tv.root;
          tv.focusPanelId = t.focusPanelId || tv.focusPanelId;
        }
        tv.streaming = !!t.streaming;
        tv.loading = !!t.loading;
        // panel 状态同步（递归布局树）
        const syncNode = (node) => {
          if (!node) { return; }
          if (node.kind === "panel") {
            seenPanels.add(node.panelId);
            let st = tabs.get(node.panelId);
            if (!st) {
              st = createTab(node.panelId, node.name || "新会话");
            } else if (node.name) {
              st.title = node.name;
            }
            st.streaming = !!node.streaming;
            const incomingActivity = node.activity;
            st.activity = incomingActivity === "working" || incomingActivity === "thinking" || incomingActivity === "tool" || incomingActivity === "idle"
              ? incomingActivity
              : (st.streaming ? "working" : "idle");
            st.activityDetail = typeof node.activityDetail === "string" ? node.activityDetail : "";
            st.piReady = node.piReady !== false;
            st.loading = !!node.loading;
            // webview 重建（视图隐藏重开/窗口重载）后 tabList 是唯一信源：
            // modelChanged 是一次性推送，不在此恢复会导致状态栏模型名丢失。
            // 字段缺失（后端尚未拿到）时保留本地已有值。
            if (typeof node.modelId === "string") { st.modelId = node.modelId; }
            if (typeof node.provider === "string") { st.provider = node.provider; }
            if (typeof node.thinkingLevel === "string") { st.thinkingLevel = node.thinkingLevel; }
            if (typeof node.percent === "number") { st.percent = node.percent; }
          } else if (node.kind === "split") {
            (node.children || []).forEach(syncNode);
          }
        };
        syncNode(t.root);
      });
      // 移除已不存在的 tab / panel
      Array.from(tabViews.keys()).forEach((id) => {
        if (!seenTabs.has(id)) {
          tabViews.delete(id);
          tabDrafts.delete(id);
          maximized.delete(id);
        }
      });
      Array.from(tabs.keys()).forEach((id) => {
        if (!seenPanels.has(id)) { removeTab(id); }
      });
      // 活跃 tab 切换 / 焦点同步
      const wantActive = msg.activeId;
      if (wantActive && tabViews.has(wantActive)) {
        if (activeTabId !== wantActive) {
          if (activeTabId !== null) { saveInputState(); }
          activeTabId = wantActive;
          const tv = tabViews.get(wantActive);
          activeId = (tv.focusPanelId && leavesOf(tv.root).includes(tv.focusPanelId))
            ? tv.focusPanelId
            : (leavesOf(tv.root)[0] || null);
          renderLayout();
          restoreInputState();
          reflectTabUI();
        } else {
          const tv = tabViews.get(wantActive);
          const wantFocus = (tv.focusPanelId && leavesOf(tv.root).includes(tv.focusPanelId))
            ? tv.focusPanelId
            : (leavesOf(tv.root)[0] || null);
          if (wantFocus && wantFocus !== activeId) {
            activeId = wantFocus;
            applyFocusClasses();
            reflectTabUI();
            renderAttachmentsFor();
          }
          const sig = layoutSignature();
          if (sig !== layoutSig) { renderLayout(); }
        }
      }
      // 全项目仅剩源 panel 时无转发目标：全局隐藏气泡转发按钮（存量/新增自动生效）
      const totalPanels = incoming.reduce((n, t) => n + leavesOf(t.root || { kind: "panel" }).length, 0);
      document.body.classList.toggle("no-relay-target", totalPanels <= 1);
      renderTabBar();
      updateSendState(); syncStatus(); updatePaneHeads();
      return;
    }
    if (type === "tabActivated") {
      enterMultiTab();
      const id = msg.id;
      if (id && tabViews.has(id)) {
        activateTabView(id);
      }
      return;
    }
    if (type === "tabClosed") {
      enterMultiTab();
      const wasActive = activeTabId === msg.id;
      tabViews.delete(msg.id);
      tabDrafts.delete(msg.id);
      maximized.delete(msg.id);
      // panel 由后续 tabList diff 清理；先切换视图避免空白
      if (wasActive) {
        activeTabId = tabViews.keys().next().value || null;
        if (activeTabId) {
          const tv = tabViews.get(activeTabId);
          activeId = (tv.focusPanelId && leavesOf(tv.root).includes(tv.focusPanelId))
            ? tv.focusPanelId
            : (leavesOf(tv.root)[0] || null);
          renderLayout();
          restoreInputState();
          reflectTabUI();
        } else {
          activeId = null;
        }
      }
      renderTabBar();
      return;
    }
    if (type === "viewOptions") { applyViewOptions(msg); return; }
    if (type === "exportConversationRequest") {
      exportActiveConversation(msg.tabId, msg.requestId);
      return;
    }
    if (type === "picker") { renderPicker(msg); return; }
    if (type === "historyPageAppend") {
      const st = pickerState;
      if (st && st.kind === "history") {
        const more = Array.isArray(msg.items) ? msg.items : [];
        st.items = st.items.concat(more);
        st.historyLoadedFamilies = typeof msg.loadedFamilies === "number" ? msg.loadedFamilies : st.historyLoadedFamilies;
        st.historyTotalFamilies = typeof msg.totalFamilies === "number" ? msg.totalFamilies : st.historyTotalFamilies;
        st.historyLoading = false;
        renderPickerItems();
      }
      return;
    }
    if (type === "historyPageEnd") {
      const st = pickerState;
      if (st && st.kind === "history") {
        st.historyLoading = false;
        renderPickerItems();
      }
      return;
    }
    if (type === "openSettings") { openSettings(msg.tab); return; }
    if (type === "viewOptionItems") { viewOptionItems = Array.isArray(msg.items) ? msg.items : []; if (settingsActiveTab === "options") { renderViewOpts(); } return; }
    if (type === "focusInput") { setTimeout(function () { inputEl.focus(); }, 0); return; }
    if (type === "app:settings" || type === "app:settingsResult" || type === "app:defaultModels") {
      if (settingsDispatch) {
        if (type === "app:settings") { settingsDispatch({ type: "load", content: msg.content, existed: msg.existed, path: msg.path }); }
        else if (type === "app:settingsResult") { settingsDispatch(msg.ok ? { type: "saved" } : { type: "error", error: msg.error }); }
        else { settingsDispatch({ type: "default", content: msg.content }); }
      }
      return;
    }
    if (type === "app:probeModelsResult") {
      if (settingsDispatch) {
        settingsDispatch({ type: "probeResult", ok: !!msg.ok, models: msg.models || [], error: msg.error });
      }
      return;
    }
    if (type === "openFiles") {
      openFiles = msg.files || [];
      if (atStart >= 0) {
        const pos = inputEl.selectionStart; const before = inputEl.value.slice(0, pos);
        const m = before.match(/(^|\s)@([^\s@]*)$/);
        filterFiles(m ? m[2] : "");
      }
      return;
    }

    if (type === "commandList") {
      commandListCache = Array.isArray(msg.items) ? msg.items : [];
      if (commandListCache.length > 0) { commandListReqAt = 0; }
      if (slashOpen) {
        const m = inputEl.value.match(/^\/(\S*)$/);
        if (m) { filterSlashMenu(m[1]); } else { closeSlashMenu(); }
      }
      return;
    }

    if (type === "symbolSet") {
      symbolNames = new Set(msg.names || []);
      // 符号集合变化后，已渲染消息里的反引号可能需变成可点击链接：重渲染各 tab 的 .md；
      // 流式中的活跃消息交给 flush 管线，避免与流式渲染竞争。
      for (const st of tabs.values()) {
        if (st.currentAssistant) { st.textDirty = true; scheduleFlush(st); }
        st.paneEl.querySelectorAll(".md").forEach((el) => {
          if (st.currentAssistant && el === st.currentAssistant.el) { return; }
          const raw = el.dataset.raw;
          if (typeof raw === "string") { el.innerHTML = renderMarkdown(raw); }
        });
      }
      return;
    }

    // tab 级消息
    const tabId = msg.tabId;
    let t = null;
    if (tabId) {
      enterMultiTab();
      t = tabs.get(tabId) || createTab(tabId, "新会话");
    } else {
      // 兜底：无 tabId 的消息（后端尚未推送 tabList）时惰性创建默认 tab
      t = ensureDefaultTab();
    }
    if (!t) { return; }
    // 安全网：多 tab 模式下若尚无活跃 tab（tabList 未到的竞态），激活当前
    if (multiTab && !activeId) {
      activeId = t.id;
      restoreInputState();
      reflectTabUI();
    }

    switch (type) {
      case "userMessage": {
        finalizeCurrentAssistant(t);
        const label = msg.imageCount ? "[" + msg.imageCount + " 张图片] " : "";
        addPlain(t, "user", "你", label + (msg.text || ""), msg.entryId);
        t.thinkingText = "";
        scrollToBottom(t, true);
        break;
      }
      case "streamStart":
        t.activity = msg.activity || "working";
        t.activityDetail = msg.detail || "";
        setStreaming(t, true);
        finalizeCurrentAssistant(t);
        t.thinkingText = "";
        // 新一轮生成：速度计时重新开始，上一轮均值先清零（有数据后由实时值接管）
        t.tps = undefined;
        t.tpsStart = Date.now();
        t.tpsTokens = 0;
        break;
      case "streamEnd":
        if (t.rafId) { flushDeltas(t); }
        finalizeCurrentAssistant(t);
        t.thinkingText = "";
        // 结算本轮速度均值（必须在 setStreaming(false) 前算，之后 currentTps 改用 t.tps）
        {
          const secs = t.tpsStart > 0 ? (Date.now() - t.tpsStart) / 1000 : 0;
          if (t.tpsTokens > 0 && secs > 0.3) { t.tps = t.tpsTokens / secs; }
          t.tpsStart = 0;
          t.tpsTokens = 0;
        }
        t.activity = msg.activity || "idle";
        t.activityDetail = msg.detail || "";
        setStreaming(t, false);
        // tab 级广播：只对焦点 panel 提示音，避免多 pane 齐响
        if (notifyOnTurnEnd && activeId === t.id) { playTurnEndBeep(); }
        break;
      case "activityChanged":
        setActivity(t, msg.activity, msg.detail);
        break;
      case "assistantDelta":
        if (!t.currentAssistant) { t.currentAssistant = { el: addMarkdown(t, ""), raw: "" }; }
        t.currentAssistant.raw += msg.delta;
        t.textDirty = true;
        scheduleFlush(t);
        t.tpsTokens += estTokens(msg.delta);
        noteTpsProgress(t);
        break;
      case "assistantFull":
        finalizeCurrentAssistant(t);
        addMarkdown(t, msg.text, msg.entryId);
        t.currentAssistant = null;
        break;
      case "scrollToEntry":
        if (typeof msg.entryId === "string") {
          // 消息可能仍在渲染：短重试
          if (!scrollToEntry(t, msg.entryId)) {
            let tries = 0;
            const timer = setInterval(() => {
              tries += 1;
              if (scrollToEntry(t, msg.entryId) || tries >= 10) { clearInterval(timer); }
            }, 100);
          }
        }
        break;
      case "thinkingDelta":
        // 兼容较旧后端：即使没有先收到 activityChanged，也按 thinking 渲染。
        if (t.activity !== "thinking") { t.activity = "thinking"; }
        t.thinkingText += msg.delta;
        t.tpsTokens += estTokens(msg.delta);
        if (activeId === t.id) { syncStatus(); }
        break;
      case "tool": {
        finalizeCurrentAssistant(t);
        const argStr = msg.args ? JSON.stringify(msg.args) : "";
        addTool(t, msg.toolName, argStr, msg.toolCallId);
        t.currentAssistant = null;
        break;
      }
      case "editCardStart": {
        finalizeCurrentAssistant(t);
        const card = buildEditCard(t, msg.toolName, msg.label, msg.path, msg.toolCallId, msg.args ? JSON.stringify(msg.args) : "");
        t.pendingToolCards.set(msg.toolCallId, card);
        t.currentAssistant = null;
        break;
      }
      case "editCardResult": {
        const card = t.pendingToolCards.get(msg.toolCallId);
        if (card) {
          card.setResult(msg);
          scrollToBottom(t);
          if (!msg.canRevert) { t.pendingToolCards.delete(msg.toolCallId); }
        }
        break;
      }
      case "editReverted": {
        const card = t.pendingToolCards.get(msg.toolCallId);
        if (card && card.markReverted) { card.markReverted(); }
        t.pendingToolCards.delete(msg.toolCallId);
        break;
      }
      case "system":
        addPlain(t, "system", null, msg.text);
        break;
      case "systemError":
        addPlain(t, "system error", null, msg.text);
        break;
      case "clear":
        cancelFlush(t);
        t.paneEl.innerHTML = '<div class="empty-hint">输入消息开始对话…</div>';
        ensurePaneHead(t);
        t.currentAssistant = null;
        t.thinkingText = "";
        t.currentToolRow = null;
        t.pendingToolCards.clear();
        for (const tg of t.pendingToolTags.values()) { clearInterval(tg._timer); }
        t.pendingToolTags.clear();
        for (const e of t.pendingToolCardsFull.values()) { clearInterval(e.timer); }
        t.pendingToolCardsFull.clear();
        // 重置当前 tab 的输入草稿（若该 panel 在当前 tab，同步到输入框）
        if (activeId === t.id) {
          const d = draftOfTab();
          d.text = "";
          d.height = 144;
          d.images = [];
          d.textBlocks = [];
          inputEl.value = "";
          inputEl.style.height = "144px";
          renderAttachmentsFor();
          inputEl.focus();
        }
        break;
      case "setInput":
        // fork 成功后由后端推送被分叉的 user 消息原文（clear 之后），可编辑后重发
        applyInputText(t, msg.text);
        break;
      case "toolResultUpdate": {
        const entry = t.pendingToolCardsFull.get(msg.toolCallId);
        if (entry) {
          if (typeof msg.durationMs === "number") { entry.card._elapsedStart = Date.now() - msg.durationMs; }
          setToolResult(entry.card, msg.resultText, { isPartial: true, durationMs: msg.durationMs });
          scrollToBottom(t);
        }
        // 简洁模式：缓存部分结果；若该标签已展开，实时刷新卡片
        const tagEl = t.pendingToolTags.get(msg.toolCallId);
        if (tagEl) {
          tagEl._resultText = msg.resultText || "";
          tagEl._resultMeta = { isPartial: true, durationMs: msg.durationMs };
          if (tagEl._card) {
            if (typeof msg.durationMs === "number") { tagEl._card._elapsedStart = Date.now() - msg.durationMs; }
            setToolResult(tagEl._card, msg.resultText, tagEl._resultMeta);
          }
        }
        break;
      }
      case "toolResult": {
        const entry = t.pendingToolCardsFull.get(msg.toolCallId);
        if (entry) {
          const card = entry.card;
          card.classList.remove("running");
          card.classList.add("done");
          if (msg.isError) { card.classList.add("error"); }
          clearInterval(entry.timer);
          setToolResult(card, msg.resultText, {
            isError: !!msg.isError,
            durationMs: msg.durationMs,
            truncation: msg.truncation || null,
          });
          t.pendingToolCardsFull.delete(msg.toolCallId);
          scrollToBottom(t);
        }
        const tagEl = t.pendingToolTags.get(msg.toolCallId);
        if (tagEl) {
          tagEl.classList.remove("running");
          if (msg.isError) { tagEl.classList.add("error"); }
          // medium 标签：耗时接在命令文本末尾（两个空格分隔），不另起一行
          if (tagEl._medium && typeof msg.durationMs === "number") {
            const dur = document.createElement("span");
            dur.className = "tool-dur";
            dur.textContent = "  " + formatDur(msg.durationMs);
            const inline = tagEl.querySelector(".tc-inline");
            (inline || tagEl).appendChild(dur);
          }
          // 记录结果，供点击展开时渲染；若已展开，立即刷新卡片
          tagEl._done = true;
          tagEl._isError = !!msg.isError;
          tagEl._resultText = msg.resultText || "";
          tagEl._resultMeta = { isError: !!msg.isError, durationMs: msg.durationMs, truncation: msg.truncation || null };
          if (tagEl._card) {
            tagEl._card.classList.remove("running");
            tagEl._card.classList.add("done");
            if (msg.isError) { tagEl._card.classList.add("error"); }
            clearInterval(tagEl._timer);
            setToolResult(tagEl._card, msg.resultText, tagEl._resultMeta);
          }
          t.pendingToolTags.delete(msg.toolCallId);
        }
        break;
      }
      case "modelChanged":
        t.modelId = msg.modelId || "";
        t.provider = msg.provider || "";
        if (activeId === t.id) { syncStatus(); }
        updatePaneHeads();
        break;
      case "thinkingChanged":
        t.thinkingLevel = msg.level || "";
        if (activeId === t.id) { syncStatus(); }
        break;
      case "stats": {
        // 上下文用量：供 panel 状态栏的百分比显示与颜色预警
        const cu = msg.contextUsage;
        if (cu) {
          if (typeof cu.percent === "number") { t.percent = cu.percent; }
          if (typeof cu.tokens === "number") { t.tokens = cu.tokens; }
          if (typeof cu.contextWindow === "number") { t.contextWindow = cu.contextWindow; }
        }
        if (activeId === t.id) { syncStatus(); }
        updatePaneHeads();
        break;
      }
      case "queueUpdate":
        t.queuedSteering = Array.isArray(msg.steering) ? msg.steering : [];
        // abort 后队列被清空：把未投递的 steer 文本合并写回输入框（与 TUI 一致）
        if (t.pendingSteerRestore && t.pendingSteerRestore.length && t.queuedSteering.length === 0) {
          const texts = t.pendingSteerRestore.filter((s) => typeof s === "string" && s);
          t.pendingSteerRestore = null;
          if (texts.length && activeId === t.id) {
            const joined = texts.join("\n\n");
            inputEl.value = inputEl.value ? (inputEl.value.replace(/\s+$/, "") + "\n\n" + joined) : joined;
            autoResize();
            inputEl.focus();
          }
        }
        if (activeId === t.id) { renderQueueBar(t); }
        break;
      case "fileChanges":
        t.changedFiles = msg.files || [];
        renderChangedFilesFor(t);
        break;
      case "piReady":
        setPiReady(t, msg.ready === true);
        break;
      case "treeView":
        // 兼容旧格式：整树一次性发送
        renderTree(msg.tree || [], msg.leafId || null, t.id);
        break;
      case "treeViewChunk":
        if (!t.treeChunks || t.treeChunks.batchId !== msg.batchId) { t.treeChunks = { batchId: msg.batchId, parts: [], total: msg.total }; }
        t.treeChunks.parts[msg.index] = msg.text;
        break;
      case "treeViewEnd":
        if (t.treeChunks && t.treeChunks.batchId === msg.batchId) {
          const parts = t.treeChunks.parts;
          t.treeChunks = null;
          try {
            const json = parts.join("");
            const data = JSON.parse(json);
            renderTree(data.tree || [], data.leafId ?? msg.leafId ?? null, t.id);
          } catch (e) {
            addPlain(t, "system error", null, "对话树数据解析失败: " + (e && e.message ? e.message : String(e)));
          }
        }
        break;
    }
  });

  function removeTab(id) {
    const st = tabs.get(id);
    if (!st) { return; }
    cancelFlush(st);
    if (st.lerpRafId) { cancelAnimationFrame(st.lerpRafId); }
    for (const e of st.pendingToolCardsFull.values()) { clearInterval(e.timer); }
    for (const tg of st.pendingToolTags.values()) { clearInterval(tg._timer); }
    st.paneEl.remove();
    tabs.delete(id);
    if (activeId === id) { activeId = null; syncJumpBottom(st); }
  }

  // ==================== 设置（models.json）浮层 ====================
  const settingsOverlay = document.getElementById("settingsOverlay");
  const settingsRoot = document.getElementById("settingsRoot");
  let settingsInstance = null;
  let settingsDispatch = null;
  let settingsActiveTab = "models";
  let viewOptionItems = [];
  const viewOptsRoot = document.getElementById("viewOptsRoot");

  function ensureSettingsMounted() {
    if (settingsInstance) { return; }
    settingsInstance = window.mountSettings(settingsRoot, {
      send(type, payload) {
        if (type === "save") { vscode.postMessage({ type: "app:saveSettings", content: (payload && payload.content) || "" }); }
        else if (type === "probeModels") {
          vscode.postMessage({
            type: "app:probeModels",
            baseUrl: (payload && payload.baseUrl) || "",
            apiKey: (payload && payload.apiKey) || "",
            api: (payload && payload.api) || "",
          });
        }
        else { vscode.postMessage({ type: "app:requestSettings" }); } // ready
      },
      on(handler) { settingsDispatch = handler; },
      onClose() { closeSettings(); },
    });
  }

  function applySettingsTab() {
    document.querySelectorAll(".settings-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === settingsActiveTab);
    });
    settingsRoot.classList.toggle("hidden", settingsActiveTab !== "models");
    viewOptsRoot.classList.toggle("hidden", settingsActiveTab !== "options");
  }

  function renderViewOpts() {
    viewOptsRoot.innerHTML = "";
    if (!viewOptionItems.length) {
      const empty = document.createElement("div"); empty.className = "vo-empty"; empty.textContent = "没有可配置项";
      viewOptsRoot.appendChild(empty); return;
    }
    viewOptionItems.forEach((it) => {
      const row = document.createElement("div"); row.className = "vo-item";
      if (it.kind === "slider") { renderSliderRow(row, it); viewOptsRoot.appendChild(row); return; }
      if (it.kind === "text") { renderTextRow(row, it); viewOptsRoot.appendChild(row); return; }
      if (Array.isArray(it.options) && it.options.length) {
        // 按钮组：直接点选某个选项
        row.classList.add("vo-item-group");
        const txt = document.createElement("div"); txt.className = "vo-text";
        const label = document.createElement("div"); label.className = "vo-label"; label.textContent = it.label || "";
        txt.appendChild(label);
        if (it.desc) { const d = document.createElement("div"); d.className = "vo-desc"; d.textContent = it.desc; txt.appendChild(d); }
        row.appendChild(txt);
        const group = document.createElement("div"); group.className = "vo-group";
        it.options.forEach((opt) => {
          const b = document.createElement("button"); b.type = "button";
          b.className = "vo-group-btn" + (opt.value === it.value ? " on" : "");
          b.textContent = opt.label;
          b.addEventListener("click", () => {
            vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: opt.value });
          });
          group.appendChild(b);
        });
        row.appendChild(group);
      } else {
        const check = document.createElement("span"); check.className = "vo-check" + (it.check === true ? " on" : "");
        check.textContent = it.check === true ? "✓" : "";
        const txt = document.createElement("div"); txt.className = "vo-text";
        const label = document.createElement("div"); label.className = "vo-label"; label.textContent = it.label || "";
        txt.appendChild(label);
        if (it.desc) { const d = document.createElement("div"); d.className = "vo-desc"; d.textContent = it.desc; txt.appendChild(d); }
        row.appendChild(check); row.appendChild(txt);
        row.addEventListener("click", () => {
          vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: it.value });
        });
      }
      viewOptsRoot.appendChild(row);
    });
  }
  /** 文本输入项（失焦 / 换出时提交，避免每键一字重渲染面板）。 */
  function renderTextRow(row, it) {
    row.classList.add("vo-item-text");
    const txt = document.createElement("div"); txt.className = "vo-text";
    const label = document.createElement("div"); label.className = "vo-label"; label.textContent = it.label || "";
    txt.appendChild(label);
    if (it.desc) { const d = document.createElement("div"); d.className = "vo-desc"; d.textContent = it.desc; txt.appendChild(d); }
    row.appendChild(txt);
    const ta = document.createElement("textarea");
    ta.className = "vo-text-input";
    ta.rows = 3;
    ta.value = typeof it.value === "string" ? it.value : "";
    ta.placeholder = "（留空则裸转发）";
    ta.spellcheck = false;
    ta.addEventListener("change", () => {
      vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: ta.value });
    });
    row.appendChild(ta);
  }
  function renderSliderRow(row, it) {
    row.classList.add("vo-item-slider");
    const txt = document.createElement("div"); txt.className = "vo-text";
    const label = document.createElement("div"); label.className = "vo-label"; label.textContent = it.label || "";
    txt.appendChild(label);
    if (it.desc) { const d = document.createElement("div"); d.className = "vo-desc"; d.textContent = it.desc; txt.appendChild(d); }
    row.appendChild(txt);
    const ctrl = document.createElement("div"); ctrl.className = "vo-slider";
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(it.min ?? 0); range.max = String(it.max ?? 100); range.step = String(it.step ?? 1);
    // 当前值：有存值用存值；否则读 body 实际字号，让滑块初始位置反映现状
    const cur = it.value && /^\d+$/.test(String(it.value))
      ? Number(it.value)
      : Math.round(parseFloat(getComputedStyle(document.body).fontSize) || 13);
    range.value = String(cur);
    const out = document.createElement("span"); out.className = "vo-slider-val"; out.textContent = cur + (it.unit || "");
    range.addEventListener("input", () => { out.textContent = range.value + (it.unit || ""); });
    range.addEventListener("change", () => {
      vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: range.value });
    });
    ctrl.appendChild(range); ctrl.appendChild(out);
    row.appendChild(ctrl);
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "vo-slider-reset";
    reset.textContent = "跟随 VSCode";
    reset.addEventListener("click", () => {
      vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: "" });
    });
    row.appendChild(reset);
  }

  function openSettings(tab) {
    const wasVisible = !settingsOverlay.classList.contains("hidden");
    settingsActiveTab = tab === "options" ? "options" : "models";
    ensureSettingsMounted();
    applySettingsTab();
    if (!wasVisible && settingsActiveTab === "models") { settingsInstance.requestInitial(); }
    if (settingsActiveTab === "options") {
      vscode.postMessage({ type: "requestViewOptionItems" });
      renderViewOpts();
    }
    settingsOverlay.classList.remove("hidden");
  }
  function closeSettings() {
    settingsOverlay.classList.add("hidden");
  }
  settingsOverlay.addEventListener("click", (e) => { if (e.target === settingsOverlay) { closeSettings(); } });
  document.querySelectorAll(".settings-tab").forEach((b) => {
    b.addEventListener("click", () => {
      const t = b.dataset.tab;
      if (!t || t === settingsActiveTab) { return; }
      settingsActiveTab = t;
      if (t === "models") { ensureSettingsMounted(); }
      applySettingsTab();
      if (t === "options") { vscode.postMessage({ type: "requestViewOptionItems" }); renderViewOpts(); }
    });
  });
  const settingsCloseBtn = document.getElementById("settingsClose");
  if (settingsCloseBtn) { settingsCloseBtn.addEventListener("click", closeSettings); }

  vscode.postMessage({ type: "ready" });
})();

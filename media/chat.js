// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages"); // 容器，内含各 .tab-pane
  const jumpBottomBtn = document.getElementById("jumpBottom");
  const inputEl = document.getElementById("input");
  const statusEl = document.getElementById("status");
  const imgPreviewEl = document.getElementById("imgPreview");
  const modelBtn = document.getElementById("modelBtn");
  const modelNameEl = document.getElementById("modelName");
  const fileMenuEl = document.getElementById("fileMenu");
  const changedFilesEl = document.getElementById("changedFiles");
  const queueBarEl = document.getElementById("queueBar");
  const tabBarInner = document.getElementById("tabBarInner");
  const tabBarEl = document.getElementById("tabBar");
  const newTabBtn = document.getElementById("newTabBtn");
  newTabBtn.addEventListener("click", () => {
    clearPendingForkDraft();
    vscode.postMessage({ type: "newSession" });
  });
  let multiTab = false; // 收到 tabList / 带 tabId 的消息后置 true，显示 tab 栏

  function enterMultiTab() {
    if (multiTab) { return; }
    multiTab = true;
    tabBarEl.classList.remove("hidden");
  }
  function ensureDefaultTab() {
    if (tabs.size === 0) {
      const st = createTab("default", "对话");
      activeId = "default";
      st.paneEl.classList.add("active");
      restoreInputState();
      reflectTabUI();
    } else if (!activeId) {
      activeId = tabs.keys().next().value;
      tabs.get(activeId).paneEl.classList.add("active");
    }
    return activeTab();
  }

  // ---- 分支树浮层（全局，瞬时）----
  const treeOverlay = document.getElementById("treeOverlay");
  const treeBody = document.getElementById("treeBody");

  // ---- 分支分叉草稿：fork 到新 tab 后把被点击的 user 消息救回输入框 ----
  let pendingForkDraft = null;        // 被点击分叉的 user 消息文本
  let pendingForkKnownTabs = null;    // 点击瞬间已存在的 tab 集合（仅新 tab 应用草稿）
  function clearPendingForkDraft() {
    pendingForkDraft = null;
    pendingForkKnownTabs = null;
  }

  // ---- 通用拾取器浮层（模型 / 历史）----
  const pickerOverlay = document.getElementById("pickerOverlay");
  const pickerBody = document.getElementById("pickerBody");
  const pickerTitle = document.getElementById("pickerTitle");
  const pickerSearch = document.getElementById("pickerSearch");
  const pickerSearchWrap = document.getElementById("pickerSearchWrap");
  const pickerFooter = document.getElementById("pickerFooter");
  let pickerState = null; // { kind, items, filtered, sel, current, toggle }

  function hideTree() { treeOverlay.classList.add("hidden"); }
  document.getElementById("treeBtn").addEventListener("click", () => {
    const tab = activeTab();
    if (tab) { vscode.postMessage({ type: "showTree", tabId: tab.id }); }
  });

  // ==================== Markdown / 文件链接 / 符号链接（纯函数，与 tab 无关）====================
  let markedReady = false;
  function ensureMarkedHighlight() {
    if (markedReady) { return; }
    markedReady = true;
    const { hljs, markedHighlight } = globalThis.hljsBundle || {};
    if (!hljs || !markedHighlight) { return; }
    marked.use(markedHighlight({
      langPrefix: "hljs language-",
      highlight(code, lang) {
        try {
          if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
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

  // ==================== 全局视图选项 ====================
  var sendKeyCombo = "enter";
  var newSessionKey = "ctrl+alt+n";
  var tabSwitchKey = "ctrl+alt+pgupdown";
  var notifyOnTurnEnd = true;
  var toolDisplayMode = "compact"; // compact=简洁标签 | full=TUI 风格卡片
  let openFiles = [];
  function applyViewOptions(opts) {
    if (typeof opts.sendKey === "string") { sendKeyCombo = opts.sendKey; }
    if (typeof opts.newSessionKey === "string") { newSessionKey = opts.newSessionKey; }
    if (typeof opts.tabSwitchKey === "string") { tabSwitchKey = opts.tabSwitchKey; }
    notifyOnTurnEnd = opts.notifyOnTurnEnd !== false;
    if (opts.toolDisplay === "full" || opts.toolDisplay === "compact") { toolDisplayMode = opts.toolDisplay; }
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
      // Alt+ 类组合在输入框里也应允许（不输入字符），处理 tab 切换
      const combos = tabSwitchCombos(tabSwitchKey);
      if (matchCombo(e, combos.prev) || matchCombo(e, combos.next)) {
        e.preventDefault();
        const dir = matchCombo(e, combos.next) ? "next" : "prev";
        vscode.postMessage({ type: "switchTabByDirection", direction: dir });
      }
      return;
    }
    // 切换会话
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
    messagesEl.appendChild(pane);  // 挂到 #messages 容器，否则消息渲染到脱离 DOM 的节点上不可见
    pane.addEventListener("scroll", () => {
      if (activeId !== id) { return; }
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
      currentToolRow: null,
      pendingToolCards: new Map(),
      pendingToolTags: new Map(),
      pendingToolCardsFull: new Map(),
      streaming: false,
      piReady: false,
      textDirty: false,
      rafId: 0,
      lastRenderAt: 0,
      stickToBottom: true,
      lerpRafId: 0,
      programmaticScroll: false,
      hasNewContent: false,
      pendingImages: [],
      pendingTextBlocks: [],
      modelId: "",
      provider: "",
      thinkingLevel: "",
      changedFiles: [],
      queuedSteering: [],
      pendingSteerRestore: null,
      // 非活跃时保存的输入状态
      inputText: "",
      inputSelectionStart: 0,
      inputSelectionEnd: 0,
      inputHeight: 144,
      autoLoadHinted: false,
    };
    tabs.set(id, st);
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
    if (activeId !== tab.id) { return; } // 仅活跃 tab 需要动画
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
  const LONG_MSG_PREVIEW_LINES = 30;
  const BIG_TEXT_LINES = 200;
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

  function addPlain(tab, cls, role, text, entryId) {
    hideEmptyHint(tab);
    tab.currentToolRow = null;
    const div = document.createElement("div");
    div.className = "msg " + cls + " msg-enter";
    if (entryId) { div.dataset.entryId = entryId; }
    const content = text || "";
    if (cls === "user" && shouldFoldText(content)) {
      div.appendChild(makeLongTextBody(content));
    } else {
      const body = document.createElement("div");
      body.textContent = content;
      div.appendChild(body);
    }
    tab.paneEl.appendChild(div);
    scrollToBottom(tab);
    return div.firstElementChild;
  }
  function addMarkdown(tab, raw) {
    hideEmptyHint(tab);
    tab.currentToolRow = null;
    const div = document.createElement("div");
    div.className = "msg assistant msg-enter";
    const body = document.createElement("div");
    body.className = "md";
    body.dataset.raw = raw || "";
    body.innerHTML = renderMarkdown(raw || "");
    div.appendChild(body);
    tab.paneEl.appendChild(div);
    scrollToBottom(tab);
    return body;
  }
  function addTool(tab, toolName, argStr, toolCallId) {
    hideEmptyHint(tab);
    if (toolDisplayMode === "full") {
      addToolCard(tab, toolName, argStr, toolCallId);
      return;
    }
    if (!tab.currentToolRow) {
      tab.currentToolRow = document.createElement("div");
      tab.currentToolRow.className = "msg tool-row msg-enter";
      tab.paneEl.appendChild(tab.currentToolRow);
    }
    const tag = document.createElement("span");
    tag.className = "tool" + (toolCallId ? " running" : "");
    tag.insertAdjacentHTML("afterbegin", GEAR_SVG);
    tag.appendChild(document.createTextNode(" " + toolName));
    if (argStr) {
      const argsDiv = document.createElement("span");
      argsDiv.className = "tool-args";
      argsDiv.textContent = argStr;
      tag.appendChild(argsDiv);
      tag.addEventListener("click", () => tag.classList.toggle("expanded"));
    }
    tab.currentToolRow.appendChild(tag);
    if (toolCallId) { tab.pendingToolTags.set(toolCallId, tag); }
    scrollToBottom(tab);
  }

  // ==================== 完整模式：TUI 风格工具卡片 ====================
  // 有定制调用行摘要的工具（与 pi TUI 一致），其余工具回退为加粗工具名 + pretty JSON 参数。
  const CUSTOM_CALL_TOOLS = new Set(["bash", "grep", "find", "ls", "read"]);
  const TOOL_PREVIEW_LINES = 5; // 结果预览行数（同 TUI BASH_PREVIEW_LINES）

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

  /** 完整模式：每个工具调用一张卡片（对齐 TUI：整块背景，call+结果连续，状态用背景色）。 */
  function addToolCard(tab, toolName, argStr, toolCallId) {
    hideEmptyHint(tab);
    tab.currentToolRow = null;
    const card = document.createElement("div");
    card.className = "tool-card running msg-enter";
    card._toolName = toolName;
    const call = buildToolCallEl(toolName, argStr);
    call.title = argStr || toolName;
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
    tab.pendingToolCardsFull.set(toolCallId, { card, resultEl, timer });
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
    // read 对齐 TUI：默认不显示内容（只有 call 行），点击展开后才显示前 10 行；错误时直接显示
    if (isRead && !meta.isError && !card._resultExpanded) {
      const hint = document.createElement("div");
      hint.className = "tc-trunc-hint";
      hint.textContent = lines.length ? "… " + lines.length + " 行 · 点击展开文件内容" : "… 点击展开文件内容";
      hint.addEventListener("click", () => { card._resultExpanded = true; renderToolResultInner(card); });
      resultEl.appendChild(hint);
      return;
    }
    // bash 预览尾部 N 行（同 TUI），read 前 10 行、grep/ls/find 前 15 行（同 TUI）
    const maxLines = isBash ? TOOL_PREVIEW_LINES : (isRead ? 10 : 15);
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
    if (hidden > 0) {
      const hint = document.createElement("div");
      hint.className = "tc-trunc-hint";
      hint.textContent = (isBash ? "… (" + hidden + " 行更早内容" : "… (" + hidden + " 行被截断") + " · 点击展开完整结果)";
      hint.addEventListener("click", (e) => { e.stopPropagation(); card._resultExpanded = true; renderToolResultInner(card); });
      resultEl.appendChild(hint);
    } else if (card._resultExpanded && (isRead || lines.length > maxLines)) {
      const fold = document.createElement("div");
      fold.className = "tc-trunc-hint"; fold.textContent = "收起";
      fold.addEventListener("click", (e) => { e.stopPropagation(); card._resultExpanded = false; renderToolResultInner(card); });
      resultEl.appendChild(fold);
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
      const t = document.createElement("div"); t.className = "tc-meta";
      t.textContent = "Elapsed " + formatDur(typeof durationMs === "number" ? durationMs : Date.now() - card._elapsedStart);
      card._elapsedEl = t;
      resultEl.appendChild(t);
    } else if (!isPartial && typeof durationMs === "number" && !isNaN(durationMs)) {
      const t = document.createElement("div"); t.className = "tc-meta";
      t.textContent = "Took " + formatDur(durationMs);
      resultEl.appendChild(t);
    }
    if (meta.isError && !text) {
      const err = document.createElement("div"); err.className = "tc-error"; err.textContent = "工具执行失败";
      resultEl.appendChild(err);
    }
  }
  function renderDiffBlock(tab, diffText, filePath) {
    const wrap = document.createElement("div");
    wrap.className = "edit-diff";
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
      wrap.appendChild(div);
    }
    return wrap;
  }

  function buildEditCard(tab, toolName, label, filePath, toolCallId) {
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
        if (msg.diff) { el.appendChild(renderDiffBlock(tab, msg.diff, filePath)); }
        if (msg.canRevert && toolCallId) {
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

  function renderChangedFilesFor(tab) {
    if (activeId !== tab.id) { return; }
    changedFilesEl.innerHTML = "";
    const files = tab.changedFiles || [];
    if (!files.length) { return; }
    const header = document.createElement("div"); header.className = "cf-header"; header.textContent = "本次对话修改的文件 (" + files.length + ")";
    changedFilesEl.appendChild(header);
    files.forEach((f) => {
      const item = document.createElement("div"); item.className = "cf-item"; item.title = "点击查看 diff: " + f.label;
      const name = document.createElement("span"); name.className = "cf-name";
      const slash = f.label.lastIndexOf("/");
      if (slash >= 0) { const dir = document.createElement("span"); dir.className = "cf-dir"; dir.textContent = f.label.slice(0, slash + 1); name.appendChild(dir); name.appendChild(document.createTextNode(f.label.slice(slash + 1))); }
      else { name.textContent = f.label; }
      item.appendChild(name);
      item.addEventListener("click", () => { vscode.postMessage({ type: "openDiff", tabId: tab.id, path: f.path }); });
      changedFilesEl.appendChild(item);
    });
  }
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
  // 实时把思考过程渲染到状态栏（#status）；show=true 时始终用同一套结构，正文随内容填充
  function statusThinking(show, text) {
    if (show) {
      if (!statusEl.querySelector(".st-body")) {
        statusEl.innerHTML = '<div class="st-head"><span class="typing"><span></span><span></span><span></span></span> 思考中… · Esc 中止</div><div class="st-body"></div>';
      }
      const body = statusEl.querySelector(".st-body");
      if (body && body.textContent !== text) {
        body.textContent = text;
        body.scrollLeft = body.scrollWidth; // 始终滚到最新内容
      }
    } else {
      statusEl.innerHTML = "";
    }
  }
  function syncStatus() {
    const tab = activeTab();
    const streaming = !!tab && tab.streaming;
    const piReady = !!tab && tab.piReady;
    if (streaming) {
      statusThinking(true, (tab && tab.thinkingText) || "");
    } else {
      statusThinking(false);
      if (tab && tab.loading) { statusEl.textContent = "加载中…"; }
      else if (!piReady) { statusEl.textContent = "等待 pi 启动…"; }
      else { statusEl.textContent = ""; }
    }
  }
  function syncModelBtn() {
    const tab = activeTab();
    const id = (tab && tab.modelId) || "";
    const prov = (tab && tab.provider) || "";
    const tl = (tab && tab.thinkingLevel) || "";
    modelNameEl.textContent = id || "模型";
    const tlSuffix = tl ? (" · 思考 " + tl) : "";
    modelBtn.title = "当前: " + (prov ? prov + "/" : "") + (id || "") + tlSuffix + "（点击切换）";
  }
  function renderAttachmentsFor(tab) {
    imgPreviewEl.innerHTML = "";
    (tab.pendingImages || []).forEach((img, idx) => {
      const wrap = document.createElement("div"); wrap.className = "img-thumb";
      const el = document.createElement("img"); el.src = "data:" + img.mimeType + ";base64," + img.data; wrap.appendChild(el);
      const rm = document.createElement("span"); rm.className = "rm"; rm.textContent = "×"; rm.title = "移除";
      rm.addEventListener("click", () => { tab.pendingImages.splice(idx, 1); renderAttachmentsFor(tab); });
      wrap.appendChild(rm); imgPreviewEl.appendChild(wrap);
    });
    (tab.pendingTextBlocks || []).forEach((blk, idx) => {
      const card = document.createElement("div"); card.className = "text-block";
      const head = document.createElement("div"); head.className = "tb-head";
      const caret = document.createElement("span"); caret.className = "tb-caret"; caret.textContent = "▶";
      const title = document.createElement("span"); title.className = "tb-title"; title.textContent = "📎 粘贴文本 · " + blk.lines + " 行 · " + blk.chars + " 字符";
      head.appendChild(caret); head.appendChild(title);
      const rm = document.createElement("span"); rm.className = "tb-rm"; rm.textContent = "×"; rm.title = "移除";
      rm.addEventListener("click", () => { tab.pendingTextBlocks.splice(idx, 1); renderAttachmentsFor(tab); });
      const body = document.createElement("div"); body.className = "tb-body";
      const previewLines = blk.text.split("\n").slice(0, 400);
      body.textContent = previewLines.join("\n") + (blk.lines > 400 ? "\n…（预览截断，完整内容随发送提交）" : "");
      head.addEventListener("click", () => card.classList.toggle("expanded"));
      card.appendChild(head); card.appendChild(body); card.appendChild(rm);
      imgPreviewEl.appendChild(card);
    });
  }

  function saveInputState() {
    const tab = activeTab();
    if (!tab) { return; }
    tab.inputText = inputEl.value;
    tab.inputSelectionStart = inputEl.selectionStart;
    tab.inputSelectionEnd = inputEl.selectionEnd;
    tab.inputHeight = parseInt(inputEl.style.height, 10) || 144;
  }
  function restoreInputState() {
    const tab = activeTab();
    if (!tab) { return; }
    inputEl.value = tab.inputText || "";
    inputEl.style.height = (tab.inputHeight || 144) + "px";
    try {
      inputEl.setSelectionRange(tab.inputSelectionStart || 0, tab.inputSelectionEnd || 0);
    } catch { /* ignore */ }
    renderAttachmentsFor(tab);
    hideFileMenu();
  }

  /** fork 到新 tab 后，把被点击分叉的 user 消息救回输入框（可编辑后重发）。 */
  function maybeApplyForkDraft() {
    if (!pendingForkDraft || !pendingForkKnownTabs) { return; }
    const tab = activeTab();
    if (!tab || pendingForkKnownTabs.has(tab.id)) { return; } // 只在新 tab 上应用，不动既有 tab 的草稿
    inputEl.value = pendingForkDraft;
    inputEl.style.height = "auto";
    autoResize();
    const end = inputEl.value.length;
    inputEl.setSelectionRange(end, end);
    tab.inputText = inputEl.value;
    tab.inputSelectionStart = end;
    tab.inputSelectionEnd = end;
    clearPendingForkDraft();
    updateSendState();
    inputEl.focus();
  }

  function reflectTabUI() {
    const tab = activeTab();
    if (!tab) { return; }
    updateSendState();
    syncStatus();
    syncModelBtn();
    renderChangedFilesFor(tab);
    renderQueueBar(tab);
    syncJumpBottom(tab);
  }

  // ==================== tab 切换 ====================
  function activateTab(id) {
    if (!tabs.has(id)) { return; }
    if (activeId === id) { return; }
    saveInputState();
    // 隐藏旧 pane
    tabs.forEach((t) => { t.paneEl.classList.remove("active"); });
    activeId = id;
    const tab = tabs.get(id);
    tab.paneEl.classList.add("active");
    restoreInputState();
    reflectTabUI();
    renderTabBar();
    inputEl.focus();
  }

  // ==================== tab 栏渲染 ====================
  function renderTabBar() {
    tabBarInner.innerHTML = "";
    tabs.forEach((tab) => {
      const el = document.createElement("div");
      el.className = "chat-tab" + (activeId === tab.id ? " active" : "") + (tab.streaming ? " streaming" : "") + (tab.loading ? " loading" : "");
      const spinner = document.createElement("span"); spinner.className = "ct-spinner"; el.appendChild(spinner);
      const title = document.createElement("span"); title.className = "ct-title"; title.textContent = tab.title; el.appendChild(title);
      const close = document.createElement("span"); close.className = "ct-close"; close.title = "关闭此对话";
      // 用 SVG 画叉：文本 “×” 在 Segoe UI 等字体下 ink 偏上，flex 居中无法修正；
      // SVG 笔画由 viewBox 几何决定，天然居中（与 VS Code 自带关闭图标同法）。
      close.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 2.5 L13.5 13.5 M13.5 2.5 L2.5 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
      close.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "closeTab", tabId: tab.id }); });
      el.appendChild(close);
      el.addEventListener("click", () => { clearPendingForkDraft(); vscode.postMessage({ type: "switchTab", tabId: tab.id }); });
      tabBarInner.appendChild(el);
    });
  }

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
    treeBody.innerHTML = "";
    const rows = flattenTree(tree);
    const active = activePathSet(tree, leafId);
    if (rows.length === 0) {
      const empty = document.createElement("div"); empty.className = "tree-empty"; empty.textContent = "没有历史消息。"; treeBody.appendChild(empty);
    } else {
      rows.forEach((row) => {
        const e = row.node.entry;
        const isLeaf = e.id === leafId;
        const onPath = active.has(e.id);
        let prefix = "";
        for (let lv = 0; lv < row.indent; lv++) {
          if (row.showConnector && lv === row.connectorPos) { prefix += row.isLast ? "└─ " : "├─ "; }
          else { const g = row.gutters.find((x) => x.pos === lv); prefix += g && g.show ? "│  " : "   "; }
        }
        const line = document.createElement("div");
        line.className = "tree-row" + (isLeaf ? " is-leaf" : "") + (onPath ? " on-path" : "");
        const pre = document.createElement("span"); pre.className = "tree-pre"; pre.textContent = prefix; line.appendChild(pre);
        const isUserMsg = e.type === "message" && e.message && e.message.role === "user";
        const marker = document.createElement("span"); marker.className = "tree-mark" + (isUserMsg ? " user" : ""); line.appendChild(marker);
        const text = document.createElement("span"); text.className = "tree-text"; text.textContent = entrySummary(row.node); line.appendChild(text);
        const forkable = isUserMsg && !isLeaf;
        if (forkable) {
          line.classList.add("forkable"); line.title = "点击在此处新建分支（可编辑该消息后重发）";
          line.addEventListener("click", () => {
            const forkText = entryText(e.message ? e.message.content : "");
            if (forkText) {
              pendingForkDraft = forkText;
              pendingForkKnownTabs = new Set(tabs.keys());
            } else {
              clearPendingForkDraft();
            }
            hideTree();
            vscode.postMessage({ type: "forkAtEntry", tabId: tabId, entryId: e.id });
          });
        } else if (isLeaf) { line.title = "当前位置（分支末尾）"; }
        else { line.classList.add("readonly"); line.title = isUserMsg ? "当前位置的消息" : "仅展示（仅 user 消息可分叉）"; }
        treeBody.appendChild(line);
      });
      const leafEl = treeBody.querySelector(".tree-row.is-leaf");
      if (leafEl) { leafEl.scrollIntoView({ block: "center" }); }
    }
    treeOverlay.classList.remove("hidden");
  }

  // ==================== 通用拾取器浮层（模型 / 历史）====================
  function hidePicker() {
    pickerOverlay.classList.add("hidden");
    pickerBody.innerHTML = "";
    pickerSearch.value = "";
    pickerFooter.innerHTML = "";
    pickerFooter.classList.add("hidden");
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
  function pickerItemMatch(item, kind, q) {
    if (!q) { return true; }
    const hay = [];
    if (kind === "model") {
      hay.push(item.id || "", item.provider || "", item.name || "");
    } else if (kind === "options") {
      hay.push(item.label || "", item.desc || "");
    } else {
      hay.push(item.title || "", item.name || "", (item.userTexts || []).join(" "), item.topFile || "");
    }
    return hay.some((s) => s.toLowerCase().includes(q));
  }
  function renderPickerItems() {
    const st = pickerState;
    if (!st) { return; }
    const q = (pickerSearch.value || "").toLowerCase().trim();
    st.filtered = st.items.filter((it) => pickerItemMatch(it, st.kind, q));
    if (st.sel >= st.filtered.length) { st.sel = Math.max(0, st.filtered.length - 1); }
    pickerBody.innerHTML = "";
    if (st.filtered.length === 0) {
      const empty = document.createElement("div"); empty.className = "pk-empty"; empty.textContent = q ? "没有匹配项。" : "列表为空。";
      pickerBody.appendChild(empty);
      return;
    }
    let lastSection = null;
    st.filtered.forEach((item, idx) => {
      // 分隔标题
      if (item.section && item.section !== lastSection) {
        lastSection = item.section;
        const sep = document.createElement("div"); sep.className = "pk-section"; sep.textContent = item.section;
        pickerBody.appendChild(sep);
      }
      const el = document.createElement("div");
      el.className = "pk-item" + (idx === st.sel ? " active" : "");
      if (st.kind === "model") {
        // 模型项 vs 思考强度项
        if (item.action === "thinkingLevel") {
          const t = document.createElement("div"); t.className = "pk-title";
          const chk = document.createElement("span"); chk.className = "pk-check" + (item.check === true ? " on" : "");
          chk.textContent = item.check === true ? "✓" : "";
          t.appendChild(chk);
          t.appendChild(document.createTextNode(item.label || ""));
          el.appendChild(t);
        } else {
          if (item.current) { el.classList.add("current"); }
          const t = document.createElement("div"); t.className = "pk-title"; t.textContent = item.id;
          if (item.current) { const b = document.createElement("span"); b.className = "pk-badge"; b.textContent = "当前"; t.appendChild(b); }
          el.appendChild(t);
          const desc = (item.provider ? item.provider : "") + (item.name && item.name !== item.id ? (item.provider ? " · " : "") + item.name : "");
          if (desc) { const d = document.createElement("div"); d.className = "pk-desc"; d.textContent = desc; el.appendChild(d); }
          if (item.contextWindow) { const det = document.createElement("div"); det.className = "pk-detail"; det.textContent = "上下文 " + Math.round(item.contextWindow / 1000) + "K"; el.appendChild(det); }
        }
      } else if (st.kind === "history") {
        if (st.current && item.file === st.current) { el.classList.add("current"); }
        const t = document.createElement("div"); t.className = "pk-title"; t.textContent = item.title || "(未命名会话)";
        if (st.current && item.file === st.current) { const b = document.createElement("span"); b.className = "pk-badge"; b.textContent = "当前"; t.appendChild(b); }
        el.appendChild(t);
        const all = item.userTexts || [];
        const count = item.truncated ? "≥" + item.messageCount + " 条" : item.messageCount + " 条";
        const desc = count + " · " + pickerRelTime(item.mtime) + (item.topFile ? " · 改动 " + item.topFile + (item.topFileCount ? " x" + item.topFileCount : "") : "");
        const d = document.createElement("div"); d.className = "pk-desc"; d.textContent = desc; el.appendChild(d);
        if (all.length > 0) {
          const preview = document.createElement("div"); preview.className = "pk-detail";
          preview.textContent = "我：" + (all[0] || "(无内容)");
          el.appendChild(preview);
        }
      } else if (st.kind === "options") {
        const t = document.createElement("div"); t.className = "pk-title";
        const chk = document.createElement("span"); chk.className = "pk-check" + (item.check === true ? " on" : "");
        chk.textContent = item.check === true ? "✓" : "";
        t.appendChild(chk);
        t.appendChild(document.createTextNode(item.label || ""));
        el.appendChild(t);
        if (item.desc) { const d = document.createElement("div"); d.className = "pk-desc"; d.style.paddingLeft = "20px"; d.textContent = item.desc; el.appendChild(d); }
      }
      el.addEventListener("mouseenter", () => { st.sel = idx; renderPickerActive(); });
      el.addEventListener("click", () => { confirmPicker(idx); });
      pickerBody.appendChild(el);
    });
  }
  function renderPickerActive() {
    const st = pickerState; if (!st) { return; }
    const items = pickerBody.querySelectorAll(".pk-item");
    items.forEach((el, i) => el.classList.toggle("active", i === st.sel));
    const cur = items[st.sel];
    if (cur) { cur.scrollIntoView({ block: "nearest" }); }
  }
  function confirmPicker(idx) {
    const st = pickerState; if (!st) { return; }
    const item = st.filtered[idx];
    if (!item) { return; }
    const kind = st.kind;
    // toggle 模式（显示选项）或单项声明 toggle 行为（模型浮层中的思考强度）
    if (st.toggle || item.behavior === "toggle") {
      // 开关/循环模式：不关闭浮层，即时回发，宿主处理后重新推送刷新
      vscode.postMessage({ type: "pickerToggle", kind, action: item.action, value: item.value });
      return;
    }
    let payload;
    if (kind === "model") {
      // 同时把当前选中的思考强度带上
      const tLevel = st.items.find((it) => it.action === "thinkingLevel" && it.check === true);
      payload = { provider: item.provider || "", modelId: item.id, thinkingLevel: tLevel ? tLevel.value : undefined };
    } else {
      payload = { file: item.file };
    }
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
      sel: 0,
      current: msg.current || null,
      toggle,
    };
    const titleMap = { model: "切换模型", history: "会话历史", options: "显示选项" };
    pickerTitle.textContent = titleMap[kind] || "选择";
    pickerSearch.value = "";
    pickerSearchWrap.classList.toggle("hidden", !searchable);
    // toggle 模式显示“关闭”按钮
    pickerFooter.innerHTML = "";
    if (toggle) {
      pickerFooter.classList.remove("hidden");
      const closeBtn = document.createElement("button"); closeBtn.className = "secondary"; closeBtn.textContent = "关闭";
      closeBtn.addEventListener("click", () => cancelPicker());
      pickerFooter.appendChild(closeBtn);
    } else {
      pickerFooter.classList.add("hidden");
    }
    renderPickerItems();
    pickerOverlay.classList.remove("hidden");
    if (searchable) { setTimeout(() => pickerSearch.focus(), 0); }
  }
  pickerOverlay.addEventListener("click", (e) => { if (e.target === pickerOverlay) { cancelPicker(); } });
  pickerSearch.addEventListener("input", () => { if (pickerState) { pickerState.sel = 0; renderPickerItems(); } });
  document.addEventListener("keydown", (e) => {
    if (!pickerState || pickerOverlay.classList.contains("hidden")) { return; }
    const st = pickerState;
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
    const typed = inputEl.value.trim();
    const hasImages = tab.pendingImages.length > 0;
    const hasTextBlocks = tab.pendingTextBlocks.length > 0;
    if (!typed && !hasImages && !hasTextBlocks) { return; }
    let text = typed;
    if (hasTextBlocks) {
      const parts = tab.pendingTextBlocks.map((b) => {
        const safeText = b.text.replace(/\u0060{4,}/g, (m) => m.split("").join("\u200b"));
        return "````\n" + safeText + "\n````";
      });
      text = (typed ? typed + "\n\n" : "") + parts.join("\n\n");
    }
    vscode.postMessage({ type: "send", tabId: tab.id, text, images: tab.pendingImages });
    inputEl.value = "";
    inputEl.style.height = "144px";
    tab.inputText = "";
    tab.inputHeight = 144;
    hideFileMenu();
    tab.pendingImages = [];
    tab.pendingTextBlocks = [];
    renderAttachmentsFor(tab);
  }

  // ==================== 事件绑定 ====================
  if (jumpBottomBtn) {
    jumpBottomBtn.addEventListener("click", () => {
      const tab = activeTab();
      if (tab) { scrollToBottom(tab, true); }
    });
  }
  modelBtn.addEventListener("click", () => { const tab = activeTab(); if (tab) { vscode.postMessage({ type: "pickModel", tabId: tab.id }); } });

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

  // 用户主动接管滚动：滚轮上滑 / 触屏上滑 打断 lerp 追底
  messagesEl.addEventListener("wheel", (e) => {
    if (activeId === null) { return; }
    const t = tabs.get(activeId);
    if (!t) { return; }
    if (e.target.closest(".tab-pane") !== t.paneEl) { return; }
    if (e.deltaY < 0) { userTookOverScroll(t); }
  }, { passive: true });
  messagesEl.addEventListener("touchstart", () => {
    if (activeId === null) { return; }
    const t = tabs.get(activeId);
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

  // 流式生成中中止活跃 tab（输入框 Esc / 消息流 Esc 共用）
  function abortActiveTab() {
    const ct = activeTab();
    if (!ct || !ct.streaming) { return false; }
    ct.pendingSteerRestore = (ct.queuedSteering || []).slice();
    vscode.postMessage({ type: "abort", tabId: ct.id });
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
      if (e.key === "ArrowDown") { e.preventDefault(); moveFileSel(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveFileSel(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseFile(); return; }
      if (e.key === "Escape") { e.preventDefault(); hideFileMenu(); return; }
    }
    // 复刻 pi TUI：流式生成中按 ESC 中止（文件菜单关闭时生效）
    if (e.key === "Escape") { if (abortActiveTab()) { e.preventDefault(); } return; }
    if (isSendKey(e)) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener("input", () => { autoResize(); maybeShowFileMenu(); });
  inputEl.addEventListener("blur", () => { setTimeout(hideFileMenu, 150); });
  inputEl.addEventListener("paste", (e) => {
    const tab = activeTab(); if (!tab) { return; }
    const cd = e.clipboardData; const items = (cd && cd.items) || [];
    let folded = false;
    for (const item of items) {
      if (item.kind === "string" && item.type === "text/plain") {
        const text = cd.getData("text/plain");
        if (shouldFoldText(text)) { e.preventDefault(); folded = true; const lines = text.split("\n").length; tab.pendingTextBlocks.push({ text, lines, chars: text.length }); }
        break;
      }
    }
    let handledImage = false;
    for (const item of items) {
      if (item.type && item.type.indexOf("image/") === 0) {
        const file = item.getAsFile(); if (!file) { continue; }
        e.preventDefault(); handledImage = true;
        const reader = new FileReader();
        reader.onload = () => { const result = String(reader.result || ""); const comma = result.indexOf(","); const data = comma >= 0 ? result.slice(comma + 1) : result; tab.pendingImages.push({ data, mimeType: file.type || "image/png" }); renderAttachmentsFor(tab); };
        reader.readAsDataURL(file);
      }
    }
    if (folded || handledImage) { renderAttachmentsFor(tab); }
  });

  // 初始：等待扩展推送 tabList / tabActivated
  statusEl.textContent = "等待 pi 启动…";

  function setStreaming(tab, on) { tab.streaming = on; if (activeId === tab.id) { updateSendState(); syncStatus(); } renderTabBar(); }
  function setPiReady(tab, on, force) { tab.piReady = on; if (activeId === tab.id) { updateSendState(); syncStatus(); } renderTabBar(); }

  // ==================== 来自扩展的消息 ====================
  window.addEventListener("message", (event) => {
    const msg = event.data;
    const type = msg.type;

    if (type === "tabList") {
      enterMultiTab();
      const incoming = msg.tabs || [];
      const seen = new Set();
      let sawNewTab = false;
      incoming.forEach((t) => {
        seen.add(t.id);
        let st = tabs.get(t.id);
        if (!st) {
          // 占位创建 pane（此时 #messages 是容器，直接 append）
          st = createTab(t.id, t.title);
          sawNewTab = true;
          if (msg.activeId === t.id) {
            // 首次出现且为 active
          }
        } else {
          st.title = t.title;
        }
        st.streaming = !!t.streaming;
        st.piReady = t.piReady !== false;
        st.loading = !!t.loading;
      });
      // 移除已不存在的 tab
      Array.from(tabs.keys()).forEach((id) => {
        if (!seen.has(id)) { removeTab(id); }
      });
      const wantActive = msg.activeId;
      if (wantActive && tabs.has(wantActive)) {
        if (activeId !== wantActive) {
          if (activeId) { saveInputState(); }
          tabs.forEach((t) => t.paneEl.classList.remove("active"));
          activeId = wantActive;
          tabs.get(wantActive).paneEl.classList.add("active");
          restoreInputState();
          reflectTabUI();
        } else if (tabs.size === 1 && !tabs.get(wantActive).paneEl.classList.contains("active")) {
          activeId = wantActive;
          tabs.get(wantActive).paneEl.classList.add("active");
          restoreInputState();
          reflectTabUI();
        }
      }
      renderTabBar();
      updateSendState(); syncStatus();
      // fork 到新 tab：把被点击的 user 消息救回输入框；若没出现新 tab（原地分叉/普通切换）则丢弃
      maybeApplyForkDraft();
      if (pendingForkDraft && !sawNewTab) { clearPendingForkDraft(); }
      return;
    }
    if (type === "tabActivated") {
      enterMultiTab();
      const id = msg.id;
      if (id && tabs.has(id)) {
        if (activeId !== id) {
          if (activeId) { saveInputState(); }
          tabs.forEach((t) => t.paneEl.classList.remove("active"));
          activeId = id;
          tabs.get(id).paneEl.classList.add("active");
          restoreInputState();
          reflectTabUI();
        }
        renderTabBar();
      }
      maybeApplyForkDraft();
      return;
    }
    if (type === "tabClosed") {
      enterMultiTab();
      removeTab(msg.id);
      renderTabBar();
      return;
    }
    if (type === "viewOptions") { applyViewOptions(msg); return; }
    if (type === "picker") { renderPicker(msg); return; }
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
    if (type === "openFiles") {
      openFiles = msg.files || [];
      if (atStart >= 0) {
        const pos = inputEl.selectionStart; const before = inputEl.value.slice(0, pos);
        const m = before.match(/(^|\s)@([^\s@]*)$/);
        filterFiles(m ? m[2] : "");
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
      t.paneEl.classList.add("active");
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
        setStreaming(t, true);
        finalizeCurrentAssistant(t);
        t.thinkingText = "";
        break;
      case "streamEnd":
        if (t.rafId) { flushDeltas(t); }
        finalizeCurrentAssistant(t);
        t.thinkingText = "";
        setStreaming(t, false);
        if (notifyOnTurnEnd) { playTurnEndBeep(); }
        break;
      case "assistantDelta":
        if (!t.currentAssistant) { t.currentAssistant = { el: addMarkdown(t, ""), raw: "" }; }
        t.currentAssistant.raw += msg.delta;
        t.textDirty = true;
        scheduleFlush(t);
        break;
      case "assistantFull":
        finalizeCurrentAssistant(t);
        addMarkdown(t, msg.text);
        t.currentAssistant = null;
        break;
      case "thinkingDelta":
        t.thinkingText += msg.delta;
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
        const card = buildEditCard(t, msg.toolName, msg.label, msg.path, msg.toolCallId);
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
        t.currentAssistant = null;
        t.thinkingText = "";
        t.currentToolRow = null;
        t.pendingToolCards.clear();
        t.pendingToolTags.clear();
        for (const e of t.pendingToolCardsFull.values()) { clearInterval(e.timer); }
        t.pendingToolCardsFull.clear();
        // 重置该 tab 的输入（若是活跃 tab，同步到输入框）
        t.pendingImages = [];
        t.pendingTextBlocks = [];
        t.inputText = "";
        t.inputHeight = 144;
        if (activeId === t.id) {
          inputEl.value = "";
          inputEl.style.height = "144px";
          renderAttachmentsFor(t);
          inputEl.focus();
        }
        break;
      case "toolResultUpdate": {
        const entry = t.pendingToolCardsFull.get(msg.toolCallId);
        if (entry) {
          if (typeof msg.durationMs === "number") { entry.card._elapsedStart = Date.now() - msg.durationMs; }
          setToolResult(entry.card, msg.resultText, { isPartial: true, durationMs: msg.durationMs });
          scrollToBottom(t);
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
          t.pendingToolTags.delete(msg.toolCallId);
        }
        break;
      }
      case "modelChanged":
        t.modelId = msg.modelId || "";
        t.provider = msg.provider || "";
        if (activeId === t.id) { syncModelBtn(); }
        break;
      case "thinkingChanged":
        t.thinkingLevel = msg.level || "";
        if (activeId === t.id) { syncModelBtn(); }
        break;
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
        renderTree(msg.tree || [], msg.leafId || null, t.id);
        break;
    }
  });

  function removeTab(id) {
    const st = tabs.get(id);
    if (!st) { return; }
    cancelFlush(st);
    if (st.lerpRafId) { cancelAnimationFrame(st.lerpRafId); }
    for (const e of st.pendingToolCardsFull.values()) { clearInterval(e.timer); }
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

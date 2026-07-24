// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const statusEl = document.getElementById("status");
  const imgPreviewEl = document.getElementById("imgPreview");
  const modelBtn = document.getElementById("modelBtn");
  const modelNameEl = document.getElementById("modelName");
  const fileMenuEl = document.getElementById("fileMenu");
  const statsBarEl = document.getElementById("statsBar");
  const changedFilesEl = document.getElementById("changedFiles");

  // ---- user 消息右键：从此处分叉 ----
  const forkMenu = document.createElement("div");
  forkMenu.id = "forkMenu";
  forkMenu.className = "ctx-menu hidden";
  document.body.appendChild(forkMenu);
  function hideForkMenu() { forkMenu.classList.add("hidden"); }
  document.addEventListener("contextmenu", function (e) {
    const userMsg = e.target.closest && e.target.closest(".msg.user");
    if (!userMsg || !userMsg.dataset.entryId) { return; }
    e.preventDefault();
    const entryId = userMsg.dataset.entryId;
    forkMenu.innerHTML = "";
    const item = document.createElement("div");
    item.className = "ctx-item";
    item.textContent = "⑂ 从此处分叉";
    item.addEventListener("click", function () {
      hideForkMenu();
      vscode.postMessage({ type: "forkFromEntry", entryId: entryId });
    });
    forkMenu.appendChild(item);
    const w = 170;
    forkMenu.style.left = Math.min(e.clientX, window.innerWidth - w - 6) + "px";
    forkMenu.style.top = Math.min(e.clientY, window.innerHeight - 40) + "px";
    forkMenu.classList.remove("hidden");
  });
  document.addEventListener("click", hideForkMenu);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hideForkMenu(); });
  document.addEventListener("scroll", hideForkMenu, true);
  window.addEventListener("blur", hideForkMenu);

  // pi 进程就绪前禁用发送按钮，避免冷启动期间点击产生困惑
  let piReady = false;
  // 显示选项：控制状态栏的显隐
  var sendKeyCombo = "enter"; // enter | shift+enter | alt+enter | ctrl+enter
  function applyViewOptions(opts) {
    statsBarEl.classList.toggle("bar-hidden", opts.showStatsBar === false);
    if (typeof opts.sendKey === "string") {
      sendKeyCombo = opts.sendKey;
    }
  }

  // 判断一次 keydown 是否匹配当前发送键组合
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

  // 渲染本次对话修改的文件列表
  function renderChangedFiles(files) {
    changedFilesEl.innerHTML = "";
    if (!files || files.length === 0) {
      return;
    }
    const header = document.createElement("div");
    header.className = "cf-header";
    header.textContent = "本次对话修改的文件 (" + files.length + ")";
    changedFilesEl.appendChild(header);

    files.forEach((f) => {
      const item = document.createElement("div");
      item.className = "cf-item";
      item.title = "点击查看 diff: " + f.label;

      const name = document.createElement("span");
      name.className = "cf-name";
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
      item.appendChild(name);

      item.addEventListener("click", () => {
        vscode.postMessage({ type: "openDiff", path: f.path });
      });
      changedFilesEl.appendChild(item);
    });
  }

  // 格式化 token 数（如 12.3K / 1.2M）
  function fmtNum(n) {
    if (n == null) return "0";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }

  function renderStats(msg) {
    const parts = [];
    if (typeof msg.cost === "number") {
      parts.push('<span class="stat" title="会话成本">$' + msg.cost.toFixed(4) + "</span>");
    }
    const cu = msg.contextUsage;
    if (cu && typeof cu.percent === "number") {
      let cls = "stat";
      if (cu.percent >= 90) { cls += " ctx-crit"; }
      else if (cu.percent >= 70) { cls += " ctx-hi"; }
      const win = cu.contextWindow ? " / " + fmtNum(cu.contextWindow) : "";
      parts.push(
        '<span class="' + cls + '" title="上下文使用">上下文 ' +
        cu.percent.toFixed(1) + '% (' + fmtNum(cu.tokens) + win + ')</span>'
      );
    }
    statsBarEl.innerHTML = parts.join("");
  }

  let currentAssistant = null; // { el, raw }
  let currentThinking = null;  // { wrap, body, textNode, raw, expanded }
  let currentToolRow = null;   // 连续 tool 调用的 flex 容器
  const pendingToolTags = new Map(); // toolCallId -> 标签元素（running 态）

  // 8齿齿轮 SVG：外轮廓为闭合 path（齿顶圆弧+齿根圆弧交替），内圆为轴孔。
  // viewBox 中心 (12,12) 即几何中心，旋转不偏心。currentColor 跟随文本色。
  const GEAR_SVG = '<span class="tool-icon"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M22.83,10.09 A11 11 0 0 1 22.83,13.91 L20.37,13.48 A8.5 8.5 0 0 1 18.96,16.88 A8.5 8.5 0 0 1 21.01,18.31 A11 11 0 0 1 18.31,21.01 L16.88,18.96 A8.5 8.5 0 0 1 13.48,20.37 A8.5 8.5 0 0 1 13.91,22.83 A11 11 0 0 1 10.09,22.83 L10.52,20.37 A8.5 8.5 0 0 1 7.12,18.96 A8.5 8.5 0 0 1 5.69,21.01 A11 11 0 0 1 2.99,18.31 L5.04,16.88 A8.5 8.5 0 0 1 3.63,13.48 A8.5 8.5 0 0 1 1.17,13.91 A11 11 0 0 1 1.17,10.09 L3.63,10.52 A8.5 8.5 0 0 1 5.04,7.12 A8.5 8.5 0 0 1 2.99,5.69 A11 11 0 0 1 5.69,2.99 L7.12,5.04 A8.5 8.5 0 0 1 10.52,3.63 A8.5 8.5 0 0 1 10.09,1.17 A11 11 0 0 1 13.91,1.17 L13.48,3.63 A8.5 8.5 0 0 1 16.88,5.04 A8.5 8.5 0 0 1 18.31,2.99 A11 11 0 0 1 21.01,5.69 L18.96,7.12 A8.5 8.5 0 0 1 20.37,10.52 Z"/><circle cx="12" cy="12" r="3.2"/></svg></span>';
  let streaming = false;

  // 初始状态：pi 尚未就绪，禁用发送按钮并提示
  sendBtn.disabled = true;
  statusEl.textContent = "等待 pi 启动…";

  // ---- rAF 节流：delta 只标记 dirty，按文本长度自适应渲染频率 ----
  // 短文本每帧渲染（流畅）；长文本改为按时间间隔渲染，避免每帧对增长中的全文本
  // 重跑 renderMarkdown + 整块 innerHTML 重建导致掉帧。streamEnd/finalize 时仍会
  // 做一次最终全量渲染，保证定稿正确。
  let textDirty = false;      // 文本块有待渲染
  let pendingThinkDelta = "";  // 思考卡片纯文本增量缓冲
  let rafId = 0;
  let lastRenderAt = 0;        // 上次文本渲染时间戳（ms）
  // 不同长度档位的渲染间隔（ms）。越长间隔越大，平衡流畅度与性能。
  function renderInterval(rawLen) {
    if (rawLen < 4000) return 0;       // ~4KB 以内：每帧渲染
    if (rawLen < 16000) return 60;     // ~16KB 以内：约 4 帧一次
    if (rawLen < 64000) return 150;    // ~64KB 以内：约 10 帧一次
    return 300;                        // 超长：最低约 2 次每秒
  }

  // 用户是否正在 currentAssistant.el 内选中文本：流式渲染每帧整块重建
  // innerHTML 会冲掉选区，导致吐字时无法选中。检测到非折叠选区落在
  // 当前文本块内时跳过本轮刷新，保留 textDirty 待下一帧再试。
  function isSelectingIn(el) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      return false;
    }
    const range = sel.getRangeAt(0);
    if (!el || !el.contains(range.startContainer)) {
      return false;
    }
    return true;
  }

  function scheduleFlush() {
    if (rafId) return;
    rafId = requestAnimationFrame(flushDeltas);
  }

  function flushDeltas() {
    rafId = 0;
    const now = performance.now();
    if (textDirty && currentAssistant) {
      const raw = currentAssistant.raw || "";
      const interval = renderInterval(raw.length);
      // 间隔未到：延后到下一帧重试，不清除 textDirty
      if (interval > 0 && now - lastRenderAt < interval) {
        rafId = requestAnimationFrame(flushDeltas);
      } else if (isSelectingIn(currentAssistant.el)) {
        // 正在选中该文本块：跳过本轮 innerHTML 重建以免冲掉选区，下帧再试
        rafId = requestAnimationFrame(flushDeltas);
      } else {
        currentAssistant.el.innerHTML = renderMarkdown(raw);
        lastRenderAt = now;
        textDirty = false;
      }
    }
    if (pendingThinkDelta && currentThinking && currentThinking.textNode) {
      currentThinking.textNode.appendData(pendingThinkDelta);
      pendingThinkDelta = "";
    }
    smoothScrollToBottom();
  }

  // 取消 pending rAF 并清空标记（定稿前调用）
  function cancelFlush() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    textDirty = false;
    pendingThinkDelta = "";
  }

  // 定稿当前文本块：cancel rAF → innerHTML 替换为 markdown → 置空
  function finalizeCurrentAssistant() {
    cancelFlush();
    if (currentAssistant) {
      const el = currentAssistant.el;
      el.innerHTML = renderMarkdown(currentAssistant.raw || "");
      smoothScrollToBottom();
      currentAssistant = null;
    }
  }
  let pendingImages = []; // [{ data, mimeType }]
  // edit/write 工具调用卡片：toolCallId -> { el, path }
  const pendingToolCards = new Map();

  // ---------- Markdown 渲染（使用 marked + highlight.js）----------
  // 仅配一次 marked-highlight；重复 use 会重复 hook，故缓存。
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
          // 仅对已注册语言（cpp/typescript/python 及别名）上色，其余纯文本
          if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return hljs.highlight(code, { language: "plaintext" }).value;
        } catch {
          return code;
        }
      }
    }));
  }

  function renderInline(text) {
    ensureMarkedHighlight();
    return marked.parseInline(text, { gfm: true });
  }

  function renderMarkdown(source) {
    ensureMarkedHighlight();
    return marked.parse(source, { breaks: true, gfm: true });
  }

  // ---------- DOM 辅助 ----------
  // 隐藏空状态提示
  function hideEmptyHint() {
    const hint = document.getElementById("emptyHint");
    if (hint) hint.remove();
  }
  // 是否"黏底"：仅当用户已在底部附近时才自动滚动，避免打断向上翻看历史
  let stickToBottom = true;
  const BOTTOM_THRESHOLD = 40; // px
  let lerpRafId = 0;

  function isNearBottom() {
    return (
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <=
      BOTTOM_THRESHOLD
    );
  }

  // 用户手动滚动时更新黏底状态；向上滚时取消进行中的 lerp
  messagesEl.addEventListener("scroll", () => {
    const wasBottom = stickToBottom;
    stickToBottom = isNearBottom();
    if (wasBottom && !stickToBottom && lerpRafId) {
      cancelAnimationFrame(lerpRafId);
      lerpRafId = 0;
    }
  });

  // lerp 滚动：每帧追近目标 1/3，既有平滑惯性又快速收敛
  function lerpScrollStep() {
    if (!stickToBottom) { lerpRafId = 0; return; }
    const target = messagesEl.scrollHeight - messagesEl.clientHeight;
    const cur = messagesEl.scrollTop;
    const diff = target - cur;
    if (Math.abs(diff) < 1) {
      messagesEl.scrollTop = target;
      lerpRafId = 0;
      return;
    }
    messagesEl.scrollTop = cur + diff * 0.3;
    lerpRafId = requestAnimationFrame(lerpScrollStep);
  }

  // 启动 lerp 滚动（若已在运行则不重复启动）
  function smoothScrollToBottom() {
    if (!stickToBottom) return;
    if (!lerpRafId) {
      lerpRafId = requestAnimationFrame(lerpScrollStep);
    }
  }

  // 强制瞬移到底（用于新消息发送等需要立刻归位的场景）
  function scrollToBottom(force) {
    if (force || stickToBottom) {
      // 取消进行中的 lerp，直接归位
      if (lerpRafId) {
        cancelAnimationFrame(lerpRafId);
        lerpRafId = 0;
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
      stickToBottom = true;
    }
  }

  function addPlain(cls, role, text, entryId) {
    hideEmptyHint();
    currentToolRow = null; // 非 tool 消息重置 tool 行
    const div = document.createElement("div");
    div.className = "msg " + cls + " msg-enter";
    if (entryId) { div.dataset.entryId = entryId; }
    const body = document.createElement("div");
    body.textContent = text || "";
    div.appendChild(body);
    messagesEl.appendChild(div);
    scrollToBottom();
    return body;
  }

  // 添加工具调用标签：连续的 tool 放在同一 flex 行，排不下自动换行
  function addTool(toolName, argStr, toolCallId) {
    hideEmptyHint();
    if (!currentToolRow) {
      currentToolRow = document.createElement("div");
      currentToolRow.className = "msg tool-row msg-enter";
      messagesEl.appendChild(currentToolRow);
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
    currentToolRow.appendChild(tag);
    if (toolCallId) {
      pendingToolTags.set(toolCallId, tag);
    }
    scrollToBottom();
  }

  function addMarkdown(role, raw) {
    hideEmptyHint();
    currentToolRow = null;
    const div = document.createElement("div");
    div.className = "msg assistant msg-enter";
    const body = document.createElement("div");
    body.className = "md";
    body.innerHTML = renderMarkdown(raw || "");
    div.appendChild(body);
    messagesEl.appendChild(div);
    scrollToBottom();
    return body;
  }

  // 构建可折叠的思考过程卡片（默认折叠），返回 { wrap, body, raw, expanded }。
  function addThinking() {
    hideEmptyHint();
    currentToolRow = null;
    const wrap = document.createElement("div");
    wrap.className = "msg thinking collapsed msg-enter";

    const header = document.createElement("div");
    header.className = "thinking-header";
    const caret = document.createElement("span");
    caret.className = "thinking-caret";
    caret.textContent = "▶";
    const label = document.createElement("span");
    label.className = "thinking-label";
    label.textContent = "思考过程";
    header.appendChild(caret);
    header.appendChild(label);
    wrap.appendChild(header);

    const body = document.createElement("div");
    body.className = "thinking-body";
    const textNode = document.createTextNode("");
    body.appendChild(textNode);
    wrap.appendChild(body);

    const state = { wrap, body, textNode, raw: "", expanded: false };
    header.addEventListener("click", () => {
      state.expanded = !state.expanded;
      wrap.classList.toggle("collapsed", !state.expanded);
    });

    messagesEl.appendChild(wrap);
    scrollToBottom();
    return state;
  }

  // 构建 edit/write 工具调用卡片（占位态），返回 { el, path, setResult }。
  function buildEditCard(toolName, label, path, toolCallId) {
    hideEmptyHint();
    currentToolRow = null;
    const el = document.createElement("div");
    el.className = "msg edit-card msg-enter";
    const title = document.createElement("div");
    title.className = "edit-title";
    const caret = document.createElement("span");
    caret.className = "et-caret";
    caret.textContent = "▶";
    title.appendChild(caret);
    const name = document.createElement("span");
    name.className = "et-name";
    name.textContent = toolName + " " + (label || "");
    title.appendChild(name);
    const loading = document.createElement("span");
    loading.className = "et-loading";
    loading.textContent = "…";
    title.appendChild(loading);
    el.appendChild(title);
    // 折叠/展开
    title.addEventListener("click", (e) => {
      if (e.target.closest(".et-revert")) return;
      el.classList.toggle("collapsed");
    });
    messagesEl.appendChild(el);
    scrollToBottom();
    return {
      el,
      path,
      setResult(msg) {
        loading.remove();
        if (msg.isError) {
          el.classList.add("error");
          const err = document.createElement("span");
          err.className = "et-err";
          err.textContent = msg.errorText || "失败";
          title.appendChild(err);
          return;
        }
        if (msg.history) {
          // 历史回放：无 diff、不可点击
          title.style.cursor = "default";
          return;
        }
        if (msg.diff) {
          el.appendChild(renderDiffBlock(msg.diff));
        }
        const line = typeof msg.firstChangedLine === "number" ? msg.firstChangedLine : 1;
        // 跳转按钮
        const jumpBtn = document.createElement("span");
        jumpBtn.className = "et-revert";
        jumpBtn.textContent = "→ 跳转";
        jumpBtn.title = "跳转到编辑位置";
        jumpBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          // 同时带上 toolCallId 与 path/line：有快照时按错点重定位，无快照（历史卡片）时回退行号
          vscode.postMessage({ type: "openEditLocation", path, line, toolCallId: toolCallId || undefined });
        });
        title.appendChild(jumpBtn);
        // revert 按钮（仅当后端记录了快照时显示）
        if (msg.canRevert && toolCallId) {
          const revertBtn = document.createElement("span");
          revertBtn.className = "et-revert";
          revertBtn.textContent = "↩ 回滚";
          revertBtn.title = "将文件恢复到本次修改前的内容";
          revertBtn.addEventListener("click", (e) => {
            e.stopPropagation(); // 不触发标题的跳转
            vscode.postMessage({ type: "revertEdit", toolCallId });
          });
          title.appendChild(revertBtn);
        }
      },
      // 标记为已回滚：置灰并移除回滚按钮
      markReverted() {
        el.classList.add("reverted");
        const btn = title.querySelector(".et-revert");
        if (btn) {
          btn.remove();
        }
        if (!title.querySelector(".et-reverted")) {
          const tag = document.createElement("span");
          tag.className = "et-reverted";
          tag.textContent = "已回滚";
          title.appendChild(tag);
        }
      },
    };
  }

  // 把 pi 的 diff 字符串渲染成红绿行块。
  function renderDiffBlock(diffText) {
    const wrap = document.createElement("div");
    wrap.className = "edit-diff";
    const lines = String(diffText).split("\n");
    for (const line of lines) {
      const div = document.createElement("div");
      div.className = "diff-line";
      const prefix = line.charAt(0);
      if (prefix === "+") div.classList.add("add");
      else if (prefix === "-") div.classList.add("del");
      else div.classList.add("ctx");
      div.textContent = line;
      wrap.appendChild(div);
    }
    return wrap;
  }

  // 根据 streaming / piReady 综合刷新发送按钮状态
  function updateSendState() {
    if (streaming) {
      sendBtn.disabled = false;
      sendBtn.textContent = "中止";
    } else {
      sendBtn.textContent = "发送";
      sendBtn.disabled = !piReady;
    }
  }

  function setStreaming(on) {
    streaming = on;
    updateSendState();
    if (on) {
      statusEl.innerHTML =
        '<span class="typing"><span></span><span></span><span></span></span> pi 正在思考…';
    } else if (!piReady) {
      statusEl.textContent = "等待 pi 启动…";
    } else {
      statusEl.textContent = "";
    }
  }

  function setPiReady(on) {
    piReady = on;
    updateSendState();
    if (!streaming) {
      statusEl.textContent = on ? "" : "等待 pi 启动…";
    }
  }

  function renderPreview() {
    imgPreviewEl.innerHTML = "";
    pendingImages.forEach((img, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "img-thumb";
      const el = document.createElement("img");
      el.src = "data:" + img.mimeType + ";base64," + img.data;
      wrap.appendChild(el);
      const rm = document.createElement("span");
      rm.className = "rm";
      rm.textContent = "×";
      rm.title = "移除";
      rm.addEventListener("click", () => {
        pendingImages.splice(idx, 1);
        renderPreview();
      });
      wrap.appendChild(rm);
      imgPreviewEl.appendChild(wrap);
    });
  }

  function send() {
    if (streaming) {
      vscode.postMessage({ type: "abort" });
      return;
    }
    if (!piReady) {
      return; // 冷启动期间按钮已禁用；防御性返回
    }
    const text = inputEl.value.trim();
    if (!text && pendingImages.length === 0) {
      return;
    }
    vscode.postMessage({ type: "send", text, images: pendingImages });
    inputEl.value = "";
    inputEl.style.height = "144px";
    hideFileMenu();
    pendingImages = [];
    renderPreview();
  }

  // ---------- 双击行内代码：修剪误选的尾随空格 ----------
  // Chromium 的词选择会跨入 <code> 后面的文本节点，把开头空格一起选上。
  // 双击发生在行内 code 内时，等选区稳定后把末尾的空白裁掉。
  messagesEl.addEventListener("dblclick", (e) => {
    const code = e.target && e.target.closest ? e.target.closest("code") : null;
    if (!code || code.closest("pre")) { return; } // 只处理行内代码
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { return; }
      let tail = 0; // 选区末尾连续空白字符数
      const txt = sel.toString();
      while (tail < txt.length && /\s/.test(txt[txt.length - 1 - tail])) { tail++; }
      if (tail === 0) { return; }
      // 仅处理焦点落在文本节点上的正向选择（双击词选择的典型形态）
      if (sel.focusNode && sel.focusNode.nodeType === Node.TEXT_NODE && sel.focusOffset >= tail) {
        sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset - tail);
      }
    }, 0);
  });

  // ---------- @ 文件引用 ----------
  let openFiles = [];      // [{ label, path }] 来自扩展
  let fileMatches = [];    // 当前过滤结果
  let fileSel = 0;         // 高亮项索引
  let atStart = -1;        // @ 在输入框中的位置

  function hideFileMenu() {
    fileMenuEl.classList.add("hidden");
    atStart = -1;
  }

  // 检测光标前是否有 @token，若有则请求文件列表并显示菜单
  function maybeShowFileMenu() {
    const pos = inputEl.selectionStart;
    const before = inputEl.value.slice(0, pos);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) {
      hideFileMenu();
      return;
    }
    atStart = pos - m[2].length - 1; // @ 的位置
    // 请求最新文件列表（异步返回 openFiles 事件），同时用已有列表先渲染
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
    if (fileMatches.length === 0) {
      // 仅隐藏菜单元素，保留 atStart，以便异步到达的 openFiles 能重新渲染
      fileMenuEl.classList.add("hidden");
      return;
    }
    fileMenuEl.innerHTML = "";
    fileMatches.forEach((f, idx) => {
      const item = document.createElement("div");
      item.className = "file-item" + (idx === fileSel ? " active" : "");
      const slash = f.label.lastIndexOf("/");
      if (slash >= 0) {
        const dir = document.createElement("span");
        dir.className = "dir";
        dir.textContent = f.label.slice(0, slash + 1);
        item.appendChild(dir);
        item.appendChild(document.createTextNode(f.label.slice(slash + 1)));
      } else {
        item.textContent = f.label;
      }
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        fileSel = idx;
        chooseFile();
      });
      fileMenuEl.appendChild(item);
    });
    fileMenuEl.classList.remove("hidden");
  }

  function moveFileSel(delta) {
    if (fileMatches.length === 0) return;
    fileSel = (fileSel + delta + fileMatches.length) % fileMatches.length;
    renderFileMenu();
  }

  function chooseFile() {
    const f = fileMatches[fileSel];
    if (!f || atStart < 0) { hideFileMenu(); return; }
    const pos = inputEl.selectionStart;
    const ref = "@" + f.label + " ";
    inputEl.value = inputEl.value.slice(0, atStart) + ref + inputEl.value.slice(pos);
    const newPos = atStart + ref.length;
    inputEl.selectionStart = inputEl.selectionEnd = newPos;
    hideFileMenu();
    autoResize();
    inputEl.focus();
  }

  // ---------- 事件绑定 ----------
  sendBtn.addEventListener("click", send);
  document.getElementById("newBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "newSession" });
  });
  modelBtn.addEventListener("click", () => vscode.postMessage({ type: "pickModel" }));

  // scrollHeight 包含 padding，content-box 下 height 不含 padding，
  // 需减去 padding（6px top + 6px bottom = 12px）避免高度每次增长
  function autoResize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight - 12, 144), 640) + "px";
  }

  inputEl.addEventListener("keydown", (e) => {
    // 文件菜单导航
    if (!fileMenuEl.classList.contains("hidden")) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveFileSel(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveFileSel(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseFile(); return; }
      if (e.key === "Escape") { e.preventDefault(); hideFileMenu(); return; }
    }
    if (isSendKey(e)) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("input", () => {
    autoResize();
    maybeShowFileMenu();
  });
  inputEl.addEventListener("blur", () => {
    // 延迟隐藏，让点击菜单项能先触发
    setTimeout(hideFileMenu, 150);
  });

  // 图片粘贴
  inputEl.addEventListener("paste", (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
      if (item.type && item.type.indexOf("image/") === 0) {
        const file = item.getAsFile();
        if (!file) {
          continue;
        }
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || "");
          const comma = result.indexOf(",");
          const data = comma >= 0 ? result.slice(comma + 1) : result;
          pendingImages.push({ data, mimeType: file.type || "image/png" });
          renderPreview();
        };
        reader.readAsDataURL(file);
      }
    }
  });

  // ---------- 来自扩展的消息 ----------
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "userMessage": {
        finalizeCurrentAssistant();
        const label = msg.imageCount ? "[" + msg.imageCount + " 张图片] " : "";
        addPlain("user", "你", label + (msg.text || ""), msg.entryId);
        currentThinking = null;
        scrollToBottom(true); // 发送新消息时强制回到底部
        break;
      }
      case "streamStart":
        setStreaming(true);
        finalizeCurrentAssistant();
        currentThinking = null;
        break;
      case "streamEnd":
        // 先 flush 思考 delta（finalizeCurrentAssistant 会 cancel 所有 pending）
        if (rafId) {
          flushDeltas();
        }
        finalizeCurrentAssistant();
        currentThinking = null;
        setStreaming(false);
        break;
      case "assistantDelta":
        if (!currentAssistant) {
          currentAssistant = { el: addMarkdown("pi", ""), raw: "" };
        }
        currentAssistant.raw += msg.delta;
        textDirty = true;
        scheduleFlush();
        break;
      case "assistantFull":
        finalizeCurrentAssistant();
        addMarkdown("pi", msg.text);
        currentAssistant = null;
        break;
      case "thinkingDelta":
        if (!currentThinking) {
          currentThinking = addThinking();
        }
        currentThinking.raw += msg.delta;
        pendingThinkDelta += msg.delta;
        scheduleFlush();
        break;
      case "tool": {
        finalizeCurrentAssistant();
        const argStr = msg.args ? JSON.stringify(msg.args) : "";
        addTool(msg.toolName, argStr, msg.toolCallId);
        currentAssistant = null;
        break;
      }
      case "editCardStart": {
        finalizeCurrentAssistant();
        const card = buildEditCard(msg.toolName, msg.label, msg.path, msg.toolCallId);
        pendingToolCards.set(msg.toolCallId, card);
        currentAssistant = null;
        break;
      }
      case "editCardResult": {
        const card = pendingToolCards.get(msg.toolCallId);
        if (card) {
          card.setResult(msg);
          scrollToBottom();
          // 保留卡片引用，供后续 revert 时更新 UI（不再从 map 删除）
          if (!msg.canRevert) {
            pendingToolCards.delete(msg.toolCallId);
          }
        }
        break;
      }
      case "editReverted": {
        const card = pendingToolCards.get(msg.toolCallId);
        if (card && card.markReverted) {
          card.markReverted();
        }
        pendingToolCards.delete(msg.toolCallId);
        break;
      }
      case "system":
        addPlain("system", null, msg.text);
        break;
      case "systemError":
        addPlain("system error", null, msg.text);
        break;
      case "clear":
        cancelFlush();
        messagesEl.innerHTML = '<div id="emptyHint" class="empty-hint">输入消息开始对话…</div>';
        statsBarEl.innerHTML = "";
        changedFilesEl.innerHTML = "";
        currentAssistant = null;
        currentThinking = null;
        pendingToolCards.clear();
        inputEl.focus();
        break;
      case "toolResult": {
        const tag = pendingToolTags.get(msg.toolCallId);
        if (tag) {
          tag.classList.remove("running");
          if (msg.isError) {
            tag.classList.add("error");
          }
          pendingToolTags.delete(msg.toolCallId);
        }
        break;
      }
      case "modelChanged":
        modelNameEl.textContent = msg.modelId || "模型";
        modelBtn.title = "当前: " + (msg.provider ? msg.provider + "/" : "") + (msg.modelId || "") + "（点击切换）";
        break;
      case "stats":
        renderStats(msg);
        break;
      case "fileChanges":
        renderChangedFiles(msg.files);
        break;
      case "openFiles":
        openFiles = msg.files || [];
        // 若菜单正开着，根据当前 @token 重新过滤
        if (atStart >= 0) {
          const pos = inputEl.selectionStart;
          const before = inputEl.value.slice(0, pos);
          const m = before.match(/(^|\s)@([^\s@]*)$/);
          filterFiles(m ? m[2] : "");
        }
        break;
      case "viewOptions":
        applyViewOptions(msg);
        break;
      case "piReady":
        setPiReady(msg.ready === true);
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();

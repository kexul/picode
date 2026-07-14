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
  const ticketInputEl = document.getElementById("ticketInput");
  const ticketHistoryEl = document.getElementById("ticketHistory");
  const ticketApplyEl = document.getElementById("ticketApply");
  const ticketClearEl = document.getElementById("ticketClear");
  const ticketActiveEl = document.getElementById("ticketActive");
  const ticketBarEl = document.getElementById("ticketBar");

  // 显示选项：控制状态栏 / 工单栏的显隐
  function applyViewOptions(opts) {
    statsBarEl.classList.toggle("bar-hidden", opts.showStatsBar === false);
    ticketBarEl.classList.toggle("bar-hidden", opts.showTicketBar === false);
  }

  // 工单：校验 #+数字 开头
  function isValidTicket(v) {
    return /^#\d+/.test((v || "").trim());
  }

  // 更新“当前工单”指示
  function setActiveTicketLabel(label) {
    if (label && isValidTicket(label)) {
      ticketActiveEl.textContent = "记录中: " + label.trim();
      ticketActiveEl.classList.add("on");
    } else {
      ticketActiveEl.textContent = "未选择工单";
      ticketActiveEl.classList.remove("on");
    }
  }

  // 渲染历史工单下拉
  function renderTicketHistory(tickets) {
    const cur = ticketHistoryEl.value;
    ticketHistoryEl.innerHTML = '<option value="">历史工单…</option>';
    (tickets || []).forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.label || t.id;
      opt.textContent = t.label || t.id;
      ticketHistoryEl.appendChild(opt);
    });
    ticketHistoryEl.value = cur;
  }

  // 应用工单（填入框内容）
  function applyTicket() {
    const v = (ticketInputEl.value || "").trim();
    if (v && !isValidTicket(v)) {
      statusEl.textContent = "工单号需以 #+数字 开头，例如 #12031";
      return;
    }
    vscode.postMessage({ type: "setTicket", ticket: v });
    setActiveTicketLabel(v);
  }

  ticketApplyEl.addEventListener("click", applyTicket);
  ticketInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyTicket();
    }
  });
  ticketClearEl.addEventListener("click", () => {
    ticketInputEl.value = "";
    ticketHistoryEl.value = "";
    vscode.postMessage({ type: "setTicket", ticket: "" });
    setActiveTicketLabel("");
  });
  ticketHistoryEl.addEventListener("change", () => {
    const v = ticketHistoryEl.value;
    if (!v) {
      return;
    }
    ticketInputEl.value = v;
    applyTicket();
  });

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

      const stat = document.createElement("span");
      stat.className = "cf-stat";
      if (f.added) {
        const a = document.createElement("span");
        a.className = "cf-add";
        a.textContent = "+" + f.added;
        stat.appendChild(a);
      }
      if (f.added && f.removed) {
        stat.appendChild(document.createTextNode(" "));
      }
      if (f.removed) {
        const d = document.createElement("span");
        d.className = "cf-del";
        d.textContent = "-" + f.removed;
        stat.appendChild(d);
      }
      item.appendChild(stat);

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
    const t = msg.tokens || {};
    const parts = [];
    parts.push('<span class="stat" title="输入 token">↑ ' + fmtNum(t.input) + "</span>");
    parts.push('<span class="stat" title="输出 token">↓ ' + fmtNum(t.output) + "</span>");
    parts.push('<span class="stat" title="缓存读取">R ' + fmtNum(t.cacheRead) + "</span>");
    parts.push('<span class="stat" title="缓存写入">W ' + fmtNum(t.cacheWrite) + "</span>");
    if (typeof msg.cost === "number") {
      parts.push('<span class="stat" title="会话成本">$' + msg.cost.toFixed(4) + "</span>");
    }
    const cu = msg.contextUsage;
    if (cu && typeof cu.percent === "number") {
      let cls = "stat";
      let barColor = "var(--vscode-foreground)";
      if (cu.percent >= 90) { cls += " ctx-crit"; barColor = "var(--vscode-errorForeground)"; }
      else if (cu.percent >= 70) { cls += " ctx-hi"; barColor = "var(--vscode-editorWarning-foreground, #cca700)"; }
      const win = cu.contextWindow ? " / " + fmtNum(cu.contextWindow) : "";
      const barPct = Math.min(cu.percent, 100);
      parts.push(
        '<span class="' + cls + '" title="上下文使用">▣ ' +
        cu.percent.toFixed(1) + "% (" + fmtNum(cu.tokens) + win + ")" +
        '<span class="ctx-bar"><span class="ctx-bar-fill" style="width:' + barPct + '%;background:' + barColor + '"></span></span></span>'
      );
    }
    statsBarEl.innerHTML = parts.join("");
  }

  let currentAssistant = null; // { el, raw }
  let currentThinking = null;  // { wrap, body, raw, expanded }
  let currentToolRow = null;   // 连续 tool 调用的 flex 容器
  let streaming = false;
  let pendingImages = []; // [{ data, mimeType }]
  // edit/write 工具调用卡片：toolCallId -> { el, path }
  const pendingToolCards = new Map();

  // ---------- 语法高亮 ----------
  const KEYWORDS = new Set(
    (
      "abstract async await boolean break byte case catch char class const continue " +
      "debugger default delete do double else enum export extends false final finally " +
      "float for from function goto if implements import in instanceof int interface let " +
      "long namespace native new null package private protected public return short static " +
      "super switch synchronized this throw throws transient true try typeof var void " +
      "volatile while with yield def elif except lambda pass raise nonlocal global is not " +
      "and or None True False print self func type struct map range chan go defer " +
      "fn impl mut pub use mod match trait where loop unsafe string bool nil echo"
    ).split(/\s+/)
  );

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlightCode(raw) {
    let src = escapeHtml(raw);
    const holders = [];
    const stash = (cls, text) => {
      // 使用不含 \w / 数字的哨兵，避免被后续 数字/关键字 正则匹配
      const key = "\uE000" + "\uE002".repeat(holders.length) + "\uE001";
      holders.push('<span class="' + cls + '">' + text + "</span>");
      return key;
    };
    // 块注释 /* */
    src = src.replace(/\/\*[\s\S]*?\*\//g, (m) => stash("tok-com", m));
    // 行注释 // 和 #
    src = src.replace(/(^|\n)(\s*(?:\/\/|#)[^\n]*)/g, (m, pfx, c) => pfx + stash("tok-com", c));
    // 字符串
    src = src.replace(
      /(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|'[^'\n]*'|"[^"\n]*")/g,
      (m) => stash("tok-str", m)
    );
    src = src.replace(/`[^`\n]*`/g, (m) => stash("tok-str", m));
    // 数字
    src = src.replace(/\b(0x[0-9a-fA-F]+|\d+\.?\d*)\b/g, (m) => stash("tok-num", m));
    // 函数调用
    src = src.replace(/\b([A-Za-z_]\w*)(?=\s*\()/g, (m, name) =>
      KEYWORDS.has(name) ? '<span class="tok-kw">' + name + "</span>" : stash("tok-fn", name)
    );
    // 关键字
    src = src.replace(/\b([A-Za-z_]\w*)\b/g, (m, w) =>
      KEYWORDS.has(w) ? '<span class="tok-kw">' + w + "</span>" : w
    );
    // 回填（哨兵由 \uE002 重复次数表示索引）
    src = src.replace(/\uE000(\uE002*)\uE001/g, (m, marks) => holders[marks.length]);
    return src;
  }

  // ---------- Markdown 渲染 ----------
  function renderInline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, (_, c) => "<code>" + c + "</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
    out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
    return out;
  }

  function renderMarkdown(source) {
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    let html = "";
    let i = 0;
    let inList = null; // "ul" | "ol"
    const closeList = () => {
      if (inList) {
        html += "</" + inList + ">";
        inList = null;
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      // 代码块
      const fence = line.match(/^\s*```(\w*)\s*$/);
      if (fence) {
        closeList();
        const lang = fence[1] || "";
        i++;
        let code = "";
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          code += lines[i] + "\n";
          i++;
        }
        i++;
        const langLabel = lang ? '<span class="code-lang">' + escapeHtml(lang) + "</span>" : "";
        html += "<pre>" + langLabel + "<code>" + highlightCode(code.replace(/\n$/, "")) + "</code></pre>";
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeList();
        const lvl = Math.min(h[1].length, 3);
        html += "<h" + lvl + ">" + renderInline(h[2]) + "</h" + lvl + ">";
        i++;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        closeList();
        html += "<hr/>";
        i++;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        closeList();
        let quote = "";
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote += lines[i].replace(/^\s*>\s?/, "") + "\n";
          i++;
        }
        html += "<blockquote>" + renderMarkdown(quote.trim()) + "</blockquote>";
        continue;
      }

      // 表格：| 表头 | 表头 |
      //       |---|---|
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
        closeList();
        const parseRow = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
        const headers = parseRow(line);
        const aligns = parseRow(lines[i + 1]).map((s) => {
          if (/^:.*:$/.test(s)) return "center";
          if (/:$/.test(s)) return "right";
          return "left";
        });
        i += 2;
        let tableHtml = '<div class="md-table-wrap"><table><thead><tr>';
        headers.forEach((h, ci) => {
          tableHtml += '<th style="text-align:' + (aligns[ci] || "left") + "\">" + renderInline(h) + "</th>";
        });
        tableHtml += "</tr></thead><tbody>";
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const cells = parseRow(lines[i]);
          tableHtml += "<tr>";
          cells.forEach((c, ci) => {
            tableHtml += '<td style="text-align:' + (aligns[ci] || "left") + "\">" + renderInline(c) + "</td>";
          });
          tableHtml += "</tr>";
          i++;
        }
        tableHtml += "</tbody></table></div>";
        html += tableHtml;
        continue;
      }

      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        if (inList !== "ul") {
          closeList();
          html += "<ul>";
          inList = "ul";
        }
        html += "<li>" + renderInline(ul[1]) + "</li>";
        i++;
        continue;
      }

      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) {
        if (inList !== "ol") {
          closeList();
          html += "<ol>";
          inList = "ol";
        }
        html += "<li>" + renderInline(ol[1]) + "</li>";
        i++;
        continue;
      }

      if (/^\s*$/.test(line)) {
        closeList();
        i++;
        continue;
      }

      // 普通段落
      closeList();
      let para = line;
      i++;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^\s*```/.test(lines[i]) &&
        !/^(#{1,6})\s/.test(lines[i]) &&
        !/^\s*[-*+]\s/.test(lines[i]) &&
        !/^\s*\d+\.\s/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i])
      ) {
        para += "\n" + lines[i];
        i++;
      }
      html += "<p>" + renderInline(para).replace(/\n/g, "<br/>") + "</p>";
    }
    closeList();
    return html;
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

  function isNearBottom() {
    return (
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <=
      BOTTOM_THRESHOLD
    );
  }

  // 用户手动滚动时更新黏底状态
  messagesEl.addEventListener("scroll", () => {
    stickToBottom = isNearBottom();
  });

  function scrollToBottom(force) {
    if (force || stickToBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      stickToBottom = true;
    }
  }

  function addPlain(cls, role, text) {
    hideEmptyHint();
    currentToolRow = null; // 非 tool 消息重置 tool 行
    const div = document.createElement("div");
    div.className = "msg " + cls + " msg-enter";
    const body = document.createElement("div");
    body.textContent = text || "";
    div.appendChild(body);
    messagesEl.appendChild(div);
    scrollToBottom();
    return body;
  }

  // 添加工具调用标签：连续的 tool 放在同一 flex 行，排不下自动换行
  function addTool(toolName, argStr) {
    hideEmptyHint();
    if (!currentToolRow) {
      currentToolRow = document.createElement("div");
      currentToolRow.className = "msg tool-row msg-enter";
      messagesEl.appendChild(currentToolRow);
    }
    const tag = document.createElement("span");
    tag.className = "tool";
    tag.textContent = "⚙ " + toolName;
    if (argStr) {
      const argsDiv = document.createElement("span");
      argsDiv.className = "tool-args";
      argsDiv.textContent = argStr;
      tag.appendChild(argsDiv);
      tag.addEventListener("click", () => tag.classList.toggle("expanded"));
    }
    currentToolRow.appendChild(tag);
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
    wrap.appendChild(body);

    const state = { wrap, body, raw: "", expanded: false };
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
          if (toolCallId) {
            vscode.postMessage({ type: "openEditLocation", path, toolCallId });
          } else {
            vscode.postMessage({ type: "openEditLocation", path, line });
          }
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

  function setStreaming(on) {
    streaming = on;
    sendBtn.textContent = on ? "中止" : "发送";
    if (on) {
      statusEl.innerHTML =
        '<span class="typing"><span></span><span></span><span></span></span> pi 正在思考…';
    } else {
      statusEl.textContent = "";
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
      hideFileMenu();
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

  function autoResize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight, 144), 640) + "px";
  }

  inputEl.addEventListener("keydown", (e) => {
    // 文件菜单导航
    if (!fileMenuEl.classList.contains("hidden")) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveFileSel(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveFileSel(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseFile(); return; }
      if (e.key === "Escape") { e.preventDefault(); hideFileMenu(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
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
        const label = msg.imageCount ? "[" + msg.imageCount + " 张图片] " : "";
        addPlain("user", "你", label + (msg.text || ""));
        currentAssistant = null;
        currentThinking = null;
        scrollToBottom(true); // 发送新消息时强制回到底部
        break;
      }
      case "streamStart":
        setStreaming(true);
        currentAssistant = null;
        currentThinking = null;
        break;
      case "streamEnd":
        setStreaming(false);
        currentAssistant = null;
        currentThinking = null;
        break;
      case "assistantDelta":
        if (!currentAssistant) {
          currentAssistant = { el: addMarkdown("pi", ""), raw: "" };
        }
        currentAssistant.raw += msg.delta;
        currentAssistant.el.innerHTML = renderMarkdown(currentAssistant.raw);
        scrollToBottom();
        break;
      case "assistantFull":
        addMarkdown("pi", msg.text);
        currentAssistant = null;
        break;
      case "thinkingDelta":
        if (!currentThinking) {
          currentThinking = addThinking();
        }
        currentThinking.raw += msg.delta;
        currentThinking.body.textContent = currentThinking.raw;
        scrollToBottom();
        break;
      case "tool": {
        const argStr = msg.args ? JSON.stringify(msg.args) : "";
        addTool(msg.toolName, argStr);
        currentAssistant = null;
        break;
      }
      case "editCardStart": {
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
        messagesEl.innerHTML = '<div id="emptyHint" class="empty-hint">输入消息开始对话…</div>';
        statsBarEl.innerHTML = "";
        changedFilesEl.innerHTML = "";
        ticketInputEl.value = "";
        ticketHistoryEl.value = "";
        setActiveTicketLabel("");
        currentAssistant = null;
        currentThinking = null;
        pendingToolCards.clear();
        inputEl.focus();
        break;
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
      case "tickets":
        renderTicketHistory(msg.tickets);
        break;
      case "activeTicket":
        if (typeof msg.ticket === "string") {
          ticketInputEl.value = msg.ticket;
          setActiveTicketLabel(msg.ticket);
        }
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
    }
  });

  vscode.postMessage({ type: "ready" });
})();

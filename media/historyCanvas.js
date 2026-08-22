/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const threadList = document.getElementById("threadList");
  const search = document.getElementById("search");
  const noResults = document.getElementById("noResults");
  const listFooter = document.getElementById("listFooter");
  const btnLoadMore = document.getElementById("btnLoadMore");
  const emptyReading = document.getElementById("emptyReading");
  const threadDetail = document.getElementById("threadDetail");
  const detailTitle = document.getElementById("detailTitle");
  const detailMeta = document.getElementById("detailMeta");
  const messagesEl = document.getElementById("messages");

  /** @type {{families:any[], totalFamilies:number, loadedFamilies:number, focus:any}} */
  let state = { families: [], totalFamilies: 0, loadedFamilies: 0, focus: null };
  let selectedFamilyId = null;
  let selectedSessionFile = null;
  let graphResizeObserver = null;
  let branchPreviewTimer = null;

  function normFile(p) {
    return String(p || "").replace(/\\/g, "/").toLowerCase().replace(/^[a-z]:/, "");
  }
  function timestamp(value) {
    const n = Date.parse(value || "");
    return Number.isNaN(n) ? 0 : n;
  }
  function latestSession(family) {
    return (family.sessions || []).slice().sort((a, b) => timestamp(b.timestamp) - timestamp(a.timestamp))[0] || null;
  }
  function familyActivity(family) {
    const s = latestSession(family);
    return timestamp(s ? s.timestamp : family.timestamp);
  }
  function sortedFamilies() {
    return state.families.slice().sort((a, b) => familyActivity(b) - familyActivity(a));
  }
  function compactLine(value, limit) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? text.slice(0, Math.max(0, limit - 1)) + "…" : text;
  }
  function firstUserText(family) {
    const messages = (family.messages || []).slice().sort((a, b) => timestamp(a.timestamp) - timestamp(b.timestamp));
    const user = messages.find((m) => m.role === "user" && String(m.text || "").trim());
    const first = messages.find((m) => String(m.text || "").trim());
    return compactLine((user || first || {}).text || "未命名会话", 140);
  }
  function sessionTitle(family, file) {
    const session = (family.sessions || []).find((s) => normFile(s.file) === normFile(file)) || latestSession(family);
    const name = String((session || {}).name || "").replace(/\s+/g, " ").trim();
    return compactLine(name || firstUserText(family), 160);
  }
  function pathForSession(family, file) {
    const session = (family.sessions || []).find((s) => normFile(s.file) === normFile(file)) || latestSession(family);
    if (!session || !session.leafId) { return []; }
    const byId = new Map((family.messages || []).map((m) => [m.id, m]));
    const path = [];
    const seen = new Set();
    let current = session.leafId;
    while (current && byId.has(current) && !seen.has(current)) {
      seen.add(current);
      path.unshift(byId.get(current));
      current = byId.get(current).parentId;
    }
    return path;
  }
  function summaryFor(family, file) {
    const path = pathForSession(family, file);
    const last = path[path.length - 1];
    return compactLine((last || {}).text || firstUserText(family), 180);
  }
  function displayTime(value) {
    const d = new Date(value || "");
    if (Number.isNaN(d.getTime())) { return ""; }
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) { return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
    if (d.getFullYear() === now.getFullYear()) { return (d.getMonth() + 1) + "/" + d.getDate(); }
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  }
  function dateGroup(value) {
    const d = new Date(value || "");
    if (Number.isNaN(d.getTime())) { return "更早"; }
    const now = new Date();
    const day = 86400000;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const delta = Math.round((today - target) / day);
    if (delta === 0) { return "今天"; }
    if (delta === 1) { return "昨天"; }
    if (delta >= 0 && delta < 7) { return "本周"; }
    if (d.getFullYear() === now.getFullYear()) { return "更早"; }
    return String(d.getFullYear()) + " 年";
  }
  function selectedFamily() {
    return state.families.find((f) => f.id === selectedFamilyId) || null;
  }
  function selectedSession(family) {
    return (family.sessions || []).find((s) => normFile(s.file) === normFile(selectedSessionFile)) || latestSession(family);
  }
  function updateLoadMore() {
    const more = state.loadedFamilies < state.totalFamilies;
    listFooter.classList.toggle("hidden", !more);
    btnLoadMore.disabled = false;
    if (more) {
      btnLoadMore.textContent = "加载更多（剩余 " + (state.totalFamilies - state.loadedFamilies) + "）";
      btnLoadMore.title = "加载更早的会话";
    }
  }
  /**
   * 为分叉轨迹上的消息取其最早所属会话。
   * 后续子分支会复用父分支消息；最早文件就是该节点所在轨迹的本体分支。
   */
  function branchSessionForMessage(family, message) {
    const files = new Set((message.files || []).map(normFile));
    return (family.sessions || [])
      .filter((session) => session.file && files.has(normFile(session.file)))
      .sort((a, b) => timestamp(a.timestamp) - timestamp(b.timestamp))[0] || null;
  }
  function cancelBranchPreview() {
    if (branchPreviewTimer !== null) {
      clearTimeout(branchPreviewTimer);
      branchPreviewTimer = null;
    }
  }
  function selectFamily(family, file) {
    cancelBranchPreview();
    selectedFamilyId = family.id;
    const session = file ? (family.sessions || []).find((s) => normFile(s.file) === normFile(file)) : latestSession(family);
    selectedSessionFile = (session || latestSession(family) || {}).file || null;
    render();
  }
  function previewBranch(family, session) {
    cancelBranchPreview();
    // 延后单击预览，给原生 dblclick 一个机会，避免第一次 click 重绘掉目标行。
    branchPreviewTimer = setTimeout(() => {
      branchPreviewTimer = null;
      selectFamily(family, session.file);
    }, 220);
  }
  function ensureSelection() {
    const families = sortedFamilies();
    if (!families.length) { selectedFamilyId = null; selectedSessionFile = null; return; }
    const found = families.find((f) => f.id === selectedFamilyId);
    if (found) {
      if (!(found.sessions || []).some((s) => normFile(s.file) === normFile(selectedSessionFile))) {
        selectedSessionFile = (latestSession(found) || {}).file || null;
      }
      return;
    }
    const focusFamily = state.focus && state.focus.familyId && families.find((f) => f.id === state.focus.familyId);
    const focusFile = state.focus && state.focus.sessionFile;
    const chosen = focusFamily || families[0];
    selectedFamilyId = chosen.id;
    selectedSessionFile = (focusFile && (chosen.sessions || []).some((s) => normFile(s.file) === normFile(focusFile)))
      ? focusFile : ((latestSession(chosen) || {}).file || null);
  }
  function renderList() {
    const query = search.value.trim().toLowerCase();
    const families = sortedFamilies().filter((family) => {
      if (!query) { return true; }
      const haystack = [sessionTitle(family, (latestSession(family) || {}).file), firstUserText(family), ...((family.messages || []).map((m) => m.text || ""))].join(" ").toLowerCase();
      return haystack.includes(query);
    });
    threadList.innerHTML = "";
    const noItems = families.length === 0;
    noResults.classList.toggle("hidden", !noItems);
    if (noItems) {
      noResults.textContent = state.families.length ? "没有匹配的会话。" : "当前工作区没有会话记录。";
      threadList.appendChild(noResults);
    }
    let lastGroup = "";
    for (const family of families) {
      const session = latestSession(family);
      const activity = (session || {}).timestamp || family.timestamp;
      const group = dateGroup(activity);
      if (group !== lastGroup) {
        lastGroup = group;
        const label = document.createElement("div");
        label.className = "date-group-label";
        label.textContent = group;
        threadList.appendChild(label);
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "thread-row" + (family.id === selectedFamilyId ? " selected" : "");
      row.title = "单击预览，双击打开会话";
      const main = document.createElement("div");
      main.className = "thread-main";
      const subject = document.createElement("div");
      subject.className = "thread-subject";
      subject.textContent = sessionTitle(family, (session || {}).file);
      const preview = document.createElement("div");
      preview.className = "thread-preview";
      preview.textContent = summaryFor(family, (session || {}).file);
      main.append(subject, preview);
      const meta = document.createElement("div");
      meta.className = "thread-meta";
      const time = document.createElement("span");
      time.className = "thread-time";
      time.textContent = displayTime(activity);
      const count = document.createElement("span");
      count.className = "thread-count";
      count.textContent = String((family.sessions || []).length);
      count.title = "分支会话数";
      meta.append(time, count);
      row.append(main, meta);
      row.addEventListener("click", () => selectFamily(family));
      row.addEventListener("dblclick", () => openSession(family, (latestSession(family) || {}).file));
      threadList.appendChild(row);
    }
  }
  function openSession(family, file, entryId) {
    const session = (family.sessions || []).find((s) => normFile(s.file) === normFile(file)) || latestSession(family);
    const targetEntryId = entryId || (session || {}).leafId;
    if (!session || !session.file || !targetEntryId) { return; }
    vscode.postMessage({ type: "openEntry", file: session.file, entryId: targetEntryId });
  }
  /** 将合并后的消息图按固定时间顺序拉平，切换分支时只更新高亮而不重排。 */
  function treeRowsFor(family, activePath) {
    const byId = new Map((family.messages || []).map((m) => [m.id, m]));
    let roots = (family.roots || []).filter((id) => byId.has(id));
    if (!roots.length) {
      roots = (family.messages || []).filter((m) => !m.parentId || !byId.has(m.parentId)).map((m) => m.id);
    }

    // messages / children 已在构建数据时按时间排序；保持该顺序以稳定图形布局。
    const ordered = (ids) => ids.filter((id) => byId.has(id));

    const rows = [];
    const renderStack = [];
    const orderedRoots = ordered(roots);
    for (let i = orderedRoots.length - 1; i >= 0; i--) {
      renderStack.push({ id: orderedRoots[i], indent: 0 });
    }
    const rendered = new Set();
    while (renderStack.length) {
      const row = renderStack.pop();
      if (rendered.has(row.id)) { continue; }
      rendered.add(row.id);
      rows.push(row);
      const children = ordered(byId.get(row.id).children || []);
      const branches = children.length > 1;
      const childIndent = branches ? row.indent + 1 : row.indent;
      for (let i = children.length - 1; i >= 0; i--) {
        renderStack.push({
          id: children[i],
          indent: childIndent,
        });
      }
    }
    return { rows, byId };
  }

  function treeSummary(text) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    return normalized.length > 220 ? normalized.slice(0, 219) + "…" : normalized;
  }

  function svgElement(name, attrs) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const key of Object.keys(attrs)) { element.setAttribute(key, String(attrs[key])); }
    return element;
  }

  /** 在消息行左侧绘制 Git 图式轨迹：圆点代表消息，曲线代表父子关系。 */
  function drawGitGraph(tree, rows, byId, activePath) {
    const oldGraph = tree.querySelector(".tree-graph");
    if (oldGraph) { oldGraph.remove(); }
    if (!tree.isConnected) { return; }

    const bounds = tree.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(bounds.width));
    const height = Math.max(1, Math.ceil(bounds.height));
    const graph = svgElement("svg", {
      class: "tree-graph",
      width,
      height,
      viewBox: "0 0 " + width + " " + height,
      "aria-hidden": "true",
    });
    const rowElements = tree.querySelectorAll(".tree-row");
    const points = new Map();
    for (let i = 0; i < rows.length && i < rowElements.length; i++) {
      const rect = rowElements[i].getBoundingClientRect();
      points.set(rows[i].id, {
        x: 14 + rows[i].indent * 22,
        y: rect.top - bounds.top + rect.height / 2,
        current: rowElements[i].classList.contains("current-leaf"),
      });
    }

    for (const rowData of rows) {
      const message = byId.get(rowData.id);
      const from = points.get(rowData.id);
      if (!message || !from) { continue; }
      const children = (message.children || []).filter((id) => points.has(id));
      for (const childId of children) {
        const to = points.get(childId);
        const bend = Math.min(10, Math.max(4, Math.abs(to.y - from.y) / 2));
        const path = from.x === to.x
          ? "M " + from.x + " " + from.y + " V " + to.y
          : "M " + from.x + " " + from.y + " V " + (to.y - bend) +
            " Q " + from.x + " " + to.y + " " + (from.x + Math.sign(to.x - from.x) * bend) + " " + to.y +
            " H " + to.x;
        const active = activePath.has(rowData.id) && activePath.has(childId);
        graph.appendChild(svgElement("path", { class: "tree-link" + (active ? " active" : ""), d: path }));
      }
    }

    for (const rowData of rows) {
      const point = points.get(rowData.id);
      if (!point) { continue; }
      const active = activePath.has(rowData.id);
      const classes = "tree-node" + (active ? " active" : "") + (point.current ? " current" : "");
      graph.appendChild(svgElement("circle", {
        class: classes,
        cx: point.x,
        cy: point.y,
        r: point.current ? 4.3 : (active ? 3.3 : 2.6),
      }));
    }
    tree.insertBefore(graph, tree.firstChild);
  }

  /** 右侧显示完整消息树；分叉后的节点可单击切换、双击加载。 */
  function renderMessageTree(family, activePath) {
    if (graphResizeObserver) {
      graphResizeObserver.disconnect();
      graphResizeObserver = null;
    }
    messagesEl.innerHTML = "";
    const data = treeRowsFor(family, activePath);
    if (!data.rows.length) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "该会话尚未包含可显示的文本消息。";
      messagesEl.appendChild(empty);
      return;
    }
    const tree = document.createElement("div");
    tree.className = "message-tree";
    for (const rowData of data.rows) {
      const msg = data.byId.get(rowData.id);
      const row = document.createElement("div");
      const onActivePath = activePath.has(msg.id);
      row.className = "tree-row" + (onActivePath ? " on-active-path" : "");
      row.style.setProperty("--tree-depth", String(rowData.indent));
      if (onActivePath && (msg.children || []).every((id) => !activePath.has(id))) {
        row.classList.add("current-leaf");
      }
      // indent > 0 表示该行处于某次分叉之后；公共主干不绑定某个特定分支。
      const branchSession = rowData.indent > 0 ? branchSessionForMessage(family, msg) : null;
      row.title = (msg.role === "user" ? "我" : "Pi") + ": " + String(msg.text || "");
      if (branchSession) {
        row.classList.add("branch-target");
        row.title += "\n单击切换到此分支 · 双击加载到对话";
        row.addEventListener("click", () => previewBranch(family, branchSession));
        row.addEventListener("dblclick", (event) => {
          event.preventDefault();
          cancelBranchPreview();
          selectFamily(family, branchSession.file);
          openSession(family, branchSession.file, msg.id);
        });
      }

      const role = document.createElement("span");
      role.className = "tree-role " + msg.role;
      role.textContent = msg.role === "user" ? "我" : "Pi";
      const text = document.createElement("span");
      text.className = "tree-text";
      text.textContent = treeSummary(msg.text);
      row.append(role, text);
      tree.appendChild(row);
    }
    messagesEl.appendChild(tree);

    let animationFrame = null;
    const scheduleGraphDraw = () => {
      if (animationFrame !== null) { return; }
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        drawGitGraph(tree, data.rows, data.byId, activePath);
      });
    };
    if (typeof ResizeObserver !== "undefined") {
      graphResizeObserver = new ResizeObserver(scheduleGraphDraw);
      graphResizeObserver.observe(tree);
    }
    scheduleGraphDraw();
  }

  function renderDetail() {
    const family = selectedFamily();
    emptyReading.classList.toggle("hidden", !!family);
    threadDetail.classList.toggle("hidden", !family);
    if (!family) { return; }
    const session = selectedSession(family);
    const file = (session || {}).file;
    const activePath = new Set(pathForSession(family, file).map((msg) => msg.id));
    detailTitle.textContent = sessionTitle(family, file);
    const sessionCount = (family.sessions || []).length;
    const messageCount = (family.messages || []).length;
    detailMeta.textContent = messageCount + " 条消息 · " + sessionCount + " 个会话";
    renderMessageTree(family, activePath);
  }
  function render() {
    ensureSelection();
    updateLoadMore();
    renderList();
    renderDetail();
  }

  search.addEventListener("input", renderList);
  btnLoadMore.addEventListener("click", () => {
    btnLoadMore.disabled = true;
    btnLoadMore.textContent = "加载中…";
    vscode.postMessage({ type: "loadMore" });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") { return; }
    if (msg.type === "init") {
      state = { families: msg.families || [], totalFamilies: msg.totalFamilies || 0, loadedFamilies: msg.loadedFamilies || 0, focus: msg.focus || null };
      // 显式聚焦当前会话时应切换到它；普通刷新则尽量保留用户当前选择。
      if (state.focus && state.focus.familyId) { selectedFamilyId = state.focus.familyId; selectedSessionFile = state.focus.sessionFile || null; }
      render();
    } else if (msg.type === "append") {
      state.families = state.families.concat(msg.families || []);
      state.totalFamilies = msg.totalFamilies || state.totalFamilies;
      state.loadedFamilies = msg.loadedFamilies || state.loadedFamilies;
      render();
    } else if (msg.type === "error") {
      btnLoadMore.disabled = false;
      btnLoadMore.textContent = "加载失败，重试";
      btnLoadMore.title = msg.text || "加载失败";
    }
  });

  vscode.postMessage({ type: "ready" });
})();

/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const threadList = document.getElementById("threadList");
  const search = document.getElementById("search");
  const noResults = document.getElementById("noResults");
  const tbMeta = document.getElementById("tbMeta");
  const btnRefresh = document.getElementById("btnRefresh");
  const btnLoadMore = document.getElementById("btnLoadMore");
  const emptyReading = document.getElementById("emptyReading");
  const threadDetail = document.getElementById("threadDetail");
  const detailTitle = document.getElementById("detailTitle");
  const detailMeta = document.getElementById("detailMeta");
  const branchBar = document.getElementById("branchBar");
  const messagesEl = document.getElementById("messages");
  const btnOpenThread = document.getElementById("btnOpenThread");

  /** @type {{families:any[], totalFamilies:number, loadedFamilies:number, focus:any}} */
  let state = { families: [], totalFamilies: 0, loadedFamilies: 0, focus: null };
  let selectedFamilyId = null;
  let selectedSessionFile = null;

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
  function firstUserText(family) {
    const messages = (family.messages || []).slice().sort((a, b) => timestamp(a.timestamp) - timestamp(b.timestamp));
    const user = messages.find((m) => m.role === "user" && String(m.text || "").trim());
    const first = messages.find((m) => String(m.text || "").trim());
    return String((user || first || {}).text || "未命名会话").replace(/\s+/g, " ").trim();
  }
  function sessionTitle(family, file) {
    const session = (family.sessions || []).find((s) => normFile(s.file) === normFile(file)) || latestSession(family);
    const name = String((session || {}).name || "").replace(/\s+/g, " ").trim();
    return name || firstUserText(family);
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
    return String((last || {}).text || firstUserText(family)).replace(/\s+/g, " ").trim();
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
  function setMeta() {
    if (!state.families.length) { tbMeta.textContent = ""; return; }
    tbMeta.textContent = "已加载 " + state.loadedFamilies + " / " + state.totalFamilies + " 个会话线程";
  }
  function updateLoadMore() {
    const more = state.loadedFamilies < state.totalFamilies;
    btnLoadMore.classList.toggle("hidden", !more);
    btnLoadMore.disabled = false;
    if (more) { btnLoadMore.textContent = "加载更多（剩余 " + (state.totalFamilies - state.loadedFamilies) + "）"; }
  }
  function selectFamily(family, file) {
    selectedFamilyId = family.id;
    const session = file ? (family.sessions || []).find((s) => normFile(s.file) === normFile(file)) : latestSession(family);
    selectedSessionFile = (session || latestSession(family) || {}).file || null;
    render();
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
  function openSession(family, file) {
    const session = (family.sessions || []).find((s) => normFile(s.file) === normFile(file)) || latestSession(family);
    if (!session || !session.file || !session.leafId) { return; }
    vscode.postMessage({ type: "openEntry", file: session.file, entryId: session.leafId });
  }
  function renderDetail() {
    const family = selectedFamily();
    emptyReading.classList.toggle("hidden", !!family);
    threadDetail.classList.toggle("hidden", !family);
    if (!family) { return; }
    const session = selectedSession(family);
    const file = (session || {}).file;
    detailTitle.textContent = sessionTitle(family, file);
    const sessionCount = (family.sessions || []).length;
    const msgPath = pathForSession(family, file);
    detailMeta.textContent = (session ? displayTime(session.timestamp) : "") + " · " + msgPath.length + " 条消息" + (sessionCount > 1 ? " · " + sessionCount + " 个分支" : "");
    btnOpenThread.disabled = !session || !session.leafId;
    branchBar.innerHTML = "";
    const branches = (family.sessions || []).slice().sort((a, b) => timestamp(b.timestamp) - timestamp(a.timestamp));
    for (let i = 0; i < branches.length; i++) {
      const branch = branches[i];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "branch-button" + (normFile(branch.file) === normFile(file) ? " selected" : "");
      button.textContent = i === 0 ? "最新分支 · " + displayTime(branch.timestamp) : "分支 " + (i + 1) + " · " + displayTime(branch.timestamp);
      button.title = "查看此分支";
      button.addEventListener("click", () => selectFamily(family, branch.file));
      branchBar.appendChild(button);
    }
    messagesEl.innerHTML = "";
    if (!msgPath.length) {
      const empty = document.createElement("div");
      empty.className = "message empty";
      empty.textContent = "该会话尚未包含可显示的文本消息。";
      messagesEl.appendChild(empty);
      return;
    }
    for (const msg of msgPath) {
      const message = document.createElement("article");
      message.className = "message " + (msg.role === "user" ? "user" : "assistant");
      const head = document.createElement("div");
      head.className = "message-head";
      const role = document.createElement("span");
      role.className = "message-role";
      role.textContent = msg.role === "user" ? "我" : "Pi";
      head.appendChild(role);
      if (msg.timestamp) {
        const time = document.createElement("span");
        time.className = "message-time";
        time.textContent = new Date(msg.timestamp).toLocaleString();
        head.appendChild(time);
      }
      if (msg.role === "user") {
        const fork = document.createElement("button");
        fork.type = "button";
        fork.className = "message-action";
        fork.textContent = "从此分支";
        fork.addEventListener("click", () => {
          if (file) { vscode.postMessage({ type: "forkEntry", file, entryId: msg.id }); }
        });
        head.appendChild(fork);
      }
      const body = document.createElement("div");
      body.className = "message-body";
      body.textContent = msg.text || "";
      message.append(head, body);
      messagesEl.appendChild(message);
    }
  }
  function render() {
    ensureSelection();
    setMeta();
    updateLoadMore();
    renderList();
    renderDetail();
  }

  search.addEventListener("input", renderList);
  btnRefresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  btnLoadMore.addEventListener("click", () => {
    btnLoadMore.disabled = true;
    btnLoadMore.textContent = "加载中…";
    vscode.postMessage({ type: "loadMore" });
  });
  btnOpenThread.addEventListener("click", () => {
    const family = selectedFamily();
    if (family) { openSession(family, selectedSessionFile); }
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
      tbMeta.textContent = msg.text || "加载失败";
      btnLoadMore.disabled = false;
    }
  });

  vscode.postMessage({ type: "ready" });
})();

// Electron 应用层前端逻辑：项目切换、各类 modal、历史/设置/显示选项面板。
// 与 chat.js（来自 @pi/chat-ui）共享同一 acquireVsCodeApi shim，消息走 'pc'/'ph' 通道。
(function () {
  const vscode = acquireVsCodeApi();
  const projectBtn = document.getElementById("projectBtn");
  const projectName = document.getElementById("projectName");
  const projectMenu = document.getElementById("projectMenu");
  const appOverlay = document.getElementById("appOverlay");
  const appModal = document.getElementById("appModal");

  let recentProjects = [];
  let currentProjectPath = "";
  let viewOptions = { showStatsBar: true, autoLoadLastSession: false, sendKey: "enter" };

  vscode.postMessage({ type: "app:ready" });

  function toggleProjectMenu() {
    if (projectMenu.classList.contains("hidden")) { renderProjectMenu(); projectMenu.classList.remove("hidden"); }
    else projectMenu.classList.add("hidden");
  }
  projectBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleProjectMenu(); });
  document.addEventListener("click", (e) => { if (!projectMenu.contains(e.target) && e.target !== projectBtn) projectMenu.classList.add("hidden"); });

  function renderProjectMenu() {
    projectMenu.innerHTML = "";
    if (recentProjects.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pm-item"; empty.style.opacity = "0.55"; empty.textContent = "还没有最近项目";
      projectMenu.appendChild(empty);
    } else {
      recentProjects.forEach((p) => {
        const item = document.createElement("div");
        item.className = "pm-item" + (p.path === currentProjectPath ? " active" : "");
        const name = document.createElement("div"); name.className = "pm-name"; name.textContent = p.name;
        const pp = document.createElement("div"); pp.className = "pm-path"; pp.textContent = p.path;
        item.appendChild(name); item.appendChild(pp);
        item.addEventListener("click", () => { projectMenu.classList.add("hidden"); vscode.postMessage({ type: "app:switchProject", path: p.path }); });
        projectMenu.appendChild(item);
      });
    }
    const sep = document.createElement("div"); sep.className = "pm-sep"; projectMenu.appendChild(sep);
    const add = document.createElement("div"); add.className = "pm-action"; add.textContent = "＋ 选择文件夹…";
    add.addEventListener("click", () => { projectMenu.classList.add("hidden"); vscode.postMessage({ type: "app:pickProject" }); });
    projectMenu.appendChild(add);
  }

  function openModal(builder) { appModal.innerHTML = ""; builder(appModal); appOverlay.classList.remove("hidden"); }
  function closeModal() { appOverlay.classList.add("hidden"); appModal.innerHTML = ""; appModal.classList.remove("wide"); appModal.style.width = ""; appModal.style.height = ""; settingsDispatch = null; }
  appOverlay.addEventListener("click", (e) => { if (e.target === appOverlay) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !appOverlay.classList.contains("hidden")) closeModal(); });

  function modalHeader(title, sub) {
    const t = document.createElement("div"); t.className = "modal-title";
    t.innerHTML = "<span>" + esc(title) + "</span>" + (sub ? '<span class="modal-sub">' + esc(sub) + "</span>" : "");
    appModal.appendChild(t);
  }
  function modalFooter(btns) {
    const f = document.createElement("div"); f.className = "modal-footer";
    btns.forEach((b) => {
      const btn = document.createElement("button"); btn.textContent = b.label;
      if (b.secondary) btn.className = "secondary";
      btn.addEventListener("click", () => b.onClick && b.onClick());
      f.appendChild(btn);
    });
    appModal.appendChild(f);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  function handleModal(msg) {
    const reply = (payload) => vscode.postMessage({ type: "modalReply", id: msg.id, payload });
    switch (msg.kind) {
      case "confirm":
        appModal.style.width = "min(440px, 92vw)";
        modalHeader(msg.data.title || "确认");
        { const body = document.createElement("div"); body.className = "modal-body";
          const m = document.createElement("div"); m.className = "modal-msg"; m.textContent = msg.data.message || "";
          body.appendChild(m); appModal.appendChild(body);
          modalFooter([
            { label: "否", secondary: true, onClick: () => { closeModal(); reply({ confirmed: false }); } },
            { label: "是", onClick: () => { closeModal(); reply({ confirmed: true }); } },
          ]); }
        break;
      case "select":
        appModal.style.width = "min(440px, 92vw)";
        modalHeader(msg.data.title || "选择");
        { const body = document.createElement("div"); body.className = "modal-body";
          const list = document.createElement("div"); list.className = "modal-list";
          (msg.data.options || []).forEach((opt) => {
            const it = document.createElement("div"); it.className = "ml-item";
            const t = document.createElement("div"); t.className = "ml-title"; t.textContent = typeof opt === "string" ? opt : (opt.label || "");
            it.appendChild(t);
            it.addEventListener("click", () => { closeModal(); reply({ value: typeof opt === "string" ? opt : (opt.value ?? opt.label) }); });
            list.appendChild(it);
          });
          body.appendChild(list); appModal.appendChild(body);
          modalFooter([{ label: "取消", secondary: true, onClick: () => { closeModal(); reply({ cancelled: true }); } }]); }
        break;
      case "input":
        appModal.style.width = "min(480px, 92vw)";
        modalHeader(msg.data.title || "输入");
        { const body = document.createElement("div"); body.className = "modal-body";
          const input = document.createElement("input"); input.className = "modal-input";
          input.placeholder = msg.data.placeholder || "";
          if (msg.data.prefill != null) input.value = msg.data.prefill;
          input.addEventListener("keydown", (e) => { if (e.key === "Enter") { closeModal(); reply({ value: input.value }); } });
          body.appendChild(input); appModal.appendChild(body);
          modalFooter([
            { label: "取消", secondary: true, onClick: () => { closeModal(); reply({ cancelled: true }); } },
            { label: "确定", onClick: () => { closeModal(); reply({ value: input.value }); } },
          ]);
          setTimeout(() => input.focus(), 0); }
        break;
      case "pickModel":
        appModal.style.width = "min(520px, 92vw)";
        modalHeader("切换模型", "选择要使用的模型");
        { const body = document.createElement("div"); body.className = "modal-body";
          const list = document.createElement("div"); list.className = "modal-list";
          (msg.data.models || []).forEach((m) => {
            const it = document.createElement("div"); it.className = "ml-item";
            const t = document.createElement("div"); t.className = "ml-title"; t.textContent = m.id;
            const d = document.createElement("div"); d.className = "ml-desc"; d.textContent = (m.provider ? m.provider : "") + (m.name && m.name !== m.id ? " · " + m.name : "");
            it.appendChild(t); it.appendChild(d);
            if (m.contextWindow) { const det = document.createElement("div"); det.className = "ml-detail"; det.textContent = "上下文 " + Math.round(m.contextWindow / 1000) + "K"; it.appendChild(det); }
            it.addEventListener("click", () => { closeModal(); reply({ provider: m.provider, modelId: m.id }); });
            list.appendChild(it);
          });
          body.appendChild(list); appModal.appendChild(body);
          modalFooter([{ label: "取消", secondary: true, onClick: () => { closeModal(); reply({ cancelled: true }); } }]); }
        break;
    }
  }

  function openHistoryModal(sessions, current) {
    appModal.classList.add("wide"); appModal.style.width = "";
    modalHeader("会话历史", "点击卡片在对话窗口打开");
    const body = document.createElement("div"); body.className = "modal-body";
    if (!sessions || sessions.length === 0) {
      const e = document.createElement("div"); e.className = "hist-empty"; e.textContent = "当前项目没有 pi 历史会话。"; body.appendChild(e);
    } else {
      sessions.forEach((s) => {
        const card = document.createElement("div");
        card.className = "hist-card" + (s.file && s.file === current ? " current" : "");
        const row1 = document.createElement("div"); row1.className = "h-row1";
        const title = document.createElement("span"); title.className = "h-title"; title.textContent = s.title;
        row1.appendChild(title);
        if (s.file && s.file === current) { const badge = document.createElement("span"); badge.className = "h-badge"; badge.textContent = "当前"; row1.appendChild(badge); }
        const time = document.createElement("span"); time.className = "h-time"; time.textContent = relTime(s.mtime); row1.appendChild(time);
        card.appendChild(row1);
        const all = s.userTexts || [];
        const head = all.slice(0, 3);
        const tailStart = Math.max(3, all.length - 3);
        const tail = all.length > 3 ? all.slice(tailStart) : [];
        const omitted = all.length - head.length - tail.length;
        head.forEach((t) => { const mv = document.createElement("div"); mv.className = "h-msg"; mv.textContent = "我：" + (t || "(无内容)"); card.appendChild(mv); });
        if (omitted > 0) { const gap = document.createElement("div"); gap.className = "h-msg"; gap.style.opacity = "0.45"; gap.style.fontSize = "0.82em"; gap.style.webkitLineClamp = "1"; gap.textContent = "…（" + omitted + " 条省略）"; card.appendChild(gap); }
        tail.forEach((t) => { const mv = document.createElement("div"); mv.className = "h-msg"; mv.textContent = "我：" + (t || "(无内容)"); card.appendChild(mv); });
        card.addEventListener("click", () => { closeModal(); vscode.postMessage({ type: "app:openHistory", file: s.file }); });
        body.appendChild(card);
      });
    }
    appModal.appendChild(body);
    modalFooter([{ label: "关闭", secondary: true, onClick: closeModal }]);
  }
  function relTime(mtime) {
    if (!mtime) return "";
    const diff = Math.max(0, Date.now() - mtime);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return "刚刚";
    const min = Math.floor(sec / 60); if (min < 60) return min + " 分钟前";
    const hr = Math.floor(min / 60); if (hr < 24) return hr + " 小时前";
    const day = Math.floor(hr / 24); if (day < 30) return day + " 天前";
    return new Date(mtime).toLocaleDateString();
  }

  let settingsDispatch = null;

  function openSettingsModal() {
    appModal.classList.add("wide"); appModal.style.width = ""; appModal.style.height = "min(86vh, 780px)";
    const container = document.createElement("div");
    container.className = "ms-root";
    container.style.flex = "1";
    container.style.minHeight = "0";
    appModal.appendChild(container);
    const inst = window.mountSettings(container, {
      send: (type, payload) => {
        if (type === "save") vscode.postMessage({ type: "app:saveSettings", content: payload.content });
        else if (type === "getDefault") vscode.postMessage({ type: "app:getDefaultModels" });
        else vscode.postMessage({ type: "app:requestSettings" }); // ready | reload
      },
      on: (h) => { settingsDispatch = h; },
      onClose: closeModal,
    });
    appOverlay.classList.remove("hidden");
    inst.requestInitial();
  }

  function openViewOptionsModal() {
    appModal.style.width = "min(440px, 92vw)";
    modalHeader("显示选项", "即时生效");
    const body = document.createElement("div"); body.className = "modal-body";
    const labelMap = { "enter":"Enter", "shift+enter":"Shift+Enter", "alt+enter":"Alt+Enter", "ctrl+enter":"Ctrl+Enter" };
    function row(label, desc, on, onClick) {
      const r = document.createElement("div"); r.className = "opt-row";
      r.innerHTML = '<span class="opt-check">' + (on ? "✓" : "○") + '</span><span class="opt-label">' + esc(label) + '</span><span class="opt-desc">' + esc(desc) + '</span>';
      r.addEventListener("click", onClick); return r;
    }
    const build = () => {
      body.innerHTML = "";
      body.appendChild(row("状态栏", "token / 上下文状态栏", viewOptions.showStatsBar, () => vscode.postMessage({ type: "app:toggleViewOption", key: "showStatsBar" })));
      body.appendChild(row("启动时自动打开最近会话", "进入界面时加载当前项目最近一次会话", viewOptions.autoLoadLastSession, () => vscode.postMessage({ type: "app:toggleViewOption", key: "autoLoadLastSession" })));
      const o3 = document.createElement("div"); o3.className = "opt-row";
      o3.innerHTML = '<span class="opt-check">⌨</span><span class="opt-label">发送键：' + labelMap[viewOptions.sendKey] + '</span><span class="opt-desc">点击切换</span>';
      o3.addEventListener("click", () => vscode.postMessage({ type: "app:cycleSendKey" }));
      body.appendChild(o3);
    };
    appModal.appendChild(body);
    modalFooter([{ label: "关闭", secondary: true, onClick: closeModal }]);
    build();
  }

  document.getElementById("historyBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "app:requestHistory" });
    appModal.style.width = ""; appModal.classList.add("wide");
    modalHeader("会话历史");
    const body = document.createElement("div"); body.className = "modal-body"; body.innerHTML = '<div class="hist-empty">加载中…</div>';
    appModal.appendChild(body); appOverlay.classList.remove("hidden");
  });
  document.getElementById("settingsBtn").addEventListener("click", () => { openModal(openSettingsModal); });
  document.getElementById("viewOptsBtn").addEventListener("click", () => { openModal(openViewOptionsModal); });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "app:projects": recentProjects = msg.projects || []; if (!projectMenu.classList.contains("hidden")) renderProjectMenu(); break;
      case "app:currentProject": currentProjectPath = msg.path || ""; projectName.textContent = msg.name || "未选择项目"; break;
      case "app:requestPickProject": vscode.postMessage({ type: "app:pickProject" }); break;
      case "modal": openModal(() => handleModal(msg)); break;
      case "app:history": openModal(() => openHistoryModal(msg.sessions, msg.current)); break;
      case "app:settings": if (settingsDispatch) settingsDispatch({ type: "load", content: msg.content, existed: msg.existed, path: msg.path }); break;
      case "app:settingsResult": if (settingsDispatch) settingsDispatch(msg.ok ? { type: "saved" } : { type: "error", error: msg.error }); break;
      case "app:defaultModels": if (settingsDispatch) settingsDispatch({ type: "default", content: msg.content }); break;
      case "viewOptions":
        viewOptions = { showStatsBar: msg.showStatsBar, autoLoadLastSession: msg.autoLoadLastSession, sendKey: msg.sendKey };
        if (!appOverlay.classList.contains("hidden") && appModal.querySelector(".opt-row")) { closeModal(); openModal(openViewOptionsModal); }
        break;
    }
  });
})();

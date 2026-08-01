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
  let viewOptions = { showStatsBar: true, autoLoadLastSession: false, sendKey: "enter", notifyOnTurnEnd: true };

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
  function closeModal() { appOverlay.classList.add("hidden"); appModal.innerHTML = ""; appModal.classList.remove("wide"); appModal.style.width = ""; appModal.style.height = ""; }
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
    }
  }

  document.getElementById("historyBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "app:requestHistory" });
  });
  document.getElementById("settingsBtn").addEventListener("click", () => { if (window.__piOpenSettings) window.__piOpenSettings(); });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "app:projects": recentProjects = msg.projects || []; if (!projectMenu.classList.contains("hidden")) renderProjectMenu(); break;
      case "app:currentProject": currentProjectPath = msg.path || ""; projectName.textContent = msg.name || "未选择项目"; break;
      case "app:requestPickProject": vscode.postMessage({ type: "app:pickProject" }); break;
      case "modal": openModal(() => handleModal(msg)); break;
      case "viewOptions":
        viewOptions = { showStatsBar: msg.showStatsBar, autoLoadLastSession: msg.autoLoadLastSession, sendKey: msg.sendKey, notifyOnTurnEnd: msg.notifyOnTurnEnd };
        break;
    }
  });
})();

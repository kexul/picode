// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  const listPane = document.getElementById("listPane");
  const editPane = document.getElementById("editPane");
  const placeholder = document.getElementById("placeholder");
  const hookNameEl = document.getElementById("hookName");
  const editorEl = document.getElementById("editor");
  const statusEl = document.getElementById("status");
  const dirEl = document.getElementById("dir");

  const saveBtn = document.getElementById("saveBtn");
  const deleteBtn = document.getElementById("deleteBtn");
  const refreshBtn = document.getElementById("refreshBtn");
  const newBlankBtn = document.getElementById("newBlankBtn");
  const newConfirmDeleteBtn = document.getElementById("newConfirmDeleteBtn");
  const newLoadRulesBtn = document.getElementById("newLoadRulesBtn");

  let currentName = null; // 正在编辑的现有文件名（含 .ts）；新建时为 null
  let hooks = [];

  function setStatus(text, cls) {
    statusEl.textContent = text || "";
    statusEl.className = cls || "";
  }

  function showEditor(show) {
    if (show) {
      editPane.classList.remove("hidden");
      placeholder.classList.add("hidden");
    } else {
      editPane.classList.add("hidden");
      placeholder.classList.remove("hidden");
    }
  }

  function renderList() {
    listPane.innerHTML = "";
    if (!hooks || hooks.length === 0) {
      const empty = document.createElement("div");
      empty.id = "empty";
      empty.textContent = "还没有任何 hook。点击上方按钮新建一个。";
      listPane.appendChild(empty);
      return;
    }
    hooks.forEach((h) => {
      const item = document.createElement("div");
      item.className = "hook-item" + (h.name === currentName ? " active" : "");
      const name = document.createElement("div");
      name.className = "name";
      name.appendChild(document.createTextNode(h.name));
      if (h.managed) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "管理";
        name.appendChild(badge);
      }
      item.appendChild(name);
      if (h.description) {
        const desc = document.createElement("div");
        desc.className = "desc";
        desc.textContent = h.description;
        item.appendChild(desc);
      }
      item.addEventListener("click", () => {
        vscode.postMessage({ type: "open", name: h.name });
      });
      listPane.appendChild(item);
    });
  }

  saveBtn.addEventListener("click", () => {
    const name = hookNameEl.value.trim();
    if (!name) {
      setStatus("请填写 hook 名称。", "err");
      return;
    }
    vscode.postMessage({ type: "save", name, content: editorEl.value });
  });

  deleteBtn.addEventListener("click", () => {
    if (!currentName) {
      setStatus("这是尚未保存的新 hook，无需删除。", "warn");
      return;
    }
    vscode.postMessage({ type: "delete", name: currentName });
  });

  refreshBtn.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  newBlankBtn.addEventListener("click", () => vscode.postMessage({ type: "newBlank" }));
  newConfirmDeleteBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "newConfirmDelete" })
  );
  newLoadRulesBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "newLoadRules" })
  );

  // Tab 键插入两个空格
  editorEl.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = editorEl.selectionStart;
      const eEnd = editorEl.selectionEnd;
      editorEl.value = editorEl.value.slice(0, s) + "  " + editorEl.value.slice(eEnd);
      editorEl.selectionStart = editorEl.selectionEnd = s + 2;
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "list":
        hooks = msg.hooks || [];
        dirEl.textContent = msg.dir || "";
        dirEl.title = msg.dir || "";
        renderList();
        break;
      case "openHook":
        currentName = msg.name || null;
        hookNameEl.value = (msg.name || "").replace(/\.ts$/, "");
        editorEl.value = msg.content || "";
        deleteBtn.style.display = currentName ? "" : "none";
        showEditor(true);
        setStatus(currentName ? "已加载 " + msg.name : "新建 hook，填写名称后保存。", "");
        renderList();
        break;
      case "saved":
        currentName = msg.name.endsWith(".ts") ? msg.name : msg.name + ".ts";
        deleteBtn.style.display = "";
        setStatus("已保存。在 pi 中执行 /reload 使其生效。", "ok");
        break;
      case "opError":
        setStatus(msg.error || "操作失败", "err");
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();

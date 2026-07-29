// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  const editor = document.getElementById("editor");
  const saveBtn = document.getElementById("saveBtn");
  const formatBtn = document.getElementById("formatBtn");
  const resetBtn = document.getElementById("resetBtn");
  const reloadBtn = document.getElementById("reloadBtn");
  const statusEl = document.getElementById("status");
  const pathEl = document.getElementById("path");

  let dirty = false;

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = kind || "";
  }

  function markDirty(on) {
    dirty = on;
    saveBtn.disabled = !on;
    saveBtn.textContent = on ? "保存 *" : "保存";
  }

  // 实时 JSON 校验
  function validate() {
    const text = editor.value;
    if (!text.trim()) {
      setStatus("内容为空", "warn");
      return false;
    }
    try {
      JSON.parse(text);
      setStatus("JSON 合法 ✓", "ok");
      return true;
    } catch (e) {
      setStatus("JSON 错误: " + e.message, "err");
      return false;
    }
  }

  editor.addEventListener("input", () => {
    markDirty(true);
    validate();
  });

  // Tab 键插入两个空格而不是切换焦点
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = editor.selectionStart;
      const en = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + "  " + editor.value.slice(en);
      editor.selectionStart = editor.selectionEnd = s + 2;
      markDirty(true);
    }
    // Ctrl+S 保存
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      save();
    }
  });

  function save() {
    if (!validate()) {
      setStatus("JSON 不合法，无法保存", "err");
      return;
    }
    vscode.postMessage({ type: "save", content: editor.value });
  }

  function format() {
    try {
      const obj = JSON.parse(editor.value);
      const formatted = JSON.stringify(obj, null, 2) + "\n";
      if (formatted === editor.value) {
        setStatus("已是标准格式，无需变更 ✓", "ok");
        return;
      }
      editor.value = formatted;
      markDirty(true);
      setStatus("已格式化 ✓", "ok");
    } catch (e) {
      setStatus("JSON 错误，无法格式化: " + e.message, "err");
    }
  }

  saveBtn.addEventListener("click", save);
  formatBtn.addEventListener("click", format);
  resetBtn.addEventListener("click", () => {
    if (dirty && !confirm("有未保存的修改，恢复默认将丢弃当前内容，确定继续？")) {
      return;
    }
    vscode.postMessage({ type: "getDefault" });
  });
  reloadBtn.addEventListener("click", () => {
    if (dirty && !confirm("有未保存的修改，确定重新加载并丢弃？")) {
      return;
    }
    vscode.postMessage({ type: "reload" });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "load":
        editor.value = msg.content;
        pathEl.textContent = msg.path + (msg.existed ? "" : "（文件不存在，将在保存时创建）");
        markDirty(false);
        validate();
        break;
      case "saved":
        markDirty(false);
        setStatus("已保存 ✓  " + new Date().toLocaleTimeString(), "ok");
        break;
      case "saveError":
        setStatus(msg.error, "err");
        break;
      case "default":
        editor.value = msg.content;
        markDirty(true);
        setStatus("已恢复为默认标准 models（尚未保存，点击保存写入）", "ok");
        validate();
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();

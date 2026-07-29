// @ts-nocheck
/**
 * models.json 结构化配置界面（共用：VSCode 面板 + Electron modal）。
 *
 * 导出 window.mountSettings(root, api)：
 *   root        容器元素（渲染器在其中绘制 整套 UI）
 *   api = {
 *     send(type, payload)   外发消息：'ready' | 'reload' | 'getDefault' | 'save'
 *     on(handler)           注册入站回调：handler({type, content?, existed?, path?, error?})
 *                           type: 'load' | 'default' | 'saved' | 'error'
 *     onClose?()            可选；提供则渲染「关闭」按钮（Electron 用，VSCode 不传）
 *   }
 *   返回 { requestInitial() }
 *
 * 交换的数据仍是 models.json 的 JSON 字符串（后端读写协议不变）。
 */
(function () {
  "use strict";

  var API_OPTIONS = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ];

  // ── 极简 DOM helper ────────────────────────────────────────────────────────
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      var v = props[k];
      if (v == null) continue;
      if (k === "style" && typeof v === "object") Object.assign(n.style, v);
      else if (k === "class") n.className = v;
      else if (k === "attrs") for (var a in v) n.setAttribute(a, v[a]);
      else if (k.indexOf("on") === 0 && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
      else n[k] = v;
    }
    if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ── 样式（一次性注入） ────────────────────────────────────────────────────
  var STYLE_ID = "ms-settings-style";
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = [
      ".ms-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}",
      ".ms-header{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}",
      ".ms-title{font-size:14px;font-weight:700}",
      ".ms-sub{font-size:11px;opacity:.6;font-family:var(--vscode-editor-font-family,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ms-spacer{flex:1}",
      ".ms-modeToggle{display:flex;align-items:center;gap:6px;font-size:12px;opacity:.8;cursor:pointer;user-select:none}",
      ".ms-modeToggle input{accent-color:var(--vscode-button-background)}",
      ".ms-body{flex:1;display:flex;min-height:0}",
      ".ms-tree{width:214px;flex-shrink:0;border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;background:var(--vscode-editorWidget-background,var(--vscode-editor-background))}",
      ".ms-tree-list{flex:1;overflow-y:auto;padding:6px}",
      ".ms-tree-prov{margin-bottom:2px}",
      ".ms-row{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:5px;cursor:pointer}",
      ".ms-row:hover{background:var(--vscode-list-hoverBackground)}",
      ".ms-row.sel{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}",
      ".ms-row .ms-ico{flex-shrink:0;opacity:.7;display:flex;align-items:center}",
      ".ms-row .ms-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}",
      ".ms-row .ms-mon{font-family:var(--vscode-editor-font-family,monospace)}",
      ".ms-row.model{padding-left:24px}",
      ".ms-row.model .ms-name{font-size:11px;opacity:.85}",
      ".ms-badge{font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(99,102,241,.15);color:rgba(99,102,241,.9);flex-shrink:0}",
      ".ms-treeAdd{display:flex;align-items:center;gap:5px;padding:5px 8px 5px 24px;border-radius:5px;cursor:pointer;color:var(--vscode-descriptionForeground);font-size:11px}",
      ".ms-treeAdd:hover{color:var(--vscode-button-background);background:var(--vscode-list-hoverBackground)}",
      ".ms-tree-foot{border-top:1px solid var(--vscode-panel-border);padding:8px 6px}",
      ".ms-addProv{width:100%;padding:6px 0;background:none;border:1px dashed var(--vscode-panel-border);border-radius:5px;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:12px}",
      ".ms-addProv:hover{border-color:var(--vscode-focusBorder);color:var(--vscode-foreground)}",
      ".ms-detail{flex:1;overflow-y:auto;padding:18px;min-width:0}",
      ".ms-empty{height:100%;display:flex;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);font-size:13px}",
      ".ms-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:10px}",
      ".ms-secTitle{font-size:11px;font-weight:600;opacity:.65;text-transform:uppercase;letter-spacing:.06em}",
      ".ms-field{display:flex;flex-direction:column;gap:4px}",
      ".ms-label{font-size:11px;opacity:.7;font-weight:500}",
      ".ms-input{padding:6px 9px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:5px;font-size:12px;outline:none;width:100%;box-sizing:border-box;font-family:inherit}",
      ".ms-input:focus{border-color:var(--vscode-focusBorder)}",
      ".ms-input.mono{font-family:var(--vscode-editor-font-family,monospace)}",
      ".ms-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      ".ms-grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}",
      ".ms-stack{display:flex;flex-direction:column;gap:14px}",
      ".ms-checks{display:flex;gap:18px;flex-wrap:wrap}",
      ".ms-check{display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;opacity:.85}",
      ".ms-check input{accent-color:var(--vscode-button-background)}",
      ".ms-secret{position:relative;width:100%;box-sizing:border-box}",
      ".ms-secret .ms-input{padding-right:32px}",
      ".ms-eye{position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;padding:4px;display:flex}",
      ".ms-btn{padding:5px 12px;border:none;border-radius:5px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font-size:12px}",
      ".ms-btn:hover{background:var(--vscode-button-hoverBackground,var(--vscode-button-background))}",
      ".ms-btn.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}",
      ".ms-btn.sec:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-button-secondaryBackground))}",
      ".ms-btn.danger{background:none;border:1px solid rgba(239,68,68,.35);color:#ef4444}",
      ".ms-btn:disabled{opacity:.5;cursor:default}",
      ".ms-split{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".ms-kv{display:flex;flex-direction:column;gap:6px}",
      ".ms-kv-row{display:flex;gap:6px;align-items:center}",
      ".ms-kv-row .ms-input{flex:1;min-width:0}",
      ".ms-hint{font-size:10px;opacity:.55}",
      ".ms-divider{border-top:1px solid var(--vscode-panel-border);padding-top:14px}",
      ".ms-footer{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--vscode-panel-border);flex-shrink:0}",
      ".ms-status{font-size:12px;opacity:.8;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ms-status.ok{color:var(--vscode-testing-iconPassed);opacity:1}",
      ".ms-status.err{color:var(--vscode-errorForeground);opacity:1}",
      ".ms-rawWrap{flex:1;display:flex;min-height:0}",
      ".ms-raw{flex:1;margin:14px;width:auto;box-sizing:border-box;resize:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:5px;padding:10px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;tab-size:2;outline:none}",
      ".ms-raw:focus{border-color:var(--vscode-focusBorder)}",
    ].join("");
    document.head.appendChild(s);
  }

  // ── 图标（内联 svg） ───────────────────────────────────────────────────────
  var ICON_PROVIDER =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>';
  var ICON_EYE =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var ICON_EYE_OFF =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12A3 3 0 0 1 9.88 9.88"/><path d="M1 1l22 22"/></svg>';
  var ICON_PLUS =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  // ── 主渲染器 ───────────────────────────────────────────────────────────────
  function mountSettings(root, api) {
    injectStyle();

    var state = {
      config: { providers: {} },
      path: "",
      existed: true,
      mode: "form",          // 'form' | 'raw'
      dirty: false,
      selection: null,       // {type:'provider',name} | {type:'model',providerName,index}
      parseError: null,
      rawText: "",
      renameDraft: null,     // 当前 provider 的重命名草稿
    };

    var dom = {};
    var treeRowRefs = new WeakMap(); // model/provider 对象 → 对应树行 .ms-name 元素

    // ── 入站 ────────────────────────────────────────────────────────────────
    api.on(function (msg) {
      switch (msg.type) {
        case "load": onLoad(msg.content, msg.existed, msg.path); break;
        case "default": applyDefault(msg.content); break;
        case "saved": state.dirty = false; refreshDirty(); setStatus("已保存 ✓  " + new Date().toLocaleTimeString(), "ok"); break;
        case "error": setStatus(msg.error || "保存失败", "err"); break;
      }
    });

    function onLoad(content, existed, path) {
      state.path = path || state.path;
      state.existed = !!existed;
      try {
        var obj = JSON.parse(content);
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("根对象须为对象");
        if (!obj.providers || typeof obj.providers !== "object") obj.providers = {};
        state.config = obj;
        state.parseError = null;
        if (!state.selection) {
          var keys = Object.keys(obj.providers);
          if (keys.length) state.selection = { type: "provider", name: keys[0] };
        }
        renderBody();
      } catch (e) {
        state.parseError = e.message;
        state.rawText = content;
        state.mode = "raw";
        renderBody();
      }
      state.dirty = false;
      refreshDirty();
      updateSub();
      if (!state.parseError) setStatus(state.existed ? "JSON 合法 ✓" : "文件不存在，将在保存时创建", state.existed ? "ok" : "");
      else setStatus("JSON 解析失败，已切换到原始模式：" + state.parseError, "err");
    }

    function applyDefault(content) {
      try {
        var obj = JSON.parse(content);
        if (!obj.providers) obj.providers = {};
        state.config = obj;
        state.parseError = null;
        state.mode = "form";
        var keys = Object.keys(obj.providers);
        state.selection = keys.length ? { type: "provider", name: keys[0] } : null;
        state.dirty = true;
        renderBody();
        refreshDirty();
        updateSub();
        setStatus("已恢复默认 models（尚未保存，点击保存写入）", "ok");
      } catch (e) {
        setStatus("默认模板解析失败：" + e.message, "err");
      }
    }

    // ── 外发 ────────────────────────────────────────────────────────────────
    function requestInitial() { api.send("ready"); }
    function doReload() { if (!confirmIfDirty("重新加载将丢弃当前修改，确定？")) return; api.send("reload"); }
    function doGetDefault() { if (!confirmIfDirty("恢复默认将丢弃当前修改，确定？")) return; api.send("getDefault"); }

    function confirmIfDirty(text) { return !state.dirty || confirm(text); }

    function serialize() { return JSON.stringify(state.config, null, 2) + "\n"; }

    function doSave() {
      if (state.mode === "raw") {
        var text = dom.rawArea.value;
        try { JSON.parse(text); } catch (e) { setStatus("JSON 错误：" + e.message, "err"); return; }
        setStatus("保存中…", ""); api.send("save", { content: text }); return;
      }
      // 校验 provider 名
      var names = Object.keys(state.config.providers);
      for (var i = 0; i < names.length; i++) {
        if (!names[i].trim()) { setStatus("存在未命名的 provider，请先填写名称", "err"); return; }
      }
      var content;
      try { content = serialize(); } catch (e) { setStatus("序列化失败：" + e.message, "err"); return; }
      setStatus("保存中…", ""); api.send("save", { content: content });
    }

    // ── 脏状态 ───────────────────────────────────────────────────────────────
    function markDirty() { if (!state.dirty) { state.dirty = true; refreshDirty(); } }
    function refreshDirty() {
      if (dom.saveBtn) {
        dom.saveBtn.disabled = false;
        dom.saveBtn.textContent = state.dirty ? "保存 *" : "保存";
      }
    }
    function setStatus(text, kind) { if (dom.status) { dom.status.textContent = text || ""; dom.status.className = "ms-status" + (kind ? " " + kind : ""); } }
    function updateSub() { if (dom.sub) dom.sub.textContent = state.path + (state.existed ? "" : "（不存在）"); }

    // ── provider / model 操作（就地改动 live 对象，保留未知字段） ──────────
    function providers() { return state.config.providers; }

    function addProvider() {
      var base = "new-provider", name = base, n = 1;
      while (providers()[name]) name = base + "-" + (n++);
      providers()[name] = { api: "openai-completions" };
      state.selection = { type: "provider", name: name };
      state.renameDraft = name;
      markDirty(); reRender();
    }
    function renameProvider(oldName, newName) {
      if (!newName || !newName.trim()) return;
      newName = newName.trim();
      if (newName === oldName) return;
      if (providers()[newName]) { setStatus("已存在同名 provider：" + newName, "err"); return; }
      var entries = Object.entries(providers());
      var idx = entries.findIndex(function (e) { return e[0] === oldName; });
      if (idx === -1) return;
      entries[idx] = [newName, entries[idx][1]];
      state.config.providers = Object.fromEntries(entries);
      if (state.selection && state.selection.type === "provider" && state.selection.name === oldName) state.selection.name = newName;
      if (state.selection && state.selection.type === "model" && state.selection.providerName === oldName) state.selection.providerName = newName;
      state.renameDraft = newName;
      markDirty(); reRender();
    }
    function deleteProvider(name) {
      if (!confirm("删除 provider「" + name + "」？此操作在保存前不写入磁盘。")) return;
      delete providers()[name];
      var keys = Object.keys(providers());
      state.selection = keys.length ? { type: "provider", name: keys[0] } : null;
      markDirty(); reRender();
    }
    function addModel(providerName) {
      var p = providers()[providerName]; if (!p) return;
      if (!Array.isArray(p.models)) p.models = [];
      p.models.push({ id: "" });
      state.selection = { type: "model", providerName: providerName, index: p.models.length - 1 };
      markDirty(); reRender();
      // 滚到详情顶部并聚焦 ID
      if (dom.detail) dom.detail.scrollTop = 0;
    }
    function deleteModel(providerName, index) {
      var p = providers()[providerName]; if (!p || !Array.isArray(p.models)) return;
      p.models.splice(index, 1);
      if (p.models.length === 0) delete p.models;
      state.selection = { type: "provider", name: providerName };
      markDirty(); reRender();
    }
    function currentSelectionTarget() {
      var s = state.selection; if (!s) return null;
      if (s.type === "provider") return providers()[s.name] || null;
      if (s.type === "model") { var p = providers()[s.providerName]; return p && Array.isArray(p.models) ? p.models[s.index] : null; }
      return null;
    }

    // ── 渲染骨架 ─────────────────────────────────────────────────────────────
    function build() {
      clear(root);
      root.className = "ms-root";

      var header = el("div", { class: "ms-header" });
      dom.title = el("span", { class: "ms-title" }, "模型配置");
      dom.sub = el("span", { class: "ms-sub" });
      dom.modeToggle = el("label", { class: "ms-modeToggle" }, [
        el("input", { type: "checkbox", checked: state.mode === "raw", onChange: function (e) { switchMode(e.target.checked ? "raw" : "form"); } }),
        el("span", {}, "原始 JSON"),
      ]);
      header.appendChild(dom.title);
      header.appendChild(dom.sub);
      header.appendChild(el("span", { class: "ms-spacer" }));
      header.appendChild(dom.modeToggle);
      root.appendChild(header);

      dom.bodyHost = el("div", { class: "ms-body" });
      root.appendChild(dom.bodyHost);

      var footer = el("div", { class: "ms-footer" });
      dom.status = el("span", { class: "ms-status" });
      footer.appendChild(dom.status);
      dom.resetBtn = el("button", { class: "ms-btn sec", onclick: doGetDefault }, "恢复默认");
      dom.reloadBtn = el("button", { class: "ms-btn sec", onclick: doReload }, "重新加载");
      footer.appendChild(dom.resetBtn);
      footer.appendChild(dom.reloadBtn);
      if (api.onClose) footer.appendChild(el("button", { class: "ms-btn sec", onclick: api.onClose }, "关闭"));
      dom.saveBtn = el("button", { class: "ms-btn", onclick: doSave }, "保存");
      footer.appendChild(dom.saveBtn);
      root.appendChild(footer);

      refreshDirty(); updateSub();
    }

    function renderBody() { if (!dom.bodyHost) return; clear(dom.bodyHost); treeRowRefs = new WeakMap();
      var cb = dom.modeToggle && dom.modeToggle.querySelector("input"); if (cb) cb.checked = (state.mode === "raw");
      if (state.mode === "raw") { renderRaw(); return; }
      var tree = el("div", { class: "ms-tree" });
      var list = el("div", { class: "ms-tree-list" });
      renderTreeInto(list);
      tree.appendChild(list);
      var foot = el("div", { class: "ms-tree-foot" });
      foot.appendChild(el("button", { class: "ms-addProv", onclick: addProvider }, "＋ 添加 Provider"));
      tree.appendChild(foot);
      dom.bodyHost.appendChild(tree);

      dom.detail = el("div", { class: "ms-detail" });
      renderDetailInto(dom.detail);
      dom.bodyHost.appendChild(dom.detail);
    }

    function reRender() { renderBody(); refreshDirty(); }

    function renderRaw() {
      var wrap = el("div", { class: "ms-rawWrap" });
      dom.rawArea = el("textarea", { class: "ms-raw", spellcheck: false, value: state.rawText || serialize(), oninput: function () { markDirty(); setStatus("已修改（原始模式）", ""); } });
      wrap.appendChild(dom.rawArea);
      dom.bodyHost.appendChild(wrap);
      dom.rawArea.addEventListener("keydown", function (e) {
        if (e.key === "Tab") {
          e.preventDefault();
          var s = dom.rawArea.selectionStart, en = dom.rawArea.selectionEnd;
          dom.rawArea.value = dom.rawArea.value.slice(0, s) + "  " + dom.rawArea.value.slice(en);
          dom.rawArea.selectionStart = dom.rawArea.selectionEnd = s + 2;
          markDirty();
        }
        if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); doSave(); }
      });
    }

    function switchMode(mode) {
      if (mode === state.mode) return;
      if (mode === "raw") {
        if (state.parseError) { state.rawText = state.rawText; }
        else { state.rawText = serialize(); }
        state.mode = "raw"; renderBody();
      } else {
        // raw → form：先解析当前文本
        var text = dom.rawArea ? dom.rawArea.value : state.rawText;
        try {
          var obj = JSON.parse(text);
          if (!obj.providers) obj.providers = {};
          state.config = obj; state.parseError = null;
          var keys = Object.keys(obj.providers);
          if (!state.selection || (state.selection.type === "provider" && !providers()[state.selection.name])) {
            state.selection = keys.length ? { type: "provider", name: keys[0] } : null;
          }
          state.mode = "form"; renderBody();
          setStatus("JSON 合法 ✓", "ok");
        } catch (e) {
          setStatus("JSON 错误，无法切换到表单：" + e.message, "err");
          // 复原开关
          dom.modeToggle.querySelector("input").checked = true;
        }
      }
    }

    // ── 左侧树 ───────────────────────────────────────────────────────────────
    function renderTreeInto(list) {
      var names = Object.keys(providers());
      if (names.length === 0) {
        list.appendChild(el("div", { style: { padding: "10px 8px", fontSize: "12px", opacity: ".55" } }, "还没有 provider，点下方添加"));
        return;
      }
      names.forEach(function (pName) {
        var p = providers()[pName];
        var provSel = state.selection && state.selection.type === "provider" && state.selection.name === pName;
        var provRow = el("div", { class: "ms-row" + (provSel ? " sel" : ""), onclick: function () { selectProvider(pName); } });
        var ico = el("span", { class: "ms-ico" }); ico.innerHTML = ICON_PROVIDER;
        var nameEl = el("span", { class: "ms-name ms-mon" }, pName);
        treeRowRefs.set(p, nameEl);
        provRow.appendChild(ico); provRow.appendChild(nameEl);

        var wrap = el("div", { class: "ms-tree-prov" }, provRow);

        var models = Array.isArray(p.models) ? p.models : [];
        models.forEach(function (m, i) {
          var mSel = state.selection && state.selection.type === "model" && state.selection.providerName === pName && state.selection.index === i;
          var mRow = el("div", { class: "ms-row model" + (mSel ? " sel" : ""), onclick: function (e) { e.stopPropagation(); selectModel(pName, i); } });
          var mName = el("span", { class: "ms-name ms-mon" }, (m && m.id) ? m.id : "新模型");
          treeRowRefs.set(m, mName);
          mRow.appendChild(mName);
          if (m && m.reasoning) mRow.appendChild(el("span", { class: "ms-badge" }, "推理"));
          wrap.appendChild(mRow);
        });

        var addRow = el("div", { class: "ms-treeAdd", onclick: function (e) { e.stopPropagation(); addModel(pName); } });
        addRow.appendChild(el("span", {}, "＋ 模型"));
        wrap.appendChild(addRow);

        list.appendChild(wrap);
      });
    }

    function selectProvider(name) { state.selection = { type: "provider", name: name }; state.renameDraft = name; renderBody(); refreshDirty(); }
    function selectModel(providerName, index) { state.selection = { type: "model", providerName: providerName, index: index }; renderBody(); refreshDirty(); }
    function selectRelative(afterDelete) { renderBody(); refreshDirty(); }

    // ── 右侧详情 ─────────────────────────────────────────────────────────────
    function renderDetailInto(host) {
      var s = state.selection;
      if (!s) { host.appendChild(el("div", { class: "ms-empty" }, "在左侧选择或添加一个 provider / model")); return; }
      if (s.type === "provider") { renderProvider(host, s.name); return; }
      if (s.type === "model") {
        var p = providers()[s.providerName];
        var m = p && Array.isArray(p.models) ? p.models[s.index] : null;
        if (!m) { host.appendChild(el("div", { class: "ms-empty" }, "该模型不存在")); return; }
        renderModel(host, s.providerName, m);
      }
    }

    // ── 通用输入 ─────────────────────────────────────────────────────────────
    function field(labelText, child) {
      return el("div", { class: "ms-field" }, [el("label", { class: "ms-label" }, labelText), child]);
    }
    function textInput(get, set, opts) {
      opts = opts || {};
      var inp = el("input", { class: "ms-input" + (opts.mono ? " mono" : ""), type: "text", value: get() || "", placeholder: opts.placeholder || "", oninput: function () { set(inp.value); markDirty(); if (opts.onInput) opts.onInput(inp.value); } });
      return inp;
    }
    function numInput(get, set, opts) {
      opts = opts || {};
      var inp = el("input", { class: "ms-input", type: "number", value: get() == null ? "" : String(get()), placeholder: opts.placeholder || "", oninput: function () { var v = inp.value.trim(); set(v === "" ? undefined : Number(v)); markDirty(); } });
      return inp;
    }
    function selectInput(get, set, options, required) {
      var sel = el("select", { class: "ms-input", onchange: function () { set(sel.value); markDirty(); } });
      if (!required) sel.appendChild(el("option", { value: "" }, "— 默认 / 无 —"));
      options.forEach(function (o) { sel.appendChild(el("option", { value: o }, o)); });
      sel.value = get() || (required ? options[0] : "");
      return sel;
    }
    function check(labelText, get, set) {
      var inp = el("input", { type: "checkbox" });
      inp.checked = !!get();
      inp.addEventListener("change", function () { set(inp.checked); markDirty(); });
      return el("label", { class: "ms-check" }, [inp, el("span", {}, labelText)]);
    }
    function secretInput(get, set, opts) {
      opts = opts || {};
      var wrap = el("div", { class: "ms-secret" });
      var inp = el("input", { class: "ms-input" + (opts.mono ? " mono" : ""), type: "password", value: get() || "", placeholder: opts.placeholder || "", oninput: function () { set(inp.value || undefined); markDirty(); } });
      var eye = el("button", { type: "button", class: "ms-eye", onclick: function () { inp.type = inp.type === "password" ? "text" : "password"; } });
      eye.innerHTML = ICON_EYE;
      wrap.appendChild(inp); wrap.appendChild(eye);
      return wrap;
    }

    // ── provider 详情 ────────────────────────────────────────────────────────
    function renderProvider(host, name) {
      var p = providers()[name];
      if (!p) { host.appendChild(el("div", { class: "ms-empty" }, "该 provider 不存在")); return; }
      if (state.renameDraft == null) state.renameDraft = name;
      var editingName = state.renameDraft;

      var stack = el("div", { class: "ms-stack" });

      // 头部
      var toolbar = el("div", { class: "ms-toolbar" });
      toolbar.appendChild(el("div", { class: "ms-secTitle" }, "Provider"));
      var delBtn = el("button", { class: "ms-btn danger", onclick: function () { deleteProvider(name); } }, "删除");
      toolbar.appendChild(delBtn);
      stack.appendChild(toolbar);

      // 名称（可重命名）
      var nameInp = el("input", { class: "ms-input mono", type: "text", value: editingName, placeholder: "provider-name", oninput: function () { state.renameDraft = nameInp.value; renameBtn.style.display = (nameInp.value && nameInp.value.trim() && nameInp.value !== name) ? "" : "none"; } });
      var renameBtn = el("button", { class: "ms-btn", style: { marginTop: "4px", alignSelf: "flex-start", display: (editingName && editingName !== name) ? "" : "none" }, onclick: function () { renameProvider(name, state.renameDraft); } }, "重命名");
      var nameField = el("div", { class: "ms-field" }, [el("label", { class: "ms-label" }, "名称"), nameInp, renameBtn]);
      stack.appendChild(nameField);

      stack.appendChild(field("Base URL", textInput(function () { return p.baseUrl; }, function (v) { p.baseUrl = v || undefined; }, { mono: true, placeholder: "https://api.example.com/v1" })));

      var apiField = field("API Key", secretInput(function () { return p.apiKey; }, function (v) { p.apiKey = v; }, { mono: true, placeholder: "ENV_VAR_NAME、!shell-command 或字面量密钥" }));
      apiField.appendChild(el("span", { class: "ms-hint" }, "以 ! 前缀执行 shell 命令，或填环境变量名"));
      stack.appendChild(apiField);

      stack.appendChild(field("API", selectInput(function () { return p.api || "openai-completions"; }, function (v) { p.api = v || "openai-completions"; }, API_OPTIONS, true)));

      // compat 键值对
      stack.appendChild(renderCompat(p));

      host.appendChild(stack);
    }

    function renderCompat(owner) {
      var wrap = el("div", { class: "ms-field" });
      wrap.appendChild(el("label", { class: "ms-label" }, "compat（兼容性开关）"));
      var kv = el("div", { class: "ms-kv" });
      var comp = owner.compat && typeof owner.compat === "object" ? owner.compat : null;

      function renderRows() {
        clear(kv);
        if (!comp) {
          kv.appendChild(el("div", { class: "ms-hint" }, "无 compat 配置"));
        } else {
          Object.keys(comp).forEach(function (key) {
            var val = comp[key];
            var isBool = typeof val === "boolean";
            var row = el("div", { class: "ms-kv-row" });
            var keyInp = el("input", { class: "ms-input mono", type: "text", value: key, oninput: function () {
              var nk = keyInp.value; if (nk === key) return;
              var v = comp[key]; delete comp[key]; comp[nk] = v; key = nk; markDirty();
            } });
            var valInp;
            if (isBool) {
              valInp = el("input", { type: "checkbox", checked: val, onchange: function () { comp[key] = valInp.checked; markDirty(); } });
              valInp.title = "布尔值";
            } else {
              valInp = el("input", { class: "ms-input mono", type: "text", value: String(val), oninput: function () { comp[key] = coerceVal(valInp.value); markDirty(); } });
              valInp.style.flex = "1";
            }
            var rm = el("button", { class: "ms-btn danger", onclick: function () { delete comp[key]; if (Object.keys(comp).length === 0) { delete owner.compat; comp = null; } markDirty(); renderRows(); } }, "×");
            rm.style.minWidth = "28px";
            row.appendChild(keyInp); row.appendChild(el("span", { style: { flex: isBool ? "0 0 auto" : "1", display: "flex", alignItems: "center" } }, valInp)); row.appendChild(rm);
            kv.appendChild(row);
          });
        }
        var addBtn = el("button", { class: "ms-btn sec", style: { alignSelf: "flex-start", marginTop: "4px" }, onclick: function () {
          if (!comp) { comp = {}; owner.compat = comp; }
          var base = "supportsDeveloperRole", nk = base, n = 1;
          while (nk in comp) nk = base + "-" + (n++);
          comp[nk] = false; markDirty(); renderRows();
        } }, "＋ 添加项");
        kv.appendChild(addBtn);
      }
      renderRows();
      wrap.appendChild(kv);
      return wrap;
    }
    function coerceVal(s) { var t = s.trim(); if (t === "true") return true; if (t === "false") return false; if (t === "null") return null; if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t); return s; }

    // ── model 详情 ───────────────────────────────────────────────────────────
    function renderModel(host, providerName, m) {
      var stack = el("div", { class: "ms-stack" });
      var toolbar = el("div", { class: "ms-toolbar" });
      toolbar.appendChild(el("div", { class: "ms-secTitle" }, "Model"));
      toolbar.appendChild(el("button", { class: "ms-btn danger", onclick: function () { deleteModel(providerName, state.selection.index); } }, "删除模型"));
      stack.appendChild(toolbar);

      var idInp = textInput(function () { return m.id; }, function (v) { m.id = v; }, { mono: true, placeholder: "model-id", onInput: function (v) { var nm = treeRowRefs.get(m); if (nm) nm.textContent = v || "新模型"; } });
      stack.appendChild(field("ID *", idInp));
      stack.appendChild(field("显示名 Name", textInput(function () { return m.name; }, function (v) { m.name = v || undefined; }, { placeholder: "展示名（可留空）" })));

      stack.appendChild(field("API 覆盖（可选）", selectInput(function () { return m.api; }, function (v) { if (v) m.api = v; else delete m.api; }, API_OPTIONS, false)));

      // 输入类型
      var inputs = Array.isArray(m.input) ? m.input.slice() : [];
      var hasImg = inputs.indexOf("image") !== -1;
      var hasText = inputs.indexOf("text") !== -1 || inputs.length === 0;
      var checks = el("div", { class: "ms-checks" });
      checks.appendChild(buildInputCheck("文本", hasText, function (on) { fixInput(m, "text", on); markDirty(); }));
      checks.appendChild(buildInputCheck("图片", hasImg, function (on) { fixInput(m, "image", on); markDirty(); }));
      stack.appendChild(el("div", { class: "ms-field" }, [el("label", { class: "ms-label" }, "输入类型"), checks]));

      var capChecks = el("div", { class: "ms-checks" });
      capChecks.appendChild(check("推理 / thinking (reasoning)", function () { return !!m.reasoning; }, function (on) { if (on) m.reasoning = true; else delete m.reasoning; reRender(); }));
      stack.appendChild(el("div", { class: "ms-field" }, [el("label", { class: "ms-label" }, "能力"), capChecks]));

      var grid2 = el("div", { class: "ms-grid2" });
      grid2.appendChild(field("上下文窗口 (tokens)", numInput(function () { return m.contextWindow; }, function (v) { if (v == null) delete m.contextWindow; else m.contextWindow = v; }, { placeholder: "128000" })));
      grid2.appendChild(field("最大输出 (tokens)", numInput(function () { return m.maxTokens; }, function (v) { if (v == null) delete m.maxTokens; else m.maxTokens = v; }, { placeholder: "16384" })));
      stack.appendChild(grid2);

      // cost
      var costWrap = el("div", { class: "ms-divider" });
      costWrap.appendChild(el("label", { class: "ms-label" }, "Cost（每百万 tokens）"));
      var grid4 = el("div", { class: "ms-grid4", style: { marginTop: "8px" } });
      ["input", "output", "cacheRead", "cacheWrite"].forEach(function (k) {
        grid4.appendChild(el("div", { class: "ms-field" }, [el("label", { class: "ms-label" }, k), numInput(
          function () { return m.cost && m.cost[k]; },
          function (v) { if (!m.cost) m.cost = {}; if (v == null) { delete m.cost[k]; if (Object.keys(m.cost).length === 0) delete m.cost; } else m.cost[k] = v; },
          { placeholder: "0" }
        )]));
      });
      costWrap.appendChild(grid4);
      stack.appendChild(costWrap);

      host.appendChild(stack);
    }
    function buildInputCheck(labelText, on, toggle) {
      var inp = el("input", { type: "checkbox" }); inp.checked = !!on;
      inp.addEventListener("change", function () { toggle(inp.checked); });
      return el("label", { class: "ms-check" }, [inp, el("span", {}, labelText)]);
    }
    function fixInput(m, kind, on) {
      var arr = Array.isArray(m.input) ? m.input.slice() : [];
      var i = arr.indexOf(kind);
      if (on) { if (i === -1) arr.push(kind); }
      else { if (i !== -1) arr.splice(i, 1); }
      // 规整顺序：text 在前
      arr.sort(function (a, b) { return (a === "text" ? 0 : 1) - (b === "text" ? 0 : 1); });
      if (arr.length === 0) delete m.input; else m.input = arr;
    }

    // ── 启动 ─────────────────────────────────────────────────────────────────
    build();
    renderBody();

    return { requestInitial: requestInitial };
  }

  window.mountSettings = mountSettings;

  // ── VSCode 独立面板自动初始化 ───────────────────────────────────────────────
  if (typeof acquireVsCodeApi === "function" && document.getElementById("settingsRoot")) {
    var vscode = acquireVsCodeApi();
    var rootEl = document.getElementById("settingsRoot");
    var instance = mountSettings(rootEl, {
      send: function (type, payload) { vscode.postMessage(Object.assign({ type: type }, payload || {})); },
      on: function (handler) {
        window.addEventListener("message", function (e) {
          var m = e.data; if (!m || !m.type) return;
          if (m.type === "load") handler({ type: "load", content: m.content, existed: m.existed, path: m.path });
          else if (m.type === "default") handler({ type: "default", content: m.content });
          else if (m.type === "saved") handler({ type: "saved" });
          else if (m.type === "saveError") handler({ type: "error", error: m.error });
        });
      },
    });
    instance.requestInitial();
  }
})();

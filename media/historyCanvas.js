/* global acquireVsCodeApi, marked */
(function () {
  const vscode = acquireVsCodeApi();

  const NODE_W = 420;
  const H_GAP = 48;
  const V_GAP = 28;
  const FAMILY_GAP = 120;
  const COLLAPSE_LINES = 40;

  const viewport = document.getElementById("viewport");
  const world = document.getElementById("world");
  const edgesSvg = document.getElementById("edges");
  const nodesEl = document.getElementById("nodes");
  const emptyEl = document.getElementById("empty");
  const tbMeta = document.getElementById("tbMeta");
  const btnFit = document.getElementById("btnFit");
  const btnRefresh = document.getElementById("btnRefresh");
  const btnLoadMore = document.getElementById("btnLoadMore");

  /** @type {{ families: any[], totalFamilies: number, loadedFamilies: number, focus: any }} */
  let state = {
    families: [],
    totalFamilies: 0,
    loadedFamilies: 0,
    focus: null,
  };

  let panX = 40;
  let panY = 40;
  let scale = 1;
  let panning = false;
  let panMoved = false;
  let panCapture = false;
  let lastX = 0;
  let lastY = 0;

  // ---- markdown ----
  let markedReady = false;
  function ensureMarked() {
    if (markedReady || typeof marked === "undefined") { return; }
    markedReady = true;
    try {
      const bundle = globalThis.hljsBundle || {};
      const hljs = bundle.hljs;
      const markedHighlight = bundle.markedHighlight;
      if (hljs && markedHighlight) {
        marked.use(markedHighlight({
          langPrefix: "hljs language-",
          highlight(code, lang) {
            const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
            try { return hljs.highlight(code, { language }).value; } catch { return code; }
          },
        }));
      }
    } catch { /* ignore */ }
  }
  function renderMarkdown(src) {
    ensureMarked();
    if (typeof marked === "undefined") {
      const d = document.createElement("div");
      d.textContent = src || "";
      return d.innerHTML;
    }
    try { return marked.parse(src || "", { breaks: true, gfm: true }); }
    catch {
      const d = document.createElement("div");
      d.textContent = src || "";
      return d.innerHTML;
    }
  }

  function applyTransform() {
    world.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + scale + ")";
  }

  function setMeta() {
    if (!state.families.length) {
      tbMeta.textContent = "";
      return;
    }
    tbMeta.textContent =
      "已加载 " + state.loadedFamilies + " / " + state.totalFamilies + " 个家族 · 双击节点打开会话 · 滚轮缩放 · 拖拽平移";
  }

  function updateLoadMore() {
    const more = state.loadedFamilies < state.totalFamilies;
    btnLoadMore.classList.toggle("hidden", !more);
    btnLoadMore.disabled = false;
    if (more) {
      btnLoadMore.textContent =
        "加载更多（剩余 " + (state.totalFamilies - state.loadedFamilies) + "）";
    }
  }

  function normFile(p) {
    if (!p) { return ""; }
    return String(p).replace(/\\/g, "/").toLowerCase().replace(/^[a-z]:/, "");
  }

  function resolveFile(msg, family, highlightFile) {
    const files = msg.files || [];
    if (!files.length) { return null; }
    if (highlightFile) {
      const t = normFile(highlightFile);
      const hit = files.find((f) => normFile(f) === t);
      if (hit) { return hit; }
    }
    const sessions = family.sessions || [];
    const byNorm = new Map(sessions.map((s) => [normFile(s.file), s]));
    let best = null;
    for (const f of files) {
      const s = byNorm.get(normFile(f));
      if (!s) { continue; }
      if (!best || String(s.timestamp) > String(best.timestamp)) { best = s; }
    }
    return best ? best.file : files[files.length - 1];
  }

  function pathSetFromLeaf(byId, leafId) {
    const set = new Set();
    let cur = leafId;
    const seen = new Set();
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      set.add(cur);
      cur = byId.get(cur).parentId;
    }
    return set;
  }

  function focusPathIds(family, focus) {
    if (!focus) { return new Set(); }
    if (Array.isArray(focus.pathIds) && focus.pathIds.length) {
      return new Set(focus.pathIds);
    }
    if (!focus.sessionFile) { return new Set(); }
    const t = normFile(focus.sessionFile);
    const sess = (family.sessions || []).find((s) => normFile(s.file) === t);
    if (!sess || !sess.leafId) { return new Set(); }
    const byId = new Map((family.messages || []).map((m) => [m.id, m]));
    return pathSetFromLeaf(byId, sess.leafId);
  }

  // ---- layout ----
  function subtreeWidth(id, byId, memo) {
    if (memo.has(id)) { return memo.get(id); }
    const m = byId.get(id);
    if (!m) { memo.set(id, NODE_W); return NODE_W; }
    const kids = m.children || [];
    if (!kids.length) {
      memo.set(id, NODE_W);
      return NODE_W;
    }
    let sum = 0;
    for (let i = 0; i < kids.length; i++) {
      sum += subtreeWidth(kids[i], byId, memo);
      if (i) { sum += H_GAP; }
    }
    const w = Math.max(NODE_W, sum);
    memo.set(id, w);
    return w;
  }

  /**
   * @returns {{ positions: Map<string,{x:number,y:number,h:number}>, width: number, height: number, edges: Array<{from:string,to:string}> }}
   */
  function layoutFamily(family, heights) {
    const byId = new Map((family.messages || []).map((m) => [m.id, m]));
    const roots = family.roots || [];
    const positions = new Map();
    const edges = [];
    const memo = new Map();

    function place(id, cx, y) {
      const h = heights.get(id) || 80;
      const x = cx - NODE_W / 2;
      positions.set(id, { x, y, h });
      const m = byId.get(id);
      const kids = (m && m.children) || [];
      if (!kids.length) {
        return y + h;
      }
      const widths = kids.map((k) => subtreeWidth(k, byId, memo));
      let total = 0;
      for (let i = 0; i < widths.length; i++) {
        total += widths[i];
        if (i) { total += H_GAP; }
      }
      let cursor = cx - total / 2;
      let maxBottom = y + h;
      const childY = y + h + V_GAP;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        const kcx = cursor + widths[i] / 2;
        edges.push({ from: id, to: k });
        const bottom = place(k, kcx, childY);
        if (bottom > maxBottom) { maxBottom = bottom; }
        cursor += widths[i] + H_GAP;
      }
      return maxBottom;
    }

    let width = 0;
    let height = 0;
    if (!roots.length) {
      return { positions, width: NODE_W, height: 40, edges };
    }

    const rootWidths = roots.map((r) => subtreeWidth(r, byId, memo));
    let total = 0;
    for (let i = 0; i < rootWidths.length; i++) {
      total += rootWidths[i];
      if (i) { total += H_GAP; }
    }
    width = Math.max(NODE_W, total);
    let cursor = 0;
    for (let i = 0; i < roots.length; i++) {
      const cx = cursor + rootWidths[i] / 2;
      const bottom = place(roots[i], cx, 0);
      if (bottom > height) { height = bottom; }
      cursor += rootWidths[i] + H_GAP;
    }
    return { positions, width, height, edges };
  }

  function clearWorld() {
    nodesEl.innerHTML = "";
    edgesSvg.innerHTML = "";
    edgesSvg.removeAttribute("width");
    edgesSvg.removeAttribute("height");
  }

  function createNodeEl(msg, family, onPath, highlightFile) {
    const el = document.createElement("div");
    el.className = "node " + (msg.role === "user" ? "user" : "assistant") + (onPath ? " on-path" : "");
    el.dataset.id = msg.id;
    el.tabIndex = 0;
    el.title = "双击打开此会话";

    const head = document.createElement("div");
    head.className = "node-head";
    const role = document.createElement("span");
    role.className = "node-role";
    role.textContent = msg.role === "user" ? "我" : "AI";
    head.appendChild(role);

    const actions = document.createElement("div");
    actions.className = "node-actions";
    if (msg.role === "user") {
      const forkBtn = document.createElement("button");
      forkBtn.type = "button";
      forkBtn.textContent = "在此分支";
      forkBtn.title = "从此消息新建分支";
      forkBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const file = resolveFile(msg, family, highlightFile);
        if (!file) { return; }
        vscode.postMessage({ type: "forkEntry", file, entryId: msg.id });
      });
      actions.appendChild(forkBtn);
    }
    head.appendChild(actions);
    el.appendChild(head);

    const body = document.createElement("div");
    body.className = "node-body";
    body.innerHTML = renderMarkdown(msg.text || "");
    el.appendChild(body);

    const more = document.createElement("button");
    more.type = "button";
    more.className = "node-more hidden";
    more.textContent = "展开全文";
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const collapsed = body.classList.toggle("collapsed");
      more.textContent = collapsed ? "展开全文" : "收起";
      // 高度变化后需要重排 —— 通知外层
      el.dispatchEvent(new CustomEvent("node-resize", { bubbles: true }));
    });
    el.appendChild(more);

    // 单击不动作（避免误触开新 tab）；双击才打开会话
    const openEntryAt = () => {
      const file = resolveFile(msg, family, highlightFile);
      if (!file) { return; }
      vscode.postMessage({ type: "openEntry", file, entryId: msg.id });
    };
    el.addEventListener("dblclick", (e) => {
      if (e.target.closest("button") || e.target.closest("a")) { return; }
      if (panMoved) { return; }
      openEntryAt();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openEntryAt();
      }
    });

    return { el, body, more };
  }

  function drawEdges(edges, positions, pathIds, offsetX, offsetY) {
    const ns = "http://www.w3.org/2000/svg";
    for (const e of edges) {
      const a = positions.get(e.from);
      const b = positions.get(e.to);
      if (!a || !b) { continue; }
      const x1 = offsetX + a.x + NODE_W / 2;
      const y1 = offsetY + a.y + a.h;
      const x2 = offsetX + b.x + NODE_W / 2;
      const y2 = offsetY + b.y;
      const midY = (y1 + y2) / 2;
      const path = document.createElementNS(ns, "path");
      path.setAttribute(
        "d",
        "M " + x1 + " " + y1 + " C " + x1 + " " + midY + ", " + x2 + " " + midY + ", " + x2 + " " + y2
      );
      if (pathIds.has(e.from) && pathIds.has(e.to)) {
        path.setAttribute("class", "on-path");
      }
      edgesSvg.appendChild(path);
    }
  }

  function fitView(worldW, worldH) {
    const vw = viewport.clientWidth || 800;
    const vh = viewport.clientHeight || 600;
    const pad = 48;
    if (worldW <= 0 || worldH <= 0) {
      panX = 40; panY = 40; scale = 1; applyTransform(); return;
    }
    const sx = (vw - pad * 2) / worldW;
    const sy = (vh - pad * 2) / worldH;
    scale = Math.max(0.15, Math.min(1.15, Math.min(sx, sy)));
    panX = (vw - worldW * scale) / 2;
    panY = Math.max(24, (vh - worldH * scale) / 2);
    applyTransform();
  }

  function focusOnRect(x, y, w, h) {
    const vw = viewport.clientWidth || 800;
    const vh = viewport.clientHeight || 600;
    const targetScale = Math.max(0.35, Math.min(1, Math.min((vw * 0.7) / Math.max(w, 1), (vh * 0.7) / Math.max(h, 1))));
    scale = targetScale;
    panX = vw / 2 - (x + w / 2) * scale;
    panY = vh / 2 - (y + h / 2) * scale;
    applyTransform();
  }

  function renderAll(opts) {
    opts = opts || {};
    clearWorld();
    const families = state.families || [];
    emptyEl.classList.toggle("hidden", families.length > 0);
    setMeta();
    updateLoadMore();
    if (!families.length) {
      applyTransform();
      return;
    }

    const highlightFile = state.focus && state.focus.sessionFile ? state.focus.sessionFile : null;
    const focusFamilyId = state.focus && state.focus.familyId ? state.focus.familyId : null;

    // 第一遍：建 DOM，测高度
    /** @type {Array<{family:any, pathIds:Set<string>, nodeMap:Map<string,{el:HTMLElement,body:HTMLElement,more:HTMLElement}>, heights:Map<string,number>}>} */
    const prepared = [];
    for (const family of families) {
      const pathIds = focusPathIds(family, state.focus && (!focusFamilyId || focusFamilyId === family.id) ? state.focus : null);
      // 若 focus 指定了 family 但不是这个，path 为空
      const effectivePath =
        focusFamilyId && focusFamilyId !== family.id ? new Set() : pathIds;
      const nodeMap = new Map();
      const heights = new Map();
      for (const msg of family.messages || []) {
        const created = createNodeEl(msg, family, effectivePath.has(msg.id), highlightFile);
        created.el.style.visibility = "hidden";
        created.el.style.left = "0px";
        created.el.style.top = "0px";
        nodesEl.appendChild(created.el);
        // collapse long content
        const lineHeight = parseFloat(getComputedStyle(created.body).lineHeight) || 18;
        const maxH = lineHeight * COLLAPSE_LINES;
        if (created.body.scrollHeight > maxH + 8) {
          created.body.classList.add("collapsed");
          created.more.classList.remove("hidden");
        }
        heights.set(msg.id, created.el.offsetHeight || 80);
        nodeMap.set(msg.id, created);
      }
      prepared.push({ family, pathIds: effectivePath, nodeMap, heights });
    }

    // 第二遍：布局 + 定位
    // 家族左右排布（新→旧从左到右）；家族内部仍竖排对话、分叉向左右展开
    let offsetX = 0;
    let worldW = 0;
    let worldH = 0;
    let focusRect = null;
    /** 最左（最新）家族包围盒，作默认相机锚点 */
    let firstFamilyRect = null;

    for (let fi = 0; fi < prepared.length; fi++) {
      const prep = prepared[fi];
      const layout = layoutFamily(prep.family, prep.heights);
      const ox = offsetX;
      const oy = 0;

      for (const [id, pos] of layout.positions) {
        const n = prep.nodeMap.get(id);
        if (!n) { continue; }
        n.el.style.visibility = "visible";
        n.el.style.left = (ox + pos.x) + "px";
        n.el.style.top = (oy + pos.y) + "px";
        // 用最终高度回写（collapsed 后）
        const h = n.el.offsetHeight || pos.h;
        pos.h = h;
        prep.heights.set(id, h);
      }

      // 高度可能因 collapsed 变化，再 layout 一次更稳
      const layout2 = layoutFamily(prep.family, prep.heights);
      for (const [id, pos] of layout2.positions) {
        const n = prep.nodeMap.get(id);
        if (!n) { continue; }
        n.el.style.left = (ox + pos.x) + "px";
        n.el.style.top = (oy + pos.y) + "px";
      }
      drawEdges(layout2.edges, layout2.positions, prep.pathIds, ox, oy);

      const famRect = {
        x: ox,
        y: oy,
        w: layout2.width,
        h: layout2.height,
      };
      if (fi === 0) { firstFamilyRect = famRect; }

      if (prep.pathIds.size > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const id of prep.pathIds) {
          const p = layout2.positions.get(id);
          if (!p) { continue; }
          minX = Math.min(minX, ox + p.x);
          minY = Math.min(minY, oy + p.y);
          maxX = Math.max(maxX, ox + p.x + NODE_W);
          maxY = Math.max(maxY, oy + p.y + p.h);
        }
        if (minX < Infinity) {
          focusRect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
      }

      worldW = ox + layout2.width;
      worldH = Math.max(worldH, layout2.height);
      offsetX = worldW + FAMILY_GAP;
    }

    edgesSvg.setAttribute("width", String(Math.ceil(worldW + 80)));
    edgesSvg.setAttribute("height", String(Math.ceil(worldH + 80)));

    if (opts.fit !== false) {
      if (focusRect && opts.preferFocus) {
        focusOnRect(focusRect.x, focusRect.y, focusRect.w, focusRect.h);
      } else if (opts.fitAll) {
        // 「适应」：整幅画布（多家族会缩得很小）
        fitView(worldW, worldH);
      } else if (firstFamilyRect) {
        // 默认对准最新家族，高度可读，避免横向全家缩成一条线
        focusOnRect(firstFamilyRect.x, firstFamilyRect.y, firstFamilyRect.w, Math.min(firstFamilyRect.h, 900));
      } else {
        fitView(worldW, worldH);
      }
    }

    // 节点展开后重排
    nodesEl.onclick = null;
    world.onnodeResize = null;
  }

  // 展开/收起后重排（保持当前相机）
  world.addEventListener("node-resize", () => {
    renderAll({ fit: false });
  });

  // ---- pan / zoom ----
  // 卡片上按住即可拖动；纯点击/双击不捕获指针，保留原生 click/dblclick 语义
  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) { return; }
    panning = true;
    panMoved = false;
    panCapture = false;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!panning) { return; }
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      panMoved = true;
      // 真正拖动后才捕获指针 + 切换光标/禁选，避免破坏点击与双击
      if (!panCapture) {
        panCapture = true;
        try { viewport.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        viewport.classList.add("panning");
      }
    }
    lastX = e.clientX;
    lastY = e.clientY;
    panX += dx;
    panY += dy;
    applyTransform();
  });
  function endPan(e) {
    if (!panning) { return; }
    panning = false;
    viewport.classList.remove("panning");
    if (panCapture) {
      panCapture = false;
      try { viewport.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    // 下一帧清 panMoved，避免 click 误触
    setTimeout(() => { panMoved = false; }, 0);
  }
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);

  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldX = (mx - panX) / scale;
    const worldY = (my - panY) / scale;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const next = Math.max(0.12, Math.min(2.5, scale * delta));
    panX = mx - worldX * next;
    panY = my - worldY * next;
    scale = next;
    applyTransform();
  }, { passive: false });

  btnFit.addEventListener("click", () => {
    // 有聚焦 path 时对准 path，否则适应全部家族
    if (state.focus && (state.focus.sessionFile || state.focus.pathIds)) {
      renderAll({ fit: true, preferFocus: true });
    } else {
      renderAll({ fit: true, fitAll: true });
    }
  });
  btnRefresh.addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });
  btnLoadMore.addEventListener("click", () => {
    btnLoadMore.disabled = true;
    btnLoadMore.textContent = "加载中…";
    vscode.postMessage({ type: "loadMore" });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") { return; }
    if (msg.type === "init") {
      state.families = msg.families || [];
      state.totalFamilies = msg.totalFamilies || 0;
      state.loadedFamilies = msg.loadedFamilies || 0;
      state.focus = msg.focus || null;
      renderAll({ fit: true, preferFocus: !!(state.focus && (state.focus.sessionFile || state.focus.pathIds)) });
      return;
    }
    if (msg.type === "append") {
      const more = msg.families || [];
      state.families = state.families.concat(more);
      state.totalFamilies = msg.totalFamilies || state.totalFamilies;
      state.loadedFamilies = msg.loadedFamilies || state.loadedFamilies;
      renderAll({ fit: false });
      updateLoadMore();
      return;
    }
    if (msg.type === "error") {
      tbMeta.textContent = msg.text || "加载失败";
      btnLoadMore.disabled = false;
      return;
    }
  });

  applyTransform();
  vscode.postMessage({ type: "ready" });
})();

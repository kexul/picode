// 顶条里「当前这一格」的几种选中样子：把真界面里那排格复制几份，每份套一种画法，
// 摆成一竖排照一张，挑一个（配色跟着当前主题走，浅色 / 深色各照一张）。
//
//   npm run web:shot -- --fake-pi --width 980 --height 620 --script dev/tabSelectStyles.js
//   npm run web:shot -- --fake-pi --width 980 --height 620 --theme dark --script dev/tabSelectStyles.js --out dev/shots
//
// 图落在 dev/shots/tabselect-<主题>.png。
module.exports = async (page) => {
  await page.waitReady();
  // 刚连上那会儿后端还会推一两次会话列表，等它落定再动
  await page.sleep(1200);

  // 造一排看着像真的格子（只验画得对不对，不点它们）
  const names = ["修改登录校验", "写顶条那颗叉", "查会话文件写到哪儿", "跑一遍测试", "收尾提交"];
  const fake = names.map((name, i) => ({
    id: "fake" + i, name, cwd: "dev/.scratch", file: "", title: "", parentId: null,
    streaming: false, loading: false, activity: "idle", activityDetail: "", piReady: true,
    modelId: "fake/model", provider: "fake", thinkingLevel: "medium", taba: null,
  }));
  await page.eval(`
    const msgs = [
      { type: "sessionList", sessions: ${JSON.stringify(fake)} },
      { type: "sessionActivated", sessionId: "fake1" },
    ];
    for (const m of msgs) { window.postMessage(m, "*"); }
    return true;
  `);
  await page.sleep(500);

  const VARIANTS = [
    { id: "now", label: "现在这版（细描边，不填色）", css: "" },
    { id: "tint", label: "之前那版（蓝底）", css: `.pv[data-v="tint"] .sn-tab.current { background: var(--pk-select-tint); }` },
    {
      id: "line", label: "只留一条下划线", css: `
        .pv[data-v="line"] .sn-tab.current { background: transparent; box-shadow: inset 0 -2px 0 var(--vscode-focusBorder, #007acc); }
        .pv[data-v="line"] .sn-tab.current .sn-text { opacity: 1; }
      `,
    },
    {
      id: "bold", label: "什么也不加，名字提亮加粗", css: `
        .pv[data-v="bold"] .sn-tab.current { background: transparent; }
        .pv[data-v="bold"] .sn-tab.current .sn-text { opacity: 1; font-weight: 600; }
      `,
    },
    {
      id: "grey", label: "中性灰底（不偏蓝）", css: `
        .pv[data-v="grey"] .sn-tab.current { background: color-mix(in srgb, var(--vscode-foreground, #ccc) 10%, transparent); }
      `,
    },
    {
      id: "tintline", label: "淡蓝底 + 底下一条蓝线", css: `
        .pv[data-v="tintline"] .sn-tab.current {
          background: color-mix(in srgb, var(--vscode-focusBorder, #007acc) 12%, transparent);
          box-shadow: inset 0 -2px 0 var(--vscode-focusBorder, #007acc);
        }
      `,
    },
  ];

  // 把真界面上那排格复制几份，每份套一种画法；整块盖在页面上，照完就完事
  await page.eval(`
    const variants = ${JSON.stringify(VARIANTS)};
    const src = document.getElementById("sessionTabs");
    const sheet = document.createElement("style");
    sheet.textContent = variants.map((v) => v.css).join("\\n") + \`
      #pvWrap { position: fixed; inset: 0; z-index: 9999; overflow: auto;
        background: var(--vscode-editor-background, var(--vscode-foreground, #fff));
        color: var(--vscode-foreground, #333); font-family: inherit; padding: 14px 18px; box-sizing: border-box; }
      .pv { display: flex; align-items: center; gap: 14px; padding: 9px 0; }
      .pv > .pv-label { flex: 0 0 210px; font-size: 12px; opacity: 0.8; }
      .pv > .pv-tabs { flex: 1 1 auto; display: flex; align-items: stretch; gap: 4px; }
      .pv > .pv-tabs .sn-tab { flex: 0 0 auto; }
    \`;
    document.head.appendChild(sheet);

    const wrap = document.createElement("div");
    wrap.id = "pvWrap";
    for (const v of variants) {
      const row = document.createElement("div");
      row.className = "pv";
      row.dataset.v = v.id;
      const label = document.createElement("div");
      label.className = "pv-label";
      label.textContent = v.label;
      const tabs = document.createElement("div");
      tabs.className = "pv-tabs";
      for (const el of src.querySelectorAll(".sn-tab")) {
        const c = el.cloneNode(true);
        c.classList.remove("tab-hidden");
        c.removeAttribute("id");
        if (c.classList.contains("current")) {
          c.querySelector(".sn-text").textContent = "写顶条那颗叉";
        }
        tabs.appendChild(c);
      }
      row.appendChild(label);
      row.appendChild(tabs);
      wrap.appendChild(row);
    }
    document.body.appendChild(wrap);
    return true;
  `);
  await page.sleep(300);

  const theme = await page.eval(`
    const m = document.querySelector('meta[name="pichat-theme"]');
    return m ? m.content : "light";
  `);
  await page.shot("tabselect-" + theme + ".png");
};

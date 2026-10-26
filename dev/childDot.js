// @ts-nocheck
/**
 * childDot —— 验顶条中间那颗会话名上的小点：本会话自己闲着、派出去的子会话还在跑时，
 * 那颗蓝点也亮着、也呼吸（以前只在本会话自己答的时候才亮），点下面那个小数字写着
 * 还有几个子会话在跑（零个时数字收起来、点也不亮）；子会话跑完了（结果已交回）、又没有
 * 谁在跑时，同一颗点换成绿的、不闪。
 *
 * 只要验前端画得对不对，所以不真派子会话：直接往页面里投假的 sessionList
 * （跟后端推的是同一种消息）。六种情形各看一眼，类名 / 显示 / 动画 / 那个数字都打成文字，各裁一张小图：
 *   1 子会话在跑（running）        → 亮、呼吸、写 1
 *   2 刚派出去、任务还没发（starting）→ 亮、呼吸、写 1
 *   3 子会话跑完等着（waiting）    → 绿点、不闪、没数字
 *   4 子会话在跑 + 别的会话有新消息 → 亮、呼吸、写 1（呼吸优先，不变成不闪的那种）
 *   5 本会话自己在跑                → 亮、呼吸、没数字（数字只算子会话）
 *   6 两个子会话在跑 + 一个在等    → 亮、呼吸、写 2
 * 最后再量一下位置：那颗点与箭头是贴着“会话名 + 目录两行”整体居中的，
 * 不是只贴着会话名那一行（目录行收起来时它们才回到名字上）；有数字的时候
 * 是“点 + 数字”这一小竖条一起居中，数字落在点的正下面。
 *
 *   npm run web:shot -- --width 900 --height 620 --script dev/childDot.js
 * 图落在 dev/shots/（名字带 child-dot-）。
 */
const fs = require("fs");
const path = require("path");

const SHOT_DIR = path.resolve(__dirname, "shots");

/** 一个会话要投给页面的字段（跟后端 serializeSession 给的那份同形，缺的字段界面有兜底）。 */
function session(over) {
  return Object.assign({
    id: "p1",
    name: "主会话",
    cwd: "dev/.scratch",
    file: "",
    title: "",
    parentId: null,
    streaming: false,
    loading: false,
    activity: "idle",
    activityDetail: "",
    piReady: true,
    modelId: "fake/model",
    provider: "fake",
    thinkingLevel: "medium",
    taba: null,
  }, over);
}

/** 子会话（名字、缩进、状态都照真那份来；state 是 taba 那边的一步）。 */
function child(state, over) {
  const running = state === "running";
  return session(Object.assign({
    id: "c1",
    name: "侦察: 认证模块",
    parentId: "p1",
    streaming: running,
    activity: running ? "working" : "idle",
    taba: { role: "child", id: "t1", name: "侦察: 认证模块", state },
  }, over));
}

/** 另一个主会话（case 4 用它造“别的会话有新消息”）。 */
function other(over) {
  return session(Object.assign({ id: "p2", name: "另一个会话" }, over));
}

module.exports = async (page) => {
  await page.waitReady();
  // 刚连上那会儿后端还会推一两次会话列表，等它落定再投假数据
  await page.sleep(1200);

  /** 顶条那颗点的现状：按钮上挂了什么类、点显示没有、在不在跑呼吸动画、点下面那个数字。 */
  const dotState = () => page.eval(`
    const btn = document.getElementById("sessionName");
    const el = btn.querySelector(".sn-dot");
    const cs = getComputedStyle(el);
    const countEl = btn.querySelector(".sn-count");
    return {
      visible: cs.display !== "none",
      animation: cs.animationName,
      bg: cs.backgroundColor,
      cls: btn.className,
      center: btn.querySelector(".sn-text").textContent,
      count: countEl ? countEl.textContent : null,
      countVisible: !!countEl && getComputedStyle(countEl).display !== "none",
      title: btn.title,
    };
  `);

  /** 投一批假会话（列表 + 指哪一个是当前这个）。 */
  const inject = async (sessions, extra) => {
    const messages = [{ type: "sessionList", sessions }, { type: "sessionActivated", sessionId: "p1" }]
      .concat(extra || []);
    await page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
    await page.sleep(250);
  };

  /** 把顶条裁下来放大 3 倍存图：7 像素的点在整屏图里几乎看不出。 */
  const shotBar = async (name) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const r = await page.eval(`
      const b = document.getElementById("sessionBar").getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height };
    `);
    const image = await page.cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), scale: 3 },
    });
    const file = path.join(SHOT_DIR, name);
    fs.writeFileSync(file, Buffer.from(image.data, "base64"));
    return file;
  };

  const CASES = [
    {
      id: "1-child-running", what: "子会话在跑",
      want: { visible: true, animation: "pi-pulse", count: "1" },
      sessions: [session(), child("running")],
    },
    {
      id: "2-child-starting", what: "刚派出去、任务还没发",
      want: { visible: true, animation: "pi-pulse", count: "1" },
      sessions: [session(), child("starting", { streaming: false, activity: "idle" })],
    },
    {
      id: "3-child-waiting", what: "子会话跑完等着",
      want: { visible: true, animation: "none", count: "", bg: "green" },
      sessions: [session(), child("waiting", { streaming: false, activity: "idle" })],
    },
    {
      id: "4-child-running-unread", what: "子会话在跑 + 别的会话有新消息",
      want: { visible: true, animation: "pi-pulse", count: "1" },
      sessions: [session(), child("running"), other()],
      // 别的会话跑完一轮：页面把「有新消息」标上（这时顶条那颗点本该“亮着不闪”）
      extra: [{ type: "turnEnd", sessionId: "p2", status: "done", text: "跑完了一轮" }],
    },
    {
      id: "5-self-streaming", what: "本会话自己在跑",
      want: { visible: true, animation: "pi-pulse", count: "" },
      sessions: [session({ streaming: true, activity: "working" }), child("waiting", { streaming: false, activity: "idle" })],
    },
    {
      id: "6-two-children", what: "两个子会话在跑、一个在等",
      want: { visible: true, animation: "pi-pulse", count: "2" },
      sessions: [
        session(),
        child("running"),
        child("running", { id: "c2", taba: { role: "child", id: "t2", name: "改一批文件", state: "running" } }),
        child("waiting", { id: "c3", streaming: false, activity: "idle", taba: { role: "child", id: "t3", name: "跑完了", state: "waiting" } }),
      ],
    },
  ];

  let bad = 0;
  for (const c of CASES) {
    await inject(c.sessions, c.extra);
    const got = await dotState();
    const rgb = (got.bg.match(/\d+/g) || []).map(Number);
    // 主题变量各套不一样（VS Code 的深/浅色、假主题各是一份），所以只认“绿”这个方向：G 通道最大
    const isGreen = rgb.length >= 3 && rgb[1] > rgb[0] && rgb[1] > rgb[2];
    const ok = got.visible === c.want.visible && got.animation === c.want.animation
      && got.count === c.want.count && got.countVisible === (c.want.count !== "")
      && (c.want.bg === undefined || (c.want.bg === "green" ? isGreen : got.bg === c.want.bg))
      && (c.want.count === "" || got.title.includes(c.want.count + " 个子会话在跑"));
    if (!ok) { bad++; }
    const file = await shotBar(`child-dot-${c.id}.png`);
    console.log(
      `${ok ? "√" : "×"} ${c.what}：小点 ${got.visible ? "亮" : "不亮"}、动画 ${got.animation === "pi-pulse" ? "呼吸" : got.animation === "none" ? "无" : got.animation}` +
      `、颜色 ${got.bg}` +
      `、点下面写「${got.countVisible ? got.count : "（没有数字）"}」（按钮类名 "${got.cls}"，顶条中间写着「${got.center}」）→ ${path.basename(file)}`
    );
  }

  // ---- 那颗点与箭头落在哪一行：都该贴着“两行合起来”那条的中线 ----
  // 以前它们是贴着会话名那一行居中的（看着偏上）；现在两行都在同一颗按钮里，
  // 点与箭头跟着这颗按钮上下居中。量之前先把两样都弄出来：本会话在跑（点亮），
  // 清单里两个主会话（箭头才露面）。
  await inject([
    session({ streaming: true, title: "长尾 drop 门审计与 +19072 全 0 结案" }),
    other(),
  ]);
  const pos = await page.eval(`
    const btn = document.getElementById("sessionName");
    const mid = (el) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
    const dotMid = ["#sessionName .sn-dot", "#sessionName .sn-caret"].map((sel) => mid(btn.querySelector(sel)));
    return {
      dotMid,
      linesMid: mid(btn.querySelector(".sn-lines")),
      nameMid: mid(btn.querySelector(".sn-text")),
      pathMid: mid(document.getElementById("sessionPath")),
      pathVisible: getComputedStyle(document.getElementById("sessionPath")).display !== "none",
    };
  `);
  for (const [i, what] of ["小点", "箭头"].entries()) {
    const off = pos.dotMid[i] - pos.linesMid;
    // 三件事：目录行得在（不然只剩一行，“两行中间”无从谈起）；
    // 点 / 箭头的中心跟两行那块的中心齐（差 1px 以内）；它得在会话名那行之下、目录那行往上。
    const ok = pos.pathVisible && Math.abs(off) <= 1
      && pos.dotMid[i] > pos.nameMid && pos.dotMid[i] < pos.pathMid;
    if (!ok) { bad++; }
    console.log(
      `${ok ? "√" : "×"} ${what}竖直位置：落在两行中间（两行中线 ${pos.linesMid.toFixed(1)}，它在 ${pos.dotMid[i].toFixed(1)}，` +
      `会话名那行中线 ${pos.nameMid.toFixed(1)}、目录那行 ${pos.pathMid.toFixed(1)}，差 ${off.toFixed(1)}px` +
      (pos.pathVisible ? "）" : "；目录行没显示）")
    );
  }

  // ---- 有数字的时候：点与数字这一小竖条一起落在两行中间，数字在点的正下面 ----
  await inject([session(), child("running")]);
  const pos2 = await page.eval(`
    const btn = document.getElementById("sessionName");
    const box = (el) => el.getBoundingClientRect();
    const mid = (el) => { const r = box(el); return (r.top + r.bottom) / 2; };
    const dot = box(btn.querySelector(".sn-dot"));
    const count = box(btn.querySelector(".sn-count"));
    const lines = box(btn.querySelector(".sn-lines"));
    const path = box(document.getElementById("sessionPath"));
    return {
      markMid: mid(btn.querySelector(".sn-mark")),
      linesMid: (lines.top + lines.bottom) / 2,
      dotBottom: dot.bottom, countTop: count.top,
      dotCenterX: (dot.left + dot.right) / 2, countCenterX: (count.left + count.right) / 2,
      countBottom: count.bottom, pathBottom: path.bottom,
      countVisible: getComputedStyle(document.getElementById("sessionName").querySelector(".sn-count")).display !== "none",
    };
  `);
  {
    const offMark = pos2.markMid - pos2.linesMid;
    const offX = pos2.countCenterX - pos2.dotCenterX;
    const ok = pos2.countVisible
      && Math.abs(offMark) <= 1
      && pos2.countTop >= pos2.dotBottom - 0.5
      && Math.abs(offX) <= 1
      && pos2.countBottom <= pos2.pathBottom + 0.5;
    if (!ok) { bad++; }
    console.log(
      `${ok ? "√" : "×"} 点 + 数字这一竖条：整体落在两行中间（差 ${offMark.toFixed(1)}px）、` +
      `数字在点的正下面（点底 ${pos2.dotBottom.toFixed(1)} ≤ 数字顶 ${pos2.countTop.toFixed(1)}；` +
      `中线差 ${offX.toFixed(1)}px）、不冒出目录那行（数字底 ${pos2.countBottom.toFixed(1)}、目录底 ${pos2.pathBottom.toFixed(1)}）`
    );
  }
  // ---- 「项目与会话」面板里子会话那一行行首的点：跑完了也该是绿的 ----
  await inject([session(), child("waiting", { streaming: false, activity: "idle" })]);
  // 右边那一列可能已经常驻开着（宽窗默认开着、这是这台设备记下的）：只有收着才去展开它
  await page.eval(`
    if (!document.body.classList.contains("dock-sidebar") && window.pichatSidebar && window.pichatSidebar.toggle) {
      window.pichatSidebar.toggle();
    }
    return true;
  `);
  await page.sleep(300);
  // 常驻那一列要先跟宿主再要一份面板内容（openWorkspace 跑一圈）：等到行出来为止
  for (let i = 0; i < 20; i++) {
    const n = await page.eval(`return document.querySelectorAll(".pk-item").length;`);
    if (n > 0) { break; }
    await page.sleep(250);
  }
  const panelRow = await page.eval(`
    const row = document.querySelector(".pk-open-child");
    if (!row) { return { found: false, items: document.querySelectorAll(".pk-item").length }; }
    const el = row.querySelector(".pk-open-dot");
    const cs = getComputedStyle(el);
    return {
      found: true, cls: el.className, bg: cs.backgroundColor,
      shown: el.getBoundingClientRect().width > 0,
      name: (row.querySelector(".pk-history-title") || {}).textContent || "",
    };
  `);
  {
    const rgb2 = ((panelRow.bg || "").match(/\d+/g) || []).map(Number);
    const green = rgb2.length >= 3 && rgb2[1] > rgb2[0] && rgb2[1] > rgb2[2];
    const ok = panelRow.found && panelRow.shown && green && /\bdone\b/.test(panelRow.cls);
    if (!ok) { bad++; }
    console.log(
      `${ok ? "√" : "×"} 面板里子会话那一行行首的点：跑完了${panelRow.found ? `亮${green ? "绿" : "的却是 " + panelRow.bg}` : "没找到那一行（只有 " + panelRow.items + " 行）"}` +
      (panelRow.found ? `（类名 "${panelRow.cls}"，行里写着「${panelRow.name}」）` : "")
    );
  }
  await page.shot("child-dot-7-panel.png");

  if (bad > 0) { throw new Error(`有 ${bad} 处画得不对（见上面 × 那几行）`); }
};

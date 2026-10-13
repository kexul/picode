// @ts-nocheck
/**
 * childDot —— 验顶条中间那颗会话名上的小点：本会话自己闲着、派出去的子会话还在跑时，
 * 那颗蓝点也亮着、也呼吸（以前只在本会话自己答的时候才亮）。
 *
 * 只要验前端画得对不对，所以不真派子会话：直接往页面里投假的 sessionList
 * （跟后端推的是同一种消息）。五种情形各看一眼，类名 / 显示 / 动画都打成文字，各裁一张小图：
 *   1 子会话在跑（running）        → 亮、呼吸
 *   2 刚派出去、任务还没发（starting）→ 亮、呼吸
 *   3 子会话跑完等着（waiting）    → 不亮
 *   4 子会话在跑 + 别的会话有新消息 → 亮、呼吸（呼吸优先，不变成不闪的那种）
 *   5 本会话自己在跑                → 亮、呼吸（老样子）
 * 最后再量一下位置：那颗点与箭头是贴着“会话名 + 目录两行”整体居中的，
 * 不是只贴着会话名那一行（目录行收起来时它们才回到名字上）。
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

  /** 顶条那颗点的现状：按钮上挂了什么类、点显示没有、在不在跑呼吸动画。 */
  const dotState = () => page.eval(`
    const btn = document.getElementById("sessionName");
    const el = btn.querySelector(".sn-dot");
    const cs = getComputedStyle(el);
    return {
      visible: cs.display !== "none",
      animation: cs.animationName,
      cls: btn.className,
      center: btn.querySelector(".sn-text").textContent,
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
      want: { visible: true, animation: "pi-pulse" },
      sessions: [session(), child("running")],
    },
    {
      id: "2-child-starting", what: "刚派出去、任务还没发",
      want: { visible: true, animation: "pi-pulse" },
      sessions: [session(), child("starting", { streaming: false, activity: "idle" })],
    },
    {
      id: "3-child-waiting", what: "子会话跑完等着",
      want: { visible: false, animation: "none" },
      sessions: [session(), child("waiting", { streaming: false, activity: "idle" })],
    },
    {
      id: "4-child-running-unread", what: "子会话在跑 + 别的会话有新消息",
      want: { visible: true, animation: "pi-pulse" },
      sessions: [session(), child("running"), other()],
      // 别的会话跑完一轮：页面把「有新消息」标上（这时顶条那颗点本该“亮着不闪”）
      extra: [{ type: "turnEnd", sessionId: "p2", beep: false }],
    },
    {
      id: "5-self-streaming", what: "本会话自己在跑",
      want: { visible: true, animation: "pi-pulse" },
      sessions: [session({ streaming: true, activity: "working" }), child("waiting", { streaming: false, activity: "idle" })],
    },
  ];

  let bad = 0;
  for (const c of CASES) {
    await inject(c.sessions, c.extra);
    const got = await dotState();
    const ok = got.visible === c.want.visible && got.animation === c.want.animation;
    if (!ok) { bad++; }
    const file = await shotBar(`child-dot-${c.id}.png`);
    console.log(
      `${ok ? "√" : "×"} ${c.what}：小点 ${got.visible ? "亮" : "不亮"}、动画 ${got.animation === "pi-pulse" ? "呼吸" : got.animation === "none" ? "无" : got.animation}` +
      `（按钮类名 "${got.cls}"，顶条中间写着「${got.center}」）→ ${path.basename(file)}`
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
  if (bad > 0) { throw new Error(`有 ${bad} 处画得不对（见上面 × 那几行）`); }
};

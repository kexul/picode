// 顶条那一排格的名字后面那颗 × ，以及挤了以后会话格怎么收窄、怎么叠起来。
//
//   FAKEPI_THINK_MS=6000 npm run web:shot -- --fake-pi --width 900 --height 500 --script dev/tabClose.js
//
// 验六件事：
//   ① 两个会话、放得下：每格名字后面都有一颗 ×
//   ② 点闲着的那个会话的 ×：一下就关掉那一个（不用确认）
//   ③ 会话正在跑时点 ×：那一格变红、叉换成勾，这一下不关；再点两下（叉 + 勾）才关
//   ④ 挤了（420 宽、五个会话）：开着的会话一个不少都还在条上；当前这一张写名字，
//     别的收成窄块、只露那颗点（名字藏起来）
//   ⑤ 再挤（会话更多 / 窗口更窄）：窄块一张压一张地叠起来（后面的盖住前面的右边），
//     每张都露出左边一截，谁也没被藏掉；点一张照旧切过去
//   ⑥ 窗口放宽、全放得下：名字都出来，窄块、叠起来的边距都收回原样
// 图落在 dev/shots/（名字带 tabclose-）。
module.exports = async (page) => {
  await page.waitReady();
  // 刚连上那会儿后端还会推一两次会话列表，等它落定再动
  await page.sleep(1200);

  /** 顶条现状：几格、每格叫什么、哪一格在等确认、每颗叉画的是叉还是勾。 */
  const bar = () => page.eval(`
    const row = document.getElementById("sessionTabs");
    const tabs = [...row.querySelectorAll(".sn-tab")].filter((t) => !t.classList.contains("hidden"));
    const dots = tabs.map((t) => {
      const c = t.querySelector(".sn-close");
      if (!c) { return "没叉"; }
      const p = c.querySelector("path");
      const d = p ? p.getAttribute("d") : "";
      return d.indexOf("M2.6") === 0 ? "勾" : (d.indexOf("M2.5") === 0 ? "叉" : "?");
    });
    return {
      格数: tabs.length,
      名字: tabs.map((t) => (t.querySelector(".sn-text") || {}).textContent || ""),
      当前: tabs.map((t) => t.classList.contains("current")),
      等确认: tabs.map((t) => t.classList.contains("closing")),
      叉: dots,
    };
  `);
  const say = async (what) => console.log("  " + what + "：" + JSON.stringify(await bar()));

  const setWidth = async (w) => {
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 500, deviceScaleFactor: 1, mobile: false });
    await page.sleep(400);
  };

  // ① 两个会话、放得下
  await page.click("#newSessionBtn");
  await page.sleep(1500);
  await say("① 两个会话（900 宽）");
  await page.shot("tabclose-1-two.png");

  // ② 闲着的那个会话：点它的 × 一下就关
  await page.eval(`
    const t = [...document.querySelectorAll("#sessionTabs .sn-tab")].find((el) => !el.classList.contains("current"));
    t.querySelector(".sn-close").click();
    return true;
  `);
  await page.sleep(1500);
  await say("② 关掉闲着的那一个之后");

  // ③ 正在跑的会话：点 × 先变成勾（不关），再点一下才关
  await page.send("说点什么");
  const untilStreaming = async (ms) => {
    const end = Date.now() + (ms || 20000);
    while (Date.now() < end) {
      if ((await page.eval(`return (document.getElementById("ctxIcon") || {}).getAttribute?.("data-st") || "";`)) === "streaming") { return true; }
      await page.sleep(150);
    }
    return false;
  };
  await untilStreaming();
  await page.eval(`document.querySelector("#sessionTabs .sn-tab.current .sn-close").click(); return true;`);
  await page.sleep(300);
  await say("③ 跑着时点了一下 ×");
  await page.shot("tabclose-3-confirm.png");
  // 点了一下不管它：4 秒后自己收回（那一格不再红、那颗勾变回叉，会话照旧开着）
  await page.sleep(4500);
  await say("③ 干等 4 秒多（自己收回）");
  await page.eval(`document.querySelector("#sessionTabs .sn-tab.current .sn-close").click(); return true;`);
  await page.sleep(300);
  await page.eval(`document.querySelector("#sessionTabs .sn-tab.current .sn-close").click(); return true;`);
  await page.sleep(1500);
  await say("③ 再点两下（叉 + 勾）之后");

  // ④ 挤了：五个会话挤在 420 宽里（只验画得对不对，不点它们）
  const names = ["写顶条那颗叉", "把会话列表重排一遍", "查一下会话文件写到哪儿", "跑测试", "收尾提交"];
  const fakeOf = (name, i, extra) => Object.assign({
    id: "fake" + i, name, cwd: "dev/.scratch", file: "", title: "", parentId: null,
    streaming: false, loading: false, activity: "idle", activityDetail: "", piReady: true,
    modelId: "fake/model", provider: "fake", thinkingLevel: "medium", taba: null,
  }, extra || {});
  const fake = names.map((name, i) => fakeOf(name, i));
  const inject = async (list, activeId) => {
    const msgs = [{ type: "sessionList", sessions: list }, { type: "sessionActivated", sessionId: activeId }];
    await page.eval(`for (const m of ${JSON.stringify(msgs)}) { window.postMessage(m, "*"); } return true;`);
    await page.sleep(500);
  };
  /** 顶条上每一格现在长什么样：在不在条上、收窄没有、名字藏没藏、宽度、当前格在不在中间、那颗点在不在。 */
  const shape = () => page.eval(`
    const row = document.getElementById("sessionTabs");
    const tabs = [...row.querySelectorAll(".sn-tab")].filter((t) => !t.classList.contains("hidden"));
    const curIdx = tabs.findIndex((t) => t.classList.contains("current"));
    return {
      条上格数: tabs.length,
      当前: tabs.filter((t) => t.classList.contains("current")).map((t) => (t.querySelector(".sn-text") || {}).textContent),
      窄块: tabs.filter((t) => t.classList.contains("strip")).length,
      宽度: tabs.map((t) => Math.round(t.getBoundingClientRect().width)),
      当前在中间: curIdx < 0 ? "-" : (Math.abs(curIdx - (tabs.length - 1 - curIdx)) <= 1),
      名字都藏着: tabs.every((t) => !t.classList.contains("strip") || getComputedStyle(t.querySelector(".sn-text")).display === "none"),
      点都露着: tabs.every((t) => {
        const d = t.querySelector(".sn-dot");
        if (!d || getComputedStyle(d).display === "none") { return false; }
        const r = t.getBoundingClientRect();
        const rowR = row.getBoundingClientRect();
        return r.width > 0 && r.left >= rowR.left - 1 && r.right <= rowR.right + 1;
      }),
    };
  `);

  await setWidth(420);
  await inject(fake, "fake0");
  console.log("  ④ 五个会话（420 宽）：" + JSON.stringify(await shape()));
  await page.shot("tabclose-4-narrow.png");

  // ⑤ 会话更多：叠起来，但一个不少、点都在
  const many = [];
  for (let i = 0; i < 14; i++) { many.push(fakeOf("会话" + (i + 1), i)); }
  await inject(many, "fake0");
  console.log("  ⑤ 十四个会话（420 宽）：" + JSON.stringify(await shape()));
  await page.shot("tabclose-6-folded.png");
  // 点中间那一张窄块：切过去（说明被压住的格子照样点得到）
  const switched = await page.eval(`
    const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("current"));
    tabs[6].click();
    return true;
  `);
  await page.sleep(800);
  console.log("  ⑤ 点了一张窄块之后，当前是：" + JSON.stringify(await page.eval(`
    const t = document.querySelector("#sessionTabs .sn-tab.current");
    return t ? t.querySelector(".sn-text").textContent : "";
  `)) + "（真的点下去了：" + switched + "）");

  await setWidth(1000);
  await inject(fake, "fake0");
  console.log("  ⑥ 同样的五个会话（1000 宽）：" + JSON.stringify(await shape()));
  await page.shot("tabclose-5-wide.png");
};

// 顶条那一排格的名字后面那颗 × ，以及排尾那颗 ▾ 什么时候露面。
//
//   FAKEPI_THINK_MS=6000 npm run web:shot -- --fake-pi --width 900 --height 500 --script dev/tabClose.js
//
// 验四件事：
//   ① 两个会话、放得下：每格名字后面都有一颗 ×，排尾那颗 ▾ 不露面（点开也没别的可挑）
//   ② 点闲着的那个会话的 ×：一下就关掉那一个（不用确认）
//   ③ 会话正在跑时点 ×：那一格变红、叉换成勾，这一下不关；再点一下才关
//   ④ 顶条放不下（窗口窄、会话多）：▾ 露面，藏起来的那几格在它的清单里；窗口放宽、全放得下时 ▾ 又收起来
// 图落在 dev/shots/（名字带 tabclose-）。
module.exports = async (page) => {
  await page.waitReady();
  // 刚连上那会儿后端还会推一两次会话列表，等它落定再动
  await page.sleep(1200);

  /** 顶条现状：几格、藏了几格、每格叫什么、哪一格在等确认、每颗叉画的是叉还是勾、▾ 露没露。 */
  const bar = () => page.eval(`
    const row = document.getElementById("sessionTabs");
    const caret = document.getElementById("sessionMore");
    const tabs = [...row.querySelectorAll(".sn-tab")];
    const dots = tabs.map((t) => {
      const c = t.querySelector(".sn-close");
      if (!c) { return "没叉"; }
      const p = c.querySelector("path");
      const d = p ? p.getAttribute("d") : "";
      return d.indexOf("M2.6") === 0 ? "勾" : (d.indexOf("M2.5") === 0 ? "叉" : "?");
    });
    return {
      格数: tabs.length,
      藏起来: tabs.filter((t) => t.classList.contains("tab-hidden")).length,
      名字: tabs.map((t) => (t.querySelector(".sn-text") || {}).textContent || ""),
      当前: tabs.map((t) => t.classList.contains("current")),
      等确认: tabs.map((t) => t.classList.contains("closing")),
      叉: dots,
      "▾": !caret.classList.contains("hidden"),
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

  // ④ 放不下：拿假会话顶一屏（只验画得对不对，不点它们）
  const names = ["写顶条那颗叉", "把会话列表重排一遍", "查一下会话文件写到哪儿", "跑测试", "收尾提交"];
  const fake = names.map((name, i) => ({
    id: "fake" + i, name, cwd: "dev/.scratch", file: "", title: "", parentId: null,
    streaming: false, loading: false, activity: "idle", activityDetail: "", piReady: true,
    modelId: "fake/model", provider: "fake", thinkingLevel: "medium", taba: null,
  }));
  const inject = async (list, activeId) => {
    const msgs = [{ type: "sessionList", sessions: list }, { type: "sessionActivated", sessionId: activeId }];
    await page.eval(`for (const m of ${JSON.stringify(msgs)}) { window.postMessage(m, "*"); } return true;`);
    await page.sleep(400);
  };
  await setWidth(420);
  await inject(fake, "fake0");
  await say("④ 五个会话（420 宽）");
  await page.shot("tabclose-4-narrow.png");
  await setWidth(1000);
  await inject(fake, "fake0");
  await say("④ 同样的五个会话（1000 宽）");
  await page.shot("tabclose-5-wide.png");
};

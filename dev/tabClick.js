// 顶条那排会话格用鼠标点：一下就该切过去，不管按下那一瞬间后端有没有推会话列表。
//
//   npm run web:shot -- --fake-pi --width 900 --height 500 --script dev/tabClick.js
//
// 用 CDP 的 Input.dispatchMouseEvent 按（跟真人按下一模一样），不是 el.click() ——
// 那一下会不会被浏览器吞掉，只有真按下去才看得出来。
//
// 验四件事：
//   ① 老老实实点一格：切过去，只有一屏露着
//   ② 按下之后、松开之前，后端推一遍会话列表（名字、小点都可能跟着变）：这一下照样算数
//      （以前这里会把每一格从 DOM 里摘下来再插回去，浏览器就把这一下点击当没点了 —— 得再点一次）
//   ③ 推的那份列表里名字变长了（整排格子的位置跟着挪）：照样切过去
//   ④ 挤成窄块（窗口窄）：点窄块那颗点，照样切过去
const { openSessionIn } = require("./harness.js");

const TABS = `
    const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden"));
    return tabs.map((t) => {
        const r = t.getBoundingClientRect();
        return {
            name: (t.querySelector(".sn-text") || {}).textContent || "",
            current: t.classList.contains("current"),
            strip: t.classList.contains("strip"),
            x: Math.round(r.left + Math.min(t.classList.contains("strip") ? 6 : r.width / 2, r.width / 2)),
            y: Math.round(r.top + r.height / 2),
        };
    });
`;

const ACTIVE = `
    const shown = [...document.querySelectorAll(".session-view:not(.off)")];
    return { id: shown.length === 1 ? shown[0].dataset.sessionId : "", shown: shown.length };
`;

module.exports = async (page) => {
  const mouse = (type, x, y) => page.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  const tabs = async () => JSON.parse(await page.eval(`return JSON.stringify((function(){${TABS}})())`));
  const active = async () => JSON.parse(await page.eval(`return JSON.stringify((function(){${ACTIVE}})())`));
  const other = async () => (await tabs()).find((t) => !t.current);
  const setWidth = async (w) => {
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 500, deviceScaleFactor: 1, mobile: false });
    await page.sleep(400);
  };

  let failed = 0;
  /** 点一格：between 是按下之后、松开之前干的事（模拟后端正好在这会儿推东西）。 */
  const clickTab = async (what, between) => {
    const t = await other();
    if (!t) { console.log(`  ★ ${what}：条上没有别的格可点`); failed++; return; }
    const before = await active();
    await mouse("mousePressed", t.x, t.y);
    await page.sleep(40);
    if (between) { await between(); }
    await page.sleep(20);
    await mouse("mouseReleased", t.x, t.y);
    await page.sleep(600);
    const after = await active();
    const ok = !!after.id && after.id !== before.id && after.shown === 1;
    if (!ok) { failed++; }
    console.log(`  ${ok ? "好" : "★ 没切"}　${what}：点「${t.name}」${t.strip ? "（窄块）" : ""}`
      + `　${String(before.id).slice(-4)} → ${String(after.id).slice(-4)}　露着 ${after.shown} 屏`);
  };

  await page.waitReady();
  await page.sleep(1200);
  // 三个会话：先发一句（假模型秒回），再点两次「项目与会话」里行尾那颗加号开两个
  // （「＋」是 pi 里的 /new，会把闲着的旧会话收掉）
  await page.send("第一个会话里说的话");
  await page.sleep(1500);
  await openSessionIn(page);
  await page.sleep(800);
  await openSessionIn(page);
  await page.sleep(1500);
  console.log("  条上 " + (await tabs()).length + " 格");

  // 后端真推过来的那份会话列表留一份（②③ 要拿它再推一遍）
  await page.eval(`
    window.__list = null;
    window.addEventListener("message", (e) => {
        if (e.data && e.data.type === "sessionList") { window.__list = e.data; }
    });
    return true;
  `);
  await page.send("再来一句");
  await page.sleep(1500);
  const haveList = await page.eval(`return !!(window.__list && window.__list.sessions && window.__list.sessions.length);`);
  console.log("  留住了一份会话列表：" + (haveList ? "是" : "★ 没有"));
  if (!haveList) { failed++; }

  // ① 普通点击
  await clickTab("① 普通点击");
  await clickTab("① 普通点击");

  // ② 按下之后推一遍同一份列表（跑完一轮、切换、子会话起落时后端就是这么推的）
  const pushSame = () => page.eval(`window.dispatchEvent(new MessageEvent("message", { data: window.__list })); return true;`);
  await clickTab("② 按下后推一遍会话列表", pushSame);
  await clickTab("② 按下后推一遍会话列表", pushSame);

  // ③ 推的那份列表里名字变长（整排要重摆一次，位置会挪）
  const pushLongName = () => page.eval(`
    const copy = JSON.parse(JSON.stringify(window.__list));
    copy.sessions.forEach((s, i) => { s.name = s.name + "（名字变长了一截）"; });
    window.dispatchEvent(new MessageEvent("message", { data: copy }));
    return true;
  `);
  await clickTab("③ 按下后推一遍名字变长的列表", pushLongName);

  // ④ 挤成窄块：窗口收窄，除了当前那一格别的都收成一颗点
  await setWidth(420);
  await page.sleep(500);
  const strips = (await tabs()).filter((t) => t.strip).length;
  console.log("  收窄到 420：窄块 " + strips + " 个");
  await clickTab("④ 点窄块");
  await clickTab("④ 点窄块");

  console.log(failed ? `★ 有 ${failed} 处不对` : "全过");
  if (failed) { throw new Error("tabClick：" + failed + " 处不对"); }
};

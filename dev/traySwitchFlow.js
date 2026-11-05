// 右下角弹窗「点了跳过去」的验证流程，配 npm run web:shot -- --fake-pi --script dev/traySwitchFlow.js 用：
//   1. A 会话发一句 → B 会话发一句（openSessionIn 开的），人停在 B 上
//   2. 学弹窗点击的后端那一半：trayOpenRequested(A 的标识) —— 所有页面都该切回 A 那一格
//   3. 同一件事走 HTTP 那条路：POST /switch（别的机器点了弹窗、把「切会话」发过来时走的路）
//   4. 顺手验一下缺字段的请求该被拒（400）
// 弹托盘卡片、真的用鼠标点那一步归 dev/trayClickTest.js（要把窗口拉到前台，得真点）。
const { openSessionIn } = require("./harness.js");

module.exports = async (page, extras) => {
  const host = extras && extras.host;
  if (!host) { throw new Error("这个脚本要拿 harness 的 host()（后端宿主），别用 --url 连外面的服务跑。"); }

  const visibleText = () => page.eval(`
    const view = document.querySelector(".session-view:not(.off)");
    return view ? view.innerText : "";
  `);
  const expectVisible = async (marker, what) => {
    await page.sleep(1200);
    const text = await visibleText();
    if (text.indexOf(marker) < 0) {
      throw new Error(what + " 之后，正看着的那格该有「" + marker + "」：「" + text.slice(0, 120) + "」");
    }
    console.log("✓ " + what);
  };

  // 两个会话，各留一句好认的话；人停在 B 上
  await page.send("第一个会话：弹窗跳转");
  await page.sleep(3000);
  await openSessionIn(page);
  await page.sleep(1000);
  await page.send("第二个会话：弹窗跳转");
  await page.sleep(3000);
  await expectVisible("第二个会话", "起手该停在 B");

  // A、B 的会话标识（按创建先后，A 在前）
  const ids = Array.from(host.panels.keys());
  if (ids.length < 2) { throw new Error("后端该有两个会话，实际：" + ids.length); }
  const aId = ids[0];
  const bId = ids[1];
  console.log("会话：A=" + aId + "  B=" + bId);

  // 学托盘点击的后端那一半：本地会话 → 广播切过去
  host.trayOpenRequested(aId, true);
  await expectVisible("第一个会话", "trayOpenRequested(A)");

  // HTTP 那条路（别的机器点弹窗 → 那台 POST /switch 过来）
  const url = extras.url.replace(/\/+$/, "");
  const res = await fetch(url + "/switch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: bId }),
  });
  if (!res.ok) { throw new Error("POST /switch 该成功，实际 " + res.status); }
  await expectVisible("第二个会话", "POST /switch(B)");

  // 缺 sessionId 的该被拒
  const bad = await fetch(url + "/switch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (bad.status !== 400) { throw new Error("缺 sessionId 该回 400，实际 " + bad.status); }
  console.log("✓ 缺 sessionId 回 400");

  await page.shot("tray-switch-flow.png");
};

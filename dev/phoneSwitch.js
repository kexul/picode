// 手机点通知进来时不整页重来：页面已经在，就只叫它在页面里切一格
// （`window.pichatSwitchSession`，见 android/ 里 MainActivity 的 openPage）。
//
//   npm run web:shot -- --fake-pi --script dev/phoneSwitch.js
//
// 验的就是 app 那一下会不会打成“整页重载”：先在页面上留一个只有同一个文档才有的记号，
// 叫它切会话，切过去以后记号还得在（重载就没了）、会话确实换了、原来那格盖上了 .off。
const { openSessionIn } = require("./harness.js");

module.exports = async (page) => {
  await page.waitReady();
  await page.sleep(1200);

  // 造出第二个会话（顶条上就有两格了），此时看着的是新的那个
  await openSessionIn(page);
  await page.sleep(1200);

  const views = () => page.eval(`
    return Array.from(document.querySelectorAll(".session-view")).map((v) => ({
      id: v.dataset.sessionId,
      off: v.classList.contains("off"),
    }));
  `);

  const hook = await page.eval(`return typeof window.pichatSwitchSession;`);
  if (hook !== "function") { throw new Error("页面上没有 window.pichatSwitchSession（不是 " + hook + "）"); }

  const before = await views();
  if (before.length < 2) { throw new Error("顶条上只有一格，验不了切换：" + JSON.stringify(before)); }
  const active0 = before.filter((v) => !v.off).map((v) => v.id);
  const target = before.filter((v) => v.off).map((v) => v.id);
  if (active0.length !== 1 || !target.length) { throw new Error("看不出现在看的是哪一格：" + JSON.stringify(before)); }
  console.log(`  · 现在看的是 ${active0[0]}，要切到 ${target[0]}`);

  // 只有同一个文档才带得住的记号：整页重载以后就没了
  await page.eval(`window.__phoneMark = "kept"; return true;`);
  // app 那一下就是这么调的
  const called = await page.eval(`window.pichatSwitchSession(${JSON.stringify(target[0])}); return true;`);
  if (called !== true) { throw new Error("调不动 pichatSwitchSession"); }
  await page.sleep(1500);

  const mark = await page.eval(`return window.__phoneMark || "";`);
  if (mark !== "kept") { throw new Error("页面被整个重载了（记号没了）"); }

  const after = await views();
  const active1 = after.filter((v) => !v.off).map((v) => v.id);
  if (active1.length !== 1 || active1[0] !== target[0]) {
    throw new Error("没切过去：原来是 " + active0[0] + "，要的是 " + target[0] + "，现在看着 " + JSON.stringify(active1));
  }

  // 切回来也一样（来回都走这一条路）
  await page.eval(`window.pichatSwitchSession(${JSON.stringify(active0[0])}); return true;`);
  await page.sleep(1000);
  const back = await views();
  const active2 = back.filter((v) => !v.off).map((v) => v.id);
  if (active2.length !== 1 || active2[0] !== active0[0]) {
    throw new Error("切不回去：要的是 " + active0[0] + "，现在看着 " + JSON.stringify(active2));
  }
  const mark2 = await page.eval(`return window.__phoneMark || "";`);
  if (mark2 !== "kept") { throw new Error("切回来以后页面被整个重载了（记号没了）"); }

  await page.shot("phone-switch.png");
  console.log("  · 好：切过去了，页面没重载（记号还在）");
};

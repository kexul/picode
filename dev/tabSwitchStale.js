// @ts-nocheck
/**
 * tabSwitchStale —— 「切到哪个会话」那几条确认过期时，画面不能照着它往回跳。
 *
 *   npm run web:shot -- --fake-pi --script dev/tabSwitchStale.js
 *
 * 两个都是“手比回话快”撞出来的：
 *   ① 连按两下切换：第二下按下去时，第一下的确认还在路上；它回来时人已经到了第二格，
 *      照着它切回去就是“在第一格停一下才过去”。
 *   ② 手机上网络不好、断线重连：切换请求还在排队重发，后端把“它记着的、你在看的那个”再说一遍；
 *      照着它切回去就是“切过去又跳回原来那一格”。
 *
 * 一条环回十几毫秒，这两件事在本地根本撞不上（手速永远比它慢），所以这里把后端办 switchSession
 * 那一步压后（见下面 delay）：意思就是“回话比手慢”，跟真机上一样，只是可控。
 */
const { openSessionIn } = require("./harness.js");

/** 压后后端办切换请求的毫秒数；step 是第二条比第一条再晚多少（保证几条回话的先后不乱）。 */
const delay = { base: 0, step: 0, n: 0 };
(function patchBackend() {
  const { ChatHost } = require("../out/server/chatHost.js");
  const orig = ChatHost.prototype.processPageMessage;
  ChatHost.prototype.processPageMessage = function (msg, pageId) {
    if (delay.base > 0 && msg && msg.type === "switchSession") {
      const after = delay.base + delay.n * delay.step;
      delay.n += 1;
      setTimeout(() => orig.call(this, msg, pageId), after);
      return;
    }
    orig.call(this, msg, pageId);
  };
})();

module.exports = async (page) => {
  const shown = () => page.eval(`
    const el = document.querySelector(".session-view:not(.off)");
    return el ? el.dataset.sessionId : "";
  `);
  const short = (id) => String(id).slice(-4);
  const press = (key, vk) => page.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key, code: key, modifiers: 3,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  }).then(() => page.cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key, code: key, modifiers: 3,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  }));
  const prevKey = () => press("ArrowLeft", 37);

  await page.waitReady();
  await page.sleep(1200);
  await openSessionIn(page);
  await page.sleep(1200);
  await openSessionIn(page);
  await page.sleep(1500);

  /** 装一本账：画面换成哪个会话、收到哪些确认（带不带 replay / 第几号）。 */
  await page.eval(`
    window.__trace = [];
    const now = function () { return Math.round(performance.now() - window.__t0); };
    window.__t0 = performance.now();
    window.__watch = function () {
      window.addEventListener("message", function (e) {
        const d = e.data || {};
        if (d.type === "sessionActivated") {
          window.__trace.push([now(), "确认 " + String(d.sessionId).slice(-4)
            + (d.replay ? " replay" : "") + (d.switchId ? " #" + d.switchId : "")]);
        }
      }, true);
      const api = window.acquireVsCodeApi();
      const realPost = api.postMessage;
      api.postMessage = function (m) {
        if (m && m.type === "switchSession") {
          window.__trace.push([now(), "发出 " + String(m.sessionId).slice(-4) + (m.switchId ? " #" + m.switchId : "")]);
        }
        return realPost.call(api, m);
      };
      let last = "";
      (function tick() {
        const el = document.querySelector(".session-view:not(.off)");
        const key = "画 " + (el ? el.dataset.sessionId.slice(-4) : "");
        if (key !== last) { last = key; window.__trace.push([now(), key]); }
        if (now() < 30000) { requestAnimationFrame(tick); }
      })();
    };
    window.__watch();
    return true;
  `);
  const tracer = async (label) => {
    const lines = await page.eval("return window.__trace");
    console.log(`  ${label}：`);
    for (const line of lines) { console.log("     ", line[0], line[1]); }
    return lines;
  };
  const reset = () => page.eval("window.__trace.length = 0; return true;");
  /** 按时间顺序，画面到过哪几个会话。 */
  const visited = (lines) => lines.filter((l) => l[1].indexOf("画 ") === 0).map((l) => l[1].slice(2));

  // ---- ① 连按两下：第一下的确认回来得比手慢 ----
  console.log("\n【① 连按两下切换】后端回话压后 300 / 520 毫秒");
  delay.base = 300;
  delay.step = 220;
  delay.n = 0;
  await reset();
  const from = await shown();
  await prevKey();
  await page.sleep(120);
  await prevKey();
  const want = await shown();
  await page.sleep(2500);
  let lines = await tracer("记录");
  let went = visited(lines);
  console.log(`  起点 ${short(from)} → 按两下 → 停在 ${short(want)}；画面经过：${went.join(" → ")}`);
  // 到了该到的那一格之后，画面不该再回别处去（哪怕后来又回到这一格 —— 中间那一下就是“停一会儿”）
  const first = went.indexOf(short(want));
  const backJump = first >= 0 && went.slice(first + 1).some((id) => id !== short(want));
  if (await shown() !== want) { throw new Error("最后停的不是按两下该到的那个会话"); }
  if (backJump) { throw new Error("画面又退回前面那一格去了（旧确认把画面拽回去了）"); }
  console.log("  ✔ 画面直接到第二格，没退回第一格");

  // ---- ② 切换请求还在路上时断线重连：后端把旧的那个再说一遍 ----
  console.log("\n【② 请求在路上时断线重连】后端回话压后 1500 毫秒，期间推送连接重开");
  delay.base = 1500;
  delay.step = 200;
  delay.n = 0;
  await page.sleep(500);
  await reset();
  const before = await shown();
  await prevKey();
  await page.sleep(300);
  const to = await shown();
  console.log(`  ${short(before)} 按一下 → ${short(to)}（请求还在路上），模拟推送连接重开`);
  await page.eval(`window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); return true;`);
  await page.sleep(4000);
  lines = await tracer("记录");
  went = visited(lines);
  const after = await shown();
  console.log(`  画面经过：${went.join(" → ")}，最后停在 ${short(after)}`);
  if (after !== to) { throw new Error(`画面跳回 ${short(after)} 去了（应该是 ${short(to)}）`); }
  const jumped = went.slice(went.indexOf(short(to)) + 1).some((id) => id !== short(to));
  if (jumped) { throw new Error("重连接回画面时，旧的那一条把画面拽回去了"); }
  const replayAt = lines.findIndex((l) => l[1].indexOf("确认 " + short(before) + " replay") === 0);
  // 重连那一条之后又发了一条给“自己看着的这个”会话（这一趟只按了一下，所以看这个会话的请求该有两条）
  const asked = lines.filter((l) => l[1].indexOf("发出 " + short(to)) === 0);
  const reAsked = replayAt >= 0 && asked.length >= 2 && asked[asked.length - 1][0] >= lines[replayAt][0] - 50;
  if (!reAsked) { throw new Error("没有把“自己看着的那个”再报给后端（后端那头会一直记着旧的那个）"); }
  console.log("  ✔ 画面没跳回去，而且把自己的选择又报给了后端一遍");
  console.log("\n过期的那几条确认不再作数。");
};

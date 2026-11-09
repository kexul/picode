// 双击名字改会话名（顶条那一格、「项目与会话」里「正在对话」那一行，同一个手势）。
//
//   npm run web:shot -- --fake-pi --width 1100 --height 700 --script dev/renameSession.js
//
// 用 CDP 的真鼠标双击（Input.dispatchMouseEvent 连按两下，clickCount 1 然后 2），不是
// el.dispatchEvent(new MouseEvent("dblclick"))——那一下会不会被浏览器当成缩放 / 被别的手势吃掉，
// 只有真按下去才看得出来。
//
// 验五件事：
//   ① 双击当前那一格的名字：名字变成输入框，且已经选中（直接打字就是覆盖）；回车改好，
//      顶条那一格的字立刻换成新的
//   ② 刷新页面（等于后端重启、换台机器打开）：名字还是新的（说明真写进了会话文件，不是只在内存里）
//   ③ Esc 不算：改了字按 Esc，名字一个字都不变
//   ④ 双击「不是当前那一格」的格子：只切过去，不改名（也不弹输入框）
//   ⑤ 「项目与会话」里「正在对话」那一行：双击同样能改，改完那一行、顶条那一格一起换
//
// 不验的一条：改完再跑一轮对话，自动起标题会不会把手改的名字盖回去。那个扩展只在真 pi 里加载
// （假模型没有它），要验就得真给模型发消息，所以这里不验；保证它不覆盖的是
// src/titleBridgeSource.ts 里那句判断（现在的名字不是自己起的就一次都不动）。
const { openSessionIn } = require("./harness.js");

const TABS = `
    const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden"));
    return tabs.map((t) => {
        const text = t.querySelector(".sn-text");
        const r = (text || t).getBoundingClientRect();
        return {
            name: text ? text.textContent : "",
            current: t.classList.contains("current"),
            x: Math.round(r.left + Math.min(40, r.width / 2)),
            y: Math.round(r.top + r.height / 2),
        };
    });
`;

const INPUT = `
    const input = document.querySelector(".sn-rename");
    if (!input) { return ""; }
    return JSON.stringify({
        value: input.value,
        focused: document.activeElement === input,
        selectedAll: input.selectionStart === 0 && input.selectionEnd === input.value.length,
    });
`;

module.exports = async (page) => {
  await page.waitReady();
  await page.sleep(600);

  let failed = 0;
  const bad = (what) => { failed++; console.log(`  ★ ${what}`); };
  const tabs = async () => JSON.parse(await page.eval(`return JSON.stringify((function(){${TABS}})())`));
  const currentName = async () => {
    const list = await tabs();
    const cur = list.find((t) => t.current);
    return cur ? cur.name : "";
  };
  const inputState = async () => {
    const raw = await page.eval(`return (function(){${INPUT}})()`);
    return raw ? JSON.parse(raw) : null;
  };
  /** 真鼠标双击（两下，第二下 clickCount 是 2，浏览器才认成 dblclick）。 */
  const dblclick = async (x, y) => {
    for (const clickCount of [1, 2]) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await page.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount });
      }
      await page.sleep(30);
    }
  };
  /** 打一段字（输入框已经聚焦，insertText 等于真人敲字，输入法 / 粘贴也不跳过）。 */
  const typeInto = async (text) => {
    await page.cdp.send("Input.insertText", { text });
    await page.sleep(80);
  };
  const pressEnter = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await page.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    await page.sleep(400);
  };
  const pressEsc = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await page.cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    }
    await page.sleep(300);
  };

  const before = await currentName();
  console.log(`  当前这一格叫：${before}`);

  // ---- ① 双击 → 输入 → 回车 ----
  const cur = (await tabs()).find((t) => t.current);
  await dblclick(cur.x, cur.y);
  await page.sleep(200);
  const opened = await inputState();
  if (!opened) { bad("双击名字没弹出输入框"); }
  else {
    if (opened.value !== before) { bad(`输入框里的初值不是现在的名字（拿到「${opened.value}」）`); }
    if (!opened.focused) { bad("输入框没拿到焦点（接着打字打不进去）"); }
  }
  await page.shot("rename-1-input.png");

  await typeInto("改好的名字");
  await pressEnter();
  await page.sleep(500);
  const renamed = await currentName();
  if (renamed !== "改好的名字") { bad(`回车之后顶条那一格还是「${renamed}」，不是「改好的名字」`); }
  else { console.log("  好：回车后顶条那一格变成「改好的名字」"); }
  if (await inputState()) { bad("回车之后输入框还在（没收起来）"); }
  await page.shot("rename-2-renamed.png");

  // ---- ② 刷新页面：名字是从会话文件读回来的 ----
  await page.cdp.send("Page.reload", { ignoreCache: false });
  await page.waitReady();
  await page.sleep(1200);
  const afterReload = await currentName();
  if (afterReload !== "改好的名字") { bad(`刷新之后名字变回「${afterReload}」了（没写进会话文件）`); }
  else { console.log("  好：刷新页面后还是「改好的名字」"); }

  // ---- ③ Esc 不算 ----
  const cur2 = (await tabs()).find((t) => t.current);
  await dblclick(cur2.x, cur2.y);
  await page.sleep(200);
  if (!(await inputState())) { bad("第二次双击没弹出输入框"); }
  await typeInto("这个名字不要");
  await pressEsc();
  const afterEsc = await currentName();
  if (afterEsc !== "改好的名字") { bad(`按 Esc 之后名字变成了「${afterEsc}」（应该一点不变）`); }
  else { console.log("  好：Esc 之后名字一个字都没变"); }
  if (await inputState()) { bad("按 Esc 之后输入框还在"); }

  // ---- ④ 双击不是当前那一格：只切过去，不改名 ----
  await openSessionIn(page);
  await page.sleep(2000);
  const list = await tabs();
  const other = list.find((t) => !t.current);
  if (!other) {
    bad("第二个会话没开出来（顶条上只有一格），④ 验不了");
  } else {
    const beforeAll = (await tabs()).map((t) => t.name).join("|");
    await dblclick(other.x, other.y);
    await page.sleep(600);
    const afterList = await tabs();
    const nowCurrent = afterList.find((t) => t.current);
    if (!nowCurrent || nowCurrent.name !== other.name) { bad(`双击别的格没切过去（当前的是「${nowCurrent ? nowCurrent.name : "没有"}」）`); }
    if (await inputState()) { bad("双击不是当前那一格，却弹出了输入框（不该改名）"); }
    if (afterList.map((t) => t.name).join("|") !== beforeAll) { bad("双击不是当前那一格，名字却变了"); }
    else if (!(await inputState())) { console.log("  好：双击别的格只切过去，两个名字都没动"); }
  }

  // ---- ⑤ 「项目与会话」里那一行也能改 ----
  // 那一列可能是常驻的、也可能是抽屉：先看看「正在对话」那几行眼下摆着没有（有宽高才算），
  // 没摆着就点顶条右边那颗按钮把它摊开。
  const rowsNow = async () => JSON.parse(await page.eval(`
        const rows = [...document.querySelectorAll(".pk-item.pk-open")];
        return JSON.stringify(rows.map((r) => {
            const t = r.querySelector(".pk-history-title");
            const rect = t ? t.getBoundingClientRect() : null;
            return {
                name: t ? t.textContent : "",
                shown: !!(rect && rect.width > 0),
                x: rect ? Math.round(rect.left + Math.min(30, rect.width / 2)) : 0,
                y: rect ? Math.round(rect.top + rect.height / 2) : 0,
            };
        }));
    `) || "[]");
  let rows = await rowsNow();
  if (!rows.some((r) => r.shown)) {
    await page.eval(`const b = document.getElementById("browserMenuBtn"); if (b) { b.click(); } return true;`);
    await page.sleep(700);
    rows = await rowsNow();
  }
  const target = rows.find((r) => r.name === "改好的名字");
  if (!target) {
    bad(`「正在对话」那几行里没找到「改好的名字」（拿到的是：${JSON.stringify(rows.map((r) => r.name))}）`);
  } else {
    await dblclick(target.x, target.y);
    await page.sleep(250);
    if (!(await inputState())) { bad("在面板那一行上双击，没弹出输入框"); }
    else {
      await page.shot("rename-3-panel-input.png");
      await typeInto("清单里改的名字");
      await pressEnter();
      await page.sleep(600);
      const again = JSON.parse(await page.eval(`
                return JSON.stringify([...document.querySelectorAll(".pk-item.pk-open .pk-history-title")].map((t) => t.textContent));
            `) || "[]");
      if (!again.includes("清单里改的名字")) { bad(`面板那一行没改成（拿到的是：${JSON.stringify(again)}）`); }
      else if (!(await tabs()).some((t) => t.name === "清单里改的名字")) {
        bad("面板那一行改了，但顶条那一格没跟着变");
      } else { console.log("  好：面板那一行双击能改，顶条那一格跟着变"); }
    }
  }
  await page.shot("rename-4-panel.png");

  console.log(failed === 0 ? "  —— 五条全过" : `  —— ${failed} 条没过`);
  if (failed > 0) { process.exitCode = 1; }
};

// 派子会话（taba）的界面流程，配 npm run web:shot -- --fake-pi --script dev/tabaFlow.js 用。
//
// 假 pi 的行为：用户这句话里带“派活”就往 stderr 发一条暗号，插件据此派一个子会话（见 dev/fakePi.js）。
// 这里验两件事：
//   1. 子会话跑完第一轮 → 结果交回派活的会话，子会话那个 tab 自动关掉（列表里那行没了）
//   2. 用户进去看着它跑 → 跑完不关（那行还在，子会话里能看到“你这个会话还留着”）
//
// 那份「项目与会话」画在哪儿都认：宽窗（≥ 900px）是右边常驻那一列，窄窗才是顶上那颗 <<< 拉出来的浮层。
//
// 慢一点跑（假 pi 的节奏，免得子会话在点进去之前就跑完了）：
//   FAKEPI_THINK_MS=900 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaFlow.js
module.exports = async (page) => {
  /** 「项目与会话」画在哪一块：宽窗（≥ 900px）是右边常驻那一列，窄窗才是浮层。
   *  取行、算“看得见”两处都要用（常驻那一列收起时给它 display:none，不是加 hidden 类）。 */
  const ROOT_EXPR = `(function () {
    const dock = document.getElementById("sidebarDock");
    return (dock && getComputedStyle(dock).display !== "none") ? "#dockBody" : "#pickerBody";
  })()`;

  /** 面板看得见吗：常驻那一列（display 不是 none）或者浮层（没盖着 hidden）。 */
  const panel = () => page.eval(`
    const dock = document.getElementById("sidebarDock");
    const dockShown = !!dock && getComputedStyle(dock).display !== "none";
    return { shown: dockShown || !document.getElementById("pickerOverlay").classList.contains("hidden"), dock: dockShown };
  `);

  /** 「正在对话」那段的行：叫什么、是不是子会话（从正在画的那一块上取）。 */
  const openRows = () => page.eval(`
    const root = ${ROOT_EXPR};
    return Array.from(document.querySelectorAll(root + " .pk-item.pk-open")).map((el) => {
      const t = el.querySelector(".pk-history-title");
      return { label: t ? t.textContent.trim().slice(0, 24) : "", child: el.classList.contains("pk-open-child") };
    });
  `);

  /** 反复试到 fn 返回真值为止。 */
  const until = async (what, fn, ms = 40000) => {
    const started = Date.now();
    for (;;) {
      const v = await fn();
      if (v) { return v; }
      if (Date.now() - started > ms) { throw new Error("等不到：" + what); }
      await page.sleep(200);
    }
  };

  /** 面板看得见就行：宽窗本来就常驻在右边；窄窗才要点顶上那颗 <<< 把它拉出来。
   *  点完核对一下真看到了（界面改过就改这里，别让后面几步对着一个没开的面板干等）。 */
  const openPicker = async () => {
    if (!(await panel()).shown) { await page.click("#browserMenuBtn"); }
    for (let i = 0; i < 25; i++) {
      if ((await panel()).shown) { return; }
      await page.sleep(200);
    }
    throw new Error("面板没打开（顶上那颗 <<< 的行为变了？）");
  };

  /** 把面板收起来：浮层那份按 Esc（面板头上那颗叉的提示语里写着「关闭 (Esc)」），
   *  常驻那一列不吃 Esc，点一下 <<< 收起来（回头 openPicker 再拉回来）。
   *  关不掉就报错 —— 以前这里点的是一个已经不存在的 id，空点一下、什么都不报，
   *  后面几步就对着一个已经收起来的面板干等。 */
  const closePicker = async () => {
    const p = await panel();
    if (!p.shown) { return; }
    if (p.dock) { await page.click("#browserMenuBtn"); } else { await page.press("Escape"); }
    await page.sleep(400);
    if ((await panel()).shown) { throw new Error("面板没收起来"); }
  };

  // ---- 1. 派活：子会话出现在「正在对话」里（缩进一行） ----
  await page.send("派活：看看认证模块");
  await openPicker();
  const spawned = await until("子会话出现在「正在对话」里", async () => {
    const rows = await openRows();
    return rows.some((r) => r.child) ? rows : null;
  });
  console.log("派出后：" + JSON.stringify(spawned));
  await page.shot("taba-1-spawned.png");

  // ---- 2. 跑完第一轮：子会话那行自动消失（结果先交回，再关） ----
  await until("子会话那行自动关掉", async () => ((await openRows()).some((r) => r.child) ? null : true));
  console.log("自动关闭后：" + JSON.stringify(await openRows()));
  await page.shot("taba-2-autoclosed.png");

  // 收起列表，看派活那个会话里收到的结果（结尾那段该说“tab 已经自动关掉”）
  await closePicker();
  await page.waitText("tab 已经自动关掉", 20000);
  await page.shot("taba-3-delivered.png");

  // ---- 3. 再派一个，这次进去看着它跑：跑完不关 ----
  await page.click("#newSessionBtn");
  await page.sleep(2500);
  await page.send("派活：第二个子会话，这次进去看着它");
  await openPicker();
  const spawned2 = await until("第二个子会话出现在列表里", async () => {
    const rows = await openRows();
    return rows.some((r) => r.child) ? rows : null;
  });
  console.log("第二个派出后：" + JSON.stringify(spawned2));

  // 点子会话那一行（等于用户切过去看着它）
  const clicked = await page.eval(`
    const root = ${ROOT_EXPR};
    const el = document.querySelector(root + " .pk-item.pk-open.pk-open-child");
    if (!el) { return false; }
    el.click();
    return true;
  `);
  if (!clicked) { throw new Error("列表里找不到子会话那一行"); }
  await page.sleep(600);
  // 浮层那份点一行会顺手收起来；常驻那一列点行不关（拍出来的图要能看见子会话那一屏）
  if (!(await panel()).dock) { await closePicker(); }
  await page.shot("taba-4-watching.png");

  // 跑完：因为用户正看着，不关；子会话里该出现“结果已交回…你这个会话还留着”
  await page.waitText("你这个会话还留着", 40000);
  await page.shot("taba-5-kept.png");

  await openPicker();
  const after = await openRows();
  console.log("跑完后：" + JSON.stringify(after));
  if (!after.some((r) => r.child)) { throw new Error("用户正看着的子会话不该被自动关掉"); }
  await page.shot("taba-6-still-there.png");

  console.log("两条路都对了：没人看的自动关，正看着的留着。");
};

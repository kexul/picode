// 「切换会话」快捷键按什么顺序走：跟「项目与会话」面板里「正在对话」那一段的行序一样
// —— 主会话在前，它派出去的子会话缩进跟在它下面，一行算一格。
//
//   FAKEPI_THINK_MS=4000 npm run web:shot -- --fake-pi --script dev/tabSwitchOrder.js
//
// 按的是默认那一套 Ctrl+Alt+← / →（设置里改成别的方案的不适用）。
// 造一份「行序 ≠ 建立序」的现场（建立序 A→B→子会话→C，面板行序 A→子会话→B→C），
// 然后每按一下快捷键就核一次：当前会话在行序里正好挪了一格（走到底回绕）。
// 子会话要一直在跑（假 pi 慢一点），跑完就自动关、行序会变。
module.exports = async (page) => {
  /** 「项目与会话」画在哪一块：宽窗是右边常驻那一列，窄窗是浮层（见 dev/tabaFlow.js）。 */
  const ROOT_EXPR = `(function () {
    const dock = document.getElementById("sidebarDock");
    return (dock && getComputedStyle(dock).display !== "none") ? "#dockBody" : "#pickerBody";
  })()`;

  /** 「正在对话」那段的行：叫什么、是不是子会话、正在看的是哪一行。 */
  const rows = () => page.eval(`
    const root = ${ROOT_EXPR};
    return Array.from(document.querySelectorAll(root + " .pk-item.pk-open")).map((el) => ({
      label: ((el.querySelector(".pk-history-title") || {}).textContent || "").trim().slice(0, 20),
      child: el.classList.contains("pk-open-child"),
      current: el.classList.contains("current"),
    }));
  `);

  /** 面板这会儿摆开了吗（没摆开就先把它叫出来，不然读不到行）。 */
  const panelShown = () => page.eval(`
    const dock = document.getElementById("sidebarDock");
    if (dock && getComputedStyle(dock).display !== "none") { return true; }
    return !document.getElementById("pickerOverlay").classList.contains("hidden");
  `);

  const until = async (what, fn, ms = 30000) => {
    const started = Date.now();
    for (;;) {
      const v = await fn();
      if (v) { return v; }
      if (Date.now() - started > ms) { throw new Error("等不到：" + what); }
      await page.sleep(200);
    }
  };

  /** 真按一下快捷键（走浏览器的按键事件，跟人手按一样）：修饰键 Alt=1、Ctrl=2。 */
  const press = (key, code, vk) => page.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key, code, modifiers: 3,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  }).then(() => page.cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key, code, modifiers: 3,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  }));
  const nextKey = () => press("ArrowRight", "ArrowRight", 39);
  const prevKey = () => press("ArrowLeft", "ArrowLeft", 37);

  await page.waitReady();
  await page.sleep(1200);
  if (!(await panelShown())) {
    // 窄窗：顶上那颗 <<< 拉出「项目与会话」
    await page.click("#browserMenuBtn");
    await page.sleep(500);
  }

  // ---- 造现场：A（打开时自带）→ 建 B → 回 A 派个子会话 → 建 C ----
  await page.click("#newSessionBtn");          // B
  await page.sleep(1500);
  await page.eval(`document.getElementById("sessionName").click(); return true;`);
  await page.sleep(400);
  await page.eval(`
    const first = document.querySelector("#sessionMenu .sm-item");
    if (!first) { throw new Error("顶条那颗会话名的清单里一行都没有"); }
    first.click();
    return true;
  `);
  await page.sleep(800);

  // 在 A 里派一个子会话（假 pi 看到“派活”就往 stderr 发暗号，插件据此真派一个）
  await page.send("派活：验一下切换顺序");
  await until("子会话那一行出现", async () => {
    const list = await rows();
    return list.some((r) => r.child) ? list : false;
  }, 40000);

  await page.click("#newSessionBtn");          // C
  await page.sleep(1500);

  const list = await rows();
  console.log("行序：", JSON.stringify(list.map((r, i) => i + (r.child ? " 子" : "") + " " + r.label)));
  if (list.length !== 4) { throw new Error(`应该四行（三个主会话 + 一个子会话），实际 ${list.length} 行`); }
  const childAt = list.findIndex((r) => r.child);
  const curAt = list.findIndex((r) => r.current);
  console.log(`子会话在第 ${childAt} 行，现在看的是第 ${curAt} 行`);
  if (childAt !== 1) { throw new Error(`子会话应该缩进挂在第一个会话下面（第 1 行），实际在第 ${childAt} 行`); }
  if (curAt !== 3) { throw new Error(`刚建完会话，应该看的是最后那一行（第 3 行），实际第 ${curAt} 行`); }

  /** 连按 n 次，每次核对“当前会话在行序里挪了一格”。 */
  const walk = async (key, label, times) => {
    for (let i = 1; i <= times; i++) {
      const before = await rows();
      const from = before.findIndex((r) => r.current);
      if (from < 0) { throw new Error("没有一行标着「正在看」"); }
      await key();
      await page.sleep(700);
      const after = await rows();
      const now = after.findIndex((r) => r.current);
      const want = (from + (label === "Ctrl+Alt+→" ? 1 : -1) + after.length) % after.length;
      const names = after.map((r) => (r.child ? "  " : "") + r.label).join(" / ");
      console.log(`  ${label} 第 ${i} 下：第 ${from} 行 → 第 ${now} 行（应为第 ${want} 行）　[${names}]`);
      if (after.length !== before.length) { throw new Error("验的过程中行数变了（子会话跑完自己关了？把 FAKEPI_THINK_MS 调大点再跑）"); }
      if (now !== want) { throw new Error(`该挪到第 ${want} 行，实际到了第 ${now} 行`); }
    }
  };

  // 从最后一行（C）连按四下：回到第一行 A → 子会话 → B → C，走一整圈回到原地
  await walk(nextKey, "Ctrl+Alt+→", 4);
  await page.shot("tab-switch-1-next.png");
  await walk(prevKey, "Ctrl+Alt+←", 4);
  await page.shot("tab-switch-2-prev.png");
  console.log("切换顺序跟「正在对话」的行序一致：只按行序挪一格，不看会话建立的先后。");
};

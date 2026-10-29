// 「关闭会话」快捷键的验证（不真给模型发消息：只建两个空会话）。
//   npm run web:shot -- --fake-pi --script dev/closeShortcut.js
// 验三件事：
//   ① 设置里有一行「关闭会话」，默认停在 Alt+W（跟「新建会话」并排那一套按钮组）
//   ② 真按一下 Alt+W（走浏览器的真按键事件，不是直接调函数）→ 当前会话被关掉、切到剩下那个
//   ③ 焦点在输入框里时按也照样关（这个键不该只在消息区里管用）
// 图落在 dev/shots/：close-key-1-settings / 2-after-key / 3-from-input。
module.exports = async (page) => {
  await page.waitReady();
  await page.sleep(800);

  // 打开「项目与会话」侧边栏 → 设置，找「关闭会话」那一行
  // （宽窗里那一列本来就常驻着，再点那颗按钮反而把它收起来）
  const docked = await page.eval('return document.body.classList.contains("dock-sidebar");');
  if (!docked) { await page.click("#browserMenuBtn"); }
  await page.sleep(500);
  await page.click(".pk-footer-settings");
  await page.sleep(600);
  const row = await page.eval(`
    const rows = Array.from(document.querySelectorAll("#viewOptsRoot .vo-item"));
    const hit = rows.find((r) => (r.querySelector(".vo-label") || {}).textContent === "关闭会话");
    if (!hit) { return { found: false }; }
    const btns = Array.from(hit.querySelectorAll(".vo-group-btn")).map((b) => ({ label: b.textContent, on: b.classList.contains("on") }));
    const names = rows.map((r) => (r.querySelector(".vo-label") || {}).textContent || "");
    return { found: true, value: (btns.find((b) => b.on) || {}).label || "", btns, names };
  `);
  console.log("① 设置里那一行：", JSON.stringify(row));
  if (!row.found) { throw new Error("设置里没有「关闭会话」这一行"); }
  if (row.btns.length < 2) { throw new Error("「关闭会话」应该是一组可点选的组合键按钮"); }
  if (row.value !== "Alt+W") { throw new Error(`默认应该是 Alt+W，实际是「${row.value}」`); }
  const at = row.names.indexOf("新建会话");
  if (at < 0 || row.names.indexOf("关闭会话") !== at + 1) { throw new Error("「关闭会话」应该紧跟「新建会话」"); }
  await page.shot("close-key-1-settings.png");

  // 关掉设置浮层与侧边栏
  await page.click("#settingsOverlay");
  await page.sleep(300);
  if (!docked) { await page.click("#browserMenuBtn"); }
  await page.sleep(400);

  // 会话开着几个就看顶条那排格（会话清单那颗 ▾ 只在摆不下时才露面，别拿它数数）
  const state = () => page.eval(`
    const all = [...document.querySelectorAll("#sessionTabs .sn-tab")];
    return {
      rows: all.length,
      names: all.map((t) => (t.querySelector(".sn-text") || {}).textContent || ""),
      current: all.map((t) => t.classList.contains("current")),
    };
  `);

  // 第二个会话（第一个是打开页面时自带的那个），现在是它
  await page.click("#newSessionBtn");
  await page.sleep(1500);
  const before = await state();
  console.log("② 两个会话：", JSON.stringify(before));
  if (before.rows !== 2) { throw new Error("应该有两个会话"); }
  const kept = before.names[0];
  const gone = before.names[1];
  if (before.current[1] !== true) { throw new Error("刚新建的那个应该在正在看的位置上"); }

  // 真按键：Alt+W（modifiers: Alt=1）
  const key = (modifiers) => page.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "w", code: "KeyW", modifiers,
    windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87,
  }).then(() => page.cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "w", code: "KeyW", modifiers,
    windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87,
  }));
  await key(1);
  await page.sleep(1500);
  const after = await state();
  console.log("② 按了 Alt+W 之后：", JSON.stringify(after));
  await page.shot("close-key-2-after-key.png");
  if (after.rows !== 1) { throw new Error(`按一下应该关掉一个会话，现在剩 ${after.rows} 个`); }
  if (after.names[0] !== kept) { throw new Error(`关的应该是当前那个「${gone}」，剩下「${kept}」，实际剩「${after.names[0]}」`); }
  if (!after.current[0]) { throw new Error("剩下那个会话应该被切成正在看的"); }

  // 焦点在输入框里：照样关（关之前再开一个，这样关掉后还剩一个）
  await page.click("#newSessionBtn");
  await page.sleep(1500);
  await page.type("草稿还留在输入框里");
  await page.sleep(300);
  const focused = await page.eval("return document.activeElement && document.activeElement.id;");
  if (focused !== "input") { throw new Error(`焦点应该在输入框里，实际在 #${focused}`); }
  await key(1);
  await page.sleep(1500);
  const fromInput = await state();
  console.log("③ 输入框里按：", JSON.stringify(fromInput));
  await page.shot("close-key-3-from-input.png");
  if (fromInput.rows !== 1) { throw new Error(`焦点在输入框时也该关得掉，现在剩 ${fromInput.rows} 个`); }
};

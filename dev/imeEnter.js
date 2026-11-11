// 输入法拼字时按回车 / Esc，不能被当成「确认」与「中止」。
//
//   FAKEPI_THINK_MS=5000 npm run web:shot -- --fake-pi --width 1100 --height 700 --script dev/imeEnter.js
//
// 中文/日文/韩文输入法在拼字时，回车是把候选字贴上去，Esc 是取消这次拼音，浏览器照样发
// 普通的 keydown（isComposing 为真；Safari 提前把它复位了，那时 keyCode 是 229）。不认这两样，
// 半句话就会被发出去、改名框会提前收、设置里的框会丢掉刚打的字；更阴的是 Esc —— 它冒到
// document 上就落到「中止正在跑的一轮」那条，拼字中按一下就把跑着的生成掐了。
//
// 这里演四出（都用合成事件，不碰真输入法）：
//   ① 主输入框：拼字中回车 → 半句话不许发出去，字还得留在框里
//   ② 主输入框：平常回车 → 照常发出去，框清空
//   ③ 会话改名框：拼字中回车 → 不算改完（框还在、字还能改）；平常回车 → 才改好
//   ④ 一轮在跑的时候，在改名框里拼字中按 Esc → 这一轮不许被中止、框也不许收
//      （要看见“在跑”，得给假 pi 设 FAKEPI_THINK_MS；没设就跳过这一出）
//
// 别的几处（选择题卡片里两个回答框、文件搜索框、新建目录的名字框、设置里的文字框与数字框）
// 走的是同一道判断（media/chat.js 的 imeBusy），没在这儿一个个演：要演得先把那几个浮层
// 一层层点开，而它们挡住的都是同一条语句。
const TABS = `
    const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden"));
    return tabs.map((t) => {
        const text = t.querySelector(".sn-text");
        const r = (text || t).getBoundingClientRect();
        return { name: text ? text.textContent : "", current: t.classList.contains("current"),
                 x: Math.round(r.left + Math.min(40, Math.max(4, r.width / 2))), y: Math.round(r.top + r.height / 2) };
    });
`;

/** 拼字中的那一下回车：isComposing 为真，keyCode 是 229。 */
const IME_ENTER = (sel) => `
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) { return "no-element"; }
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true });
    Object.defineProperty(ev, "keyCode", { get() { return 229; } });
    el.dispatchEvent(ev);
    return "ok";
`;

/** 平常那一下回车。 */
const PLAIN_ENTER = (sel) => `
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) { return "no-element"; }
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return "ok";
`;

/** 拼字中的那一下 Esc（取消拼音）：同样不许冒到外头去。 */
const IME_ESC = (sel) => `
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) { return "no-element"; }
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
    Object.defineProperty(ev, "keyCode", { get() { return 229; } });
    el.dispatchEvent(ev);
    return "ok";
`;

module.exports = async (page) => {
  await page.waitReady();
  await page.sleep(800);

  let failed = 0;
  const bad = (what) => { failed++; console.log(`  \u2605 ${what}`); };
  const userMsgs = async () => Number(await page.eval(`return document.querySelectorAll(".msg.user").length`));
  const inputValue = async () => String(await page.eval(`return document.querySelector("#input").value`));
  const renameBox = async () => String(await page.eval(`
      const el = document.querySelector(".sn-rename");
      return el ? el.value + "|" + (document.activeElement === el) : "";
  `));
  const tabsNow = async () => JSON.parse(await page.eval(`return JSON.stringify((function(){${TABS}})())`));

  // ---- ① 主输入框：拼字中回车 ----
  const before = await userMsgs();
  await page.eval(`
      const t = document.querySelector("#input");
      t.focus();
      t.value = "拼字中的半句";
      t.dispatchEvent(new Event("input", { bubbles: true }));
  `);
  console.log("  ① 主输入框，拼字中按回车…");
  await page.eval(`(function(){${IME_ENTER("#input")}})()`);
  await page.sleep(900);
  const midValue = await inputValue();
  const midMsgs = await userMsgs();
  if (midMsgs !== before) { bad(`拼字中回车把消息发出去了（消息数 ${before} → ${midMsgs}）`); }
  else if (midValue !== "拼字中的半句") { bad(`拼字中回车把框里的字动了："${midValue}"`); }
  else { console.log(`  \u2713 没发出去，字还在框里`); }

  // ---- ② 主输入框：普通回车 ----
  console.log("  ② 主输入框，平常按回车…");
  await page.eval(`(function(){${PLAIN_ENTER("#input")}})()`);
  await page.sleep(1200);
  const afterMsgs = await userMsgs();
  const afterValue = await inputValue();
  if (afterMsgs <= before) { bad(`平常回车没发出去（消息数还是 ${afterMsgs}）`); }
  else if (afterValue !== "") { bad(`发出去了但框没清空："${afterValue}"`); }
  else { console.log(`  \u2713 发出去了，框清空了`); }

  // ---- ③ 会话改名框 ----
  const cur = (await tabsNow()).find((t) => t.current);
  if (!cur) { bad("没找到当前那一格会话"); }
  else {
    for (const clickCount of [1, 2]) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await page.cdp.send("Input.dispatchMouseEvent", { type, x: cur.x, y: cur.y, button: "left", clickCount });
      }
      await page.sleep(30);
    }
    await page.sleep(300);
    if (!(await renameBox())) { bad("双击没把名字变成输入框"); }
    else {
      console.log(`  ③ 改名框里拼字中按回车…`);
      await page.eval(`
          const el = document.querySelector(".sn-rename");
          el.value = "改过的名字";
          el.dispatchEvent(new Event("input", { bubbles: true }));
      `);
      await page.eval(`(function(){${IME_ENTER(".sn-rename")}})()`);
      await page.sleep(500);
      const stillOpen = await renameBox();
      if (!stillOpen) { bad(`拼字中回车把改名框收了（名字已经变成 "${(await tabsNow()).find((t) => t.current).name}"）`); }
      else {
        console.log(`  \u2713 改名框还在（"${stillOpen}"）`);
        await page.eval(`(function(){${PLAIN_ENTER(".sn-rename")}})()`);
        await page.sleep(600);
        const now = (await tabsNow()).find((t) => t.current);
        if (await renameBox()) { bad("平常回车没把改名框收起来"); }
        else if (!now || now.name !== "改过的名字") { bad(`平常回车后名字不对："${now && now.name}"`); }
        else { console.log(`  \u2713 平常回车改好了："${now.name}"`); }
      }
    }
  }

  /** 整页那一下真 Esc（走 CDP 的真键，跟人按一样）。 */
  const realEsc = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await page.cdp.send("Input.dispatchKeyEvent", {
        type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      });
    }
    await page.sleep(300);
  };
  const streaming = async () => String(await page.eval(`return (document.getElementById("ctxIcon") || { dataset: {} }).dataset.st || "";`)) === "streaming";

  // ---- ④ 一轮在跑时，改名框里「拼字中的 Esc」不许中止这一轮 ----
  if (!process.env.FAKEPI_THINK_MS) {
    console.log("  ④ （没设 FAKEPI_THINK_MS，看不到“正在跑”，跳过）");
  } else {
    console.log("  ④ 一边跑一边在改名框里拼字中按 Esc…");
    await page.send("随便演示一下");
    let running = false;
    for (let i = 0; i < 100; i++) {
      if (await streaming()) { running = true; break; }
      await page.sleep(100);
    }
    if (!running) { bad("这一轮没跑起来（等不到 streaming）"); }
    else {
      // 再双击一次改名框（前面那一出已经改完收起来了）
      const again = (await tabsNow()).find((t) => t.current);
      for (const clickCount of [1, 2]) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await page.cdp.send("Input.dispatchMouseEvent", { type, x: again.x, y: again.y, button: "left", clickCount });
        }
        await page.sleep(30);
      }
      await page.sleep(300);
      if (!(await renameBox())) { bad("第二次双击没把名字变成输入框"); }
      else {
        await page.eval(`(function(){${IME_ESC(".sn-rename")}})()`);
        await page.sleep(400);
        if (!(await streaming())) { bad("拼字中按 Esc 把正在跑的那一轮中止了"); }
        else if (!(await renameBox())) { bad("拼字中按 Esc 把改名框收了"); }
        else { console.log(`  \u2713 这一轮还在跑，改名框也还在`); }
        // 平常 Esc：只收改名框，也不许顺手中止这一轮
        await realEsc();
        await page.sleep(400);
        if (await renameBox()) { bad("平常 Esc 没把改名框收起来"); }
        else if (!(await streaming())) { bad("改名框里按 Esc 把正在跑的那一轮中止了（这一条键该只收改名框）"); }
        else { console.log(`  \u2713 平常 Esc 只收了改名框，这一轮照旧在跑`); }
      }
    }
    // 等这一轮跑完，别把后面的进程带跑
    for (let i = 0; i < 200; i++) {
      if (!(await streaming())) { break; }
      await page.sleep(100);
    }
  }

  console.log(failed ? `\n  ${failed} 项没过` : "\n  全过");
  if (failed) { process.exitCode = 1; }
};

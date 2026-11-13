// @ts-nocheck
/**
 * autoLoop —— 验「自动模式」整条路（后端 + 界面一起，模型一头是假的）。
 *
 * 要验的几件事：
 *   1. 开关是输入框右下角最右边那颗圆圈按钮：没开时也在（暗着），点一下开始——
 *      不往对话里发东西、按钮变绿、存档里记下“开着”（不记轮数）；
 *   2. 主会话跑完一轮 → 插件直接发一句「继续」→ 又跑一轮（不再另起判官会话）；
 *   3. 开着时再点一下就是停（停下以后不再发「继续」）；
 *   4. 刷新页面后那颗按钮还亮着；
 *   5. 打 `/auto` 这几个字：吞掉（不发给模型、不回话、也不把开关关掉），菜单里也不再列它；
 *   6. 开着的时候模型问的选择题（ask_user）不弹卡片：直接替你点它推荐的那一项。
 *
 * 模型那头是假的（`--fake-pi`）：看到「继续」就回一句短的，不点开关就会一轮接一轮地跑
 * （见 dev/fakePi.js）。
 *
 *   npm run web:shot -- --fake-pi --script dev/autoLoop.js
 */
const fs = require("fs");
const path = require("path");

module.exports = async (page) => {
  const scratch = path.join(__dirname, ".scratch");
  const autoFilePath = path.join(process.env.PICHAT_HOME || path.join(scratch, "pichat"), "auto.json");
  try { fs.rmSync(autoFilePath, { force: true }); } catch { /* 没有就算了 */ }

  await page.waitReady();
  const problems = [];
  const check = (what, ok, detail) => {
    if (!ok) { problems.push(what + (detail ? "：" + JSON.stringify(detail) : "")); }
    console.log((ok ? "✓ " : "✗ ") + what + (detail ? "  " + JSON.stringify(detail) : ""));
  };

  const autos = () => {
    try { return JSON.parse(fs.readFileSync(autoFilePath, "utf8")).autos || {}; } catch { return {}; }
  };
  const onlyAuto = () => {
    const all = autos();
    const keys = Object.keys(all);
    return keys.length === 1 ? all[keys[0]] : null;
  };

  /** 右下角那颗自动模式的按钮：一直在不在、亮没亮（开着）、指上去说什么、是不是输入行最右那一颗。 */
  const ind = () => page.eval(`
    const el = document.getElementById("autoBtn");
    if (!el) { return { exists: false }; }
    const row = document.getElementById("inputRow");
    const composer = document.getElementById("composer");
    return {
      exists: true,
      on: el.classList.contains("on"),
      flow: !!composer && composer.classList.contains("auto"),
      title: el.title || "",
      lastInRow: !!row && row.lastElementChild === el,
    };
  `);
  const userSays = () => page.eval(`
    return Array.from(document.querySelectorAll(".msg.user")).map((el) => el.textContent.trim());
  `);
  const systemSays = () => page.eval(`
    return Array.from(document.querySelectorAll(".msg.system")).map((el) => el.textContent.trim()).join(" | ");
  `);
  const continues = async () => (await userSays()).filter((t) => t === "继续").length;
  /** 面板现在看得见吗：常驻那一列（宽窗，display 不是 none）或者浮层（窄窗，没盖着 hidden）。 */
  const panelShown = () => page.eval(`
    const dock = document.getElementById("sidebarDock");
    const dockShown = !!dock && getComputedStyle(dock).display !== "none";
    const overlay = document.getElementById("pickerOverlay");
    return dockShown || (!!overlay && !overlay.classList.contains("hidden"));
  `);
  /** 「项目与会话」里「正在对话」那几行。 */
  const openRows = async () => {
    const opened = !(await panelShown());
    if (opened) { await page.click("#browserMenuBtn"); await page.sleep(400); }
    const rows = await page.eval(`
      const root = (function () {
        const dock = document.getElementById("sidebarDock");
        return (dock && getComputedStyle(dock).display !== "none") ? "#dockBody" : "#pickerBody";
      })();
      return Array.from(document.querySelectorAll(root + " .pk-item.pk-open"))
        .map((el) => { const t = el.querySelector(".pk-history-title"); return t ? t.textContent.trim() : ""; });
    `);
    if (opened) { await page.press("Escape"); await page.sleep(250); }
    return rows;
  };
  const until = async (fn, ms) => {
    const limit = Date.now() + (ms || 60000);
    let last = null;
    while (Date.now() < limit) {
      last = await fn();
      if (last && last.ok) { return last; }
      await page.sleep(250);
    }
    return last;
  };

  // ---- 1. 右下角那颗按钮一直在；点一下开始：不往对话里发东西 ----
  let i = await ind();
  check("输入框右下角最右边那颗小开关一直在（横排最右那一颗）", i.exists && i.lastInRow, i);
  check("没开的时候滑块在左、灰着：指上去写着「点一下开始」", !i.on && i.title === "自动模式（点一下开始）", i);

  await page.click("#autoBtn");
  await page.sleep(800);
  i = await ind();
  check("点一下：小开关拨到右边（开着）、输入框外面那圈边框变绿", i.on && i.flow, i);
  check("指上去写着「自动模式（点一下停止）」", i.title === "自动模式（点一下停止）", i.title);
  check("点一下不多出一条对话消息",
    (await page.eval(`return document.querySelectorAll(".msg.user").length;`)) === 0);
  const a1 = onlyAuto();
  check("存档：这个会话的开关是「开着」、不记轮数",
    !!a1 && typeof a1.updatedAt === "number" && !("rounds" in a1), a1);
  await page.shot("auto-on.png");

  // ---- 2. 第一轮跑完 → 直接发一句「继续」→ 再跑一轮 ----
  await page.send("随便干点活，演示一下");
  await page.waitAnswer("三个工具都跑过");
  const continued = await until(async () => {
    const n = await continues();
    return { ok: n >= 1, n };
  }, 30000);
  check("这一轮跑完：主会话收到一句「继续」（没有判官那一层）", continued && continued.ok, continued);
  const rows = await openRows();
  check("不再另起判官会话：列表里只有主会话", rows.length === 1 && !rows.some((r) => r.includes("判官")), rows);
  await page.sleep(1500);
  check("不点开关就一直接着跑（还会再来「继续」）", (await continues()) >= 1, await continues());
  await page.shot("auto-looping.png");

  // ---- 3. 开着时再点一下：停；停下以后不再发「继续」----
  await page.click("#autoBtn");
  await page.sleep(600);
  i = await ind();
  check("开着时再点一下：自动模式关掉、按钮回到暗色", i.exists && !i.on, i);
  check("关掉以后存档里也没了", Object.keys(autos()).length === 0, autos());
  const stoppedAt = await continues();
  await page.sleep(3500);
  check("停下以后不再发「继续」", (await continues()) === stoppedAt, { before: stoppedAt, after: await continues() });
  check("停下以后绿边也收掉", (await ind()).flow === false, await ind());

  // ---- 4. 再点一下又开；刷新页面后还亮着 ----
  await page.click("#autoBtn");
  await page.sleep(600);
  check("再点一下那颗按钮又开了", (await ind()).on, await ind());

  await page.eval("location.reload(); return true;");
  await page.sleep(1200);
  await page.waitReady(60000);
  const back = await until(async () => {
    const now = await ind();
    return { ok: now.exists && now.on, title: now.title };
  }, 20000);
  check("刷新页面后那颗按钮还亮着（会话列表里带的）", back && back.ok, back);

  await page.click("#autoBtn");
  await page.sleep(500);
  check("开着时再点一下：自动模式关掉、存档里也没了",
    !(await ind()).on && Object.keys(autos()).length === 0, autos());

  // ---- 5. 打 /auto 这几个字：吞掉（不发给模型、不回话、也不改开关）----
  const userCount = await page.eval(`return document.querySelectorAll(".msg.user").length;`);
  const sysBefore = await systemSays();
  await page.send("/auto 把测试跑一下");
  await page.sleep(800);
  check("打 /auto（后面带东西也一样）：吞掉，不发给模型、也不回话",
    (await page.eval(`return document.querySelectorAll(".msg.user").length;`)) === userCount
    && (await systemSays()) === sysBefore
    && !(await ind()).on,
    { sys: (await systemSays()).slice(-120) });

  // ---- 6. 自动模式开着时模型问的选择题（ask_user）：卡片不弹，插件直接替你点推荐项 ----
  // （不替你点的话这一轮就卡在那张卡片上：自动模式下没人会来点它）
  await page.click("#autoBtn");
  await page.sleep(600);
  check("（前提）按钮点开了", (await ind()).on, await ind());
  const cardsBefore = await page.eval(`return document.querySelectorAll(".ask-card").length;`);
  await page.send("问单选");   // 假模型：options ["A", "B"]，recommended [1]（也就是 A）
  const askedReply = await page.waitAnswer("用户选了：A");
  const cardsAfter = await page.eval(`return document.querySelectorAll(".ask-card").length;`);
  const saidAsk = await systemSays();
  check("自动模式下问的选择题不弹卡片，直接按它推荐的那一项作答",
    cardsAfter === cardsBefore
    && saidAsk.includes("自动模式：这题替你选了「A」（选 A 还是 B？）"),
    { cardsBefore, cardsAfter, said: saidAsk.slice(-200) });
  check("模型拿到的是「用户选了：A」", askedReply.includes("用户选了：A"), askedReply.slice(-160));
  await page.shot("auto-ask.png");
  await page.click("#autoBtn");
  await page.sleep(500);

  // ---- 7. 命令菜单里不再列 /auto（开关改成那颗按钮了） ----
  await page.type("/");
  await page.sleep(700);
  const menu = await page.eval(`
    const el = document.getElementById("fileMenu");
    if (!el || el.classList.contains("hidden")) { return { open: false, items: [] }; }
    return { open: true, items: Array.from(el.querySelectorAll(".file-item")).map((x) => x.textContent.trim()) };
  `);
  check("命令菜单里不再列 /auto（/compact 还在）",
    menu.open
    && menu.items.some((t) => t.includes("/compact"))
    && !menu.items.some((t) => /^\/auto/.test(t)),
    menu.items);
  await page.shot("auto-menu.png");

  if (problems.length) {
    throw new Error("自动模式有问题：\n- " + problems.join("\n- "));
  }
  console.log("自动模式全过。");
};

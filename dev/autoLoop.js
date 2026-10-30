// @ts-nocheck
/**
 * autoLoop —— 验「自动模式」（/auto）整条路（后端 + 界面一起，模型一头是假的）。
 *
 * 要验的几件事：
 *   1. /auto 只开开关：不往对话里发东西、输入框右头多一颗转圈圈的图标、存档里记下"开着"；
 *   2. 主会话跑完一轮 → 插件自动派判官 → 判官说「继续」→ 主会话收到一句「继续」又跑一轮；
 *   3. 判官说「结束」→ 开关自己关掉、图标收掉、系统提示说清为什么；
 *   4. 那颗图标点一下就是停；刷新页面后图标还在；
 *   5. 打 /auto 后面带别的东西：只回一句提示，不当成普通消息发出去；命令菜单里有 /auto。
 *
 * 模型那头是假的（`--fake-pi`）：假 pi 看到判官提示词就按轮数说「继续」/「结束」
 * （见 dev/fakePi.js 与 FAKEPI_AUTO_STOP_ON，默认第 2 轮收工）。
 *
 *   npm run web:shot -- --fake-pi --script dev/autoLoop.js
 */
const fs = require("fs");
const path = require("path");

// 判官要跑一会儿才看得到「判官正在看」：没指定就把假判官拖慢一点
process.env.FAKEPI_JUDGE_MS = process.env.FAKEPI_JUDGE_MS || "2500";

module.exports = async (page) => {
  const scratch = path.join(__dirname, ".scratch");
  // 判官的轮数记在会话目录里，开关存在 pichat 目录里：上一次跑剩的会让这一跑从第二轮开始
  for (const name of [path.join(scratch, ".judge-rounds"), path.join(scratch, "pichat", "auto.json")]) {
    try { fs.rmSync(name, { force: true }); } catch { /* 没有就算了 */ }
  }

  await page.waitReady();
  const problems = [];
  const check = (what, ok, detail) => {
    if (!ok) { problems.push(what + (detail ? "：" + JSON.stringify(detail) : "")); }
    console.log((ok ? "✓ " : "✗ ") + what + (detail ? "  " + JSON.stringify(detail) : ""));
  };

  /** 开关存档（跟后端同一个目录：调试时 PICHAT_HOME 指到 dev/.scratch/pichat）。 */
  const autoFilePath = path.join(process.env.PICHAT_HOME || path.join(scratch, "pichat"), "auto.json");
  const autos = () => {
    try { return JSON.parse(fs.readFileSync(autoFilePath, "utf8")).autos || {}; } catch { return {}; }
  };
  /** 存档里那一份（只有一个会话开着的时候才有意义）。 */
  const onlyAuto = () => {
    const all = autos();
    const keys = Object.keys(all);
    return keys.length === 1 ? all[keys[0]] : null;
  };

  /** 输入框右头那颗转圈圈的图标：露没露面、指上去说什么、在不在「你说过的话」左边。 */
  const ind = () => page.eval(`
    const el = document.getElementById("autoBtn");
    if (!el) { return { exists: false }; }
    const said = document.getElementById("saidBtn");
    return {
      exists: true,
      hidden: el.classList.contains("hidden"),
      title: el.title || "",
      beforeSaid: !!(said && (el.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  `);
  const userSays = () => page.eval(`
    return Array.from(document.querySelectorAll(".msg.user")).map((el) => el.textContent.trim());
  `);
  const systemSays = () => page.eval(`
    return Array.from(document.querySelectorAll(".msg.system")).map((el) => el.textContent.trim()).join(" | ");
  `);
  /** 面板现在看得见吗：常驻那一列（宽窗，display 不是 none）或者浮层（窄窗，没盖着 hidden）。 */
  const panelShown = () => page.eval(`
    const dock = document.getElementById("sidebarDock");
    const dockShown = !!dock && getComputedStyle(dock).display !== "none";
    const overlay = document.getElementById("pickerOverlay");
    return dockShown || (!!overlay && !overlay.classList.contains("hidden"));
  `);
  /** 「项目与会话」里「正在对话」那几行（判官在跑的时候也在里面）。 */
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
  /** 等某件事发生（最多等 ms 毫秒）；返回等到时那一条要看的读数。 */
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

  // ---- 1. /auto：只开开关，不往对话里发东西 ----
  // 注意 /auto 后头那个空格：不写的话输入框会弹「/ 命令菜单」，回车被它吃掉（只把命令补进输入框），
  // 这是现有行为（/compact 也一样），不是这个功能的事。
  await page.send("/auto ");
  await page.sleep(800);

  let i = await ind();
  check("输入框右头多了一颗转圈圈的图标，挨在「你说过的话」左边",
    i.exists && !i.hidden && i.beforeSaid, i);
  check("指上去写着「自动模式」（点一下停止）", i.title === "自动模式（点一下停止）", i.title);
  check("开开关不多出一条对话消息",
    (await page.eval(`return document.querySelectorAll(".msg.user").length;`)) === 0);
  const a1 = onlyAuto();
  check("存档：这个会话的开关是「开着」、还没跑过轮", !!a1 && a1.rounds === 0, a1 && { rounds: a1.rounds });
  await page.shot("auto-on.png");

  // ---- 2. 第一轮跑完 → 判官说「继续」→ 主会话收到一句「继续」再跑一轮 ----
  await page.send("随便干点活，演示一下");
  await page.waitAnswer("三个工具都跑过");
  const judged = await until(async () => {
    const now = await ind();
    return { ok: now.title.includes("判官正在看") && now.title.includes("第 1 轮"), title: now.title };
  }, 20000);
  check("判官在跑的时候图标写着「第 1 轮 · 判官正在看」", judged && judged.ok, judged);
  const judgingRows = await openRows();
  check("判官在跑的时候在「项目与会话」列表里看得见", judgingRows.some((r) => r.includes("判官")), judgingRows);
  await page.shot("auto-judging.png");

  const continued = await until(async () => {
    const said = await userSays();
    return { ok: said.some((t) => t.trim() === "继续"), said };
  }, 90000);
  check("判官说继续：主会话收到一句「继续」", continued && continued.ok, continued && continued.said);
  // 主会话收到「继续」马上又跑完一轮、下一个判官就派出来了：这里只认"轮数记上了"
  check("存档：轮数记上了", ((onlyAuto() || {}).rounds || 0) >= 1, onlyAuto() && onlyAuto().rounds);

  // ---- 3. 第二轮判官说「结束」→ 开关自己关掉 ----
  const stopped = await until(async () => {
    const now = await ind();
    return { ok: now.hidden === true, hidden: now.hidden };
  }, 90000);
  check("判官说结束：那颗图标自己收掉", stopped && stopped.ok, stopped);
  const said2 = await systemSays();
  check("系统提示说清了为什么停", said2.includes("判官说不用继续了"), said2.slice(-160));
  check("存档：关掉以后那条也没了", Object.keys(autos()).length === 0, autos());
  const rowsAfter = await openRows();
  check("判官给完结论就把自己关掉：列表里只剩主会话",
    !rowsAfter.some((r) => r.includes("判官")) && rowsAfter.length === 1, rowsAfter);
  await page.shot("auto-stopped.png");

  // ---- 4. 再开一次：刷新页面后图标还在；点一下那颗图标就是停 ----
  await page.send("/auto ");
  await page.sleep(600);
  i = await ind();
  check("再打一次 /auto 又开了", !i.hidden && i.title === "自动模式（点一下停止）", i);

  await page.eval("location.reload(); return true;");
  await page.sleep(1200);
  await page.waitReady(60000);
  const back = await until(async () => {
    const now = await ind();
    return { ok: now.exists && !now.hidden, title: now.title };
  }, 20000);
  check("刷新页面后图标还在（会话列表里带的）", back && back.ok, back);

  await page.click("#autoBtn");
  await page.sleep(500);
  i = await ind();
  check("点一下那颗图标：自动模式关掉、图标收掉", i.hidden, i);
  check("点一下那颗图标：存档里也没了", Object.keys(autos()).length === 0, autos());

  // ---- 5. /auto 后面带别的东西：一句话回你，不当成普通消息 ----
  const userCount = await page.eval(`return document.querySelectorAll(".msg.user").length;`);
  await page.send("/auto 把测试跑一下");
  await page.sleep(600);
  const said3 = await systemSays();
  check("打 /auto 带别的东西：只回一句提示，不发给模型",
    said3.includes("不接东西")
    && (await page.eval(`return document.querySelectorAll(".msg.user").length;`)) === userCount
    && (await ind()).hidden,
    said3.slice(-120));

  // ---- 6. 命令菜单里要有 /auto 那一条 ----
  await page.type("/auto");
  await page.sleep(600);
  const menu = await page.eval(`
    const el = document.getElementById("fileMenu");
    if (!el || el.classList.contains("hidden")) { return { open: false, items: [] }; }
    return { open: true, items: Array.from(el.querySelectorAll(".file-item")).map((x) => x.textContent.trim()) };
  `);
  check("命令菜单里能搜到 /auto", menu.open && menu.items.some((t) => t.includes("/auto")), menu);
  await page.shot("auto-menu.png");

  if (problems.length) {
    throw new Error("自动模式有问题：\n- " + problems.join("\n- "));
  }
  console.log("自动模式全过。");
};

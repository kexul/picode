// @ts-nocheck
/**
 * autoSkip —— 验「自动模式该等的时候先不叫判官」：后台命令还在跑、派出去的子会话还没跑完。
 *
 * 要验的几件事：
 *   1. 一轮跑完、后台命令还在跑：不派判官（轮数还是 0、列表里没有判官），也不往对话里写话；
 *   2. 那条命令跑完、结果交回来、这一轮也跑完之后才派判官（judge 说「继续」就继续、说「结束」就关开关）；
 *   3. 派出去的子会话还没跑完时也一样：先不叫，等它的结果交回来、那一轮跑完才叫；
 *   4. 界面上「后台任务」那一块照常在（不是把后台命令当没看见）。
 *
 * 后台命令和子会话都由假模型演：前者照真扩展的样子往 stderr 写 start / end 两行暗号
 * （见 dev/fakePi.js 里「后台跑一会」那一段），后者调的是真扩展注册的那个 task 工具；
 * 后端那边全是真的。
 *
 *   npm run web:shot -- --fake-pi --script dev/autoSkip.js
 */
const fs = require("fs");
const path = require("path");

// 后台那条命令要跑多久才收工（毫秒）：够短，一眼看完；够长，够脚本查「这段时间里没叫判官」
process.env.FAKEPI_BG_MS = process.env.FAKEPI_BG_MS || "9000";
// 子会话同理：故意磨蹭一会儿，才查得到「它还在跑的那段时间里没叫判官」
process.env.FAKEPI_CHILD_SLOW_MS = process.env.FAKEPI_CHILD_SLOW_MS || "9000";
// 判官要跑一会儿才看得到「判官正在看」、也才来得及在「项目与会话」列表里露一面
process.env.FAKEPI_JUDGE_MS = process.env.FAKEPI_JUDGE_MS || "2500";
// 判官第一轮就说「结束」：这一跑只看「该不该叫判官」，不必再让主会话多跑几轮
process.env.FAKEPI_AUTO_STOP_ON = process.env.FAKEPI_AUTO_STOP_ON || "1";

module.exports = async (page) => {
  const scratch = path.join(__dirname, ".scratch");
  // 上一次跑剩的轮数会让这一跑对不上号
  try { fs.rmSync(path.join(scratch, ".judge-rounds"), { force: true }); } catch { /* 没有就算了 */ }
  try { fs.rmSync(path.join(scratch, "pichat", "auto.json"), { force: true }); } catch { /* 同上 */ }

  await page.waitReady();
  const problems = [];
  const check = (what, ok, detail) => {
    if (!ok) { problems.push(what + (detail ? "：" + JSON.stringify(detail) : "")); }
    console.log((ok ? "✓ " : "✗ ") + what + (detail ? "  " + JSON.stringify(detail) : ""));
  };

  /** 开关存档（跟后端同一个目录）。 */
  const autoFilePath = path.join(process.env.PICHAT_HOME || path.join(scratch, "pichat"), "auto.json");
  const autos = () => {
    try { return JSON.parse(fs.readFileSync(autoFilePath, "utf8")).autos || {}; } catch { return {}; }
  };
  const onlyAuto = () => {
    const all = autos();
    const keys = Object.keys(all);
    return keys.length === 1 ? all[keys[0]] : null;
  };

  /** 右下角那颗自动模式的按钮：开着没有、指上去说什么。 */
  const ind = () => page.eval(`
    const el = document.getElementById("autoBtn");
    return el ? { exists: true, on: el.classList.contains("on"), title: el.title || "" } : { exists: false };
  `);
  const userSays = () => page.eval(`
    return Array.from(document.querySelectorAll(".msg.user")).map((el) => el.textContent.trim());
  `);
  const systemSays = () => page.eval(`
    return Array.from(document.querySelectorAll(".msg.system")).map((el) => el.textContent.trim()).join(" | ");
  `);
  /** 消息流末尾那一块「后台任务」现在什么样：在不在、几条、每条写的什么。 */
  const bgBlock = () => page.eval(`
    const box = document.querySelector(".session-view:not(.off) .bash-running");
    if (!box) { return { exists: false, rows: [] }; }
    return {
      exists: true,
      rows: Array.from(box.querySelectorAll(".bash-run")).map((el) => el.textContent.replace(/\\s+/g, " ").trim()),
    };
  `);
  /** 「项目与会话」里「正在对话」那几行（判官在跑的时候也在里面）。 */
  const panelShown = () => page.eval(`
    const dock = document.getElementById("sidebarDock");
    const dockShown = !!dock && getComputedStyle(dock).display !== "none";
    const overlay = document.getElementById("pickerOverlay");
    return dockShown || (!!overlay && !overlay.classList.contains("hidden"));
  `);
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

  // ---- 1. 打开自动模式，发一句让假模型把活扔到后台 ----
  await page.click("#autoBtn");
  await page.sleep(600);
  check("（前提）自动模式点开了", (await ind()).on, await ind());
  // 开开关会往消息流里写一句说明：这一跑的「安静跳过」就跟着这个基线比
  const sysAfterOn = await systemSays();
  await page.send("后台跑一会");
  await page.waitAnswer("我把活扔到后台了");
  const bg = await bgBlock();
  check("消息流末尾那一块「后台任务」看得见这条命令", bg.exists && bg.rows.length === 1, bg);
  await page.shot("auto-bg-running.png");

  // ---- 2. 这一轮跑完了、后台命令还在跑：不叫判官 ----
  // 后台那条还要好几秒才收工：这段时间里反复看，轮数一直得是 0、列表里一直不该冒出判官
  let sawJudge = null;
  let roundsMoved = null;
  const watchingUntil = Date.now() + (Number(process.env.FAKEPI_BG_MS) - 3500);
  while (Date.now() < watchingUntil) {
    const now = await ind();
    if (now.title.includes("判官")) { sawJudge = now.title; break; }
    const a = onlyAuto();
    if (a && a.rounds > 0) { roundsMoved = a.rounds; break; }
    await page.sleep(400);
  }
  check("后台命令还在跑的时候不叫判官（那颗按钮上一直没提判官）", !sawJudge, sawJudge);
  check("后台命令还在跑的时候不叫判官（轮数还是 0）", !roundsMoved, roundsMoved);
  const saidSkip = await systemSays();
  check("安静地跳过：不往对话里写任何说明（消息流里还是只有开开关那一句）",
    saidSkip === sysAfterOn && !saidSkip.includes("后台还有命令"), { sys: saidSkip.slice(-160) });
  const rowsWhileBg = await openRows();
  check("后台命令还在跑的时候列表里只有主会话（没有判官）",
    rowsWhileBg.length === 1 && !rowsWhileBg.some((r) => r.includes("判官")), rowsWhileBg);
  const bgStill = await bgBlock();
  check("这一轮跑完了，后台那条还在跑（那一块没收掉）",
    bgStill.exists && bgStill.rows.length === 1 && bgStill.rows[0].includes("npm run build"), bgStill);

  // ---- 3. 那条命令跑完 → 结果交回会话 → 这一轮跑完，这才叫判官 ----
  const delivered = await until(async () => {
    const said = await userSays();
    return { ok: said.some((t) => t.includes("后台命令 #1 跑完了")), said };
  }, 40000);
  check("后台命令跑完，结果当一条新消息交回了会话", delivered && delivered.ok,
    delivered && delivered.said.filter((t) => t.includes("后台命令")));

  const judged = await until(async () => {
    const now = await ind();
    const a = onlyAuto();
    return { ok: now.title.includes("判官正在看") && now.title.includes("第 1 轮"), title: now.title, rounds: a && a.rounds };
  }, 40000);
  check("后台命令跑完、这一轮也跑完之后才派判官（第 1 轮 · 判官正在看）", judged && judged.ok, judged);
  const rowsJudging = await openRows();
  check("判官在跑的时候在「项目与会话」列表里看得见", rowsJudging.some((r) => r.includes("判官")), rowsJudging);
  await page.shot("auto-bg-judging.png");

  // ---- 4. 判官说「结束」→ 开关关掉（证明这一趟判官真的跑完了）----
  const stopped = await until(async () => {
    const now = await ind();
    return { ok: now.exists && now.on === false, title: now.title };
  }, 60000);
  check("判官说结束：那颗按钮回到暗色、开关也收了", stopped && stopped.ok && Object.keys(autos()).length === 0, stopped);
  await page.shot("auto-bg-stopped.png");

  // ---- 5. 子会话还没跑完时也一样：先不叫判官，等它交回结果、这一轮跑完再叫 ----
  await page.click("#autoBtn");
  await page.sleep(600);
  check("（前提）自动模式再点开", (await ind()).on, await ind());
  const sysAfterOn2 = await systemSays();
  await page.send("派活");
  await page.waitAnswer("子会话工具回话");
  let sawJudge2 = null;
  let roundsMoved2 = null;
  const watchingChildUntil = Date.now() + (Number(process.env.FAKEPI_CHILD_SLOW_MS) - 3500);
  while (Date.now() < watchingChildUntil) {
    const now = await ind();
    if (now.title.includes("判官")) { sawJudge2 = now.title; break; }
    const a = onlyAuto();
    if (a && a.rounds > 0) { roundsMoved2 = a.rounds; break; }
    await page.sleep(400);
  }
  check("子会话还在跑的时候不叫判官（那颗按钮上一直没提判官）", !sawJudge2, sawJudge2);
  check("子会话还在跑的时候不叫判官（轮数还是 0）", !roundsMoved2, roundsMoved2);
  check("子会话还在跑的时候也不往对话里写话", (await systemSays()) === sysAfterOn2,
    (await systemSays()).slice(-160));
  const rowsWhileChild = await openRows();
  check("子会话还在跑的时候列表里只有它，没有判官",
    rowsWhileChild.length === 2 && !rowsWhileChild.some((r) => r.includes("判官")), rowsWhileChild);

  const childBack = await until(async () => {
    const said = await userSays();
    return { ok: said.some((t) => t.includes("跑完了，用时")), said };
  }, 60000);
  check("子会话跑完，结果交回了派它的会话", childBack && childBack.ok,
    childBack && childBack.said.filter((t) => t.includes("跑完了，用时")));
  const judged2 = await until(async () => {
    const now = await ind();
    return { ok: now.title.includes("判官正在看"), title: now.title };
  }, 60000);
  check("子会话交回结果、那一轮也跑完之后才派判官", judged2 && judged2.ok, judged2);
  await page.shot("auto-skip-child.png");

  if (problems.length) {
    throw new Error("自动模式该等的时候先不叫判官：有问题：\n- " + problems.join("\n- "));
  }
  console.log("自动模式该等的时候先不叫判官：全过。");
};

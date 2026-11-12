// @ts-nocheck
/**
 * autoSkip —— 验「自动模式该等的时候先不催」：后台命令还在跑、派出去的子会话还没跑完。
 *
 * 要验的几件事：
 *   1. 一轮跑完、后台命令还在跑：不发「继续」（也不往对话里写话）；
 *   2. 那条命令跑完、结果交回来、这一轮也跑完之后才发「继续」；
 *   3. 派出去的子会话还没跑完时不发「继续」，改发一句
 *      「现在有子任务在跑着，你这边也别闲着」（每次跑完、子会话还在跑就再发）；
 *   4. 等子会话的结果交回来、那一轮跑完才发「继续」；
 *   5. 界面上「后台任务」那一块照常在（不是把后台命令当没看见）。
 *
 * 后台命令和子会话都由假模型演：前者照真扩展的样子往 stderr 写 start / end 两行暗号
 * （见 dev/fakePi.js 里「后台跑一会」那一段），后者调的是真扩展注册的那个 task 工具；
 * 后端那边全是真的。
 *
 *   npm run web:shot -- --fake-pi --script dev/autoSkip.js
 */
const fs = require("fs");
const path = require("path");

// 后台那条命令要跑多久才收工（毫秒）：够短，一眼看完；够长，够脚本查「这段时间里没催」
process.env.FAKEPI_BG_MS = process.env.FAKEPI_BG_MS || "9000";
// 子会话同理：故意磨蹭一会儿，才查得到「它还在跑的那段时间里没发继续」
process.env.FAKEPI_CHILD_SLOW_MS = process.env.FAKEPI_CHILD_SLOW_MS || "9000";

const NUDGE = "现在有子任务在跑着，你这边也别闲着";

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
  const continues = async () => (await userSays()).filter((t) => t === "继续").length;
  const nudges = async () => (await userSays()).filter((t) => t === NUDGE).length;
  /** 消息流末尾那一块「后台任务」现在什么样：在不在、几条、每条写的什么。 */
  const bgBlock = () => page.eval(`
    const box = document.querySelector(".session-view:not(.off) .bash-running");
    if (!box) { return { exists: false, rows: [] }; }
    return {
      exists: true,
      rows: Array.from(box.querySelectorAll(".bash-run")).map((el) => el.textContent.replace(/\\s+/g, " ").trim()),
    };
  `);
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
  /** 停下开关，等手上那一轮跑完（它结束时可能还会发一句「继续」，这里不数）。 */
  const stopAuto = async () => {
    await page.click("#autoBtn");
    await page.sleep(600);
    await page.sleep(2500);
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

  // ---- 2. 这一轮跑完了、后台命令还在跑：不发「继续」 ----
  const watchingUntil = Date.now() + (Number(process.env.FAKEPI_BG_MS) - 3500);
  let sawContinue = 0;
  let sawNudge = 0;
  while (Date.now() < watchingUntil) {
    if ((await continues()) > 0) { sawContinue = await continues(); break; }
    if ((await nudges()) > 0) { sawNudge = await nudges(); break; }
    await page.sleep(400);
  }
  check("后台命令还在跑的时候不发「继续」", sawContinue === 0, sawContinue);
  check("后台命令还在跑的时候也不发「别闲着」（那只管子会话）", sawNudge === 0, sawNudge);
  check("安静地跳过：不往对话里写任何说明（消息流里还是只有开开关那一句）",
    (await systemSays()) === sysAfterOn, (await systemSays()).slice(-160));
  const rowsWhileBg = await openRows();
  check("后台命令还在跑的时候列表里只有主会话", rowsWhileBg.length === 1, rowsWhileBg);
  const bgStill = await bgBlock();
  check("这一轮跑完了，后台那条还在跑（那一块没收掉）",
    bgStill.exists && bgStill.rows.length === 1 && bgStill.rows[0].includes("npm run build"), bgStill);

  // ---- 3. 那条命令跑完 → 结果交回会话 → 这一轮跑完，这才发「继续」 ----
  const delivered = await until(async () => {
    const said = await userSays();
    return { ok: said.some((t) => t.includes("后台命令 #1 跑完了")), said };
  }, 40000);
  check("后台命令跑完，结果当一条新消息交回了会话", delivered && delivered.ok,
    delivered && delivered.said.filter((t) => t.includes("后台命令")));
  const continued1 = await until(async () => {
    const n = await continues();
    return { ok: n >= 1, n };
  }, 30000);
  check("后台命令跑完、这一轮也跑完之后才发「继续」", continued1 && continued1.ok, continued1);
  await page.shot("auto-bg-continued.png");
  await stopAuto();

  // ---- 4. 子会话还没跑完时：不发「继续」，改成催「别闲着」 ----
  await page.click("#autoBtn");
  await page.sleep(600);
  check("（前提）自动模式再点开", (await ind()).on, await ind());
  const sysAfterOn2 = await systemSays();
  await page.send("派活");
  await page.waitAnswer("子会话工具回话");
  const nudged = await until(async () => {
    const n = await nudges();
    return { ok: n >= 1, n };
  }, 10000);
  check("子会话还在跑：主会话收到一句「别闲着」", nudged && nudged.ok, nudged);
  const twice = await until(async () => {
    const n = await nudges();
    return { ok: n >= 2, n };
  }, 8000);
  check("每跑完一轮、子会话还在跑就再发一句（至少两句）", twice && twice.ok, twice);
  check("子会话还在跑的时候不发「继续」", (await continues()) === 0, await continues());
  check("催它干活不等于往对话里写说明（系统提示没多）", (await systemSays()) === sysAfterOn2,
    (await systemSays()).slice(-160));
  const rowsWhileChild = await openRows();
  check("子会话还在跑的时候列表里只有它，没有判官",
    rowsWhileChild.length === 2 && !rowsWhileChild.some((r) => r.includes("判官")), rowsWhileChild);

  // ---- 5. 子会话交回结果、那一轮跑完：这才发「继续」 ----
  const childBack = await until(async () => {
    const said = await userSays();
    return { ok: said.some((t) => t.includes("跑完了，用时")), said };
  }, 60000);
  check("子会话跑完，结果交回了派它的会话", childBack && childBack.ok,
    childBack && childBack.said.filter((t) => t.includes("跑完了，用时")));
  const continued2 = await until(async () => {
    const n = await continues();
    return { ok: n >= 1, n };
  }, 30000);
  check("子会话交回结果、那一轮跑完之后才发「继续」", continued2 && continued2.ok, continued2);
  await page.shot("auto-skip-child.png");
  await stopAuto();

  if (problems.length) {
    throw new Error("自动模式该等的时候先不催：有问题：\n- " + problems.join("\n- "));
  }
  console.log("自动模式该等的时候先不催：全过。");
};

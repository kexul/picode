// @ts-nocheck
/**
 * goalInterject —— 验「目标跑着的时候，你自己开口插一句话 → 目标照跑，不停」。
 *
 * 要验的几件事：
 *   1. 判官正在验的时候你插一句话：目标条还是「进行中」，存盘还是 active；
 *   2. 正在验的那个判官不动（不因为你插话被收掉），照样验完、结论照样发回工人；
 *   3. 循环接着转：工人下一轮跑起来，轮数照涨；
 *   4. 想停就点目标条上的「暂停」（那颗按钮没被插话影响）。
 *
 *   npm run web:shot -- --fake-pi --script dev/goalInterject.js
 */
const fs = require("fs");
const path = require("path");

// 判官那一步要跑一会儿，才留得出“它正在验的时候插话”这个窗口
process.env.FAKEPI_JUDGE_MS = process.env.FAKEPI_JUDGE_MS || "3000";

module.exports = async (page) => {
  const scratch = path.join(__dirname, ".scratch");
  try { fs.rmSync(path.join(scratch, ".judge-rounds"), { force: true }); } catch { /* 没有就算了 */ }
  await page.waitReady();
  const problems = [];
  const check = (what, ok, detail) => {
    if (!ok) { problems.push(what + (detail ? "：" + JSON.stringify(detail) : "")); }
    console.log((ok ? "✓ " : "✗ ") + what + (detail ? "  " + JSON.stringify(detail) : ""));
  };
  const goalsFile = path.join(process.env.PICHAT_HOME || path.join(scratch, "pichat"), "goals.json");
  // 调试目录里那份是上一跑留下的（会话文件一个个不同，每条都留在里面）：先清空，
  // 不然「取第一条」取到的是上一次那个会话的目标，检查就瞎了。
  try { fs.rmSync(goalsFile, { force: true }); } catch { /* 没有就算了 */ }
  const goal = () => {
    try {
      const all = JSON.parse(fs.readFileSync(goalsFile, "utf8")).goals || {};
      const keys = Object.keys(all);
      return keys.length ? all[keys[0]] : null;
    } catch { return null; }
  };
  const bar = () => page.eval(`
    const el = document.getElementById("goalBar");
    if (!el) { return { exists: false }; }
    const text = el.querySelector(".gb-text");
    const body = el.querySelector(".gb-body");
    return {
      exists: true, hidden: el.classList.contains("hidden"),
      tone: el.className.replace(/\\s*open\\b/, "").trim(),
      text: text ? text.textContent.trim() : "",
      body: body ? body.textContent.trim() : "",
    };
  `);
  /** 面板看得见吗（宽窗常驻那一列，或者窄窗顶上那颗 <<< 拉出来的浮层）。 */
  const panelShown = () => page.eval(`
    const dock = document.getElementById("sidebarDock");
    const dockShown = !!dock && getComputedStyle(dock).display !== "none";
    const overlay = document.getElementById("pickerOverlay");
    return dockShown || (!!overlay && !overlay.classList.contains("hidden"));
  `);
  /** 「项目与会话」里「正在对话」那几行（判官也在里面）。 */
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
  const systemText = () => page.eval(`
    return Array.from(document.querySelectorAll(".msg.system")).map((el) => el.textContent.trim()).join(" | ");
  `);
  const until = async (what, fn, ms = 60000) => {
    const started = Date.now();
    for (;;) {
      const v = await fn();
      if (v) { return v; }
      if (Date.now() - started > ms) { throw new Error("等不到：" + what); }
      await page.sleep(250);
    }
  };

  await page.send("/goal 把 dev/README.md 里那段命令全部跑通");
  await page.waitAnswer("验收清单");
  await page.goalPress("play");
  await until("判官开始验", async () => (await bar()).text.includes("判官正在验"));
  const rowsBefore = await openRows();
  check("判官在列表里", rowsBefore.some((r) => r.includes("判官 · 第 1 轮")), rowsBefore);

  // 判官正在验的时候你插一句话
  await page.send("先别改 README，改成写一个 run.md");

  // 目标条不该变成「已暂停」；存盘也该还是 active
  await page.sleep(800);
  const b = await bar();
  check("插话以后目标条还是「进行中」", b.tone === "run" && b.text.includes("进行中"), b);
  const g0 = goal();
  check("存盘：相位还是 active", !!g0 && g0.phase === "active", g0 && { phase: g0.phase, note: g0.note });

  // 正在验的那个判官不动：它还留在列表里，接着把这一轮验完
  const rowsAfter = await openRows();
  check("插话不动判官（它还在列表里、还在验）", rowsAfter.some((r) => r.includes("判官 · 第 1 轮")), rowsAfter);

  // 它照样验完，结论照样发回工人
  await until("判官这一轮的结论照常发回工人", async () => {
    const sys = await systemText();
    if (sys.includes("第 1 轮没过") || sys.includes("验收通过")) { return sys; }
    // 这期间目标条一次都不该变成「已暂停」
    const now = await bar();
    if (now.tone === "stop") { throw new Error("插话把目标停掉了：" + JSON.stringify(now)); }
    return "";
  });

  // 循环接着转：工人再跑一轮，轮数往上走
  await until("轮数涨到 2（循环没停）", async () => {
    const g = goal();
    return g && g.rounds >= 2 ? g : null;
  });
  const g1 = goal();
  check("插话以后循环照转（轮数涨了、目标还是进行中）", g1.phase === "active" && g1.rounds >= 2, { phase: g1.phase, rounds: g1.rounds });
  await page.shot("goal-interject.png");

  // 想停就点目标条上那颗按钮（它变成「暂停」了）
  await page.goalPress("play");
  const stopped = await until("点「暂停」就停", async () => {
    const x = await bar();
    return x.tone === "stop" ? x : null;
  }, 30000);
  check("点「暂停」照样能停", stopped.text.includes("已暂停"), stopped);

  if (problems.length) {
    throw new Error("插话不该停目标：\n- " + problems.join("\n- "));
  }
  console.log("插话不停目标全过。");
};

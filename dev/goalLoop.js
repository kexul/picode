// @ts-nocheck
/**
 * goalLoop —— 验目标（/goal）的判官循环整条路（后端 + 界面一起，模型一头是假的）。
 *
 * 要验的几件事：
 *   1. 工人这一轮跑完，插件自动派一个判官会话去验（判官会话不进会话列表）；
 *   2. 判官没过 → 批评发回工人、工人接着干、再派下一轮判官；
 *   3. 判官报了“通过” → 目标变已完成、不再往下催、判官会话关掉；
 *   4. 轮数和结论都记在目标上（目标条 + 存盘）。
 *
 * 模型那头是假的（`--fake-pi`）：假 pi 看到判官提示词就演“跑条命令 + 调 update_goal”，
 * 第一轮报不过、第二轮报通过（见 dev/fakePi.js 与 FAKEPI_JUDGE_PASS_ON）。
 *
 * 判官每一步要跑一会儿才好看到「判官正在验」那条状态：用 FAKEPI_JUDGE_MS 拖慢它。
 *
 *   npm run web:shot -- --fake-pi --script dev/goalLoop.js
 */
const fs = require("fs");
const path = require("path");

// 判官这一步要跑一会儿才看得到「判官正在验」：没指定就把假判官拖慢一点
process.env.FAKEPI_JUDGE_MS = process.env.FAKEPI_JUDGE_MS || "2500";

module.exports = async (page) => {
  // 判官的轮数计数落在会话目录里：上一次跑剩的会把这个进程的第一轮当成第二轮
  const scratch = path.join(__dirname, ".scratch");
  try { fs.rmSync(path.join(scratch, ".judge-rounds"), { force: true }); } catch { /* 没有就算了 */ }

  await page.waitReady();
  const problems = [];
  const check = (what, ok, detail) => {
    if (!ok) { problems.push(what + (detail ? "：" + JSON.stringify(detail) : "")); }
    console.log((ok ? "✓ " : "✗ ") + what + (detail ? "  " + JSON.stringify(detail) : ""));
  };

  const goalsFile = path.join(process.env.PICHAT_HOME || path.join(scratch, "pichat"), "goals.json");
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
    return {
      exists: true,
      hidden: el.classList.contains("hidden"),
      tone: el.className.replace(/\\s*open\\b/, "").trim(),
      text: text ? text.textContent.trim() : "",
    };
  `);
  /** 「项目与会话」里「正在对话」那几行（判官会话不该出现在里面）。 */
  const openRows = async () => {
    const shown = await page.eval(`
      const dock = document.getElementById("sidebarDock");
      return !!dock && getComputedStyle(dock).display !== "none";
    `);
    if (!shown) { await page.click("#browserMenuBtn"); await page.sleep(400); }
    const rows = await page.eval(`
      const root = (function () {
        const dock = document.getElementById("sidebarDock");
        return (dock && getComputedStyle(dock).display !== "none") ? "#dockBody" : "#pickerBody";
      })();
      return Array.from(document.querySelectorAll(root + " .pk-item.pk-open"))
        .map((el) => { const t = el.querySelector(".pk-history-title"); return t ? t.textContent.trim() : ""; });
    `);
    if (!shown) { await page.press("Escape"); await page.sleep(250); }
    return rows;
  };
  const until = async (what, fn, ms = 120000) => {
    const started = Date.now();
    for (;;) {
      const v = await fn();
      if (v) { return v; }
      if (Date.now() - started > ms) { throw new Error("等不到：" + what); }
      await page.sleep(300);
    }
  };

  // ---- 1. 定目标、谈清单、开跑 ----
  await page.send("/goal 把 dev/README.md 里那段命令全部跑通");
  await page.waitAnswer("验收清单");
  await page.sleep(400);
  await page.send("/goal 开始");
  await page.waitAnswer("三个工具都跑过");

  // ---- 2. 判官正在验：目标条上要看得到（不然看着像卡住了） ----
  const judging = await until("目标条写出「判官正在验」", async () => {
    const b = await bar();
    return b.text.includes("判官正在验") ? b : null;
  });
  check("判官在验的时候目标条写出第几轮", judging.text.includes("第 1 轮") && judging.tone === "run", judging);

  // ---- 3. 第一轮判官：没过 → 批评发回工人 → 工人再干一轮 ----
  await until("第一轮判官报不过", async () => {
    const sys = await page.eval(`
      return Array.from(document.querySelectorAll(".msg.system")).map((el) => el.textContent.trim()).join(" | ");
    `);
    return sys.includes("第 1 轮没过") ? sys : "";
  });
  const rows = await openRows();
  check("判官会话没进「项目与会话」列表（只有工人那一个）", rows.length === 1, rows);

  // ---- 4. 第二轮判官：通过 → 目标完成 ----
  await until("目标变已完成", async () => {
    const b = await bar();
    return b.text === "目标已完成" ? b : null;
  });
  let g = goal();
  check("验收通过：目标已完成、轮数 2", !!g && g.phase === "complete" && g.rounds === 2, g && { phase: g.phase, rounds: g.rounds });
  check("判官的结论记在目标上", !!g && typeof g.note === "string" && g.note.includes("假判官"), g && g.note);

  const b = await bar();
  check("目标条是「已完成」那副脸", b.tone === "done" && b.text === "目标已完成", b);

  // 通过以后不该再有新的判官派出来（等一会看轮数还停在 2）
  await page.sleep(4000);
  g = goal();
  check("通过以后不再往下催（轮数没再涨）", !!g && g.rounds === 2, g && g.rounds);

  // 判官会话都关掉了：列表里仍然只有工人那一个
  const rows2 = await openRows();
  check("判官会话都关了（列表还是只有一个）", rows2.length === 1, rows2);

  // 记录里应该有两轮判官的意见（「第 N 轮没过」+「验收通过」）
  const sys = await page.eval(`
    return Array.from(document.querySelectorAll(".msg.system")).map((el) => el.textContent.trim()).join(" | ");
  `);
  check("两轮的结论都在消息流里说过", sys.includes("第 1 轮没过") && sys.includes("验收通过"), sys.slice(0, 200));
  await page.shot("goal-loop-done.png");

  if (problems.length) {
    throw new Error("目标循环有问题：\n- " + problems.join("\n- "));
  }
  console.log("目标循环全过。");
};

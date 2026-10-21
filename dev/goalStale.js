// @ts-nocheck
/**
 * goalStale —— 验「判官连着几轮报的是同一批没过条目 → 算没进展，自己停下」。
 *
 * 为什么会走到这儿：工人一直在原地打转（判官每轮说的都是同一条），再催下去只是烧钱。
 * 判官这边用一个环境变量让它永远报不过、且每次都报同一条：
 *
 *   npm run web:shot -- --fake-pi --script dev/goalStale.js
 */
const fs = require("fs");
  process.env.FAKEPI_JUDGE_PASS_ON = process.env.FAKEPI_JUDGE_PASS_ON || "99";
const path = require("path");

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
    return { hidden: el.classList.contains("hidden"), tone: el.className.replace(/\s*open\b/, "").trim(), text: text ? text.textContent.trim() : "" };
  `);
  const until = async (what, fn, ms = 180000) => {
    const started = Date.now();
    for (;;) {
      const v = await fn();
      if (v) { return v; }
      if (Date.now() - started > ms) { throw new Error("等不到：" + what); }
      await page.sleep(400);
    }
  };

  await page.send("/goal 把 dev/README.md 里那段命令全部跑通");
  await page.waitAnswer("验收清单");
  await page.send("/goal 开始");

  const b = await until("目标因为没进展停下来", async () => {
    const x = await bar();
    return x.tone === "stop" ? x : null;
  });
  const g = goal();
  check("停了以后目标条是「已暂停」", b.text.includes("已暂停"), b);
  check("停的理由写着“没进展”", !!g && String(g.note || "").includes("没进展"), g && g.note);
  check("停之前真跑了好几轮", !!g && g.rounds >= 3, g && g.rounds);
  const rounds = g.rounds;
  await page.sleep(4000);
  check("停下以后不再派人（轮数不涨）", (goal() || {}).rounds === rounds, { before: rounds, now: (goal() || {}).rounds });
  await page.shot("goal-stale.png");

  if (problems.length) {
    throw new Error("没进展那条路有问题：\n- " + problems.join("\n- "));
  }
  console.log("没进展停下这条路全过。");
};

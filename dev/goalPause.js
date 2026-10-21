// @ts-nocheck
/**
 * goalPause —— 验「目标跑着的时候，你自己开口说话 → 目标先暂停」以及「暂停时判官当场收掉」。
 *
 * 为什么要这样：判官会一轮一轮地催工人干活；你插一句话本来是要改方向，两边一起说就打架。
 * 所以人一开口目标就暂停，接着跑得你自己打 /goal 继续。
 *
 *   npm run web:shot -- --fake-pi --script dev/goalPause.js
 */
const fs = require("fs");
  process.env.FAKEPI_JUDGE_MS = process.env.FAKEPI_JUDGE_MS || "3000";
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
    const body = el.querySelector(".gb-body");
    return {
      exists: true, hidden: el.classList.contains("hidden"),
      tone: el.className.replace(/\s*open\b/, "").trim(),
      text: text ? text.textContent.trim() : "",
      body: body ? body.textContent.trim() : "",
    };
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
  await page.send("/goal 开始");
  await until("判官开始验", async () => (await bar()).text.includes("判官正在验"));

  // 判官还在验的时候你开口说话：目标该当场暂停，判官那个会话该被收掉
  await page.send("先别改 README，改成写一个 run.md");
  await page.sleep(800);
  const b = await bar();
  check("一插话目标条就变「已暂停」", b.tone === "stop" && b.text.includes("已暂停"), b);
  const g = goal();
  check("存盘：相位 paused、结论写着“你插话了”", !!g && g.phase === "paused" && String(g.note || "").includes("插话"), g && { phase: g.phase, note: g.note });

  // 目标暂停了就不该再往下催：等一会儿轮数不该再涨
  const roundsBefore = (goal() || {}).rounds;
  await page.sleep(6000);
  check("暂停以后判官不再派人、轮数不涨", (goal() || {}).rounds === roundsBefore, { before: roundsBefore, now: (goal() || {}).rounds });
  check("暂停以后目标条上还是「已暂停」", (await bar()).text.includes("已暂停"), await bar());

  // /goal 继续：接着跑（判官会重新派）
  await page.send("/goal 继续");
  await until("接着跑", async () => {
    const x = await bar();
    return x.tone === "run" ? x : null;
  }, 30000);
  check("打 /goal 继续 以后目标接着跑", true);
  await page.shot("goal-paused.png");

  if (problems.length) {
    throw new Error("目标暂停有问题：\n- " + problems.join("\n- "));
  }
  console.log("目标暂停全过。");
};

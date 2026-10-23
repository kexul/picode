// @ts-nocheck
/**
 * goalStale —— 验「判官连着几轮报的是同一批没过条目，也不会自己停」。
 *
 * 以前这里有「连着 3 轮没进展就停」「跑够 30 轮 / 3 小时就停」那几条自动停，现在都去掉了：
 * 只有验收通过、判官那一轮坏了（出错 / 既没报结论也没说话）、你打 /goal 暂停才停。
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

  // 判官每轮都报同一条「没过」；没有自动停，就该一直跑下去
  const ran = await until("连着好几轮报同一批条目还在往下跑", async () => {
    const g = goal();
    return g && g.rounds >= 4 ? g : null;
  });
  const b = await bar();
  check("跑过 4 轮以后目标条还是「进行中」", b.tone === "run" && b.text.includes("进行中"), b);
  check("目标没被自动停掉", ran.phase === "active", { phase: ran.phase, note: ran.note });

  // 手动停：只有这个能停
  await page.send("/goal 暂停");
  const stopped = await until("打 /goal 暂停 以后停下来", async () => {
    const x = await bar();
    return x.tone === "stop" ? x : null;
  });
  const g = goal();
  check("停了以后目标条是「已暂停」", stopped.text.includes("已暂停"), stopped);
  check("停的理由是手动暂停，不是“没进展”", !!g && !String(g.note || "").includes("没进展"), g && g.note);
  const rounds = g.rounds;
  await page.sleep(4000);
  check("停下以后不再派人（轮数不涨）", (goal() || {}).rounds === rounds, { before: rounds, now: (goal() || {}).rounds });
  await page.shot("goal-stale.png");

  if (problems.length) {
    throw new Error("没进展不停这条路有问题：\n- " + problems.join("\n- "));
  }
  console.log("同一批条目连报几轮也不自动停、只有手动暂停能停 —— 全过。");
};

// @ts-nocheck
/**
 * goalFlow —— 验「目标条」这块界面（不真叫模型：目标状态直接投给页面，跟后端推的是同一种消息）。
 *
 * 要验的几件事：
 *   1. 没目标时目标条不出现；
 *   2. 谈验收条件（还没清单 / 有清单）两条脸分别写什么；
 *   3. 开跑、暂停、完成三条脸；
 *   4. 点一下展开，能看到目标原文和验收清单全文；
 *   5. 切会话：目标条跟着换（每个会话有自己的一份）。
 *
 *   npm run web:shot -- --fake-pi --script dev/goalFlow.js
 */
module.exports = async (page) => {
  await page.waitReady();
  const problems = [];

  /** 把一条 goal 状态投给页面（跟后端 postToSession 推下来的一模一样）。 */
  const post = (m) => page.eval(`for (const x of ${JSON.stringify(m)}) { window.postMessage(x, "*"); } return true;`);
  const bar = () => page.eval(`
    const el = document.getElementById("goalBar");
    if (!el) { return { exists: false }; }
    const text = el.querySelector(".gb-text");
    const body = el.querySelector(".gb-body");
    return {
      exists: true,
      hidden: el.classList.contains("hidden"),
      tone: el.className.replace(/\\s*open\\b/, "").trim(),
      text: text ? text.textContent.trim() : "",
      open: el.classList.contains("open"),
      objective: body ? (body.querySelector(".gb-objective") || {}).textContent || "" : "",
      criteria: body ? Array.from(body.querySelectorAll(".gb-criteria li")).map((x) => x.textContent.trim()) : [],
    };
  `);
  const sid = await page.eval(`const p = document.querySelector(".session-pane"); return p ? p.dataset.sessionId : "";`);
  const check = (what, ok, detail) => {
    if (!ok) { problems.push(what + (detail ? "：" + JSON.stringify(detail) : "")); }
    console.log((ok ? "✓ " : "✗ ") + what + (detail ? "  " + JSON.stringify(detail) : ""));
  };

  // ---- 1. 一开始：没有目标，目标条不出现 ----
  let b = await bar();
  check("没有目标时不显示目标条", b.exists && b.hidden, b);

  // ---- 2. 谈验收条件，还没清单 ----
  const objective = "把 dev/README.md 里那段命令全部跑通，写一份能照着做的说明";
  const goal = (over) => Object.assign({
    objective,
    criteria: [],
    phase: "negotiating",
    startedAt: 0,
    rounds: 0,
    updatedAt: Date.now(),
  }, over || {});
  const summary = (text, tone) => ({ text, tone });

  await post([{ type: "goal", sessionId: sid, goal: goal(), summary: summary("目标待确认 · 还在谈验收条件", "talk") }]);
  await page.sleep(200);
  b = await bar();
  check("谈条件（还没清单）：一行字对", !b.hidden && b.tone === "talk" && b.text.includes("还在谈验收条件"), b);

  // ---- 3. 清单出来了：脸上要写有几条 ----
  const criteria = [
    "doc/README.md 里每条命令都能原样跑通，退出码为 0",
    "文档里列出的文件都在仓库里存在",
    "从空目录照文档做一遍不报错",
  ];
  await post([{ type: "goal", sessionId: sid, goal: goal({ criteria }), summary: summary("目标待确认 · 验收 3 条 · 打 /goal 开始", "talk") }]);
  await page.sleep(200);
  b = await bar();
  check("谈条件（有清单）：一行字对", b.text.includes("验收 3 条"), b);

  // ---- 4. 点开：看到目标原文和清单全文 ----
  await page.eval(`document.querySelector("#goalBar .gb-head").click(); return true;`);
  await page.sleep(200);
  b = await bar();
  check("点开以后是展开的", b.open, b);
  check("展开里有目标原文", b.objective.trim() === objective, b.objective);
  check("展开里有 3 条清单", b.criteria.length === 3 && b.criteria[1].includes("仓库里存在"), b.criteria);
  await page.shot("goal-negotiating.png");

  // ---- 5. 开跑 ----
  await post([{ type: "goal", sessionId: sid, goal: goal({ criteria, phase: "active", startedAt: Date.now() }), summary: summary("目标进行中", "run") }]);
  await page.sleep(200);
  b = await bar();
  check("开跑：一行字对、还是展开着", b.text === "目标进行中" && b.tone === "run" && b.open, b);
  await page.shot("goal-active.png");

  // ---- 6. 暂停 / 完成 ----
  await post([{ type: "goal", sessionId: sid, goal: goal({ criteria, phase: "paused" }), summary: summary("目标已暂停 · 打 /goal 继续 接着跑", "stop") }]);
  await page.sleep(150);
  b = await bar();
  check("暂停：一行字对", b.text.includes("已暂停") && b.tone === "stop", b);

  await post([{ type: "goal", sessionId: sid, goal: goal({ criteria, phase: "complete" }), summary: summary("目标已完成", "done") }]);
  await page.sleep(150);
  b = await bar();
  check("完成：一行字对", b.text === "目标已完成" && b.tone === "done", b);
  await page.shot("goal-done.png");

  // ---- 7. 收起来 / 清除 ----
  await page.eval(`document.querySelector("#goalBar .gb-head").click(); return true;`);
  await page.sleep(150);
  b = await bar();
  check("再点一下收起来", !b.open, b);

  await post([{ type: "goal", sessionId: sid, goal: null, summary: null }]);
  await page.sleep(150);
  b = await bar();
  check("清除目标以后整个收掉", b.hidden, b);

  // ---- 8. 切会话：各带各的目标 ----
  // 开一个新会话（真后端走一遍），它那边不该有目标
  await page.eval(`document.getElementById("newSessionBtn").click(); return true;`);
  await page.sleep(1200);
  b = await bar();
  check("新会话里没有目标条", b.hidden, b);

  if (problems.length) {
    throw new Error("目标条有问题：\n- " + problems.join("\n- "));
  }
  console.log("目标条全过。");
};

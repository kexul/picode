// @ts-nocheck
/**
 * goalCommand —— 验 /goal 那几个命令走通（后端 + 界面一起：命令拦截、清单取下来、目标条变脸、存盘）。
 *
 * 模型那头是假的（`--fake-pi`）：假 pi 看到「先别动手」就回一份验收清单（见 dev/fakePi.js），
 * 会话、历史、命令拦截、存盘全是真的。
 *
 * 判官（第二段）会在这条命令链后面接着转：这里把判官拖慢、并且让它一直报不过，
 * 好让目标停在「进行中」上验这几条命令本身。
 *
 *   npm run web:shot -- --fake-pi --script dev/goalCommand.js
 */
const fs = require("fs");
  process.env.FAKEPI_JUDGE_PASS_ON = process.env.FAKEPI_JUDGE_PASS_ON || "99";
  process.env.FAKEPI_JUDGE_MS = process.env.FAKEPI_JUDGE_MS || "4000";
const path = require("path");

module.exports = async (page) => {
  try { fs.rmSync(path.join(__dirname, ".scratch", ".judge-rounds"), { force: true }); } catch { /* 没有就算了 */ }
  await page.waitReady();
  const problems = [];
  const check = (what, ok, detail) => {
    if (!ok) { problems.push(what + (detail ? "：" + JSON.stringify(detail) : "")); }
    console.log((ok ? "✓ " : "✗ ") + what + (detail ? "  " + JSON.stringify(detail) : ""));
  };

  /** 目标存档（跟后端同一个目录：调试时 PICHAT_HOME 指到 dev/.scratch/pichat）。 */
  const goalsFile = path.join(process.env.PICHAT_HOME || path.join(__dirname, ".scratch", "pichat"), "goals.json");
  // 调试目录里那份是上一跑留下的（会话文件一个个不同，每条都留在里面）：先清空，
  // 不然“存档里是不是只剩这一条”这类检查没个准。
  try { fs.rmSync(goalsFile, { force: true }); } catch { /* 没有就算了 */ }
  const goals = () => {
    try { return JSON.parse(fs.readFileSync(goalsFile, "utf8")).goals || {}; } catch { return {}; }
  };
  const onlyGoal = () => {
    const all = goals();
    const keys = Object.keys(all);
    return keys.length === 1 ? all[keys[0]] : null;
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

  // ---- 1. 定目标：命令被插件接住，不进对话当普通消息；马上发一版谈判提示 ----
  await page.send("/goal 把 dev/README.md 里那段命令全部跑通，写一份能照着做的说明");
  await page.waitAnswer("验收清单");
  await page.sleep(600);

  let b = await bar();
  check("目标条出现了，写着待确认 + 验收 3 条", !b.hidden && b.tone === "talk" && b.text.includes("验收 3 条"), b);

  const g1 = onlyGoal();
  check("存盘：目标原文与 3 条清单都在，相位还是「谈」",
    !!g1 && g1.phase === "negotiating" && g1.criteria.length === 3 && g1.objective.includes("dev/README.md"),
    g1 && { phase: g1.phase, criteria: g1.criteria.length });

  const asked = await page.eval(`
    const users = Array.from(document.querySelectorAll(".msg.user"));
    return users.map((el) => el.textContent.slice(0, 60));
  `);
  check("/goal 那行原文在记录里（「你说过的话」那份数据就是从这儿来的）",
    asked.some((t) => t.includes("/goal 把 dev/README.md")), asked);
  await page.shot("goal-command-negotiating.png");

  // ---- 2. 目标条上的「开始」：目标条变「进行中」，相位变 active ----
  await page.goalPress("play");
  // 开跑那条提示词带着清单：“开始干”的三个字在清单没被藏住的【任务】里，
  // 假 pi 收到后会演一遍默认剧本（三个工具那些），等它跑完再看目标条
  await page.waitAnswer("三个工具都跑过");
  await page.sleep(600);
  b = await bar();
  // 判官可能已经派出来了（第二段循环），所以这里只认开头那一段
  check("开跑：目标条写着进行中", b.text.startsWith("目标进行中") && b.tone === "run", b);
  const g2 = onlyGoal();
  check("存盘：相位 active、起始时刻有了", !!g2 && g2.phase === "active" && g2.startedAt > 0, g2 && { phase: g2.phase, startedAt: g2.startedAt });
  await page.shot("goal-command-active.png");

  // ---- 3. 开始那颗按了变成暂停，再按又变回开始 ----
  const playLabel = () => page.eval(`const el = document.querySelector("#goalBar .gb-act.gb-play"); return el ? (el.getAttribute("aria-label") || "") + "/" + (el.dataset.act || "") : "";`);
  check("跑着的时候那颗按钮是暂停图标", (await playLabel()) === "暂停/pause", await playLabel());
  await page.goalPress("play");
  await page.sleep(400);
  b = await bar();
  check("点了暂停：目标条写着已暂停", b.text.includes("已暂停") && b.tone === "stop", b);
  check("存盘：相位 paused", (onlyGoal() || {}).phase === "paused", onlyGoal() && onlyGoal().phase);
  check("停下来以后那颗按钮又变回播放图标", (await playLabel()) === "开始/start", await playLabel());

  await page.goalPress("play");
  await page.sleep(600);
  b = await bar();
  check("再点开始：目标条回到进行中", b.text.startsWith("目标进行中") && b.tone === "run", b);

  // ---- 3.5 刷新页面（重连）：目标条要能从后端补回来 ----
  await page.eval("location.reload(); return true;");
  await page.sleep(1200);
  await page.waitReady(60000);
  for (let i = 0; i < 20; i++) {
    b = await bar();
    if (b.exists && !b.hidden) { break; }
    await page.sleep(300);
  }
  check("刷新页面后目标条还在（会话列表里带的）", b.text.startsWith("目标进行中"), b);

  // ---- 4. /goal（不带参数）：只把目标条展开，不往对话里写东西 ----
  // 注意尾随那个空格：不写的话输入框会弹「/ 命令菜单」，回车被它吃掉（只把命令补进输入框），
  // 这是现有行为（/compact 也一样），不是这个功能的事。
  const before = await page.eval(`return document.querySelectorAll(".msg").length;`);
  await page.send("/goal ");
  await page.sleep(600);
  const open = await page.eval(`return !!document.querySelector("#goalBar.open");`);
  const after = await page.eval(`return document.querySelectorAll(".msg").length;`);
  check("/goal 只展开目标条、不多出一条消息", open && after === before, { open, before, after });

  // ---- 5. 目标条上的「停止」：目标条收掉，存档里也没了 ----
  await page.goalPress("stop");
  await page.sleep(400);
  b = await bar();
  check("停止：目标条收掉", b.hidden, b);
  check("停止：存档里那条也删了", Object.keys(goals()).length === 0, goals());

  // ---- 6. 再定一个目标，用「停止」关掉 ----
  await page.send("/goal 再定一个目标，专门验那颗停止按钮");
  await page.waitAnswer("验收清单");
  await page.sleep(600);
  b = await bar();
  const hasButtons = await page.eval(`return { play: !!document.querySelector("#goalBar .gb-act.gb-play"), stop: !!document.querySelector("#goalBar .gb-act.gb-stop") };`);
  check("又出现目标条，展开里两颗按钮都在", !b.hidden && hasButtons.play && hasButtons.stop, { b, hasButtons });
  // 撑开拍一张：两颗按钮在展开的上面（“开始”現在是这模样）
  await page.eval(`document.querySelector("#goalBar .gb-head").click(); return true;`);
  await page.sleep(300);
  await page.shot("goal-command-buttons.png");
  await page.goalPress("stop");
  await page.sleep(800);
  b = await bar();
  check("点停止以后目标条收掉", b.hidden, b);
  check("点停止以后存档里也没了", Object.keys(goals()).length === 0, goals());

  // ---- 7. 打以前的那些控制词：别稀里糊涂定成一个叫「停止」的目标 ----
  const beforeWarn = await page.eval(`return Object.keys(${JSON.stringify(goals())}).length;`);
  await page.send("/goal 停止");
  await page.sleep(600);
  const said = await page.eval(`
    return Array.from(document.querySelectorAll(".msg.system")).map((el) => el.textContent.trim()).join(" | ");
  `);
  check("打 /goal 停止 不会变成新目标，而是告诉你按钮在目标条上",
    said.includes("目标条上的按钮") && Object.keys(goals()).length === beforeWarn && (await bar()).hidden,
    { said: said.slice(0, 160), goals: goals() });

  // ---- 8. 命令菜单里要有 /goal 那一条（打 / 开头就弹） ----
  await page.type("/goal");
  await page.sleep(600);
  const menu = await page.eval(`
    const el = document.getElementById("fileMenu");
    if (!el || el.classList.contains("hidden")) { return { open: false, items: [] }; }
    return { open: true, items: Array.from(el.querySelectorAll(".file-item")).map((x) => x.textContent.trim()) };
  `);
  check("命令菜单里能搜到 /goal", menu.open && menu.items.some((t) => t.includes("/goal")), menu);
  await page.shot("goal-command-menu.png");

  if (problems.length) {
    throw new Error("/goal 命令有问题：\n- " + problems.join("\n- "));
  }
  console.log("/goal 命令全过。");
};

// @ts-nocheck
/**
 * goalLoop —— 验目标（/goal）的判官循环整条路（后端 + 界面一起，模型一头是假的）。
 *
 * 要验的几件事：
 *   1. 工人这一轮跑完，插件自动派一个判官会话去验（判官会话在跑的时候进「正在对话」列表，
 *      点进去能看它验到哪一步；报完结论就关掉，但正看着它时留着、你自己关）；
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
    return {
      exists: true,
      hidden: el.classList.contains("hidden"),
      tone: el.className.replace(/\\s*open\\b/, "").trim(),
      text: text ? text.textContent.trim() : "",
    };
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
  /** 点「正在对话」里名字含 needle 的那一行（宽窗常驻那一列、窄窗浮层都认）。 */
  const clickRow = async (needle) => {
    const opened = !(await panelShown());
    if (opened) { await page.click("#browserMenuBtn"); await page.sleep(400); }
    const hit = await page.eval(`
      const root = (function () {
        const dock = document.getElementById("sidebarDock");
        return (dock && getComputedStyle(dock).display !== "none") ? "#dockBody" : "#pickerBody";
      })();
      const rows = Array.from(document.querySelectorAll(root + " .pk-item.pk-open"));
      const hit = rows.find((el) => {
        const t = el.querySelector(".pk-history-title");
        return !!t && t.textContent.includes(${JSON.stringify(needle)});
      });
      if (!hit) { return false; }
      hit.click();
      return true;
    `);
    await page.sleep(500);
    if (opened && (await panelShown())) { await page.press("Escape"); await page.sleep(250); }
    if (!hit) { throw new Error("列表里没有「" + needle + "」那一行"); }
  };
  /** 现在是哪个会话（顶条中间那行字）。 */
  const topName = () => page.eval(`
    const el = document.querySelector("#sessionName .sn-text");
    return el ? el.textContent.trim() : "";
  `);
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
  await page.goalPress("play");
  await page.waitAnswer("三个工具都跑过");

  // ---- 2. 判官正在验：目标条上要看得到（不然看着像卡住了） ----
  const judging = await until("目标条写出「判官正在验」", async () => {
    const b = await bar();
    return b.text.includes("判官正在验") ? b : null;
  });
  check("判官在验的时候目标条写出第几轮", judging.text.includes("第 1 轮") && judging.tone === "run", judging);

  // 判官跑着的时候在列表里看得见（缩进挂在工人下面），点进去能看它验到哪一步
  const judgingRows = await until("判官在跑的时候出现在列表里", async () => {
    const rows = await openRows();
    return rows.some((r) => r.includes("判官")) ? rows : null;
  }, 20000);
  check("判官在跑的时候进了「项目与会话」列表（工人 + 判官两行）", judgingRows.length === 2, judgingRows);
  await page.shot("goal-judge-running.png");

  // ---- 3. 点进去看判官：它报完结论不会抽走你正在看的那一页 ----
  await clickRow("判官");
  const name1 = await topName();
  check("点判官那一行就切到它（看得到它验到哪一步）", name1.includes("判官"), name1);
  await page.shot("goal-judge-open.png");

  // 第二轮判官一开，说明第一轮那个已经报了结论（目标那边处理完了）
  await until("第一轮判官报上结论", async () => {
    const rows = await openRows();
    return rows.some((r) => r.includes("判官 · 第 2 轮"));
  });
  const kept = await openRows();
  check("你正看着它的时候，判官报完结论不硬关掉", kept.some((r) => r.includes("判官 · 第 1 轮")), kept);

  // 看完了自己关：按设置里「关闭会话」那个组合键（当前看的就是它），关掉以后列表里就没了。
  // 不能写死成某一个键：默认是 Alt+W，人在设置里换过就是别的（函数要求修饰键完全一致，
  // 多按一个 Ctrl 就不认，于是那一下什么也不发生、只是等着超时）。
  const closeKey = (() => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(process.env.PICHAT_HOME || path.join(scratch, "pichat"), "config.json"), "utf8"));
      return typeof cfg.closeSessionKey === "string" && cfg.closeSessionKey ? cfg.closeSessionKey : "alt+w";
    } catch { return "alt+w"; }
  })();
  const pressCloseKey = async () => {
    const parts = closeKey.split("+").map((s) => s.trim().toLowerCase());
    const name = parts.pop() || "w";
    let modifiers = 0;   // CDP 的位：Alt=1、Ctrl=2、Meta=4、Shift=8
    if (parts.includes("alt")) { modifiers |= 1; }
    if (parts.includes("ctrl")) { modifiers |= 2; }
    if (parts.includes("meta")) { modifiers |= 4; }
    if (parts.includes("shift")) { modifiers |= 8; }
    const vk = name.toUpperCase().charCodeAt(0);
    for (const type of ["keyDown", "keyUp"]) {
      await page.cdp.send("Input.dispatchKeyEvent", {
        type, key: name, code: "Key" + name.toUpperCase(),
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
      });
    }
  };
  await pressCloseKey();
  const gone = await until("自己关掉的判官从列表里消失", async () => {
    const rows = await openRows();
    return !rows.some((r) => r.includes("判官 · 第 1 轮"));
  });
  check("自己关掉以后列表里就没它了", gone === true, gone);

  // 回到工人那边，接着看后面的几轮（后面的断言读的是工人那份消息流）
  await clickRow("假标题");

  // ---- 4. 第一轮判官：没过 → 批评发回工人 → 工人再干一轮 ----
  await until("第一轮判官报不过", async () => {
    const sys = await page.eval(`
      return Array.from(document.querySelectorAll(".msg.system")).map((el) => el.textContent.trim()).join(" | ");
    `);
    return sys.includes("第 1 轮没过") ? sys : "";
  });

  // ---- 5. 第二轮判官：通过 → 目标完成 ----
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
  check("两轮判官都关掉了（列表还是只有一个）", rows2.length === 1, rows2);

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

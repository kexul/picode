// @ts-nocheck
/**
 * tabaApart —— 验「平级派活」（task 的 separate: true）：另开一个会话，跑完不交回、也不自动关。
 *
 *   npm run web:shot -- --fake-pi --script dev/tabaApart.js
 *
 * 假 pi 认「平级派活」这一句（见 dev/fakePi.js），调的是真扩展里那个 task 工具，所以
 * 暗号、协议、插件那一头（tabaSpawnApart）全是真的；假 pi 只负责当模型、只负责当那个新会话。
 *
 * 要验的五件事：
 *   1. 回话是「另开了一个会话」那一套（不是「子会话」）
 *   2. 新会话真开在另一个目录里（会话格上带着那个目录）
 *   3. 它不算子会话：派活那个会话的小点底下没有子会话数、也不因它亮着
 *   4. 它跑完不交回、也不被自动关掉（还在那一格上）
 *   5. 它自己还能再往下派（平级没有层数限制）
 *
 * 平级那个会话故意磨一会儿才回话：第 3 条得在它「还在跑」的时候看才有意义。
 * 慢一点跑（假 pi 的节奏，免得它跑完了才轮到检查）：
 *   FAKEPI_THINK_MS=900 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaApart.js
 */
// 平级那个会话慢一点才收工（它收到的任务正文带【任务】，假 pi 把它当“被派出去的那个”）
process.env.FAKEPI_CHILD_SLOW_MS = process.env.FAKEPI_CHILD_SLOW_MS || "9000";

const fs = require("fs");
const os = require("os");
const path = require("path");

module.exports = async (page) => {
  /** 反复试到 fn 返回真值为止。 */
  const until = async (what, fn, ms = 30000) => {
    const started = Date.now();
    for (;;) {
      const v = await fn();
      if (v) { return v; }
      if (Date.now() - started > ms) { throw new Error("等不到：" + what); }
      await page.sleep(200);
    }
  };

  /** 顶条上那一排会话格：名字、目录、目录名那一行、小点底下挂的数。 */
  const tabs = () => page.eval(`
    return Array.from(document.querySelectorAll('#sessionTabs .sn-tab:not(.hidden)')).map((el) => {
      const n = el.querySelector('.sn-text');
      const c = el.querySelector('.sn-cwd');
      const k = el.querySelector('.sn-count');
      return {
        name: n ? n.textContent.trim() : '',
        cwd: el.dataset.cwd || '',
        cwdLabel: c ? c.textContent.trim() : '',
        count: k ? k.textContent.trim() : '',
        childRunning: el.classList.contains('child-running'),
        streaming: el.classList.contains('streaming'),
        current: el.classList.contains('current'),
      };
    });
  `);
  const lastAssistant = () => page.eval("var a = document.querySelectorAll('.msg.assistant'); var e = a[a.length - 1]; return e ? e.textContent : '';");
  const userText = () => page.eval("return Array.from(document.querySelectorAll('.msg.user')).map(function (e) { return e.textContent; }).join('\\n');");

  const apartDir = path.join(os.tmpdir(), "pichat-apart-work");
  const isApart = (t) => String(t.cwd).toLowerCase() === apartDir.toLowerCase();

  // ---- 1. 派活：回话是「另开了一个会话」那一套 ----
  await page.send("平级派活：那边也开一个");
  const reply = await until("回话里说是另开了一个会话", async () => {
    const text = await lastAssistant();
    return text.indexOf("不会把结果交回来") >= 0 ? text : "";
  });
  if (/已派出子会话/.test(reply)) { throw new Error("回话还是子会话那一套：" + reply); }
  if (reply.indexOf("另开了一个会话") < 0) { throw new Error("回话里没说清“不交回”：" + reply); }
  console.log("① 派活的回话对了（不是子会话那一套）");

  // ---- 2. 新会话开在另一个目录里，名字用的是派活时给的那个 ----
  const two = await until("会话格里多出一格", async () => {
    const list = await tabs();
    return list.length >= 2 && list.some(isApart) ? list : null;
  });
  const apart = two.find(isApart);
  console.log("两组会话格：" + JSON.stringify(two));
  if (apart.cwdLabel !== path.basename(apartDir)) { throw new Error("新会话那格上写的目录不对：" + apart.cwdLabel); }
  if (apart.name !== "平级假会话") { throw new Error("新会话没拿到派活时给的名字：" + apart.name); }
  console.log("② 新会话真开在 " + apartDir + "，名字也对");
  await page.shot("taba-apart-1-spawned.png");

  // ---- 3. 它不算子会话：派活那个会话的小点底下没有数、也不因它亮着 ----
  const parent = two.find((t) => !isApart(t));
  if (parent.count) { throw new Error("派活那个会话底下挂出子会话数了：" + parent.count); }
  if (parent.childRunning) { throw new Error("派活那个会话因它亮着了（当成子会话了）"); }
  console.log("③ 派活那个会话那边什么都没挂");

  // ---- 4. 跑完不交回、也不被自动关掉 ----
  await until("那边跑完了", async () => {
    const list = await tabs();
    return list.some((t) => isApart(t) && t.streaming) ? null : list;
  }, 60000);
  await page.sleep(1500);   // 跑完那一刻最容易自动关，给它一点时间露出马脚
  const after = await tabs();
  console.log("跑完以后：" + JSON.stringify(after));
  if (!after.some(isApart)) { throw new Error("平级那个会话被自动关掉了"); }
  if (/跑完了，用时|把结果交回来/.test(await userText())) { throw new Error("派活那个会话收到了交回的结果"); }
  console.log("④ 跑完了还留着，也没交回");

  // 会话文件里不该有子会话那个记号（有的话历史列表会把它藏起来）
  const stamp = await page.eval("return document.querySelector('#sessionTabs .sn-tab.current .sn-text').textContent.trim()");
  const apartFiles = fs.existsSync(apartDir)
    ? fs.readdirSync(apartDir).filter((n) => n.startsWith("fake-session-") && n.endsWith(".jsonl"))
    : [];
  if (apartFiles.length === 0) { throw new Error("那边没落下会话文件，验不了记号"); }
  const raw = apartFiles.map((n) => fs.readFileSync(path.join(apartDir, n), "utf8")).join("\n");
  if (raw.indexOf("【收尾要求】") >= 0) { throw new Error("那条消息里带着子会话的记号，历史列表会把它藏起来"); }
  if (raw.indexOf("【这件事怎么收尾】") < 0) { throw new Error("那边收到的不是平级那一套收尾要求"); }
  console.log("⑤ 会话文件里没有子会话的记号（当前这一格是「" + stamp + "」）");

  // ---- 5. 它自己还能再往下派（平级没有层数限制）----
  await page.eval(`
    const el = Array.from(document.querySelectorAll('#sessionTabs .sn-tab:not(.hidden)'))
      .find((e) => (e.dataset.cwd || '').toLowerCase() === ${JSON.stringify(apartDir.toLowerCase())});
    if (!el) { return false; }
    el.click();
    return true;
  `);
  await until("切到平级那个会话", async () => {
    const list = await tabs();
    const cur = list.find((t) => t.current);
    return cur && isApart(cur) ? cur : null;
  });
  await page.sleep(600);
  await page.send("平级派活：再往下一层");
  const three = await until("再往下派的那一格出来了", async () => {
    const list = await tabs();
    return list.length >= 3 ? list : null;
  }, 40000);
  console.log("再派一层：" + JSON.stringify(three.map((t) => t.name + "@" + t.cwdLabel)));
  await page.shot("taba-apart-2-depth.png");

  console.log("平级派活这五条都对了：另开、另的目录、不算子会话、不交回不关、能再往下派。");
};

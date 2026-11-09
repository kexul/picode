// @ts-nocheck
/**
 * newSessionChild —— 验「派出去的子会话还在跑时，点顶条那颗加号（新建会话）不关掉派活那个会话」。
 *
 *   FAKEPI_CHILD_SLOW_MS=8000 npm run web:shot -- --fake-pi --script dev/newSessionChild.js
 *
 * 那颗加号是 pi 里 /new 那套：旧的那个闲着就顺手关掉，顶条上只留一格（见 chatControllerBase
 * 的 newSession）。以前“闲着”只看这一轮在不在跑、后台有没有命令，子会话在跑不算 ——
 * 于是点一下加号，派活那个会话被关掉，还在跑的子会话当场跟它断掉（变成独立会话），
 * 跑完的结果也交不回去了。这条就是钉住那一下：三步
 *   ① 派活（子会话慢慢跑，别在这一步就跑完）：顶条上仍旧一格
 *   ② 点加号：顶条上变成两格 —— 派活那个会话还在（没有被关掉）
 *   ③ 子会话跑完：结果照旧交回派活那个会话（切回那一格，看到那句「tab 已经自动关掉」）
 *
 * 假 pi 那句话里带“派活”就往真扩展里调一次 task（见 dev/fakePi.js）；
 * FAKEPI_CHILD_SLOW_MS 让子会话磨一会儿才回话，好在它还没跑完的时候去点加号。
 */
module.exports = async (page) => {
  await page.waitReady();
  // 刚连上那会儿后端还会推一两次会话列表，等它落定再动
  await page.sleep(1200);

  /** 顶条上现在几格、每格叫什么、哪一格是当前那一格、每格底下还有几个子会话在跑。 */
  const bar = () => page.eval(`
    const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden"));
    return {
      格数: tabs.length,
      名字: tabs.map((t) => ((t.querySelector(".sn-text") || {}).textContent || "").trim()),
      当前: tabs.map((t) => t.classList.contains("current")),
      子会话在跑: tabs.map((t) => ((t.querySelector(".sn-count") || {}).textContent || "").trim()),
    };
  `);
  const say = async (what) => console.log("  " + what + "：" + JSON.stringify(await bar()));

  /** 反复试到 fn 返回真值为止（等不到就抛：别让它默默往下跑）。 */
  const until = async (what, fn, ms = 40000) => {
    const started = Date.now();
    for (;;) {
      const v = await fn();
      if (v) { return v; }
      if (Date.now() - started > ms) { throw new Error("等不到：" + what); }
      await page.sleep(200);
    }
  };

  // ---- ① 派活：子会话跑起来了，顶条上仍旧一格 ----
  const before = await bar();
  await page.send("派活：看看认证模块");
  // 派活那个会话这一轮说完（假 pi 说了“子会话工具回话”那句），子会话还在慢慢跑
  await page.waitText("子会话工具回话", 20000);
  const one = await until("子会话那颗点数出来（顶条上写着有 1 个在跑）", async () => {
    const b = await bar();
    return b.格数 === 1 && b.子会话在跑[0] === "1" ? b : null;
  });
  console.log("① 派活之后：" + JSON.stringify(one));
  await page.shot("new-session-child-1-spawned.png");

  // ---- ② 点加号：派活那个会话还在（顶条上两格）----
  await page.click("#newSessionBtn");
  const two = await until("顶条上变成两格（派活那个会话没被关掉）", async () => {
    const b = await bar();
    return b.格数 === 2 ? b : null;
  });
  console.log("② 点了加号之后：" + JSON.stringify(two));
  // 旧那一格还挂着那个还在跑的子会话（点下面写着 1）：说明两边还连着，不是“另开一份”
  const kept = two.子会话在跑.filter((n) => n === "1");
  if (kept.length !== 1) { throw new Error("旧那一格上没写着子会话在跑：" + JSON.stringify(two)); }
  await page.shot("new-session-child-2-two-tabs.png");

  // ---- ③ 子会话跑完：结果照旧交回派活那个会话 ----
  // 切回旧那一格（不是当前这一格就是它）
  await page.eval(`
    const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden"));
    const old = tabs.find((t) => !t.classList.contains("current"));
    if (!old) { return false; }
    old.click();
    return true;
  `);
  // 子会话跑完会交回一条“【子会话…跑完了】”，末尾写着 tab 已经自动关掉
  await page.waitText("tab 已经自动关掉", 40000);
  console.log("③ 交回的结果收到了");
  await page.shot("new-session-child-3-delivered.png");

  console.log("对了：子会话在跑的时候点加号，派活那个会话留着，结果照旧交得回来。");
};

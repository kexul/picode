// @ts-nocheck
/**
 * tabaTools —— 验子会话那三个工具里平时没人喊的那两个：停掉（taba_stop）与查看（taba_peek）。
 *
 *   FAKEPI_THINK_MS=4000 FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tabaTools.js
 *
 * 假 pi 认这几句话（见 dev/fakePi.js）：带「派活」演 taba、带「停掉子会话」演 taba_stop、
 * 带「看子会话」演 taba_peek。这三个工具的实现就是 pi 进程里真加载的那段代码
 * （宿主写出来的 taba-bridge-<版本>.ts，源码见 src/tabaBridgeSource.ts），所以这一趟跑下来，
 * 它写暗号、读名录、按名字找子会话这些代码都真跑过一遍。
 *
 * 顺序是"派活 → 停掉 → 查看"：停掉那一句得趁子会话还在跑（它跑一轮要十几秒，假 pi 得放慢），
 * 停完再看名录，看到的就是被停之后的收尾状态。
 *
 * 三处讲究：
 *   - 每发一句都等这一轮真跑完（看消息流末尾那颗「停止生成」）再发下一句：不等的话上一轮还在
 *     流式时下一句就进去了，两轮会叠在一起跑（假 pi 不排队，真 pi 会）。
 *   - 每条断言只看"最后一个助手气泡"：上一轮的回话还留在页面上，拿整段助手文字去比会误判。
 *   - 别拿整页文字去 includes：工具回话在页面上只出现在悬浮提示框里，而那一层挂在 body 上，
 *     会把整页 innerText 插花（「已发出停止请求」会被别的字拆开）。
 */

// 第二步要「趁它还在跑」把它停掉：假子会话默认几百毫秒就结束，这里让它磨一会儿。
// 就算真没停掉，它也会自己结束，不会把后面几幕卡死。
process.env.FAKEPI_CHILD_SLOW_MS = process.env.FAKEPI_CHILD_SLOW_MS || "15000";

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

  /** 最后一个助手气泡的文字（每一步只认这一步的回话）。 */
  const lastAssistant = () => page.eval("var a = document.querySelectorAll('.msg.assistant'); var e = a[a.length - 1]; return e ? e.textContent : '';");
  /** 交回的结果落在用户那侧气泡里。 */
  const userText = () => page.eval("return Array.from(document.querySelectorAll('.msg.user')).map(function (e) { return e.textContent; }).join('\\n');");
  /** 生成中时消息流末尾那颗「停止生成」露着。 */
  const generating = () => page.eval("var b = document.querySelector('.session-view:not(.off) .msg-endhint-stop'); return !!(b && !b.classList.contains('hidden'));");

  /** 说一句、等最后一个气泡里出现要等的字、再等这一轮收尾，最后把这一轮的文字取回来。 */
  const say = async (text, want) => {
    await page.send(text);
    await until("回话里出现：" + want, async () => ((await lastAssistant()).indexOf(want) >= 0 ? true : ""), 40000);
    await until("这一轮跑完", async () => !(await generating()), 60000);
    return await lastAssistant();
  };

  // ---- 1. 派活：走真扩展的 taba ----
  await say("派活：干一件慢活", "已派出子会话");
  console.log("① 派活：子会话派出去了（回话由真扩展给）");

  // ---- 2. 停掉：趁它还在跑，走真扩展的 taba_stop ----
  // 先等一下：子会话自己的 pi 进程要冷启动一两秒，派出去当场就停等于停一个还没跑起来的东西
  // （那种情况下它不会被中止，待会儿自己跑完交回「跑完了」，下一步就等不到「没有正常跑完」）。
  await page.sleep(2500);
  await say("停掉子会话", "已发出停止请求");
  console.log("② 停掉：真扩展回了「已发出停止请求」");
  await until("被停掉的子会话交回结果", async () => ((await userText()).indexOf("没有正常跑完") >= 0 ? true : ""), 60000);
  console.log("③ 被停掉的子会话把结果交回父会话了（被中止了）");

  // ---- 3. 查看：走真扩展的 taba_peek（去读名录文件）----
  const seen = await say("看子会话", "派给它的任务");
  if (!/子会话「假子会话」（编号 [0-9a-f]+）/.test(seen)) { throw new Error("查看那条没把子会话列出来"); }
  console.log("④ 查看：名录读出来了（" + (seen.match(/状态：[^\n]{0,26}/) || [""])[0] + "）");

  await page.shot("taba-tools.png");
  console.log("停掉与查看都走过真扩展的代码了。");
};

// 会话（没有 tab 栏那套）的界面验证流程，配 npm run web:shot -- --fake-pi --script dev/sessionFlow.js 用：
//   1. A 会话发一句 → 假 pi 会给这个会话起标题（顶条中间那行应该跟着变）
//   2. 输入框里留半句草稿
//   3. 新建 B 会话、说一句
//   4. 打开「项目与会话」列表 → 截图（看上半「正在对话」段：两条 + 当前高亮）
//   5. 切回 A → 截图（消息和草稿都该还在）
//   6. 列表里点第 2 条的 × → 确认条；点行身（勾前面那块）→ 该切过去，不该真关
//   7. 再点 × 再点那颗勾 → 截图（那条会话没了）
// 点叉后那一行只该变红、行尾多一颗勾（名字照旧、整行大小不变），再点勾才真关；
// 确认条开着时点行身是“切过去”（列表这一份连带收起来），不能替那颗勾把关会话点实了。
module.exports = async (page) => {
  await page.send("第一个会话：看看标题");
  await page.sleep(3000);
  await page.type("打一半的草稿");
  await page.sleep(300);
  await page.shot("session-a.png");

  await page.click("#newSessionBtn");
  await page.sleep(1000);
  await page.send("第二个会话：标题也该变");
  await page.sleep(3000);

  await page.click("#browserMenuBtn");
  await page.sleep(800);
  await page.shot("session-list.png");

  // 切回列表里第一条（A 会话）
  await page.eval("document.querySelectorAll('.pk-item.pk-open')[0].click()");
  await page.sleep(1200);
  await page.shot("session-back-a.png");

  // 再开列表，点第 2 条的关闭叉（第一次点只变确认条：整行变红、行尾多一颗勾），再点勾
  await page.click("#browserMenuBtn");
  await page.sleep(700);
  const before = await page.eval("const r = document.querySelectorAll('.pk-item.pk-open')[1].getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) };");
  await page.eval("document.querySelectorAll('.pk-item.pk-open')[1].querySelector('.pk-open-close').click();");
  await page.sleep(400);
  const after = await page.eval(`
    const row = document.querySelectorAll(".pk-item.pk-open")[1];
    const r = row.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      title: (row.querySelector(".pk-history-title") || {}).textContent || "",
      confirm: row.classList.contains("pk-open-confirm"),
      yes: !!row.querySelector(".pk-open-yes"), no: !!row.querySelector(".pk-open-no"),
    };
  `);
  console.log("确认条：", JSON.stringify(before), "→", JSON.stringify(after));
  if (!after.confirm || !after.yes || !after.no) { throw new Error("点叉后这一行应该是确认条（行尾一颗勾一颗叉）"); }
  if (!after.title) { throw new Error("确认条里还得看得见关的是哪一个"); }
  if (after.w !== before.w || after.h !== before.h) { throw new Error(`确认条把这一行撑大了：${JSON.stringify(before)} → ${JSON.stringify(after)}`); }
  await page.shot("session-close-confirm.png");

  // 确认条开着时点行身（勾前面那块）：该切到这个会话（列表这一份连带收起来），不能把关会话点实了
  await page.eval("document.querySelectorAll('.pk-item.pk-open')[1].querySelector('.pk-history-main').click();");
  await page.sleep(1200);
  await page.click("#browserMenuBtn");
  await page.sleep(700);
  const rowBody = JSON.parse(await page.eval(`
    const rows = [...document.querySelectorAll(".pk-item.pk-open")];
    return JSON.stringify({
      rows: rows.length,
      confirm: rows.some((r) => r.classList.contains("pk-open-confirm")),
      current: rows.findIndex((r) => r.classList.contains("current")),
    });
  `));
  console.log("点行身之后再开列表：", JSON.stringify(rowBody));
  if (rowBody.rows !== 2) { throw new Error("确认条开着时点行身不该真关会话：" + JSON.stringify(rowBody)); }
  if (rowBody.confirm) { throw new Error("点行身该把确认条撤掉：" + JSON.stringify(rowBody)); }
  if (rowBody.current !== 1) { throw new Error("点行身该切到那一条（当前该是第 2 条）：" + JSON.stringify(rowBody)); }
  await page.shot("session-row-body.png");

  // 切回第一条（让后面那次“点勾真关”关的还是上面那条不是当前的），再点第 2 条的 × → 点勾
  await page.eval("document.querySelectorAll('.pk-item.pk-open')[0].click();");
  await page.sleep(1200);
  await page.click("#browserMenuBtn");
  await page.sleep(700);
  await page.eval("document.querySelectorAll('.pk-item.pk-open')[1].querySelector('.pk-open-close').click();");
  await page.sleep(300);
  await page.eval("document.querySelectorAll('.pk-item.pk-open')[1].querySelector('.pk-open-yes').click();");
  await page.sleep(1200);
  await page.click("#browserMenuBtn");
  await page.sleep(700);
  await page.shot("session-close-done.png");
};

// 会话（没有 tab 栏那套）的界面验证流程，配 npm run web:shot -- --fake-pi --script dev/sessionFlow.js 用：
//   1. A 会话发一句 → 假 pi 会给这个会话起标题（顶条中间那行应该跟着变）
//   2. 输入框里留半句草稿
//   3. 新建 B 会话、说一句
//   4. 打开「项目与会话」列表 → 截图（看上半「正在对话」段：两条 + 当前高亮）
//   5. 切回 A → 截图（消息和草稿都该还在）
//   6. 点第 2 条的行身 → 该切过去，不该真关
//   7. 切回第 1 条，点第 2 条行尾那颗 × → 一下就关掉，不用再点第二下
// 这里的会话都已经跑完了，点叉就关（正在跑的要再点一下勾，见 dev/sessionMenuClose.js）：
// 关掉的那条从列表里消失，别的照旧。
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

  // 点第 2 条的行身：该切到这个会话（列表这一份连带收起来），不能把会话关了
  await page.click("#browserMenuBtn");
  await page.sleep(700);
  await page.eval("document.querySelectorAll('.pk-item.pk-open')[1].querySelector('.pk-history-main').click();");
  await page.sleep(1200);
  await page.click("#browserMenuBtn");
  await page.sleep(700);
  const rowBody = JSON.parse(await page.eval(`
    const rows = [...document.querySelectorAll(".pk-item.pk-open")];
    return JSON.stringify({
      rows: rows.length,
      current: rows.findIndex((r) => r.classList.contains("current")),
    });
  `));
  console.log("点行身之后再开列表：", JSON.stringify(rowBody));
  if (rowBody.rows !== 2) { throw new Error("点行身不该真关会话：" + JSON.stringify(rowBody)); }
  if (rowBody.current !== 1) { throw new Error("点行身该切到那一条（当前该是第 2 条）：" + JSON.stringify(rowBody)); }
  await page.shot("session-row-body.png");

  // 切回第一条（让后面那次点叉关的是上面那条不是当前的），点第 2 条的 × → 一下就关
  await page.eval("document.querySelectorAll('.pk-item.pk-open')[0].click();");
  await page.sleep(1200);
  await page.click("#browserMenuBtn");
  await page.sleep(700);
  const before = JSON.parse(await page.eval('return JSON.stringify({ rows: document.querySelectorAll(".pk-item.pk-open").length });'));
  await page.eval("document.querySelectorAll('.pk-item.pk-open')[1].querySelector('.pk-open-close').click();");
  await page.sleep(1200);
  const after = JSON.parse(await page.eval('return JSON.stringify({ rows: document.querySelectorAll(".pk-item.pk-open").length });'));
  console.log("点叉之后：", JSON.stringify(before), "→", JSON.stringify(after));
  if (after.rows !== before.rows - 1) { throw new Error("点一下叉就该关掉那条会话：" + JSON.stringify(before) + " → " + JSON.stringify(after)); }
  await page.shot("session-close-done.png");

  // 顶条那颗会话名的下拉框里那颗 × 也一样：点一下就关，没有第二下
  // （先把前面那张「项目与会话」面板按 Esc 收掉，不然它会盖住下拉框）
  await page.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));");
  await page.sleep(400);
  await page.click("#newSessionBtn");
  await page.sleep(1500);
  await page.click("#sessionName");
  await page.sleep(500);
  const menuBefore = JSON.parse(await page.eval('return JSON.stringify({ rows: document.querySelectorAll("#sessionMenu .sm-item").length });'));
  await page.shot("session-menu-open.png");
  await page.eval("document.querySelectorAll('#sessionMenu .sm-item')[1].querySelector('.sm-close').click();");
  await page.sleep(1200);
  const menuAfter = JSON.parse(await page.eval('return JSON.stringify({ rows: document.querySelectorAll("#sessionMenu .sm-item").length });'));
  console.log("下拉框里点叉之后：", JSON.stringify(menuBefore), "→", JSON.stringify(menuAfter));
  if (menuBefore.rows !== 2 || menuAfter.rows !== 1) {
    throw new Error("下拉框里点一下叉就该关掉那条会话：" + JSON.stringify(menuBefore) + " → " + JSON.stringify(menuAfter));
  }
  await page.shot("session-menu-closed.png");
};

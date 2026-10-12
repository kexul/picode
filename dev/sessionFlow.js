// 会话（没有 tab 栏那套）的界面验证流程，配 npm run web:shot -- --fake-pi --script dev/sessionFlow.js 用：
//   1. A 会话发一句 → 假 pi 会给这个会话起标题（顶条中间那行应该跟着变）
//   2. 输入框里留半句草稿
//   3. 新建 B 会话、说一句
//   4. 打开「项目与会话」列表 → 截图（看上半「正在对话」段：两条 + 当前高亮）
//   5. 切回 A → 截图（消息和草稿都该还在）
//   6. 列表里点第 2 条的 × 再点「关闭」→ 截图（那条会话没了）
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

  // 再开列表，点第 2 条的关闭叉（第一次点只变确认条），再点「关闭」
  await page.click("#browserMenuBtn");
  await page.sleep(700);
  await page.eval("document.querySelectorAll('.pk-item.pk-open')[1].querySelector('.pk-open-close').click();");
  await page.sleep(400);
  await page.shot("session-close-confirm.png");
  await page.eval("document.querySelectorAll('.pk-item.pk-open')[1].querySelector('.pk-open-yes').click();");
  await page.sleep(1200);
  await page.click("#browserMenuBtn");
  await page.sleep(700);
  await page.shot("session-close-done.png");
};

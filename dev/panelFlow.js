// 「项目与会话」面板的界面验证流程：打开 → 截图 → 点第二个工作区（就地换列表）→ 截图 →
// 点「加载更多」→ 截图。配 npm run web:shot -- --script dev/panelFlow.js 用。
module.exports = async (page) => {
  await page.click("#browserMenuBtn");
  await page.sleep(900);
  await page.shot("panel-after.png");
  // 点工作区那块的第二行（第一行是当前目录，跳过“浏览文件夹…”动作行）
  const n = await page.eval(`
    return (() => {
      const rows = Array.from(document.querySelectorAll("#pickerBody .pk-item"));
      const spaces = rows.filter(function (r) { return r.querySelector(".pk-space-path"); });
      if (spaces[1]) { spaces[1].click(); }
      return spaces.length;
    })()
  `);
  console.log("工作区行数: " + n);
  await page.sleep(900);
  await page.shot("panel-switched.png");
  // 点会话那块的「加载更多」（在“工作区”分节标题前面那颗）
  await page.eval(`
    return (() => {
      const btns = Array.from(document.querySelectorAll("#pickerBody .pk-loadmore"));
      if (btns[0]) { btns[0].click(); }
      return btns.length;
    })()
  `);
  await page.sleep(900);
  await page.shot("panel-loadmore.png");
};

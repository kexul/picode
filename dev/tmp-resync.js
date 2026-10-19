// 临时：在真后端的真会话上触发一次「窗口模式整屏重画」（对账路径），看页面报不报错。
module.exports = async (page) => {
  const read = () => page.eval(`
    const pane = document.getElementById('messages');
    return {
      nodes: pane ? pane.children.length : -1,
      users: document.querySelectorAll('.msg.user').length,
      assistants: document.querySelectorAll('.msg.assistant').length,
      historyBtn: document.querySelectorAll('.history-more').length,
      lastText: (function () {
        const all = document.querySelectorAll('.msg.assistant');
        return all.length ? all[all.length - 1].innerText.slice(0, 40) : '';
      })(),
    };
  `);
  console.log('重画前 ', JSON.stringify(await read()));
  await page.eval("window.acquireVsCodeApi().postMessage({ type: 'browserResync' })");
  await page.sleep(2500);
  console.log('重画后 ', JSON.stringify(await read()));
  await page.sleep(1500);
  console.log('再等一会 ', JSON.stringify(await read()));
  console.log('页面报错：', JSON.stringify((page.pageErrors || []).slice(-15)));
  await page.shot('tmp-resync.png');
};

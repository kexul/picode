// 临时：验「页面异常捎到后端日志」
module.exports = async (page) => {
  await page.eval("setTimeout(function () { throw new Error('故意抛的：验页面异常回传'); }, 50); return 1");
  await page.sleep(1200);
  // 再验一条“处理消息时出错”：给页面投一条会让 chat.js 处理时抛的消息（构造不出来就只验上面的）
  await page.eval("window.dispatchEvent(new MessageEvent('message', { data: { type: 'assistantDelta', delta: 'x', sessionId: 'nope' } })); return 1");
  await page.sleep(600);
};

// @ts-nocheck
/**
 * 一条会话都没有的时候（刚起后端、浏览器页面还没开会话），顶上那条跟右边那一列该长什么样。
 *
 *   npm run web:shot -- --fake-pi --skip-ready --width 1280 --height 800 --script dev/emptyBar.js
 *
 * 验三件事（都栽过，见 chat.css 的 #sessionTabs 最小高、.pk-session-pane:empty、顶条那条 padding）：
 *   ① 顶条跟有会话时一样高：会话格那一排空着也得留出一格的高度，不然开第一个会话那一下
 *      顶条突然长高 8 像素、右边那一列的面板头跟着跳。
 *   ② 右边那一列不许多出一条线：「正在对话」那一格空着就整个收掉，它底下那条分隔线也别画
 *      —— 不然它那 10 像素内边距会把线顶到面板头下面，右上角并排两条横线。
 *   ③ 两边那两颗按钮按整条居中：它们竖着撑满顶条（剩下那点由 flex 居中），顶条自己要是
 *      上下不一般高（比如上边留 5 像素、下边不留），它们就偏心两像素。
 * 顶条左边那颗「文件侧边栏」跟右边那几颗按钮不参与这个高度。
 */
module.exports = async (page) => {
  // 不等会话就绪（--skip-ready）：停在“还没有会话”那一屏
  await page.sleep(2500);

  /** 顶条 / 面板头 / 右边那一列的两格 / 两边那两颗按钮的图标，现在各是什么样。 */
  const look = () => page.eval(`
    const bar = document.getElementById("sessionBar");
    const head = document.querySelector("#sidebarDock .pk-header");
    const sess = document.querySelector("#sidebarDock .pk-session-pane");
    const space = document.querySelector("#sidebarDock .pk-space-pane");
    const r = (el) => el ? +el.getBoundingClientRect().height.toFixed(2) : null;
    const barR = bar.getBoundingClientRect();
    const barMid = (barR.top + barR.bottom) / 2;
    const iconOff = (sel) => {
      const svg = (document.querySelector(sel) || document.createElement("i")).querySelector?.("svg");
      if (!svg) { return null; }
      const sr = svg.getBoundingClientRect();
      return +(((sr.top + sr.bottom) / 2) - barMid).toFixed(2);
    };
    return {
      tabs: [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden")).length,
      barH: r(bar), headH: r(head),
      sessShown: !!sess && getComputedStyle(sess).display !== "none",
      spaceBorderTop: space ? getComputedStyle(space).borderTopWidth : null,
      左按钮偏心: iconOff("#fileSidebarBtn"),
      右按钮偏心: iconOff("#browserMenuBtn"),
    };
  `);

  /** 两颗按钮的图标都该在顶条中线上下 1 像素以内。 */
  const checkButtons = (state, what) => {
    for (const [name, off] of [["左", state.左按钮偏心], ["右", state.右按钮偏心]]) {
      if (off === null) { throw new Error(`${what}：找不到${name}边那颗按钮的图标`); }
      if (Math.abs(off) > 1) { throw new Error(`${what}：${name}边那颗按钮没按整条居中（差 ${off} 像素）`); }
    }
  };

  const empty = await look();
  console.log("  还没开会话：" + JSON.stringify(empty));
  if (empty.tabs !== 0) { throw new Error("这会儿不该有会话格：" + JSON.stringify(empty)); }
  if (empty.sessShown) { throw new Error("「正在对话」那一格空着就该收掉（不然右上角多出一条线）"); }
  if (empty.spaceBorderTop !== "0px") { throw new Error("上面没东西可隔的时候那条分隔线不该画：" + empty.spaceBorderTop); }
  if (empty.barH !== empty.headH) { throw new Error(`顶条跟面板头该一样高：${empty.barH} vs ${empty.headH}`); }
  checkButtons(empty, "还没开会话");
  await page.shot("empty-bar.png");

  // 开一个会话：顶条不该变高（会话格那一排空着时已经留好了高度）
  await page.eval(`window.acquireVsCodeApi().postMessage({ type: "newSession" }); return true;`);
  await page.sleep(3000);
  const open = await look();
  console.log("  开了一个会话：" + JSON.stringify(open));
  if (open.tabs !== 1) { throw new Error("该有会话格了：" + JSON.stringify(open)); }
  if (open.barH !== open.headH) { throw new Error(`顶条跟面板头该一样高：${open.barH} vs ${open.headH}`); }
  if (open.barH !== empty.barH) { throw new Error(`开第一个会话那一下顶条不该变高：${empty.barH} → ${open.barH}`); }
  if (!open.sessShown) { throw new Error("有会话了「正在对话」那一格该露出来"); }
  checkButtons(open, "开了一个会话");
  await page.shot("empty-bar-after.png");
};

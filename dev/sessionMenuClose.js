// 「关闭会话」的二次确认：会话正在跑的时候才要再点一下（防误触、也免得不小心把跑着一半的一轮打断），
// 跑完了点一下就关。
//   FAKEPI_THINK_MS=5000 npm run web:shot -- --fake-pi --width 900 --height 800 --script dev/sessionMenuClose.js
//   （假 pi 每个工具卡 5 秒，才有时间在“正在跑”的时候去点关闭。）
//
// 三处入口同一个规矩：
//   ① 顶条上那一格点自己的 ×：那一格变红、那颗叉换成勾，这一下不真关；再点一下（勾）才关
//   ② 在跑时按 Ctrl+Alt+W：落在顶条那一格上（同上），不再自己弹出一张清单等你找那一行
//   ③ 「项目与会话」里「正在对话」那几行：点叉出确认条（整行变红、行尾多一颗勾一颗叉），
//      点叉撤销、干等 4 秒自己收回、点勾才真关；点行身也算撤销（不许替那颗勾把关会话点实了）
// 图落在 dev/shots/：closeconfirm-1-tab / 2-key / 3-panel …
module.exports = async (page) => {
  await page.waitReady();
  await page.sleep(800);

  // 输入框底下那颗胶囊的 data-st：当前会话在跑的时候是 streaming（见 media/chat.js 的 ctxState）
  const dataSt = () => page.eval(`
    const el = document.getElementById("ctxIcon");
    return el ? (el.getAttribute("data-st") || "") : "";
  `);
  const waitStreaming = async (timeoutMs) => {
    const until = Date.now() + (timeoutMs || 20000);
    while (Date.now() < until) {
      if ((await dataSt()) === "streaming") { return true; }
      await page.sleep(150);
    }
    return false;
  };
  const keyClose = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await page.cdp.send("Input.dispatchKeyEvent", {
        type, key: "w", code: "KeyW", modifiers: 3,   // Alt=1 + Ctrl=2
        windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87,
      });
    }
  };

  /** 顶条现在什么样：几格、哪一格在等确认、那几颗叉画的是叉还是勾、清单开着没。 */
  const tabs = () => page.eval(`
    const row = document.getElementById("sessionTabs");
    const all = [...row.querySelectorAll(".sn-tab")];
    return {
      count: all.length,
      closing: all.map((t) => t.classList.contains("closing")),
      icons: all.map((t) => {
        const p = t.querySelector(".sn-close path");
        const d = p ? p.getAttribute("d") : "";
        return d.indexOf("M2.6") === 0 ? "勾" : (d.indexOf("M2.5") === 0 ? "叉" : "?");
      }),
      menu: !document.getElementById("sessionMenu").classList.contains("hidden"),
    };
  `);

  /** 「正在对话」那几行（宽窗里是右边常驻那一列，窄窗是浮层）。 */
  const panel = () => page.eval(`
    const rows = [...document.querySelectorAll(".pk-item.pk-open")];
    return {
      rows: rows.length,
      current: rows.map((r) => r.classList.contains("current")),
      confirm: rows.map((r) => r.classList.contains("pk-open-confirm")),
      hasYes: rows.map((r) => !!r.querySelector(".pk-open-yes")),
      hasNo: rows.map((r) => !!r.querySelector(".pk-open-no")),
    };
  `);

  /** 在跑着的那个会话（顶条那格点 × / 快捷键都落在它身上）。 */
  const clickCurrentTabClose = () => page.eval(`
    document.querySelector("#sessionTabs .sn-tab.current .sn-close").click();
    return true;
  `);

  // 第二个会话 B，说一句让它跑起来
  await page.click("#newSessionBtn");
  await page.sleep(1500);
  await page.send("随便演示一下");
  if (!(await waitStreaming(20000))) { throw new Error("会话没跑起来（等不到 streaming）"); }
  await page.sleep(400);

  // ① 跑着时点顶条那一格的 ×：变红 + 勾，不真关；再点一下才关
  await clickCurrentTabClose();
  await page.sleep(300);
  const t1 = await tabs();
  console.log("① 跑着时点了一下 ×：", JSON.stringify(t1));
  await page.shot("closeconfirm-1-tab.png");
  if (!t1.closing[t1.count - 1] && !t1.closing.some(Boolean)) { throw new Error("跑着的时候点 × 应该让那一格进入等确认（变红）"); }
  if (!t1.icons.some((i) => i === "勾")) { throw new Error("等确认时那颗叉应该换成勾"); }
  if (t1.menu) { throw new Error("点那一格上的 × 不该弹出清单"); }
  const countBefore = t1.count;
  await clickCurrentTabClose();
  await page.sleep(1500);
  const t2 = await tabs();
  console.log("① 再点一下（勾）之后：", JSON.stringify(t2));
  if (t2.count !== Math.max(0, countBefore - 1)) { throw new Error(`点勾之后该真关掉这一个（${countBefore} → ${t2.count}）`); }

  // ② 跑着时按 Ctrl+Alt+W：同样落在顶条那一格上，不再弹出清单
  await page.click("#newSessionBtn");
  await page.sleep(1500);
  await page.send("随便演示一下");
  if (!(await waitStreaming(20000))) { throw new Error("第二个会话没跑起来"); }
  await keyClose();
  await page.sleep(600);
  const t3 = await tabs();
  console.log("② 在跑时按 Ctrl+Alt+W：", JSON.stringify(t3));
  await page.shot("closeconfirm-2-key.png");
  if (!t3.closing.some(Boolean)) { throw new Error("在跑的时候按关闭快捷键，那一格应该先变成等确认，不真关"); }
  if (t3.menu) { throw new Error("按快捷键不该再自己弹出清单（确认就在那一格上）"); }
  await keyClose();
  await page.sleep(1500);
  const t4 = await tabs();
  console.log("② 再按一下之后：", JSON.stringify(t4));
  if (t4.count !== Math.max(0, t3.count - 1)) { throw new Error(`再按一下该真关掉（${t3.count} → ${t4.count}）`); }

  // ③ 「项目与会话」里「正在对话」那几行：同一套规矩
  await page.click("#newSessionBtn");
  await page.sleep(1500);
  await page.send("随便演示一下");
  if (!(await waitStreaming(20000))) { throw new Error("第三个会话没跑起来"); }
  // 宽窗里右边那一列本来就常驻着（不是浮层）；窄窗才要先点那颗按钮把它拉出来
  const docked = await page.eval('return document.body.classList.contains("dock-sidebar");');
  if (!docked) { await page.click("#browserMenuBtn"); await page.sleep(500); }

  const rowExpr = `document.querySelector(".pk-item.pk-open.current")`;
  const p1 = await panel();
  console.log("③ 面板里的行：", JSON.stringify(p1));
  if (p1.rows < 2 || p1.confirm.some(Boolean)) { throw new Error("面板里应该有几行、都没有确认条"); }
  const curAt = p1.current.indexOf(true);
  await page.eval(`${rowExpr}.querySelector(".pk-open-close").click(); return true;`);
  await page.sleep(300);
  const p2 = await panel();
  console.log("③ 面板里点叉之后：", JSON.stringify(p2));
  await page.shot("closeconfirm-3-panel.png");
  if (!p2.confirm[curAt] || !p2.hasYes[curAt] || !p2.hasNo[curAt] || p2.rows !== p1.rows) {
    throw new Error("面板里正在跑的会话点叉，应该先出确认条（行尾一颗勾一颗叉）、不真关");
  }
  // 点取消：撤回去
  await page.eval(`${rowExpr}.querySelector(".pk-open-no").click(); return true;`);
  await page.sleep(300);
  const p3 = await panel();
  console.log("③ 面板里点取消之后：", JSON.stringify(p3));
  if (p3.confirm.some(Boolean)) { throw new Error("面板里点取消应该把确认条撤掉"); }
  // 再点叉出确认条，这回点行身：该撤掉确认条，也不关会话
  await page.eval(`${rowExpr}.querySelector(".pk-open-close").click(); return true;`);
  await page.sleep(300);
  await page.eval(`${rowExpr}.querySelector(".pk-history-main").click(); return true;`);
  await page.sleep(800);
  const p4 = await panel();
  console.log("③ 面板里点行身之后：", JSON.stringify(p4));
  if (p4.confirm.some(Boolean)) { throw new Error("点行身应该把确认条撤掉"); }
  if (p4.rows !== p3.rows) { throw new Error("点行身不该关掉会话"); }
  // 再来一次，这回点勾：真关掉
  await page.eval(`${rowExpr}.querySelector(".pk-open-close").click(); return true;`);
  await page.sleep(300);
  await page.eval(`${rowExpr}.querySelector(".pk-open-yes").click(); return true;`);
  await page.sleep(1500);
  const p5 = await panel();
  console.log("③ 面板里点勾之后：", JSON.stringify(p5));
  if (p5.rows !== p4.rows - 1) { throw new Error(`点勾之后该真关掉一个（${p4.rows} → ${p5.rows}）`); }
};

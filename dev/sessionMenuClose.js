// 「关闭会话」的二次确认：会话正在跑的时候才要再点一下，跑完了直接关。
//   FAKEPI_THINK_MS=5000 npm run web:shot -- --fake-pi --width 900 --height 800 --script dev/sessionMenuClose.js
//   （假 pi 每个工具卡 5 秒，才有时间在“正在跑”的时候去点关闭。）
//
// 验五件事：
//   ① 会话正在跑，点下拉框里那颗叉 → 那一行变确认条：整行变红、行尾多一颗勾（名字与目录照旧、
//      整张清单的宽窄不变、名字不被截），这一下不真关
//   ② 点叉（取消）撤销；点了叉不管它，4 秒后自己收回
//   ③ 再点叉再点勾 → 真关掉，这块屏切到剩下那个
//   ④ 会话已经跑完（闲着）的：点叉一下就关，不出确认条
//   ⑤ 正在跑的时候按 Ctrl+Alt+W → 自己把清单打开、那一行变确认条，点勾才关
//   「项目与会话」里「正在对话」那几行同一套（点叉出确认条、点取消撤销、点行身撤掉确认条）。
// 图落在 dev/shots/：menu-close-1-open / 2-confirm / 2-confirm-zoom / 3-cancel / 4-done / 5-idle / 6-key / 7-panel。
const fs = require("fs");
const path = require("path");

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

  /** 下拉框现在什么样：开着没、多宽、每行是不是确认条、有没有那两颗按钮。 */
  const menu = () => page.eval(`
    const el = document.getElementById("sessionMenu");
    const rows = [...el.querySelectorAll(".sm-item")];
    return {
      open: !el.classList.contains("hidden"),
      width: Math.round(el.getBoundingClientRect().width),
      rows: rows.length,
      names: rows.map((r) => (r.querySelector(".sm-name") || {}).textContent || ""),
      dirs: rows.map((r) => (r.querySelector(".sm-path") || {}).textContent || ""),
      hasClose: rows.map((r) => !!r.querySelector(".sm-close")),
      confirm: rows.map((r) => r.classList.contains("sm-confirm")),
      hasYes: rows.map((r) => !!r.querySelector(".sm-yes")),
      hasNo: rows.map((r) => !!r.querySelector(".sm-no")),
      current: rows.map((r) => r.classList.contains("current")),
    };
  `);

  /** 把清单那块放大 3 倍裁一张：看确认条有没有截字、字看不看得清。 */
  const shotMenuZoom = async (name) => {
    fs.mkdirSync(path.resolve(__dirname, "shots"), { recursive: true });
    const r = await page.eval(`const b = document.getElementById("sessionMenu").getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height };`);
    const image = await page.cdp.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: false,
      clip: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), scale: 3 },
    });
    fs.writeFileSync(path.resolve(__dirname, "shots", name), Buffer.from(image.data, "base64"));
  };

  const menuShown = async () => (await menu()).open;
  const menuOpen = async () => {
    if (await menuShown()) { return; }
    await page.eval(`document.getElementById("sessionName").click(); return true;`);
    await page.sleep(400);
  };
  const menuClose = async () => {
    if (!(await menuShown())) { return; }
    await page.eval(`document.getElementById("sessionName").click(); return true;`);
    await page.sleep(300);
  };
  const keyClose = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await page.cdp.send("Input.dispatchKeyEvent", {
        type, key: "w", code: "KeyW", modifiers: 3,   // Alt=1 + Ctrl=2
        windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87,
      });
    }
  };

  // 第二个会话 B（第一个 A 是打开页面时自带的），在 B 里说一句让它跑起来
  await page.click("#newSessionBtn");
  await page.sleep(1500);
  await page.send("随便演示一下");
  if (!(await waitStreaming(20000))) { throw new Error("会话没跑起来（等不到 streaming）"); }
  await page.sleep(400);

  // ① 在跑的时候点叉：先出确认条，不真关
  await menuOpen();
  await page.shot("menu-close-1-open.png");
  const st1 = await menu();
  console.log("① 打开下拉：", JSON.stringify(st1));
  if (!st1.open || st1.rows !== 2 || !st1.hasClose.every(Boolean) || st1.confirm.some(Boolean)) {
    throw new Error("打开时不对：应该两行、每行都有叉、没有确认条");
  }
  await page.eval(`document.querySelectorAll("#sessionMenu .sm-item")[1].querySelector(".sm-close").click(); return true;`);
  await page.sleep(300);
  const st2 = await menu();
  console.log("① 点叉之后：", JSON.stringify(st2));
  await page.shot("menu-close-2-confirm.png");
  await shotMenuZoom("menu-close-2-confirm-zoom.png");
  if (!st2.confirm[1] || !st2.hasYes[1] || !st2.hasNo[1] || st2.rows !== 2) {
    throw new Error("会话正在跑时点了叉应该变成确认条（行尾一颗勾一颗叉）、行数不变、不真关");
  }
  // 确认条里还得看得见关的是哪一个：名字与目录跟普通行一模一样
  if (st2.names[1] !== st1.names[1] || st2.dirs[1] !== st1.dirs[1]) { throw new Error("确认条里名字 / 目录不该变样"); }
  // 关键一条：确认条出来前后整张清单一样宽（多一颗勾也不许把清单撑宽）
  if (st2.width !== st1.width) { throw new Error(`确认条把清单撑宽了：${st1.width} → ${st2.width}`); }
  const cut = await page.eval(`
    const el = document.querySelectorAll("#sessionMenu .sm-item")[1].querySelector(".sm-name");
    return { client: el.clientWidth, scroll: el.scrollWidth };
  `);
  if (cut.scroll > cut.client + 1) { throw new Error(`确认条里的名字被截了：${cut.scroll} > ${cut.client}`); }

  // ② 点「取消」：确认条收回去
  await page.eval(`document.querySelector("#sessionMenu .sm-no").click(); return true;`);
  await page.sleep(300);
  const st3 = await menu();
  console.log("② 点取消之后：", JSON.stringify(st3));
  await page.shot("menu-close-3-cancel.png");
  if (st3.confirm.some(Boolean) || !st3.hasClose.every(Boolean) || st3.width !== st1.width) {
    throw new Error("取消后应该回到普通行、清单宽度照旧");
  }

  // 点了叉但不管它：4 秒后确认条自己收回
  await page.eval(`document.querySelectorAll("#sessionMenu .sm-item")[1].querySelector(".sm-close").click(); return true;`);
  await page.sleep(4300);
  const stTimeout = await menu();
  console.log("②b 点叉后等 4 秒多：", JSON.stringify(stTimeout));
  if (stTimeout.confirm.some(Boolean)) { throw new Error("干等着确认条也该自己收回"); }

  // ③ 再来一次，这回点那颗勾：会话真被关掉，切到剩下那个
  const gone = st1.names[1], kept = st1.names[0];
  await page.eval(`document.querySelectorAll("#sessionMenu .sm-item")[1].querySelector(".sm-close").click(); return true;`);
  await page.sleep(300);
  await page.eval(`document.querySelector("#sessionMenu .sm-yes").click(); return true;`);
  await page.sleep(1500);
  const st4 = await menu();
  console.log("③ 点勾之后：", JSON.stringify(st4));
  await page.shot("menu-close-4-done.png");
  if (st4.rows !== 1 || !st4.open) { throw new Error("关掉一条后应该只剩一行、清单还开着"); }
  if (st4.names[0] !== kept || !st4.current[0]) { throw new Error(`应该关掉「${gone}」、切到剩下那个「${kept}」`); }

  // 点剩下那行的正文：还是切会话（没被那颗叉挡住）
  await page.eval(`document.querySelector("#sessionMenu .sm-item .sm-name").click(); return true;`);
  await page.sleep(800);
  console.log("③b 点行正文之后菜单是否收起：", JSON.stringify(await menuShown()));
  if (await menuShown()) { throw new Error("点行正文应该切会话并收起清单"); }

  // ④ 已经跑完（闲着）的会话：点叉一下就关，不出确认条
  await page.click("#newSessionBtn");
  await page.sleep(1500);
  if ((await dataSt()) === "streaming") { throw new Error("新开的会话不该在跑"); }
  await menuOpen();
  const before = await menu();
  await page.eval(`document.querySelectorAll("#sessionMenu .sm-item")[0].querySelector(".sm-close").click(); return true;`);
  await page.sleep(150);
  const justAfter = await menu();
  await page.sleep(1200);
  const after = await menu();
  console.log("④ 闲着的那条点叉：", JSON.stringify(before.rows), "→", JSON.stringify(justAfter), "→", JSON.stringify(after.rows));
  await page.shot("menu-close-5-idle.png");
  if (justAfter.confirm.some(Boolean)) { throw new Error("会话闲着呢，点叉不该出确认条"); }
  if (after.rows !== 1) { throw new Error(`闲着的会话点一下就该关掉，现在剩 ${after.rows} 个`); }
  await menuClose();

  // ⑤ 正在跑的时候按 Ctrl+Alt+W：自己把清单打开、那一行变确认条，点勾才真关
  await page.click("#newSessionBtn");
  await page.sleep(1500);
  await page.send("随便演示一下");
  if (!(await waitStreaming(20000))) { throw new Error("第二个会话没跑起来"); }
  await menuClose();
  await keyClose();
  await page.sleep(600);
  const st5 = await menu();
  console.log("⑤ 在跑时按 Ctrl+Alt+W：", JSON.stringify(st5));
  await page.shot("menu-close-6-key.png");
  if (!st5.open) { throw new Error("在跑的时候按关闭快捷键，应该自己把清单打开（确认条得有地方露出来）"); }
  if (!st5.confirm.some(Boolean) || !st5.hasYes.some(Boolean)) { throw new Error("在跑的时候按关闭快捷键，应该先出确认条，不真关"); }
  const rowsBeforeKey = st5.rows;
  await page.eval(`document.querySelector("#sessionMenu .sm-yes").click(); return true;`);
  await page.sleep(1500);
  const st6 = await menu();
  console.log("⑤ 点了那颗勾之后：", JSON.stringify(st6));
  if (st6.rows !== rowsBeforeKey - 1) { throw new Error(`点勾之后该真关掉一个（${rowsBeforeKey} → ${st6.rows}）`); }

  // 「项目与会话」里「正在对话」那几行：同一套（点叉出确认条、点取消撤销、点行身撤掉确认条）
  await menuClose();
  await page.click("#newSessionBtn");
  await page.sleep(1500);
  await page.send("随便演示一下");
  if (!(await waitStreaming(20000))) { throw new Error("第三个会话没跑起来"); }
  // 宽窗里那一列本来就常驻着（不是浮层）；窄窗才要先点那颗按钮把它拉出来
  const docked = await page.eval('return document.body.classList.contains("dock-sidebar");');
  if (!docked) { await page.click("#browserMenuBtn"); await page.sleep(500); }
  /** 面板里那几行有没有哪一行正开着确认条。 */
  const anyConfirm = (stateOfPanel) => (stateOfPanel.confirm || []).some(Boolean);
  const panel = () => page.eval(`
    const rows = [...document.querySelectorAll(".pk-item.pk-open")];
    return {
      rows: rows.length,
      confirm: rows.map((r) => r.classList.contains("pk-open-confirm")),
      hasYes: rows.map((r) => !!r.querySelector(".pk-open-yes")),
      hasNo: rows.map((r) => !!r.querySelector(".pk-open-no")),
      hasClose: rows.map((r) => !!r.querySelector(".pk-open-close")),
    };
  `);
  const p1 = await panel();
  console.log("⑥ 面板里的行：", JSON.stringify(p1));
  if (p1.rows < 2 || p1.confirm.some(Boolean)) { throw new Error("面板里应该有几行、都没有确认条"); }
  const runningAt = p1.rows - 1;   // 最后一行是刚开的、正在跑的那个
  await page.eval(`document.querySelectorAll(".pk-item.pk-open")[${runningAt}].querySelector(".pk-open-close").click(); return true;`);
  await page.sleep(300);
  const p2 = await panel();
  console.log("⑥ 面板里点叉之后：", JSON.stringify(p2));
  await page.shot("menu-close-7-panel.png");
  if (!p2.confirm[runningAt] || !p2.hasYes[runningAt] || !p2.hasNo[runningAt]) {
    throw new Error("面板里正在跑的会话点叉，也应该先出确认条");
  }
  // 点取消：撤回去
  await page.eval(`document.querySelectorAll(".pk-item.pk-open")[${runningAt}].querySelector(".pk-open-no").click(); return true;`);
  await page.sleep(300);
  const p3 = await panel();
  console.log("⑥ 面板里点取消之后：", JSON.stringify(p3));
  if (anyConfirm(p3)) { throw new Error("面板里点取消应该把确认条撤掉"); }
  // 再点叉出确认条，这回点行身：该撤掉确认条（切不切会话另说），不能替那颗勾把关会话点实了
  await page.eval(`document.querySelectorAll(".pk-item.pk-open")[${runningAt}].querySelector(".pk-open-close").click(); return true;`);
  await page.sleep(300);
  await page.eval(`document.querySelectorAll(".pk-item.pk-open")[${runningAt}].querySelector(".pk-history-main").click(); return true;`);
  await page.sleep(800);
  const p4 = await panel();
  console.log("⑥ 面板里点行身之后：", JSON.stringify(p4));
  if (anyConfirm(p4)) { throw new Error("点行身应该把确认条撤掉"); }
  if (p4.rows !== p3.rows) { throw new Error("点行身不该关掉会话"); }

};

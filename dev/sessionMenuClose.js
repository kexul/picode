// 顶条会话名下拉框里「每行一颗关闭叉」的验证（不真给模型发消息：只建两个空会话）。
//   npm run web:shot -- --fake-pi --script dev/sessionMenuClose.js
//   npm run web:shot -- --fake-pi --theme dark --script dev/sessionMenuClose.js
// 图落在 dev/shots/：menu-close-1-open / 2-confirm / 2-confirm-zoom / 3-cancel / 4-done。
const fs = require("fs");
const path = require("path");

module.exports = async (page) => {
  await page.waitReady();
  await page.sleep(800);

  // 第二个会话（第一个是打开页面时自带的那个）
  await page.click("#newSessionBtn");
  await page.sleep(1500);

  // 打开顶条中间那颗名字的下拉
  await page.click("#sessionName");
  await page.sleep(400);
  await page.shot("menu-close-1-open.png");

  const state = () => page.eval(`
    const menu = document.getElementById("sessionMenu");
    const rows = [...menu.querySelectorAll(".sm-item")];
    return {
      open: !menu.classList.contains("hidden"),
      rows: rows.length,
      names: rows.map((r) => (r.querySelector(".sm-name") || {}).textContent || ""),
      hasClose: rows.map((r) => !!r.querySelector(".sm-close")),
      confirm: rows.map((r) => r.classList.contains("sm-confirm")),
      asks: [...menu.querySelectorAll(".sm-ask")].map((e) => e.textContent),
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

  const st1 = await state();
  console.log("① 打开下拉：", JSON.stringify(st1));
  if (!st1.open || st1.rows !== 2 || !st1.hasClose.every(Boolean) || st1.confirm.some(Boolean)) {
    throw new Error("打开时不对：应该两行、每行都有叉、没有确认条");
  }

  // 点第二行那颗叉：第一次只变确认条，不真关
  await page.eval(`document.querySelectorAll("#sessionMenu .sm-item")[1].querySelector(".sm-close").click(); return true;`);
  await page.sleep(300);
  const st2 = await state();
  console.log("② 点叉之后：", JSON.stringify(st2));
  await page.shot("menu-close-2-confirm.png");
  await shotMenuZoom("menu-close-2-confirm-zoom.png");
  if (!st2.confirm[1] || !st2.asks[0] || st2.rows !== 2) { throw new Error("点了叉应该第二行变确认条、行数不变"); }
  // 确认条里的字不能被截掉（截了就是名字没处看、要点错）
  const cut = await page.eval(`
    const ask = document.querySelector("#sessionMenu .sm-ask");
    return { client: ask.clientWidth, scroll: ask.scrollWidth };
  `);
  if (cut.scroll > cut.client + 1) { throw new Error(`确认条里的字被截了：${cut.scroll} > ${cut.client}`); }

  // 点「取消」：确认条收回去
  await page.eval(`document.querySelector("#sessionMenu .sm-no").click(); return true;`);
  await page.sleep(300);
  const st3 = await state();
  console.log("③ 点取消之后：", JSON.stringify(st3));
  await page.shot("menu-close-3-cancel.png");
  if (st3.confirm.some(Boolean) || !st3.hasClose.every(Boolean)) { throw new Error("取消后应该回到普通行"); }

  // 点了叉但不管它：4 秒后确认条自己收回
  await page.eval(`document.querySelectorAll("#sessionMenu .sm-item")[1].querySelector(".sm-close").click(); return true;`);
  await page.sleep(4300);
  const stTimeout = await state();
  console.log("③b 点叉后等 4 秒多：", JSON.stringify(stTimeout));
  if (stTimeout.confirm.some(Boolean)) { throw new Error("干等着确认条也该自己收回"); }

  // 再来一次，这回点「关闭」：会话真被关掉（等后端的列表回来）
  await page.eval(`document.querySelectorAll("#sessionMenu .sm-item")[1].querySelector(".sm-close").click(); return true;`);
  await page.sleep(300);
  await page.eval(`document.querySelector("#sessionMenu .sm-yes").click(); return true;`);
  await page.sleep(1500);
  const st4 = await state();
  console.log("④ 点关闭之后：", JSON.stringify(st4));
  await page.shot("menu-close-4-done.png");
  if (st4.rows !== 1 || !st4.open) { throw new Error("关掉一条后应该只剩一行、清单还开着"); }

  // 点剩下那行的正文：还是切会话（没被那颗叉挡住）
  await page.eval(`document.querySelector("#sessionMenu .sm-item .sm-name").click(); return true;`);
  await page.sleep(800);
  const st5 = await page.eval(`return { open: !document.getElementById("sessionMenu").classList.contains("hidden") };`);
  console.log("⑤ 点行正文之后菜单是否收起：", JSON.stringify(st5));
  if (st5.open) { throw new Error("点行正文应该切会话并收起清单"); }
};

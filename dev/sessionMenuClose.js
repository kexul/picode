// 顶条会话名下拉框里「每行一颗关闭叉」的验证（不真给模型发消息：只建两个空会话）。
// 点叉先出确认条：那一行底色变红、行尾多一颗勾（名字与目录照旧看得见），点勾才真关、
// 点叉或者干等 4 秒都撤销；确认条出来时整张清单的宽窄不许变（这是它换掉文字按钮的原因）。
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
      width: Math.round(menu.getBoundingClientRect().width),
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

  const st1 = await state();
  console.log("① 打开下拉：", JSON.stringify(st1));
  if (!st1.open || st1.rows !== 2 || !st1.hasClose.every(Boolean) || st1.confirm.some(Boolean)) {
    throw new Error("打开时不对：应该两行、每行都有叉、没有确认条");
  }

  // 点第二行那颗叉：第一次只变确认条（行尾多一颗勾），不真关
  await page.eval(`document.querySelectorAll("#sessionMenu .sm-item")[1].querySelector(".sm-close").click(); return true;`);
  await page.sleep(300);
  const st2 = await state();
  console.log("② 点叉之后：", JSON.stringify(st2));
  await page.shot("menu-close-2-confirm.png");
  await shotMenuZoom("menu-close-2-confirm-zoom.png");
  if (!st2.confirm[1] || !st2.hasYes[1] || !st2.hasNo[1] || st2.rows !== 2) { throw new Error("点了叉应该第二行变确认条（行尾一颗勾一颗叉）、行数不变"); }
  // 确认条里还得看得见关的是哪一个：名字与目录跟普通行一模一样
  if (st2.names[1] !== st1.names[1] || st2.dirs[1] !== st1.dirs[1]) { throw new Error("确认条里名字 / 目录不该变样"); }
  // 关键一条：确认条出来前后整张清单一样宽（从前换成文字按钮会把清单撑宽）
  if (st2.width !== st1.width) { throw new Error(`确认条把清单撑宽了：${st1.width} → ${st2.width}`); }
  const cut = await page.eval(`
    const el = document.querySelectorAll("#sessionMenu .sm-item")[1].querySelector(".sm-name");
    return { client: el.clientWidth, scroll: el.scrollWidth };
  `);
  if (cut.scroll > cut.client + 1) { throw new Error(`确认条里的名字被截了：${cut.scroll} > ${cut.client}`); }

  // 点「取消」：确认条收回去
  await page.eval(`document.querySelector("#sessionMenu .sm-no").click(); return true;`);
  await page.sleep(300);
  const st3 = await state();
  console.log("③ 点取消之后：", JSON.stringify(st3));
  await page.shot("menu-close-3-cancel.png");
  if (st3.confirm.some(Boolean) || !st3.hasClose.every(Boolean) || st3.width !== st1.width) { throw new Error("取消后应该回到普通行、清单宽度照旧"); }

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

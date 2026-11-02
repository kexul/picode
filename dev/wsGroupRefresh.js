// 验「会话文件一变，那个工作区的历史会话就跟着变」：
//   npm run web:shot -- --fake-pi --cwd dev/.scratch/ws-group --width 1100 --height 800 --script dev/wsGroupRefresh.js
//
// 场景（右边那一列 = 常驻的「项目与会话」）：那一组的会话清单是打开面板时扫一次就记在界面手里的。
// 关掉一个会话（或者新会话头一回落盘）之后，它的文件就在那个目录里了 —— 以前那份清单不会再扫，
// 所以它迟迟不出现，要等整块面板重开。现在会话文件一变，就把那个工作区那一组作废、重扫一遍。
//
// 假 pi 报的会话文件不在 pi 的会话目录里（见 dev/fakePi.js），所以这里自己手写一份塞进去：
// 就像那个会话刚把第一条消息落了盘。然后关掉一个会话，看那一组里有没有它。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openSessionIn } = require("./harness.js");

/** 跟 src/sessionStore.ts 的 encodeCwd 一个规矩：目录名是拼出来的。 */
function encodeCwd(cwd) {
  return "--" + String(cwd).replace(/^[/\\]/, "").replace(/[\\/:]/g, "-") + "--";
}

/** 这个目录的会话文件放在哪儿。 */
function sessionsDirOf(cwd) {
  const root = process.env.PI_CODING_AGENT_SESSION_DIR
    || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "sessions");
  return path.join(root, encodeCwd(cwd));
}

/** 右边那一列里，展开着的那一组现在列着哪些会话（行上写的标题）。 */
function groupTitles(page) {
  return page
    .eval('return JSON.stringify([...document.querySelectorAll("#sidebarDock .pk-item.pk-group-session")].map((el) => el.querySelector(".pk-history-title").textContent));')
    .then(JSON.parse);
}

module.exports = async (page) => {
  const cwd = await page.eval('return (document.getElementById("sessionName") || { dataset: {} }).dataset.cwd || "";');
  if (!cwd) { throw new Error("问不出当前会话跑在哪个目录（顶条那一格上没有 data-cwd）"); }
  const dir = sessionsDirOf(cwd);
  console.log("工作目录：" + cwd);
  console.log("会话文件目录：" + dir);
  console.log("一开始那一组里：" + JSON.stringify(await groupTitles(page)));

  // 再开一个会话：等会儿关掉它，就有“会话文件变了”这一下
  await openSessionIn(page);
  await page.sleep(800);

  // 手写一份会话文件放进会话目录（标题取自第一条用户消息）
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "homemade-session.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "session", id: "homemade", cwd }),
    JSON.stringify({ type: "message", message: { role: "user", content: "手写的历史会话" } }),
  ].join("\n") + "\n", "utf8");

  // 关掉刚开的那个（它没在跑，点一下叉就关）
  await page.eval('document.querySelector("#sidebarDock .pk-item.pk-open.current .pk-open-close").click(); return true;');
  await page.sleep(2000);
  const after = await groupTitles(page);
  console.log("关掉一个会话之后那一组里：" + JSON.stringify(after));
  await page.shot("ws-group-after-close.png");
  fs.rmSync(file, { force: true });
  if (!after.includes("手写的历史会话")) { throw new Error("会话文件变了，那一组该重扫一遍：" + JSON.stringify(after)); }
};

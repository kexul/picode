// 双击名字改会话名（顶条那一格、「项目与会话」里「正在对话」那一行，同一个手势）。
//
//   npm run web:shot -- --fake-pi --width 1100 --height 700 --script dev/renameSession.js
//
// 用 CDP 的真鼠标双击（Input.dispatchMouseEvent 连按两下，clickCount 1 然后 2），不是
// el.dispatchEvent(new MouseEvent("dblclick"))——那一下会不会被浏览器当成缩放 / 被别的手势吃掉，
// 只有真按下去才看得出来。
//
// 验五件事：
//   ① 双击当前那一格的名字：名字变成输入框，且已经选中（直接打字就是覆盖）；回车改好，
//      顶条那一格的字立刻换成新的
//   ② 刷新页面（等于后端重启、换台机器打开）：名字还是新的（说明真写进了会话文件，不是只在内存里）
//   ③ Esc 不算：改了字按 Esc，名字一个字都不变
//   ④ 双击「不是当前那一格」的格子：只切过去，不改名（也不弹输入框）
//   ⑤ 「项目与会话」里「正在对话」那一行：双击同样能改，改完那一行、顶条那一格一起换
//
// 不验的一条：改完再跑一轮对话，自动起标题会不会把手改的名字盖回去。那个扩展只在真 pi 里加载
// （假模型没有它），要验就得真给模型发消息，所以这里不验；保证它不覆盖的是
// src/titleBridgeSource.ts 里那句判断（现在的名字不是自己起的就一次都不动）。
const { openSessionIn } = require("./harness.js");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** 跟 src/sessionStore.ts 的 encodeCwd 一个规矩：会话目录的名字是拼出来的。 */
function encodeCwd(cwd) {
  return "--" + String(cwd).replace(/^[/\\]/, "").replace(/[\\/:]/g, "-") + "--";
}

/** 这个目录的会话文件放在哪儿（⑥ 要往里塞一份手写的）。 */
function sessionsDirOf(cwd) {
  const root = process.env.PI_CODING_AGENT_SESSION_DIR
    || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "sessions");
  return path.join(root, encodeCwd(cwd));
}

/** 路径最后一段（那一行工作区上写的就是它）。 */
function baseName(p) {
  const parts = String(p || "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || "");
}

const TABS = `
    const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden"));
    return tabs.map((t) => {
        const text = t.querySelector(".sn-text");
        const r = (text || t).getBoundingClientRect();
        return {
            name: text ? text.textContent : "",
            current: t.classList.contains("current"),
            x: Math.round(r.left + Math.min(40, r.width / 2)),
            y: Math.round(r.top + r.height / 2),
        };
    });
`;

const INPUT = `
    const input = document.querySelector(".sn-rename");
    if (!input) { return ""; }
    return JSON.stringify({
        value: input.value,
        focused: document.activeElement === input,
        selectedAll: input.selectionStart === 0 && input.selectionEnd === input.value.length,
    });
`;

module.exports = async (page) => {
  await page.waitReady();
  await page.sleep(600);

  let failed = 0;
  const bad = (what) => { failed++; console.log(`  ★ ${what}`); };
  const tabs = async () => JSON.parse(await page.eval(`return JSON.stringify((function(){${TABS}})())`));
  const currentName = async () => {
    const list = await tabs();
    const cur = list.find((t) => t.current);
    return cur ? cur.name : "";
  };
  const inputState = async () => {
    const raw = await page.eval(`return (function(){${INPUT}})()`);
    return raw ? JSON.parse(raw) : null;
  };
  /** 真鼠标双击（两下，第二下 clickCount 是 2，浏览器才认成 dblclick）。 */
  const dblclick = async (x, y) => {
    for (const clickCount of [1, 2]) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await page.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount });
      }
      await page.sleep(30);
    }
  };
  /** 真鼠标点一下（按一下、松开）。 */
  const clickAt = async (x, y) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    await page.sleep(60);
  };
  /** 打一段字（输入框已经聚焦，insertText 等于真人敲字，输入法 / 粘贴也不跳过）。 */
  const typeInto = async (text) => {
    await page.cdp.send("Input.insertText", { text });
    await page.sleep(80);
  };
  const pressEnter = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await page.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    await page.sleep(400);
  };
  const pressEsc = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await page.cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    }
    await page.sleep(300);
  };

  const before = await currentName();
  console.log(`  当前这一格叫：${before}`);

  // ---- ① 双击 → 输入 → 回车 ----
  const cur = (await tabs()).find((t) => t.current);
  await dblclick(cur.x, cur.y);
  await page.sleep(200);
  const opened = await inputState();
  if (!opened) { bad("双击名字没弹出输入框"); }
  else {
    if (opened.value !== before) { bad(`输入框里的初值不是现在的名字（拿到「${opened.value}」）`); }
    if (!opened.focused) { bad("输入框没拿到焦点（接着打字打不进去）"); }
  }
  await page.shot("rename-1-input.png");

  await typeInto("改好的名字");
  await pressEnter();
  await page.sleep(500);
  const renamed = await currentName();
  if (renamed !== "改好的名字") { bad(`回车之后顶条那一格还是「${renamed}」，不是「改好的名字」`); }
  else { console.log("  好：回车后顶条那一格变成「改好的名字」"); }
  if (await inputState()) { bad("回车之后输入框还在（没收起来）"); }
  await page.shot("rename-2-renamed.png");

  // ---- ② 刷新页面：名字是从会话文件读回来的 ----
  await page.cdp.send("Page.reload", { ignoreCache: false });
  await page.waitReady();
  await page.sleep(1200);
  const afterReload = await currentName();
  if (afterReload !== "改好的名字") { bad(`刷新之后名字变回「${afterReload}」了（没写进会话文件）`); }
  else { console.log("  好：刷新页面后还是「改好的名字」"); }

  // ---- ③ Esc 不算 ----
  const cur2 = (await tabs()).find((t) => t.current);
  await dblclick(cur2.x, cur2.y);
  await page.sleep(200);
  if (!(await inputState())) { bad("第二次双击没弹出输入框"); }
  await typeInto("这个名字不要");
  await pressEsc();
  const afterEsc = await currentName();
  if (afterEsc !== "改好的名字") { bad(`按 Esc 之后名字变成了「${afterEsc}」（应该一点不变）`); }
  else { console.log("  好：Esc 之后名字一个字都没变"); }
  if (await inputState()) { bad("按 Esc 之后输入框还在"); }

  // ---- ④ 双击不是当前那一格：只切过去，不改名 ----
  await openSessionIn(page);
  await page.sleep(2000);
  const list = await tabs();
  const other = list.find((t) => !t.current);
  if (!other) {
    bad("第二个会话没开出来（顶条上只有一格），④ 验不了");
  } else {
    const beforeAll = (await tabs()).map((t) => t.name).join("|");
    await dblclick(other.x, other.y);
    await page.sleep(600);
    const afterList = await tabs();
    const nowCurrent = afterList.find((t) => t.current);
    if (!nowCurrent || nowCurrent.name !== other.name) { bad(`双击别的格没切过去（当前的是「${nowCurrent ? nowCurrent.name : "没有"}」）`); }
    if (await inputState()) { bad("双击不是当前那一格，却弹出了输入框（不该改名）"); }
    if (afterList.map((t) => t.name).join("|") !== beforeAll) { bad("双击不是当前那一格，名字却变了"); }
    else if (!(await inputState())) { console.log("  好：双击别的格只切过去，两个名字都没动"); }
  }

  // ---- ⑤ 「项目与会话」里那一行也能改 ----
  // 那一列可能是常驻的、也可能是抽屉：先看看「正在对话」那几行眼下摆着没有（有宽高才算），
  // 没摆着就点顶条右边那颗按钮把它摊开。
  const rowsNow = async () => JSON.parse(await page.eval(`
        const rows = [...document.querySelectorAll(".pk-item.pk-open")];
        return JSON.stringify(rows.map((r) => {
            const t = r.querySelector(".pk-history-title");
            const rect = t ? t.getBoundingClientRect() : null;
            return {
                name: t ? t.textContent : "",
                shown: !!(rect && rect.width > 0),
                x: rect ? Math.round(rect.left + Math.min(30, rect.width / 2)) : 0,
                y: rect ? Math.round(rect.top + rect.height / 2) : 0,
            };
        }));
    `) || "[]");
  let rows = await rowsNow();
  if (!rows.some((r) => r.shown)) {
    await page.eval(`const b = document.getElementById("browserMenuBtn"); if (b) { b.click(); } return true;`);
    await page.sleep(700);
    rows = await rowsNow();
  }
  const target = rows.find((r) => r.name === "改好的名字");
  if (!target) {
    bad(`「正在对话」那几行里没找到「改好的名字」（拿到的是：${JSON.stringify(rows.map((r) => r.name))}）`);
  } else {
    await dblclick(target.x, target.y);
    await page.sleep(250);
    if (!(await inputState())) { bad("在面板那一行上双击，没弹出输入框"); }
    else {
      await page.shot("rename-3-panel-input.png");
      await typeInto("清单里改的名字");
      await pressEnter();
      await page.sleep(600);
      const again = JSON.parse(await page.eval(`
                return JSON.stringify([...document.querySelectorAll(".pk-item.pk-open .pk-history-title")].map((t) => t.textContent));
            `) || "[]");
      if (!again.includes("清单里改的名字")) { bad(`面板那一行没改成（拿到的是：${JSON.stringify(again)}）`); }
      else if (!(await tabs()).some((t) => t.name === "清单里改的名字")) {
        bad("面板那一行改了，但顶条那一格没跟着变");
      } else { console.log("  好：面板那一行双击能改，顶条那一格跟着变"); }
    }
  }
  await page.shot("rename-4-panel.png");

  // ---- ⑥ 改完名字，右边「工作区」那一组里那一行的字也跟着变 ----
  // 行上的名字是扫会话文件读的，所以只有真 pi 能验（假 pi 不往那个文件里写东西）。
  // 做法：自己手写一份会话文件塞进会话目录（跟 dev/wsGroupRefresh.js 一个路数），从面板那一行点开它，
  // 再双击名字改一下，看那一行跟着变不变。
  if (process.env.PICHAT_PI && /fake-pi/.test(process.env.PICHAT_PI)) {
    console.log("  （⑥ 跳过：假 pi 不写会话文件，这一条只有真 pi 能验）");
  } else {
    const cwd = await page.eval(`const t = document.getElementById("sessionName"); return t ? (t.dataset.cwd || "") : "";`);
    const dir = sessionsDirOf(cwd);
    console.log("  ⑥ 当前目录：" + JSON.stringify(cwd) + " ｜ 会话文件目录：" + dir + " ｜ 存在：" + fs.existsSync(dir));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "homemade-rename.jsonl");
    const now = new Date().toISOString();
    fs.writeFileSync(file, [
      JSON.stringify({ type: "session", version: 3, id: "homemade-rename", timestamp: now, cwd }),
      JSON.stringify({
        type: "message", id: "m1", parentId: null, timestamp: now,
        message: { role: "user", content: [{ type: "text", text: "这条是脚本写进去的" }], timestamp: now },
      }),
      JSON.stringify({ type: "session_info", id: "i1", parentId: "m1", timestamp: now, name: "脚本写的会话" }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10), "utf8");

    if (!fs.existsSync(file)) { bad("手写的那份会话文件没写进去：" + file); }
    // 后端的「某个目录里有哪些会话文件」那份清单留 5 秒（见 sessionStore 的 FILE_LIST_TTL_MS）：
    // 刚写完文件立刻问，可能还拿到上一份。等过它再刷新页面。
    await page.sleep(5500);
    // 刷新一次页面：面板是现问宿主要的，手写进去的这一条才看得见（人自己也是这么做：
    // 重开页面 / 重开那一列，那一组才现扫）
    await page.cdp.send("Page.reload", { ignoreCache: false });
    await page.waitReady();
    await page.sleep(1500);
    // 右边那一列没摊开就点一下顶条那颗按钮
    const dockedNow = await page.eval(`return document.body.classList.contains("dock-sidebar");`);
    if (!dockedNow) {
      await page.eval(`const b = document.getElementById("browserMenuBtn"); if (b) { b.click(); } return true;`);
      await page.sleep(1500);
    }
    const spot = JSON.parse(await page.eval(`
      const rows = [...document.querySelectorAll("#sidebarDock .pk-item.pk-group-session")];
      const hit = rows.find((r) => {
          const t = r.querySelector(".pk-history-title");
          return t && t.textContent === "脚本写的会话";
      });
      if (!hit) { return JSON.stringify(null); }
      const t = hit.querySelector(".pk-history-title");
      const rect = t.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(rect.left + Math.min(30, rect.width / 2)), y: Math.round(rect.top + rect.height / 2) });
    `) || "null");
    if (!spot) {
      const all = JSON.parse(await page.eval(`
        return JSON.stringify({
            spaces: [...document.querySelectorAll("#sidebarDock .pk-item.pk-space .pk-history-title")].map((t) => t.textContent),
            rows: [...document.querySelectorAll("#sidebarDock .pk-item.pk-group-session .pk-history-title")].map((t) => t.textContent),
        });
      `) || "{}");
      console.log("  ⑥ 那一列里现在：工作区=" + JSON.stringify(all.spaces) + " 组里=" + JSON.stringify(all.rows));
      bad("手写进会话目录的那一条没在那一组里露面（⑥ 没验成）");
    } else {
      await clickAt(spot.x, spot.y);           // 点那一行：打开这个会话
      await page.sleep(2500);
      const openedName = await currentName();
      if (openedName !== "脚本写的会话") {
        bad(`点那一行没打开那个会话（当前是「${openedName}」）`);
      } else {
        const cur3 = (await tabs()).find((t) => t.current);
        await dblclick(cur3.x, cur3.y);
        await page.sleep(250);
        if (!(await inputState())) { bad("⑥ 双击名字没弹出输入框"); }
        await typeInto("改过名的旧会话");
        await pressEnter();
        await page.sleep(1500);
        const groupNames = JSON.parse(await page.eval(`
          return JSON.stringify([...document.querySelectorAll("#sidebarDock .pk-item.pk-group-session .pk-history-title")].map((t) => t.textContent));
        `) || "[]");
        if (!groupNames.includes("改过名的旧会话")) {
          bad(`改完名字，右边那一组里那一行还是旧的（那一组现在是：${JSON.stringify(groupNames.slice(0, 6))}）`);
        } else { console.log("  好：改完名字，右边那一组里那一行也跟着变了"); }
      }
    }
    fs.rmSync(file, { force: true });
  }
  await page.shot("rename-5-group.png");

  // ---- ⑦ 手改过名字以后，自动起标题不许再动它 ----
  // 这条要真跑一轮对话（自动起标题那个扩展在一轮跑完时才动手），所以要真模型、要花钱，
  // 平时不跑：设了 RENAME_CHECK_AUTO_TITLE=1 才验。
  //   RENAME_CHECK_AUTO_TITLE=1 npm run web:shot -- --width 1200 --height 800 --script dev/renameSession.js
  if (!process.env.RENAME_CHECK_AUTO_TITLE) {
    console.log("  （⑦ 跳过：要真跑一轮模型才看得出自动起标题会不会盖掉手改的名字）");
  } else {
    const stamp = "手改的名字-" + Date.now().toString(36).slice(-4);
    const cur4 = (await tabs()).find((t) => t.current);
    await dblclick(cur4.x, cur4.y);
    await page.sleep(250);
    if (!(await inputState())) { bad("⑦ 双击名字没弹出输入框"); }
    await typeInto(stamp);
    await pressEnter();
    await page.sleep(800);
    // 说一句话：一轮跑完，自动起标题那个扩展会看一眼要不要改名
    await page.send("只回复这一个词：收到");
    await page.waitAnswer("收到");
    await page.sleep(4000);
    const cwd2 = await page.eval(`const t = document.getElementById("sessionName"); return t ? (t.dataset.cwd || "") : "";`);
    const dir2 = sessionsDirOf(cwd2);
    // 找那个记着这个名字的会话文件，看它最后一条 session_info 是谁
    const hit = fs.readdirSync(dir2)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir2, f))
      .filter((f) => {
        try { return fs.readFileSync(f, "utf8").includes(stamp); } catch { return false; }
      })
      .pop();
    if (!hit) {
      bad(`⑦ 没找到记着「${stamp}」的会话文件（这一条没验成）`);
    } else {
      const names = fs.readFileSync(hit, "utf8").split(String.fromCharCode(10))
        .filter((line) => line.indexOf('"type":"session_info"') >= 0)
        .map((line) => { try { return JSON.parse(line).name; } catch { return ""; } });
      const last = names[names.length - 1] || "";
      if (last !== stamp) {
        bad(`⑦ 手改的名字被盖掉了：现在会话文件里最后那个名字是「${last}」`);
      } else { console.log("  好：手改过名字以后，自动起标题没再动它"); }
    }
  }


  console.log(failed === 0 ? "  —— 全过" : `  —— ${failed} 条没过`);
  if (failed > 0) { process.exitCode = 1; }
};

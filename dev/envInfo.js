// @ts-nocheck
/**
 * envInfo —— 验侧边栏底部那颗「工具」（这个会话现在加载着什么：工具 / 技能 / MCP 服务器）。
 *
 * 清单是真货：会话里那个报清单的扩展（src/envBridgeSource.ts）从 pi 那儿取好，
 * 写成一行暗号交回后端，后端存着最近一份（见 src/envProtocol.ts）。
 * 所以第一趟什么都不用造假：点开那颗按钮，等它把真清单要来。
 *
 * 第二趟往页面里投一份假清单，专门看几种少见的写法画出来对不对
 * （不在模型手里 / 要从脚本里调 / 用不了的工具、项目级技能、停用的 MCP、配置写错的 MCP）。
 *
 *   npm run web:shot -- --width 1200 --height 800 --script dev/envInfo.js
 * 图落在 dev/shots/。
 */

const post = (page, messages) =>
    page.eval(`for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);

/** 侧边栏底部那颗「工具」在哪儿：宽窗在常驻那一列里；窄窗先把抽屉拉出来（等它画出来）。 */
async function envButton(page) {
    const visible = (sel) => page.eval(
        `const el = document.querySelector(${JSON.stringify(sel)});
         return !!el && el.getBoundingClientRect().width > 0;`);
    if (await visible("#dockFooter .pk-footer-env")) { return "#dockFooter .pk-footer-env"; }
    const overlayOpen = await page.eval(`return !document.getElementById("pickerOverlay").classList.contains("hidden")`);
    if (!overlayOpen) { await page.click("#browserMenuBtn"); }
    for (let i = 0; i < 40; i++) {
        if (await visible("#pickerFooter .pk-footer-env")) { return "#pickerFooter .pk-footer-env"; }
        await page.sleep(100);
    }
    throw new Error("侧边栏底部没长出那颗「工具」");
}

const look = (page, label) => page.eval(`return JSON.stringify({
    open: !document.getElementById("envOverlay").classList.contains("hidden"),
    text: (document.getElementById("envBody").innerText || "").replace(/\\n+/g, " | ").slice(0, 1200),
})`).then((raw) => console.log(label + "：" + raw));

/** 第二趟用的假清单：把几种少见写法都摆一遍。 */
const FAKE = {
    at: Date.now(),
    cwd: "D:\\projects\\picode\\dev\\.scratch\\work",
    tools: [
        { name: "bash", on: true, exposure: "direct", path: "builtin:bash", scope: "temporary" },
        { name: "read", on: true, exposure: "direct", path: "builtin:read", scope: "temporary" },
        { name: "ask_choice", on: true, exposure: "direct", path: "C:\\Users\\kk\\.pi\\pichat\\ask-bridge-0.1.0.ts", scope: "user" },
        { name: "mcp__filesystem__read_file", on: true, exposure: "direct", path: "builtin:mcp", scope: "user" },
        { name: "mcp__filesystem__write_file", on: false, exposure: "codemode", path: "builtin:mcp", scope: "user" },
        { name: "tool_search", on: false, exposure: "deferred", path: "builtin:tool_search", scope: "temporary" },
        { name: "secret_tool", on: false, exposure: "hidden", path: "C:\\Users\\kk\\.pi\\agent\\extensions\\secret.ts", scope: "user" },
    ],
    skills: [
        { name: "grill-me", path: "C:\\Users\\kk\\.pi\\agent\\skills\\grill-me\\SKILL.md", scope: "user" },
        { name: "how", path: "D:\\projects\\picode\\.pi\\skills\\how\\SKILL.md", scope: "project" },
    ],
    mcp: [
        { name: "filesystem", scope: "user", enabled: true, tools: 2, path: "C:\\Users\\kk\\.pi\\agent\\mcp.json" },
        { name: "internal-tools", scope: "user", enabled: false, tools: 0, path: "C:\\Users\\kk\\.pi\\agent\\mcp.json" },
        { name: "docs", scope: "project", enabled: true, tools: 0, path: "D:\\projects\\picode\\.pi\\mcp.json" },
        { name: "配置有错", enabled: true, tools: 0, error: "C:\\Users\\kk\\.pi\\agent\\mcp.json：Unexpected token } in JSON at position 42" },
    ],
};

module.exports = async (page) => {
    await page.waitReady();

    // ---- 第一趟：真会话报上来的那份清单 ----
    await page.click(await envButton(page));
    await page.sleep(300);
    // 弹窗一开就去要，pi 那边可能还没报过来（会话刚起来那一两秒）：等它填上内容
    for (let i = 0; i < 60; i++) {
        const text = await page.eval(`return document.getElementById("envBody").innerText || ""`);
        if (text && text.indexOf("正在取") < 0 && text.indexOf("还没取到") < 0) { break; }
        await page.sleep(250);
    }
    await look(page, "刚打开（会话刚起来时那一份）");
    // MCP 服务器是后台连的：会话起来 0.6 秒那一份里它们还没挂上来，之后每 5 秒比一次、
    // 变了就推过来（弹窗开着就跟着重画）。等它挂上来的那一份。
    for (let i = 0; i < 40; i++) {
        const text = await page.eval(`return document.getElementById("envBody").innerText || ""`);
        if (text.indexOf("mcp__") >= 0 || text.indexOf("连上了 ·") >= 0) { break; }
        await page.sleep(300);
    }
    await look(page, "真会话的清单（MCP 挂上来之后）");
    await page.shot("env-1-real.png");

    // 点右上角那颗叉收起来
    await page.click("#envClose");
    await page.sleep(200);
    await look(page, "点叉之后");

    // ---- 第二趟：投一份假清单，看几种少见写法 ----
    // 先把弹窗摆出来（不走那颗按钮：走它就会去要一份真清单，把假的顶掉），再投假清单。
    // 不带 sessionId 的消息按“当前会话”处理（跟后端还没推 sessionList 时的兜底一样）。
    await page.eval(`document.getElementById("envOverlay").classList.remove("hidden"); return true;`);
    await post(page, [{ type: "envInfo", env: FAKE }]);
    await page.sleep(200);
    await look(page, "假清单");
    await page.shot("env-2-fake.png");

    // Esc 收起来（且不能顺手把正在生成的那一轮停掉：这里没在跑，只看它收没收）
    await page.eval(`
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return true;
    `);
    await page.sleep(200);
    await look(page, "按过 Esc 之后");
};

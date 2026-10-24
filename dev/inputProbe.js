// @ts-nocheck
/**
 * inputProbe —— 量输入框的高度与滚动条（查“输入框右边冒出滚动条”用的探针）。
 *
 *   node dev/inputProbe.js                # 用浏览器本来的滚动条（能看见滚动条的真样子）
 *   node dev/inputProbe.js --hide         # 把滚动条藏起来（跟 web:shot 一样的看图条件）
 *
 * 每步打一行量出来的数字，并把输入区裁一张小图到 dev/shots/probe-*.png。
 * 会话目录 / 设置都指到 dev/.scratch，不碰用户自己的环境。
 *
 * 看哪几个数：over = 内容比框高多少（>0 就会有滚动条），barW = 滚动条占了多宽（=0 就是没滚动条）。
 */
const fs = require("fs");
const path = require("path");
const { createHarness } = require("./harness.js");
const { openPage } = require("./cdp.js");

const MEASURE = `
  const el = document.getElementById("input");
  if (!el) { return null; }
  const cs = getComputedStyle(el);
  const row = document.getElementById("inputRow");
  return {
    inlineH: el.style.height || "(没有)",
    offsetH: el.offsetHeight,
    clientH: el.clientHeight,
    scrollH: el.scrollHeight,
    over: el.scrollHeight - el.clientHeight,
    barW: el.offsetWidth - el.clientWidth - (parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)),
    fontSize: cs.fontSize,
    valueLen: el.value.length,
    stopVisible: !!document.querySelector(".session-view:not(.off) .msg-endhint-stop") && !document.querySelector(".session-view:not(.off) .msg-endhint-stop").classList.contains("hidden"),
    rowH: row ? row.offsetHeight : 0,
  };
`;

/** 裁输入区那一小条截图（坐标要夹进视口，不然浏览器会把整页挪一下再截）。 */
async function cropInput(cdp, page, name) {
    const rect = JSON.parse(await page.eval(`
        const a = document.getElementById("inputArea").getBoundingClientRect();
        return JSON.stringify({ x: a.left, y: a.top, w: a.width, h: a.height, vw: window.innerWidth, vh: window.innerHeight });
    `));
    const x = Math.max(0, Math.round(rect.x - 2));
    const y = Math.max(0, Math.round(rect.y - 2));
    const image = await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: {
            x, y,
            width: Math.round(Math.min(rect.w + 4, rect.vw - x)),
            height: Math.round(Math.min(rect.h + 4, rect.vh - y)),
            scale: 2,
        },
    });
    const dir = path.resolve(__dirname, "shots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(image.data, "base64"));
    return file;
}

/** 拖设置面板里的“字号”滑块（走的是界面上真那条路：滑块 → 后端 → 推回界面）。 */
async function dragFontSize(page, px) {
    await page.click("#browserMenuBtn");
    await page.sleep(400);
    await page.click(".pk-footer-settings");
    await page.sleep(400);
    const ok = await page.eval(`
        const rows = Array.from(document.querySelectorAll("#viewOptsRoot .vo-item-slider"));
        const row = rows.find((r) => (r.querySelector(".vo-label") || {}).textContent === "字号");
        if (!row) { return false; }
        const range = row.querySelector("input[type=range]");
        range.value = ${JSON.stringify(String(px))};
        range.dispatchEvent(new Event("input", { bubbles: true }));
        range.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    `);
    if (!ok) { throw new Error("设置面板里没找到“字号”滑块"); }
    await page.sleep(600);
    // 关掉设置浮层（点面板外面）
    await page.click("#settingsOverlay");
    await page.sleep(200);
}

async function main() {
    const argv = process.argv.slice(2);
    const hide = argv.includes("--hide");

    const harness = createHarness({ fakePi: true });
    const url = await harness.start();
    const open = await openPage({ url, width: 420, height: 900, scrollbars: !hide });
    const { page, cdp } = open;
    const report = async (label, shot) => {
        const m = await page.eval(MEASURE);
        console.log(label.padEnd(30), JSON.stringify(m));
        if (shot) { console.log(" ".repeat(30) + "图：" + await cropInput(cdp, page, shot)); }
    };
    try {
        await page.waitReady();
        console.log("地址：" + url + "（滚动条：" + (hide ? "藏起来" : "浏览器本来的") + "），视口宽 " + (await page.eval("return window.innerWidth")));

        await report("① 刚打开（空输入框）", "probe-1-fresh.png");
        await page.send("你好");
        await report("② 发出去以后", "probe-2-after-send.png");
        await page.waitAnswer();
        await report("③ 回复完了", null);

        await dragFontSize(page, 22);
        await report("④ 字号拖到 22px", "probe-4-font22.png");
        await page.eval(`
            const el = document.getElementById("input");
            el.focus(); el.value = "打完这行字";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        `);
        await report("⑤ 22px 下打了一行字", "probe-5-typed.png");

        await dragFontSize(page, 11);
        await report("⑥ 字号拖回 11px", "probe-6-font11.png");

        await page.eval(`
            const el = document.getElementById("input");
            el.value = "中文测试".repeat(20);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        `);
        await report("⑦ 折成很多行", null);

        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 260, height: 900, deviceScaleFactor: 1, mobile: false });
        await page.sleep(400);
        await report("⑧ 缩到 260px 宽", "probe-8-narrow.png");
    } finally {
        await open.close();
        if (harness && harness.stop) { await harness.stop(); }
    }
}

main().catch((err) => { console.error(err); process.exit(1); });

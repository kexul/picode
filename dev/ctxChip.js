// @ts-nocheck
/**
 * ctxChip —— 量输入框顶边上那条（状态图 / 用量横杠 / 生成速度）与底行那颗模型名胶囊，
 * 并把它放大截几张图看。
 *
 *   npm run web:shot -- --fake-pi --script dev/ctxChip.js
 *   npm run web:shot -- --width 360 --height 780 --fake-pi --script dev/ctxChip.js
 *
 * 三件事：
 *   1. 摆一段假状态（63% + 扳手 + 116.5 t/s）量各块的位置，截放大图；
 *   2. 换成“没在跑”的样子（8%、没有图、没有速度）再截一张；
 *   3. 真跑一轮（假 pi），每 50 毫秒量一次横杠的两端 —— 这些位置是钉死的，
 *      跑起来、速度数出现 / 位数变化、停下，都不该挪一个像素（当年这几处一直在抽：
 *      左端 18px、右端 56px、数字变宽还抖几像素）。
 *
 * 图落在 dev/shots/：ctx-top-run.png（跑着）、ctx-top-idle.png（没在跑）。
 */
const fs = require("fs");
const path = require("path");

/** 往页面里摆一段假状态：模型名、用量、状态图、速度（真数据要跑一轮才有）。 */
const fake = (pct, act, tps) => `
    const el = document.getElementById("ctxIcon");
    const top = document.getElementById("composer");
    el.querySelector(".ci-name").textContent = "deepseek-flash";
    document.getElementById("ctxBar").style.setProperty("--ci-pct", ${JSON.stringify(pct)});
    document.getElementById("ctxAct").dataset.act = ${JSON.stringify(act)};
    document.getElementById("ctxTps").textContent = ${JSON.stringify(tps)};
    return true;
`;

/** 只截输入框那一块（放大看对齐）：多留一点上边，顶边那条在那儿。 */
async function shot(page, name, scale) {
    const r = await page.eval(`const b = document.getElementById("composer").getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };`);
    const image = await page.cdp.send("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: false,
        clip: { x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 18), width: r.w + 12, height: r.h + 40, scale },
    });
    const file = path.resolve(__dirname, "shots", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(image.data, "base64"));
    console.log("图：" + file);
}

module.exports = async (page) => {
    await page.waitReady();
    await page.eval(fake(0.63, "tool", "116.5 t/s"));
    await page.sleep(400);
    const rects = await page.eval(`
        const q = (s) => { const e = document.querySelector(s); if (!e) { return null; }
            const r = e.getBoundingClientRect();
            return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
                     cy: +((r.top + r.bottom) / 2).toFixed(2) }; };
        return { chip: q("#ctxIcon"), name: q("#ctxIcon .ci-name"), top: q("#ctxTop"),
                 act: q("#ctxAct"), bar: q("#ctxBar"), fill: q("#ctxBar .ct-fill"), tps: q("#ctxTps") };
    `);
    console.log(JSON.stringify(rects, null, 2));
    await shot(page, "ctx-top-run.png", 3);

    await page.eval(fake(0.08, "", ""));
    await page.sleep(200);
    await shot(page, "ctx-top-idle.png", 3);

    // ---- 三、横杠的两端一个像素都不该动 ----
    // 把这几种情况挨个摆一遍（速度数在不在、位数多宽、状态图在不在），每次量横杠的两端：
    // 这些位置是钉死的，只该有一种（当年这几处一直在抽：左端 18px、右端 56px、数字变宽还抖几像素）。
    const cases = [
        { act: "tool", tps: "116.5 t/s" },
        { act: "tool", tps: "9.8 t/s" },
        { act: "waiting", tps: "44.2 t/s" },
        { act: "thinking", tps: "" },
        { act: "", tps: "" },
        { act: "", tps: "116.5 t/s" },
    ];
    const seen = [];
    for (const c of cases) {
        await page.eval(fake(0.63, c.act, c.tps));
        await page.sleep(260);
        const r = await page.eval(`
            const b = document.getElementById("ctxBar").getBoundingClientRect();
            const f = document.querySelector("#ctxBar .ct-fill").getBoundingClientRect();
            const a = document.getElementById("ctxAct").getBoundingClientRect();
            const bar = document.getElementById("ctxBar");
            const cs = getComputedStyle(bar);
            const lead = parseFloat(getComputedStyle(document.getElementById("ctxTop")).getPropertyValue("--ctx-lead"));
            // 有图的时候横杠左头那一格是被 mask 挖掉的 —— 得真挖了才算数（这条当年漏过：
            // 规则被误放进“减少动态效果”的 media query 里，正常情况根本没生效，线还是从图标底下过）。
            const masked = (cs.maskImage || cs.webkitMaskImage || "none") !== "none";
            const lineStart = Math.round(b.left + (masked ? lead : 0));
            return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width),
                     fill: Math.round(f.width), actRight: Math.round(a.right), masked, lineStart };`);
        if (c.act && !r.masked) { throw new Error("有状态图，但横杠左头那一格没被挖掉：线会从图标底下穿过去"); }
        if (!c.act && r.masked) { throw new Error("没有状态图，横杠左头那一格却被挖掉了（不跑的时候前面会缺一截）"); }
        if (c.act && r.actRight > r.lineStart) {
            throw new Error(`图标压在横杠上了：图标右边缘 ${r.actRight}，线上班的地方 ${r.lineStart}`);
        }
        seen.push({ at: r.left + ".." + r.right, w: r.width, fill: r.fill, act: c.act || "（无）", tps: c.tps || "（无）",
                    gap: c.act ? r.lineStart - r.actRight : null });
    }
    console.log("");
    console.log("横杠的位置（应当只有一种），以及 63% 时填充的长度：");
    for (const s of seen) {
        console.log(`  ${s.at} w=${s.w} 填充 ${s.fill}  状态图 ${s.act}  速度 ${s.tps}` +
            (s.gap === null ? "" : `  图标与线之间还空 ${s.gap}px`));
    }
    const spots = new Set(seen.map((s) => s.at));
    if (spots.size > 1) { throw new Error("横杠在挪：" + JSON.stringify(seen)); }
    // 刻度对不对：填充 = (横杠宽 - 右头那一格 60) × 63%（左头那一格只挖掉看得见的那层，不算在尺子里）
    const tail = 60;
    const expect = Math.round((seen[0].w - tail) * 0.63);
    console.log(`刻度：应当 ${expect}px，实际 ${seen[0].fill}px${Math.abs(expect - seen[0].fill) <= 1 ? " ✓" : " ✗"}`);
};

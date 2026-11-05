// @ts-nocheck
/**
 * ctxChip —— 量输入框顶边上那条（状态图 / 用量横杠 / 生成速度）与底行那颗模型名胶囊，
 * 并把它放大截几张图看。
 *
 *   npm run web:shot -- --fake-pi --script dev/ctxChip.js
 *   npm run web:shot -- --width 360 --height 780 --fake-pi --script dev/ctxChip.js
 *
 * 图落在 dev/shots/：ctx-top-run.png（跑着，有状态图与速度）、ctx-top-idle.png（没在跑）。
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
};

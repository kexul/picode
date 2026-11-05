// @ts-nocheck
/**
 * ctxChip —— 量输入框顶边上那条（上下文用量的横杠）和底行那几样读数（状态图 / 模型名 / 生成速度），
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

/** 往页面里摆一段假状态：模型名、用量（写到 #composer 上）、状态图、速度（真数据要跑一轮才有）。 */
const fake = (pct, act, tps) => `
    const el = document.getElementById("ctxIcon");
    const top = document.getElementById("composer");
    el.querySelector(".ci-name").textContent = "deepseek-flash";
    document.getElementById("composer").style.setProperty("--ci-pct", ${JSON.stringify(pct)});
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
        return { chip: q("#ctxIcon"), name: q("#ctxIcon .ci-name"), composer: q("#composer"),
                 act: q("#ctxAct"), tps: q("#ctxTps") };
    `);
    console.log(JSON.stringify(rects, null, 2));
    await shot(page, "ctx-top-run.png", 3);

    await page.eval(fake(0.08, "", ""));
    await page.sleep(200);
    await shot(page, "ctx-top-idle.png", 3);

    // ---- 三、横杠的位置随两头的东西伸缩，但填充永远从它自己的左头起 ----
    // 挨个摆一遍（速度数在不在、位数多宽、状态图在不在），每次量横杠的两端和填充：
    // 这是“弹性”那版 —— 横杠吃掉中间剩下的位置，所以有图 / 有速度时短一点，都没有时铺满整条。
    // 要守的是：填充从横杠自己的左头起、图标与速度都不压着横杠、模型名不被挤动。
    const cases = [
        { act: "tool", tps: "116.5 t/s" },
        { act: "tool", tps: "9.8 t/s" },
        { act: "writing", tps: "1234.5 t/s" },
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
            const t = document.getElementById("ctxTps").getBoundingClientRect();
            const name = document.getElementById("ctxIcon").getBoundingClientRect();
            return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width),
                     fill: Math.round(f.width), fillLeft: Math.round(f.left),
                     actRight: a.width ? Math.round(a.right) : null,
                     tpsLeft: t.width ? Math.round(t.left) : null,
                     nameLeft: Math.round(name.left) };`);
        if (r.fillLeft !== r.left) { throw new Error(`填充没从横杠左头起：横杠 ${r.left}，填充 ${r.fillLeft}`); }
        if (c.act && r.actRight > r.left) { throw new Error(`图标压在横杠上了：图标右边缘 ${r.actRight}，横杠从 ${r.left} 起`); }
        if (c.tps && r.tpsLeft < r.right) { throw new Error(`速度数压在横杠上了：横杠到 ${r.right} 止，速度从 ${r.tpsLeft} 起`); }
        if (seen.length && r.nameLeft !== seen[0].nameLeft) { throw new Error(`模型名被挤动了：${seen[0].nameLeft} → ${r.nameLeft}`); }
        seen.push({ at: r.left + ".." + r.right, w: r.width, fill: r.fill, nameLeft: r.nameLeft,
                    act: c.act || "（无）", tps: c.tps || "（无）" });
    }
    console.log("");
    console.log("横杠的位置（有图 / 有速度时短一点，都没有时铺满）与 63% 的填充：");
    for (const s of seen) {
        const pct = ((s.fill / s.w) * 100).toFixed(1);
        console.log(`  ${s.at} w=${s.w} 填充 ${s.fill}（${pct}%）  状态图 ${s.act}  速度 ${s.tps}`);
    }
    // 每种摆法里填充都该是横杠长度的 63%
    for (const s of seen) {
        if (Math.abs(s.fill / s.w - 0.63) > 0.01) { throw new Error(`刻度不对：${s.at} 填充 ${s.fill} / 横杠 ${s.w}`); }
    }
    console.log("刻度：每种摆法都是横杠长的 63% ✓");
};

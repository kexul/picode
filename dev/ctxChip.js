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

    // ---- 三、横杠的位置、长度、刻度，在什么场景下都一样；两样读数都在下面那行 ----
    // 挨个摆一遍（速度数在不在、位数多宽、状态图在不在），每次量横杠的两端和填充：
    // 横杠整条铺在盒子的顶边上，只该有一种位置，填充也只该从它的左头起。
    // 状态图与速度数现在都在底下那条小横排里（不在顶边那条上），所以不许跟横杠有任何重叠。
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
            const name = document.querySelector("#ctxIcon").getBoundingClientRect();
            return { nameLeft: Math.round(name.left),
                     left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width),
                     fill: Math.round(f.width), fillLeft: Math.round(f.left),
                     barBottom: Math.round(b.bottom),
                     actTop: a.width ? Math.round(a.top) : null,
                     actRight: Math.round(a.right),
                     tpsTop: t.width ? Math.round(t.top) : null,
                     tpsRight: t.width ? Math.round(t.right) : null };`);
        // 深色那截必须从横杠自己的左头起
        if (r.fillLeft !== r.left) { throw new Error(`填充没从横杠左头起：横杠 ${r.left}，填充 ${r.fillLeft}`); }
        // 状态图那一格一直在（只是空的），所以模型名的左边不该跟着动
        if (r.nameLeft !== seen[0]?.nameLeft && seen.length) {
            throw new Error(`模型名被挤动了：${seen[0].nameLeft} → ${r.nameLeft}`);
        }
        // 两样读数都在下面那行：上边必须在横杠下边之下
        if (c.act && r.actTop < r.barBottom) { throw new Error(`状态图跑到顶边那条上了：上边 ${r.actTop}，横杠下边 ${r.barBottom}`); }
        if (c.tps && r.tpsTop < r.barBottom) { throw new Error(`速度数跑到顶边那条上了：上边 ${r.tpsTop}，横杠下边 ${r.barBottom}`); }
        seen.push({ at: r.left + ".." + r.right, w: r.width, fill: r.fill, nameLeft: r.nameLeft,
                    act: c.act || "（无）", tps: c.tps || "（无）" });
    }
    console.log("");
    console.log("横杠的位置（应当只有一种），以及 63% 时填充的长度：");
    for (const s of seen) { console.log(`  ${s.at} w=${s.w} 填充 ${s.fill}  名字左边 ${s.nameLeft}  状态图 ${s.act}  速度 ${s.tps}`); }
    const spots = new Set(seen.map((s) => s.at));
    if (spots.size > 1) { throw new Error("横杠在挪：" + JSON.stringify(seen)); }
    // 刻度对不对：填充 = 横杠宽 × 63%
    const expect = Math.round(seen[0].w * 0.63);
    console.log(`刻度：应当 ${expect}px，实际 ${seen[0].fill}px${Math.abs(expect - seen[0].fill) <= 1 ? " ✓" : " ✗"}`);
};

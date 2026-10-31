// @ts-nocheck
/**
 * 验顶条那排格的过渡：换位置时不是“啪”地跳，而是滑过去（底色也是淡过去的）。
 *
 *   npm run web:shot -- --fake-pi --width 420 --height 700 --script dev/tabSlide.js
 *
 * 验三件事：
 *   ① 挤着的时候点另一张标签切过去：有格子出现平移补偿（transform: translateX），
 *      三百毫秒后清干净（不留 inline 过渡，免得盖掉下面那条“底色淡过去”）；
 *   ② 底色是渐变过去的（顶条那排格上有 background-color 的过渡）；
 *   ③ 手机上左右划切会话：内容区滑过去的同时，顶条那排也跟着动（同样出现平移补偿）。
 */
const LOOK = `
    const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden"));
    const cur = tabs.find((t) => t.classList.contains("current"));
    return {
        格数: tabs.length,
        当前: cur ? (cur.querySelector(".sn-text") || {}).textContent || "" : "",
        底色过渡: cur ? getComputedStyle(cur).transitionProperty + " " + getComputedStyle(cur).transitionDuration : "",
        还在滑: tabs.filter((t) => t.style.transform).length,
        还挂着过渡: tabs.filter((t) => t.style.transition).length,
    };
`;

/** 接下来这几百毫秒里，哪些格子出现过平移补偿（按帧采样）。 */
const WATCH = `
    return new Promise((resolve) => {
        const seen = [];
        const t0 = performance.now();
        const tick = () => {
            for (const el of document.querySelectorAll("#sessionTabs .sn-tab")) {
                const tr = el.style.transform;
                if (!tr) { continue; }
                const name = (el.querySelector(".sn-text") || {}).textContent || "";
                const key = name + " " + tr;
                if (seen.indexOf(key) < 0 && seen.length < 12) { seen.push(key); }
            }
            if (performance.now() - t0 < 600) { requestAnimationFrame(tick); } else { resolve(seen); }
        };
        tick();
    });
`;

module.exports = async (page) => {
    const look = async (label) => {
        const r = await page.eval(`const f = function () { ${LOOK} }; return f();`);
        console.log("  " + label + "：" + JSON.stringify(r));
        return r;
    };

    await page.waitReady();
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.sleep(1200);

    // 多开几个会话（挤了以后切换会重排，才有位置可滑）
    for (let i = 0; i < 4; i++) { await page.click("#newSessionBtn"); await page.sleep(1300); }
    await page.sleep(400);
    const before = await look("① 五个会话、当前是最后一个");

    // 点最左边那一格：切过去（一边切一边采样顶条那排的位移）
    const watched = page.eval(WATCH);
    await page.eval(`
        document.querySelectorAll("#sessionTabs .sn-tab")[0].click();
        return true;
    `);
    const seen = await watched;
    await page.sleep(400);
    const after = await look("① 切完以后");
    console.log("  ① 切的那一下出现过的平移：" + JSON.stringify(seen));
    if (!seen.length) { throw new Error("切标签的时候顶条那排没有滑（一个平移补偿都没有）"); }
    if (after.还在滑 || after.还挂着过渡) { throw new Error("滑完以后没清干净：" + JSON.stringify(after)); }
    if (String(after.底色过渡).indexOf("background-color") < 0) {
        throw new Error("底色不是渐变过去的：" + after.底色过渡);
    }
    await page.shot("tabslide-1-switched.png");

    // ② 手机上左右划：内容区滑的同时，顶条那排也该跟着动
    const slideSeen = page.eval(WATCH);
    const touch = (type, x, y) => page.cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    });
    await touch("touchStart", 340, 420);
    for (let i = 1; i <= 8; i++) {
        await touch("touchMove", 340 - (340 - 80) * (i / 8), 420);
        await page.sleep(16);
    }
    await touch("touchEnd", 80, 420);
    const seenSwipe = await slideSeen;
    await page.sleep(500);
    console.log("  ② 划过去那一下出现过的平移：" + JSON.stringify(seenSwipe));
    if (!seenSwipe.length) { throw new Error("左右划切会话时顶条那排没有跟着动"); }
    const end = await look("② 划完以后");
    if (end.还在滑 || end.还挂着过渡) { throw new Error("划完以后没清干净：" + JSON.stringify(end)); }
    await page.shot("tabslide-2-swipe.png");

    console.log("通过");
};

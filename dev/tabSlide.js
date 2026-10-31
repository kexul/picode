// @ts-nocheck
/**
 * 验顶条那排格的过渡：换位置时不是“啪”地跳，而是滑过去（底色也是淡过去的）。
 *
 *   npm run web:shot -- --fake-pi --width 420 --height 700 --script dev/tabSlide.js
 *
 * 验这么几件事：
 *   ⓪ 挤成“一张大的 + 两颗点”时左右划：那颗点真跟着手指涨开（名字慢慢露出来）、当前这一格跟着收，
 *      松手切过去那一下从手指停下的宽度接着长（不先缩成小标签再弹开），切完不留钉住的宽度；
 *   ①②③④ 点另一张标签切过去时会滑过去、底色淡过去；左右划切过去时旧的那一格落在划过去的那一边；
 *      划一小截弹回去不留钉住的宽度。
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
    const touch = (type, x, y) => page.cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    });
    const widths = () => page.eval(`
        const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden"));
        const cur = tabs.find((t) => t.classList.contains("current"));
        const grow = tabs.find((t) => t.classList.contains("tab-growing"));
        return {
            当前宽: cur ? Math.round(cur.getBoundingClientRect().width) : 0,
            正在变宽的那格: grow ? Math.round(grow.getBoundingClientRect().width) : 0,
            变宽的那格有名字: !!grow && !!grow.querySelector(".sn-text") && getComputedStyle(grow.querySelector(".sn-text")).display !== "none",
        };
    `);

    // ⓪ 手机上最常见的挤法（三个会话：当前这一格是大 tab、别的收成一颗点）。滑过去时
    //    那颗点要真的在涨、大 tab 在收（以前那点一直不动，松手才猛地涨开 —— 看着就是“先不动、最后跳一下”）。
    //    两个会话时放得下（每格都写着名字），那种情况宽度本来就不该动，不在这儿验。
    for (let i = 0; i < 2; i++) {
        await page.click("#newSessionBtn");
        await page.sleep(1500);
    }
    const widthsAll = () => page.eval(`
        const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden"));
        return tabs.map((t) => Math.round(t.getBoundingClientRect().width));
    `);
    const twoBefore = await widthsAll();
    const growBefore = await widths();
    if (!(twoBefore.length === 3 && twoBefore.filter((w) => w <= 30).length === 2)) {
        throw new Error("三个会话该挤成“一张大的 + 两颗点”，现在量到的是：" + JSON.stringify(twoBefore));
    }
    await touch("touchStart", 80, 420);
    for (let i = 1; i <= 4; i++) {
        await touch("touchMove", 80 + (340 - 80) * (i / 8), 420);
        await page.sleep(16);
    }
    const twoHalfAll = await widthsAll();
    const twoHalf = await widths();
    console.log("  ⓪ 三个会话：划之前 " + JSON.stringify(twoBefore) + " → 划到一半 " + JSON.stringify(twoHalfAll)
        + "（要进来的那格 " + twoHalf.正在变宽的那格 + "，当前 " + twoHalf.当前宽 + "）");
    if (!(twoHalf.正在变宽的那格 > 21 + 1 && twoHalf.变宽的那格有名字)) {
        throw new Error("划到一半，要进来的那一格没有跟着涨开：" + JSON.stringify({ twoBefore, twoHalf }));
    }
    if (!(twoHalf.当前宽 < growBefore.当前宽 - 1)) {
        throw new Error("划到一半，当前那一格没有跟着收：" + JSON.stringify({ growBefore, twoHalf }));
    }
    for (let i = 5; i <= 8; i++) {
        await touch("touchMove", 80 + (340 - 80) * (i / 8), 420);
        await page.sleep(16);
    }
    await touch("touchEnd", 340, 420);
    await page.sleep(400);
    const twoSettled = await widths();
    console.log("  ⓪ 松手切完：当前这一格 " + twoSettled.当前宽 + "（手指离开时它 " + twoHalf.正在变宽的那格 + "）");
    if (!(twoSettled.当前宽 > twoHalf.正在变宽的那格 + 1)) {
        throw new Error("松手那一下没有接着涨（该从手指停下的宽度接着长）：" + JSON.stringify({ twoHalf, twoSettled }));
    }
    const leftover = await page.eval(`
        return [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => t.style.width).length;
    `);
    if (leftover) {
        throw new Error("松手切完之后还留着钉住的宽度：" + leftover);
    }

    /** 给“现在的当前这一格”打个记号，一会儿看它切完落到哪一边。 */
    const markOld = () => page.eval(`
        const cur = [...document.querySelectorAll("#sessionTabs .sn-tab")].find((t) => t.classList.contains("current"));
        if (cur) { cur.dataset.oldCur = "1"; }
        return !!cur;
    `);
    const whereOld = () => page.eval(`
        const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden"));
        const oldAt = tabs.findIndex((t) => t.dataset.oldCur === "1");
        const curAt = tabs.findIndex((t) => t.classList.contains("current"));
        tabs.forEach((t) => { delete t.dataset.oldCur; });
        return { 旧当前在: oldAt, 当前在: curAt, 总共: tabs.length };
    `);

    // ② 手机上左右划：内容区滑的同时，顶条那排也该跟着动
    //   划到一半就量一下：要进来的那一格变宽了（名字露出来）、当前那一格收窄了
    await markOld();
    const swipeBefore = await widths();
    await touch("touchStart", 340, 420);
    for (let i = 1; i <= 4; i++) {
        await touch("touchMove", 340 - (340 - 80) * (i / 8), 420);
        await page.sleep(16);
    }
    const swipeHalf = await widths();
    console.log("  ② 划到一半：之前 " + JSON.stringify(swipeBefore) + " → 现在 " + JSON.stringify(swipeHalf));
    if (!swipeHalf.变宽的那格有名字) { throw new Error("划到一半时，要进来的那一格名字没露出来"); }
    if (!(swipeHalf.当前宽 < swipeBefore.当前宽)) { throw new Error("划到一半时，当前那一格没有收窄"); }
    if (!(swipeHalf.正在变宽的那格 > 0)) { throw new Error("划到一半时，没找到正在变宽的那一格"); }
    const slideSeen = page.eval(WATCH);
    for (let i = 5; i <= 8; i++) {
        await touch("touchMove", 340 - (340 - 80) * (i / 8), 420);
        await page.sleep(16);
    }
    // 松手前一瞬那格有多宽：切过去以后它得从这儿接着长，不是一下跳到最终宽
    const beforeRelease = await widths();
    await touch("touchEnd", 80, 420);
    await page.sleep(60);
    const rightAfter = await widths();
    await page.sleep(260);
    const settled = await widths();
    console.log("  ② 松手：手离开时 " + JSON.stringify(beforeRelease) + " → 60 毫秒后 " + JSON.stringify(rightAfter)
        + " → 到站 " + JSON.stringify(settled));
    if (!(rightAfter.当前宽 < settled.当前宽 - 1)) {
        throw new Error("松手那一下宽度一下跳到最终值了（该接着长）：" + JSON.stringify({ rightAfter, settled }));
    }
    const seenSwipe = await slideSeen;
    await page.sleep(500);
    // 这一趟不再补平移：位置完全跟着宽度走（整排居中自己会挪）。这里只把采到的打出来，
    // 有的话是别的格子被重排了（不该有，但不算错）。
    console.log("  ② 划过去那一下出现过的平移：" + JSON.stringify(seenSwipe));
    const end = await look("② 划完以后");
    if (end.还在滑 || end.还挂着过渡) { throw new Error("划完以后没清干净：" + JSON.stringify(end)); }
    const leftDir = await whereOld();
    console.log("  ② 向左划切完：旧的那一格落在 " + JSON.stringify(leftDir));
    if (!(leftDir.旧当前在 >= 0 && leftDir.当前在 >= 0)) { throw new Error("没找着旧的/新的当前格：" + JSON.stringify(leftDir)); }
    if (!(leftDir.旧当前在 < leftDir.当前在)) {
        throw new Error("向左划切到下一个，刚下来的那一格该落在左边：" + JSON.stringify(leftDir));
    }
    await page.shot("tabslide-2-swipe.png");

    // ③ 再向右划回去：刚下来的那一格这回该落在右边
    await markOld();
    await touch("touchStart", 80, 420);
    for (let i = 1; i <= 8; i++) {
        await touch("touchMove", 80 + (340 - 80) * (i / 8), 420);
        await page.sleep(16);
    }
    await touch("touchEnd", 340, 420);
    await page.sleep(500);
    const rightDir = await whereOld();
    console.log("  ③ 向右划切完：旧的那一格落在 " + JSON.stringify(rightDir));
    if (!(rightDir.旧当前在 >= 0 && rightDir.当前在 >= 0)) { throw new Error("没找着旧的/新的当前格：" + JSON.stringify(rightDir)); }
    if (!(rightDir.旧当前在 > rightDir.当前在)) {
        throw new Error("向右划切到上一个，刚下来的那一格该落在右边：" + JSON.stringify(rightDir));
    }
    await page.shot("tabslide-3-swipe-back.png");

    // ④ 划一小截就松手（不到线，弹回去）：宽度得滑回原样，不留 inline 宽度
    const widthsOf = () => page.eval(`
        const tabs = [...document.querySelectorAll("#sessionTabs .sn-tab")].filter((t) => !t.classList.contains("hidden"));
        return tabs.map((t) => t.style.width || "-");
    `);
    await touch("touchStart", 340, 420);
    for (let i = 1; i <= 3; i++) {
        await touch("touchMove", 340 - 60 * (i / 3), 420);
        await page.sleep(16);
    }
    await touch("touchEnd", 280, 420);
    await page.sleep(400);
    const leftInline = (await widthsOf()).filter((w) => w !== "-");
    const back = await look("④ 划一小截松手以后");
    if (leftInline.length) { throw new Error("弹回去以后还留着钉住的宽度：" + JSON.stringify(leftInline)); }
    if (back.还挂着过渡) { throw new Error("弹回去以后过渡没放开：" + JSON.stringify(back)); }
    await page.shot("tabslide-4-springback.png");

    // ① 挤着的时候点另一张标签切过去：位置要滑过去、底色要淡过去。
    //    这里用注入的会话：真会话刚建出来还在预加载，点了得等后端回话，验不稳。
    const names = ["甲会话", "乙会话", "丙会话", "丁会话", "戊会话"];
    const fake = names.map((name, i) => ({
        id: "px" + i, name, cwd: "dev/.scratch", file: "", title: "", parentId: null,
        streaming: false, loading: false, activity: "idle", activityDetail: "", piReady: true,
        modelId: "fake/model", provider: "fake", thinkingLevel: "medium", taba: null,
    }));
    await page.eval(`
        for (const m of ${JSON.stringify([{ type: "sessionList", sessions: fake }, { type: "sessionActivated", sessionId: "px4" }])}) {
            window.postMessage(m, "*");
        }
        return true;
    `);
    await page.sleep(800);
    const before = await look("① 五个会话、当前是最后一个");
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
    console.log("通过");
};

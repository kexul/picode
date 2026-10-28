// @ts-nocheck
/**
 * 验「手机上左右划切会话」：在对话区横着划一下就跟手走（正在看的那个跟着手指挪、
 * 下一个从另一边进来），松手过了线就真切过去；划得不够远、竖着划都不切。
 *
 *   npm run web:shot -- --width 420 --height 900 --fake-pi --script dev/swipeSession.js
 *
 * 手指的动作走 CDP 的 Input.dispatchTouchEvent（浏览器会派发对应的 touch 事件，
 * 跟真手指一样）。每划一次报：正在看的是哪个会话、拖动中两个壳的位移（transform）、
 * #messages 有没有截边（.swiping）。
 */
const LOOK = `
    const views = Array.from(document.querySelectorAll(".session-view"));
    const shown = views.filter((v) => !v.classList.contains("off"));
    return {
        active: shown.length === 1 ? shown[0].dataset.sessionId : "(" + shown.length + " 个露着)",
        title: (document.querySelector(".session-view:not(.off) .msg.user") || {}).innerText || "(空会话)",
        views: views.length,
        shown: shown.length,
        swiping: document.getElementById("messages").classList.contains("swiping"),
        moved: views
            .filter((v) => v.style.transform)
            .map((v) => "…" + v.dataset.sessionId.slice(-4) + ":" + v.style.transform.replace("translateX(", "").replace(")", "")),
    };
`;

module.exports = async (page) => {
    const look = async (label) => {
        const r = JSON.parse(await page.eval(`const f = function () { ${LOOK} }; return JSON.stringify(f());`));
        console.log(`${label}\n    正在看：…${r.active.slice(-4)}「${r.title.trim().slice(0, 20)}」` +
            `　壳 ${r.views} 个（露着 ${r.shown} 个）` +
            `\n    截边(swiping)：${r.swiping}　位移：${JSON.stringify(r.moved)}`);
        return r;
    };
    const touch = (type, x, y) => page.cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    });
    /** 从 (x0,y0) 划到 (x1,y1)：分几步走，最后一步之后可以停下来看看、拍张照。 */
    const drag = async (x0, y0, x1, y1, steps = 8, atEnd) => {
        await touch("touchStart", x0, y0);
        for (let i = 1; i <= steps; i++) {
            await touch("touchMove", x0 + (x1 - x0) * (i / steps), y0 + (y1 - y0) * (i / steps));
            await page.sleep(16);
        }
        if (atEnd) { await atEnd(); }
        await touch("touchEnd", x1, y1);
    };

    await page.waitReady();
    await page.sleep(900);
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

    // 第一个会话里说一句（假模型秒回）：滑过去的时候看得出那是另一个会话，不是空白
    await page.send("第一个会话里说的话");
    await page.sleep(900);
    // 再多开两个会话（切会话得有得切）
    for (let i = 0; i < 2; i++) {
        await page.click("#newSessionBtn");
        await page.sleep(700);
    }
    const before = await look("开三个会话之后");

    const box = JSON.parse(await page.eval(`
        const r = document.getElementById("messages").getBoundingClientRect();
        return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
    `));
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;

    // 1. 往左划一大截（下一个），划到一半停下来看看跟手的样子
    await drag(cx + 60, cy, cx - 120, cy, 8, async () => {
        await look("往左划到一半（还没松手）");
        await page.shot("swipe-left-half.png");
    });
    await page.sleep(400);
    const afterLeft = await look("往左划完、松手");
    console.log(afterLeft.active !== before.active ? "    ✓ 切过去了" : "    ✗ 没切过去");
    await page.shot("swipe-left-done.png");

    // 2. 往右划回去
    await drag(cx - 60, cy, cx + 120, cy);
    await page.sleep(400);
    const back = await look("往右划回去");
    console.log(back.active === before.active ? "    ✓ 回到了原来那个" : "    ✗ 没回到原来那个");

    // 3. 只划一小截（没过线）：弹回去，不切
    await drag(cx + 30, cy, cx - 10, cy, 5);
    await page.sleep(400);
    const tiny = await look("只划一小截");
    console.log(tiny.active === before.active ? "    ✓ 没切（弹回去了）" : "    ✗ 不该切却切了");

    // 4. 竖着划：那是滚动，不切会话
    await drag(cx, cy + 100, cx, cy - 100);
    await page.sleep(400);
    const vertical = await look("竖着划");
    console.log(vertical.active === before.active ? "    ✓ 没切（交还给滚动）" : "    ✗ 竖着划不该切");

    // 5. 后端回话故意迟到 400 毫秒（比最后那 180 毫秒的滑完还慢）：画面不该冻在手指离开的地方，
    //    该当场滑到位；等它回话只是收尾（不该再滑一下、也不该多留一份位移）。
    await page.eval(`
        const api = window.acquireVsCodeApi();
        const orig = api.postMessage.bind(api);
        api.postMessage = function (msg) {
            if (msg && msg.type === "switchSession") { setTimeout(function () { orig(msg); }, 400); return; }
            orig(msg);
        };
        return true;
    `);
    await drag(cx - 60, cy, cx + 120, cy);
    await page.sleep(200);
    const half = await look("后端还没回话（松手 200 毫秒后）");
    await page.sleep(900);
    const late = await look("后端回话之后");
    // 松手 200 毫秒时：进来的那个已经在正中（0px），出去的那个已经推出屏外 —— 就是“没冻住、当场滑到位”
    const settledNow = half.moved.some((one) => one.endsWith(":0px"));
    const ok = settledNow && half.swiping && late.shown === 1 && late.moved.length === 0 &&
        late.active !== before.active && !late.swiping;
    console.log(ok ? "    ✓ 画面当场滑到位，回话迟到也不冻住、不重滑" : "    ✗ 回话迟到时的收尾不对");
    await page.eval(`
        const api = window.acquireVsCodeApi();
        delete api.postMessage;
        return true;
    `).catch(() => {});
    console.log(`\n页面报错：${page.pageErrors.length ? JSON.stringify(page.pageErrors.slice(0, 5)) : "无"}`);
};

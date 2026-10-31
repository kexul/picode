// @ts-nocheck
/**
 * 验「手机上左右划切会话」：在对话区横着划一下就跟手走（正在看的那个跟着手指挪、
 * 下一个从另一边进来），松手过了线就真切过去；划得不够远、竖着划都不切。
 * 滑到头（最左 / 最右那个会话）不再绕到另一头：跟着拉一小段、松手把那一侧的侧边栏滑进来
 *（往左划开右边的「项目与会话」，往右划开左边的文件侧边栏）。
 *
 *   npm run web:shot -- --width 420 --height 900 --fake-pi --script dev/swipeSession.js
 *
 * 手指的动作走 CDP 的 Input.dispatchTouchEvent（浏览器会派发对应的 touch 事件，
 * 跟真手指一样）。每划一次报：正在看的是哪个会话、拖动中两个壳的位移（transform）、
 * #messages 有没有截边（.swiping）、两块侧边栏开没开。
 */
const LOOK = `
    const views = Array.from(document.querySelectorAll(".session-view"));
    const shown = views.filter((v) => !v.classList.contains("off"));
    const panelEl = document.getElementById("pickerPanel");
    const fileEl = document.getElementById("fileSidebar");
    const drawer = panelEl.style.transform || fileEl.style.transform || "-";
    return {
        active: shown.length === 1 ? shown[0].dataset.sessionId : "(" + shown.length + " 个露着)",
        title: (document.querySelector(".session-view:not(.off) .msg.user") || {}).innerText || "(空会话)",
        views: views.length,
        shown: shown.length,
        idx: (document.getElementById("sessionName") || { dataset: {} }).dataset.idx || "",
        swiping: document.getElementById("messages").classList.contains("swiping"),
        panel: document.getElementById("pickerOverlay").classList.contains("hidden") ? "关" : "开",
        file: document.body.classList.contains("file-open") ? "开" : "关",
        drawer: drawer,
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
            `\n    截边(swiping)：${r.swiping}　侧边栏：项目与会话 ${r.panel} / 文件 ${r.file}　抽屉位置：${r.drawer}` +
            `　位移：${JSON.stringify(r.moved)}`);
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

    // 牵一点（拉得少的可以自己控节奏：慢拉就不算“甩”，不会过线）
    const slowDrag = async (x0, y0, x1, y1, steps, gap) => {
        await touch("touchStart", x0, y0);
        for (let i = 1; i <= steps; i++) {
            await touch("touchMove", x0 + (x1 - x0) * (i / steps), y0 + (y1 - y0) * (i / steps));
            await page.sleep(gap);
        }
        await touch("touchEnd", x1, y1);
    };

    // 第一个会话里说一句（假模型秒回）：滑过去的时候看得出那是另一个会话，不是空白
    await page.send("第一个会话里说的话");
    await page.sleep(900);

    const box = JSON.parse(await page.eval(`
        const r = document.getElementById("messages").getBoundingClientRect();
        return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
    `));
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;

    // 0. 只开着一个会话时，左右两边都是头：往左划开右边的「项目与会话」、往右划开左边的文件侧边栏
    const lone = await look("只有一个会话");
    await drag(cx + 60, cy, cx - 160, cy);
    await page.sleep(700);
    const loneRight = await look("唯一的会话往左划");
    console.log(loneRight.panel === "开" && loneRight.active === lone.active
        ? "    ✓ 没换会话（没得换），右边的「项目与会话」滑进来了"
        : "    ✗ 只有一个会话时往左划该开右边的侧边栏");
    await page.eval('document.getElementById("pickerOverlay").click(); return true;');
    await page.sleep(600);
    await drag(cx - 60, cy, cx + 160, cy);
    await page.sleep(700);
    const loneLeft = await look("唯一的会话往右划");
    console.log(loneLeft.file === "开" && loneLeft.active === lone.active
        ? "    ✓ 左边的文件侧边栏滑进来了"
        : "    ✗ 只有一个会话时往右划该开左边的文件侧边栏");
    await page.click("#fileClose");
    await page.sleep(600);

    // 再多开两个会话（切会话得有得切）
    for (let i = 0; i < 2; i++) {
        await page.click("#newSessionBtn");
        await page.sleep(700);
    }
    // 三个会话按「正在对话」那一列的顺序排，当前（最后开的那个）在末位。
    // 切到中间那一格：左右两边都有得切（滑到头是另一回事，见后面第 6 到 8 步）
    await page.click('#sessionBar .sn-tab[data-idx="1"]');
    await page.sleep(600);
    const before = await look("开三个会话、切到中间那个");
    if (!before.active || before.idx !== "1") { throw new Error("没切到中间那一格：" + JSON.stringify(before)); }

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
        api.__origPostMessage = api.__origPostMessage || api.postMessage;
        const orig = api.__origPostMessage.bind(api);
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
        if (api.__origPostMessage) { api.postMessage = api.__origPostMessage; delete api.__origPostMessage; }
        return true;
    `).catch(() => {});

    // 6. 最右那一格再往左划：不再绕到第一格，改成把「项目与会话」跟手拉出来
    await page.click('#sessionBar .sn-tab[data-idx="2"]');
    await page.sleep(600);
    const atLast = await look("切到最右那一格");
    if (atLast.idx !== "2") { throw new Error("没切到最右那一格：" + JSON.stringify(atLast)); }
    const pulledOf = (tr) => Math.abs(parseFloat(String(tr).replace(/[^0-9.\-]/g, "")) || 0);
    await drag(cx + 60, cy, cx - 200, cy, 10, async () => {
        const half = await look("最右那个再往左划到一半（还没松手）");
        // 会话那排不动，倒是右边那块面板跟着手指出来了（还差一截没到位）
        console.log((half.moved.length === 0 && half.panel === "开" && pulledOf(half.drawer) > 10 && pulledOf(half.drawer) < box.w * 0.9)
            ? "    ✓ 会话没挪，右边那块侧边栏跟手出来了一截" : "    ✗ 到头那一下的跟手不对");
        await page.shot("swipe-edge-half.png");
    });
    await page.sleep(700);
    const edgeRight = await look("最右那个往左划完、松手");
    console.log(edgeRight.panel === "开" && edgeRight.active === atLast.active && edgeRight.moved.length === 0 &&
        pulledOf(edgeRight.drawer) < 1
        ? "    ✓ 没换会话，右边的「项目与会话」收到位了"
        : "    ✗ 滑到头该把右边的侧边栏拉出来");
    await page.shot("swipe-edge-panel.png");
    await page.eval('document.getElementById("pickerOverlay").click(); return true;');
    await page.sleep(600);
    const closed = await look("点遮罩收起来");
    console.log(closed.panel === "关" && closed.drawer === "-" ? "    ✓ 收得干净（临时样式也摘了）" : "    ✗ 收起后还留着抽屉的位置");

    // 7. 只慢慢拉一小截（没过线又没甩）：滑回去，什么也不开
    await slowDrag(cx + 60, cy, cx + 30, cy, 6, 70);
    await page.sleep(800);
    const edgeTiny = await look("最右那个只慢慢往左拉一小截");
    console.log(edgeTiny.panel === "关" && edgeTiny.active === atLast.active && edgeTiny.moved.length === 0
        ? "    ✓ 没开侧边栏，抽屉滑回去了"
        : "    ✗ 拉得不够也开了 / 没滑回去");

    // 8. 最左那一格再往右划：把左边的文件侧边栏滑进来
    await page.click('#sessionBar .sn-tab[data-idx="0"]');
    await page.sleep(600);
    const atFirst = await look("切到最左那一格");
    if (atFirst.idx !== "0") { throw new Error("没切到最左那一格：" + JSON.stringify(atFirst)); }
    await drag(cx - 60, cy, cx + 200, cy, 10, async () => {
        const half = await look("最左那个再往右划到一半（还没松手）");
        console.log((half.moved.length === 0 && half.file === "开" && pulledOf(half.drawer) > 10 && pulledOf(half.drawer) < box.w * 0.9)
            ? "    ✓ 会话没挪，左边那一列跟手出来了一截" : "    ✗ 往右划到头那一下的跟手不对");
        await page.shot("swipe-edge-file-half.png");
    });
    await page.sleep(700);
    const edgeLeft = await look("最左那个往右划完、松手");
    console.log(edgeLeft.file === "开" && edgeLeft.active === atFirst.active && edgeLeft.moved.length === 0 &&
        pulledOf(edgeLeft.drawer) < 1
        ? "    ✓ 没换会话，左边的文件侧边栏拉出来了"
        : "    ✗ 滑到头该把左边的文件侧边栏拉出来");
    await page.shot("swipe-edge-file.png");

    console.log(`\n页面报错：${page.pageErrors.length ? JSON.stringify(page.pageErrors.slice(0, 5)) : "无"}`);
};

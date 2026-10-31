// @ts-nocheck
/**
 * 验「电脑上用鼠标拖也能切会话」：在没有文字的地方按住鼠标横着拖就切、拖到一半就跟手；
 * 从文字上按下还是老老实实选字（不切）；拖得不够远、竖着拖、按钮上按都不切。
 *
 *   npm run web:shot -- --width 1000 --height 760 --fake-pi --script dev/dragSession.js
 *
 * 鼠标动作用 CDP 的 Input.dispatchMouseEvent（跟真人按下一模一样，浏览器照常派发 pointer 事件）。
 */
const LOOK = `
    const views = Array.from(document.querySelectorAll(".session-view"));
    const shown = views.filter((v) => !v.classList.contains("off"));
    const sel = window.getSelection();
    return {
        active: shown.length === 1 ? shown[0].dataset.sessionId : "(" + shown.length + " 个露着)",
        shown: shown.length,
        swiping: document.getElementById("messages").classList.contains("swiping"),
        moved: views.filter((v) => v.style.transform).length,
        selected: sel ? sel.toString().length : 0,
    };
`;

module.exports = async (page) => {
    const look = async (label) => {
        const r = JSON.parse(await page.eval(`const f = function () { ${LOOK} }; return JSON.stringify(f());`));
        console.log(`${label}\n    正在看：…${r.active.slice(-4)}　露着 ${r.shown} 个　跟手(swiping)：${r.swiping}` +
            `　位移 ${r.moved} 个　选中的字数：${r.selected}`);
        return r;
    };
    const mouse = (type, x, y, extra) => page.cdp.send("Input.dispatchMouseEvent", Object.assign({
        type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: type === "mouseMoved" ? 0 : 1,
    }, extra || {}));
    /** 按住从 (x0,y0) 拖到 (x1,y1)：分几步走，中途可以看一眼、拍张照。 */
    const drag = async (x0, y0, x1, y1, steps = 10, atEnd) => {
        await mouse("mousePressed", x0, y0);
        for (let i = 1; i <= steps; i++) {
            await mouse("mouseMoved", x0 + (x1 - x0) * (i / steps), y0 + (y1 - y0) * (i / steps), { button: "left" });
            await page.sleep(16);
        }
        if (atEnd) { await atEnd(); }
        await mouse("mouseReleased", x1, y1);
    };

    await page.waitReady();
    await page.sleep(900);
    // 第一个会话里说一句（假模型秒回），再多开两个会话
    await page.send("第一个会话里说的话");
    await page.sleep(900);
    for (let i = 0; i < 2; i++) {
        await page.click("#newSessionBtn");
        await page.sleep(600);
    }
    // 三个会话按「正在对话」那一列的顺序排，最后开的那个在末位。
    // 切到中间那一格：左右两边都有得切（滑到头没有下一个，见第 5 步）
    await page.click('#sessionBar .sn-tab[data-idx="1"]');
    await page.sleep(600);
    const before = await look("开三个会话、切到中间那个");
    if (!before.active) { throw new Error("没切到中间那一格：" + JSON.stringify(before)); }

    // 一块“没有文字的地方”（最后一条消息下面的空地）
    const spot = JSON.parse(await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        const r = pane.getBoundingClientRect();
        const kids = Array.from(pane.children).filter((el) => el.getBoundingClientRect().height > 0);
        const last = kids[kids.length - 1];
        const lb = last ? last.getBoundingClientRect().bottom : r.top;
        return JSON.stringify({
            pane: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width },
            contentBottom: lb,
        });
    `));
    const blankX = spot.pane.left + spot.pane.w * 0.75;
    const blankY = Math.min(spot.pane.bottom - 80, Math.max(spot.pane.top + 40, spot.contentBottom + 120));
    console.log(`没有文字的地方：(${Math.round(blankX)}, ${Math.round(blankY)})`);

    // 1. 从空白处往左拖一大截（下一个），拖到一半看看跟手的样子
    await drag(blankX, blankY, blankX - 240, blankY, 10, async () => {
        await look("从空白处往左拖到一半（还没松手）");
        await page.shot("drag-half.png");
    });
    await page.sleep(400);
    const afterDrag = await look("往左拖完、松手");
    console.log(afterDrag.active !== before.active ? "    ✓ 切过去了" : "    ✗ 没切过去");
    await page.shot("drag-done.png");

    // 2. 从文字上按下往左拖：那是选字，不该切会话（切过来的这个会话里正好有那句话）
    const textSpot = JSON.parse(await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        const msg = pane.querySelector(".msg.user .md") || pane.querySelector(".msg.user");
        if (!msg) { return "null"; }
        const r = msg.getBoundingClientRect();
        return JSON.stringify({ x: r.left + 24, y: r.top + r.height / 2 });
    `));
    if (textSpot && textSpot.x) {
        console.log(`有文字的地方：(${Math.round(textSpot.x)}, ${Math.round(textSpot.y)})`);
        await drag(textSpot.x, textSpot.y, textSpot.x - 240, textSpot.y);
        await page.sleep(300);
        const onText = await look("从文字上往左拖");
        console.log(onText.active === afterDrag.active ? "    ✓ 没切（在选字）" : "    ✗ 从文字上拖不该切");
    } else {
        console.log("    （没找到文字，这一项跳过了）");
    }

    // 3. 空白处只拖一小截（没过线）：弹回去，不切
    await drag(blankX, blankY, blankX - 40, blankY, 5);
    await page.sleep(400);
    const tiny = await look("只拖一小截");
    console.log(tiny.active === afterDrag.active ? "    ✓ 没切（弹回去了）" : "    ✗ 不该切却切了");

    // 4. 空白处竖着拖：不管，不切
    await drag(blankX, blankY - 60, blankX, blankY + 60);
    await page.sleep(400);
    const vertical = await look("竖着拖");
    console.log(vertical.active === afterDrag.active ? "    ✓ 没切" : "    ✗ 竖着拖不该切");
    // 5. 最右那一格再往左拖：宽窗里右边那块「项目与会话」本来就常驻着，没有“滑进来”这回事，
    //    所以这一拖什么也不发生（不换会话、也不动那块面板）
    await page.click('#sessionBar .sn-tab[data-idx="2"]');
    await page.sleep(600);
    const atLast = await look("切到最右那一格");
    await drag(blankX, blankY, blankX - 240, blankY);
    await page.sleep(500);
    const edge = await look("最右那一格再往左拖");
    console.log(edge.active === atLast.active && edge.moved === 0 ? "    ✓ 没换会话（宽窗里那两块是常驻的，不滑入）" : "    ✗ 滑到头的行为不对");

    console.log(`\n页面报错：${page.pageErrors.length ? JSON.stringify(page.pageErrors.slice(0, 5)) : "无"}`);
};

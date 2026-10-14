// @ts-nocheck
/**
 * 验「鼠标扫过侧边栏行、移开之后留下什么」。
 *
 *   npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/hoverRow.js
 *
 * 宽窗（>=900）验常驻那一列；窄窗（--width 420）自动打开滑出来的抽屉，验那一份。
 * 鼠标停在某一行的中间 → 移到对话那边 → 再移回面板空白处，每一步报：
 *   · 哪几行带着 .active（那层灰底）
 *   · 哪几行真的被 :hover 命中（document.querySelectorAll(":hover")）
 *   · document.activeElement 是谁（DOM 焦点在谁身上）
 * 顶条（标题栏）那颗按钮同样走一遍，作对照。最后点一下列表里的一行，看鼠标点行还好不好使。
 */
const LOOK = `
    const hovered = Array.from(document.querySelectorAll(":hover"))
        .filter((el) => el.closest("#sidebarDock") || el.closest("#pickerOverlay") || el.closest("#sessionBar"));
    return {
        activeRows: Array.from(document.querySelectorAll("#dockBody .pk-item.active"))
            .map((el) => el.textContent.slice(0, 22)),
        activeInOverlay: Array.from(document.querySelectorAll("#pickerBody .pk-item.active"))
            .map((el) => el.textContent.slice(0, 22)),
        hovered: hovered.map((el) => {
            const name = el.id ? "#" + el.id : (el.className || el.tagName).toString().slice(0, 24);
            return name + (el.closest("#sidebarDock") ? "（常驻那一列里）" : (el.closest("#pickerOverlay") ? "（浮层抽屉里）" : "（顶条里）"));
        }),
        focused: (() => {
            const el = document.activeElement;
            if (!el || el === document.body) { return "(body)"; }
            return (el.id ? "#" + el.id : (el.className || el.tagName).toString().slice(0, 24));
        })(),
    };
`;

module.exports = async (page) => {
    const look = async (label) => {
        const r = JSON.parse(await page.eval(`return JSON.stringify((function () { ${LOOK} })());`));
        console.log(`${label}\n    active（常驻列）：${JSON.stringify(r.activeRows)}` +
            `\n    active（浮层）：${JSON.stringify(r.activeInOverlay)}` +
            `\n    :hover：${JSON.stringify(r.hovered)}` +
            `\n    DOM 焦点：${r.focused}`);
        return r;
    };
    const move = (x, y) => page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y), button: "none" });

    await page.waitReady();
    await page.sleep(900);
    // 窄窗：先点 <<< 把抽屉拉出来（宽窗下这一列本来就常驻着）
    if (await page.eval("return window.innerWidth < 900")) {
        await page.click("#browserMenuBtn");
        await page.sleep(900);
        console.log("窄窗：打开的是滑出来的抽屉（浮层那份）");
    }

    // 侧边栏里挑一行会话（有就挑会话行，没有就挑工作区行）
    const row = JSON.parse(await page.eval(`
        const el = document.querySelector("#dockBody .pk-item") || document.querySelector("#pickerBody .pk-item");
        if (!el) { return "null"; }
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent.slice(0, 22) });
    `));
    console.log("拿这一行做试验：" + JSON.stringify(row));
    const bar = JSON.parse(await page.eval(`
        const el = document.getElementById("sessionCenter") || document.querySelector("#sessionBar button");
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    `));

    await look("【起点】鼠标不在侧边栏上");
    await page.shot("hover-1-before.png");

    await move(row.x, row.y);
    await page.sleep(400);
    await look("【鼠标停在这一行上】");
    await page.shot("hover-2-on-row.png");

    await move(300, 400); // 移到对话那边
    await page.sleep(400);
    const away = await look("【鼠标移开、落到对话那边】");
    await page.shot("hover-3-away.png");

    const width = await page.eval("return window.innerWidth");
    await move(width - 30, 400); // 面板里的空白处（不是行）
    await page.sleep(400);
    await look("【鼠标停在面板空白处】");

    await move(bar.x, bar.y); // 顶条那颗按钮
    await page.sleep(400);
    await look("【鼠标停在顶条按钮上】");
    await page.shot("hover-4-topbar.png");

    await move(300, 600);
    await page.sleep(400);
    await look("【从顶条按钮移开】");

    // 键盘那套已经拆了：开着的抽屉里按方向键，不该再有灰底冒出来；Esc 还得能关
    const drawerOpen = await page.eval(`return !document.getElementById("pickerOverlay").classList.contains("hidden")`);
    if (drawerOpen) {
        await page.press("ArrowDown");
        await page.sleep(250);
        const key1 = await look("【按一下方向键下】");
        await page.press("ArrowDown");
        await page.sleep(250);
        const key2 = await look("【再按一下方向键下】");
        await page.shot("hover-5-keys.png");
        console.log(key1.activeInOverlay.length === 0 && key2.activeInOverlay.length === 0
            ? "方向键：没有选行这回事了"
            : "方向键还在选行：" + JSON.stringify([key1.activeInOverlay, key2.activeInOverlay]));
    }

    console.log("\n=== 判断 ===");
    console.log(away.activeRows.length === 0
        ? "移开之后没有行留着灰底"
        : "移开之后仍留着灰底：" + JSON.stringify(away.activeRows));

    // 鼠标点面板里的东西还好不好使：宽窗与窄窗都点「工作区」标题右边那颗加号
    // （弹出逛文件夹那层浮层，没有别的副作用）。点完那地方自己也该跟着灭。
    const browseRow = JSON.parse(await page.eval(`
        const el = document.querySelector("#dockBody .pk-section-add-btn") || document.querySelector("#pickerBody .pk-section-add-btn");
        if (!el) { return "null"; }
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, text: (el.title || "").slice(0, 18) });
    `));
    if (browseRow) {
        await move(browseRow.x, browseRow.y);
        await page.sleep(200);
        await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(browseRow.x), y: Math.round(browseRow.y), button: "left", clickCount: 1 });
        await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(browseRow.x), y: Math.round(browseRow.y), button: "left", clickCount: 1 });
        await page.sleep(1200);
        const opened = await page.eval(`return document.getElementById("pickerOverlay").className`);
        const afterClick = await look("【鼠标点过「工作区」标题那颗加号】");
        await page.shot("hover-6-click.png");
        console.log(opened.indexOf("pk-folders") >= 0 ? "点它还好使（逛文件夹那层浮层弹出来了）" : "点它没反应：" + opened);
        console.log(afterClick.activeRows.length === 0 ? "点完那行没有留着灰底" : "点完还留着灰底：" + JSON.stringify(afterClick.activeRows));

        // 点行了、只开着这层浮层：方向键 / 回车都不该有反应，Esc 还得能关
        await page.press("ArrowDown");
        await page.sleep(200);
        const arrow = await look("【浮层开着，按一下方向键下】");
        console.log(arrow.activeInOverlay.length === 0 ? "方向键：没有选行这回事了" : "方向键还在选行：" + JSON.stringify(arrow.activeInOverlay));
        await page.press("Escape");
        await page.sleep(500);
        const closed = await page.eval(`return document.getElementById("pickerOverlay").classList.contains("hidden")`);
        console.log(closed ? "Esc 还能把浮层关掉" : "Esc 关不掉了");
    }

    // 「切换模型」那层：点开、当前模型那一行得是「待应用」那个样子，点一行不报错，Esc 能关
    await page.click(".pane-status");
    await page.sleep(1000);
    const model = JSON.parse(await page.eval(`
        const rows = Array.from(document.querySelectorAll("#pickerBody .pk-model-item"));
        return JSON.stringify({
            open: !document.getElementById("pickerOverlay").classList.contains("hidden"),
            title: (document.getElementById("pickerTitle") || {}).textContent,
            rows: rows.map((r) => ({ text: r.textContent.slice(0, 20), active: r.classList.contains("active") })),
        });
    `));
    console.log("切换模型那层：" + JSON.stringify(model));
    await page.shot("hover-7-model.png");
    if (model.rows.length) {
        await page.eval(`document.querySelector("#pickerBody .pk-model-item").click(); return true;`);
        await page.sleep(400);
        const again = JSON.parse(await page.eval(`
            const rows = Array.from(document.querySelectorAll("#pickerBody .pk-model-item"));
            return JSON.stringify(rows.map((r) => r.classList.contains("active")));
        `));
        console.log("点了一下那一行之后，各行还是不是「待应用」：" + JSON.stringify(again) + "（应该跟点之前一样）");
        await page.press("Escape");
        await page.sleep(400);
        const modelClosed = await page.eval(`return document.getElementById("pickerOverlay").classList.contains("hidden")`);
        console.log(modelClosed ? "Esc 把「切换模型」那层也关掉了" : "「切换模型」那层关不掉");
    }
};

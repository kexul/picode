// @ts-nocheck
/**
 * 验「手机上左右划切会话时跳过子会话」：划过派活那个会话就是下一个主会话，
 * 不会停在它底下那个子会话上。
 *
 *   FAKEPI_THINK_MS=6000 FAKEPI_TICK_MS=40 npm run web:shot -- --width 420 --height 900 --fake-pi --script dev/swipeSkipChild.js
 *
 * 假 pi 慢一点跑，子会话才来得及在整趟划完之前一直挂着（跑完第一轮它自己会关掉）。
 * 子会话在哪儿认：跟 dev/tabaFlow.js 一个路子，看「项目与会话」里「正在对话」那几行
 *（子会话缩进一行、带 pk-open-child 那个类）。手指的动作走 CDP 的 Input.dispatchTouchEvent。
 */
module.exports = async (page) => {
    /** 「项目与会话」画在哪一块：宽窗（≥ 900px）是右边常驻那一列，窄窗才是浮层。 */
    const ROOT_EXPR = `(function () {
        const dock = document.getElementById("sidebarDock");
        return (dock && getComputedStyle(dock).display !== "none") ? "#dockBody" : "#pickerBody";
    })()`;
    const panel = () => page.eval(`
        const dock = document.getElementById("sidebarDock");
        const dockShown = !!dock && getComputedStyle(dock).display !== "none";
        return { shown: dockShown || !document.getElementById("pickerOverlay").classList.contains("hidden"), dock: dockShown };
    `);
    /** 「正在对话」那几行：叫什么、是不是子会话、是不是当前那个。 */
    const openRows = () => page.eval(`
        const root = ${ROOT_EXPR};
        return JSON.stringify(Array.from(document.querySelectorAll(root + " .pk-item.pk-open")).map((el) => {
            const t = el.querySelector(".pk-history-title");
            return {
                label: t ? t.textContent.trim().slice(0, 24) : "",
                child: el.classList.contains("pk-open-child"),
                current: el.classList.contains("pk-current") || el.classList.contains("current"),
            };
        }));
    `).then(JSON.parse);
    const until = async (what, fn, ms = 40000) => {
        const started = Date.now();
        for (;;) {
            const v = await fn();
            if (v) { return v; }
            if (Date.now() - started > ms) { throw new Error("等不到：" + what); }
            await page.sleep(200);
        }
    };
    const openPicker = async () => {
        if (!(await panel()).shown) { await page.click("#browserMenuBtn"); }
        await until("「项目与会话」打开", async () => (await panel()).shown);
    };
    const closePicker = async () => {
        const p = await panel();
        if (!p.shown) { return; }
        if (p.dock) { await page.click("#browserMenuBtn"); } else { await page.press("Escape"); }
        await until("「项目与会话」收起", async () => !(await panel()).shown);
    };

    const touch = (type, x, y) => page.cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    });
    const drag = async (x0, y0, x1, y1, steps = 8) => {
        await touch("touchStart", x0, y0);
        for (let i = 1; i <= steps; i++) {
            await touch("touchMove", x0 + (x1 - x0) * (i / steps), y0 + (y1 - y0) * (i / steps));
            await page.sleep(16);
        }
        await touch("touchEnd", x1, y1);
    };
    /** 现在看着哪个会话（露着那层壳的 id 与它最后一句用户说的话）。 */
    const look = () => page.eval(`
        const shown = Array.from(document.querySelectorAll(".session-view")).filter((v) => !v.classList.contains("off"));
        return JSON.stringify({
            active: shown.length === 1 ? shown[0].dataset.sessionId : "",
            said: (document.querySelector(".session-view:not(.off) .msg.user") || {}).innerText || "",
        });
    `).then(JSON.parse);

    await page.waitReady();
    await page.sleep(900);
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

    // A（第一个会话）：说一句
    await page.send("A 说的话");
    await page.sleep(1200);
    const a = await look();
    // B（第二个会话）：也说一句，划过去时认得出落到了它身上
    await page.click("#newSessionBtn");
    await page.sleep(900);
    await page.send("B 说的话");
    await page.sleep(1200);
    const b = await look();
    console.log(`A=…${a.active.slice(-8)}　B=…${b.active.slice(-8)}`);

    // 回到 A 派活：子会话挂在 A 底下（清单里排在 A 后面、顶条上不占格）
    await page.click('#sessionBar .sn-tab[data-idx="0"]');
    await page.sleep(600);
    await page.send("派活：看看子会话会不会被划过去");
    await openPicker();
    const spawned = await until("子会话出现在「正在对话」里", async () => {
        const rows = await openRows();
        return rows.some((r) => r.child) ? rows : null;
    });
    console.log("「正在对话」那几行：" + JSON.stringify(spawned));
    await closePicker();
    const childAt = spawned.findIndex((r) => r.child);
    const rowsOk = childAt > 0 && spawned[childAt - 1].label && !spawned[childAt - 1].child;
    if (!rowsOk) { throw new Error("子会话没排在它父会话后面，这一趟验不出跳过："); }

    // 从 A 往左划：该落在 B 上（子会话跳过），不该停在子会话那一层
    const box = JSON.parse(await page.eval(`
        const r = document.getElementById("messages").getBoundingClientRect();
        return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height });
    `));
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    await drag(cx + 60, cy, cx - 160, cy);
    await page.sleep(700);
    const landed = await look();
    const ok = landed.active === b.active;
    console.log(`${ok ? "✓" : "✗"} 从 A 往左划落在「${landed.said.trim().slice(0, 16) || "(空)"}」` +
        `（…${landed.active.slice(-8)}）${ok ? "" : "　该落在 B"}`);
    await page.shot("swipe-skip-child.png");

    // 再往回划：该回到 A 上（子会话排在 A 后面，不在这一侧）
    await drag(cx - 60, cy, cx + 160, cy);
    await page.sleep(700);
    const back = await look();
    const okBack = back.active === a.active;
    console.log(`${okBack ? "✓" : "✗"} 往右划回到「${back.said.trim().slice(0, 16) || "(空)"}」` +
        `（…${back.active.slice(-8)}）`);

    console.log(`\n页面报错：${page.pageErrors.length ? JSON.stringify(page.pageErrors.slice(0, 5)) : "无"}`);
};

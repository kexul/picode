// @ts-nocheck
/**
 * escPriority —— 验「Esc 归谁」这张表现在只有一处写（media/chat.js 的 escTopLayer）。
 *
 *   FAKEPI_THINK_MS=5000 npm run web:shot -- --fake-pi --width 1200 --height 800 --script dev/escPriority.js
 *
 * 以前这条键只靠“谁先注册监听”排先后，于是有两处打架一直没人发现：
 *   · 设置面板压根没接这条键 —— 在里面按 Esc 落到“中止正在生成的一轮”那条上，正在跑的生成被掐；
 *   · 工具耗时 / 工具两个弹窗的监听注册在中止那条之后 —— 那一按既关弹窗、又中止这一轮。
 * 另外文件搜索可以开在浮层上面，一次 Esc 以前只关浮层、搜索还留着。
 *
 * 这里逐档验：上面开着谁，Esc 就只收那一个；一层都没有时才算“中止这一轮”。
 */
module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(600);
    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };

    const esc = async () => {
        for (const type of ["keyDown", "keyUp"]) {
            await page.cdp.send("Input.dispatchKeyEvent", {
                type, key: "Escape", code: "Escape",
                windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
            });
        }
        await page.sleep(300);
    };
    const streaming = async () => (await page.eval(`return (document.getElementById("ctxIcon") || {}).dataset?.st || "";`)) === "streaming";
    const hidden = (sel) => page.eval(`const el = document.querySelector(${JSON.stringify(sel)}); return !el || el.classList.contains("hidden");`);
    const visible = (sel) => page.eval(`const el = document.querySelector(${JSON.stringify(sel)}); return !!el && !el.classList.contains("hidden");`);

    /** 跑一轮起来（假 pi 每个工具卡一会儿，够我们按键）。 */
    const startRound = async () => {
        await page.send("随便演示一下");
        for (let i = 0; i < 100; i++) {
            if (await streaming()) { return true; }
            await page.sleep(100);
        }
        return false;
    };
    const waitIdle = async () => {
        for (let i = 0; i < 200; i++) {
            if (!(await streaming())) { return; }
            await page.sleep(100);
        }
    };
    /** 右边那一列（宽窗里常驻）开着、把底下那颗按钮露出来。 */
    const openDock = async () => {
        await page.eval(`
            if (!document.body.classList.contains("dock-sidebar") && window.pichatSidebar && window.pichatSidebar.toggle) {
                window.pichatSidebar.toggle();
            }
            return true;
        `);
        await page.sleep(400);
    };

    // ---- 一、设置面板：Esc 只关设置，不中止正在跑的那一轮 ----
    check(await startRound(), "第一轮没跑起来（等不到 streaming）");
    await openDock();
    await page.eval(`document.querySelector("#dockFooter .pk-footer-settings, #pickerFooter .pk-footer-settings").click(); return true;`);
    await page.sleep(400);
    check(await visible("#settingsOverlay"), "设置面板没打开（这一条没法验）");
    await esc();
    check(await hidden("#settingsOverlay"), "设置面板开着时按 Esc 没关掉");
    check(await streaming(), "设置面板里按 Esc 把正在跑的那一轮中止了（这一条键该只收设置）");
    console.log("  一、设置面板：Esc 关设置、这一轮照旧在跑");
    await waitIdle();

    // ---- 二、工具调用耗时 / 三、工具（两个弹窗）：Esc 只关弹窗 ----
    for (const [name, btn, overlay, checkFn] of [
        ["工具调用耗时", "#dockFooter .pk-footer-stats, #pickerFooter .pk-footer-stats", "#toolStatsOverlay", () => visible("#toolStatsOverlay")],
        ["工具（工具 / 技能 / MCP）", "#dockFooter .pk-footer-env, #pickerFooter .pk-footer-env", "#envOverlay", () => visible("#envOverlay")],
    ]) {
        check(await startRound(), `${name}这一轮没跑起来`);
        await openDock();
        await page.eval(`const el = document.querySelector(${JSON.stringify(btn)}); if (el) { el.click(); } return true;`);
        await page.sleep(500);
        check(await checkFn(), `${name}弹窗没打开（这一条没法验）`);
        await esc();
        check(await hidden(overlay), `${name}弹窗开着时按 Esc 没关掉`);
        check(await streaming(), `在${name}弹窗里按 Esc 把正在跑的那一轮中止了（这一条键该只收弹窗）`);
        console.log("  " + (name === "工具调用耗时" ? "二、" : "三、") + name + "：Esc 关弹窗、这一轮照旧在跑");
        await waitIdle();
    }

    // ---- 四、搜索开在浮层上面：一下只收上面那一个 ----
    check(await startRound(), "第四轮没跑起来");
    await page.eval(`document.getElementById("ctxIcon").click(); return true;`);
    await page.sleep(500);
    check(await visible("#pickerOverlay"), "模型选择器没打开（这一条没法验）");
    // Ctrl+Shift+F 开文件搜索
    for (const type of ["keyDown", "keyUp"]) {
        await page.cdp.send("Input.dispatchKeyEvent", {
            type, key: "F", code: "KeyF", modifiers: 10 /* Ctrl+Shift */,
            windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70,
        });
    }
    await page.sleep(500);
    const searchOpen = await page.eval(`
        const el = document.getElementById("fileSearchOverlay");
        return !!el && !el.classList.contains("hidden");
    `);
    if (searchOpen) {
        await esc();
        const searchStill = await page.eval(`
            const el = document.getElementById("fileSearchOverlay");
            return !!el && !el.classList.contains("hidden");
        `);
        check(!searchStill, "搜索开在浮层上面时，一下 Esc 没收掉搜索");
        check(await visible("#pickerOverlay"), "收掉搜索的那一下把底下的浮层也一并收了");
        await esc();
        check(await hidden("#pickerOverlay"), "第二下 Esc 没把浮层收掉");
        console.log("  四、搜索叠在浮层上：第一下收搜索、第二下收浮层");
    } else {
        console.log("  四、（文件搜索没能打开，跳过了这一档）");
    }
    await waitIdle();

    // ---- 五、一层都没有：Esc 还是“中止这一轮” ----
    check(await startRound(), "第五轮没跑起来");
    await esc();
    let stopped = false;
    for (let i = 0; i < 50; i++) {
        if (!(await streaming())) { stopped = true; break; }
        await page.sleep(100);
    }
    check(stopped, "什么浮层都没开的时候按 Esc，这一轮没被中止（原来的手艺丢了）");
    console.log("  五、什么也没开着：Esc 照旧中止这一轮");

    if (problems.length) {
        console.log("");
        console.log("有问题（" + problems.length + " 条）：");
        for (const p of problems) { console.log("  ! " + p); }
        throw new Error("Esc 归属表没验过：" + problems.length + " 条");
    }
    console.log("");
    console.log("Esc 归属表：设置 / 两个弹窗 / 搜索叠浮层 / 一层都没有，四档都只收该收的那一个。");
};

// @ts-nocheck
/**
 * 验「对话在更新（开始生成 / 跑完 / 未读 / 换当前）时，常驻的项目与会话侧边栏只动『正在对话』那一格」。
 *
 * 以前这种推送一来，「项目与会话」整个面板（连下半「工作区」那一块）都被 innerHTML 清掉重画，
 * 看着就是整列闪一下。现在只重画上半那一格；下半那一格连元素都不换、滚到哪儿也不动。
 *
 *   FAKEPI_TICK_MS=60 npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/sidebarRedraw.js
 *
 * 做法：先发一条把「新建会话」那一阵（宿主重推整份面板，整块重画是应该的）走完，
 * 再把探针清零、把上下两格记成基线，第二条消息（同一个会话，不再新建）期间查：
 *   - 整块重画（#dockBody 被清空）：一次都不该有；
 *   - 下半那一格：没被清空、元素没换、滚动位置不动；
 *   - 上半那一格：该重画（行首那颗小点要跟着变成“在跑”）；
 *   - 重画过后点行还好使（行上那颗点击认的是它在列表里的第几行，见 confirmPicker）。
 */
module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(800);

    // 探针：谁把哪一格清空了（两格会被整块重画换掉，所以每帧看一眼有没有新元素要挂）
    await page.eval(`
        (function () {
            const d = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
            const get = d.get, set = d.set;
            window.__log = [];
            window.__logs = [];
            window.__base = { session: null, space: null };
            const hooked = new WeakSet();
            function hookEl(el, tag) {
                if (!el || hooked.has(el)) { return; }
                hooked.add(el);
                Object.defineProperty(el, "innerHTML", {
                    configurable: true,
                    get() { return get.call(el); },
                    set(v) {
                        window.__log.push({
                            at: Math.round(performance.now()), tag,
                            stack: String(new Error().stack).split("\\n").slice(1, 5)
                                .map((s) => s.trim().replace(/\\(.*/, "")).join(" ← "),
                        });
                        set.call(el, v);
                    },
                });
            }
            let last = "";
            let n = 0;
            function scan() {
                hookEl(document.getElementById("dockBody"), "整块");
                hookEl(document.querySelector("#dockBody .pk-session-pane"), "上半");
                hookEl(document.querySelector("#dockBody .pk-space-pane"), "下半");
            }
            function tick() {
                n++;
                scan();
                const s = document.querySelector("#dockBody .pk-session-pane");
                const w = document.querySelector("#dockBody .pk-space-pane");
                const dot = document.querySelector("#dockBody .pk-item.pk-open .pk-open-dot");
                const sig = [
                    s === window.__base.session ? "上半原格" : "上半换过",
                    w === window.__base.space ? "下半原格" : "下半换过",
                    dot ? dot.className : "没有点", w ? Math.round(w.scrollTop) : "-",
                    document.querySelectorAll("#dockBody .pk-item").length,
                ].join(" | ");
                if (sig !== last) { window.__logs.push({ at: Math.round(performance.now()), frame: n, sig }); last = sig; }
                window.__rafId = requestAnimationFrame(tick);
            }
            window.__rafId = requestAnimationFrame(tick);
            scan();
            if (!document.querySelector("#dockBody .pk-space-pane")) { throw new Error("右边那一列没画出来（窗口 ≥ 900px 才有常驻那一列）"); }
            return true;
        })();
    `);

    // 第一条：新建会话那一阵（宿主会重推整份面板，那一次整块重画是应该的）
    await page.send("你好");
    await page.sleep(5000);
    const warmup = JSON.parse(await page.eval("return JSON.stringify(window.__log);"));
    console.log("第一条消息期间（含新建会话那一阵，整块重画是应该的），右边那一列被动过的地方：");
    for (const w of warmup) { console.log(`  ${w.tag.padEnd(3)}  ${w.stack}`); }

    // 清零、把现在这两格记成基线；把下半那一格滚一点，好看出它有没有被动过
    await page.eval(`
        window.__log.length = 0;
        window.__logs.length = 0;
        window.__base.session = document.querySelector("#dockBody .pk-session-pane");
        window.__base.space = document.querySelector("#dockBody .pk-space-pane");
        document.querySelector("#dockBody .pk-space-pane").scrollTop = 40;
        return true;
    `);
    const look = "const w = document.querySelector('#dockBody .pk-space-pane');"
        + " return JSON.stringify({ scrollTop: Math.round(w.scrollTop), rows: document.querySelectorAll('#dockBody .pk-item').length, spaceRows: document.querySelectorAll('#dockBody .pk-space-pane .pk-item').length });";
    const before = await page.eval(look);
    console.log("第二条之前，下半那一格：" + before);

    const t0 = await page.eval("return Math.round(performance.now());");
    await page.send("再说一句");
    await page.sleep(6000);

    const wipes = JSON.parse(await page.eval("return JSON.stringify(window.__log);"));
    const frames = JSON.parse(await page.eval("return JSON.stringify(window.__logs);"));
    console.log("第二条消息期间，右边那一列被清空的每一次（相对发出去那一刻）：");
    for (const w of wipes) { console.log(`  ${w.tag.padEnd(3)}  [${w.at - t0}ms]  ${w.stack}`); }
    console.log("逐帧看（只记跟上一帧不一样的）：");
    for (const f of frames) { console.log(`  ${String(f.at - t0).padStart(6)}ms 帧#${String(f.frame).padStart(4)}  ${f.sig}`); }

    const whole = wipes.filter((w) => w.tag === "整块");
    if (whole.length) { throw new Error("整块重画了（对话更新不该重画整个面板）：" + JSON.stringify(whole)); }
    const space = wipes.filter((w) => w.tag === "下半");
    if (space.length) { throw new Error("下半「工作区」那一格被清空重画了：" + JSON.stringify(space)); }
    const half = wipes.filter((w) => w.tag === "上半" && /redrawOpenRowsIn/.test(w.stack));
    if (half.length === 0) { throw new Error("上半那一格一次都没重画：会话状态推送没接上？"); }
    if (!frames.some((f) => f.sig.includes("pk-open-dot running"))) {
        throw new Error("没看到行首那颗小点变成『在跑』（假模型太快？用 FAKEPI_TICK_MS=60 跑）");
    }
    if (frames.some((f) => f.sig.includes("下半换过"))) { throw new Error("下半那一格的元素被换过。"); }
    const after = await page.eval(look);
    console.log("第二条之后，下半那一格：" + after);
    if (before !== after) { throw new Error("下半那一格的内容 / 滚动变了：" + before + " → " + after); }
    console.log("\n结论：整块没动、下半那一格没动（" + before + " 原样），只有上半那一格重画了 " + half.length + " 次。");

    // 重画过后点行还好使吗：点一下当前目录那个组头（收起 / 展开），行数得跟着变
    const spaceRows = JSON.parse(before).spaceRows;
    await page.click("#dockBody .pk-space-pane .pk-item.pk-space-head");
    await page.sleep(1500);
    const collapsed = await page.eval("return document.querySelectorAll('#dockBody .pk-space-pane .pk-item').length;");
    console.log("点一下组头（收起）：组里那些行从 " + spaceRows + " 条变成 " + collapsed + " 条");
    await page.click("#dockBody .pk-space-pane .pk-item.pk-space-head");
    await page.sleep(1500);
    const expanded = await page.eval("return document.querySelectorAll('#dockBody .pk-space-pane .pk-item').length;");
    console.log("再点一下（展开）：" + expanded + " 条");
    if (collapsed >= spaceRows || expanded !== spaceRows) {
        throw new Error("点组头展开 / 收起不好使了（重画过后第几行错位？）");
    }
    await page.shot("sidebar-redraw.png");
};

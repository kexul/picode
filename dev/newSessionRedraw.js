// @ts-nocheck
/**
 * 验「开新会话时，右边常驻的项目与会话侧边栏不整块重画，展开的工作区组不掉」。
 *
 * 以前点一下顶条那颗「新会话」：宿主推来新列表，界面把整个面板（连下半「工作区」那一块）
 * 拆掉重建好几次，展开的组先塌下去、过一帧再长回来 —— 看着就是整列闪一下。
 *
 *   FAKEPI_TICK_MS=60 npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/newSessionRedraw.js
 *
 * 做法：先展开一个工作区组（下半那一格有内容），把探针清零，再点「新会话」，期间查：
 *   - 整块重画（#dockBody 被清空）：一次都不该有；
 *   - 下半那一格里展开的组：里面的会话行一根都不掉（真数据变了允许重画那一格，但不许塌）；
 *   - 上半那一格：新会话那一行加进来了、当前高亮跟着挪；
 *   - 点行还准（行上那颗点击认的是它自己那一行，不再是它在列表里的第几行）：
 *     点上半某一行切过去、点下半组里某一行开的就是那一行。
 */
module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(2500);

    // 探针：谁把哪一格清空了；每一帧下半那一格里还剩几行
    await page.eval(`
        (function () {
            const d = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
            const get = d.get, set = d.set;
            window.__log = [];
            window.__frames = [];
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
            window.__dot = null;
            let n = 0;
            function tick() {
                n++;
                hookEl(document.getElementById("dockBody"), "整块");
                hookEl(document.querySelector("#dockBody .pk-session-pane"), "上半");
                hookEl(document.querySelector("#dockBody .pk-space-pane"), "下半");
                const s = document.querySelector("#dockBody .pk-session-pane");
                const w = document.querySelector("#dockBody .pk-space-pane");
                if (s && w) {
                    window.__frames.push({
                        at: Math.round(performance.now()), frame: n,
                        open: s.querySelectorAll(".pk-item.pk-open").length,
                        groupRows: w.querySelectorAll(".pk-item.pk-group-session").length,
                        spaceRows: w.querySelectorAll(".pk-item").length,
                        openTitles: Array.prototype.map.call(s.querySelectorAll(".pk-open"), (el) => {
                            const t = el.querySelector(".pk-history-title");
                            return (el.classList.contains("current") ? "*" : "") + (t ? t.textContent : "?");
                        }).join(" / "),
                    });
                }
                window.__raf = requestAnimationFrame(tick);
            }
            window.__raf = requestAnimationFrame(tick);
            return true;
        })();
    `);

    if (!(await page.eval("return !!document.querySelector('#dockBody .pk-space-pane')"))) {
        throw new Error("右边那一列没画出来（窗口 ≥ 900px 才有常驻那一列）");
    }

    // 展开一个别的组：下半那一格有内容才看得出它有没有被推倒重来
    await page.eval(`
        const heads = document.querySelectorAll("#dockBody .pk-space-pane .pk-item.pk-space-head");
        let opened = false;
        for (const h of heads) {
            if (document.querySelectorAll("#dockBody .pk-space-pane .pk-group-session").length === 0) { h.click(); opened = true; }
        }
        return opened;
    `);
    await page.sleep(2000);

    const baseline = await page.eval("return JSON.stringify({groupRows: document.querySelectorAll('#dockBody .pk-space-pane .pk-group-session').length, open: document.querySelectorAll('#dockBody .pk-open').length, titles: Array.prototype.map.call(document.querySelectorAll('#dockBody .pk-session-pane .pk-open'), (el) => { const t = el.querySelector('.pk-history-title'); return (el.classList.contains('current') ? '*' : '') + (t ? t.textContent : '?'); })})");
    console.log("点之前，右边那一列：" + baseline);
    if (JSON.parse(baseline).groupRows === 0) { throw new Error("下半那一格一个展开的组都没有，换个目录再跑（要看它有没有塌）"); }

    await page.eval("window.__log.length = 0; window.__frames.length = 0; window.__t0 = Math.round(performance.now()); return true;");
    await page.click("#newSessionBtn");
    await page.sleep(3000);

    const log = JSON.parse(await page.eval("return JSON.stringify(window.__log)"));
    const frames = JSON.parse(await page.eval("return JSON.stringify(window.__frames)"));
    const t0 = await page.eval("return window.__t0");
    const after = JSON.parse(await page.eval("return JSON.stringify({groupRows: document.querySelectorAll('#dockBody .pk-space-pane .pk-group-session').length, open: document.querySelectorAll('#dockBody .pk-open').length, titles: Array.prototype.map.call(document.querySelectorAll('#dockBody .pk-session-pane .pk-open'), (el) => { const t = el.querySelector('.pk-history-title'); return (el.classList.contains('current') ? '*' : '') + (t ? t.textContent : '?'); })})"));

    console.log("\n点「新会话」以后，右边那一列被清空的每一次（相对点下去那一刻）：");
    for (const w of log) { console.log(`  ${w.tag.padEnd(3)} [${String(w.at - t0).padStart(5)}ms]  ${w.stack}`); }
    console.log("\n逐帧（只记跟上一帧不一样的）：");
    let prev = "";
    for (const f of frames) {
        const sig = f.open + "|" + f.groupRows + "|" + f.spaceRows + "|" + f.openTitles;
        if (sig === prev) { continue; }
        prev = sig;
        console.log(`  ${String(f.at - t0).padStart(5)}ms 帧#${String(f.frame).padStart(3)}  上半${f.open} 行  下半展开组里${f.groupRows} 行（共${f.spaceRows}）  ${f.openTitles}`);
    }
    console.log("\n点之后，右边那一列：" + JSON.stringify(after));

    const whole = log.filter((w) => w.tag === "整块");
    if (whole.length) { throw new Error("整块重画了（开新会话不该把整个面板拆掉重来）：" + JSON.stringify(whole)); }
    const base = JSON.parse(baseline);
    const minGroup = frames.reduce((m, f) => Math.min(m, f.groupRows), base.groupRows);
    if (minGroup < base.groupRows) {
        throw new Error(`下半那一格展开的组塌过：里面的会话行从 ${base.groupRows} 行掉到最少 ${minGroup} 行`);
    }
    if (after.open !== base.open + 1) { throw new Error(`上半没多出那一行：${base.open} → ${after.open}`); }
    const starred = after.titles.filter((t) => t.startsWith("*"));
    if (starred.length !== 1 || after.titles[after.titles.length - 1] !== starred[0]) {
        throw new Error("当前高亮没落在新会话那一行（新会话排在上半那一段末尾）：" + JSON.stringify(after.titles));
    }
    if (after.groupRows !== base.groupRows) { throw new Error(`下半那一格展开的组变了：${base.groupRows} → ${after.groupRows}`); }

    // 点上半那格里的第一行（原来的会话）：得切回它，高亮也跟着挪
    const oldTitle = base.titles[0].replace(/^\*/, "");
    await page.eval(`
        const rows = document.querySelectorAll("#dockBody .pk-session-pane .pk-open");
        rows[0].click();
        return true;
    `);
    await page.sleep(1200);
    const switched = await page.eval("return (document.querySelector('#dockBody .pk-session-pane .pk-open.current .pk-history-title') || {}).textContent || ''");
    console.log(`\n点上半第一行（${oldTitle}）以后，当前高亮：${switched}`);
    if (switched !== oldTitle) { throw new Error(`点上半那一行没切过去：想切 ${oldTitle}，实际 ${switched}`); }

    // 点下半那格里展开组的第二行：开的得是那一行（行上那颗点击认的是它自己那一条）
    const picked = JSON.parse(await page.eval(`
        const rows = document.querySelectorAll("#dockBody .pk-space-pane .pk-item.pk-group-session");
        if (rows.length < 2) { return JSON.stringify(null); }
        const row = rows[1];
        const title = (row.querySelector(".pk-history-title") || {}).textContent || "";
        const file = row.dataset.file || "";
        row.click();
        return JSON.stringify({ title, file });
    `));
    if (!picked || !picked.file) { throw new Error("下半那一格展开的组里不足两行，点不动（换个目录再跑）"); }
    // 开完以后那一行行尾会多一颗「已打开」（工作区里的行不再标“当前”了，认这一颗）：等它落下来
    let opened = false;
    for (let i = 0; i < 16; i++) {
        await page.sleep(500);
        opened = await page.eval(`
            const row = Array.prototype.find.call(document.querySelectorAll("#dockBody .pk-space-pane .pk-item.pk-group-session"), (r) => r.dataset.file === ${JSON.stringify(picked.file)});
            return !!(row && row.querySelector(".pk-open-tag"));
        `);
        if (opened) { break; }
    }
    console.log(`点下半组里那一行（${picked.title}）以后，它行尾那颗「已打开」露面了吗：${opened ? "露面了" : "没露面"}`);
    if (!opened) { throw new Error(`点下半那一行开的不是它（行尾没出「已打开」）：想开 ${picked.title}（${picked.file}）`); }
    // 工作区里这些行不标「当前」：它现在就是正在看的会话，照样不该有选中底色与左边那道竖条
    const marked = await page.eval(`
        const row = Array.prototype.find.call(document.querySelectorAll("#dockBody .pk-space-pane .pk-item.pk-group-session"), (r) => r.dataset.file === ${JSON.stringify(picked.file)});
        if (!row) { return { found: false }; }
        return { found: true, current: row.classList.contains("current"), before: getComputedStyle(row, "::before").content };
    `);
    console.log(`    它有没有被标成「当前」：${marked.current}（竖条 ${marked.before}）`);
    if (!marked.found || marked.current) { throw new Error("工作区里正在看的那一行不该标「当前」：" + JSON.stringify(marked)); }

    console.log("\n结论：点「新会话」整块一次没重画，下半展开的组一根手指都没动（" + base.groupRows + " 行原样），"
        + "只有上半那一格重画（多出那一行）；重画过后点上下的行都还准。");
    await page.shot("new-session-redraw.png");
};

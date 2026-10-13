// @ts-nocheck
/**
 * 验「项目与会话」面板（顶条最右边那颗 <<<）：
 * 打开 → 上半会话、下半工作区各是几行 → 两块各点一次「加载更多」是不是接着往下出 → 截图。
 *
 *   npm run web:shot -- --script dev/workspacePanel.js
 *
 * 顺带量一下点击到面板可见用了多少毫秒（面板打开不该等宿主扫磁盘）。
 */
module.exports = async (page) => {
    await page.waitReady();
    await page.eval(`
        window.__t = { click: 0, visible: 0 };
        const overlay = document.getElementById("pickerOverlay");
        new MutationObserver(function () {
            const open = !overlay.classList.contains("hidden") && overlay.classList.contains("pk-workspace");
            if (open && !window.__t.visible) { window.__t.visible = performance.now(); }
        }).observe(overlay, { attributes: true, attributeFilter: ["class"] });
        return true;
    `);

    await page.eval("window.__t.click = performance.now(); document.getElementById('browserMenuBtn').click(); return true;");
    await page.sleep(900);

    const look = () => page.eval(`
        const panes = Array.from(document.querySelectorAll("#pickerBody .pk-workspace-pane"));
        const sessions = panes.find(function (p) { return p.classList.contains("pk-session-pane"); });
        const spaces = panes.find(function (p) { return p.classList.contains("pk-space-pane"); });
        const rows = function (p) { return p ? p.querySelectorAll(".pk-item").length : -1; };
        return {
            visible: !document.getElementById("pickerOverlay").classList.contains("hidden"),
            title: (document.getElementById("pickerTitle") || {}).textContent,
            sections: Array.from(document.querySelectorAll("#pickerBody .pk-section")).map(function (s) { return s.textContent; }),
            sessions: rows(sessions),
            spaces: rows(spaces),
            spaceRows: spaces ? Array.from(spaces.querySelectorAll(".pk-item")).map(function (i) { return i.textContent.slice(0, 30); }) : [],
            sessionRows: sessions ? Array.from(sessions.querySelectorAll(".pk-item")).map(function (i) { return i.textContent.slice(0, 30); }) : [],
            loadMore: Array.from(document.querySelectorAll(".pk-loadmore")).map(function (b) { return b.textContent; }),
        };
    `);

    const first = await look();
    const t = await page.eval("return window.__t");
    console.log(`点击→面板可见：${Math.round((t.visible - t.click) * 10) / 10} 毫秒`);
    console.log(`标题：${first.title}；分节：${JSON.stringify(first.sections)}`);
    console.log(`上半「会话」${first.sessions} 行：${JSON.stringify(first.sessionRows)}`);
    console.log(`下半「工作区」${first.spaces} 行：${JSON.stringify(first.spaceRows)}`);
    console.log(`「加载更多」按钮：${JSON.stringify(first.loadMore)}`);
    await page.shot("panel-open.png");

    // 两块各点一次「加载更多」（先点下半那块的）
    for (const which of ["spaces", "sessions"]) {
        const clicked = await page.eval(`
            const want = ${which === "spaces" ? "true" : "false"};
            const pane = Array.from(document.querySelectorAll("#pickerBody .pk-workspace-pane"))
                .find(function (p) { return want === p.classList.contains("pk-space-pane"); });
            const btn = pane && pane.querySelector(".pk-loadmore");
            if (!btn) { return "没有按钮"; }
            btn.click();
            return true;
        `);
        if (clicked !== true) { console.log(`「加载更多」（${which}）：${clicked}`); continue; }
        await page.sleep(800);
        const after = await look();
        console.log(`点过「加载更多」（${which}）之后：上半 ${after.sessions} 行、下半 ${after.spaces} 行`);
    }
    await page.shot("panel-more.png");
};

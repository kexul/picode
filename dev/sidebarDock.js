// @ts-nocheck
/**
 * 验「宽窗下常驻的侧边栏」（顶条最右边那颗 <<<）。
 *
 *   npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/sidebarDock.js
 *
 * 宽窗该看到的：开页面右边就是一列（自己的容器 #sidebarDock，不当浮层、不盖对话、没有遮罩），
 * 点 <<< 收起、刷新之后还是收起（记住了），再点又展开；点面板里的行（工作区行尾那颗加号 /
 * 「工作区」标题右边那颗加号）面板不关；点标题那颗加号弹出浮层时，右边那一列照样在（内容不丢、宽度不跳）。
 * 同一趟里把视口改成手机宽再看一次：那一列整个不见，点 <<< 是原来的抽屉（有遮罩、整屏高、
 * 贴着右边、点外面收）；居中那一套（逛文件夹、设置）照旧在正中。
 */
module.exports = async (page) => {
    const LOOK = `
        const col = document.getElementById("chatColumn");
        const dock = document.getElementById("sidebarDock");
        const overlay = document.getElementById("pickerOverlay");
        const cr = col.getBoundingClientRect();
        const dr = dock.getBoundingClientRect();
        // 浮层里那块面板：抽屉（项目与会话 / 历史）该整屏高、贴着右边；其余拾取器该在正中
        const pane = document.getElementById("pickerPanel");
        const pr = pane.getBoundingClientRect();
        const row = document.querySelector("#dockBody .pk-space-pane .pk-space-add");
        return {
            vw: window.innerWidth, vh: window.innerHeight,
            bodyDocked: document.body.classList.contains("dock-sidebar"),
            dockShown: getComputedStyle(dock).display !== "none",
            dockRows: document.querySelectorAll("#dockBody .pk-item").length,
            dockTitle: (document.getElementById("dockTitle") || {}).textContent,
            dockRight: Math.round(dr.right), dockW: Math.round(dr.width),
            overlayClass: overlay.className,
            overlayOpen: !overlay.classList.contains("hidden"),
            overlayRows: document.querySelectorAll("#pickerBody .pk-item").length,
            paneLeft: Math.round(pr.left), paneRight: Math.round(pr.right),
            paneTop: Math.round(pr.top), paneBottom: Math.round(pr.bottom),
            paneRadius: getComputedStyle(pane).borderRadius,
            chatRight: Math.round(cr.right),
            dim: getComputedStyle(overlay).backgroundColor,
            menuTitle: (document.getElementById("browserMenuBtn") || {}).title,
            newRow: row ? row.title.slice(0, 24) : "(没有)",
            tabCount: document.querySelectorAll(".session-view").length,
        };
    `;
    const look = async (label) => {
        const raw = await page.eval(`const f = function () { ${LOOK} }; return JSON.stringify(f());`);
        const r = JSON.parse(raw);
        console.log(`${label}：` + JSON.stringify(r));
        return r;
    };

    await page.waitReady();
    await page.sleep(700);
    const wide1 = await look("宽窗 · 刚打开");
    await page.shot("dock-1-open.png");

    // 顶条右边缘是不是停在那一列左边（对话让出了右边那块）；两根横线是不是齐
    const barFit = await page.eval(`
        const bar = document.getElementById("sessionBar").getBoundingClientRect();
        const head = document.getElementById("dockHeader").getBoundingClientRect();
        const col = document.getElementById("chatColumn").getBoundingClientRect();
        return JSON.stringify({
            barRight: Math.round(bar.right), colRight: Math.round(col.right), barTop: Math.round(bar.top),
            barBottom: bar.bottom, headBottom: head.bottom, gap: Math.abs(bar.bottom - head.bottom),
        });
    `);
    console.log("顶条位置与对齐：" + barFit);

    await page.click("#browserMenuBtn");
    await page.sleep(400);
    const wide2 = await look("宽窗 · 点 <<< 之后（应该收起）");
    await page.shot("dock-2-collapsed.png");

    // 刷新：收起的状态该记住
    await page.eval("location.reload(); return true;");
    await page.sleep(1200);
    await page.waitReady();
    await page.sleep(700);
    const wide3 = await look("宽窗 · 刷新之后（应该还是收起）");

    await page.click("#browserMenuBtn");
    await page.sleep(700);
    const wide4 = await look("宽窗 · 再点一下（应该展开）");
    await page.shot("dock-3-expanded.png");

    // 点工作区那一行行尾的加号：在那个目录里新建会话，面板不该关
    const newSessionRow = await page.eval(`
        const row = document.querySelector("#dockBody .pk-space-pane .pk-space-add");
        if (!row) { return "没有那一行"; }
        row.click();
        return "点了：" + row.title.slice(0, 24);
    `);
    console.log("点工作区行尾那颗加号：" + newSessionRow);
    await page.sleep(2500);
    const wide5 = await look("宽窗 · 点过新建会话之后（面板应该还在）");
    await page.shot("dock-4-after-new.png");

    // 点「工作区」标题右边那颗加号（原来的「打开文件夹…」）：弹出浮层（居中、有遮罩），
    // 右边那一列内容照旧、宽度不跳
    const browse = await page.eval(`
        const row = document.querySelector("#dockBody .pk-section-add-btn");
        if (!row) { return "没有那一行"; }
        row.click();
        return "点了";
    `);
    console.log("点「工作区」标题右边的加号：" + browse);
    await page.sleep(1500);
    const wide6 = await look("宽窗 · 逛文件夹浮层开着（那一列该原样留着）");
    await page.shot("dock-5-folders.png");

    // 关掉它（点浮层外面）：那一列还是原样（这次连“回来”都不用）
    await page.eval(`
        const overlay = document.getElementById("pickerOverlay");
        overlay.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 3, clientY: 3 }));
        return true;
    `);
    await page.sleep(600);
    const wide7 = await look("宽窗 · 关掉浮层之后");
    await page.shot("dock-6-back.png");

    // 视口改成手机宽：那一列整个不见，点 <<< 是抽屉
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 760, deviceScaleFactor: 1, mobile: false });
    await page.sleep(800);
    const narrow1 = await look("窄窗 · 刚改小（应该没有那一列）");
    await page.click("#browserMenuBtn");
    await page.sleep(700);
    const narrow2 = await look("窄窗 · 点 <<< （应该是抽屉：有遮罩、盖住对话）");
    await page.shot("dock-7-narrow.png");
    await page.eval("document.getElementById('pickerOverlay').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 })); return true;");
    await page.sleep(600);
    const narrow3 = await look("窄窗 · 点外面（应该收起来）");

    // 拉回宽窗：那一列该自己回来（记忆还是“展开”）
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
    await page.sleep(1500);
    const wide8 = await look("拉回宽窗 · 应该自己回到常驻");
    await page.shot("dock-8-back-wide.png");

    // 面板头部那颗叉：在常驻这一列上它的意思是“收起”，而且该记住
    await page.click("#sidebarDock .pk-header-close");
    await page.sleep(400);
    const cross1 = await look("点那一列头上那颗叉（应该收起、并且记住）");
    await page.eval("location.reload(); return true;");
    await page.sleep(1200);
    await page.waitReady();
    await page.sleep(600);
    const cross2 = await look("点过叉之后再刷新（应该还是收起）");
    await page.click("#browserMenuBtn");
    await page.sleep(800);

    // 面板底部的「设置」：设置浮层盖在上面，右边那一列不该跟着收
    await page.click("#dockFooter .pk-footer-settings");
    await page.sleep(600);
    const settingsOpen = await page.eval(`
        const f = function () {
            const r = document.getElementById("settingsPanel").getBoundingClientRect();
            return JSON.stringify({
                settings: !document.getElementById("settingsOverlay").classList.contains("hidden"),
                settingsCentered: Math.abs(Math.round(r.left) - (window.innerWidth - Math.round(r.right))) <= 1,
                dockRows: document.querySelectorAll("#dockBody .pk-item").length,
                bodyDocked: document.body.classList.contains("dock-sidebar"),
            });
        };
        return f();
    `);
    console.log("开着设置时：" + settingsOpen);
    await page.shot("dock-9-settings.png");
    await page.click("#settingsClose");
    await page.sleep(500);
    const afterSettings = await look("关掉设置（那一列还在）");

    // 常驻开着的时候打字发送：Enter 归输入框，不归那一列（早先浮层会抢走回车）
    const beforeSend = await page.eval(`return String(document.querySelectorAll(".msg.user").length);`);
    await page.send("常驻侧边栏测试：这一条只是看看能不能发出去");
    await page.sleep(1500);
    const afterSend = await page.eval(`return String(document.querySelectorAll(".msg.user").length);`);
    const afterSendLook = await look("发过一条消息之后");
    console.log(`用户消息条数：${beforeSend} → ${afterSend}`);

    // 点一行历史会话：切过去，面板留着
    const nameBefore = await page.eval(`return (document.querySelector("#sessionName .sn-text") || {}).textContent || "";`);
    const historyClick = await page.eval(`
        const rows = Array.from(document.querySelectorAll("#dockBody .pk-history.pk-session"));
        if (!rows.length) { return "没有历史行"; }
        const row = rows[rows.length - 1];
        const label = row.textContent.slice(0, 24);
        row.click();
        return "点了：" + label;
    `);
    console.log("点历史会话那一行：" + historyClick);
    await page.sleep(2500);
    const nameAfter = await page.eval(`return (document.querySelector("#sessionName .sn-text") || {}).textContent || "";`);
    const wide9 = await look("点过历史会话之后（面板该还在）");
    console.log(`顶条会话名：${JSON.stringify(nameBefore)} → ${JSON.stringify(nameAfter)}`);
    await page.shot("dock-10-history.png");

    console.log("\n=== 判断 ===");
    // 工作区那一块的两颗「加载更多」：组里那一颗接着加会话，最底下那一颗接更多目录
    // （回来的那批要记到这一列头上：浮层那份与这份各画各的，不能记错）
    const countRows = () => page.eval(`
        return JSON.stringify({
            sessions: document.querySelectorAll("#dockBody .pk-session-pane .pk-item").length,
            spaces: document.querySelectorAll("#dockBody .pk-space-pane .pk-item").length,
        });
    `);
    const beforeMore = JSON.parse(await countRows());
    const moreClicks = [];
    moreClicks.push("组里：" + await page.eval(`
        const btn = document.querySelector("#dockBody .pk-space-pane .pk-loadmore.pk-group-more");
        if (!btn) { return "没有按钮"; }
        btn.click();
        return "点了";
    `));
    await page.sleep(1200);
    moreClicks.push("工作区列表：" + await page.eval(`
        const btns = Array.from(document.querySelectorAll("#dockBody .pk-space-pane .pk-loadmore"));
        const btn = btns.find(function (b) { return !b.classList.contains("pk-group-more"); });
        if (!btn) { return "没有按钮"; }
        btn.click();
        return "点了";
    `));
    await page.sleep(1200);
    const afterMore = JSON.parse(await countRows());
    const moreLook = await look("点过那两颗「加载更多」之后");
    console.log("「加载更多」：" + moreClicks.join("，") + "；" +
        JSON.stringify(beforeMore) + " → " + JSON.stringify(afterMore));
    await page.shot("dock-11-loadmore.png");
    const noSessionMore = await page.eval("return document.querySelectorAll('#dockBody .pk-session-pane .pk-loadmore').length");

    const checks = [
        ["宽窗刚打开就是常驻一列（不是浮层）", wide1.bodyDocked && wide1.dockShown && !wide1.overlayOpen && wide1.dockRows > 0],
        ["那一列宽 320、贴满高、贴着右边", wide1.dockW === 320 && wide1.dockRight === wide1.vw && wide1.chatRight === wide1.vw - 320],
        ["面板头与顶条那两根横线齐", JSON.parse(barFit).gap < 0.6 && JSON.parse(barFit).barRight === JSON.parse(barFit).colRight],
        ["点 <<< 收起（那一列不见、对话铺满）", !wide2.dockShown && !wide2.bodyDocked && wide2.chatRight === wide2.vw],
        ["刷新之后还是收起", !wide3.dockShown && !wide3.bodyDocked],
        ["再点 <<< 展开", wide4.dockShown && wide4.bodyDocked && wide4.dockRows > 0],
        ["点工作区行尾的加号（新建会话）后面板不关", wide5.dockShown && wide5.dockRows > 0],
        ["开别的浮层时那一列原样留着（这次它一直没走）", wide6.bodyDocked && wide6.dockShown && wide6.dockRows === wide5.dockRows && wide6.overlayOpen && wide6.overlayClass.indexOf("pk-folders") >= 0],
        ["逛文件夹那块浮层照旧在正中（抽屉那两条没把它带跑）",
            Math.abs(wide6.paneLeft - (wide6.vw - wide6.paneRight)) <= 1 && wide6.paneRadius !== "0px" && wide6.paneTop > 0],
        ["关掉浮层后那一列还是原样", wide7.dockShown && wide7.dockRows === wide6.dockRows],
        ["窄窗没有那一列", !narrow1.bodyDocked && !narrow1.dockShown],
        ["窄窗点 <<< 是抽屉（有遮罩）", narrow2.overlayOpen && !narrow2.bodyDocked && narrow2.dim !== "rgba(0, 0, 0, 0)" && narrow2.overlayRows > 0],
        ["窄窗那一块贴着右边、整屏高（不是居中的弹窗）",
            narrow2.paneRight === narrow2.vw && narrow2.paneTop === 0 && narrow2.paneBottom === narrow2.vh &&
            narrow2.paneRadius === "0px" && narrow2.paneLeft > 0],
        ["窄窗点外面收起来", !narrow3.overlayOpen],
        ["拉回宽窗自己回到常驻", wide8.dockShown && !wide8.overlayOpen && wide8.dockRows > 0],
        ["点那一列头上那颗叉 = 收起", !cross1.dockShown && !cross1.bodyDocked],
        ["点过叉之后刷新还是收起", !cross2.dockShown && !cross2.bodyDocked],
        ["开着设置时那一列不收", settingsOpen.indexOf('"settings":true') >= 0 && settingsOpen.indexOf('"bodyDocked":true') >= 0],
        ["设置那块浮层还在正中", settingsOpen.indexOf('"settingsCentered":true') >= 0],
        ["关掉设置后那一列还在", afterSettings.dockShown && afterSettings.dockRows > 0],
        ["常驻开着时回车能把消息发出去", Number(afterSend) === Number(beforeSend) + 1],
        ["发消息后那一列还在", afterSendLook.dockShown && afterSendLook.dockRows > 0],
        ["点历史会话：切过去了（顶条名字变了）、面板留着", nameAfter !== nameBefore && wide9.dockShown && wide9.dockRows > 0],
        ["工作区那一块两颗「加载更多」都能把行接上去", afterMore.spaces > beforeMore.spaces && moreLook.dockShown],
        ["「正在对话」那一半不再有「加载更多」（会话按工作区分组了）", noSessionMore === 0],
    ];
    for (const [name, pass] of checks) { console.log((pass ? "✓ " : "✗ ") + name); }
};

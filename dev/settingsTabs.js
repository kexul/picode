// @ts-nocheck
/**
 * 验设置面板按页分开：快捷键那几行单独一页（「快捷键」标签），其余在「基础」里。
 *
 *   npm run web:shot -- --script dev/settingsTabs.js --fake-pi
 *
 * 看的是：标签那一排有没有出来、两页里各有哪些行、点标签换不换页。
 */
module.exports = async (page) => {
    // 设置入口在「项目与会话」那一列的底下：宽窗里那一列常驻着，窄窗先点开菜单
    const docked = await page.eval('return document.body.classList.contains("dock-sidebar");');
    if (!docked) { await page.click("#browserMenuBtn"); }
    await page.sleep(500);
    await page.click(".pk-footer-settings");
    await page.sleep(500);

    const tabs = await page.eval(`return Array.from(document.querySelectorAll('#settingsTabBar .settings-tab'))
        .map((b) => b.textContent + (b.classList.contains('on') ? '*' : ''));`);
    const baseRows = await page.eval(`return Array.from(document.querySelectorAll('#viewOptsRoot .vo-label')).map((e) => e.textContent);`);
    console.log("  · 标签：" + JSON.stringify(tabs));
    console.log("  · 基础那页：" + JSON.stringify(baseRows));
    if (!tabs.length) { throw new Error("标签那一排没出来"); }
    await page.shot("settings-base.png");

    const keyTab = tabs.findIndex((t) => t.replace("*", "") === "快捷键");
    if (keyTab < 0) { throw new Error("没有「快捷键」这一页"); }
    await page.eval(`document.querySelectorAll('#settingsTabBar .settings-tab')[${keyTab}].click(); return true;`);
    await page.sleep(200);
    const keyRows = await page.eval(`return Array.from(document.querySelectorAll('#viewOptsRoot .vo-label')).map((e) => e.textContent);`);
    console.log("  · 快捷键那页：" + JSON.stringify(keyRows));
    await page.shot("settings-keys.png");
};

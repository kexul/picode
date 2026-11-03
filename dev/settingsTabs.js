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
    const sections = await page.eval(`return Array.from(document.querySelectorAll('#viewOptsRoot .vo-section')).map((e) => e.textContent);`);
    const baseRows = await page.eval(`return Array.from(document.querySelectorAll('#viewOptsRoot .vo-label')).map((e) => e.textContent);`);
    console.log("  · 标签：" + JSON.stringify(tabs));
    console.log("  · 小节：" + JSON.stringify(sections));
    console.log("  · 基础那页：" + JSON.stringify(baseRows));
    if (!tabs.length) { throw new Error("标签那一排没出来"); }
    // 基础页按小节分段（名字见 chatHost.ts 的 section）；微信那块的名字已经在标题上了，里面不再写一遍
    const wantSections = ["启动", "外观", "通知", "微信", "维护"];
    if (JSON.stringify(sections) !== JSON.stringify(wantSections)) {
        throw new Error("小节不对：" + JSON.stringify(sections));
    }
    const wxLabel = await page.eval(`return !!document.querySelector('#viewOptsRoot .vo-item-weixin .vo-label');`);
    if (wxLabel) { throw new Error("微信那块里又写了一遍名字"); }
    await page.shot("settings-base.png");

    // 字号那一行是个填数的框（不是滑块，也没有「跟随 VSCode」）：填 18 试一下，肉眼看字有没有变大，
    // 完事再填回原来的数，别把调试目录留成奇怪的字号
    const typeSize = (n) => page.eval(`const input = document.querySelector('#viewOptsRoot .vo-number-input');
if (!input) { return null; }
input.value = '${n}';
input.dispatchEvent(new Event('change', { bubbles: true }));
return true;`);
    const before = await page.eval(`const input = document.querySelector('#viewOptsRoot .vo-number-input');
return input ? input.value : null;`);
    if (before === null) { throw new Error("字号那一行没有输入框"); }
    const slider = await page.eval(`return !!document.querySelector('#viewOptsRoot .vo-slider, #viewOptsRoot input[type=range]');`);
    if (slider) { throw new Error("字号那一行还有滑块"); }
    const follow = await page.eval(`return Array.from(document.querySelectorAll('#viewOptsRoot button')).some((b) => b.textContent.indexOf('跟随') >= 0);`);
    if (follow) { throw new Error("字号那一行还有「跟随 VSCode」"); }
    await typeSize(18);
    await page.sleep(600);
    const size = await page.eval(`return getComputedStyle(document.body).fontSize;`);
    console.log(`  · 字号框原来是 ${before}，填 18 后正文：${size}`);
    if (size !== "18px") { throw new Error("填了 18，正文没跟着变"); }
    await page.shot("settings-base-18.png");
    await typeSize(before);
    await page.sleep(400);

    const keyTab = tabs.findIndex((t) => t.replace("*", "") === "快捷键");
    if (keyTab < 0) { throw new Error("没有「快捷键」这一页"); }
    await page.eval(`document.querySelectorAll('#settingsTabBar .settings-tab')[${keyTab}].click(); return true;`);
    await page.sleep(200);
    const keyRows = await page.eval(`return Array.from(document.querySelectorAll('#viewOptsRoot .vo-label')).map((e) => e.textContent);`);
    console.log("  · 快捷键那页：" + JSON.stringify(keyRows));
    await page.shot("settings-keys.png");
};

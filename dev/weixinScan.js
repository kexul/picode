// @ts-nocheck
/**
 * 真机扫一次二维码：打开设置 → 微信 → 点「扫码登录」，然后把窗口留着让人扫。
 *
 *   npm run web:dev                                        # 另开一个终端，起后端（会打出地址）
 *   npm run web:shot -- --url http://127.0.0.1:51999/ --headed --keep --script dev/weixinScan.js
 *
 * 跟 dev/weixinLogin.js 不同的是：这里不打假服务，走的是真微信那头的接口。
 * 扫完手机上确认、该输数字就输数字，界面会自己走到「已登录」，令牌落到
 * PICHAT_HOME 下的 weixin/account.json（调试时是 dev/.scratch/pichat/weixin/account.json）。
 */
const SCROLL_WX = `const el = document.querySelector('#viewOptsRoot .vo-item-weixin');
if (el) { el.scrollIntoView({ block: 'end' }); }
return true;`;

/** 设置浮层里那块「微信」上那颗按钮（按字认）。 */
const CLICK_WX_BUTTON = (text) => `const el = Array.from(document.querySelectorAll('#viewOptsRoot .vo-item-weixin .vo-btn')).find((b) => b.textContent === ${JSON.stringify(text)});
if (!el) { return false; }
el.click();
return true;`;

module.exports = async (page) => {
    // 设置入口在「项目与会话」那边：宽窗里那一列常驻着，窄窗先点开菜单
    const docked = await page.eval('return document.body.classList.contains("dock-sidebar");');
    if (!docked) { await page.click("#browserMenuBtn"); }
    await page.sleep(500);
    await page.click(".pk-footer-settings");
    await page.sleep(500);
    await page.waitText("微信");
    await page.eval(SCROLL_WX);
    await page.sleep(200);

    const started = (await page.eval(CLICK_WX_BUTTON("扫码登录")))
        || (await page.eval(CLICK_WX_BUTTON("重新扫码")));
    if (!started) { throw new Error("没找到「扫码登录」那颗按钮（设置里那块「微信」没出来？）"); }

    // 等二维码画出来（要真等真接口回来）
    let drawn = false;
    for (let i = 0; i < 100; i++) {
        drawn = await page.eval(`return !!document.querySelector('#viewOptsRoot .vo-wx-qr canvas');`);
        if (drawn) { break; }
        await page.sleep(150);
    }
    if (!drawn) {
        const note = await page.eval(`const el = document.querySelector('#viewOptsRoot .vo-wx-note');
return el ? el.textContent : '（那块里连说明都没有）';`);
        throw new Error(`二维码没出来：${note}`);
    }
    await page.eval(SCROLL_WX);
    await page.sleep(200);
    await page.shot("weixin-scan.png");
    console.log("");
    console.log("  → 二维码已经画在窗口里了：用手机微信扫它，扫完在手机上点确认。");
    console.log("  → 该输数字就输数字（它会跳出一个框）。");
    console.log("  → 这个窗口不关，扫完自己看它变成「已登录」。");
    console.log("");
};

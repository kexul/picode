// @ts-nocheck
/**
 * askDialog —— 验「要你打字」和「要你点是 / 否」这两种问话：现在都长在那个会话的消息流里
 * （一张卡片），不是浏览器原生那两个框（prompt / confirm），也不是盖住屏幕的浮层。
 *
 * 触发它们的扩展放在 dev/askDialogTrigger.ts：**得先把它复制到 ~/.pi/agent/extensions/** 才生效，
 * 跑完再删掉（别留在自己的全局扩展里）。它认两句话：test-prompt 出输入卡片，test-confirm 出确认卡片，
 * 答复会写成一条系统提示。
 *
 * 这条不用模型：页面 → 插件 → pi → 扩展 → 插件 → 页面，整条是真的（比假数据那套多验一段真扩展）。
 *
 *   npm run web:shot -- --script dev/askDialog.js
 */

/** 在"还在等着的那张卡片"（最后一张）里跑一段代码；返回 true（给 page.eval 用）。 */
function inLastCard(code) {
    return `(() => { const cs = document.querySelectorAll(".ask-card:not(.done)"); const c = cs[cs.length - 1]; ${code} })(); return true;`;
}

/** 等"还在等着的那张卡片"里出现某个零件。 */
async function waitPart(page, part, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
        if (await page.eval(inLastCard(`return !!c.querySelector("${part}");`))) { return; }
        if (Date.now() - t0 > timeoutMs) { throw new Error(`等 ${timeoutMs} 毫秒也没等到 ${part}`); }
        await page.sleep(200);
    }
}

module.exports = async (page) => {
    await page.waitReady();

    // ---- 输入卡片：写一句、点确定 ----
    await page.send("test-prompt");
    await waitPart(page, ".ask-input", 20000);
    await page.sleep(300);
    await page.shot("dialog-prompt.png");
    await page.eval(inLastCard(`c.querySelector(".ask-input").focus();`));
    await page.cdp.send("Input.insertText", { text: "我自己写的答案" });
    await page.eval(inLastCard(`c.querySelector(".ask-btn.primary").click();`));
    await page.sleep(1200);
    await page.shot("dialog-prompt-after.png");

    // ---- 输入卡片：直接取消 ----
    await page.send("test-prompt");
    await waitPart(page, ".ask-input", 20000);
    await page.sleep(200);
    await page.eval(inLastCard(`const bs = c.querySelectorAll(".ask-btn:not(.primary)"); bs[bs.length - 1].click();`));
    await page.sleep(1200);

    // ---- 确认卡片：肯定 ----
    await page.send("test-confirm");
    await waitPart(page, ".ask-body", 20000);
    await page.sleep(300);
    await page.shot("dialog-confirm.png");
    await page.eval(inLastCard(`c.querySelector(".ask-btn.primary").click();`));
    await page.sleep(1200);

    // ---- 确认卡片：否定 ----
    await page.send("test-confirm");
    await waitPart(page, ".ask-body", 20000);
    await page.sleep(200);
    await page.eval(inLastCard(`const bs = c.querySelectorAll(".ask-btn:not(.primary)"); bs[0].click();`));
    await page.sleep(1200);

    // ---- 普通的“选一个”（别的扩展用的那种）：点一行就该有答案 ----
    await page.send("test-select");
    await waitPart(page, ".ask-opt", 20000);
    await page.sleep(300);
    await page.shot("dialog-select.png");
    await page.eval(inLastCard(`c.querySelectorAll(".ask-opt")[1].click();`));
    await page.sleep(1200);

    console.log("---- 页面上剩下的文字 ----");
    console.log(await page.text());
};

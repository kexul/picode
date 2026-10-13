// @ts-nocheck
/**
 * askDialog —— 验「要你打字」和「要你点是 / 否」这两个框：现在是页面上自己画的（VS Code 配色），
 * 不是浏览器原生那两个（prompt / confirm）。
 *
 * 触发它们的扩展放在 dev/askDialogTrigger.ts：**得先把它复制到 ~/.pi/agent/extensions/** 才生效，
 * 跑完再删掉（别留在自己的全局扩展里）。它认两句话：test-prompt 弹输入框，test-confirm 弹确认框，
 * 答复会写成一条系统提示。
 *
 * 这条不用模型：页面 → 插件 → pi → 扩展 → 插件 → 页面，整条是真的。
 *
 *   npm run web:shot -- --script dev/askDialog.js
 */

/** 等某个选择器出现。 */
async function waitFor(page, selector, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
        if (await page.eval(`return !!document.querySelector(${JSON.stringify(selector)});`)) { return; }
        if (Date.now() - t0 > timeoutMs) { throw new Error(`等 ${timeoutMs} 毫秒也没等到 ${selector}`); }
        await page.sleep(200);
    }
}

module.exports = async (page) => {
    await page.waitReady();

    // ---- 输入框：写一句、点确定 ----
    await page.send("test-prompt");
    await waitFor(page, ".pichat-dlg-input", 20000);
    await page.sleep(300);
    await page.shot("dialog-prompt.png");
    await page.eval(`document.querySelector(".pichat-dlg-input").focus(); return true;`);
    await page.cdp.send("Input.insertText", { text: "我自己写的答案" });
    await page.eval(`document.querySelector(".pichat-dlg-actions button.primary").click(); return true;`);
    await page.sleep(1200);
    await page.shot("dialog-prompt-after.png");

    // ---- 输入框：直接取消 ----
    await page.send("test-prompt");
    await waitFor(page, ".pichat-dlg-input", 20000);
    await page.sleep(200);
    await page.eval(`document.querySelector(".pichat-dlg-actions button:not(.primary)").click(); return true;`);
    await page.sleep(1200);

    // ---- 确认框：确定 ----
    await page.send("test-confirm");
    await waitFor(page, ".pichat-dlg-msg", 20000);
    await page.sleep(300);
    await page.shot("dialog-confirm.png");
    await page.eval(`document.querySelector(".pichat-dlg-actions button.primary").click(); return true;`);
    await page.sleep(1200);

    // ---- 确认框：取消 ----
    await page.send("test-confirm");
    await waitFor(page, ".pichat-dlg-msg", 20000);
    await page.sleep(200);
    await page.eval(`document.querySelector(".pichat-dlg-actions button:not(.primary)").click(); return true;`);
    await page.sleep(1200);

    // ---- 普通的“选一个”（别的扩展用的那种）：点一行就该有答案 ----
    await page.send("test-select");
    await waitFor(page, ".pk-item", 20000);
    await page.sleep(300);
    await page.shot("dialog-select.png");
    await page.eval(`document.querySelectorAll(".pk-item")[1].click(); return true;`);
    await page.sleep(1200);

    console.log("---- 页面上剩下的文字 ----");
    console.log(await page.text());
};

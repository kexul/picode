// @ts-nocheck
/**
 * askQuestion —— 验「ask_choice 这个工具能把问题弹到界面上、用户点/勾/写之后答案回到模型手里」。
 *
 * 这条是整条真路（工具、协议、浮层、回话文件全是真的）：
 *   真模型 → 真 pi（插件给它 -e 了 ask-bridge-<版本>.ts）→ stderr 暗号 → 真后端
 *   → 页面弹问话浮层 → 你在这里点 → 后端写回话文件 → 扩展读到 → 工具结果 → 模型接着说。
 * 只有"模型"是真的，所以慢；跑一次能验完单选 / 多选 / 自己写三条路。
 *
 *   npm run web:shot -- --script dev/askQuestion.js
 * 图落在 dev/shots/。
 */

/** 等问话浮层的选项行出来（看 DOM，别用文字等 —— 自己发出去的话里可能就有那几个字）。 */
async function waitRows(page, least, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
        const n = await page.eval(`return document.querySelectorAll(".pk-item").length;`);
        if (n >= least) { return n; }
        if (Date.now() - t0 > timeoutMs) { throw new Error(`等 ${timeoutMs} 毫秒也没等到问话浮层（现在 ${n} 行）`); }
        await page.sleep(200);
    }
}

module.exports = async (page) => {
    await page.waitReady();

    // 一、单选：点一行就是答案
    await page.send("用 ask_choice 问我：选 A 还是 B？options 就写 [\"A\",\"B\"]，recommended 写 1。等我选。");
    await waitRows(page, 2, 180000);
    await page.sleep(400);
    await page.shot("ask-single.png");
    await page.eval(`document.querySelectorAll(".pk-item")[0].click(); return true;`);
    await page.sleep(3000);
    await page.shot("ask-single-after.png");

    // 二、多选：勾两项，按「确定」
    await page.send("再用 ask_choice 问我：哪几项要？multi 写 true，options 写 [\"甲\",\"乙\",\"丙\"]，recommended 写 [1,3]。");
    await waitRows(page, 3, 180000);
    await page.sleep(400);
    await page.shot("ask-multi.png");
    await page.eval(`const rows = document.querySelectorAll(".pk-item"); rows[0].click(); rows[2].click(); return true;`);
    await page.sleep(300);
    await page.shot("ask-multi-checked.png");
    await page.eval(`document.querySelector("#pickerFooter button.primary").click(); return true;`);
    await page.sleep(3000);
    await page.shot("ask-multi-after.png");

    // 三、自己写：在底下那行写字，按「确定」
    await page.send("再用 ask_choice 问我：选 A 还是 B？options 写 [\"A\",\"B\"]。这回我不勾，我打算自己写。");
    await waitRows(page, 2, 180000);
    await page.sleep(400);
    await page.eval(`document.getElementById("pickerInput").focus(); return true;`);
    await page.cdp.send("Input.insertText", { text: "都不选，我要 C" });
    await page.sleep(200);
    await page.shot("ask-written.png");
    await page.press("Enter");
    await page.sleep(3000);
    await page.shot("ask-written-after.png");

    // 四、按 Esc 关掉：模型收到的应该是“用户把问题关了、没作答”
    await page.send("再问我一次同样的问题（options 写 [\"A\",\"B\"]），这回我要把它关掉。");
    await waitRows(page, 2, 180000);
    await page.sleep(300);
    await page.press("Escape");
    await page.sleep(3000);
    await page.shot("ask-cancel.png");

    console.log("---- 页面上剩下的文字 ----");
    console.log(await page.text());
};

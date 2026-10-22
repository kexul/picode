// @ts-nocheck
/**
 * killedTool —— 验「一轮跑到一半 pi 进程没了」时，界面不再留一颗一直转圈的标签。
 *
 * 用假模型演这个场景（dev/fakePi.js 里那句话带「假装被杀」）：先真起一条 bash，然后进程直接
 * 退出、不报结束。后端在 pi 进程退出时发一条 toolsInterrupted（见 src/sessionRuntime.ts），
 * 界面把那颗标签收掉（见 media/chat.js 的 settleInterruptedTools）——标签还在、提示框里写着
 * 「这一轮被中断，没有结果」，只是不再转圈、「正在跑」那行也不再挂着它。
 *
 *   npm run web:shot -- --fake-pi --send "假装被杀" --script dev/killedTool.js
 * 图落在 dev/shots/。
 */

const PROBE = `
    const line = document.querySelector(".tool-running");
    return document.querySelectorAll(".tool.running").length
        + " 颗转圈 | 正在跑那行：" + (line ? JSON.stringify(line.innerText) : "（没有）");
`;

module.exports = async (page) => {
    await page.waitReady();
    await page.send("假装被杀");
    // 进程退出前：那颗标签应该正在转圈（验的是下面那一下真把它收掉了）
    await page.sleep(700);
    console.log("进程退出前：" + await page.eval(PROBE));
    await page.shot("killed-before.png");
    // 等 pi 死掉、后端把话说完
    await page.sleep(3000);
    console.log("进程退出后：" + await page.eval(PROBE));
    console.log("页面上的话：" + (await page.eval("return document.body.innerText")).split("\n")
        .filter((t) => t.includes("pi 进程") || t.includes("中断")).join(" / "));
    await page.shot("killed-after.png");

    // 鼠标停到那颗标签上：提示框里应该写着「这一轮被中断，没有结果」
    await page.eval(`
        const tag = Array.from(document.querySelectorAll(".tool")).find((e) => e.innerText.includes("bash"));
        if (tag) { tag.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })); }
        return true;
    `);
    await page.sleep(500);
    console.log("提示框：" + await page.eval(`
        const tip = document.querySelector(".tag-tip");
        return tip && !tip.classList.contains("hidden") ? JSON.stringify(tip.innerText) : "（没弹出来）";
    `));
    await page.shot("killed-tip.png");
};

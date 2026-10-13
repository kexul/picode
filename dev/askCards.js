// @ts-nocheck
/**
 * askCards —— 验「问话卡片长在消息流里」（假数据，不调真模型）。
 *
 * 假 pi 照剧本演：模型调 ask_choice（走真协议：工具调用 → stderr 暗号 → 回话文件 → 工具结果），
 * 以及扩展在中间问用户（extension_ui_request：确认 / 输入 / 选一个）。
 * 卡片该长在那条 ask_choice 工具行下面；单选点一行就走，多选勾完按「确定」，答完卡片定住、
 * 选中的那几行留着高亮（见 dev/README.md）。
 *
 *   npm run web:shot -- --fake-pi --script dev/askCards.js
 * 图落在 dev/shots/。
 */

/** 等消息流里出现第 least 张还等着作答的卡片。 */
async function waitCards(page, least, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
        const n = await page.eval(`return document.querySelectorAll(".ask-card:not(.done)").length;`);
        if (n >= least) { return n; }
        if (Date.now() - t0 > timeoutMs) {
            throw new Error(`等 ${timeoutMs} 毫秒也没等到第 ${least} 张问话卡片（现在 ${n} 张）`);
        }
        await page.sleep(200);
    }
}

/** 等答完的卡片凑够 least 张（答完卡片留在流里，加 .done）。 */
async function waitDone(page, least, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
        const n = await page.eval(`return document.querySelectorAll(".ask-card.done").length;`);
        if (n >= least) { return n; }
        if (Date.now() - t0 > timeoutMs) {
            throw new Error(`等 ${timeoutMs} 毫秒也没等到第 ${least} 张答完的卡片（现在 ${n} 张）`);
        }
        await page.sleep(200);
    }
}

/** 在"还在等着的那张卡片"（最后一张）里跑一段代码。 */
function inLastCard(code) {
    return `(() => { const cs = document.querySelectorAll(".ask-card:not(.done)"); const c = cs[cs.length - 1]; ${code} })(); return true;`;
}

module.exports = async (page) => {
    await page.waitReady();

    // 一、单选：点一行就是答案
    await page.send("问单选");
    await waitCards(page, 1, 30000);
    await page.sleep(300);
    await page.shot("ask-card-single.png");
    await page.eval(inLastCard(`c.querySelectorAll(".ask-opt")[0].click();`));
    await waitDone(page, 1, 20000);
    await page.sleep(1200);
    await page.shot("ask-card-single-done.png");

    // 二、多选：勾两项，按「确定」
    await page.send("问多选");
    await waitCards(page, 1, 30000);
    await page.sleep(300);
    await page.shot("ask-card-multi.png");
    await page.eval(inLastCard(`const o = c.querySelectorAll(".ask-opt"); o[0].click(); o[2].click();`));
    await page.sleep(200);
    await page.shot("ask-card-multi-checked.png");
    await page.eval(inLastCard(`c.querySelector(".ask-btn.primary").click();`));
    await waitDone(page, 2, 20000);
    await page.sleep(1200);
    await page.shot("ask-card-multi-done.png");

    // 三、自己写：底下那行写字，回车交回去
    await page.send("问单选");
    await waitCards(page, 1, 30000);
    await page.sleep(300);
    await page.eval(inLastCard(`c.querySelector(".ask-input").focus();`));
    await page.cdp.send("Input.insertText", { text: "都不选，我要 C" });
    await page.sleep(200);
    await page.shot("ask-card-typed.png");
    await page.press("Enter");
    await waitDone(page, 3, 20000);
    await page.sleep(1200);
    await page.shot("ask-card-typed-done.png");

    // 四、没答就按“停止生成”（输入框角上那颗）：这一轮被停 → 模型收到「用户没作答」
    await page.send("问单选");
    await waitCards(page, 1, 30000);
    await page.sleep(300);
    await page.click("#stopBtn");
    await waitDone(page, 4, 30000);
    await page.sleep(1200);
    await page.shot("ask-card-stopped.png");

    // 五、扩展问的确认：是 / 否
    await page.send("问确认");
    await waitCards(page, 1, 30000);
    await page.sleep(300);
    await page.shot("ask-card-confirm.png");
    await page.eval(inLastCard(`c.querySelector(".ask-btn.primary").click();`));
    await waitDone(page, 5, 20000);
    await page.sleep(1200);
    await page.shot("ask-card-confirm-done.png");

    // 六、扩展问的输入：改一改再确定
    await page.send("问输入");
    await waitCards(page, 1, 30000);
    await page.sleep(300);
    await page.shot("ask-card-prompt.png");
    await page.eval(inLastCard(`const i = c.querySelector(".ask-input"); i.focus(); i.select();`));
    await page.cdp.send("Input.insertText", { text: "新名字" });
    await page.sleep(150);
    await page.eval(inLastCard(`c.querySelector(".ask-btn.primary").click();`));
    await waitDone(page, 6, 20000);
    await page.sleep(1200);
    await page.shot("ask-card-prompt-done.png");

    // 七、扩展问的选一个：点一行就是答案
    await page.send("问选项");
    await waitCards(page, 1, 30000);
    await page.sleep(300);
    await page.shot("ask-card-select.png");
    await page.eval(inLastCard(`c.querySelectorAll(".ask-opt")[1].click();`));
    await waitDone(page, 7, 20000);
    await page.sleep(1200);
    await page.shot("ask-card-select-done.png");

    // 八、问话还等着的时候刷新页面：重画把卡片抹掉了，宿主得把它补发回来
    await page.send("问单选");
    await waitCards(page, 1, 30000);
    await page.sleep(300);
    await page.cdp.send("Page.reload");
    await page.sleep(1500);
    await page.waitReady();
    await waitCards(page, 1, 30000);
    await page.sleep(300);
    await page.shot("ask-card-reload.png");
    await page.eval(inLastCard(`c.querySelectorAll(".ask-opt")[1].click();`));
    await waitDone(page, 1, 20000);
    await page.sleep(1200);
    await page.shot("ask-card-reload-done.png");

    console.log("---- 页面上剩下的文字 ----");
    console.log(await page.text());
};

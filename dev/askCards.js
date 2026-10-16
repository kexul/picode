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

/** 一条检查：不对就当场报错（末尾那些图是给人看的，这里是给机器看的）。 */
function check(what, ok, detail) {
    if (ok) { console.log("  ✓ " + what); return; }
    throw new Error("✗ " + what + (detail ? "：" + detail : ""));
}

/** 在"还在等着的那张卡片"（最后一张）里取一个值（写 `return …`）。 */
function lastCardValue(code) {
    return `const cs = document.querySelectorAll(".ask-card:not(.done)"); const c = cs[cs.length - 1];
        if (!c) { return "(没有还在等的卡片)"; } ${code}`;
}

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

/** 在"还在等着的那张卡片"里用真鼠标点一个元素（真点会落焦点，`el.click()` 不会）。 */
async function clickInLastCard(page, selector) {
    const box = await page.eval(lastCardValue(`
        const el = c.querySelector(${JSON.stringify(selector)});
        if (!el) { return "(没有这个元素)"; }
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    `));
    if (box === "(没有这个元素)") { throw new Error("卡片里没有这个元素：" + selector); }
    const { x, y } = JSON.parse(box);
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

module.exports = async (page) => {
    await page.waitReady();

    // 一、单选：点一行就是答案（先把光标摆进"自己写"那行再点：点选项答的那一种不该把光标搬走）
    await page.send("问单选");
    await waitCards(page, 1, 30000);
    await page.sleep(300);
    await page.shot("ask-card-single.png");
    await page.eval(inLastCard(`c.querySelector(".ask-input").focus();`));
    await clickInLastCard(page, ".ask-opt");
    await waitDone(page, 1, 20000);
    check("点选项答的不把光标搬到下面那个输入框里",
        (await page.eval(`return document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "";`)) !== "input",
        String(await page.eval(`return document.activeElement && (document.activeElement.id || document.activeElement.className);`)));
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
    // 那行输入框得写明 enterkeyhint：手机键盘上那颗键才是"回车"，不会被当成"下一项"把光标挪走
    check("「自己写」那行写着 enterkeyhint（手机键盘那颗键是回车）",
        (await page.eval(lastCardValue(`const i = c.querySelector(".ask-input"); return i ? i.getAttribute("enterkeyhint") : "(没有输入行)";`))) === "enter",
        String(await page.eval(lastCardValue(`const i = c.querySelector(".ask-input"); return i && i.getAttribute("enterkeyhint");`))));
    await page.cdp.send("Input.insertText", { text: "都不选，我要 C" });
    await page.sleep(200);
    await page.shot("ask-card-typed.png");
    await page.press("Enter");
    await waitDone(page, 3, 20000);
    // 交出去之后：光标落在下面那个输入框里（接着就能打字；手机上键盘也跟着留着）
    check("回车交出去之后光标落到下面那个输入框里",
        (await page.eval(`return document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "";`)) === "input",
        String(await page.eval(`return document.activeElement && (document.activeElement.id || document.activeElement.className);`)));
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
    check("输入卡片那行也写着 enterkeyhint",
        (await page.eval(lastCardValue(`const i = c.querySelector(".ask-input"); return i ? i.getAttribute("enterkeyhint") : "(没有输入行)";`))) === "enter",
        String(await page.eval(lastCardValue(`const i = c.querySelector(".ask-input"); return i && i.getAttribute("enterkeyhint");`))));
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

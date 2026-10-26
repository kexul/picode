// @ts-nocheck
/**
 * tps —— 验输入框底下那颗胶囊最右边那格「生成速度（t/s）」。
 *
 * 数以前是界面自己拿收到的增量估的：只有正文算进去，思考与工具参数一个字都没传（见
 * src/sessionRuntime.ts 的 DETAIL_PREVIEW_CHARS），计时窗口又是整个回合（跑工具的时间也摊进
 * 分母），所以带思考、带工具的回合这个数会低一大截。现在数在后端算（正文 + 思考 + 工具参数，
 * 只算模型真在吐字的那段时间），界面只把收到的一个数写出来。
 *
 * 这个脚本验两件事：
 *   1. 界面收到 { type: "tps", value } 就写那个数，收到 value: null 就清空
 *      （真数据不容易凑准，这部分直接往页面里投消息，跟后端推的是同一种）；
 *   2. 真跑一轮（假 pi，秒回、只是慢一点）：跑的过程中那个数就出来了、落在正常范围里
 *      （不是几百上千那种离谱的数，也不是 0 附近），跑完之后冻住不再变。
 *
 *   FAKEPI_TICK_MS=40 npm run web:shot -- --fake-pi --script dev/tps.js
 *
 * 图落在 dev/shots/。假 pi 的整段剧本在一条 assistant 消息里（真 pi 是一轮里好几次模型调用），
 * 所以「跑工具的时间不算进分母」这一条在这里验不到，只能等真会话看。
 */

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };

    /** 胶囊最右边那格写了什么（没有就是空串）。 */
    const tpsText = () => page.eval(`
        const el = document.querySelector("#ctxIcon .ci-tps");
        return el ? el.textContent.trim() : "<里面没有 .ci-tps>";
    `);
    const post = (messages) => page.eval(
        `for (const m of ${JSON.stringify(messages)}) { window.postMessage(m, "*"); } return true;`);
    /** 那格里的数字（"42.5 t/s" → 42.5）；没有数就是 undefined。 */
    const tpsValue = async () => {
        const text = await tpsText();
        const m = /^([\d.]+) t\/s$/.exec(text);
        return m ? Number(m[1]) : undefined;
    };

    // ---- 一、界面照抄后端给的那个数 ----
    await post([{ type: "tps", value: 42.5 }]);
    await page.sleep(200);
    let text = await tpsText();
    check(text === "42.5 t/s", `投一个 42.5 过去，胶囊右边写的却是 ${JSON.stringify(text)}`);
    await page.shot("tps-ui.png");

    await post([{ type: "tps", value: null }]);
    await page.sleep(200);
    text = await tpsText();
    check(text === "", `投一个 null 过去，胶囊右边没清空：${JSON.stringify(text)}`);

    // ---- 二、真跑一轮（假 pi）：跑的时候就有数，跑完冻住 ----
    await page.send("随便说点什么");
    let live;
    for (let i = 0; i < 100; i++) {
        live = await tpsValue();
        if (typeof live === "number") { break; }
        await page.sleep(100);
    }
    check(typeof live === "number", "这一轮跑起来之后胶囊右边一直没出数");
    if (typeof live === "number") {
        check(live > 5 && live < 500, `跑的过程中那个数离谱：${live} t/s`);
        await page.shot("tps-live.png");
    }

    // 等这一轮跑完（胶囊状态回到 idle），再读两次：应当有数，而且两次一样
    for (let i = 0; i < 200; i++) {
        const state = await page.eval(`return document.getElementById("ctxIcon").dataset.st;`);
        if (state === "idle") { break; }
        await page.sleep(100);
    }
    const first = await tpsValue();
    await page.sleep(600);
    const second = await tpsValue();
    check(typeof first === "number", "跑完了胶囊右边反而是空的（这一轮的数应当留着）");
    check(first === second, `跑完之后那个数还在变：${first} → ${second}`);
    await page.shot("tps-done.png");

    // 刷新页面：界面重建后靠会话列表把数补回来（跟模型名、用量百分比一样）
    await page.eval("location.reload(); return true;");
    await page.waitReady();
    let restored;
    for (let i = 0; i < 50; i++) {
        restored = await tpsValue();
        if (typeof restored === "number") { break; }
        await page.sleep(200);
    }
    check(restored === first, `刷新后那颗数没补回来：跑完是 ${first}，刷新后是 ${restored}`);
    await page.shot("tps-reload.png");

    console.log("");
    console.log("跑的时候：" + (typeof live === "number" ? live + " t/s" : "（没出数）")
        + "；跑完了：" + (typeof first === "number" ? first + " t/s" : "（空的）")
        + "；刷新后：" + (typeof restored === "number" ? restored + " t/s" : "（空的）"));
    if (problems.length) {
        console.log("");
        console.log("有问题（" + problems.length + " 条）：");
        for (const p of problems) { console.log("  ! " + p); }
        throw new Error("t/s 那格没验过：" + problems.length + " 条");
    }
    console.log("t/s 那格都对上了。");
};

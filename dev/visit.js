// @ts-nocheck
/**
 * visit —— 自动跑一遍界面并截图：开浏览器 → 打开页面 → 按动作点 → 截图存到 dev/shots/。
 *
 *   npm run web:shot                                       打开页面、等会话起来、截一张图
 *   npm run web:shot -- --send "你好" --wait "你好" --shot reply.png
 *   npm run web:shot -- --url http://127.0.0.1:51999/       连一个已经开着的服务（npm run web:dev）
 *   npm run web:shot -- --headed --keep                    显示窗口、跑完不关，自己接着点
 *   npm run web:shot -- --script dev/myFlow.js             用脚本描述复杂流程
 *
 * 默认自己起一个调试后端（dev/harness.js），跑完就收摊；给了 --url 就只驱动浏览器，不动后端。
 * 每一步都会打印一行，最后打印截图路径 —— 这些图片可以直接打开看。
 */
const fs = require("fs");
const path = require("path");
const { createHarness } = require("./harness.js");
const { openPage } = require("./cdp.js");
const { parseArgs, usage } = require("./options.js");

async function runAction(page, action) {
    const { kind, value } = action;
    if (kind === "sleep" || kind === "wait-ms") {
        console.log(`  · 等 ${value} 毫秒`);
        await page.sleep(Number(value));
        return;
    }
    if (kind === "send") {
        console.log(`  · 发送：${value}`);
        await page.send(value);
        return;
    }
    if (kind === "click") {
        console.log(`  · 点击：${value}`);
        await page.click(value);
        return;
    }
    if (kind === "eval") {
        const result = await page.eval(`return (${value})`);
        console.log(`  · 页面脚本结果：${JSON.stringify(result)}`);
        return;
    }
    if (kind === "wait") {
        console.log(`  · 等页面出现：${value}`);
        await page.waitText(value);
        return;
    }
    if (kind === "wait-answer") {
        console.log("  · 等模型的回复" + (value ? `（要包含：${value}）` : ""));
        await page.waitAnswer(value);
        return;
    }
    if (kind === "shot") {
        const file = await page.shot(value);
        console.log(`  · 截图：${file}`);
        return;
    }
    throw new Error(`不认识的动作：${kind}`);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(usage()); return; }

    let harness;
    let url = options.url;
    if (url) {
        console.log("用已经开着的服务：" + url);
    } else {
        harness = createHarness(options);
        url = await harness.start();
        console.log("起了调试后端：" + url);
    }

    const open = await openPage({
        url,
        headed: options.headed,
        keep: options.keep,
        chrome: options.chrome,
        width: options.width,
        height: options.height,
        timeoutMs: options.timeoutMs,
        shotDir: options.shotDir ? path.resolve(options.shotDir) : undefined,
    });
    const { page } = open;
    console.log("浏览器：" + open.browser + (options.headed ? "" : "（无头）"));

    const shots = [];
    try {
        if (options.skipReady) {
            // 只等输入框出来：用来复现"刚打开就发消息"这类启动时序问题
            for (let i = 0; i < 100; i++) {
                if (await page.eval("return !!document.getElementById('input')")) { break; }
                await page.sleep(100);
            }
            console.log("  · 界面已就绪（--skip-ready：不等会话就绪）");
        } else {
            await page.waitReady();
            console.log("  · 界面已就绪");
        }

        if (options.script) {
            const scriptPath = path.resolve(options.script);
            console.log("  · 跑脚本：" + scriptPath);
            const script = require(scriptPath);
            if (typeof script !== "function") { throw new Error("脚本文件要写成 module.exports = async (page) => { … }。"); }
            // 给脚本配上截图记录：脚本里调 page.shot 时会自己存文件，这里只负责把它记下来
            const originalShot = page.shot.bind(page);
            page.shot = async (name) => { const file = await originalShot(name); shots.push(file); return file; };
            await script(page);
        } else {
            for (const action of options.actions) {
                if (action.kind === "shot") {
                    const file = await page.shot(action.value);
                    shots.push(file);
                    console.log(`  · 截图：${file}`);
                    continue;
                }
                await runAction(page, action);
            }
            if (options.actions.length === 0 || !options.actions.some((a) => a.kind === "shot")) {
                const file = await page.shot(options.actions.length === 0 ? "loaded.png" : "last.png");
                shots.push(file);
                console.log(`  · 截图：${file}`);
            }
        }
        // 页面上报的错（异常 / console.error）集中打一下：界面出问题时不用再开 devtools
        const errs = page.pageErrors || [];
        if (errs.length) {
            console.log("");
            console.log("页面报错（" + errs.length + " 条）：");
            for (const e of errs.slice(0, 10)) { console.log("  ! " + e); }
        }
        console.log("");
        console.log("完成。截图：" + (shots.length ? shots.join("  ") : "（这次没截图）"));
    } finally {
        if (options.keep) {
            console.log("按 --keep：浏览器留着不关，自己接着点。结束时按 Ctrl+C 退出。");
        } else {
            await open.close();
        }
        if (harness) { await harness.stop(); }
    }
}

main().catch((err) => {
    console.error("\n出错了：" + (err?.message || err));
    process.exit(1);
});

// @ts-nocheck
/**
 * browserHost —— 常驻的调试后端：真插件代码 + 真 pi 会话 + 网页服务，等你用浏览器打开。
 *
 *   npm run web:dev                 起服务，地址打在屏幕上
 *   npm run web:dev -- --theme dark 深色界面
 *   npm run web:dev -- --open       起完顺手用系统默认浏览器打开
 *
 * 浏览器里看到的就是真界面、真会话（跟装了插件以后在浏览器里看到的一样），
 * 只是少了 VS Code 那一圈外壳（diff 编辑器、符号跳转这些验不到）。
 * 按 Ctrl+C 退出，退出时会一并杀掉调试起的 pi 进程。
 *
 * 想让它自己开浏览器、点几下、截图，用 dev/visit.js（npm run web:shot）。
 */
/* eslint-disable no-console */
const { spawn } = require("child_process");
const { createHarness } = require("./harness.js");
const { parseArgs, usage } = require("./options.js");

/** 用系统默认浏览器打开地址（纯为方便，打不开也不影响：地址已经打在屏幕上了）。 */
function openInDefaultBrowser(url) {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try { spawn(command, args, { detached: true, stdio: "ignore" }).unref(); } catch { /* 打不开算了 */ }
}

async function main() {
    const options = parseArgs(process.argv.slice(2), { actions: false });
    if (options.help) { console.log(usage()); return; }

    const harness = createHarness(options);
    const url = await harness.start();

    console.log("");
    console.log("  界面地址：" + url);
    console.log("  会话目录：" + harness.cwd + "（调试专用，动不到插件仓库）");
    console.log("  模型：" + (options.model || "跟随 pi 自己的配置"));
    console.log("  停止：Ctrl+C");
    console.log("");
    if (options.open) { openInDefaultBrowser(url); }

    const stop = async (signal) => {
        console.log(`\n收到 ${signal}，收摊（停网页服务、杀 pi 进程）…`);
        await harness.stop();
        process.exit(0);
    };
    process.on("SIGINT", () => { void stop("SIGINT"); });
    process.on("SIGTERM", () => { void stop("SIGTERM"); });
}

main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
});

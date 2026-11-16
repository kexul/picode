// @ts-nocheck
/**
 * apkBuild —— 验手机设置画面里那颗「打包并安装新版」背后的三条口（见 src/apkBuild.ts）：
 *
 *   npm run compile && node dev/apkBuild.js
 *
 * 手机那边就四步：`POST /apk/build` 叫它打 → 隔一会儿 `GET /apk/build` 问进度 →
 * 打好了 `GET /apk` 把包拉下来 → 交给系统安装器。所以这条脚本盯的是：
 *
 *   1. 没源码的机器上 `canBuild:false` 加一句人话（装的是插件包的电脑不能打包）；
 *   2. POST 一下真的起了打包，回报 running；正在打的时候再 POST 不会起第二份
 *      （两个 gradle 同时写一个 build 目录会互相踩）；
 *   3. 打到 ok，手边那个包在、大小对得上，版本号（`-PapkVersionCode`）跟着抬了
 *      —— 手机安装器靠这个认得出是升级；
 *   4. `GET /apk` 发出去的字节跟磁盘上那个包一模一样，认 Range（断了下半截能接着下）；
 *   5. 别的方子（POST /apk）405，还没打好的机器上 GET /apk 是一句人话的 404。
 *
 * 这条会真跑一次 gradle（几十秒，机器上没装 SDK / gradle 时自动跳过打包那几步，
 * 只验“编不了”那一路）：其余全是真的 —— 真后端、真网页服务。
 */
const fs = require("fs");
const path = require("path");

const { createHarness, SCRATCH_DIR } = require("./harness.js");
const outServer = path.resolve(__dirname, "..", "out", "server");
const { createApkBuilder } = require(path.join(outServer, "apkBuild.js"));

const APK_FILE = path.resolve(__dirname, "..", "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const META_FILE = path.resolve(__dirname, "..", "android", "app", "build", "outputs", "apk", "debug", "output-metadata.json");

let failed = 0;
function ok(text) { console.log("  ✔ " + text); }
function bad(text) { console.log("  ✘ " + text); failed += 1; }
function check(cond, text) { (cond ? ok : bad)(text); }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 那个包这会儿的版本号（gradle 打完写的 output-metadata.json）。 */
function versionCodeNow() {
    try {
        return JSON.parse(fs.readFileSync(META_FILE, "utf8")).elements[0].versionCode;
    } catch {
        return 0;
    }
}

async function main() {
    // 一、没源码的机器（就是装了插件包那种）：编不了，但得说清为什么
    const bare = createApkBuilder(path.join(SCRATCH_DIR, "apk-build-no-src"));
    const bareStatus = bare.status();
    check(bareStatus.canBuild === false, "没有 android/ 源码时不谎称能打包");
    check(/android/.test(bareStatus.reason || ""), `理由说的是缺 android/ 源码（${bareStatus.reason}）`);
    check(bare.status().state === "idle", "没打过时 state 是 idle");
    check(bare.start().state === "idle", "编不了的时候 POST 也不会硬起");
    check(bare.apkFile() === undefined, "手边没有包时 apkFile 是 undefined（GET /apk 会回 404）");

    // 二、真后端那三条口
    const harness = createHarness({ fakePi: true, port: 0, log: () => {} });
    try {
        const base = await harness.start();
        const status = async () => (await fetch(base + "/apk/build")).json();

        const before = await status();
        const beforeVersion = versionCodeNow();
        check(before.canBuild === true, "从仓库起的后端：canBuild 是 true");

        if (!before.canBuild) {
            console.log("  （这台机器上打包不了：" + before.reason + "，后面几项跳过）");
        } else {
            const started = await (await fetch(base + "/apk/build", { method: "POST" })).json();
            check(started.state === "running", "POST 一下就真的开始打了");
            const again = await (await fetch(base + "/apk/build", { method: "POST" })).json();
            check(again.state === "running" && again.startedAt === started.startedAt,
                "正在打的时候再 POST 不会起第二份（还是同一轮）");

            let now = again;
            const deadline = Date.now() + 5 * 60 * 1000;
            while (now.state === "running" && Date.now() < deadline) {
                await sleep(1000);
                now = await status();
            }
            check(now.state === "ok", `打完了（state=${now.state}${now.error ? "：" + now.error : ""}）`);
            check(!!now.apk && now.apk.size > 1024 * 1024, `手边有个包（${now.apk ? now.apk.size : 0} 字节）`);
            check(versionCodeNow() > beforeVersion,
                `版本号抬了（${beforeVersion} → ${versionCodeNow()}），安装器认得出是升级`);
            check(/^1\.0\.\d{12}$/.test(
                (() => { try { return JSON.parse(fs.readFileSync(META_FILE, "utf8")).elements[0].versionName; } catch { return ""; } })()),
                "版本名是那个按时间戳来的（1.0.yyyyMMddHHmm）");

            // 三、把包发出去：字节一模一样，认 Range
            const resp = await fetch(base + "/apk");
            const body = Buffer.from(await resp.arrayBuffer());
            const onDisk = fs.readFileSync(APK_FILE);
            check(resp.status === 200, "GET /apk 给 200");
            check(resp.headers.get("content-type") === "application/vnd.android.package-archive", "内容类型是安卓包");
            check(Number(resp.headers.get("content-length")) === onDisk.length, "Content-Length 就是那个包的大小");
            check(body.length === onDisk.length && body.equals(onDisk), "发出来的字节跟磁盘上那个包一模一样");
            check(body.subarray(0, 2).toString("latin1") === "PK", "确实是安装包（zip 那种 PK 开头）");

            const part = await fetch(base + "/apk", { headers: { Range: "bytes=100-199" } });
            const partBody = Buffer.from(await part.arrayBuffer());
            check(part.status === 206, "带 Range 给 206");
            check(part.headers.get("content-range") === `bytes 100-199/${onDisk.length}`, "Content-Range 说的是要的那一段");
            check(partBody.length === 100 && partBody.equals(onDisk.subarray(100, 200)), "那一段就是原文里那一段");

            const post = await fetch(base + "/apk", { method: "POST" });
            check(post.status === 405, "POST /apk 给 405");
        }
    } finally {
        await harness.stop();
    }

    console.log(failed === 0 ? "\n全部通过。" : `\n${failed} 条没过。`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});

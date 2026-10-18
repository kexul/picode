#!/usr/bin/env node
/**
 * 编手机 App 的安装包：android/ 那个 Gradle 工程，产物是 android/app/build/outputs/apk/debug/app-debug.apk。
 *
 * 为什么要这个脚本：这台机器上 gradle 没装在 PATH 里（Gradle 的发行版躺在 ~/.gradle/wrapper/dists 里），
 * 安卓 SDK 的位置也不一定在环境变量里。这两件事都在这儿找一遍，找不到就用人话告诉你怎么补。
 *
 *   npm run android:apk              编调试包
 *   npm run android:apk -- release   编正式包（自己签名那种，这里不管签名，只会编出未签名的）
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = path.join(root, "android");
const HOME = process.env.USERPROFILE || process.env.HOME || "";

/** 找安卓 SDK：环境变量优先，其次是几个常见装法。 */
function findSdk() {
    const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (fromEnv && fs.existsSync(fromEnv)) { return fromEnv; }
    const guesses = [
        path.join(HOME, "AppData/Local/Android/Sdk"),
        path.join(HOME, "Library/Android/sdk"),
        path.join(HOME, "Android/Sdk"),
        "/usr/lib/android-sdk",
    ];
    return guesses.find((p) => fs.existsSync(path.join(p, "platforms"))) || "";
}

function versionKey(name) {
    return name.split(".").map((x) => Number(x) || 0);
}

function compareVersion(a, b) {
    const x = versionKey(a);
    const y = versionKey(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d !== 0) { return d; }
    }
    return 0;
}

/** 找 gradle：PATH 里的最省事；没有就从 ~/.gradle/wrapper/dists 里挑版本号最大的那个。 */
function findGradle() {
    const onPath = process.platform === "win32"
        ? spawnSync("where", ["gradle"], { encoding: "utf8" })
        : spawnSync("which", ["gradle"], { encoding: "utf8" });
    if (onPath.status === 0 && onPath.stdout.trim()) {
        return onPath.stdout.trim().split(/\r?\n/)[0];
    }
    const dists = path.join(HOME, ".gradle/wrapper/dists");
    if (!fs.existsSync(dists)) { return ""; }
    const versions = fs.readdirSync(dists)
        .map((dir) => ({ dir, version: (dir.match(/^gradle-([\d.]+)-/) || [])[1] }))
        .filter((x) => x.version)
        .sort((a, b) => compareVersion(b.version, a.version));
    for (const { dir, version } of versions) {
        for (const hash of fs.readdirSync(path.join(dists, dir))) {
            const bin = path.join(dists, dir, hash, `gradle-${version}`,
                "bin", process.platform === "win32" ? "gradle.bat" : "gradle");
            if (fs.existsSync(bin)) { return bin; }
        }
    }
    return "";
}

const sdk = findSdk();
if (!sdk) {
    console.error("找不到安卓 SDK。装一个 Android SDK（或 Android Studio），然后把 ANDROID_HOME 指到它上面。");
    process.exit(1);
}
const gradle = findGradle();
if (!gradle) {
    console.error("找不到 gradle。装一个（`gradle` 在 PATH 里），或者跑一次任意安卓工程的 ./gradlew 让缓存下来。");
    process.exit(1);
}

// local.properties 是机器上的路径，不该进版本库：每次现写
fs.writeFileSync(path.join(androidDir, "local.properties"),
    `sdk.dir=${sdk.replace(/\\/g, "/")}\n`, "utf8");

import net from "node:net";

const task = process.argv[2] === "release" ? "assembleRelease" : "assembleDebug";
console.log(`用 ${gradle}`);
console.log(`安卓 SDK：${sdk}`);
console.log(`编：${task}`);

const args = ["-p", androidDir, task, "--console=plain"];

/**
 * ~/.gradle/gradle.properties 里常常写着代理（systemProp.https.proxyHost 一类）。
 * 代理没开着的时候，gradle 会把每个依赖都当成“下不到”，报一句“插件找不到”就完事 ——
 * 跟真实的网络问题看不出区别。所以先探一下那个代理，没开着就明说，并让这次编译绕开它。
 */
function proxyNote() {
    const file = path.join(HOME, ".gradle/gradle.properties");
    if (!fs.existsSync(file)) { return null; }
    const text = fs.readFileSync(file, "utf8");
    const host = (text.match(/^systemProp\.\w+\.proxyHost=(.+)$/m) || [])[1];
    const port = (text.match(/^systemProp\.\w+\.proxyPort=(\d+)$/m) || [])[1];
    if (!host || !port) { return null; }
    const socket = new net.Socket();
    return new Promise((resolve) => {
        let settled = false;
        const finish = (alive) => {
            if (settled) { return; }
            settled = true;
            socket.destroy();
            resolve(alive ? null : `${host.trim()}:${port}`);
        };
        socket.setTimeout(1200, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.connect(Number(port), host.trim());
    });
}

const deadProxy = await proxyNote();
if (deadProxy) {
    console.log(`（gradle 配置里那个代理 ${deadProxy} 连不上，这次绕开它）`);
    args.push("-Dhttp.nonProxyHosts=*", "-Dhttps.nonProxyHosts=*");
}

const env = { ...process.env, ANDROID_HOME: sdk };
// Windows 上那个 gradle 是 .bat：不经过 shell 就跑不起来（新版 Node 直接拦掉 .bat）
const run = /\.(bat|cmd)$/i.test(gradle)
    ? spawnSync(`"${gradle}" ${args.map((a) => `"${a}"`).join(" ")}`, { stdio: "inherit", shell: true, env })
    : spawnSync(gradle, args, { stdio: "inherit", env });
if (run.status !== 0) { process.exit(run.status || 1); }

const apk = path.join(androidDir, "app/build/outputs/apk", task === "assembleDebug" ? "debug" : "release",
    task === "assembleDebug" ? "app-debug.apk" : "app-release-unsigned.apk");
if (fs.existsSync(apk)) {
    const bytes = fs.statSync(apk).size;
    const size = bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    console.log(`\n好了：${apk}（${size}）`);
    console.log("传到手机上装（或者在连着手机时：adb install -r " + apk + "）");
} else {
    console.log("编完了，但没在预想的位置找到安装包，去 android/app/build/outputs/apk/ 底下看看。");
}

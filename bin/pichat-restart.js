#!/usr/bin/env node
/*
 * pichat-restart —— 帮后端重启它自己的一只小手（设置浮层里那颗「编译并重启」）。
 *
 * 后端没法自己重启自己：发起重启的那个进程一退，就没人编译、也没人把后端起回来了。
 * 所以后端只写一份「重启计划」JSON（见 src/serverRestart.ts），再用 detached 的方式起这个
 * 小进程去办，自己按正常流程收摊退出。这里做的事，按顺序：
 *
 *   1. 等老后端退干净（它收到重启请求后会停网页服务、杀掉所有 pi 进程）；
 *      15 秒还没退就直接杀掉（那种情况下它自己那几个 pi 进程可能留在那儿）。
 *   2. 拉最新代码（git pull --ff-only）；拉不到就拿现在的代码接着编，日志里记一笔。
 *   3. 在仓库里编译：`npm run build` + `npm i -g .`（装全局 pichat 命令）。
 *      成功才起后端；失败就停在这儿（后端不再起来，修好后再手工起一次）。
 *   4. 照老后端当初的命令行把后端起回来：同一个端口、同一个会话目录 —— 页面在原来的
 *      地址上一连就回来了。新后端放后台跑。
 *   5. 顺手把桌面那个小窗口与安卓 app 也编了（有源码、有工具才编；编不过只记日志，
 *      不影响已经跑着的后端）。
 *
 * 编译输出与新后端的日志都追加到计划里的 logFile（默认 ~/.pi/pichat/restart.log）：
 * 重启之后原来那个终端就看不到什么了，出问题只能看这份日志。
 *
 * 用法（只在插件内部用）：node pichat-restart.js <plan.json>
 */
"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");

/** 等老后端自己退干净的时限；超了就硬杀。 */
const EXIT_WAIT_MS = 15000;
/** 硬杀之后再等一会儿的时限。 */
const KILL_WAIT_MS = 5000;
/** 新后端起来后看它还活着没有之前，等这么久（起来了就不会马上退）。 */
const START_VERIFY_MS = 2000;

/** 拉代码最多等多久：网络不通时 git 会磨很久，不能让它把重启卡在这儿。 */
const PULL_TIMEOUT_MS = 120000;
/** 顺手编桌面窗口 / 安卓 app 最多等多久（gradle 第一次跑可能要几分钟）。 */
const CLIENT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 追加一行到日志（写不进去也不能把重启带崩：那就没有日志，但活还得干）。 */
function openLog(file) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        return fs.openSync(file, "a");
    } catch {
        return undefined;
    }
}

function write(fd, text) {
    if (fd === undefined) { return; }
    try { fs.writeSync(fd, `[${stamp()}] ${text}\n`); } catch { /* 写不进去算了 */ }
}

/** 这个进程号还活着没有（在 Windows 上也管用：process.kill 的 0 号信号只是探活）。 */
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** 等这个进程退掉；到点还没退就返回 false。 */
async function waitForExit(pid, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (!alive(pid)) { return true; }
        await sleep(100);
    }
    return !alive(pid);
}

/** 硬杀（不走后端的收摊流程：只杀它自己，别把我们自己连带杀了）。 */
function forceKill(pid) {
    if (process.platform === "win32") {
        try { cp.spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true }); } catch { /* 没了就算了 */ }
        return;
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* 没了就算了 */ }
}

/**
 * 跑一条命令（整条给出来，不分参数：Windows 上 npm 是 npm.cmd，只有经 shell 才找得到，
 * shell 也不会替我们给参数加引号），输出直接进日志。
 * @param timeoutMs 到点还没跑完就当失败（拉代码跟网络有关，可能一直挂着）
 * @returns 退出码（起不来、超时、信号结束这些都算失败，返回 -1）
 */
function run(commandLine, cwd, logFd, timeoutMs) {
    return new Promise((resolve) => {
        write(logFd, `$ ${commandLine}`);
        let child;
        const finish = (code) => { resolve(code); };
        try {
            child = cp.spawn(commandLine, {
                cwd,
                shell: true,
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },   // 不让人在后台悄悄等着输密码
                stdio: ["ignore", logFd === undefined ? "ignore" : logFd, logFd === undefined ? "ignore" : logFd],
                windowsHide: true,
            });
        } catch (err) {
            write(logFd, `起不来：${err && err.message ? err.message : err}`);
            finish(-1);
            return;
        }
        let timer;
        if (timeoutMs) {
            timer = setTimeout(() => {
                write(logFd, `跑了 ${Math.round(timeoutMs / 1000)} 秒还没完，掐掉（当失败）。`);
                try { child.kill(); } catch { /* 已经没了 */ }
                finish(-1);
            }, timeoutMs);
        }
        child.on("error", (err) => {
            write(logFd, `起不来：${err && err.message ? err.message : err}`);
            if (timer) { clearTimeout(timer); }
            finish(-1);
        });
        child.on("close", (code) => {
            if (timer) { clearTimeout(timer); }
            finish(code === 0 ? 0 : (code ?? -1));
        });
    });
}

/**
 * 拉最新代码。拉不到（没网、本地有改动、有分叉、没装 git）不算失败：拿现在的代码接着编就是了，
 * 只是日志里记一笔。--ff-only 是有意的：后台跑的命令不能自作主张替人生成一次合并提交。
 * 代码在后台跑，所以也不许它停下来等人输密码（见 run 里的 GIT_TERMINAL_PROMPT）。
 */
async function pullLatest(repoDir, logFd) {
    const code = await run("git pull --ff-only --no-edit", repoDir, logFd, PULL_TIMEOUT_MS);
    if (code !== 0) {
        write(logFd, "拉取失败（没网 / 本地有改动 / 分叉 / 没装 git 都算），照现在的代码接着编。");
        return;
    }
    write(logFd, "已拉最新代码。");
}

/** 照老命令行把后端起回来（后台跑，输出进日志）。 */
function startBackend(plan, logFd) {
    write(logFd, "起后端：" + [plan.execPath, ...plan.argv].join(" "));
    const child = cp.spawn(plan.execPath, plan.argv, {
        cwd: plan.startCwd,
        detached: true,
        stdio: ["ignore", logFd === undefined ? "ignore" : logFd, logFd === undefined ? "ignore" : logFd],
        windowsHide: true,
    });
    child.unref();
    return child;
}

/**
 * 顺手把桌面那个小窗口和安卓 app 也编了。
 *
 * 这两样不是后端的一部分：编不过只在日志里记一笔，后端照常起来（跟 build.bat 那边一个规矩：
 * 缺工具 / 缺 SDK 都是跳过，不是失败）。没装 .NET SDK、没装 JDK、没配 Android SDK 都会走到这里。
 */
async function buildClients(plan, logFd) {
    // 桌面小窗口：WPF，只有 Windows 有
    const desktopProject = path.join(plan.repoDir, "desktop", "PiChat", "PiChat.csproj");
    if (process.platform === "win32" && fs.existsSync(desktopProject)) {
        const code = await run(`dotnet build -c Release "${desktopProject}"`, plan.repoDir, logFd, CLIENT_BUILD_TIMEOUT_MS);
        write(logFd, code === 0
            ? "桌面小窗口编好了（desktop/PiChat/bin/Release/net8.0-windows/PiChat.exe）。"
            : "桌面小窗口没编过（不影响后端；多半是没装 .NET 8 SDK）。");
    }

    // 安卓 app：跟着仓库里那个 Gradle 工程编（要 JDK 17+ 和 Android SDK）
    const androidDir = path.join(plan.repoDir, "android");
    const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
    if (fs.existsSync(path.join(androidDir, gradlew))) {
        const code = await run(`"${path.join(androidDir, gradlew)}" assembleDebug`, androidDir, logFd, CLIENT_BUILD_TIMEOUT_MS);
        write(logFd, code === 0
            ? "安卓 app 编好了（android/app/build/outputs/apk/debug/app-debug.apk）。"
            : "安卓 app 没编过（不影响后端；多半是没装 JDK / Android SDK，见 android/README.md）。");
    }
}

async function main() {
    const planPath = process.argv[2];
    if (!planPath) {
        console.error("用法：pichat-restart.js <plan.json>");
        process.exitCode = 2;
        return;
    }
    let plan;
    try {
        plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    } catch (err) {
        console.error(`读不到重启计划（${planPath}）：${err && err.message ? err.message : err}`);
        process.exitCode = 1;
        return;
    }

    const logFd = openLog(plan.logFile);
    write(logFd, "");
    write(logFd, `===== 重启后端：${plan.url}（进程 ${plan.pid}） =====`);
    write(logFd, `仓库：${plan.repoDir}`);

    // 1. 等老后端退干净
    if (!(await waitForExit(plan.pid, EXIT_WAIT_MS))) {
        write(logFd, `老后端 ${Math.round(EXIT_WAIT_MS / 1000)} 秒还没退，直接杀掉（它自己那几个 pi 进程可能留在那儿）。`);
        forceKill(plan.pid);
        await waitForExit(plan.pid, KILL_WAIT_MS);
    }
    write(logFd, "老后端已停。");

    // 2. 拉最新代码（拉不到就拿现在的代码接着走，只记一笔）
    await pullLatest(plan.repoDir, logFd);

    // 3. 编译（顺带装一次全局命令）
    if (await run("npm run build", plan.repoDir, logFd) !== 0) {
        write(logFd, "编译失败，后端没有重新起来。修好以后再在终端里敲一次 pichat。");
        process.exitCode = 1;
        return;
    }
    if (await run("npm i -g .", plan.repoDir, logFd) !== 0) {
        write(logFd, "装全局 pichat 命令失败，后端没有重新起来。修好以后再在终端里敲一次 pichat。");
        process.exitCode = 1;
        return;
    }

    // 4. 照老命令行起回来
    const child = startBackend(plan, logFd);
    await sleep(START_VERIFY_MS);
    if (alive(child.pid)) {
        write(logFd, `后端已在后台重新起来：${plan.url}（进程 ${child.pid}）`);
    } else {
        write(logFd, "后端起来就退了，看上面几行的输出。");
        process.exitCode = 1;
        return;
    }

    // 5. 顺手编桌面那个小窗口与安卓 app（编不过只记一笔，后端已经在跑了）
    await buildClients(plan, logFd);
}

main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
});

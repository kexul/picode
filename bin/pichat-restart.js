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
 *   2. 在仓库里编译、再把 pichat 装成全局命令：`npm run build` + `npm i -g .`。
 *      两步都成功才起后端；哪一步失败就停在这儿（后端不再起来，修好后再手工敲 pichat）。
 *   3. 照老后端当初的命令行把后端起回来：同一个端口、同一个会话目录 —— 页面在原来的
 *      地址上一连就回来了。新后端放后台跑，自己退出。
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
 * @returns 退出码（起不来、信号结束这些都算失败，返回 -1）
 */
function run(commandLine, cwd, logFd) {
    return new Promise((resolve) => {
        write(logFd, `$ ${commandLine}`);
        let child;
        try {
            child = cp.spawn(commandLine, {
                cwd,
                shell: true,
                stdio: ["ignore", logFd === undefined ? "ignore" : logFd, logFd === undefined ? "ignore" : logFd],
                windowsHide: true,
            });
        } catch (err) {
            write(logFd, `起不来：${err && err.message ? err.message : err}`);
            resolve(-1);
            return;
        }
        child.on("error", (err) => {
            write(logFd, `起不来：${err && err.message ? err.message : err}`);
            resolve(-1);
        });
        child.on("close", (code) => { resolve(code === 0 ? 0 : (code ?? -1)); });
    });
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

    // 2. 编译 + 装全局命令
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

    // 3. 照老命令行起回来
    const child = startBackend(plan, logFd);
    await sleep(START_VERIFY_MS);
    if (alive(child.pid)) {
        write(logFd, `后端已在后台重新起来：${plan.url}（进程 ${child.pid}）`);
    } else {
        write(logFd, "后端起来就退了，看上面几行的输出。");
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
});

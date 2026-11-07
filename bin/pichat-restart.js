#!/usr/bin/env node
/*
 * pichat-restart —— 「编译并重启」（设置浮层里那颗按钮）的两半。
 *
 * 后端没法自己重启自己：发起重启的那个进程一退，就没人编译、也没人把后端起回来了。
 * 所以后端只写一份「重启计划」JSON（见 src/serverRestart.ts）就照常收摊退出，
 * 剩下的事由这儿的两个角色之一接着办：
 *
 * A. 终端里起的后端（`pichat` 在终端里敲的）：这个文件里的 supervise() 就是留在终端里的那一层，
 *    真正的后端是它的子进程。子进程要重启时写下计划就退，这一层接着拉代码、编译
 *    （输出直接打在终端里），再在同一个终端里把后端起回来 —— 终端里照样有新后端的输出，
 *    Ctrl+C 照样能停。见下面 supervise()。
 *
 * B. 没有终端的那一头（exe 起的、后台跑着的）：后端用 detached 的方式起这个文件自己的 main()，
 *    由它办完、把新后端放到后台。这一步按顺序：
 *
 *   1. 等老后端退干净（它收到重启请求后会停网页服务、杀掉所有 pi 进程）；
 *      15 秒还没退就直接杀掉（那种情况下它自己那几个 pi 进程可能留在那儿）。
 *   2. 拉最新代码（git pull --ff-only）；拉不到就拿现在的代码接着编，日志里记一笔。
 *   3. 在仓库里编译后端：`npm run build` + `npm i -g .`（装全局 pichat 命令）。
 *      成功才起后端；失败就停在这儿（后端不再起来，修好后再手工起一次）。
 *   4. 照老后端当初的命令行把后端起回来：同一个端口、同一个会话目录 —— 页面在原来的
 *      地址上一连就回来了。新后端放后台跑。
 *
 * B 这一头的编译输出与新后端的日志都追加到计划里的 logFile（默认 ~/.pi/pichat/restart.log）：
 * 那一头没有终端可看，出问题只能看这份日志。
 *
 * 用法（只在插件 / 仓库脚本内部用）：
 *   node pichat-restart.js <plan.json>     B 那一头（见 bin/pichat.js）
 *   require("./pichat-restart.js").supervise()   A 那一头（见 bin/pichat.js）
 */
"use strict";

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** 等老后端自己退干净的时限；超了就硬杀。 */
const EXIT_WAIT_MS = 15000;
/** 硬杀之后再等一会儿的时限。 */
const KILL_WAIT_MS = 5000;
/** 新后端起来后看它还活着没有之前，等这么久（起来了就不会马上退）。 */
const START_VERIFY_MS = 2000;

/** 拉代码最多等多久：网络不通时 git 会磨很久，不能让它把重启卡在这儿。 */
const PULL_TIMEOUT_MS = 120000;

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
 * 在终端里等着后端的那一层：你在终端敲的 pichat 就是它，真正的后端是它的子进程。
 *
 * 它自己不开端口、不接页面，只盯着子进程：
 *   - 子进程照常跑完（Ctrl+C、出错）就跟着退，退出码照抄；
 *   - 子进程写下重启计划（环境变量 PICHAT_RESTART_PLAN 指的那个文件）再退，就是有人点了
 *     「编译并重启」：那就拉代码、在这儿编译（输出直接打在这个终端里），然后照计划里的
 *     命令行把后端起回来 —— 还在这个终端里，输出与 Ctrl+C 都跟原来一样。
 *
 * 编译没成就不起了（修好以后再敲一次 pichat），省得一直转圈。
 */
async function supervise() {
    /** 计划文件由这一层挑地方、用环境变量告诉子进程；同一个后端几次重启共用一个。 */
    const planPath = path.join(os.tmpdir(), `pichat-restart-${process.pid}.json`);
    /** 下一次起来照这份（第一次起来就是命令行原样）。 */
    let spec = { argv: [process.argv[1], ...process.argv.slice(2)], cwd: process.cwd() };
    let child;
    let stopping = false;

    // Ctrl+C：两边都收到了，让子进程自己收摊（它会停网页服务、杀掉 pi 进程），
    // 这一层等它退完再退；正赶上编译（手上没有子进程）就直接退。
    const onSignal = () => {
        if (child) { stopping = true; return; }
        process.exit(130);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    for (;;) {
        child = cp.spawn(process.execPath, spec.argv, {
            cwd: spec.cwd,
            stdio: "inherit",
            env: { ...process.env, PICHAT_SUPERVISED: "1", PICHAT_RESTART_PLAN: planPath },
        });
        const pid = child.pid;
        const code = await new Promise((resolve) => {
            let settled = false;
            const done = (value) => { if (!settled) { settled = true; resolve(value); } };
            child.on("error", (err) => {
                write(1, `后端起不来：${err && err.message ? err.message : err}`);
                done(-1);
            });
            // 信号结束（Windows 上被外面杀掉之类）当失败，别让人以为它是自己退的
            child.on("close", (exitCode, signal) => done(exitCode ?? (signal ? -1 : 0)));
        });
        child = undefined;
        if (stopping) { process.exit(code); }

        const plan = readPlan(planPath);
        // 计划里记着是哪个进程要的重启：没有这份、或者不是刚退的这个，就说明没人要重启
        if (!plan || plan.pid !== pid) { process.exit(code); }

        write(1, "");
        write(1, "这个终端里的后端要重启：先拉最新代码，再在这儿重新编译，编完把它起回来。");
        await pullLatest(plan.repoDir, 1);
        if (await run("npm run build", plan.repoDir, 1) !== 0) {
            write(1, "编译失败，后端没有重新起来。修好以后再在这个终端里敲一次 pichat。");
            process.exit(1);
        }
        if (await run("npm i -g .", plan.repoDir, 1) !== 0) {
            write(1, "装全局 pichat 命令失败，后端没有重新起来。修好以后再在这个终端里敲一次 pichat。");
            process.exit(1);
        }
        spec = { argv: plan.argv, cwd: plan.startCwd || process.cwd() };
    }
}

/** 读走子进程留下的重启计划（读不到、读坏了都当没有）。 */
function readPlan(file) {
    try {
        const plan = JSON.parse(fs.readFileSync(file, "utf8"));
        fs.rmSync(file, { force: true });
        return plan;
    } catch {
        return undefined;
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
}

module.exports = { supervise };

if (require.main === module) {
    main().catch((err) => {
        console.error(err && err.stack ? err.stack : err);
        process.exitCode = 1;
    });
}

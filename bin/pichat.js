#!/usr/bin/env node
/*
 * pichat —— 独立后端的命令行入口。
 *
 * 装法：在插件仓库里先 `npm run build`，再 `npm i -g .`，之后在任意目录敲 `pichat`
 * 就能起一个后端（会话跑在哪个目录由 --cwd 决定，默认就是你敲命令时所在的目录）。
 *
 * 分两种情况：
 *   - 在终端里敲的（stdout 是终端）：这个进程留在终端里当“看着后端的那一层”，
 *     真正的后端是它的子进程，参数原样交给子进程。设置浮层里那颗「编译并重启」点下去时，
 *     子进程写下计划就退，这一层在同一个终端里拉代码、编译、再把它起回来 ——
 *     终端里照样有新后端的输出，Ctrl+C 照样能停（见 pichat-restart.js 的 supervise）。
 *   - 不是终端（管道、别的程序起的）：直接把活交给编译好的 out/server/serverMain.js。
 * 子进程那边带着 PICHAT_SUPERVISED=1，走到这一分支时不再套一层。
 *
 * 没编译过时给一句人话，而不是甩一个 MODULE_NOT_FOUND 的栈。
 */
"use strict";

const path = require("path");

const entry = path.join(__dirname, "..", "out", "server", "serverMain.js");

/** 后端本身：把参数交给 serverMain.js，出事了把栈打出来。 */
function runBackend() {
    try {
        const mod = require(entry);
        // 真正的活都在 serverMain.js 里；这里把当前进程的收尾交代清楚，免得出错时静默退出。
        Promise.resolve(mod.main()).catch((err) => {
            console.error(err && err.stack ? err.stack : err);
            process.exit(1);
        });
    } catch (err) {
        if (err && err.code === "MODULE_NOT_FOUND" && String(err.message).includes("serverMain")) {
            console.error("还没编译：先在这个仓库里跑 `npm run build`，再试一次。");
            console.error(`（找不到 ${entry}）`);
            process.exit(1);
        }
        throw err;
    }
}

if (process.env.PICHAT_SUPERVISED === "1" || !process.stdout.isTTY) {
    runBackend();
} else {
    require("./pichat-restart.js").supervise().catch((err) => {
        console.error(err && err.stack ? err.stack : err);
        process.exit(1);
    });
}

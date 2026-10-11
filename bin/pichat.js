#!/usr/bin/env node
/*
 * pichat —— 独立后端的命令行入口。
 *
 * 装法：在插件仓库里先 `npm run build`，再 `npm i -g .`，之后在任意目录敲 `pichat`
 * 就能起一个后端（会话跑在哪个目录由 --cwd 决定，默认就是你敲命令时所在的目录）。
 *
 * 这个文件只负责把参数交给编译好的 out/server/serverMain.js；真正的活都在那边。
 * 没编译过时给一句人话，而不是甩一个 MODULE_NOT_FOUND 的栈。
 */
"use strict";

const path = require("path");

const entry = path.join(__dirname, "..", "out", "server", "serverMain.js");

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

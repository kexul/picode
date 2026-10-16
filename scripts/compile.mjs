/*
 * 把三份编译配置一次跑完，外加桌面截图那支小程序。
 *
 * 为什么要分三份：插件那侧（一屏界面 + 一双打开文件的手）与后端那侧（会话、网页服务）
 * 编到不同目录，打进插件包里的只有插件那侧；第三份不产出文件，只把 src 下全部源码
 * 过一遍类型检查（两个入口都到不了的文件靠它查）。
 * 一个 tsc 一次只有一个输出目录，所以这里挨个跑、或者各起一个。
 *
 *   node scripts/compile.mjs           挨个跑一遍，哪份错了就停在那里（npm run compile）
 *   node scripts/compile.mjs --watch   三份各起一个 tsc -w，改一下就编一下（npm run watch；
 *                                      截屏小程序不在里面，改过 bin/shot.cs 就跑一次 npm run compile）
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
// 用 node 直接跑 tsc.js：不用管各平台 shell 怎么找 tsc、PATH 里有没有它。
let tscMain;
try {
    tscMain = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
} catch {
    process.stderr.write("找不到 typescript：先在这个仓库里跑 npm install。\n");
    process.exit(1);
}

const projects = [
    { label: "插件侧", config: "tsconfig.extension.json" },
    { label: "后端侧", config: "tsconfig.server.json" },
    // 这份就是 tsconfig.json：src 下全量过一遍类型检查（不产出文件），编辑器也认它。
    { label: "全量检查", config: "tsconfig.json" },
];

// 桌面截图那支小程序的源码与产物（见 bin/shot.cs、src/desktopScreenshot.ts）：
// 用系统自带的 csc.exe 编成 bin/shot.exe，随 npm 包一起装到后端那边。
const SHOT_SOURCE = path.join(repoRoot, "bin", "shot.cs");
const SHOT_EXE = path.join(repoRoot, "bin", "shot.exe");

const watch = process.argv.includes("--watch");

/** 起一个 tsc 子进程。输出走管道，交给调用方决定怎么印。 */
function runTsc(config, extraArgs) {
    return spawn(process.execPath, [tscMain, ...extraArgs, "-p", config], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
    });
}

/** 挨个编：一个出错就停，不接着编下一个（先把前一个修好更省事）。 */
async function compileOnce() {
    for (const project of projects) {
        process.stdout.write(`· ${project.label}（${project.config}）\n`);
        const code = await new Promise((resolve) => {
            const child = runTsc(project.config, []);
            child.stdout.pipe(process.stdout);
            child.stderr.pipe(process.stderr);
            child.on("error", (err) => {
                process.stderr.write(`起不了 tsc：${err?.message ?? String(err)}\n`);
                resolve(1);
            });
            child.on("exit", (c) => resolve(c ?? 1));
        });
        if (code !== 0) {
            process.stderr.write(`× ${project.label}编译没过，先把这个修好。\n`);
            process.exit(code);
        }
    }
    compileShotExe();
    process.stdout.write("都编完了。\n");
}

/**
 * 编桌面截图那支小程序（bin/shot.cs → bin/shot.exe）。
 *
 * 编不出来不算构建失败：运行时会退回 PowerShell 那套（见 src/desktopScreenshot.ts），
 * 慢一些但一样能用。所以这里只提醒一句，不拦路。
 */
function compileShotExe() {
    process.stdout.write(`· 截屏小程序（bin/shot.cs → bin/shot.exe）\n`);
    if (process.platform !== "win32") {
        process.stdout.write("  （不是 Windows，跳过：桌面截图只在 Windows 上能用，没必要编）\n");
        return;
    }
    const csc = findCsc();
    if (!csc) {
        process.stdout.write("  （没找到 csc.exe，跳过：运行时会退回 PowerShell 那套，慢一些）\n");
        return;
    }
    try {
        // 源码没动过就别编：npm run web:shot 每条命令都会走到这里来
        if (fs.statSync(SHOT_EXE).mtimeMs >= fs.statSync(SHOT_SOURCE).mtimeMs) {
            process.stdout.write("  （没改动，跳过）\n");
            return;
        }
    } catch { /* 产物还没有，往下走就是 */ }
    const result = spawnSync(csc, [
        "-nologo", "-optimize+", "-target:exe", "-platform:anycpu",
        // 源码是 UTF-8，不指明的话 csc 按系统代码页读，中文注释会乱
        "-codepage:65001",
        // 路径里有空格时由 Node 自己加引号，别在这儿手写引号（csc 会把引号当成文件名的一部分）
        `-out:${SHOT_EXE}`,
        "-r:System.Drawing.dll",
        SHOT_SOURCE,
    ], { cwd: repoRoot, encoding: "utf8" });
    if (result.status !== 0) {
        process.stdout.write(`  × 没编成（csc 退出码 ${result.status}），运行时会退回 PowerShell 那套\n`);
        if (result.stdout) { process.stdout.write(result.stdout); }
        if (result.stderr) { process.stderr.write(result.stderr); }
        return;
    }
    process.stdout.write("  编好了。\n");
}

/** 找系统自带的 csc.exe（64 位那份优先，退回 32 位那份）。找不到返回 undefined。 */
function findCsc() {
    const windows = process.env.WINDIR || "C:\\Windows";
    const candidates = [
        path.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
        path.join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    ];
    for (const item of candidates) {
        try { if (fs.existsSync(item)) { return item; } } catch { /* 换下一个 */ }
    }
    return undefined;
}

/** 三份各起一个 tsc -w：一个进度慢不影响别的。输出混在一个终端里，每行标上是谁说的。 */
function watchAll() {
    const children = [];
    for (const project of projects) {
        const child = runTsc(project.config, ["-w"]);
        children.push(child);
        for (const stream of [child.stdout, child.stderr]) {
            stream.setEncoding("utf8");
            let rest = "";
            stream.on("data", (chunk) => {
                const lines = String(chunk).split("\n");
                rest = lines.pop() ?? "";
                for (const line of lines) {
                    if (line.trim()) { process.stdout.write(`[${project.label}] ${line}\n`); }
                }
            });
        }
        child.on("error", (err) => {
            process.stderr.write(`起不了 tsc：${err?.message ?? String(err)}\n`);
        });
    }
    process.stdout.write(`在看 ${projects.length} 份配置的改动（Ctrl+C 退出）。\n`);
    // Ctrl+C 时把三个子进程一起收掉，免得有一个留在后台继续编。
    process.on("SIGINT", () => {
        for (const child of children) { try { child.kill(); } catch { /* 已经没了 */ } }
        process.exit(0);
    });
}

if (watch) {
    watchAll();
} else {
    await compileOnce();
}

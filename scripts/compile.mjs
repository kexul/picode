/*
 * 把三份编译配置一次跑完，外加四支小程序（托盘图标、桌面截图、桌面实时画面、右下角提醒卡片）。
 *
 * 为什么要分三份：插件那侧（一屏界面 + 一双打开文件的手）与后端那侧（会话、网页服务）
 * 编到不同目录，打进插件包里的只有插件那侧；第三份不产出文件，只把 src 下全部源码
 * 过一遍类型检查（两个入口都到不了的文件靠它查）。
 * 一个 tsc 一次只有一个输出目录，所以这里挨个跑、或者各起一个。
 *
 *   node scripts/compile.mjs           挨个跑一遍，哪份错了就停在那里（npm run compile）
 *   node scripts/compile.mjs --watch   三份各起一个 tsc -w，改一下就编一下（npm run watch；
 *                                      四支小程序不在里面，改过 bin/*.cs
 *                                      就跑一次 npm run compile）
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

// 四支小程序的源码与产物（见 bin/tray.cs、bin/shot.cs、bin/live.cs、bin/notice.cs）：
// 都用系统自带的 csc.exe 编，随 npm 包一起装到后端那边。
const TRAY_SOURCE = path.join(repoRoot, "bin", "tray.cs");
const TRAY_EXE = path.join(repoRoot, "bin", "tray.exe");
const SHOT_SOURCE = path.join(repoRoot, "bin", "shot.cs");
const SHOT_EXE = path.join(repoRoot, "bin", "shot.exe");
const LIVE_SOURCE = path.join(repoRoot, "bin", "live.cs");
const LIVE_EXE = path.join(repoRoot, "bin", "live.exe");
const NOTICE_SOURCE = path.join(repoRoot, "bin", "notice.cs");
const NOTICE_EXE = path.join(repoRoot, "bin", "notice.exe");
const RESIZE_SOURCE = path.join(repoRoot, "bin", "resize.cs");
const RESIZE_EXE = path.join(repoRoot, "bin", "resize.exe");

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
    compileTrayExe();
    compileShotExe();
    compileLiveExe();
    compileNoticeExe();
    compileResizeExe();
    process.stdout.write("都编完了。\n");
}

/**
 * 编通知区域里那颗图标（bin/tray.cs → bin/tray.exe）。
 *
 * 编不出来不算构建失败：没有它只是托盘里没有那颗图标（后端照常跑）。
 */
function compileTrayExe() {
    runCsc({
        label: "托盘小程序",
        source: TRAY_SOURCE,
        output: TRAY_EXE,
        target: "winexe",
        references: ["System.Drawing.dll"],
        whySkip: "托盘图标只在 Windows 上有，没必要编",
        whyFail: "通知区域里就没有那颗图标了（后端照常跑）",
    });
}

/**
 * 编桌面截图那支小程序（bin/shot.cs → bin/shot.exe）。
 *
 * 编不出来不算构建失败：运行时会退回 PowerShell 那套（见 src/desktopScreenshot.ts），
 * 慢一些但一样能用。所以这里只提醒一句，不拦路。
 */
function compileShotExe() {
    runCsc({
        label: "截屏小程序",
        source: SHOT_SOURCE,
        output: SHOT_EXE,
        target: "exe",
        references: ["System.Drawing.dll"],
        whySkip: "桌面截图只在 Windows 上能用，没必要编",
        whyFail: "运行时会退回 PowerShell 那套",
    });
}

/**
 * 编“一直拍桌面”那支小程序（bin/live.cs → bin/live.exe）。
 *
 * 跟截屏那支一样不算构建失败：没有它只是长按截图按钮看不了实时画面（点一下截图照旧能用）。
 */
function compileLiveExe() {
    runCsc({
        label: "实时画面小程序",
        source: LIVE_SOURCE,
        output: LIVE_EXE,
        target: "exe",
        references: ["System.Drawing.dll"],
        whySkip: "桌面实时画面只在 Windows 上能用，没必要编",
        whyFail: "长按截图按钮看桌面实时画面就用不了",
    });
}

/**
 * 编右下角那张提醒卡片（bin/notice.cs → bin/notice.exe）。
 *
 * 跟截屏那支一样不算构建失败：没有它只是这台机器上不弹提醒（浏览器页面里照样看得到）。
 */
function compileNoticeExe() {
    runCsc({
        label: "提醒卡片小程序",
        source: NOTICE_SOURCE,
        output: NOTICE_EXE,
        target: "winexe",
        references: [],
        whySkip: "提醒卡片只在 Windows 上弹，没必要编",
        whyFail: "这台机器上就不弹提醒了（浏览器页面里照样看得到）",
    });
}

/**
 * 编缩图那支小程序（bin/resize.cs → bin/resize.exe）。
 *
 * 编不出来不算构建失败：运行时不缩图，照原样把图发过去（见 src/imageFit.ts）——
 * 只是手机上多下几百 KB，不会坏。
 */
function compileResizeExe() {
    runCsc({
        label: "缩图小程序",
        source: RESIZE_SOURCE,
        output: RESIZE_EXE,
        target: "exe",
        references: ["System.Drawing.dll"],
        whySkip: "缩图只在 Windows 上用，没必要编",
        whyFail: "运行时不缩图，照原样把图发过去（手机上多下几百 KB）",
    });
}

/**
 * 用系统自带的 csc.exe 编一支小程序。
 *
 * 编不出来只提醒一句、不拦路：两支都是“没有也能用”的东西，构建不该为它们停下。
 * @param {{ label: string, source: string, output: string, target: string,
 *           references: string[], whySkip: string, whyFail: string }} job
 */
function runCsc(job) {
    process.stdout.write(`· ${job.label}（${path.relative(repoRoot, job.source)} → ${path.relative(repoRoot, job.output)}）\n`);
    if (process.platform !== "win32") {
        process.stdout.write(`  （不是 Windows，跳过：${job.whySkip}）\n`);
        return;
    }
    const csc = findCsc();
    if (!csc) {
        process.stdout.write(`  （没找到 csc.exe，跳过：${job.whyFail}）\n`);
        return;
    }
    try {
        // 源码没动过就别编：npm run web:shot 每条命令都会走到这里来
        if (fs.statSync(job.output).mtimeMs >= fs.statSync(job.source).mtimeMs) {
            process.stdout.write("  （没改动，跳过）\n");
            return;
        }
    } catch { /* 产物还没有，往下走就是 */ }
    const result = spawnSync(csc, [
        "-nologo", "-optimize+", `-target:${job.target}`, "-platform:anycpu",
        // 源码是 UTF-8，不指明的话 csc 按系统代码页读，中文注释会乱
        "-codepage:65001",
        // 路径里有空格时由 Node 自己加引号，别在这儿手写引号（csc 会把引号当成文件名的一部分）
        `-out:${job.output}`,
        ...job.references.map((dll) => `-r:${dll}`),
        job.source,
    ], { cwd: repoRoot, encoding: "utf8" });
    if (result.status !== 0) {
        process.stdout.write(`  × 没编成（csc 退出码 ${result.status}），${job.whyFail}\n`);
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

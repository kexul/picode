/*
 * 把三份编译配置一次跑完。
 *
 * 为什么要分三份：插件那侧（一屏界面 + 一双打开文件的手）与后端那侧（会话、网页服务）
 * 编到不同目录，打进插件包里的只有插件那侧；测试同时要用到两侧的东西，编到第三份目录。
 * 一个 tsc 一次只有一个输出目录，所以这里挨个跑、或者各起一个。
 *
 *   node scripts/compile.mjs           挨个跑一遍，哪份错了就停在那里（npm run compile）
 *   node scripts/compile.mjs --watch   三份各起一个 tsc -w，改一下就编一下（npm run watch）
 */
import { spawn } from "node:child_process";
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
    // 这份就是 tsconfig.json：src 下全量编一遍，单测与编辑器的类型检查都用它。
    { label: "全量", config: "tsconfig.json" },
];

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
    process.stdout.write("三份都编完了。\n");
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

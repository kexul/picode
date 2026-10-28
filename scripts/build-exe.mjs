/*
 * 把后端打成一个单文件 exe（Windows）：双击就开，没有控制台，托盘里出一颗图标。
 *
 *   npm run exe        → dist/pichat.exe（约 4MB）
 *
 * 里面装的是什么（跟 Node 单文件应用那种 90MB 的做法不一样）：
 *   - 一份壳（bin/launcher.cs，编出来是个窗口程序，天生没有黑框）；
 *   - 后端打成一个 CommonJS 文件（我们零运行时依赖，相对路径自己接一下就行）；
 *   - 界面文件（media/）与两支小程序（bin/tray.exe、bin/shot.exe）。
 * **不带 Node 运行时**：跑的时候用这台机器上装好的 Node（`PICHAT_NODE` → PATH → 常见安装位置）。
 * 所以产物只有几 MB；代价是目标机器得有 Node 20 或以上（找不到时壳会弹一句人话）。
 *
 * 壳干的事见 bin/launcher.cs：解到 %LOCALAPPDATA%\PiChat\app-<版本>\ → 找 node → 起后端 →
 * 把后端的输出写进 %LOCALAPPDATA%\PiChat\pichat.log。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const OUT_SERVER = path.join(repoRoot, "out", "server");
const DIST = path.join(repoRoot, "dist");
const BUNDLE = path.join(DIST, "bundle.cjs");
const EXE = path.join(DIST, "pichat.exe");
const ICO = path.join(DIST, "pichat.ico");
const PAYLOAD_TXT = path.join(DIST, "payload.txt");
const VERSION_TXT = path.join(DIST, "version.txt");
const PACKAGE_TXT = path.join(DIST, "package.json");
const LAUNCHER_SRC = path.join(repoRoot, "bin", "launcher.cs");
const ICON_SRC = path.join(repoRoot, "bin", "makeicon.cs");

function fail(text) {
    process.stderr.write(`× ${text}\n`);
    process.exit(1);
}

function step(text) {
    process.stdout.write(`· ${text}\n`);
}

/** 找系统自带的 csc.exe（64 位那份优先，退回 32 位那份）。 */
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

/** 编一支 C#（都是系统自带的 csc，不带任何第三方依赖）。 */
function compileCsc(csc, outFile, source, extra) {
    const result = spawnSync(csc, [
        "-nologo", "-optimize+", "-target:winexe", "-platform:anycpu",
        // 源码是 UTF-8，不指明的话 csc 按系统代码页读，中文注释会乱
        "-codepage:65001",
        `-out:${outFile}`,
        ...extra,
        source,
    ], { cwd: repoRoot, encoding: "utf8" });
    if (result.status !== 0) {
        return `${result.stdout || ""}${result.stderr || ""}`.trim() || `csc 退出码 ${result.status}`;
    }
    return undefined;
}

/** 把 out/server 打成一个 CommonJS 文件：每个编译结果包一层，require 只接管相对路径。 */
function writeBundle() {
    const files = fs.readdirSync(OUT_SERVER).filter((name) => name.endsWith(".js")).sort();
    if (!files.includes("serverMain.js")) { fail("out/server 里没有 serverMain.js：先跑 npm run compile"); }
    const parts = [];
    parts.push("/* 打包产物：不要改这个文件，改 src/ 然后 npm run exe。 */");
    // 每个内嵌模块拿到的 __dirname 必须是**真**路径（这一层往上两层就是 media/ 与 bin/ 那一层），
    // 不能是“包里的虚拟路径”：后端靠 __dirname 找界面文件与两支小程序。
    parts.push("const __bundleDir = __dirname;");
    parts.push("const __defs = Object.create(null);");
    for (const name of files) {
        const src = fs.readFileSync(path.join(OUT_SERVER, name), "utf8");
        parts.push(`__defs[${JSON.stringify(name)}] = function (module, exports, require, __filename, __dirname) {`);
        parts.push(src);
        parts.push("};");
    }
    parts.push(`
const __cache = Object.create(null);
const __path = require("node:path");

/** 从某个模块出发 require 一个相对路径：按"同目录 / 加 .js / index.js"三档找。 */
function __resolve(fromId, spec) {
  const base = __path.posix.normalize(__path.posix.join(__path.posix.dirname(fromId), spec));
  for (const candidate of [base, base + ".js", base + "/index.js"]) {
    if (__defs[candidate]) { return candidate; }
  }
  throw new Error("打好的包里没有这个模块：" + spec + "（来自 " + fromId + "）");
}

function __load(id) {
  const cached = __cache[id];
  if (cached) { return cached.exports; }
  const def = __defs[id];
  if (!def) { throw new Error("打好的包里没有这个模块：" + id); }
  const module = { exports: {} };
  __cache[id] = module;
  const requireFrom = (spec) => {
    if (typeof spec !== "string") { throw new Error("require 的参数不是字符串"); }
    if (spec.startsWith(".")) { return __load(__resolve(id, spec)); }
    return require(spec);          // 内置模块（fs / http / node:sea 这些）
  };
  // 真路径：包里的模块按 out/server 那一层的相对位置拼到 bundle.cjs 旁边
  const file = __path.join(__bundleDir, ...id.split("/"));
  def.call(module.exports, module, module.exports, requireFrom, file, __path.dirname(file));
  return module.exports;
}

Promise.resolve(__load("serverMain.js").main()).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`);
    fs.writeFileSync(BUNDLE, parts.join("\n"), "utf8");
}

/** 要装进 exe 的东西（相对解出来的那个目录：media/…、bin/…、out/server/bundle.cjs）。 */
function collectPayload(version) {
    const entries = [];
    const add = (relative, full) => { entries.push({ relative, full }); };
    add("out/server/bundle.cjs", BUNDLE);
    add("package.json", PACKAGE_TXT);        // 只有一句版本号：后端靠它报版本、给桥接文件起名
    for (const name of fs.readdirSync(path.join(repoRoot, "media"))) {
        const full = path.join(repoRoot, "media", name);
        if (fs.statSync(full).isFile()) { add(`media/${name}`, full); }
    }
    for (const name of ["tray.exe", "shot.exe"]) {
        const full = path.join(repoRoot, "bin", name);
        if (!fs.existsSync(full)) { fail(`找不到 bin/${name}：先跑 npm run compile（它顺手编这两支小程序）`); }
        add(`bin/${name}`, full);
    }
    // 壳只想要那一串版本号（拿它给缓存目录起名），后端要的是一份 package.json：两个都写
    fs.writeFileSync(VERSION_TXT, version, "utf8");
    fs.writeFileSync(PACKAGE_TXT, JSON.stringify({ version }), "utf8");
    return entries;
}

async function main() {
    const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    const csc = findCsc();
    if (!csc) { fail("找不到系统自带的 csc.exe（.NET Framework 4 那套），编不了壳。"); }
    fs.mkdirSync(DIST, { recursive: true });

    step("把 out/server 打成一个 CommonJS 文件");
    writeBundle();
    step(`  ${path.relative(repoRoot, BUNDLE)}（${(fs.statSync(BUNDLE).size / 1024).toFixed(0)} KB）`);

    step("列出要装进 exe 的东西");
    const payload = collectPayload(version);
    step(`  一共 ${payload.length} 个（界面文件 + 两支小程序 + 后端）`);

    step("画图标");
    const iconTool = path.join(DIST, "makeicon.exe");
    let problem = compileCsc(csc, iconTool, ICON_SRC, ["-target:exe", "-r:System.Drawing.dll"]);
    if (problem) { fail(`编不出做图标那支小程序：\n${problem}`); }
    const drawn = spawnSync(iconTool, ["write", ICO], { encoding: "utf8" });
    if (drawn.status !== 0) { fail(`画图标失败：${drawn.stderr || ""}`); }
    step(`  ${path.relative(repoRoot, ICO)}（${(fs.statSync(ICO).size / 1024).toFixed(0)} KB，九种尺寸）`);

    step("把壳、图标、内嵌文件编成一个 exe");
    // 每个内嵌文件一个资源名（p0、p1…），对应关系写在 payload.txt 里（「资源名<TAB>相对路径」）
    fs.writeFileSync(PAYLOAD_TXT, payload.map((item, index) => `p${index}\t${item.relative}`).join("\n") + "\n", "utf8");
    const resources = [
        `-resource:${PAYLOAD_TXT},payload.txt`,
        `-resource:${VERSION_TXT},version.txt`,
        ...payload.map((item, index) => `-resource:${item.full},p${index}`),
    ];
    try {
        fs.rmSync(EXE, { force: true });
    } catch {
        fail("dist\pichat.exe 正被占着（它还在跑）。先把它关掉（托盘菜单里那颗「退出这颗图标」或者任务管理器）再打包。");
    }
    problem = compileCsc(csc, EXE, LAUNCHER_SRC, [
        "-r:System.Windows.Forms.dll",
        `-win32icon:${ICO}`,
        ...resources,
    ]);
    if (problem) { fail(`编不出 exe：\n${problem}`); }

    step("收尾");
    for (const file of [BUNDLE, PAYLOAD_TXT, VERSION_TXT, PACKAGE_TXT, ICO, iconTool]) {
        try { fs.rmSync(file, { force: true }); } catch { /* 删不掉留着也不影响 */ }
    }
    const kb = fs.statSync(EXE).size / 1024;
    process.stdout.write(`\n好了：${path.relative(repoRoot, EXE)}（${kb.toFixed(0)} KB）\n`);
    process.stdout.write("双击它就会起后端、在通知区域出一颗图标、并把浏览器打开。\n");
    process.stdout.write("（机器上得有 Node 20 或以上；找不到会弹一句提示。日志在 %LOCALAPPDATA%\\PiChat\\pichat.log）\n");
}

main().catch((err) => fail(err?.stack || String(err)));

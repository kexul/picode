/*
 * 把后端打成一个单文件可执行（按当前这台机器的系统来）。
 *
 *   npm run exe        → Windows：dist/pichat.exe（约 2.3MB）
 *                        Linux / macOS：dist/pichat（一个可执行文件，约 2.4MB）
 *
 * 两边装的东西一样：后端打成一个 CommonJS 文件 + 界面文件 + 启动用的那点东西
 * （Windows 还带上托盘与截屏两支小程序，Linux 上没有托盘，不带）。
 * 也都不带 Node 运行时：跑的时候用这台机器上装好的 Node（`PICHAT_NODE` → PATH → 常见位置）。
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

/**
 * Linux / macOS：打一个“自解压脚本”（一个可执行文件）。
 *
 * 为什么这么做：这边没有系统自带的 C# 编译器可以照 Windows 那条路编壳，也不想为打包拉依赖。
 * 干脆让产物本身是一个 `sh` 脚本：脚本头里算好自己后面那段 tar.gz 从第几个字节开始，
 * 第一次跑时 tail 出来解开（`tar` 哪儿都有），之后直接跑。
 *
 * 用法跟 exe 一样：双击 / `./pichat`；带参数就照原样交给后端。
 */
function packagePosix(version) {
    const payload = collectPayload(version, false);
    step(`  一共 ${payload.length} 个（后端 + 界面文件）`);

    // 打包内容：解出来就是“有 media/ 与 out/ 的那一层”。只收 Linux 用得上的（不带 .exe）。
    const stage = path.join(DIST, "stage");
    fs.rmSync(stage, { recursive: true, force: true });
    for (const item of payload) {
        const target = path.join(stage, item.relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(item.full, target);
    }
    const tarball = path.join(DIST, "payload.tar.gz");
    // cwd 指到 stage、只给相对路径：Windows 上的 tar（bsdtar）会把 "D:\…" 当成主机名去连
    const tar = spawnSync("tar", ["-czf", "payload.tar.gz", "-C", "stage", "."], { encoding: "utf8", cwd: DIST });
    if (tar.status !== 0) { fail(`打 tar 失败：${tar.stderr || tar.error?.message || ""}`); }

    // 脚本头：OFFSET 那行定长十位，等头拼好以后回填（长度不变，偏移不会漂）
    // 壳的脚本头放在 scripts/pichat-launcher.sh.in：几百行 shell，塞进 JS 字面量里
    // 光那些 $ 与引号就要命（还容易改错），单独一个文件干净。
    const template = fs.readFileSync(path.join(repoRoot, "scripts", "pichat-launcher.sh.in"), "utf8");
    const header = template
        .replaceAll("__VERSION__", version)
        // 缓存目录：跟别的平台的约定一样，~/.cache/pichat（尊重 XDG_CACHE_HOME）
        .replaceAll("__DATA__", "${XDG_CACHE_HOME:-$HOME/.cache}/pichat");

    // 先算“头和正文之间的那段固定长度”：OFFSET / BYTES 都是定长十位，回填时长度不变
    const probe = header.replaceAll("__OFFSET__", "0000000000");
    const offset = Buffer.byteLength(probe, "utf8");
    // replaceAll：注释里也提到了这个占位符（两处，都得换，不然留下的那处会把脚本弄坏）
    const script = header.replaceAll("__OFFSET__", String(offset).padStart(10, "0"));

    const target = path.join(DIST, "pichat");
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, script, "utf8");
    fs.appendFileSync(target, fs.readFileSync(tarball));
    fs.chmodSync(target, 0o755);

    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(tarball, { force: true });
    fs.rmSync(BUNDLE, { force: true });
    fs.rmSync(VERSION_TXT, { force: true });
    fs.rmSync(PACKAGE_TXT, { force: true });

    const kb = fs.statSync(target).size / 1024;
    process.stdout.write("\n" + "好了：" + path.relative(repoRoot, target) + "（" + kb.toFixed(0) + " KB）" + "\n");
    process.stdout.write("直接跑它就是：./" + path.basename(target) + "（会解包到 ~/.cache/pichat，再起后端）。" + "\n");
    process.stdout.write("要求这台机器上有 Node 20 或以上；日志在 ~/.cache/pichat/pichat.log" + "\n");
}

/**
 * 要装进产物里的东西（相对解出来的那个目录：media/…、out/server/bundle.cjs、以及 Windows 才有的 bin/…）。
 * @param withBinaries 要不要带上那两支小程序（托盘 / 截屏）：只有 Windows 那份才用得上，
 *                     Linux 上它们压根不编（scripts/compile.mjs 会跳过），不能强求。
 */
function collectPayload(version, withBinaries) {
    const entries = [];
    const add = (relative, full) => { entries.push({ relative, full }); };
    add("out/server/bundle.cjs", BUNDLE);
    add("package.json", PACKAGE_TXT);        // 只有一句版本号：后端靠它报版本、给桥接文件起名
    for (const name of fs.readdirSync(path.join(repoRoot, "media"))) {
        const full = path.join(repoRoot, "media", name);
        if (fs.statSync(full).isFile()) { add(`media/${name}`, full); }
    }
    if (withBinaries) {
        for (const name of ["tray.exe", "shot.exe"]) {
            const full = path.join(repoRoot, "bin", name);
            if (!fs.existsSync(full)) { fail(`找不到 bin/${name}：先跑 npm run compile（它顺手编这两支小程序）`); }
            add(`bin/${name}`, full);
        }
    }
    // 壳只想要那一串版本号（拿它给缓存目录起名），后端要的是一份 package.json：两个都写
    fs.writeFileSync(VERSION_TXT, version, "utf8");
    fs.writeFileSync(PACKAGE_TXT, JSON.stringify({ version }), "utf8");
    return entries;
}

/** 按当前平台打包：Windows 编 exe 壳，其它系统贴一个自解压脚本。 */
async function main() {
    const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    // 临时文件与产物都放这儿；clean 之后这个目录不存在，先建出来
    fs.mkdirSync(DIST, { recursive: true });

    step("把 out/server 打成一个 CommonJS 文件");
    writeBundle();
    step(`  ${path.relative(repoRoot, BUNDLE)}（${(fs.statSync(BUNDLE).size / 1024).toFixed(0)} KB）`);

    // `--posix` 是给在 Windows 上验 Linux 那份产物用的（Git Bash 里有 sh 与 tar）；
    // 平时只按当前系统来。
    const posix = process.argv.includes("--posix") || process.platform !== "win32";
    if (posix) {
        packagePosix(version);
        return;
    }
    const csc = findCsc();
    if (!csc) { fail("找不到系统自带的 csc.exe（.NET Framework 4 那套），编不了壳。"); }

    step("列出要装进 exe 的东西");
    const payload = collectPayload(version, true);
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
        fail("dist\pichat.exe 正被占着（它还在跑）。先把它关掉（任务管理器里结束它，或者那个 pichat 后端先退出）再打包。");
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

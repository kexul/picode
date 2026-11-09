/*
 * 把后端打成一个 Windows 单文件 exe：dist\PiChat.exe。
 *
 * 双击它就能起后端（托盘图标由后端自己拉起来，见 bin/tray.cs），不用在终端里敲 pichat。
 * 打进去的东西：
 *   - 一份壳（bin/launcher.cs，编出来是个窗口程序，天生没有黑框）；
 *   - 后端打成一个 CommonJS 文件（我们零运行时依赖，相对路径自己接一下就行）；
 *   - 界面文件（media/）与那几支小程序（bin/tray.exe、shot.exe、live.exe、notice.exe）；
 *   - 一枚图标（bin/makeicon.cs 画的那个标记）。
 * **不带 Node 运行时**：跑的时候用这台机器上装好的 Node（PICHAT_NODE → PATH → 常见位置）。
 * 所以产物只有几 MB；代价是目标机器得有 Node 20 或以上（找不到时壳会弹一句人话）。
 *
 * 壳干的事见 bin/launcher.cs：解到 %LOCALAPPDATA%\PiChat\app-<内容指纹>\ → 找 node → 起后端 →
 * 把后端的输出写进 %LOCALAPPDATA%\PiChat\pichat.log。
 * 目录名用的是这一版内容算出来的指纹（不是版本号）：改完代码重打一个，缓存目录就换了，
 * 「编译并重启」起回来的 exe 才真跑的是新代码。
 *
 *   npm run exe        只打 exe（要求先 npm run compile；npm run build 会顺带打）
 *
 * 非 Windows 上什么也不做（只打一句跳过）：这个 exe 只在 Windows 上有意义。
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const OUT_SERVER = path.join(repoRoot, "out", "server");
const DIST = path.join(repoRoot, "dist");
const WORK = path.join(DIST, "build");
const BUNDLE = path.join(WORK, "bundle.cjs");
const EXE = path.join(DIST, "PiChat.exe");
const ICO = path.join(WORK, "PiChat.ico");
const PAYLOAD_TXT = path.join(WORK, "payload.txt");
const FINGERPRINT_TXT = path.join(WORK, "fingerprint.txt");
const PACKAGE_TXT = path.join(WORK, "package.json");
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
    parts.push("/* 打包产物：不要改这个文件，改 src/ 然后 npm run build。 */");
    // 每个内嵌模块拿到的 __dirname 必须是**真**路径（这一层往上两层就是 media/ 与 bin/ 那一层），
    // 不能是“包里的虚拟路径”：后端靠 __dirname 找界面文件与那几支小程序。
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
    return require(spec);          // 内置模块（fs / http / node:path 这些）
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
    for (const name of ["tray.exe", "shot.exe", "live.exe", "notice.exe", "resize.exe", "cwebp.exe"]) {
        const full = path.join(repoRoot, "bin", name);
        if (!fs.existsSync(full)) { fail(`找不到 bin/${name}：先跑 npm run compile（它顺手编这几支小程序）`); }
        add(`bin/${name}`, full);
    }
    // 后端要的是一份 package.json（只有版本号那一句）
    fs.writeFileSync(PACKAGE_TXT, JSON.stringify({ version }), "utf8");
    return entries;
}

/**
 * 这一版的内容指纹：解出来的缓存目录叫 app-<它>。
 * 不能拿 package.json 的版本号：版本号长期不变，改完代码重打 exe、重启之后
 * 还会去用上一次解出来的旧目录（跑的是旧代码）。
 */
function fingerprintOf(payload) {
    const hash = crypto.createHash("sha256");
    for (const item of payload) {
        hash.update(item.relative);
        hash.update("\0");
        hash.update(fs.readFileSync(item.full));
        hash.update("\0");
    }
    return hash.digest("hex").slice(0, 12);
}

async function main() {
    if (process.platform !== "win32") {
        process.stdout.write("· 单文件 exe（跳过：只有 Windows 上有这个）\n");
        return;
    }
    const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    const csc = findCsc();
    if (!csc) { fail("找不到系统自带的 csc.exe（.NET Framework 4 那套），编不了壳。"); }
    fs.mkdirSync(WORK, { recursive: true });

    step("把 out/server 打成一个 CommonJS 文件");
    writeBundle();
    step(`  ${path.relative(repoRoot, BUNDLE)}（${(fs.statSync(BUNDLE).size / 1024).toFixed(0)} KB）`);

    step("列出要装进 exe 的东西");
    const payload = collectPayload(version);
    const fingerprint = fingerprintOf(payload);
    step(`  一共 ${payload.length} 个（界面文件 + 几支小程序 + 后端），指纹 ${fingerprint}`);

    step("画图标");
    const iconTool = path.join(WORK, "makeicon.exe");
    let problem = compileCsc(csc, iconTool, ICON_SRC, ["-target:exe", "-r:System.Drawing.dll"]);
    if (problem) { fail(`编不出做图标那支小程序：\n${problem}`); }
    const drawn = spawnSync(iconTool, ["write", ICO], { encoding: "utf8" });
    if (drawn.status !== 0) { fail(`画图标失败：${drawn.stderr || ""}`); }
    step(`  ${path.relative(repoRoot, ICO)}（${(fs.statSync(ICO).size / 1024).toFixed(0)} KB，九种尺寸）`);

    step("把壳、图标、内嵌文件编成一个 exe");
    // 每个内嵌文件一个资源名（p0、p1…），对应关系写在 payload.txt 里（「资源名<TAB>相对路径」）
    fs.writeFileSync(PAYLOAD_TXT, payload.map((item, index) => `p${index}\t${item.relative}`).join("\n") + "\n", "utf8");
    fs.writeFileSync(FINGERPRINT_TXT, fingerprint, "utf8");
    const resources = [
        `-resource:${PAYLOAD_TXT},payload.txt`,
        `-resource:${FINGERPRINT_TXT},fingerprint.txt`,
        ...payload.map((item, index) => `-resource:${item.full},p${index}`),
    ];
    try {
        fs.rmSync(EXE, { force: true });
    } catch {
        fail("dist\\PiChat.exe 正被占着（它还在跑）。先退出托盘菜单里那颗「退出」再打包。");
    }
    problem = compileCsc(csc, EXE, LAUNCHER_SRC, [
        "-r:System.Windows.Forms.dll",
        `-win32icon:${ICO}`,
        ...resources,
    ]);
    if (problem) { fail(`编不出 exe：\n${problem}`); }

    fs.rmSync(WORK, { recursive: true, force: true });
    const kb = fs.statSync(EXE).size / 1024;
    process.stdout.write(`\n好了：${path.relative(repoRoot, EXE)}（${kb.toFixed(0)} KB）\n`);
    process.stdout.write("双击它就会起后端、通知区域出那颗图标，并把页面打开。\n");
    process.stdout.write("（机器上得有 Node 20 或以上；找不到会弹一句提示。日志在 %LOCALAPPDATA%\\PiChat\\pichat.log）\n");
}

main().catch((err) => fail(err?.stack || String(err)));

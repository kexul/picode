/*
 * 把后端打成一个单文件 exe（Windows）：双击就开，没有控制台，托盘里出一颗图标。
 *
 *   npm run exe        → dist/pichat.exe（约 90MB）
 *
 * 干的事：
 *   1. 把 out/server 下所有的编译结果打成一个 CommonJS 文件（我们零运行时依赖，
 *      除了相对路径就是 Node 内置模块，所以只用管"相对路径怎么找"这一件事）；
 *   2. 把界面文件（media/）与两支小程序（bin/tray.exe、bin/shot.exe）列成 Node 单文件
 *      应用（SEA）能内嵌的资源；
 *   3. 用 Node 自带的 `--experimental-sea-config` 生成 blob，塞进一份 node.exe 里；
 *   4. 把 PE 头里的"子系统"从控制台改成窗口（不然后台一跑就顶一个黑框），
 *      日志改由 appAssets.startSingleExe 写文件。
 *
 * 跑起来以后的样子、以及"pi 打不进去"这些，见 README 的「一个 exe 直接跑」那一段。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const OUT_SERVER = path.join(repoRoot, "out", "server");
const DIST = path.join(repoRoot, "dist");
const BUNDLE = path.join(DIST, "bundle.cjs");
const SEA_CONFIG = path.join(DIST, "sea-config.json");
const SEA_BLOB = path.join(DIST, "sea-prep.blob");
const EXE = path.join(DIST, "pichat.exe");
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function fail(text) {
    process.stderr.write(`× ${text}\n`);
    process.exit(1);
}

function step(text) {
    process.stdout.write(`· ${text}\n`);
}

/** 内嵌哪些文件：界面文件全部 + 两支小程序。 */
function collectAssets() {
    const assets = {};
    const mediaDir = path.join(repoRoot, "media");
    for (const name of fs.readdirSync(mediaDir)) {
        const full = path.join(mediaDir, name);
        if (fs.statSync(full).isFile()) { assets[`media/${name}`] = full; }
    }
    for (const name of ["tray.exe", "shot.exe"]) {
        const full = path.join(repoRoot, "bin", name);
        if (!fs.existsSync(full)) { fail(`找不到 bin/${name}：先跑 npm run compile（它顺手编这两支小程序）`); }
        assets[`bin/${name}`] = full;
    }
    return assets;
}

/**
 * 打一个 CommonJS 文件：每个编译结果包成一个函数，require 只处理相对路径（其余全交给 Node 内置）。
 * 为什么自己写而不上打包工具：我们一个外部依赖都没有，要处理的只有"相对路径怎么找"这一件事，
 * 六十行就够了，也免得为构建再拉一个几百 KB 的依赖进来。
 */
function writeBundle(version, assetKeys) {
    const files = fs.readdirSync(OUT_SERVER).filter((name) => name.endsWith(".js")).sort();
    if (!files.includes("serverMain.js")) { fail("out/server 里没有 serverMain.js：先跑 npm run compile"); }
    const parts = [];
    parts.push("/* 打包产物：不要改这个文件，改 src/ 然后 npm run exe。 */");
    parts.push(`globalThis.__PICHAT_SINGLE_EXE__ = ${JSON.stringify({ version, assets: assetKeys })};`);
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
  const file = __path.posix.join("/", id);
  def.call(module.exports, module, module.exports, requireFrom, file, __path.posix.dirname(file));
  return module.exports;
}

Promise.resolve(__load("serverMain.js").main()).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`);
    fs.writeFileSync(BUNDLE, parts.join("\n"), "utf8");
}

/** 把 PE 头里的子系统改成 2（WINDOWS_GUI）：不改的话双击就顶一个黑框。 */
function patchToWindowsSubsystem(file) {
    const fd = fs.openSync(file, "r+");
    try {
        const dos = Buffer.alloc(0x40);
        fs.readSync(fd, dos, 0, dos.length, 0);
        if (dos.toString("latin1", 0, 2) !== "MZ") { fail("这不是一个 PE 文件（没有 MZ 头）"); }
        const peOffset = dos.readUInt32LE(0x3c);
        // PE 签名(4) + 文件头(20) + 可选头；Subsystem 在可选头里第 0x44 个字节（32 / 64 位都一样）
        const head = Buffer.alloc(4 + 20 + 0x46);
        fs.readSync(fd, head, 0, head.length, peOffset);
        if (head.toString("latin1", 0, 4) !== "PE\u0000\u0000") { fail("PE 头不对"); }
        const at = 4 + 20 + 0x44;
        const before = head.readUInt16LE(at);
        head.writeUInt16LE(2, at);
        fs.writeSync(fd, head, 0, head.length, peOffset);
        return before;
    } finally {
        fs.closeSync(fd);
    }
}

async function main() {
    const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    fs.mkdirSync(DIST, { recursive: true });

    step("列出要内嵌的文件");
    const assets = collectAssets();
    step(`  界面文件与小程序一共 ${Object.keys(assets).length} 个`);

    step("把 out/server 打成一个 CommonJS 文件");
    writeBundle(version, Object.keys(assets));
    step(`  ${path.relative(repoRoot, BUNDLE)}（${(fs.statSync(BUNDLE).size / 1024).toFixed(0)} KB）`);

    step("生成单文件应用的 blob");
    fs.writeFileSync(SEA_CONFIG, JSON.stringify({
        main: BUNDLE,
        output: SEA_BLOB,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets,
    }, null, 1), "utf8");
    const sea = spawnSync(process.execPath, ["--experimental-sea-config", SEA_CONFIG], { cwd: repoRoot, encoding: "utf8" });
    if (sea.status !== 0) { fail(`生成 blob 失败：${sea.stderr || sea.stdout}`); }

    step("复制一份 node.exe 当底座");
    fs.copyFileSync(process.execPath, EXE);

    step("把 blob 注进去");
    const { inject } = await import("postject");
    await inject(EXE, "NODE_SEA_BLOB", fs.readFileSync(SEA_BLOB), { sentinelFuse: SENTINEL });

    step("把子系统改成窗口（不要黑框）");
    const before = patchToWindowsSubsystem(EXE);
    step(`  原来是 ${before === 3 ? "控制台(3)" : before}，现在是 2（窗口）`);

    step("收尾");
    fs.rmSync(SEA_BLOB, { force: true });
    fs.rmSync(SEA_CONFIG, { force: true });
    fs.rmSync(BUNDLE, { force: true });
    const mb = (fs.statSync(EXE).size / 1048576).toFixed(0);
    process.stdout.write(`\n好了：${path.relative(repoRoot, EXE)}（${mb} MB）\n`);
    process.stdout.write("双击它就会起后端、在通知区域出一颗图标、并把浏览器打开。\n");
}

main().catch((err) => fail(err?.stack || String(err)));

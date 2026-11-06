/*
 * 给桌面那个程序（desktop/PiChat）准备「要嵌进 exe 里的那一份后端」。
 *
 *   npm run payload        （dotnet build 之前也会自己跑一次，见 desktop/PiChat/PiChat.csproj）
 *
 * 产物是 desktop/PiChat/payload/ 这个目录，编 exe 时整棵作为内嵌资源装进去（不进版本库）：
 *
 *   payload/out/server/bundle.cjs   后端打成一个 CommonJS 文件（零运行时依赖，相对路径自己接）
 *   payload/media/*                 界面文件（网页端那一套）
 *   payload/bin/shot.exe            截屏那支小程序
 *   payload/bin/live.exe            实时画面那支小程序
 *   payload/package.json            只有一句版本号：后端靠它报版本、给桥接文件起名
 *
 * 运行时由 PiChat.exe 自己解到 %LOCALAPPDATA%\PiChat\app-<版本>-<内容指纹>\，
 * 再用这台机器上装的 Node 跑那个 bundle（见 desktop/PiChat/Payload.cs）。
 *
 * 不带 Node 运行时：跑的时候用机器上装的 Node（PICHAT_NODE → PATH → 常见安装位置）。
 * 所以产物只有几 MB；代价是目标机器得有 Node 20 或以上。
 */
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const OUT_SERVER = path.join(repoRoot, "out", "server");
const TARGET = path.join(repoRoot, "desktop", "PiChat", "payload");

function fail(text) {
    process.stderr.write(`× ${text}\n`);
    process.exit(1);
}

function step(text) {
    process.stdout.write(`- ${text}\n`);
}

/** 把 out/server 打成一个 CommonJS 文件：每个编译结果包一层，require 只接管相对路径。 */
function writeBundle(file) {
    const files = fs.readdirSync(OUT_SERVER).filter((name) => name.endsWith(".js")).sort();
    if (!files.includes("serverMain.js")) { fail("out/server 里没有 serverMain.js：先跑 npm run compile"); }
    const parts = [];
    parts.push("/* 打包产物：不要改这个文件，改 src/ 然后重新编。 */");
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
    return require(spec);          // 内置模块（fs / http 这些）
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
    fs.writeFileSync(file, parts.join("\n"), "utf8");
}

function main() {
    const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

    fs.rmSync(TARGET, { recursive: true, force: true });
    fs.mkdirSync(path.join(TARGET, "out", "server"), { recursive: true });

    step("把 out/server 打成一个 CommonJS 文件");
    const bundle = path.join(TARGET, "out", "server", "bundle.cjs");
    writeBundle(bundle);
    step(`  out/server/bundle.cjs（${(fs.statSync(bundle).size / 1024).toFixed(0)} KB）`);

    step("收界面文件");
    const mediaDir = path.join(repoRoot, "media");
    fs.mkdirSync(path.join(TARGET, "media"), { recursive: true });
    let mediaCount = 0;
    for (const name of fs.readdirSync(mediaDir)) {
        const full = path.join(mediaDir, name);
        if (!fs.statSync(full).isFile()) { continue; }
        fs.copyFileSync(full, path.join(TARGET, "media", name));
        mediaCount++;
    }
    step(`  media/（${mediaCount} 个文件）`);

    step("收两支小程序");
    fs.mkdirSync(path.join(TARGET, "bin"), { recursive: true });
    for (const name of ["shot.exe", "live.exe"]) {
        const full = path.join(repoRoot, "bin", name);
        if (!fs.existsSync(full)) { fail(`找不到 bin/${name}：先跑 npm run compile（它顺手编这几支小程序）`); }
        fs.copyFileSync(full, path.join(TARGET, "bin", name));
        step(`  bin/${name}（${(fs.statSync(full).size / 1024).toFixed(0)} KB）`);
    }

    // 后端要的是一份 package.json：只有版本号
    fs.writeFileSync(path.join(TARGET, "package.json"), JSON.stringify({ version }), "utf8");

    const bytes = sizeOf(TARGET);
    process.stdout.write(`\ndone: desktop/PiChat/payload/ (${(bytes / 1024).toFixed(0)} KB, gets embedded into the exe)\n`);
}

/** 一个目录加起来多大（打日志用）。 */
function sizeOf(dir) {
    let total = 0;
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        total += stat.isDirectory() ? sizeOf(full) : stat.size;
    }
    return total;
}

main();

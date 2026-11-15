// 临时文件服务：把编出来的 APK 给手机下载（用完 Ctrl+C 关）。
//
//   npm run apk                    # 默认 8099 端口
//   npm run apk -- --port 9000
//
// 目录不用给：自己去 android/app/build/outputs/apk 底下找（有几份就列几份，新的排前面）。
// 手机上打开打印出来的那个地址，点文件名就下；装完这一个服务就可以关掉。
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const APK_DIR = path.join(ROOT, "android", "app", "build", "outputs", "apk");

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg("--port", 8099));

/** 找手头的 APK：输出目录底下所有 .apk，新的排前面。 */
function findApks() {
    const found = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.toLowerCase().endsWith(".apk")) { continue; }
            const st = fs.statSync(full);
            found.push({ name: entry.name, file: full, size: st.size, mtime: st.mtime });
        }
    };
    walk(APK_DIR);
    return found.sort((a, b) => b.mtime - a.mtime);
}

/** 文件大小的说法（手机上看的，MB 就够）。 */
function sizeText(bytes) {
    return bytes >= 1024 * 1024
        ? (bytes / (1024 * 1024)).toFixed(1) + " MB"
        : Math.round(bytes / 1024) + " KB";
}

/** 首页：把找到的 APK 列出来。手机上就是一屏能点的大字。 */
function indexHtml(apks) {
    const rows = apks.map((apk) => `
      <li>
        <a href="/${encodeURIComponent(apk.name)}">${apk.name}</a>
        <span class="meta">${sizeText(apk.size)} · ${apk.mtime.toLocaleString("zh-CN", { hour12: false })}</span>
      </li>`).join("");
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>下载 APK</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 24px 20px; color: #222; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: #666; font-size: 14px; margin: 0 0 20px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 14px 0; border-top: 1px solid #eee; }
  a { font-size: 17px; color: #0b57d0; text-decoration: none; word-break: break-all; }
  .meta { display: block; color: #888; font-size: 13px; margin-top: 2px; }
</style>
</head>
<body>
<h1>下载 APK</h1>
<p>点文件名下载，下完点开装。这台机器上的 APK：</p>
<ul>${rows || "<li>暂时没有编出来的 APK（先 cd android && gradle assembleDebug）</li>"}</ul>
</body>
</html>
`;
}

/** 发一个 APK（认 Range：手机下载器常用断点续传）。 */
function sendApk(req, res, apk) {
    const type = "application/vnd.android.package-archive";
    const disposition = { "Content-Disposition": `attachment; filename="${apk.name}"` };
    const range = /bytes=(\d+)-/.exec(req.headers.range || "");
    if (range) {
        const start = Number(range[1]);
        res.writeHead(206, {
            "Content-Type": type,
            "Content-Range": `bytes ${start}-${apk.size - 1}/${apk.size}`,
            "Content-Length": apk.size - start,
            ...disposition,
        });
        fs.createReadStream(apk.file, { start }).on("error", () => res.destroy()).pipe(res);
        return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": apk.size, ...disposition });
    fs.createReadStream(apk.file).on("error", () => res.destroy()).pipe(res);
}

const server = http.createServer((req, res) => {
    // 下载中途断了（手机息屏、取消下载）：把流里的错吞掉，别把整个服务带崩
    res.on("error", () => { /* 这次下载罢了，下一个请求照常 */ });
    let name;
    try {
        name = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1));
    } catch {
        res.writeHead(400); res.end("地址不对。"); return;
    }
    const apks = findApks();
    if (!name) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(indexHtml(apks));
        return;
    }
    // 只认这儿列出来的那几个文件名：别的一律 404（不留按路径乱取的后门）
    const apk = apks.find((item) => item.name === name);
    if (!apk) { res.writeHead(404); res.end("没有这个文件"); return; }
    sendApk(req, res, apk);
});

server.listen(port, "0.0.0.0", () => {
    const addresses = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const item of list || []) {
            if (item.family === "IPv4" && !item.internal) { addresses.push(item.address); }
        }
    }
    console.log("手机和电脑连同一个网络，手机上打开：");
    for (const address of addresses) { console.log(`  http://${address}:${port}/`); }
    console.log(`\n本机：http://127.0.0.1:${port}/`);
    console.log("下完（装机）就 Ctrl+C 关掉。");
});

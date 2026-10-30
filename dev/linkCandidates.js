// @ts-nocheck
/**
 * linkCandidates —— 验点文件链接时后端挑文件的那一段（`findPathCandidates`，见 src/fileSearch.ts）。
 *
 *   node dev/linkCandidates.js
 *
 * 纯 Node，不开浏览器，全在临时目录里跑（跑完就删）。验的规矩：
 *   1. 照写的路径就在：只回它一个（后面几档都不用看）；
 *   2. 会话碰过的文件先认：同名的还有别处，也只回碰过的那份——大仓库里这一下不用把整个仓库扫一遍
 *      （拿 node_modules 里那个试：它在文件清单里本来就不出现，能挑出来就说明走的是「碰过的那份」）；
 *   3. 碰过的那份在会话目录外面：不认，照旧按文件清单找（边界那条还是得挡住）；
 *   4. 会话没碰过：按文件清单把同名的都列出来，浅的排前面（界面会弹选择）；
 *   5. 会话没碰过、只有一份：就那一份；
 *   6. 三层都对不上：空数组（界面照原来那个写法去开，该 404 就 404）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const OUT = path.resolve(__dirname, "..", "out", "server", "fileSearch.js");
if (!fs.existsSync(OUT)) {
    console.error("还没编译：找不到 out/server/fileSearch.js。先跑 npm run compile（或 npm run web:dev，它会自己编译）。");
    process.exit(1);
}
const { findPathCandidates } = require(OUT);

let bad = 0;
function check(name, ok, extra) {
    console.log("  " + (ok ? "✓" : "✗") + " " + name + (extra === undefined ? "" : "：" + extra));
    if (!ok) { bad++; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-link-candidates-"));
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-link-candidates-outside-"));

function write(rel) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "// " + rel + "\n", "utf8");
    return full;
}

// 所有素材先都铺好：文件清单有缓存，跑到一半再新建的文件这一轮可能看不见
write("exact.js");
write("deep/pick.js");
write("deep2/pick.js");
write("deep/nested/only-here.js");
write("node_modules/known-in-modules.js");
write("other/deleted-twin.js");
// 会话碰过、但现在已经不在了的那份（建过就删，文件清单里没有它）
const goneKnown = write("gone/deleted-twin.js");
fs.rmSync(goneKnown);
const knownOutside = path.join(outsideRoot, "pick.js");
fs.writeFileSync(knownOutside, "// 会话目录外面那个\n", "utf8");

(async () => {
    const exact = await findPathCandidates(root, "exact.js", []);
    check("照写的路径就在：只回它一个", JSON.stringify(exact) === JSON.stringify(["exact.js"]), JSON.stringify(exact));

    const deepKnown = path.join(root, "deep", "pick.js");
    const knownFirst = await findPathCandidates(root, "pick.js", [deepKnown]);
    check("会话碰过的文件先认（同名的还有别处，也只回它）",
        JSON.stringify(knownFirst) === JSON.stringify(["deep/pick.js"]), JSON.stringify(knownFirst));

    const untouched = await findPathCandidates(root, "pick.js", []);
    check("会话没碰过、同名好几份：都列出来、浅的在前",
        JSON.stringify(untouched) === JSON.stringify(["deep/pick.js", "deep2/pick.js"]), JSON.stringify(untouched));

    const inModules = path.join(root, "node_modules", "known-in-modules.js");
    const knownInModules = await findPathCandidates(root, "known-in-modules.js", [inModules]);
    check("文件清单里根本不会出现的那份（node_modules 里）、会话碰过：照样直接认",
        JSON.stringify(knownInModules) === JSON.stringify(["node_modules/known-in-modules.js"]),
        JSON.stringify(knownInModules));
    const modulesNoKnown = await findPathCandidates(root, "known-in-modules.js", []);
    check("会话没碰过：清单不进 node_modules，按找不到算",
        JSON.stringify(modulesNoKnown) === JSON.stringify([]), JSON.stringify(modulesNoKnown));

    const outsideKnown = await findPathCandidates(root, "pick-outside.js", [knownOutside]);
    check("碰过的那份在会话目录外面：不认（照旧按清单找，找不到就是空）",
        JSON.stringify(outsideKnown) === JSON.stringify([]), JSON.stringify(outsideKnown));

    const deletedKnown = await findPathCandidates(root, "deleted-twin.js", [goneKnown]);
    check("碰过的那份已经删了：不拿它当候选，照旧去清单里找同名的那一份",
        JSON.stringify(deletedKnown) === JSON.stringify(["other/deleted-twin.js"]), JSON.stringify(deletedKnown));

    const deepOnly = await findPathCandidates(root, "only-here.js", []);
    check("会话没碰过、清单里只有一份：就那一份",
        JSON.stringify(deepOnly) === JSON.stringify(["deep/nested/only-here.js"]), JSON.stringify(deepOnly));

    const none = await findPathCandidates(root, "nobody-has-this.js", []);
    check("三层都对不上：空数组", JSON.stringify(none) === JSON.stringify([]), JSON.stringify(none));

    console.log("");
    console.log(bad === 0 ? "点链接挑文件：都对上了。" : "点链接挑文件：有 " + bad + " 条不对。");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
    process.exit(bad === 0 ? 0 : 1);
})().catch((err) => {
    console.error("跑炸了：" + (err && err.stack ? err.stack : String(err)));
    process.exit(1);
});

// @ts-nocheck
/**
 * apkBundle —— 验手机 app 设置画面里那一行「包里的界面是不是旧的」靠的那条口：
 * `GET /media-manifest.json`（见 src/webChatServer.ts 的 route、android/README）。
 *
 *   npm run compile && node dev/apkBundle.js
 *
 * 手机那边做的事就三步：读包里 assets/media-manifest.json（文件名 → 指纹）、
 * 来问后端这一条、两边逐个文件名比。所以这条口必须满足：
 *
 *   1. 键是界面清单（src/chatUiFiles.ts）里那几份，一份不多一份不少；
 *   2. 值是**原样文件的** sha1 前 10 个十六进制字符 —— 跟 /media/xxx?v= 用的是同一个函数，
 *      也跟 android/app/build.gradle 里那个算指纹的写法一样（那边是 Groovy、这边只能照着核）；
 *   3. 跟页面 HTML 里引的那几个 ?v= 一模一样（不然手机上永远显示“旧了”）；
 *   4. 文件改了它跟着变（“旧了”就是这么认出来的）；
 *   5. 只认 GET / HEAD，别的给 405；带 no-store（手机上不能拿到上一回的那份）。
 *
 * 不起浏览器、不叫模型：起一个后端（假 pi）只发几个请求。
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { createHarness, MEDIA_DIR } = require("./harness.js");
const { CHAT_UI_FILE_NAMES } = require(path.join(path.resolve(__dirname, ".."), "out", "server", "chatUiFiles.js"));

let failed = 0;
function ok(text) { console.log("  ✔ " + text); }
function bad(text) { console.log("  ✘ " + text); failed += 1; }
function check(cond, text) { (cond ? ok : bad)(text); }

/** 直接照 build.gradle 那一套算：sha1 的前 10 个十六进制字符。 */
function hashOf(file) {
    return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 10);
}

async function main() {
    const harness = createHarness({ fakePi: true, port: 0, log: () => {} });
    let base;
    try {
        base = await harness.start();
        const get = (p) => fetch(base + p);
        const manifest = await (await get("/media-manifest.json")).json();
        const page = await (await get("/")).text();

        // 1. 键就是界面清单里那几份
        check(
            JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify([...CHAT_UI_FILE_NAMES].sort()),
            `清单里的文件名跟界面清单一致（${Object.keys(manifest).length} 份）`,
        );

        // 2. 值就是原样文件的 sha1 前 10 位
        const wrong = CHAT_UI_FILE_NAMES.filter((name) => manifest[name] !== hashOf(path.join(MEDIA_DIR, name)));
        check(wrong.length === 0, "每份指纹都是原样文件的 sha1 前 10 位（跟 build.gradle 那个算法一样）" +
            (wrong.length ? `：${wrong.join("、")} 对不上` : ""));
        check(CHAT_UI_FILE_NAMES.every((name) => /^[0-9a-f]{10}$/.test(manifest[name] || "")), "指纹都是 10 个十六进制字符");

        // 3. 跟页面 HTML 里引的那几个 ?v= 一个一个对——手机上是靠这个判“旧没旧”的
        const referenced = Object.fromEntries(
            Array.from(page.matchAll(/\/media\/([\w.-]+)\?v=([0-9a-f]+)/g)).map((m) => [m[1], m[2]]));
        const mismatched = Object.keys(referenced).filter((name) => referenced[name] !== manifest[name]);
        check(Object.keys(referenced).length > 0, `页面 HTML 里带着指纹引了 ${Object.keys(referenced).length} 份`);
        check(mismatched.length === 0, "清单跟页面 HTML 里引的指纹一模一样" +
            (mismatched.length ? `：${mismatched.join("、")} 不一样` : ""));

        // 4. “旧了”真的认得出来：拿一份改了几个字节的文件去比，指纹得变
        const sample = CHAT_UI_FILE_NAMES[0];
        const edited = path.join(__dirname, ".scratch", "apk-bundle-" + sample);
        fs.mkdirSync(path.dirname(edited), { recursive: true });
        fs.writeFileSync(edited, fs.readFileSync(path.join(MEDIA_DIR, sample)) + "\n/* 改过的 */\n");
        check(hashOf(edited) !== manifest[sample], `文件改了就认得出是旧的（${sample}）`);

        // 5. 只认 GET / HEAD，并且不许缓存
        const post = await fetch(base + "/media-manifest.json", { method: "POST" });
        check(post.status === 405, "POST 给 405");
        check(/no-store/.test((await get("/media-manifest.json")).headers.get("cache-control") || ""), "带 no-store");
    } finally {
        await harness.stop();
    }
    console.log(failed === 0 ? "\n全部通过。" : `\n${failed} 条没过。`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});

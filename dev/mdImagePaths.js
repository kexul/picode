// @ts-nocheck
/**
 * mdImagePaths —— 验「正文里的图片路径放宽到整机」。
 *
 *   npm run web:shot -- --fake-pi --script dev/mdImagePaths.js
 *
 * 真后端、真网页服务、真界面文件（模型是假的，消息直接往页面里投），验的是：
 *   1. 会话目录里的相对写法照旧显示（走 `/site/` 那条地址）；
 *   2. 整机上的绝对路径（`C:/…`、`/home/…`）与 `file:///…` 也显示（走 `/file?anywhere=1`）；
 *   3. 跳出会话目录的 `../x.png` 也显示；文件侧边栏里打开的 `.md` 同样（按文档自己那一层算）；
 *   4. 外站地址（`https://…`）原样不动、不显示（页面不往外站发请求）；
 *   5. 那条放宽的地址只认图片：非图片 403、带 download=1 也 403；不带 anywhere=1 时
 *      会话目录外的文件照旧 403（文件那道边界没跟着放开）。
 *
 * 测试用的图片现写：会话目录里一张、会话目录外面（系统的临时目录）一张、会话目录的上一层一张，
 * 跑完删掉。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const REL_INSIDE = "md-img-inside.png";
const REL_PARENT = "md-img-parent.png";

/** 图上标的那句话：几张图按顺序排在一段假消息里。 */
const HEADING = "几张图：";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async (page) => {
    const checks = [];
    const check = (name, pass, detail) => {
        checks.push([name, !!pass]);
        console.log((pass ? "✓ " : "✗ ") + name + (detail === undefined ? "" : "   " + detail));
    };

    await page.waitReady();
    await page.sleep(300);

    const info = JSON.parse(await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return JSON.stringify({
            cwd: (((document.getElementById("sessionName") || {}).dataset || {}).cwd) || "",
            sessionId: pane ? (pane.dataset.sessionId || "") : "",
        });
    `));
    if (!info.cwd || !info.sessionId) { throw new Error("拿不到会话目录，验不了：" + JSON.stringify(info)); }
    const cwd = info.cwd;

    // 三张图：会话目录里 / 系统临时目录（整机别处）/ 会话目录的上一层
    const writePng = require("./makePng.js").writeSamplePng;
    const insideFile = path.join(cwd, REL_INSIDE);
    writePng(insideFile, 240, 120);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-md-img-"));
    const outsideFile = path.join(outDir, "md-img-outside.png");
    writePng(outsideFile, 240, 120);
    const parentFile = path.join(path.dirname(cwd), REL_PARENT);
    writePng(parentFile, 240, 120);

    const slashes = (p) => p.replace(/\\/g, "/");
    const external = "https://example.invalid/x.png";
    const text = [
        HEADING,
        "",
        "![](" + REL_INSIDE + ")",
        "",
        "![](../" + REL_PARENT + ")",
        "",
        "![](" + slashes(outsideFile) + ")",
        "",
        "![](file:///" + slashes(outsideFile) + ")",
        "",
        "![](" + external + ")",
        "",
    ].join("\n");

    try {
        await page.eval(`window.postMessage({ type: "assistantFull", text: ${JSON.stringify(text)} }, "*"); return true;`);
        await page.sleep(1500);

        const seen = JSON.parse(await page.eval(`
            const msgs = Array.from(document.querySelectorAll(".session-view:not(.off) .msg"));
            const msg = msgs.reverse().find((m) => m.innerText.indexOf(${JSON.stringify(HEADING)}) >= 0);
            if (!msg) { return JSON.stringify({ found: false }); }
            const imgs = Array.from(msg.querySelectorAll("img")).map((el) => ({
                src: el.getAttribute("src") || "",
                loaded: el.complete && el.naturalWidth > 0,
                width: el.naturalWidth,
            }));
            return JSON.stringify({ found: true, imgs: imgs });
        `));
        if (!seen.found) { throw new Error("页面里找不到那条假消息"); }
        const imgs = seen.imgs || [];
        check("五张图都在（顺序照正文）", imgs.length === 5, "拿到 " + imgs.length + " 张");
        const [inside, parent, outside, fileUrl, url] = imgs;

        check("会话目录里的相对路径：走 /site/ 那条地址，显示出来了",
            inside && inside.src.indexOf("/site/") === 0 && inside.loaded, inside && inside.src);
        check("跳出会话目录的 ../x.png：走 /file?anywhere=1，显示出来了",
            parent && parent.src.indexOf("anywhere=1") > 0 && parent.loaded, parent && parent.src);
        check("整机别处的绝对路径：走 /file?anywhere=1，显示出来了",
            outside && outside.src.indexOf("anywhere=1") > 0 && outside.loaded,
            outside && (outside.src + "  宽 " + outside.width));
        check("file:/// 开头的本机地址：同样显示出来了",
            fileUrl && fileUrl.src.indexOf("anywhere=1") > 0 && fileUrl.loaded, fileUrl && fileUrl.src);
        check("外站地址原样留着、不显示", url && url.src === external && !url.loaded, url && (url.src + "  加载 " + url.loaded));

        // 那条放宽地址自己的规矩：只认图片、不给下载；不带开关时会话目录外照旧 403
        const probe = JSON.parse(await page.eval(`
            return (async () => {
                const sid = ${JSON.stringify(info.sessionId)};
                const q = (p, extra) => "/file?session=" + encodeURIComponent(sid) + (extra || "") +
                    "&path=" + encodeURIComponent(p);
                const loose = (p, extra) => q(p, "&anywhere=1" + (extra || ""));
                const image = await fetch(loose(${JSON.stringify(slashes(outsideFile))}), { cache: "no-store" });
                const notImage = await fetch(loose(${JSON.stringify(slashes(path.join(cwd, "说明.txt")))}));
                const download = await fetch(loose(${JSON.stringify(slashes(outsideFile))}, "&download=1"));
                const strict = await fetch(q(${JSON.stringify(slashes(outsideFile))}));
                return JSON.stringify({
                    imageStatus: image.status,
                    imageType: image.headers.get("Content-Type") || "",
                    notImageStatus: notImage.status,
                    downloadStatus: download.status,
                    strictStatus: strict.status,
                });
            })();
        `));
        check("放宽的那条：整机上的图片 200、按图片类型给",
            probe.imageStatus === 200 && probe.imageType.indexOf("image/") === 0, JSON.stringify(probe));
        check("放宽的那条只认图片：非图片 403", probe.notImageStatus === 403, String(probe.notImageStatus));
        check("放宽的那条不给下载：带 download=1 回 403", probe.downloadStatus === 403, String(probe.downloadStatus));
        check("不带 anywhere=1：会话目录外照旧 403（文件那道边界没动）", probe.strictStatus === 403, String(probe.strictStatus));

        // 文件侧边栏里打开一份 .md：那边按文档自己所在的那一层算路径（baseDir），图也得能显示
        const mdDir = path.join(cwd, "md-sub");
        fs.mkdirSync(mdDir, { recursive: true });
        const mdFile = path.join(mdDir, "note.md");
        writePng(path.join(mdDir, "pic.png"), 240, 120);
        fs.writeFileSync(mdFile, "# 图\n\n![](pic.png)\n\n![](../" + REL_INSIDE + ")\n\n![](" + slashes(outsideFile) + ")\n", "utf8");
        try {
            const mdLinkText = "看这份文档：\n\n`md-sub/note.md`\n";
            await page.eval(`window.postMessage({ type: "assistantFull", text: ${JSON.stringify(mdLinkText)} }, "*"); return true;`);
            await page.sleep(600);
            const clicked = await page.eval(`
                const link = Array.from(document.querySelectorAll("a.file-link"))
                    .find((a) => a.getAttribute("data-file") === "md-sub/note.md");
                if (!link) { return false; }
                link.click();
                return true;
            `);
            check("点开那份 .md（文件侧边栏里按文档自己那一层算路径）", clicked, String(clicked));
            let docImgs = [];
            for (let i = 0; i < 40; i++) {
                docImgs = JSON.parse(await page.eval(`
                    return JSON.stringify(Array.from(document.querySelectorAll(".file-md img")).map((el) => ({
                        src: el.getAttribute("src") || "",
                        loaded: el.complete && el.naturalWidth > 0,
                    })));
                `));
                if (docImgs.length >= 3 && docImgs.every((x) => x.loaded)) { break; }
                await sleep(200);
            }
            check("那份 .md 里的图都显示出来了（同层的走 /site/，跳出去的与绝对路径走 /file?anywhere=1）",
                docImgs.length === 3 && docImgs.every((x) => x.loaded)
                && docImgs[0].src.indexOf("/site/") === 0
                && docImgs.slice(1).every((x) => x.src.indexOf("anywhere=1") > 0),
                JSON.stringify(docImgs));
        } finally {
            try { fs.rmSync(mdDir, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
        }

        await page.shot("md-image-paths.png");
    } finally {
        for (const file of [insideFile, outsideFile, parentFile]) {
            try { fs.unlinkSync(file); } catch { /* 没建成就算了 */ }
        }
        try { fs.rmdirSync(outDir); } catch { /* 删不掉就算了 */ }
    }

    const failed = checks.filter((c) => !c[1]).map((c) => c[0]);
    console.log("\n=== 判断 ===");
    console.log("通过 " + (checks.length - failed.length) + " / " + checks.length);
    if (failed.length) { throw new Error("有 " + failed.length + " 项没通过：\n  - " + failed.join("\n  - ")); }
};

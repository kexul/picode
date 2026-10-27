// @ts-nocheck
/**
 * htmlPreview —— 验「文件侧边栏里点 .html，直接看到渲染出来的网页」。
 *
 *   npm run web:shot -- --fake-pi --script dev/htmlPreview.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的），验的是外面看得见的行为：
 *   1. 点消息流里的 .html 链接，左边那一列里出现一个 iframe（不是一行一行的源码、没有行号）；
 *   2. 页面里的相对引用由浏览器自己接着取：`./html-site.css` 那份样式生效、
 *      `./html-site.js` 那段脚本真跑了（这两个子请求走的也是 `/site/` 那条地址）；
 *   3. 链接里带的行号（`:2`）在网页这条路上等于没带，不报错；
 *   4. 文件被改过以后，这一列不用重新点链接就把那个 iframe 重载一遍（问的是 HEAD，改过才重载）；
 *      切到别的标签再切回来时那个 iframe 不重新加载（页面里的滚动、输入、跑着的脚本都得还在）；
 *   5. 那条 `/site/` 地址的规矩：HEAD 给修改时间、不存在的文件 404、会话目录外面的 403。
 *
 * 测试用的文件（html-site.html / .css / .js）现写进会话目录（dev/.scratch），那个目录不进版本库。
 */
const fs = require("fs");
const path = require("path");

const PAGE = { html: "html-site.html", css: "html-site.css", js: "html-site.js" };
const TITLE_BEFORE = "相对样式与脚本";
const TITLE_AFTER = "改过之后";
/** 链接里带一个行号：网页这条路上它等于没带（跟 markdown 那个特例一样）。 */
const LINK_LINE = 2;
const CSS_TEXT = "#site-css { color: rgb(0, 128, 0); }\nbody { margin: 0; padding: 8px; }\n";
const JS_TEXT = "document.getElementById('site-script').textContent = '脚本跑了';\n";
/** 会话目录外面的一个真文件：拿它验「只看得到会话目录里的东西」那条边界。 */
const OUTSIDE_ABS = process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/hostname";

function pageHtml(title) {
    return "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\">\n"
        + "<link rel=\"stylesheet\" href=\"./" + PAGE.css + "\">\n"
        + "<title>" + title + "</title></head>\n"
        + "<body><h1 id=\"site-title\">" + title + "</h1>\n"
        + "<p id=\"site-css\">样式没生效</p>\n"
        + "<div id=\"site-script\">脚本没跑</div>\n"
        + "<script src=\"./" + PAGE.js + "\"></script>\n"
        + "</body></html>\n";
}

/** 消息流里那段带链接的假消息（点它开左边那一列）。 */
const LINK_TEXT = "看这张网页：\n\n`" + PAGE.html + ":" + LINK_LINE + "`\n";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async (page) => {
    const checks = [];
    const check = (name, pass, detail) => {
        checks.push([name, !!pass]);
        console.log((pass ? "✓ " : "✗ ") + name + (detail === undefined ? "" : "   " + detail));
    };

    await page.waitReady();
    await page.sleep(500);

    const sessionInfo = JSON.parse(await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return JSON.stringify({
            cwd: (((document.getElementById("sessionName") || {}).dataset || {}).cwd) || "",
            sessionId: pane ? (pane.dataset.sessionId || "") : "",
        });
    `));
    check("页面上说得出会话跑在哪个目录", sessionInfo.cwd !== "" && sessionInfo.sessionId !== "",
        JSON.stringify(sessionInfo));
    const cwd = sessionInfo.cwd;
    if (!cwd) { throw new Error("拿不到会话目录，验不了"); }

    // 1. 会话目录里摆一张网页（连同它的样式与脚本）
    fs.writeFileSync(path.join(cwd, PAGE.html), pageHtml(TITLE_BEFORE), "utf8");
    fs.writeFileSync(path.join(cwd, PAGE.css), CSS_TEXT, "utf8");
    fs.writeFileSync(path.join(cwd, PAGE.js), JS_TEXT, "utf8");

    // 2. 投一条带链接的假消息，点它
    await page.eval(`for (const m of ${JSON.stringify([{ type: "assistantFull", text: LINK_TEXT }])}) { window.postMessage(m, "*"); } return true;`);
    await page.sleep(500);
    const clicked = await page.eval(`
        const links = Array.from(document.querySelectorAll("a.file-link"));
        const hit = links.find((a) => (a.getAttribute("data-file") || "") === ${JSON.stringify(PAGE.html)});
        if (!hit) { return false; }
        hit.click();
        return true;
    `);
    check("消息流里那张网页的链接点得着", clicked === true);

    // 每个标签各留自己那一块正文（切走只是藏起来，见 chat.js 的 fileTabPage）：
    // 一律从「露着的那一块」查，别从整个 #fileBody 查（那儿同时躺着别的标签的内容）。
    await page.eval(`
        window.__fileView = function () {
            return document.querySelector("#fileBody .file-page:not([hidden])")
                || document.getElementById("fileBody");
        };
        return true;
    `);

    /** 读现在这一列里那个 iframe 的状态（同源，页里的 document 直接读得到）。 */
    const readFrame = async () => JSON.parse(await page.eval(`
        const view = window.__fileView();
        const frame = view.querySelector("iframe.file-site");
        if (!frame) {
            return JSON.stringify({ found: false, lines: view.querySelectorAll(".file-line").length });
        }
        const d = frame.contentDocument;
        if (!d || !d.getElementById("site-title")) {
            return JSON.stringify({ found: true, ready: false, src: frame.getAttribute("src"), lines: 0 });
        }
        const css = d.getElementById("site-css");
        return JSON.stringify({
            found: true,
            ready: true,
            src: frame.getAttribute("src") || "",
            sandbox: frame.getAttribute("sandbox") || "",
            title: (d.getElementById("site-title") || {}).textContent || "",
            script: (d.getElementById("site-script") || {}).textContent || "",
            color: css ? getComputedStyle(css).color : "",
            lines: view.querySelectorAll(".file-line").length,
        });
    `));

    /** 等那个 iframe 里出现某个标题（重载是异步的）。 */
    const waitFrame = async (wantedTitle, timeoutMs) => {
        const limit = Date.now() + (timeoutMs || 8000);
        let last = null;
        while (Date.now() < limit) {
            last = await readFrame();
            if (last.found && last.ready && last.title === wantedTitle) { return last; }
            await sleep(200);
        }
        return last;
    };

    const first = await waitFrame(TITLE_BEFORE);
    check("点开就摆出一个 iframe（不是一行一行带行号的源码）",
        first.found && first.ready && first.lines === 0, JSON.stringify(first));
    check("iframe 吃的是 /site/ 那条地址", first.found && first.src.indexOf("/site/") === 0, first.src);
    await page.shot("html-1-render.png");

    // 3. 相对引用：样式真生效、脚本真跑了
    check("页面里 `./" + PAGE.css + "` 那份样式生效", first.color === "rgb(0, 128, 0)", first.color);
    check("页面里 `./" + PAGE.js + "` 那段脚本跑了", first.script === "脚本跑了", first.script);
    check("链接里带的 `:" + LINK_LINE + "` 没人拿它去停行（网页没有行号）", first.lines === 0, String(first.lines));

    // 4. 改文件：不用重新点链接，这一列自己把那个 iframe 重载一遍
    fs.writeFileSync(path.join(cwd, PAGE.html), pageHtml(TITLE_AFTER), "utf8");
    const after = await waitFrame(TITLE_AFTER, 10000);
    check("文件改过以后这一列自己重载了那张网页", after.found && after.ready && after.title === TITLE_AFTER,
        after.found ? after.title : "没有 iframe");
    check("重载之后样式与脚本照旧生效",
        after.color === "rgb(0, 128, 0)" && after.script === "脚本跑了",
        JSON.stringify({ color: after.color, script: after.script }));
    await page.shot("html-2-reload.png");

    // 4b. 切到别的标签再切回来：那个 iframe 不许重新加载
    //     （一挪位置、一重造，页面里的滚动、输入、跑着的脚本全丢，靠脚本画出来的图表等于白画一遍）
    console.log("在网页里做个记号：" + await page.eval(`
        const view = window.__fileView();
        const frame = view.querySelector("iframe.file-site");
        if (!frame) { return "没有 iframe"; }
        frame.setAttribute("data-mark", "keep");
        try { frame.contentWindow.__mark = "alive"; } catch (e) { return "碰不到那个页面：" + e.message; }
        return "记上了";
    `));
    console.log("点「项目目录」那一格：" + await page.eval(`
        const t = document.querySelector("#fileTabs .file-tab[data-proj='1']");
        if (!t) { return "没有那一格"; }
        t.click();
        return "点了";
    `));
    await page.sleep(600);
    console.log("点回网页那一格：" + await page.eval(`
        const t = Array.from(document.querySelectorAll("#fileTabs .file-tab"))
            .find(function (x) { return x.getAttribute("data-path") === ${JSON.stringify(PAGE.html)}; });
        if (!t) { return "没有那一格"; }
        t.click();
        return "点了";
    `));
    await page.sleep(300);
    const backFrame = JSON.parse(await page.eval(`
        const view = window.__fileView();
        const frame = view.querySelector("iframe.file-site");
        return JSON.stringify({
            same: !!frame && frame.getAttribute("data-mark") === "keep",
            mark: frame && frame.contentWindow ? (frame.contentWindow.__mark || "") : "",
            title: frame && frame.contentDocument
                ? ((frame.contentDocument.getElementById("site-title") || {}).textContent || "") : "",
            frames: view.querySelectorAll("iframe.file-site").length,
        });
    `));
    check("切到别的标签再切回来：还是原来那个 iframe（没重新加载，页面里的状态还在）",
        backFrame.same && backFrame.mark === "alive" && backFrame.title === TITLE_AFTER && backFrame.frames === 1,
        JSON.stringify(backFrame));

    // 5. 那条地址自己的规矩：HEAD 给修改时间、没有的文件 404、目录外的 403
    const probe = JSON.parse(await page.eval(`
        return (async () => {
            const sid = ${JSON.stringify(sessionInfo.sessionId)};
            const base = "/site/" + encodeURIComponent(sid) + "/";
            const head = await fetch(base + ${JSON.stringify(PAGE.html)}, { method: "HEAD", cache: "no-store" });
            const missing = await fetch(base + "no-such-file.html");
            const outside = await fetch(base + ${JSON.stringify(OUTSIDE_ABS)});
            const css = await fetch(base + ${JSON.stringify(PAGE.css)});
            return JSON.stringify({
                headStatus: head.status,
                mtime: head.headers.get("X-File-Mtime") || "",
                headType: head.headers.get("Content-Type") || "",
                cssType: css.headers.get("Content-Type") || "",
                missingStatus: missing.status,
                outsideStatus: outside.status,
            });
        })();
    `));
    check("HEAD 只给头：200、带上修改时间与页面类型",
        probe.headStatus === 200 && probe.mtime !== "" && probe.headType.indexOf("text/html") === 0,
        JSON.stringify(probe));
    check("样式按 text/css 给（浏览器才当样式用）", probe.cssType.indexOf("text/css") === 0, probe.cssType);
    check("没有这个文件回 404", probe.missingStatus === 404, String(probe.missingStatus));
    check("会话目录外面的文件回 403", probe.outsideStatus === 403, String(probe.outsideStatus));

    const failed = checks.filter((c) => !c[1]).map((c) => c[0]);
    console.log("\n=== 判断 ===");
    console.log("通过 " + (checks.length - failed.length) + " / " + checks.length);
    if (failed.length) { throw new Error("有 " + failed.length + " 项没通过：\n  - " + failed.join("\n  - ")); }
};

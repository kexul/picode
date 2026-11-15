// @ts-nocheck
/**
 * copyPath —— 验「看文件的弹窗」顶上那条横条最前面那颗「复制路径」。
 *
 *   npm run web:shot -- --script dev/copyPath.js
 *
 * 验的是外面看得见的行为：
 *   · 开着一份文件时那颗按钮在横条上：排在右边那堆按钮的最前面（写作名 / 标签条之后、铅笔之前），
 *     上面写着「复制路径」，悬停提示写着「复制这个文件的路径」；
 *   · 点它，剪贴板里就是这一份的**完整路径**（会话目录 + 写法），不是文件名、也不是相对写法；
 *   · 再点开第二份（多一格标签），提示变成「复制这 2 份文件的路径」，点一下一次抄两条、
 *     一份一行，顺序跟标签上摆的一样；
 *   · 抄完那四处字变成「已复制」（1.2 秒）再自己变回来；
 *   · 弹窗关了它不露面；正在改文件（横条上是「存」「放弃」）时照样在。
 *
 * 剪贴板是真的：页面是 127.0.0.1（算安全来源），浏览器里 navigator.clipboard 能用；
 * 脚本另外把 writeText 也记一份，读回剪贴板对不上时好知道是哪一头的事。
 */
const fs = require("fs");
const path = require("path");
const { SCRATCH_DIR } = require("./harness.js");

const FILE_A = "copy-path-a.js";
const FILE_B = "copy-path-b.js";
const TEXT_A = ["const a = 1;", "", "module.exports = { a };", ""].join("\n");
const TEXT_B = ["function b() {", "    return 2;", "}", ""].join("\n");

/** 两个文件链接：点一下就在弹窗里开一份。 */
const LINK_TEXT = "看这两个文件：\n\n`" + FILE_A + ":1` 和 `" + FILE_B + ":2`。\n";

module.exports = async (page) => {
    const checks = [];
    const check = (name, pass, detail) => {
        checks.push([name, !!pass]);
        console.log((pass ? "✓ " : "✗ ") + name + (detail === undefined ? "" : "   " + detail));
    };

    await page.waitReady();
    await page.sleep(400);

    // 会话目录（跟 fileSidebar.js 一个写法：顶条上那格写着这一轮跑在哪儿）
    const cwd = (await page.eval(`
        const btn = document.getElementById("sessionName");
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        return JSON.stringify({
            cwd: ((btn || {}).dataset || {}).cwd || "",
            sessionId: pane ? (pane.dataset.sessionId || "") : "",
        });
    `)) || "{}";
    const info = JSON.parse(cwd);
    const base = info.cwd || SCRATCH_DIR;
    fs.writeFileSync(path.join(base, FILE_A), TEXT_A, "utf8");
    fs.writeFileSync(path.join(base, FILE_B), TEXT_B, "utf8");

    // 剪贴板：先把浏览器那个接口记一份（读回对不上时好分辨是哪一头），能授予权限就真读一遍
    const origin = await page.eval("return location.origin");
    let canRead = false;
    try {
        await page.cdp.send("Browser.grantPermissions", {
            origin,
            permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
        });
        canRead = true;
    } catch { /* 老浏览器不给这份权限就只验记下来的那份 */ }
    await page.eval(`
        window.__clip = [];
        const proto = navigator.clipboard;
        if (proto && proto.writeText) {
            const original = proto.writeText.bind(proto);
            proto.writeText = function (text) { window.__clip.push(text); return original(text); };
        }
        return true;
    `);
    const readClipboard = async () => {
        const seen = await page.eval("return window.__clip.length ? window.__clip[window.__clip.length - 1] : null");
        if (!canRead) { return seen; }
        const real = await page.eval(`
            if (!navigator.clipboard || !navigator.clipboard.readText) { return null; }
            return navigator.clipboard.readText().then(function (t) { return t; }, function () { return null; });
        `);
        return real === null ? seen : real;
    };

    // 投消息、点链接开弹窗
    const open = async (file) => {
        await page.eval(`
            const a = Array.from(document.querySelectorAll("a.file-link")).find(function (x) {
                return x.getAttribute("data-file") === ${JSON.stringify(file)};
            });
            if (!a) { return false; }
            a.click();
            return true;
        `);
        await page.sleep(900);
    };
    await page.eval(`for (const m of ${JSON.stringify([{ type: "assistantFull", text: LINK_TEXT }])}) { window.postMessage(m, "*"); } return true;`);
    await page.sleep(500);
    await open(FILE_A);

    // —— 一份的时候：按钮在、位置对、提示对 ——
    const layout = JSON.parse(await page.eval(`
        const btn = document.getElementById("fileCopyPath");
        const bar = document.getElementById("fileBar");
        if (!btn || !bar) { return JSON.stringify({ missing: true }); }
        const order = Array.from(bar.children).map(function (el) { return el.id || el.className; });
        return JSON.stringify({
            hidden: btn.hidden,
            title: btn.title,
            label: btn.textContent,
            beforeEdit: btn.nextElementSibling ? btn.nextElementSibling.id : "",
            afterName: btn.previousElementSibling ? (btn.previousElementSibling.id || btn.previousElementSibling.className) : "",
            order: order,
        });
    `));
    check("开着一份时「复制路径」那颗按钮在横条上露面", !layout.missing && layout.hidden === false, JSON.stringify(layout.title));
    check("它排在右边那堆按钮的最前面（写法后面、铅笔前面）", layout.beforeEdit === "fileEdit" && layout.afterName === "file-bar-name", layout.order && layout.order.join(" | "));
    check("上面写着「复制路径」四个字", layout.label === "复制路径", layout.label);
    check("悬停提示写着「复制这个文件的路径」", layout.title === "复制这个文件的路径", layout.title);
    await page.shot("copy-path-one.png");

    // —— 点一下：完整路径进剪贴板 ——
    await page.eval('document.getElementById("fileCopyPath").click(); return true;');
    await page.sleep(300);
    const wantOne = path.join(base, FILE_A);
    const gotOne = await readClipboard();
    check("点一下抄的是这一份的完整路径", gotOne === wantOne, JSON.stringify(gotOne));
    check("抄的不是文件名本身", gotOne !== FILE_A);
    const afterOne = JSON.parse(await page.eval(`
        const btn = document.getElementById("fileCopyPath");
        return JSON.stringify({ done: btn.classList.contains("done"), label: btn.textContent });
    `));
    check("抄完那四个字变成「已复制」", afterOne.done && afterOne.label === "已复制", JSON.stringify(afterOne));
    await page.shot("copy-path-done.png");
    await page.sleep(1500);
    const restored = JSON.parse(await page.eval(`
        const btn = document.getElementById("fileCopyPath");
        return JSON.stringify({ done: btn.classList.contains("done"), label: btn.textContent });
    `));
    check("过一会儿自己变回「复制路径」", !restored.done && restored.label === "复制路径", JSON.stringify(restored));

    // —— 多开一份：一次抄两条，一份一行 ——
    await open(FILE_B);
    const many = JSON.parse(await page.eval(`
        const btn = document.getElementById("fileCopyPath");
        const tabs = Array.from(document.querySelectorAll("#fileViewTabs .file-tab .file-tab-name")).map(function (el) { return el.textContent; });
        return JSON.stringify({ tabs: tabs, hidden: btn.hidden, title: btn.title });
    `));
    check("开着两份时排了标签、按钮还在", many.tabs.length === 2 && many.hidden === false, JSON.stringify(many.tabs));
    check("提示变成「复制这 2 份文件的路径」", many.title === "复制这 2 份文件的路径", many.title);
    await page.eval('document.getElementById("fileCopyPath").click(); return true;');
    await page.sleep(300);
    const wantTwo = path.join(base, FILE_A) + "\n" + path.join(base, FILE_B);
    const gotTwo = await readClipboard();
    // 浏览器读回来的换行是 CRLF（系统剪贴板本来就这样），比的时候统一成 \n
    check("点一下把两份的完整路径都抄了、一份一行", String(gotTwo || "").replace(/\r\n/g, "\n") === wantTwo, JSON.stringify(gotTwo));
    await page.shot("copy-path-two.png");

    // —— 改文件的时候照样在；关掉弹窗就收起来 ——
    await page.eval('document.getElementById("fileEdit").click(); return true;');
    await page.sleep(600);
    const editing = JSON.parse(await page.eval(`
        const btn = document.getElementById("fileCopyPath");
        const edit = document.getElementById("fileEdit");
        return JSON.stringify({ copyHidden: btn.hidden, editHidden: edit.hidden });
    `));
    check("正在改文件（铅笔换成了存 / 放弃）时复制那颗照样在", editing.copyHidden === false && editing.editHidden === true, JSON.stringify(editing));
    await page.eval('document.getElementById("fileRevert").click(); return true;');
    await page.sleep(400);
    await page.eval('document.getElementById("fileCloseFile").click(); return true;');
    await page.sleep(600);
    const closed = JSON.parse(await page.eval(`
        const btn = document.getElementById("fileCopyPath");
        const bar = document.getElementById("fileBar");
        return JSON.stringify({ barHidden: bar.hidden, copyHidden: btn.hidden });
    `));
    check("关掉弹窗以后它跟着横条一起收起来", closed.barHidden === true, JSON.stringify(closed));

    const failed = checks.filter((c) => !c[1]);
    console.log("\n" + (checks.length - failed.length) + " / " + checks.length + " 项对上了");
    if (failed.length) {
        console.log("没对上：" + failed.map((c) => c[0]).join("；"));
        throw new Error("复制路径那一摊有 " + failed.length + " 项没对上");
    }
};

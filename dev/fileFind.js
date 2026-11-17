// @ts-nocheck
/**
 * fileFind —— 验「看文件的弹窗」里那个找字（Ctrl+F，见 media/chat.js 的「弹窗里找字」那一段）。
 *
 *   npm run web:shot -- --width 1200 --height 820 --script dev/fileFind.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的；这一遍压根不跟模型说话），
 * 验的是外面看得见的行为：
 *   1. 弹窗里按 Ctrl+F：弹窗顶条底下长出那条查找条、光标在框里，浏览器自己那个查找被拦下来；
 *   2. 敲一段字：说得出一共有几处（「1/3」）、停在眼下看着的地方最近的那一处；
 *   3. 回车下一处、Shift+回车上一处：那个「第几/共几」跟着走，停的那一行真的滚到眼前
 *      （文件比页面里摆得下的行多：滚出去的那些也得找得到 —— 这正是不能靠浏览器那个查找的原因）；
 *   4. Esc 只收查找条，弹窗还开着；再按 Ctrl+F 又是刚才那个关键词；
 *   5. 换成一份 diff 也能找，而且同一句在左右两栏都有时只算一处；
 *   6. 正在改字那一态（文本框）没有那条：Ctrl+F 不弹它（这一份挑 `.js`：纯文本没有那颗铅笔，进不了那一态）。
 *
 * 测试文件现写进会话目录（dev/.scratch），那个目录不进版本库，随便造。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { SCRATCH_DIR } = require("./harness.js");

const FILE = "0-find.js";
const TOTAL_LINES = 900;
const HITS = [40, 150, 260];
/** markdown 那一份（排好版那份文档里也能找）：三处 NEEDLE 分别落在段落、列表项、代码块里。 */
const MD_FILE = "0-find.md";
/** 换行的写法（不写 "\n" 是因为这一份脚本本身就是在外面拼出来再落盘的，转义容易岔） */
const NL = String.fromCharCode(10);
const MD_TEXT = [
    "# 标题",
    "",
    "第一段里有一个 NEEDLE。",
    "",
    "- 列表里也有 NEEDLE",
    "- 这一行没有",
    "",
    "```",
    "NEEDLE 在代码块里也算",
    "```",
    "",
    "最后一行没有。",
].join(NL) + NL;

/** 那一份 900 行的测试文件：三行里带 NEEDLE，其余都是普通的一行。
 *  @param changeLine 非 0 就把那一行改写掉（造一处改动，给“一份 diff 里也能找”那一遍用） */
function makeText(changeLine) {
    const lines = [];
    for (let i = 1; i <= TOTAL_LINES; i += 1) {
        if (changeLine && i === changeLine) { lines.push("line " + i + " 改过的这一行"); continue; }
        lines.push(HITS.indexOf(i) >= 0 ? "line " + i + " NEEDLE here" : "line " + i + " 普通的这一行");
    }
    return lines.join("\n") + "\n";
}

/** 在某个目录里跑一句 git（这一跑的目录在 dev/.scratch 里，不进版本库，随便弄）。 */
function git(dir, ...args) {
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: dir, stdio: "ignore" });
}

/**
 * 这一跑自己的干净工作目录：会话目录就是它，`git init` + 提交一份，那就是「最近一次提交」。
 * 不拿 dev/.scratch 本身当仓库：那个目录里堆着历次调试留下的东西，`git add -A` 要卡几十秒；
 * 更要紧的是放个 `.gitignore` 进去会把别的调试（文件搜索的内容那一档走 ripgrep）一起挡了。
 */
const WORK = path.join(SCRATCH_DIR, "findWork");

/** 把这一份铺好的东西提交上去（那就是“最近一次提交”）。 */
function initRepo(dir) {
    git(dir, "init", "-q", ".");
    git(dir, "add", "-A");
    git(dir, "-c", "user.email=dev@example.invalid", "-c", "user.name=dev", "commit", "-qm", "基线");
}

module.exports = async (page) => {
    const checks = [];
    const check = (name, pass, detail) => {
        checks.push([name, !!pass]);
        console.log((pass ? "✓ " : "✗ ") + name + (detail === undefined ? "" : "   " + detail));
    };
    // 这一跑自己的干净工作目录（会话目录就是它）；铺好这一份，提交一道当基线
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(path.join(WORK, FILE), makeText(0), "utf8");
    fs.writeFileSync(path.join(WORK, MD_FILE), MD_TEXT, "utf8");
    initRepo(WORK);
    const dir = WORK;

    /** 按一个键（带修饰键）：Ctrl=2、Shift=8。 */
    const press = async (key, code, vk, modifiers) => {
        await page.cdp.send("Input.dispatchKeyEvent", {
            type: "keyDown", key, code, modifiers,
            windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        });
        await page.cdp.send("Input.dispatchKeyEvent", {
            type: "keyUp", key, code, modifiers,
            windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        });
    };
    const ctrlF = () => press("f", "KeyF", 70, 2);
    const enter = (shift) => press("Enter", "Enter", 13, shift ? 8 : 0);
    const esc = () => press("Escape", "Escape", 27, 0);
    /** 往查找框里敲一段字（先全选再插入，跟人选中后打字一样）。 */
    const typeFind = async (text) => {
        await page.eval(`const el = document.getElementById("fileFindInput"); el.focus(); el.select(); return true;`);
        if (!text) {
            await page.cdp.send("Input.dispatchKeyEvent", {
                type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46,
            });
            await page.cdp.send("Input.dispatchKeyEvent", {
                type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46,
            });
        } else {
            await page.cdp.send("Input.insertText", { text });
        }
        await page.sleep(180);
    };

    /** 查找条与正文现在的样子：开没开、光标在不在框里、那个数、停的那一行是哪一行、在不在眼前。 */
    const state = async () => JSON.parse(await page.eval(`
        const bar = document.getElementById("fileFind");
        const input = document.getElementById("fileFindInput");
        const body = document.getElementById("fileBody");
        const cur = document.querySelector("#fileBody .file-line.find.hit, #fileBody .file-line.hit");
        const br = body.getBoundingClientRect();
        const cr = cur ? cur.getBoundingClientRect() : null;
        return JSON.stringify({
            shown: !!bar && !bar.hidden && getComputedStyle(bar).display !== "none",
            focused: document.activeElement === input,
            query: input ? input.value : "",
            count: (document.getElementById("fileFindCount") || {}).textContent || "",
            curText: cur ? cur.textContent.trim().split("\\n")[0] : "",
            curVisible: !!cr && cr.top >= br.top - 2 && cr.bottom <= br.bottom + 2,
            scrollTop: Math.round(body.scrollTop),
            viewerOpen: document.body.classList.contains("file-view"),
            prevented: !!window.__findPrevented,
            findMarks: document.querySelectorAll("#fileBody .file-line.find").length,
        });
    `));

    await page.waitReady();
    await page.sleep(600);
    // 拦没拦下来：在 window 上看最后那一下的 defaultPrevented（document 上那两个监听比它先跑）
    await page.eval(`
        window.__findPrevented = false;
        window.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "f") { window.__findPrevented = e.defaultPrevented; }
        });
        return true;
    `);
    // 会话目录就是 WORK：开一个新会话进去（跟 dev/fileEdit.js 那一遍一个做法）
    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "newSessionInWorkspace", path: ${JSON.stringify(WORK)} });
        return true;
    `);
    await page.sleep(2500);
    const open = await page.eval(`return document.body.classList.contains("file-view");`);
    if (!open) { await page.click("#fileSidebarBtn"); await page.sleep(700); }
    const rowClick = await page.eval(`
        const row = Array.from(document.querySelectorAll("#dirPane .file-entry"))
            .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(FILE)}; });
        if (!row) { return "没找到那一行"; }
        row.click();
        return "点了";
    `);
    await page.sleep(900);
    const opened = await state();
    check("点清单里那个文件：弹窗开着、还没那条查找条",
        rowClick === "点了" && opened.viewerOpen && !opened.shown,
        JSON.stringify({ rowClick, viewerOpen: opened.viewerOpen, findShown: opened.shown }));

    // 1. Ctrl+F：弹出查找条、光标在框里、浏览器那个查找被拦下
    await ctrlF();
    await page.sleep(250);
    const afterKey = await state();
    check("弹窗里按 Ctrl+F：顶条底下长出查找条、光标就在框里",
        afterKey.shown && afterKey.focused, JSON.stringify({ shown: afterKey.shown, focused: afterKey.focused }));
    check("这一下被拦下来了（不会又弹出浏览器自己那个查找）", afterKey.prevented === true, String(afterKey.prevented));
    await page.shot("find-1-open.png");

    // 2. 敲字：说得出一共几处、停在哪一处
    await typeFind("NEEDLE");
    const typed = await state();
    check("敲一段字：说得出一共有几处（3 处里停在第 1 处）",
        typed.count === "1/3", typed.count);
    check("对上的那几行涂上了底（页面里只摆看得见的那几百行，所以只数得着这一段里的）",
        typed.findMarks >= 1 && typed.curText.indexOf("NEEDLE") >= 0,
        JSON.stringify({ marks: typed.findMarks, cur: typed.curText }));
    check("停的那一处就在眼前", typed.curVisible === true, JSON.stringify({ cur: typed.curText, top: typed.scrollTop }));
    await page.shot("find-2-typed.png");

    // 3. 回车下一处：那个数跟着走、那一行真滚到眼前（这一行本来在页面里压根没有）
    await enter(false);
    await page.sleep(260);
    const next1 = await state();
    check("回车：到第 2 处，并且那一行真滚到了眼前（不是只在看得见的那几百行里找）",
        next1.count === "2/3" && next1.curVisible && next1.curText.indexOf("line 150") >= 0,
        JSON.stringify({ count: next1.count, cur: next1.curText, visible: next1.curVisible }));
    check("翻到下一处时正文确实滚了", next1.scrollTop !== typed.scrollTop,
        JSON.stringify({ from: typed.scrollTop, to: next1.scrollTop }));
    await page.shot("find-3-next.png");
    await enter(false);
    await page.sleep(260);
    const next2 = await state();
    check("再回车：第 3 处（line 260）",
        next2.count === "3/3" && next2.curText.indexOf("line 260") >= 0,
        JSON.stringify({ count: next2.count, cur: next2.curText }));
    await enter(false);
    await page.sleep(260);
    const wrapped = await state();
    check("再回车：绕回第 1 处", wrapped.count === "1/3" && wrapped.curText.indexOf("line 40") >= 0,
        JSON.stringify({ count: wrapped.count, cur: wrapped.curText }));
    await enter(true);
    await page.sleep(260);
    const prev = await state();
    check("Shift+回车：往回一处（绕到最后一处）", prev.count === "3/3", prev.count);
    await enter(true);
    await page.sleep(260);
    const prev2 = await state();
    check("再 Shift+回车：第 2 处，那一行也在眼前",
        prev2.count === "2/3" && prev2.curVisible, JSON.stringify({ count: prev2.count, visible: prev2.curVisible }));

    // 4. Esc：只收查找条，弹窗还开着；再按 Ctrl+F 又是刚才那个关键词
    await esc();
    await page.sleep(200);
    const closed = await state();
    check("Esc 只收查找条，弹窗还开着", !closed.shown && closed.viewerOpen,
        JSON.stringify({ findShown: closed.shown, viewerOpen: closed.viewerOpen }));
    check("收起来以后正文上的那层底也没了", closed.findMarks === 0, String(closed.findMarks));
    await ctrlF();
    await page.sleep(250);
    const reopened = await state();
    check("再按 Ctrl+F：关键词还是刚才那个、又找回来了",
        reopened.shown && reopened.query === "NEEDLE" && reopened.count === "2/3",
        JSON.stringify({ query: reopened.query, count: reopened.count }));

    // 敲一个对不上的：写「没有」，上下两颗按不动
    await typeFind("zzz-no-such-thing");
    const none = JSON.parse(await page.eval(`
        return JSON.stringify({
            count: (document.getElementById("fileFindCount") || {}).textContent || "",
            prev: document.getElementById("fileFindPrev").disabled,
            next: document.getElementById("fileFindNext").disabled,
        });
    `));
    check("对不上一个字：写「没有」，上下两颗按不动",
        none.count === "没有" && none.prev && none.next, JSON.stringify(none));
    await typeFind("NEEDLE");

    // 4b. markdown（排好版的那一份）：也走这根条，在排好版的字上包 <mark>；
    //     一处一处跳；收起来时把那几个 <mark> 拆掉、把字还回去。
    await esc();
    await page.sleep(150);
    const mdOpen = await page.eval(`
        document.getElementById("fileCloseFile").click();
        const row = Array.from(document.querySelectorAll("#dirPane .file-entry"))
            .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(MD_FILE)}; });
        if (!row) { return "没找到那一行"; }
        row.click();
        return "点了";
    `);
    await page.sleep(1000);
    await page.eval(`window.__findPrevented = false; return true;`);
    await ctrlF();
    await page.sleep(250);
    await typeFind("NEEDLE");
    const md = JSON.parse(await page.eval(`
        const root = document.querySelector("#fileBody .file-page.active .file-md");
        return JSON.stringify({
            rendered: !!root,
            shown: !document.getElementById("fileFind").hidden,
            prevented: !!window.__findPrevented,
            count: (document.getElementById("fileFindCount") || {}).textContent || "",
            marks: root ? root.querySelectorAll("mark.file-find-mark").length : 0,
            cur: root ? root.querySelectorAll("mark.file-find-mark.cur").length : 0,
        });
    `));
    check("markdown 也归这根查找条（不是浏览器那个）", mdOpen === "点了" && md.rendered && md.shown && md.prevented,
        JSON.stringify(md));
    check("排好版的字上一共有三处（写「1/3」，三处都涂了、停的那一处再深一点）",
        md.count === "1/3" && md.marks === 3 && md.cur === 1,
        JSON.stringify({ count: md.count, marks: md.marks, cur: md.cur }));
    await page.shot("find-5-markdown.png");
    await enter(false);
    await page.sleep(250);
    const mdNext = JSON.parse(await page.eval(`
        const root = document.querySelector("#fileBody .file-page.active .file-md");
        const cur = root ? root.querySelector("mark.file-find-mark.cur") : null;
        const br = document.getElementById("fileBody").getBoundingClientRect();
        const cr = cur ? cur.getBoundingClientRect() : null;
        return JSON.stringify({
            count: (document.getElementById("fileFindCount") || {}).textContent || "",
            cur: cur ? (cur.textContent || "") : "",
            visible: !!cr && cr.top >= br.top - 2 && cr.bottom <= br.bottom + 2,
        });
    `));
    check("回车：跳到第二处（那一段字滚到了眼前）",
        mdNext.count === "2/3" && mdNext.cur === "NEEDLE" && mdNext.visible,
        JSON.stringify(mdNext));
    await esc();
    await page.sleep(200);
    const mdClean = JSON.parse(await page.eval(`
        const root = document.querySelector("#fileBody .file-page.active .file-md");
        return JSON.stringify({
            marks: root ? root.querySelectorAll("mark.file-find-mark").length : 0,
            text: root ? root.textContent : "",
        });
    `));
    check("收起来：那几个 <mark> 拆干净了，字还是原来那些",
        mdClean.marks === 0 && mdClean.text.indexOf("NEEDLE") >= 0 && mdClean.text.indexOf("列表里也有") >= 0,
        JSON.stringify({ marks: mdClean.marks }));

    // 5. 换成一份 diff：也能找，而且同一句在左右两栏都有时只算一处。
    //    造一处改动：把第 149 行改掉（第 150 行那句 NEEDLE 就成了“没变的那行”，左右两栏都有）
    await esc();
    await page.sleep(150);
    fs.writeFileSync(path.join(dir, FILE), makeText(149), "utf8");
    const diffClick = await page.eval(`
        // 「改动」那一格只在打开 / 收到「改动变了」时重问：收起再开一次，让它现问一道
        document.getElementById("fileCloseFile").click();
        document.getElementById("fileSidebarBtn").click();
        return true;
    `);
    await page.sleep(300);
    await page.eval(`document.getElementById("fileSidebarBtn").click(); return true;`);
    await page.sleep(1200);
    const rowFound = await page.eval(`
        const row = Array.from(document.querySelectorAll("#changePane .change-head"))
            .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(FILE)}; });
        if (!row) { return "没找到那一行"; }
        row.click();
        return "点了";
    `);
    await page.sleep(1200);
    await page.eval(`window.__findPrevented = false; return true;`);
    await ctrlF();
    await page.sleep(250);
    await typeFind("NEEDLE");
    const inDiff = JSON.parse(await page.eval(`
        return JSON.stringify({
            shown: !document.getElementById("fileFind").hidden,
            prevented: !!window.__findPrevented,
            count: (document.getElementById("fileFindCount") || {}).textContent || "",
            cells: document.querySelectorAll(".diff2-cell .file-text.find").length,
            cur: !!document.querySelector(".diff2-cell .file-text.find.cur"),
        });
    `));
    check("点「改动」那一行开出一份 diff（左右两栏都在）",
        diffClick === true && rowFound === "点了", JSON.stringify({ rowFound }));
    check("一份 diff 里按 Ctrl+F 也能找", inDiff.shown && inDiff.prevented, JSON.stringify(inDiff));
    check("同一句在左右两栏都有时只算一处（写「1/1」，两栏都涂了底）",
        inDiff.count === "1/1" && inDiff.cells === 2 && inDiff.cur,
        JSON.stringify({ count: inDiff.count, cells: inDiff.cells, cur: inDiff.cur }));
    await page.shot("find-4-diff.png");
    await esc();
    await page.sleep(150);
    // 收尾：这一份 diff 关掉、文件改回干净的样子（下次跑还是从这一份开始）
    fs.writeFileSync(path.join(dir, FILE), makeText(0), "utf8");

    // 6. 正在改字那一态里没有那条：Ctrl+F 不弹它
    await page.sleep(700);
    const backToFile = await page.eval(`
        const row = Array.from(document.querySelectorAll("#dirPane .file-entry"))
            .find(function (r) { return r.getAttribute("data-path") === ${JSON.stringify(FILE)}; });
        if (row) { row.click(); }
        return !!row;
    `);
    await page.sleep(1000);
    const editReady = await page.eval(`
        const btn = document.getElementById("fileEdit");
        if (!btn || btn.hidden) { return false; }
        btn.click();
        return true;
    `);
    await page.sleep(400);
    if (editReady) {
        await page.eval(`window.__findPrevented = false; return true;`);
        await ctrlF();
        await page.sleep(250);
        const editing = await state();
        check("正在改字（文本框）那一态：Ctrl+F 不弹这条（回车 / 输入还得归文本框）",
            !editing.shown && !editing.prevented,
            JSON.stringify({ findShown: editing.shown, prevented: editing.prevented }));
        await page.eval(`document.getElementById("fileRevert").click(); return true;`);
        await page.sleep(300);
        check("（改字那一态验完，已经弃掉了）", backToFile !== false);
    } else {
        check("（这一份没有那颗铅笔，跳过改字那一态）", true);
    }

    const passed = checks.filter((c) => c[1]).length;
    console.log("\n" + passed + "/" + checks.length + " 项通过");
    return checks.every((c) => c[1]);
};

// @ts-nocheck
/**
 * changeSheet —— 验「消息滑到底再往上拖，把改动清单拖出来」这一下。
 *
 *   npm run web:shot -- --width 420 --height 900 --script dev/changeSheet.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的，这一跑也不给模型发消息：
 * 清单里的那一行是脚本自己往会话目录里写文件造出来的，后端直接问 git 就有）。
 * 这一跑自己搭一个小仓库当会话目录、把铺好的文件提交上去，那就是「最近一次提交」。
 *
 * 验的是外面看得见的行为：
 *   1. 消息已经贴到底时，从最底下那一小截（胶囊那一排连它底下的空当）往上拖：底下那一块跟着
 *      手指长起来，但走得比手指短（有阻尼）；
 *   1b. 起手在消息区中间（那一小截上头）：不接，那是正常滚动；
 *   2. 拖到一半时看出两块各占一块：消息区矮下去，这一块的顶边就是消息区的底边（谁也不盖谁）；
 *   3. 松手过线：它留在那儿，高度按内容定、不超过对话那一列的 45%；清单里列着改过的那几个文件
 *      （写的是整条相对写法、右边 +几行 −几行）；
 *   4. 点清单里的一行：打开那份 diff（跟左边文件侧边栏里点一行一个结果）；
 *   5. 拖着它头上那一条往下拉：这一块跟着手指矮下去，松手过了三成收起来，
 *      消息区回到原来的高度、这一块整个藏起来；
 *   6. 只轻轻拉一小截就松手：弹回去，什么也不留；
 *   7. 消息没贴到底（还有一截没看完）时往上拖：不接，那是正常滚动；
 *   8. 点头上那颗叉：收起来。
 *
 * 手指用 CDP 的 Input.dispatchTouchEvent 真派下去（界面里挂的就是 touch 监听）。
 * 造的东西全在 dev/.scratch 里（那个目录不进版本库）。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { SCRATCH_DIR } = require("./harness.js");

/** 这一跑自己的干净工作目录（是一个 git 仓库）。 */
const WORK = path.join(SCRATCH_DIR, "sheetWork");
const EDITED = "说明.md";
const ADDED = "新文件.md";
const BASE = "这是调试用的工作目录。\n";
/** 假 pi 把自己的会话文件也写在会话目录里（真 pi 不会）：拿 .gitignore 挡在清单外面。 */
const GITIGNORE = "fake-session-*.jsonl\n";

function git(dir, ...args) {
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: dir, stdio: "ignore" });
}

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "  ✓ " : "  ✗ ") + label + (detail === undefined ? "" : "：" + detail));
    if (!ok) { failures++; }
}

module.exports = async (page) => {
    await page.waitReady();
    await page.sleep(600);
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

    // ---- 铺一个干净的小仓库当会话目录，提交上去当“最近一次提交” ----
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(path.join(WORK, EDITED), BASE, "utf8");
    fs.writeFileSync(path.join(WORK, ".gitignore"), GITIGNORE, "utf8");
    git(WORK, "init", "-q", ".");
    git(WORK, "add", "-A");
    git(WORK, "-c", "user.email=dev@example.invalid", "-c", "user.name=dev", "commit", "-qm", "基线");
    // 改一份、添一份（就是清单里该长出来的那两行）
    fs.writeFileSync(path.join(WORK, EDITED), BASE + "又多了一行。\n", "utf8");
    fs.writeFileSync(path.join(WORK, ADDED), "新添的一行\n", "utf8");

    await page.eval(`
        acquireVsCodeApi().postMessage({ type: "newSessionInWorkspace", path: ${JSON.stringify(WORK)} });
        return true;
    `);
    for (let t = 0; t < 40; t++) {
        await page.sleep(250);
        const st = await page.eval(`const el = document.getElementById("ctxIcon"); return el ? el.dataset.st : "";`);
        if (st === "idle" || st === "streaming") { break; }
    }
    await page.sleep(800);

    const touch = (type, x, y) => page.cdp.send("Input.dispatchTouchEvent", {
        type: type,
        touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y), id: 1 }],
    });

    /** 底下那一块现在什么样：高矮、藏没藏、清单里有哪几行、两块怎么分的、消息区多高。 */
    const sheetNow = () => page.eval(`
        const root = document.getElementById("changeSheet");
        const body = document.getElementById("changeSheetBody");
        const msgs = document.getElementById("messages");
        const input = document.getElementById("inputArea");
        const bar = document.getElementById("changeSheetBar");
        const stage = document.getElementById("fileStage");
        const r = root ? root.getBoundingClientRect() : null;
        const m = msgs ? msgs.getBoundingClientRect() : null;
        const i = input ? input.getBoundingClientRect() : null;
        const b = bar ? bar.getBoundingClientRect() : null;
        const rows = body ? Array.from(body.querySelectorAll(".change-head")) : [];
        return JSON.stringify({
            exists: !!root,
            hidden: !root || root.classList.contains("hidden"),
            h: r ? Math.round(r.height) : -1,
            top: r ? Math.round(r.top) : -1,
            msgsH: m ? Math.round(m.height) : -1,
            msgsBottom: m ? Math.round(m.bottom) : -1,
            distBottom: (function () {
                const pane = document.querySelector(".session-view:not(.off) .session-pane");
                return pane ? Math.round(pane.scrollHeight - pane.scrollTop - pane.clientHeight) : -1;
            })(),
            inputTop: i ? Math.round(i.top) : -1,
            rows: rows.map(function (el) {
                return {
                    path: el.getAttribute("data-path"),
                    name: ((el.querySelector(".change-path") || {}).textContent || "").trim(),
                    counts: ((el.querySelector(".change-counts") || {}).textContent || "").trim(),
                };
            }),
            note: body && body.querySelector(".file-note") ? body.querySelector(".file-note").textContent : "",
            view: document.body.classList.contains("file-view"),
            stageShown: !!stage && getComputedStyle(stage).display !== "none",
            bar: b ? { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } : null,
            listBox: body ? (function () {
                const r = body.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), h: Math.round(r.height) };
            })() : null,
            listTop: body ? Math.round(body.scrollTop) : -1,
            listScrollable: !!body && body.scrollHeight > body.clientHeight + 2,
        });
    `).then(JSON.parse);

    /** 手指起手的位置：最底下那一小截（改动层只认从这儿起手的上滑，见 chat.js）；
     * midY 是消息区中间，验“起在别处不接”用的。 */
    const box = JSON.parse(await page.eval(`
        const r = document.getElementById("messages").getBoundingClientRect();
        const el = document.querySelector(".session-view:not(.off) .session-pane");
        return JSON.stringify({
            x: r.left, y: r.top, w: r.width, h: r.height,
            atBottom: !!el && el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
        });
    `));
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h - 20;   // 最底下那一小截里（离底 20 像素，避开关着的时候的边线）
    const midY = box.y + Math.round(box.h * 0.6);

    /** 从 (x0,y0) 划到 (x1,y1)：分几步走，走到头可以停下来看看、拍张照。 */
    const drag = async (x0, y0, x1, y1, steps, atEnd) => {
        await touch("touchStart", x0, y0);
        for (let k = 1; k <= steps; k++) {
            await touch("touchMove", x0 + (x1 - x0) * (k / steps), y0 + (y1 - y0) * (k / steps));
            await page.sleep(16);
        }
        if (atEnd) { await atEnd(); }
        await touch("touchEnd", x1, y1);
    };

    // ---- 0. 一开始：这一块是藏着的，消息区占满 ----
    const start = await sheetNow();
    check("界面里搭出了底下那一块（一开始藏着、不占版面）", start.exists && start.hidden && start.h <= 0,
        JSON.stringify({ 藏: start.hidden, 高: start.h }));
    const msgH0 = start.msgsH;

    // ---- 1b. 起手在消息区中间（最底下那一小截的上头）：不接，那是正常滚动 ----
    await drag(cx, midY, cx, midY - 260, 12);
    await page.sleep(700);
    const midStart = await sheetNow();
    check("起手在消息区中间：不接（那一块还藏着）", midStart.hidden && midStart.h <= 0,
        JSON.stringify({ 藏: midStart.hidden, 高: midStart.h }));

    // ---- 1/2. 往上拖 260 像素（分 12 步），拖到一半看看跟手与阻尼 ----
    const PULL = 260;
    let half = null;
    await drag(cx, cy, cx, cy - PULL, 12, async () => {
        half = await sheetNow();
        await page.shot("sheet-pulling.png");
    });
    await page.sleep(600);
    check("拖着的时候它跟着长起来了", half && !half.hidden && half.h > 30,
        JSON.stringify({ 高: half && half.h }));
    check("走得比手指短（有阻尼）", half && half.h > 0 && half.h <= PULL * 0.6,
        String(PULL) + " 像素的手指，它长到 " + (half && half.h));
    check("拖起来那一刻就去要清单了（拖到一半时里面已经有东西、不是一片空白）",
        half && (half.rows.length > 0 || half.note !== ""),
        JSON.stringify({ 行: half && half.rows.length, 小字: half && half.note }));
    check("两块各占一块：消息区矮下去了，这一块的顶边就是消息区的底边",
        half && half.msgsBottom <= half.top + 1 && half.msgsH < msgH0,
        JSON.stringify({ 消息区高: half && half.msgsH, 原来: msgH0, 消息区底: half && half.msgsBottom, 这一块顶: half && half.top }));

    // ---- 3. 松手过线：留在那儿，清单画出来 ----
    let settled = null;
    for (let t = 0; t < 40; t++) {
        await page.sleep(250);
        settled = await sheetNow();
        if (settled.rows.length > 0) { break; }
    }
    await page.shot("sheet-open.png");
    check("松手过线：它留在那儿（没滑回去）", !settled.hidden && settled.h > 40,
        JSON.stringify({ 藏: settled.hidden, 高: settled.h }));
    const cap = Math.round((await page.eval(`return document.getElementById("chatColumn").clientHeight;`)) * 0.45);
    check("高度按内容定，不超过对话那一列的 45%", settled.h > 0 && settled.h <= cap + 2,
        "高 " + settled.h + "，封顶 " + cap);
    const paths = settled.rows.map((r) => r.path).sort();
    check("清单里列着改过的那两个文件", paths.join(",") === [EDITED, ADDED].sort().join(","), JSON.stringify(paths));
    check("行上写的是整条相对写法（手机上没有悬停可以看全）", settled.rows.every((r) => r.name === r.path),
        JSON.stringify(settled.rows.map((r) => r.name)));
    const editedRow = settled.rows.find((r) => r.path === EDITED);
    check("右边写着多了几行少了几行", !!editedRow && editedRow.counts.indexOf("+1") >= 0, editedRow && editedRow.counts);
    check("两块还是各占一块（输入框还在最底下、没被挤走）",
        settled.msgsBottom <= settled.top + 1 && settled.inputTop > settled.top,
        JSON.stringify({ 消息区底: settled.msgsBottom, 这一块顶: settled.top, 输入框顶: settled.inputTop }));

    // ---- 4. 点一行：打开那份 diff ----
    await page.eval(`
        const row = Array.from(document.querySelectorAll("#changeSheetBody .change-head"))
            .find(function (el) { return el.getAttribute("data-path") === ${JSON.stringify(EDITED)}; });
        if (row) { row.click(); }
        return !!row;
    `);
    let opened = null;
    for (let t = 0; t < 30; t++) {
        await page.sleep(250);
        opened = await sheetNow();
        if (opened.view && opened.stageShown) { break; }
    }
    await page.shot("sheet-diff.png");
    check("点清单里的一行：打开了那份 diff（盖住对话那一块的弹窗）", opened.view && opened.stageShown,
        JSON.stringify({ 弹窗: opened.stageShown }));
    await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
    await page.sleep(600);

    // ---- 5. 拖着头上那一条往下拉：跟手、过三成收起来 ----
    const afterDiff = await sheetNow();
    const barX = afterDiff.bar.x;
    const barY = afterDiff.bar.y;
    const h0 = afterDiff.h;
    let dragging = null;
    await drag(barX, barY, barX, barY + Math.round(h0 * 0.45), 8, async () => {
        dragging = await sheetNow();
    });
    check("往下拉的时候它跟着矮下去", dragging && dragging.h < h0 && dragging.h > 0,
        JSON.stringify({ 拉之前: h0, 拉到一半: dragging && dragging.h }));
    let closed = null;
    for (let t = 0; t < 20; t++) {
        await page.sleep(200);
        closed = await sheetNow();
        if (closed.hidden) { break; }
    }
    await page.shot("sheet-closed.png");
    check("松手过了三成：收起来了（藏起来、不占版面）", closed.hidden && closed.h <= 0,
        JSON.stringify({ 藏: closed.hidden, 高: closed.h }));
    check("消息区回到原来的高度", Math.abs(closed.msgsH - msgH0) <= 2,
        JSON.stringify({ 现在: closed.msgsH, 原来: msgH0 }));

    // ---- 6. 只轻轻拉一小截：弹回去 ----
    await drag(cx, cy, cx, cy - 30, 6);
    await page.sleep(700);
    const tiny = await sheetNow();
    check("拉得不够：弹回去，什么也不留", tiny.hidden && tiny.h <= 0, JSON.stringify({ 藏: tiny.hidden, 高: tiny.h }));

    // ---- 7. 消息没贴到底：这一下不算（那是正常滚动） ----
    await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        if (pane) {
            const filler = document.createElement("div");
            filler.id = "sheetFiller";
            filler.style.height = (pane.clientHeight * 3) + "px";
            pane.appendChild(filler);
            pane.scrollTop = 0;
        }
        return true;
    `);
    await page.sleep(300);
    await drag(cx, cy, cx, cy - 260, 12);
    await page.sleep(700);
    const notBottom = await sheetNow();
    check("消息没贴到底时往上拖：不接（还藏着）", notBottom.hidden && notBottom.h <= 0,
        JSON.stringify({ 藏: notBottom.hidden, 高: notBottom.h }));
    // 把那块撑高的占位拿掉，滚回底部
    await page.eval(`
        const filler = document.getElementById("sheetFiller");
        if (filler) { filler.remove(); }
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        if (pane) { pane.scrollTop = pane.scrollHeight; }
        return true;
    `);
    await page.sleep(400);

    // ---- 7b. 消息很多、已经贴底时往上拖：这一块长起来，窗格仍旧贴着底（最后一行没被顶出去）----
    await page.eval(`
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        if (pane) {
            const filler = document.createElement("div");
            filler.id = "sheetFiller";
            filler.style.height = (pane.clientHeight * 3) + "px";
            pane.appendChild(filler);
            pane.scrollTop = pane.scrollHeight;
        }
        return true;
    `);
    await page.sleep(300);
    await drag(cx, cy, cx, cy - 260, 12);
    let pinned = null;
    for (let t = 0; t < 30; t++) {
        await page.sleep(250);
        pinned = await sheetNow();
        if (!pinned.hidden && pinned.h > 40) { break; }
    }
    check("贴底时往上拖：这一块长起来，窗格仍旧贴着底（最后一行没被顶出去）",
        !pinned.hidden && pinned.h > 40 && Math.abs(pinned.distBottom) <= 2,
        JSON.stringify({ 高: pinned.h, 离底: pinned.distBottom }));
    await page.eval(`
        const filler = document.getElementById("sheetFiller");
        if (filler) { filler.remove(); }
        const pane = document.querySelector(".session-view:not(.off) .session-pane");
        if (pane) { pane.scrollTop = pane.scrollHeight; }
        return true;
    `);
    await page.sleep(400);

    // ---- 8. 再拖出来，点头上那颗叉收起来 ----
    await drag(cx, cy, cx, cy - 260, 12);
    let again = null;
    for (let t = 0; t < 30; t++) {
        await page.sleep(250);
        again = await sheetNow();
        if (!again.hidden && again.h > 40) { break; }
    }
    check("再往上拖还是拖得出来", !again.hidden && again.h > 40, JSON.stringify({ 高: again.h }));
    await page.click("#changeSheetClose");
    let gone = null;
    for (let t = 0; t < 20; t++) {
        await page.sleep(200);
        gone = await sheetNow();
        if (gone.hidden) { break; }
    }
    check("点头上那颗叉：收起来", gone.hidden && gone.h <= 0, JSON.stringify({ 藏: gone.hidden, 高: gone.h }));

    // ---- 9. 清单长了以后：在清单上往下拉也能收，但只在清单已经滚到最上头时算 ----
    const extra = [];
    for (let i = 1; i <= 20; i++) {
        const name = "长清单-" + i + ".txt";
        fs.writeFileSync(path.join(WORK, name), "第 " + i + " 个文件\n", "utf8");
        extra.push(name);
    }
    await drag(cx, cy, cx, cy - 300, 12);
    let long = null;
    for (let t = 0; t < 30; t++) {
        await page.sleep(250);
        long = await sheetNow();
        if (!long.hidden && long.rows.length > 20) { break; }
    }
    const capLong = Math.round((await page.eval(`return document.getElementById("chatColumn").clientHeight;`)) * 0.45);
    check("清单长了：这一块停在封顶那儿，清单自己滚",
        !long.hidden && Math.abs(long.h - capLong) <= 2 && long.listScrollable,
        JSON.stringify({ 高: long.h, 封顶: capLong, 能滚: long.listScrollable, 行: long.rows.length }));
    await page.shot("sheet-long.png");

    // 清单滚到中间时往下拖：那是翻清单里上面那几条，这一块不动、也不收
    await page.eval(`
        const body = document.getElementById("changeSheetBody");
        if (body) { body.scrollTop = 120; }
        return true;
    `);
    await page.sleep(300);
    const beforeScroll = await sheetNow();
    const listX = beforeScroll.listBox.x;
    const listY = beforeScroll.listBox.y;
    await drag(listX, listY, listX, listY + 60, 8);
    await page.sleep(500);
    const afterScroll = await sheetNow();
    check("清单不在最上头时往下拖：那一下是翻清单（这一块不收、也不矮）",
        !afterScroll.hidden && Math.abs(afterScroll.h - beforeScroll.h) <= 2 && afterScroll.listTop < beforeScroll.listTop,
        JSON.stringify({ 高: afterScroll.h, 原来: beforeScroll.h, 清单顶: afterScroll.listTop, 拖之前: beforeScroll.listTop }));

    // 清单在最上头时往下拖：这一块跟着矮下去，松手过三成就收起来
    await page.eval(`
        const body = document.getElementById("changeSheetBody");
        if (body) { body.scrollTop = 0; }
        return true;
    `);
    await page.sleep(300);
    const topNow = await sheetNow();
    let listDrag = null;
    await drag(topNow.listBox.x, topNow.listBox.y, topNow.listBox.x, topNow.listBox.y + Math.round(topNow.h * 0.45), 8, async () => {
        listDrag = await sheetNow();
    });
    check("清单在最上头时往下拖：这一块跟着矮下去",
        listDrag && listDrag.h < topNow.h && listDrag.h > 0,
        JSON.stringify({ 拖之前: topNow.h, 拉到一半: listDrag && listDrag.h }));
    let closedByList = null;
    for (let t = 0; t < 20; t++) {
        await page.sleep(200);
        closedByList = await sheetNow();
        if (closedByList.hidden) { break; }
    }
    check("松手过了三成：收起来了（没顺手把那份 diff 打开）",
        closedByList.hidden && closedByList.h <= 0 && !closedByList.view,
        JSON.stringify({ 藏: closedByList.hidden, 高: closedByList.h, 弹窗: closedByList.view }));

    if (failures) { throw new Error("有 " + failures + " 条不对"); }
};

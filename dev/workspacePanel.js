// @ts-nocheck
/**
 * 验「项目与会话」面板（顶条最右边那颗 <<<，宽窗下常驻在右边那一列）。
 *
 *   npm run web:shot -- --width 1200 --height 760 --fake-pi --script dev/workspacePanel.js
 *
 * 面板现在长这样：
 *   · 「正在对话」一段在最上面：所有开着的会话（不分目录、没有「新建会话」那一行）；
 *   · 「工作区」那一块是分组的：一行一个目录（当前那个排最上面），点整行展开 / 收起，
 *     展开以后挂它的会话（一组一次 5 条，组里末尾一颗「加载更多」，子会话不出现）；
 *   · 行尾那颗加号（鼠标停在这一行才露出来）= 在那个目录里新建会话；
 *   · 「工作区」标题右边那颗加号 = 原来的「打开文件夹…」那一行。
 *
 * 这一趟把这些都点一遍，并造两个假的会话文件（一个正常、一个子会话）验“子会话不显示”。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/** 调试会话所在的目录编成 pi 的名字（跟 sessionStore.encodeCwd 一个规矩）。 */
function scratchSessionsDir() {
    const cwd = path.join(process.cwd(), "dev", ".scratch");
    return path.join(os.homedir(), ".pi", "agent", "sessions", "--" + cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-") + "--");
}

/** 两个假会话文件：正常那个、子会话那个（第一条用户消息是派活那套文字）。 */
function writeFakeSessions() {
    const dir = scratchSessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const cwd = path.join(process.cwd(), "dev", ".scratch");
    const made = [];
    const write = (name, lines) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
        made.push(file);
        return file;
    };
    const head = (id) => ({ type: "session", id, cwd, timestamp: new Date().toISOString() });
    write("2099-01-01T00-00-00-000Z_deadbeef-0000-4000-8000-00000000f001.jsonl", [
        head("deadbeef-0000-4000-8000-00000000f001"),
        { type: "message", message: { role: "user", content: [{ type: "text", text: "面板验子会话：这一条该出现" }] } },
    ]);
    write("2099-01-01T00-00-01-000Z_deadbeef-0000-4000-8000-00000000f002.jsonl", [
        head("deadbeef-0000-4000-8000-00000000f002"),
        { type: "message", message: { role: "user", content: [{ type: "text", text: "【任务】\n\n干点活\n\n---\n\n【收尾要求】\n\n写成完整交代。" }] } },
    ]);
    return made;
}

const LOOK = `
    const body = document.getElementById("dockBody");
    const space = body.querySelector(".pk-space-pane");
    const items = space ? Array.from(space.querySelectorAll(".pk-item")) : [];
    const first = items.find(function (i) { return i.classList.contains("pk-space-head"); });
    const firstAdd = first ? first.querySelector(".pk-space-add") : null;
    return {
        sections: Array.from(body.querySelectorAll(".pk-section")).map(function (s) { return s.textContent; }),
        heads: items.filter(function (i) { return i.classList.contains("pk-space-head"); }).map(function (i) {
            const t = i.querySelector(".pk-history-title");
            return (i.classList.contains("expanded") ? "[开] " : "[合] ") + (t ? t.textContent : "?");
        }),
        groupRows: items.filter(function (i) { return i.classList.contains("pk-group-session"); }).map(function (i) { return i.textContent.slice(0, 34); }),
        openRows: Array.from(body.querySelectorAll(".pk-item.pk-open")).length,
        caretRotated: (function () {
            const c = first ? first.querySelector(".pk-space-caret") : null;
            return c ? getComputedStyle(c).transform : "(没有)";
        })(),
        addBtns: space ? space.querySelectorAll(".pk-space-add").length : 0,
        addOpacity: firstAdd ? getComputedStyle(firstAdd).opacity : "(没有)",
        sectionAdd: !!body.querySelector(".pk-section-add-btn"),
        newSessionRows: Array.from(body.querySelectorAll(".pk-item")).filter(function (i) { return /^在 .*新建会话$/.test(i.textContent.trim()); }).length,
        groupMore: space ? space.querySelectorAll(".pk-loadmore.pk-group-more").length : 0,
        spaceMore: space ? Array.from(space.querySelectorAll(".pk-loadmore")).map(function (b) { return b.textContent; }).length : 0,
        folderPicker: !document.getElementById("pickerOverlay").classList.contains("hidden")
            && document.getElementById("pickerOverlay").classList.contains("pk-folders"),
        currentDir: ((document.getElementById("sessionPath") || {}).textContent || "").trim(),
    };
`;

module.exports = async (page) => {
    const look = async (label) => {
        const r = JSON.parse(await page.eval(`return JSON.stringify((function () { ${LOOK} })());`));
        console.log(`${label}\n    分节：${JSON.stringify(r.sections)}｜组头：${JSON.stringify(r.heads)}｜` +
            `组里会话 ${r.groupRows.length} 行｜组里「加载更多」${r.groupMore} 颗｜行尾加号 ${r.addBtns} 颗（第一颗透明度 ${r.addOpacity}）｜` +
            `标题加号 ${r.sectionAdd}｜「新建会话」行 ${r.newSessionRows} 行｜当前目录 ${r.currentDir}`);
        return r;
    };
    const rect = async (selector, index) => JSON.parse(await page.eval(`
        const list = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const el = list[${index || 0}];
        if (!el) { return "null"; }
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, w: r.width, h: r.height });
    `));
    const move = (x, y) => page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y), button: "none" });
    const clickAt = async (x, y) => {
        await page.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
        await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
    };

    await page.waitReady();
    await page.sleep(700);
    const first = await look("刚打开（当前那个组该是展开的）");
    await page.shot("panel-open.png");

    // 鼠标停到第一组那一行上：行尾那颗加号该露出来
    const row0 = await rect("#dockBody .pk-space-pane .pk-item.pk-space-head", 0);
    await move(row0.left + 40, row0.y);
    await page.sleep(200);
    await look("鼠标停在工作区第一行上（那一行的加号该露出来）");
    await page.shot("panel-hover-row.png");

    // 点第二组那一行：展开（挂上会话）；再点：收起；再点：展开（行还在，不用重新等）
    const head2 = await rect("#dockBody .pk-space-pane .pk-item.pk-space-head", 1);
    await clickAt(head2.x, head2.y);
    await page.sleep(1500);
    const opened = await look("点开第二组");
    await clickAt(head2.x, head2.y);
    await page.sleep(500);
    await look("再点一下（收起）");
    await clickAt(head2.x, head2.y);
    await page.sleep(1200);
    const reopened = await look("再点回来（展开，行还在）");
    console.log(`    第二组两次展开的行数：${opened.groupRows.length} → ${reopened.groupRows.length}`);
    await page.shot("panel-two-groups.png");

    // 那一组的「加载更多」：接着加 5 条
    const beforeMore = reopened.groupRows.length;
    const clickedMore = await page.eval(`
        const btn = document.querySelector("#dockBody .pk-space-pane .pk-loadmore.pk-group-more");
        if (!btn) { return "没有组里的加载更多"; }
        btn.click();
        return "点了";
    `);
    console.log("点组里的「加载更多」：" + clickedMore);
    await page.sleep(1500);
    const afterMore = await look("点过之后");
    console.log(`    组里的行数：${beforeMore} → ${afterMore.groupRows.length}`);
    await page.shot("panel-group-more.png");

    // 点第二组里一条会话：切过去（目录跟着变），面板留着
    const pick = await page.eval(`
        const rows = Array.from(document.querySelectorAll("#dockBody .pk-space-pane .pk-item.pk-group-session"));
        if (!rows.length) { return "没有会话行"; }
        const row = rows[rows.length - 1];
        const name = row.textContent.slice(0, 24);
        row.click();
        return name;
    `);
    console.log("点组里一条会话：" + pick);
    await page.sleep(2600);
    const picked = await look("点过之后（当前目录该换成那一组的目录）");
    console.log(`    目录换了吗：${picked.currentDir !== first.currentDir}（${first.currentDir} → ${picked.currentDir}）`);
    await page.shot("panel-picked.png");

    // 第二组那一行的加号：在那个目录里新建会话
    const add2 = await rect("#dockBody .pk-space-pane .pk-item.pk-space-head .pk-space-add", 1);
    await move(add2.left, add2.y);
    await page.sleep(200);
    await page.eval("Array.from(document.querySelectorAll('#dockBody .pk-space-pane .pk-item.pk-space-head .pk-space-add'))[1].click(); return true;");
    await page.sleep(3000);
    const afterNew = await look("点过第二组行尾的加号之后（该在那个目录里新开一个会话）");
    console.log(`    组里的行数（新建的会话该出现在「正在对话」里）：${picked.groupRows.length} → ${afterNew.groupRows.length}｜正在对话 ${afterNew.openRows} 行`);
    await page.shot("panel-new-in-group.png");

    // 标题右边那颗加号：打开逛文件夹那层浮层
    await page.click("#dockBody .pk-section-add-btn");
    await page.sleep(1200);
    const browse = await look("点过「工作区」标题右边的加号");
    console.log(`    挑文件夹那层开着吗：${browse.folderPicker}`);
    await page.shot("panel-browse.png");
    await clickAt(3, 3);
    await page.sleep(600);

    // 工作区那一块的「加载更多」：再接几个目录上来
    const beforeList = (await look("点工作区那一块的「加载更多」之前")).heads.length;
    const clickedList = await page.eval(`
        const btns = Array.from(document.querySelectorAll("#dockBody .pk-space-pane .pk-loadmore"));
        const btn = btns.find(function (b) { return !b.classList.contains("pk-group-more"); });
        if (!btn) { return "没有那一颗"; }
        btn.click();
        return "点了";
    `);
    console.log("点工作区那一块的「加载更多」：" + clickedList);
    await page.sleep(1500);
    const afterList = await look("点过之后（目录该多几个）");
    console.log(`    组头数：${beforeList} → ${afterList.heads.length}`);
    await page.shot("panel-list-more.png");

    // 子会话不显示：造两个假的会话文件（一个正常、一个子会话），刷新一下看当前那个组
    const made = writeFakeSessions();
    try {
        await page.eval("location.reload(); return true;");
        await page.sleep(1800);
        await page.waitReady();
        await page.sleep(1400);
        const after = await look("造了两个假会话文件之后（正常的该出现、子会话不该出现）");
        const titles = after.groupRows.join(" || ");
        console.log(`    正常那条出现了吗：${titles.indexOf("面板验子会话：这一条该出现") >= 0}`);
        console.log(`    子会话那条出现了吗（应该是 false）：${titles.indexOf("【任务】") >= 0}`);
        await page.shot("panel-child-hidden.png");
    } finally {
        for (const f of made) { try { fs.rmSync(f); } catch { /* 清不掉就算了，是调试目录 */ } }
    }

    // 输入框左边那颗加号还是在当前会话的目录里开新会话（面板里那一行没了，行为不变）
    const beforeTop = await look("底条加号之前");
    await page.click("#newSessionBtn");
    await page.sleep(2500);
    const afterTop = await look("底条加号之后（目录该不变）");
    console.log(`    目录没变吗：${beforeTop.currentDir === afterTop.currentDir}（都是 ${afterTop.currentDir}）｜正在对话 ${beforeTop.openRows} → ${afterTop.openRows} 行`);
};

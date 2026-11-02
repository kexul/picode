// @ts-nocheck
/**
 * bashTasks —— 验输入框右边那颗「后台任务」按钮与它弹出来的清单。
 *
 * 真让 pi 往后台放一条命令不好凑，这里直接往页面里投假消息（跟后端推的是同一种消息：bashTasks 是
 * 界面问后端要来的那份清单）；一次验：
 *   · 那颗按钮一直在输入行里，没有命令在跑时右下角不挂数字；
 *   · 点开是从输入行上头往上弹的一小张清单：一条一行（编号 + 在跑 + 已经跑了多久 + 停 + 命令原文）；
 *   · 有命令在跑时按钮右下角挂一个蓝色小数字（几条），按钮本身不变色，清单里那几条的用时自己往上走；
 *   · 命令原文不截：多长都换行写全（带换行的也照原样分行）；
 *   · 跑完的不列（后端那份清单里只留 running 的）；
 *   · 按 Esc、点别处都收起；
 *   · 手机上往上弹、不出屏、行高够点。
 *
 *   npm run web:shot -- --width 900 --height 700 --script dev/bashTasks.js
 * 图落在 dev/shots/。
 */

/** 投进去的那几条后台命令（跟后端 listBashTasks 给的字段一样）。 */
const LONG_CMD = "node dev/visit.js --fake-pi --send 你好 --wait-answer 你好 --shot extra-long-name.png "
    + "--width 900 --height 700 --keep --script dev/bashTasks.js --cwd dev/.scratch/a-rather-long-directory-name";
const tasksAt = (now) => ([
    { no: 7, toolCallId: "c7", cmd: LONG_CMD, log: "l7", pid: 1234, startedAt: now - 65000, background: true, status: "running", exitCode: null, elapsedMs: 0 },
    { no: 6, toolCallId: "c6", cmd: "node dev/visit.js --fake-pi --send 你好", log: "l6", pid: 1235, startedAt: now - 4000, background: true, status: "running", exitCode: null, elapsedMs: 0 },
    { no: 5, toolCallId: "c5", cmd: "npm test", log: "l5", pid: 1236, startedAt: now - 300000, background: true, status: "done", exitCode: 0, elapsedMs: 300000 },
]);

module.exports = async (page) => {
    await page.waitReady();
    const problems = [];

    /** 当前会话的标识（投假消息要带上它，界面只认当前会话那份）。 */
    const activeId = () => page.eval(`
        const view = document.querySelector(".session-view:not(.off)");
        return view ? view.dataset.sessionId || "" : "";
    `);

    /** 投一份后台命令清单（跟后端回的那条消息一模一样）。 */
    const feed = async (list) => {
        const id = await activeId();
        await page.eval(`window.postMessage(${JSON.stringify({ type: "bashTasks", sessionId: id, tasks: list })}, "*"); return true;`);
        await page.sleep(250);
    };

    /** 那颗按钮现在什么样：在不在、右下角那个小数字写了什么、算出来的颜色。 */
    const btnState = () => page.eval(`
        const b = document.getElementById("bashBtn");
        if (!b) { return { none: true }; }
        const c = b.querySelector(".bash-count");
        return {
            none: false,
            hidden: b.classList.contains("hidden"),
            inInputRow: !!b.closest("#inputRow"),
            on: b.classList.contains("on"),
            color: getComputedStyle(b).color,
            count: c ? c.textContent : null,
            countShown: !!c && !c.classList.contains("hidden") && getComputedStyle(c).display !== "none",
            countColor: c ? getComputedStyle(c).color : "",
            title: b.title || "",
            w: Math.round(b.getBoundingClientRect().width),
            h: Math.round(b.getBoundingClientRect().height),
        };
    `);

    /** 清单现在什么样：开着没有、几行、每行写了什么。 */
    const listState = () => page.eval(`
        const menu = document.getElementById("bashMenu");
        if (!menu) { return { none: true }; }
        const rows = Array.from(menu.querySelectorAll(".bash-item"));
        const mb = menu.getBoundingClientRect();
        const row = document.getElementById("inputRow").getBoundingClientRect();
        return {
            none: false,
            open: !menu.classList.contains("hidden"),
            n: rows.length,
            items: rows.map((el) => {
                const c = el.querySelector(".bash-cmd");
                // 命令原文排成了几行（按文字自己那几块矩形数，不靠行高猜）
                let cmdLines = 0;
                if (c) {
                    const r = document.createRange();
                    r.selectNodeContents(c);
                    cmdLines = new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top))).size;
                }
                return {
                    no: (el.querySelector(".bash-no") || {}).textContent || "",
                    state: (el.querySelector(".bash-state") || {}).textContent || "",
                    time: (el.querySelector(".bash-time") || {}).textContent || "",
                    cmd: (c || {}).textContent || "",
                    stop: !!el.querySelector(".bash-stop"),
                    cmdLines: cmdLines,
                    // 被截了没有：横向多出来 / 竖向被切掉都算截
                    cmdOverflowX: c ? c.scrollWidth - c.clientWidth : 0,
                    cmdOverflowY: c ? c.scrollHeight - c.clientHeight : 0,
                    cmdWrap: c ? getComputedStyle(c).whiteSpace : "",
                };
            }),
            empty: (menu.querySelector(".bash-empty") || {}).textContent || "",
            above: Math.round(row.top - mb.bottom),
            h: Math.round(mb.height),
        };
    `);

    // ---- 第一幕：没有命令在跑：按钮右下角不挂数字，点开只有一句提示 ----
    const btn0 = await btnState();
    console.log("\n第一幕（一条都没在跑）：\n  在输入行里=" + btn0.inInputRow + " 藏着=" + btn0.hidden
        + " 大小=" + btn0.w + "x" + btn0.h + " 挂数字=" + btn0.countShown + " 提示=" + JSON.stringify(btn0.title));
    if (btn0.none) { problems.push("没有那颗「后台任务」按钮"); }
    if (btn0.hidden) { problems.push("这颗按钮该一直露着"); }
    if (!btn0.inInputRow) { problems.push("这颗按钮该在输入框底下那条横排里"); }
    if (btn0.countShown) { problems.push("一条命令都没在跑，右下角不该挂数字"); }

    await page.click("#bashBtn");
    await page.sleep(300);
    const empty = await listState();
    console.log("  点开：开着=" + empty.open + " 行数=" + empty.n + " 写的=" + JSON.stringify(empty.empty)
        + " 贴着输入行上头=" + empty.above + "px");
    if (!empty.open) { problems.push("点按钮没打开清单"); }
    if (empty.n !== 0 || !empty.empty) { problems.push("一条都没在跑的时候清单里该只有一句提示"); }
    if (empty.above < 0) { problems.push("清单该往上弹、落在输入行上头，实际压住输入行 " + (-empty.above) + " 像素"); }
    await page.shot("bash-1-empty.png");

    // ---- 第二幕：投两条在跑的 + 一条跑完的：只列在跑的那两条，按钮右下角挂「2」 ----
    await feed(tasksAt(Date.now()));
    const btn1 = await btnState();
    const list1 = await listState();
    console.log("\n第二幕（两条在跑、一条跑完）：\n  行数=" + list1.n
        + " 右下角数字=" + btn1.count + "（挂着=" + btn1.countShown + " 颜色=" + btn1.countColor + "）"
        + " 按钮颜色=" + btn1.color + " 提示=" + JSON.stringify(btn1.title)
        + "\n  " + list1.items.map((it) => it.no + " " + it.state + " " + it.time + " " + it.cmd).join("\n  "));
    if (list1.n !== 2) { problems.push("该只列还在跑的两条，实际 " + list1.n + " 行"); }
    if (list1.items[0] && list1.items[0].no !== "#7") { problems.push("新的那条该排最前：#7，实际 " + (list1.items[0] || {}).no); }
    if (list1.items.some((it) => it.no === "#5")) { problems.push("跑完的那条（#5）不该列出来"); }
    if (!list1.items.every((it) => it.state === "在跑")) { problems.push("每行都该写着「在跑」"); }
    if (!list1.items.every((it) => it.stop)) { problems.push("在跑的那几条右边该有一颗「停」"); }
    if (!list1.items[0] || !list1.items[0].cmd.startsWith("node dev/visit.js")) { problems.push("那一行下面该写着命令原文"); }
    // 那颗按钮本身不变色，只在右下角挂一个小数字
    const btnRgb = (btn1.color.match(/\d+/g) || []).map(Number);
    if (btnRgb.length >= 3 && btnRgb[2] > 150 && btnRgb[2] > btnRgb[0] + 40) { problems.push("有命令在跑时那颗按钮本身不该变色，实际 " + btn1.color); }
    if (!btn1.countShown || btn1.count !== "2") { problems.push("有两条在跑，右下角该挂个「2」，实际 " + (btn1.countShown ? btn1.count : "没挂")); }
    const cntRgb = (btn1.countColor.match(/\d+/g) || []).map(Number);
    if (!(cntRgb.length >= 3 && cntRgb[2] > 150 && cntRgb[2] > cntRgb[0] + 40)) { problems.push("右下角那个数字该是蓝的，实际 " + btn1.countColor); }
    if (!/2 条在跑/.test(btn1.title)) { problems.push("悬停提示该写清几条在跑，实际 " + JSON.stringify(btn1.title)); }
    // 命令原文不截：长的那条（#7）换行写全，短的那条（#6）一行
    console.log("  命令原文：#7 " + list1.items[0].cmdLines + " 行，横向溢出 " + list1.items[0].cmdOverflowX
        + "，竖向溢出 " + list1.items[0].cmdOverflowY + "；#6 " + (list1.items[1] || {}).cmdLines + " 行");
    if (list1.items[0].cmdOverflowX > 0 || list1.items[0].cmdOverflowY > 0) { problems.push("命令原文被截了（横向溢出 " + list1.items[0].cmdOverflowX + "、竖向 " + list1.items[0].cmdOverflowY + "）"); }
    if (list1.items[0].cmdLines < 2) { problems.push("长得放不下的命令该换行写全，实际还是 " + list1.items[0].cmdLines + " 行"); }
    if (list1.items[0].cmd !== LONG_CMD) { problems.push("命令原文该一字不差地写出来（实际长度 " + list1.items[0].cmd.length + "、原长 " + LONG_CMD.length + "）"); }
    if (!list1.items.every((it) => it.cmdWrap === "pre-wrap")) { problems.push("命令原文该照原样换行排（white-space 实际 " + (list1.items[0] || {}).cmdWrap + "）"); }
    await page.shot("bash-2-running.png");

    // ---- 第三幕：用时自己往上走（半秒一跳，不重画清单） ----
    const t0 = (await listState()).items[0].time;
    await page.sleep(1300);
    const t1 = (await listState()).items[0].time;
    console.log("\n第三幕（用时）：\n  刚才=" + t0 + " 现在=" + t1);
    if (t0 === t1) { problems.push("在跑的那几条用时该自己往上走（" + t0 + " 没变）"); }

    // ---- 第四幕：Esc 与点别处都能收起 ----
    await page.press("Escape");
    await page.sleep(250);
    const escClosed = await listState();
    console.log("\n第四幕（Esc 与点别处）：\n  按 Esc 收起=" + !escClosed.open);
    if (escClosed.open) { problems.push("按 Esc 没把清单收起来"); }

    await page.click("#bashBtn");
    await page.sleep(250);
    await page.eval(`document.querySelector(".session-view:not(.off) .session-pane").click(); return true;`);
    await page.sleep(250);
    const outClosed = await listState();
    console.log("  点别处收起=" + !outClosed.open);
    if (outClosed.open) { problems.push("点了外头没把清单收起来"); }

    // ---- 第五幕：全跑完了：右下角那个数字消失，清单里又只剩一句提示 ----
    const done = tasksAt(Date.now()).map((it) => ({ ...it, status: "done", exitCode: 0, elapsedMs: 9000 }));
    await feed(done);
    const btn2 = await btnState();
    await page.click("#bashBtn");
    await page.sleep(250);
    const list2 = await listState();
    console.log("\n第五幕（全跑完）：\n  行数=" + list2.n + " 右下角挂着=" + btn2.countShown + " 提示=" + JSON.stringify(btn2.title));
    if (btn2.countShown) { problems.push("全跑完了，右下角那个数字该消失"); }
    if (btn2.title !== "后台任务") { problems.push("全跑完了，提示该回到「后台任务」，实际 " + JSON.stringify(btn2.title)); }
    if (list2.n !== 0) { problems.push("全跑完了清单里该只剩一句提示，实际 " + list2.n + " 行"); }

    // ---- 第六幕：手机上的清单：往上弹、不出屏、行高够点 ----
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 1, mobile: true });
    await page.sleep(400);
    await feed(tasksAt(Date.now()));
    await page.sleep(300);
    const phone = await page.eval(`
        const menu = document.getElementById("bashMenu");
        const rows = menu.querySelectorAll(".bash-item");
        const b = menu.getBoundingClientRect();
        const r0 = rows.length ? rows[0].getBoundingClientRect() : null;
        return { w: Math.round(b.width), h: Math.round(b.height), left: Math.round(b.left), right: Math.round(b.right),
            rows: rows.length, rowH: r0 ? Math.round(r0.height) : 0, winW: window.innerWidth, winH: window.innerHeight };
    `);
    console.log("\n第六幕（手机 400 宽）：\n  清单 " + phone.w + "x" + phone.h + "（屏 " + phone.winW + "x" + phone.winH + "）行数=" + phone.rows + " 行高=" + phone.rowH);
    if (phone.rows !== 2) { problems.push("手机上的清单该有两条，实际 " + phone.rows); }
    if (phone.left < 0 || phone.right > phone.winW) { problems.push("手机上的清单出屏幕了：左 " + phone.left + "、右 " + phone.right + "、屏宽 " + phone.winW); }
    if (phone.h > phone.winH * 0.6) { problems.push("手机上的清单太高了（该封顶）：高 " + phone.h + "、屏高 " + phone.winH); }
    if (phone.rowH < 30) { problems.push("手机上的清单行太矮，不好点：行高 " + phone.rowH); }
    await page.shot("bash-6-phone.png");

    await page.eval(`document.getElementById("bashBtn").click(); return true;`);
    await page.sleep(150);
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
    await page.sleep(200);

    // ---- 第七幕：很多条一起跑：数字封到 9+，按钮不多长一寸 ----
    const many = Array.from({ length: 12 }, (_, i) => ({
        no: 30 - i, toolCallId: "c" + (30 - i), cmd: "npm test -- --run no " + (30 - i),
        log: "l", pid: 2000 + i, startedAt: Date.now() - 1000 * (i + 1), background: true, status: "running", exitCode: null, elapsedMs: 0,
    }));
    await feed(many);
    const btn3 = await btnState();
    console.log("\n第七幕（十二条在跑）：\n  右下角数字=" + btn3.count + "（挂着=" + btn3.countShown + "）按钮大小=" + btn3.w + "x" + btn3.h);
    if (btn3.count !== "9+") { problems.push("十来条在跑时那个数字该写「9+」，实际 " + btn3.count); }
    if (btn3.w !== btn0.w || btn3.h !== btn0.h) { problems.push("挂上数字不该把那颗按钮撑大（原来 " + btn0.w + "x" + btn0.h + "，现在 " + btn3.w + "x" + btn3.h + "）"); }
    await page.shot("bash-7-many.png");

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

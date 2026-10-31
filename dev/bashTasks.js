// @ts-nocheck
/**
 * bashTasks —— 验输入框右边那颗「后台任务」按钮与它弹出来的清单。
 *
 * 真让 pi 往后台放一条命令不好凑，这里直接往页面里投假消息（跟后端推的是同一种消息：bashTasks 是
 * 界面问后端要来的那份清单）；一次验：
 *   · 那颗按钮一直在输入行里，没有命令在跑时是灰的；
 *   · 点开是从输入行上头往上弹的一小张清单：一条一行（编号 + 在跑 + 已经跑了多久 + 停 + 命令原文）；
 *   · 有命令在跑时那颗按钮变蓝，清单里那几条的用时自己往上走；
 *   · 跑完的不列（后端那份清单里只留 running 的）；
 *   · 按 Esc、点别处都收起；
 *   · 手机上往上弹、不出屏、行高够点。
 *
 *   npm run web:shot -- --width 900 --height 700 --script dev/bashTasks.js
 * 图落在 dev/shots/。
 */

/** 投进去的那几条后台命令（跟后端 listBashTasks 给的字段一样）。 */
const tasksAt = (now) => ([
    { no: 7, toolCallId: "c7", cmd: "npm run build -- --watch", log: "l7", pid: 1234, startedAt: now - 65000, background: true, status: "running", exitCode: null, elapsedMs: 0 },
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

    /** 那颗按钮现在什么样：在不在、有没有亮着（.busy）、算出来的颜色。 */
    const btnState = () => page.eval(`
        const b = document.getElementById("bashBtn");
        if (!b) { return { none: true }; }
        return {
            none: false,
            hidden: b.classList.contains("hidden"),
            inInputRow: !!b.closest("#inputRow"),
            busy: b.classList.contains("busy"),
            on: b.classList.contains("on"),
            color: getComputedStyle(b).color,
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
            items: rows.map((el) => ({
                no: (el.querySelector(".bash-no") || {}).textContent || "",
                state: (el.querySelector(".bash-state") || {}).textContent || "",
                time: (el.querySelector(".bash-time") || {}).textContent || "",
                cmd: (el.querySelector(".bash-cmd") || {}).textContent || "",
                stop: !!el.querySelector(".bash-stop"),
            })),
            empty: (menu.querySelector(".bash-empty") || {}).textContent || "",
            above: Math.round(row.top - mb.bottom),
            h: Math.round(mb.height),
        };
    `);

    // ---- 第一幕：没有命令在跑：按钮是灰的，点开只有一句提示 ----
    const btn0 = await btnState();
    console.log("\n第一幕（一条都没在跑）：\n  在输入行里=" + btn0.inInputRow + " 藏着=" + btn0.hidden
        + " 大小=" + btn0.w + "x" + btn0.h + " 亮的=" + btn0.busy + " 颜色=" + btn0.color + " 提示=" + JSON.stringify(btn0.title));
    if (btn0.none) { problems.push("没有那颗「后台任务」按钮"); }
    if (btn0.hidden) { problems.push("这颗按钮该一直露着"); }
    if (!btn0.inInputRow) { problems.push("这颗按钮该在输入框底下那条横排里"); }
    if (btn0.busy) { problems.push("一条命令都没在跑，那颗按钮不该是亮的"); }

    await page.click("#bashBtn");
    await page.sleep(300);
    const empty = await listState();
    console.log("  点开：开着=" + empty.open + " 行数=" + empty.n + " 写的=" + JSON.stringify(empty.empty)
        + " 贴着输入行上头=" + empty.above + "px");
    if (!empty.open) { problems.push("点按钮没打开清单"); }
    if (empty.n !== 0 || !empty.empty) { problems.push("一条都没在跑的时候清单里该只有一句提示"); }
    if (empty.above < 0) { problems.push("清单该往上弹、落在输入行上头，实际压住输入行 " + (-empty.above) + " 像素"); }
    await page.shot("bash-1-empty.png");

    // ---- 第二幕：投两条在跑的 + 一条跑完的：只列在跑的那两条，按钮变蓝 ----
    await feed(tasksAt(Date.now()));
    const btn1 = await btnState();
    const list1 = await listState();
    console.log("\n第二幕（两条在跑、一条跑完）：\n  行数=" + list1.n
        + " 按钮亮的=" + btn1.busy + " 颜色=" + btn1.color
        + "\n  " + list1.items.map((it) => it.no + " " + it.state + " " + it.time + " " + it.cmd).join("\n  "));
    if (list1.n !== 2) { problems.push("该只列还在跑的两条，实际 " + list1.n + " 行"); }
    if (list1.items[0] && list1.items[0].no !== "#7") { problems.push("新的那条该排最前：#7，实际 " + (list1.items[0] || {}).no); }
    if (list1.items.some((it) => it.no === "#5")) { problems.push("跑完的那条（#5）不该列出来"); }
    if (!list1.items.every((it) => it.state === "在跑")) { problems.push("每行都该写着「在跑」"); }
    if (!list1.items.every((it) => it.stop)) { problems.push("在跑的那几条右边该有一颗「停」"); }
    if (!list1.items[0] || !list1.items[0].cmd.startsWith("npm run build")) { problems.push("那一行下面该写着命令原文"); }
    if (!btn1.busy) { problems.push("有命令在跑时那颗按钮该是亮的（蓝色）"); }
    const rgb = (btn1.color.match(/\d+/g) || []).map(Number);
    if (!(rgb.length >= 3 && rgb[2] > 150 && rgb[2] > rgb[0] + 40)) { problems.push("有命令在跑时那颗按钮该是蓝的，实际 " + btn1.color); }
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
    console.log("\n第四幕（Esc 与点别处）：\n  按 Esc 收起=" + !escClosed.open + " 按钮还亮着=" + escClosed.open);
    if (escClosed.open) { problems.push("按 Esc 没把清单收起来"); }

    await page.click("#bashBtn");
    await page.sleep(250);
    await page.eval(`document.querySelector(".session-view:not(.off) .session-pane").click(); return true;`);
    await page.sleep(250);
    const outClosed = await listState();
    console.log("  点别处收起=" + !outClosed.open);
    if (outClosed.open) { problems.push("点了外头没把清单收起来"); }

    // ---- 第五幕：全跑完了：按钮回到灰的，清单里又只剩一句提示 ----
    const done = tasksAt(Date.now()).map((it) => ({ ...it, status: "done", exitCode: 0, elapsedMs: 9000 }));
    await feed(done);
    const btn2 = await btnState();
    await page.click("#bashBtn");
    await page.sleep(250);
    const list2 = await listState();
    console.log("\n第五幕（全跑完）：\n  行数=" + list2.n + " 按钮亮的=" + btn2.busy + " 颜色=" + btn2.color);
    if (btn2.busy) { problems.push("全跑完了那颗按钮该回到灰的"); }
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

    if (problems.length) {
        throw new Error("有对不上的地方：\n  - " + problems.join("\n  - "));
    }
    console.log("\n  全部通过。");
};

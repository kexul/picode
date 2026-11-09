// @ts-nocheck
/**
 * pickerStray —— 验浮层（选模型 / 选文件夹 / 历史列表这些）在两件“没人应答”的事上不再各说各话：
 *
 *   node dev/pickerStray.js
 *
 * 一、窄窗里收一份「项目与会话」的推送时，界面会顺手回一句 `pickerCancel kind:"workspace"`。
 *     以前后端不看 kind，这一句能把这块屏上正开着的**别的**浮层（比如模型选择器）一并放掉 ——
 *     选择器还摆在屏幕上，点下去却没人接。现在回复要对得上它自己开的那一个。
 * 二、断线那一刻后端会把浮层按取消放行（不然等的人干等 120 秒），界面上那一块却还摆着；
 *     重连时后端说一句“收起来”，它才真的收。以前这块浮层就一直摆着、点了没反应。
 *
 * 用真后端 + 真页面；模型选择器是真从界面上点开的（会话是假模型，够用）。
 */
const { createHarness } = require("./harness.js");
const { openPage, sleep } = require("./cdp.js");

async function main() {
    const problems = [];
    const check = (ok, what) => { if (!ok) { problems.push(what); } };

    const harness = createHarness({ fakePi: true, port: 0, log: () => { /* 安静跑 */ } });
    let open;
    try {
        const url = await harness.start();
        open = await openPage({ url, timeoutMs: 60000 });
        const page = open.page;
        await page.waitReady();

        const host = harness.host();
        /** 屏幕上那块浮层开着没有（收起时 #pickerOverlay 带 hidden）。 */
        const overlayOpen = () => page.eval(`
            const el = document.getElementById("pickerOverlay");
            return !!el && !el.classList.contains("hidden");
        `);
        /** 后端这会儿正等着哪一块屏回哪个浮层（没等着就是空串）。 */
        const pendingKind = (pageId) => {
            const st = host.pickers ? host.pickers.get(pageId) : undefined;
            return st ? st.kind : "";
        };
        const openModelPicker = async () => {
            await page.eval(`document.getElementById("ctxIcon").click(); return true;`);
            let kind = "";
            for (let i = 0; i < 100 && kind !== "model"; i++) {
                await sleep(100);
                const pageId = [...host.pickers.keys()][0];
                kind = pageId ? pendingKind(pageId) : "";
            }
            await sleep(300);
            return { kind, pageId: [...host.pickers.keys()][0] };
        };

        // ---- 一、别的浮层的取消不能放掉这一个 ----
        let opened = await openModelPicker();
        check(opened.kind === "model", `从界面点开模型选择器，后端等着的却是 ${JSON.stringify(opened.kind)}`);
        check(await overlayOpen(), "点开模型选择器，屏幕上那块没露面");
        const pageId = opened.pageId;
        check(!!pageId, "没找到这块屏的标识");
        if (!pageId) { throw new Error("没法验：没有屏"); }

        // 界面会发的那一句（见 media/chat.js 的 closePickerAnyway / renderPicker）
        await page.eval(`window.acquireVsCodeApi().postMessage({ type: "pickerCancel", kind: "workspace" }); return true;`);
        await sleep(400);
        check(pendingKind(pageId) === "model", `一句 kind:"workspace" 的取消把模型选择器放掉了（后端等着的变成 ${JSON.stringify(pendingKind(pageId))}）`);
        check(await overlayOpen(), "那一句取消之后，屏幕上的模型选择器也没了（该留着，等它自己选）");
        console.log("  一、别的浮层的取消：后端仍在等 model，屏幕上那块还开着");

        // 它自己的取消照旧管用：按 Esc（浮层那条监听自己收起、再回一句 pickerCancel）
        await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
        for (let i = 0; i < 50 && (pendingKind(pageId) !== "" || await overlayOpen()); i++) { await sleep(100); }
        check(pendingKind(pageId) === "", "它自己的取消没把后端那份放掉");
        check(!(await overlayOpen()), "它自己的取消没把屏幕上那块收起来");
        console.log("  二、它自己的取消：照旧放掉并收起");

        // ---- 三、断线那一阵留下的浮层，重连时收起来 ----
        opened = await openModelPicker();
        check(opened.kind === "model", "第二次点开模型选择器没成");
        check(await overlayOpen(), "第二次点开，屏幕上那块没露面");
        // 断线：后端把浮层按取消放行（服务端收到推送连接关闭时走的就是这一条）
        host.onPageDisconnected(pageId);
        await sleep(200);
        check(pendingKind(pageId) === "", "断线时后端没把浮层按取消放掉（等的人要干等 120 秒）");
        check(await overlayOpen(), "断线时屏幕上那块自己收掉了（这一条要验的是“还摆着”）");
        // 重连：服务端在页面连上时调的就是这个
        host.onPageConnected(pageId);
        for (let i = 0; i < 50 && await overlayOpen(); i++) { await sleep(100); }
        check(!(await overlayOpen()), "重连以后屏幕上那块浮层还摆着（点了没反应的就是它）");
        console.log("  三、断线留下的浮层：重连时收起来了");

        if (problems.length) {
            console.log("");
            console.log("有问题（" + problems.length + " 条）：");
            for (const p of problems) { console.log("  ! " + p); }
            throw new Error("浮层的这两件事没验过：" + problems.length + " 条");
        }
        console.log("");
        console.log("浮层：别的浮层的取消放不掉它、它自己的取消照旧管用、断线留下的重连时收起来，都对上了。");
    } finally {
        if (open) { try { await open.close(); } catch { /* 收摊出错不拦路 */ } }
        try { await harness.stop(); } catch { /* 收摊出错不拦路 */ }
    }
}

main().catch((err) => {
    console.error("出错了：" + (err && err.message ? err.message : String(err)));
    process.exit(1);
});

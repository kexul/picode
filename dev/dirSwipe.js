// @ts-nocheck
/**
 * dirSwipe —— 验「文件侧边栏里往右划退到上一层」那个手势。
 *
 *   npm run web:shot -- --fake-pi --width 420 --height 900 --script dev/dirSwipe.js
 *
 * 真后端、真会话、真网页服务、真界面文件（只有模型是假的），验的是外面看得见的行为：
 *   1. 在子目录的清单上往右划：清单跟着手指往右挪，底下露出上一层那份清单（真的那一层的条目）；
 *   2. 过四成松手：这一格换到上一层，画的就是上一层的内容，从它顶上开始看；
 *   3. 不到线松手：滑回原位，还停在原来那一层；
 *   4. 竖着划（那是滚清单）、往左划（那是把这一列收回去，见「侧边栏」那一条）、
 *      已经在会话目录本身那一层：都不换层，也不把临时那块留下。
 *
 * 手指用 CDP 的 Input.dispatchTouchEvent 真派下去（界面里挂的就是 touch 监听）。
 * 测试用的目录现写进会话目录（dev/.scratch），那个目录不进版本库，随便造。
 */
const fs = require("fs");
const path = require("path");
const { SCRATCH_DIR } = require("./harness.js");

const DIR = "dirswipe-" + Date.now().toString(36);
const FILE_OUTER = "outer.txt";
const FILE_INNER = "inner.txt";

module.exports = async (page) => {
    const checks = [];
    const check = (name, pass, detail) => {
        checks.push([name, !!pass]);
        console.log((pass ? "✓ " : "✗ ") + name + (detail === undefined ? "" : "   " + detail));
    };

    const cwd = await page.eval(`return (((document.getElementById("sessionName") || {}).dataset || {}).cwd || "");`);
    const dir = cwd || SCRATCH_DIR;
    // 会话目录里本来就有一堆别的调试文件：造一层自己的，名字带时间戳，清单里一眼认得出
    fs.mkdirSync(path.join(dir, DIR, "inner"), { recursive: true });
    fs.writeFileSync(path.join(dir, DIR, FILE_OUTER), "外面这一层\n", "utf8");
    fs.writeFileSync(path.join(dir, DIR, "inner", FILE_INNER), "里面那一层\n", "utf8");

    const touch = (type, x, y) => page.cdp.send("Input.dispatchTouchEvent", {
        type: type,
        touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y), id: 1 }],
    });

    /** 现在这一列什么样：待在哪一层、清单里有哪些路径、临时那块还在不在、两块挪到哪儿了。 */
    const look = async () => JSON.parse(await page.eval(`
        const pane = document.getElementById("dirPane");
        const page = pane.querySelector(".file-page");
        const layer = pane.querySelector(".dir-up-layer");
        const rect = pane.getBoundingClientRect();
        return JSON.stringify({
            open: document.body.classList.contains("file-open"),
            level: pane.title || "",
            paths: Array.from(pane.querySelectorAll(".file-entry[data-path]")).map((r) => r.dataset.path),
            layerPaths: layer ? Array.from(layer.querySelectorAll(".file-entry[data-path]")).map((r) => r.dataset.path) : [],
            layer: !!layer,
            layerX: layer ? (layer.style.transform || "") : "",
            pageX: page ? (page.style.transform || "") : "",
            scrollTop: Math.round(pane.scrollTop),
            box: { left: Math.round(rect.left), top: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        });
    `));

    const waitFor = async (what, fn, limit) => {
        const started = Date.now();
        let last = null;
        const until = limit || 8000;
        while (Date.now() - started < until) {
            last = await look();
            if (fn(last)) { return last; }
            await page.sleep(120);
        }
        console.log("（等 " + what + " 超时，最后看到的是 " + JSON.stringify(last) + "）");
        return last;
    };

    /** 在清单上点一行（按相对写法找那一行）。 */
    const clickRow = async (rel) => page.eval(`
        const row = Array.from(document.querySelectorAll("#dirPane .file-entry[data-path]"))
            .find((r) => r.dataset.path === ${JSON.stringify(rel)});
        if (!row) { return false; }
        row.click();
        return true;
    `);

    /** 从清单中间某个位置划一下：steps 步走完，最后停着（不松手）时调 atEnd。 */
    const drag = async (dx, dy, steps, atEnd) => {
        const s = await look();
        const y = s.box.top + Math.min(s.box.h - 20, 90);
        const x0 = s.box.left + Math.min(40, Math.max(10, s.box.w * 0.1));
        await touch("touchStart", x0, y);
        for (let i = 1; i <= steps; i += 1) {
            await touch("touchMove", x0 + (dx * i) / steps, y + (dy * i) / steps);
            await page.sleep(16);
        }
        if (atEnd) { await atEnd(); }
        await touch("touchEnd", x0 + dx, y + dy);
        return { x0: x0, y: y, dx: dx, dy: dy };
    };

    const atLevel = (s, level) => s.level === path.join(dir, level);
    const reopen = async () => {
        await page.eval(`if (!document.body.classList.contains("file-open")) { document.getElementById("fileSidebarBtn").click(); } return true;`);
        await page.sleep(250);
        await waitFor("清单列出来", (x) => x.open && x.paths.length > 0);
    };

    await reopen();

    // ==================== 进到子目录的下一层 ====================
    check("点到自己的测试目录", await clickRow(DIR));
    const top = await waitFor("测试目录那一层列出来", (x) => x.paths.indexOf(DIR + "/inner") >= 0 && x.paths.indexOf(DIR + "/" + FILE_OUTER) >= 0);
    check("清单上是测试目录这一层", atLevel(top, DIR) && top.paths.indexOf(DIR + "/inner") >= 0,
        JSON.stringify(top.paths.filter((p) => p.indexOf(DIR) === 0)));
    check("这一层有「上一层」那一行", await page.eval(`return !!Array.from(document.querySelectorAll("#dirPane .file-entry.up"))[0]`));

    check("再进一层", await clickRow(DIR + "/inner"));
    const inner = await waitFor("里层列出来", (x) => x.paths.indexOf(DIR + "/inner/" + FILE_INNER) >= 0);
    check("清单上是里层", atLevel(inner, DIR + "/inner"), inner.level);

    // ==================== 往右划（不到线） ====================
    await drag(80, 0, 8);
    await page.sleep(400);
    const small = await look();
    check("划得不够：还停在里层", atLevel(small, DIR + "/inner"), small.level);
    check("松手以后临时那块收掉了、两块都回到原样",
        !small.layer && small.pageX === "", JSON.stringify({ layer: small.layer, pageX: small.pageX }));
    check("划得不够的那一趟没把清单点开成别的（还是里层那一份）",
        small.paths.indexOf(DIR + "/inner/" + FILE_INNER) >= 0, JSON.stringify(small.paths));

    // ==================== 往右划（过线） ====================
    let mid = null;
    await drag(180, 0, 10, async () => {
        mid = await look();
        await page.shot("dirswipe-1-mid.png");
    });
    check("划起来时清单跟着手指往右走", !!mid && /translateX\(\s*[1-9]/.test(mid.pageX), mid && mid.pageX);
    check("底下垫的是上一层的真清单（那一层的条目都在里面）",
        !!mid && mid.layerPaths.indexOf(DIR + "/inner") >= 0 && mid.layerPaths.indexOf(DIR + "/" + FILE_OUTER) >= 0,
        mid && JSON.stringify(mid.layerPaths.filter((p) => p.indexOf(DIR) === 0)));
    check("底下那一块不跟手走（让出来的地方就露出它）",
        !!mid && mid.layerX === "translateY(0px)", mid && mid.layerX);

    const up = await waitFor("换到上一层", (x) => atLevel(x, DIR));
    check("过四成松手：换到上一层", atLevel(up, DIR), up.level);
    check("换上来画的就是上一层的内容（跟刚才跟手进来那份对得上）",
        up.paths.indexOf(DIR + "/inner") >= 0 && up.paths.indexOf(DIR + "/" + FILE_OUTER) >= 0,
        JSON.stringify(up.paths.filter((p) => p.indexOf(DIR) === 0)));
    check("换上来以后临时那块没了、位移回到原样", !up.layer && up.pageX === "", JSON.stringify({ layer: up.layer, pageX: up.pageX }));
    check("换上来以后清单是从顶上开始看的", up.scrollTop === 0, String(up.scrollTop));
    await page.shot("dirswipe-2-up.png");

    // ==================== 换过去以后清单还能点（接着往里走） ====================
    check("换上来以后清单照旧能点（点回里层）", await clickRow(DIR + "/inner"));
    const again = await waitFor("又进到里层", (x) => atLevel(x, DIR + "/inner"));
    check("点得进去：还是里层", atLevel(again, DIR + "/inner"), again.level);

    // ==================== 竖着划是滚清单，不是换层 ====================
    await page.eval(`document.getElementById("dirPane").scrollTop = 0; return true;`);
    await drag(0, 120, 8);
    await page.sleep(400);
    const vert = await look();
    check("竖着划：不换层（那是滚清单）", atLevel(vert, DIR + "/inner"), vert.level);
    check("竖着划以后也没留下临时那块", !vert.layer, JSON.stringify({ layer: vert.layer }));

    // ==================== 往左划还是把这一列收回去 ====================
    await drag(-160, 0, 10);
    await page.sleep(500);
    const left = await look();
    check("往左划：这一列收起来了（不是换层）", !left.open, JSON.stringify({ open: left.open }));
    await reopen();
    const back = await waitFor("收起来再开出来", (x) => x.open && x.paths.length > 0);
    check("收起来再开出来：还是原来那一层（还是里层）", atLevel(back, DIR + "/inner"), back.level);

    // ==================== 会话目录本身那一层：没有上一层，划不动 ====================
    await page.eval(`
        const pane = document.getElementById("dirPane");
        pane.scrollTop = 0;
        return true;
    `);
    // 一路点到会话目录本身那一层（连续点「上一层」）
    for (let i = 0; i < 4; i += 1) {
        const s = await look();
        if (s.level === dir) { break; }
        const clicked = await page.eval(`
            const up = document.querySelector("#dirPane .file-entry.up");
            if (!up) { return false; }
            up.click();
            return true;
        `);
        if (!clicked) { break; }
        await page.sleep(400);
    }
    const root = await waitFor("回到会话目录本身那一层", (x) => x.level === dir);
    check("退回会话目录本身那一层（钉子在这里继续验）", root.level === dir, root.level);
    await drag(180, 0, 10, async () => {
        mid = await look();
    });
    await page.sleep(400);
    const rootAfter = await look();
    check("会话目录本身那一层往右划：不换层，也没有跟手进来的那一块",
        rootAfter.level === dir && !rootAfter.layer && rootAfter.pageX === "",
        JSON.stringify({ level: rootAfter.level, layer: rootAfter.layer, pageX: rootAfter.pageX }));

    const bad = checks.filter((c) => !c[1]);
    console.log("\n共 " + checks.length + " 项，" + (bad.length === 0 ? "全部通过。" : bad.length + " 项没过：" + bad.map((c) => c[0]).join(" / ")));
    if (bad.length) { throw new Error("有 " + bad.length + " 项没过"); }
};

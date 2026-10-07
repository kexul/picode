/**
 * tab 栏横向滚动的几件事。
 *
 * 起因：派子会话一开就是好几个 tab，tab 栏溢出以后只有把窗口拉得很宽才看得见后面的。
 * 当时滑动条被 CSS 藏了、每次重建又把滚动位置清零、滚轮落在栏上没有任何反应。
 * 前端跑在网页视图里没有 DOM 可测，按仓库既有做法（webChatServer.test.ts）直接读文件断言。
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "path";

const mediaDir = path.join(__dirname, "..", "..", "media");
const css = fs.readFileSync(path.join(mediaDir, "chat.css"), "utf8");
const js = fs.readFileSync(path.join(mediaDir, "chat.js"), "utf8");

/** #tabBarInner 那条主规则的正文（到下一条规则为止）。 */
function innerRule(): string {
    const start = css.indexOf("#tabBarInner {");
    const end = css.indexOf("#newTabBtn {");
    assert.ok(start > 0 && end > start, "chat.css 里找不到 #tabBarInner / #newTabBtn 规则");
    return css.slice(start, end);
}

test("tab 栏的滑动条不再藏起来，横向能滚", () => {
    const rule = innerRule();
    assert.ok(/overflow-x:\s*auto/.test(rule), "横向要能滚");
    assert.ok(!/scrollbar-width:\s*none/.test(rule), "别再把滑动条藏了：藏着就等于没有");
    assert.ok(/scrollbar-width:\s*thin/.test(rule), "要一根细的，别把 tab 栏顶得太高");
    assert.ok(/#tabBarInner::-webkit-scrollbar\s*{\s*height:\s*\d+px/.test(css), "WebKit 那边也得看得见");
});

test("重建 tab 栏时保住滚动位置（流式期间名字一变就重建）", () => {
    assert.match(js, /const keepScroll = tabBarInner\.scrollLeft;/, "重建前先记住位置");
    assert.match(js, /tabBarInner\.scrollLeft = keepScroll;/, "重建后放回原位");
    // 记住与放回之间只有建 tab 的内容：中间不该再有清空滚动位置的写法
    const from = js.indexOf("const keepScroll = tabBarInner.scrollLeft;");
    const to = js.indexOf("tabBarInner.scrollLeft = keepScroll;");
    assert.ok(from > 0 && to > from, "两处都要在，且顺序对");
});

test("切到屏幕外的 tab 会自动滚过去，且只在换活跃 tab 时滚", () => {
    assert.match(js, /function revealTabInBar\(tabId\)/, "要有一个滚过去的函数");
    assert.match(js, /\.chat-tab\[data-tab-id="/, "按 tab id 找回那个元素");
    assert.match(js, /el\.dataset\.tabId = tv\.id;/, "建 tab 时要写上 data-tab-id");
    assert.match(js, /activeTabId !== tabBarRevealedActive/, "同一个 tab 反复重建时不该动视图");
});

test("滚轮落在 tab 栏上改成横向滚，没溢出时不拦", () => {
    assert.match(js, /tabBarInner\.addEventListener\("wheel"/, "要听滚轮");
    assert.match(js, /passive:\s*false/, "要 preventDefault 就得声明成非 passive");
    assert.match(js, /scrollWidth - tabBarInner\.clientWidth <= 2/, "没溢出就别拦，页面照常滚");
});

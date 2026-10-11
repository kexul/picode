import { test } from "node:test";
import * as assert from "node:assert/strict";
import { pickOverlayClient } from "./overlayTarget";

/**
 * 挑“浮层发给哪个界面”的规则。
 *
 * 规则本身很简单，但它是“在手机上点开的历史列表不会弹到电脑上”的关键，单独钉住。
 */

const SIDEBAR = "sidebar";

test("页面比侧边栏动得新：浮层发给那个页面", () => {
    assert.equal(pickOverlayClient(SIDEBAR, 100, true, { id: "p-a", at: 200 }, "p-b"), "p-a");
});

test("侧边栏动得更新：浮层发给侧边栏；一样新时页面优先（两边同一毫秒撞上，按页面算）", () => {
    assert.equal(pickOverlayClient(SIDEBAR, 300, true, { id: "p-a", at: 200 }, "p-b"), SIDEBAR);
    assert.equal(pickOverlayClient(SIDEBAR, 200, true, { id: "p-a", at: 200 }, "p-b"), "p-a");
});

test("谁都没动过：默认发给侧边栏", () => {
    assert.equal(pickOverlayClient(SIDEBAR, 0, true, undefined, "p-a"), SIDEBAR);
});

test("侧边栏没开着：拿还连着的最近一个页面顶上", () => {
    assert.equal(pickOverlayClient(SIDEBAR, 300, false, { id: "p-a", at: 200 }, "p-b"), "p-b");
    assert.equal(pickOverlayClient(SIDEBAR, 0, false, undefined, "p-b"), "p-b");
});

test("一个界面都没有：空串（调用方按“没地方弹”处理）", () => {
    assert.equal(pickOverlayClient(SIDEBAR, 0, false, undefined, undefined), "");
});

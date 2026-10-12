import { test } from "node:test";
import * as assert from "node:assert/strict";
import { closedRunState, runStateText } from "./tabaRunFiles";

test("关掉时的状态：跑完了才关的和没跑完就被关的，分开写", () => {
    assert.equal(closedRunState({ endedAt: 2000, deliveries: 1 }), "closed_done");
    assert.equal(closedRunState({ endedAt: 2000, deliveries: 0 }), "closed", "跑完了但结果没交回（父会话先没了）");
    assert.equal(closedRunState({ deliveries: 0 }), "closed", "第一轮还没跑完就被关");
});

test("两款“已关闭”的人话说法不一样", () => {
    assert.match(runStateText("closed_done"), /跑完了/);
    assert.equal(runStateText("closed"), "tab 已经关闭");
});

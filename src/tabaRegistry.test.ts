import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
    buildChildIntro,
    buildDeliveryText,
    buildSpawnNotice,
    shouldCloseAfterFirstTurn,
    type TabaChild,
} from "./tabaRegistry";

function child(over: Partial<TabaChild> = {}): TabaChild {
    return {
        id: "a1",
        name: "侦察: 认证",
        task: "看看认证模块\n第二行不用出现",
        parentPanelId: "p1",
        childPanelId: "c1",
        state: "waiting",
        startedAt: 1000,
        endedAt: 4000,
        deliveries: 1,
        ...over,
    };
}

test("跑完就关：跑完 + 父会话还在 + 用户没在看", () => {
    assert.equal(shouldCloseAfterFirstTurn({ status: "done", hasParent: true, isBeingWatched: false }), true);
});

test("这三种情况不关：没跑完（出错、被停）、父会话没了、用户正看着", () => {
    assert.equal(shouldCloseAfterFirstTurn({ status: "error", hasParent: true, isBeingWatched: false }), false);
    assert.equal(shouldCloseAfterFirstTurn({ status: "cancelled", hasParent: true, isBeingWatched: false }), false);
    assert.equal(shouldCloseAfterFirstTurn({ status: "done", hasParent: false, isBeingWatched: false }), false);
    assert.equal(shouldCloseAfterFirstTurn({ status: "done", hasParent: true, isBeingWatched: true }), false);
});

test("交回的文字：关掉了就说关掉了，没关才说“还开着”", () => {
    const closed = buildDeliveryText({ child: child(), result: "活干完了", elapsedMs: 3000, status: "done", tabClosed: true });
    assert.match(closed, /tab 已经自动关掉/);
    assert.doesNotMatch(closed, /还开着/);

    const kept = buildDeliveryText({
        child: child({ lastStatus: "error" }),
        result: "报错了",
        elapsedMs: 3000,
        status: "error",
        childSessionName: "侦察: 认证",
    });
    assert.match(kept, /还开着/);
    assert.match(kept, /没有正常跑完/);
});

test("派活提示与子会话开场：都说清楚跑完会自动关", () => {
    assert.match(buildSpawnNotice({ child: child(), sessionName: "假会话" }), /自动关掉/);
    assert.match(buildChildIntro({ child: child(), parentName: "主会话" }), /自动关掉|跟着关掉/);
    assert.doesNotMatch(buildChildIntro({ child: child(), parentName: "主会话" }), /第二行不用出现/, "任务只露第一行");
});

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
    TabaRegistry,
    buildChildClosedNotice,
    buildChildIntro,
    buildDeliveryText,
    buildSpawnFailure,
    buildSpawnNotice,
    describeChildState,
    describeTurnStatus,
    formatElapsedMs,
    stateAfterTurnEnd,
    type TabaChild,
} from "./tabaRegistry";

function kid(over: Partial<TabaChild> = {}): TabaChild {
    return {
        id: "a1", name: "侦察: 认证", task: "看看认证模块",
        parentPanelId: "sidebar:panel-1", state: "starting", startedAt: 0, deliveries: 0,
        sessionMode: "standalone", ...over,
    };
}

test("登记：同编号只登一次", () => {
    const r = new TabaRegistry();
    assert.equal(r.add(kid()), true);
    assert.equal(r.add(kid()), false);
    assert.equal(r.all().length, 1);
    assert.equal(r.has("a1"), true);
    assert.equal(r.get("a1")?.name, "侦察: 认证");
});

test("登记：子会话的 tab 挂上来以后能按 panel 反查", () => {
    const r = new TabaRegistry();
    r.add(kid());
    assert.equal(r.byChildPanel("sidebar:panel-9"), undefined);
    r.attachPanel("a1", "sidebar:panel-9", "sidebar:tab-3");
    assert.equal(r.byChildPanel("sidebar:panel-9")?.id, "a1");
    assert.equal(r.get("a1")?.childTabId, "sidebar:tab-3");
});

test("状态：任务发出去才算运行中，第一轮结束才落终态", () => {
    const r = new TabaRegistry();
    r.add(kid());
    r.attachPanel("a1", "panel-c", "tab-c");
    assert.equal(r.get("a1")!.state, "starting");
    r.noteTaskSent("a1");
    assert.equal(r.get("a1")!.state, "running");
    r.noteTaskSent("a1");
    assert.equal(r.get("a1")!.state, "running", "再发一次不改状态");
    r.noteTurnEnd("a1", "done", 5000);
    assert.equal(r.get("a1")!.state, "waiting");
    assert.equal(r.get("a1")!.endedAt, 5000);
    r.noteTurnEnd("a1", "error", 9000);
    assert.equal(r.get("a1")!.endedAt, 5000, "只认第一轮那次");
    assert.equal(r.get("a1")!.state, "waiting");
});

test("状态：出错和被中止都落到 error", () => {
    const r = new TabaRegistry();
    r.add(kid({ id: "e1" }));
    r.noteTaskSent("e1");
    r.noteTurnEnd("e1", "error", 1);
    assert.equal(r.get("e1")!.state, "error");
    const r2 = new TabaRegistry();
    r2.add(kid({ id: "c1" }));
    r2.noteTurnEnd("c1", "cancelled", 1);
    assert.equal(r2.get("c1")!.state, "error");
    assert.equal(stateAfterTurnEnd("cancelled"), "error");
    assert.equal(stateAfterTurnEnd("done"), "waiting");
});

test("交回：次数累加，手动交回也算", () => {
    const r = new TabaRegistry();
    r.add(kid());
    assert.equal(r.get("a1")!.deliveries, 0);
    r.markDelivered("a1");
    r.markDelivered("a1");
    assert.equal(r.get("a1")!.deliveries, 2);
    r.markDelivered("没有这个编号");
});

test("派活关系：一个会话能查到自己派出去的子会话，已独立的不再算", () => {
    const r = new TabaRegistry();
    r.add(kid({ id: "1", parentPanelId: "p1" }));
    r.add(kid({ id: "2", parentPanelId: "p1" }));
    r.add(kid({ id: "3", parentPanelId: "p2" }));
    assert.deepEqual(r.childrenOf("p1").map((c) => c.id), ["1", "2"]);
    assert.deepEqual(r.childrenOf("p9"), []);
    r.detachChildrenOf("p1");
    assert.deepEqual(r.liveChildrenOf("p1"), []);
    assert.equal(r.get("1")!.state, "detached");
    assert.equal(r.get("1")!.parentPanelId, undefined);
    assert.equal(r.get("3")!.state, "starting", "别人的子会话不受影响");
});

test("关掉子会话 tab：记录摘掉，父会话那边不再等着它", () => {
    const r = new TabaRegistry();
    r.add(kid({ id: "1", parentPanelId: "p1" }));
    r.attachPanel("1", "panel-c", "tab-c");
    const gone = r.forgetChildPanel("panel-c");
    assert.equal(gone?.id, "1");
    assert.equal(r.get("1"), undefined);
    assert.deepEqual(r.childrenOf("p1"), []);
    assert.equal(r.forgetChildPanel("panel-c"), undefined);
});

test("指名停止：先按编号找，再按名字精确找，最后按包含找", () => {
    const r = new TabaRegistry();
    r.add(kid({ id: "1", name: "侦察: 认证", parentPanelId: "p1" }));
    r.add(kid({ id: "2", name: "施工: 登录页", parentPanelId: "p1" }));
    r.add(kid({ id: "3", name: "侦察: 数据库", parentPanelId: "p2" }));
    assert.equal(r.findByRef("p1", { id: "2" })?.name, "施工: 登录页");
    assert.equal(r.findByRef("p1", { name: "施工: 登录页" })?.id, "2");
    assert.equal(r.findByRef("p1", { name: "施工" })?.id, "2", "写一半也能找到");
    assert.equal(r.findByRef("p1", { id: "没有", name: "认证" })?.id, "1");
    assert.equal(r.findByRef("p1", { name: "数据库" }), undefined, "不是自己派的不给停");
    assert.equal(r.findByRef("p1", {}), undefined);
});

test("用时说法", () => {
    assert.equal(formatElapsedMs(0), "0 秒");
    assert.equal(formatElapsedMs(8000), "8 秒");
    assert.equal(formatElapsedMs(72_000), "1 分 12 秒");
    assert.equal(formatElapsedMs(3_780_000), "1 小时 3 分");
    assert.equal(formatElapsedMs(-5), "0 秒");
    assert.equal(formatElapsedMs(Number.NaN), "0 秒");
});

test("交回去的正文：跑完 / 出错 / 没内容 三种写法", () => {
    const child = kid({ name: "侦察: 认证" });
    const done = buildDeliveryText({ child, result: "看过了，认证在 src/auth.ts。", elapsedMs: 72_000, status: "done", childTabName: "↳ 侦察: 认证" });
    assert.ok(done.includes("【子会话「侦察: 认证」跑完了，用时 1 分 12 秒】"));
    assert.ok(done.includes("看过了，认证在 src/auth.ts。"));
    assert.ok(done.includes("tab「↳ 侦察: 认证」"));

    const bad = buildDeliveryText({ child, result: "  ", elapsedMs: 1000, status: "error", childTabName: "x" });
    assert.ok(bad.includes("没有正常跑完（这一轮报错了）"));
    assert.ok(bad.includes("（没有拿到任何回复）"));

    const cancelled = buildDeliveryText({ child, result: "干了一半", elapsedMs: 1000, status: "cancelled" });
    assert.ok(cancelled.includes("被中止了"));
    assert.ok(cancelled.includes("干了一半"));
    assert.equal(cancelled.includes("tab「"), false, "没给 tab 名就不提 tab");

    const manual = buildDeliveryText({ child, result: "补一句", elapsedMs: 1000, status: "done", manual: true });
    assert.ok(manual.includes("用户手动交的"));
});

test("界面上那几行提示怎么写", () => {
    const child = kid({ name: "侦察: 认证", task: "看看认证模块\n第二行" });
    const notice = buildSpawnNotice({ child, tabName: "↳ 侦察: 认证", mode: "standalone" });
    assert.ok(notice.includes("已派出子会话「侦察: 认证」"));
    assert.ok(notice.includes("新 tab「↳ 侦察: 认证」"));
    assert.ok(notice.includes("全新会话"));
    assert.ok(notice.includes("自动交回"));
    assert.ok(buildSpawnNotice({ child, tabName: "t", mode: "fork" }).includes("带上了本会话之前的对话"));
    assert.ok(buildSpawnNotice({ child, tabName: "t", mode: "lineage-only" }).includes("只记着是本会话派的"));

    const intro = buildChildIntro({ child, parentTabName: "沉静的雪豹" });
    assert.ok(intro.includes("由「沉静的雪豹」派来"));
    assert.ok(intro.includes("看看认证模块"));
    assert.equal(intro.includes("第二行"), false, "只取任务第一行");
    assert.ok(buildChildIntro({ child: { ...child, parentPanelId: undefined } }).includes("独立会话"));

    assert.equal(buildSpawnFailure({ name: "侦察", reason: "没有叫 recon 的角色" }), "子会话「侦察」没派出去：没有叫 recon 的角色");
});

test("子会话 tab 被关掉、结果没交回时怎么交代", () => {
    const unfinished = buildChildClosedNotice({ child: kid({ name: "侦察: 认证" }) });
    assert.ok(unfinished.includes("tab 被关掉了，没有交回结果"));
    assert.ok(unfinished.includes("第一轮还没跑完"));
    const finished = buildChildClosedNotice({ child: kid({ name: "施工", startedAt: 0, endedAt: 72_000 }) });
    assert.ok(finished.includes("用时 1 分 12 秒"));
    assert.ok(finished.includes("没来得及交回"));
});

test("状态与收尾的人话说法", () => {
    assert.equal(describeTurnStatus("done"), "跑完了");
    assert.equal(describeTurnStatus("error"), "这一轮报错了");
    assert.equal(describeTurnStatus("cancelled"), "被中止了");
    assert.equal(describeTurnStatus(undefined), "还没有结果");
    assert.equal(describeChildState("running"), "运行中");
    assert.equal(describeChildState("detached"), "已变成独立会话");
});

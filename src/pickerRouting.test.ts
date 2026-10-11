/**
 * 浮层只发给一个界面：在手机上点开的历史列表不会弹到电脑上，电脑上关掉也不影响手机。
 *
 * 这里测的是会话编排基类的那套“一次只挂在一个界面上”的规矩（真实宿主是 ChatViewProvider，
 * 它挑谁、怎么发在 overlayTarget.test.ts / 它自己的代码里）。用假的宿主跑，不起 pi。
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ChatControllerBase } from "./chatControllerBase";
import type { PiConfig, TurnEndInfo } from "./runtimeTypes";

/** 只有“发给哪个界面”这一件事的假宿主。 */
class PickerTestController extends ChatControllerBase {
    /** 每条消息发给了谁（走基类默认出口 postToWebview 的记空串）。 */
    public readonly sent: Array<{ target: string; msg: any }> = [];
    /** 现挑时挑谁。 */
    public target = "screen-a";
    /** 假装发不出去（界面刚好走了）。 */
    public sendFails = false;

    constructor() { super("test-workspace"); }

    protected override pickOverlayTarget(): string { return this.target; }
    protected override sendOverlayTo(target: string, msg: Record<string, unknown>): boolean {
        if (this.sendFails) { return false; }
        this.sent.push({ target, msg });
        return true;
    }
    protected postToWebview(msg: Record<string, unknown>): void { this.sent.push({ target: "", msg }); }

    // 下面这些这个测试都用不到，给个空的实现把抽象成员补齐。
    public picker(kind: string, items: any[] = []): Promise<any | undefined> { return this.showPicker(kind, items); }
    public historyPicker(items: any[], hasMore: boolean, target?: string): Promise<any | undefined> {
        return this.promptHistoryPicker(items, hasMore, target);
    }
    public dropFor(target: string): void { this.dropPickerForClient(target); }

    public getConfig(): PiConfig {
        return { piPath: "pi", provider: "", model: "", extraArgs: [], trustProject: true };
    }
    public getCwd(): string { return process.cwd(); }
    public async confirmDialog(): Promise<boolean> { return false; }
    public async selectDialog(): Promise<string | undefined> { return undefined; }
    public async inputDialog(): Promise<string | undefined> { return undefined; }
    public persistModel(): void { /* noop */ }
    public openFileLocation(): void { /* noop */ }
    public async confirmRevert(): Promise<boolean> { return false; }
    protected getAutoLoadLast(): boolean { return false; }
    protected getSendKey(): string { return "enter"; }
    protected getNewSessionKey(): string { return "ctrl+alt+n"; }
    protected getTabSwitchKey(): string { return "ctrl+alt+arrows"; }
    protected getFocusInputKey(): string { return "ctrlAltI"; }
    protected getFontSize(): string { return "14"; }
    protected mutateViewOption(): void { /* noop */ }
    protected notifyBeepEnabled(): boolean { return false; }
    protected notifyTurnEnd(_info: TurnEndInfo): void { /* noop */ }
    protected sendFileList(): void { /* noop */ }
    protected openFileFromWebview(): void { /* noop */ }
    protected handlePlatformMessage(): boolean { return false; }
}

test("浮层只发给挑中的那个界面，别的界面收不到", async () => {
    const ctl = new PickerTestController();
    ctl.target = "screen-a";
    const pending = ctl.picker("history", [{ file: "x" }]);
    assert.deepEqual(ctl.sent.map((s) => [s.target, s.msg.type]), [["screen-a", "picker"]]);
    ctl.processMessage({ type: "pickerChoice", payload: { file: "x" } });
    assert.deepEqual(await pending, { file: "x" });
    assert.equal(ctl.sent.length, 1, "选完之后不该再往哪儿发消息");
});

test("一边取消：不往外发任何消息（另一边的浮层不受影响）", async () => {
    const ctl = new PickerTestController();
    ctl.target = "screen-a";
    const pending = ctl.picker("history", []);
    ctl.processMessage({ type: "pickerCancel", kind: "history" });
    assert.equal(await pending, undefined);
    assert.equal(ctl.sent.length, 1, "取消只关自己，不需要通知别的界面");
});

test("换一个浮层：原来那块屏收到取消，等的人拿到 undefined", async () => {
    const ctl = new PickerTestController();
    ctl.target = "screen-a";
    const first = ctl.picker("history", []);
    ctl.target = "screen-b";
    const second = ctl.picker("model", []);
    assert.equal(await first, undefined, "被顶掉的浮层按取消放行，不会一直挂着");
    assert.deepEqual(
        ctl.sent.map((s) => [s.target, s.msg.type]),
        [["screen-a", "picker"], ["screen-a", "pickerCancel"], ["screen-b", "picker"]],
    );
    ctl.processMessage({ type: "pickerCancel" });
    assert.equal(await second, undefined);
});

test("浮层挂着的界面断了：按取消收掉，不用干等 120 秒", async () => {
    const ctl = new PickerTestController();
    ctl.target = "screen-a";
    const pending = ctl.picker("history", []);
    ctl.dropFor("screen-a");
    assert.equal(await pending, undefined);
    assert.equal(ctl.sent.length, 1, "界面都不在了，不用再发取消消息");
});

test("别的界面断了：浮层不动", async () => {
    const ctl = new PickerTestController();
    ctl.target = "screen-a";
    const pending = ctl.picker("history", []);
    ctl.dropFor("screen-b");
    ctl.processMessage({ type: "pickerChoice", payload: 1 });
    assert.equal(await pending, 1);
});

test("挑不出界面 / 发不出去：直接按取消，不白等", async () => {
    const ctl = new PickerTestController();
    ctl.target = "";
    assert.equal(await ctl.picker("history"), undefined);
    ctl.target = "screen-a";
    ctl.sendFails = true;
    assert.equal(await ctl.picker("history"), undefined);
    assert.equal(ctl.sent.length, 0);
});

test("浮层没人答：到点自己收掉，并让那个界面把浮层关掉", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ctl = new PickerTestController();
    ctl.target = "screen-a";
    const pending = ctl.picker("history", []);
    t.mock.timers.tick(120000);
    assert.equal(await pending, undefined);
    assert.deepEqual(
        ctl.sent.map((s) => [s.target, s.msg.type]),
        [["screen-a", "picker"], ["screen-a", "pickerCancel"]],
    );
});

test("历史列表的「加载更多」只发给开着列表的那个界面", async () => {
    const ctl = new PickerTestController();
    ctl.target = "screen-a";
    const pending = ctl.historyPicker([], true);
    // 假装列表后面还有文件：让「加载更多」真的走到“追加一批”那一步
    (ctl as any).historyFiles = ["1.jsonl", "2.jsonl"];
    (ctl as any).historyOffset = 0;
    (ctl as any).scanSessionBatch = async () => [{ file: "1.jsonl", title: "t", count: 1, current: false }];
    await ctl.loadMoreHistory();
    assert.deepEqual(
        ctl.sent.filter((s) => s.msg.type === "historyPageAppend").map((s) => s.target),
        ["screen-a"],
    );
    ctl.processMessage({ type: "pickerCancel" });
    assert.equal(await pending, undefined);
});

test("指定界面的历史列表：就弹在它那儿（不管“最近在动”的是谁）", async () => {
    const ctl = new PickerTestController();
    ctl.target = "screen-b";
    const pending = ctl.historyPicker([{ file: "x" }], false, "sidebar");
    assert.deepEqual(ctl.sent.map((s) => [s.target, s.msg.type]), [["sidebar", "picker"]]);
    ctl.processMessage({ type: "pickerCancel" });
    assert.equal(await pending, undefined);
});

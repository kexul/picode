import { test } from "node:test";
import * as assert from "node:assert/strict";
import { dirInsideFolders, ScreenRegistry } from "./screenRegistry";

/**
 * 屏登记簿的检查：谁打开着这个目录、该派给谁。
 * 这一层不碰网络，纯挑人逻辑（挑了谁不对，点文件就会开在错的窗口里）。
 */

test("目录是不是落在窗口打开的文件夹里：相等算、在里面算、前缀像但不是一个目录不算", () => {
    assert.equal(dirInsideFolders("D:\\projects\\picode", ["D:\\projects\\picode"]), true, "相等");
    assert.equal(dirInsideFolders("D:\\projects\\picode\\src", ["D:\\projects\\picode"]), true, "在里面");
    assert.equal(dirInsideFolders("D:\\projects", ["D:\\projects\\picode"]), false, "上级不算（窗口只开了子目录）");
    assert.equal(dirInsideFolders("D:\\projects2", ["D:\\projects"]), false, "名字前缀像，但不是它的子目录");
    assert.equal(dirInsideFolders("D:\\projects\\picode", ["D:\\projects\\", "C:\\other"]), true, "末尾多余的斜杠不影响");
    assert.equal(dirInsideFolders("D:\\projects\\picode", []), false, "空窗口什么都不认");
    assert.equal(dirInsideFolders("", ["D:\\projects"]), false, "空目录不认");
});

test("挑窗口：只挑打开着这个目录的；一个都没有就谁也不派", () => {
    const reg = new ScreenRegistry();
    const sent: string[] = [];
    reg.add("a", ["D:\\projects\\alpha"], (m) => sent.push(`a:${m.kind}`));
    reg.add("b", ["D:\\projects\\beta"], (m) => sent.push(`b:${m.kind}`));

    assert.equal(reg.pick("D:\\projects\\alpha")?.id, "a", "有窗口开着这个目录就派给它");
    assert.equal(reg.pick("D:\\projects\\beta\\sub")?.id, "b", "会话在子目录里也算（窗口开的是上级）");
    assert.equal(reg.pick("D:\\projects\\gamma"), undefined, "没人开着这个目录：不派（不许乱开）");
    assert.equal(reg.pick("C:\\"), undefined, "同上");
});

test("同一个目录开着好几个窗口：挑最近有动静的那个；都刚连上时按标识排定，结果稳定", async () => {
    const reg = new ScreenRegistry();
    reg.add("w1", ["D:\\projects\\picode"], () => { /* 只挑人，不发送 */ });
    reg.add("w2", ["D:\\projects\\picode"], () => { /* 同上 */ });

    // 都刚连上（时刻一样）：按标识排，谁都不会一会儿变一个
    const first = reg.pick("D:\\projects\\picode")!.id;
    assert.equal(reg.pick("D:\\projects\\picode")!.id, first, "同样条件下每次挑到的是同一个");

    // 等一毫秒：markActive 记的是当前时刻，同一毫秒内动手跟"刚连上"分不出先后
    await new Promise((r) => setTimeout(r, 5));
    reg.markActive(first === "w1" ? "w2" : "w1");
    const other = first === "w1" ? "w2" : "w1";
    assert.equal(reg.pick("D:\\projects\\picode")!.id, other, "有人动过的那个优先");
});

test("推送（会话触及的文件清单）发给所有开着这个目录的窗口，关掉的窗口不再发", () => {
    const reg = new ScreenRegistry();
    const a: string[] = [];
    const b: string[] = [];
    reg.add("a", ["D:\\projects\\picode"], (m) => a.push(String(m.kind)));
    reg.add("b", ["D:\\projects\\picode"], (m) => b.push(String(m.kind)));
    reg.sendTo("D:\\projects\\picode", { kind: "sessionFiles", files: ["x.ts"] });
    assert.deepEqual(a, ["sessionFiles"]);
    assert.deepEqual(b, ["sessionFiles"], "同一个目录开着两个窗口，两个都要更新符号表");

    reg.remove("b");
    reg.sendTo("D:\\projects\\picode", { kind: "sessionFiles", files: ["y.ts"] });
    assert.deepEqual(a, ["sessionFiles", "sessionFiles"]);
    assert.deepEqual(b, ["sessionFiles"], "关掉的窗口不再发");
});

test("半天没动静的连接会被挑出来收掉（窗口崩了、网断了没通知到）", () => {
    const reg = new ScreenRegistry();
    reg.add("alive", ["D:\\x"], () => { /* 不需要发送 */ });
    assert.deepEqual(reg.staleIds(-1), ["alive"], "负数上限 = 全部算超时（这里只是验筛选逻辑）");
    assert.deepEqual(reg.staleIds(60_000), [], "一分钟没到，还留着");
    assert.equal(reg.count, 1, "挑超时不会顺手把人拿掉（拿掉是调用方的事）");
});

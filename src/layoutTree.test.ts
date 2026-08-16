/**
 * layoutTree 单元测试：tab 内 panel 布局树（递归二叉树）的纯函数操作。
 */
import { strict as assert } from "assert";
import { describe, it } from "node:test";
import {
    layoutLeaves,
    layoutInsertAdjacent,
    layoutRemove,
    layoutReplaceLeaf,
    LayoutNode,
} from "./chatControllerBase";

const p = (id: string): LayoutNode => ({ kind: "panel", panelId: id });

describe("layoutLeaves", () => {
    it("单叶", () => {
        assert.deepStrictEqual(layoutLeaves(p("a")), ["a"]);
    });
    it("嵌套树深度优先序", () => {
        const tree: LayoutNode = {
            kind: "split", orientation: "h",
            children: [
                p("a"),
                { kind: "split", orientation: "v", children: [p("b"), p("c")] },
                p("d"),
            ],
        };
        assert.deepStrictEqual(layoutLeaves(tree), ["a", "b", "c", "d"]);
    });
});

describe("layoutInsertAdjacent", () => {
    it("单叶插入 → 新分叉", () => {
        const t = layoutInsertAdjacent(p("a"), "a", p("b"), "h", false);
        assert.deepStrictEqual(t, { kind: "split", orientation: "h", children: [p("a"), p("b")] });
    });
    it("同向插入保持扁平", () => {
        let t = layoutInsertAdjacent(p("a"), "a", p("b"), "h", false);
        t = layoutInsertAdjacent(t, "a", p("c"), "h", false);
        assert.deepStrictEqual(layoutLeaves(t), ["a", "c", "b"]);
    });
    it("异向插入嵌套新分叉", () => {
        let t = layoutInsertAdjacent(p("a"), "a", p("b"), "h", false);
        t = layoutInsertAdjacent(t, "b", p("d"), "v", true);
        assert.deepStrictEqual(layoutLeaves(t), ["a", "d", "b"]);
    });
    it("before 插入在 anchor 前", () => {
        const t = layoutInsertAdjacent(p("a"), "a", p("b"), "h", true);
        assert.deepStrictEqual(layoutLeaves(t), ["b", "a"]);
    });
});

describe("layoutRemove", () => {
    it("分叉剩一子坍缩", () => {
        let t = layoutInsertAdjacent(p("a"), "a", p("b"), "h", false);
        t = layoutInsertAdjacent(t, "b", p("c"), "h", false);
        const r = layoutRemove(t, "c");
        assert.deepStrictEqual(layoutLeaves(r!), ["a", "b"]);
    });
    it("摘到最后单叶 → 坍缩为叶子", () => {
        const t = layoutInsertAdjacent(p("a"), "a", p("b"), "h", false);
        const r = layoutRemove(t, "b");
        assert.deepStrictEqual(r, p("a"));
    });
    it("全摘 → null", () => {
        assert.strictEqual(layoutRemove(p("a"), "a"), null);
    });
});

describe("layoutReplaceLeaf", () => {
    it("替换目标叶子", () => {
        const t: LayoutNode = { kind: "split", orientation: "h", children: [p("x"), p("y")] };
        const r = layoutReplaceLeaf(t, "y", p("z"));
        assert.deepStrictEqual(layoutLeaves(r), ["x", "z"]);
    });
    it("anchor 不存在原样返回", () => {
        const r = layoutReplaceLeaf(p("x"), "nope", p("z"));
        assert.deepStrictEqual(r, p("x"));
    });
});

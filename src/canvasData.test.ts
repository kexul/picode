import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
    buildCanvasFamily,
    buildContentMessages,
    keepLastAssistantPerRound,
    pathIdsToRoot,
    resolveMessageFile,
    sameSessionFile,
    type CanvasMsg,
    type CanvasSessionMeta,
} from "./canvasData";

describe("buildContentMessages", () => {
    it("keeps only non-empty user/assistant and rewires parents over gaps", () => {
        const entries = [
            { id: "m1", parentId: null, role: "user" as const, text: "hi", isContent: true },
            { id: "t1", parentId: "m1", isContent: false },
            { id: "a1", parentId: "t1", role: "assistant" as const, text: "", isContent: false },
            { id: "t2", parentId: "a1", isContent: false },
            { id: "a2", parentId: "t2", role: "assistant" as const, text: "hello", isContent: true },
            { id: "m2", parentId: "a2", role: "user" as const, text: "next", isContent: true },
        ];
        const msgs = buildContentMessages(entries);
        assert.equal(msgs.length, 3);
        assert.deepEqual(
            msgs.map((m) => [m.id, m.parentId]),
            [
                ["m1", null],
                ["a2", "m1"],
                ["m2", "a2"],
            ]
        );
    });

    it("drops empty content roles", () => {
        const msgs = buildContentMessages([
            { id: "u", parentId: null, role: "user", text: "  ", isContent: false },
            { id: "a", parentId: "u", role: "assistant", text: "ok", isContent: true },
        ]);
        assert.equal(msgs.length, 1);
        assert.equal(msgs[0].id, "a");
        assert.equal(msgs[0].parentId, null);
    });
});

describe("session titles", () => {
    it("reads the newest session_info name for the history list", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-title-"));
        const file = path.join(dir, "session.jsonl");
        try {
            fs.writeFileSync(file, [
                JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" }),
                JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "修复登录问题" } }),
                JSON.stringify({ type: "session_info", id: "i1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", name: "修复登录重定向" }),
                JSON.stringify({ type: "session_info", id: "i2", parentId: "i1", timestamp: "2026-01-01T00:00:03.000Z", name: "修复 OAuth 登录重定向" }),
            ].join("\n"), "utf8");
            const family = await buildCanvasFamily({
                header: { id: "s1", file, timestamp: "2026-01-01T00:00:00.000Z" },
                depth: 0,
                children: [],
            });
            assert.equal(family.sessions[0].name, "修复 OAuth 登录重定向");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("pathIdsToRoot", () => {
    it("walks parent chain", () => {
        const messages: CanvasMsg[] = [
            { id: "a", role: "user", text: "a", parentId: null, children: ["b"], files: [] },
            { id: "b", role: "assistant", text: "b", parentId: "a", children: ["c"], files: [] },
            { id: "c", role: "user", text: "c", parentId: "b", children: [], files: [] },
        ];
        assert.deepEqual(pathIdsToRoot(messages, "c"), ["c", "b", "a"]);
        assert.deepEqual(pathIdsToRoot(messages, null), []);
    });
});

describe("keepLastAssistantPerRound", () => {
    function mk(id: string, role: "user" | "assistant", parentId: string | null, ts = ""): CanvasMsg {
        return { id, role, text: id, parentId, children: [], files: [], timestamp: ts };
    }
    function link(msgs: CanvasMsg[]): void {
        const byId = new Map(msgs.map((m) => [m.id, m]));
        for (const m of msgs) {
            if (m.parentId && byId.has(m.parentId)) {
                byId.get(m.parentId)!.children.push(m.id);
            }
        }
    }

    it("keeps only the last assistant of each round", () => {
        const msgs = [
            mk("m1", "user", null, "t1"),
            mk("a1", "assistant", "m1", "t2"),
            mk("a2", "assistant", "a1", "t3"),
            mk("a3", "assistant", "a2", "t4"),
            mk("m2", "user", "a3", "t5"),
        ];
        link(msgs);
        const kept = keepLastAssistantPerRound(msgs);
        assert.deepEqual(kept.map((m) => m.id), ["m1", "a3", "m2"]);
        const a3 = kept.find((m) => m.id === "a3")!;
        assert.equal(a3.parentId, "m1");
        assert.deepEqual(a3.children, ["m2"]);
        assert.deepEqual(kept[0].children, ["a3"]);
    });

    it("keeps assistant that has a user child (round ends in that branch)", () => {
        const msgs = [
            mk("m1", "user", null),
            mk("a1", "assistant", "m1"),
            mk("a2", "assistant", "a1"),
            mk("m2", "user", "a1"), // 分支：此轮在 a1 结束
        ];
        link(msgs);
        const kept = keepLastAssistantPerRound(msgs);
        const a1 = kept.find((m) => m.id === "a1")!;
        assert.deepEqual(kept.map((m) => m.id).sort(), ["a1", "a2", "m1", "m2"]);
        assert.deepEqual(a1.children, ["a2", "m2"]);
    });

    it("rewires parents past dropped messages", () => {
        const msgs = [
            mk("m1", "user", null),
            mk("a1", "assistant", "m1"),
            mk("a2", "assistant", "a1"),
        ];
        link(msgs);
        const kept = keepLastAssistantPerRound(msgs);
        assert.deepEqual(kept.map((m) => m.id), ["m1", "a2"]);
        assert.equal(kept[1].parentId, "m1");
        assert.deepEqual(kept[1].children, []);
    });

    it("orphan assistant chain collapses to its last message (new root)", () => {
        const msgs = [
            mk("a1", "assistant", null),
            mk("a2", "assistant", "a1"),
        ];
        link(msgs);
        const kept = keepLastAssistantPerRound(msgs);
        assert.deepEqual(kept.map((m) => m.id), ["a2"]);
        assert.equal(kept[0].parentId, null);
    });
});

describe("resolveMessageFile", () => {
    const sessions: CanvasSessionMeta[] = [
        { id: "s1", file: "C:\\s\\a.jsonl", timestamp: "2026-01-01T00:00:00.000Z", leafId: "x" },
        { id: "s2", file: "C:\\s\\b.jsonl", timestamp: "2026-02-01T00:00:00.000Z", leafId: "y" },
    ];
    const msg: CanvasMsg = {
        id: "m",
        role: "user",
        text: "t",
        parentId: null,
        children: [],
        files: ["C:\\s\\a.jsonl", "C:\\s\\b.jsonl"],
    };

    it("prefers highlight file when present", () => {
        assert.equal(
            resolveMessageFile(msg, sessions, "c:/s/a.jsonl"),
            "C:\\s\\a.jsonl"
        );
    });

    it("falls back to newest session", () => {
        assert.equal(resolveMessageFile(msg, sessions, null), "C:\\s\\b.jsonl");
    });
});

describe("sameSessionFile", () => {
    it("ignores separators and drive case", () => {
        assert.equal(sameSessionFile("C:\\Foo\\a.jsonl", "c:/foo/a.jsonl"), true);
        assert.equal(sameSessionFile("a", "b"), false);
    });
});

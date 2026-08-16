import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    cleanToolOutput,
    countImages,
    extractErrorText,
    extractResultText,
    extractTruncation,
    formatPiError,
    getModelThinkingLevels,
    historyEditInfo,
    resolveAnchorLine,
    slimTree,
    summarizeToolCall,
    textOf,
    toolFilePath,
} from "./messageUtils";
import { forkSelectedText, isRpcOk, rpcErrorMessage } from "./piRpc";

describe("formatPiError", () => {
    it("extracts message from status + JSON provider error", () => {
        const raw = '401 {"error":{"message":"Invalid API key","type":"authentication_error"}}';
        assert.equal(formatPiError(raw), "401 Invalid API key");
    });

    it("handles nested error.error.message (overloaded shape)", () => {
        const raw =
            '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
        assert.equal(formatPiError(raw), "529 Overloaded");
    });

    it("passes through plain text", () => {
        assert.equal(formatPiError("Something broke"), "Something broke");
    });

    it("keeps invalid JSON as-is", () => {
        const raw = '500 {"error":{"message":"trunca';
        assert.equal(formatPiError(raw), raw);
    });

    it("truncates very long errors", () => {
        const raw = "x".repeat(500);
        assert.equal(formatPiError(raw).length, 301); // 300 chars + ellipsis
    });

    it("returns empty string as-is", () => {
        assert.equal(formatPiError(""), "");
    });
});

describe("textOf", () => {
    it("handles string content", () => {
        assert.equal(textOf("hello"), "hello");
    });

    it("joins text parts and ignores non-text", () => {
        assert.equal(
            textOf([
                { type: "text", text: "a" },
                { type: "image", data: "x" },
                { type: "text", text: "b" },
            ]),
            "ab"
        );
    });

    it("returns empty for unknown shapes", () => {
        assert.equal(textOf(null), "");
        assert.equal(textOf(42), "");
        assert.equal(textOf({}), "");
    });
});

describe("countImages", () => {
    it("counts image parts only", () => {
        assert.equal(countImages([{ type: "text", text: "x" }, { type: "image" }, { type: "image" }]), 2);
        assert.equal(countImages("hi"), 0);
    });
});

describe("cleanToolOutput", () => {
    it("strips ansi and carriage returns", () => {
        assert.equal(cleanToolOutput("a\r\n\x1b[31mb\x1b[0m"), "a\nb");
    });

    it("truncates oversized output", () => {
        const out = cleanToolOutput("x".repeat(50), 20);
        assert.ok(out.startsWith("x".repeat(20)));
        assert.ok(out.includes("输出过长已截断"));
    });
});

describe("extractResultText", () => {
    it("reads content text parts", () => {
        assert.equal(
            extractResultText({ content: [{ type: "text", text: "ok" }] }),
            "ok"
        );
    });

    it("reads bare string", () => {
        assert.equal(extractResultText("plain"), "plain");
    });

    it("returns undefined when empty", () => {
        assert.equal(extractResultText(undefined), undefined);
        assert.equal(extractResultText({ content: [] }), undefined);
    });
});

describe("extractTruncation", () => {
    it("returns undefined when not truncated", () => {
        assert.equal(extractTruncation({ details: {} }), undefined);
        assert.equal(extractTruncation(null), undefined);
    });

    it("maps truncation fields", () => {
        const info = extractTruncation({
            details: {
                truncation: { truncated: true, truncatedBy: "lines", outputLines: 10, totalLines: 99 },
                fullOutputPath: "/tmp/out.txt",
            },
        });
        assert.deepEqual(info, {
            truncated: true,
            truncatedBy: "lines",
            outputLines: 10,
            totalLines: 99,
            fullOutputPath: "/tmp/out.txt",
        });
    });
});

describe("extractErrorText", () => {
    it("prefers text content", () => {
        assert.equal(
            extractErrorText({ content: [{ type: "text", text: "boom" }] }),
            "boom"
        );
    });
});

describe("toolFilePath", () => {
    it("accepts path and file_path", () => {
        assert.equal(toolFilePath({ path: "a.ts" }), "a.ts");
        assert.equal(toolFilePath({ file_path: "b.ts" }), "b.ts");
        assert.equal(toolFilePath({}), null);
        assert.equal(toolFilePath(null), null);
    });
});

describe("getModelThinkingLevels", () => {
    it("returns off when model has no reasoning", () => {
        assert.deepEqual(getModelThinkingLevels({ id: "m" }), ["off"]);
        assert.deepEqual(getModelThinkingLevels(undefined), ["off"]);
    });

    it("filters null mappings and opt-in xhigh/max", () => {
        const levels = getModelThinkingLevels({
            id: "m",
            reasoning: true,
            thinkingLevelMap: {
                off: "none",
                low: "low",
                medium: "medium",
                high: null,
                xhigh: "xhigh",
            },
        });
        assert.ok(levels.includes("off"));
        assert.ok(levels.includes("low"));
        assert.ok(levels.includes("medium"));
        assert.ok(!levels.includes("high"));
        assert.ok(levels.includes("xhigh"));
        assert.ok(!levels.includes("max"));
    });
});

describe("slimTree", () => {
    it("keeps full user text and clips assistant", () => {
        const longAssistant = "z".repeat(200);
        const tree = slimTree([
            {
                entry: {
                    type: "message",
                    id: "u1",
                    parentId: null,
                    message: {
                        role: "user",
                        content: [{ type: "text", text: "  keep   spaces  " }],
                    },
                },
                children: [
                    {
                        entry: {
                            type: "message",
                            id: "a1",
                            parentId: "u1",
                            message: { role: "assistant", content: longAssistant },
                        },
                        children: [],
                    },
                ],
            },
        ]);
        const userText = (tree[0].entry.message?.content as any[])[0].text;
        assert.equal(userText, "  keep   spaces  ");
        const asstText = (tree[0].children![0].entry.message?.content as any[])[0].text;
        assert.equal(asstText.length, 120);
        assert.equal(asstText, "z".repeat(120));
    });

    it("preserves branch_summary", () => {
        const tree = slimTree([
            { entry: { type: "branch_summary", id: "b1", summary: "sum" }, children: [] },
        ]);
        assert.equal(tree[0].entry.summary, "sum");
    });
});

describe("historyEditInfo", () => {
    it("prefers details.diff", () => {
        assert.equal(
            historyEditInfo({ name: "edit" }, { details: { diff: "-a\n+b" } }),
            "-a\n+b"
        );
    });

    it("builds edit diff from args", () => {
        assert.equal(
            historyEditInfo(
                { name: "edit", arguments: { oldText: "a\nb", newText: "c" } },
                null
            ),
            "-a\n-b\n+c"
        );
    });

    it("builds write diff as all additions", () => {
        assert.equal(
            historyEditInfo({ name: "write", arguments: { content: "x\ny" } }, null),
            "+x\n+y"
        );
    });
});

describe("resolveAnchorLine", () => {
    const text = ["zero", "one", "two", "target", "four", "target", "six"].join("\n");

    it("returns fallback when anchor empty or exact hit", () => {
        assert.equal(resolveAnchorLine(text, "", 3), 3);
        assert.equal(resolveAnchorLine(text, "two", 3), 3);
    });

    it("prefers nearer match below then above", () => {
        // fallback line 6 ("target" at index 5) — exact
        assert.equal(resolveAnchorLine(text, "target", 6), 6);
        // fallback line 5 ("four") — nearest target is line 4 (down preferred at equal? distance 1 down is line 6, distance 1 up is line 4)
        // from fb0=4 ("four"): down d=1 -> "target" at 5 -> line 6
        assert.equal(resolveAnchorLine(text, "target", 5), 6);
        // from fb0=2 ("two"): down d=1 "target" at 3 -> line 4
        assert.equal(resolveAnchorLine(text, "target", 3), 4);
    });

    it("falls back to first full-file match outside window", () => {
        const long = ["needle", ...Array(300).fill("x")].join("\n");
        // fallback 靠近末尾、窗口 10 够不到第 1 行的 needle → 走全文扫描
        assert.equal(resolveAnchorLine(long, "needle", 250, 10), 1);
    });
});

describe("piRpc helpers", () => {
    it("isRpcOk / rpcErrorMessage / forkSelectedText", () => {
        assert.equal(isRpcOk(undefined), false);
        assert.equal(isRpcOk({ type: "response", success: false, error: "x" }), false);
        assert.equal(isRpcOk({ type: "response", success: true, data: {} }), true);
        assert.equal(isRpcOk({ type: "response" }), true);

        assert.equal(rpcErrorMessage(undefined, "fb"), "fb");
        assert.equal(rpcErrorMessage({ type: "response", error: "nope" }), "nope");

        assert.equal(forkSelectedText({ type: "response", data: { text: "hi" } }), "hi");
        assert.equal(forkSelectedText({ type: "response", data: { cancelled: true } }), "");
        assert.equal(forkSelectedText(undefined), "");
    });
});

describe("summarizeToolCall", () => {
    it("提取已知工具的关键参数", () => {
        assert.equal(summarizeToolCall("bash", { command: "npm test" }), "npm test");
        assert.equal(summarizeToolCall("read", { path: "src/a.ts" }), "src/a.ts");
        assert.equal(summarizeToolCall("grep", { pattern: "foo", path: "src" }), "foo in src");
        assert.equal(summarizeToolCall("ls", { path: "." }), ".");
    });
    it("未知工具回退 JSON 入参", () => {
        assert.equal(summarizeToolCall("custom", { a: 1 }), '{"a":1}'
        );
        assert.equal(summarizeToolCall("custom", {}), "");
    });
    it("截断超长摘要", () => {
        const long = "x".repeat(300);
        const s = summarizeToolCall("bash", { command: long });
        assert.equal(s.length, 121); // 120 + “…”
        assert.ok(s.endsWith("…"));
    });
});

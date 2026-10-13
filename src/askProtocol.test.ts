/**
 * 问话（askProtocol）：暗号行与回话文件的格式。
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
    ASK_FRAME_PREFIX,
    AskRequest,
    cleanStaleAskAnswers,
    decodeAskFrame,
    encodeAskFrame,
    normalizeAskRequest,
    readAskAnswer,
    writeAskAnswer,
} from "./askProtocol";

function askPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { kind: "ask", id: "a1b2c3d4", question: "选 A 还是 B？", options: ["A", "B"], ...extra };
}

test("暗号行：造出来能原样解回去", () => {
    const line = encodeAskFrame(askPayload({ multi: true, recommended: [1], parentSessionFile: "C:\\x\\y.jsonl" }));
    assert.ok(line.startsWith(ASK_FRAME_PREFIX));
    assert.equal(line.indexOf("\n"), -1, "暗号行里不能有换行");
    const req = decodeAskFrame(line) as AskRequest;
    assert.equal(req.question, "选 A 还是 B？");
    assert.deepEqual(req.options, ["A", "B"]);
    assert.equal(req.multi, true);
    assert.deepEqual(req.recommended, [1]);
    assert.equal(req.allowText, true, "没写 allowText 默认要“自己写”那一行");
    assert.equal(req.parentSessionFile, "C:\\x\\y.jsonl");
});

test("暗号行：问题里有换行、引号、反斜杠都不影响", () => {
    const question = '第一行\r\n第二行 "带引号" C:\\path\\to\\file ##PICHAT_ASK## 假暗号';
    const req = decodeAskFrame(encodeAskFrame(askPayload({ question }))) as AskRequest;
    assert.equal(req.question, question);
});

test("问话请求：缺问题、选项不够两个、编号不合法都算不合法", () => {
    assert.equal(normalizeAskRequest(askPayload({ question: "" })), undefined);
    assert.equal(normalizeAskRequest(askPayload({ options: ["只有一个"] })), undefined);
    assert.equal(normalizeAskRequest(askPayload({ id: "带/斜杠" })), undefined);
    assert.equal(normalizeAskRequest({ kind: "stop", id: "a1" }), undefined, "别的种类的暗号不当问话");
});

test("问话请求：推荐项超范围 / 重复 / 不是整数都丢掉", () => {
    const req = normalizeAskRequest(askPayload({ options: ["A", "B", "C"], recommended: [3, 3, 9, 0, 1.5, 2] }))!;
    assert.deepEqual(req.recommended, [2, 3]);
});

test("问话请求：选项最多 8 个、每个截断到 400 字", () => {
    const many = Array.from({ length: 12 }, (_, i) => "选项" + i);
    const req = normalizeAskRequest(askPayload({ options: many }))!;
    assert.equal(req.options.length, 8);
    const long = normalizeAskRequest(askPayload({ options: ["A", "B".repeat(500)] }))!;
    assert.equal(long.options[1].length, 400);
});

test("“不等了”的通知：解出来是 ask-done", () => {
    const decoded = decodeAskFrame(encodeAskFrame({ kind: "ask-done", id: "a1b2" }));
    assert.deepEqual(decoded, { kind: "ask-done", id: "a1b2" });
    assert.equal(decodeAskFrame(encodeAskFrame({ kind: "ask-done", id: "带/斜杠" })), undefined);
});

test("回话文件：写进去能读回来（先写临时文件再改名，不留 .tmp）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-ask-"));
    try {
        assert.equal(writeAskAnswer(dir, { id: "a1", cancelled: false, picked: ["A", "C"], text: "自己写的" }), true);
        const back = readAskAnswer(dir, "a1")!;
        assert.deepEqual(back, { id: "a1", cancelled: false, picked: ["A", "C"], text: "自己写的" });
        const files = fs.readdirSync(path.join(dir, "ask-answers"));
        assert.deepEqual(files, ["a1.json"], "临时文件不该留下");
        // 编号不合法、文件还没有：都当读不到（不能让扩展那边认错）
        assert.equal(writeAskAnswer(dir, { id: "带/斜杠", cancelled: true, picked: [], text: "" }), false);
        assert.equal(readAskAnswer(dir, "没写过"), undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("回话文件：太老的残留会被清掉，新的不动", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-ask-"));
    try {
        writeAskAnswer(dir, { id: "old", cancelled: true, picked: [], text: "" });
        writeAskAnswer(dir, { id: "new", cancelled: true, picked: [], text: "" });
        const answers = path.join(dir, "ask-answers");
        const oldFile = path.join(answers, "old.json");
        const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
        fs.utimesSync(oldFile, past, past);
        cleanStaleAskAnswers(dir);
        assert.deepEqual(fs.readdirSync(answers), ["new.json"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * stderr 暗号切割（见 piFrames.ts）：切行、按前缀认领、剩下的当普通输出。
 *
 * 这两种暗号的形状在各自的协议文件里测（tabaProtocol.test.ts / askProtocol.test.ts），
 * 这里专测"切割"这一层：混着来、被切块、夹着杂音、暗号行不进日志。
 */
import * as assert from "node:assert/strict";
import test from "node:test";
import { ASK_DECODER, ASK_FRAME_PREFIX, AskRequest } from "./askProtocol";
import { StderrFrameSplitter } from "./piFrames";
import { TABA_DECODER, TABA_FRAME_PREFIX, TabaRequest, encodeTabaFrame } from "./tabaProtocol";

function splitter(): StderrFrameSplitter {
    return new StderrFrameSplitter([TABA_DECODER, ASK_DECODER]);
}

function tabaFrame(payload: Record<string, unknown>): string {
    return encodeTabaFrame(payload) + "\n";
}

function askFrame(payload: Record<string, unknown>): string {
    return ASK_FRAME_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\n";
}

test("pi 自己的 stderr 输出不会被当成暗号（但要留给调用方打日志）", () => {
    const parser = splitter();
    const out = parser.feed(
        "Error: Failed to load extension \"C:\\x\\y.ts\": boom\nHint: Start without extensions using \"pi -ne\".\n(node:1234) Warning: something\n"
    );
    assert.deepEqual(out, [], "不是暗号就不出东西");
    assert.deepEqual(parser.takeOtherLines(), [
        "Error: Failed to load extension \"C:\\x\\y.ts\": boom",
        'Hint: Start without extensions using "pi -ne".',
        "(node:1234) Warning: something",
    ]);
    assert.deepEqual(parser.takeOtherLines(), [], "取过就该清空");
});

test("暗号行不能出现在日志里（两种都一样）", () => {
    const parser = splitter();
    const out = parser.feed(
        `先一行普通输出\n${tabaFrame({ kind: "spawn", id: "a1", name: "施工", task: "改个 bug" })}后一行普通输出\n`
        + `${askFrame({ kind: "ask", id: "q1", question: "选哪个？", options: ["A", "B"] })}收尾一行\n`
    );
    assert.equal(out.length, 2);
    assert.deepEqual(parser.takeOtherLines(), ["先一行普通输出", "后一行普通输出", "收尾一行"]);
});

test("一行被切成两块也能拼回来", () => {
    const line = tabaFrame({ kind: "spawn", id: "abc", name: "施工", task: "改个 bug" });
    const parser = splitter();
    const cut = 7;
    assert.deepEqual(parser.feed(line.slice(0, cut)), [], "半行不该出结果");
    const out = parser.feed(line.slice(cut));
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "taba");
    assert.equal((out[0].value as TabaRequest & { name?: string }).name, "施工");
});

test("CRLF 换行、一次多行、两种暗号夹着杂音都能解", () => {
    const a = tabaFrame({ kind: "spawn", id: "1", name: "a", task: "ta" });
    const b = askFrame({ kind: "ask", id: "q2", question: "选哪个？", options: ["A", "B"], multi: true });
    const parser = splitter();
    const out = parser.feed(`噪音\r\n${a.replace("\n", "\r\n")}更多噪音\n${b.replace("\n", "\r\n")}`);
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, "taba");
    assert.equal(out[1].kind, "ask");
    assert.equal((out[1].value as AskRequest).multi, true);
    assert.deepEqual(parser.takeOtherLines(), ["噪音", "更多噪音"]);
});

test("前缀对但内容不合法：不算暗号，也不能悄悄吃掉（当普通输出留给日志）", () => {
    const parser = splitter();
    const out = parser.feed(`${TABA_FRAME_PREFIX}这不是base64\n${ASK_FRAME_PREFIX}\n`);
    assert.deepEqual(out, []);
    assert.equal(parser.takeOtherLines().length, 2, "两行都不是合法的暗号：留下打日志，但不能停下来");
});

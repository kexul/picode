import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
    TABA_FRAME_PREFIX,
    TabaFrameParser,
    decodeTabaFrame,
    encodeTabaFrame,
    normalizeTabaRequest,
} from "./tabaProtocol";

test("暗号行：造出来能原样解回去", () => {
    const line = encodeTabaFrame({ kind: "spawn", id: "a1b2c3d4", name: "侦察: 认证", task: "看一下认证模块" });
    assert.ok(line.startsWith(TABA_FRAME_PREFIX));
    assert.equal(line.indexOf("\n"), -1, "暗号行里不能有换行");
    const req = decodeTabaFrame(line);
    assert.equal(req?.kind, "spawn");
    assert.equal((req as any).id, "a1b2c3d4");
    assert.equal((req as any).name, "侦察: 认证");
    assert.equal((req as any).task, "看一下认证模块");
});

test("暗号行：任务里有换行、引号、反斜杠都不影响", () => {
    const task = '第一行\r\n第二行 "带引号" C:\\path\\to\\file ##PICHAT_TABA## 假暗号';
    const line = encodeTabaFrame({ kind: "spawn", id: "x1", name: "n", task });
    const req: any = decodeTabaFrame(line);
    assert.equal(req.task, task);
});

test("pi 自己的 stderr 输出不会被当成暗号", () => {
    const parser = new TabaFrameParser();
    const out = parser.feed(
        "Error: Failed to load extension \"C:\\x\\y.ts\": boom\nHint: Start without extensions using \"pi -ne\".\n(node:1234) Warning: something\n"
    );
    assert.deepEqual(out, []);
});

test("一行被切成两块也能拼回来", () => {
    const line = encodeTabaFrame({ kind: "spawn", id: "abc", name: "施工", task: "改个 bug" }) + "\n";
    const parser = new TabaFrameParser();
    const cut = 7;
    assert.deepEqual(parser.feed(line.slice(0, cut)), [], "半行不该出结果");
    const out = parser.feed(line.slice(cut));
    assert.equal(out.length, 1);
    assert.equal((out[0] as any).name, "施工");
});

test("CRLF 换行、一次多行、夹着杂音都能解", () => {
    const a = encodeTabaFrame({ kind: "spawn", id: "1", name: "a", task: "ta" });
    const b = encodeTabaFrame({ kind: "stop", id: "1" });
    const parser = new TabaFrameParser();
    const out = parser.feed(`噪音\r\n${a}\r\n更多噪音\n${b}\n`);
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, "spawn");
    assert.equal(out[1].kind, "stop");
    assert.equal((out[1] as any).id, "1");
});

test("暗号混在一行中间也能挑出来", () => {
    const payload = encodeTabaFrame({ kind: "spawn", id: "9", name: "n", task: "t" });
    const req = decodeTabaFrame("前面的垃圾 " + payload.slice(TABA_FRAME_PREFIX.length - 2) + " 后面的垃圾");
    // 前缀被截断的两个字符会让这一行不认：宁可不认，也不能认错
    assert.equal(req, undefined);
    const ok = decodeTabaFrame("前面的垃圾 " + payload + " 后面的垃圾");
    assert.equal((ok as any)?.id, "9");
});

test("派活请求：缺名字或缺任务都算不合法", () => {
    assert.equal(normalizeTabaRequest({ kind: "spawn", id: "1", task: "t" }), undefined);
    assert.equal(normalizeTabaRequest({ kind: "spawn", id: "1", name: "n" }), undefined);
    assert.equal(normalizeTabaRequest({ kind: "spawn", name: "n", task: "t" }), undefined);
    assert.equal(normalizeTabaRequest({ kind: "spawn", id: "带 空格", name: "n", task: "t" }), undefined);
    assert.equal(normalizeTabaRequest({ kind: "spawn", id: "..\\..\\x", name: "n", task: "t" }), undefined);
    assert.equal(normalizeTabaRequest(null), undefined);
    assert.equal(normalizeTabaRequest("spawn"), undefined);
    assert.equal(normalizeTabaRequest({ kind: "unknown" }), undefined);
});

test("派活请求：可选字段只有真有内容才带上", () => {
    const req: any = normalizeTabaRequest({
        kind: "spawn", id: "i", name: " n ", task: " t ",
        agent: "  ", model: "", thinking: null, tools: "read,bash", cwd: "", fork: false,
    });
    assert.equal(req.name, "n");
    assert.equal(req.task, "t");
    assert.equal(req.tools, "read,bash");
    assert.equal("agent" in req, false);
    assert.equal("model" in req, false);
    assert.equal("thinking" in req, false);
    assert.equal("cwd" in req, false);
    assert.equal("fork" in req, false, "fork 只有明确为 true 才带");
});

test("派活请求：超长任务被截断而不是整条丢掉", () => {
    const req: any = normalizeTabaRequest({ kind: "spawn", id: "i", name: "n", task: "x".repeat(30000) });
    assert.ok(req);
    assert.equal(req.task.length, 20000);
});

test("停止请求：编号和名字至少要有一个", () => {
    assert.equal(normalizeTabaRequest({ kind: "stop" }), undefined);
    const byName: any = normalizeTabaRequest({ kind: "stop", name: "侦察" });
    assert.equal(byName.name, "侦察");
    assert.equal("id" in byName, false);
    const byId: any = normalizeTabaRequest({ kind: "stop", id: "ab12" });
    assert.equal(byId.id, "ab12");
});

test("攒行器：没有换行的半行一直留着，不会丢", () => {
    const line = encodeTabaFrame({ kind: "spawn", id: "z", name: "n", task: "t" });
    const parser = new TabaFrameParser();
    assert.deepEqual(parser.feed(line.slice(0, 20)), []);
    assert.deepEqual(parser.feed(line.slice(20)), [], "还没换行，仍然不出结果");
    const out = parser.feed("\n");
    assert.equal(out.length, 1);
    assert.equal((out[0] as any).id, "z");
});

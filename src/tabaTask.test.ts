import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
    buildChildSessionLines,
    buildTaskText,
    childSessionFileName,
    forkContentLines,
    piSessionDirFor,
    resolveSessionMode,
    sessionHeaderLine,
    TABA_CLOSING_INSTRUCTION,
} from "./tabaTask";

const line = (o: unknown) => JSON.stringify(o);
const msg = (role: string, text: string) => ({ type: "message", id: role + text.length, message: { role, content: [{ type: "text", text }] } });

test("会话内容从哪来：派活时的 fork 参数优先于角色定义", () => {
    assert.equal(resolveSessionMode({ fork: true }, { sessionMode: "standalone" }), "fork");
    assert.equal(resolveSessionMode({ fork: false }, { sessionMode: "fork" }), "fork", "角色说要带上下文就带");
    assert.equal(resolveSessionMode({}, { sessionMode: undefined }), "standalone", "都不说就是全新会话");
    assert.equal(resolveSessionMode({ fork: true }), "fork");
});

test("会话内容从哪来：没角色就是全新会话", () => {
    assert.equal(resolveSessionMode({}), "standalone");
    assert.equal(resolveSessionMode({ fork: false }), "standalone");
});

test("pi 的会话目录名：分隔符和冒号都换成横杠，两头加双横杠", () => {
    const win = piSessionDirFor("D:\\projects\\picode", "C:\\Users\\kkk\\.pi\\agent").replace(/\\/g, "/");
    assert.equal(win, "C:/Users/kkk/.pi/agent/sessions/--D--projects-picode--");
    const posix = piSessionDirFor("/home/kkk/proj", "/home/kkk/.pi/agent").replace(/\\/g, "/");
    assert.equal(posix, "/home/kkk/.pi/agent/sessions/--home-kkk-proj--");
});

test("子会话文件名跟 pi 自己起的一样", () => {
    assert.equal(
        childSessionFileName("2026-10-07T18:30:00.123Z", "019fc1fa-1234"),
        "2026-10-07T18-30-00-123Z_019fc1fa-1234.jsonl"
    );
});

test("会话头带上父会话路径，pi 那边就能看出父子关系", () => {
    const header = JSON.parse(sessionHeaderLine({
        sessionId: "abc", cwd: "D:\\projects\\picode", timestamp: "2026-10-07T18:30:00.000Z", parentSessionFile: "D:\\p.jsonl",
    }));
    assert.equal(header.type, "session");
    assert.equal(header.version, 3);
    assert.equal(header.id, "abc");
    assert.equal(header.parentSession, "D:\\p.jsonl");
    const noParent = JSON.parse(sessionHeaderLine({ sessionId: "abc", cwd: "/x", timestamp: "t" }));
    assert.equal("parentSession" in noParent, false);
});

test("带上下文：截到最后一条用户消息之前，会话头丢掉，坏行丢掉", () => {
    const parent = [
        line({ type: "session", version: 3, id: "parent", cwd: "/x" }),
        line(msg("user", "第一句")),
        line(msg("assistant", "第一答")),
        line({ type: "branch_summary", id: "b1", summary: "摘要" }),
        line(msg("user", "派活那一句")),
        line(msg("assistant", "已派出")),
        "{ 坏掉的行",
    ];
    const kept = forkContentLines(parent).map((l) => JSON.parse(l));
    assert.equal(kept.length, 3, "只留派活之前那三条");
    assert.equal(kept[0].message.role, "user");
    assert.equal(kept[2].type, "branch_summary");
    assert.equal(kept.some((k) => k.type === "session"), false, "父会话头不能带过去");
});

test("带上下文：父会话里一条用户消息都没有时，除会话头外都带过去", () => {
    const parent = [line({ type: "session", id: "p" }), line(msg("assistant", "自己冒出来的话"))];
    const kept = forkContentLines(parent);
    assert.equal(kept.length, 1);
});

test("带上下文：空文件不炸", () => {
    assert.deepEqual(forkContentLines([]), []);
    assert.deepEqual(forkContentLines(["", "  "]), []);
});

test("子会话文件内容：只记父子关系时只有一行会话头", () => {
    const lines = buildChildSessionLines({
        mode: "lineage-only", sessionId: "kid", cwd: "/proj", timestamp: "2026-10-07T18:30:00.000Z",
        parentSessionFile: "/proj/parent.jsonl", parentLines: [line(msg("user", "别带过去"))],
    });
    assert.equal(lines.length, 1);
    const header = JSON.parse(lines[0]);
    assert.equal(header.id, "kid");
    assert.equal(header.parentSession, "/proj/parent.jsonl");
});

test("子会话文件内容：带上下文时头在后面对话在前", () => {
    const lines = buildChildSessionLines({
        mode: "fork", sessionId: "kid", cwd: "/proj", timestamp: "t",
        parentSessionFile: "/p.jsonl",
        parentLines: [line({ type: "session", id: "p" }), line(msg("user", "第一句")), line(msg("assistant", "第一答")), line(msg("user", "派活"))],
    });
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).id, "kid");
    assert.equal(JSON.parse(lines[1]).message.content[0].text, "第一句");
});

test("给子会话的第一条消息：角色说明 + 任务 + 收尾要求都在", () => {
    const text = buildTaskText({ roleBody: "你是摸底角色。", bodyInTask: true, skills: "hai, grill", task: "看看认证模块" });
    assert.ok(text.includes("/skill:hai"));
    assert.ok(text.includes("/skill:grill"));
    assert.ok(text.includes("【你的角色】"));
    assert.ok(text.includes("你是摸底角色。"));
    assert.ok(text.includes("【任务】"));
    assert.ok(text.includes("看看认证模块"));
    assert.ok(text.includes(TABA_CLOSING_INSTRUCTION.split("\n")[0]));
    assert.ok(text.indexOf("看看认证模块") > text.indexOf("你是摸底角色。"), "任务在角色说明后面");
});

test("给子会话的第一条消息：说明书走系统提示词时不重复一遍", () => {
    const text = buildTaskText({ roleBody: "你是摸底角色。", bodyInTask: false, task: "看看认证模块" });
    assert.equal(text.includes("你是摸底角色。"), false);
    assert.ok(text.includes("看看认证模块"));
});

test("给子会话的第一条消息：没技能就没那一段", () => {
    const text = buildTaskText({ bodyInTask: false, task: "干活" });
    assert.equal(text.includes("/skill:"), false);
    assert.equal(text.startsWith("【任务】"), true);
});

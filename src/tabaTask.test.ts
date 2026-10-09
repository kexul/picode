import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildTaskText, TABA_CLOSING_INSTRUCTION } from "./tabaTask";

test("第一条消息：任务在前，收尾要求在后", () => {
    const text = buildTaskText({ task: "看看认证模块" });
    assert.ok(text.includes("【任务】"));
    assert.ok(text.includes("看看认证模块"));
    assert.ok(text.includes(TABA_CLOSING_INSTRUCTION.split("\n")[0]));
    assert.ok(text.indexOf("看看认证模块") < text.indexOf("【收尾要求】"), "收尾要求在任务后面");
});

test("第一条消息：只有任务和收尾要求，没有别的东西", () => {
    const text = buildTaskText({ task: "  看看认证模块  \n" });
    assert.equal(text.startsWith("【任务】\n\n看看认证模块"), true, "任务两头的空白去掉");
    assert.equal(text.includes("/skill:"), false, "没有技能行这回事了");
    assert.equal(text.includes("【你的角色】"), false, "没有角色说明这回事了");
    assert.ok(text.includes("---"), "任务和收尾要求之间用分隔线隔开");
});

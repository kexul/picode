import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
    dedupeRoles,
    listableRoles,
    normalizeListValue,
    parseRoleMarkdown,
    pickRoleByName,
    roleDirs,
    splitFrontmatter,
} from "./tabaRoles";

const SCOUT = `---
name: scout
description: 只读摸底，看清代码再回报
model: local/glm-5.3-flash
thinking: low
tools: read, bash
skills: hai, grill-me
session-mode: standalone
system-prompt: append
---

# 摸底角色

你是摸底角色，只读不写。
`;

test("角色文件：前置元数据逐项解出来", () => {
    const role = parseRoleMarkdown(SCOUT, "scout", "project", "/x/.pi/agents/scout.md");
    assert.ok(role);
    assert.equal(role!.name, "scout");
    assert.equal(role!.description, "只读摸底，看清代码再回报");
    assert.equal(role!.model, "local/glm-5.3-flash");
    assert.equal(role!.thinking, "low");
    assert.equal(role!.tools, "read,bash", "工具列表要去掉空格");
    assert.equal(role!.skills, "hai,grill-me");
    assert.equal(role!.sessionMode, "standalone");
    assert.equal(role!.systemPromptMode, "append");
    assert.equal(role!.body.startsWith("# 摸底角色"), true);
    assert.equal(role!.origin, "project");
});

test("角色文件：没有前置元数据也能用，名字取文件名", () => {
    const role = parseRoleMarkdown("你就是个干活的。\n", "worker", "global", "/a/worker.md");
    assert.equal(role!.name, "worker");
    assert.equal(role!.body, "你就是个干活的。");
    assert.equal(role!.description, "");
    assert.equal(role!.tools, undefined);
});

test("角色文件：前置元数据没写完（缺收尾 ---）时整份当正文", () => {
    const text = "---\nname: broken\n没有收尾\n";
    const { front, body } = splitFrontmatter(text);
    assert.deepEqual(front, {});
    assert.equal(body, text);
    const role = parseRoleMarkdown(text, "broken", "project", "/a/broken.md");
    assert.equal(role!.name, "broken", "回落到文件名");
    assert.ok(role!.body.includes("name: broken"));
});

test("角色文件：认不出的字段忽略，值带引号能去掉", () => {
    const role = parseRoleMarkdown(
        '---\nname: "x"\nfoo: bar\nunknown-list: a, b\nthinking: high\n---\n正文\n',
        "x", "builtin", "/b/x.md"
    );
    assert.equal(role!.name, "x");
    assert.equal(role!.thinking, "high");
    assert.equal((role as any).foo, undefined);
});

test("角色文件：session-mode 写错就当成没写", () => {
    const role = parseRoleMarkdown("---\nname: y\nsession-mode: 随便\n---\n", "y", "project", "/y.md");
    assert.equal(role!.sessionMode, undefined);
    const ok = parseRoleMarkdown("---\nname: y\nsession-mode: lineage-only\n---\n", "y", "project", "/y.md");
    assert.equal(ok!.sessionMode, "lineage-only");
});

test("角色文件：声明了要用外部命令行工具的角色标记为跑不了", () => {
    const role = parseRoleMarkdown(
        "---\nname: claude-code\nrunner:\n  type: external-cli\n  command: claude\n---\n正文\n",
        "claude-code", "global", "/c.md"
    );
    assert.ok(role!.unusable);
    assert.equal(listableRoles([role!]).length, 0);
});

test("角色文件：disable-model-invocation 的角色不列出来但能指名用", () => {
    const hidden = parseRoleMarkdown("---\nname: secret\ndisable-model-invocation: true\n---\n", "secret", "project", "/s.md");
    const shown = parseRoleMarkdown("---\nname: open\n---\n", "open", "project", "/o.md");
    assert.equal(listableRoles([hidden!, shown!]).map((r) => r.name).join(","), "open");
    assert.equal(pickRoleByName([hidden!, shown!], "secret")!.name, "secret");
});

test("工具列表归一化：去空格、去空项、去掉重复", () => {
    assert.equal(normalizeListValue("read, bash , edit"), "read,bash,edit");
    assert.equal(normalizeListValue(",,,"), undefined);
    assert.equal(normalizeListValue(""), undefined);
    assert.equal(normalizeListValue("Read, read"), "Read", "大小写算重复，保留先出现的那个写法");
    assert.equal(normalizeListValue(undefined), undefined);
});

test("目录优先级：项目 > 全局 > 插件自带", () => {
    const dirs = roleDirs("/proj", "/bundled", "/agent");
    assert.deepEqual(dirs.map((d) => d.origin), ["project", "global", "builtin"]);
    assert.equal(dirs[0].dir.replace(/\\/g, "/"), "/proj/.pi/agents");
    assert.equal(dirs[1].dir.replace(/\\/g, "/"), "/agent/agents");
    assert.equal(dirs[2].dir.replace(/\\/g, "/"), "/bundled");
});

test("同名角色按优先级留第一个", () => {
    const project = parseRoleMarkdown("---\nname: scout\ndescription: 项目里的\n---\n", "scout", "project", "/p.md")!;
    const global = parseRoleMarkdown("---\nname: scout\ndescription: 全局的\n---\n", "scout", "global", "/g.md")!;
    const kept = dedupeRoles([project, global]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].description, "项目里的");
});

test("按名字找角色：大小写不敏感，允许带 .md", () => {
    const a = parseRoleMarkdown("---\nname: Scout\n---\n", "scout", "project", "/s.md")!;
    assert.equal(pickRoleByName([a], "scout")!.name, "Scout");
    assert.equal(pickRoleByName([a], "SCOUT.md")!.name, "Scout");
    assert.equal(pickRoleByName([a], "没这个"), undefined);
    assert.equal(pickRoleByName([a], "  "), undefined);
});

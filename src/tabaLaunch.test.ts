import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
    buildTabaExtraArgs,
    buildTabaLaunch,
    buildTabaTaskText,
    resolveTabaSpawn,
} from "./tabaLaunch";
import type { TabaSpawnRequest } from "./tabaProtocol";
import type { TabaRole } from "./tabaRoles";

/** 相对路径前面加个斜杠，用来验证"确实问过 resolvePath"。 */
const resolvePath = (p: string): string => (p.startsWith("/") || /^[a-zA-Z]:/.test(p) ? p : "/resolved/" + p);

function req(over: Partial<TabaSpawnRequest> = {}): TabaSpawnRequest {
    return { kind: "spawn", id: "a1", name: "侦察: 认证", task: "看看认证模块", ...over };
}

function role(over: Partial<TabaRole> = {}): TabaRole {
    return { name: "scout", description: "", body: "你是摸底角色。", origin: "builtin", filePath: "/r/scout.md", ...over };
}

const base = { parentCwd: "/proj", parentModelId: "glm-5.3-flash", parentProvider: "local", resolvePath };

test("工作目录：派活时指定的 > 角色定的 > 跟派活那个会话一样", () => {
    assert.equal(resolveTabaSpawn({ req: req(), role: role(), ...base }).cwd, "/proj");
    assert.equal(resolveTabaSpawn({ req: req(), role: role({ cwd: "agents/sre" }), ...base }).cwd, "/resolved/agents/sre");
    assert.equal(
        resolveTabaSpawn({ req: req({ cwd: "D:\\other" }), role: role({ cwd: "agents/sre" }), ...base }).cwd,
        "D:\\other",
        "派活时指定的不用再过 resolvePath（本来就是绝对路径）"
    );
    assert.equal(resolveTabaSpawn({ req: req({ cwd: "sub" }), ...base }).cwd, "/resolved/sub");
});

test("会话内容从哪来：派活时的 fork > 角色定的 > 全新会话", () => {
    assert.equal(resolveTabaSpawn({ req: req(), role: role(), ...base }).mode, "standalone");
    assert.equal(resolveTabaSpawn({ req: req(), role: role({ sessionMode: "fork" }), ...base }).mode, "fork");
    assert.equal(resolveTabaSpawn({ req: req(), role: role({ sessionMode: "lineage-only" }), ...base }).mode, "lineage-only");
    assert.equal(resolveTabaSpawn({ req: req({ fork: true }), role: role({ sessionMode: "standalone" }), ...base }).mode, "fork");
    assert.equal(resolveTabaSpawn({ req: req({ fork: true }), ...base }).mode, "fork");
});

test("工具白名单：派活时指定的 > 角色定的 > 不限制；格式归一化", () => {
    assert.equal(resolveTabaSpawn({ req: req(), role: role(), ...base }).tools, undefined);
    assert.equal(resolveTabaSpawn({ req: req(), role: role({ tools: "read, bash" }), ...base }).tools, "read,bash");
    assert.equal(
        resolveTabaSpawn({ req: req({ tools: "read,bash,edit,write" }), role: role({ tools: "read" }), ...base }).tools,
        "read,bash,edit,write"
    );
    assert.equal(resolveTabaSpawn({ req: req({ tools: " , " }), role: role(), ...base }).tools, undefined, "全是空白当没写");
});

test("模型：派活时指定的 > 角色定的 > 派活那个会话正在用的；思考强度拼在后面", () => {
    assert.equal(resolveTabaSpawn({ req: req(), role: role(), ...base }).modelSpec, "glm-5.3-flash");
    assert.equal(resolveTabaSpawn({ req: req(), role: role({ model: "scout-model", thinking: "low" }), ...base }).modelSpec, "scout-model:low");
    assert.equal(resolveTabaSpawn({ req: req({ model: "m1" }), role: role({ model: "m2" }), ...base }).modelSpec, "m1");
    assert.equal(resolveTabaSpawn({ req: req({ model: "m1", thinking: "high" }), ...base }).modelSpec, "m1:high");
    assert.equal(resolveTabaSpawn({ req: req(), role: role(), ...{ ...base, parentModelId: "" } }).modelSpec, "");
});

test("模型覆盖：写成 provider/model 时不再单独传 provider", () => {
    const withProvider = resolveTabaSpawn({ req: req({ model: "local/glm-5.3-flash" }), ...base }).modelOverride;
    assert.deepEqual(withProvider, { provider: undefined, modelId: "local/glm-5.3-flash" });
    const bare = resolveTabaSpawn({ req: req({ model: "glm-5.3", thinking: "low" }), ...base }).modelOverride;
    assert.deepEqual(bare, { provider: "local", modelId: "glm-5.3:low" });
    assert.equal(resolveTabaSpawn({ req: req(), role: role(), ...{ ...base, parentModelId: "" } }).modelOverride, undefined);
});

test("角色说明放哪：角色文件写了 system-prompt 才走系统提示词", () => {
    assert.equal(resolveTabaSpawn({ req: req(), role: role(), ...base }).bodyInTask, true);
    assert.equal(resolveTabaSpawn({ req: req(), role: role({ systemPromptMode: "append" }), ...base }).bodyInTask, false);
    assert.equal(resolveTabaSpawn({ req: req(), role: role({ systemPromptMode: "replace", body: "" }), ...base }).bodyInTask, true, "没有正文就没什么可放的");
    assert.equal(resolveTabaSpawn({ req: req(), ...base }).bodyInTask, true, "没有角色");
});

test("启动参数：会话文件、系统提示词、工具白名单按顺序拼", () => {
    assert.deepEqual(buildTabaExtraArgs({}), []);
    assert.deepEqual(
        buildTabaExtraArgs({ sessionFile: "/s/kid.jsonl", tools: "read,bash" }),
        ["--session", "/s/kid.jsonl", "--tools", "read,bash"]
    );
    assert.deepEqual(
        buildTabaExtraArgs({ promptFile: "/r/scout.md", systemPromptMode: undefined }),
        ["--append-system-prompt", "/r/scout.md"],
        "没写清楚就按追加处理"
    );
    assert.deepEqual(
        buildTabaExtraArgs({ promptFile: "/r/x.md", systemPromptMode: "replace" }),
        ["--system-prompt", "/r/x.md"]
    );
    assert.deepEqual(
        buildTabaExtraArgs({ sessionFile: "/s.jsonl", promptFile: "/r.md", systemPromptMode: "append", tools: "read" }),
        ["--session", "/s.jsonl", "--append-system-prompt", "/r.md", "--tools", "read"]
    );
});

test("子会话的启动要求：不领备用进程、不再加载派子会话那个扩展", () => {
    const launch = buildTabaLaunch(["--tools", "read"], "/proj/sub");
    assert.equal(launch.skipSpare, true);
    assert.equal(launch.noTaba, true);
    assert.equal(launch.cwd, "/proj/sub");
    assert.deepEqual(launch.extraArgs, ["--tools", "read"]);
});

test("第一条消息：走系统提示词时任务里不重复角色说明", () => {
    const withBody = buildTabaTaskText({ role: role(), bodyInTask: true, task: "看看认证模块" });
    assert.ok(withBody.includes("你是摸底角色。"));
    assert.ok(withBody.includes("看看认证模块"));
    const withoutBody = buildTabaTaskText({ role: role({ systemPromptMode: "append" }), bodyInTask: false, task: "看看认证模块" });
    assert.equal(withoutBody.includes("你是摸底角色。"), false);
    assert.ok(withoutBody.includes("看看认证模块"));
    const skills = buildTabaTaskText({ role: role({ skills: "hai,grill" }), bodyInTask: true, task: "活儿" });
    assert.ok(skills.includes("/skill:hai"));
    assert.ok(skills.includes("/skill:grill"));
});

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
    buildTabaExtraArgs,
    buildTabaLaunch,
    normalizeListValue,
    resolveTabaSpawn,
} from "./tabaLaunch";
import type { TabaSpawnRequest } from "./tabaProtocol";

/** 相对路径前面加个斜杠，用来验证"确实问过 resolvePath"。 */
const resolvePath = (p: string): string => (p.startsWith("/") || /^[a-zA-Z]:/.test(p) ? p : "/resolved/" + p);

function req(over: Partial<TabaSpawnRequest> = {}): TabaSpawnRequest {
    return { kind: "spawn", id: "a1", name: "侦察: 认证", task: "看看认证模块", ...over };
}

const base = { parentCwd: "/proj", parentModelId: "glm-5.3-flash", parentProvider: "local", resolvePath };

test("工作目录：派活时指定的 > 跟派活那个会话一样", () => {
    assert.equal(resolveTabaSpawn({ req: req(), ...base }).cwd, "/proj");
    assert.equal(
        resolveTabaSpawn({ req: req({ cwd: "D:\\other" }), ...base }).cwd,
        "D:\\other",
        "派活时指定的不用再过 resolvePath（本来就是绝对路径）"
    );
    assert.equal(resolveTabaSpawn({ req: req({ cwd: "sub" }), ...base }).cwd, "/resolved/sub");
});

test("工具白名单：派活时指定的 > 不限制；格式归一化", () => {
    assert.equal(resolveTabaSpawn({ req: req(), ...base }).tools, undefined);
    assert.equal(resolveTabaSpawn({ req: req({ tools: "read,bash,edit,write" }), ...base }).tools, "read,bash,edit,write");
    assert.equal(resolveTabaSpawn({ req: req({ tools: " , " }), ...base }).tools, undefined, "全是空白当没写");
});

test("模型：派活时指定的 > 派活那个会话正在用的；思考强度拼在后面", () => {
    assert.equal(resolveTabaSpawn({ req: req(), ...base }).modelSpec, "glm-5.3-flash");
    assert.equal(resolveTabaSpawn({ req: req({ model: "m1", thinking: "high" }), ...base }).modelSpec, "m1:high");
    assert.equal(resolveTabaSpawn({ req: req(), ...{ ...base, parentModelId: "" } }).modelSpec, "");
});

test("模型覆盖：写成 provider/model 时不再单独传 provider", () => {
    const withProvider = resolveTabaSpawn({ req: req({ model: "local/glm-5.3-flash" }), ...base }).modelOverride;
    assert.deepEqual(withProvider, { provider: undefined, modelId: "local/glm-5.3-flash" });
    const bare = resolveTabaSpawn({ req: req({ model: "glm-5.3", thinking: "low" }), ...base }).modelOverride;
    assert.deepEqual(bare, { provider: "local", modelId: "glm-5.3:low" });
    assert.equal(resolveTabaSpawn({ req: req(), ...{ ...base, parentModelId: "" } }).modelOverride, undefined);
});

test("工具白名单列表的归一化", () => {
    assert.equal(normalizeListValue("read, bash , edit"), "read,bash,edit");
    assert.equal(normalizeListValue(",,,"), undefined);
    assert.equal(normalizeListValue(""), undefined);
    assert.equal(normalizeListValue("Read, read"), "Read", "大小写算重复，保留先出现的那个写法");
    assert.equal(normalizeListValue(undefined), undefined);
});

test("启动参数：只有工具白名单一样东西", () => {
    assert.deepEqual(buildTabaExtraArgs({}), []);
    assert.deepEqual(buildTabaExtraArgs({ tools: "read,bash" }), ["--tools", "read,bash"]);
});

test("子会话的启动要求：不领备用进程、不再加载派子会话那个扩展", () => {
    const launch = buildTabaLaunch(["--tools", "read"], "/proj/sub");
    assert.equal(launch.skipSpare, true);
    assert.equal(launch.noTaba, true);
    assert.equal(launch.cwd, "/proj/sub");
    assert.deepEqual(launch.extraArgs, ["--tools", "read"]);
});

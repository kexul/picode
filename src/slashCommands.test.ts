import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandMenuItems, expandSlashCommand } from "./sessionRuntime";
import type { RpcCommandInfo } from "./piRpc";

const COMMANDS: RpcCommandInfo[] = [
    { name: "skill:grill-me", description: "拷问式需求澄清", source: "skill" },
    { name: "skill:handoff", description: "会话交接", source: "skill" },
    { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
    { name: "session-name", description: "Set or clear session name", source: "extension" },
    { name: "skill:session-name", description: "同名技能（应被扩展命令压过）", source: "skill" },
];

describe("commandMenuItems", () => {
    it("strips skill: prefix and inserts shorthand", () => {
        const items = commandMenuItems(COMMANDS);
        const grill = items.find((i) => i.name === "grill-me");
        assert.ok(grill);
        assert.equal(grill.insert, "/grill-me");
        assert.equal(grill.source, "skill");
        assert.equal(grill.description, "拷问式需求澄清");
    });

    it("sorts alphabetically by base name", () => {
        const names = commandMenuItems(COMMANDS).map((i) => i.name);
        assert.deepEqual(names, ["fix-tests", "grill-me", "handoff", "session-name"]);
    });

    it("dedupes base-name collisions by pi priority (extension > prompt > skill)", () => {
        const items = commandMenuItems(COMMANDS);
        const dup = items.find((i) => i.name === "session-name");
        assert.ok(dup);
        assert.equal(dup.source, "extension");
        assert.equal(dup.description, "Set or clear session name");
    });

    it("ignores invalid entries", () => {
        const items = commandMenuItems([
            { name: "", source: "skill" },
            { name: "skill:", source: "skill" },
            null as unknown as RpcCommandInfo,
            { name: "ok", source: "prompt" },
        ]);
        assert.equal(items.length, 1);
        assert.equal(items[0].name, "ok");
    });
});

describe("expandSlashCommand", () => {
    it("rewrites skill shorthand to /skill: form", () => {
        assert.equal(expandSlashCommand("/grill-me", COMMANDS), "/skill:grill-me");
    });

    it("keeps args after the command name", () => {
        assert.equal(
            expandSlashCommand("/grill-me 请严格一点", COMMANDS),
            "/skill:grill-me 请严格一点"
        );
    });

    it("does not touch full /skill: spelling", () => {
        assert.equal(expandSlashCommand("/skill:grill-me", COMMANDS), "/skill:grill-me");
    });

    it("does not touch extension commands or prompt templates", () => {
        assert.equal(expandSlashCommand("/session-name foo", COMMANDS), "/session-name foo");
        assert.equal(expandSlashCommand("/fix-tests", COMMANDS), "/fix-tests");
    });

    it("passes through unknown commands and plain text", () => {
        assert.equal(expandSlashCommand("/nope", COMMANDS), "/nope");
        assert.equal(expandSlashCommand("/", COMMANDS), "/");
        assert.equal(expandSlashCommand("hello world", COMMANDS), "hello world");
        assert.equal(expandSlashCommand("", COMMANDS), "");
    });

    it("returns text unchanged when command list is empty", () => {
        assert.equal(expandSlashCommand("/grill-me", []), "/grill-me");
    });
});

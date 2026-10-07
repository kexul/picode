import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    DEFAULT_TABA_ROLES,
    safeVersionForFile,
    tabaHomeDir,
    writeTabaAssets,
} from "./tabaAssets";
import { TABA_BRIDGE_SOURCE } from "./tabaBridgeSource";

/** 每个用例一个干净的临时目录，用完删掉。 */
function withTempDir(fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-taba-"));
    try {
        fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test("家目录位置：在 .pi 下面，但不在 pi 会自动发现的 extensions 目录里", () => {
    const dir = tabaHomeDir().replace(/\\/g, "/");
    assert.ok(dir.endsWith("/.pi/pichat"), dir);
    assert.equal(dir.includes("/.pi/agent"), false, "不能被 pi 自动发现");
});

test("版本号只留下能进文件名的字符", () => {
    assert.equal(safeVersionForFile("0.0.7"), "0.0.7");
    assert.equal(safeVersionForFile("1.2.3-beta 1"), "1.2.3-beta-1");
    assert.equal(safeVersionForFile(""), "0");
});

test("写两样东西：桥扩展 + 默认角色", () => {
    withTempDir((dir) => {
        const got = writeTabaAssets(dir, "0.0.7");
        assert.equal(got.ok, true, got.error ?? "");
        assert.equal(got.extensionPath.replace(/\\/g, "/"), dir.replace(/\\/g, "/") + "/taba-bridge-0.0.7.ts");
        assert.equal(fs.readFileSync(got.extensionPath, "utf8"), TABA_BRIDGE_SOURCE);
        const roles = fs.readdirSync(path.join(got.resourceDir, "taba-roles")).sort();
        assert.deepEqual(roles, DEFAULT_TABA_ROLES.map((r) => r.file).sort());
        // 每个角色文件都要能被前置元数据解析出名字
        for (const role of DEFAULT_TABA_ROLES) {
            const text = fs.readFileSync(path.join(got.resourceDir, "taba-roles", role.file), "utf8");
            assert.ok(text.startsWith("---\n"), role.file + " 要有前置元数据");
            assert.ok(text.includes("name: " + role.file.slice(0, -3)), role.file + " 的 name 要跟文件名对上");
        }
    });
});

test("重复写：内容没变就不动文件，插件升级后旧的扩展文件被删掉", () => {
    withTempDir((dir) => {
        const first = writeTabaAssets(dir, "0.0.7");
        assert.equal(first.ok, true);
        const stamp = fs.statSync(first.extensionPath).mtimeMs;
        const again = writeTabaAssets(dir, "0.0.7");
        assert.equal(again.extensionPath, first.extensionPath);
        assert.equal(fs.statSync(first.extensionPath).mtimeMs, stamp, "内容没变就不该重写");
        const upgraded = writeTabaAssets(dir, "0.0.8");
        assert.equal(upgraded.ok, true);
        const left = fs.readdirSync(dir).filter((n) => n.startsWith("taba-bridge-"));
        assert.deepEqual(left, ["taba-bridge-0.0.8.ts"], "只留当前版本那一个");
    });
});

test("用户改过的角色文件不会被改回去", () => {
    withTempDir((dir) => {
        const first = writeTabaAssets(dir, "0.0.7");
        const scout = path.join(first.resourceDir, "taba-roles", "scout.md");
        fs.writeFileSync(scout, "---\nname: scout\ndescription: 我改过的\n---\n我的说明\n", "utf8");
        writeTabaAssets(dir, "0.0.8");
        assert.ok(fs.readFileSync(scout, "utf8").includes("我改过的"));
    });
});

test("写不进去时报失败，不抛异常（插件据此不给 pi 加载扩展）", () => {
    withTempDir((dir) => {
        const blocker = path.join(dir, "not-a-dir");
        fs.writeFileSync(blocker, "占位", "utf8");
        const got = writeTabaAssets(blocker, "0.0.7");
        assert.equal(got.ok, false);
        assert.equal(got.extensionPath, "");
        assert.ok(got.error, "要说清原因");
    });
});

test("桥扩展源码：能被当成一份 TypeScript 源文件看（没有模板串漏出来、四个工具都注册了）", () => {
    assert.ok(TABA_BRIDGE_SOURCE.includes("export default function tabaBridge(pi: any): void {"));
    const tools = TABA_BRIDGE_SOURCE.match(/name: "(taba|taba_list|taba_stop|taba_peek)"/g) ?? [];
    assert.deepEqual(tools, ['name: "taba"', 'name: "taba_list"', 'name: "taba_stop"', 'name: "taba_peek"']);
    // 外层是 String.raw：里面的 \n 必须原样是两个字符，不能变成真换行
    assert.ok(TABA_BRIDGE_SOURCE.includes('Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\\n"'));
    // 暗号前缀要跟解析那边一致
    assert.ok(TABA_BRIDGE_SOURCE.includes('const FRAME_PREFIX = "##PICHAT_TABA##"'));
    assert.equal(TABA_BRIDGE_SOURCE.includes("${"), false, "源码里不该出现 ${");
    assert.equal(TABA_BRIDGE_SOURCE.includes("`"), false, "源码里不该有反引号");
});

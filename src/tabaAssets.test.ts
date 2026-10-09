import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
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

test("写桥扩展：路径、内容都对，名录的根就是这个目录", () => {
    withTempDir((dir) => {
        const got = writeTabaAssets(dir, "0.0.7");
        assert.equal(got.ok, true, got.error ?? "");
        assert.equal(got.extensionPath.replace(/\\/g, "/"), dir.replace(/\\/g, "/") + "/taba-bridge-0.0.7.ts");
        assert.equal(fs.readFileSync(got.extensionPath, "utf8"), TABA_BRIDGE_SOURCE);
        assert.equal(got.resourceDir.replace(/\\/g, "/"), dir.replace(/\\/g, "/"));
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

test("老版本插件留下的角色目录会被顺手清掉", () => {
    withTempDir((dir) => {
        fs.mkdirSync(path.join(dir, "taba-roles"), { recursive: true });
        fs.writeFileSync(path.join(dir, "taba-roles", "scout.md"), "---\nname: scout\n---\n旧角色\n", "utf8");
        fs.mkdirSync(path.join(dir, "taba-prompts"), { recursive: true });
        const got = writeTabaAssets(dir, "0.0.8");
        assert.equal(got.ok, true);
        assert.equal(fs.existsSync(path.join(dir, "taba-roles")), false, "角色已经不支持了，目录清掉");
        assert.equal(fs.existsSync(path.join(dir, "taba-prompts")), false);
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

test("桥扩展源码：能被当成一份 TypeScript 源文件看（没有模板串漏出来、三个工具都注册了）", () => {
    assert.ok(TABA_BRIDGE_SOURCE.includes("export default function tabaBridge(pi: any): void {"));
    const tools = TABA_BRIDGE_SOURCE.match(/name: "(taba|taba_stop|taba_peek)"/g) ?? [];
    assert.deepEqual(tools, ['name: "taba"', 'name: "taba_stop"', 'name: "taba_peek"']);
    // 外层是 String.raw：里面的 \n 必须原样是两个字符，不能变成真换行
    assert.ok(TABA_BRIDGE_SOURCE.includes('Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\\n"'));
    // 暗号前缀要跟解析那边一致
    assert.ok(TABA_BRIDGE_SOURCE.includes('const FRAME_PREFIX = "##PICHAT_TABA##"'));
    assert.equal(TABA_BRIDGE_SOURCE.includes("`"), false, "源码里不该有反引号");
});

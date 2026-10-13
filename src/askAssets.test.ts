/**
 * 问话（askAssets）：桥扩展文件落盘 + 旧版本清理 + 自己那份源码要是能解析的。
 *
 * 最后那条最要紧：那份源码是包在 String.raw 里的字符串，拼错一个引号，
 * 编译照样过（它只是字符串），要到用户那边 pi 起不来才发现。
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ASK_BRIDGE_SOURCE } from "./askBridgeSource";
import { writeAskAssets } from "./askAssets";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pichat-ask-assets-"));
}

test("桥扩展落盘：文件名带版本号，内容跟源码一字不差，回话目录也建好", () => {
    const dir = tmpDir();
    try {
        const assets = writeAskAssets(dir, "1.2.3");
        assert.equal(assets.ok, true);
        assert.equal(path.basename(assets.extensionPath), "ask-bridge-1.2.3.ts");
        assert.equal(fs.readFileSync(assets.extensionPath, "utf8"), ASK_BRIDGE_SOURCE);
        assert.ok(fs.statSync(path.join(dir, "ask-answers")).isDirectory());
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("旧版本的桥扩展会被清掉，别的文件不动", () => {
    const dir = tmpDir();
    try {
        fs.writeFileSync(path.join(dir, "ask-bridge-0.9.0.ts"), "旧的", "utf8");
        fs.writeFileSync(path.join(dir, "config.json"), "{}", "utf8");
        const assets = writeAskAssets(dir, "1.0.0");
        assert.equal(assets.ok, true);
        const names = fs.readdirSync(dir).sort();
        assert.ok(names.includes("ask-bridge-1.0.0.ts"));
        assert.ok(!names.includes("ask-bridge-0.9.0.ts"), "旧版本的该删掉");
        assert.ok(names.includes("config.json"), "不是桥扩展的文件一个都别碰");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("版本号里的怪字符出不了文件名的范围", () => {
    const dir = tmpDir();
    try {
        const assets = writeAskAssets(dir, "1.0.0/../坏");
        assert.equal(assets.ok, true);
        assert.equal(path.dirname(assets.extensionPath), dir, "文件得落在目录里，不能跑出去");
        const name = path.basename(assets.extensionPath);
        assert.ok(name.startsWith("ask-bridge-"), name);
        assert.ok(!name.includes("/"), name);
        assert.ok(!name.includes("坏"), name);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("那份桥扩展的源码是一份能解析的 TypeScript", () => {
    let ts: any;
    try {
        ts = require("typescript");
    } catch {
        return;    // 打包环境里没带 typescript：跳过，不能因为这个把测试挂掉
    }
    const file = ts.createSourceFile("ask-bridge.ts", ASK_BRIDGE_SOURCE, ts.ScriptTarget.ESNext, true);
    const diags: any[] = file.parseDiagnostics ?? [];
    const messages = diags.map((d) => {
        const at = file.getLineAndCharacterOfPosition(d.start);
        return `第 ${at.line + 1} 行: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
    assert.deepEqual(messages, [], "桥扩展源码有语法错（多半是字符串里混了半角引号）");
    assert.ok(ASK_BRIDGE_SOURCE.includes("ask_choice"), "工具名得在里面");
    assert.ok(ASK_BRIDGE_SOURCE.includes("PICHAT_ASK_DIR"), "资源目录靠这个环境变量找");
});

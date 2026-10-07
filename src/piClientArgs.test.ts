import { test } from "node:test";
import * as assert from "node:assert/strict";
import { quoteArgForWindowsShell } from "./piClient";

test("Windows 命令行参数加引号：不含空格的不动", () => {
    assert.equal(quoteArgForWindowsShell("pi"), "pi");
    assert.equal(quoteArgForWindowsShell("--mode"), "--mode");
    assert.equal(quoteArgForWindowsShell("rpc"), "rpc");
    assert.equal(quoteArgForWindowsShell("C:\\Users\\kkk\\.pi\\pichat\\taba-bridge-0.0.7.ts"),
        "C:\\Users\\kkk\\.pi\\pichat\\taba-bridge-0.0.7.ts");
    assert.equal(quoteArgForWindowsShell("read,bash,edit"), "read,bash,edit");
});

test("Windows 命令行参数加引号：带空格的要用双引号包起来", () => {
    assert.equal(
        quoteArgForWindowsShell("C:\\Users\\John Doe\\.pi\\pichat\\taba-bridge-0.0.7.ts"),
        '"C:\\Users\\John Doe\\.pi\\pichat\\taba-bridge-0.0.7.ts"'
    );
    assert.equal(quoteArgForWindowsShell("C:\\Program Files\\pi\\pi.cmd"), '"C:\\Program Files\\pi\\pi.cmd"');
    assert.equal(quoteArgForWindowsShell("带 空格 的路径.md"), '"带 空格 的路径.md"');
    assert.equal(quoteArgForWindowsShell("有\t制表符"), '"有\t制表符"');
});

test("Windows 命令行参数加引号：自己已经带成对引号的不重复加", () => {
    assert.equal(quoteArgForWindowsShell('"C:\\a b\\c.ts"'), '"C:\\a b\\c.ts"');
    assert.equal(quoteArgForWindowsShell("'a b'"), "'a b'");
});

test("Windows 命令行参数加引号：值里的引号被转义，空串原样返回", () => {
    assert.equal(quoteArgForWindowsShell('a "b" c'), '"a \\"b\\" c"');
    assert.equal(quoteArgForWindowsShell(""), "");
});

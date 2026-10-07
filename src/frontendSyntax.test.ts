/**
 * 前端脚本的语法检查。
 *
 * media/ 下那几个 js 是直接给网页视图加载的，不参与 tsc 编译，改坏了要等到界面白屏才发现。
 * 这里用 node 自带的 --check（只解析、不执行）把它们过一遍：语法坏了这条测试就红。
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";

/** 编译后的测试在 out/src/ 下，media/ 往上两级。 */
const mediaDir = path.join(__dirname, "..", "..", "media");

test("media 下的脚本都能过语法检查", () => {
    const files = fs.readdirSync(mediaDir).filter((n) => n.endsWith(".js")).sort();
    assert.ok(files.length >= 4, `media 下应该有几个 js，实际 ${files.length}`);
    assert.ok(files.includes("chat.js"), "对话前端那份要在里面");
    for (const name of files) {
        const full = path.join(mediaDir, name);
        try {
            execFileSync(process.execPath, ["--check", full], { stdio: "pipe" });
        } catch (e: any) {
            const detail = String((e && (e.stderr ?? e.stdout)) || e?.message || e).slice(0, 500);
            assert.fail(`${name} 语法不对：\n${detail}`);
        }
    }
});

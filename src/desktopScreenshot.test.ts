import { test } from "node:test";
import * as assert from "node:assert/strict";
import { captureDesktopScreenshot, screenshotPowerShellScript } from "./desktopScreenshot";

test("非 Windows 平台直接给出明确提示，不去真的截屏", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
        const result = await captureDesktopScreenshot();
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.match(result.error, /Windows/);
        }
    } finally {
        Object.defineProperty(process, "platform", { value: original });
    }
});

test("PowerShell 脚本里写入了目标文件路径，单引号按 PowerShell 的规矩转义", () => {
    const script = screenshotPowerShellScript("C:\\temp\\pi's shot.png");
    assert.match(script, /C:\\temp\\pi''s shot\.png/);
});

test("PowerShell 脚本截的是所有显示器拼起来的虚拟桌面，并声明了 DPI 感知", () => {
    const script = screenshotPowerShellScript("C:\\temp\\s.png");
    assert.match(script, /VirtualScreen/);
    assert.match(script, /SetProcessDPIAware/);
});

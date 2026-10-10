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
    const script = screenshotPowerShellScript("C:\\temp\\pi's shot.jpg");
    assert.match(script, /C:\\temp\\pi''s shot\.jpg/);
});

test("PowerShell 脚本：虚拟桌面 + DPI 感知 + JPEG + 长边 2560 缩小", () => {
    const script = screenshotPowerShellScript("C:\\temp\\s.jpg");
    assert.match(script, /VirtualScreen/);
    assert.match(script, /SetProcessDPIAware/);
    assert.match(script, /ImageFormat\]::Jpeg/);
    assert.match(script, /maxEdge = 2560/);
    // 不能用 GetImageEncoders / EncoderParameters 自选质量的那套写法：
    // Windows Defender 的 EmpireGetScreenshot 签名盯着它，整段脚本会被拦（实测）。
    assert.doesNotMatch(script, /EncoderParameters/);
});

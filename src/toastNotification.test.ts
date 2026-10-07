/**
 * Windows 通知链路的测试（只在 Windows 上真正跑 PowerShell，其它平台跳过）。
 *
 * 覆盖三件事：
 *   1. 生成的 PowerShell 脚本语法没问题，能真的把通知交给系统
 *      （判据：临时文件里出现 .done 标记，且数据文件被脚本自己清掉）；
 *   2. “到点从通知中心一并消失”的写法在这台机器上能用（设置失效时间后脚本不报错）；
 *   3. 通知文字里的引号、反引号、尖括号等只会被当数据转义，不会变成可执行内容。
 *
 * 注意：跑这个测试时屏幕上会真的弹出通知卡片，这是预期行为。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    POWERSHELL_APP_USER_MODEL_ID,
    TOAST_EXPIRE_SECONDS,
    buildToastScript,
    encodePowerShell,
    escapePs,
} from "./toastScript";

const isWindows = process.platform === "win32";

/** 数据文件里的通知文字（故意塞中英文与各种符号）。 */
const ITEMS = [
    {
        title: "沉静的雪豹：任务完成",
        body: "已经改好了登录页，共 2 个文件。表单校验也加上了，测试全部通过 · it's a <test> & `ok`",
        attribution: "Pi Chat",
    },
];

/** 写一份数据文件，返回它的路径。 */
function writeDataFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-toast-test-"));
    const file = path.join(dir, "batch.json");
    fs.writeFileSync(file, JSON.stringify(ITEMS), { encoding: "utf8" });
    return file;
}

/** 反复查某个文件是否出现，最多等 timeoutMs。 */
function waitForFile(target: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
        const tick = (): void => {
            if (fs.existsSync(target)) { resolve(true); return; }
            if (Date.now() > deadline) { resolve(false); return; }
            setTimeout(tick, 100);
        };
        tick();
    });
}

/** 真的跑一遍 PowerShell，要求它把通知发出去（.done 出现）且没有报错。 */
async function runScriptAndExpectDone(options: { expireAfterSeconds: number; keepAliveMs: number }): Promise<void> {
    const dataFile = writeDataFile();
    const script = buildToastScript({
        dataFile,
        appUserModelId: POWERSHELL_APP_USER_MODEL_ID,
        appLabel: "Pi Chat",
        expireAfterSeconds: options.expireAfterSeconds,
        keepAliveMs: options.keepAliveMs,
    });
    const child = cp.spawn(
        "powershell.exe",
        [
            "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-EncodedCommand", encodePowerShell(script),
        ],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    const done = await waitForFile(`${dataFile}.done`, 15000);
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    fs.rmSync(path.dirname(dataFile), { recursive: true, force: true });

    // PowerShell 会把进度信息以 CLIXML 形式写到 stderr，那是噪音不是报错，过滤掉再判断。
    const noise = stderr.split(/\r?\n/).filter((line) => {
        const t = line.trim();
        return t.length > 0
            && !t.startsWith("#< CLIXML")
            && !/^<\?xml|^<Objs|^<\/Objs/.test(t);
    }).join("\n").trim();
    assert.equal(noise, "", `PowerShell 报错：${stderr}`);
    assert.ok(done, "通知应当在 15 秒内交给系统（出现 .done 标记）");
    assert.ok(!fs.existsSync(dataFile), "脚本应当自己删掉数据文件");
}

describe("Windows 通知", () => {
    it("escapePs 去掉 PowerShell 的活字符并把单引号翻倍", () => {
        assert.equal(escapePs("it's"), "it''s");
        assert.equal(escapePs("a`b$c"), "abc");
        assert.equal(escapePs(""), "");
    });

    it("生成的脚本：路径带单引号不破坏、卡片用系统默认时长、带上失效时间", () => {
        const weird = "C:\\temp\\it's here\\batch.json";
        const script = buildToastScript({
            dataFile: weird,
            appUserModelId: POWERSHELL_APP_USER_MODEL_ID,
            appLabel: "Pi Chat",
            expireAfterSeconds: TOAST_EXPIRE_SECONDS,
            keepAliveMs: 0,
        });
        assert.ok(script.includes("'C:\\temp\\it''s here\\batch.json'"));
        // 折回单个 $：不该出现 $$（TypeScript 模板里的占位写法）
        assert.ok(!script.includes("$$"));
        // 不再写 duration="long"（那会让卡片在屏幕上停约 25 秒），改用系统默认的约 7 秒
        assert.ok(!script.includes('duration="long"'));
        assert.ok(script.includes(`$expireAfter = ${TOAST_EXPIRE_SECONDS}`));
        assert.ok(script.includes("$toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds($expireAfter)"));
    });

    it("PowerShell 真的把通知交给系统（出现 .done 标记）", { skip: !isWindows }, async () => {
        await runScriptAndExpectDone({ expireAfterSeconds: TOAST_EXPIRE_SECONDS, keepAliveMs: 300 });
    });

    it("带失效时间的通知在进程存活期间到点消失，脚本不报错", { skip: !isWindows }, async () => {
        // 失效时间给 3 秒、进程留 6 秒：整个过程能在测试里跑完。
        await runScriptAndExpectDone({ expireAfterSeconds: 3, keepAliveMs: 6000 });
    });
});

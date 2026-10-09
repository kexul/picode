import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    TABA_RUN_FILE_VERSION,
    TABA_RUN_MAX_AGE_MS,
    buildRunRecord,
    cleanStaleRunFiles,
    makeLastReplyPreview,
    readRunRecord,
    runFilePath,
    runStateText,
    tabaRunsDir,
    writeRunRecord,
    type TabaRunRecord,
} from "./tabaRunFiles";
import type { TabaChild } from "./tabaRegistry";

function kid(over: Partial<TabaChild> = {}): TabaChild {
    return {
        id: "a1b2c3d4", name: "侦察: 认证", task: "看看认证模块",
        parentPanelId: "sidebar:panel-1", parentSessionFile: "/sessions/parent.jsonl",
        childPanelId: "sidebar:panel-2", childTabId: "sidebar:tab-2",
        state: "running", startedAt: 1000, deliveries: 0,
        sessionFile: "/sessions/kid.jsonl", ...over,
    };
}

function withTempDir(fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pichat-runs-"));
    try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("名录目录与文件名的约定", () => {
    assert.equal(tabaRunsDir("/res").replace(/\\/g, "/"), "/res/taba-runs");
    assert.equal(runFilePath(tabaRunsDir("/res"), "a1b2c3d4").replace(/\\/g, "/"), "/res/taba-runs/a1b2c3d4.json");
});

test("状态的人话说法（含 tab 已关闭那一档）", () => {
    assert.equal(runStateText("starting"), "正在开");
    assert.equal(runStateText("running"), "运行中");
    assert.equal(runStateText("waiting"), "第一轮跑完了，tab 还留着");
    assert.equal(runStateText("error"), "第一轮出错了");
    assert.equal(runStateText("detached"), "已经变成独立会话");
    assert.equal(runStateText("closed"), "tab 已经关闭");
});

test("最后一条回复的开头一段：压掉换行、超长就切在句子边上", () => {
    assert.equal(makeLastReplyPreview(""), "");
    assert.equal(makeLastReplyPreview("  短结论  "), "短结论");
    assert.equal(makeLastReplyPreview("第一行\n\n第二行\t第三行"), "第一行 第二行 第三行");
    const long = "认证在 src/auth.ts。" + "后面还有很多话。".repeat(60);
    const preview = makeLastReplyPreview(long, 200);
    assert.ok(preview.endsWith("…"), "超长要有省略号");
    assert.ok(preview.length <= 201, `长度 ${preview.length}`);
    assert.ok(preview.includes("认证在 src/auth.ts。"), "开头那句要留着");
    assert.equal(preview.slice(0, 200).endsWith("。…"), false, "不要切成“句号 + 省略号”这种半句");
    // 不到上限就整段返回
    const mid = "一句话。".repeat(10);
    assert.equal(makeLastReplyPreview(mid, 200), mid);
});

test("名录记录：字段都对得上，状态可以被覆盖成 closed", () => {
    const rec = buildRunRecord({ child: kid(), now: 5000 });
    assert.equal(rec.v, TABA_RUN_FILE_VERSION);
    assert.equal(rec.id, "a1b2c3d4");
    assert.equal(rec.name, "侦察: 认证");
    assert.equal(rec.task, "看看认证模块");
    assert.equal(rec.state, "running");
    assert.equal(rec.stateText, "运行中");
    assert.equal(rec.startedAt, 1000);
    assert.equal(rec.endedAt, 0, "还没跑完就是 0");
    assert.equal(rec.sessionFile, "/sessions/kid.jsonl");
    assert.equal(rec.parentSessionFile, "/sessions/parent.jsonl");
    assert.equal(rec.lastReplyPreview, "", "还没交回就没有预览");
    assert.equal(rec.writtenAt, 5000);

    const closed = buildRunRecord({ child: kid({ result: "看过了，认证在 src/auth.ts。", endedAt: 9000 }), state: "closed", now: 9999 });
    assert.equal(closed.state, "closed");
    assert.equal(closed.stateText, "tab 已经关闭");
    assert.equal(closed.endedAt, 9000);
    assert.equal(closed.lastReplyPreview, "看过了，认证在 src/auth.ts。");
});

test("写出去再读回来是同一份；版本不对或文件没有都返回 undefined", () => {
    withTempDir((dir) => {
        const runs = tabaRunsDir(dir);
        const rec = buildRunRecord({ child: kid(), now: 1 });
        assert.equal(writeRunRecord(runs, rec), true);
        assert.deepEqual(readRunRecord(runs, rec.id), rec);
        assert.equal(readRunRecord(runs, "没有这个编号"), undefined);
        // 版本不对就当认不出来（免得拿着旧格式当真）
        fs.writeFileSync(runFilePath(runs, "old.json"), JSON.stringify({ ...rec, id: "old", v: 99 }), "utf8");
        assert.equal(readRunRecord(runs, "old"), undefined);
        fs.writeFileSync(path.join(runs, "坏掉的.json"), "{ 不是 JSON", "utf8");
        assert.equal(readRunRecord(runs, "坏掉的"), undefined);
        // 目录不存在时读不炸、写会自己建目录
        assert.equal(readRunRecord(path.join(dir, "没有这个目录"), "x"), undefined);
        assert.equal(writeRunRecord(path.join(dir, "新建的目录"), rec), true);
    });
});

test("清理：只删太老的，别的文件不动", () => {
    withTempDir((dir) => {
        const runs = tabaRunsDir(dir);
        fs.mkdirSync(runs, { recursive: true });
        const now = Date.now();
        const fresh = runFilePath(runs, "fresh.json");
        const stale = runFilePath(runs, "stale.json");
        const other = path.join(runs, "说明.txt");
        fs.writeFileSync(fresh, "{}", "utf8");
        fs.writeFileSync(stale, "{}", "utf8");
        fs.writeFileSync(other, "不是名录", "utf8");
        const old = new Date(now - TABA_RUN_MAX_AGE_MS - 60_000);
        fs.utimesSync(stale, old, old);

        assert.equal(cleanStaleRunFiles(runs, now), 1, "只删掉那一个太老的");
        assert.equal(fs.existsSync(fresh), true);
        assert.equal(fs.existsSync(stale), false);
        assert.equal(fs.existsSync(other), true, "不是名录的文件不动");
        assert.equal(cleanStaleRunFiles(runs, now), 0, "再清一次没得清");
        assert.equal(cleanStaleRunFiles(path.join(dir, "没有这个目录"), now), 0, "目录不存在也不炸");
    });
});

test("记录里带的东西正好够模型自己去读：路径、状态、用时、预览", () => {
    const rec: TabaRunRecord = buildRunRecord({
        child: kid({ result: "结论：认证逻辑集中在 src/auth.ts。", endedAt: 72_000, deliveries: 1, state: "waiting" }),
    });
    // 桥扩展只需要这些字段就能把情况说清楚
    assert.ok(rec.sessionFile);
    assert.ok(rec.stateText);
    assert.ok(rec.startedAt > 0);
    assert.ok(rec.lastReplyPreview.startsWith("结论："));
    assert.equal(rec.deliveries, 1);
});

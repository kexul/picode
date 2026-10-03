/**
 * 收尾提醒文字的单测（纯函数，不碰 vscode / PowerShell）。
 *
 * 重点盯两件事：
 *   1. 会话名优先用 pi 自己给的标题，没有才退回插件分配的随机名 / tab 名；
 *   2. 标题太长或带换行时只收成一行并截断，别把 Windows 通知卡片撑爆。
 */
import { strict as assert } from "assert";
import { describe, it } from "node:test";
import {
    MAX_NAME_CHARS,
    notifyBody,
    notifySessionName,
    notifySummary,
    notifyTitle,
    shorten,
} from "./turnNotifyText";
import type { TurnEndInfo } from "./runtimeTypes";

/** 造一条收尾信息：默认是“正常跑完”，测试按需覆盖字段。 */
function turn(over: Partial<TurnEndInfo> = {}): TurnEndInfo {
    return {
        panelId: "sidebar:panel-1",
        panelName: "沉静的雪豹",
        tabName: "雪豹·青鸟",
        workspaceId: "sidebar",
        status: "done",
        ...over,
    };
}

describe("收尾提醒的文字", () => {
    it("有 pi 会话标题就用它，不再显示 tab 栏那个随机名", () => {
        const info = turn({ sessionTitle: "上传 auto-session-title 插件到 GitHub" });
        assert.equal(notifySessionName(info), "上传 auto-session-title 插件到 GitHub");
        assert.equal(notifyTitle(info), "上传 auto-session-title 插件到 GitHub：任务完成");
    });

    it("标题还没来（等超时）时退回会话随机名，随机名也没有就用 tab 名 / “会话”", () => {
        assert.equal(notifySessionName(turn({ sessionTitle: "" })), "沉静的雪豹");
        assert.equal(notifySessionName(turn({ panelName: "" })), "雪豹·青鸟");
        assert.equal(notifySessionName(turn({ panelName: "", tabName: "" })), "会话");
    });

    it("出错 / 中止的说法不一样，标题里也带上会话名", () => {
        assert.equal(notifyTitle(turn({ status: "error", sessionTitle: "改登录页" })), "改登录页：本轮出错结束");
        assert.equal(notifyTitle(turn({ status: "cancelled", sessionTitle: "改登录页" })), "改登录页：已中止");
    });

    it("标题带换行 / 过长时收成一行并截断", () => {
        const long = "很长的标题".repeat(20) + "\n第二行";
        const name = notifySessionName(turn({ sessionTitle: long }));
        assert.equal(name.length, MAX_NAME_CHARS);
        assert.ok(name.endsWith("…"));
        assert.ok(!name.includes("\n"));
        assert.equal(shorten("  a \n b  ", 20), "a b");
    });

    it("第二行：改动文件数 + 累计花费（小于 1 分时多留两位小数）", () => {
        assert.equal(notifyBody(turn({ changedFileCount: 2, costUsd: 0.0421 })), "改动 2 个文件 · 累计 $0.04");
        assert.equal(notifyBody(turn({ changedFileCount: 0, costUsd: 0.00421 })), "累计 $0.0042");
        assert.equal(notifyBody(turn({ changedFileCount: 3, costUsd: 1.5 })), "改动 3 个文件 · 累计 $1.50");
        assert.equal(notifyBody(turn({ status: "cancelled", costUsd: 0 })), "用户中止");
    });

    it("出错时第二行带错误摘要，且同样截断", () => {
        const body = notifyBody(turn({ status: "error", errorText: "模型炸了\n".repeat(20) }));
        assert.ok(body.startsWith("模型炸了"));
        assert.ok(body.endsWith("…"));
    });

    it("界面内提示：一批会话只列前 3 个名字，其余并进“等 N 个会话”", () => {
        const batch = [
            turn({ panelId: "p1", sessionTitle: "改登录页" }),
            turn({ panelId: "p2", sessionTitle: "修构建" }),
            turn({ panelId: "p3", panelName: "沉静的雪豹" }),
            turn({ panelId: "p4", sessionTitle: "写文档" }),
        ];
        assert.equal(notifySummary(batch), "改登录页、修构建、沉静的雪豹 等 4 个会话 任务完成");
        assert.equal(notifySummary([turn({ sessionTitle: "改登录页", status: "error" })]), "改登录页 有会话出错结束");
        assert.equal(notifySummary([turn({ sessionTitle: "改登录页", status: "cancelled" })]), "改登录页 有会话被中止");
    });
});

/**
 * 收尾提醒文字的单测（纯函数，不碰 vscode / PowerShell）。
 *
 * 重点盯两件事：
 *   1. 会话名优先用 pi 自己给的标题，没有才退回插件分配的随机名 / tab 名；
 *   2. 标题太长或带换行时只收成一行并截断，别把 Windows 通知卡片撑爆；
 *   3. 第二行显示最后一条 AI 回复的首尾句摘要（不再显示改动文件数和花费）。
 */
import { strict as assert } from "assert";
import { describe, it } from "node:test";
import {
    MAX_NAME_CHARS,
    MAX_REPLY_CHARS,
    notifyBody,
    notifySessionName,
    notifySummary,
    notifyTitle,
    shorten,
    summarizeReply,
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

    it("第二行：显示最后一条 AI 回复的首尾句，中间用省略号；花费和文件数都不再显示", () => {
        assert.equal(
            notifyBody(turn({ lastReplyText: "已经把登录页改好了。表单校验也加上了。测试全部通过，可以提交了！" })),
            "已经把登录页改好了。……测试全部通过，可以提交了！",
        );
        assert.equal(notifyBody(turn({ lastReplyText: "只有一句话的回复", costUsd: 0.0421 })), "只有一句话的回复");
        assert.equal(notifyBody(turn({})), "");
        assert.equal(notifyBody(turn({ status: "cancelled", costUsd: 0 })), "用户中止");
    });

    it("回复摘要：换行也算一句结束，空回复返回空串", () => {
        assert.equal(summarizeReply("第一句。\n第二句。\n第三句。"), "第一句。……第三句。");
        assert.equal(summarizeReply("   "), "");
        assert.equal(summarizeReply(""), "");
        // 英文叹号/问号也认（半角句点不算句末，这是确认过的规则）
        assert.equal(summarizeReply("Done! Great work! All good."), "Done!……All good.");
    });

    it("回复摘要：整体超长时首尾各裁一半，总长不超上限", () => {
        const body = summarizeReply(`${"很长的第一句".repeat(10)}。中间省略。${"很长的最后一句".repeat(10)}。`);
        assert.ok(body.length <= MAX_REPLY_CHARS, `长度 ${body.length} 超过 ${MAX_REPLY_CHARS}`);
        assert.ok(body.includes("……"));
        assert.ok(body.endsWith("…"));
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

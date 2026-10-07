/**
 * 一轮对话收尾提醒的文字组装（纯函数）。
 *
 * 单独成一个文件、且不引用 vscode：这段只是字符串拼装，离开扩展宿主也能直接跑单测
 * （见 turnNotifyText.test.ts）。真正去发通知的代码在 turnNotifier.ts。
 */
import type { TurnEndInfo } from "./runtimeTypes";

/** 一条通知里的文字条目。 */
export interface TurnToastItem {
    /** 通知第一行（粗体标题） */
    title: string;
    /** 通知第二行（说明） */
    body: string;
    /** 通知左下角的来源标签 */
    attribution: string;
}

/** 提醒里会话名最多显示多长（用户自己用 /name 起的标题可能很长），超出收成 …。 */
export const MAX_NAME_CHARS = 48;

/** 通知第二行里错误摘要最多显示多长。 */
export const MAX_ERROR_CHARS = 60;

/** 通知第二行里回复摘要（首尾句加省略号）最多显示多长。 */
export const MAX_REPLY_CHARS = 80;

/** 界面内提示一次最多列几个会话名，超出的并进“等 N 个会话”。 */
const MAX_NAMES_IN_SUMMARY = 3;

/**
 * 提醒里显示的会话名。
 *
 * 优先用 pi 自己给的会话标题（自动命名扩展生成的，如“上传插件到 GitHub”）：它才说得出
 * 这次到底干了什么。tab 栏上那个随机名（“沉静的雪豹”）只当标题还没来时兜底。
 */
export function notifySessionName(info: TurnEndInfo): string {
    const name = info.sessionTitle || info.panelName || info.tabName || "会话";
    return shorten(name, MAX_NAME_CHARS);
}

/** 通知第一行：会话名 + 跑完了没有。 */
export function notifyTitle(info: TurnEndInfo): string {
    const name = notifySessionName(info);
    switch (info.status) {
        case "error": return `${name}：本轮出错结束`;
        case "cancelled": return `${name}：已中止`;
        default: return `${name}：任务完成`;
    }
}

/** 通知第二行：本轮最后一条 AI 回复的首尾句摘要 / 错误摘要。 */
export function notifyBody(info: TurnEndInfo): string {
    const parts: string[] = [];
    if (info.status === "cancelled") { parts.push("用户中止"); }
    else {
        const reply = summarizeReply(info.lastReplyText ?? "");
        if (reply) { parts.push(reply); }
    }
    if (info.status === "error" && info.errorText) { parts.push(shorten(info.errorText, MAX_ERROR_CHARS)); }
    return parts.join(" · ");
}

/**
 * 从一条 AI 回复里摘出「第一句……最后一句」；只有一句就只显示那一句。
 *
 * 句子按句末标点（。！？!?）或换行切分；取不到任何句子（回复为空等）返回空串。
 */
export function summarizeReply(text: string, max: number = MAX_REPLY_CHARS): string {
    // 换行也算一句话结束；句末标点保留在句尾，显示出来更自然。
    const sentences = String(text)
        .split(/(?<=[。！？!?])|\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /[^。！？!?\s]/.test(s));
    if (sentences.length === 0) { return ""; }
    const first = sentences[0];
    const last = sentences[sentences.length - 1];
    const body = sentences.length === 1 ? first : `${first}……${last}`;
    if (body.length <= max) { return body; }
    // 整体超长时把首尾两句各裁一半，保证「最后一句」不被截没（减 1 是给中间省略号留位置）。
    const half = Math.max(1, Math.floor((max - 1) / 2));
    return `${shorten(first, half)}……${shorten(last, half)}`;
}

/** 界面内提示的摘要：一行说完这批会话。 */
export function notifySummary(batch: TurnEndInfo[]): string {
    const names = batch.map((info) => notifySessionName(info));
    const shown = names.slice(0, MAX_NAMES_IN_SUMMARY).join("、");
    const more = names.length > MAX_NAMES_IN_SUMMARY ? ` 等 ${names.length} 个会话` : "";
    const result = batch.some((info) => info.status === "error")
        ? "有会话出错结束"
        : batch.some((info) => info.status === "cancelled")
            ? "有会话被中止"
            : "任务完成";
    return `${shown}${more} ${result}`;
}

/** 截断长文本（会话标题、错误消息都可能很长），先压成一行。 */
export function shorten(text: string, max: number): string {
    const oneLine = String(text).replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
